const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const { query } = require('../config/database');
const { requireDoctorOrReceptionist, getStaffPermission } = require('../middleware/auth');
const { sendPatientWelcomeEmail, sendLinkEmail } = require('../services/emailService');
const socketService = require('../services/socketService');

const router = express.Router();

const columnCache = new Map();
const tableCache = new Map();
const MAX_FOLLOWUP_PHOTOS_PER_REQUEST = 6;
const MAX_FOLLOWUP_PHOTO_SIZE = 2 * 1024 * 1024;

async function hasColumn(tableName, columnName) {
  const cacheKey = `${tableName}.${columnName}`;
  if (columnCache.has(cacheKey)) return columnCache.get(cacheKey);

  const found = await query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  const exists = found.rowCount > 0;
  columnCache.set(cacheKey, exists);
  return exists;
}

async function hasTable(tableName) {
  if (tableCache.has(tableName)) return tableCache.get(tableName);

  const found = await query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1
     LIMIT 1`,
    [tableName]
  );
  const exists = found.rowCount > 0;
  tableCache.set(tableName, exists);
  return exists;
}

function safeText(value) {
  return value ? String(value) : 'Nao informado';
}

function formatDateTime(value) {
  if (!value) return 'Nao informado';
  return new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function formatDate(value) {
  if (!value) return 'Nao informado';
  return new Date(value).toLocaleDateString('pt-BR');
}

function normalizePhotoStage(value) {
  const stage = String(value || '').trim().toUpperCase();
  if (stage === 'ANTES') return 'ANTES';
  if (stage === 'DURANTE') return 'DURANTE';
  if (stage === 'DEPOIS') return 'DEPOIS';
  return 'GERAL';
}

// Libera o endpoint pra medico OU recepcionista, checando a permissao
// granular da(s) pagina(s) informada(s) (aceita mais de um code — alguns
// endpoints sao usados tanto pela tela de Pacientes quanto pela de
// Prontuarios/Perfil, e basta ter permissao em uma delas). Depois de
// confirmar, garante que req.doctor sempre exista (com id/clinicId) mesmo
// quando quem esta chamando e a recepcao, pra nao quebrar o resto do
// arquivo que ja lia req.doctor.id / req.doctor.clinicId.
function requirePatientPermission(pageCodes, action) {
  const codes = Array.isArray(pageCodes) ? pageCodes : [pageCodes];
  return async (req, res, next) => {
    try {
      const results = await Promise.all(codes.map((code) => getStaffPermission(req.user, code)));
      const allowed = results.some((perm) => perm && (perm.isOwner || perm[`can_${action}`]));
      if (!allowed) {
        return res.status(403).json({ error: 'Voce nao tem permissao para acessar esta area.' });
      }
      req.doctor = req.doctor || req.user;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

function sanitizePhotoName(name, index) {
  const base = String(name || '').trim() || `foto-${index + 1}`;
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

// Encadeada depois de requireDoctorOrReceptionist: reaproveita a resolucao
// robusta de clinicId (com fallback pra clinica que o medico e dono/membro)
// mas bloqueia quem nao for medico. Usada nas acoes de autoria clinica que
// continuam exclusivas do medico (criar/editar prontuario e acompanhamento).
function requireDoctorRoleOnly(req, res, next) {
  if (req.user?.role !== 'DOCTOR') {
    return res.status(403).json({ error: 'Esta acao e exclusiva do medico.' });
  }
  return next();
}


function decodeImageDataUrl(dataUrl) {
  const input = String(dataUrl || '');
  const match = input.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\n\r]+)$/);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const base64Payload = match[2].replace(/[\n\r]/g, '');
  const buffer = Buffer.from(base64Payload, 'base64');
  if (!buffer.length) return null;
  return {
    mimeType,
    buffer,
  };
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function normalizeFollowupPhotos(rawPhotos) {
  const photos = Array.isArray(rawPhotos) ? rawPhotos : [];
  if (photos.length > MAX_FOLLOWUP_PHOTOS_PER_REQUEST) {
    throw new Error(`Selecione no maximo ${MAX_FOLLOWUP_PHOTOS_PER_REQUEST} fotos por envio.`);
  }

  const normalized = [];
  photos.forEach((photo, index) => {
    const parsed = decodeImageDataUrl(photo?.dataUrl);
    if (!parsed) return;
    if (parsed.buffer.length > MAX_FOLLOWUP_PHOTO_SIZE) {
      throw new Error(`A foto ${sanitizePhotoName(photo?.name, index)} excede 2MB.`);
    }

    const stage = normalizePhotoStage(photo?.stage);
    const nowIso = new Date().toISOString();
    normalized.push({
      id: String(photo?.id || crypto.randomUUID()),
      name: sanitizePhotoName(photo?.name, index),
      type: parsed.mimeType,
      size: Number(photo?.size) || parsed.buffer.length,
      stage,
      description: photo?.description ? String(photo.description).slice(0, 240) : null,
      createdAt: String(photo?.createdAt || nowIso),
      dataUrl: String(photo.dataUrl),
    });
  });

  return normalized;
}

function buildFollowupPhotoDocumentation(input, existingDocumentation) {
  const current = existingDocumentation && typeof existingDocumentation === 'object' ? existingDocumentation : {};
  const existingPhotos = Array.isArray(current.photos) ? current.photos : [];
  const existingUpdates = Array.isArray(current.updates) ? current.updates : [];

  const notesRaw = input?.notes;
  const notes = notesRaw == null ? null : String(notesRaw).trim();
  const normalizedPhotos = normalizeFollowupPhotos(input?.photos);

  return {
    notes,
    photos: [...existingPhotos, ...normalizedPhotos],
    updates: existingUpdates,
    addedPhotosCount: normalizedPhotos.length,
  };
}

function appendClinicalText(existingValue, newChunk, label) {
  const base = String(existingValue || '').trim();
  const chunk = String(newChunk || '').trim();
  if (!chunk) return base || null;
  const stamp = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  const block = `[Atualizacao ${stamp}${label ? ` - ${label}` : ''}]\n${chunk}`;
  return base ? `${base}\n\n${block}` : block;
}

function ensurePdfSpace(pdf, minHeight) {
  const available = pdf.page.height - pdf.page.margins.bottom - pdf.y;
  if (available < minHeight) {
    pdf.addPage();
  }
}

function renderFollowupPhotosOnPdf(pdf, photos) {
  if (!Array.isArray(photos) || photos.length === 0) return;

  pdf.moveDown(0.5);
  pdf.fontSize(12).fillColor('#111827').text('Galeria de Foto-documentacao', { underline: true });
  pdf.moveDown(0.4);

  const marginLeft = pdf.page.margins.left;
  const maxWidth = pdf.page.width - pdf.page.margins.left - pdf.page.margins.right;
  const colGap = 10;
  const cols = 2;
  const tileWidth = (maxWidth - colGap) / cols;
  const tileHeight = 150;
  let x = marginLeft;
  let y = pdf.y;

  photos.forEach((photo, index) => {
    const parsed = decodeImageDataUrl(photo?.dataUrl);
    if (!parsed) return;

    if (y + tileHeight > pdf.page.height - pdf.page.margins.bottom) {
      pdf.addPage();
      x = marginLeft;
      y = pdf.y;
    }

    pdf.save();
    pdf.roundedRect(x, y, tileWidth, tileHeight, 6).lineWidth(0.7).strokeColor('#d1d5db').stroke();
    try {
      pdf.image(parsed.buffer, x + 6, y + 6, {
        fit: [tileWidth - 12, 102],
        align: 'center',
        valign: 'center',
      });
    } catch (_e) {
      pdf.fontSize(8).fillColor('#6b7280').text('Nao foi possivel renderizar a imagem', x + 8, y + 45, {
        width: tileWidth - 16,
        align: 'center',
      });
    }

    pdf.fillColor('#1f2937').fontSize(8).text(`${index + 1}. ${safeText(photo?.stage || 'GERAL')}`, x + 6, y + 112, {
      width: tileWidth - 12,
      lineBreak: false,
    });
    pdf.fillColor('#4b5563').fontSize(8).text(safeText(photo?.name || 'foto'), x + 6, y + 123, {
      width: tileWidth - 12,
      ellipsis: true,
    });
    pdf.restore();

    if (x + tileWidth + colGap + tileWidth <= marginLeft + maxWidth + 1) {
      x += tileWidth + colGap;
    } else {
      x = marginLeft;
      y += tileHeight + 10;
    }
  });

  if (x !== marginLeft) {
    y += tileHeight + 10;
  }
  pdf.y = y;
}

async function findPatientScoped(patientId, clinicId) {
  const hasPatientsClinicId = await hasColumn('patients', 'clinic_id');
  return hasPatientsClinicId
    ? query('SELECT id FROM patients WHERE id = $1 AND clinic_id = $2', [patientId, clinicId])
    : query('SELECT id FROM patients WHERE id = $1', [patientId]);
}

router.get('/', requireDoctorOrReceptionist, requirePatientPermission('patients', 'view'), async (_req, res, next) => {
  try {
    const [hasPhone, hasDocumentId, hasBirthDate, hasAddress, hasReferenceFace, hasEmergencyContactName, hasEmergencyContactPhone, hasMedicalHistory, hasLgpdConsentVersion, hasLgpdConsentAt, hasPatientsClinicId] = await Promise.all([
      hasColumn('patients', 'phone'),
      hasColumn('patients', 'document_id'),
      hasColumn('patients', 'birth_date'),
      hasColumn('patients', 'address'),
      hasColumn('patients', 'reference_face_path'),
      hasColumn('patients', 'emergency_contact_name'),
      hasColumn('patients', 'emergency_contact_phone'),
      hasColumn('patients', 'medical_history'),
      hasColumn('patients', 'lgpd_consent_version'),
      hasColumn('patients', 'lgpd_consent_at'),
      hasColumn('patients', 'clinic_id'),
    ]);

    const items = await query(
      `SELECT id, name, email,
              ${hasPhone ? 'phone' : 'NULL::text AS phone'},
              ${hasDocumentId ? 'document_id' : 'NULL::text AS document_id'},
              ${hasBirthDate ? 'birth_date' : 'NULL::date AS birth_date'},
              ${hasAddress ? 'address' : 'NULL::text AS address'},
              ${hasReferenceFace ? 'reference_face_path' : 'NULL::text AS reference_face_path'},
              ${hasEmergencyContactName ? 'emergency_contact_name' : 'NULL::text AS emergency_contact_name'},
              ${hasEmergencyContactPhone ? 'emergency_contact_phone' : 'NULL::text AS emergency_contact_phone'},
              ${hasMedicalHistory ? 'medical_history' : 'NULL::text AS medical_history'},
              ${hasLgpdConsentVersion ? 'lgpd_consent_version' : 'NULL::text AS lgpd_consent_version'},
              ${hasLgpdConsentAt ? 'lgpd_consent_at' : 'NULL::timestamptz AS lgpd_consent_at'},
              created_at
       FROM patients
       ${hasPatientsClinicId ? 'WHERE clinic_id = $1' : ''}
       ORDER BY created_at DESC`,
      hasPatientsClinicId ? [(_req.doctor?.clinicId || null)] : []
    );
    return res.json(items.rows);
  } catch (error) {
    return next(error);
  }
});

router.get('/medical-records/history', requireDoctorOrReceptionist, requirePatientPermission('patients.records', 'view'), async (_req, res, next) => {
  try {
    if (!(await hasTable('medical_records'))) {
      return res.status(412).json({
        error: 'Estrutura de prontuario nao encontrada. Execute supabase/schema.sql atualizado.',
      });
    }

    const [hasConsultations, hasSurgeries, hasMedicalRecordsClinicId, hasPatientsClinicId, hasConsultationsClinicId, hasSurgeriesClinicId] = await Promise.all([
      hasTable('consultations'),
      hasTable('surgeries'),
      hasColumn('medical_records', 'clinic_id'),
      hasColumn('patients', 'clinic_id'),
      hasColumn('consultations', 'clinic_id'),
      hasColumn('surgeries', 'clinic_id'),
    ]);

    const clinicId = _req.doctor?.clinicId || null;
    const whereSql = hasMedicalRecordsClinicId
      ? 'WHERE mr.clinic_id = $1'
      : (hasPatientsClinicId ? 'WHERE p.clinic_id = $1' : '');
    const whereValues = whereSql ? [clinicId] : [];

    const consultationsCountExpr = hasConsultations
      ? (hasConsultationsClinicId
          ? '(SELECT COUNT(*)::int FROM consultations c WHERE c.patient_id = mr.patient_id AND c.clinic_id = mr.clinic_id)'
          : '(SELECT COUNT(*)::int FROM consultations c WHERE c.patient_id = mr.patient_id)')
      : '0::int';
    const surgeriesCountExpr = hasSurgeries
      ? (hasSurgeriesClinicId
          ? '(SELECT COUNT(*)::int FROM surgeries s WHERE s.patient_id = mr.patient_id AND s.clinic_id = mr.clinic_id)'
          : '(SELECT COUNT(*)::int FROM surgeries s WHERE s.patient_id = mr.patient_id)')
      : '0::int';

    const records = await query(
      `SELECT mr.id, mr.patient_id, mr.doctor_id, mr.title, mr.summary, mr.clinical_history,
              mr.allergies, mr.chronic_conditions, mr.current_medications,
              mr.status, mr.closed_at,
              mr.created_at, mr.updated_at,
              p.name AS patient_name, p.email AS patient_email, p.phone AS patient_phone,
              d.name AS doctor_name, d.crm AS doctor_crm,
              ${consultationsCountExpr} AS consultations_count,
              ${surgeriesCountExpr} AS surgeries_count
       FROM medical_records mr
       INNER JOIN patients p ON p.id = mr.patient_id
       LEFT JOIN doctors d ON d.id = mr.doctor_id
       ${whereSql}
       ORDER BY mr.updated_at DESC, mr.created_at DESC
       LIMIT 300`,
      whereValues
    );

    return res.json(records.rows);
  } catch (error) {
    return next(error);
  }
});

router.post('/', requireDoctorOrReceptionist, requireDoctorRoleOnly, async (req, res, next) => {
  try {
    const {
      name,
      email,
      phone,
      documentId,
      birthDate,
      address,
      password,
      faceImage,
      emergencyContactName,
      emergencyContactPhone,
      medicalHistory,
      lgpdConsentVersion,
      lgpdConsentAt,
    } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nome, email e senha do paciente sao obrigatorios' });
    }

    const hasPatientsClinicIdForEmail = await hasColumn('patients', 'clinic_id');
    const exists = hasPatientsClinicIdForEmail
      ? await query('SELECT id FROM patients WHERE email = $1 AND clinic_id = $2', [email, req.doctor.clinicId || null])
      : await query('SELECT id FROM patients WHERE email = $1', [email]);
    if (exists.rowCount > 0) {
      return res.status(409).json({ error: 'Ja existe paciente com este e-mail' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const [hasPhone, hasDocumentId, hasBirthDate, hasAddress, hasReferenceFace, hasPasswordHash, hasEmergencyContactName, hasEmergencyContactPhone, hasMedicalHistory, hasLgpdConsentVersion, hasLgpdConsentAt, hasPatientsClinicId] = await Promise.all([
      hasColumn('patients', 'phone'),
      hasColumn('patients', 'document_id'),
      hasColumn('patients', 'birth_date'),
      hasColumn('patients', 'address'),
      hasColumn('patients', 'reference_face_path'),
      hasColumn('patients', 'password_hash'),
      hasColumn('patients', 'emergency_contact_name'),
      hasColumn('patients', 'emergency_contact_phone'),
      hasColumn('patients', 'medical_history'),
      hasColumn('patients', 'lgpd_consent_version'),
      hasColumn('patients', 'lgpd_consent_at'),
      hasColumn('patients', 'clinic_id'),
    ]);

    if (!hasPasswordHash) {
      return res.status(500).json({
        error: 'Estrutura do banco incompleta: coluna patients.password_hash ausente. Execute supabase/schema.sql no schema public.',
      });
    }

    const insertColumns = ['name', 'email'];
    const insertValues = [name, email];

    if (hasPhone) {
      insertColumns.push('phone');
      insertValues.push(phone || null);
    }
    if (hasDocumentId) {
      insertColumns.push('document_id');
      insertValues.push(documentId || null);
    }
    if (hasBirthDate) {
      insertColumns.push('birth_date');
      insertValues.push(birthDate || null);
    }

    if (hasAddress) {
      insertColumns.push('address');
      insertValues.push(address || null);
    }
    if (hasReferenceFace) {
      insertColumns.push('reference_face_path');
      insertValues.push(faceImage || null);
    }
    if (hasEmergencyContactName) {
      insertColumns.push('emergency_contact_name');
      insertValues.push(emergencyContactName || null);
    }
    if (hasEmergencyContactPhone) {
      insertColumns.push('emergency_contact_phone');
      insertValues.push(emergencyContactPhone || null);
    }
    if (hasMedicalHistory) {
      insertColumns.push('medical_history');
      insertValues.push(medicalHistory || null);
    }
    if (hasLgpdConsentVersion) {
      insertColumns.push('lgpd_consent_version');
      insertValues.push(lgpdConsentVersion || null);
    }
    if (hasLgpdConsentAt) {
      insertColumns.push('lgpd_consent_at');
      insertValues.push(lgpdConsentAt || null);
    }

    insertColumns.push('password_hash');
    insertValues.push(passwordHash);
    if (hasPatientsClinicId) {
      insertColumns.push('clinic_id');
      insertValues.push(req.doctor.clinicId || null);
    }

    const valuePlaceholders = insertValues.map((_, index) => `$${index + 1}`).join(', ');

    const inserted = await query(
      `INSERT INTO patients (${insertColumns.join(', ')})
       VALUES (${valuePlaceholders})
       RETURNING id, name, email,
                 ${hasPhone ? 'phone' : 'NULL::text AS phone'},
                 ${hasDocumentId ? 'document_id' : 'NULL::text AS document_id'},
                 ${hasBirthDate ? 'birth_date' : 'NULL::date AS birth_date'},
                 ${hasAddress ? 'address' : 'NULL::text AS address'},
                 ${hasReferenceFace ? 'reference_face_path' : 'NULL::text AS reference_face_path'},
                 ${hasEmergencyContactName ? 'emergency_contact_name' : 'NULL::text AS emergency_contact_name'},
                 ${hasEmergencyContactPhone ? 'emergency_contact_phone' : 'NULL::text AS emergency_contact_phone'},
                 ${hasMedicalHistory ? 'medical_history' : 'NULL::text AS medical_history'},
                 ${hasLgpdConsentVersion ? 'lgpd_consent_version' : 'NULL::text AS lgpd_consent_version'},
                 ${hasLgpdConsentAt ? 'lgpd_consent_at' : 'NULL::timestamptz AS lgpd_consent_at'},
                 created_at`,
      insertValues
    );

    const patient = inserted.rows[0];

    if (await hasTable('medical_records')) {
      const hasMedicalRecordsClinicId = await hasColumn('medical_records', 'clinic_id');
      // doctor_id e nullable — se quem cadastrou foi a recepcao, deixa em
      // aberto (sem medico responsavel ainda) em vez de tentar gravar um id
      // que nao existe na tabela doctors (violaria a FK).
      const creatorDoctorId = req.user.role === 'DOCTOR' ? req.doctor.id : null;
      await query(
        `INSERT INTO medical_records (patient_id, doctor_id, title, summary, status, closed_at${hasMedicalRecordsClinicId ? ', clinic_id' : ''})
         VALUES ($1, $2, $3, $4, 'OPEN', NULL${hasMedicalRecordsClinicId ? ', $5' : ''})`,
        [patient.id, creatorDoctorId, 'Prontuario Inicial', 'Prontuario criado automaticamente no cadastro do paciente.', ...(hasMedicalRecordsClinicId ? [req.doctor.clinicId || null] : [])]
      );
    }

    socketService.emitToDoctor(req.doctor.id, 'patient_created', {
      id: patient.id,
      name: patient.name,
      email: patient.email,
      clinicId: req.doctor.clinicId || null,
    });

    const baseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    let inviteEmail = { sent: false };
    try {
      inviteEmail = await sendPatientWelcomeEmail({
        to: patient.email,
        patientName: patient.name,
        loginLink: `${baseUrl}/paciente/login`,
        tempPassword: password,
      });
    } catch (emailErr) {
      console.warn('[Email] Erro ao enviar email de boas-vindas:', emailErr.message);
    }

    return res.status(201).json({
      patient,
      inviteEmail,
    });
  } catch (error) {
    console.error('[Patients POST] Erro:', error.message, error.stack);
    if (error.code === '42703') {
      return res.status(500).json({ error: 'Coluna inexistente no banco. Execute a migration SQL.' });
    }
    return next(error);
  }
});

router.post('/self-registration-links', requireDoctorOrReceptionist, requirePatientPermission('patients', 'create'), async (req, res, next) => {
  try {
    if (!(await hasTable('patient_registration_links'))) {
      return res.status(412).json({ error: 'Estrutura de links de cadastro ainda nao foi aplicada no banco.' });
    }

    const requestedEmail = String(req.body?.email || '').trim().toLowerCase() || null;
    const expiresHoursRaw = Number(req.body?.expiresInHours);
    const expiresInHours = Number.isFinite(expiresHoursRaw)
      ? Math.max(1, Math.min(168, Math.floor(expiresHoursRaw)))
      : 72;

    const token = randomToken();
    const expiresAt = new Date(Date.now() + (expiresInHours * 60 * 60 * 1000)).toISOString();

    // doctor_id e nullable — se foi a recepcao que gerou o link, deixa sem
    // medico associado (evita violar a FK com um id que nao existe em doctors).
    const creatorDoctorId = req.user.role === 'DOCTOR' ? req.doctor.id : null;
    const inserted = await query(
      `INSERT INTO patient_registration_links (
         token, clinic_id, doctor_id, requested_email, status, expires_at
       ) VALUES ($1, $2, $3, $4, 'OPEN', $5)
       RETURNING id, token, requested_email, status, expires_at, created_at`,
      [token, req.doctor.clinicId || null, creatorDoctorId, requestedEmail, expiresAt]
    );

    const baseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3020}`;
    const registrationUrl = `${baseUrl}/paciente/cadastro/${token}`;

    let emailResult = { sent: false };
    if (requestedEmail) {
      try {
        emailResult = await sendLinkEmail({
          to: requestedEmail,
          subject: 'Link para cadastro de paciente',
          message: 'Use este link para preencher seu cadastro de paciente na clínica. O link possui validade limitada.',
          link: registrationUrl,
        });
      } catch (emailErr) {
        console.warn('[Patient Self Registration] Erro ao enviar e-mail de link:', emailErr.message);
      }
    }

    await query(
      `UPDATE patient_registration_links
          SET sent_via_email = $2,
              updated_at = now()
        WHERE id = $1`,
      [inserted.rows[0].id, !!emailResult.sent]
    );

    return res.status(201).json({
      link: inserted.rows[0],
      registrationUrl,
      emailResult,
    });
  } catch (error) {
    return next(error);
  }
});

router.put('/:id', requireDoctorOrReceptionist, requirePatientPermission('patients', 'update'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      name,
      email,
      phone,
      documentId,
      birthDate,
      address,
      faceImage,
      password,
      emergencyContactName,
      emergencyContactPhone,
      medicalHistory,
      lgpdConsentVersion,
      lgpdConsentAt,
    } = req.body;

    const [hasPhone, hasDocumentId, hasBirthDate, hasAddress, hasReferenceFace, hasPasswordHash, hasEmergencyContactName, hasEmergencyContactPhone, hasMedicalHistory, hasLgpdConsentVersion, hasLgpdConsentAt, hasPatientsClinicId] = await Promise.all([
      hasColumn('patients', 'phone'),
      hasColumn('patients', 'document_id'),
      hasColumn('patients', 'birth_date'),
      hasColumn('patients', 'address'),
      hasColumn('patients', 'reference_face_path'),
      hasColumn('patients', 'password_hash'),
      hasColumn('patients', 'emergency_contact_name'),
      hasColumn('patients', 'emergency_contact_phone'),
      hasColumn('patients', 'medical_history'),
      hasColumn('patients', 'lgpd_consent_version'),
      hasColumn('patients', 'lgpd_consent_at'),
      hasColumn('patients', 'clinic_id'),
    ]);

    const existing = hasPatientsClinicId
      ? await query('SELECT id, email FROM patients WHERE id = $1 AND clinic_id = $2', [id, req.doctor.clinicId || null])
      : await query('SELECT id, email FROM patients WHERE id = $1', [id]);
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'Paciente nao encontrado' });
    }

    const nextEmail = String(email || existing.rows[0].email || '').trim();
    if (nextEmail) {
      const emailConflict = hasPatientsClinicId
        ? await query('SELECT id FROM patients WHERE email = $1 AND id <> $2 AND clinic_id = $3', [nextEmail, id, req.doctor.clinicId || null])
        : await query('SELECT id FROM patients WHERE email = $1 AND id <> $2', [nextEmail, id]);
      if (emailConflict.rowCount > 0) {
        return res.status(409).json({ error: 'Ja existe paciente com este e-mail' });
      }
    }

    const sets = [];
    const values = [];
    const pushSet = (col, val) => {
      values.push(val);
      sets.push(`${col} = $${values.length}`);
    };

    pushSet('name', name || null);
    pushSet('email', nextEmail || null);
    if (hasPhone) pushSet('phone', phone || null);
    if (hasDocumentId) pushSet('document_id', documentId || null);
    if (hasBirthDate) pushSet('birth_date', birthDate || null);
    if (hasAddress) pushSet('address', address || null);
    if (hasReferenceFace && Object.prototype.hasOwnProperty.call(req.body, 'faceImage')) {
      pushSet('reference_face_path', faceImage || null);
    }
    if (hasEmergencyContactName) pushSet('emergency_contact_name', emergencyContactName || null);
    if (hasEmergencyContactPhone) pushSet('emergency_contact_phone', emergencyContactPhone || null);
    if (hasMedicalHistory) pushSet('medical_history', medicalHistory || null);
    if (hasLgpdConsentVersion) pushSet('lgpd_consent_version', lgpdConsentVersion || null);
    if (hasLgpdConsentAt) pushSet('lgpd_consent_at', lgpdConsentAt || null);
    if (hasPasswordHash && password) {
      pushSet('password_hash', bcrypt.hashSync(password, 10));
    }

    values.push(id);
     if (hasPatientsClinicId) values.push(req.doctor.clinicId || null);
    const updated = await query(
      `UPDATE patients
       SET ${sets.join(', ')}
       WHERE id = $${hasPatientsClinicId ? values.length - 1 : values.length}
       ${hasPatientsClinicId ? `AND clinic_id = $${values.length}` : ''}
       RETURNING id, name, email,
                 ${hasPhone ? 'phone' : 'NULL::text AS phone'},
                 ${hasDocumentId ? 'document_id' : 'NULL::text AS document_id'},
                 ${hasBirthDate ? 'birth_date' : 'NULL::date AS birth_date'},
                 ${hasAddress ? 'address' : 'NULL::text AS address'},
                 ${hasReferenceFace ? 'reference_face_path' : 'NULL::text AS reference_face_path'},
                 ${hasEmergencyContactName ? 'emergency_contact_name' : 'NULL::text AS emergency_contact_name'},
                 ${hasEmergencyContactPhone ? 'emergency_contact_phone' : 'NULL::text AS emergency_contact_phone'},
                 ${hasMedicalHistory ? 'medical_history' : 'NULL::text AS medical_history'},
                 ${hasLgpdConsentVersion ? 'lgpd_consent_version' : 'NULL::text AS lgpd_consent_version'},
                 ${hasLgpdConsentAt ? 'lgpd_consent_at' : 'NULL::timestamptz AS lgpd_consent_at'},
                 created_at`,
      values
    );

    socketService.emitToDoctor(req.doctor.id, 'patient_updated', {
      id: updated.rows[0].id,
      name: updated.rows[0].name,
      email: updated.rows[0].email,
      clinicId: req.doctor.clinicId || null,
    });

    return res.json({ patient: updated.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.get('/:id/medical-records', requireDoctorOrReceptionist, requirePatientPermission(['patients.records', 'patients.profile'], 'view'), async (req, res, next) => {
  try {
    if (!(await hasTable('medical_records'))) {
      return res.status(412).json({
        error: 'Estrutura de prontuario nao encontrada. Execute supabase/schema.sql atualizado.',
      });
    }

    const { id } = req.params;
    const patient = await findPatientScoped(id, req.doctor.clinicId || null);
    if (patient.rowCount === 0) {
      return res.status(404).json({ error: 'Paciente nao encontrado' });
    }

    const records = await query(
      `SELECT id, patient_id, doctor_id, title, summary,
              clinical_history, allergies, chronic_conditions,
              current_medications, status, closed_at,
              lgpd_consent_version, lgpd_consent_at,
              created_at, updated_at
       FROM medical_records
       WHERE patient_id = $1
       ORDER BY updated_at DESC, created_at DESC`,
      [id]
    );

    return res.json(records.rows);
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/medical-records', requireDoctorOrReceptionist, requireDoctorRoleOnly, async (req, res, next) => {
  try {
    if (!(await hasTable('medical_records'))) {
      return res.status(412).json({
        error: 'Estrutura de prontuario nao encontrada. Execute supabase/schema.sql atualizado.',
      });
    }

    const { id } = req.params;
    const {
      title,
      summary,
      clinicalHistory,
      allergies,
      chronicConditions,
      currentMedications,
      status,
      closedAt,
      lgpdConsentVersion,
      lgpdConsentAt,
    } = req.body || {};

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'Titulo do prontuario e obrigatorio' });
    }

    const patient = await findPatientScoped(id, req.doctor.clinicId || null);
    if (patient.rowCount === 0) {
      return res.status(404).json({ error: 'Paciente nao encontrado' });
    }

    // Regra de negocio: todo novo prontuario nasce em andamento e
    // so pode ser concluido quando for vinculado a um procedimento.
    const normalizedStatus = 'OPEN';
    const normalizedClosedAt = null;

    const inserted = await query(
      `INSERT INTO medical_records (
         patient_id, doctor_id, title, summary,
         clinical_history, allergies, chronic_conditions,
         current_medications, status, closed_at,
         lgpd_consent_version, lgpd_consent_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        id,
        req.doctor.id,
        String(title).trim(),
        summary || null,
        clinicalHistory || null,
        allergies || null,
        chronicConditions || null,
        currentMedications || null,
        normalizedStatus,
        normalizedClosedAt,
        lgpdConsentVersion || null,
        lgpdConsentAt || null,
      ]
    );

    socketService.emitToDoctor(req.doctor.id, 'medical_record_created', {
      id: inserted.rows[0].id,
      patient_id: id,
      title: inserted.rows[0].title,
      clinicId: req.doctor.clinicId || null,
    });

    return res.status(201).json({ record: inserted.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.get('/:id/medical-records/:recordId/download/pdf', requireDoctorOrReceptionist, requirePatientPermission(['patients.records', 'patients.profile'], 'view'), async (req, res, next) => {
  try {
    if (!(await hasTable('medical_records'))) {
      return res.status(412).json({
        error: 'Estrutura de prontuario nao encontrada. Execute supabase/schema.sql atualizado.',
      });
    }

    const { id, recordId } = req.params;
    const recordResult = await query(
      `SELECT mr.*, p.name AS patient_name, p.email AS patient_email, p.phone AS patient_phone,
              d.name AS doctor_name, d.crm AS doctor_crm
       FROM medical_records mr
       INNER JOIN patients p ON p.id = mr.patient_id
       LEFT JOIN doctors d ON d.id = mr.doctor_id
       WHERE mr.id = $1 AND mr.patient_id = $2
       LIMIT 1`,
      [recordId, id]
    );

    if (recordResult.rowCount === 0) {
      return res.status(404).json({ error: 'Prontuario nao encontrado para este paciente' });
    }

    const record = recordResult.rows[0];
    const fileName = `prontuario-${record.id}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const pdf = new PDFDocument({ margin: 40, size: 'A4' });
    pdf.pipe(res);

    pdf.fontSize(18).text('Prontuario Medico', { underline: true });
    pdf.moveDown(0.5);
    pdf.fontSize(10).fillColor('#4a5568').text(`Prontuario ID: ${record.id}`);
    pdf.text(`Atualizado em: ${formatDateTime(record.updated_at || record.created_at)}`);
    pdf.moveDown();

    pdf.fontSize(13).fillColor('#111827').text('Paciente', { underline: true });
    pdf.fontSize(10).fillColor('#111827');
    pdf.text(`Nome: ${safeText(record.patient_name)}`);
    pdf.text(`Contato: ${safeText(record.patient_email)} ${record.patient_phone ? `- ${safeText(record.patient_phone)}` : ''}`);
    pdf.moveDown();

    pdf.fontSize(13).text('Profissional', { underline: true });
    pdf.fontSize(10);
    pdf.text(`Nome: ${safeText(record.doctor_name)} ${record.doctor_crm ? `(${safeText(record.doctor_crm)})` : ''}`);
    pdf.moveDown();

    pdf.fontSize(13).text('Resumo Clinico', { underline: true });
    pdf.fontSize(10);
    pdf.text(`Titulo: ${safeText(record.title)}`);
    pdf.text(`Resumo: ${safeText(record.summary)}`);
    pdf.text(`Historia clinica: ${safeText(record.clinical_history)}`);
    pdf.text(`Alergias: ${safeText(record.allergies)}`);
    pdf.text(`Condicoes cronicas: ${safeText(record.chronic_conditions)}`);
    pdf.text(`Medicacoes em uso: ${safeText(record.current_medications)}`);
    pdf.text(`Status: ${safeText(record.status)}`);
    if (record.closed_at) pdf.text(`Concluido em: ${formatDateTime(record.closed_at)}`);

    pdf.end();
  } catch (error) {
    return next(error);
  }
});

router.get('/:id/clinical-followups', requireDoctorOrReceptionist, requirePatientPermission(['patients.followups', 'patients.profile'], 'view'), async (req, res, next) => {
  try {
    if (!(await hasTable('patient_clinical_followups'))) {
      return res.status(412).json({
        error: 'Estrutura de acompanhamento clinico nao encontrada. Execute supabase/schema.sql atualizado.',
      });
    }

    const { id } = req.params;
    const patient = await findPatientScoped(id, req.doctor.clinicId || null);
    if (patient.rowCount === 0) {
      return res.status(404).json({ error: 'Paciente nao encontrado' });
    }

    const hasFollowupSurgeryId = await hasColumn('patient_clinical_followups', 'surgery_id');
    const surgeryColumns = hasFollowupSurgeryId
      ? `, f.surgery_id, s.title AS surgery_title, s.status AS surgery_status,
            sd.status AS surgery_document_status`
      : `, NULL::uuid AS surgery_id, NULL::text AS surgery_title, NULL::text AS surgery_status,
            NULL::text AS surgery_document_status`;
    const surgeryJoins = hasFollowupSurgeryId
      ? `
       LEFT JOIN surgeries s ON s.id = f.surgery_id
       LEFT JOIN LATERAL (
         SELECT d2.status
         FROM surgery_documents d2
         WHERE d2.surgery_id = s.id
         ORDER BY d2.created_at DESC NULLS LAST, d2.id DESC
         LIMIT 1
       ) sd ON true`
      : '';

    const items = await query(
      `SELECT f.*, d.name AS doctor_name, d.crm,
              mr.title AS medical_record_title
              ${surgeryColumns}
       FROM patient_clinical_followups f
       LEFT JOIN doctors d ON d.id = f.doctor_id
       LEFT JOIN medical_records mr ON mr.id = f.medical_record_id
       ${surgeryJoins}
       WHERE f.patient_id = $1
       ORDER BY f.created_at DESC`,
      [id]
    );

    return res.json(items.rows);
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/clinical-followups', requireDoctorOrReceptionist, requireDoctorRoleOnly, async (req, res, next) => {
  try {
    if (!(await hasTable('patient_clinical_followups'))) {
      return res.status(412).json({
        error: 'Estrutura de acompanhamento clinico nao encontrada. Execute supabase/schema.sql atualizado.',
      });
    }

    const { id } = req.params;
    const {
      surgeryId,
      medicalRecordId,
      chiefComplaint,
      complaintDuration,
      historyPresentIllness,
      systemsReview,
      personalHistory,
      familyHistory,
      srq20Answers,
      physicalExamGeneral,
      physicalExamSpecial,
      surgicalRisk,
      diagnosisHypothesis,
      therapeuticPlan,
      evolutionNotes,
      photoDocumentation,
    } = req.body || {};

    const patient = await findPatientScoped(id, req.doctor.clinicId || null);
    if (patient.rowCount === 0) {
      return res.status(404).json({ error: 'Paciente nao encontrado' });
    }

    const hasFollowupSurgeryId = await hasColumn('patient_clinical_followups', 'surgery_id');
    if (!hasFollowupSurgeryId) {
      return res.status(412).json({
        error: 'Estrutura de acompanhamento desatualizada: coluna surgery_id ausente. Execute supabase/schema.sql atualizado.',
      });
    }

    if (!surgeryId) {
      return res.status(400).json({ error: 'Selecione um procedimento concluido e assinado para vincular ao acompanhamento' });
    }

    const surgeryResult = await query(
      `SELECT s.id, s.title, s.status, s.medical_record_id,
              sd.status AS document_status
       FROM surgeries s
       LEFT JOIN LATERAL (
         SELECT d.status
         FROM surgery_documents d
         WHERE d.surgery_id = s.id
         ORDER BY d.created_at DESC NULLS LAST, d.id DESC
         LIMIT 1
       ) sd ON true
       WHERE s.id = $1 AND s.patient_id = $2
       LIMIT 1`,
      [surgeryId, id]
    );

    if (surgeryResult.rowCount === 0) {
      return res.status(400).json({ error: 'Procedimento informado nao pertence ao paciente selecionado' });
    }

    const surgery = surgeryResult.rows[0];
    const surgeryStatus = String(surgery.status || '').toUpperCase();
    const docStatus = String(surgery.document_status || '').toUpperCase();
    if (!(surgeryStatus === 'COMPLETED' || surgeryStatus === 'SIGNED') || docStatus !== 'SIGNED') {
      return res.status(400).json({ error: 'Somente procedimentos concluidos e com documento assinado podem ser vinculados ao acompanhamento' });
    }

    const resolvedMedicalRecordId = medicalRecordId || surgery.medical_record_id || null;

    if (resolvedMedicalRecordId) {
      const record = await query('SELECT id FROM medical_records WHERE id = $1 AND patient_id = $2', [resolvedMedicalRecordId, id]);
      if (record.rowCount === 0) {
        return res.status(400).json({ error: 'Prontuario informado nao pertence ao paciente selecionado' });
      }
    }

    const mergedPhotoDocumentation = buildFollowupPhotoDocumentation(photoDocumentation, {});
    mergedPhotoDocumentation.updates = [{
      id: crypto.randomUUID(),
      type: 'CREATE',
      created_at: new Date().toISOString(),
      notes: mergedPhotoDocumentation.notes || null,
      added_photos: mergedPhotoDocumentation.addedPhotosCount,
    }];

    const inserted = await query(
      `INSERT INTO patient_clinical_followups (
         patient_id, doctor_id, surgery_id, medical_record_id,
         chief_complaint, complaint_duration, history_present_illness,
         systems_review, personal_history, family_history, srq20_answers,
         physical_exam_general, physical_exam_special, surgical_risk,
         diagnosis_hypothesis, therapeutic_plan, evolution_notes,
         photo_documentation
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7,
         $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb,
         $12, $13, $14,
         $15, $16, $17,
         $18::jsonb
       )
       RETURNING *`,
      [
        id,
        req.doctor.id,
        surgeryId,
        resolvedMedicalRecordId,
        chiefComplaint || null,
        complaintDuration || null,
        historyPresentIllness || null,
        JSON.stringify(systemsReview || {}),
        JSON.stringify(personalHistory || {}),
        JSON.stringify(familyHistory || {}),
        JSON.stringify(srq20Answers || {}),
        physicalExamGeneral || null,
        physicalExamSpecial || null,
        surgicalRisk || null,
        diagnosisHypothesis || null,
        therapeuticPlan || null,
        evolutionNotes || null,
        JSON.stringify({
          notes: mergedPhotoDocumentation.notes,
          photos: mergedPhotoDocumentation.photos,
          updates: mergedPhotoDocumentation.updates,
        }),
      ]
    );

    socketService.emitToDoctor(req.doctor.id, 'clinical_followup_created', {
      id: inserted.rows[0].id,
      patient_id: id,
      clinicId: req.doctor.clinicId || null,
    });

    return res.status(201).json({ followup: inserted.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.patch('/:id/clinical-followups/:followupId', requireDoctorOrReceptionist, requireDoctorRoleOnly, async (req, res, next) => {
  try {
    if (!(await hasTable('patient_clinical_followups'))) {
      return res.status(412).json({
        error: 'Estrutura de acompanhamento clinico nao encontrada. Execute supabase/schema.sql atualizado.',
      });
    }

    const { id, followupId } = req.params;
    const patient = await findPatientScoped(id, req.doctor.clinicId || null);
    if (patient.rowCount === 0) {
      return res.status(404).json({ error: 'Paciente nao encontrado' });
    }

    const existingResult = await query(
      `SELECT id, evolution_notes, diagnosis_hypothesis, therapeutic_plan,
              physical_exam_general, physical_exam_special, surgical_risk, photo_documentation
       FROM patient_clinical_followups
       WHERE id = $1 AND patient_id = $2
       LIMIT 1`,
      [followupId, id]
    );

    if (existingResult.rowCount === 0) {
      return res.status(404).json({ error: 'Acompanhamento nao encontrado para este paciente' });
    }

    const current = existingResult.rows[0];
    const {
      additionalNotes,
      diagnosisUpdate,
      therapeuticPlanUpdate,
      physicalExamGeneralUpdate,
      physicalExamSpecialUpdate,
      surgicalRiskUpdate,
      photoDocumentation,
    } = req.body || {};

    const evolutionNotes = appendClinicalText(current.evolution_notes, additionalNotes, 'Evolucao');
    const diagnosisHypothesis = appendClinicalText(current.diagnosis_hypothesis, diagnosisUpdate, 'Diagnostico');
    const therapeuticPlan = appendClinicalText(current.therapeutic_plan, therapeuticPlanUpdate, 'Plano terapeutico');
    const physicalExamGeneral = appendClinicalText(current.physical_exam_general, physicalExamGeneralUpdate, 'Exame fisico geral');
    const physicalExamSpecial = appendClinicalText(current.physical_exam_special, physicalExamSpecialUpdate, 'Exame fisico especial');
    const surgicalRisk = appendClinicalText(current.surgical_risk, surgicalRiskUpdate, 'Risco cirurgico');

    const mergedPhotoDocumentation = buildFollowupPhotoDocumentation(photoDocumentation, current.photo_documentation);
    const existingUpdates = Array.isArray(current.photo_documentation?.updates)
      ? current.photo_documentation.updates
      : [];

    mergedPhotoDocumentation.updates = [
      ...existingUpdates,
      {
        id: crypto.randomUUID(),
        type: 'UPDATE',
        created_at: new Date().toISOString(),
        notes: photoDocumentation?.notes ? String(photoDocumentation.notes).trim() : null,
        added_photos: mergedPhotoDocumentation.addedPhotosCount,
        added_evolution: String(additionalNotes || '').trim() ? true : false,
      },
    ];

    const updated = await query(
      `UPDATE patient_clinical_followups
       SET evolution_notes = $3,
           diagnosis_hypothesis = $4,
           therapeutic_plan = $5,
           physical_exam_general = $6,
           physical_exam_special = $7,
           surgical_risk = $8,
           photo_documentation = $9::jsonb
       WHERE id = $1 AND patient_id = $2
       RETURNING *`,
      [
        followupId,
        id,
        evolutionNotes,
        diagnosisHypothesis,
        therapeuticPlan,
        physicalExamGeneral,
        physicalExamSpecial,
        surgicalRisk,
        JSON.stringify({
          notes: mergedPhotoDocumentation.notes,
          photos: mergedPhotoDocumentation.photos,
          updates: mergedPhotoDocumentation.updates,
        }),
      ]
    );

    socketService.emitToDoctor(req.doctor.id, 'clinical_followup_updated', {
      id: updated.rows[0].id,
      patient_id: id,
      clinicId: req.doctor.clinicId || null,
    });

    return res.json({ followup: updated.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.get('/:id/clinical-followups/:followupId/download/pdf', requireDoctorOrReceptionist, requirePatientPermission(['patients.followups', 'patients.profile'], 'view'), async (req, res, next) => {
  try {
    if (!(await hasTable('patient_clinical_followups'))) {
      return res.status(412).json({
        error: 'Estrutura de acompanhamento clinico nao encontrada. Execute supabase/schema.sql atualizado.',
      });
    }

    const { id, followupId } = req.params;
    const hasFollowupSurgeryId = await hasColumn('patient_clinical_followups', 'surgery_id');
    const surgeryColumns = hasFollowupSurgeryId
      ? `, f.surgery_id, s.title AS surgery_title, s.status AS surgery_status,
            sd.status AS surgery_document_status`
      : `, NULL::uuid AS surgery_id, NULL::text AS surgery_title, NULL::text AS surgery_status,
            NULL::text AS surgery_document_status`;
    const surgeryJoins = hasFollowupSurgeryId
      ? `
       LEFT JOIN surgeries s ON s.id = f.surgery_id
       LEFT JOIN LATERAL (
         SELECT d2.status
         FROM surgery_documents d2
         WHERE d2.surgery_id = s.id
         ORDER BY d2.created_at DESC NULLS LAST, d2.id DESC
         LIMIT 1
       ) sd ON true`
      : '';

    const followupResult = await query(
      `SELECT f.*, d.name AS doctor_name, d.crm,
              p.name AS patient_name, p.email AS patient_email,
              mr.title AS medical_record_title
              ${surgeryColumns}
       FROM patient_clinical_followups f
       INNER JOIN patients p ON p.id = f.patient_id
       LEFT JOIN doctors d ON d.id = f.doctor_id
       LEFT JOIN medical_records mr ON mr.id = f.medical_record_id
       ${surgeryJoins}
       WHERE f.id = $1 AND f.patient_id = $2
       LIMIT 1`,
      [followupId, id]
    );

    if (followupResult.rowCount === 0) {
      return res.status(404).json({ error: 'Acompanhamento nao encontrado para este paciente' });
    }

    const f = followupResult.rows[0];
    const photos = Array.isArray(f.photo_documentation?.photos) ? f.photo_documentation.photos : [];
    const fileName = `acompanhamento-${f.id}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const pdf = new PDFDocument({ margin: 40, size: 'A4' });
    pdf.pipe(res);

    pdf.fontSize(18).text('Acompanhamento Clinico', { underline: true });
    pdf.moveDown(0.5);
    pdf.fontSize(10).fillColor('#4a5568').text(`Acompanhamento ID: ${f.id}`);
    pdf.text(`Criado em: ${formatDateTime(f.created_at)}`);
    pdf.moveDown();

    pdf.fontSize(13).fillColor('#111827').text('Paciente e Profissional', { underline: true });
    pdf.fontSize(10).fillColor('#111827');
    pdf.text(`Paciente: ${safeText(f.patient_name)} (${safeText(f.patient_email)})`);
    pdf.text(`Profissional: ${safeText(f.doctor_name)} ${f.crm ? `(${safeText(f.crm)})` : ''}`);
    pdf.moveDown(0.3);
    pdf.text(`Procedimento vinculado: ${safeText(f.surgery_title)} (${safeText(f.surgery_status)})`);
    pdf.text(`Documento do procedimento: ${safeText(f.surgery_document_status)}`);
    if (f.medical_record_title) pdf.text(`Prontuario relacionado: ${safeText(f.medical_record_title)}`);
    pdf.moveDown();

    pdf.fontSize(13).text('Conteudo Clinico', { underline: true });
    pdf.fontSize(10);
    pdf.text(`Queixa principal: ${safeText(f.chief_complaint)}`);
    pdf.text(`Duracao da queixa: ${safeText(f.complaint_duration)}`);
    pdf.text(`Historia da doenca atual: ${safeText(f.history_present_illness)}`);
    pdf.text(`Surgical risk: ${safeText(f.surgical_risk)}`);
    pdf.text(`Hipotese diagnostica: ${safeText(f.diagnosis_hypothesis)}`);
    pdf.text(`Plano terapeutico: ${safeText(f.therapeutic_plan)}`);
    pdf.text(`Evolucao: ${safeText(f.evolution_notes)}`);
    pdf.moveDown(0.4);
    pdf.text(`Systems review: ${safeText(f.systems_review?.text)}`);
    pdf.text(`Antecedentes pessoais: ${safeText(f.personal_history?.text)}`);
    pdf.text(`Antecedentes familiares: ${safeText(f.family_history?.text)}`);
    pdf.text(`SRQ-20: ${safeText(f.srq20_answers?.score)}`);
    pdf.moveDown(0.4);
    pdf.text(`Foto-documentacao: ${photos.length} arquivo(s)`);
    if (f.photo_documentation?.notes) {
      pdf.text(`Observacoes das fotos: ${safeText(f.photo_documentation.notes)}`);
    }

    ensurePdfSpace(pdf, 40);
    renderFollowupPhotosOnPdf(pdf, photos);

    pdf.end();
  } catch (error) {
    return next(error);
  }
});

router.get('/:id/profile', requireDoctorOrReceptionist, requirePatientPermission('patients.profile', 'view'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const [hasEmergencyContactName, hasEmergencyContactPhone, hasMedicalHistory, hasLgpdConsentVersion, hasLgpdConsentAt, hasMedicalRecordsTable, hasPatientsClinicId, hasMedicalRecordsClinicId, hasConsultationsClinicId, hasSurgeriesClinicId, hasFollowupsClinicId] = await Promise.all([
      hasColumn('patients', 'emergency_contact_name'),
      hasColumn('patients', 'emergency_contact_phone'),
      hasColumn('patients', 'medical_history'),
      hasColumn('patients', 'lgpd_consent_version'),
      hasColumn('patients', 'lgpd_consent_at'),
      hasTable('medical_records'),
      hasColumn('patients', 'clinic_id'),
      hasColumn('medical_records', 'clinic_id'),
      hasColumn('consultations', 'clinic_id'),
      hasColumn('surgeries', 'clinic_id'),
      hasColumn('patient_clinical_followups', 'clinic_id'),
    ]);

    const patientResult = await query(
      `SELECT id, name, email, phone, document_id, birth_date, address, reference_face_path,
              ${hasEmergencyContactName ? 'emergency_contact_name' : 'NULL::text AS emergency_contact_name'},
              ${hasEmergencyContactPhone ? 'emergency_contact_phone' : 'NULL::text AS emergency_contact_phone'},
              ${hasMedicalHistory ? 'medical_history' : 'NULL::text AS medical_history'},
              ${hasLgpdConsentVersion ? 'lgpd_consent_version' : 'NULL::text AS lgpd_consent_version'},
              ${hasLgpdConsentAt ? 'lgpd_consent_at' : 'NULL::timestamptz AS lgpd_consent_at'},
              created_at
       FROM patients
       WHERE id = $1
       ${hasPatientsClinicId ? 'AND clinic_id = $2' : ''}`,
      hasPatientsClinicId ? [id, req.doctor.clinicId || null] : [id]
    );
    if (patientResult.rowCount === 0) {
      return res.status(404).json({ error: 'Paciente nao encontrado' });
    }

    const [recordsResult, consultationsResult, surgeriesResult, clinicalFollowupsResult] = await Promise.all([
      hasMedicalRecordsTable
        ? query(
          `SELECT id, title, summary, clinical_history, allergies, chronic_conditions,
                  current_medications, status, closed_at,
                  lgpd_consent_version, lgpd_consent_at,
                  created_at, updated_at
           FROM medical_records
           WHERE patient_id = $1
           ${hasMedicalRecordsClinicId ? 'AND clinic_id = $2' : ''}
           ORDER BY updated_at DESC, created_at DESC`,
          hasMedicalRecordsClinicId ? [id, req.doctor.clinicId || null] : [id]
        )
        : Promise.resolve({ rows: [] }),
      query(
        `SELECT c.id,
                c.consultation_at,
                c.summary,
                c.diagnosis,
                c.prescription,
                d.name AS doctor_name,
                d.crm,
                'CONSULTATION'::text AS source
         FROM consultations c
         INNER JOIN doctors d ON d.id = c.doctor_id
         WHERE c.patient_id = $1
         ${hasConsultationsClinicId ? 'AND c.clinic_id = $2' : ''}
         ORDER BY c.consultation_at DESC`,
        hasConsultationsClinicId ? [id, req.doctor.clinicId || null] : [id]
      ),
      query(
        `SELECT s.id, s.title, s.status, s.scheduled_at, s.procedure_type, s.hospital,
                s.notes, s.medical_record_id,
                d.name AS doctor_name, d.crm,
                sd.id AS document_id, sd.status AS document_status, sd.signed_at,
                sd.access_token, sd.signature_face_path
         FROM surgeries s
         INNER JOIN doctors d ON d.id = s.doctor_id
         LEFT JOIN LATERAL (
           SELECT d2.id, d2.status, d2.signed_at, d2.access_token, d2.signature_face_path
           FROM surgery_documents d2
           WHERE d2.surgery_id = s.id
           ORDER BY d2.created_at DESC NULLS LAST, d2.id DESC
           LIMIT 1
         ) sd ON true
         WHERE s.patient_id = $1
         ${hasSurgeriesClinicId ? 'AND s.clinic_id = $2' : ''}
         ORDER BY s.created_at DESC`,
        hasSurgeriesClinicId ? [id, req.doctor.clinicId || null] : [id]
      ),
      hasTable('patient_clinical_followups').then((exists) => {
        if (!exists) return Promise.resolve({ rows: [] });
        return hasColumn('patient_clinical_followups', 'surgery_id').then((hasFollowupSurgeryId) => {
          const surgeryColumns = hasFollowupSurgeryId
            ? `, f.surgery_id, s.title AS surgery_title, s.status AS surgery_status,
                  sd.status AS surgery_document_status`
            : `, NULL::uuid AS surgery_id, NULL::text AS surgery_title, NULL::text AS surgery_status,
                  NULL::text AS surgery_document_status`;
          const surgeryJoins = hasFollowupSurgeryId
            ? `
             LEFT JOIN surgeries s ON s.id = f.surgery_id
             LEFT JOIN LATERAL (
               SELECT d2.status
               FROM surgery_documents d2
               WHERE d2.surgery_id = s.id
               ORDER BY d2.created_at DESC NULLS LAST, d2.id DESC
               LIMIT 1
             ) sd ON true`
            : '';
          return query(
            `SELECT f.*, d.name AS doctor_name, d.crm,
                    mr.title AS medical_record_title
                    ${surgeryColumns}
             FROM patient_clinical_followups f
             LEFT JOIN doctors d ON d.id = f.doctor_id
             LEFT JOIN medical_records mr ON mr.id = f.medical_record_id
             ${surgeryJoins}
             WHERE f.patient_id = $1
             ${hasFollowupsClinicId ? 'AND f.clinic_id = $2' : ''}
             ORDER BY f.created_at DESC`,
            hasFollowupsClinicId ? [id, req.doctor.clinicId || null] : [id]
          );
        });
      }),
    ]);

    return res.json({
      patient: patientResult.rows[0],
      medicalRecords: recordsResult.rows,
      consultations: consultationsResult.rows,
      surgeries: surgeriesResult.rows,
      clinicalFollowups: clinicalFollowupsResult.rows,
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/:id/tablet-sessions', requireDoctorOrReceptionist, requirePatientPermission('patients.profile', 'view'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await hasTable('patient_tablet_sessions'))) {
      return res.status(412).json({ error: 'Estrutura do tablet ainda nao foi aplicada no banco.' });
    }

    const hasPatientsClinicId = await hasColumn('patients', 'clinic_id');
    const hasSessionsClinicId = await hasColumn('patient_tablet_sessions', 'clinic_id');
    const hasConsultationsClinicId = await hasColumn('consultations', 'clinic_id');

    if (hasPatientsClinicId) {
      const patientScope = await query('SELECT id FROM patients WHERE id = $1 AND clinic_id = $2', [id, req.doctor.clinicId || null]);
      if (patientScope.rowCount === 0) {
        return res.status(404).json({ error: 'Paciente nao encontrado' });
      }
    }

    const values = [id];
    const where = ['s.patient_id = $1'];
    if (hasSessionsClinicId) {
      values.push(req.doctor.clinicId || null);
      where.push(`s.clinic_id = $${values.length}`);
    }

    if (hasConsultationsClinicId) {
      values.push(req.doctor.clinicId || null);
    }

    const result = await query(
      `SELECT s.id, s.token, s.intake_mode, s.status, s.face_verified, s.face_similarity,
              s.verified_at, s.submitted_at, s.expires_at, s.created_at, s.updated_at,
              s.intake_data_json,
              c.id AS consultation_id, c.consultation_at, c.summary AS consultation_summary,
              d.name AS doctor_name
       FROM patient_tablet_sessions s
       LEFT JOIN consultations c ON c.id = s.consultation_id
       LEFT JOIN doctors d ON d.id = c.doctor_id
       WHERE ${where.join(' AND ')}
       ${hasConsultationsClinicId ? `AND (c.id IS NULL OR c.clinic_id = $${values.length})` : ''}
       ORDER BY s.created_at DESC
       LIMIT 20`,
      values
    );

    return res.json({ sessions: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.get('/:id/download/reference-face', requireDoctorOrReceptionist, requirePatientPermission(['patients', 'patients.profile'], 'view'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const hasReferenceFace = await hasColumn('patients', 'reference_face_path');
    const hasPatientsClinicId = await hasColumn('patients', 'clinic_id');
    if (!hasReferenceFace) {
      return res.status(404).json({ error: 'Foto de referencia indisponivel' });
    }

    const patient = hasPatientsClinicId
      ? await query('SELECT name, reference_face_path FROM patients WHERE id = $1 AND clinic_id = $2', [id, req.doctor.clinicId || null])
      : await query('SELECT name, reference_face_path FROM patients WHERE id = $1', [id]);
    if (patient.rowCount === 0) {
      return res.status(404).json({ error: 'Paciente nao encontrado' });
    }

    const facePath = patient.rows[0].reference_face_path;
    if (!facePath || !fs.existsSync(facePath)) {
      return res.status(404).json({ error: 'Foto de referencia nao encontrada' });
    }

    const ext = facePath.toLowerCase().endsWith('.png') ? 'png' : (facePath.toLowerCase().endsWith('.webp') ? 'webp' : 'jpg');
    const safeName = String(patient.rows[0].name || 'paciente').replace(/[^a-zA-Z0-9_-]+/g, '_');
    return res.download(facePath, `${safeName}-foto-referencia.${ext}`);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

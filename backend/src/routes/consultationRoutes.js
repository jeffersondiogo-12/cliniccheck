const express = require('express');
const PDFDocument = require('pdfkit');
const { query } = require('../config/database');
const { requireDoctorOrReceptionist, getStaffPermission } = require('../middleware/auth');
const gcal = require('../services/googleCalendarService');
const socketService = require('../services/socketService');

const router = express.Router();
const tableCache = new Map();
const columnCache = new Map();

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

async function loadConsultationDetails(consultationId, clinicId) {
  const hasConsultationClinicId = await hasColumn('consultations', 'clinic_id');
  const consultationResult = await query(
    `SELECT c.id, c.patient_id, c.doctor_id, c.consultation_at, c.summary, c.diagnosis, c.prescription, c.google_event_id,
            p.name AS patient_name, p.email AS patient_email, p.phone AS patient_phone, p.document_id AS patient_document,
            p.birth_date AS patient_birth_date, p.address AS patient_address,
            d.name AS doctor_name, d.crm AS doctor_crm, d.specialty AS doctor_specialty
     FROM consultations c
     INNER JOIN patients p ON p.id = c.patient_id
     INNER JOIN doctors d ON d.id = c.doctor_id
     WHERE c.id = $1
       ${hasConsultationClinicId ? 'AND c.clinic_id = $2' : ''}`,
    hasConsultationClinicId ? [consultationId, clinicId] : [consultationId]
  );

  if (consultationResult.rowCount === 0) return null;
  const consultation = consultationResult.rows[0];
  const hasMedicalRecords = await hasTable('medical_records');
  const hasSurgeries = await hasTable('surgeries');
  const hasPrescriptions = await hasTable('prescriptions');
  const hasCertificates = await hasTable('medical_certificates');

  const [recordsResult, proceduresResult] = await Promise.all([
    hasMedicalRecords
      ? query(
        `SELECT id, title, summary, clinical_history, allergies, chronic_conditions, current_medications,
                lgpd_consent_version, lgpd_consent_at, created_at, updated_at
         FROM medical_records
         WHERE patient_id = $1
         ORDER BY updated_at DESC, created_at DESC`,
        [consultation.patient_id]
      )
      : Promise.resolve({ rows: [] }),
    hasSurgeries
      ? query(
        `SELECT s.id, s.title, s.status, s.scheduled_at, s.procedure_type, s.hospital, s.notes, s.medical_record_id,
                sd.id AS document_id, sd.status AS document_status, sd.signed_at
         FROM surgeries s
         LEFT JOIN LATERAL (
           SELECT d.id, d.status, d.signed_at
           FROM surgery_documents d
           WHERE d.surgery_id = s.id
           ORDER BY d.created_at DESC NULLS LAST, d.id DESC
           LIMIT 1
         ) sd ON true
         WHERE s.patient_id = $1
           AND s.doctor_id = $3
           AND (
             COALESCE(s.scheduled_at, s.created_at)::date = $2::date
             OR abs(extract(epoch from (COALESCE(s.scheduled_at, s.created_at) - $2::timestamptz))) <= 7200
           )
         ORDER BY abs(extract(epoch from (COALESCE(s.scheduled_at, s.created_at) - $2::timestamptz))) ASC,
                  COALESCE(s.scheduled_at, s.created_at) DESC`,
        [consultation.patient_id, consultation.consultation_at, consultation.doctor_id]
      )
      : Promise.resolve({ rows: [] }),
  ]);

  const procedures = proceduresResult.rows;
  const procedureIds = procedures.map((p) => p.id);
  const records = recordsResult.rows;
  const recordsMap = new Map(records.map((r) => [String(r.id), r]));

  const linkedRecords = procedures
    .map((p) => recordsMap.get(String(p.medical_record_id)))
    .filter(Boolean);
  const uniqueLinkedRecordIds = new Set(linkedRecords.map((r) => String(r.id)));
  const effectiveRecords = linkedRecords.length
    ? linkedRecords
    : (records.length ? [records[0]] : []);

  let prescriptions = [];
  if (hasPrescriptions) {
    const params = [consultation.patient_id, consultation.consultation_at];
    let surgeryClause = '';
    if (procedureIds.length) {
      surgeryClause = ` OR pr.surgery_id = ANY($3::uuid[])`;
      params.push(procedureIds);
    }
    const prResult = await query(
      `SELECT pr.id, pr.surgery_id, pr.medications, pr.notes, pr.valid_days, pr.issued_at, pr.created_at
       FROM prescriptions pr
       WHERE pr.patient_id = $1
         AND (pr.issued_at = $2::date${surgeryClause})
       ORDER BY pr.created_at DESC`,
      params
    );
    prescriptions = prResult.rows;
  }

  let certificates = [];
  if (hasCertificates) {
    const params = [consultation.patient_id, consultation.consultation_at];
    let surgeryClause = '';
    if (procedureIds.length) {
      surgeryClause = ` OR mc.surgery_id = ANY($3::uuid[])`;
      params.push(procedureIds);
    }
    const certResult = await query(
      `SELECT mc.id, mc.surgery_id, mc.cid10_code, mc.cid10_desc, mc.cid_version, mc.cid_uri,
              mc.rest_days, mc.justification, mc.issued_at, mc.created_at
       FROM medical_certificates mc
       WHERE mc.patient_id = $1
         AND (mc.issued_at = $2::date${surgeryClause})
       ORDER BY mc.created_at DESC`,
      params
    );
    certificates = certResult.rows;
  }

  return {
    consultation,
    patient: {
      id: consultation.patient_id,
      name: consultation.patient_name,
      email: consultation.patient_email,
      phone: consultation.patient_phone,
      document: consultation.patient_document,
      birthDate: consultation.patient_birth_date,
      address: consultation.patient_address,
    },
    doctor: {
      id: consultation.doctor_id,
      name: consultation.doctor_name,
      crm: consultation.doctor_crm,
      specialty: consultation.doctor_specialty,
    },
    procedures,
    medicalRecords: records,
    linkedMedicalRecords: effectiveRecords,
    prescriptions,
    certificates,
    metadata: {
      linkedRecordCount: uniqueLinkedRecordIds.size,
      proceduresCount: procedures.length,
      prescriptionsCount: prescriptions.length,
      certificatesCount: certificates.length,
    },
  };
}

function normalizeConsultationAt(value) {
  if (!value) return value;
  const raw = String(value).trim();
  if (!raw) return raw;
  if (/[+-]\d{2}:\d{2}$/.test(raw) || raw.endsWith('Z')) return raw;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) {
    return `${raw}:00-03:00`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw)) {
    return `${raw}-03:00`;
  }
  return raw;
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

// Mesma logica do patientRoutes.js: libera pra medico OU recepcionista,
// checando a permissao granular da(s) pagina(s) informada(s), e garante
// req.doctor.id/clinicId disponivel mesmo pra recepcionista.
function requireConsultationPermission(pageCodes, action) {
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

// Encadeada depois de requireDoctorOrReceptionist: reaproveita a resolucao
// robusta de clinicId mas bloqueia quem nao for medico. Criar consulta
// (autoria clinica) continua exclusivo do medico.
function requireDoctorRoleOnly(req, res, next) {
  if (req.user?.role !== 'DOCTOR') {
    return res.status(403).json({ error: 'Esta acao e exclusiva do medico.' });
  }
  return next();
}

router.get('/:id/details', requireDoctorOrReceptionist, requireConsultationPermission(['patients.profile', 'patients.records'], 'view'), async (req, res, next) => {
  try {
    const details = await loadConsultationDetails(req.params.id, req.doctor.clinicId || null);
    if (!details) {
      return res.status(404).json({ error: 'Consulta nao encontrada' });
    }
    return res.json(details);
  } catch (error) {
    return next(error);
  }
});

router.get('/:id/details/pdf', requireDoctorOrReceptionist, requireConsultationPermission(['patients.profile', 'patients.records'], 'view'), async (req, res, next) => {
  try {
    const details = await loadConsultationDetails(req.params.id, req.doctor.clinicId || null);
    if (!details) {
      return res.status(404).json({ error: 'Consulta nao encontrada' });
    }

    const { consultation, patient, doctor, procedures, linkedMedicalRecords, prescriptions, certificates } = details;
    const fileName = `consulta-${consultation.id}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const pdf = new PDFDocument({ margin: 40, size: 'A4' });
    pdf.pipe(res);

    pdf.fontSize(18).text('Relatorio Completo da Consulta', { underline: true });
    pdf.moveDown(0.5);
    pdf.fontSize(10).fillColor('#4a5568').text(`Consulta ID: ${consultation.id}`);
    pdf.text(`Data/Hora: ${formatDateTime(consultation.consultation_at)}`);
    pdf.text(`Profissional: ${safeText(doctor.name)} ${doctor.crm ? `(${doctor.crm})` : ''}`);
    pdf.text(`Especialidade: ${safeText(doctor.specialty)}`);
    pdf.moveDown();

    pdf.fontSize(13).fillColor('#111827').text('Dados do Paciente', { underline: true });
    pdf.fontSize(10).fillColor('#111827');
    pdf.text(`Nome: ${safeText(patient.name)}`);
    pdf.text(`E-mail: ${safeText(patient.email)}`);
    pdf.text(`Telefone: ${safeText(patient.phone)}`);
    pdf.text(`Documento: ${safeText(patient.document)}`);
    pdf.text(`Nascimento: ${formatDate(patient.birthDate)}`);
    pdf.text(`Endereco: ${safeText(patient.address)}`);
    pdf.moveDown();

    pdf.fontSize(13).text('Descricao Clinica da Consulta', { underline: true });
    pdf.fontSize(10);
    pdf.text(`Resumo: ${safeText(consultation.summary)}`);
    pdf.moveDown(0.3);
    pdf.text(`Diagnostico: ${safeText(consultation.diagnosis)}`);
    pdf.moveDown(0.3);
    pdf.text(`Prescricao em texto livre: ${safeText(consultation.prescription)}`);
    pdf.moveDown();

    pdf.fontSize(13).text('Prontuario(s) Relacionado(s)', { underline: true });
    pdf.fontSize(10);
    if (!linkedMedicalRecords.length) {
      pdf.text('Nenhum prontuario relacionado encontrado para esta consulta.');
    } else {
      linkedMedicalRecords.forEach((record, index) => {
        pdf.text(`${index + 1}. ${safeText(record.title)} (Atualizado: ${formatDateTime(record.updated_at || record.created_at)})`);
        pdf.text(`   Resumo: ${safeText(record.summary)}`);
        pdf.text(`   Historia clinica: ${safeText(record.clinical_history)}`);
        pdf.text(`   Alergias: ${safeText(record.allergies)}`);
        pdf.text(`   Condicoes cronicas: ${safeText(record.chronic_conditions)}`);
        pdf.text(`   Medicacoes em uso: ${safeText(record.current_medications)}`);
      });
    }
    pdf.moveDown();

    pdf.fontSize(13).text('Procedimentos Vinculados', { underline: true });
    pdf.fontSize(10);
    if (!procedures.length) {
      pdf.text('Nenhum procedimento vinculado na janela desta consulta.');
    } else {
      procedures.forEach((proc, index) => {
        pdf.text(`${index + 1}. ${safeText(proc.title)} | Tipo: ${safeText(proc.procedure_type)} | Status: ${safeText(proc.status)}`);
        pdf.text(`   Data: ${formatDateTime(proc.scheduled_at)} | Hospital: ${safeText(proc.hospital)}`);
        pdf.text(`   Observacoes: ${safeText(proc.notes)}`);
      });
    }
    pdf.moveDown();

    pdf.fontSize(13).text('Receitas Emitidas', { underline: true });
    pdf.fontSize(10);
    if (!prescriptions.length) {
      pdf.text('Nenhuma receita vinculada encontrada.');
    } else {
      prescriptions.forEach((pr, index) => {
        const meds = Array.isArray(pr.medications) ? pr.medications.length : 0;
        pdf.text(`${index + 1}. Emitida em ${formatDate(pr.issued_at)} | Medicamentos: ${meds} | Validade: ${pr.valid_days || '-'} dias`);
        pdf.text(`   Observacoes: ${safeText(pr.notes)}`);
      });
    }
    pdf.moveDown();

    pdf.fontSize(13).text('Atestados Emitidos', { underline: true });
    pdf.fontSize(10);
    if (!certificates.length) {
      pdf.text('Nenhum atestado vinculado encontrado.');
    } else {
      certificates.forEach((cert, index) => {
        pdf.text(`${index + 1}. Emitido em ${formatDate(cert.issued_at)} | CID: ${safeText(cert.cid10_code)} - ${safeText(cert.cid10_desc)}`);
        pdf.text(`   Repouso: ${cert.rest_days || '-'} dia(s) | Justificativa: ${safeText(cert.justification)}`);
      });
    }

    pdf.moveDown();
    pdf.fontSize(9).fillColor('#4a5568').text(`Gerado em ${formatDateTime(new Date())}`);
    pdf.end();
  } catch (error) {
    return next(error);
  }
});

router.get('/', requireDoctorOrReceptionist, requireConsultationPermission(['patients.records', 'patients.profile'], 'view'), async (req, res, next) => {
  try {
    const patientId = req.query.patientId;
    const clinicId = req.doctor.clinicId || null;
    const hasConsultationClinicId = await hasColumn('consultations', 'clinic_id');

    const result = patientId
      ? await query(
          `SELECT c.*, p.name AS patient_name, d.name AS doctor_name
           FROM consultations c
           INNER JOIN patients p ON p.id = c.patient_id
           INNER JOIN doctors d ON d.id = c.doctor_id
           WHERE c.patient_id = $1
             ${hasConsultationClinicId ? 'AND c.clinic_id = $2' : ''}
           ORDER BY c.consultation_at DESC`,
          hasConsultationClinicId ? [patientId, clinicId] : [patientId]
        )
      : await query(
          `SELECT c.*, p.name AS patient_name, d.name AS doctor_name
           FROM consultations c
           INNER JOIN patients p ON p.id = c.patient_id
           INNER JOIN doctors d ON d.id = c.doctor_id
            ${hasConsultationClinicId ? 'WHERE c.clinic_id = $1' : ''}
            ORDER BY c.consultation_at DESC`,
           hasConsultationClinicId ? [clinicId] : []
        );

    return res.json(result.rows);
  } catch (error) {
    return next(error);
  }
});

router.post('/', requireDoctorOrReceptionist, requireDoctorRoleOnly, async (req, res, next) => {
  try {
    const { patientId, consultationAt, summary, diagnosis, prescription } = req.body;
    const normalizedConsultationAt = consultationAt
      ? normalizeConsultationAt(consultationAt)
      : new Date().toISOString();
    const hasConsultationClinicId = await hasColumn('consultations', 'clinic_id');
    const hasPatientsClinicId = await hasColumn('patients', 'clinic_id');

    if (!patientId || !summary) {
      return res.status(400).json({ error: 'patientId e summary sao obrigatorios' });
    }

    if (hasPatientsClinicId) {
      const patientScoped = await query('SELECT id FROM patients WHERE id = $1 AND clinic_id = $2', [patientId, req.doctor.clinicId || null]);
      if (patientScoped.rowCount === 0) {
        return res.status(404).json({ error: 'Paciente nao encontrado para a clinica ativa' });
      }
    }

    const inserted = await query(
      `INSERT INTO consultations (patient_id, doctor_id, consultation_at, summary, diagnosis, prescription${hasConsultationClinicId ? ', clinic_id' : ''})
       VALUES ($1, $2, $3, $4, $5, $6${hasConsultationClinicId ? ', $7' : ''})
       RETURNING *`,
      [
        patientId,
        req.doctor.id,
        normalizedConsultationAt,
        summary,
        diagnosis || null,
        prescription || null,
        ...(hasConsultationClinicId ? [req.doctor.clinicId || null] : []),
      ]
    );

    const consultation = inserted.rows[0];
    let googleEventId = null;

    if (gcal.isEnabled()) {
      try {
        const [patientRow, doctorRow] = await Promise.all([
          query('SELECT name, email FROM patients WHERE id = $1', [patientId]),
          query('SELECT name FROM doctors WHERE id = $1', [req.doctor.id]),
        ]);
        const patient = patientRow.rows[0];
        const doctor = doctorRow.rows[0];
        if (patient && doctor) {
          googleEventId = await gcal.createCalendarEvent({
            doctorId: req.doctor.id,
            patientName: patient.name,
            patientEmail: patient.email,
            doctorName: doctor.name,
            summary,
            consultationAt: normalizedConsultationAt,
            durationMin: req.body.durationMin || 30,
          });
          if (googleEventId) {
            await query('UPDATE consultations SET google_event_id = $1 WHERE id = $2', [googleEventId, consultation.id]);
            consultation.google_event_id = googleEventId;
          }
        }
      } catch (gcalErr) {
        console.warn('[Google Calendar] Erro ao criar evento (nao bloqueia):', gcalErr.message);
      }
    }

    socketService.emitToDoctor(req.doctor.id, 'consultation_created', {
      id: consultation.id,
      patient_id: consultation.patient_id,
      consultation_at: consultation.consultation_at,
    });
    socketService.emitToPatient(consultation.patient_id, 'consultation_created', {
      id: consultation.id,
      consultation_at: consultation.consultation_at,
    });
    socketService.emitAll('agenda_updated', { doctor_id: req.doctor.id });

    return res.status(201).json({ ...consultation, google_event_created: !!googleEventId });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

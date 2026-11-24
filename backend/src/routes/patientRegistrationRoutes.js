const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../config/database');

const router = express.Router();
const columnCache = new Map();
const tableCache = new Map();

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

function normalizeToken(value) {
  return String(value || '').trim();
}

async function loadOpenLinkByToken(token) {
  if (!(await hasTable('patient_registration_links'))) return null;

  const result = await query(
    `SELECT id, token, clinic_id, doctor_id, requested_email, status, expires_at,
            submitted_at, submitted_patient_id, payload_json, created_at
       FROM patient_registration_links
      WHERE token = $1
      LIMIT 1`,
    [token]
  );
  const row = result.rows[0] || null;
  if (!row) return null;

  if (row.status === 'OPEN' && row.expires_at && new Date(row.expires_at) < new Date()) {
    await query(
      `UPDATE patient_registration_links
          SET status = 'EXPIRED',
              updated_at = now()
        WHERE id = $1`,
      [row.id]
    ).catch(() => {});
    row.status = 'EXPIRED';
  }

  return row;
}

router.get('/api/patient-registration/:token', async (req, res, next) => {
  try {
    const token = normalizeToken(req.params.token);
    const link = await loadOpenLinkByToken(token);
    if (!link) return res.status(404).json({ error: 'Link de cadastro nao encontrado.' });
    if (link.status !== 'OPEN') {
      return res.status(410).json({ error: 'Este link de cadastro nao esta mais disponivel.' });
    }

    return res.json({
      link: {
        token: link.token,
        requested_email: link.requested_email,
        expires_at: link.expires_at,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/patient-registration/:token/submit', async (req, res, next) => {
  try {
    const token = normalizeToken(req.params.token);
    const link = await loadOpenLinkByToken(token);
    if (!link) return res.status(404).json({ error: 'Link de cadastro nao encontrado.' });
    if (link.status !== 'OPEN') {
      return res.status(410).json({ error: 'Este link de cadastro nao esta mais disponivel.' });
    }

    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const phone = String(req.body?.phone || '').trim() || null;
    const documentId = String(req.body?.documentId || '').trim() || null;
    const birthDate = String(req.body?.birthDate || '').trim() || null;
    const address = String(req.body?.address || '').trim() || null;
    const emergencyContactName = String(req.body?.emergencyContactName || '').trim() || null;
    const emergencyContactPhone = String(req.body?.emergencyContactPhone || '').trim() || null;
    const medicalHistory = String(req.body?.medicalHistory || '').trim() || null;
    const lgpdConsentVersion = String(req.body?.lgpdConsentVersion || '').trim() || null;
    const lgpdConsentAt = req.body?.lgpdConsentAt || new Date().toISOString();
    const faceImage = String(req.body?.faceImage || '').trim() || null;

    if (!name || !email || password.length < 6) {
      return res.status(400).json({ error: 'Informe nome, e-mail e senha com no minimo 6 caracteres.' });
    }

    if (!faceImage || !/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(faceImage)) {
      return res.status(400).json({ error: 'A foto biometrica e obrigatoria para concluir o cadastro.' });
    }

    const [
      hasPhone,
      hasDocumentId,
      hasBirthDate,
      hasAddress,
      hasReferenceFace,
      hasPasswordHash,
      hasEmergencyContactName,
      hasEmergencyContactPhone,
      hasMedicalHistory,
      hasLgpdConsentVersion,
      hasLgpdConsentAt,
      hasPatientsClinicId,
    ] = await Promise.all([
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
      return res.status(500).json({ error: 'Estrutura do banco incompleta para cadastro.' });
    }

    const existing = hasPatientsClinicId
      ? await query('SELECT id FROM patients WHERE email = $1 AND clinic_id = $2', [email, link.clinic_id || null])
      : await query('SELECT id FROM patients WHERE email = $1', [email]);

    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'Ja existe paciente cadastrado com este e-mail.' });
    }

    const insertColumns = ['name', 'email', 'password_hash'];
    const insertValues = [name, email, bcrypt.hashSync(password, 10)];

    if (hasPhone) {
      insertColumns.push('phone');
      insertValues.push(phone);
    }
    if (hasDocumentId) {
      insertColumns.push('document_id');
      insertValues.push(documentId);
    }
    if (hasBirthDate) {
      insertColumns.push('birth_date');
      insertValues.push(birthDate);
    }
    if (hasAddress) {
      insertColumns.push('address');
      insertValues.push(address);
    }
    if (hasReferenceFace) {
      insertColumns.push('reference_face_path');
      insertValues.push(faceImage);
    }
    if (hasEmergencyContactName) {
      insertColumns.push('emergency_contact_name');
      insertValues.push(emergencyContactName);
    }
    if (hasEmergencyContactPhone) {
      insertColumns.push('emergency_contact_phone');
      insertValues.push(emergencyContactPhone);
    }
    if (hasMedicalHistory) {
      insertColumns.push('medical_history');
      insertValues.push(medicalHistory);
    }
    if (hasLgpdConsentVersion) {
      insertColumns.push('lgpd_consent_version');
      insertValues.push(lgpdConsentVersion || 'LGPD-PACIENTE-LINK');
    }
    if (hasLgpdConsentAt) {
      insertColumns.push('lgpd_consent_at');
      insertValues.push(lgpdConsentAt);
    }
    if (hasPatientsClinicId) {
      insertColumns.push('clinic_id');
      insertValues.push(link.clinic_id || null);
    }

    const placeholders = insertValues.map((_, index) => `$${index + 1}`).join(', ');
    const patientInserted = await query(
      `INSERT INTO patients (${insertColumns.join(', ')})
       VALUES (${placeholders})
       RETURNING id, name, email, created_at`,
      insertValues
    );

    const patient = patientInserted.rows[0];

    if (await hasTable('medical_records')) {
      const hasMedicalRecordsClinicId = await hasColumn('medical_records', 'clinic_id');
      await query(
        `INSERT INTO medical_records (patient_id, doctor_id, title, summary, status, closed_at${hasMedicalRecordsClinicId ? ', clinic_id' : ''})
         VALUES ($1, $2, $3, $4, 'OPEN', NULL${hasMedicalRecordsClinicId ? ', $5' : ''})`,
        [
          patient.id,
          link.doctor_id || null,
          'Prontuario Inicial',
          'Prontuario criado automaticamente a partir do link de cadastro do paciente.',
          ...(hasMedicalRecordsClinicId ? [link.clinic_id || null] : []),
        ]
      );
    }

    await query(
      `UPDATE patient_registration_links
          SET status = 'SUBMITTED',
              submitted_at = now(),
              submitted_patient_id = $2,
              payload_json = $3::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [
        link.id,
        patient.id,
        JSON.stringify({
          name,
          email,
          phone,
          documentId,
          birthDate,
          address,
          emergencyContactName,
          emergencyContactPhone,
          medicalHistory,
          lgpdConsentVersion,
          lgpdConsentAt,
        }),
      ]
    );

    return res.status(201).json({
      ok: true,
      patient: {
        id: patient.id,
        name: patient.name,
        email: patient.email,
      },
      message: 'Cadastro enviado com sucesso. A equipe da clinica ira prosseguir com o atendimento.',
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

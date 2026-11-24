const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { query } = require('../config/database');
const { requireDoctorOrReceptionist } = require('../middleware/auth');

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

function normalizeIntakeMode(value) {
  const mode = String(value || '').trim().toUpperCase();
  return mode === 'PREFILLED' ? 'PREFILLED' : 'BLANK';
}

function safeJson(value, fallback = {}) {
  if (!value || typeof value !== 'object') return fallback;
  return value;
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function normalizeDataUrl(value) {
  const input = String(value || '').trim();
  if (!input) return null;
  const match = input.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\n\r]+)$/);
  if (!match) return null;
  return {
    mimeType: match[1].toLowerCase(),
    payload: match[2].replace(/[\n\r]/g, ''),
  };
}

function mimeToExtension(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

function resolveReferenceFaceSource(rawValue) {
  const input = String(rawValue || '').trim();
  if (!input) return null;

  // Legacy profile flow stores image directly as a Data URL in reference_face_path.
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(input)) {
    return { type: 'data-url', value: input };
  }

  const normalized = input.replace(/\\/g, '/');
  const appRoot = path.join(__dirname, '..', '..', '..');
  const candidates = [];

  if (path.isAbsolute(input)) {
    candidates.push(input);
  }

  if (normalized.startsWith('/')) {
    candidates.push(path.join(appRoot, normalized.replace(/^\/+/, '')));
  }

  candidates.push(path.join(appRoot, normalized.replace(/^\/+/, '')));

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return { type: 'file', value: candidate };
    }
  }

  return null;
}

function toDataUrl(filePathValue) {
  const source = resolveReferenceFaceSource(filePathValue);
  if (!source) return null;
  if (source.type === 'data-url') return source.value;

  const lower = String(source.value).toLowerCase();
  const mimeType = lower.endsWith('.png') ? 'image/png' : (lower.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
  return `data:${mimeType};base64,${fs.readFileSync(source.value).toString('base64')}`;
}

async function buildSuggestedData(patientId) {
  const [patientResult, lastSessionResult] = await Promise.all([
    query(
      `SELECT id, name, email, phone, document_id, birth_date, address, medical_history,
              emergency_contact_name, emergency_contact_phone, reference_face_path
       FROM patients
       WHERE id = $1`,
      [patientId]
    ),
    hasTable('patient_tablet_sessions')
      ? query(
        `SELECT intake_data_json
           FROM patient_tablet_sessions
          WHERE patient_id = $1 AND status = 'SUBMITTED'
          ORDER BY submitted_at DESC NULLS LAST, created_at DESC
          LIMIT 1`,
        [patientId]
      )
      : Promise.resolve({ rows: [] }),
  ]);

  const patient = patientResult.rows[0] || null;
  if (!patient) return { patient: null, suggestedData: {}, referenceFace: null };

  const latestIntake = safeJson(lastSessionResult.rows[0]?.intake_data_json, {});
  const suggestedData = {
    patient_name: patient.name || '',
    patient_email: patient.email || '',
    patient_phone: patient.phone || '',
    patient_document: patient.document_id || '',
    patient_birth_date: patient.birth_date || '',
    patient_address: patient.address || '',
    patient_medical_history: patient.medical_history || '',
    emergency_contact_name: patient.emergency_contact_name || '',
    emergency_contact_phone: patient.emergency_contact_phone || '',
    chief_complaint: latestIntake.chief_complaint || '',
    symptoms: latestIntake.symptoms || '',
    allergies: latestIntake.allergies || '',
    medications: latestIntake.medications || '',
    observations: latestIntake.observations || '',
  };

  return {
    patient,
    suggestedData,
    referenceFace: toDataUrl(patient.reference_face_path),
  };
}

async function loadSessionByToken(token) {
  if (!(await hasTable('patient_tablet_sessions'))) return null;
  const result = await query(
    `SELECT s.*, p.name AS patient_name, p.email AS patient_email, p.phone AS patient_phone,
            p.document_id AS patient_document_id, p.address AS patient_address,
            p.medical_history AS patient_medical_history, p.reference_face_path,
            c.consultation_at, c.summary AS consultation_summary,
            d.name AS doctor_name
     FROM patient_tablet_sessions s
     INNER JOIN patients p ON p.id = s.patient_id
     LEFT JOIN consultations c ON c.id = s.consultation_id
     LEFT JOIN doctors d ON d.id = c.doctor_id
     WHERE s.token = $1`,
    [token]
  );

  const session = result.rows[0] || null;
  if (!session) return null;
  if (session.expires_at && new Date(session.expires_at) < new Date()) {
    await query(`UPDATE patient_tablet_sessions SET status = 'EXPIRED', updated_at = now() WHERE token = $1`, [token]).catch(() => {});
    return { expired: true, session };
  }

  return { expired: false, session };
}

router.get('/paciente/tablet/:token', async (req, res, next) => {
  try {
    return res.render('patient-tablet', { token: req.params.token });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/patient/tablet/:token', async (req, res, next) => {
  try {
    const result = await loadSessionByToken(req.params.token);
    if (!result) {
      return res.status(404).json({ error: 'Sessao do tablet nao encontrada' });
    }
    if (result.expired) {
      return res.status(410).json({ error: 'Sessao do tablet expirou' });
    }

    const { patient, suggestedData, referenceFace } = await buildSuggestedData(result.session.patient_id);
    if (!patient) {
      return res.status(404).json({ error: 'Paciente nao encontrado' });
    }

    return res.json({
      session: {
        id: result.session.id,
        token: result.session.token,
        status: result.session.status,
        intake_mode: result.session.intake_mode,
        face_verified: result.session.face_verified,
        face_similarity: result.session.face_similarity,
        verified_at: result.session.verified_at,
        submitted_at: result.session.submitted_at,
        expires_at: result.session.expires_at,
      },
      patient: {
        id: patient.id,
        name: patient.name,
        email: patient.email,
        phone: patient.phone,
        document_id: patient.document_id,
        birth_date: patient.birth_date,
        address: patient.address,
        medical_history: patient.medical_history,
        emergency_contact_name: patient.emergency_contact_name,
        emergency_contact_phone: patient.emergency_contact_phone,
      },
      consultation: result.session.consultation_id ? {
        id: result.session.consultation_id,
        consultation_at: result.session.consultation_at,
        summary: result.session.consultation_summary,
        doctor_name: result.session.doctor_name,
      } : null,
      reference_face: referenceFace,
      suggested_data: suggestedData,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/patient/tablet/:token/verify', async (req, res, next) => {
  try {
    const sessionResult = await loadSessionByToken(req.params.token);
    if (!sessionResult) {
      return res.status(404).json({ error: 'Sessao do tablet nao encontrada' });
    }
    if (sessionResult.expired) {
      return res.status(410).json({ error: 'Sessao do tablet expirou' });
    }

    const { faceImage, matchPercent } = req.body || {};
    const parsedPercent = Number(matchPercent);
    if (!Number.isFinite(parsedPercent) || parsedPercent < 0 || parsedPercent > 100) {
      return res.status(400).json({ error: 'A similaridade facial deve ser um numero entre 0 e 100' });
    }

    if (parsedPercent < 70) {
      return res.status(412).json({ error: 'Reconhecimento facial nao aprovado. Tente novamente com melhor enquadramento.' });
    }

    const normalizedFace = normalizeDataUrl(faceImage);
    if (!normalizedFace) {
      return res.status(400).json({ error: 'Captura facial invalida' });
    }

    const extension = mimeToExtension(normalizedFace.mimeType);
    const fileName = `tablet-${sessionResult.session.id}-${Date.now()}.${extension}`;
    const fullPath = path.join(__dirname, '..', '..', '..', 'storage', 'faces', fileName);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, Buffer.from(normalizedFace.payload, 'base64'));

    await query(
      `UPDATE patient_tablet_sessions
          SET face_verified = true,
              face_similarity = $2,
              face_capture_path = $3,
              status = 'VERIFIED',
              verified_at = now(),
              updated_at = now()
        WHERE token = $1`,
      [req.params.token, parsedPercent, fullPath]
    );

    return res.json({ ok: true, face_similarity: parsedPercent });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/patient/tablet/:token/submit', async (req, res, next) => {
  try {
    const sessionResult = await loadSessionByToken(req.params.token);
    if (!sessionResult) {
      return res.status(404).json({ error: 'Sessao do tablet nao encontrada' });
    }
    if (sessionResult.expired) {
      return res.status(410).json({ error: 'Sessao do tablet expirou' });
    }

    const { intakeData, intakeMode } = req.body || {};
    const normalizedMode = normalizeIntakeMode(intakeMode);
    const currentSession = sessionResult.session;
    if (!currentSession.face_verified || Number(currentSession.face_similarity || 0) < 70) {
      return res.status(412).json({ error: 'Reconhecimento facial pendente antes do envio do prontuario' });
    }

    if (!intakeData || typeof intakeData !== 'object') {
      return res.status(400).json({ error: 'Dados do formulario invalidos' });
    }

    await query(
      `UPDATE patient_tablet_sessions
          SET intake_mode = $2,
              intake_data_json = $3::jsonb,
              status = 'SUBMITTED',
              submitted_at = now(),
              updated_at = now()
        WHERE token = $1`,
      [req.params.token, normalizedMode, JSON.stringify(intakeData)]
    );

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/reception/tablet-sessions', requireDoctorOrReceptionist, async (req, res, next) => {
  try {
    if (!(await hasTable('patient_tablet_sessions'))) {
      return res.status(412).json({ error: 'Estrutura do tablet ainda nao foi aplicada no banco.' });
    }

    const { patientId, consultationId, intakeMode } = req.body || {};
    if (!patientId) {
      return res.status(400).json({ error: 'patientId e obrigatorio' });
    }

    const hasPatientsClinicId = await hasColumn('patients', 'clinic_id');
    const clinicId = req.user?.clinicId || null;
    if (hasPatientsClinicId) {
      const patientScope = await query('SELECT id FROM patients WHERE id = $1 AND clinic_id = $2', [patientId, clinicId]);
      if (patientScope.rowCount === 0) {
        return res.status(404).json({ error: 'Paciente nao encontrado para a clinica ativa' });
      }
    }

    if (consultationId) {
      const consultationScope = await query(
        'SELECT id, patient_id FROM consultations WHERE id = $1' + (hasPatientsClinicId ? ' AND clinic_id = $2' : ''),
        hasPatientsClinicId ? [consultationId, clinicId] : [consultationId]
      );
      if (consultationScope.rowCount === 0) {
        return res.status(404).json({ error: 'Consulta nao encontrada' });
      }
      if (String(consultationScope.rows[0].patient_id) !== String(patientId)) {
        return res.status(400).json({ error: 'A consulta nao pertence a este paciente' });
      }
    }

    const token = randomToken();
    const mode = normalizeIntakeMode(intakeMode);
    const expiresAt = new Date(Date.now() + (6 * 60 * 60 * 1000)).toISOString();

    const inserted = await query(
      `INSERT INTO patient_tablet_sessions (
         token, patient_id, consultation_id, receptionist_id, clinic_id,
         intake_mode, expires_at, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN')
       RETURNING id, token, expires_at`,
      [token, patientId, consultationId || null, req.user?.id || null, clinicId, mode, expiresAt]
    );

    return res.status(201).json({
      session: inserted.rows[0],
      url: `/paciente/tablet/${token}`,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
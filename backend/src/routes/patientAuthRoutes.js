const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const { requirePatient, clearOtherRoleCookies } = require('../middleware/auth');
const { buildEvidenceSummary } = require('../services/complianceEvidenceService');
const { getJwtSecret } = require('../config/security');
const gcal = require('../services/googleCalendarService');

const JWT_SECRET = getJwtSecret();
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('invalid-password-placeholder', 10);

const router = express.Router();
const columnCache = new Map();

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePassword(value) {
  return String(value || '');
}

function isValidCredentialInput(email, password) {
  if (!email || !password) return false;
  if (email.length > 254 || password.length > 128) return false;
  return true;
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

router.post('/login', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = normalizePassword(req.body?.password);

    if (!isValidCredentialInput(email, password)) {
      return res.status(401).json({ error: 'Credenciais invalidas' });
    }

    const result = await query('SELECT * FROM patients WHERE email = $1', [email]);
    const patient = result.rows[0];
    const hashToCompare = patient?.password_hash || DUMMY_PASSWORD_HASH;
    const passwordOk = bcrypt.compareSync(password, hashToCompare);

    if (!patient || !patient.password_hash || !passwordOk) {
      return res.status(401).json({ error: 'Credenciais invalidas' });
    }

    const token = jwt.sign(
      { id: patient.id, name: patient.name, email: patient.email, role: 'PATIENT' },
      JWT_SECRET,
      { expiresIn: '12h', algorithm: 'HS256' }
    );

    clearOtherRoleCookies(res, 'PATIENT');
    res.cookie('patientToken', token, {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 12 * 60 * 60 * 1000,
    });

    return res.json({
      token,
      patient: {
        id: patient.id,
        name: patient.name,
        email: patient.email,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/me/records', requirePatient, async (req, res, next) => {
  try {
    const [hasRequireQualifiedSignature, hasProcedureClassification] = await Promise.all([
      hasColumn('surgeries', 'require_qualified_signature'),
      hasColumn('surgeries', 'procedure_classification'),
    ]);
    const requireQualifiedSelect = hasRequireQualifiedSignature
      ? 's.require_qualified_signature'
      : 'NULL::boolean AS require_qualified_signature';
    const procedureClassificationSelect = hasProcedureClassification
      ? 's.procedure_classification'
      : 'NULL::text AS procedure_classification';

    const [surgeries, consultations] = await Promise.all([
      query(
        `SELECT s.id, s.title AS procedure_name, s.scheduled_at AS surgery_date, s.hospital, s.status, s.notes,
                s.procedure_type, s.procedure_details, s.complications,
                ${requireQualifiedSelect}, ${procedureClassificationSelect},
                d.name AS doctor_name, d.crm,
                sd.id AS document_id, sd.access_token, sd.status AS document_status, sd.signed_at,
                to_jsonb(sd) AS document_meta
         FROM surgeries s
         INNER JOIN doctors d ON d.id = s.doctor_id
         LEFT JOIN surgery_documents sd ON sd.surgery_id = s.id
         WHERE s.patient_id = $1
         ORDER BY s.created_at DESC`,
        [req.patient.id]
      ),
      query(
        `SELECT c.id, c.consultation_at AS consultation_date, c.summary AS notes, c.diagnosis, c.prescription,
                c.modality,
                d.name AS doctor_name, d.crm,
                ts.access_token AS teleconsultation_token, ts.status AS teleconsultation_status
         FROM consultations c
         INNER JOIN doctors d ON d.id = c.doctor_id
         LEFT JOIN teleconsultation_sessions ts ON ts.consultation_id = c.id
         WHERE c.patient_id = $1
         ORDER BY c.consultation_at DESC`,
        [req.patient.id]
      ),
    ]);

    return res.json({
      surgeries: surgeries.rows.map((row) => {
        const documentEvidence = row.document_meta
          ? buildEvidenceSummary(row.document_meta, {
            procedureType: row.procedure_type,
            title: row.procedure_name,
            requireQualifiedSignature: row.require_qualified_signature,
            procedureClassification: row.procedure_classification,
          })
          : null;

        const { document_meta, ...safeRow } = row;

        return {
          ...safeRow,
          document_evidence: documentEvidence,
          require_qualified_signature: documentEvidence?.qualifiedSignature.required || false,
        };
      }),
      consultations: consultations.rows,
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/google/authorize', requirePatient, (req, res) => {
  if (!gcal.isEnabled()) {
    const config = gcal.getConfigStatus();
    return res.status(400).json({
      error: `Google Calendar nao configurado. Campos ausentes: ${config.missing.join(', ') || 'nenhum'}`,
    });
  }
  const url = gcal.getAuthUrl(`patient:${req.patient.id}`);
  return res.json({ url });
});

router.post('/google/disconnect', requirePatient, async (req, res, next) => {
  try {
    await gcal.disconnectPatient(req.patient.id);
    return res.json({ ok: true });
  } catch (err) {
    if (err?.code === 'GCAL_PATIENT_SCHEMA_MISSING') {
      return res.status(412).json({
        ok: false,
        error: 'Schema Google Calendar do paciente nao aplicado no banco. Rode a migration atualizada.',
      });
    }
    return next(err);
  }
});

router.get('/google/status', requirePatient, async (req, res, next) => {
  try {
    const row = await gcal.getPatientTokens(req.patient.id);
    return res.json({ connected: !!(row && row.google_calendar_connected) });
  } catch (err) {
    if (err?.code === 'GCAL_PATIENT_SCHEMA_MISSING') {
      return res.status(200).json({
        connected: false,
        setupRequired: true,
        error: 'Schema Google Calendar do paciente nao aplicado no banco. Rode a migration atualizada.',
      });
    }
    return next(err);
  }
});

module.exports = router;

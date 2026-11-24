/**
 * Rotas de Receitas Médicas, Atestados e CID-10
 */
const express = require('express');
const router  = express.Router();
const { query } = require('../config/database');
const { requireDoctor } = require('../middleware/auth');
const socketService = require('../services/socketService');
const icdWhoService = require('../services/icdWhoService');
const cid10BrService = require('../services/cid10BrService');

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

function normalizeCidFilter(value) {
  const raw = String(value || 'all').trim().toLowerCase();
  if (raw === 'cid10' || raw === '10') return 'cid10';
  if (raw === 'cid11' || raw === '11') return 'cid11';
  return 'all';
}

function sanitizeText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapCertificateCid(item, fallbackSource = 'manual') {
  return {
    code: sanitizeText(item?.code).toUpperCase(),
    description: sanitizeText(item?.description),
    version: String(item?.version || '').trim() || null,
    uri: item?.uri || null,
    source: item?.source || fallbackSource,
  };
}

// ─── CID-10 ─────────────────────────────────────────────────────────────────

// Busca unificada de CID: ICD-11 oficial (WHO) + CID-10 customizado do médico.
router.get('/cid/search', requireDoctor, async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json([]);

    const filter = normalizeCidFilter(req.query.filter);
    const includeCid10 = filter === 'all' || filter === 'cid10';
    const includeCid11 = filter === 'all' || filter === 'cid11';
    const hasCidCustomClinicId = includeCid10 ? await hasColumn('cid10_custom', 'clinic_id') : false;

    const qUpper = q.toUpperCase();
    const hasCid10ReferenceTable = includeCid10 ? await hasTable('cid10_reference') : false;

    const [customCid10, referenceCid10, remoteCid10Results, icd11Results] = await Promise.all([
      includeCid10
        ? query(
            `SELECT code, description, category
               FROM cid10_custom
              WHERE doctor_id = $1 AND active = true
                ${hasCidCustomClinicId ? 'AND clinic_id = $3' : ''}
                AND (UPPER(code) LIKE $2 OR UPPER(description) LIKE $2)
              ORDER BY code
              LIMIT 20`,
            hasCidCustomClinicId ? [req.doctor.id, `%${qUpper}%`, req.doctor.clinicId || null] : [req.doctor.id, `%${qUpper}%`]
          )
        : { rows: [] },
      includeCid10 && hasCid10ReferenceTable
        ? query(
            `SELECT code, description
               FROM cid10_reference
              WHERE active = true
                AND (UPPER(code) LIKE $1 OR UPPER(description) LIKE $1)
              ORDER BY code
              LIMIT 40`,
            [`%${qUpper}%`]
          )
        : { rows: [] },
      includeCid10 ? cid10BrService.searchCid10(q).catch(() => []) : [],
      includeCid11 ? icdWhoService.searchICD11({ term: q, language: req.query.lang || 'pt' }) : [],
    ]);

    const mapped11 = (icd11Results || []).map((item) => ({
      code: sanitizeText(item.code),
      description: sanitizeText(item.description),
      system: 'CID-11',
      version: '11',
      source: 'who',
      uri: item.uri || null,
    }));

    const mappedCustom10 = customCid10.rows.map((row) => ({
      code: sanitizeText(row.code),
      description: sanitizeText(row.description),
      category: row.category,
      system: 'CID-10',
      version: '10',
      source: 'custom',
      uri: null,
    }));

    const mappedReference10 = referenceCid10.rows.map((row) => ({
      code: sanitizeText(row.code),
      description: sanitizeText(row.description),
      system: 'CID-10',
      version: '10',
      source: 'cid10-reference',
      uri: null,
    }));

    const mappedRemote10 = (remoteCid10Results || []).map((row) => ({
      code: sanitizeText(row.code),
      description: sanitizeText(row.description),
      system: 'CID-10',
      version: '10',
      source: row.source || 'fhir-go',
      uri: null,
    }));

    const prioritized = [
      ...mapped11,
      ...mappedCustom10,
      ...mappedReference10,
      ...mappedRemote10,
    ];

    const dedupe = new Map();
    for (const item of prioritized) {
      const key = `${String(item.version || '')}:${String(item.code || '').toUpperCase()}`;
      if (!item.code || dedupe.has(key)) continue;
      dedupe.set(key, item);
    }

    return res.json(Array.from(dedupe.values()).slice(0, 60));
  } catch (err) {
    return next(err);
  }
});

router.post('/cid10/sync', requireDoctor, async (req, res, next) => {
  try {
    const allCid10 = await cid10BrService.loadAllCid10({ forceRefresh: true });

    await query(
      `CREATE TABLE IF NOT EXISTS cid10_reference (
        id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        code        text        NOT NULL UNIQUE,
        description text        NOT NULL,
        source      text        NOT NULL DEFAULT 'fhir-go',
        active      boolean     NOT NULL DEFAULT true,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      )`
    );
    await query(`CREATE INDEX IF NOT EXISTS idx_cid10_reference_code ON cid10_reference(code)`);

    for (let i = 0; i < allCid10.length; i += 300) {
      const chunk = allCid10.slice(i, i + 300);
      const values = [];
      const placeholders = chunk.map((item, idx) => {
        const base = idx * 3;
        values.push(item.code, item.description, item.source || 'fhir-go');
        return `($${base + 1}, $${base + 2}, $${base + 3})`;
      });

      await query(
        `INSERT INTO cid10_reference (code, description, source)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (code)
         DO UPDATE SET
           description = EXCLUDED.description,
           source = EXCLUDED.source,
           active = true,
           updated_at = now()`,
        values
      );
    }

    return res.json({ ok: true, total: allCid10.length });
  } catch (err) {
    return next(err);
  }
});

router.get('/icd11/search', requireDoctor, async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json([]);

    const data = await icdWhoService.searchICD11({
      term: q,
      language: req.query.lang || 'pt',
    });
    return res.json(data);
  } catch (err) {
    return next(err);
  }
});

// Busca CID-10: primeiro no custom do médico, depois na tabela geral estática embutida
// Retorna até 30 resultados que contenham o texto no código ou descrição
router.get('/cid10/search', requireDoctor, async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim().toUpperCase();
    if (!q || q.length < 2) return res.json([]);

    // Busca registros customizados do médico
    const hasCidCustomClinicId = await hasColumn('cid10_custom', 'clinic_id');
    const custom = await query(
      `SELECT code, description, category, 'custom' AS source
         FROM cid10_custom
        WHERE doctor_id = $1 AND active = true
          ${hasCidCustomClinicId ? 'AND clinic_id = $3' : ''}
          AND (UPPER(code) LIKE $2 OR UPPER(description) LIKE $2)
        ORDER BY code
        LIMIT 20`,
      hasCidCustomClinicId ? [req.doctor.id, `%${q}%`, req.doctor.clinicId || null] : [req.doctor.id, `%${q}%`]
    );

    return res.json(custom.rows);
  } catch (err) { return next(err); }
});

// Lista todos os CID-10 customizados do médico
router.get('/cid10', requireDoctor, async (req, res, next) => {
  try {
    const hasCidCustomClinicId = await hasColumn('cid10_custom', 'clinic_id');
    const result = await query(
      `SELECT * FROM cid10_custom WHERE doctor_id = $1
       ${hasCidCustomClinicId ? 'AND clinic_id = $2' : ''}
       ORDER BY code`,
      hasCidCustomClinicId ? [req.doctor.id, req.doctor.clinicId || null] : [req.doctor.id]
    );
    return res.json(result.rows);
  } catch (err) { return next(err); }
});

// Cadastra CID-10 customizado
router.post('/cid10', requireDoctor, async (req, res, next) => {
  try {
    const hasCidCustomClinicId = await hasColumn('cid10_custom', 'clinic_id');
    const { code, description, category } = req.body;
    if (!code || !description) return res.status(400).json({ error: 'Código e descrição são obrigatórios.' });

    const existing = await query(
      `SELECT id FROM cid10_custom WHERE doctor_id = $1 AND code = $2
       ${hasCidCustomClinicId ? 'AND clinic_id = $3' : ''}`,
      hasCidCustomClinicId ? [req.doctor.id, code.trim().toUpperCase(), req.doctor.clinicId || null] : [req.doctor.id, code.trim().toUpperCase()]
    );
    if (existing.rowCount > 0) return res.status(409).json({ error: 'Código CID-10 já cadastrado.' });

    const inserted = hasCidCustomClinicId
      ? await query(
        `INSERT INTO cid10_custom (doctor_id, code, description, category, clinic_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [req.doctor.id, code.trim().toUpperCase(), description.trim(), (category || '').trim() || null, req.doctor.clinicId || null]
      )
      : await query(
        `INSERT INTO cid10_custom (doctor_id, code, description, category)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [req.doctor.id, code.trim().toUpperCase(), description.trim(), (category || '').trim() || null]
      );
    return res.status(201).json(inserted.rows[0]);
  } catch (err) { return next(err); }
});

// Atualiza / desativa CID-10 customizado
router.put('/cid10/:id', requireDoctor, async (req, res, next) => {
  try {
    const hasCidCustomClinicId = await hasColumn('cid10_custom', 'clinic_id');
    const { description, category, active } = req.body;
    const sets = []; const vals = [];
    if (description !== undefined) { sets.push(`description = $${sets.length+2}`); vals.push(description); }
    if (category    !== undefined) { sets.push(`category    = $${sets.length+2}`); vals.push(category); }
    if (active      !== undefined) { sets.push(`active      = $${sets.length+2}`); vals.push(active); }
    if (!sets.length) return res.status(400).json({ error: 'Nenhum campo para atualizar.' });

    const result = await query(
      `UPDATE cid10_custom SET ${sets.join(', ')}
       WHERE id = $1 AND doctor_id = $${vals.length+2}
       ${hasCidCustomClinicId ? `AND clinic_id = $${vals.length + 3}` : ''}
       RETURNING *`,
      hasCidCustomClinicId ? [req.params.id, ...vals, req.doctor.id, req.doctor.clinicId || null] : [req.params.id, ...vals, req.doctor.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'CID não encontrado.' });
    return res.json(result.rows[0]);
  } catch (err) { return next(err); }
});

router.delete('/cid10/:id', requireDoctor, async (req, res, next) => {
  try {
    const hasCidCustomClinicId = await hasColumn('cid10_custom', 'clinic_id');
    await query(
      `DELETE FROM cid10_custom WHERE id = $1 AND doctor_id = $2
       ${hasCidCustomClinicId ? 'AND clinic_id = $3' : ''}`,
      hasCidCustomClinicId ? [req.params.id, req.doctor.id, req.doctor.clinicId || null] : [req.params.id, req.doctor.id]
    );
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// ─── RECEITAS ────────────────────────────────────────────────────────────────

// Fallback de pacientes para tela de receita/atestado quando /api/patients não estiver acessível por permissão.
router.get('/patients', requireDoctor, async (_req, res, next) => {
  try {
    const [hasDocumentId, hasBirthDate, hasAddress, hasPatientsClinicId] = await Promise.all([
      hasColumn('patients', 'document_id'),
      hasColumn('patients', 'birth_date'),
      hasColumn('patients', 'address'),
      hasColumn('patients', 'clinic_id'),
    ]);

    const result = await query(
      `SELECT id, name, email,
              ${hasDocumentId ? 'document_id' : 'NULL::text AS document_id'},
              ${hasBirthDate ? 'birth_date' : 'NULL::date AS birth_date'},
              ${hasAddress ? 'address' : 'NULL::text AS address'},
              created_at
         FROM patients
        ${hasPatientsClinicId ? 'WHERE clinic_id = $1' : ''}
        ORDER BY created_at DESC`,
      hasPatientsClinicId ? [_req.doctor.clinicId || null] : []
    );

    return res.json(result.rows);
  } catch (err) {
    return next(err);
  }
});

// Lista receitas do médico
router.get('/prescriptions', requireDoctor, async (req, res, next) => {
  try {
    const [hasMedicalRecordId, hasPrescriptionClinicId] = await Promise.all([
      hasColumn('prescriptions', 'medical_record_id'),
      hasColumn('prescriptions', 'clinic_id'),
    ]);
    const result = await query(
      `SELECT r.*, p.name AS patient_name, p.email AS patient_email,
              p.document_id AS patient_cpf, p.birth_date AS patient_birth,
              p.address AS patient_address,
              s.title AS surgery_title, s.procedure_type,
              s.status AS surgery_status,
              sd.status AS consent_status,
              ${hasMedicalRecordId ? 'mr.title AS medical_record_title' : 'NULL::text AS medical_record_title'}
         FROM prescriptions r
         JOIN patients p ON p.id = r.patient_id
         LEFT JOIN surgeries s ON s.id = r.surgery_id
         LEFT JOIN surgery_documents sd ON sd.surgery_id = s.id
         ${hasMedicalRecordId ? 'LEFT JOIN medical_records mr ON mr.id = r.medical_record_id' : ''}
        WHERE r.doctor_id = $1
        ${hasPrescriptionClinicId ? 'AND r.clinic_id = $2' : ''}
        ORDER BY r.created_at DESC`,
      hasPrescriptionClinicId ? [req.doctor.id, req.doctor.clinicId || null] : [req.doctor.id]
    );
    return res.json(result.rows);
  } catch (err) { return next(err); }
});

// Cria receita
router.post('/prescriptions', requireDoctor, async (req, res, next) => {
  try {
    const { patientId, surgeryId, medications, notes, validDays, issuedAt } = req.body;
    if (!patientId) return res.status(400).json({ error: 'Paciente obrigatório.' });
    if (!medications || !medications.length) return res.status(400).json({ error: 'Adicione pelo menos um medicamento.' });
    if (!surgeryId) {
      return res.status(400).json({ error: 'A receita deve estar vinculada a um procedimento assinado.' });
    }

    const [hasSurgeriesClinicId, hasPrescriptionClinicId] = await Promise.all([
      hasColumn('surgeries', 'clinic_id'),
      hasColumn('prescriptions', 'clinic_id'),
    ]);

    if (surgeryId) {
      const surgery = await query(
        `SELECT id, status
           FROM surgeries
          WHERE id = $1 AND patient_id = $2
          ${hasSurgeriesClinicId ? 'AND clinic_id = $3' : ''}`,
        hasSurgeriesClinicId ? [surgeryId, patientId, req.doctor.clinicId || null] : [surgeryId, patientId]
      );
      if (surgery.rowCount === 0) {
        return res.status(400).json({ error: 'Procedimento inválido para o paciente selecionado.' });
      }
      const status = String(surgery.rows[0].status || '').toUpperCase();
      if (status !== 'SIGNED') {
        return res.status(400).json({ error: 'Somente procedimentos assinados podem ser vinculados a receitas.' });
      }
    }

    const insertColumns = ['doctor_id', 'patient_id', 'surgery_id', 'medications', 'notes', 'valid_days', 'issued_at'];
    const insertValues = [
      req.doctor.id,
      patientId,
      surgeryId || null,
      JSON.stringify(medications),
      notes || null,
      validDays || 30,
      issuedAt || new Date().toISOString().slice(0, 10),
    ];
    if (hasPrescriptionClinicId) {
      insertColumns.push('clinic_id');
      insertValues.push(req.doctor.clinicId || null);
    }

    const placeholders = insertValues.map((_, idx) => `$${idx + 1}`).join(', ');

    const inserted = await query(
      `INSERT INTO prescriptions (${insertColumns.join(', ')})
       VALUES (${placeholders}) RETURNING *`,
      insertValues
    );
    const newRx = inserted.rows[0];

    if (surgeryId) {
      await query(
        `UPDATE surgeries
            SET status = 'completed'
          WHERE id = $1 AND patient_id = $2
          ${hasSurgeriesClinicId ? 'AND clinic_id = $3' : ''}`,
        hasSurgeriesClinicId ? [surgeryId, patientId, req.doctor.clinicId || null] : [surgeryId, patientId]
      );
    }

    socketService.emitToDoctor(req.doctor.id, 'prescription_saved', { id: newRx.id, patient_id: newRx.patient_id, clinicId: req.doctor.clinicId || null });
    return res.status(201).json(newRx);
  } catch (err) { return next(err); }
});

router.delete('/prescriptions/:id', requireDoctor, async (req, res, next) => {
  try {
    const hasPrescriptionClinicId = await hasColumn('prescriptions', 'clinic_id');
    await query(
      `DELETE FROM prescriptions WHERE id = $1 AND doctor_id = $2
       ${hasPrescriptionClinicId ? 'AND clinic_id = $3' : ''}`,
      hasPrescriptionClinicId ? [req.params.id, req.doctor.id, req.doctor.clinicId || null] : [req.params.id, req.doctor.id]
    );
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// ─── ATESTADOS ───────────────────────────────────────────────────────────────

// Lista atestados do médico
router.get('/certificates', requireDoctor, async (req, res, next) => {
  try {
    const [hasCertificateCids, hasMedicalRecordId, hasCertificatesClinicId] = await Promise.all([
      hasTable('medical_certificate_cids'),
      hasColumn('medical_certificates', 'medical_record_id'),
      hasColumn('medical_certificates', 'clinic_id'),
    ]);

    const result = await query(
      `SELECT a.*, p.name AS patient_name, p.email AS patient_email,
              p.document_id AS patient_cpf, p.birth_date AS patient_birth,
              p.address AS patient_address,
              s.title AS surgery_title, s.procedure_type,
              s.status AS surgery_status,
              sd.status AS consent_status,
              ${hasMedicalRecordId ? 'mr.title AS medical_record_title,' : 'NULL::text AS medical_record_title,'}
              ${hasCertificateCids
                ? `COALESCE(cids_data.cids, '[]'::json) AS cids`
                : `'[]'::json AS cids`}
         FROM medical_certificates a
         JOIN patients p ON p.id = a.patient_id
         LEFT JOIN surgeries s ON s.id = a.surgery_id
         LEFT JOIN surgery_documents sd ON sd.surgery_id = s.id
         ${hasMedicalRecordId ? 'LEFT JOIN medical_records mr ON mr.id = a.medical_record_id' : ''}
         ${hasCertificateCids
           ? `LEFT JOIN LATERAL (
                SELECT COALESCE(
                  json_agg(
                    json_build_object(
                      'code', mcc.code,
                      'description', mcc.description,
                      'version', mcc.cid_version,
                      'uri', mcc.cid_uri,
                      'source', mcc.source
                    )
                    ORDER BY mcc.position, mcc.created_at
                  ),
                  '[]'::json
                ) AS cids
                  FROM medical_certificate_cids mcc
                 WHERE mcc.certificate_id = a.id
              ) cids_data ON true`
           : ''}
        WHERE a.doctor_id = $1
        ${hasCertificatesClinicId ? 'AND a.clinic_id = $2' : ''}
        ORDER BY a.created_at DESC`,
      hasCertificatesClinicId ? [req.doctor.id, req.doctor.clinicId || null] : [req.doctor.id]
    );
    return res.json(result.rows);
  } catch (err) { return next(err); }
});

// Cria atestado
router.post('/certificates', requireDoctor, async (req, res, next) => {
  try {
    const { patientId, surgeryId, cid10Code, cid10Desc, cidVersion, cidUri, cids, restDays, justification, issuedAt } = req.body;
    if (!patientId) return res.status(400).json({ error: 'Paciente obrigatório.' });
    if (!restDays || restDays < 1) return res.status(400).json({ error: 'Informe o número de dias de repouso.' });
    if (!surgeryId) {
      return res.status(400).json({ error: 'O atestado deve estar vinculado a um procedimento assinado.' });
    }

    const [hasCidVersion, hasCidUri, hasCertificateCids, hasMedicalRecordId, hasSurgeriesClinicId, hasCertificatesClinicId] = await Promise.all([
      hasColumn('medical_certificates', 'cid_version'),
      hasColumn('medical_certificates', 'cid_uri'),
      hasTable('medical_certificate_cids'),
      hasColumn('medical_certificates', 'medical_record_id'),
      hasColumn('surgeries', 'clinic_id'),
      hasColumn('medical_certificates', 'clinic_id'),
    ]);

    if (surgeryId) {
      const surgery = await query(
        `SELECT id, status
           FROM surgeries
          WHERE id = $1 AND patient_id = $2
          ${hasSurgeriesClinicId ? 'AND clinic_id = $3' : ''}`,
        hasSurgeriesClinicId ? [surgeryId, patientId, req.doctor.clinicId || null] : [surgeryId, patientId]
      );
      if (surgery.rowCount === 0) {
        return res.status(400).json({ error: 'Procedimento inválido para o paciente selecionado.' });
      }
      const status = String(surgery.rows[0].status || '').toUpperCase();
      if (status !== 'SIGNED') {
        return res.status(400).json({ error: 'Somente procedimentos assinados podem ser vinculados a atestados.' });
      }
    }

    let normalizedCids = Array.isArray(cids)
      ? cids.map((item) => mapCertificateCid(item)).filter((item) => item.code)
      : [];

    if (!normalizedCids.length && (cid10Code || cid10Desc)) {
      normalizedCids = [
        {
          code: String(cid10Code || '').trim().toUpperCase(),
          description: String(cid10Desc || '').trim(),
          version: cidVersion || '10',
          uri: cidUri || null,
          source: 'legacy-single',
        },
      ].filter((item) => item.code);
    }

    const firstCid = normalizedCids[0] || null;

    const columns = [
      'doctor_id',
      'patient_id',
      'surgery_id',
      'cid10_code',
      'cid10_desc',
      'rest_days',
      'justification',
      'issued_at',
    ];
    const values = [
      req.doctor.id,
      patientId,
      surgeryId || null,
      firstCid?.code || null,
      firstCid?.description || null,
      restDays,
      justification || null,
      issuedAt || new Date().toISOString().slice(0, 10),
    ];

    if (hasMedicalRecordId) {
      columns.push('medical_record_id');
      values.push(null);
    }

    if (hasCidVersion) {
      columns.push('cid_version');
      values.push(firstCid?.version || cidVersion || null);
    }

    if (hasCidUri) {
      columns.push('cid_uri');
      values.push(firstCid?.uri || cidUri || null);
    }
    if (hasCertificatesClinicId) {
      columns.push('clinic_id');
      values.push(req.doctor.clinicId || null);
    }

    const placeholders = values.map((_, idx) => `$${idx + 1}`).join(', ');

    const inserted = await query(
      `INSERT INTO medical_certificates (${columns.join(', ')})
       VALUES (${placeholders}) RETURNING *`,
      values
    );
    const newCert = inserted.rows[0];

    if (hasCertificateCids && normalizedCids.length) {
      const cidValues = [];
      const cidPlaceholders = normalizedCids.map((item, idx) => {
        const base = idx * 7;
        cidValues.push(
          newCert.id,
          idx + 1,
          item.code,
          item.description || null,
          item.version || null,
          item.uri || null,
          item.source || 'manual'
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
      });

      await query(
        `INSERT INTO medical_certificate_cids (
          certificate_id,
          position,
          code,
          description,
          cid_version,
          cid_uri,
          source
        ) VALUES ${cidPlaceholders.join(', ')}`,
        cidValues
      );
    }

    socketService.emitToDoctor(req.doctor.id, 'certificate_saved', { id: newCert.id, patient_id: newCert.patient_id, cid10_code: newCert.cid10_code, clinicId: req.doctor.clinicId || null });

    if (surgeryId) {
      await query(
        `UPDATE surgeries
            SET status = 'completed'
          WHERE id = $1 AND patient_id = $2
          ${hasSurgeriesClinicId ? 'AND clinic_id = $3' : ''}`,
        hasSurgeriesClinicId ? [surgeryId, patientId, req.doctor.clinicId || null] : [surgeryId, patientId]
      );
    }

    return res.status(201).json({
      ...newCert,
      cids: normalizedCids,
    });
  } catch (err) { return next(err); }
});

router.delete('/certificates/:id', requireDoctor, async (req, res, next) => {
  try {
    const hasCertificatesClinicId = await hasColumn('medical_certificates', 'clinic_id');
    await query(
      `DELETE FROM medical_certificates WHERE id = $1 AND doctor_id = $2
       ${hasCertificatesClinicId ? 'AND clinic_id = $3' : ''}`,
      hasCertificatesClinicId ? [req.params.id, req.doctor.id, req.doctor.clinicId || null] : [req.params.id, req.doctor.id]
    );
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

module.exports = router;

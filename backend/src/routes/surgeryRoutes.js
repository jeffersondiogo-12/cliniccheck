const express = require('express');
const { query } = require('../config/database');
const { requireDoctor } = require('../middleware/auth');
const { buildEvidenceSummary } = require('../services/complianceEvidenceService');
const socketService = require('../services/socketService');
const { ensureAutoChargeForSurgery } = require('../services/cashierService');

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

router.get('/', requireDoctor, async (_req, res, next) => {
  try {
    const clinicId = _req.doctor.clinicId || null;
    const [hasMedicalRecordId, hasMedicalRecordsTable] = await Promise.all([
      hasColumn('surgeries', 'medical_record_id'),
      hasTable('medical_records'),
    ]);
    const hasSurgeriesClinicId = await hasColumn('surgeries', 'clinic_id');
    const medicalRecordSelect = hasMedicalRecordId && hasMedicalRecordsTable
      ? ', mr.id AS medical_record_id, mr.title AS medical_record_title'
      : ', NULL::uuid AS medical_record_id, NULL::text AS medical_record_title';
    const medicalRecordJoin = hasMedicalRecordId && hasMedicalRecordsTable
      ? 'LEFT JOIN medical_records mr ON mr.id = s.medical_record_id'
      : '';

    const surgeries = await query(
      `SELECT s.*, p.name AS patient_name, p.email AS patient_email,
              p.document_id AS patient_document_id,
              d.name AS doctor_name,
              sd.id         AS surgery_document_id,
              sd.access_token,
              sd.status     AS document_status,
              to_jsonb(sd)  AS document_meta
              ${medicalRecordSelect}
       FROM surgeries s
       INNER JOIN patients p ON p.id = s.patient_id
       INNER JOIN doctors  d ON d.id = s.doctor_id
       LEFT  JOIN surgery_documents sd ON sd.surgery_id = s.id
       ${medicalRecordJoin}
       ${hasSurgeriesClinicId ? 'WHERE s.clinic_id = $1' : ''}
       ORDER BY s.created_at DESC`
      ,
      hasSurgeriesClinicId ? [clinicId] : []
    );

    return res.json(surgeries.rows.map((row) => {
      const documentEvidence = row.document_meta
        ? buildEvidenceSummary(row.document_meta, {
          procedureType: row.procedure_type,
          title: row.title,
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
    }));
  } catch (error) {
    return next(error);
  }
});

router.post('/', requireDoctor, async (req, res, next) => {
  try {
    // Aceita tanto 'title' quanto 'procedureName'
    const {
      patientId,
      procedureName,
      title: titleField,
      scheduledAt,
      surgeryDate,
      hospital,
      procedureType,
      procedureDetails,
      complications,
      notes,
      status,
      requireQualifiedSignature,
      procedureClassification,
      medicalRecordId,
    } = req.body;
    const title = titleField || procedureName;
    const dateValue = scheduledAt || surgeryDate;
    const normalizedStatus = ['DRAFT', 'scheduled', 'completed', 'cancelled', 'AWAITING_SIGNATURE', 'SIGNED'].includes(status) ? status : 'DRAFT';

    if (!patientId || !title) {
      return res.status(400).json({ error: 'patientId e nome do procedimento sao obrigatorios' });
    }

    const hasPatientsClinicId = await hasColumn('patients', 'clinic_id');
    const patient = hasPatientsClinicId
      ? await query('SELECT id FROM patients WHERE id = $1 AND clinic_id = $2', [patientId, req.doctor.clinicId || null])
      : await query('SELECT id FROM patients WHERE id = $1', [patientId]);
    if (patient.rowCount === 0) {
      return res.status(404).json({ error: 'Paciente nao encontrado' });
    }

    const [hasProcedureType, hasProcedureDetails, hasComplications, hasRequireQualifiedSignature, hasProcedureClassification, hasMedicalRecordId, hasMedicalRecordsTable, hasSurgeriesClinicId] = await Promise.all([
      hasColumn('surgeries', 'procedure_type'),
      hasColumn('surgeries', 'procedure_details'),
      hasColumn('surgeries', 'complications'),
      hasColumn('surgeries', 'require_qualified_signature'),
      hasColumn('surgeries', 'procedure_classification'),
      hasColumn('surgeries', 'medical_record_id'),
      hasTable('medical_records'),
      hasColumn('surgeries', 'clinic_id'),
    ]);

    if (hasMedicalRecordId && hasMedicalRecordsTable) {
      if (!medicalRecordId) {
        return res.status(400).json({ error: 'Selecione um prontuario medico antes de registrar o procedimento' });
      }

      const record = await query(
        `SELECT id
         FROM medical_records
         WHERE id = $1 AND patient_id = $2`,
        [medicalRecordId, patientId]
      );
      if (record.rowCount === 0) {
        return res.status(400).json({ error: 'Prontuario medico invalido para o paciente selecionado' });
      }
    }

    const insertColumns = ['patient_id', 'doctor_id', 'title', 'scheduled_at', 'hospital', 'notes', 'status'];
    const insertValues = [patientId, req.doctor.id, title, dateValue || null, hospital || null, notes || null, normalizedStatus];

    if (hasProcedureType) {
      insertColumns.push('procedure_type');
      insertValues.push(procedureType || null);
    }
    if (hasProcedureDetails) {
      insertColumns.push('procedure_details');
      insertValues.push(procedureDetails || null);
    }
    if (hasComplications) {
      insertColumns.push('complications');
      insertValues.push(complications || null);
    }
    if (hasRequireQualifiedSignature) {
      insertColumns.push('require_qualified_signature');
      insertValues.push(Boolean(requireQualifiedSignature));
    }
    if (hasProcedureClassification) {
      insertColumns.push('procedure_classification');
      insertValues.push(procedureClassification || null);
    }
    if (hasMedicalRecordId) {
      insertColumns.push('medical_record_id');
      insertValues.push(medicalRecordId || null);
    }
    if (hasSurgeriesClinicId) {
      insertColumns.push('clinic_id');
      insertValues.push(req.doctor.clinicId || null);
    }

    const valuePlaceholders = insertValues.map((_, index) => `$${index + 1}`).join(', ');

    const inserted = await query(
      `INSERT INTO surgeries (${insertColumns.join(', ')})
       VALUES (${valuePlaceholders})
       RETURNING *`,
      insertValues
    );

    const newRow = inserted.rows[0];

    if (hasMedicalRecordId && hasMedicalRecordsTable && medicalRecordId) {
      await query(
        `UPDATE medical_records
            SET status = 'COMPLETED',
                closed_at = COALESCE(closed_at, now())
          WHERE id = $1 AND patient_id = $2`,
        [medicalRecordId, patientId]
      );
    }

    socketService.emitToDoctor(req.doctor.id, 'procedure_created', { id: newRow.id, title: newRow.title, status: newRow.status, patient_id: newRow.patient_id });

    if (newRow.status === 'SIGNED') {
      try {
        await ensureAutoChargeForSurgery(newRow.id);
      } catch (cashierErr) {
        console.warn('[Caixa] Falha ao gerar cobranca automatica:', cashierErr.message);
      }
    }

    return res.status(201).json(newRow);
  } catch (error) {
    return next(error);
  }
});

router.put('/:id', requireDoctor, async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      title,
      procedureName,
      scheduledAt,
      surgeryDate,
      hospital,
      procedureType,
      procedureDetails,
      complications,
      notes,
      status,
      patientId,
      requireQualifiedSignature,
      procedureClassification,
      medicalRecordId,
    } = req.body;

    const hasSurgeriesClinicId = await hasColumn('surgeries', 'clinic_id');
    const current = hasSurgeriesClinicId
      ? await query('SELECT id FROM surgeries WHERE id = $1 AND doctor_id = $2 AND clinic_id = $3', [id, req.doctor.id, req.doctor.clinicId || null])
      : await query('SELECT id FROM surgeries WHERE id = $1 AND doctor_id = $2', [id, req.doctor.id]);
    if (current.rowCount === 0) {
      return res.status(404).json({ error: 'Procedimento nao encontrado' });
    }

    const [hasProcedureType, hasProcedureDetails, hasComplications, hasRequireQualifiedSignature, hasProcedureClassification, hasMedicalRecordId, hasMedicalRecordsTable] = await Promise.all([
      hasColumn('surgeries', 'procedure_type'),
      hasColumn('surgeries', 'procedure_details'),
      hasColumn('surgeries', 'complications'),
      hasColumn('surgeries', 'require_qualified_signature'),
      hasColumn('surgeries', 'procedure_classification'),
      hasColumn('surgeries', 'medical_record_id'),
      hasTable('medical_records'),
    ]);

    if (patientId) {
      const hasPatientsClinicId = await hasColumn('patients', 'clinic_id');
      const patient = hasPatientsClinicId
        ? await query('SELECT id FROM patients WHERE id = $1 AND clinic_id = $2', [patientId, req.doctor.clinicId || null])
        : await query('SELECT id FROM patients WHERE id = $1', [patientId]);
      if (patient.rowCount === 0) {
        return res.status(404).json({ error: 'Paciente nao encontrado' });
      }
    }

    if (hasMedicalRecordId && hasMedicalRecordsTable && medicalRecordId) {
      const targetPatientId = patientId || (await query('SELECT patient_id FROM surgeries WHERE id = $1', [id])).rows[0]?.patient_id;
      const record = await query(
        `SELECT id
         FROM medical_records
         WHERE id = $1 AND patient_id = $2`,
        [medicalRecordId, targetPatientId]
      );
      if (record.rowCount === 0) {
        return res.status(400).json({ error: 'Prontuario medico invalido para o paciente selecionado' });
      }
    }

    const nextStatus = ['DRAFT', 'scheduled', 'completed', 'cancelled', 'AWAITING_SIGNATURE', 'SIGNED'].includes(status) ? status : 'DRAFT';
    const nextTitle = title || procedureName;
    const nextDate = scheduledAt || surgeryDate || null;

    const sets = [];
    const values = [];
    const pushSet = (col, val) => {
      values.push(val);
      sets.push(`${col} = $${values.length}`);
    };

    if (patientId) pushSet('patient_id', patientId);
    if (nextTitle) pushSet('title', nextTitle);
    pushSet('scheduled_at', nextDate);
    pushSet('hospital', hospital || null);
    pushSet('notes', notes || null);
    pushSet('status', nextStatus);
    if (hasProcedureType) pushSet('procedure_type', procedureType || null);
    if (hasProcedureDetails) pushSet('procedure_details', procedureDetails || null);
    if (hasComplications) pushSet('complications', complications || null);
    if (hasRequireQualifiedSignature) pushSet('require_qualified_signature', Boolean(requireQualifiedSignature));
    if (hasProcedureClassification) pushSet('procedure_classification', procedureClassification || null);
    if (hasMedicalRecordId && medicalRecordId) pushSet('medical_record_id', medicalRecordId);

    values.push(id);
    values.push(req.doctor.id);
    const updated = await query(
      `UPDATE surgeries
       SET ${sets.join(', ')}
       WHERE id = $${values.length - 1} AND doctor_id = $${values.length}
       RETURNING *`,
      values
    );

    const updatedRow = updated.rows[0];

    if (hasMedicalRecordId && hasMedicalRecordsTable && medicalRecordId && updatedRow?.patient_id) {
      await query(
        `UPDATE medical_records
            SET status = 'COMPLETED',
                closed_at = COALESCE(closed_at, now())
          WHERE id = $1 AND patient_id = $2`,
        [medicalRecordId, updatedRow.patient_id]
      );
    }

    socketService.emitToDoctor(req.doctor.id, 'procedure_updated', { id: updatedRow.id, title: updatedRow.title, status: updatedRow.status });

    if (updatedRow.status === 'SIGNED') {
      try {
        await ensureAutoChargeForSurgery(updatedRow.id);
      } catch (cashierErr) {
        console.warn('[Caixa] Falha ao gerar cobranca automatica:', cashierErr.message);
      }
    }

    return res.json(updatedRow);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

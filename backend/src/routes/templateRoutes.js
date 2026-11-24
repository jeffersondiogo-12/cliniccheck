const express = require('express');
const { query } = require('../config/database');
const { requireDoctor } = require('../middleware/auth');
const socketService = require('../services/socketService');

const router = express.Router();

const columnCache = new Map();

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

router.get('/', requireDoctor, async (_req, res, next) => {
  try {
    const [hasProcedureType, hasTemplatesClinicId] = await Promise.all([
      hasColumn('document_templates', 'procedure_type'),
      hasColumn('document_templates', 'clinic_id'),
    ]);

    const templates = await query(
      `SELECT id, name, body_html,
              ${hasProcedureType ? 'procedure_type' : 'NULL::text AS procedure_type'},
              created_by, created_at
       FROM document_templates
       ${hasTemplatesClinicId ? 'WHERE clinic_id = $1' : ''}
       ORDER BY created_at DESC`,
      hasTemplatesClinicId ? [_req.doctor.clinicId || null] : []
    );

    return res.json(templates.rows);
  } catch (error) {
    return next(error);
  }
});

router.post('/', requireDoctor, async (req, res, next) => {
  try {
    const { name, bodyHtml, procedureType } = req.body;

    if (!name || !bodyHtml) {
      return res.status(400).json({ error: 'name e bodyHtml sao obrigatorios' });
    }

    const [hasProcedureType, hasTemplatesClinicId] = await Promise.all([
      hasColumn('document_templates', 'procedure_type'),
      hasColumn('document_templates', 'clinic_id'),
    ]);

    const insertColumns = ['name', 'body_html', 'created_by'];
    const insertValues = [name, bodyHtml, req.doctor.id];

    if (hasProcedureType) {
      insertColumns.push('procedure_type');
      insertValues.push(procedureType || null);
    }
    if (hasTemplatesClinicId) {
      insertColumns.push('clinic_id');
      insertValues.push(req.doctor.clinicId || null);
    }

    const valuePlaceholders = insertValues.map((_, index) => `$${index + 1}`).join(', ');
    const inserted = await query(
      `INSERT INTO document_templates (${insertColumns.join(', ')})
       VALUES (${valuePlaceholders})
       RETURNING *`,
      insertValues
    );

    socketService.emitToDoctor(req.doctor.id, 'template_created', {
      id: inserted.rows[0].id,
      name: inserted.rows[0].name,
    });

    return res.status(201).json(inserted.rows[0]);
  } catch (error) {
    return next(error);
  }
});

router.put('/:id', requireDoctor, async (req, res, next) => {
  try {
    const { name, bodyHtml, procedureType } = req.body;
    const { id } = req.params;

    if (!name || !bodyHtml) {
      return res.status(400).json({ error: 'name e bodyHtml sao obrigatorios' });
    }

    const [hasProcedureType, hasTemplatesClinicId] = await Promise.all([
      hasColumn('document_templates', 'procedure_type'),
      hasColumn('document_templates', 'clinic_id'),
    ]);
    const sets = ['name = $1', 'body_html = $2'];
    const values = [name, bodyHtml];

    if (hasProcedureType) {
      values.push(procedureType || null);
      sets.push(`procedure_type = $${values.length}`);
    }

    values.push(id);
    values.push(req.doctor.id);

    const updated = await query(
      `UPDATE document_templates
       SET ${sets.join(', ')}
       WHERE id = $${values.length - 1} AND created_by = $${values.length}
       ${hasTemplatesClinicId ? `AND clinic_id = $${values.length + 1}` : ''}
       RETURNING *`,
      hasTemplatesClinicId ? [...values, req.doctor.clinicId || null] : values
    );

    if (updated.rowCount === 0) {
      return res.status(404).json({ error: 'Modelo nao encontrado' });
    }

    socketService.emitToDoctor(req.doctor.id, 'template_updated', {
      id: updated.rows[0].id,
      name: updated.rows[0].name,
    });

    return res.json(updated.rows[0]);
  } catch (error) {
    return next(error);
  }
});

router.delete('/:id', requireDoctor, async (req, res, next) => {
  try {
    const hasTemplatesClinicId = await hasColumn('document_templates', 'clinic_id');
    const result = await query(
      `DELETE FROM document_templates WHERE id = $1 AND created_by = $2
       ${hasTemplatesClinicId ? 'AND clinic_id = $3' : ''}
       RETURNING id`,
      hasTemplatesClinicId ? [req.params.id, req.doctor.id, req.doctor.clinicId || null] : [req.params.id, req.doctor.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Modelo nao encontrado' });
    }

    socketService.emitToDoctor(req.doctor.id, 'template_deleted', {
      id: req.params.id,
    });

    return res.json({ deleted: true });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

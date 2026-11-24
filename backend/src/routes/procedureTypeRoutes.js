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

const DEFAULT_CATEGORIES = [
  'CIRURGIA',
  'EXAME',
  'TRATAMENTO',
  'CONSULTA_ESPECIALIZADA',
  'INTERNACAO',
  'OUTRO',
];

function normalizeCategory(value) {
  return String(value || '').trim();
}

// Retorna null (sem preco definido), o valor numerico normalizado, ou `false` se invalido.
function normalizePrice(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(num) || num < 0) return false;
  return Math.round(num * 100) / 100;
}

async function getDefaultOverrides(doctorId) {
  const hasCategoryClinicId = await hasColumn('procedure_type_categories', 'clinic_id');
  const clinicId = arguments.length > 1 ? arguments[1] : null;
  const result = await query(
    `SELECT id, base_default, name, active
     FROM procedure_type_categories
     WHERE doctor_id = $1
       ${hasCategoryClinicId ? 'AND clinic_id = $2' : ''}
       AND base_default IS NOT NULL
       AND active = true`,
    hasCategoryClinicId ? [doctorId, clinicId] : [doctorId]
  );

  const map = new Map();
  result.rows.forEach((row) => {
    if (row.base_default && row.name) {
      map.set(String(row.base_default).trim(), row);
    }
  });
  return map;
}

async function getEffectiveDefaultCategories(doctorId) {
  const clinicId = arguments.length > 1 ? arguments[1] : null;
  const overrides = await getDefaultOverrides(doctorId, clinicId);
  return DEFAULT_CATEGORIES.map((baseName) => {
    const override = overrides.get(baseName);
    return {
      id: `default:${baseName}`,
      doctor_id: null,
      name: override?.name || baseName,
      base_default: baseName,
      active: true,
      is_default: true,
    };
  });
}

async function getAllowedCategories(doctorId) {
  const clinicId = arguments.length > 1 ? arguments[1] : null;
  const [effectiveDefaults, hasCategoryClinicId] = await Promise.all([
    getEffectiveDefaultCategories(doctorId, clinicId),
    hasColumn('procedure_type_categories', 'clinic_id'),
  ]);
  const custom = await query(
    `SELECT name FROM procedure_type_categories
     WHERE (doctor_id = $1 OR doctor_id IS NULL)
       ${hasCategoryClinicId ? 'AND clinic_id = $2' : ''}
       AND active = true
     ORDER BY name ASC`,
    hasCategoryClinicId ? [doctorId, clinicId] : [doctorId]
  );
  const set = new Set(effectiveDefaults.map((c) => c.name));
  custom.rows.forEach((r) => {
    if (r.name && r.name.trim()) set.add(r.name.trim());
  });
  return Array.from(set);
}

// GET /api/procedure-types/categories — categorias ativas
router.get('/categories', requireDoctor, async (req, res, next) => {
  try {
    const hasCategoryClinicId = await hasColumn('procedure_type_categories', 'clinic_id');
    const custom = await query(
      `SELECT * FROM procedure_type_categories
       WHERE (doctor_id = $1 OR doctor_id IS NULL)
         ${hasCategoryClinicId ? 'AND clinic_id = $2' : ''}
         AND active = true
         AND base_default IS NULL
       ORDER BY name ASC`,
      hasCategoryClinicId ? [req.doctor.id, req.doctor.clinicId || null] : [req.doctor.id]
    );
    const defaultRows = await getEffectiveDefaultCategories(req.doctor.id, req.doctor.clinicId || null);
    return res.json([...defaultRows, ...custom.rows.map((r) => ({ ...r, is_default: false }))]);
  } catch (err) {
    return next(err);
  }
});

// GET /api/procedure-types/categories/all — categorias do medico (inclui inativas)
router.get('/categories/all', requireDoctor, async (req, res, next) => {
  try {
    const hasCategoryClinicId = await hasColumn('procedure_type_categories', 'clinic_id');
    const result = await query(
      `SELECT * FROM procedure_type_categories
       WHERE doctor_id = $1
       ${hasCategoryClinicId ? 'AND clinic_id = $2' : ''}
       ORDER BY active DESC, name ASC`,
      hasCategoryClinicId ? [req.doctor.id, req.doctor.clinicId || null] : [req.doctor.id]
    );
    return res.json(result.rows);
  } catch (err) {
    return next(err);
  }
});

// POST /api/procedure-types/categories — cria categoria customizada
router.post('/categories', requireDoctor, async (req, res, next) => {
  try {
    const hasCategoryClinicId = await hasColumn('procedure_type_categories', 'clinic_id');
    const name = normalizeCategory(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Nome da categoria e obrigatorio' });

    const existsDefault = DEFAULT_CATEGORIES.some((c) => c.toLowerCase() === name.toLowerCase());
    if (existsDefault) return res.status(409).json({ error: 'Categoria ja existe como padrao' });

    const exists = await query(
      `SELECT id FROM procedure_type_categories
       WHERE doctor_id = $1 AND lower(name) = lower($2)
       ${hasCategoryClinicId ? 'AND clinic_id = $3' : ''}
       LIMIT 1`,
      hasCategoryClinicId ? [req.doctor.id, name, req.doctor.clinicId || null] : [req.doctor.id, name]
    );
    if (exists.rowCount > 0) return res.status(409).json({ error: 'Categoria ja cadastrada' });

    const inserted = hasCategoryClinicId
      ? await query(
        `INSERT INTO procedure_type_categories (doctor_id, name, active, clinic_id)
         VALUES ($1,$2,true,$3)
         RETURNING *`,
        [req.doctor.id, name, req.doctor.clinicId || null]
      )
      : await query(
        `INSERT INTO procedure_type_categories (doctor_id, name, active)
         VALUES ($1,$2,true)
         RETURNING *`,
        [req.doctor.id, name]
      );

    socketService.emitToDoctor(req.doctor.id, 'procedure_category_created', {
      id: inserted.rows[0].id,
      name: inserted.rows[0].name,
    });

    return res.status(201).json(inserted.rows[0]);
  } catch (err) {
    return next(err);
  }
});

// PUT /api/procedure-types/categories/:id — atualiza categoria customizada
router.put('/categories/:id', requireDoctor, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, active } = req.body || {};
    const hasCategoryClinicId = await hasColumn('procedure_type_categories', 'clinic_id');

    if (String(id).startsWith('default:')) {
      const baseName = String(id).slice('default:'.length).trim();
      const isDefaultCategory = DEFAULT_CATEGORIES.some((c) => c.toLowerCase() === baseName.toLowerCase());
      if (!isDefaultCategory) {
        return res.status(404).json({ error: 'Categoria padrao nao encontrada' });
      }
      if (name == null) {
        return res.status(400).json({ error: 'Nome da categoria invalido' });
      }

      const normalized = normalizeCategory(name);
      if (!normalized) return res.status(400).json({ error: 'Nome da categoria invalido' });

      const duplicated = await query(
        `SELECT id FROM procedure_type_categories
         WHERE doctor_id = $1 AND lower(name) = lower($2)
           AND (base_default IS NULL OR lower(base_default) <> lower($3))
          ${hasCategoryClinicId ? 'AND clinic_id = $4' : ''}
         LIMIT 1`,
        hasCategoryClinicId ? [req.doctor.id, normalized, baseName, req.doctor.clinicId || null] : [req.doctor.id, normalized, baseName]
      );
      if (duplicated.rowCount > 0) {
        return res.status(409).json({ error: 'Categoria ja cadastrada' });
      }

      const existingOverride = await query(
        `SELECT id, name FROM procedure_type_categories
         WHERE doctor_id = $1 AND lower(base_default) = lower($2)
         ${hasCategoryClinicId ? 'AND clinic_id = $3' : ''}
         LIMIT 1`,
        hasCategoryClinicId ? [req.doctor.id, baseName, req.doctor.clinicId || null] : [req.doctor.id, baseName]
      );

      if (existingOverride.rowCount > 0) {
        await query(
          `UPDATE procedure_type_categories
           SET name = $1, active = true
           WHERE id = $2`,
          [normalized, existingOverride.rows[0].id]
        );
      } else {
        await query(
          `INSERT INTO procedure_type_categories (doctor_id, name, active, base_default${hasCategoryClinicId ? ', clinic_id' : ''})
           VALUES ($1,$2,true,$3${hasCategoryClinicId ? ', $4' : ''})`,
          hasCategoryClinicId ? [req.doctor.id, normalized, baseName, req.doctor.clinicId || null] : [req.doctor.id, normalized, baseName]
        );
      }

      const previousName = existingOverride.rows[0]?.name;
      const hasTypeClinicId = await hasColumn('procedure_types', 'clinic_id');
      if (previousName && previousName.trim()) {
        await query(
          `UPDATE procedure_types
           SET category = $1
           WHERE doctor_id = $2
             ${hasTypeClinicId ? 'AND clinic_id = $5' : ''}
             AND (lower(category) = lower($3) OR lower(category) = lower($4))`,
          hasTypeClinicId ? [normalized, req.doctor.id, baseName, previousName, req.doctor.clinicId || null] : [normalized, req.doctor.id, baseName, previousName]
        );
      } else {
        await query(
          `UPDATE procedure_types
           SET category = $1
           WHERE doctor_id = $2
             ${hasTypeClinicId ? 'AND clinic_id = $4' : ''}
             AND lower(category) = lower($3)`,
          hasTypeClinicId ? [normalized, req.doctor.id, baseName, req.doctor.clinicId || null] : [normalized, req.doctor.id, baseName]
        );
      }

      socketService.emitToDoctor(req.doctor.id, 'procedure_category_updated', {
        id: `default:${baseName}`,
        name: normalized,
        active: true,
      });

      return res.json({
        id: `default:${baseName}`,
        doctor_id: null,
        name: normalized,
        active: true,
        is_default: true,
        base_default: baseName,
      });
    }

    const existing = await query(
      `SELECT id FROM procedure_type_categories WHERE id = $1 AND doctor_id = $2
       ${hasCategoryClinicId ? 'AND clinic_id = $3' : ''}`,
      hasCategoryClinicId ? [id, req.doctor.id, req.doctor.clinicId || null] : [id, req.doctor.id]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Categoria nao encontrada' });

    if (name != null) {
      const normalized = normalizeCategory(name);
      if (!normalized) return res.status(400).json({ error: 'Nome da categoria invalido' });
      const duplicated = await query(
        `SELECT id FROM procedure_type_categories
         WHERE doctor_id = $1 AND lower(name) = lower($2) AND id <> $3
         ${hasCategoryClinicId ? 'AND clinic_id = $4' : ''}
         LIMIT 1`,
        hasCategoryClinicId ? [req.doctor.id, normalized, id, req.doctor.clinicId || null] : [req.doctor.id, normalized, id]
      );
      if (duplicated.rowCount > 0) return res.status(409).json({ error: 'Categoria ja cadastrada' });
    }

    const updated = await query(
      `UPDATE procedure_type_categories SET
         name = COALESCE($1, name),
         active = COALESCE($2, active)
       WHERE id = $3 AND doctor_id = $4
       ${hasCategoryClinicId ? 'AND clinic_id = $5' : ''}
       RETURNING *`,
      hasCategoryClinicId
        ? [name != null ? normalizeCategory(name) : null, active != null ? Boolean(active) : null, id, req.doctor.id, req.doctor.clinicId || null]
        : [name != null ? normalizeCategory(name) : null, active != null ? Boolean(active) : null, id, req.doctor.id]
    );

    socketService.emitToDoctor(req.doctor.id, 'procedure_category_updated', {
      id: updated.rows[0].id,
      name: updated.rows[0].name,
      active: updated.rows[0].active,
    });

    return res.json(updated.rows[0]);
  } catch (err) {
    return next(err);
  }
});

// GET /api/procedure-types — lista todos os tipos do médico (+ globais sem doctor_id)
router.get('/', requireDoctor, async (req, res, next) => {
  try {
    const hasTypeClinicId = await hasColumn('procedure_types', 'clinic_id');
    const result = await query(
      `SELECT * FROM procedure_types
       WHERE (doctor_id = $1 OR doctor_id IS NULL)
       ${hasTypeClinicId ? 'AND clinic_id = $2' : ''}
       AND active = true
       ORDER BY name ASC`,
      hasTypeClinicId ? [req.doctor.id, req.doctor.clinicId || null] : [req.doctor.id]
    );
    return res.json(result.rows);
  } catch (err) {
    return next(err);
  }
});

// GET /api/procedure-types/all — lista todos (inclusive inativos) — só do médico
router.get('/all', requireDoctor, async (req, res, next) => {
  try {
    const hasTypeClinicId = await hasColumn('procedure_types', 'clinic_id');
    const result = await query(
      `SELECT * FROM procedure_types
       WHERE doctor_id = $1
       ${hasTypeClinicId ? 'AND clinic_id = $2' : ''}
       ORDER BY active DESC, name ASC`,
      hasTypeClinicId ? [req.doctor.id, req.doctor.clinicId || null] : [req.doctor.id]
    );
    return res.json(result.rows);
  } catch (err) {
    return next(err);
  }
});

// POST /api/procedure-types — cria novo tipo
router.post('/', requireDoctor, async (req, res, next) => {
  try {
    const {
      name,
      category,
      description,
      defaultRisks,
      defaultPreparation,
      suppliesPreparation,
      estimatedDurationMin,
      requireQualifiedSignature,
      price,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Nome do tipo e obrigatorio' });
    }

    const normalizedCategory = normalizeCategory(category || 'CIRURGIA');
    const allowedCategories = await getAllowedCategories(req.doctor.id, req.doctor.clinicId || null);
    const categoryValid = allowedCategories.some((c) => c.toLowerCase() === normalizedCategory.toLowerCase());
    if (!categoryValid) {
      return res.status(400).json({ error: 'Categoria invalida. Cadastre a categoria antes de usar.' });
    }

    const normalizedPrice = normalizePrice(price);
    if (normalizedPrice === false) {
      return res.status(400).json({ error: 'Preco invalido. Informe um valor numerico maior ou igual a zero.' });
    }

    const hasTypeClinicId = await hasColumn('procedure_types', 'clinic_id');
    const inserted = hasTypeClinicId
      ? await query(
        `INSERT INTO procedure_types
           (doctor_id, name, category, description, default_risks, default_preparation,
            estimated_duration_min, require_qualified_signature, price, clinic_id, supplies_preparation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          req.doctor.id,
          name.trim(),
          normalizedCategory,
          description || null,
          defaultRisks || null,
          defaultPreparation || null,
          estimatedDurationMin ? parseInt(estimatedDurationMin, 10) : null,
          Boolean(requireQualifiedSignature),
          normalizedPrice,
          req.doctor.clinicId || null,
          suppliesPreparation || null,
        ]
      )
      : await query(
        `INSERT INTO procedure_types
           (doctor_id, name, category, description, default_risks, default_preparation,
            estimated_duration_min, require_qualified_signature, price, supplies_preparation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          req.doctor.id,
          name.trim(),
          normalizedCategory,
          description || null,
          defaultRisks || null,
          defaultPreparation || null,
          estimatedDurationMin ? parseInt(estimatedDurationMin, 10) : null,
          Boolean(requireQualifiedSignature),
          normalizedPrice,
          suppliesPreparation || null,
        ]
      );

    socketService.emitToDoctor(req.doctor.id, 'procedure_type_created', {
      id: inserted.rows[0].id,
      name: inserted.rows[0].name,
      category: inserted.rows[0].category,
    });

    return res.status(201).json(inserted.rows[0]);
  } catch (err) {
    return next(err);
  }
});

// PUT /api/procedure-types/:id — atualiza tipo existente
router.put('/:id', requireDoctor, async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      name,
      category,
      description,
      defaultRisks,
      defaultPreparation,
      suppliesPreparation,
      estimatedDurationMin,
      requireQualifiedSignature,
      price,
      active,
    } = req.body;

    // Garante que só edita os próprios
    const hasTypeClinicId = await hasColumn('procedure_types', 'clinic_id');
    const existing = await query(
      `SELECT id FROM procedure_types WHERE id = $1 AND doctor_id = $2
       ${hasTypeClinicId ? 'AND clinic_id = $3' : ''}`,
      hasTypeClinicId ? [id, req.doctor.id, req.doctor.clinicId || null] : [id, req.doctor.id]
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'Tipo nao encontrado' });
    }

    if (category != null) {
      const normalizedCategory = normalizeCategory(category);
      if (!normalizedCategory) return res.status(400).json({ error: 'Categoria invalida' });
      const allowedCategories = await getAllowedCategories(req.doctor.id, req.doctor.clinicId || null);
      const categoryValid = allowedCategories.some((c) => c.toLowerCase() === normalizedCategory.toLowerCase());
      if (!categoryValid) {
        return res.status(400).json({ error: 'Categoria invalida. Cadastre a categoria antes de usar.' });
      }
    }

    const normalizedPrice = normalizePrice(price);
    if (normalizedPrice === false) {
      return res.status(400).json({ error: 'Preco invalido. Informe um valor numerico maior ou igual a zero.' });
    }

    const updated = await query(
      `UPDATE procedure_types SET
         name = COALESCE($1, name),
         category = COALESCE($2, category),
         description = $3,
         default_risks = $4,
         default_preparation = $5,
         estimated_duration_min = $6,
         require_qualified_signature = COALESCE($7, require_qualified_signature),
         price = $8,
         active = COALESCE($9, active),
         supplies_preparation = ${hasTypeClinicId ? '$13' : '$12'}
       WHERE id = $10 AND doctor_id = $11
       ${hasTypeClinicId ? 'AND clinic_id = $12' : ''}
       RETURNING *`,
      hasTypeClinicId
        ? [
          name ? name.trim() : null,
          category != null ? normalizeCategory(category) : null,
          description ?? null,
          defaultRisks ?? null,
          defaultPreparation ?? null,
          estimatedDurationMin != null ? parseInt(estimatedDurationMin, 10) : null,
          requireQualifiedSignature != null ? Boolean(requireQualifiedSignature) : null,
          normalizedPrice,
          active != null ? Boolean(active) : null,
          id,
          req.doctor.id,
          req.doctor.clinicId || null,
          suppliesPreparation ?? null,
        ]
        : [
          name ? name.trim() : null,
          category != null ? normalizeCategory(category) : null,
          description ?? null,
          defaultRisks ?? null,
          defaultPreparation ?? null,
          estimatedDurationMin != null ? parseInt(estimatedDurationMin, 10) : null,
          requireQualifiedSignature != null ? Boolean(requireQualifiedSignature) : null,
          normalizedPrice,
          active != null ? Boolean(active) : null,
          id,
          req.doctor.id,
          suppliesPreparation ?? null,
        ]
    );

    socketService.emitToDoctor(req.doctor.id, 'procedure_type_updated', {
      id: updated.rows[0].id,
      name: updated.rows[0].name,
      active: updated.rows[0].active,
    });

    return res.json(updated.rows[0]);
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/procedure-types/:id — desativa (soft delete)
router.delete('/:id', requireDoctor, async (req, res, next) => {
  try {
    const { id } = req.params;
    const hasTypeClinicId = await hasColumn('procedure_types', 'clinic_id');
    const result = await query(
      `UPDATE procedure_types SET active = false
       WHERE id = $1 AND doctor_id = $2
       ${hasTypeClinicId ? 'AND clinic_id = $3' : ''}
       RETURNING id`,
      hasTypeClinicId ? [id, req.doctor.id, req.doctor.clinicId || null] : [id, req.doctor.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Tipo nao encontrado' });
    }

    socketService.emitToDoctor(req.doctor.id, 'procedure_type_deleted', {
      id,
    });

    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// GET /api/procedure-types/:id/products — lista os produtos de estoque
// vinculados a esse tipo de procedimento (o "kit"/receita), com o saldo
// atual de cada um pra dar uma ideia rapida de disponibilidade.
router.get('/:id/products', requireDoctor, async (req, res, next) => {
  try {
    const { id } = req.params;
    const hasTypeClinicId = await hasColumn('procedure_types', 'clinic_id');
    const owns = await query(
      `SELECT id FROM procedure_types WHERE id = $1 AND doctor_id = $2 ${hasTypeClinicId ? 'AND clinic_id = $3' : ''}`,
      hasTypeClinicId ? [id, req.doctor.id, req.doctor.clinicId || null] : [id, req.doctor.id]
    );
    if (owns.rowCount === 0) return res.status(404).json({ error: 'Tipo nao encontrado' });

    const result = await query(
      `SELECT ptp.id, ptp.product_id, ptp.quantity, ptp.notes,
              sp.name AS product_name, sp.unit AS product_unit, sp.active AS product_active,
              COALESCE(sm.balance, 0) AS product_balance
         FROM procedure_type_products ptp
         JOIN stock_products sp ON sp.id = ptp.product_id
         LEFT JOIN LATERAL (
           SELECT SUM(quantity) AS balance FROM stock_movements WHERE product_id = sp.id
         ) sm ON true
        WHERE ptp.procedure_type_id = $1
        ORDER BY sp.name ASC`,
      [id]
    );
    return res.json(result.rows.map((r) => ({ ...r, quantity: Number(r.quantity), product_balance: Number(r.product_balance) })));
  } catch (err) {
    return next(err);
  }
});

// PUT /api/procedure-types/:id/products — substitui a lista inteira de
// produtos/quantidades desse tipo de procedimento de uma vez (mais simples
// pra tela do que ficar dando POST/DELETE item a item).
router.put('/:id/products', requireDoctor, async (req, res, next) => {
  try {
    const { id } = req.params;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    const hasTypeClinicId = await hasColumn('procedure_types', 'clinic_id');
    const owns = await query(
      `SELECT id FROM procedure_types WHERE id = $1 AND doctor_id = $2 ${hasTypeClinicId ? 'AND clinic_id = $3' : ''}`,
      hasTypeClinicId ? [id, req.doctor.id, req.doctor.clinicId || null] : [id, req.doctor.id]
    );
    if (owns.rowCount === 0) return res.status(404).json({ error: 'Tipo nao encontrado' });

    const cleanItems = [];
    for (const item of items) {
      const productId = item?.productId;
      const quantity = Number(String(item?.quantity ?? '1').replace(',', '.'));
      if (!productId || !Number.isFinite(quantity) || quantity <= 0) continue;
      cleanItems.push({ productId, quantity, notes: item?.notes || null });
    }

    await query(`DELETE FROM procedure_type_products WHERE procedure_type_id = $1`, [id]);
    for (const item of cleanItems) {
      await query(
        `INSERT INTO procedure_type_products (procedure_type_id, product_id, quantity, notes)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (procedure_type_id, product_id) DO UPDATE SET quantity = excluded.quantity, notes = excluded.notes`,
        [id, item.productId, item.quantity, item.notes]
      );
    }

    socketService.emitToDoctor(req.doctor.id, 'procedure_type_products_updated', { procedureTypeId: id });
    return res.json({ success: true, count: cleanItems.length });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

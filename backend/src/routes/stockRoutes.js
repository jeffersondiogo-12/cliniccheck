const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const convert = require('xml-js');
const { query, pool } = require('../config/database');
const { requireDoctorOrReceptionist, getStaffPermission } = require('../middleware/auth');
const socketService = require('../services/socketService');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (!/\.xml$/i.test(file.originalname || '')) {
      return cb(new Error('Envie um arquivo .xml (NFe).'));
    }
    cb(null, true);
  },
});

// ─────────────────────────────────────────────────────────────────
// PERMISSAO — medico ou recepcionista, checando a pagina 'estoque'
// ─────────────────────────────────────────────────────────────────
function requireStockPermission(action) {
  return async (req, res, next) => {
    try {
      const perm = await getStaffPermission(req.user, 'estoque');
      if (!perm || !(perm.isOwner || perm[`can_${action}`])) {
        return res.status(403).json({ error: 'Voce nao tem permissao para esta acao no estoque.' });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────
function normalizeQty(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(num) ? num : null;
}

function txt(node) {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  if (node._text != null) return String(node._text).trim();
  return null;
}

function toArr(node) {
  if (node == null) return [];
  return Array.isArray(node) ? node : [node];
}

function parseXmlNumber(s) {
  if (s == null) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// Extrai os dados relevantes de uma NFe (itens de produto e
// duplicatas/boleto, se houver) a partir do XML bruto no layout padrao da
// SEFAZ (funciona tanto pro XML "puro" <NFe> quanto pro "processado"
// <nfeProc><NFe>...).
function parseNFeXml(xmlString) {
  let parsed;
  try {
    parsed = convert.xml2js(xmlString, { compact: true, ignoreDeclaration: true, ignoreComment: true });
  } catch (err) {
    throw new Error('Arquivo XML mal formado.');
  }
  const root = parsed.nfeProc ? parsed.nfeProc.NFe : parsed.NFe;
  if (!root || !root.infNFe) {
    throw new Error('XML nao parece ser uma NFe valida (elemento <NFe><infNFe> nao encontrado).');
  }
  const infNFe = root.infNFe;
  const accessKeyRaw = infNFe._attributes && infNFe._attributes.Id ? String(infNFe._attributes.Id) : '';
  const accessKey = accessKeyRaw.replace(/^NFe/i, '').trim() || null;

  const ide = infNFe.ide || {};
  const emit = infNFe.emit || {};
  const total = infNFe.total || {};
  const cobr = infNFe.cobr || {};

  const supplierName = txt(emit.xFant) || txt(emit.xNome) || 'Fornecedor nao identificado';
  const supplierCnpj = txt(emit.CNPJ) || txt(emit.CPF) || null;

  const items = toArr(infNFe.det)
    .map((det) => {
      const prod = (det && det.prod) || {};
      const eanRaw = txt(prod.cEAN) || txt(prod.cEANTrib);
      const ean = eanRaw && eanRaw.toUpperCase() !== 'SEM GTIN' ? eanRaw : null;
      return {
        code: txt(prod.cProd),
        ean,
        name: txt(prod.xProd) || 'Produto sem descricao',
        ncm: txt(prod.NCM),
        unit: (txt(prod.uCom) || 'UN').toUpperCase(),
        quantity: parseXmlNumber(txt(prod.qCom)),
        unitValue: parseXmlNumber(txt(prod.vUnCom)),
        totalValue: parseXmlNumber(txt(prod.vProd)),
      };
    })
    .filter((item) => item.quantity > 0);

  const duplicatas = toArr(cobr.dup)
    .filter(Boolean)
    .map((dup) => ({
      number: txt(dup.nDup),
      dueDate: txt(dup.dVenc),
      value: parseXmlNumber(txt(dup.vDup)),
    }))
    .filter((d) => d.value > 0);

  return {
    accessKey,
    nfeNumber: txt(ide.nNF),
    series: txt(ide.serie),
    issueDate: txt(ide.dhEmi) || txt(ide.dEmi) || null,
    supplierName,
    supplierCnpj,
    totalValue: parseXmlNumber(total.ICMSTot && txt(total.ICMSTot.vNF)),
    items,
    duplicatas,
  };
}

// ═══════════════════════════════════════════════════════════════
// PRODUTOS
// ═══════════════════════════════════════════════════════════════
router.get('/products', requireDoctorOrReceptionist, requireStockPermission('view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const search = (req.query.search || '').trim();
    const values = [clinicId];
    let where = `(sp.clinic_id = $1 OR sp.clinic_id IS NULL) AND sp.active = true`;
    if (search) {
      values.push(`%${search}%`);
      where += ` AND (sp.name ILIKE $${values.length} OR sp.ean_code ILIKE $${values.length} OR sp.ncm_code ILIKE $${values.length})`;
    }
    const result = await query(
      `SELECT sp.*,
              COALESCE(m.balance, 0) AS balance,
              COALESCE(m.avg_cost, 0) AS avg_cost
         FROM stock_products sp
         LEFT JOIN LATERAL (
           SELECT SUM(quantity) AS balance,
                  CASE WHEN SUM(quantity) FILTER (WHERE type = 'ENTRADA') > 0
                       THEN SUM(quantity * unit_cost) FILTER (WHERE type = 'ENTRADA') / SUM(quantity) FILTER (WHERE type = 'ENTRADA')
                       ELSE 0 END AS avg_cost
             FROM stock_movements
            WHERE product_id = sp.id
         ) m ON true
        WHERE ${where}
        ORDER BY sp.name ASC`,
      values
    );
    const rows = result.rows.map((r) => ({
      ...r,
      balance: Number(r.balance),
      avg_cost: Math.round(Number(r.avg_cost) * 100) / 100,
      minimum_quantity: Number(r.minimum_quantity),
      low_stock: Number(r.balance) <= Number(r.minimum_quantity),
    }));
    return res.json(req.query.lowStock === 'true' ? rows.filter((r) => r.low_stock) : rows);
  } catch (err) {
    return next(err);
  }
});

router.get('/products/:id', requireDoctorOrReceptionist, requireStockPermission('view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { id } = req.params;
    const productRes = await query(
      `SELECT sp.*, COALESCE(SUM(sm.quantity), 0) AS balance
         FROM stock_products sp
         LEFT JOIN stock_movements sm ON sm.product_id = sp.id
        WHERE sp.id = $1 AND (sp.clinic_id = $2 OR sp.clinic_id IS NULL)
        GROUP BY sp.id`,
      [id, clinicId]
    );
    if (productRes.rowCount === 0) return res.status(404).json({ error: 'Produto nao encontrado.' });

    const movementsRes = await query(
      `SELECT * FROM stock_movements WHERE product_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [id]
    );
    const usedInRes = await query(
      `SELECT ptp.procedure_type_id, pt.name AS procedure_type_name, ptp.quantity, ptp.notes
         FROM procedure_type_products ptp
         JOIN procedure_types pt ON pt.id = ptp.procedure_type_id
        WHERE ptp.product_id = $1
        ORDER BY pt.name ASC`,
      [id]
    );

    return res.json({
      ...productRes.rows[0],
      balance: Number(productRes.rows[0].balance),
      movements: movementsRes.rows,
      usedInProcedures: usedInRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/products', requireDoctorOrReceptionist, requireStockPermission('create'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { name, description, category, unit, ncmCode, eanCode, minimumQuantity, supplierName } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Informe o nome do produto.' });
    const inserted = await query(
      `INSERT INTO stock_products (clinic_id, name, description, category, unit, ncm_code, ean_code, minimum_quantity, supplier_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        clinicId, String(name).trim(), description || null, category || null,
        (unit || 'UN').toUpperCase().trim(), ncmCode || null, eanCode || null,
        normalizeQty(minimumQuantity) || 0, supplierName || null,
      ]
    );
    socketService.emitToClinic(clinicId, 'stock_product_created', { product: inserted.rows[0] });
    return res.status(201).json({ ...inserted.rows[0], balance: 0, avg_cost: 0 });
  } catch (err) {
    return next(err);
  }
});

router.put('/products/:id', requireDoctorOrReceptionist, requireStockPermission('update'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { id } = req.params;
    const { name, description, category, unit, ncmCode, eanCode, minimumQuantity, supplierName, active } = req.body;
    const updated = await query(
      `UPDATE stock_products SET
         name = COALESCE($1, name), description = COALESCE($2, description), category = COALESCE($3, category),
         unit = COALESCE($4, unit), ncm_code = COALESCE($5, ncm_code), ean_code = COALESCE($6, ean_code),
         minimum_quantity = COALESCE($7, minimum_quantity), supplier_name = COALESCE($8, supplier_name),
         active = COALESCE($9, active)
       WHERE id = $10 AND (clinic_id = $11 OR clinic_id IS NULL)
       RETURNING *`,
      [
        name ? String(name).trim() : null, description ?? null, category ?? null,
        unit ? String(unit).toUpperCase().trim() : null, ncmCode ?? null, eanCode ?? null,
        normalizeQty(minimumQuantity), supplierName ?? null,
        active != null ? Boolean(active) : null, id, clinicId,
      ]
    );
    if (updated.rowCount === 0) return res.status(404).json({ error: 'Produto nao encontrado.' });
    socketService.emitToClinic(clinicId, 'stock_product_updated', { product: updated.rows[0] });
    return res.json(updated.rows[0]);
  } catch (err) {
    return next(err);
  }
});

router.delete('/products/:id', requireDoctorOrReceptionist, requireStockPermission('delete'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { id } = req.params;
    // Nunca apaga de verdade — o historico de movimentacoes referencia o
    // produto. So desativa, pra sumir das listas mas manter o rastro.
    const updated = await query(
      `UPDATE stock_products SET active = false WHERE id = $1 AND (clinic_id = $2 OR clinic_id IS NULL) RETURNING id`,
      [id, clinicId]
    );
    if (updated.rowCount === 0) return res.status(404).json({ error: 'Produto nao encontrado.' });
    socketService.emitToClinic(clinicId, 'stock_product_deleted', { productId: id });
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// MOVIMENTACOES (entrada manual, saida, ajuste, perda)
// ═══════════════════════════════════════════════════════════════
router.get('/movements', requireDoctorOrReceptionist, requireStockPermission('view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { productId, type, from, to } = req.query;
    const values = [clinicId];
    let where = `(sm.clinic_id = $1 OR sm.clinic_id IS NULL)`;
    if (productId) { values.push(productId); where += ` AND sm.product_id = $${values.length}`; }
    if (type) { values.push(type); where += ` AND sm.type = $${values.length}`; }
    if (from) { values.push(from); where += ` AND sm.created_at::date >= $${values.length}`; }
    if (to) { values.push(to); where += ` AND sm.created_at::date <= $${values.length}`; }
    const result = await query(
      `SELECT sm.*, sp.name AS product_name, sp.unit AS product_unit
         FROM stock_movements sm
         JOIN stock_products sp ON sp.id = sm.product_id
        WHERE ${where}
        ORDER BY sm.created_at DESC
        LIMIT 300`,
      values
    );
    return res.json(result.rows);
  } catch (err) {
    return next(err);
  }
});

router.post('/movements', requireDoctorOrReceptionist, requireStockPermission('create'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { productId, type, quantity, unitCost, reason, batchNumber, expirationDate } = req.body;
    const validTypes = ['ENTRADA', 'SAIDA', 'AJUSTE', 'PERDA'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'Tipo de movimentacao invalido.' });
    const qty = normalizeQty(quantity);
    if (qty === null || qty === 0) return res.status(400).json({ error: 'Informe uma quantidade valida (diferente de zero).' });
    if (!productId) return res.status(400).json({ error: 'Informe o produto.' });

    const productRes = await query(
      `SELECT id FROM stock_products WHERE id = $1 AND (clinic_id = $2 OR clinic_id IS NULL)`,
      [productId, clinicId]
    );
    if (productRes.rowCount === 0) return res.status(404).json({ error: 'Produto nao encontrado.' });

    // ENTRADA sempre soma; SAIDA/PERDA sempre subtraem (a quantidade
    // digitada e tratada em modulo); AJUSTE usa o sinal exatamente como
    // digitado — serve pra corrigir tanto pra cima quanto pra baixo.
    let signedQty;
    if (type === 'ENTRADA') signedQty = Math.abs(qty);
    else if (type === 'SAIDA' || type === 'PERDA') signedQty = -Math.abs(qty);
    else signedQty = qty;

    const unitCostNum = normalizeQty(unitCost);
    const totalCost = unitCostNum != null ? Math.round(Math.abs(signedQty) * unitCostNum * 100) / 100 : null;

    const inserted = await query(
      `INSERT INTO stock_movements (clinic_id, product_id, type, quantity, unit_cost, total_cost, reason, reference_type, batch_number, expiration_date, created_by_type, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'MANUAL',$8,$9,$10,$11)
       RETURNING *`,
      [
        clinicId, productId, type, signedQty, unitCostNum, totalCost, reason || null,
        batchNumber || null, expirationDate || null, req.user.role, req.user.id,
      ]
    );
    socketService.emitToClinic(clinicId, 'stock_movement_created', { movement: inserted.rows[0] });
    return res.status(201).json(inserted.rows[0]);
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// RESUMO / ALERTAS
// ═══════════════════════════════════════════════════════════════
router.get('/summary', requireDoctorOrReceptionist, requireStockPermission('view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const balances = await query(
      `SELECT sp.id, sp.name, sp.unit, sp.minimum_quantity, COALESCE(SUM(sm.quantity), 0) AS balance
         FROM stock_products sp
         LEFT JOIN stock_movements sm ON sm.product_id = sp.id
        WHERE (sp.clinic_id = $1 OR sp.clinic_id IS NULL) AND sp.active = true
        GROUP BY sp.id, sp.name, sp.unit, sp.minimum_quantity`,
      [clinicId]
    );
    const rows = balances.rows.map((r) => ({
      ...r,
      balance: Number(r.balance),
      minimum_quantity: Number(r.minimum_quantity),
    }));
    const lowStock = rows
      .filter((r) => r.balance <= r.minimum_quantity)
      .sort((a, b) => (a.balance - a.minimum_quantity) - (b.balance - b.minimum_quantity));

    const last30 = await query(
      `SELECT COALESCE(SUM(total_cost) FILTER (WHERE type = 'ENTRADA'), 0) AS entradas_valor,
              COUNT(*) FILTER (WHERE type = 'ENTRADA') AS entradas_qtd,
              COUNT(*) FILTER (WHERE type IN ('SAIDA','PERDA','CONSUMO_PROCEDIMENTO')) AS saidas_qtd
         FROM stock_movements
        WHERE (clinic_id = $1 OR clinic_id IS NULL) AND created_at >= now() - interval '30 days'`,
      [clinicId]
    );

    return res.json({
      totalProducts: rows.length,
      lowStockCount: lowStock.length,
      lowStockItems: lowStock.slice(0, 30),
      negativeStockCount: rows.filter((r) => r.balance < 0).length,
      last30Days: {
        entradasValor: Number(last30.rows[0].entradas_valor),
        entradasQtd: Number(last30.rows[0].entradas_qtd),
        saidasQtd: Number(last30.rows[0].saidas_qtd),
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// IMPORTACAO DE XML (NFe) — entrada em lote + deteccao de boleto/duplicata
// ═══════════════════════════════════════════════════════════════
router.post(
  '/xml-import',
  requireDoctorOrReceptionist,
  requireStockPermission('create'),
  upload.single('xml'),
  async (req, res, next) => {
    if (!req.file) return res.status(400).json({ error: 'Envie o arquivo XML da NFe.' });
    const clinicId = req.user.clinicId;

    let parsedNFe;
    try {
      parsedNFe = parseNFeXml(req.file.buffer.toString('utf8'));
    } catch (err) {
      return res.status(400).json({ error: `Nao foi possivel ler o XML: ${err.message}` });
    }
    if (parsedNFe.items.length === 0) {
      return res.status(400).json({ error: 'Nenhum item de produto valido foi encontrado nessa NFe.' });
    }

    // Idempotencia: mesma chave de acesso nao processa 2x.
    if (parsedNFe.accessKey) {
      const existing = await query(
        `SELECT id, created_at FROM stock_xml_imports WHERE clinic_id = $1 AND access_key = $2 LIMIT 1`,
        [clinicId, parsedNFe.accessKey]
      );
      if (existing.rowCount > 0) {
        return res.status(409).json({
          error: `Essa nota (chave ${parsedNFe.accessKey}) ja foi importada em ${new Date(existing.rows[0].created_at).toLocaleString('pt-BR')}.`,
        });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let matchedCount = 0;
      let newProductsCount = 0;
      const processedItems = [];

      for (const item of parsedNFe.items) {
        let product = null;

        if (item.ean) {
          const byEan = await client.query(
            `SELECT * FROM stock_products WHERE (clinic_id = $1 OR clinic_id IS NULL) AND ean_code = $2 AND active = true LIMIT 1`,
            [clinicId, item.ean]
          );
          if (byEan.rowCount > 0) product = byEan.rows[0];
        }
        if (!product) {
          const byName = await client.query(
            `SELECT * FROM stock_products WHERE (clinic_id = $1 OR clinic_id IS NULL) AND active = true AND lower(name) = lower($2) LIMIT 1`,
            [clinicId, item.name]
          );
          if (byName.rowCount > 0) product = byName.rows[0];
        }

        const wasNew = !product;
        if (product) {
          matchedCount += 1;
        } else {
          const inserted = await client.query(
            `INSERT INTO stock_products (clinic_id, name, unit, ncm_code, ean_code, supplier_name)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [clinicId, item.name, item.unit || 'UN', item.ncm || null, item.ean || null, parsedNFe.supplierName]
          );
          product = inserted.rows[0];
          newProductsCount += 1;
        }

        const movement = await client.query(
          `INSERT INTO stock_movements (clinic_id, product_id, type, quantity, unit_cost, total_cost, reason, reference_type, created_by_type, created_by_id)
           VALUES ($1,$2,'ENTRADA',$3,$4,$5,$6,'XML_IMPORT',$7,$8)
           RETURNING *`,
          [
            clinicId, product.id, item.quantity, item.unitValue || null, item.totalValue || null,
            `Entrada por NFe ${parsedNFe.nfeNumber || 's/n'} — ${parsedNFe.supplierName}`, req.user.role, req.user.id,
          ]
        );

        processedItems.push({ product, movement: movement.rows[0], xmlItem: item, wasNew });
      }

      // Detecta boleto/duplicata -> cria uma conta a pagar POR duplicata
      // (uma NFe parcelada em 3 boletos vira 3 lancamentos, cada um com
      // seu proprio vencimento — igual sairia na rotina financeira manual).
      const importId = crypto.randomUUID();
      const createdExpenses = [];
      for (const dup of parsedNFe.duplicatas) {
        const expenseInserted = await client.query(
          `INSERT INTO expenses (clinic_id, description, category, supplier_name, amount, due_date, status, payment_method, notes, created_by_type, created_by_id, source_type, source_id)
           VALUES ($1,$2,'FORNECEDORES',$3,$4,$5,'PENDING','BOLETO',$6,$7,$8,'STOCK_XML_IMPORT',$9)
           RETURNING *`,
          [
            clinicId,
            `NFe ${parsedNFe.nfeNumber || 's/n'} - ${parsedNFe.supplierName}${dup.number ? ` (parcela ${dup.number})` : ''}`,
            parsedNFe.supplierName,
            dup.value,
            dup.dueDate || new Date().toISOString().slice(0, 10),
            `Gerado automaticamente a partir do XML da NFe ${parsedNFe.nfeNumber || 's/n'} (chave ${parsedNFe.accessKey || 'nao informada'}).`,
            req.user.role,
            req.user.id,
            importId,
          ]
        );
        createdExpenses.push(expenseInserted.rows[0]);
      }

      const importInserted = await client.query(
        `INSERT INTO stock_xml_imports (id, clinic_id, access_key, nfe_number, nfe_series, supplier_name, supplier_cnpj, issue_date, total_value, xml_filename, items_count, matched_count, new_products_count, expenses_created, imported_by_type, imported_by_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [
          importId, clinicId, parsedNFe.accessKey, parsedNFe.nfeNumber, parsedNFe.series,
          parsedNFe.supplierName, parsedNFe.supplierCnpj, parsedNFe.issueDate || null, parsedNFe.totalValue,
          req.file.originalname, parsedNFe.items.length, matchedCount, newProductsCount, createdExpenses.length,
          req.user.role, req.user.id,
        ]
      );

      await client.query('COMMIT');

      socketService.emitToClinic(clinicId, 'stock_xml_imported', { import: importInserted.rows[0] });
      if (createdExpenses.length > 0) socketService.emitToClinic(clinicId, 'expense_created', { count: createdExpenses.length });

      return res.status(201).json({
        import: importInserted.rows[0],
        items: processedItems.map((p) => ({
          productId: p.product.id,
          productName: p.product.name,
          wasNew: p.wasNew,
          quantity: p.movement.quantity,
          unitCost: p.movement.unit_cost,
          totalCost: p.movement.total_cost,
        })),
        expensesCreated: createdExpenses,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      return next(err);
    } finally {
      client.release();
    }
  }
);

router.get('/xml-imports', requireDoctorOrReceptionist, requireStockPermission('view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const result = await query(
      `SELECT * FROM stock_xml_imports WHERE clinic_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [clinicId]
    );
    return res.json(result.rows);
  } catch (err) {
    return next(err);
  }
});

router.get('/xml-imports/:id', requireDoctorOrReceptionist, requireStockPermission('view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { id } = req.params;
    const importRes = await query(`SELECT * FROM stock_xml_imports WHERE id = $1 AND clinic_id = $2`, [id, clinicId]);
    if (importRes.rowCount === 0) return res.status(404).json({ error: 'Importacao nao encontrada.' });

    const movementsRes = await query(
      `SELECT sm.*, sp.name AS product_name, sp.unit AS product_unit
         FROM stock_movements sm
         JOIN stock_products sp ON sp.id = sm.product_id
        WHERE sm.reference_type = 'XML_IMPORT'
          AND sm.clinic_id = $1
          AND sm.created_at BETWEEN $2::timestamptz - interval '2 minutes' AND $2::timestamptz + interval '2 minutes'
        ORDER BY sm.created_at ASC`,
      [clinicId, importRes.rows[0].created_at]
    );
    const expensesRes = await query(
      `SELECT * FROM expenses WHERE source_type = 'STOCK_XML_IMPORT' AND source_id = $1 ORDER BY due_date ASC`,
      [id]
    );

    return res.json({ ...importRes.rows[0], movements: movementsRes.rows, expenses: expensesRes.rows });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

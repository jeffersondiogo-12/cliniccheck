/**
 * financeReportsRoutes.js — API de Relatorios Financeiros, Contas a Pagar (despesas)
 * e Comissao/Repasse medico. Monta em /api/finance.
 *
 * Paginas de permissao usadas:
 *  - 'financeiro.despesas'   -> CRUD de despesas/contas a pagar
 *  - 'financeiro.relatorios' -> visualizacao de relatorios, dashboard e comissoes
 *
 * A EDICAO do percentual de comissao de um medico e restrita ao PROPRIETARIO
 * da clinica (checagem direta no banco, nao depende de checkbox de permissao)
 * -- pedido explicito: "esse cadastro de porcentagem so pode ser feito pelo owner".
 */
const express = require('express');
const { query } = require('../config/database');
const { requireDoctorOrReceptionist, getStaffPermission } = require('../middleware/auth');
const { getClinicOwner } = require('../services/cashierService');
const socketService = require('../services/socketService');

const router = express.Router();

const EXPENSE_CATEGORIES = ['ALUGUEL', 'FORNECEDORES', 'SALARIOS', 'IMPOSTOS', 'MARKETING', 'EQUIPAMENTOS', 'MANUTENCAO', 'OUTROS'];
const EXPENSE_PAYMENT_METHODS = ['DINHEIRO', 'CARTAO_DEBITO', 'CARTAO_CREDITO', 'PIX', 'TRANSFERENCIA', 'BOLETO'];

function actorType(user) {
  return user.role === 'DOCTOR' ? 'doctor' : 'receptionist';
}

function requireFinancePermission(pageCode, action) {
  return async (req, res, next) => {
    try {
      const perm = await getStaffPermission(req.user, pageCode);
      const allowed =
        (action === 'view' && perm.can_view) ||
        (action === 'create' && perm.can_create) ||
        (action === 'update' && perm.can_update) ||
        (action === 'delete' && perm.can_delete);
      if (!allowed) {
        return res.status(403).json({ error: `Sem permissao para ${action} nesta area financeira.` });
      }
      return next();
    } catch (_err) {
      return res.status(403).json({ error: 'Permissao nao concedida.' });
    }
  };
}

// Bloqueia qualquer coisa que nao seja o proprietario da clinica logado como medico.
async function requireOwner(req, res, next) {
  try {
    if (req.user.role !== 'DOCTOR') {
      return res.status(403).json({ error: 'Somente o proprietario da clinica pode fazer isso.' });
    }
    const owner = await getClinicOwner(req.user.clinicId);
    if (!owner || owner.id !== req.user.id) {
      return res.status(403).json({ error: 'Somente o proprietario da clinica pode fazer isso.' });
    }
    return next();
  } catch (_err) {
    return res.status(403).json({ error: 'Nao foi possivel confirmar que voce e o proprietario da clinica.' });
  }
}

function normalizeAmount(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(num) || num < 0) return false;
  return Math.round(num * 100) / 100;
}

function normalizePercentage(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(num) || num < 0 || num > 100) return false;
  return Math.round(num * 100) / 100;
}

// Retorna { from, to } (strings YYYY-MM-DD) a partir de query params, com fallback
// para o mes corrente.
function resolveMonthRange(monthParam) {
  let year, month;
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    [year, month] = monthParam.split('-').map(Number);
  } else {
    const now = new Date();
    year = now.getUTCFullYear();
    month = now.getUTCMonth() + 1;
  }
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const toDate = new Date(Date.UTC(year, month, 0));
  const to = toDate.toISOString().slice(0, 10);
  return { from, to, year, month };
}

function shiftMonth(year, month, delta) {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

// Soma N meses a uma data (aceita Date do pg ou string 'YYYY-MM-DD'), mantendo
// o dia do mes quando possivel e "grudando" no ultimo dia do mes de destino
// quando o dia original nao existir nele (ex.: 31/01 + 1 mes -> 28/02 ou
// 29/02, nunca vaza pra marco como aconteceria com due_date + INTERVAL '1 month'
// direto no Postgres).
function addMonthsClampedUTC(due, months) {
  const iso = typeof due === 'string' ? due : due.toISOString().slice(0, 10);
  const [y, m, d] = iso.split('-').map(Number);
  const targetIndex = (m - 1) + months;
  const targetYear = y + Math.floor(targetIndex / 12);
  const targetMonth0 = ((targetIndex % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth0 + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDayOfTargetMonth);
  return new Date(Date.UTC(targetYear, targetMonth0, day)).toISOString().slice(0, 10);
}

// Quantos meses a frente uma despesa marcada como recorrente fica projetada
// nos relatorios (Contas a Pagar, Projecao, Dashboard) a partir de quando ela
// e criada/editada/paga. Rolando a cada pagamento, o horizonte nunca acaba.
const RECURRING_HORIZON_MONTHS = 12;

/**
 * Garante que existam ocorrencias PENDING da despesa recorrente `baseExpense`
 * para os proximos `horizonMonths` meses a partir do seu due_date (nao
 * inclui o due_date do proprio baseExpense, so os seguintes). Idempotente:
 * pula qualquer mes que ja tenha uma despesa com a mesma descricao+data
 * (mesma checagem de duplicata ja usada no fluxo de pagamento).
 *
 * Isso e o que faz uma despesa marcada como "mensal" realmente aparecer nos
 * relatorios dos proximos meses — antes, "is_recurring" so ficava salvo no
 * banco sem nada gerar a proxima ocorrencia automaticamente ao criar/editar.
 */
async function ensureFutureRecurringOccurrences(baseExpense, clinicId, actorTypeVal, actorId, horizonMonths = RECURRING_HORIZON_MONTHS) {
  const created = [];
  for (let i = 1; i <= horizonMonths; i += 1) {
    const nextDueDate = addMonthsClampedUTC(baseExpense.due_date, i);
    const duplicate = await query(
      `SELECT id FROM expenses
        WHERE clinic_id = $1 AND description = $2 AND due_date = $3 AND status != 'CANCELED'
        LIMIT 1`,
      [clinicId, baseExpense.description, nextDueDate]
    );
    if (duplicate.rowCount > 0) continue; // ja existe (gerada antes, ou editada manualmente) — nao duplica

    const insertedNext = await query(
      `INSERT INTO expenses (clinic_id, description, category, supplier_name, amount, due_date, is_recurring, notes, created_by_type, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9)
       RETURNING *`,
      [
        clinicId,
        baseExpense.description,
        baseExpense.category,
        baseExpense.supplier_name,
        baseExpense.amount,
        nextDueDate,
        baseExpense.notes,
        actorTypeVal,
        actorId,
      ]
    );
    created.push(insertedNext.rows[0]);
  }
  if (created.length > 0) {
    socketService.emitToClinic(clinicId, 'expenses_projected', { count: created.length, description: baseExpense.description });
  }
  return created;
}

// ═══════════════════════════════════════════════════════════════
// DESPESAS / CONTAS A PAGAR
// ═══════════════════════════════════════════════════════════════
router.get('/expenses', requireDoctorOrReceptionist, requireFinancePermission('financeiro.despesas', 'view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { status, category, from, to } = req.query;
    const values = [clinicId];
    const where = ['clinic_id = $1'];

    if (status && status.toUpperCase() !== 'ALL') {
      values.push(status.toUpperCase());
      where.push(`status = $${values.length}`);
    }
    if (category) {
      values.push(category.toUpperCase());
      where.push(`category = $${values.length}`);
    }
    if (from) {
      values.push(from);
      where.push(`due_date >= $${values.length}`);
    }
    if (to) {
      values.push(to);
      where.push(`due_date <= $${values.length}`);
    }

    const result = await query(
      `SELECT * FROM expenses WHERE ${where.join(' AND ')} ORDER BY due_date ASC`,
      values
    );
    return res.json(result.rows);
  } catch (err) {
    return next(err);
  }
});

router.post('/expenses', requireDoctorOrReceptionist, requireFinancePermission('financeiro.despesas', 'create'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { description, category, supplierName, amount, dueDate, isRecurring, notes } = req.body;

    if (!description || !description.trim()) {
      return res.status(400).json({ error: 'Informe a descricao da despesa.' });
    }
    const normalizedCategory = (category || 'OUTROS').toUpperCase();
    if (!EXPENSE_CATEGORIES.includes(normalizedCategory)) {
      return res.status(400).json({ error: 'Categoria invalida.' });
    }
    const normalizedAmount = normalizeAmount(amount);
    if (!normalizedAmount) {
      return res.status(400).json({ error: 'Informe um valor valido maior que zero.' });
    }
    if (!dueDate) {
      return res.status(400).json({ error: 'Informe a data de vencimento.' });
    }

    const inserted = await query(
      `INSERT INTO expenses (clinic_id, description, category, supplier_name, amount, due_date, is_recurring, notes, created_by_type, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [clinicId, description.trim(), normalizedCategory, supplierName || null, normalizedAmount, dueDate, Boolean(isRecurring), notes || null, actorType(req.user), req.user.id]
    );
    socketService.emitToClinic(clinicId, 'expense_created', { expense: inserted.rows[0] });

    let projectedOccurrences = [];
    if (inserted.rows[0].is_recurring) {
      projectedOccurrences = await ensureFutureRecurringOccurrences(inserted.rows[0], clinicId, actorType(req.user), req.user.id);
    }

    return res.status(201).json({ ...inserted.rows[0], projectedOccurrences });
  } catch (err) {
    return next(err);
  }
});

router.put('/expenses/:id', requireDoctorOrReceptionist, requireFinancePermission('financeiro.despesas', 'update'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { id } = req.params;
    const { description, category, supplierName, amount, dueDate, isRecurring, notes } = req.body;

    const existing = await query(`SELECT * FROM expenses WHERE id = $1 AND clinic_id = $2 LIMIT 1`, [id, clinicId]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Despesa nao encontrada.' });
    if (existing.rows[0].status !== 'PENDING') {
      return res.status(409).json({ error: 'Somente despesas pendentes podem ser editadas.' });
    }

    let normalizedCategory = null;
    if (category) {
      normalizedCategory = category.toUpperCase();
      if (!EXPENSE_CATEGORIES.includes(normalizedCategory)) {
        return res.status(400).json({ error: 'Categoria invalida.' });
      }
    }
    const normalizedAmount = amount !== undefined ? normalizeAmount(amount) : null;
    if (normalizedAmount === false) return res.status(400).json({ error: 'Valor invalido.' });

    const updated = await query(
      `UPDATE expenses SET
         description = COALESCE($1, description),
         category = COALESCE($2, category),
         supplier_name = COALESCE($3, supplier_name),
         amount = COALESCE($4, amount),
         due_date = COALESCE($5, due_date),
         is_recurring = COALESCE($6, is_recurring),
         notes = COALESCE($7, notes)
       WHERE id = $8
       RETURNING *`,
      [
        description ? description.trim() : null,
        normalizedCategory,
        supplierName ?? null,
        normalizedAmount,
        dueDate || null,
        isRecurring != null ? Boolean(isRecurring) : null,
        notes ?? null,
        id,
      ]
    );
    socketService.emitToClinic(clinicId, 'expense_updated', { expense: updated.rows[0] });

    let projectedOccurrences = [];
    if (updated.rows[0].is_recurring) {
      projectedOccurrences = await ensureFutureRecurringOccurrences(updated.rows[0], clinicId, actorType(req.user), req.user.id);
    }

    return res.json({ ...updated.rows[0], projectedOccurrences });
  } catch (err) {
    return next(err);
  }
});

router.post('/expenses/:id/pay', requireDoctorOrReceptionist, requireFinancePermission('financeiro.despesas', 'update'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { id } = req.params;
    const { paymentMethod, paidAmount } = req.body;

    if (paymentMethod && !EXPENSE_PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ error: 'Forma de pagamento invalida.' });
    }

    const existing = await query(`SELECT * FROM expenses WHERE id = $1 AND clinic_id = $2 LIMIT 1`, [id, clinicId]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Despesa nao encontrada.' });
    if (existing.rows[0].status !== 'PENDING') {
      return res.status(409).json({ error: 'Esta despesa ja foi paga ou cancelada.' });
    }

    const normalizedPaidAmount = paidAmount !== undefined ? normalizeAmount(paidAmount) : null;
    if (normalizedPaidAmount === false) return res.status(400).json({ error: 'Valor pago invalido.' });

    const updated = await query(
      `UPDATE expenses SET
         status = 'PAID',
         paid_at = now(),
         payment_method = COALESCE($1, payment_method),
         amount = COALESCE($2, amount)
       WHERE id = $3
       RETURNING *`,
      [paymentMethod || null, normalizedPaidAmount, id]
    );
    socketService.emitToClinic(clinicId, 'expense_paid', { expense: updated.rows[0] });

    // Despesa recorrente (mensal): garante que as proximas ocorrencias
    // existam como PENDING, para ela continuar aparecendo nos relatorios
    // (Contas a Pagar, Projecao, Dashboard) nos proximos ciclos. Isso e um
    // reforco/rolagem do horizonte — a geracao principal ja acontece na
    // criacao/edicao da despesa (ver ensureFutureRecurringOccurrences).
    let nextOccurrences = [];
    if (existing.rows[0].is_recurring) {
      nextOccurrences = await ensureFutureRecurringOccurrences(updated.rows[0], clinicId, actorType(req.user), req.user.id);
    }

    return res.json({ ...updated.rows[0], nextOccurrence: nextOccurrences[0] || null, nextOccurrences });
  } catch (err) {
    return next(err);
  }
});

router.post('/expenses/:id/cancel', requireDoctorOrReceptionist, requireFinancePermission('financeiro.despesas', 'delete'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { id } = req.params;
    const existing = await query(`SELECT * FROM expenses WHERE id = $1 AND clinic_id = $2 LIMIT 1`, [id, clinicId]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Despesa nao encontrada.' });
    if (existing.rows[0].status !== 'PENDING') {
      return res.status(409).json({ error: 'Somente despesas pendentes podem ser canceladas.' });
    }
    const updated = await query(`UPDATE expenses SET status = 'CANCELED' WHERE id = $1 RETURNING *`, [id]);
    socketService.emitToClinic(clinicId, 'expense_canceled', { expense: updated.rows[0] });
    return res.json(updated.rows[0]);
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// COMISSAO / REPASSE MEDICO
// ═══════════════════════════════════════════════════════════════
router.get('/commission-rates', requireDoctorOrReceptionist, requireFinancePermission('financeiro.relatorios', 'view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const result = await query(
      `SELECT d.id, d.name, d.commission_percentage
         FROM clinic_members cm
         JOIN doctors d ON d.id = cm.member_id
        WHERE cm.clinic_id = $1 AND cm.member_type = 'doctor' AND cm.active = true
        ORDER BY d.name ASC`,
      [clinicId]
    );
    return res.json(result.rows);
  } catch (err) {
    return next(err);
  }
});

// Somente o proprietario da clinica pode definir o percentual de comissao.
router.put('/commission-rates/:doctorId', requireDoctorOrReceptionist, requireOwner, async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { doctorId } = req.params;
    const { commissionPercentage } = req.body;

    const normalized = normalizePercentage(commissionPercentage);
    if (normalized === false) {
      return res.status(400).json({ error: 'Percentual invalido. Use um valor entre 0 e 100.' });
    }

    const member = await query(
      `SELECT 1 FROM clinic_members WHERE clinic_id = $1 AND member_id = $2 AND member_type = 'doctor' AND active = true`,
      [clinicId, doctorId]
    );
    if (member.rowCount === 0) {
      return res.status(404).json({ error: 'Medico nao encontrado nesta clinica.' });
    }

    const updated = await query(
      `UPDATE doctors SET commission_percentage = $1 WHERE id = $2 RETURNING id, name, commission_percentage`,
      [normalized, doctorId]
    );
    return res.json(updated.rows[0]);
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// DASHBOARD FINANCEIRO
// ═══════════════════════════════════════════════════════════════
router.get('/reports/dashboard', requireDoctorOrReceptionist, requireFinancePermission('financeiro.relatorios', 'view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { from, to, year, month } = resolveMonthRange(req.query.month);
    const prev = shiftMonth(year, month, -1);
    const { from: prevFrom, to: prevTo } = resolveMonthRange(`${prev.year}-${String(prev.month).padStart(2, '0')}`);

    const revenueRes = await query(
      `SELECT COALESCE(SUM(amount - discount_amount), 0) AS total, COUNT(DISTINCT patient_id)::int AS patients
         FROM cash_transactions
        WHERE clinic_id = $1 AND status = 'PAID' AND paid_at::date BETWEEN $2 AND $3`,
      [clinicId, from, to]
    );
    const prevRevenueRes = await query(
      `SELECT COALESCE(SUM(amount - discount_amount), 0) AS total
         FROM cash_transactions
        WHERE clinic_id = $1 AND status = 'PAID' AND paid_at::date BETWEEN $2 AND $3`,
      [clinicId, prevFrom, prevTo]
    );
    const expensesRes = await query(
      `SELECT COALESCE(SUM(amount), 0) AS total
         FROM expenses
        WHERE clinic_id = $1 AND status = 'PAID' AND paid_at::date BETWEEN $2 AND $3`,
      [clinicId, from, to]
    );
    const pendingReceivablesRes = await query(
      `SELECT COALESCE(SUM(amount - discount_amount), 0) AS total, COUNT(*)::int AS count
         FROM cash_transactions WHERE clinic_id = $1 AND status = 'PENDING'`,
      [clinicId]
    );
    const pendingPayablesRes = await query(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*)::int AS count
         FROM expenses WHERE clinic_id = $1 AND status = 'PENDING'`,
      [clinicId]
    );
    // Pelas pernas de pagamento — um recebimento MISTO conta em cada forma usada.
    const paymentMethodRes = await query(
      `SELECT ctp.payment_method, COALESCE(SUM(ctp.amount), 0) AS total
         FROM cash_transaction_payments ctp
         JOIN cash_transactions ct ON ct.id = ctp.transaction_id
        WHERE ct.clinic_id = $1 AND ct.status = 'PAID' AND ct.paid_at::date BETWEEN $2 AND $3
        GROUP BY ctp.payment_method`,
      [clinicId, from, to]
    );
    const topProceduresRes = await query(
      `SELECT COALESCE(pt.name, ct.description) AS name, COALESCE(SUM(ct.amount - ct.discount_amount), 0) AS total, COUNT(*)::int AS count
         FROM cash_transactions ct
         LEFT JOIN procedure_types pt ON pt.id = ct.procedure_type_id
        WHERE ct.clinic_id = $1 AND ct.status = 'PAID' AND ct.paid_at::date BETWEEN $2 AND $3
        GROUP BY COALESCE(pt.name, ct.description)
        ORDER BY total DESC
        LIMIT 5`,
      [clinicId, from, to]
    );
    const topDoctorsRes = await query(
      `SELECT d.name, COALESCE(SUM(ct.amount - ct.discount_amount), 0) AS total, COUNT(*)::int AS count
         FROM cash_transactions ct
         JOIN doctors d ON d.id = ct.doctor_id
        WHERE ct.clinic_id = $1 AND ct.status = 'PAID' AND ct.paid_at::date BETWEEN $2 AND $3
        GROUP BY d.name
        ORDER BY total DESC
        LIMIT 5`,
      [clinicId, from, to]
    );

    // Tendencia dos ultimos 6 meses (receita x despesa)
    const trend = [];
    for (let i = 5; i >= 0; i--) {
      const m = shiftMonth(year, month, -i);
      const range = resolveMonthRange(`${m.year}-${String(m.month).padStart(2, '0')}`);
      const [rev, exp] = await Promise.all([
        query(
          `SELECT COALESCE(SUM(amount - discount_amount), 0) AS total FROM cash_transactions
            WHERE clinic_id = $1 AND status = 'PAID' AND paid_at::date BETWEEN $2 AND $3`,
          [clinicId, range.from, range.to]
        ),
        query(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
            WHERE clinic_id = $1 AND status = 'PAID' AND paid_at::date BETWEEN $2 AND $3`,
          [clinicId, range.from, range.to]
        ),
      ]);
      trend.push({
        month: `${m.year}-${String(m.month).padStart(2, '0')}`,
        revenue: Number(rev.rows[0].total),
        expenses: Number(exp.rows[0].total),
      });
    }

    const upcomingExpensesRes = await query(
      `SELECT id, description, amount, due_date, category
         FROM expenses
        WHERE clinic_id = $1 AND status = 'PENDING' AND due_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '7 days')
        ORDER BY due_date ASC
        LIMIT 10`,
      [clinicId]
    );
    const overduePatientsRes = await query(
      `SELECT p.id, p.name, COALESCE(SUM(ct.amount - ct.discount_amount), 0) AS total, COUNT(*)::int AS charges,
              MAX(EXTRACT(DAY FROM now() - ct.created_at))::int AS oldest_days
         FROM cash_transactions ct
         JOIN patients p ON p.id = ct.patient_id
        WHERE ct.clinic_id = $1 AND ct.status = 'PENDING' AND ct.created_at < now() - INTERVAL '7 days'
        GROUP BY p.id, p.name
        ORDER BY total DESC
        LIMIT 5`,
      [clinicId]
    );

    const revenue = Number(revenueRes.rows[0].total);
    const prevRevenue = Number(prevRevenueRes.rows[0].total);
    const expensesTotal = Number(expensesRes.rows[0].total);
    const patients = revenueRes.rows[0].patients;

    return res.json({
      period: { from, to },
      kpis: {
        revenue,
        prevRevenue,
        revenueChangePct: prevRevenue > 0 ? Math.round(((revenue - prevRevenue) / prevRevenue) * 10000) / 100 : null,
        expenses: expensesTotal,
        netProfit: revenue - expensesTotal,
        averageTicket: patients > 0 ? Math.round((revenue / patients) * 100) / 100 : 0,
        pendingReceivables: Number(pendingReceivablesRes.rows[0].total),
        pendingReceivablesCount: pendingReceivablesRes.rows[0].count,
        pendingPayables: Number(pendingPayablesRes.rows[0].total),
        pendingPayablesCount: pendingPayablesRes.rows[0].count,
      },
      revenueByPaymentMethod: paymentMethodRes.rows.map((r) => ({ method: r.payment_method, total: Number(r.total) })),
      topProcedures: topProceduresRes.rows.map((r) => ({ name: r.name, total: Number(r.total), count: r.count })),
      topDoctors: topDoctorsRes.rows.map((r) => ({ name: r.name, total: Number(r.total), count: r.count })),
      trend,
      upcomingExpenses: upcomingExpensesRes.rows,
      overduePatients: overduePatientsRes.rows.map((r) => ({ id: r.id, name: r.name, total: Number(r.total), charges: r.charges, oldestDays: r.oldest_days })),
    });
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// DRE (Demonstracao do Resultado do Exercicio)
// ═══════════════════════════════════════════════════════════════
router.get('/reports/dre', requireDoctorOrReceptionist, requireFinancePermission('financeiro.relatorios', 'view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { from, to, year, month } = resolveMonthRange(req.query.month);
    const prev = shiftMonth(year, month, -1);
    const prevRange = resolveMonthRange(`${prev.year}-${String(prev.month).padStart(2, '0')}`);

    const revenueRes = await query(
      `SELECT COALESCE(SUM(amount - discount_amount), 0) AS total
         FROM cash_transactions WHERE clinic_id = $1 AND status = 'PAID' AND paid_at::date BETWEEN $2 AND $3`,
      [clinicId, from, to]
    );
    const insuranceRevenueRes = await query(
      `SELECT COALESCE(SUM(ic.total_paid), 0) AS total
         FROM insurance_claims ic
         JOIN insurance_billing_batches b ON b.id = ic.batch_id
        WHERE ic.clinic_id = $1 AND b.returned_at::date BETWEEN $2 AND $3`,
      [clinicId, from, to]
    );
    const expensesByCategoryRes = await query(
      `SELECT category, COALESCE(SUM(amount), 0) AS total
         FROM expenses WHERE clinic_id = $1 AND status = 'PAID' AND paid_at::date BETWEEN $2 AND $3
        GROUP BY category`,
      [clinicId, from, to]
    );
    const prevRevenueRes = await query(
      `SELECT COALESCE(SUM(amount - discount_amount), 0) AS total
         FROM cash_transactions WHERE clinic_id = $1 AND status = 'PAID' AND paid_at::date BETWEEN $2 AND $3`,
      [clinicId, prevRange.from, prevRange.to]
    );
    const prevInsuranceRevenueRes = await query(
      `SELECT COALESCE(SUM(ic.total_paid), 0) AS total
         FROM insurance_claims ic
         JOIN insurance_billing_batches b ON b.id = ic.batch_id
        WHERE ic.clinic_id = $1 AND b.returned_at::date BETWEEN $2 AND $3`,
      [clinicId, prevRange.from, prevRange.to]
    );
    const prevExpensesRes = await query(
      `SELECT COALESCE(SUM(amount), 0) AS total
         FROM expenses WHERE clinic_id = $1 AND status = 'PAID' AND paid_at::date BETWEEN $2 AND $3`,
      [clinicId, prevRange.from, prevRange.to]
    );

    const particularRevenue = Number(revenueRes.rows[0].total);
    const insuranceRevenue = Number(insuranceRevenueRes.rows[0].total);
    const revenue = particularRevenue + insuranceRevenue;
    const expensesByCategory = {};
    let totalExpenses = 0;
    expensesByCategoryRes.rows.forEach((r) => { expensesByCategory[r.category] = Number(r.total); totalExpenses += Number(r.total); });
    const prevParticularRevenue = Number(prevRevenueRes.rows[0].total);
    const prevInsuranceRevenue = Number(prevInsuranceRevenueRes.rows[0].total);
    const prevRevenue = prevParticularRevenue + prevInsuranceRevenue;
    const prevExpenses = Number(prevExpensesRes.rows[0].total);

    return res.json({
      period: { from, to },
      grossRevenue: revenue,
      revenueBySource: { particular: particularRevenue, convenio: insuranceRevenue },
      expensesByCategory,
      totalExpenses,
      netProfit: revenue - totalExpenses,
      previousPeriod: {
        grossRevenue: prevRevenue,
        revenueBySource: { particular: prevParticularRevenue, convenio: prevInsuranceRevenue },
        totalExpenses: prevExpenses,
        netProfit: prevRevenue - prevExpenses,
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// FLUXO DE CAIXA REALIZADO
// ═══════════════════════════════════════════════════════════════
router.get('/reports/cashflow', requireDoctorOrReceptionist, requireFinancePermission('financeiro.relatorios', 'view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const from = req.query.from || (() => {
      const d = new Date(to); d.setDate(d.getDate() - 29); return d.toISOString().slice(0, 10);
    })();

    const inflowRes = await query(
      `SELECT paid_at::date AS day, COALESCE(SUM(amount - discount_amount), 0) AS total
         FROM cash_transactions
        WHERE clinic_id = $1 AND status = 'PAID' AND paid_at::date BETWEEN $2 AND $3
        GROUP BY paid_at::date`,
      [clinicId, from, to]
    );
    const outflowRes = await query(
      `SELECT paid_at::date AS day, COALESCE(SUM(amount), 0) AS total
         FROM expenses
        WHERE clinic_id = $1 AND status = 'PAID' AND paid_at::date BETWEEN $2 AND $3
        GROUP BY paid_at::date`,
      [clinicId, from, to]
    );

    const inflowByDay = {};
    inflowRes.rows.forEach((r) => { inflowByDay[r.day.toISOString().slice(0, 10)] = Number(r.total); });
    const outflowByDay = {};
    outflowRes.rows.forEach((r) => { outflowByDay[r.day.toISOString().slice(0, 10)] = Number(r.total); });

    const days = [];
    let cursor = new Date(from);
    const end = new Date(to);
    let runningBalance = 0;
    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 10);
      const inflow = inflowByDay[key] || 0;
      const outflow = outflowByDay[key] || 0;
      runningBalance += inflow - outflow;
      days.push({ date: key, inflow, outflow, net: inflow - outflow, balance: runningBalance });
      cursor.setDate(cursor.getDate() + 1);
    }

    const totalInflow = days.reduce((acc, d) => acc + d.inflow, 0);
    const totalOutflow = days.reduce((acc, d) => acc + d.outflow, 0);

    return res.json({ period: { from, to }, days, totals: { inflow: totalInflow, outflow: totalOutflow, net: totalInflow - totalOutflow } });
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// PROJECAO DE FLUXO DE CAIXA
// ═══════════════════════════════════════════════════════════════
router.get('/reports/cashflow-projection', requireDoctorOrReceptionist, requireFinancePermission('financeiro.relatorios', 'view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const days = Math.min(parseInt(req.query.days, 10) || 30, 90);

    const pendingReceivablesRes = await query(
      `SELECT COALESCE(SUM(amount - discount_amount), 0) AS total FROM cash_transactions WHERE clinic_id = $1 AND status = 'PENDING'`,
      [clinicId]
    );
    const upcomingExpensesRes = await query(
      `SELECT id, description, category, amount, due_date
         FROM expenses
        WHERE clinic_id = $1 AND status = 'PENDING' AND due_date <= (CURRENT_DATE + ($2 || ' days')::interval)
        ORDER BY due_date ASC`,
      [clinicId, String(days)]
    );

    // Aproxima o "caixa atual" pelo historico: tudo que ja entrou menos tudo que ja saiu.
    const historicalRes = await query(
      `SELECT
         (SELECT COALESCE(SUM(amount - discount_amount), 0) FROM cash_transactions WHERE clinic_id = $1 AND status = 'PAID') AS revenue,
         (SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE clinic_id = $1 AND status = 'PAID') AS expenses`,
      [clinicId]
    );

    const approxCurrentBalance = Number(historicalRes.rows[0].revenue) - Number(historicalRes.rows[0].expenses);
    const pendingReceivables = Number(pendingReceivablesRes.rows[0].total);
    const upcomingExpensesTotal = upcomingExpensesRes.rows.reduce((acc, e) => acc + Number(e.amount), 0);

    // Agrupa despesas futuras por semana
    const byWeek = {};
    upcomingExpensesRes.rows.forEach((e) => {
      const d = new Date(e.due_date);
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      const key = weekStart.toISOString().slice(0, 10);
      byWeek[key] = (byWeek[key] || 0) + Number(e.amount);
    });

    return res.json({
      horizonDays: days,
      approxCurrentBalance,
      pendingReceivables,
      upcomingExpensesTotal,
      projectedBalance: approxCurrentBalance + pendingReceivables - upcomingExpensesTotal,
      upcomingExpenses: upcomingExpensesRes.rows,
      upcomingExpensesByWeek: Object.entries(byWeek).map(([week, total]) => ({ week, total })).sort((a, b) => a.week.localeCompare(b.week)),
    });
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// CONTAS A PAGAR E A RECEBER (AGING)
// ═══════════════════════════════════════════════════════════════
router.get('/reports/accounts', requireDoctorOrReceptionist, requireFinancePermission('financeiro.relatorios', 'view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;

    const payablesRes = await query(
      `SELECT id, description, supplier_name, category, amount, due_date, is_recurring,
              CASE
                WHEN due_date < CURRENT_DATE THEN 'OVERDUE'
                WHEN due_date <= CURRENT_DATE + INTERVAL '7 days' THEN 'DUE_0_7'
                WHEN due_date <= CURRENT_DATE + INTERVAL '30 days' THEN 'DUE_8_30'
                ELSE 'DUE_30_PLUS'
              END AS bucket
         FROM expenses
        WHERE clinic_id = $1 AND status = 'PENDING'
        ORDER BY due_date ASC`,
      [clinicId]
    );
    const receivablesRes = await query(
      `SELECT ct.id, ct.description, p.name AS patient_name, (ct.amount - ct.discount_amount) AS amount, ct.created_at,
              CASE
                WHEN ct.created_at >= now() - INTERVAL '7 days' THEN 'AGE_0_7'
                WHEN ct.created_at >= now() - INTERVAL '30 days' THEN 'AGE_8_30'
                ELSE 'AGE_30_PLUS'
              END AS bucket
         FROM cash_transactions ct
         JOIN patients p ON p.id = ct.patient_id
        WHERE ct.clinic_id = $1 AND ct.status = 'PENDING'
        ORDER BY ct.created_at ASC`,
      [clinicId]
    );
    const insuranceReceivablesRes = await query(
      `SELECT ic.id, ic.total_value, ic.status, ic.issued_at, o.name AS operator_name, p.name AS patient_name,
              CASE
                WHEN ic.issued_at >= now() - INTERVAL '30 days' THEN 'AGE_0_30'
                WHEN ic.issued_at >= now() - INTERVAL '60 days' THEN 'AGE_31_60'
                WHEN ic.issued_at >= now() - INTERVAL '90 days' THEN 'AGE_61_90'
                ELSE 'AGE_90_PLUS'
              END AS bucket
         FROM insurance_claims ic
         JOIN patient_insurance pi ON pi.id = ic.patient_insurance_id
         JOIN patients p ON p.id = pi.patient_id
         JOIN clinic_insurance_contracts c ON c.id = pi.contract_id
         JOIN insurance_operators o ON o.id = c.operator_id
        WHERE ic.clinic_id = $1 AND ic.status IN ('EMITIDA','ENVIADA')
        ORDER BY ic.issued_at ASC`,
      [clinicId]
    );

    const payableBuckets = { OVERDUE: 0, DUE_0_7: 0, DUE_8_30: 0, DUE_30_PLUS: 0 };
    payablesRes.rows.forEach((r) => { payableBuckets[r.bucket] += Number(r.amount); });
    const receivableBuckets = { AGE_0_7: 0, AGE_8_30: 0, AGE_30_PLUS: 0 };
    receivablesRes.rows.forEach((r) => { receivableBuckets[r.bucket] += Number(r.amount); });
    const insuranceReceivableBuckets = { AGE_0_30: 0, AGE_31_60: 0, AGE_61_90: 0, AGE_90_PLUS: 0 };
    insuranceReceivablesRes.rows.forEach((r) => { insuranceReceivableBuckets[r.bucket] += Number(r.total_value); });

    return res.json({
      payables: { items: payablesRes.rows, buckets: payableBuckets, total: payablesRes.rows.reduce((a, r) => a + Number(r.amount), 0) },
      receivables: { items: receivablesRes.rows, buckets: receivableBuckets, total: receivablesRes.rows.reduce((a, r) => a + Number(r.amount), 0) },
      insuranceReceivables: {
        items: insuranceReceivablesRes.rows,
        buckets: insuranceReceivableBuckets,
        total: insuranceReceivablesRes.rows.reduce((a, r) => a + Number(r.total_value), 0),
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// INADIMPLENCIA (pacientes com pendencias antigas)
// ═══════════════════════════════════════════════════════════════
router.get('/reports/overdue-patients', requireDoctorOrReceptionist, requireFinancePermission('financeiro.relatorios', 'view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const minDays = Math.max(parseInt(req.query.minDays, 10) || 7, 0);

    const result = await query(
      `SELECT p.id, p.name, p.phone,
              COALESCE(SUM(ct.amount - ct.discount_amount), 0) AS total,
              COUNT(*)::int AS charges,
              MAX(EXTRACT(DAY FROM now() - ct.created_at))::int AS oldest_days
         FROM cash_transactions ct
         JOIN patients p ON p.id = ct.patient_id
        WHERE ct.clinic_id = $1 AND ct.status = 'PENDING'
          AND ct.created_at < now() - ($2 || ' days')::interval
        GROUP BY p.id, p.name, p.phone
        ORDER BY total DESC`,
      [clinicId, String(minDays)]
    );

    return res.json(result.rows.map((r) => ({
      id: r.id, name: r.name, phone: r.phone, total: Number(r.total), charges: r.charges, oldestDays: r.oldest_days,
    })));
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// CAIXA POR FORMA DE PAGAMENTO
// ═══════════════════════════════════════════════════════════════
router.get('/reports/payment-methods', requireDoctorOrReceptionist, requireFinancePermission('financeiro.relatorios', 'view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const from = req.query.from || (() => {
      const d = new Date(to); d.setDate(d.getDate() - 29); return d.toISOString().slice(0, 10);
    })();

    // Soma pelas PERNAS de pagamento (cash_transaction_payments), nao pelo
    // payment_method direto da transacao — um recebimento dividido em mais
    // de uma forma (MISTO, no caixa em estilo PDV) precisa contar em cada
    // forma que ele efetivamente usou.
    const result = await query(
      `SELECT ctp.payment_method, COALESCE(SUM(ctp.amount), 0) AS total, COUNT(*)::int AS count
         FROM cash_transaction_payments ctp
         JOIN cash_transactions ct ON ct.id = ctp.transaction_id
        WHERE ct.clinic_id = $1 AND ct.status = 'PAID' AND ct.paid_at::date BETWEEN $2 AND $3
        GROUP BY ctp.payment_method
        ORDER BY total DESC`,
      [clinicId, from, to]
    );
    const grandTotal = result.rows.reduce((acc, r) => acc + Number(r.total), 0);

    return res.json({
      period: { from, to },
      methods: result.rows.map((r) => ({
        method: r.payment_method,
        total: Number(r.total),
        count: r.count,
        percentage: grandTotal > 0 ? Math.round((Number(r.total) / grandTotal) * 10000) / 100 : 0,
      })),
      grandTotal,
    });
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// TICKET MEDIO (por paciente e por procedimento)
// ═══════════════════════════════════════════════════════════════
router.get('/reports/average-ticket', requireDoctorOrReceptionist, requireFinancePermission('financeiro.relatorios', 'view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const from = req.query.from || (() => {
      const d = new Date(to); d.setDate(d.getDate() - 29); return d.toISOString().slice(0, 10);
    })();

    const overallRes = await query(
      `SELECT COALESCE(SUM(amount - discount_amount), 0) AS total, COUNT(DISTINCT patient_id)::int AS patients, COUNT(*)::int AS charges
         FROM cash_transactions
        WHERE clinic_id = $1 AND status = 'PAID' AND paid_at::date BETWEEN $2 AND $3`,
      [clinicId, from, to]
    );
    const byProcedureRes = await query(
      `SELECT COALESCE(pt.name, ct.description) AS name, AVG(ct.amount - ct.discount_amount) AS avg_amount, COUNT(*)::int AS count
         FROM cash_transactions ct
         LEFT JOIN procedure_types pt ON pt.id = ct.procedure_type_id
        WHERE ct.clinic_id = $1 AND ct.status = 'PAID' AND ct.paid_at::date BETWEEN $2 AND $3
        GROUP BY COALESCE(pt.name, ct.description)
        ORDER BY avg_amount DESC`,
      [clinicId, from, to]
    );

    const total = Number(overallRes.rows[0].total);
    const patients = overallRes.rows[0].patients;

    return res.json({
      period: { from, to },
      overallAverage: patients > 0 ? Math.round((total / patients) * 100) / 100 : 0,
      totalRevenue: total,
      totalPatients: patients,
      totalCharges: overallRes.rows[0].charges,
      byProcedure: byProcedureRes.rows.map((r) => ({ name: r.name, average: Math.round(Number(r.avg_amount) * 100) / 100, count: r.count })),
    });
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// REPASSE MEDICO / COMISSIONAMENTO
// ═══════════════════════════════════════════════════════════════
router.get('/reports/commissions', requireDoctorOrReceptionist, requireFinancePermission('financeiro.relatorios', 'view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const from = req.query.from || (() => {
      const d = new Date(to); d.setDate(d.getDate() - 29); return d.toISOString().slice(0, 10);
    })();

    const result = await query(
      `SELECT d.id, d.name, d.commission_percentage,
              COALESCE(SUM(ct.amount - ct.discount_amount), 0) AS total_revenue,
              COUNT(ct.id)::int AS charges
         FROM clinic_members cm
         JOIN doctors d ON d.id = cm.member_id
         LEFT JOIN cash_transactions ct ON ct.doctor_id = d.id AND ct.clinic_id = cm.clinic_id
              AND ct.status = 'PAID' AND ct.paid_at::date BETWEEN $2 AND $3
        WHERE cm.clinic_id = $1 AND cm.member_type = 'doctor' AND cm.active = true
        GROUP BY d.id, d.name, d.commission_percentage
        ORDER BY total_revenue DESC`,
      [clinicId, from, to]
    );

    return res.json({
      period: { from, to },
      doctors: result.rows.map((r) => {
        const pct = r.commission_percentage != null ? Number(r.commission_percentage) : null;
        const revenue = Number(r.total_revenue);
        return {
          id: r.id,
          name: r.name,
          commissionPercentage: pct,
          totalRevenue: revenue,
          charges: r.charges,
          commissionAmount: pct != null ? Math.round(revenue * (pct / 100) * 100) / 100 : null,
        };
      }),
    });
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// LUCRATIVIDADE (por procedimento / profissional / especialidade)
// ═══════════════════════════════════════════════════════════════
// Custo direto considerado aqui = repasse/comissao do medico sobre o valor
// recebido (% cadastrado em doctors.commission_percentage). A clinica ainda
// nao controla baixa de insumo por atendimento (modulo de estoque), entao
// esse custo NAO entra na conta — deixamos isso explicito na resposta
// (`costBasis`) pra nao dar a falsa impressao de que a margem ja inclui
// material usado no procedimento.
router.get('/reports/profitability', requireDoctorOrReceptionist, requireFinancePermission('financeiro.relatorios', 'view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const from = req.query.from || (() => {
      const d = new Date(to); d.setDate(d.getDate() - 29); return d.toISOString().slice(0, 10);
    })();
    const groupBy = ['procedure', 'doctor', 'specialty'].includes(req.query.groupBy) ? req.query.groupBy : 'procedure';

    let groupExpr, nameExpr;
    if (groupBy === 'doctor') {
      groupExpr = 'd.id, d.name';
      nameExpr = "COALESCE(d.name, 'Sem profissional')";
    } else if (groupBy === 'specialty') {
      groupExpr = 'COALESCE(d.specialty, $4)';
      nameExpr = 'COALESCE(d.specialty, $4)';
    } else {
      groupExpr = 'COALESCE(pt.name, ct.description)';
      nameExpr = 'COALESCE(pt.name, ct.description)';
    }

    const values = [clinicId, from, to];
    if (groupBy === 'specialty') values.push('Não informada');

    const result = await query(
      `SELECT ${nameExpr} AS name,
              COUNT(*)::int AS count,
              COALESCE(SUM(ct.amount - ct.discount_amount), 0) AS revenue,
              COALESCE(SUM((ct.amount - ct.discount_amount) * COALESCE(d.commission_percentage, 0) / 100), 0) AS commission_cost
         FROM cash_transactions ct
         LEFT JOIN procedure_types pt ON pt.id = ct.procedure_type_id
         LEFT JOIN doctors d ON d.id = ct.doctor_id
        WHERE ct.clinic_id = $1 AND ct.status = 'PAID' AND ct.paid_at::date BETWEEN $2 AND $3
        GROUP BY ${groupExpr}
        ORDER BY revenue DESC`,
      values
    );

    const rows = result.rows.map((r) => {
      const revenue = Number(r.revenue);
      const cost = Number(r.commission_cost);
      const margin = Math.round((revenue - cost) * 100) / 100;
      return {
        name: r.name,
        count: r.count,
        revenue,
        cost,
        margin,
        marginPct: revenue > 0 ? Math.round((margin / revenue) * 10000) / 100 : 0,
      };
    });
    const totals = rows.reduce((acc, r) => ({ revenue: acc.revenue + r.revenue, cost: acc.cost + r.cost, margin: acc.margin + r.margin }), { revenue: 0, cost: 0, margin: 0 });

    return res.json({
      period: { from, to },
      groupBy,
      costBasis: 'Custo direto = repasse/comissão médica sobre o valor recebido. Não inclui insumos/materiais (sem controle de estoque vinculado ao atendimento ainda).',
      rows,
      totals: { ...totals, marginPct: totals.revenue > 0 ? Math.round((totals.margin / totals.revenue) * 10000) / 100 : 0 },
    });
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// EVOLUCAO DE RECEITA (serie historica particular x convenio)
// ═══════════════════════════════════════════════════════════════
router.get('/reports/revenue-evolution', requireDoctorOrReceptionist, requireFinancePermission('financeiro.relatorios', 'view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const granularity = ['day', 'week', 'month'].includes(req.query.granularity) ? req.query.granularity : 'month';
    const periods = Math.min(parseInt(req.query.periods, 10) || (granularity === 'month' ? 12 : 12), 36);

    // Janela de tempo a partir de hoje, voltando N periodos (usa date_trunc
    // pra alinhar no inicio de cada mes/semana/dia).
    const intervalUnit = granularity === 'day' ? 'days' : granularity === 'week' ? 'weeks' : 'months';

    // Soma pelas PERNAS de pagamento — assim um recebimento MISTO (ex.: parte
    // particular, parte convenio, no mesmo atendimento) e contado corretamente
    // em cada lado, em vez de cair todo num unico "MISTO" sem sentido aqui.
    const result = await query(
      `SELECT date_trunc('${granularity}', ct.paid_at) AS period,
              COALESCE(SUM(CASE WHEN ctp.payment_method = 'CONVENIO' THEN ctp.amount ELSE 0 END), 0) AS convenio,
              COALESCE(SUM(CASE WHEN ctp.payment_method != 'CONVENIO' THEN ctp.amount ELSE 0 END), 0) AS particular
         FROM cash_transaction_payments ctp
         JOIN cash_transactions ct ON ct.id = ctp.transaction_id
        WHERE ct.clinic_id = $1 AND ct.status = 'PAID'
          AND ct.paid_at >= date_trunc('${granularity}', now()) - ($2 || ' ${intervalUnit}')::interval
        GROUP BY period
        ORDER BY period ASC`,
      [clinicId, String(periods - 1)]
    );

    const rows = result.rows.map((r) => ({
      period: r.period,
      particular: Number(r.particular),
      convenio: Number(r.convenio),
      total: Number(r.particular) + Number(r.convenio),
    }));
    for (let i = 0; i < rows.length; i += 1) {
      const prevTotal = i > 0 ? rows[i - 1].total : null;
      rows[i].changePct = prevTotal ? Math.round(((rows[i].total - prevTotal) / prevTotal) * 10000) / 100 : null;
    }

    return res.json({ granularity, rows });
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// PACIENTES — ranking (quem mais gastou / ticket medio), inativos e
// aniversariantes do mes
// ═══════════════════════════════════════════════════════════════
router.get('/reports/patients-ranking', requireDoctorOrReceptionist, requireFinancePermission('financeiro.relatorios', 'view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const from = req.query.from || (() => {
      const d = new Date(to); d.setDate(d.getDate() - 364); return d.toISOString().slice(0, 10);
    })();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const result = await query(
      `SELECT p.id, p.name, p.phone,
              COUNT(*)::int AS charges,
              COALESCE(SUM(ct.amount - ct.discount_amount), 0) AS total,
              MAX(ct.paid_at) AS last_visit
         FROM cash_transactions ct
         JOIN patients p ON p.id = ct.patient_id
        WHERE ct.clinic_id = $1 AND ct.status = 'PAID' AND ct.paid_at::date BETWEEN $2 AND $3
        GROUP BY p.id, p.name, p.phone
        ORDER BY total DESC
        LIMIT $4`,
      [clinicId, from, to, limit]
    );

    return res.json({
      period: { from, to },
      patients: result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        charges: r.charges,
        total: Number(r.total),
        averageTicket: Math.round((Number(r.total) / r.charges) * 100) / 100,
        lastVisit: r.last_visit,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/reports/patients-inactive', requireDoctorOrReceptionist, requireFinancePermission('financeiro.relatorios', 'view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const minDays = Math.max(parseInt(req.query.days, 10) || 90, 1);

    // "Ultima visita" = ultimo pagamento recebido (cash_transactions PAID).
    // Paciente sem NENHUM pagamento registrado tambem entra (nunca voltou
    // depois do cadastro), com dias em aberto contados a partir do cadastro.
    const result = await query(
      `SELECT p.id, p.name, p.phone, p.created_at,
              MAX(ct.paid_at) AS last_visit
         FROM patients p
         LEFT JOIN cash_transactions ct ON ct.patient_id = p.id AND ct.status = 'PAID'
        WHERE (p.clinic_id = $1 OR p.clinic_id IS NULL)
        GROUP BY p.id, p.name, p.phone, p.created_at
       HAVING COALESCE(MAX(ct.paid_at), p.created_at) < now() - ($2 || ' days')::interval
        ORDER BY COALESCE(MAX(ct.paid_at), p.created_at) ASC
        LIMIT 200`,
      [clinicId, String(minDays)]
    );

    return res.json({
      minDays,
      patients: result.rows.map((r) => {
        const reference = r.last_visit || r.created_at;
        const daysInactive = Math.floor((Date.now() - new Date(reference).getTime()) / 86400000);
        return { id: r.id, name: r.name, phone: r.phone, lastVisit: r.last_visit, daysInactive };
      }),
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/reports/patients-birthdays', requireDoctorOrReceptionist, requireFinancePermission('financeiro.relatorios', 'view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const month = Math.min(Math.max(parseInt(req.query.month, 10) || (new Date().getMonth() + 1), 1), 12);

    const result = await query(
      `SELECT id, name, phone, birth_date
         FROM patients
        WHERE (clinic_id = $1 OR clinic_id IS NULL)
          AND birth_date IS NOT NULL
          AND EXTRACT(MONTH FROM birth_date) = $2
        ORDER BY EXTRACT(DAY FROM birth_date) ASC`,
      [clinicId, month]
    );

    return res.json({
      month,
      patients: result.rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, birthDate: r.birth_date })),
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
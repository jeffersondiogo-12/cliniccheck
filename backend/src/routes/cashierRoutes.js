/**
 * cashierRoutes.js — API do modulo Financeiro / Caixa.
 * Acessivel tanto por medicos quanto por recepcionistas da clinica
 * (controle fino de visualizar/criar/editar/excluir via clinic_member_permissions,
 * pagina 'financeiro.caixa').
 */
const express = require('express');
const PDFDocument = require('pdfkit');
const { query } = require('../config/database');
const { requireDoctorOrReceptionist, getStaffPermission } = require('../middleware/auth');
const { verifyOwnerCredentials } = require('../services/cashierService');
const socketService = require('../services/socketService');

const router = express.Router();

const PAGE_CODE = 'financeiro.caixa';
const PAYMENT_METHODS = ['DINHEIRO', 'CARTAO_DEBITO', 'CARTAO_CREDITO', 'PIX', 'CONVENIO'];

function actorType(user) {
  return user.role === 'DOCTOR' ? 'doctor' : 'receptionist';
}

function requireCaixaPermission(action) {
  return async (req, res, next) => {
    try {
      const perm = await getStaffPermission(req.user, PAGE_CODE);
      const allowed =
        (action === 'view' && perm.can_view) ||
        (action === 'create' && perm.can_create) ||
        (action === 'update' && perm.can_update) ||
        (action === 'delete' && perm.can_delete);
      if (!allowed) {
        return res.status(403).json({ error: `Sem permissao para ${action} no Caixa.` });
      }
      req.caixaPerm = perm;
      return next();
    } catch (_err) {
      return res.status(403).json({ error: 'Permissao nao concedida.' });
    }
  };
}

function normalizeAmount(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(num) || num < 0) return false;
  return Math.round(num * 100) / 100;
}

// Soma recebimentos por forma de pagamento "de verdade" — a partir das
// PERNAS de cada recebimento (cash_transaction_payments), nao do campo
// cash_transactions.payment_method direto. Isso importa porque, desde que o
// caixa passou a aceitar recebimento dividido em mais de uma forma (ex.:
// metade dinheiro, metade Pix, como em um PDV), o payment_method da
// transacao pode estar como 'MISTO' — quem tem o valor certo por forma sao
// as linhas em cash_transaction_payments (uma por perna).
// `extraWhereOnCt` referencia o alias `ct` (cash_transactions) e pode usar
// os placeholders de `params` a partir de $1.
async function sumPaidLegsByMethod(extraWhereOnCt, params) {
  const result = await query(
    `SELECT ctp.payment_method, COALESCE(SUM(ctp.amount), 0) AS amount, COUNT(*)::int AS legs
       FROM cash_transaction_payments ctp
       JOIN cash_transactions ct ON ct.id = ctp.transaction_id
      WHERE ct.status = 'PAID' AND ${extraWhereOnCt}
      GROUP BY ctp.payment_method`,
    params
  );
  return result.rows;
}

async function getOpenSession(clinicId) {
  const res = await query(
    `SELECT cs.*, COALESCE(d.name, r.name) AS opened_by_name
       FROM cash_sessions cs
       LEFT JOIN doctors d ON cs.opened_by_type = 'doctor' AND d.id = cs.opened_by_id
       LEFT JOIN receptionists r ON cs.opened_by_type = 'receptionist' AND r.id = cs.opened_by_id
      WHERE cs.clinic_id = $1 AND cs.status = 'OPEN'
      LIMIT 1`,
    [clinicId]
  );
  return res.rows[0] || null;
}

async function getClinicDoctorIds(clinicId) {
  const res = await query(
    `SELECT member_id FROM clinic_members
      WHERE clinic_id = $1 AND member_type = 'doctor' AND active = true`,
    [clinicId]
  );
  return res.rows.map((r) => r.member_id);
}

// ─────────────────────────────────────────────────────────────
// TIPOS DE PROCEDIMENTO (leitura, para o modal de novo lançamento)
// ─────────────────────────────────────────────────────────────
router.get('/procedure-types', requireDoctorOrReceptionist, requireCaixaPermission('view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const result = await query(
      `SELECT pt.id, pt.name, pt.category, pt.price, pt.estimated_duration_min, pt.doctor_id
         FROM procedure_types pt
        WHERE pt.active = true
          AND (
            pt.doctor_id IS NULL
            OR pt.doctor_id IN (
              SELECT cm.member_id FROM clinic_members cm
               WHERE cm.clinic_id = $1 AND cm.member_type = 'doctor' AND cm.active = true
            )
          )
        ORDER BY pt.name ASC`,
      [clinicId]
    );
    return res.json(result.rows);
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────
// SESSÃO DE CAIXA (abertura / fechamento)
// ─────────────────────────────────────────────────────────────
router.get('/session/current', requireDoctorOrReceptionist, requireCaixaPermission('view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const session = await getOpenSession(clinicId);

    const pendingRes = await query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount - discount_amount), 0) AS amount
         FROM cash_transactions
        WHERE clinic_id = $1 AND status = 'PENDING'`,
      [clinicId]
    );

    let paidByMethod = {};
    let paidTotal = 0;
    let totalSangrias = 0;
    let totalAportes = 0;
    if (session) {
      const paidLegs = await sumPaidLegsByMethod('ct.cash_session_id = $1', [session.id]);
      paidLegs.forEach((r) => { paidByMethod[r.payment_method] = Number(r.amount); });
      paidTotal = paidLegs.reduce((acc, r) => acc + Number(r.amount), 0);

      const movementsRes = await query(
        `SELECT type, COALESCE(SUM(amount), 0) AS amount
           FROM cash_movements
          WHERE cash_session_id = $1
          GROUP BY type`,
        [session.id]
      );
      movementsRes.rows.forEach((r) => {
        if (r.type === 'SANGRIA') totalSangrias = Number(r.amount);
        if (r.type === 'APORTE') totalAportes = Number(r.amount);
      });
    }

    return res.json({
      session,
      totals: {
        pendingCount: pendingRes.rows[0].count,
        pendingAmount: Number(pendingRes.rows[0].amount),
        paidTotal,
        paidByMethod,
        totalSangrias,
        totalAportes,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/sessions', requireDoctorOrReceptionist, requireCaixaPermission('view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const result = await query(
      `SELECT cs.*, COALESCE(d.name, r.name) AS opened_by_name,
              COALESCE(d2.name, r2.name) AS closed_by_name
         FROM cash_sessions cs
         LEFT JOIN doctors d ON cs.opened_by_type = 'doctor' AND d.id = cs.opened_by_id
         LEFT JOIN receptionists r ON cs.opened_by_type = 'receptionist' AND r.id = cs.opened_by_id
         LEFT JOIN doctors d2 ON cs.closed_by_type = 'doctor' AND d2.id = cs.closed_by_id
         LEFT JOIN receptionists r2 ON cs.closed_by_type = 'receptionist' AND r2.id = cs.closed_by_id
        WHERE cs.clinic_id = $1
        ORDER BY cs.opened_at DESC
        LIMIT $2 OFFSET $3`,
      [clinicId, limit, offset]
    );
    return res.json(result.rows);
  } catch (err) {
    return next(err);
  }
});

router.get('/sessions/:id', requireDoctorOrReceptionist, requireCaixaPermission('view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { id } = req.params;
    const sessionRes = await query(
      `SELECT cs.*, COALESCE(d.name, r.name) AS opened_by_name,
              COALESCE(d2.name, r2.name) AS closed_by_name
         FROM cash_sessions cs
         LEFT JOIN doctors d ON cs.opened_by_type = 'doctor' AND d.id = cs.opened_by_id
         LEFT JOIN receptionists r ON cs.opened_by_type = 'receptionist' AND r.id = cs.opened_by_id
         LEFT JOIN doctors d2 ON cs.closed_by_type = 'doctor' AND d2.id = cs.closed_by_id
         LEFT JOIN receptionists r2 ON cs.closed_by_type = 'receptionist' AND r2.id = cs.closed_by_id
        WHERE cs.id = $1 AND cs.clinic_id = $2
        LIMIT 1`,
      [id, clinicId]
    );
    if (sessionRes.rowCount === 0) return res.status(404).json({ error: 'Sessao de caixa nao encontrada.' });

    const txRes = await query(
      `SELECT ct.*, p.name AS patient_name, d.name AS doctor_name
         FROM cash_transactions ct
         JOIN patients p ON p.id = ct.patient_id
         LEFT JOIN doctors d ON d.id = ct.doctor_id
        WHERE ct.cash_session_id = $1
        ORDER BY ct.paid_at ASC`,
      [id]
    );

    return res.json({ session: sessionRes.rows[0], transactions: txRes.rows });
  } catch (err) {
    return next(err);
  }
});

router.post('/session/open', requireDoctorOrReceptionist, requireCaixaPermission('create'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const existing = await getOpenSession(clinicId);
    if (existing) {
      return res.status(409).json({ error: 'Ja existe um caixa aberto para esta clinica.' });
    }

    const openingAmount = normalizeAmount(req.body?.openingAmount ?? 0);
    if (openingAmount === false) {
      return res.status(400).json({ error: 'Valor de abertura invalido.' });
    }

    const inserted = await query(
      `INSERT INTO cash_sessions (clinic_id, opening_amount, opened_by_type, opened_by_id)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [clinicId, openingAmount || 0, actorType(req.user), req.user.id]
    );

    socketService.emitToClinic(clinicId, 'cash_session_opened', { session: inserted.rows[0] });
    return res.status(201).json(inserted.rows[0]);
  } catch (err) {
    return next(err);
  }
});

router.post('/session/:id/close', requireDoctorOrReceptionist, requireCaixaPermission('update'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { id } = req.params;

    const sessionRes = await query(
      `SELECT * FROM cash_sessions WHERE id = $1 AND clinic_id = $2 LIMIT 1`,
      [id, clinicId]
    );
    const session = sessionRes.rows[0];
    if (!session) return res.status(404).json({ error: 'Sessao de caixa nao encontrada.' });
    if (session.status !== 'OPEN') return res.status(409).json({ error: 'Esta sessao de caixa ja foi fechada.' });

    // Conferencia por forma de pagamento e sempre obrigatoria pra fechar —
    // o front sempre mostra a tela de conferencia antes de chegar aqui,
    // entao esperamos um valor conferido pra cada forma que teve movimento.
    const conferredByMethod = req.body?.conferredByMethod;
    if (!conferredByMethod || typeof conferredByMethod !== 'object') {
      return res.status(400).json({ error: 'Informe o valor conferido de cada forma de pagamento para fechar o caixa.' });
    }

    // Usa as pernas de pagamento (cash_transaction_payments), nao o campo
    // payment_method direto — um recebimento MISTO (varias formas em um so
    // atendimento) precisa entrar na conta de CADA forma que ele usou, senao
    // a conferencia de dinheiro/cartao/pix ficaria errada.
    const totalsRes = await sumPaidLegsByMethod('ct.cash_session_id = $1', [id]);
    const systemByMethod = {};
    totalsRes.forEach((r) => { systemByMethod[r.payment_method] = Number(r.amount); });

    const movementsRes = await query(
      `SELECT type, COALESCE(SUM(amount), 0) AS amount
         FROM cash_movements
        WHERE cash_session_id = $1
        GROUP BY type`,
      [id]
    );
    const movementsByType = {};
    movementsRes.rows.forEach((r) => { movementsByType[r.type] = Number(r.amount); });
    const totalSangrias = movementsByType.SANGRIA || 0;
    const totalAportes = movementsByType.APORTE || 0;

    // Dinheiro conta com o fundo de abertura + sangrias/aportes; as demais
    // formas (cartao, pix, convenio...) sao conferidas contra maquininha,
    // extrato, etc. — sem fundo de abertura, so o que entrou na sessao.
    const methodsToReconcile = new Set(['DINHEIRO', ...Object.keys(systemByMethod)]);
    const byMethod = {};
    let hasMissingValue = false;
    methodsToReconcile.forEach((method) => {
      const system = method === 'DINHEIRO'
        ? Number(session.opening_amount) + (systemByMethod.DINHEIRO || 0) + totalAportes - totalSangrias
        : (systemByMethod[method] || 0);
      const conferredRaw = conferredByMethod[method];
      const conferred = normalizeAmount(conferredRaw);
      if (conferred === false || conferred === null) { hasMissingValue = true; return; }
      byMethod[method] = { system, conferred, difference: Math.round((conferred - system) * 100) / 100 };
    });
    if (hasMissingValue) {
      return res.status(400).json({ error: 'Informe o valor conferido de todas as formas de pagamento listadas.' });
    }

    // Fotografia de quanto ainda estava em aberto (a receber) no momento do
    // fechamento — mantém o histórico de inadimplência mesmo sem vincular a
    // pendência a uma sessão específica.
    const pendingSnapshotRes = await query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount - discount_amount), 0) AS total
         FROM cash_transactions WHERE clinic_id = $1 AND status = 'PENDING'`,
      [clinicId]
    );
    const pendingAtClose = {
      count: Number(pendingSnapshotRes.rows[0].count),
      total: Number(pendingSnapshotRes.rows[0].total),
    };

    const cashEntry = byMethod.DINHEIRO || { system: 0, conferred: 0, difference: 0 };

    const updated = await query(
      `UPDATE cash_sessions SET
         status = 'CLOSED',
         closing_amount_informed = $1,
         closing_expected_cash = $2,
         closing_difference = $3,
         closing_totals_json = $4,
         closing_notes = $5,
         closed_by_type = $6,
         closed_by_id = $7,
         closed_at = now()
       WHERE id = $8
       RETURNING *`,
      [
        cashEntry.conferred,
        cashEntry.system,
        cashEntry.difference,
        JSON.stringify({ byMethod, movements: { sangria: totalSangrias, aporte: totalAportes }, pendingAtClose }),
        req.body?.notes || null,
        actorType(req.user),
        req.user.id,
        id,
      ]
    );

    socketService.emitToClinic(clinicId, 'cash_session_closed', { session: updated.rows[0] });
    return res.json(updated.rows[0]);
  } catch (err) {
    return next(err);
  }
});

// Conferencia de recebimentos de uma sessao: tudo que foi efetivamente
// recebido (deu baixa), agrupado por forma de pagamento, e o que ainda
// esta em aberto — usado na tela de aviso antes de fechar o caixa com
// recebimento pendente.
router.get('/session/:id/reconciliation', requireDoctorOrReceptionist, requireCaixaPermission('view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { id } = req.params;

    const sessionRes = await query(`SELECT id FROM cash_sessions WHERE id = $1 AND clinic_id = $2 LIMIT 1`, [id, clinicId]);
    if (sessionRes.rowCount === 0) return res.status(404).json({ error: 'Sessao de caixa nao encontrada.' });

    const receivedRes = await query(
      `SELECT ct.id, ct.description, ct.payment_method, (ct.amount - ct.discount_amount) AS amount,
              ct.paid_at, p.name AS patient_name,
              COALESCE((
                SELECT json_agg(json_build_object('method', ctp.payment_method, 'amount', ctp.amount) ORDER BY ctp.created_at)
                  FROM cash_transaction_payments ctp WHERE ctp.transaction_id = ct.id
              ), '[]') AS payments
         FROM cash_transactions ct
         JOIN patients p ON p.id = ct.patient_id
        WHERE ct.cash_session_id = $1 AND ct.status = 'PAID'
        ORDER BY ct.paid_at ASC`,
      [id]
    );
    const pendingRes = await query(
      `SELECT ct.id, ct.description, (ct.amount - ct.discount_amount) AS amount, p.name AS patient_name
         FROM cash_transactions ct
         JOIN patients p ON p.id = ct.patient_id
        WHERE ct.clinic_id = $1 AND ct.status = 'PENDING'
        ORDER BY ct.created_at ASC`,
      [clinicId]
    );

    // Pernas de pagamento (nao o payment_method direto) — um recebimento
    // MISTO precisa contar em cada forma que ele efetivamente usou.
    const totalsLegs = await sumPaidLegsByMethod('ct.cash_session_id = $1', [id]);
    const totalsByMethod = {};
    totalsLegs.forEach((r) => { totalsByMethod[r.payment_method] = Number(r.amount); });

    return res.json({
      received: {
        items: receivedRes.rows.map((r) => ({ ...r, amount: Number(r.amount) })),
        totalsByMethod,
        total: receivedRes.rows.reduce((a, r) => a + Number(r.amount), 0),
      },
      pending: {
        items: pendingRes.rows.map((r) => ({ ...r, amount: Number(r.amount) })),
        total: pendingRes.rows.reduce((a, r) => a + Number(r.amount), 0),
      },
    });
  } catch (err) {
    return next(err);
  }
});

const METHOD_LABEL = {
  DINHEIRO: 'Dinheiro', CARTAO_DEBITO: 'Cartão Débito', CARTAO_CREDITO: 'Cartão Crédito',
  PIX: 'Pix', CONVENIO: 'Convênio', TRANSFERENCIA: 'Transferência', BOLETO: 'Boleto',
};
const fmtBRL = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDT = (v) => (v ? new Date(v).toLocaleString('pt-BR') : '—');

async function fetchSessionWithNames(id, clinicId) {
  const result = await query(
    `SELECT cs.*, cl.name AS clinic_name, COALESCE(d.name, r.name) AS opened_by_name,
            COALESCE(d2.name, r2.name) AS closed_by_name
       FROM cash_sessions cs
       JOIN clinics cl ON cl.id = cs.clinic_id
       LEFT JOIN doctors d ON cs.opened_by_type = 'doctor' AND d.id = cs.opened_by_id
       LEFT JOIN receptionists r ON cs.opened_by_type = 'receptionist' AND r.id = cs.opened_by_id
       LEFT JOIN doctors d2 ON cs.closed_by_type = 'doctor' AND d2.id = cs.closed_by_id
       LEFT JOIN receptionists r2 ON cs.closed_by_type = 'receptionist' AND r2.id = cs.closed_by_id
      WHERE cs.id = $1 AND cs.clinic_id = $2
      LIMIT 1`,
    [id, clinicId]
  );
  return result.rows[0] || null;
}

function pdfHeader(doc, clinicName, title) {
  doc.fontSize(16).font('Helvetica-Bold').text(clinicName || 'Clinic Chek', { align: 'center' });
  doc.fontSize(12).font('Helvetica').text(title, { align: 'center' });
  doc.moveDown(0.3);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#cbd5e1').stroke();
  doc.moveDown(1);
}
function pdfRow(doc, label, value, opts = {}) {
  const y = doc.y;
  doc.font('Helvetica').fontSize(10).fillColor('#475569').text(label, doc.page.margins.left, y, { continued: false });
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor('#0f172a')
    .text(value, doc.page.margins.left, y, { align: 'right', width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
  doc.moveDown(0.6);
}

// Comprovante de ABERTURA de caixa (PDF) — pra imprimir/guardar junto com o
// fundo de troco físico.
router.get('/session/:id/comprovante-abertura', requireDoctorOrReceptionist, requireCaixaPermission('view'), async (req, res, next) => {
  try {
    const session = await fetchSessionWithNames(req.params.id, req.user.clinicId);
    if (!session) return res.status(404).json({ error: 'Sessao de caixa nao encontrada.' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="comprovante-abertura-${session.id.slice(0, 8)}.pdf"`);
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    doc.pipe(res);

    pdfHeader(doc, session.clinic_name, 'Comprovante de Abertura de Caixa');
    pdfRow(doc, 'Sessão', session.id);
    pdfRow(doc, 'Aberto em', fmtDT(session.opened_at));
    pdfRow(doc, 'Aberto por', session.opened_by_name || '—');
    doc.moveDown(0.5);
    pdfRow(doc, 'Valor de abertura (fundo de troco)', fmtBRL(session.opening_amount), { bold: true });
    doc.moveDown(2);
    doc.fontSize(9).fillColor('#94a3b8').text('Gerado automaticamente pelo Clinic Chek em ' + fmtDT(new Date()), { align: 'center' });
    doc.end();
  } catch (err) { return next(err); }
});

// Comprovante de FECHAMENTO de caixa (PDF) — a conferencia completa por
// forma de pagamento, pendencias e diferencas.
router.get('/session/:id/comprovante-fechamento', requireDoctorOrReceptionist, requireCaixaPermission('view'), async (req, res, next) => {
  try {
    const session = await fetchSessionWithNames(req.params.id, req.user.clinicId);
    if (!session) return res.status(404).json({ error: 'Sessao de caixa nao encontrada.' });
    if (session.status !== 'CLOSED') return res.status(409).json({ error: 'Esta sessao ainda nao foi fechada.' });

    const totals = session.closing_totals_json || {};
    const byMethod = totals.byMethod || {};
    const movements = totals.movements || { sangria: 0, aporte: 0 };
    const pendingAtClose = totals.pendingAtClose || { count: 0, total: 0 };

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="comprovante-fechamento-${session.id.slice(0, 8)}.pdf"`);
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    doc.pipe(res);

    pdfHeader(doc, session.clinic_name, 'Comprovante de Fechamento de Caixa');
    pdfRow(doc, 'Sessão', session.id);
    pdfRow(doc, 'Aberto em', `${fmtDT(session.opened_at)} — por ${session.opened_by_name || '—'}`);
    pdfRow(doc, 'Fechado em', `${fmtDT(session.closed_at)} — por ${session.closed_by_name || '—'}`);
    doc.moveDown(0.5);

    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text('Conferência por forma de pagamento');
    doc.moveDown(0.3);
    const colX = [doc.page.margins.left, 230, 340, 450];
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#475569');
    doc.text('Forma', colX[0], doc.y, { width: 170, continued: false });
    doc.text('Sistema', colX[1], doc.y - doc.currentLineHeight(), { width: 100, align: 'right' });
    doc.text('Conferido', colX[2], doc.y - doc.currentLineHeight(), { width: 100, align: 'right' });
    doc.text('Diferença', colX[3], doc.y - doc.currentLineHeight(), { width: 90, align: 'right' });
    doc.moveDown(0.5);
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#e2e8f0').stroke();
    doc.moveDown(0.3);

    Object.entries(byMethod).forEach(([method, v]) => {
      const rowY = doc.y;
      const diffColor = Math.abs(v.difference) < 0.01 ? '#0f172a' : (v.difference < 0 ? '#dc2626' : '#d97706');
      doc.font('Helvetica').fontSize(9).fillColor('#0f172a').text(METHOD_LABEL[method] || method, colX[0], rowY, { width: 170 });
      doc.text(fmtBRL(v.system), colX[1], rowY, { width: 100, align: 'right' });
      doc.text(fmtBRL(v.conferred), colX[2], rowY, { width: 100, align: 'right' });
      doc.fillColor(diffColor).text(fmtBRL(v.difference), colX[3], rowY, { width: 90, align: 'right' });
      doc.moveDown(0.6);
    });

    doc.moveDown(0.8);
    if (movements.sangria) pdfRow(doc, 'Total de sangrias (retiradas)', `- ${fmtBRL(movements.sangria)}`);
    if (movements.aporte) pdfRow(doc, 'Total de aportes (reforços)', fmtBRL(movements.aporte));

    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(pendingAtClose.total > 0 ? '#d97706' : '#0f172a')
      .text(`Em aberto no fechamento: ${pendingAtClose.count} conta(s), ${fmtBRL(pendingAtClose.total)}`);
    if (pendingAtClose.total > 0) {
      doc.font('Helvetica').fontSize(9).fillColor('#64748b')
        .text('Esses valores continuam como a receber e passam a contar para inadimplência se não forem pagos.');
    }

    if (session.closing_notes) {
      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text('Observações');
      doc.font('Helvetica').fontSize(9).fillColor('#475569').text(session.closing_notes);
    }

    doc.moveDown(2);
    doc.fontSize(9).fillColor('#94a3b8').text('Gerado automaticamente pelo Clinic Chek em ' + fmtDT(new Date()), { align: 'center' });
    doc.end();
  } catch (err) { return next(err); }
});

// ─────────────────────────────────────────────────────────────
// SANGRIA E APORTE (movimentações avulsas dentro de uma sessão aberta)
// ─────────────────────────────────────────────────────────────
router.get('/session/:id/movements', requireDoctorOrReceptionist, requireCaixaPermission('view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { id } = req.params;
    const result = await query(
      `SELECT cm.*, COALESCE(d.name, r.name) AS created_by_name
         FROM cash_movements cm
         LEFT JOIN doctors d ON cm.created_by_type = 'doctor' AND d.id = cm.created_by_id
         LEFT JOIN receptionists r ON cm.created_by_type = 'receptionist' AND r.id = cm.created_by_id
        WHERE cm.cash_session_id = $1 AND cm.clinic_id = $2
        ORDER BY cm.created_at DESC`,
      [id, clinicId]
    );
    return res.json(result.rows);
  } catch (err) {
    return next(err);
  }
});

router.post('/session/:id/movements', requireDoctorOrReceptionist, requireCaixaPermission('create'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { id } = req.params;
    const { type, amount, reason } = req.body;

    if (!['SANGRIA', 'APORTE'].includes(type)) {
      return res.status(400).json({ error: 'Tipo de movimentacao invalido (use SANGRIA ou APORTE).' });
    }
    const normalizedAmount = normalizeAmount(amount);
    if (!normalizedAmount || normalizedAmount <= 0) {
      return res.status(400).json({ error: 'Informe um valor maior que zero.' });
    }

    const sessionRes = await query(
      `SELECT * FROM cash_sessions WHERE id = $1 AND clinic_id = $2 AND status = 'OPEN' LIMIT 1`,
      [id, clinicId]
    );
    if (sessionRes.rowCount === 0) {
      return res.status(409).json({ error: 'Esta sessao de caixa nao esta aberta.' });
    }

    const inserted = await query(
      `INSERT INTO cash_movements (clinic_id, cash_session_id, type, amount, reason, created_by_type, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [clinicId, id, type, normalizedAmount, reason || null, actorType(req.user), req.user.id]
    );

    socketService.emitToClinic(clinicId, 'cash_movement_created', { movement: inserted.rows[0] });
    return res.status(201).json(inserted.rows[0]);
  } catch (err) {
    return next(err);
  }
});

// ─────────────────────────────────────────────────────────────
// LANÇAMENTOS (COBRANÇAS)
// ─────────────────────────────────────────────────────────────
router.get('/transactions', requireDoctorOrReceptionist, requireCaixaPermission('view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { status, patientId, sessionId, search } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const values = [clinicId];
    const where = ['ct.clinic_id = $1'];

    const normalizedStatus = String(status || 'PENDING').toUpperCase();
    if (normalizedStatus !== 'ALL') {
      values.push(normalizedStatus);
      where.push(`ct.status = $${values.length}`);
    }
    if (patientId) {
      values.push(patientId);
      where.push(`ct.patient_id = $${values.length}`);
    }
    if (sessionId) {
      values.push(sessionId);
      where.push(`ct.cash_session_id = $${values.length}`);
    }
    if (search && search.trim()) {
      values.push(`%${search.trim()}%`);
      where.push(`p.name ILIKE $${values.length}`);
    }

    values.push(limit);

    const result = await query(
      `SELECT ct.*, p.name AS patient_name, p.phone AS patient_phone,
              d.name AS doctor_name, pt.name AS procedure_type_name,
              COALESCE((
                SELECT json_agg(json_build_object('method', ctp.payment_method, 'amount', ctp.amount) ORDER BY ctp.created_at)
                  FROM cash_transaction_payments ctp WHERE ctp.transaction_id = ct.id
              ), '[]') AS payments
         FROM cash_transactions ct
         JOIN patients p ON p.id = ct.patient_id
         LEFT JOIN doctors d ON d.id = ct.doctor_id
         LEFT JOIN procedure_types pt ON pt.id = ct.procedure_type_id
        WHERE ${where.join(' AND ')}
        ORDER BY ct.created_at DESC
        LIMIT $${values.length}`,
      values
    );
    return res.json(result.rows);
  } catch (err) {
    return next(err);
  }
});

router.post('/transactions', requireDoctorOrReceptionist, requireCaixaPermission('create'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const {
      patientId,
      doctorId,
      procedureTypeId,
      description,
      amount,
      discountAmount,
      notes,
      ownerEmail,
      ownerPassword,
    } = req.body;

    if (!patientId) {
      return res.status(400).json({ error: 'Selecione o paciente.' });
    }

    // Autorizacao extra: lancamento manual exige e-mail e senha do proprietario da clinica.
    const auth = await verifyOwnerCredentials(clinicId, ownerEmail, ownerPassword);
    if (!auth.ok) {
      return res.status(403).json({ error: auth.error });
    }

    const patientRes = await query(
      `SELECT id FROM patients WHERE id = $1 AND (clinic_id = $2 OR clinic_id IS NULL) LIMIT 1`,
      [patientId, clinicId]
    );
    if (patientRes.rowCount === 0) {
      return res.status(404).json({ error: 'Paciente nao encontrado nesta clinica.' });
    }

    if (doctorId) {
      const doctorIds = await getClinicDoctorIds(clinicId);
      if (!doctorIds.includes(doctorId)) {
        return res.status(400).json({ error: 'Medico invalido para esta clinica.' });
      }
    }

    let finalDescription = description ? String(description).trim() : null;
    let finalAmount = normalizeAmount(amount);
    if (finalAmount === false) {
      return res.status(400).json({ error: 'Valor invalido. Informe um numero maior ou igual a zero.' });
    }

    let resolvedProcedureTypeId = null;
    if (procedureTypeId) {
      const typeRes = await query(
        `SELECT id, name, price FROM procedure_types WHERE id = $1 AND active = true LIMIT 1`,
        [procedureTypeId]
      );
      if (typeRes.rowCount === 0) {
        return res.status(400).json({ error: 'Tipo de procedimento invalido.' });
      }
      resolvedProcedureTypeId = typeRes.rows[0].id;
      if (!finalDescription) finalDescription = typeRes.rows[0].name;
      if (finalAmount === null) finalAmount = Number(typeRes.rows[0].price || 0);
    }

    if (!finalDescription) {
      return res.status(400).json({ error: 'Informe uma descricao ou selecione um tipo de procedimento.' });
    }
    if (finalAmount === null) {
      return res.status(400).json({ error: 'Informe o valor da cobranca (o tipo de procedimento selecionado nao tem preco cadastrado).' });
    }

    const finalDiscount = normalizeAmount(discountAmount) || 0;
    if (finalDiscount === false) {
      return res.status(400).json({ error: 'Desconto invalido.' });
    }

    const inserted = await query(
      `INSERT INTO cash_transactions
         (clinic_id, patient_id, doctor_id, procedure_type_id, description, amount, discount_amount,
          status, origin, created_by_type, created_by_id, authorized_by_owner_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING','MANUAL',$8,$9,$10,$11)
       RETURNING *`,
      [
        clinicId,
        patientId,
        doctorId || null,
        resolvedProcedureTypeId,
        finalDescription,
        finalAmount,
        finalDiscount,
        actorType(req.user),
        req.user.id,
        auth.ownerId,
        notes || null,
      ]
    );

    socketService.emitToClinic(clinicId, 'cash_transaction_created', { transaction: inserted.rows[0] });
    return res.status(201).json(inserted.rows[0]);
  } catch (err) {
    return next(err);
  }
});

// Recebe um lancamento — aceita tanto o formato antigo (paymentMethod unico)
// quanto o novo, no estilo PDV: `payments: [{ method, amount }, ...]`, onde o
// mesmo atendimento pode ser pago em mais de uma forma (ex.: parte em
// dinheiro, parte no cartao). A soma das "pernas" tem que fechar exatamente
// com o valor liquido do lancamento (amount - discount_amount) — sem isso,
// a conferencia de caixa do fechamento do dia ficaria furada.
router.post('/transactions/:id/receive', requireDoctorOrReceptionist, requireCaixaPermission('update'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { id } = req.params;
    const { paymentMethod, payments, notes } = req.body;

    let legs;
    if (Array.isArray(payments) && payments.length > 0) {
      legs = payments.map((p) => ({
        method: String(p?.method || p?.paymentMethod || '').toUpperCase(),
        amount: normalizeAmount(p?.amount),
      }));
    } else if (paymentMethod) {
      // Fluxo antigo/simples: uma unica forma, valor = total do lancamento (calculado abaixo).
      legs = [{ method: String(paymentMethod).toUpperCase(), amount: null }];
    } else {
      return res.status(400).json({ error: 'Informe a forma de pagamento.' });
    }

    if (legs.length > 6) {
      return res.status(400).json({ error: 'No maximo 6 formas de pagamento por recebimento.' });
    }
    for (const leg of legs) {
      if (!PAYMENT_METHODS.includes(leg.method)) {
        return res.status(400).json({ error: `Forma de pagamento invalida: ${leg.method || '(vazio)'}.` });
      }
    }

    const session = await getOpenSession(clinicId);
    if (!session) {
      return res.status(409).json({ error: 'Abra o caixa antes de registrar recebimentos.' });
    }

    const txRes = await query(
      `SELECT * FROM cash_transactions WHERE id = $1 AND clinic_id = $2 LIMIT 1`,
      [id, clinicId]
    );
    const transaction = txRes.rows[0];
    if (!transaction) return res.status(404).json({ error: 'Lancamento nao encontrado.' });
    if (transaction.status !== 'PENDING') {
      return res.status(409).json({ error: 'Este lancamento ja foi recebido ou cancelado.' });
    }

    const netAmount = Math.round((Number(transaction.amount) - Number(transaction.discount_amount)) * 100) / 100;

    // Uma unica perna sem valor informado (fluxo antigo) usa o valor total do lancamento.
    if (legs.length === 1 && legs[0].amount === null) legs[0].amount = netAmount;

    for (const leg of legs) {
      if (leg.amount === false || leg.amount === null || leg.amount <= 0) {
        return res.status(400).json({ error: 'Informe um valor valido (maior que zero) para cada forma de pagamento.' });
      }
    }
    const legsSum = Math.round(legs.reduce((acc, l) => acc + l.amount, 0) * 100) / 100;
    if (Math.abs(legsSum - netAmount) > 0.01) {
      return res.status(400).json({
        error: `A soma das formas de pagamento (R$ ${legsSum.toFixed(2)}) precisa ser igual ao valor do lancamento (R$ ${netAmount.toFixed(2)}).`,
      });
    }

    // Mais de uma forma -> marca o lancamento como MISTO; o detalhe de cada
    // forma (e quanto foi em cada uma) fica em cash_transaction_payments.
    const finalPaymentMethod = legs.length > 1 ? 'MISTO' : legs[0].method;

    const updated = await query(
      `UPDATE cash_transactions SET
         status = 'PAID',
         payment_method = $1,
         paid_at = now(),
         received_by_type = $2,
         received_by_id = $3,
         cash_session_id = $4,
         notes = COALESCE($5, notes)
       WHERE id = $6
       RETURNING *`,
      [finalPaymentMethod, actorType(req.user), req.user.id, session.id, notes || null, id]
    );

    for (const leg of legs) {
      await query(
        `INSERT INTO cash_transaction_payments (transaction_id, payment_method, amount) VALUES ($1, $2, $3)`,
        [id, leg.method, leg.amount]
      );
    }

    const result = { ...updated.rows[0], payments: legs.map((l) => ({ method: l.method, amount: l.amount })) };
    socketService.emitToClinic(clinicId, 'cash_transaction_paid', { transaction: result });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.post('/transactions/:id/cancel', requireDoctorOrReceptionist, requireCaixaPermission('delete'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { id } = req.params;
    const { reason } = req.body;

    const txRes = await query(
      `SELECT * FROM cash_transactions WHERE id = $1 AND clinic_id = $2 LIMIT 1`,
      [id, clinicId]
    );
    const transaction = txRes.rows[0];
    if (!transaction) return res.status(404).json({ error: 'Lancamento nao encontrado.' });
    if (transaction.status !== 'PENDING') {
      return res.status(409).json({ error: 'Somente lancamentos pendentes podem ser cancelados.' });
    }

    const updated = await query(
      `UPDATE cash_transactions SET
         status = 'CANCELED',
         canceled_at = now(),
         notes = TRIM(CONCAT(COALESCE(notes, ''), ' ', $1::text))
       WHERE id = $2
       RETURNING *`,
      [reason ? `[Cancelado] ${reason}` : '[Cancelado]', id]
    );

    socketService.emitToClinic(clinicId, 'cash_transaction_canceled', { transaction: updated.rows[0] });
    return res.json(updated.rows[0]);
  } catch (err) {
    return next(err);
  }
});

router.put('/transactions/:id', requireDoctorOrReceptionist, requireCaixaPermission('update'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const { id } = req.params;
    const { description, amount, discountAmount, doctorId, notes } = req.body;

    const txRes = await query(
      `SELECT * FROM cash_transactions WHERE id = $1 AND clinic_id = $2 LIMIT 1`,
      [id, clinicId]
    );
    const transaction = txRes.rows[0];
    if (!transaction) return res.status(404).json({ error: 'Lancamento nao encontrado.' });
    if (transaction.status !== 'PENDING') {
      return res.status(409).json({ error: 'Somente lancamentos pendentes podem ser editados.' });
    }

    const normalizedAmount = amount !== undefined ? normalizeAmount(amount) : null;
    if (normalizedAmount === false) return res.status(400).json({ error: 'Valor invalido.' });
    const normalizedDiscount = discountAmount !== undefined ? normalizeAmount(discountAmount) : null;
    if (normalizedDiscount === false) return res.status(400).json({ error: 'Desconto invalido.' });

    if (doctorId) {
      const doctorIds = await getClinicDoctorIds(clinicId);
      if (!doctorIds.includes(doctorId)) {
        return res.status(400).json({ error: 'Medico invalido para esta clinica.' });
      }
    }

    const updated = await query(
      `UPDATE cash_transactions SET
         description = COALESCE($1, description),
         amount = COALESCE($2, amount),
         discount_amount = COALESCE($3, discount_amount),
         doctor_id = COALESCE($4, doctor_id),
         notes = COALESCE($5, notes)
       WHERE id = $6
       RETURNING *`,
      [
        description ? String(description).trim() : null,
        normalizedAmount,
        normalizedDiscount,
        doctorId || null,
        notes ?? null,
        id,
      ]
    );

    socketService.emitToClinic(clinicId, 'cash_transaction_updated', { transaction: updated.rows[0] });
    return res.json(updated.rows[0]);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
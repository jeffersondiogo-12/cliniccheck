/**
 * insuranceRoutes.js — API de Convênios / Glosas. Monta em /api/insurance.
 *
 * Nível de integração: controle interno (sem geração de XML TISS nem
 * webservice com operadora) — conforme decidido, guias funcionam como
 * "espelho" interno para conferência financeira e de status.
 *
 * Páginas de permissão:
 *  - 'convenios'        -> cadastro (operadoras, planos, contratos, tabela de
 *                          procedimentos, carteirinhas de pacientes)
 *  - 'convenios.guias'  -> operação (guias, lotes de faturamento, glosas)
 */
const express = require('express');
const { query } = require('../config/database');
const { requireDoctorOrReceptionist, getStaffPermission } = require('../middleware/auth');
const socketService = require('../services/socketService');

const router = express.Router();

function actorType(user) {
  return user.role === 'DOCTOR' ? 'doctor' : 'receptionist';
}

function requireInsurancePermission(pageCode, action) {
  return async (req, res, next) => {
    try {
      const perm = await getStaffPermission(req.user, pageCode);
      const allowed =
        (action === 'view' && perm.can_view) ||
        (action === 'create' && perm.can_create) ||
        (action === 'update' && perm.can_update) ||
        (action === 'delete' && perm.can_delete);
      if (!allowed) {
        return res.status(403).json({ error: `Sem permissao para ${action} em Convênios.` });
      }
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

// ═══════════════════════════════════════════════════════════════
// OPERADORAS
// ═══════════════════════════════════════════════════════════════
router.get('/operators', requireDoctorOrReceptionist, requireInsurancePermission('convenios', 'view'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM insurance_operators WHERE clinic_id = $1 ORDER BY name ASC`,
      [req.user.clinicId]
    );
    return res.json(result.rows);
  } catch (err) { return next(err); }
});

router.post('/operators', requireDoctorOrReceptionist, requireInsurancePermission('convenios', 'create'), async (req, res, next) => {
  try {
    const { name, cnpj, ansRegistry, contactPhone, contactEmail, averagePaymentDays } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Informe o nome da operadora.' });
    const days = averagePaymentDays != null && averagePaymentDays !== '' ? Math.max(1, parseInt(averagePaymentDays, 10) || 45) : 45;
    const inserted = await query(
      `INSERT INTO insurance_operators (clinic_id, name, cnpj, ans_registry, contact_phone, contact_email, average_payment_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.clinicId, name.trim(), cnpj || null, ansRegistry || null, contactPhone || null, contactEmail || null, days]
    );
    return res.status(201).json(inserted.rows[0]);
  } catch (err) { return next(err); }
});

router.put('/operators/:id', requireDoctorOrReceptionist, requireInsurancePermission('convenios', 'update'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, cnpj, ansRegistry, contactPhone, contactEmail, active, averagePaymentDays } = req.body;
    const days = averagePaymentDays != null && averagePaymentDays !== '' ? Math.max(1, parseInt(averagePaymentDays, 10) || 45) : null;
    const updated = await query(
      `UPDATE insurance_operators SET
         name = COALESCE($1, name), cnpj = COALESCE($2, cnpj), ans_registry = COALESCE($3, ans_registry),
         contact_phone = COALESCE($4, contact_phone), contact_email = COALESCE($5, contact_email),
         active = COALESCE($6, active), average_payment_days = COALESCE($7, average_payment_days)
       WHERE id = $8 AND clinic_id = $9 RETURNING *`,
      [name?.trim() || null, cnpj ?? null, ansRegistry ?? null, contactPhone ?? null, contactEmail ?? null, active != null ? Boolean(active) : null, days, id, req.user.clinicId]
    );
    if (updated.rowCount === 0) return res.status(404).json({ error: 'Operadora não encontrada.' });
    return res.json(updated.rows[0]);
  } catch (err) { return next(err); }
});

// ═══════════════════════════════════════════════════════════════
// PLANOS
// ═══════════════════════════════════════════════════════════════
router.get('/operators/:operatorId/plans', requireDoctorOrReceptionist, requireInsurancePermission('convenios', 'view'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT p.* FROM insurance_plans p
         JOIN insurance_operators o ON o.id = p.operator_id
        WHERE p.operator_id = $1 AND o.clinic_id = $2 ORDER BY p.name ASC`,
      [req.params.operatorId, req.user.clinicId]
    );
    return res.json(result.rows);
  } catch (err) { return next(err); }
});

router.post('/operators/:operatorId/plans', requireDoctorOrReceptionist, requireInsurancePermission('convenios', 'create'), async (req, res, next) => {
  try {
    const { name, segmentation, coverageArea } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Informe o nome do plano.' });
    const owner = await query(`SELECT id FROM insurance_operators WHERE id = $1 AND clinic_id = $2`, [req.params.operatorId, req.user.clinicId]);
    if (owner.rowCount === 0) return res.status(404).json({ error: 'Operadora não encontrada.' });
    const inserted = await query(
      `INSERT INTO insurance_plans (operator_id, name, segmentation, coverage_area) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.operatorId, name.trim(), segmentation || null, coverageArea || null]
    );
    return res.status(201).json(inserted.rows[0]);
  } catch (err) { return next(err); }
});

// ═══════════════════════════════════════════════════════════════
// CONTRATOS DA CLÍNICA COM A OPERADORA
// ═══════════════════════════════════════════════════════════════
router.get('/contracts', requireDoctorOrReceptionist, requireInsurancePermission('convenios', 'view'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT c.*, o.name AS operator_name
         FROM clinic_insurance_contracts c
         JOIN insurance_operators o ON o.id = c.operator_id
        WHERE c.clinic_id = $1
        ORDER BY o.name ASC`,
      [req.user.clinicId]
    );
    return res.json(result.rows);
  } catch (err) { return next(err); }
});

router.post('/contracts', requireDoctorOrReceptionist, requireInsurancePermission('convenios', 'create'), async (req, res, next) => {
  try {
    const { operatorId, cbhpmPercentage, requiresAuthorizationDefault, hasCoparticipation, coparticipationPercentage, closingDay, glosaAppealDeadlineDays, notes } = req.body;
    if (!operatorId) return res.status(400).json({ error: 'Selecione a operadora.' });
    const owner = await query(`SELECT id FROM insurance_operators WHERE id = $1 AND clinic_id = $2`, [operatorId, req.user.clinicId]);
    if (owner.rowCount === 0) return res.status(404).json({ error: 'Operadora não encontrada.' });

    const inserted = await query(
      `INSERT INTO clinic_insurance_contracts
         (clinic_id, operator_id, cbhpm_percentage, requires_authorization_default, has_coparticipation, coparticipation_percentage, closing_day, glosa_appeal_deadline_days, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (clinic_id, operator_id) DO UPDATE SET
         cbhpm_percentage = excluded.cbhpm_percentage,
         requires_authorization_default = excluded.requires_authorization_default,
         has_coparticipation = excluded.has_coparticipation,
         coparticipation_percentage = excluded.coparticipation_percentage,
         closing_day = excluded.closing_day,
         glosa_appeal_deadline_days = excluded.glosa_appeal_deadline_days,
         notes = excluded.notes,
         active = true
       RETURNING *`,
      [
        req.user.clinicId, operatorId, cbhpmPercentage || null, Boolean(requiresAuthorizationDefault),
        Boolean(hasCoparticipation), coparticipationPercentage || null, closingDay || null,
        glosaAppealDeadlineDays || 30, notes || null,
      ]
    );
    return res.status(201).json(inserted.rows[0]);
  } catch (err) { return next(err); }
});

router.put('/contracts/:id', requireDoctorOrReceptionist, requireInsurancePermission('convenios', 'update'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { cbhpmPercentage, requiresAuthorizationDefault, hasCoparticipation, coparticipationPercentage, closingDay, glosaAppealDeadlineDays, notes, active } = req.body;
    const updated = await query(
      `UPDATE clinic_insurance_contracts SET
         cbhpm_percentage = COALESCE($1, cbhpm_percentage),
         requires_authorization_default = COALESCE($2, requires_authorization_default),
         has_coparticipation = COALESCE($3, has_coparticipation),
         coparticipation_percentage = COALESCE($4, coparticipation_percentage),
         closing_day = COALESCE($5, closing_day),
         glosa_appeal_deadline_days = COALESCE($6, glosa_appeal_deadline_days),
         notes = COALESCE($7, notes),
         active = COALESCE($8, active)
       WHERE id = $9 AND clinic_id = $10 RETURNING *`,
      [
        cbhpmPercentage ?? null, requiresAuthorizationDefault != null ? Boolean(requiresAuthorizationDefault) : null,
        hasCoparticipation != null ? Boolean(hasCoparticipation) : null, coparticipationPercentage ?? null,
        closingDay ?? null, glosaAppealDeadlineDays ?? null, notes ?? null, active != null ? Boolean(active) : null,
        id, req.user.clinicId,
      ]
    );
    if (updated.rowCount === 0) return res.status(404).json({ error: 'Contrato não encontrado.' });
    return res.json(updated.rows[0]);
  } catch (err) { return next(err); }
});

// ═══════════════════════════════════════════════════════════════
// TABELA DE PROCEDIMENTOS POR CONTRATO
// ═══════════════════════════════════════════════════════════════
router.get('/contracts/:contractId/procedures', requireDoctorOrReceptionist, requireInsurancePermission('convenios', 'view'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT pt.* FROM insurance_procedure_table pt
         JOIN clinic_insurance_contracts c ON c.id = pt.contract_id
        WHERE pt.contract_id = $1 AND c.clinic_id = $2 ORDER BY pt.description ASC`,
      [req.params.contractId, req.user.clinicId]
    );
    return res.json(result.rows);
  } catch (err) { return next(err); }
});

router.post('/contracts/:contractId/procedures', requireDoctorOrReceptionist, requireInsurancePermission('convenios', 'create'), async (req, res, next) => {
  try {
    const { tussCode, cbhpmCode, description, negotiatedValue, requiresAuthorization, waitingPeriodDays } = req.body;
    if (!description || !description.trim()) return res.status(400).json({ error: 'Informe a descrição do procedimento.' });
    const normalizedValue = normalizeAmount(negotiatedValue);
    if (normalizedValue === false) return res.status(400).json({ error: 'Valor negociado inválido.' });
    const owner = await query(`SELECT id FROM clinic_insurance_contracts WHERE id = $1 AND clinic_id = $2`, [req.params.contractId, req.user.clinicId]);
    if (owner.rowCount === 0) return res.status(404).json({ error: 'Contrato não encontrado.' });

    const inserted = await query(
      `INSERT INTO insurance_procedure_table (contract_id, tuss_code, cbhpm_code, description, negotiated_value, requires_authorization, waiting_period_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.contractId, tussCode || null, cbhpmCode || null, description.trim(), normalizedValue || 0, requiresAuthorization != null ? Boolean(requiresAuthorization) : null, waitingPeriodDays || 0]
    );
    return res.status(201).json(inserted.rows[0]);
  } catch (err) { return next(err); }
});

router.put('/procedures/:id', requireDoctorOrReceptionist, requireInsurancePermission('convenios', 'update'), async (req, res, next) => {
  try {
    const { tussCode, cbhpmCode, description, negotiatedValue, requiresAuthorization, waitingPeriodDays, active } = req.body;
    const normalizedValue = negotiatedValue !== undefined ? normalizeAmount(negotiatedValue) : null;
    if (normalizedValue === false) return res.status(400).json({ error: 'Valor negociado inválido.' });
    const updated = await query(
      `UPDATE insurance_procedure_table SET
         tuss_code = COALESCE($1, tuss_code), cbhpm_code = COALESCE($2, cbhpm_code),
         description = COALESCE($3, description), negotiated_value = COALESCE($4, negotiated_value),
         requires_authorization = COALESCE($5, requires_authorization),
         waiting_period_days = COALESCE($6, waiting_period_days), active = COALESCE($7, active)
       WHERE id = $8 RETURNING *`,
      [tussCode ?? null, cbhpmCode ?? null, description?.trim() || null, normalizedValue,
       requiresAuthorization != null ? Boolean(requiresAuthorization) : null, waitingPeriodDays ?? null,
       active != null ? Boolean(active) : null, req.params.id]
    );
    if (updated.rowCount === 0) return res.status(404).json({ error: 'Procedimento não encontrado.' });
    return res.json(updated.rows[0]);
  } catch (err) { return next(err); }
});

router.delete('/procedures/:id', requireDoctorOrReceptionist, requireInsurancePermission('convenios', 'delete'), async (req, res, next) => {
  try {
    await query(`UPDATE insurance_procedure_table SET active = false WHERE id = $1`, [req.params.id]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// ═══════════════════════════════════════════════════════════════
// CARTEIRINHAS (paciente ↔ convênio)
// ═══════════════════════════════════════════════════════════════
router.get('/patient-insurance', requireDoctorOrReceptionist, requireInsurancePermission('convenios', 'view'), async (req, res, next) => {
  try {
    const { patientId, search } = req.query;
    const values = [req.user.clinicId];
    const where = ['c.clinic_id = $1'];
    if (patientId) { values.push(patientId); where.push(`pi.patient_id = $${values.length}`); }
    if (search) { values.push(`%${search.trim()}%`); where.push(`p.name ILIKE $${values.length}`); }

    const result = await query(
      `SELECT pi.*, p.name AS patient_name, o.name AS operator_name, pl.name AS plan_name, c.operator_id
         FROM patient_insurance pi
         JOIN patients p ON p.id = pi.patient_id
         JOIN clinic_insurance_contracts c ON c.id = pi.contract_id
         JOIN insurance_operators o ON o.id = c.operator_id
         LEFT JOIN insurance_plans pl ON pl.id = pi.plan_id
        WHERE ${where.join(' AND ')}
        ORDER BY p.name ASC`,
      values
    );
    return res.json(result.rows);
  } catch (err) { return next(err); }
});

router.post('/patient-insurance', requireDoctorOrReceptionist, requireInsurancePermission('convenios', 'create'), async (req, res, next) => {
  try {
    const { patientId, contractId, planId, cardNumber, cardValidity, holderPatientId, coverageStartDate, notes } = req.body;
    if (!patientId || !contractId || !cardNumber) {
      return res.status(400).json({ error: 'Informe paciente, contrato e número da carteirinha.' });
    }
    const contract = await query(`SELECT id FROM clinic_insurance_contracts WHERE id = $1 AND clinic_id = $2`, [contractId, req.user.clinicId]);
    if (contract.rowCount === 0) return res.status(404).json({ error: 'Contrato não encontrado.' });

    const inserted = await query(
      `INSERT INTO patient_insurance (patient_id, contract_id, plan_id, card_number, card_validity, holder_patient_id, coverage_start_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [patientId, contractId, planId || null, cardNumber.trim(), cardValidity || null, holderPatientId || null, coverageStartDate || new Date().toISOString().slice(0, 10), notes || null]
    );
    return res.status(201).json(inserted.rows[0]);
  } catch (err) { return next(err); }
});

router.put('/patient-insurance/:id', requireDoctorOrReceptionist, requireInsurancePermission('convenios', 'update'), async (req, res, next) => {
  try {
    const { planId, cardNumber, cardValidity, coverageStartDate, status, notes } = req.body;
    const updated = await query(
      `UPDATE patient_insurance SET
         plan_id = COALESCE($1, plan_id), card_number = COALESCE($2, card_number),
         card_validity = COALESCE($3, card_validity), coverage_start_date = COALESCE($4, coverage_start_date),
         status = COALESCE($5, status), notes = COALESCE($6, notes)
       WHERE id = $7 RETURNING *`,
      [planId ?? null, cardNumber?.trim() || null, cardValidity ?? null, coverageStartDate ?? null, status || null, notes ?? null, req.params.id]
    );
    if (updated.rowCount === 0) return res.status(404).json({ error: 'Carteirinha não encontrada.' });
    return res.json(updated.rows[0]);
  } catch (err) { return next(err); }
});

// Checagem de carência para um procedimento específico
router.get('/patient-insurance/:id/waiting-period-check', requireDoctorOrReceptionist, requireInsurancePermission('convenios', 'view'), async (req, res, next) => {
  try {
    const { procedureTableId } = req.query;
    const piRes = await query(`SELECT * FROM patient_insurance WHERE id = $1`, [req.params.id]);
    if (piRes.rowCount === 0) return res.status(404).json({ error: 'Carteirinha não encontrada.' });
    const pi = piRes.rows[0];

    let waitingDays = 0;
    if (procedureTableId) {
      const procRes = await query(`SELECT waiting_period_days FROM insurance_procedure_table WHERE id = $1`, [procedureTableId]);
      waitingDays = procRes.rows[0]?.waiting_period_days || 0;
    }
    const coverageStart = new Date(pi.coverage_start_date);
    const waitingUntil = new Date(coverageStart);
    waitingUntil.setDate(waitingUntil.getDate() + waitingDays);
    const stillInWaitingPeriod = waitingDays > 0 && new Date() < waitingUntil;

    return res.json({
      coverageStartDate: pi.coverage_start_date,
      waitingPeriodDays: waitingDays,
      waitingUntil: waitingUntil.toISOString().slice(0, 10),
      stillInWaitingPeriod,
    });
  } catch (err) { return next(err); }
});

// ═══════════════════════════════════════════════════════════════
// GUIAS (CLAIMS) — máquina de estados
// ═══════════════════════════════════════════════════════════════
router.get('/claims', requireDoctorOrReceptionist, requireInsurancePermission('convenios.guias', 'view'), async (req, res, next) => {
  try {
    const { status, contractId, patientId, batchId } = req.query;
    const values = [req.user.clinicId];
    const where = ['ic.clinic_id = $1'];
    if (status && status.toUpperCase() !== 'ALL') { values.push(status.toUpperCase()); where.push(`ic.status = $${values.length}`); }
    if (contractId) { values.push(contractId); where.push(`pi.contract_id = $${values.length}`); }
    if (patientId) { values.push(patientId); where.push(`pi.patient_id = $${values.length}`); }
    if (batchId) { values.push(batchId); where.push(`ic.batch_id = $${values.length}`); }

    const result = await query(
      `SELECT ic.*, p.name AS patient_name, pi.card_number, o.name AS operator_name, d.name AS doctor_name
         FROM insurance_claims ic
         JOIN patient_insurance pi ON pi.id = ic.patient_insurance_id
         JOIN patients p ON p.id = pi.patient_id
         JOIN clinic_insurance_contracts c ON c.id = pi.contract_id
         JOIN insurance_operators o ON o.id = c.operator_id
         LEFT JOIN doctors d ON d.id = ic.doctor_id
        WHERE ${where.join(' AND ')}
        ORDER BY ic.created_at DESC`,
      values
    );
    return res.json(result.rows);
  } catch (err) { return next(err); }
});

router.get('/claims/:id', requireDoctorOrReceptionist, requireInsurancePermission('convenios.guias', 'view'), async (req, res, next) => {
  try {
    const claimRes = await query(
      `SELECT ic.*, p.name AS patient_name, pi.card_number, o.name AS operator_name, d.name AS doctor_name
         FROM insurance_claims ic
         JOIN patient_insurance pi ON pi.id = ic.patient_insurance_id
         JOIN patients p ON p.id = pi.patient_id
         JOIN clinic_insurance_contracts c ON c.id = pi.contract_id
         JOIN insurance_operators o ON o.id = c.operator_id
         LEFT JOIN doctors d ON d.id = ic.doctor_id
        WHERE ic.id = $1 AND ic.clinic_id = $2`,
      [req.params.id, req.user.clinicId]
    );
    if (claimRes.rowCount === 0) return res.status(404).json({ error: 'Guia não encontrada.' });
    const itemsRes = await query(`SELECT * FROM insurance_claim_items WHERE claim_id = $1 ORDER BY created_at ASC`, [req.params.id]);
    const appealsRes = await query(`SELECT * FROM insurance_glosa_appeals WHERE claim_id = $1 ORDER BY created_at DESC`, [req.params.id]);
    return res.json({ claim: claimRes.rows[0], items: itemsRes.rows, appeals: appealsRes.rows });
  } catch (err) { return next(err); }
});

router.post('/claims', requireDoctorOrReceptionist, requireInsurancePermission('convenios.guias', 'create'), async (req, res, next) => {
  try {
    const { patientInsuranceId, doctorId, consultationId, surgeryId, type, authorizationNumber, notes, items } = req.body;
    if (!patientInsuranceId) return res.status(400).json({ error: 'Selecione a carteirinha do paciente.' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Adicione ao menos um procedimento à guia.' });

    const piRes = await query(
      `SELECT pi.*, c.requires_authorization_default
         FROM patient_insurance pi
         JOIN clinic_insurance_contracts c ON c.id = pi.contract_id
        WHERE pi.id = $1 AND c.clinic_id = $2`,
      [patientInsuranceId, req.user.clinicId]
    );
    if (piRes.rowCount === 0) return res.status(404).json({ error: 'Carteirinha não encontrada.' });

    let totalValue = 0;
    const normalizedItems = [];
    for (const item of items) {
      const qty = Math.max(parseInt(item.quantity, 10) || 1, 1);
      const unitValue = normalizeAmount(item.unitValue);
      if (unitValue === false || unitValue === null) return res.status(400).json({ error: 'Valor unitário inválido em um dos itens.' });
      if (!item.description || !item.description.trim()) return res.status(400).json({ error: 'Descrição obrigatória em todos os itens.' });
      totalValue += qty * unitValue;
      normalizedItems.push({ procedureTableId: item.procedureTableId || null, description: item.description.trim(), quantity: qty, unitValue });
    }

    const claimInserted = await query(
      `INSERT INTO insurance_claims (clinic_id, patient_insurance_id, doctor_id, consultation_id, surgery_id, type, authorization_number, total_value, notes, created_by_type, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.user.clinicId, patientInsuranceId, doctorId || null, consultationId || null, surgeryId || null, type || 'CONSULTA', authorizationNumber || null, Math.round(totalValue * 100) / 100, notes || null, actorType(req.user), req.user.id]
    );
    const claim = claimInserted.rows[0];

    for (const item of normalizedItems) {
      await query(
        `INSERT INTO insurance_claim_items (claim_id, procedure_table_id, description, quantity, unit_value) VALUES ($1,$2,$3,$4,$5)`,
        [claim.id, item.procedureTableId, item.description, item.quantity, item.unitValue]
      );
    }

    socketService.emitToClinic(req.user.clinicId, 'insurance_claim_created', { claim });
    return res.status(201).json(claim);
  } catch (err) { return next(err); }
});

router.post('/claims/:id/emit', requireDoctorOrReceptionist, requireInsurancePermission('convenios.guias', 'update'), async (req, res, next) => {
  try {
    const claimRes = await query(
      `SELECT ic.*, c.requires_authorization_default
         FROM insurance_claims ic
         JOIN patient_insurance pi ON pi.id = ic.patient_insurance_id
         JOIN clinic_insurance_contracts c ON c.id = pi.contract_id
        WHERE ic.id = $1 AND ic.clinic_id = $2`,
      [req.params.id, req.user.clinicId]
    );
    if (claimRes.rowCount === 0) return res.status(404).json({ error: 'Guia não encontrada.' });
    const claim = claimRes.rows[0];
    if (claim.status !== 'RASCUNHO') return res.status(409).json({ error: 'Somente guias em rascunho podem ser emitidas.' });
    if (claim.requires_authorization_default && !claim.authorization_number) {
      return res.status(400).json({ error: 'Este convênio exige número de autorização antes de emitir a guia.' });
    }

    const updated = await query(`UPDATE insurance_claims SET status = 'EMITIDA', issued_at = now() WHERE id = $1 RETURNING *`, [req.params.id]);
    socketService.emitToClinic(req.user.clinicId, 'insurance_claim_updated', { claim: updated.rows[0] });
    return res.json(updated.rows[0]);
  } catch (err) { return next(err); }
});

router.post('/claims/:id/cancel', requireDoctorOrReceptionist, requireInsurancePermission('convenios.guias', 'delete'), async (req, res, next) => {
  try {
    const claimRes = await query(`SELECT * FROM insurance_claims WHERE id = $1 AND clinic_id = $2`, [req.params.id, req.user.clinicId]);
    if (claimRes.rowCount === 0) return res.status(404).json({ error: 'Guia não encontrada.' });
    if (!['RASCUNHO', 'EMITIDA'].includes(claimRes.rows[0].status)) {
      return res.status(409).json({ error: 'Só é possível cancelar guias em rascunho ou emitidas (ainda não enviadas).' });
    }
    await query(`DELETE FROM insurance_claims WHERE id = $1`, [req.params.id]);
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// ═══════════════════════════════════════════════════════════════
// LOTES DE FATURAMENTO
// ═══════════════════════════════════════════════════════════════
router.get('/batches', requireDoctorOrReceptionist, requireInsurancePermission('convenios.guias', 'view'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT b.*, o.name AS operator_name
         FROM insurance_billing_batches b
         JOIN clinic_insurance_contracts c ON c.id = b.contract_id
         JOIN insurance_operators o ON o.id = c.operator_id
        WHERE b.clinic_id = $1
        ORDER BY b.competence_month DESC, b.created_at DESC`,
      [req.user.clinicId]
    );
    return res.json(result.rows);
  } catch (err) { return next(err); }
});

router.post('/batches', requireDoctorOrReceptionist, requireInsurancePermission('convenios.guias', 'create'), async (req, res, next) => {
  try {
    const { contractId, competenceMonth } = req.body;
    if (!contractId || !competenceMonth) return res.status(400).json({ error: 'Informe o contrato e o mês de competência.' });
    const contract = await query(`SELECT id FROM clinic_insurance_contracts WHERE id = $1 AND clinic_id = $2`, [contractId, req.user.clinicId]);
    if (contract.rowCount === 0) return res.status(404).json({ error: 'Contrato não encontrado.' });

    const inserted = await query(
      `INSERT INTO insurance_billing_batches (clinic_id, contract_id, competence_month) VALUES ($1,$2,$3) RETURNING *`,
      [req.user.clinicId, contractId, `${competenceMonth}-01`]
    );
    return res.status(201).json(inserted.rows[0]);
  } catch (err) { return next(err); }
});

// Adiciona guias EMITIDAs (do mesmo contrato do lote) ao lote e marca como ENVIADA
router.post('/batches/:id/add-claims', requireDoctorOrReceptionist, requireInsurancePermission('convenios.guias', 'update'), async (req, res, next) => {
  try {
    const { claimIds } = req.body;
    if (!Array.isArray(claimIds) || claimIds.length === 0) return res.status(400).json({ error: 'Selecione ao menos uma guia.' });

    const batchRes = await query(`SELECT * FROM insurance_billing_batches WHERE id = $1 AND clinic_id = $2`, [req.params.id, req.user.clinicId]);
    if (batchRes.rowCount === 0) return res.status(404).json({ error: 'Lote não encontrado.' });
    if (batchRes.rows[0].status !== 'ABERTO') return res.status(409).json({ error: 'Este lote já foi enviado.' });

    const updated = await query(
      `UPDATE insurance_claims ic SET batch_id = $1, status = 'ENVIADA', sent_at = now()
         FROM patient_insurance pi
        WHERE ic.patient_insurance_id = pi.id
          AND ic.id = ANY($2::uuid[]) AND ic.clinic_id = $3 AND ic.status = 'EMITIDA'
          AND pi.contract_id = $4
        RETURNING ic.*`,
      [req.params.id, claimIds, req.user.clinicId, batchRes.rows[0].contract_id]
    );

    const totalRes = await query(`SELECT COALESCE(SUM(total_value),0) AS total FROM insurance_claims WHERE batch_id = $1`, [req.params.id]);
    await query(`UPDATE insurance_billing_batches SET total_billed = $1 WHERE id = $2`, [totalRes.rows[0].total, req.params.id]);

    return res.json({ added: updated.rowCount, claims: updated.rows });
  } catch (err) { return next(err); }
});

router.post('/batches/:id/close', requireDoctorOrReceptionist, requireInsurancePermission('convenios.guias', 'update'), async (req, res, next) => {
  try {
    const batchRes = await query(`SELECT * FROM insurance_billing_batches WHERE id = $1 AND clinic_id = $2`, [req.params.id, req.user.clinicId]);
    if (batchRes.rowCount === 0) return res.status(404).json({ error: 'Lote não encontrado.' });
    if (batchRes.rows[0].status !== 'ABERTO') return res.status(409).json({ error: 'Este lote já foi enviado.' });

    const updated = await query(`UPDATE insurance_billing_batches SET status = 'ENVIADO', sent_at = now() WHERE id = $1 RETURNING *`, [req.params.id]);
    return res.json(updated.rows[0]);
  } catch (err) { return next(err); }
});

// Registra o retorno da operadora: pago/glosado por guia do lote
router.post('/batches/:id/return', requireDoctorOrReceptionist, requireInsurancePermission('convenios.guias', 'update'), async (req, res, next) => {
  try {
    const { items } = req.body; // [{ claimId, paidValue, glossedValue, glosaReason }]
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Informe o retorno de ao menos uma guia.' });

    const batchRes = await query(`SELECT * FROM insurance_billing_batches WHERE id = $1 AND clinic_id = $2`, [req.params.id, req.user.clinicId]);
    if (batchRes.rowCount === 0) return res.status(404).json({ error: 'Lote não encontrado.' });
    if (batchRes.rows[0].status === 'CONCILIADO') return res.status(409).json({ error: 'Este lote já foi conciliado.' });

    let totalPaid = 0, totalGlossed = 0;
    for (const item of items) {
      const paid = normalizeAmount(item.paidValue) || 0;
      const glossed = normalizeAmount(item.glossedValue) || 0;
      if (paid === false || glossed === false) return res.status(400).json({ error: 'Valor de pagamento/glosa inválido.' });
      totalPaid += paid; totalGlossed += glossed;

      let status = 'PAGA';
      if (glossed > 0 && paid <= 0) status = 'GLOSADA_TOTAL';
      else if (glossed > 0) status = 'GLOSADA_PARCIAL';

      await query(
        `UPDATE insurance_claims SET status = $1, total_paid = $2, total_glossed = $3, glosa_reason = $4
          WHERE id = $5 AND batch_id = $6`,
        [status, paid, glossed, item.glosaReason || null, item.claimId, req.params.id]
      );
    }

    const updated = await query(
      `UPDATE insurance_billing_batches SET status = 'CONCILIADO', returned_at = now(), total_paid = $1, total_glossed = $2 WHERE id = $3 RETURNING *`,
      [totalPaid, totalGlossed, req.params.id]
    );
    socketService.emitToClinic(req.user.clinicId, 'insurance_batch_reconciled', { batch: updated.rows[0] });
    return res.json(updated.rows[0]);
  } catch (err) { return next(err); }
});

// ═══════════════════════════════════════════════════════════════
// GLOSAS — RECURSOS
// ═══════════════════════════════════════════════════════════════
router.get('/appeals', requireDoctorOrReceptionist, requireInsurancePermission('convenios.guias', 'view'), async (req, res, next) => {
  try {
    const { status } = req.query;
    const values = [req.user.clinicId];
    const where = ['ic.clinic_id = $1'];
    if (status && status.toUpperCase() !== 'ALL') { values.push(status.toUpperCase()); where.push(`a.status = $${values.length}`); }
    const result = await query(
      `SELECT a.*, ic.total_glossed, ic.glosa_reason AS claim_glosa_reason, p.name AS patient_name, o.name AS operator_name
         FROM insurance_glosa_appeals a
         JOIN insurance_claims ic ON ic.id = a.claim_id
         JOIN patient_insurance pi ON pi.id = ic.patient_insurance_id
         JOIN patients p ON p.id = pi.patient_id
         JOIN clinic_insurance_contracts c ON c.id = pi.contract_id
         JOIN insurance_operators o ON o.id = c.operator_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.created_at DESC`,
      values
    );
    return res.json(result.rows);
  } catch (err) { return next(err); }
});

router.post('/claims/:id/appeal', requireDoctorOrReceptionist, requireInsurancePermission('convenios.guias', 'create'), async (req, res, next) => {
  try {
    const { justification } = req.body;
    if (!justification || !justification.trim()) return res.status(400).json({ error: 'Informe a justificativa do recurso.' });

    const claimRes = await query(`SELECT * FROM insurance_claims WHERE id = $1 AND clinic_id = $2`, [req.params.id, req.user.clinicId]);
    if (claimRes.rowCount === 0) return res.status(404).json({ error: 'Guia não encontrada.' });
    if (!['GLOSADA_PARCIAL', 'GLOSADA_TOTAL'].includes(claimRes.rows[0].status)) {
      return res.status(409).json({ error: 'Só é possível recorrer de guias glosadas.' });
    }

    const inserted = await query(
      `INSERT INTO insurance_glosa_appeals (claim_id, justification, created_by_type, created_by_id) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, justification.trim(), actorType(req.user), req.user.id]
    );
    await query(`UPDATE insurance_claims SET status = 'EM_RECURSO' WHERE id = $1`, [req.params.id]);
    return res.status(201).json(inserted.rows[0]);
  } catch (err) { return next(err); }
});

router.post('/appeals/:id/resolve', requireDoctorOrReceptionist, requireInsurancePermission('convenios.guias', 'update'), async (req, res, next) => {
  try {
    const { status, responseNotes, additionalPaidValue } = req.body;
    if (!['ACEITO', 'NEGADO'].includes(status)) return res.status(400).json({ error: 'Status inválido.' });

    const appealRes = await query(
      `SELECT a.*, ic.clinic_id FROM insurance_glosa_appeals a JOIN insurance_claims ic ON ic.id = a.claim_id WHERE a.id = $1 AND ic.clinic_id = $2`,
      [req.params.id, req.user.clinicId]
    );
    if (appealRes.rowCount === 0) return res.status(404).json({ error: 'Recurso não encontrado.' });

    const updated = await query(
      `UPDATE insurance_glosa_appeals SET status = $1, response_notes = $2, response_date = CURRENT_DATE WHERE id = $3 RETURNING *`,
      [status, responseNotes || null, req.params.id]
    );

    if (status === 'ACEITO') {
      const extra = normalizeAmount(additionalPaidValue) || 0;
      await query(
        `UPDATE insurance_claims SET status = 'FINALIZADA', total_paid = COALESCE(total_paid,0) + $1, total_glossed = GREATEST(COALESCE(total_glossed,0) - $1, 0)
          WHERE id = $2`,
        [extra, appealRes.rows[0].claim_id]
      );
    } else {
      await query(`UPDATE insurance_claims SET status = 'FINALIZADA' WHERE id = $1`, [appealRes.rows[0].claim_id]);
    }

    return res.json(updated.rows[0]);
  } catch (err) { return next(err); }
});

// ═══════════════════════════════════════════════════════════════
// RELATÓRIOS: GLOSAS E CONCILIAÇÃO
// ═══════════════════════════════════════════════════════════════
router.get('/reports/glosas', requireDoctorOrReceptionist, requireInsurancePermission('convenios.guias', 'view'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT o.name AS operator_name, ic.status, COUNT(*)::int AS count,
              COALESCE(SUM(ic.total_glossed), 0) AS total_glossed
         FROM insurance_claims ic
         JOIN patient_insurance pi ON pi.id = ic.patient_insurance_id
         JOIN clinic_insurance_contracts c ON c.id = pi.contract_id
         JOIN insurance_operators o ON o.id = c.operator_id
        WHERE ic.clinic_id = $1 AND ic.status IN ('GLOSADA_PARCIAL','GLOSADA_TOTAL','EM_RECURSO')
        GROUP BY o.name, ic.status
        ORDER BY total_glossed DESC`,
      [req.user.clinicId]
    );
    return res.json(result.rows.map((r) => ({ ...r, total_glossed: Number(r.total_glossed) })));
  } catch (err) { return next(err); }
});

router.get('/reports/conciliacao', requireDoctorOrReceptionist, requireInsurancePermission('convenios.guias', 'view'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT b.id, b.competence_month, b.status, o.name AS operator_name,
              b.total_billed, b.total_paid, b.total_glossed, b.sent_at, b.returned_at
         FROM insurance_billing_batches b
         JOIN clinic_insurance_contracts c ON c.id = b.contract_id
         JOIN insurance_operators o ON o.id = c.operator_id
        WHERE b.clinic_id = $1
        ORDER BY b.competence_month DESC`,
      [req.user.clinicId]
    );
    return res.json(result.rows.map((r) => ({
      ...r,
      total_billed: Number(r.total_billed), total_paid: Number(r.total_paid), total_glossed: Number(r.total_glossed),
    })));
  } catch (err) { return next(err); }
});

// ═══════════════════════════════════════════════════════════════
// RELATÓRIO: FATURAMENTO POR CONVÊNIO
// (consolidado por operadora + profissional, e por procedimento/TUSS)
// ═══════════════════════════════════════════════════════════════
router.get('/reports/billing', requireDoctorOrReceptionist, requireInsurancePermission('convenios.guias', 'view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const from = req.query.from || (() => {
      const d = new Date(to); d.setDate(d.getDate() - 89); return d.toISOString().slice(0, 10);
    })();

    const byOperatorDoctorRes = await query(
      `SELECT o.id AS operator_id, o.name AS operator_name, COALESCE(d.name, 'Não informado') AS doctor_name,
              COUNT(*)::int AS claims,
              COALESCE(SUM(ic.total_value), 0) AS billed,
              COALESCE(SUM(ic.total_paid), 0) AS paid,
              COALESCE(SUM(ic.total_glossed), 0) AS glossed
         FROM insurance_claims ic
         JOIN patient_insurance pi ON pi.id = ic.patient_insurance_id
         JOIN clinic_insurance_contracts c ON c.id = pi.contract_id
         JOIN insurance_operators o ON o.id = c.operator_id
         LEFT JOIN doctors d ON d.id = ic.doctor_id
        WHERE ic.clinic_id = $1 AND ic.issued_at::date BETWEEN $2 AND $3
        GROUP BY o.id, o.name, d.name
        ORDER BY billed DESC`,
      [clinicId, from, to]
    );

    const byProcedureRes = await query(
      `SELECT o.name AS operator_name, ici.description AS procedure_name, ipt.tuss_code,
              SUM(ici.quantity)::int AS quantity,
              COALESCE(SUM(ici.quantity * ici.unit_value), 0) AS billed
         FROM insurance_claim_items ici
         JOIN insurance_claims ic ON ic.id = ici.claim_id
         JOIN patient_insurance pi ON pi.id = ic.patient_insurance_id
         JOIN clinic_insurance_contracts c ON c.id = pi.contract_id
         JOIN insurance_operators o ON o.id = c.operator_id
         LEFT JOIN insurance_procedure_table ipt ON ipt.id = ici.procedure_table_id
        WHERE ic.clinic_id = $1 AND ic.issued_at::date BETWEEN $2 AND $3
        GROUP BY o.name, ici.description, ipt.tuss_code
        ORDER BY billed DESC
        LIMIT 50`,
      [clinicId, from, to]
    );

    const byOperatorDoctor = byOperatorDoctorRes.rows.map((r) => {
      const billed = Number(r.billed);
      const glossed = Number(r.glossed);
      return {
        operatorId: r.operator_id,
        operatorName: r.operator_name,
        doctorName: r.doctor_name,
        claims: r.claims,
        billed,
        paid: Number(r.paid),
        glossed,
        glosaPct: billed > 0 ? Math.round((glossed / billed) * 10000) / 100 : 0,
      };
    });

    return res.json({
      period: { from, to },
      byOperatorDoctor,
      byProcedure: byProcedureRes.rows.map((r) => ({
        operatorName: r.operator_name, procedureName: r.procedure_name, tussCode: r.tuss_code,
        quantity: r.quantity, billed: Number(r.billed),
      })),
    });
  } catch (err) { return next(err); }
});

// ═══════════════════════════════════════════════════════════════
// RELATÓRIO: PROJEÇÃO DE RECEBÍVEIS DE CONVÊNIO
// Estima quando o valor de guias ja enviadas/emitidas (e ainda nao pagas
// integralmente) deve efetivamente cair no caixa, usando o prazo medio de
// recebimento cadastrado em cada operadora (insurance_operators.average_payment_days).
// ═══════════════════════════════════════════════════════════════
router.get('/reports/receivables-projection', requireDoctorOrReceptionist, requireInsurancePermission('convenios.guias', 'view'), async (req, res, next) => {
  try {
    const clinicId = req.user.clinicId;
    const result = await query(
      `WITH pend AS (
         SELECT o.id AS operator_id, o.name AS operator_name, o.average_payment_days,
                ic.id AS claim_id,
                (ic.total_value - COALESCE(ic.total_paid, 0)) AS pending_value,
                (COALESCE(ic.sent_at, ic.issued_at) + (o.average_payment_days || ' days')::interval) AS expected_date
           FROM insurance_claims ic
           JOIN patient_insurance pi ON pi.id = ic.patient_insurance_id
           JOIN clinic_insurance_contracts c ON c.id = pi.contract_id
           JOIN insurance_operators o ON o.id = c.operator_id
          WHERE ic.clinic_id = $1
            AND ic.status IN ('EMITIDA','ENVIADA')
            AND (ic.total_value - COALESCE(ic.total_paid, 0)) > 0
       )
       SELECT operator_id, operator_name, average_payment_days,
              COUNT(*)::int AS claims,
              COALESCE(SUM(pending_value), 0) AS pending_total,
              COALESCE(SUM(CASE WHEN expected_date <= now() + INTERVAL '30 days' THEN pending_value ELSE 0 END), 0) AS bucket_30,
              COALESCE(SUM(CASE WHEN expected_date > now() + INTERVAL '30 days' AND expected_date <= now() + INTERVAL '60 days' THEN pending_value ELSE 0 END), 0) AS bucket_60,
              COALESCE(SUM(CASE WHEN expected_date > now() + INTERVAL '60 days' AND expected_date <= now() + INTERVAL '90 days' THEN pending_value ELSE 0 END), 0) AS bucket_90,
              COALESCE(SUM(CASE WHEN expected_date > now() + INTERVAL '90 days' THEN pending_value ELSE 0 END), 0) AS bucket_90_plus
         FROM pend
        GROUP BY operator_id, operator_name, average_payment_days
        ORDER BY pending_total DESC`,
      [clinicId]
    );

    const operators = result.rows.map((r) => ({
      operatorId: r.operator_id,
      operatorName: r.operator_name,
      averagePaymentDays: r.average_payment_days,
      claims: r.claims,
      pendingTotal: Number(r.pending_total),
      bucket30: Number(r.bucket_30),
      bucket60: Number(r.bucket_60),
      bucket90: Number(r.bucket_90),
      bucket90Plus: Number(r.bucket_90_plus),
    }));
    const totals = operators.reduce((acc, o) => ({
      pendingTotal: acc.pendingTotal + o.pendingTotal,
      bucket30: acc.bucket30 + o.bucket30,
      bucket60: acc.bucket60 + o.bucket60,
      bucket90: acc.bucket90 + o.bucket90,
      bucket90Plus: acc.bucket90Plus + o.bucket90Plus,
    }), { pendingTotal: 0, bucket30: 0, bucket60: 0, bucket90: 0, bucket90Plus: 0 });

    return res.json({ operators, totals });
  } catch (err) { return next(err); }
});

module.exports = router;

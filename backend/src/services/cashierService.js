/**
 * cashierService.js — regras de negocio do modulo Financeiro / Caixa.
 * Usado por cashierRoutes.js (API do caixa) e tambem chamado a partir de
 * portalRoutes.js / surgeryRoutes.js quando um procedimento e assinado,
 * para gerar automaticamente a cobranca no caixa.
 */
const bcrypt = require('bcryptjs');
const { query } = require('../config/database');
const socketService = require('./socketService');

const DUMMY_PASSWORD_HASH = bcrypt.hashSync('invalid-password-placeholder', 10);

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

// Localiza o proprietario (owner) da clinica: o medico que consta em clinics.created_by.
async function getClinicOwner(clinicId) {
  if (!clinicId) return null;
  const res = await query(
    `SELECT d.id, d.email, d.password_hash
       FROM clinics c
       JOIN doctors d ON d.id = c.created_by
      WHERE c.id = $1 AND c.active = true
      LIMIT 1`,
    [clinicId]
  );
  return res.rows[0] || null;
}

/**
 * Confere e-mail + senha do proprietario da clinica.
 * Usado como autorizacao extra para lancamentos manuais no caixa.
 */
async function verifyOwnerCredentials(clinicId, email, password) {
  const normalizedEmail = normalizeEmail(email);
  if (!clinicId || !normalizedEmail || !password) {
    return { ok: false, error: 'Informe o e-mail e a senha do proprietario da clinica para autorizar.' };
  }

  const owner = await getClinicOwner(clinicId);
  const hashToCompare = owner?.password_hash || DUMMY_PASSWORD_HASH;
  const passwordOk = bcrypt.compareSync(String(password), hashToCompare);
  const emailOk = Boolean(owner) && normalizeEmail(owner.email) === normalizedEmail;

  if (!owner || !emailOk || !passwordOk) {
    return { ok: false, error: 'E-mail ou senha do proprietario invalidos.' };
  }
  return { ok: true, ownerId: owner.id };
}

// Fallback para cirurgias antigas sem clinic_id preenchido.
async function resolveClinicIdForSurgery(surgery) {
  if (surgery.clinic_id) return surgery.clinic_id;
  if (!surgery.doctor_id) return null;

  const owned = await query(
    `SELECT id FROM clinics WHERE created_by = $1 AND active = true ORDER BY created_at ASC LIMIT 1`,
    [surgery.doctor_id]
  );
  if (owned.rowCount > 0) return owned.rows[0].id;

  const member = await query(
    `SELECT clinic_id FROM clinic_members
      WHERE member_id = $1 AND member_type = 'doctor' AND active = true
      ORDER BY joined_at ASC LIMIT 1`,
    [surgery.doctor_id]
  );
  return member.rows[0]?.clinic_id || null;
}

/**
 * Gera automaticamente uma cobranca (PENDING) no caixa quando um procedimento
 * (surgery) e assinado pelo paciente, vinculando o preco cadastrado no tipo
 * de procedimento correspondente. Idempotente: nao duplica se ja existir uma
 * cobranca automatica para a mesma cirurgia.
 */
async function ensureAutoChargeForSurgery(surgeryId) {
  if (!surgeryId) return null;

  const existing = await query(
    `SELECT id FROM cash_transactions WHERE surgery_id = $1 AND origin = 'AUTO_SIGNATURE' LIMIT 1`,
    [surgeryId]
  );
  if (existing.rowCount > 0) return existing.rows[0].id;

  const surgeryRes = await query(
    `SELECT id, patient_id, doctor_id, procedure_type, title, clinic_id
       FROM surgeries WHERE id = $1 LIMIT 1`,
    [surgeryId]
  );
  const surgery = surgeryRes.rows[0];
  if (!surgery || !surgery.patient_id) return null;

  const clinicId = await resolveClinicIdForSurgery(surgery);
  if (!clinicId) return null;

  let procedureTypeId = null;
  let price = 0;
  if (surgery.procedure_type) {
    const typeRes = await query(
      `SELECT id, price FROM procedure_types
        WHERE active = true AND lower(name) = lower($1)
          AND (doctor_id = $2 OR doctor_id IS NULL)
        ORDER BY doctor_id NULLS LAST
        LIMIT 1`,
      [surgery.procedure_type, surgery.doctor_id]
    );
    if (typeRes.rowCount > 0) {
      procedureTypeId = typeRes.rows[0].id;
      price = Number(typeRes.rows[0].price || 0);
    }
  }

  const description = surgery.title || surgery.procedure_type || 'Procedimento';

  const inserted = await query(
    `INSERT INTO cash_transactions
       (clinic_id, patient_id, doctor_id, procedure_type_id, surgery_id, description, amount, status, origin, created_by_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING','AUTO_SIGNATURE','system')
     ON CONFLICT (surgery_id) WHERE origin = 'AUTO_SIGNATURE' AND surgery_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [clinicId, surgery.patient_id, surgery.doctor_id, procedureTypeId, surgery.id, description, price]
  );

  const created = inserted.rows[0] || null;
  if (created) {
    socketService.emitToClinic(clinicId, 'cash_transaction_created', { transaction: created });
  }
  return created?.id || null;
}

module.exports = {
  getClinicOwner,
  verifyOwnerCredentials,
  ensureAutoChargeForSurgery,
};

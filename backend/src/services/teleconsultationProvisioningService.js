/**
 * teleconsultationProvisioningService.js
 *
 * Cria (ou recupera, se já existir) a sessão de teleconsulta de uma
 * consulta, e envia o link por e-mail ao paciente. Extraído como serviço
 * compartilhado porque duas telas diferentes podem disparar isso:
 *   - o médico, "habilitando" uma consulta já existente na Agenda
 *   - a recepção, já marcando "é teleconsulta" no momento de criar o agendamento
 */

const crypto = require('crypto');
const { query } = require('../config/database');
const emailService = require('./emailService');
const { registrarEvento } = require('./teleconsultationAuditService');

const ACCESS_TOKEN_VALIDITY_HOURS = 24; // validade do link enviado ao paciente

function linkPaciente(accessToken) {
  const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  return `${base}/paciente/teleconsulta/${accessToken}`;
}

/**
 * Garante que existe uma teleconsultation_session para a consulta informada.
 * Idempotente: se já existir, apenas retorna a existente sem duplicar.
 *
 * @param {Object} params
 * @param {string} params.consultationId
 * @param {string|null} params.clinicId
 * @param {string} params.doctorId
 * @param {string} params.patientId
 * @param {string} params.consultationAt - ISO string do horario da consulta
 * @param {'doctor'|'system'} params.actorType - quem disparou (para auditoria)
 * @param {string|null} params.actorId
 */
async function provisionarSessao({ consultationId, clinicId, doctorId, patientId, consultationAt, actorType = 'system', actorId = null }) {
  const existente = await query(`SELECT * FROM teleconsultation_sessions WHERE consultation_id = $1`, [consultationId]);
  if (existente.rowCount > 0) {
    return { sessao: existente.rows[0], criadaAgora: false };
  }

  const accessToken = crypto.randomBytes(32).toString('hex');
  const expiraEm = new Date(new Date(consultationAt).getTime() + ACCESS_TOKEN_VALIDITY_HOURS * 60 * 60 * 1000);

  const inserted = await query(
    `INSERT INTO teleconsultation_sessions
       (consultation_id, clinic_id, doctor_id, patient_id, access_token, access_token_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [consultationId, clinicId || null, doctorId, patientId, accessToken, expiraEm.toISOString()]
  );
  const sessao = inserted.rows[0];

  await query(`UPDATE consultations SET modality = 'TELECONSULTA' WHERE id = $1`, [consultationId]);

  await registrarEvento({
    sessionId: sessao.id,
    eventType: 'sessao_criada',
    actorType,
    actorId,
  });

  return { sessao, criadaAgora: true };
}

/** Envia (best-effort) o link da sala por e-mail ao paciente. Nunca lança erro. */
async function enviarLinkPorEmail({ accessToken, patientEmail, patientName, doctorName, consultationAt }) {
  if (!patientEmail) return false;
  try {
    await emailService.sendLinkEmail({
      to: patientEmail,
      subject: `Link da sua teleconsulta com ${doctorName || 'seu medico'}`,
      message:
        `Ola, ${patientName || ''}. Sua teleconsulta esta marcada para ` +
        `${new Date(consultationAt).toLocaleString('pt-BR')}. ` +
        `Use o link abaixo alguns minutos antes do horario para entrar na sala de espera virtual. ` +
        `Nao compartilhe este link — ele e pessoal e intransferivel.`,
      link: linkPaciente(accessToken),
    });
    return true;
  } catch (err) {
    console.warn('[teleconsultation] Falha ao enviar e-mail ao paciente (nao bloqueia):', err.message);
    return false;
  }
}

module.exports = { provisionarSessao, enviarLinkPorEmail, linkPaciente };

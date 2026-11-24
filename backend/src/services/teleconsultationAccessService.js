/**
 * teleconsultationAccessService.js
 *
 * Toda a logica de "quem pode entrar em qual sala, e quando" fica
 * centralizada aqui — tanto as rotas do medico quanto as do paciente
 * chamam essas funcoes, em vez de cada rota reimplementar a propria
 * checagem de posse/janela de tempo. Isso evita que uma rota nova
 * "esqueca" uma validacao que as outras ja fazem.
 *
 * Janela de acesso: abre 15 minutos antes do horario da consulta e fecha
 * 4 horas depois (folga generosa para atrasos), ou quando o status vira
 * FINALIZADA/EXPIRADA — o que ocorrer primeiro.
 */

const { query } = require('../config/database');

const JANELA_ANTECEDENCIA_MIN = 15;
const JANELA_TOLERANCIA_HORAS = 4;

class AcessoNegadoError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.status = status;
  }
}

function dentroDaJanela(consultationAt) {
  const agora = Date.now();
  const horario = new Date(consultationAt).getTime();
  const abreEm = horario - JANELA_ANTECEDENCIA_MIN * 60 * 1000;
  const fechaEm = horario + JANELA_TOLERANCIA_HORAS * 60 * 60 * 1000;
  return agora >= abreEm && agora <= fechaEm;
}

async function carregarSessaoPorId(sessionId) {
  const result = await query(
    `SELECT ts.*, c.consultation_at, c.summary, c.modality,
            p.name AS patient_name, p.email AS patient_email,
            d.name AS doctor_name, d.email AS doctor_email, d.crm AS doctor_crm
       FROM teleconsultation_sessions ts
       JOIN consultations c ON c.id = ts.consultation_id
       JOIN patients p ON p.id = ts.patient_id
       JOIN doctors d ON d.id = ts.doctor_id
      WHERE ts.id = $1`,
    [sessionId]
  );
  return result.rows[0] || null;
}

async function carregarSessaoPorConsulta(consultationId) {
  const result = await query(
    `SELECT ts.*, c.consultation_at, c.summary, c.modality,
            p.name AS patient_name, p.email AS patient_email,
            d.name AS doctor_name, d.email AS doctor_email, d.crm AS doctor_crm
       FROM teleconsultation_sessions ts
       JOIN consultations c ON c.id = ts.consultation_id
       JOIN patients p ON p.id = ts.patient_id
       JOIN doctors d ON d.id = ts.doctor_id
      WHERE ts.consultation_id = $1`,
    [consultationId]
  );
  return result.rows[0] || null;
}

async function carregarSessaoPorToken(accessToken) {
  const result = await query(
    `SELECT ts.*, c.consultation_at, c.summary, c.modality,
            p.name AS patient_name, p.email AS patient_email,
            d.name AS doctor_name, d.email AS doctor_email, d.crm AS doctor_crm
       FROM teleconsultation_sessions ts
       JOIN consultations c ON c.id = ts.consultation_id
       JOIN patients p ON p.id = ts.patient_id
       JOIN doctors d ON d.id = ts.doctor_id
      WHERE ts.access_token = $1`,
    [accessToken]
  );
  return result.rows[0] || null;
}

/** Usado pelas rotas do medico. Garante posse (doctor_id + clinic_id) e janela de tempo. */
async function resolverSessaoParaMedico({ sessionId, consultationId, doctor }) {
  const sessao = sessionId
    ? await carregarSessaoPorId(sessionId)
    : await carregarSessaoPorConsulta(consultationId);

  if (!sessao) {
    throw new AcessoNegadoError('Sessao de teleconsulta nao encontrada.', 404);
  }
  if (sessao.doctor_id !== doctor.id) {
    throw new AcessoNegadoError('Esta teleconsulta pertence a outro medico.', 403);
  }
  if (doctor.clinicId && sessao.clinic_id && sessao.clinic_id !== doctor.clinicId) {
    throw new AcessoNegadoError('Esta teleconsulta nao pertence a clinica ativa.', 403);
  }
  if (sessao.status === 'FINALIZADA') {
    throw new AcessoNegadoError('Esta teleconsulta ja foi encerrada.', 409);
  }
  if (sessao.status === 'EXPIRADA') {
    throw new AcessoNegadoError('O prazo de acesso desta teleconsulta expirou.', 409);
  }
  return sessao;
}

/** Usado pelas rotas publicas do paciente. Garante validade do token e janela de tempo. */
async function resolverSessaoParaPaciente({ accessToken }) {
  const sessao = await carregarSessaoPorToken(accessToken);

  if (!sessao) {
    throw new AcessoNegadoError('Link invalido.', 404);
  }
  if (new Date(sessao.access_token_expires_at).getTime() < Date.now()) {
    throw new AcessoNegadoError('Este link expirou. Peca para a clinica reenviar o convite.', 410);
  }
  if (sessao.status === 'FINALIZADA') {
    throw new AcessoNegadoError('Esta teleconsulta ja foi encerrada.', 409);
  }
  if (sessao.status === 'EXPIRADA') {
    throw new AcessoNegadoError('O prazo de acesso desta teleconsulta expirou.', 410);
  }
  return sessao;
}

module.exports = {
  AcessoNegadoError,
  dentroDaJanela,
  resolverSessaoParaMedico,
  resolverSessaoParaPaciente,
  JANELA_ANTECEDENCIA_MIN,
};

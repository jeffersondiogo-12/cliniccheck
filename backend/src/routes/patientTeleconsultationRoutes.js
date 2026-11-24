const express = require('express');
const { query } = require('../config/database');
const socketService = require('../services/socketService');
const { gerarTokenSala } = require('../services/teleconsultationTokenService');
const { registrarEvento } = require('../services/teleconsultationAuditService');
const {
  AcessoNegadoError,
  dentroDaJanela,
  resolverSessaoParaPaciente,
  JANELA_ANTECEDENCIA_MIN,
} = require('../services/teleconsultationAccessService');

const router = express.Router();

// Versao do Termo de Consentimento — mude este numero sempre que o texto
// abaixo mudar de forma relevante. O texto exibido/aceito fica gravado
// junto com o consentimento (coluna e evento de auditoria), entao mesmo
// que este texto mude no futuro, o que cada paciente efetivamente leu
// continua rastreavel.
const TERMO_VERSAO = '1.0';
const TERMO_TEXTO = [
  'Ao continuar, você concorda com os termos abaixo para a realização desta teleconsulta:',
  '1. Esta consulta será realizada por videochamada, com identificação do profissional responsável (nome e CRM exibidos na tela).',
  '2. Seus dados de saúde são tratados como dados pessoais sensíveis, protegidos pela Lei Geral de Proteção de Dados (LGPD).',
  '3. Esta teleconsulta NÃO é gravada.',
  '4. As informações desta consulta serão registradas no seu prontuário eletrônico, com os mesmos critérios de uma consulta presencial, e mantidas pelo prazo exigido pela legislação médica.',
  '5. Você pode exercer seus direitos como titular de dados (acesso, correção, portabilidade, entre outros previstos na LGPD) entrando em contato diretamente com a clínica.',
  '6. É necessário autorizar o uso da câmera e do microfone do seu dispositivo para a realização da consulta.',
].join('\n');

function tratarErro(res, error, next) {
  if (error instanceof AcessoNegadoError) {
    return res.status(error.status).json({ error: error.message });
  }
  return next(error);
}

function precisaConsentimento(sessao) {
  return !sessao.patient_consent_at;
}

router.get('/:token', async (req, res, next) => {
  try {
    const sessao = await resolverSessaoParaPaciente({ accessToken: req.params.token });

    return res.json({
      status: sessao.status,
      sessionId: sessao.id,
      consultationAt: sessao.consultation_at,
      doctorName: sessao.doctor_name,
      doctorCrm: sessao.doctor_crm,
      patientName: sessao.patient_name,
      patientId: sessao.patient_id,
      clinicId: sessao.clinic_id,
      precisaConsentimento: precisaConsentimento(sessao),
      dentroDaJanela: dentroDaJanela(sessao.consultation_at),
      janelaAntecedenciaMin: JANELA_ANTECEDENCIA_MIN,
      termoVersao: TERMO_VERSAO,
      termoTexto: precisaConsentimento(sessao) ? TERMO_TEXTO : undefined,
    });
  } catch (error) {
    return tratarErro(res, error, next);
  }
});

router.post('/:token/consentimento', async (req, res, next) => {
  try {
    const sessao = await resolverSessaoParaPaciente({ accessToken: req.params.token });

    if (req.body?.aceito !== true) {
      return res.status(400).json({ error: 'É necessário aceitar o termo para continuar.' });
    }

    if (precisaConsentimento(sessao)) {
      await query(
        `UPDATE teleconsultation_sessions
            SET patient_consent_version = $1,
                patient_consent_at = now(),
                patient_consent_ip = $2,
                patient_consent_user_agent = $3
          WHERE id = $4`,
        [TERMO_VERSAO, req.ip, req.get('user-agent'), sessao.id]
      );

      await registrarEvento({
        sessionId: sessao.id,
        eventType: 'consentimento_aceito',
        actorType: 'patient',
        actorId: sessao.patient_id,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        payload: { termoVersao: TERMO_VERSAO },
      });
    }

    return res.json({ ok: true });
  } catch (error) {
    return tratarErro(res, error, next);
  }
});

/** Paciente sinaliza presenca na sala de espera (ainda sem abrir o video). */
router.post('/:token/aguardar', async (req, res, next) => {
  try {
    const sessao = await resolverSessaoParaPaciente({ accessToken: req.params.token });

    if (precisaConsentimento(sessao)) {
      return res.status(403).json({ error: 'É necessário aceitar o termo de consentimento antes.' });
    }
    if (!dentroDaJanela(sessao.consultation_at)) {
      return res.status(403).json({
        error: `A sala abre ${JANELA_ANTECEDENCIA_MIN} minutos antes do horário agendado.`,
      });
    }

    const primeiraEntrada = !sessao.patient_joined_at;
    if (primeiraEntrada) {
      await query(`UPDATE teleconsultation_sessions SET patient_joined_at = now() WHERE id = $1`, [sessao.id]);
      await registrarEvento({
        sessionId: sessao.id,
        eventType: 'paciente_aguardando',
        actorType: 'patient',
        actorId: sessao.patient_id,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
    }

    socketService.emitToDoctor(
      sessao.doctor_id,
      'teleconsultation:paciente_aguardando',
      { sessionId: sessao.id, patientName: sessao.patient_name },
      sessao.clinic_id
    );

    return res.json({ ok: true, status: sessao.status });
  } catch (error) {
    return tratarErro(res, error, next);
  }
});

/** Devolve o JWT do Jitsi — só quando o médico já iniciou a consulta. */
router.post('/:token/token-video', async (req, res, next) => {
  try {
    const sessao = await resolverSessaoParaPaciente({ accessToken: req.params.token });

    if (precisaConsentimento(sessao)) {
      return res.status(403).json({ error: 'É necessário aceitar o termo de consentimento antes.' });
    }
    if (sessao.status !== 'EM_ANDAMENTO') {
      return res.status(409).json({ error: 'O médico ainda não iniciou o atendimento.', status: sessao.status });
    }
    if (!dentroDaJanela(sessao.consultation_at)) {
      return res.status(403).json({ error: 'Fora da janela de horário permitida para esta consulta.' });
    }

    const { token, appId, domain, roomName } = gerarTokenSala({
      roomUuid: sessao.room_uuid,
      usuario: { id: sessao.patient_id, name: sessao.patient_name, email: sessao.patient_email },
      moderador: false,
    });

    await registrarEvento({
      sessionId: sessao.id,
      eventType: 'paciente_entrou_na_chamada',
      actorType: 'patient',
      actorId: sessao.patient_id,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.json({ token, appId, domain, roomName });
  } catch (error) {
    return tratarErro(res, error, next);
  }
});

module.exports = router;

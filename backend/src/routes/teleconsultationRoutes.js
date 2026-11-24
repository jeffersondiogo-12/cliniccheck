const express = require('express');
const { query } = require('../config/database');
const socketService = require('../services/socketService');
const { gerarTokenSala } = require('../services/teleconsultationTokenService');
const { registrarEvento } = require('../services/teleconsultationAuditService');
const { provisionarSessao, enviarLinkPorEmail, linkPaciente } = require('../services/teleconsultationProvisioningService');
const {
  AcessoNegadoError,
  dentroDaJanela,
  resolverSessaoParaMedico,
} = require('../services/teleconsultationAccessService');

const router = express.Router();

function tratarErro(res, error, next) {
  if (error instanceof AcessoNegadoError) {
    return res.status(error.status).json({ error: error.message });
  }
  return next(error);
}

/**
 * Ativa a teleconsulta para um agendamento existente: marca a modalidade,
 * cria a sessao (se ainda nao existir) e devolve o link do paciente.
 * Idempotente — chamar de novo numa consulta ja habilitada apenas retorna
 * a sessao existente (contanto que nao esteja finalizada).
 */
router.post('/consultations/:consultationId/enable', async (req, res, next) => {
  try {
    const { consultationId } = req.params;
    const doctor = req.doctor;

    const consultaResult = await query(
      `SELECT c.*, p.name AS patient_name, p.email AS patient_email
         FROM consultations c
         JOIN patients p ON p.id = c.patient_id
        WHERE c.id = $1 AND c.doctor_id = $2`,
      [consultationId, doctor.id]
    );
    const consulta = consultaResult.rows[0];
    if (!consulta) {
      return res.status(404).json({ error: 'Consulta nao encontrada para este medico.' });
    }
    if (doctor.clinicId && consulta.clinic_id && consulta.clinic_id !== doctor.clinicId) {
      return res.status(403).json({ error: 'Esta consulta nao pertence a clinica ativa.' });
    }
    if (!consulta.patient_email) {
      return res.status(422).json({
        error: 'Este paciente nao tem e-mail cadastrado — necessario para enviar o link seguro da teleconsulta.',
      });
    }

    const { sessao } = await provisionarSessao({
      consultationId,
      clinicId: consulta.clinic_id,
      doctorId: doctor.id,
      patientId: consulta.patient_id,
      consultationAt: consulta.consultation_at,
      actorType: 'doctor',
      actorId: doctor.id,
    });

    const emailEnviado = await enviarLinkPorEmail({
      accessToken: sessao.access_token,
      patientEmail: consulta.patient_email,
      patientName: consulta.patient_name,
      doctorName: doctor.name,
      consultationAt: consulta.consultation_at,
    });

    return res.status(201).json({
      sessionId: sessao.id,
      status: sessao.status,
      patientLink: linkPaciente(sessao.access_token),
      emailEnviado,
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/consultations/:consultationId/session', async (req, res, next) => {
  try {
    const sessao = await resolverSessaoParaMedico({
      consultationId: req.params.consultationId,
      doctor: req.doctor,
    }).catch((err) => {
      if (err instanceof AcessoNegadoError && err.status === 404) return null; // ainda nao habilitada
      throw err;
    });

    if (!sessao) {
      return res.json({ enabled: false });
    }

    return res.json({
      enabled: true,
      sessionId: sessao.id,
      status: sessao.status,
      consultationAt: sessao.consultation_at,
      patientName: sessao.patient_name,
      patientConsentAt: sessao.patient_consent_at,
      patientJoinedAt: sessao.patient_joined_at,
      doctorJoinedAt: sessao.doctor_joined_at,
      startedAt: sessao.started_at,
      endedAt: sessao.ended_at,
      dentroDaJanela: dentroDaJanela(sessao.consultation_at),
    });
  } catch (error) {
    return tratarErro(res, error, next);
  }
});

router.post('/sessions/:sessionId/token-video', async (req, res, next) => {
  try {
    const sessao = await resolverSessaoParaMedico({ sessionId: req.params.sessionId, doctor: req.doctor });

    if (!dentroDaJanela(sessao.consultation_at)) {
      return res.status(403).json({ error: 'Fora da janela de horario permitida para esta consulta.' });
    }

    const primeiraEntrada = !sessao.doctor_joined_at;
    if (primeiraEntrada) {
      await query(`UPDATE teleconsultation_sessions SET doctor_joined_at = now() WHERE id = $1`, [sessao.id]);
    }

    const { token, appId, domain, roomName } = gerarTokenSala({
      roomUuid: sessao.room_uuid,
      usuario: { id: req.doctor.id, name: sessao.doctor_name, email: sessao.doctor_email },
      moderador: true,
    });

    await registrarEvento({
      sessionId: sessao.id,
      eventType: primeiraEntrada ? 'medico_entrou' : 'medico_reentrou',
      actorType: 'doctor',
      actorId: req.doctor.id,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    if (sessao.patient_joined_at) {
      socketService.emitToPatient(sessao.patient_id, 'teleconsultation:medico_presente', { sessionId: sessao.id }, sessao.clinic_id);
    }

    return res.json({ token, appId, domain, roomName });
  } catch (error) {
    return tratarErro(res, error, next);
  }
});

router.post('/sessions/:sessionId/iniciar', async (req, res, next) => {
  try {
    const sessao = await resolverSessaoParaMedico({ sessionId: req.params.sessionId, doctor: req.doctor });

    await query(
      `UPDATE teleconsultation_sessions SET status = 'EM_ANDAMENTO', started_at = COALESCE(started_at, now()) WHERE id = $1`,
      [sessao.id]
    );

    await registrarEvento({
      sessionId: sessao.id,
      eventType: 'consulta_iniciada',
      actorType: 'doctor',
      actorId: req.doctor.id,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    socketService.emitToPatient(sessao.patient_id, 'teleconsultation:iniciada', { sessionId: sessao.id }, sessao.clinic_id);

    return res.json({ ok: true, status: 'EM_ANDAMENTO' });
  } catch (error) {
    return tratarErro(res, error, next);
  }
});

router.post('/sessions/:sessionId/finalizar', async (req, res, next) => {
  try {
    const sessao = await resolverSessaoParaMedico({ sessionId: req.params.sessionId, doctor: req.doctor });

    await query(
      `UPDATE teleconsultation_sessions SET status = 'FINALIZADA', ended_at = now() WHERE id = $1`,
      [sessao.id]
    );

    await registrarEvento({
      sessionId: sessao.id,
      eventType: 'consulta_finalizada',
      actorType: 'doctor',
      actorId: req.doctor.id,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    socketService.emitToPatient(sessao.patient_id, 'teleconsultation:finalizada', { sessionId: sessao.id }, sessao.clinic_id);

    return res.json({ ok: true, status: 'FINALIZADA' });
  } catch (error) {
    return tratarErro(res, error, next);
  }
});

router.post('/sessions/:sessionId/reenviar-link', async (req, res, next) => {
  try {
    const sessao = await resolverSessaoParaMedico({ sessionId: req.params.sessionId, doctor: req.doctor });
    const enviado = await enviarLinkPorEmail({
      accessToken: sessao.access_token,
      patientEmail: sessao.patient_email,
      patientName: sessao.patient_name,
      doctorName: sessao.doctor_name,
      consultationAt: sessao.consultation_at,
    });

    await registrarEvento({
      sessionId: sessao.id,
      eventType: 'link_reenviado',
      actorType: 'doctor',
      actorId: req.doctor.id,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      payload: { enviado },
    });

    return res.json({ ok: true, emailEnviado: enviado, patientLink: linkPaciente(sessao.access_token) });
  } catch (error) {
    return tratarErro(res, error, next);
  }
});

module.exports = router;

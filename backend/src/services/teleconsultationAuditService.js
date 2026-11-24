/**
 * teleconsultationAuditService.js
 *
 * Registro de auditoria em cadeia de hash para a teleconsulta — cada evento
 * guarda o hash do evento anterior (prev_event_hash) e o seu proprio hash
 * (event_hash), formando uma cadeia que evidencia adulteracao caso algum
 * registro seja alterado ou removido fora de ordem. Segue o mesmo principio
 * ja usado em `signature_audit_logs` para o fluxo de assinatura de
 * documentos, aplicado agora a sessao de video.
 *
 * Eventos tipicos: sessao_criada, consentimento_aceito, medico_entrou,
 * paciente_aguardando, consulta_iniciada, paciente_entrou_na_chamada,
 * consulta_finalizada, acesso_negado, token_expirado.
 */

const crypto = require('crypto');
const { query } = require('../config/database');

async function getUltimoHash(sessionId) {
  if (!sessionId) return null;
  const result = await query(
    `SELECT event_hash
       FROM teleconsultation_audit_logs
      WHERE session_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [sessionId]
  );
  return result.rows[0]?.event_hash || null;
}

function calcularHash({ prevHash, eventType, actorType, actorId, payload, createdAt }) {
  const base = JSON.stringify({ prevHash, eventType, actorType, actorId, payload: payload || null, createdAt });
  return crypto.createHash('sha256').update(base, 'utf8').digest('hex');
}

/**
 * @param {Object} params
 * @param {string|null} params.sessionId
 * @param {string} params.eventType
 * @param {'doctor'|'patient'|'system'} params.actorType
 * @param {string|null} [params.actorId]
 * @param {string|null} [params.ip]
 * @param {string|null} [params.userAgent]
 * @param {Object|null} [params.payload] - dados extras nao sensiveis (ex: versao do termo)
 */
async function registrarEvento({ sessionId, eventType, actorType, actorId = null, ip = null, userAgent = null, payload = null }) {
  const prevHash = await getUltimoHash(sessionId);
  const createdAt = new Date().toISOString();
  const eventHash = calcularHash({ prevHash, eventType, actorType, actorId, payload, createdAt });

  await query(
    `INSERT INTO teleconsultation_audit_logs
       (session_id, event_type, actor_type, actor_id, ip_address, user_agent, prev_event_hash, event_hash, payload_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [sessionId, eventType, actorType, actorId, ip, userAgent, prevHash, eventHash, payload ? JSON.stringify(payload) : null, createdAt]
  );

  return eventHash;
}

/**
 * Reconfere a cadeia de uma sessao (util para checagem manual/relatorio de
 * compliance). Retorna { valido, totalEventos, quebraNoIndice }.
 */
async function verificarCadeia(sessionId) {
  const result = await query(
    `SELECT event_type, actor_type, actor_id, payload_json, prev_event_hash, event_hash, created_at
       FROM teleconsultation_audit_logs
      WHERE session_id = $1
      ORDER BY created_at ASC, id ASC`,
    [sessionId]
  );

  let prevHash = null;
  for (let i = 0; i < result.rows.length; i += 1) {
    const row = result.rows[i];
    const esperado = calcularHash({
      prevHash,
      eventType: row.event_type,
      actorType: row.actor_type,
      actorId: row.actor_id,
      payload: row.payload_json,
      createdAt: row.created_at.toISOString ? row.created_at.toISOString() : row.created_at,
    });
    if (row.prev_event_hash !== prevHash || row.event_hash !== esperado) {
      return { valido: false, totalEventos: result.rows.length, quebraNoIndice: i };
    }
    prevHash = row.event_hash;
  }
  return { valido: true, totalEventos: result.rows.length, quebraNoIndice: null };
}

module.exports = { registrarEvento, verificarCadeia };

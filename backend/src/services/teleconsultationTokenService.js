/**
 * teleconsultationTokenService.js
 *
 * Gera o JWT assinado (RS256) exigido pelo 8x8 JaaS para abrir a sala de
 * videochamada (Jitsi) de uma teleconsulta.
 *
 * Formato verificado em:
 *   https://developer.8x8.com/jaas/docs/api-keys-jwt/
 *   https://developer.8x8.com/jaas/docs/iframe-api-integration
 *
 * Requer três variáveis de ambiente (ver .env.example):
 *   JAAS_APP_ID            -> "AppID" mostrado no console do JaaS (vpaas-magic-cookie-...)
 *   JAAS_KEY_ID             -> "Key ID" (kid) mostrado ao gerar a API Key no console do JaaS
 *   JAAS_PRIVATE_KEY_PATH  -> caminho no servidor para o arquivo .pk (chave privada RSA),
 *                              NUNCA para o conteúdo da chave em si. O arquivo não deve
 *                              ser versionado (ver .gitignore -> storage/keys/*).
 *
 * A chave privada nunca é exposta ao frontend: apenas o JWT já assinado é
 * enviado ao navegador do médico/paciente.
 */

const jwt = require('jsonwebtoken');
const fs = require('fs');

// Tempo de vida do token. É intencionalmente curto: o token é gerado sob
// demanda (quando a pessoa efetivamente entra na sala), então não precisa
// cobrir mais do que a duração razoável de uma consulta + folga.
const TOKEN_TTL_SECONDS = 4 * 60 * 60; // 4 horas

let cachedPrivateKey = null;

function getConfig() {
  const appId = process.env.JAAS_APP_ID;
  const keyId = process.env.JAAS_KEY_ID;
  const privateKeyPath = process.env.JAAS_PRIVATE_KEY_PATH;

  if (!appId || !keyId || !privateKeyPath) {
    throw new Error(
      'Configuracao do JaaS incompleta. Defina JAAS_APP_ID, JAAS_KEY_ID e JAAS_PRIVATE_KEY_PATH no .env.'
    );
  }

  // Erro comum: colar o valor "AppID/KeyID" (como aparece no console do JaaS)
  // inteiro em uma das duas variaveis, em vez de separar cada metade.
  if (appId.includes('/')) {
    throw new Error(
      `JAAS_APP_ID parece conter "AppID/KeyID" colado ("${appId}"). ` +
      `JAAS_APP_ID deve ter só a parte ANTES da barra. A parte depois da barra vai em JAAS_KEY_ID.`
    );
  }
  if (keyId.includes('/')) {
    throw new Error(
      `JAAS_KEY_ID parece conter "AppID/KeyID" colado ("${keyId}"). ` +
      `JAAS_KEY_ID deve ter só a parte DEPOIS da barra (ex: "f8004c").`
    );
  }

  return { appId, keyId, privateKeyPath };
}

function loadPrivateKey(privateKeyPath) {
  if (cachedPrivateKey) return cachedPrivateKey;
  try {
    cachedPrivateKey = fs.readFileSync(privateKeyPath, 'utf8');
  } catch (err) {
    throw new Error(
      `Nao foi possivel ler a chave privada do JaaS em "${privateKeyPath}". ` +
      `Confirme se o arquivo .pk foi colocado nesse caminho no servidor. Detalhe: ${err.message}`
    );
  }
  return cachedPrivateKey;
}

/**
 * Gera um JWT assinado, valido apenas para UMA sala especifica (room_uuid)
 * e para o papel (moderador ou nao) resolvido no backend a partir da sessao
 * autenticada de quem esta pedindo o token — nunca a partir de um valor
 * enviado pelo cliente.
 *
 * @param {Object} params
 * @param {string} params.roomUuid   - identificador único da sala (nossa coluna room_uuid)
 * @param {Object} params.usuario    - { id, name, email }
 * @param {boolean} params.moderador - true para o médico, false para o paciente
 * @returns {{ token: string, appId: string, roomName: string, domain: string }}
 */
function gerarTokenSala({ roomUuid, usuario, moderador }) {
  const { appId, keyId, privateKeyPath } = getConfig();
  const privateKey = loadPrivateKey(privateKeyPath);

  const agora = Math.floor(Date.now() / 1000);

  const payload = {
    aud: 'jitsi',
    iss: 'chat',
    sub: appId,
    room: roomUuid,
    exp: agora + TOKEN_TTL_SECONDS,
    nbf: agora - 5, // pequena folga para relógios levemente dessincronizados
    context: {
      user: {
        id: String(usuario.id),
        name: usuario.name || 'Participante',
        email: usuario.email || '',
        avatar: '',
        moderator: moderador === true,
      },
      // Por padrão NENHUM recurso sensível é liberado. Gravação/streaming
      // ficam desligados propositalmente (ver LGPD_TELEMEDICINA.md, secao
      // "Gravacao das consultas").
      features: {
        livestreaming: false,
        recording: false,
        transcription: false,
        'outbound-call': false,
        'inbound-call': false,
        'sip-inbound-call': false,
        'sip-outbound-call': false,
        'file-upload': false,
      },
      room: { regex: false },
    },
  };

  const token = jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    // O "kid" precisa ser "<AppID>/<KeyID>" — confirmado na documentacao oficial.
    keyid: `${appId}/${keyId}`,
  });

  const roomName = `${appId}/${roomUuid}`;
  console.log(`[teleconsultation] Sala gerada: ${roomName}`);

  return {
    token,
    appId,
    domain: '8x8.vc',
    // roomName no formato exigido pelo IFrame API: "<AppID>/<room>"
    roomName,
  };
}

module.exports = { gerarTokenSala };

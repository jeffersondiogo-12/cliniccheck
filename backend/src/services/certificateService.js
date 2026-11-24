const { query } = require('../config/database');
const { decryptText, encryptText } = require('./secretCryptoService');

function getOAuthConfig() {
  return {
    authorizeUrl: process.env.PSC_OAUTH_AUTHORIZE_URL || '',
    tokenUrl: process.env.PSC_OAUTH_TOKEN_URL || '',
    clientId: process.env.PSC_CLIENT_ID || '',
    clientSecret: process.env.PSC_CLIENT_SECRET || '',
    redirectUri: process.env.PSC_REDIRECT_URI || '',
    scope: process.env.PSC_OAUTH_SCOPE || 'signature openid profile',
    providerName: process.env.PSC_PROVIDER_NAME || 'VIDAAS_CFM',
  };
}

function buildOAuthState({ doctorId, providerType }) {
  const payload = {
    doctorId,
    providerType,
    nonce: Math.random().toString(36).slice(2),
    ts: Date.now(),
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function parseOAuthState(state) {
  const decoded = Buffer.from(String(state || ''), 'base64url').toString('utf8');
  const payload = JSON.parse(decoded);
  if (!payload.doctorId || !payload.providerType) {
    throw new Error('State inválido');
  }
  return payload;
}

async function exchangeAuthorizationCode(code) {
  const cfg = getOAuthConfig();
  if (!cfg.tokenUrl || !cfg.clientId || !cfg.clientSecret || !cfg.redirectUri) {
    throw new Error('Configuração OAuth incompleta para PSC');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
  });

  const response = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Falha ao trocar code por token: ${response.status}`);
  }

  return response.json();
}

async function refreshAccessToken(certRow) {
  const cfg = getOAuthConfig();
  if (!cfg.tokenUrl || !cfg.clientId || !cfg.clientSecret) {
    throw new Error('Configuração OAuth incompleta para refresh');
  }
  if (!certRow?.refresh_token_encrypted) {
    throw new Error('Refresh token ausente');
  }

  const refreshToken = decryptText(certRow.refresh_token_encrypted);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });

  const response = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Falha no refresh de token: ${response.status}`);
  }

  const data = await response.json();
  await saveDoctorCertificateTokens({
    doctorId: certRow.doctor_id,
    providerType: certRow.provider_type,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in,
    scope: data.scope || certRow.scopes || null,
    providerSubject: data.subject || null,
    providerAccountId: data.account_id || null,
    status: 'CONNECTED',
  });

  return data.access_token;
}

async function saveDoctorCertificateTokens({
  doctorId,
  providerType,
  accessToken,
  refreshToken,
  expiresIn,
  scope,
  providerSubject,
  providerAccountId,
  status,
}) {
  const expiresAt = expiresIn ? new Date(Date.now() + (Number(expiresIn) * 1000)).toISOString() : null;

  await query(
    `INSERT INTO doctor_certificates (
       doctor_id,
       provider_type,
       status,
       provider_subject,
       provider_account_id,
       access_token_encrypted,
       refresh_token_encrypted,
       token_expires_at,
       scopes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (doctor_id) DO UPDATE
     SET provider_type = EXCLUDED.provider_type,
         status = EXCLUDED.status,
         provider_subject = COALESCE(EXCLUDED.provider_subject, doctor_certificates.provider_subject),
         provider_account_id = COALESCE(EXCLUDED.provider_account_id, doctor_certificates.provider_account_id),
         access_token_encrypted = EXCLUDED.access_token_encrypted,
         refresh_token_encrypted = COALESCE(EXCLUDED.refresh_token_encrypted, doctor_certificates.refresh_token_encrypted),
         token_expires_at = EXCLUDED.token_expires_at,
         scopes = COALESCE(EXCLUDED.scopes, doctor_certificates.scopes),
         updated_at = now()`,
    [
      doctorId,
      providerType,
      status || 'CONNECTED',
      providerSubject || null,
      providerAccountId || null,
      encryptText(accessToken),
      refreshToken ? encryptText(refreshToken) : null,
      expiresAt,
      scope || null,
    ]
  );
}

async function getDoctorCertificate(doctorId) {
  const cert = await query(
    `SELECT *
     FROM doctor_certificates
     WHERE doctor_id = $1
     LIMIT 1`,
    [doctorId]
  );
  return cert.rows[0] || null;
}

async function getValidDoctorAccessToken(doctorId) {
  const certRow = await getDoctorCertificate(doctorId);
  if (!certRow || !certRow.access_token_encrypted) {
    return null;
  }

  const nowMs = Date.now();
  const expiresAtMs = certRow.token_expires_at ? new Date(certRow.token_expires_at).getTime() : null;

  if (!expiresAtMs || expiresAtMs - nowMs > 60 * 1000) {
    return decryptText(certRow.access_token_encrypted);
  }

  if (!certRow.refresh_token_encrypted) {
    await query(
      `UPDATE doctor_certificates
       SET status = 'EXPIRED',
           updated_at = now()
       WHERE doctor_id = $1`,
      [doctorId]
    );
    return null;
  }

  try {
    return await refreshAccessToken(certRow);
  } catch (_err) {
    await query(
      `UPDATE doctor_certificates
       SET status = 'ERROR',
           updated_at = now()
       WHERE doctor_id = $1`,
      [doctorId]
    );
    return null;
  }
}

function buildConnectUrl({ state }) {
  const cfg = getOAuthConfig();
  if (!cfg.authorizeUrl || !cfg.clientId || !cfg.redirectUri) {
    throw new Error('Configuração OAuth incompleta para URL de autorização');
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scope,
    state,
  });

  return `${cfg.authorizeUrl}?${params.toString()}`;
}

module.exports = {
  buildOAuthState,
  parseOAuthState,
  exchangeAuthorizationCode,
  saveDoctorCertificateTokens,
  getDoctorCertificate,
  getValidDoctorAccessToken,
  buildConnectUrl,
  getOAuthConfig,
};

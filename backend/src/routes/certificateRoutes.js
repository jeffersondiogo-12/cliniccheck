const express = require('express');
const { requireDoctor } = require('../middleware/auth');
const {
  buildOAuthState,
  parseOAuthState,
  exchangeAuthorizationCode,
  saveDoctorCertificateTokens,
  getDoctorCertificate,
  buildConnectUrl,
  getOAuthConfig,
} = require('../services/certificateService');
const multer = require('multer');
const { readCertificateFromBuffer } = require('../services/certificateReaderService');

// Upload em memória (sem salvar arquivo no disco)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(pfx|p12|cer|pem|crt)$/i;
    if (!allowed.test(file.originalname)) {
      return cb(new Error('Tipo de arquivo não permitido. Use .pfx, .p12, .cer ou .pem'));
    }
    cb(null, true);
  },
});

const router = express.Router();

router.get('/me', requireDoctor, async (req, res, next) => {
  try {
    const cert = await getDoctorCertificate(req.doctor.id);
    return res.json({
      connected: Boolean(cert && cert.status === 'CONNECTED' && cert.access_token_encrypted),
      certificate: cert
        ? {
            providerType: cert.provider_type,
            status: cert.status,
            providerSubject: cert.provider_subject,
            providerAccountId: cert.provider_account_id,
            tokenExpiresAt: cert.token_expires_at,
            updatedAt: cert.updated_at,
          }
        : null,
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/connect', requireDoctor, async (req, res, next) => {
  try {
    const cfg = getOAuthConfig();
    const providerType = String(req.query.provider || cfg.providerName || 'VIDAAS_CFM');
    const state = buildOAuthState({
      doctorId: req.doctor.id,
      providerType,
    });

    const connectUrl = buildConnectUrl({ state });
    return res.json({ connectUrl, providerType });
  } catch (error) {
    return next(error);
  }
});

router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const successRedirect = process.env.PSC_CONNECT_SUCCESS_REDIRECT || '/medico?cert=connected';
  const failRedirect = process.env.PSC_CONNECT_FAIL_REDIRECT || '/medico?cert=error';

  if (error) {
    return res.redirect(`${failRedirect}&reason=${encodeURIComponent(String(error))}`);
  }

  if (!code || !state) {
    return res.redirect(`${failRedirect}&reason=missing_code_or_state`);
  }

  try {
    const statePayload = parseOAuthState(state);
    const tokenData = await exchangeAuthorizationCode(code);

    await saveDoctorCertificateTokens({
      doctorId: statePayload.doctorId,
      providerType: statePayload.providerType,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresIn: tokenData.expires_in,
      scope: tokenData.scope || null,
      providerSubject: tokenData.subject || tokenData.sub || null,
      providerAccountId: tokenData.account_id || tokenData.user_id || null,
      status: 'CONNECTED',
    });

    return res.redirect(successRedirect);
  } catch (_error) {
    return res.redirect(`${failRedirect}&reason=oauth_callback_failed`);
  }
});

// ── LEITURA LOCAL DE CERTIFICADO (gratuito, sem serviço externo) ──

/**
 * POST /api/certificates/read
 * Recebe um arquivo .pfx/.p12/.cer/.pem e retorna os dados do certificado.
 * O arquivo nunca é salvo no disco — processado em memória.
 * Campo "password" é opcional (necessário apenas para .pfx/.p12).
 */
router.post('/read', requireDoctor, upload.single('certificate'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado. Use o campo "certificate".' });
  }

  const password = String(req.body.password || '');
  const result = readCertificateFromBuffer(req.file.buffer, req.file.originalname, password);

  if (!result.valid) {
    return res.status(422).json({ error: result.error || 'Não foi possível ler o certificado.' });
  }

  return res.json(result);
});

/**
 * POST /api/certificates/read-public
 * Versão sem autenticação para uso no frontend de assinatura do paciente.
 * Útil para exibir dados do certificado antes de assinar.
 * Apenas .cer/.pem (sem senha) — não aceita .pfx para evitar exposição de chave privada.
 */
router.post('/read-public', requireDoctor, upload.single('certificate'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const ext = (req.file.originalname || '').toLowerCase().split('.').pop();
  if (ext === 'pfx' || ext === 'p12') {
    return res.status(400).json({ error: 'Não é permitido enviar .pfx/.p12 neste endpoint. Use /read com autenticação.' });
  }

  const result = readCertificateFromBuffer(req.file.buffer, req.file.originalname, '');
  if (!result.valid) {
    return res.status(422).json({ error: result.error });
  }

  return res.json(result);
});

// ── WEB PKI LOCAL — memorizar certificado do médico ──────────────────────────

/**
 * POST /api/certificates/webpki/save
 * Salva o thumbprint + dados públicos do certificado selecionado via Web PKI.
 * O thumbprint é criptografado no banco como se fosse um access_token.
 * Body: { thumbprint, commonName, expiresAt, subjectDn }
 */
router.post('/webpki/save', requireDoctor, async (req, res, next) => {
  try {
    const { thumbprint, commonName, expiresAt, subjectDn } = req.body;

    if (!thumbprint || typeof thumbprint !== 'string' || thumbprint.length < 10) {
      return res.status(400).json({ error: 'thumbprint inválido.' });
    }

    await saveDoctorCertificateTokens({
      doctorId: req.doctor.id,
      providerType: 'WEBPKI_LOCAL',
      accessToken: thumbprint,           // thumbprint criptografado no banco
      refreshToken: null,
      expiresIn: expiresAt
        ? Math.floor((new Date(expiresAt) - Date.now()) / 1000)
        : null,
      scope: null,
      providerSubject: subjectDn || commonName || null,
      providerAccountId: commonName || null,
      status: 'CONNECTED',
    });

    return res.json({ ok: true, commonName, expiresAt });
  } catch (error) {
    return next(error);
  }
});

/**
 * DELETE /api/certificates/webpki/remove
 * Remove o certificado memorizado do médico.
 */
router.delete('/webpki/remove', requireDoctor, async (req, res, next) => {
  try {
    const { query } = require('../config/database');
    await query(
      `UPDATE doctor_certificates SET status = 'DISCONNECTED', access_token_encrypted = NULL, provider_type = 'WEBPKI_LOCAL', updated_at = now() WHERE doctor_id = $1`,
      [req.doctor.id]
    );
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

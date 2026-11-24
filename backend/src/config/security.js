function normalizeBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeAllowedOrigins(raw) {
  if (!raw || !String(raw).trim()) return [];
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getJwtSecret() {
  const envSecret = process.env.JWT_SECRET;
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && !envSecret) {
    throw new Error('JWT_SECRET não configurado em produção. Defina JWT_SECRET antes de iniciar o servidor.');
  }

  if (!envSecret) {
    // Somente para ambiente local de desenvolvimento.
    return 'dev-secret-INSEGURO-configure-JWT_SECRET';
  }

  if (envSecret.length < 32) {
    console.warn('[SEGURANÇA] JWT_SECRET muito curto. Recomenda-se pelo menos 32 caracteres.');
  }

  return envSecret;
}

function getSecurityConfig() {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    isProduction,
    forceHttps: normalizeBoolean(process.env.FORCE_HTTPS, isProduction),
    trustProxy: normalizeBoolean(process.env.TRUST_PROXY, true),
    allowedOrigins: normalizeAllowedOrigins(process.env.ALLOWED_ORIGINS),
  };
}

module.exports = {
  getJwtSecret,
  getSecurityConfig,
};
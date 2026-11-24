const crypto = require('crypto');

function getCipherKey() {
  const raw = process.env.CERT_TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET;
  const isProduction = process.env.NODE_ENV === 'production';

  if (!raw && isProduction) {
    throw new Error('CERT_TOKEN_ENCRYPTION_KEY/JWT_SECRET não configurado em produção para criptografia de tokens.');
  }

  const keyMaterial = raw || 'dev-cert-token-key-INSEGURO-configure-em-producao';
  return crypto.createHash('sha256').update(String(keyMaterial), 'utf8').digest();
}

function encryptText(value) {
  if (!value) return null;

  const iv = crypto.randomBytes(12);
  const key = getCipherKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('base64')}.${authTag.toString('base64')}.${encrypted.toString('base64')}`;
}

function decryptText(payload) {
  if (!payload) return null;

  const [ivBase64, authTagBase64, encryptedBase64] = String(payload).split('.');
  if (!ivBase64 || !authTagBase64 || !encryptedBase64) {
    throw new Error('Formato de token criptografado inválido');
  }

  const iv = Buffer.from(ivBase64, 'base64');
  const authTag = Buffer.from(authTagBase64, 'base64');
  const encrypted = Buffer.from(encryptedBase64, 'base64');
  const key = getCipherKey();

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = {
  encryptText,
  decryptText,
};

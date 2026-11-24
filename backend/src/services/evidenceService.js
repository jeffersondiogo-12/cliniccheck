const fs = require('fs');
const crypto = require('crypto');
const { getValidDoctorAccessToken } = require('./certificateService');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function sha256File(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function requestTrustedTimestamp(hashHex) {
  const endpoint = process.env.TSA_ENDPOINT;
  const mockMode = process.env.TSA_MOCK_MODE === 'true';
  if (!endpoint) return null;

  const payload = {
    hash: hashHex,
    hashAlgorithm: 'SHA-256',
    source: 'clinica-aline',
  };

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.TSA_API_KEY) {
    headers.Authorization = `Bearer ${process.env.TSA_API_KEY}`;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    if (mockMode) {
      return {
        provider: 'tsa-mock',
        token: `mock-tsa-${hashHex.slice(0, 16)}`,
        timestampAt: new Date().toISOString(),
      };
    }
    throw new Error(`TSA request failed with status ${response.status}`);
  }

  const data = await response.json().catch(() => ({}));
  return {
    provider: data.provider || 'external-tsa',
    token: data.token || data.timestampToken || null,
    timestampAt: data.timestampAt || data.time || new Date().toISOString(),
  };
}

async function requestQualifiedSignature({ documentHash, signerName, signerDocumentId, doctorId }) {
  const endpoint = process.env.QUALIFIED_SIGNATURE_ENDPOINT;
  if (!endpoint) return null;

  const headers = { 'Content-Type': 'application/json' };
  const doctorAccessToken = doctorId ? await getValidDoctorAccessToken(doctorId) : null;

  if (doctorAccessToken) {
    headers.Authorization = `Bearer ${doctorAccessToken}`;
  } else if (process.env.QUALIFIED_SIGNATURE_API_KEY) {
    headers.Authorization = `Bearer ${process.env.QUALIFIED_SIGNATURE_API_KEY}`;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      documentHash,
      signerName,
      signerDocumentId: signerDocumentId || null,
      standard: 'ICP-Brasil',
      profile: process.env.QUALIFIED_SIGNATURE_PROFILE || 'AD-RB',
    }),
  });

  if (!response.ok) {
    throw new Error(`Qualified signature request failed with status ${response.status}`);
  }

  const data = await response.json().catch(() => ({}));
  return {
    provider: data.provider || 'qualified-sign-provider',
    ref: data.reference || data.protocol || data.transactionId || null,
  };
}

module.exports = {
  sha256,
  sha256File,
  requestTrustedTimestamp,
  requestQualifiedSignature,
};

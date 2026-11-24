const { RestPkiClient } = require('restpki-client');
const fs = require('fs');
const crypto = require('crypto');

function getLacunaClient() {
  const endpoint = process.env.LACUNA_RESTPKI_ENDPOINT || 'https://pki.rest/';
  const token = process.env.LACUNA_RESTPKI_TOKEN;

  if (!token) {
    throw new Error('LACUNA_RESTPKI_TOKEN não configurado no ambiente');
  }

  return new RestPkiClient(endpoint, token);
}

async function validateConnection() {
  try {
    const client = getLacunaClient();
    const result = await client.getRestPkiVersion();
    console.log('[Lacuna] Conectado com sucesso:', result);
    return { connected: true, version: result };
  } catch (error) {
    console.error('[Lacuna] Falha na conexão:', error.message);
    return { connected: false, error: error.message };
  }
}

async function initiatePdfSignature({ pdfPath, signerEmail, signerName }) {
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`Arquivo PDF não encontrado: ${pdfPath}`);
  }

  const client = getLacunaClient();
  const pdfContent = fs.readFileSync(pdfPath);
  const pdfBase64 = pdfContent.toString('base64');

  const signatureRequest = {
    pdfToSign: pdfBase64,
    signatureStarter: {
      elementId: 'signature1',
      reason: 'Consentimento informado para procedimento médico',
      location: 'Sistema Clínico - Clínica Aline',
      visualElements: [
        {
          type: 'signerInitials',
          page: -1,
          x: 7.5,
          y: 4.5,
          width: 2,
          height: 1,
        },
      ],
    },
    callbackArgument: {
      doctorEmail: signerEmail,
      doctorName: signerName,
      timestamp: new Date().toISOString(),
    },
  };

  const result = await client.getPadesSignatureStarter(signatureRequest);
  return {
    transferFile: result.transferFile,
    toSignHash: result.toSignHash,
    digestAlgorithm: result.digestAlgorithm || 'SHA256',
  };
}

async function completePdfSignature({ transferFile, signature }) {
  const client = getLacunaClient();

  const completeRequest = {
    transferFile,
    signature: signature,
  };

  const result = await client.completePadesSignature(completeRequest);

  return {
    signedPdfPath: result.outputFile,
    certificateChain: result.certificateChain,
    signerCertificate: result.signerCertificate,
    signatureInfo: {
      signingTime: result.signingTime,
      messageDigest: result.messageDigest,
      encryptedDigest: result.encryptedDigest,
    },
  };
}

async function getSignatureInfo({ pdfPath }) {
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`Arquivo PDF não encontrado: ${pdfPath}`);
  }

  const client = getLacunaClient();
  const pdfContent = fs.readFileSync(pdfPath);
  const pdfBase64 = pdfContent.toString('base64');

  const result = await client.getSignatureInfo({
    pdfToValidate: pdfBase64,
  });

  return {
    isValid: result.isValid,
    signerNames: result.signers?.map((s) => s.name) || [],
    signingTimes: result.signers?.map((s) => s.signingTime) || [],
    certificateChains: result.certificateChains || [],
  };
}

async function hashPdfForRemoteSignature({ pdfPath }) {
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`Arquivo PDF não encontrado: ${pdfPath}`);
  }

  const pdfContent = fs.readFileSync(pdfPath);
  const hash = crypto.createHash('sha256').update(pdfContent).digest('hex');

  return {
    pdfHash: hash,
    algorithm: 'SHA256',
    pdfSize: pdfContent.length,
  };
}

module.exports = {
  validateConnection,
  initiatePdfSignature,
  completePdfSignature,
  getSignatureInfo,
  hashPdfForRemoteSignature,
  getLacunaClient,
};

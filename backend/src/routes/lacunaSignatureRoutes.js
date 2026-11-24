const express = require('express');
const { requireDoctor } = require('../middleware/auth');
const {
  validateConnection,
  initiatePdfSignature,
  completePdfSignature,
  getSignatureInfo,
  hashPdfForRemoteSignature,
} = require('../services/lacunaSignatureService');

const router = express.Router();

router.get('/health', requireDoctor, async (_req, res, next) => {
  try {
    const result = await validateConnection();
    if (result.connected) {
      return res.json({ status: 'ok', message: 'Lacuna Rest PKI conectado', version: result.version });
    }
    return res.status(503).json({ status: 'error', message: result.error });
  } catch (error) {
    return next(error);
  }
});

router.post('/initiate', requireDoctor, async (req, res, next) => {
  try {
    const { pdfPath, signerEmail, signerName } = req.body;

    if (!pdfPath) {
      return res.status(400).json({ error: 'pdfPath é obrigatório' });
    }

    const result = await initiatePdfSignature({
      pdfPath,
      signerEmail: signerEmail || req.doctor.email,
      signerName: signerName || req.doctor.name,
    });

    return res.json({
      transferFile: result.transferFile,
      toSignHash: result.toSignHash,
      digestAlgorithm: result.digestAlgorithm,
      message: 'Assinatura iniciada. Envie o hash assinado para completar.',
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/complete', requireDoctor, async (req, res, next) => {
  try {
    const { transferFile, signature } = req.body;

    if (!transferFile || !signature) {
      return res.status(400).json({ error: 'transferFile e signature são obrigatórios' });
    }

    const result = await completePdfSignature({
      transferFile,
      signature,
    });

    return res.json({
      message: 'Assinatura completada com sucesso',
      signedPdfPath: result.signedPdfPath,
      signerCertificate: result.signerCertificate,
      signatureInfo: result.signatureInfo,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/verify', requireDoctor, async (req, res, next) => {
  try {
    const { pdfPath } = req.body;

    if (!pdfPath) {
      return res.status(400).json({ error: 'pdfPath é obrigatório' });
    }

    const result = await getSignatureInfo({ pdfPath });

    return res.json({
      isValid: result.isValid,
      signerNames: result.signerNames,
      signingTimes: result.signingTimes,
      certificateCount: result.certificateChains?.length || 0,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/hash', requireDoctor, async (req, res, next) => {
  try {
    const { pdfPath } = req.body;

    if (!pdfPath) {
      return res.status(400).json({ error: 'pdfPath é obrigatório' });
    }

    const result = await hashPdfForRemoteSignature({ pdfPath });

    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

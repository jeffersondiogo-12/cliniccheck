const express = require('express');
const fs = require('fs');
const path = require('path');
const { query } = require('../config/database');
const socketService = require('../services/socketService');
const { sha256, sha256File, requestTrustedTimestamp, requestQualifiedSignature } = require('../services/evidenceService');
const { classifyProcedure } = require('../services/compliancePolicyService');
const { buildEvidenceSummary } = require('../services/complianceEvidenceService');
const { ensureAutoChargeForSurgery } = require('../services/cashierService');

const router = express.Router();
const columnCache = new Map();
const MAX_FACE_IMAGE_BYTES = 3 * 1024 * 1024;

async function logAuditEvent(documentId, eventType, req, payload = null) {
  try {
    const [hasPrevEventHash, hasEventHash, hasCreatedAt] = await Promise.all([
      hasColumn('signature_audit_logs', 'prev_event_hash'),
      hasColumn('signature_audit_logs', 'event_hash'),
      hasColumn('signature_audit_logs', 'created_at'),
    ]);

    const prev = await query(
      `SELECT event_hash
       FROM signature_audit_logs
       WHERE document_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [documentId]
    );

    const prevEventHash = prev.rows[0]?.event_hash || null;
    const createdAt = new Date().toISOString();
    const serializedPayload = payload ? JSON.stringify(payload) : null;
    const eventHash = sha256(
      `${documentId}|${eventType}|${req.ip || ''}|${req.get('user-agent') || ''}|${serializedPayload || ''}|${createdAt}|${prevEventHash || ''}`
    );

    const cols = ['document_id', 'event_type', 'ip_address', 'user_agent', 'payload_json'];
    const vals = [documentId, eventType, req.ip || null, req.get('user-agent') || null, serializedPayload];
    if (hasPrevEventHash) {
      cols.push('prev_event_hash');
      vals.push(prevEventHash);
    }
    if (hasEventHash) {
      cols.push('event_hash');
      vals.push(eventHash);
    }
    if (hasCreatedAt) {
      cols.push('created_at');
      vals.push(createdAt);
    }

    const placeholders = vals.map((_, idx) => (cols[idx] === 'payload_json' ? `$${idx + 1}::jsonb` : `$${idx + 1}`));
    await query(`INSERT INTO signature_audit_logs (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`, vals);
  } catch (err) {
    if (err.code !== '42P01') {
      console.warn('[Audit] Falha ao registrar auditoria:', err.message);
    }
  }
}

async function hasColumn(tableName, columnName) {
  const cacheKey = `${tableName}.${columnName}`;
  if (columnCache.has(cacheKey)) return columnCache.get(cacheKey);

  const found = await query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  const exists = found.rowCount > 0;
  columnCache.set(cacheKey, exists);
  return exists;
}

function isExpiredDocument(doc) {
  return Boolean(doc?.expires_at) && new Date(doc.expires_at) < new Date();
}

function estimateBase64Bytes(base64Value) {
  const clean = String(base64Value || '').replace(/\s/g, '');
  if (!clean) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

router.get('/assinatura/:token', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT sd.*, p.name AS patient_name, p.document_id, d.name AS doctor_name, d.crm,
              s.title AS surgery_title, s.hospital, s.scheduled_at
       FROM surgery_documents sd
       INNER JOIN patients p ON p.id = sd.patient_id
       INNER JOIN doctors d ON d.id = sd.doctor_id
       INNER JOIN surgeries s ON s.id = sd.surgery_id
       WHERE sd.access_token = $1`,
      [req.params.token]
    );

    const doc = result.rows[0];
    if (!doc) {
      return res.status(404).send('Documento nao encontrado.');
    }

    if (doc.expires_at && new Date(doc.expires_at) < new Date()) {
      return res.status(410).send('Link expirado.');
    }

    return res.render('patient-sign', { token: req.params.token, doc });
  } catch (error) {
    return next(error);
  }
});

// Endpoint JSON para buscar dados do documento (usado pelo patient-sign.ejs client-side)
router.get('/api/patient/document/:token', async (req, res, next) => {
  try {
    const [hasRequireQualifiedSignature, hasProcedureClassification, hasReferenceFacePath] = await Promise.all([
      hasColumn('surgeries', 'require_qualified_signature'),
      hasColumn('surgeries', 'procedure_classification'),
      hasColumn('patients', 'reference_face_path'),
    ]);
    const requireQualifiedSelect = hasRequireQualifiedSignature
      ? 's.require_qualified_signature'
      : 'NULL::boolean AS require_qualified_signature';
    const procedureClassificationSelect = hasProcedureClassification
      ? 's.procedure_classification'
      : 'NULL::text AS procedure_classification';
    const referenceFaceSelect = hasReferenceFacePath
      ? 'p.reference_face_path'
      : 'NULL::text AS reference_face_path';

    // Tenta buscar com reference_face_path; se a coluna não existir ainda, faz fallback sem ela
    let result;
    try {
      result = await query(
        `SELECT sd.*, p.name AS patient_name, p.reference_face_path,
                s.title AS procedure_name, s.procedure_type, s.title AS surgery_title,
                ${requireQualifiedSelect}, ${procedureClassificationSelect}
         FROM surgery_documents sd
         INNER JOIN patients p ON p.id = sd.patient_id
         INNER JOIN surgeries s ON s.id = sd.surgery_id
         WHERE sd.access_token = $1`,
        [req.params.token]
      );
    } catch (colErr) {
      if (colErr.code === '42703') {
        result = await query(
          `SELECT sd.*, p.name AS patient_name, NULL::text AS reference_face_path,
                  s.title AS procedure_name, s.procedure_type, s.title AS surgery_title,
                  ${requireQualifiedSelect}, ${procedureClassificationSelect}
           FROM surgery_documents sd
           INNER JOIN patients p ON p.id = sd.patient_id
           INNER JOIN surgeries s ON s.id = sd.surgery_id
           WHERE sd.access_token = $1`,
          [req.params.token]
        );
      } else {
        throw colErr;
      }
    }
    const doc = result.rows[0];
    if (!doc) return res.status(404).json({ error: 'Documento nao encontrado' });
    if (isExpiredDocument(doc)) return res.status(410).json({ error: 'Link expirado' });

    const evidenceSummary = buildEvidenceSummary(doc, {
      procedureType: doc.procedure_type,
      title: doc.procedure_name,
      requireQualifiedSignature: doc.require_qualified_signature,
      procedureClassification: doc.procedure_classification,
    });

    return res.json({
      title: doc.title,
      content: doc.content_html,
      status: doc.status,
      signed_at: doc.signed_at || null,
      patient_name: doc.patient_name,
      procedure_name: doc.procedure_name,
      reference_face: doc.reference_face_path || null,
      pages_read: doc.pages_read || 0,
      total_pages: doc.total_pages || 0,
      require_qualified_signature: evidenceSummary.qualifiedSignature.required,
      procedure_classification: evidenceSummary.procedureClassification,
      evidence_summary: evidenceSummary,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/patient/progress/:token', async (req, res, next) => {
  try {
    const token = req.params.token;
    // Aceita tanto 'currentPage' quanto 'page' (legado)
    const { totalPages, currentPage, page } = req.body;
    const pageValue = currentPage || page;

    const parsedTotalPages = Number(totalPages);
    const parsedCurrentPage = Number(pageValue);

    if (!Number.isFinite(parsedTotalPages) || !Number.isFinite(parsedCurrentPage)) {
      return res.status(400).json({ error: 'totalPages e currentPage devem ser numeros' });
    }

    if (parsedTotalPages < 1 || parsedCurrentPage < 1) {
      return res.status(400).json({ error: 'Valores de pagina invalidos' });
    }

    const docResult = await query(
      'SELECT id, total_pages, pages_read FROM surgery_documents WHERE access_token = $1',
      [token]
    );
    const doc = docResult.rows[0];

    if (!doc) {
      return res.status(404).json({ error: 'Documento nao encontrado' });
    }
    if (isExpiredDocument(doc)) {
      return res.status(410).json({ error: 'Link expirado' });
    }

    const totalPagesSaved = Math.max(Number(doc.total_pages || 1), parsedTotalPages);
    const pagesReadSaved = Math.max(Number(doc.pages_read || 0), Math.min(parsedCurrentPage, totalPagesSaved));
    const readCompletedAt = pagesReadSaved >= totalPagesSaved ? new Date().toISOString() : null;

    await query(
      `UPDATE surgery_documents
       SET total_pages = $1,
           pages_read = $2,
           read_completed_at = COALESCE($3, read_completed_at)
       WHERE id = $4`,
      [totalPagesSaved, pagesReadSaved, readCompletedAt, doc.id]
    );

    await logAuditEvent(doc.id, 'READ_PROGRESS', req, {
      totalPages: totalPagesSaved,
      pagesRead: pagesReadSaved,
      completed: pagesReadSaved >= totalPagesSaved,
    });

    return res.json({
      totalPages: totalPagesSaved,
      pagesRead: pagesReadSaved,
      completed: pagesReadSaved >= totalPagesSaved,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/api/patient/sign/:token', async (req, res, next) => {
  try {
    // Aceita tanto 'faceImage' (novo) quanto 'faceImageBase64' (legado)
    const {
      signatureName,
      faceImage,
      faceImageBase64,
      lgpdPolicyVersion,
      legalTermsVersion,
      riskAckText,
      confirmations,
      requireQualifiedSignature,
    } = req.body;
    const faceData = faceImage || faceImageBase64;
    const token = req.params.token;

    const [hasRequireQualifiedSignature, hasProcedureClassification, hasReferenceFacePath] = await Promise.all([
      hasColumn('surgeries', 'require_qualified_signature'),
      hasColumn('surgeries', 'procedure_classification'),
      hasColumn('patients', 'reference_face_path'),
    ]);
    const requireQualifiedSelect = hasRequireQualifiedSignature
      ? 's.require_qualified_signature'
      : 'NULL::boolean AS require_qualified_signature';
    const procedureClassificationSelect = hasProcedureClassification
      ? 's.procedure_classification'
      : 'NULL::text AS procedure_classification';
    const referenceFaceSelect = hasReferenceFacePath
      ? 'p.reference_face_path'
      : 'NULL::text AS reference_face_path';

    if (!signatureName) {
      return res.status(400).json({ error: 'Nome de assinatura obrigatorio' });
    }

    const docResult = await query(
      `SELECT sd.*, s.procedure_type, s.title AS surgery_title, p.document_id AS patient_document_id, ${referenceFaceSelect},
              ${requireQualifiedSelect}, ${procedureClassificationSelect}
       FROM surgery_documents sd
       INNER JOIN surgeries s ON s.id = sd.surgery_id
       INNER JOIN patients p ON p.id = sd.patient_id
       WHERE sd.access_token = $1`,
      [token]
    );
    const doc = docResult.rows[0];

    if (!doc) {
      return res.status(404).json({ error: 'Documento nao encontrado' });
    }
    if (isExpiredDocument(doc)) {
      return res.status(410).json({ error: 'Link expirado' });
    }
    if (doc.status === 'SIGNED') {
      return res.status(409).json({ error: 'Documento ja assinado.' });
    }

    if (!doc.reference_face_path) {
      return res.status(412).json({
        error: 'Nao foi possivel concluir a assinatura: paciente sem foto de referencia no cadastro. Solicite ao profissional o cadastro da foto antes de assinar.',
      });
    }

    const totalPages = Number(doc.total_pages || 1);
    const pagesRead = Number(doc.pages_read || 0);
    if (pagesRead < totalPages) {
      return res.status(400).json({ error: 'Leia todas as paginas antes de assinar' });
    }

    if (!faceData) {
      return res.status(400).json({ error: 'Captura facial obrigatoria antes da assinatura' });
    }

    const allConfirmed = confirmations
      && confirmations.readConfirmed
      && confirmations.procedureConsentConfirmed
      && confirmations.identityConfirmed;
    if (!allConfirmed) {
      return res.status(400).json({ error: 'Confirmações obrigatórias de consentimento não foram marcadas.' });
    }

    const [
      hasContentHash,
      hasSignedContentHash,
      hasSignedUserAgent,
      hasPdfHashSigned,
      hasTsaProvider,
      hasTsaToken,
      hasTsaTimestampAt,
      hasQualifiedProvider,
      hasQualifiedRef,
      hasLgpdPolicyVersion,
      hasLegalTermsVersion,
      hasRiskAckText,
    ] = await Promise.all([
      hasColumn('surgery_documents', 'content_hash'),
      hasColumn('surgery_documents', 'signed_content_hash'),
      hasColumn('surgery_documents', 'signed_user_agent'),
      hasColumn('surgery_documents', 'pdf_hash_signed'),
      hasColumn('surgery_documents', 'tsa_provider'),
      hasColumn('surgery_documents', 'tsa_token'),
      hasColumn('surgery_documents', 'tsa_timestamp_at'),
      hasColumn('surgery_documents', 'qualified_provider'),
      hasColumn('surgery_documents', 'qualified_ref'),
      hasColumn('surgery_documents', 'lgpd_policy_version'),
      hasColumn('surgery_documents', 'legal_terms_version'),
      hasColumn('surgery_documents', 'risk_ack_text'),
    ]);

    const currentContentHash = sha256(doc.content_html || '');
    if (hasContentHash && doc.content_hash && doc.content_hash !== currentContentHash) {
      return res.status(409).json({ error: 'Integridade do documento comprometida. Gere um novo documento antes da assinatura.' });
    }

    const matches = String(faceData).match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\n\r]+)$/);
    if (!matches) {
      return res.status(400).json({ error: 'Captura facial invalida. Envie imagem PNG ou JPEG em base64.' });
    }

    const estimatedFaceBytes = estimateBase64Bytes(matches[2]);
    if (!Number.isFinite(estimatedFaceBytes) || estimatedFaceBytes <= 0 || estimatedFaceBytes > MAX_FACE_IMAGE_BYTES) {
      return res.status(413).json({ error: 'Captura facial excede o limite de 3MB.' });
    }

    const extension = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const fileName = `face-${doc.id}-${Date.now()}.${extension}`;
    const fullPath = path.join(__dirname, '..', '..', '..', 'storage', 'faces', fileName);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, Buffer.from(matches[2], 'base64'));
    const facePath = fullPath;

    const signedAt = new Date().toISOString();
    const pdfHashSigned = doc.pdf_path && fs.existsSync(doc.pdf_path) ? sha256File(doc.pdf_path) : null;

    let tsaEvidence = null;
    try {
      if (pdfHashSigned) {
        tsaEvidence = await requestTrustedTimestamp(pdfHashSigned);
      }
    } catch (tsaErr) {
      console.warn('[TSA] Falha ao obter carimbo do tempo:', tsaErr.message);
    }

    const classification = classifyProcedure({
      procedureType: doc.procedure_type,
      title: doc.surgery_title,
      procedureClassification: doc.procedure_classification,
      isCritical: doc.require_qualified_signature === true,
    });

    let qualifiedEvidence = null;
    const mustRequireQualified = process.env.REQUIRE_QUALIFIED_SIGNATURE === 'true'
      || Boolean(requireQualifiedSignature)
      || Boolean(doc.require_qualified_signature)
      || classification.isCritical;
    try {
      qualifiedEvidence = await requestQualifiedSignature({
        documentHash: pdfHashSigned || currentContentHash,
        signerName: signatureName,
        signerDocumentId: doc.patient_document_id || null,
        doctorId: doc.doctor_id,
      });
    } catch (qualifiedErr) {
      if (mustRequireQualified) {
        return res.status(412).json({ error: `Assinatura qualificada indisponível: ${qualifiedErr.message}` });
      }
      console.warn('[Qualified] Provedor indisponível:', qualifiedErr.message);
    }

    if (mustRequireQualified && !qualifiedEvidence) {
      return res.status(412).json({ error: 'Assinatura qualificada (ICP-Brasil) é obrigatória neste fluxo e não foi concluída.' });
    }

    const setParts = [
      "status = 'SIGNED'",
      'signed_at = $1',
      'signature_name = $2',
      'signature_ip = $3',
      'signature_face_path = $4',
      'read_completed_at = COALESCE(read_completed_at, $1)',
    ];
    const updateValues = [signedAt, signatureName, req.ip, facePath];

    if (hasSignedContentHash) {
      setParts.push(`signed_content_hash = $${updateValues.length + 1}`);
      updateValues.push(currentContentHash);
    }
    if (hasSignedUserAgent) {
      setParts.push(`signed_user_agent = $${updateValues.length + 1}`);
      updateValues.push(req.get('user-agent') || null);
    }
    if (hasPdfHashSigned) {
      setParts.push(`pdf_hash_signed = $${updateValues.length + 1}`);
      updateValues.push(pdfHashSigned);
    }
    if (hasTsaProvider) {
      setParts.push(`tsa_provider = $${updateValues.length + 1}`);
      updateValues.push(tsaEvidence?.provider || null);
    }
    if (hasTsaToken) {
      setParts.push(`tsa_token = $${updateValues.length + 1}`);
      updateValues.push(tsaEvidence?.token || null);
    }
    if (hasTsaTimestampAt) {
      setParts.push(`tsa_timestamp_at = $${updateValues.length + 1}`);
      updateValues.push(tsaEvidence?.timestampAt || null);
    }
    if (hasQualifiedProvider) {
      setParts.push(`qualified_provider = $${updateValues.length + 1}`);
      updateValues.push(qualifiedEvidence?.provider || null);
    }
    if (hasQualifiedRef) {
      setParts.push(`qualified_ref = $${updateValues.length + 1}`);
      updateValues.push(qualifiedEvidence?.ref || null);
    }
    if (hasLgpdPolicyVersion) {
      setParts.push(`lgpd_policy_version = $${updateValues.length + 1}`);
      updateValues.push(lgpdPolicyVersion || null);
    }
    if (hasLegalTermsVersion) {
      setParts.push(`legal_terms_version = $${updateValues.length + 1}`);
      updateValues.push(legalTermsVersion || null);
    }
    if (hasRiskAckText) {
      setParts.push(`risk_ack_text = $${updateValues.length + 1}`);
      updateValues.push(riskAckText || null);
    }

    updateValues.push(doc.id);
    await query(
      `UPDATE surgery_documents
       SET ${setParts.join(', ')}
       WHERE id = $${updateValues.length}`,
      updateValues
    );

    await query('UPDATE surgeries SET status = $1 WHERE id = $2', ['SIGNED', doc.surgery_id]);

    // Financeiro: gera automaticamente a cobranca no caixa vinculada a este procedimento.
    try {
      await ensureAutoChargeForSurgery(doc.surgery_id);
    } catch (cashierErr) {
      console.warn('[Caixa] Falha ao gerar cobranca automatica:', cashierErr.message);
    }

    await logAuditEvent(doc.id, 'SIGNED', req, {
      signatureName,
      signedAt,
      signedContentHash: currentContentHash,
      pdfHashSigned,
      tsaEvidence,
      qualifiedEvidence,
      lgpdPolicyVersion: lgpdPolicyVersion || null,
      legalTermsVersion: legalTermsVersion || null,
      riskAckText: riskAckText || null,
      procedureClassification: classification,
      qualifiedRequired: mustRequireQualified,
      confirmations,
    });

    const evidenceSummary = buildEvidenceSummary({
      ...doc,
      status: 'SIGNED',
      signed_at: signedAt,
      signature_face_path: facePath,
      signed_content_hash: currentContentHash,
      pdf_hash_signed: pdfHashSigned,
      tsa_provider: tsaEvidence?.provider || null,
      tsa_token: tsaEvidence?.token || null,
      tsa_timestamp_at: tsaEvidence?.timestampAt || null,
      qualified_provider: qualifiedEvidence?.provider || null,
      qualified_ref: qualifiedEvidence?.ref || null,
      lgpd_policy_version: lgpdPolicyVersion || null,
      legal_terms_version: legalTermsVersion || null,
      risk_ack_text: riskAckText || null,
      signature_ip: req.ip,
      signed_user_agent: req.get('user-agent') || null,
    }, {
      procedureType: doc.procedure_type,
      title: doc.surgery_title,
      requireQualifiedSignature: mustRequireQualified,
      procedureClassification: doc.procedure_classification,
    });

    // Notifica médico e paciente via WebSocket
    try {
      socketService.emitToDoctor(String(doc.doctor_id), 'document_signed', { document_id: doc.id, surgery_id: doc.surgery_id, patient_id: doc.patient_id });
      socketService.emitToPatient(String(doc.patient_id), 'document_signed', { document_id: doc.id, surgery_id: doc.surgery_id });
    } catch (_) {}

    return res.json({
      message: 'Documento assinado com sucesso',
      signedAt,
      evidenceSummary,
    });
  } catch (error) {
    return next(error);
  }
});

// Rota sem formato — padrão PDF
router.get('/api/patient/download/:token', async (req, res) => {
  return res.redirect(302, `/api/patient/download/${req.params.token}/pdf`);
});

router.get('/api/patient/download/:token/:format', async (req, res, next) => {
  try {
    const { token, format } = req.params;

    const result = await query('SELECT * FROM surgery_documents WHERE access_token = $1', [token]);
    const doc = result.rows[0];

    if (!doc) {
      return res.status(404).json({ error: 'Documento nao encontrado' });
    }
    if (isExpiredDocument(doc)) {
      return res.status(410).json({ error: 'Link expirado' });
    }

    let filePath = format === 'pdf' ? doc.pdf_path : doc.docx_path;

    // Render tem filesystem efêmero — regenera o arquivo se não existir mais
    if (!filePath || !fs.existsSync(filePath)) {
      if (!doc.content_html) {
        return res.status(404).json({ error: 'Arquivo indisponivel e conteudo nao armazenado' });
      }
      try {
        const { generateDocumentFiles } = require('../services/documentService');
        const files = await generateDocumentFiles({
          baseFileName: `doc-${doc.id}`,
          title: doc.title || 'Documento',
          htmlContent: doc.content_html,
        });
        // Atualiza os caminhos no banco para próxima vez
        await query('UPDATE surgery_documents SET pdf_path = $1, docx_path = $2 WHERE id = $3',
          [files.pdfPath, files.docxPath, doc.id]);
        filePath = format === 'pdf' ? files.pdfPath : files.docxPath;
      } catch (genErr) {
        console.error('[Download] Erro ao regenerar documento:', genErr.message);
        return res.status(500).json({ error: 'Erro ao gerar arquivo para download' });
      }
    }

    return res.download(filePath, `${doc.title || 'documento'}.${format === 'pdf' ? 'pdf' : 'docx'}`);
  } catch (error) {
    return next(error);
  }
});

// Rota para carregar o termo de consentimento e privacidade apontando para o frontend
router.get('/privacidade', (req, res) => {
  try {
    // Tenta renderizar usando a raiz do projeto como base absoluta
    const absoluteViewPath = path.join(process.cwd(), 'frontend', 'views', 'privacidade.ejs');
    
    if (fs.existsSync(absoluteViewPath)) {
      return res.render(absoluteViewPath);
    }

    // Se falhar, tenta o caminho relativo padrão configurado na engine de views do Express
    return res.render('privacidade');
  } catch (err) {
    console.error('[Privacidade] Erro ao renderizar página:', err.message);
    // Se tudo falhar, ele envia o HTML bruto diretamente para não dar erro 500 no Google
    res.send(`
      <html>
        <head><title>Política de Privacidade</title><meta charset="utf-8"></head>
        <body style="font-family: sans-serif; padding: 40px; line-height: 1.6;">
          <h1>Política de Privacidade</h1>
          <p>Esta Política de Privacidade descreve como suas informações pessoais são coletadas, usadas e compartilhadas quando você usa o sistema.</p>
          <h2>1. Coleta de Informações</h2>
          <p>Coletamos informações necessárias para a prestação de nossos serviços, incluindo dados de autenticação fornecidos por integrações de terceiros (como o Google).</p>
          <h2>2. Uso de Dados</h2>
          <p>Os dados coletados são utilizados exclusivamente para gerenciar agendamentos, sincronizar agendas e garantir a segurança do sistema.</p>
        </body>
      </html>
    `);
  }
});

module.exports = router;


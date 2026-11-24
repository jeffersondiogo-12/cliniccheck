const express = require('express');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/database');
const { requireDoctor } = require('../middleware/auth');
const socketService = require('../services/socketService');
const { generateDocumentFiles } = require('../services/documentService');
const { sendLinkEmail } = require('../services/emailService');
const { sha256, sha256File } = require('../services/evidenceService');

const router = express.Router();
const columnCache = new Map();

function applyTemplate(templateHtml, surgery) {
  return templateHtml
    .replace(/{{procedimento}}/g, surgery.title || '')
    .replace(/{{descricao}}/g, surgery.procedure_details || '')
    .replace(/{{complicacoes}}/g, surgery.complications || 'Nao informado');
}

function normalizePhone(rawValue) {
  if (!rawValue) return null;
  const onlyDigits = String(rawValue).replace(/\D/g, '');
  return onlyDigits.length >= 10 ? onlyDigits : null;
}

function ensureRiskConsentSection(html, surgery, patient) {
  const marker = 'DECLARACAO DE CIENCIA DOS RISCOS';
  if (String(html || '').includes(marker)) return html;

  const patientName = patient?.name || 'Paciente';
  const procedureName = surgery?.title || 'Procedimento médico';
  const complications = surgery?.complications || 'Complicações não informadas no cadastro.';

  return `${html}
<hr>
<h3>${marker}</h3>
<p><strong>Paciente:</strong> ${patientName}</p>
<p><strong>Procedimento:</strong> ${procedureName}</p>
<p><strong>Riscos e complicações informados:</strong> ${complications}</p>
<p>Declaro que recebi explicações claras sobre riscos, benefícios e alternativas terapêuticas, e que tive oportunidade de esclarecer dúvidas antes de assinar este consentimento.</p>`;
}

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

router.post('/generate', requireDoctor, async (req, res, next) => {
  try {
    const { surgeryId, templateId, title, customHtml, expiresAt } = req.body;

    if (!surgeryId || !title) {
      return res.status(400).json({ error: 'surgeryId e title sao obrigatorios' });
    }

    const [hasSurgeriesClinicId, hasPatientsClinicId] = await Promise.all([
      hasColumn('surgeries', 'clinic_id'),
      hasColumn('patients', 'clinic_id'),
    ]);

    const surgeryResult = hasSurgeriesClinicId
      ? await query('SELECT * FROM surgeries WHERE id = $1 AND clinic_id = $2', [surgeryId, req.doctor.clinicId || null])
      : await query('SELECT * FROM surgeries WHERE id = $1', [surgeryId]);
    const surgery = surgeryResult.rows[0];
    if (!surgery) {
      return res.status(404).json({ error: 'Cirurgia nao encontrada' });
    }

    const patientResult = hasPatientsClinicId
      ? await query('SELECT id, name, email, phone FROM patients WHERE id = $1 AND clinic_id = $2', [surgery.patient_id, req.doctor.clinicId || null])
      : await query('SELECT id, name, email, phone FROM patients WHERE id = $1', [surgery.patient_id]);
    const patient = patientResult.rows[0];

    const templateResult = templateId
      ? await query('SELECT * FROM document_templates WHERE id = $1', [templateId])
      : { rows: [] };
    const template = templateResult.rows[0];

    const baseHtml = customHtml || (template ? applyTemplate(template.body_html, surgery) : '');
    if (!baseHtml) {
      return res.status(400).json({ error: 'Informe customHtml ou templateId valido' });
    }
    const html = ensureRiskConsentSection(baseHtml, surgery, patient);
    const contentHash = sha256(html);

    const documentId = uuidv4();
    const fileBaseName = `doc-${documentId}`;

    const files = await generateDocumentFiles({
      baseFileName: fileBaseName,
      title,
      htmlContent: html,
    });

    const accessToken = uuidv4().replace(/-/g, '');

    const [hasContentHash, hasPdfHashGenerated] = await Promise.all([
      hasColumn('surgery_documents', 'content_hash'),
      hasColumn('surgery_documents', 'pdf_hash_generated'),
    ]);
    const pdfHashGenerated = sha256File(files.pdfPath);
    const insertColumns = [
      'id',
      'surgery_id',
      'doctor_id',
      'patient_id',
      'title',
      'content_html',
      'pdf_path',
      'docx_path',
      'access_token',
      'expires_at',
      'status',
    ];
    const insertValues = [
      documentId,
      surgery.id,
      req.doctor.id,
      surgery.patient_id,
      title,
      html,
      files.pdfPath,
      files.docxPath,
      accessToken,
      expiresAt || null,
      'PENDING_SIGNATURE',
    ];

    if (hasContentHash) {
      insertColumns.push('content_hash');
      insertValues.push(contentHash);
    }
    if (hasPdfHashGenerated) {
      insertColumns.push('pdf_hash_generated');
      insertValues.push(pdfHashGenerated);
    }

    const placeholders = insertValues.map((_, i) => `$${i + 1}`).join(', ');
    await query(
      `INSERT INTO surgery_documents (${insertColumns.join(', ')}) VALUES (${placeholders})`,
      insertValues
    );

    await logAuditEvent(documentId, 'GENERATED', req, {
      surgeryId: surgery.id,
      patientId: surgery.patient_id,
      contentHash,
      pdfHashGenerated,
    });

    await query(
      `UPDATE surgeries SET status = $1 WHERE id = $2 ${hasSurgeriesClinicId ? 'AND clinic_id = $3' : ''}`,
      hasSurgeriesClinicId ? ['AWAITING_SIGNATURE', surgery.id, req.doctor.clinicId || null] : ['AWAITING_SIGNATURE', surgery.id]
    );

    // Notifica médico via WebSocket
    try {
      socketService.emitToDoctor(String(req.user.id), 'document_generated', {
        document_id: documentId,
        surgery_id: surgery.id,
        patient_id: surgery.patient_id,
        clinicId: req.doctor.clinicId || null,
      });
    } catch (_) {}

    const baseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const accessLink = `${baseUrl}/assinatura/${accessToken}`;
    const normalizedPatientPhone = normalizePhone(patient?.phone);

    return res.status(201).json({
      message: 'Documento gerado com sucesso',
      documentId,
      accessToken,
      accessLink,
      patientContact: {
        name: patient?.name || null,
        email: patient?.email || null,
        phone: patient?.phone || null,
      },
      whatsappLink: normalizedPatientPhone
        ? `https://wa.me/${normalizedPatientPhone}?text=${encodeURIComponent(
            `Ola, seu documento medico esta disponivel para leitura e assinatura: ${accessLink}`
          )}`
        : null,
      downloads: {
        pdf: `${baseUrl}/api/documents/${documentId}/download/pdf`,
        docx: `${baseUrl}/api/documents/${documentId}/download/docx`,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/', requireDoctor, async (req, res, next) => {
  try {
    const hasSurgeriesClinicId = await hasColumn('surgeries', 'clinic_id');
    const documents = await query(
      `SELECT sd.id, sd.title, sd.status, sd.created_at, sd.signed_at,
              p.name AS patient_name, s.title AS surgery_title
       FROM surgery_documents sd
       INNER JOIN patients p ON p.id = sd.patient_id
       INNER JOIN surgeries s ON s.id = sd.surgery_id
      WHERE (${hasSurgeriesClinicId ? 's.clinic_id = $1 AND ' : ''}
        (LOWER(COALESCE(s.status, '')) <> 'cancelled' OR UPPER(COALESCE(sd.status, '')) = 'SIGNED'))
       ORDER BY sd.created_at DESC`,
      hasSurgeriesClinicId ? [req.doctor.clinicId || null] : []
    );

    return res.json(documents.rows);
  } catch (error) {
    return next(error);
  }
});

router.get('/:id/download/:format', requireDoctor, async (req, res, next) => {
  try {
    const { id, format } = req.params;
    const hasSurgeriesClinicId = await hasColumn('surgeries', 'clinic_id');
    const result = await query(
      `SELECT sd.*
       FROM surgery_documents sd
       INNER JOIN surgeries s ON s.id = sd.surgery_id
       WHERE sd.id = $1
       ${hasSurgeriesClinicId ? 'AND s.clinic_id = $2' : ''}`,
      hasSurgeriesClinicId ? [id, req.doctor.clinicId || null] : [id]
    );
    const doc = result.rows[0];

    if (!doc) {
      return res.status(404).json({ error: 'Documento nao encontrado' });
    }

    let filePath = format === 'pdf' ? doc.pdf_path : doc.docx_path;

    // Render tem filesystem efêmero — regenera o arquivo se não existir mais
    if (!filePath || !fs.existsSync(filePath)) {
      if (!doc.content_html) {
        return res.status(404).json({ error: 'Arquivo nao encontrado e conteudo nao armazenado' });
      }
      try {
        const files = await generateDocumentFiles({
          baseFileName: `doc-${doc.id}`,
          title: doc.title || 'Documento',
          htmlContent: doc.content_html,
        });
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

router.get('/:id/download/signature-face', requireDoctor, async (req, res, next) => {
  try {
    const { id } = req.params;
    const hasSurgeriesClinicId = await hasColumn('surgeries', 'clinic_id');
    const result = await query(
      `SELECT sd.signature_face_path, sd.title, p.name AS patient_name
       FROM surgery_documents sd
       INNER JOIN patients p ON p.id = sd.patient_id
       INNER JOIN surgeries s ON s.id = sd.surgery_id
       WHERE sd.id = $1
       ${hasSurgeriesClinicId ? 'AND s.clinic_id = $2' : ''}`,
      hasSurgeriesClinicId ? [id, req.doctor.clinicId || null] : [id]
    );
    const doc = result.rows[0];

    if (!doc) {
      return res.status(404).json({ error: 'Documento nao encontrado' });
    }

    if (!doc.signature_face_path || !fs.existsSync(doc.signature_face_path)) {
      return res.status(404).json({ error: 'Foto de assinatura facial nao encontrada' });
    }

    const lower = String(doc.signature_face_path).toLowerCase();
    const ext = lower.endsWith('.png') ? 'png' : (lower.endsWith('.webp') ? 'webp' : 'jpg');
    const safeName = String(doc.patient_name || doc.title || 'assinatura').replace(/[^a-zA-Z0-9_-]+/g, '_');
    return res.download(doc.signature_face_path, `${safeName}-assinatura-facial.${ext}`);
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/share', requireDoctor, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { patientEmail, patientPhone, customMessage } = req.body;
    const hasSurgeriesClinicId = await hasColumn('surgeries', 'clinic_id');

    const result = await query(
      `SELECT sd.id, sd.title, sd.access_token, p.name AS patient_name
       FROM surgery_documents sd
       INNER JOIN patients p ON p.id = sd.patient_id
       INNER JOIN surgeries s ON s.id = sd.surgery_id
       WHERE sd.id = $1
       ${hasSurgeriesClinicId ? 'AND s.clinic_id = $2' : ''}`,
      hasSurgeriesClinicId ? [id, req.doctor.clinicId || null] : [id]
    );

    const doc = result.rows[0];
    if (!doc) {
      return res.status(404).json({ error: 'Documento nao encontrado' });
    }

    const baseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const accessLink = `${baseUrl}/assinatura/${doc.access_token}`;
    const message =
      customMessage ||
      `Ola ${doc.patient_name}, seu documento medico esta disponivel para leitura e assinatura: ${accessLink}`;

    const whatsappPhone = normalizePhone(patientPhone);
    const whatsappLink = whatsappPhone ? `https://wa.me/${whatsappPhone}?text=${encodeURIComponent(message)}` : null;

    const emailResult = await sendLinkEmail({
      to: patientEmail,
      subject: `Documento medico: ${doc.title}`,
      message,
      link: accessLink,
    });

    return res.json({
      message: 'Compartilhamento processado',
      accessLink,
      whatsappLink,
      emailSent: emailResult.sent,
      emailWarning: emailResult.warning || null,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

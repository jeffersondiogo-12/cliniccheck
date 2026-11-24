const { classifyProcedure } = require('./compliancePolicyService');

function normalizeDocumentStatus(status) {
  return String(status || '').toUpperCase();
}

function getQualifiedRequirement({ procedureType, title, requireQualifiedSignature, procedureClassification, isCritical }) {
  const classification = classifyProcedure({
    procedureType,
    title,
    procedureClassification,
    isCritical,
  });
  const required = process.env.REQUIRE_QUALIFIED_SIGNATURE === 'true'
    || Boolean(requireQualifiedSignature)
    || classification.isCritical;

  return {
    required,
    classification,
    reason: required
      ? (classification.isCritical
        ? 'Procedimento crítico: assinatura qualificada ICP-Brasil exigida.'
        : 'Fluxo configurado para exigir assinatura qualificada ICP-Brasil.')
      : 'Assinatura qualificada opcional neste fluxo.',
  };
}

function buildEvidenceSummary(documentRow = {}, options = {}) {
  const normalizedStatus = normalizeDocumentStatus(documentRow.document_status || documentRow.status);
  const isSigned = normalizedStatus === 'SIGNED';
  const requirement = getQualifiedRequirement({
    procedureType: options.procedureType || documentRow.procedure_type,
    title: options.title || documentRow.surgery_title || documentRow.title,
    requireQualifiedSignature: options.requireQualifiedSignature,
    procedureClassification: options.procedureClassification || documentRow.procedure_classification,
    isCritical: options.isCritical,
  });

  const biometricCompleted = Boolean(documentRow.signature_face_path);
  const timestampCompleted = Boolean(documentRow.tsa_provider || documentRow.tsa_token || documentRow.tsa_timestamp_at);
  const qualifiedCompleted = Boolean(documentRow.qualified_provider || documentRow.qualified_ref);
  const auditTrailCompleted = Boolean(documentRow.signed_content_hash || documentRow.signature_ip || documentRow.signed_user_agent);
  const integrityCompleted = Boolean(documentRow.content_hash || documentRow.pdf_hash_generated || documentRow.pdf_hash_signed);
  const consentVersionsCompleted = Boolean(documentRow.lgpd_policy_version || documentRow.legal_terms_version);

  let legalStatus = 'PENDING';
  let legalLabel = 'Consentimento pendente';

  if (isSigned) {
    if (requirement.required && qualifiedCompleted) {
      legalStatus = 'QUALIFIED';
      legalLabel = 'Consentimento qualificado ICP-Brasil';
    } else if (biometricCompleted && auditTrailCompleted) {
      legalStatus = 'AUTHENTICATED';
      legalLabel = 'Consentimento autenticado com biometria';
    } else {
      legalStatus = 'SIGNED';
      legalLabel = 'Documento assinado';
    }
  } else if (requirement.required) {
    legalStatus = 'QUALIFIED_REQUIRED';
    legalLabel = 'ICP-Brasil obrigatório';
  }

  return {
    legalStatus,
    legalLabel,
    procedureClassification: requirement.classification,
    qualifiedSignature: {
      required: requirement.required,
      completed: qualifiedCompleted,
      provider: documentRow.qualified_provider || null,
      ref: documentRow.qualified_ref || null,
      reason: requirement.reason,
    },
    biometrics: {
      completed: biometricCompleted,
      label: biometricCompleted ? 'Biometria facial registrada' : 'Biometria facial pendente',
    },
    timestamp: {
      completed: timestampCompleted,
      provider: documentRow.tsa_provider || null,
      at: documentRow.tsa_timestamp_at || null,
      label: timestampCompleted ? 'Carimbo do tempo emitido' : 'Carimbo do tempo indisponível',
    },
    auditTrail: {
      completed: auditTrailCompleted,
      hasIp: Boolean(documentRow.signature_ip),
      hasUserAgent: Boolean(documentRow.signed_user_agent),
      label: auditTrailCompleted ? 'Trilha de auditoria registrada' : 'Trilha de auditoria parcial',
    },
    integrity: {
      completed: integrityCompleted,
      contentHash: documentRow.content_hash || documentRow.signed_content_hash || null,
      pdfHash: documentRow.pdf_hash_signed || documentRow.pdf_hash_generated || null,
      label: integrityCompleted ? 'Hashes de integridade registrados' : 'Hashes de integridade pendentes',
    },
    legalTerms: {
      lgpdPolicyVersion: documentRow.lgpd_policy_version || null,
      legalTermsVersion: documentRow.legal_terms_version || null,
      riskAckText: documentRow.risk_ack_text || null,
      completed: consentVersionsCompleted,
    },
    signedAt: documentRow.signed_at || null,
  };
}

module.exports = {
  buildEvidenceSummary,
  getQualifiedRequirement,
};

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function classifyProcedure({ procedureType, title, procedureClassification, isCritical }) {
  if (typeof isCritical === 'boolean') {
    return {
      isCritical,
      reason: isCritical
        ? 'Procedimento marcado manualmente como crítico no cadastro.'
        : 'Procedimento marcado manualmente como não crítico no cadastro.',
    };
  }

  const normalizedClassification = normalizeText(procedureClassification);
  if (normalizedClassification) {
    const criticalLabels = ['critico', 'critical', 'alto-risco', 'alto risco'];
    const isManualCritical = criticalLabels.some((label) => normalizedClassification.includes(label));

    return {
      isCritical: isManualCritical,
      reason: isManualCritical
        ? 'Procedimento classificado manualmente como crítico no cadastro.'
        : `Procedimento classificado manualmente como "${procedureClassification}" no cadastro.`,
    };
  }

  const hasProcedureInfo = normalizeText(procedureType) || normalizeText(title);
  if (hasProcedureInfo) {
    return {
      isCritical: false,
      reason: 'Sem classificação manual: procedimento tratado como não crítico por padrão.',
    };
  }

  return {
    isCritical: false,
    reason: 'Sem dados suficientes para classificar o procedimento',
  };
}

module.exports = {
  classifyProcedure,
};

/**
 * certificateReaderService.js
 * Leitura LOCAL de certificados digitais ICP-Brasil — SEM custo externo.
 * Suporta: .pfx / .p12 (com senha) e .pem / .cer (sem senha)
 * Extrai: nome, CPF, CRM, e-mail, validade, emissor.
 */

const forge = require('node-forge');

// OIDs ICP-Brasil relevantes
const OID_CPF            = '2.16.76.1.3.1';
const OID_CRM_FEDERAL    = '2.16.76.1.4.2.1';
const OID_CRM_UF         = '2.16.76.1.4.2.3';
const OID_EMAIL_ADDRESS  = '1.2.840.113549.1.9.1';

/**
 * Extrai campos do Subject Alternative Name que contém dados ICP-Brasil
 * O campo OtherName para CPF é codificado dentro do SAN como octets
 */
function extractSanFields(cert) {
  const result = { cpf: null, crm: null };
  try {
    const san = cert.getExtension('subjectAltName');
    if (!san || !san.altNames) return result;

    for (const alt of san.altNames) {
      // OtherName (tipo 0) = dados ICP-Brasil
      if (alt.type === 0 && alt.value) {
        const raw = alt.value;
        // Tenta extrair CPF (11 dígitos numéricos) de campos OtherName
        const cpfMatch = raw.replace(/\D/g, '');
        if (cpfMatch.length === 11 && !result.cpf) {
          result.cpf = cpfMatch.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
        }
      }
      // rfc822Name (tipo 1) = e-mail
      if (alt.type === 1) {
        result.email = alt.value;
      }
    }
  } catch (_) {}
  return result;
}

/**
 * Lê uma string de dados de certificado e tenta extrair por múltiplos encodings
 */
function tryDecodeCertificateField(value) {
  if (!value || typeof value !== 'string') return '';
  // Remove caracteres não imprimíveis mantendo UTF-8 válido
  return value.replace(/[\x00-\x08\x0E-\x1F\x7F]/g, '').trim();
}

/**
 * Parseia um certificado X.509 (objeto forge) e retorna os campos relevantes
 */
function parseCertificate(cert) {
  const subject = {};
  for (const attr of cert.subject.attributes) {
    const name = attr.name || attr.shortName;
    subject[name] = tryDecodeCertificateField(attr.value);
    // Por OID específico
    if (attr.type === OID_CPF) subject.cpfOid = tryDecodeCertificateField(attr.value);
    if (attr.type === OID_CRM_FEDERAL) subject.crmOid = tryDecodeCertificateField(attr.value);
    if (attr.type === OID_EMAIL_ADDRESS) subject.emailOid = tryDecodeCertificateField(attr.value);
  }

  const issuer = {};
  for (const attr of cert.issuer.attributes) {
    const name = attr.name || attr.shortName;
    issuer[name] = tryDecodeCertificateField(attr.value);
  }

  const san = extractSanFields(cert);

  // Determina tipo do certificado (A1 = software, A3 = hardware/token)
  const serial = cert.serialNumber;
  const notBefore = cert.validity.notBefore;
  const notAfter  = cert.validity.notAfter;
  const now = new Date();
  const isExpired = notAfter < now;
  const daysLeft  = Math.floor((notAfter - now) / (1000 * 60 * 60 * 24));

  return {
    valid: true,
    expired: isExpired,
    daysUntilExpiry: isExpired ? 0 : daysLeft,
    subject: {
      commonName:   subject.commonName   || subject.CN || null,
      organization: subject.organizationName || subject.O || null,
      email:        subject.emailAddress || subject.E || subject.emailOid || san.email || null,
      cpf:          subject.cpfOid || san.cpf || null,
      crm:          subject.crmOid || null,
      country:      subject.countryName  || subject.C || null,
      state:        subject.stateOrProvinceName || subject.ST || null,
    },
    issuer: {
      commonName:   issuer.commonName   || issuer.CN  || null,
      organization: issuer.organizationName || issuer.O || null,
    },
    validity: {
      notBefore: notBefore.toISOString(),
      notAfter:  notAfter.toISOString(),
    },
    serialNumber: serial,
  };
}

/**
 * Lê um arquivo .pfx / .p12 (PKCS#12) e retorna os dados do certificado
 * @param {Buffer} fileBuffer  - conteúdo binário do arquivo
 * @param {string} password    - senha do arquivo (pode ser vazia)
 */
function readPfxBuffer(fileBuffer, password = '') {
  try {
    const p12Der = forge.util.createBuffer(fileBuffer.toString('binary'));
    const p12Asn1 = forge.asn1.fromDer(p12Der);
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const bags = certBags[forge.pki.oids.certBag] || [];

    if (!bags.length) {
      return { valid: false, error: 'Nenhum certificado encontrado no arquivo .pfx' };
    }

    // Pega o certificado de usuário (não a cadeia/CA)
    const userCert = bags.find(b => b.cert && b.cert.subject.attributes.length > 0)?.cert || bags[0].cert;
    return parseCertificate(userCert);
  } catch (e) {
    if (e.message && e.message.toLowerCase().includes('invalid password')) {
      return { valid: false, error: 'Senha incorreta para o arquivo .pfx/.p12' };
    }
    return { valid: false, error: 'Arquivo .pfx/.p12 inválido ou corrompido: ' + e.message };
  }
}

/**
 * Lê um arquivo .cer / .pem (X.509 DER ou PEM) e retorna os dados
 * @param {Buffer} fileBuffer - conteúdo do arquivo
 */
function readCerBuffer(fileBuffer) {
  try {
    const content = fileBuffer.toString('utf8');

    let cert;
    if (content.includes('-----BEGIN CERTIFICATE-----')) {
      // Formato PEM
      cert = forge.pki.certificateFromPem(content);
    } else {
      // Formato DER binário
      const der = forge.util.createBuffer(fileBuffer.toString('binary'));
      const asn1 = forge.asn1.fromDer(der);
      cert = forge.pki.certificateFromAsn1(asn1);
    }

    return parseCertificate(cert);
  } catch (e) {
    return { valid: false, error: 'Arquivo de certificado inválido: ' + e.message };
  }
}

/**
 * Ponto de entrada principal
 * @param {Buffer} fileBuffer   - conteúdo do arquivo
 * @param {string} originalname - nome original do arquivo (para detectar tipo)
 * @param {string} password     - senha (só para .pfx/.p12)
 */
function readCertificateFromBuffer(fileBuffer, originalname, password = '') {
  const ext = (originalname || '').toLowerCase().split('.').pop();

  if (ext === 'pfx' || ext === 'p12') {
    return readPfxBuffer(fileBuffer, password);
  }

  if (ext === 'cer' || ext === 'pem' || ext === 'crt') {
    return readCerBuffer(fileBuffer);
  }

  // Tenta detectar automaticamente
  const preview = fileBuffer.toString('utf8', 0, 100);
  if (preview.includes('-----BEGIN')) {
    return readCerBuffer(fileBuffer);
  }

  // Tenta como PFX sem senha e depois como DER
  const pfxResult = readPfxBuffer(fileBuffer, password);
  if (pfxResult.valid) return pfxResult;
  return readCerBuffer(fileBuffer);
}

module.exports = { readCertificateFromBuffer };

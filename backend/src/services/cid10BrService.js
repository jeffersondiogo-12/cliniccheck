const DEFAULT_CID10_URL = 'https://fhir.saude.go.gov.br/r4/reds-go/ValueSet-BRCID10-1.0';
const DEFAULT_CID10_CODESYSTEM_HTML_URL = 'https://fhir.saude.go.gov.br/r4/reds-go/CodeSystem-BRCID10.html';
const SOURCE_URL = process.env.CID10_BR_API_URL || DEFAULT_CID10_URL;
const CACHE_TTL_MS = Number(process.env.CID10_BR_CACHE_TTL_MS || 1000 * 60 * 60 * 12); // 12h

let cache = {
  concepts: [],
  expiresAt: 0,
};

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function parseConcepts(payload) {
  const includeList = Array.isArray(payload?.compose?.include) ? payload.compose.include : [];
  const concepts = [];

  for (const include of includeList) {
    const conceptList = Array.isArray(include?.concept) ? include.concept : [];
    for (const concept of conceptList) {
      const code = String(concept?.code || '').trim().toUpperCase();
      const description = String(concept?.display || '').trim();
      if (!code || !description) continue;
      concepts.push({
        code,
        description,
        system: 'CID-10',
        version: '10',
        source: 'fhir-go',
        uri: null,
      });
    }
  }

  const dedupe = new Map();
  for (const item of concepts) {
    if (!dedupe.has(item.code)) dedupe.set(item.code, item);
  }

  return Array.from(dedupe.values());
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function parseConceptsFromHtml(html) {
  const source = String(html || '');
  const concepts = [];
  const rowRegex = /<tr><td[^>]*>\s*([A-Z][0-9][A-Z0-9]{1,4})\s*<a name="BRCID10-[^"]+">\s*<\/a><\/td>\s*<td>([\s\S]*?)<\/td><\/tr>/gi;
  let match;

  while ((match = rowRegex.exec(source)) !== null) {
    const code = String(match[1] || '').trim().toUpperCase();
    const description = decodeHtmlEntities(String(match[2] || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!code || !description) continue;
    concepts.push({
      code,
      description,
      system: 'CID-10',
      version: '10',
      source: 'fhir-go-html',
      uri: null,
    });
  }

  const dedupe = new Map();
  for (const item of concepts) {
    if (!dedupe.has(item.code)) dedupe.set(item.code, item);
  }

  return Array.from(dedupe.values());
}

function candidateUrls() {
  const list = [SOURCE_URL];

  if (SOURCE_URL.endsWith('.json.html')) {
    list.push(SOURCE_URL.slice(0, -5));
  }

  if (SOURCE_URL.endsWith('.html')) {
    list.push(SOURCE_URL.slice(0, -5));
  }

  if (!SOURCE_URL.endsWith('/ValueSet-BRCID10-1.0')) {
    list.push('https://fhir.saude.go.gov.br/r4/reds-go/ValueSet-BRCID10-1.0');
  }

  list.push(DEFAULT_CID10_CODESYSTEM_HTML_URL);

  return Array.from(new Set(list));
}

async function fetchCid10Payload() {
  const urls = candidateUrls();
  let lastError = null;

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/fhir+json, application/json;q=0.9, text/json;q=0.8',
        },
      });

      if (!response.ok) {
        lastError = `HTTP ${response.status} em ${url}`;
        continue;
      }

      const contentType = String(response.headers.get('content-type') || '').toLowerCase();

      if (contentType.includes('json') || contentType.includes('fhir')) {
        return response.json();
      }

      const bodyText = await response.text();

      if (url.endsWith('CodeSystem-BRCID10.html') || bodyText.includes('BRCID10-')) {
        return { __html: bodyText };
      }

      // Alguns servidores retornam JSON com content-type incorreto.
      try {
        return JSON.parse(bodyText);
      } catch {
        lastError = `Resposta não-JSON em ${url}`;
      }
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }

  throw new Error(lastError || 'Não foi possível baixar CID-10 da API pública');
}

async function loadAllCid10({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cache.concepts.length && cache.expiresAt > now) {
    return cache.concepts;
  }

  const payload = await fetchCid10Payload();
  const concepts = payload?.__html ? parseConceptsFromHtml(payload.__html) : parseConcepts(payload);

  cache = {
    concepts,
    expiresAt: now + CACHE_TTL_MS,
  };

  return concepts;
}

async function searchCid10(term) {
  const q = normalizeText(term);
  if (!q || q.length < 2) return [];

  const concepts = await loadAllCid10();
  return concepts
    .map((item) => {
      const code = normalizeText(item.code);
      const description = normalizeText(item.description);
      const matches = code.includes(q) || description.includes(q);
      if (!matches) return null;

      let score = 0;
      if (code === q) score += 1000;
      else if (code.startsWith(q)) score += 700;
      else if (code.includes(q)) score += 400;

      if (description === q) score += 900;
      else if (description.startsWith(q)) score += 650;
      else if (new RegExp(`(^|\\b)${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\b|$)`).test(description)) score += 500;
      else if (description.includes(q)) score += 200;

      return { item, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.item.code.localeCompare(b.item.code, 'pt-BR'))
    .map(({ item }) => item)
    .slice(0, 40);
}

module.exports = {
  loadAllCid10,
  searchCid10,
};

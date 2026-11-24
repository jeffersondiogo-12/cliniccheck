const TOKEN_URL = process.env.ICD_TOKEN_URL || process.env.ICD11_TOKEN_URL || 'https://icdaccessmanagement.who.int/connect/token';
const API_BASE_URL = process.env.ICD_API_BASE_URL || process.env.ICD11_BASE_URL || 'https://id.who.int';
const CLIENT_ID = process.env.ICD_CLIENT_ID || process.env.ICD11_CLIENT_ID || '';
const CLIENT_SECRET = process.env.ICD_CLIENT_SECRET || process.env.ICD11_CLIENT_SECRET || '';
const SCOPE = process.env.ICD_SCOPE || process.env.ICD11_SCOPE || 'icdapi_access';
const RELEASE_ID = process.env.ICD11_RELEASE_ID || '2024-01';
const LINEARIZATION = process.env.ICD11_LINEARIZATION || 'mms';

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

function sanitizeIcdText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

async function fetchToken() {
  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAt > now + 15_000) {
    return tokenCache.accessToken;
  }

  if (!isConfigured()) {
    return null;
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');
  body.set('client_id', CLIENT_ID);
  body.set('client_secret', CLIENT_SECRET);
  body.set('scope', SCOPE);

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Falha ao autenticar ICD API: ${resp.status} ${text.slice(0, 180)}`);
  }

  const data = await resp.json();
  const expiresIn = Number(data.expires_in || 300);
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  return tokenCache.accessToken;
}

function normalizeIcd11Search(data) {
  const raw = [];

  if (Array.isArray(data?.destinationEntities)) {
    raw.push(...data.destinationEntities);
  }
  if (Array.isArray(data?.entities)) {
    raw.push(...data.entities);
  }

  return raw
    .map((entry) => {
      const code = entry?.theCode || entry?.code || '';
      const title = entry?.title || entry?.label || entry?.name || '';
      const description = typeof title === 'string' ? title : (title?.value || '');
      const uri = entry?.id || entry?.uri || entry?.source || null;
      return {
        code: sanitizeIcdText(code),
        description: sanitizeIcdText(description),
        uri,
      };
    })
    .filter((x) => x.code || x.description)
    .slice(0, 30);
}

async function searchICD11({ term, language = 'pt' }) {
  if (!term || String(term).trim().length < 2) {
    return [];
  }

  const token = await fetchToken();
  if (!token) {
    return [];
  }

  const q = encodeURIComponent(String(term).trim());
  const url = `${API_BASE_URL}/icd/release/11/${RELEASE_ID}/${LINEARIZATION}/search?q=${q}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'API-Version': 'v2',
      Accept: 'application/json',
      'Accept-Language': language || 'pt',
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.warn('[ICD-11] Busca falhou:', resp.status, text.slice(0, 180));
    return [];
  }

  const data = await resp.json();
  return normalizeIcd11Search(data);
}

module.exports = {
  isConfigured,
  searchICD11,
};

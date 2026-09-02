import process from 'node:process';

const AUTHORITY_ENV = 'ARCANOS_BACKSTAGE_NOTION_AUTHORITY_ROOTS_JSON';
const TOKEN_ENV_NAMES = ['ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN', 'NOTION_API_KEY'];
const NOTION_ORIGIN = 'https://api.notion.com';
const NOTION_VERSION = '2026-03-11';
const UUID_PATTERN = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;

function normalizeId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) return null;
  const compact = value.trim().replaceAll('-', '').toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function roots() {
  try {
    const parsed = JSON.parse(process.env[AUTHORITY_ENV] ?? '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.values(parsed).flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const rootPageId = normalizeId(entry.rootPageId);
      return rootPageId ? [rootPageId] : [];
    });
  } catch {
    return [];
  }
}

function token() {
  for (const name of TOKEN_ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

async function resultCode(response) {
  if (response.ok) return null;
  try {
    const body = await response.clone().json();
    return typeof body?.code === 'string' ? body.code.slice(0, 80) : null;
  } catch {
    return null;
  }
}

async function probe(kind, url, headers) {
  try {
    const response = await fetch(url, { method: 'GET', headers, redirect: 'manual' });
    console.info('[notion-authority-root-probe]', JSON.stringify({
      kind,
      status: response.status,
      ok: response.ok,
      providerCode: await resultCode(response),
    }));
    await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    console.info('[notion-authority-root-probe]', JSON.stringify({
      kind,
      status: null,
      ok: false,
      providerCode: error instanceof Error ? 'request_failed' : 'unknown_failure',
    }));
  }
}

const configuredRoots = roots();
const accessToken = token();
console.info('[notion-authority-root-probe]', JSON.stringify({
  kind: 'configuration',
  configuredRoots: configuredRoots.length,
  credentialConfigured: Boolean(accessToken),
}));

if (accessToken) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'Notion-Version': NOTION_VERSION,
  };
  for (const root of configuredRoots) {
    await probe('page', `${NOTION_ORIGIN}/v1/pages/${root}`, headers);
    await probe('database', `${NOTION_ORIGIN}/v1/databases/${root}`, headers);
  }
}

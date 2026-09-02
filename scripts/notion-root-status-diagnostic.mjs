import process from 'node:process';

const AUTHORITY_ENV = 'ARCANOS_BACKSTAGE_NOTION_AUTHORITY_ROOTS_JSON';
const NOTION_ORIGIN = 'https://api.notion.com';
const UUID_COMPACT = /^[0-9a-f]{32}$/i;

function compactId(value) {
  const compact = String(value ?? '').replaceAll('-', '').toLowerCase();
  return UUID_COMPACT.test(compact) ? compact : null;
}

function rootsFromEnvironment() {
  try {
    const parsed = JSON.parse(process.env[AUTHORITY_ENV] ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set();
    const roots = new Set();
    for (const entry of Object.values(parsed)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const root = compactId(entry.rootPageId);
      if (root) roots.add(root);
    }
    return roots;
  } catch {
    return new Set();
  }
}

const roots = rootsFromEnvironment();
const originalFetch = globalThis.fetch?.bind(globalThis);

async function providerCode(response) {
  if (response.ok) return null;
  try {
    const body = await response.clone().json();
    return typeof body?.code === 'string' ? body.code.slice(0, 80) : null;
  } catch {
    return null;
  }
}

if (originalFetch && roots.size > 0) {
  globalThis.fetch = async function notionRootStatusDiagnostic(input, init) {
    const response = await originalFetch(input, init);
    let url;
    try {
      url = new URL(input instanceof Request ? input.url : String(input));
    } catch {
      return response;
    }
    if (url.origin !== NOTION_ORIGIN) return response;

    const page = /^\/v1\/pages\/([0-9a-f-]{32,36})$/i.exec(url.pathname);
    const markdown = /^\/v1\/pages\/([0-9a-f-]{32,36})\/markdown$/i.exec(url.pathname);
    const database = /^\/v1\/databases\/([0-9a-f-]{32,36})$/i.exec(url.pathname);
    const id = compactId(page?.[1] ?? markdown?.[1] ?? database?.[1]);
    if (!id || !roots.has(id)) return response;

    const operation = page ? 'root_page' : markdown ? 'root_markdown' : 'root_database';
    console.info('[notion-root-status]', JSON.stringify({
      operation,
      status: response.status,
      ok: response.ok,
      providerCode: await providerCode(response),
    }));
    return response;
  };
}

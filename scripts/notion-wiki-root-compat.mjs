import process from 'node:process';

const AUTHORITY_ENV = 'ARCANOS_BACKSTAGE_NOTION_AUTHORITY_ROOTS_JSON';
const NOTION_ORIGIN = 'https://api.notion.com';
const PRELOAD_SPECIFIER = new URL(import.meta.url).pathname;
const UUID_COMPACT = /^[0-9a-f]{32}$/i;

function compactId(value) {
  const compact = String(value ?? '').replaceAll('-', '').toLowerCase();
  return UUID_COMPACT.test(compact) ? compact : null;
}

function dashedId(value) {
  const compact = compactId(value);
  if (!compact) return null;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function authorityRoots() {
  try {
    const parsed = JSON.parse(process.env[AUTHORITY_ENV] ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set();
    return new Set(Object.values(parsed).flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const id = compactId(entry.rootPageId);
      return id ? [id] : [];
    }));
  } catch {
    return new Set();
  }
}

function ensureChildPreload() {
  const current = process.env.NODE_OPTIONS ?? '';
  if (current.includes('notion-wiki-root-compat.mjs')) return;
  process.env.NODE_OPTIONS = `${current} --import=${PRELOAD_SPECIFIER}`.trim();
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function titleFromPage(page) {
  const properties = page?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return 'Untitled';
  for (const property of Object.values(properties)) {
    if (!property || typeof property !== 'object' || Array.isArray(property)) continue;
    if (property.type !== 'title' || !Array.isArray(property.title)) continue;
    const title = property.title.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
      if (typeof item.plain_text === 'string') return item.plain_text;
      return item.text && typeof item.text.content === 'string' ? item.text.content : '';
    }).join('').trim();
    if (title) return title.slice(0, 500);
  }
  return 'Untitled';
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function requestHeaders(input, init) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) {
    for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
  }
  return headers;
}

function maxIsoTimestamp(values) {
  let winner = null;
  let winnerMs = -Infinity;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > winnerMs) {
      winner = new Date(ms).toISOString();
      winnerMs = ms;
    }
  }
  return winner;
}

const roots = authorityRoots();
const originalFetch = globalThis.fetch?.bind(globalThis);
const rootStates = new Map();
const topLevelToRoot = new Map();

async function queryDataSource(dataSourceId, headers) {
  const results = [];
  let cursor = null;
  for (let page = 0; page < 8; page += 1) {
    const queryHeaders = new Headers(headers);
    queryHeaders.set('content-type', 'application/json');
    const response = await originalFetch(`${NOTION_ORIGIN}/v1/data_sources/${dataSourceId}/query`, {
      method: 'POST',
      headers: queryHeaders,
      redirect: 'manual',
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== 'object' || !Array.isArray(body.results)) return null;
    results.push(...body.results);
    if (!body.has_more) return results;
    if (typeof body.next_cursor !== 'string' || !body.next_cursor) return null;
    cursor = body.next_cursor;
  }
  return null;
}

async function loadDatabaseRoot(rootCompact, headers) {
  const root = dashedId(rootCompact);
  if (!root) return null;
  const dbResponse = await originalFetch(`${NOTION_ORIGIN}/v1/databases/${root}`, {
    method: 'GET',
    headers,
    redirect: 'manual',
  });
  if (!dbResponse.ok) return null;
  const database = await dbResponse.json().catch(() => null);
  if (!database || database.object !== 'database' || compactId(database.id) !== rootCompact) return null;
  const dataSources = Array.isArray(database.data_sources)
    ? database.data_sources.map((item) => dashedId(item?.id)).filter(Boolean)
    : [];
  if (dataSources.length < 1 || dataSources.length > 16) return null;

  const allPages = [];
  for (const dataSourceId of dataSources) {
    const pages = await queryDataSource(dataSourceId, headers);
    if (!pages) return null;
    allPages.push(...pages);
  }
  if (allPages.length < 1 || allPages.length > 512) return null;

  const topLevel = [];
  const timestamps = [database.last_edited_time, database.created_time];
  for (const page of allPages) {
    if (!page || page.object !== 'page') continue;
    const pageCompact = compactId(page.id);
    if (!pageCompact || page.in_trash === true || page.archived === true) continue;
    timestamps.push(page.last_edited_time, page.created_time);
    if (page.parent?.type !== 'page_id') {
      topLevel.push({
        pageCompact,
        pageId: dashedId(pageCompact),
        title: titleFromPage(page),
      });
    }
  }
  if (topLevel.length < 1 || topLevel.length > 128) return null;
  topLevel.sort((a, b) => a.title.localeCompare(b.title) || a.pageCompact.localeCompare(b.pageCompact));
  const lastEditedTime = maxIsoTimestamp(timestamps) ?? new Date(0).toISOString();
  return { root, rootCompact, lastEditedTime, topLevel };
}

function installState(state) {
  const previous = rootStates.get(state.rootCompact);
  if (previous) {
    for (const page of previous.topLevel) {
      if (topLevelToRoot.get(page.pageCompact) === state.rootCompact) {
        topLevelToRoot.delete(page.pageCompact);
      }
    }
  }
  rootStates.set(state.rootCompact, state);
  for (const page of state.topLevel) topLevelToRoot.set(page.pageCompact, state.rootCompact);
}

async function refreshDatabaseRoot(rootCompact, headers) {
  const state = await loadDatabaseRoot(rootCompact, headers).catch(() => null);
  if (state) installState(state);
  return state;
}

function rootMarkdown(state) {
  return state.topLevel.map(({ pageId, title }) =>
    `<page url="https://www.notion.so/${encodeURIComponent(title.replaceAll(' ', '-'))}-${pageId.replaceAll('-', '')}">${xmlEscape(title)}</page>`
  ).join('\n');
}

if (originalFetch && roots.size > 0) {
  ensureChildPreload();
  globalThis.fetch = async function arcanosNotionWikiRootCompat(input, init) {
    let url;
    try {
      url = new URL(input instanceof Request ? input.url : String(input));
    } catch {
      return originalFetch(input, init);
    }
    if (url.origin !== NOTION_ORIGIN) return originalFetch(input, init);

    const metadataMatch = /^\/v1\/pages\/([0-9a-f-]{32,36})$/i.exec(url.pathname);
    const markdownMatch = /^\/v1\/pages\/([0-9a-f-]{32,36})\/markdown$/i.exec(url.pathname);
    const targetCompact = compactId(metadataMatch?.[1] ?? markdownMatch?.[1]);
    const headers = requestHeaders(input, init);

    if (targetCompact && metadataMatch && topLevelToRoot.has(targetCompact)) {
      const response = await originalFetch(input, init);
      if (!response.ok) return response;
      const body = await response.clone().json().catch(() => null);
      const rootCompact = topLevelToRoot.get(targetCompact);
      const root = dashedId(rootCompact);
      if (!body || body.object !== 'page' || !root) return response;
      return jsonResponse({ ...body, parent: { type: 'page_id', page_id: root } });
    }

    if (!targetCompact || !roots.has(targetCompact) || (!metadataMatch && !markdownMatch)) {
      return originalFetch(input, init);
    }

    const response = await originalFetch(input, init);
    if (response.ok) return response;

    if (metadataMatch) {
      const state = await refreshDatabaseRoot(targetCompact, headers);
      if (!state) return response;
      console.info(
        '[notion-wiki-root-compat] adapted configured database authority root',
        JSON.stringify({ topLevelPages: state.topLevel.length })
      );
      return jsonResponse({
        object: 'page',
        id: state.root,
        parent: { type: 'workspace', workspace: true },
        in_trash: false,
        last_edited_time: state.lastEditedTime,
      });
    }

    const state = rootStates.get(targetCompact) ?? await refreshDatabaseRoot(targetCompact, headers);
    if (!state) return response;
    return jsonResponse({
      object: 'page_markdown',
      id: state.root,
      markdown: rootMarkdown(state),
      truncated: false,
      unknown_block_ids: [],
    });
  };
}

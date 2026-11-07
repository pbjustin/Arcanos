import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { load } from 'cheerio';
import type { FetchAndCleanExtractionMetrics } from '../src/shared/webFetcher.js';

const axiosGet = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const resolve4 = jest.fn<() => Promise<string[]>>();
const resolve6 = jest.fn<() => Promise<string[]>>();
const mkdir = jest.fn<() => Promise<void>>();
const setMemory = jest.fn<(...args: unknown[]) => Promise<void>>();
const saveRagDoc = jest.fn<(...args: unknown[]) => Promise<void>>();
const createEmbedding = jest.fn<(...args: unknown[]) => Promise<number[]>>();
type PipelineRequest = { input: { sourceEndpoint: string; prompt: string } };
const pipeline = jest.fn<(request: PipelineRequest) => Promise<{ result: string }>>();

// Keep the real shared transport/extractor and consumer orchestration. Replace
// only network, inference and persistence boundaries; these fixtures have no
// credentials and never contact a provider or a database.
jest.unstable_mockModule('axios', () => ({ default: { get: axiosGet } }));
jest.unstable_mockModule('node:dns/promises', () => ({
  Resolver: class {
    resolve4() { return resolve4(); }
    resolve6() { return resolve6(); }
    cancel() {}
  }
}));
jest.unstable_mockModule('fs', () => ({ promises: { mkdir } }));
jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({ runTrinityWritingPipeline: pipeline }));
jest.unstable_mockModule('../src/services/memory.js', () => ({ setMemory }));
jest.unstable_mockModule('../src/services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: () => ({ client: {} }),
  requireOpenAIClientOrAdapter: () => ({ client: {}, adapter: {} })
}));
jest.unstable_mockModule('../src/services/openai/credentialProvider.js', () => ({
  resolveGenerativeModel: () => 'synthetic-consumer-model'
}));
jest.unstable_mockModule('../src/services/openai.js', () => ({ hasValidAPIKey: () => false }));
jest.unstable_mockModule('../src/services/openai/embeddings.js', () => ({ createEmbedding }));
jest.unstable_mockModule('@core/db/index.js', () => ({
  saveRagDoc,
  loadAllRagDocs: async () => [],
  loadRagDocsByIds: async () => [],
  initializeDatabaseWithSchema: async () => true,
  getStatus: () => ({ connected: true })
}));

const { extractFetchAndCleanDocument, fetchAndClean, fetchAndCleanDocument, webFetcher } = await import('../src/shared/webFetcher.js');
const { researchTopic } = await import('../src/services/research.js');
const { ingestUrl } = await import('../src/services/webRag.js');
const { webSearchAgent } = await import('../src/services/webSearchAgent.js');
const { gamingDocumentFetchOptions } = await import('../src/services/gamingDocumentExtraction.js');
const { preservePrimaryContentSidebarLayouts } = await import('../src/shared/gaming/gamingDocumentTextNormalization.js');

const sourceUrl = 'https://evidence.example.org/synthetic-research';
const prose = 'The synthetic observatory records three blue lamps before opening the practice gate. '
  + 'Inspect each lamp and wait until all three remain lit before crossing the training bridge.';
const body = '<html><title>Synthetic observatory report</title><body><header>SITE_HEADER_MARKER</header>'
  + '<div class="content-grid has-guide-sidebar"><div class="left-column-content">'
  + '<header><h1>Observatory source subject</h1></header><p>' + prose + '</p>'
  + '<a href="/methods">Read methods</a><script type="application/json">{"internal":"SCRIPT_STATE_MARKER"}</script>'
  + '</div></div><aside>LEGACY_SIDEBAR_MARKER</aside></body></html>';
const originalFetch = global.fetch;
const envKeys = ['WEB_FETCH_MAX_CHARS', 'OPENAI_API_KEY'] as const;
const originalEnv = new Map(envKeys.map(key => [key, process.env[key]]));

/** Install one accepted public response without replacing the actual cleaner. */
function accepted(responseBody = body, contentType = 'text/html') {
  axiosGet.mockResolvedValue({ data: responseBody, headers: { 'content-type': contentType } });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WEB_FETCH_MAX_CHARS = '9000';
  delete process.env.OPENAI_API_KEY;
  resolve4.mockResolvedValue(['93.184.216.34']);
  resolve6.mockResolvedValue([]);
  mkdir.mockResolvedValue(undefined);
  setMemory.mockResolvedValue(undefined);
  saveRagDoc.mockResolvedValue(undefined);
  createEmbedding.mockResolvedValue([1, 0, 0]);
  pipeline.mockImplementation(async request => ({
    result: request.input.sourceEndpoint === 'research.audit' ? 'SAFE\nSynthetic source summary.'
      : request.input.sourceEndpoint === 'research.synthesize' ? 'Synthetic research brief.' : 'Synthetic source summary.'
  }));
  accepted();
  global.fetch = jest.fn<typeof fetch>().mockRejectedValue(new Error('Unexpected global network request'));
});

afterEach(() => {
  jest.useRealTimers();
  global.fetch = originalFetch;
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('shared fetcher non-Gaming consumers', () => {
  it('passes legacy body text and absolute link serialization into real Research orchestration', async () => {
    const result = await researchTopic('synthetic observatory', [sourceUrl]);
    expect(result.sourcesProcessed).toBe(1);
    const request = pipeline.mock.calls.find(([value]) => value.input.sourceEndpoint === 'research.summarizeSource')?.[0];
    expect(request?.input.prompt).toContain(prose);
    expect(request?.input.prompt).toContain('SITE_HEADER_MARKER');
    expect(request?.input.prompt).toContain('LEGACY_SIDEBAR_MARKER');
    expect(request?.input.prompt).toContain('[LINKS]\n- Read methods -> https://evidence.example.org/methods');
    expect(request?.input.prompt).not.toContain('SCRIPT_STATE_MARKER');
    expect(axiosGet.mock.calls[0][1]).toMatchObject({ maxRedirects: 0, proxy: false, responseType: 'text' });
    expect(setMemory).toHaveBeenCalled();
  });

  it('passes the real default cleaner result to URL ingestion with isolated embedding/storage boundaries', async () => {
    const result = await ingestUrl(sourceUrl);
    expect(result.source).toBe(sourceUrl);
    expect(result.chunkCount).toBe(1);
    const stored = saveRagDoc.mock.calls[0][0] as { content: string; url: string; metadata: Record<string, unknown> };
    expect(stored.url).toBe(sourceUrl);
    expect(stored.content).toContain(prose);
    expect(stored.content).toContain('SITE_HEADER_MARKER');
    expect(stored.content).toContain('LEGACY_SIDEBAR_MARKER');
    expect(stored.content).toContain('[LINKS]');
    expect(stored.content).not.toContain('SCRIPT_STATE_MARKER');
    expect(stored.metadata).toMatchObject({ sourceType: 'url', source: sourceUrl, chunkCount: 1 });
    expect(pipeline).not.toHaveBeenCalled();
  });

  it('builds real browser-search packets and hashes from the unchanged structured default wrapper', async () => {
    const providerHtml = `<div class="result"><div class="result__title"><a href="${sourceUrl}">Synthetic report</a></div>`
      + '<div class="result__snippet">A synthetic report snippet.</div></div>';
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue(new Response(providerHtml, { status: 200 }));
    const result = await webSearchAgent('synthetic observatory', {
      provider: 'duckduckgo-lite', fetchPages: 1, synthesize: false, traverseLinks: false
    });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].metadata.fetchStatus).toBe('ok');
    expect(result.sources[0].content).toContain(prose);
    expect(result.sources[0].content).toContain('LEGACY_SIDEBAR_MARKER');
    expect(result.sources[0].content).toContain('[LINKS]\n- Read methods -> https://evidence.example.org/methods');
    expect(result.sources[0].snapshot.contentHash).toBe(result.sources[0].contentHash);
    expect(result.sources[0].contentLength).toBe(result.sources[0].content?.length);
    expect(pipeline).not.toHaveBeenCalled();
    expect(saveRagDoc).not.toHaveBeenCalled();
  });

  it('keeps the separate system-state JSON wrapper outside HTML normalization', async () => {
    const state = { running: true, content: '<article class="has-guide-sidebar">literal JSON field</article>' };
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(state), {
      status: 200, headers: { 'content-type': 'application/json' }
    }));
    await expect(webFetcher('https://state.example.org/status')).resolves.toEqual(state);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('propagates Research cancellation through the real shared transport before inference or persistence', async () => {
    const parent = new AbortController();
    const cancelled = Object.assign(new Error('Synthetic research cancelled'), { name: 'AbortError' });
    let started!: () => void;
    const transferStarted = new Promise<void>(resolve => { started = resolve; });
    axiosGet.mockImplementation((_url, config) => new Promise((_resolve, reject) => {
      const signal = (config as { signal: AbortSignal }).signal;
      signal.addEventListener('abort', () => reject(new Error('Transport wrapped cancellation')), { once: true });
      started();
    }));
    const pending = researchTopic('cancelled observatory', [sourceUrl], { signal: parent.signal });
    await transferStarted;
    parent.abort(cancelled);
    await expect(pending).rejects.toBe(cancelled);
    expect(pipeline).not.toHaveBeenCalled();
    expect(setMemory).not.toHaveBeenCalled();
  });

  it('preserves the Research aggregate deadline while acquiring through the real shared fetcher', async () => {
    jest.useFakeTimers();
    let started!: () => void;
    const transferStarted = new Promise<void>(resolve => { started = resolve; });
    axiosGet.mockImplementation((_url, config) => new Promise((_resolve, reject) => {
      const signal = (config as { signal: AbortSignal }).signal;
      signal.addEventListener('abort', () => reject(new Error('Transport wrapped timeout')), { once: true });
      started();
    }));
    const pending = researchTopic('deadline observatory', [sourceUrl], { timeoutMs: 50 });
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await transferStarted;
    expect((axiosGet.mock.calls[0][1] as { timeout: number }).timeout).toBeLessThanOrEqual(50);
    await jest.advanceTimersByTimeAsync(50);
    await rejection;
    expect(pipeline).not.toHaveBeenCalled();
    expect(setMemory).not.toHaveBeenCalled();
  });

  it('keeps default string payloads bounded for long nested non-Gaming documents', async () => {
    const longBody = '<html><body>' + '<div class="report-wrapper">'.repeat(24)
      + '<article><p>BEGIN_LONG_REPORT ' + 'The observatory records a complete synthetic measurement. '.repeat(2300)
      + ' END_LONG_REPORT</p></article>' + '</div>'.repeat(24) + '</body></html>';
    accepted(longBody);
    const result = await fetchAndClean(sourceUrl);
    expect(result).toHaveLength(9000);
    expect(result).toContain('BEGIN_LONG_REPORT');
    expect(result).not.toContain('END_LONG_REPORT');
    expect(pipeline).not.toHaveBeenCalled();
  });

  it('keeps deep default layouts usable without introducing Gaming DOM normalization', async () => {
    accepted('<html><body>' + '<div class="has-guide-sidebar">'.repeat(2000)
      + '<article><p>' + prose + '</p></article>' + '</div>'.repeat(2000) + '</body></html>');
    expect(await fetchAndClean(sourceUrl)).toContain(prose);
  });

  it.each([undefined, [], ['[']])(
    'keeps default body extraction stable with absent, empty or malformed optional hints: %j', primaryContentSelectors => {
      const result = extractFetchAndCleanDocument(sourceUrl, body, 'text/html', 9000, { primaryContentSelectors });
      expect(result.text).toContain(prose);
      expect(result.text).toContain('SITE_HEADER_MARKER');
      expect(result.text).toContain('LEGACY_SIDEBAR_MARKER');
      expect(result.combined).toContain('[LINKS]');
    });

  it('keeps valid legacy selection hints usable beside a malformed optional hint', () => {
    const result = extractFetchAndCleanDocument(sourceUrl, body, 'text/html', 9000, {
      primaryContentSelectors: ['[', '.left-column-content']
    });
    expect(result.text).toContain(prose);
    expect(result.text).toContain('Observatory source subject');
    expect(result.text).not.toContain('SITE_HEADER_MARKER');
    expect(result.text).not.toContain('LEGACY_SIDEBAR_MARKER');
    expect(result.combined).toContain('[LINKS]');
  });

  it('keeps raw JSON inspection intact before legacy script stripping', async () => {
    let raw = '';
    const result = await fetchAndCleanDocument(sourceUrl, 9000, { onRawDocument: document => { raw = document.body; } });
    expect(raw).toContain('SCRIPT_STATE_MARKER');
    expect(raw).toBe(body);
    expect(result.text).not.toContain('SCRIPT_STATE_MARKER');
  });

  it('confines publisher layout normalization and furniture removal to the explicit Gaming options', () => {
    const publisherUrl = 'https://www.icy-veins.com/synthetic-observatory';
    const legacy = extractFetchAndCleanDocument(publisherUrl, body, 'text/html', 9000);
    const optedIn = extractFetchAndCleanDocument(publisherUrl, body, 'text/html', 9000, gamingDocumentFetchOptions(publisherUrl));
    expect(legacy.text).toContain('SITE_HEADER_MARKER');
    expect(legacy.text).toContain('LEGACY_SIDEBAR_MARKER');
    expect(optedIn.text).toContain(prose);
    expect(optedIn.text).toContain('Observatory source subject');
    expect(optedIn.text).not.toContain('SITE_HEADER_MARKER');
    expect(optedIn.text).not.toContain('LEGACY_SIDEBAR_MARKER');
    expect(optedIn.links).toEqual([]);
  });

  it.each([{ primaryContentSelectors: [''] }, { primaryContentSelectors: ['   '] }])(
    'uses the semantic fallback for blank optional primary selectors: $primaryContentSelectors', ({ primaryContentSelectors }) => {
    const fixture = '<div class="has-guide-sidebar"><article><header><h1>Observatory source subject</h1></header>'
      + '<p>' + prose + '</p></article></div>';
    const result = extractFetchAndCleanDocument(sourceUrl, fixture, 'text/html', 9000,
      gamingDocumentFetchOptions(sourceUrl, { primaryContentSelectors }));
    expect(result.text).toContain(prose);
    expect(result.text).toContain('Observatory source subject');
  });

  it('retains a valid trimmed selector beside blank hints without admitting real furniture', () => {
    const fixture = '<div class="has-guide-sidebar"><div class="custom-body"><header><h1>Observatory source subject</h1></header>'
      + '<p>' + prose + '</p></div><aside>FURNITURE_MARKER</aside></div>';
    const result = extractFetchAndCleanDocument(sourceUrl, fixture, 'text/html', 9000,
      gamingDocumentFetchOptions(sourceUrl, { primaryContentSelectors: ['', ' .custom-body ', '   '] }));
    expect(result.text).toContain(prose);
    expect(result.text).toContain('Observatory source subject');
    expect(result.text).not.toContain('FURNITURE_MARKER');
  });

  it('applies blank-hint fallback to the direct layout helper without reading past the existing selector cap', () => {
    const $ = load('<div class="has-guide-sidebar"><article><p>Primary article.</p></article></div>');
    preservePrimaryContentSidebarLayouts($, ['', '   ']);
    expect($('article').parent().attr('class')).toBe('');
    const capped = load('<div class="has-guide-sidebar"><div class="custom-body">Unreviewed content.</div></div>');
    preservePrimaryContentSidebarLayouts(capped, [...Array<string>(24).fill(''), '.custom-body']);
    expect(capped('.custom-body').parent().attr('class')).toBe('has-guide-sidebar');
  });

  it('counts genuine navigation once while retaining the legacy full-text output', () => {
    let metrics: FetchAndCleanExtractionMetrics | undefined;
    const navigationText = 'Route catalogue marker';
    const fixture = '<article><p>' + prose.repeat(8) + '</p></article>'
      + '<nav>' + '<div class="guide-sidebar">'.repeat(80) + navigationText + '</div>'.repeat(80) + '</nav>';
    const result = extractFetchAndCleanDocument(sourceUrl, fixture, 'text/html', 9000, {
      onExtraction: value => { metrics = value; }
    });
    expect(result.text).toContain(navigationText);
    expect(metrics?.navigationDensity).toBeGreaterThan(0);
    expect(metrics?.navigationDensity).toBeLessThan(0.1);
    expect(metrics?.navigationPenalty).toBeGreaterThan(0);
  });
});

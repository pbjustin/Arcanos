import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';

const transport = jest.fn();
const resolve4 = jest.fn<(host: string) => Promise<string[]>>().mockResolvedValue(['93.184.216.34']);
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(transport) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  resolve4(host: string) { return resolve4(host); }
  async resolve6() { return []; }
  cancel() {}
} }));

const { buildGamingRagContext, clearGamingRagCache } = await import('../src/services/gamingWebContext.js');
const { logger } = await import('../src/platform/logging/structuredLogging.js');
const { GAMING_DOCUMENT_ACQUISITION_LIMITS } = await import('../src/services/gamingDocumentResolution.js');

const game = 'Lantern Voyage';
const first = 'https://guides.example.org/start-guide';
const blocked = 'https://guides.example.org/blocked-guide';
const alternative = 'https://guides.example.org/amber-gate-guide';
const prompt = 'How do I activate the amber gate in Lantern Voyage?';
// Acquired prose is synthetic. The production admission, protected hop loop,
// discovery adapter/ranking/cap, extraction, selection and provenance stay real.
const body = `<html><title>${game} walkthrough</title><body><article><h1>${game} gameplay guide</h1>`
  + `<p>In the game ${game}, activate the amber gate by aligning the brass handle with the eastern lamp. `
  + 'The amber gate opens only after the eastern lamp stays lit. Turn the brass handle once the eastern lamp stays lit, '
  + 'then walk through the open amber gate.</p></article></body></html>';
const env = {
  ARCANOS_GAMING_RAG_ENABLED: 'true', ARCANOS_GAMING_DISCOVERY_ENABLED: 'true',
  ARCANOS_GAMING_DISCOVERY_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'synthetic-search-fixture-only',
  ARCANOS_GAMING_CURATED_SOURCES_JSON: '[]', ARCANOS_GAMING_DISCOVERY_FETCH_CANDIDATE_LIMIT: '1',
  ARCANOS_GAMING_DISCOVERY_BUDGET_MS: '5000', ARCANOS_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS: '1000',
  ARCANOS_GAMING_WEB_CONTEXT_CHARS: '5000', ARCANOS_GAMING_RAG_CHUNK_CHARS: '1200',
  ARCANOS_GAMING_DISCOVERY_DOMAIN_ALLOWLIST: '', ARCANOS_GAMING_DISCOVERY_DOMAIN_BLOCKLIST: ''
};
let previousEnv: Record<string, string | undefined>;
let search: ReturnType<typeof jest.fn>;
let hops: string[];
let servePage: (url: string) => ReturnType<typeof response>;
const logContext = { module: 'ARCANOS:GAMING' as const, route: 'gaming' as const, mode: 'guide' as const,
  sourceEndpoint: 'failed-redirect-fixture' };

/** Use the production RAG entry without stored data, provider inference or durable effects. */
function retrieve(signal?: AbortSignal) {
  return buildGamingRagContext({ mode: 'guide', game, prompt, guideUrl: first, guideUrls: [] }, logContext, signal);
}

/** Provide a disposable response with the same raw headers the protected stream inspects. */
function response(status: number, data = '', headers: Record<string, string> = { 'content-type': 'text/html' }) {
  const stream = Object.assign(Readable.from([Buffer.from(data)]), { rawHeaders: Object.entries(headers).flat() });
  stream.on('error', () => undefined);
  return { status, headers, data: stream };
}

/** Fixture only the Brave HTTP boundary; the actual adapter applies admission before its one-slot cap. */
function searchResults(urls = [blocked, alternative]) {
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin + url.pathname).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(options?.redirect).toBe('error'); expect(options?.signal).toBeDefined();
    expect(new Headers(options?.headers).get('x-subscription-token')).toBe('synthetic-search-fixture-only');
    search();
    return new Response(JSON.stringify({ web: { results: urls.map(candidate => ({ url: candidate,
      title: `${game} amber gate walkthrough`, description: 'Activate the amber gate with the brass handle and eastern lamp.' })) } }),
    { headers: { 'content-type': 'application/json' } });
  });
}

beforeEach(() => {
  jest.clearAllMocks(); clearGamingRagCache(); hops = []; search = jest.fn();
  previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  for (const level of ['info', 'warn', 'error', 'debug'] as const) jest.spyOn(logger, level).mockImplementation(() => undefined);
  servePage = url => {
    if (url === first) return response(302, '', { location: blocked });
    if (url === blocked) return response(403);
    expect(url).toBe(alternative);
    return response(200, body);
  };
  transport.mockImplementation(async (url: string, options: any) => {
    expect(new URL(url).hostname).toBe('93.184.216.34');
    expect(options).toMatchObject({ maxRedirects: 0, proxy: false, responseType: 'stream', decompress: false, signal: expect.any(Object) });
    expect(options.httpsAgent.options).toMatchObject({ servername: options.headers.Host, rejectUnauthorized: true });
    expect(options.timeout).toBeLessThanOrEqual(1000);
    expect(options.maxBodyLength).toBeLessThanOrEqual(GAMING_DOCUMENT_ACQUISITION_LIMITS.maxTransferredBytes);
    const headers = new Headers(options.headers);
    expect(headers.has('authorization')).toBe(false); expect(headers.has('cookie')).toBe(false);
    expect(headers.has('x-subscription-token')).toBe(false);
    const logical = new URL(url); logical.hostname = options.headers.Host; hops.push(logical.href);
    return servePage(logical.href);
  });
});

afterEach(() => {
  clearGamingRagCache();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  jest.restoreAllMocks();
});

describe('failed protected redirect attempts remain excluded before discovery truncation', () => {
  it('recovers A→B→403 through C without spending its only discovery slot on B again', async () => {
    searchResults();
    const result = await retrieve();
    expect(hops).toEqual([first, blocked, alternative]);
    expect(search).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ discoveryTriggered: true, candidateCount: 1, fetchedCandidateCount: 1,
      acceptedSourceCount: 1, rejectedCandidateCount: 1 });
    expect(result.sources).toEqual(expect.arrayContaining([expect.objectContaining({ url: alternative, snippet: expect.stringContaining('brass handle') })]));
    expect(result.clearKnowledge?.evidence?.some(chunk => chunk.publicUrl === alternative && chunk.text.includes('amber gate'))).toBe(true);
    expect(result.context).toContain(alternative); expect(result.context).not.toContain(blocked);
    expect(JSON.stringify(result)).not.toContain('onRequestUrl');
  });

  it.each([
    ['private destination', 'https://127.0.0.1/private-guide'],
    ['sensitive destination', `${blocked}?token=synthetic-rejected-marker`]
  ])('never requests or publishes a rejected %s while recovering with C', async (_label, rejected) => {
    servePage = url => url === first ? response(302, '', { location: rejected }) : response(200, body);
    searchResults([rejected, alternative]);
    const result = await retrieve();
    expect(hops).toEqual([first, alternative]); expect(search).toHaveBeenCalledTimes(1);
    expect(result.acceptedSourceCount).toBe(1); expect(result.context).toContain(alternative);
    expect(JSON.stringify(result)).not.toContain(rejected);
    expect(JSON.stringify([...jest.mocked(logger.info).mock.calls, ...jest.mocked(logger.warn).mock.calls]))
      .not.toContain('synthetic-rejected-marker');
    expect(resolve4).not.toHaveBeenCalledWith('127.0.0.1');
  });

  it('does not exclude an unapproved redirect destination that was never attempted', async () => {
    const foreign = 'https://second.example.org/amber-gate-guide';
    servePage = url => {
      if (url === first) return response(302, '', { location: foreign });
      expect(url).toBe(foreign);
      return response(200, body);
    };
    searchResults([foreign, alternative]);
    const result = await retrieve();
    expect(hops).toEqual([first, foreign]); expect(search).toHaveBeenCalledTimes(1);
    expect(result.acceptedSourceCount).toBe(1); expect(result.context).toContain(foreign);
    expect(result.clearKnowledge?.evidence?.every(chunk => chunk.publicUrl === foreign)).toBe(true);
  });

  it('retains a failed destination when the existing byte cap rejects its declared response size', async () => {
    servePage = url => {
      if (url === first) return response(302, '', { location: blocked });
      return url === blocked ? response(200, '', { 'content-type': 'text/html',
        'content-length': String(GAMING_DOCUMENT_ACQUISITION_LIMITS.maxTransferredBytes + 1) }) : response(200, body);
    };
    searchResults();
    const result = await retrieve();
    expect(hops).toEqual([first, blocked, alternative]);
    expect(result.acceptedSourceCount).toBe(1); expect(result.context).toContain(alternative);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('retains a failed destination when its original acquisition deadline expires', async () => {
    const realNow = Date.now.bind(Date);
    let elapsedMs = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + elapsedMs);
    servePage = url => {
      if (url === first) return response(302, '', { location: blocked });
      if (url === blocked) { elapsedMs += 2000; return response(403); }
      return response(200, body);
    };
    searchResults();
    const result = await retrieve();
    expect(hops).toEqual([first, blocked, alternative]);
    expect(result.acceptedSourceCount).toBe(1); expect(result.context).toContain(alternative);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('keeps redirect-loop rejection bounded and discovers C instead of retrying B', async () => {
    servePage = url => {
      if (url === first) return response(302, '', { location: blocked });
      return url === blocked ? response(302, '', { location: first }) : response(200, body);
    };
    searchResults();
    const result = await retrieve();
    expect(hops).toEqual([first, blocked, alternative]);
    expect(result.acceptedSourceCount).toBe(1); expect(search).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation after B without discovery, another hop or evidence', async () => {
    const controller = new AbortController();
    const cancelled = new Error('Synthetic caller cancellation.');
    servePage = url => {
      if (url === first) return response(302, '', { location: blocked });
      expect(url).toBe(blocked); controller.abort(cancelled); return response(403);
    };
    searchResults();
    await expect(retrieve(controller.signal)).rejects.toBe(cancelled);
    expect(hops).toEqual([first, blocked]); expect(search).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

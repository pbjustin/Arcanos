import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { gamingStructuredResourceFixtures } from './testUtils/gamingStructuredResourceFixtures.js';
import { gamingArchiveDerivativePath, gamingArchiveGuideText, gamingArchiveGuideUrl,
  gamingArchiveMetadata, gamingArchiveStorageHost } from './testUtils/gamingArchiveFixtures.js';

const http = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { ingestGamingBuildResource, clearGamingBuildResourceCache } = await import('../src/services/gamingBuildResources.js');
const { resolveGamingDocument } = await import('../src/services/gamingDocumentResolution.js');
const { extractGamingFreshnessMetadata, evaluateGamingFreshness } = await import('../src/shared/gaming/gamingFreshnessCore.js');
const { buildGamingRagContext, clearGamingRagCache, isCitableGamingWebSource } = await import('../src/services/gamingWebContext.js');
const { logger } = await import('../src/platform/logging/structuredLogging.js');
const fixture = gamingStructuredResourceFixtures[0];
const game = 'Portal 2';
const url = 'https://guides.example.org/cr-extraction';
const passage = 'The copper key opens the canal gate. Collect the copper key before crossing the canal bridge.';
const html = (body: string) => `<html><title>${game} guide</title><main><article><h1>${game} guide</h1>`
  + `<p>In the game ${game}, ${passage}</p><p>Edition: base-game.</p>${body}</article></main></html>`;
const env = { ARCANOS_GAMING_RAG_ENABLED: 'true', ARCANOS_GAMING_DISCOVERY_ENABLED: 'false',
  ARCANOS_GAMING_CURATED_SOURCES_JSON: '[]', ARCANOS_GAMING_WEB_CONTEXT_CHARS: '5000' };
let previous: Record<string, string | undefined>;
beforeEach(() => {
  http.mockReset(); clearGamingBuildResourceCache(); clearGamingRagCache();
  previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  jest.spyOn(logger, 'info').mockImplementation(() => undefined); jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  jest.restoreAllMocks();
});
function payloadUrl(payload: unknown) {
  const result = new URL(fixture.jsonUrl); result.search = ''; result.searchParams.set('build', JSON.stringify(payload)); return result.toString();
}
function rejected(result: Awaited<ReturnType<typeof ingestGamingBuildResource>>) {
  expect(result).toMatchObject({ build: null, quality: 'unusable', evidenceText: '', publicSnippet: '', cacheHit: false,
    failureReason: 'SOURCE_USE_RESTRICTED', validation: { accepted: false } });
}
function serveArchive(text: string) {
  http.mockImplementation(async (target: string, options: { headers: { Host: string } }) => {
    const path = new URL(target).pathname;
    if (options.headers.Host === 'archive.org' && path === '/metadata/KH1.5_guide')
      return { data: JSON.stringify(gamingArchiveMetadata(text)), headers: { 'content-type': 'application/json' } };
    expect(options.headers.Host).toBe(gamingArchiveStorageHost); expect(path).toBe(gamingArchiveDerivativePath);
    return { data: text, headers: { 'content-type': 'text/plain' } };
  });
}

// All HTML, derivative prose and decoded records below are authored synthetic
// fixtures. Only HTTP/DNS transport is substituted for protected acquisition.
describe('CodeRabbit extraction source-use boundaries', () => {
  it.each(['title', 'description', 'og:title', 'og:description'])('checks full raw %s before retaining a metadata prefix', async field => {
    const value = 'Build preparation '.repeat(45) + 'No automated use.';
    const metadata = field === 'title' ? `<title>${value}</title>` : field === 'description'
      ? `<meta name="description" content="${value}">` : `<meta property="${field}" content="${value}">`;
    for (let attempt = 0; attempt < 2; attempt++) rejected(await ingestGamingBuildResource({
      url: payloadUrl(fixture.payload), requestedGame: fixture.game, html: `<html><head>${metadata}</head><body></body></html>` }));
  });

  it.each(['URL payload', 'embedded state'])('inspects restricted supported fields in every decoded sibling before ranking: %s', async kind => {
    const payload = { builds: [fixture.payload, { game: fixture.game, title: 'Secondary loadout',
      equipment: [{ name: 'Copper shield' }], notes: ['No automated use.'] }] };
    const resource = kind === 'URL payload' ? { url: payloadUrl(payload) }
      : { url: fixture.jsonUrl, metadata: { embeddedState: payload } };
    for (let attempt = 0; attempt < 2; attempt++) rejected(await ingestGamingBuildResource(resource));
  });

  it('does not let a clean adapter rescue a restricted lower-ranked decoded sibling', async () => {
    const extract = jest.fn(async () => ({ ...fixture.payload, source: { url: fixture.jsonUrl,
      resourceType: fixture.resourceType, extractor: 'synthetic-clean', confidence: 1 } }));
    rejected(await ingestGamingBuildResource({ url: payloadUrl({ builds: [fixture.payload,
      { game: fixture.game, equipment: [{ name: 'Copper shield' }], notes: ['No automated use.'] }] }) },
    { adapters: [{ id: 'synthetic-clean-sibling', version: '1', canHandle: async () => 1, extract }] }));
    expect(extract).not.toHaveBeenCalled();
  });

  it('carries the full acquired Archive derivative restriction beyond the selected prose ceiling', async () => {
    const text = gamingArchiveGuideText + '\n\n' + passage.repeat(15) + '\n\nNo automated use.';
    serveArchive(text);
    const document = await resolveGamingDocument(gamingArchiveGuideUrl, 800);
    expect(document.text).not.toContain('No automated use.');
    expect(document.rawDocument?.body).toContain('No automated use.');
    expect(document.sourceUseRestricted).toBe(true);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await buildGamingRagContext({ game: 'Kingdom Hearts HD 1.5 Remix', mode: 'guide',
        prompt: 'How should Sora prepare at the lantern checkpoint?', guideUrl: gamingArchiveGuideUrl, guideUrls: [] });
      expect(result.sources.filter(isCitableGamingWebSource)).toEqual([]);
      expect(result.clearKnowledge?.evidence ?? []).toEqual([]);
    }
  });

  it('excludes an acquired restriction beyond the RAG resolver ceiling from initial and cached evidence', async () => {
    // Archive requests project at most 100000 characters for RAG. The accepted
    // derivative remains within the existing raw-body budget and is fully scanned.
    const text = gamingArchiveGuideText + '\n\n' + passage.repeat(1500) + '\n\nNo automated use.';
    expect(text.indexOf('No automated use.')).toBeGreaterThan(100_000);
    serveArchive(text);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await buildGamingRagContext({ game: 'Kingdom Hearts HD 1.5 Remix', mode: 'guide',
        prompt: 'How should Sora prepare at the lantern checkpoint?', guideUrl: gamingArchiveGuideUrl, guideUrls: [] });
      expect(result.sources.filter(isCitableGamingWebSource)).toEqual([]);
      expect(result.clearKnowledge?.evidence ?? []).toEqual([]);
    }
  });
});

describe('CodeRabbit protected HTML extraction', () => {
  it('retains an unpunctuated linked factual predicate while omitting nominal catalog links', async () => {
    http.mockResolvedValue({ headers: { 'content-type': 'text/html' }, data: html('<ul>'
      + '<li><a href="/key">Copper key opens the canal gate</a></li>'
      + '<li><a href="/catalog">Copper key locations and upgrades</a></li></ul>') });
    const document = await resolveGamingDocument(url);
    expect(document.text).toContain('Copper key opens the canal gate');
    expect(document.text).not.toContain('Copper key locations and upgrades');
    expect(http).toHaveBeenCalledTimes(1);
  });

  it.each([['Platforms', 'Xbox', { platform: 'PC' }], ['Regions', 'EU', { region: 'US' }]] as const)
    ('fails closed when an unlabelled list prefix precedes explicit %s', async (field, value, request) => {
      http.mockResolvedValue({ headers: { 'content-type': 'text/html' }, data: html(
        `<ul><li>Important scope<br>${field}: ${value}</li></ul>`) });
      const document = await resolveGamingDocument(url);
      expect(document.text).toContain(value);
      const freshness = extractGamingFreshnessMetadata(document, { game, ...request });
      expect(evaluateGamingFreshness({ game, ...request, mode: 'guide', question: 'How do I open the canal gate?',
        evidence: [freshness] }).usable).toBe(false);
      expect(freshness.metadataUnverified).toBe(true);
    });
});

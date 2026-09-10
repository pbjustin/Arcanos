import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';

const http = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { buildGamingRagContext, clearGamingRagCache } = await import('../src/services/gamingWebContext.js');
const { assessGamingClearEvidence } = await import('../src/shared/gaming/gamingClearEvidence.js');
const names = ['ARCANOS_GAMING_DISCOVERY_ENABLED', 'ARCANOS_GAMING_RAG_ENABLED', 'ARCANOS_GAMING_RAG_CHUNK_CHARS',
  'ARCANOS_GAMING_RAG_MAX_CHUNKS', 'ARCANOS_GAMING_RAG_MAX_SOURCES', 'ARCANOS_GAMING_WEB_CONTEXT_CHARS'] as const;
let saved: Array<string | undefined>;
const url = 'https://example.org/testspace-report';
const input = { game: 'Testspace', mode: 'guide' as const, prompt: 'Which system body site reports Platinum?', guideUrl: url, guideUrls: [], spoilerMode: 'none' as const };
const page = (rows = '<tr><td>T-1</td><td>B 2</td><td>PML 7</td><td>Platinum</td></tr>', extra = '') => `<html><head><title>Testspace guide</title></head><body><main><table><caption>Testspace</caption><tr><th>System</th><th>Body</th><th>Site</th><th>Resource</th></tr>${rows}</table></main>${extra}</body></html>`;
const platinumProse = 'Testspace guide. This community source reports Platinum at system T-1, body B 2, site PML 7. It is a source assertion and current applicability remains unverified. Always check local conditions before using this reported resource location.';
const mixedPage = (rows: string, prose = platinumProse) => page(rows).replace('<main>', `<main><article><p>${prose}</p></article>`);

describe('actual secure acquisition into ordinary supplied URL structured RAG', () => {
  beforeEach(() => {
    saved = names.map(name => process.env[name]);
    ['false', 'true', '320', '8', '4', '5000'].forEach((value, index) => { process.env[names[index]] = value; });
    clearGamingRagCache(); http.mockReset();
    http.mockResolvedValue({ data: page(), headers: { 'content-type': 'text/html' } });
  });
  afterEach(() => {
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
    clearGamingRagCache();
  });
  it('retains a short intact record and real source CLEAR/provenance through a cache hit', async () => {
    for (const cacheHit of [false, true]) {
      const assessmentStartedAt = Date.now();
      const result = await buildGamingRagContext(input);
      expect(result).toMatchObject({ selectedChunkCount: 1, cacheHit });
      expect(result.clearKnowledge?.evidence?.[0].text.length).toBeLessThan(120);
      expect(result.clearKnowledge?.evidence?.[0].evidenceUnits?.[0]).toMatchObject({ kind: 'table_row', integrity: { status: 'complete' },
        provenance: { strategy: 'html_table', sourceUrl: url } });
      expect(result.clearKnowledge?.sources[0].clearSourceAssessment).toMatchObject({ decision: 'accept', gates: { claimSupport: 'verified' } });
      expect(Date.parse(result.clearKnowledge!.sources[0].clearSourceAssessment!.evaluatedAt)).toBeGreaterThanOrEqual(assessmentStartedAt);
      expect(assessGamingClearEvidence(input, result.clearKnowledge!)).toMatchObject({ decision: 'accept', gates: { claimSupport: 'verified' } });
      expect(result.context).toContain('current availability and independent corroboration are not established');
      expect(result.currentEvidenceAvailable).toBe(false);
    }
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('omits a whole record when final context headers leave too little room, including a cache hit', async () => {
    expect((await buildGamingRagContext(input)).selectedChunkCount).toBe(1);
    process.env.ARCANOS_GAMING_WEB_CONTEXT_CHARS = '200';
    const result = await buildGamingRagContext(input);
    expect(result).toMatchObject({ selectedChunkCount: 0, cacheHit: true });
    expect(result.clearKnowledge?.evidence).toEqual([]);
    expect(result.sources).toEqual([]);
  });
  it('keeps independent prose usable when an unrelated resource table is present, including a cache hit', async () => {
    http.mockResolvedValue({ data: mixedPage('<tr><td>OTHER-1</td><td>A 1</td><td>PML 1</td><td>Iron</td></tr>'), headers: { 'content-type': 'text/html' } });
    for (const cacheHit of [false, true]) {
      const result = await buildGamingRagContext(input);
      expect(result).toMatchObject({ cacheHit });
      expect(result.selectedChunkCount).toBeGreaterThan(0);
      expect(result.context).toContain('reports Platinum at system T-1, body B 2, site PML 7');
      expect(result.clearKnowledge?.evidence?.every(chunk => !chunk.evidenceUnits?.length)).toBe(true);
      expect(assessGamingClearEvidence(input, result.clearKnowledge!)).toMatchObject({ decision: 'accept', gates: { claimSupport: 'verified' } });
    }
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('does not treat requested field labels as a missing resource anchor in independent prose', async () => {
    const generic = 'Testspace guide. Each system body site has a resource report. Source records describe the system body site and resource; check the source report before visiting a location. These system body site records are community reports with unverified current applicability.';
    http.mockResolvedValue({ data: mixedPage('<tr><td>OTHER-1</td><td>A 1</td><td>PML 1</td><td>Iron</td></tr>', generic), headers: { 'content-type': 'text/html' } });
    expect((await buildGamingRagContext(input)).selectedChunkCount).toBe(0);
  });
  it.each([
    '<tr><td>T-1</td><td>B 2</td><td></td><td>Platinum</td></tr>',
    '<tr><td>T-1</td><td>B 2</td><td>PML 7</td><td>not Platinum; depleted</td></tr>',
    '<tr><td>T-1</td><td>B 2</td><td>PML 7</td><td>Platinum</td></tr><tr><td>T-1</td><td>B 2</td><td>PML 7</td><td>Iron</td></tr>'
  ])('keeps relevant partial, qualified, or contradictory records from being bypassed by positive prose', async rows => {
    http.mockResolvedValue({ data: mixedPage(rows), headers: { 'content-type': 'text/html' } });
    for (const cacheHit of [false, true]) {
      const result = await buildGamingRagContext(input);
      expect(result).toMatchObject({ selectedChunkCount: 0, cacheHit });
    }
  });
  it.each([
    '<tr><td>T-1</td><td>B 2</td><td></td><td>Platinum</td></tr><tr><td>OTHER-1</td><td>A 1</td><td>PML 1</td><td>Iron</td></tr>',
    '<tr><td>T-1</td><td>B 2</td><td>PML 7</td><td>not Platinum; depleted</td></tr>'
  ])('does not let rejected structural values fall back into prose evidence', async rows => {
    http.mockResolvedValue({ data: page(rows), headers: { 'content-type': 'text/html' } });
    const result = await buildGamingRagContext(input);
    expect(result.selectedChunkCount).toBe(0);
    expect(result.clearKnowledge?.evidence).toEqual([]);
  });
  it('retains source-use prohibitions found outside the selected table', async () => {
    http.mockResolvedValue({ data: page(undefined, '<footer>Do not store this content. No automated access.</footer>'), headers: { 'content-type': 'text/html' } });
    const result = await buildGamingRagContext(input);
    expect(result.selectedChunkCount).toBe(0);
    expect(result.sources.some(source => source.error)).toBe(true);
  });
});

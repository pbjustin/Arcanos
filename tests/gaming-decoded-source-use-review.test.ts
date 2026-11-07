import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { gamingStructuredResourceFixtures } from './testUtils/gamingStructuredResourceFixtures.js';

const http = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { buildGamingRagContext, clearGamingRagCache, isCitableGamingWebSource } = await import('../src/services/gamingWebContext.js');
const { assessGamingClearEvidence } = await import('../src/shared/gaming/gamingClearEvidence.js');
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { clearGamingBuildResourceCache } = await import('../src/services/gamingBuildResources.js');
const { resolveGamingDocument } = await import('../src/services/gamingDocumentResolution.js');
const env = { ARCANOS_GAMING_RAG_ENABLED: 'true', ARCANOS_GAMING_DISCOVERY_ENABLED: 'false',
  ARCANOS_GAMING_CURATED_SOURCES_JSON: '[]', ARCANOS_GAMING_WEB_CONTEXT_CHARS: '5000', ARCANOS_GAMING_RAG_CHUNK_CHARS: '1200' };
let previousEnv: Record<string, string | undefined>;
beforeEach(() => {
  jest.clearAllMocks(); clearGamingRagCache(); clearGamingBuildResourceCache();
  previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
});
afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const encoded = (text: string, escape: boolean) => escape ? text.replace('automated', 'autom\\u0061ted') : text;

describe('independent decoded source-use audit', () => {
  it.each([false, true])('rejects protected JSON notes before evidence projection, escaped=%s', async escape => {
    const url = 'https://guides.example.org/decoded-source-use-record';
    const body = encoded(JSON.stringify({ game: 'Portal 2', edition: 'base-game', records: [
      { item: 'Copper shield', stat: 'damage', value: 77, unit: 'points', scope: 'base-game', notes: ['No automated use.'] }
    ] }), escape);
    http.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: body });
    const input = { game: 'Portal 2', mode: 'guide' as const, prompt: 'What is Copper shield damage?', guideUrl: url, guideUrls: [] };
    const candidate = await evaluateGamingHybridCandidates({ ...input, protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] },
      { actorKey: 'synthetic-decoded-source-use-review' });
    expect(candidate.accepted).toHaveLength(0);
    expect(candidate.decisions[0].reasonCodes).toContain('SOURCE_USE_RESTRICTED');
    const document = await resolveGamingDocument(url);
    expect(document.text).toContain('No automated use.');
    expect(document.sourceUseRestricted).toBe(true);
    const result = await buildGamingRagContext(input);
    const assessment = assessGamingClearEvidence(input, result.clearKnowledge!);
    expect({ citableSources: result.sources.filter(isCitableGamingWebSource).length,
      selectedPassages: result.clearKnowledge?.evidence?.length ?? 0, claimSupport: assessment.gates.claimSupport, decision: assessment.decision })
      .toEqual({ citableSources: 0, selectedPassages: 0, claimSupport: expect.not.stringMatching(/^verified$/u), decision: expect.not.stringMatching(/^accept$/u) });
  });

  it.each([false, true])('rejects consumed decoded typed-build notes in HTTP503 fallback, escaped=%s', async escape => {
    const fixture = gamingStructuredResourceFixtures[0];
    const url = new URL(fixture.jsonUrl);
    url.search = '';
    url.searchParams.set('build', encoded(JSON.stringify({ ...fixture.payload, notes: ['No automated use.'] }), escape));
    http.mockResolvedValue({ status: 503, headers: { 'content-type': 'text/html' }, data: '' });
    const input = { mode: 'guide' as const, game: fixture.game, prompt: 'Explain Light Ion Blaster II equipment.',
      guideUrl: url.toString(), guideUrls: [] };
    const result = await buildGamingRagContext(input);
    const assessment = assessGamingClearEvidence(input, result.clearKnowledge!);
    expect({ citableSources: result.sources.filter(isCitableGamingWebSource).length,
      selectedPassages: result.clearKnowledge?.evidence?.length ?? 0, claimSupport: assessment.gates.claimSupport, decision: assessment.decision })
      .toEqual({ citableSources: 0, selectedPassages: 0, claimSupport: expect.not.stringMatching(/^verified$/u), decision: expect.not.stringMatching(/^accept$/u) });
  });
});

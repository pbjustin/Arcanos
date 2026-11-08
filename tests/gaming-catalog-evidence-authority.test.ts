import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { gamingCatalogAuthorityFixture as fixture, gamingCompiledHttpCatalogFixture } from './fixtures/gaming-catalog-authority.js';
import type { GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';

const http = jest.fn();
const trinity = jest.fn();
const forbiddenWrite = jest.fn(async () => { throw new Error('Synthetic catalog fixture forbids durable writes.'); });
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({ runTrinityWritingPipeline: trinity }));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({ getOpenAIClientOrAdapter: () => ({ client: {} }) }));
const { resolveGamingDocument } = await import('../src/services/gamingDocumentResolution.js');
const { assessGamingClearSourceIdentity, assessGamingClearSource } = await import('../src/shared/gaming/gamingClearSource.js');
const { assessGamingSourcePolicy, extractGamingFreshnessMetadata } = await import('../src/shared/gaming/gamingFreshnessCore.js');
const { classifyGamingDocumentQuality } = await import('../src/shared/gaming/gamingDocumentIngestionCore.js');
const { assessGamingClearEvidence, assessGamingRequestCoverage } = await import('../src/shared/gaming/gamingClearEvidence.js');
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { createGamingHybridWorkflow } = await import('../src/services/gamingHybridKnowledge.js');
const { runGameplayPipeline } = await import('../src/services/gamingPipeline.js');
const { logger } = await import('../src/platform/logging/structuredLogging.js');
const input = { game: fixture.game, mode: 'guide' as const, prompt: fixture.question, guideUrls: [], auditEnabled: false };
const actor = { actorKey: 'synthetic-catalog-authority-reader' };

async function acquiredKnowledge(game = fixture.game): Promise<GamingStoredKnowledgeContext> {
  const document = await resolveGamingDocument(fixture.url);
  const fetchedAt = new Date().toISOString();
  return { context: `[Source 1]\n${document.text}`, sourceKnown: true,
    sources: [{ sourceId: 'catalog-source', game, url: fixture.url, title: document.metadata.title,
      sourceType: 'supplied', origin: 'live', fetchedAt, snippet: document.text }],
    evidence: [{ sourceId: 'catalog-source', revisionId: 'catalog-revision', recordId: 'catalog-record',
      recordType: 'guide', publicUrl: fixture.url, text: document.text, lexicalScore: 1, combinedScore: 1,
      provenance: { fetchedAt }, ...(document.evidenceUnits?.length ? { evidenceUnits: document.evidenceUnits } : {}) }] };
}
beforeEach(() => {
  jest.clearAllMocks();
  trinity.mockResolvedValue({ result: 'Synthetic dry-run sentinel.', fallbackFlag: true, dryRun: true });
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
});
afterEach(() => { expect(forbiddenWrite).not.toHaveBeenCalled(); jest.restoreAllMocks(); });

describe.each(fixture.cases)('non-authoritative $id through acquired and selected evidence', example => {
  beforeEach(() => http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: fixture.html(example.text) }));

  it('retains independent game identity without classifying names and length as gameplay', async () => {
    const document = await resolveGamingDocument(fixture.url);
    expect(document.text.length).toBeGreaterThan(120);
    expect(assessGamingClearSourceIdentity(document, input, assessGamingSourcePolicy(fixture.url, fixture.game)).status).toBe('verified');
    expect(classifyGamingDocumentQuality({ cleanedText: document.text, metadata: document.metadata, game: fixture.game,
      evidenceUnits: document.evidenceUnits, truncated: false, minUsefulTextChars: 120 })).toBe('metadata-only');
  });

  it('cannot supply selected request support or a verified CLEAR claim-support gate', async () => {
    const knowledge = await acquiredKnowledge();
    expect(assessGamingRequestCoverage(input, knowledge).coverageSatisfied).toBe(false);
    const assessment = assessGamingClearEvidence(input, knowledge, { identityVerified: true, requireRequestCoverage: true });
    expect(assessment.gates.claimSupport).not.toBe('verified');
    expect(assessment.decision).not.toBe('accept');
  });

  it('cannot independently acquire source CLEAR gameplay authority', async () => {
    const document = await resolveGamingDocument(fixture.url);
    const now = new Date();
    const assessment = assessGamingClearSource(input, document, { subjectId: 'catalog-source', subjectHash: 'a'.repeat(64),
      actorScopeHash: 'b'.repeat(64), sourcePolicy: assessGamingSourcePolicy(fixture.url, fixture.game),
      freshness: extractGamingFreshnessMetadata(document, input, now), now, allowPartialCoverage: true });
    expect(assessment.gates.claimSupport).not.toBe('verified');
    expect(assessment.qualityEligible).toBe(false);
  });

  it('stops the actual direct answer pipeline before the provider boundary', async () => {
    const knowledge = await acquiredKnowledge();
    await runGameplayPipeline(input, { knowledge, current: true, qualification: '' });
    expect(trinity.mock.calls.length).toBe(0);
  });

  it('cannot become an accepted hybrid gameplay candidate', async () => {
    const result = await evaluateGamingHybridCandidates({ ...input, protocolVersion: 'gaming-hybrid-v2',
      candidates: [{ url: fixture.url }] }, actor);
    expect(result.accepted.length).toBe(0);
    expect(result.knowledge.evidence ?? []).toEqual([]);
  });

  it('cannot make a hybrid workflow generation-ready or invoke its provider', async () => {
    const workflow = createGamingHybridWorkflow({
      retrieve: async () => ({ context: '', sources: [], evidence: [], sourceKnown: false }), ingest: forbiddenWrite as never });
    const queried = await workflow.query({ contractVersion: 'gaming-hybrid-v2', idempotencyKey: `${example.id}-query`,
      game: fixture.game, mode: 'guide', question: fixture.question, storagePolicy: 'transient_only' }, actor);
    const submitted = await workflow.candidates({ contractVersion: 'gaming-hybrid-v2', workflowId: queried.body.workflowId,
      expectedRevision: queried.body.revision, idempotencyKey: `${example.id}-candidate`,
      candidates: [{ url: fixture.url }] }, actor);
    expect(submitted.body.coverageSatisfied).toBe(false);
    expect(submitted.body.evidenceSelected).toBe(false);
    expect(submitted.body.selectedEvidenceIds ?? []).toEqual([]);
    expect(submitted.body.state).not.toBe('answer_ready');
    expect(submitted.body.nextAction).not.toBe('answer');
    expect(submitted.body.answer).toBeUndefined();
    expect(trinity.mock.calls.length).toBe(0);
  });
});

it('does not restore catalog-label authority when lexical retrieval returns only a stored fragment', async () => {
  http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: fixture.html(fixture.cases[1].text) });
  const knowledge = await acquiredKnowledge();
  knowledge.sources[0].origin = 'stored';
  knowledge.evidence![0].text = 'copper shield acquisition; copper shield locations; copper shield upgrades; copper shield skills.';
  expect(assessGamingRequestCoverage(input, knowledge).coverageSatisfied).toBe(false);
  expect(assessGamingClearEvidence(input, knowledge, { identityVerified: true }).gates.claimSupport).not.toBe('verified');
});

it('does not interpret a preposition inside an independently acquired game name as a gameplay location', async () => {
  const game = 'Paths in Copper';
  const title = `${game} copper shield guide`;
  const text = `In the game ${game}, Copper shield locations and Copper shield upgrades and Copper shield skills and Copper shield equipment categories.`;
  http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' },
    data: `<html><title>${title}</title><article><h1>${title}</h1><p>${text}</p></article></html>` });
  const document = await resolveGamingDocument(fixture.url);
  const request = { ...input, game };
  expect(assessGamingClearSourceIdentity(document, request, assessGamingSourcePolicy(fixture.url, game)).status).toBe('verified');
  expect(classifyGamingDocumentQuality({ cleanedText: document.text, metadata: document.metadata, game,
    evidenceUnits: document.evidenceUnits, truncated: false, minUsefulTextChars: 120 })).not.toBe('complete');
  expect(assessGamingRequestCoverage(request, await acquiredKnowledge(game)).coverageSatisfied).toBe(false);
  expect((await evaluateGamingHybridCandidates({ ...request, protocolVersion: 'gaming-hybrid-v2', candidates: [{ url: fixture.url }] }, actor)).accepted).toHaveLength(0);
});

it('rejects the exact compiled HTTP catalog fixture despite unmatched nominal sentence wording', async () => {
  const example = gamingCompiledHttpCatalogFixture;
  http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: example.html });
  const document = await resolveGamingDocument(fixture.url);
  expect(classifyGamingDocumentQuality({ cleanedText: document.text, metadata: document.metadata, game: example.game,
    evidenceUnits: document.evidenceUnits, truncated: false, minUsefulTextChars: 120 })).toBe('metadata-only');
  const knowledge = await acquiredKnowledge(example.game);
  const request = { ...input, game: example.game, prompt: example.question };
  expect(assessGamingRequestCoverage(request, knowledge).coverageSatisfied).toBe(false);
  expect(assessGamingClearEvidence(request, knowledge, { identityVerified: true }).gates.claimSupport).not.toBe('verified');
});

describe('legitimate reference-style evidence remains usable', () => {
  it.each([
    'In the game Portal 2, the copper shield is sold at the training gate for ten practice tokens. The copper shield blocks practice projectiles while its charge remains active.',
    'In the game Portal 2, copper shield acquisition follows the river path through the practice garden before the training gate.'
  ])('preserves attributable non-imperative facts: %s', async text => {
    http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: fixture.html(text) });
    const result = await evaluateGamingHybridCandidates({ ...input, protocolVersion: 'gaming-hybrid-v2', candidates: [{ url: fixture.url }] }, actor);
    expect(result.accepted).toHaveLength(1);
    expect(assessGamingClearEvidence(input, result.knowledge, { identityVerified: true }).gates.claimSupport).toBe('verified');
  });

  it('preserves a short independently scoped declarative guide without requiring an imperative', async () => {
    const text = 'In the game Portal 2, the copper shield is sold at the gate.';
    http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: fixture.html(text) });
    const document = await resolveGamingDocument(fixture.url);
    expect(document.text.length).toBeLessThan(120);
    const result = await evaluateGamingHybridCandidates({ ...input, protocolVersion: 'gaming-hybrid-v2', candidates: [{ url: fixture.url }] }, actor);
    expect(result.accepted.length).toBe(1);
    expect(assessGamingClearEvidence(input, result.knowledge, { identityVerified: true }).gates.claimSupport).toBe('verified');
  });

  it('preserves an actual mechanic involving an item named Index instead of treating it as browsing', async () => {
    http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' },
      data: fixture.html('In the game Portal 2, use the Copper Index to unlock the copper shield gate.') });
    const result = await evaluateGamingHybridCandidates({ ...input, protocolVersion: 'gaming-hybrid-v2', candidates: [{ url: fixture.url }] }, actor);
    expect(result.accepted).toHaveLength(1);
    expect(assessGamingClearEvidence(input, result.knowledge, { identityVerified: true }).gates.claimSupport).toBe('verified');
  });

  it('preserves complete factual structured records under a wiki title', async () => {
    const html = fixture.html('In the game Portal 2, the following table records copper shield weight.')
      .replace('</article>', '<table><tr><th>Game</th><th>Item</th><th>Stat</th><th>Value</th><th>Unit</th><th>Scope</th></tr>'
        + '<tr><td>Portal 2</td><td>Copper shield</td><td>weight</td><td>7</td><td>practice tokens</td><td>base-game</td></tr></table></article>');
    http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: html });
    const request = { ...input, prompt: 'What is the copper shield weight value?' };
    const result = await evaluateGamingHybridCandidates({ ...request, protocolVersion: 'gaming-hybrid-v2', candidates: [{ url: fixture.url }] }, actor);
    expect(result.accepted).toHaveLength(1);
    expect(assessGamingClearEvidence(request, result.knowledge, { identityVerified: true }).gates.claimSupport).toBe('verified');
  });
});

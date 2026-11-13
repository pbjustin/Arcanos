import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import type { GamingSourceAuthoritySnapshot, GamingSourceAuthoritySnapshotInput,
  QueryActiveGamingKnowledgeOptions } from '../src/core/db/repositories/gamingSourceRepository.js';
import type { GamingHybridResult } from '../src/services/gamingHybridKnowledge.js';
import type { runGameplayPipeline } from '../src/services/gamingPipeline.js';
import type { GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';

const http = jest.fn();
const authority = new Map<string, GamingSourceAuthoritySnapshot>();
const healthy = { status: 'available', restrictedRevisionCount: 0, requiresReassessment: false,
  stateFingerprint: 'epoch0' } as GamingSourceAuthoritySnapshot;
const held = { status: 'available', restrictedRevisionCount: 1, requiresReassessment: true,
  stateFingerprint: 'epoch1' } as GamingSourceAuthoritySnapshot;
let authorityFailure: Error | undefined;
const readAuthority = jest.fn<(input: GamingSourceAuthoritySnapshotInput, options?: QueryActiveGamingKnowledgeOptions) =>
  GamingSourceAuthoritySnapshot | Promise<GamingSourceAuthoritySnapshot>>();
const forbiddenWrite = jest.fn(async () => { throw new Error('This provider-free authority fixture forbids durable writes.'); });
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
jest.unstable_mockModule('../src/core/db/repositories/gamingSourceRepository.js', () => ({
  readGamingSourceAuthoritySnapshot: readAuthority,
  readGamingSourceAuthorityRestrictionCount: jest.fn(async () => 0),
  findActiveGamingSourceIdentities: jest.fn(async () => []), searchActiveGamingKnowledge: jest.fn(async () => []),
  getGamingSourceById: jest.fn(async () => undefined), persistGamingSourceRevision: forbiddenWrite,
  recordGamingSourceAuthorityHold: forbiddenWrite, GamingSourceRepositoryUnavailableError: class extends Error {}
}));
const { createGamingHybridWorkflow } = await import('../src/services/gamingHybridKnowledge.js');
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { gamingClearHash } =
  await import('../src/shared/gaming/gamingClearPolicy.js');
const { GAMING_PRESENTED_ANSWER } = await import('../src/shared/gaming/gamingPresentedAnswerBinding.js');
const { assessGamingClearEvidence } = await import('../src/shared/gaming/gamingClearEvidence.js');
const { GAMING_HYBRID_V2_LIMITS } = await import('../src/shared/gaming/gamingHybridContract.js');
const { logger } = await import('../src/platform/logging/structuredLogging.js');

const game = 'Amber Pilgrim';
const keyUrl = 'https://guides.example.org/authority-copper-key';
const leverUrl = 'https://guides.example.org/authority-silver-lever';
const keyProse = 'The copper key is inside the practice chest behind the amber gate. Collect the copper key before leaving the practice courtyard.';
const leverProse = 'The silver lever is beside the northern practice gate. Pull the silver lever after reaching the practice gate.';
const context = { actorKey: 'synthetic-hybrid-authority-owner', requestId: 'synthetic-hybrid-authority-request' };
const empty: GamingStoredKnowledgeContext = { context: '', sources: [], evidence: [], sourceKnown: false };
const versions = ['gaming-hybrid-v1', 'gaming-hybrid-v2'] as const;
type Version = typeof versions[number];

function setup(version: Version = 'gaming-hybrid-v2', question = 'Where is the copper key?', stored = empty) {
  const retrieve = jest.fn(async () => stored);
  const evaluate = jest.fn<typeof evaluateGamingHybridCandidates>((input, callContext) =>
    evaluateGamingHybridCandidates(input, callContext));
  const generate = jest.fn<typeof runGameplayPipeline>(async (input, prepared) => {
    const knowledge = prepared!.knowledge;
    const evidenceAssessment = assessGamingClearEvidence(input, knowledge, { actorScopeHash: prepared!.actorScopeHash,
      allowAdvisoryFreshness: prepared!.advisoryFreshnessAllowed, requireRequestCoverage: prepared!.requireRequestCoverage });
    expect(evidenceAssessment.decision).toBe('accept');
    const response = `${question.includes('silver lever') ? `${keyProse} ${leverProse}` : keyProse} [Source 1]`;
    const binding = { policyVersion: 'gaming-clear-presentation/v1' as const, subjectHash: gamingClearHash(response),
      contextFingerprint: evidenceAssessment.contextFingerprint, evidenceSubjectHash: evidenceAssessment.subjectHash };
    return { ok: true, route: 'gaming', mode: 'guide', data: { response, sources: knowledge.sources,
      grounding: { groundingStatus: 'grounded', requestedSourceCount: 0, fetchedSourceCount: knowledge.sources.length,
        fetchedSuppliedSourceCount: 0, usableSourceCount: knowledge.sources.length, citableSourceCount: knowledge.sources.length,
        selectedChunkCount: knowledge.evidence!.length, suppliedEvidenceSourceCount: 0, groundedInSuppliedEvidence: false },
      [GAMING_PRESENTED_ANSWER]: binding } };
  });
  const workflow = createGamingHybridWorkflow({ retrieve, evaluateCandidates: evaluate, generate, ingest: forbiddenWrite as never });
  const query = { contractVersion: version, idempotencyKey: 'authority-query', game, mode: 'guide' as const,
    question, storagePolicy: 'transient_only' as const };
  const submission = (workflowId: string, revision = 0, recovery = false) => ({ contractVersion: version, workflowId,
    ...(version === 'gaming-hybrid-v2' ? { expectedRevision: revision } : {}),
    idempotencyKey: recovery ? 'authority-recovery' : 'authority-first-source',
    candidates: [{ url: recovery ? leverUrl : keyUrl }] });
  async function accepted() {
    const first = await workflow.query(query, context);
    expect(first.body.nextAction).toBe('search');
    const submitted = submission(first.body.workflowId!, first.body.revision);
    const found = await workflow.candidates(submitted, context);
    expect(found.body.reason).toBe('ACCEPTED_EVIDENCE');
    expect(found.body).toMatchObject({ state: 'answer_ready', nextAction: 'answer', evidenceSelected: true,
      answer: { provenance: 'arcanos-trinity' } });
    expect(found.body.candidates?.[0].candidateId).toEqual(expect.any(String));
    expect(generate).toHaveBeenCalledTimes(1);
    return { first, submitted, found };
  }
  return { workflow, query, submission, retrieve, evaluate, generate, accepted };
}

function expectWithheld(result: GamingHybridResult) {
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(result.body.answer).toBeUndefined();
  expect(result.body.nextAction).not.toBe('answer');
  expect(result.body.evidenceSelected).toBe(false);
  expect(result.body.selectedEvidenceIds ?? []).toEqual([]);
}

beforeEach(() => {
  authority.clear(); authorityFailure = undefined; readAuthority.mockReset(); http.mockReset(); forbiddenWrite.mockClear();
  readAuthority.mockImplementation(input => {
    if (authorityFailure) throw authorityFailure;
    return { ...(authority.get(input.canonicalUrl) ?? healthy) };
  });
  http.mockImplementation(async (_url: string, options: { headers: Record<string, string>; maxRedirects: number }) => {
    expect(options.maxRedirects).toBe(0);
    expect(options.headers).not.toHaveProperty('Authorization');
    expect(options.headers).not.toHaveProperty('Cookie');
    const text = String(_url).includes('silver-lever') ? leverProse : keyProse;
    return { status: 200, headers: { 'content-type': 'text/html' },
      data: `<html><title>${game} guide</title><article><p>In the game ${game}, ${text}</p></article></html>` };
  });
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
});
afterEach(() => { expect(forbiddenWrite).not.toHaveBeenCalled(); jest.restoreAllMocks(); });

describe('hybrid accepted-artifact durable authority revocation', () => {
  it.each(versions)('preserves unchanged healthy %s evidence, same-key retries and equivalent-query reuse', async version => {
    const fixture = setup(version);
    const { submitted, found } = await fixture.accepted();
    expect(await fixture.workflow.candidates(submitted, context)).toEqual(found);
    expect(await fixture.workflow.query(fixture.query, context)).toEqual(found);
    expect(await fixture.workflow.query({ ...fixture.query, idempotencyKey: 'healthy-equivalent-query' }, context)).toEqual(found);
    expect(fixture.evaluate).toHaveBeenCalledTimes(1); expect(fixture.generate).toHaveBeenCalledTimes(1);
    expect(fixture.retrieve).toHaveBeenCalledTimes(1); expect(http).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicitly unconfigured database without storage or new acquisition on reuse', async () => {
    readAuthority.mockReturnValue({ status: 'unconfigured' });
    const fixture = setup();
    const { submitted, found } = await fixture.accepted();
    expect(await fixture.workflow.candidates(submitted, context)).toEqual(found);
    expect(fixture.generate).toHaveBeenCalledTimes(1); expect(http).toHaveBeenCalledTimes(1);
  });

  it.each(versions)('withholds a cached %s candidate answer after a durable hold, including identical retries', async version => {
    const fixture = setup(version);
    const { submitted } = await fixture.accepted();
    authority.set(keyUrl, held);
    for (let attempt = 0; attempt < 2; attempt++) expectWithheld(await fixture.workflow.candidates(submitted, context));
    expect(fixture.evaluate).toHaveBeenCalledTimes(1); expect(fixture.generate).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it.each(versions)('withholds cached %s answers on original and equivalent query keys after a durable hold', async version => {
    const fixture = setup(version);
    await fixture.accepted(); authority.set(keyUrl, held);
    expectWithheld(await fixture.workflow.query(fixture.query, context));
    expectWithheld(await fixture.workflow.query({ ...fixture.query, idempotencyKey: 'held-equivalent-query' }, context));
    expect(fixture.retrieve).toHaveBeenCalledTimes(1); expect(fixture.evaluate).toHaveBeenCalledTimes(1);
    expect(fixture.generate).toHaveBeenCalledTimes(1); expect(http).toHaveBeenCalledTimes(1);
  });

  it.each(versions)('preserves a fresh %s historical source until a repeated same-count hold changes its state', async version => {
    authority.set(keyUrl, held);
    const fixture = setup(version);
    const { submitted, found } = await fixture.accepted();
    expect(await fixture.workflow.candidates(submitted, context)).toEqual(found);
    authority.set(keyUrl, { ...held, stateFingerprint: 'epoch2' } as GamingSourceAuthoritySnapshot);
    const revoked = await fixture.workflow.candidates(submitted, context);
    expectWithheld(revoked);
    expect(revoked).toMatchObject({ status: 409, body: { reason: 'EVIDENCE_REVALIDATION_REQUIRED' } });
    expect(fixture.generate).toHaveBeenCalledTimes(1); expect(http).toHaveBeenCalledTimes(1);
  });

  it.each(versions.flatMap(version => (['stored', undefined] as const).map(origin => ({ version, origin }))))(
    'rechecks exact selected $version membership with stored origin $origin before returning an old query answer', async ({ version, origin }) => {
    const evaluated = await evaluateGamingHybridCandidates({ game, mode: 'guide', prompt: 'Where is the copper key?',
      protocolVersion: version, candidates: [{ url: keyUrl }] }, context);
    expect(evaluated.accepted).toHaveLength(1);
    for (const source of evaluated.knowledge.sources) {
      if (origin) source.origin = origin;
      else delete source.origin;
    }
    const fixture = setup(version, 'Where is the copper key?', evaluated.knowledge);
    const first = await fixture.workflow.query(fixture.query, context);
    expect(first.body).toMatchObject({ state: 'answer_ready', nextAction: 'answer' });
    expect(await fixture.workflow.query(fixture.query, context)).toEqual(first);
    // Real durable retrieval removes a record after a restriction/active-revision
    // change. The old workflow must not resurrect its earlier selected record.
    fixture.retrieve.mockResolvedValue(empty);
    expectWithheld(await fixture.workflow.query(fixture.query, context));
    expectWithheld(await fixture.workflow.query({ ...fixture.query, idempotencyKey: 'stored-equivalent-query' }, context));
    expect(fixture.retrieve.mock.calls.length).toBeGreaterThan(1);
    expect(fixture.generate).toHaveBeenCalledTimes(1); expect(fixture.evaluate).not.toHaveBeenCalled();
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('does not accept a source whose durable authority changes during candidate acquisition', async () => {
    const fixture = setup();
    const healthyHttp = http.getMockImplementation()!;
    http.mockImplementationOnce(async (...args) => {
      const response = await healthyHttp(...args);
      authority.set(keyUrl, held);
      return response;
    });
    const first = await fixture.workflow.query(fixture.query, context);
    const result = await fixture.workflow.candidates(fixture.submission(first.body.workflowId!, first.body.revision), context);
    expect(result.body.answer).toBeUndefined(); expect(result.body.evidenceSelected).toBe(false);
    expect(result.body.selectedEvidenceIds ?? []).toEqual([]);
    expect(fixture.generate).not.toHaveBeenCalled(); expect(http).toHaveBeenCalledTimes(1);
  });

  it('rechecks authority immediately before generation after its answer-entry observation', async () => {
    const fixture = setup();
    const normalRead = readAuthority.getMockImplementation()!;
    const normalEvaluate = fixture.evaluate.getMockImplementation()!;
    let armed = false;
    readAuthority.mockImplementation((input, options) => {
      const snapshot = normalRead(input, options);
      if (armed) {
        armed = false;
        queueMicrotask(() => authority.set(keyUrl, held));
      }
      return snapshot;
    });
    fixture.evaluate.mockImplementationOnce(async (...args) => {
      const evaluated = await normalEvaluate(...args);
      armed = true;
      return evaluated;
    });
    const first = await fixture.workflow.query(fixture.query, context);
    const result = await fixture.workflow.candidates(fixture.submission(first.body.workflowId!, first.body.revision), context);
    expectWithheld(result);
    expect(fixture.generate).not.toHaveBeenCalled(); expect(http).toHaveBeenCalledTimes(1);
  });

  it('does not reuse an accepted source after its epoch changes during v2 recovery', async () => {
    const fixture = setup('gaming-hybrid-v2', 'Where are the copper key and silver lever?');
    const first = await fixture.workflow.query(fixture.query, context);
    const initial = await fixture.workflow.candidates(fixture.submission(first.body.workflowId!, first.body.revision), context);
    expect(initial.body).toMatchObject({ nextAction: 'search', coverageSatisfied: false,
      discovery: { round: 1, maxRounds: 2, recoveryRemaining: 1 } });
    expect(initial.body.candidates?.[0].candidateId).toEqual(expect.any(String));
    expect(fixture.generate).not.toHaveBeenCalled();
    authority.set(keyUrl, held);
    const recovery = fixture.submission(first.body.workflowId!, initial.body.revision, true);
    expectWithheld(await fixture.workflow.candidates(recovery, context));
    expectWithheld(await fixture.workflow.candidates(recovery, context));
    expect(fixture.evaluate.mock.calls.length).toBeLessThanOrEqual(2);
    for (const [, callContext] of fixture.evaluate.mock.calls)
      expect(callContext.maxElapsedMs).toBeLessThanOrEqual(GAMING_HYBRID_V2_LIMITS.candidateTimeoutMs);
    expect(http.mock.calls.length).toBeLessThanOrEqual(2); expect(fixture.generate).not.toHaveBeenCalled();
  });

  it('does not regenerate a failed v1 operation from revoked retained evidence', async () => {
    const fixture = setup('gaming-hybrid-v1');
    fixture.generate.mockRejectedValueOnce(new Error('Synthetic provider boundary failure.'));
    const first = await fixture.workflow.query(fixture.query, context);
    const submitted = fixture.submission(first.body.workflowId!);
    const failed = await fixture.workflow.candidates(submitted, context);
    expect(failed.status).toBe(503); expect(failed.body.answer).toBeUndefined();
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    authority.set(keyUrl, held);
    expectWithheld(await fixture.workflow.candidates(submitted, context));
    expect(fixture.generate).toHaveBeenCalledTimes(1); expect(fixture.evaluate).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it.each(versions)('withholds a freshly generated %s answer when a hold appears during generation', async version => {
    const fixture = setup(version);
    const healthyGenerate = fixture.generate.getMockImplementation()!;
    fixture.generate.mockImplementationOnce(async (...args) => {
      const generated = await healthyGenerate(...args);
      authority.set(keyUrl, held);
      return generated;
    });
    const first = await fixture.workflow.query(fixture.query, context);
    const submitted = fixture.submission(first.body.workflowId!, first.body.revision);
    expectWithheld(await fixture.workflow.candidates(submitted, context));
    expectWithheld(await fixture.workflow.candidates(submitted, context));
    expect(fixture.generate).toHaveBeenCalledTimes(1); expect(fixture.evaluate).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it.each(versions)('withholds a cached %s answer when configured authority becomes unavailable', async version => {
    const fixture = setup(version);
    const { submitted } = await fixture.accepted();
    authorityFailure = new Error('Synthetic private authority diagnostic.');
    const unavailable = await fixture.workflow.candidates(submitted, context);
    expectWithheld(unavailable);
    expect(JSON.stringify(unavailable)).not.toContain(authorityFailure.message);
    expect(fixture.generate).toHaveBeenCalledTimes(1); expect(http).toHaveBeenCalledTimes(1);
  });

  it('withholds a cached answer when its caller deadline expires during the authority read', async () => {
    const fixture = setup();
    const { submitted } = await fixture.accepted();
    const controller = new AbortController();
    readAuthority.mockImplementation((_input, options) => new Promise((_resolve, reject) => {
      const signal = options?.signal;
      if (!signal) { reject(new Error('Authority read must remain caller-cancellable.')); return; }
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const timer = setTimeout(() => controller.abort(new Error('Synthetic owner deadline.')), 25);
    try {
      expectWithheld(await fixture.workflow.candidates(submitted, { ...context, signal: controller.signal }));
      expect(controller.signal.aborted).toBe(true);
    } finally { clearTimeout(timer); }
    expect(fixture.generate).toHaveBeenCalledTimes(1); expect(http).toHaveBeenCalledTimes(1);
  });
});

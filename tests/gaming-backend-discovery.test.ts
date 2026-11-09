import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createGamingHybridWorkflow } from '../src/services/gamingHybridKnowledge.js';
import { GAMING_HYBRID_CONTRACT_VERSION, GAMING_HYBRID_V2_CONTRACT_VERSION as contractVersion,
  GAMING_HYBRID_V2_LIMITS } from '../src/shared/gaming/gamingHybridContract.js';
import type { GamingDiscoveryResult } from '../src/services/gamingSourceDiscovery.js';
import { runWithRequestAbortContext } from '@arcanos/runtime';

const context = { actorKey: 'backend-search-fixture-actor', requestId: 'backend-search-fixture-request' };
const query = { contractVersion, idempotencyKey: 'backend-search-query', game: 'Lantern Voyage',
  question: 'How do I open the copper gate?' };
const empty = { context: '', sources: [], evidence: [], sourceKnown: false };
const flag = 'ARCANOS_GAMING_HYBRID_BACKEND_DISCOVERY_ENABLED';
let previous: string | undefined;
const timingKeys = ['ARCANOS_GAMING_STAGE_TIMEOUT_MS', 'ARCANOS_GAMING_GUIDE_STAGE_TIMEOUT_MS',
  'ARCANOS_GAMING_PIPELINE_TIMEOUT_MS', 'ARCANOS_GAMING_GUIDE_PIPELINE_TIMEOUT_MS', 'ARCANOS_GAMING_MODULE_TIMEOUT_MS'];
let previousTiming: Record<string, string | undefined>;
function discovered(urls = ['https://guides.example/copper-gate']): GamingDiscoveryResult {
  return { candidates: urls.map((url, index) => ({ url, title: 'Lantern Voyage copper gate guide',
    providerRank: index + 1, provider: 'synthetic', score: 0.9, suggestedSourceType: 'curated', stable: true,
    freshnessKnown: false, characteristics: { officialLikely: false, patchLikely: false, wikiLikely: false,
      guideLikely: true, articleLikely: true } })), searchProvider: 'synthetic', searchResultCount: urls.length,
    candidateCount: urls.length, rejectedCandidateCount: 0, discoveryCacheHit: false,
    discoveryElapsedMs: 1, candidateRankingElapsedMs: 0 };
}
function setup() {
  let clock = Date.now();
  const discover = jest.fn(async () => discovered());
  const evaluateCandidates = jest.fn(async () => ({ accepted: [], knowledge: empty, acquisitionWorkMs: 12_000,
    decisions: [{ submittedIndex: 0, url: 'https://guides.example/copper-gate', decision: 'rejected' as const,
      reasonCodes: ['SOURCE_INACCESSIBLE'] }] }));
  const generate = jest.fn<any>();
  const ingest = jest.fn<any>();
  const workflow = createGamingHybridWorkflow({ retrieve: async () => empty, discover, evaluateCandidates,
    generate, ingest, now: () => clock });
  return { workflow, discover, evaluateCandidates, generate, ingest, advance: (ms: number) => { clock += ms; } };
}

beforeEach(() => {
  previous = process.env[flag]; process.env[flag] = 'true';
  previousTiming = Object.fromEntries(timingKeys.map(key => [key, process.env[key]]));
  for (const key of timingKeys) delete process.env[key];
});
afterEach(() => {
  if (previous === undefined) delete process.env[flag]; else process.env[flag] = previous;
  for (const [key, value] of Object.entries(previousTiming)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe('opt-in backend discovery uses the existing v2 workflow', () => {
  it('acquires URL hints once and retains the normal revision and failed-work accounting', async () => {
    const { workflow, discover, evaluateCandidates, generate, ingest } = setup();
    const first = await workflow.query(query, context);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(evaluateCandidates).toHaveBeenCalledTimes(1);
    expect(first.body).toMatchObject({ revision: 1, reason: 'SOURCE_ACQUISITION_UNVERIFIED',
      discovery: { remainingTotalAcquisitionMs: 12_000, remainingCandidateUrls: 5, replacementAllowed: true } });
    expect(await workflow.query(query, context)).toEqual(first);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(generate).not.toHaveBeenCalled(); expect(ingest).not.toHaveBeenCalled();
  });

  it('uses only the backend-granted recovery with distinct URLs and stops at the unchanged budget', async () => {
    const { workflow, discover, evaluateCandidates } = setup();
    discover.mockResolvedValueOnce(discovered(['https://guides.example/initial']))
      .mockResolvedValueOnce(discovered(['https://other.example/replacement']));
    const result = await workflow.query(query, context);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(discover.mock.calls[1][0]).toMatchObject({ excludedUrls: ['https://guides.example/initial'] });
    expect(evaluateCandidates).toHaveBeenCalledTimes(2);
    expect(result.body).toMatchObject({ revision: 2, nextAction: 'stop', discovery: {
      remainingTotalAcquisitionMs: 0, recoveryRemaining: 0, continuationRequired: false } });
    expect((await workflow.query({ ...query, idempotencyKey: 'same-budget-new-key' }, context)).body).toEqual(result.body);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, 'false'])('preserves host discovery when configuration is %s', async value => {
    if (value === undefined) delete process.env[flag]; else process.env[flag] = value;
    const { workflow, discover, evaluateCandidates } = setup();
    expect((await workflow.query(query, context)).body).toMatchObject({ revision: 0, nextAction: 'search' });
    expect(discover).not.toHaveBeenCalled(); expect(evaluateCandidates).not.toHaveBeenCalled();
  });

  it('leaves v1 and explicitly supplied guide URLs under their original host workflow', async () => {
    const { workflow, discover } = setup();
    await workflow.query({ ...query, contractVersion: GAMING_HYBRID_CONTRACT_VERSION }, context);
    await workflow.query({ ...query, idempotencyKey: 'supplied-guide-query',
      question: 'Use https://supplied.example/guide to explain the copper gate.' }, context);
    expect(discover).not.toHaveBeenCalled();
  });

  it.each(['DISCOVERY_DISABLED', 'DISCOVERY_PROVIDER_UNCONFIGURED', 'DISCOVERY_PROVIDER_ERROR',
    'DISCOVERY_PROVIDER_TIMEOUT', 'DISCOVERY_NO_RESULTS'] as const)('reports %s without inventing results or spending acquisition', async reason => {
    const { workflow, discover, evaluateCandidates, generate } = setup();
    discover.mockResolvedValue({ ...discovered([]), discoveryFailureReason: reason });
    const result = await workflow.query(query, context);
    expect(result.body).toMatchObject({ revision: 0, nextAction: 'search', discovery: {
      remainingTotalAcquisitionMs: GAMING_HYBRID_V2_LIMITS.totalCandidateTimeoutMs, remainingCandidateUrls: 6 } });
    if (reason !== 'DISCOVERY_DISABLED') expect(result.body.reason).toBe(reason);
    expect(await workflow.query(query, context)).toEqual(result);
    expect(discover).toHaveBeenCalledTimes(1); expect(evaluateCandidates).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests before search and keeps idempotency payload-bound', async () => {
    const { workflow, discover } = setup();
    expect((await workflow.query(query, { ...context, actorKey: '' })).status).toBe(401);
    expect(discover).not.toHaveBeenCalled();
    await workflow.query(query, context);
    expect((await workflow.query({ ...query, question: 'A different gameplay question' }, context)).body.reason).toBe('IDEMPOTENCY_CONFLICT');
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('does not acquire after cancellation or TTL expiry during provider search', async () => {
    for (const outcome of ['cancelled', 'expired'] as const) {
      const { workflow, discover, evaluateCandidates, advance } = setup();
      const controller = new AbortController();
      discover.mockImplementation(async () => {
        if (outcome === 'cancelled') controller.abort(); else advance(600_001);
        return discovered();
      });
      const result = await workflow.query(query, { ...context, signal: controller.signal });
      expect(result.body.nextAction).toBe('stop');
      expect(evaluateCandidates).not.toHaveBeenCalled();
    }
  });

  it('preserves gameplay context in the same sanitized discovery input as host search', async () => {
    const { workflow, discover } = setup();
    await workflow.query({ ...query, currentArea: 'Copper Quay', class: 'Sentinel', constraints: ['No consumables'] }, context);
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({ currentArea: 'Copper Quay',
      class: 'Sentinel', constraints: ['No consumables'] }));
  });

  it('reserves the recovery revision during search and coalesces concurrent query replays', async () => {
    const { workflow, discover, evaluateCandidates } = setup();
    let release!: (value: GamingDiscoveryResult) => void;
    let notify!: () => void;
    const searching = new Promise<void>(resolve => { notify = resolve; });
    discover.mockResolvedValueOnce(discovered(['https://guides.example/initial'])).mockImplementationOnce(async () => {
      notify(); return new Promise(resolve => { release = resolve; });
    });
    const pending = workflow.query(query, context);
    await searching;
    const workflowId = evaluateCandidates.mock.calls[0][1].workflowId;
    const replay = workflow.query(query, context);
    const concurrent = await workflow.candidates({ contractVersion, workflowId, expectedRevision: 1,
      idempotencyKey: 'concurrent-host-candidate', candidates: [{ url: 'https://host.example/guide' }] }, context);
    expect(concurrent.body.reason).toBe('SUBMISSION_IN_PROGRESS');
    const otherActor = await workflow.candidates({ contractVersion, workflowId, expectedRevision: 1,
      idempotencyKey: 'cross-actor-candidate', candidates: [{ url: 'https://host.example/guide' }] },
    { ...context, actorKey: 'different-actor' });
    expect(otherActor.body.reason).toBe('WORKFLOW_UNAVAILABLE');
    release(discovered(['https://other.example/replacement']));
    const final = await pending;
    expect(await replay).toEqual(final);
    expect(final.body).toMatchObject({ revision: 2, nextAction: 'stop' });
    expect(discover).toHaveBeenCalledTimes(2); expect(evaluateCandidates).toHaveBeenCalledTimes(2);
  });

  it('re-admits, deduplicates and caps provider hints before normal candidate accounting', async () => {
    const { workflow, discover, evaluateCandidates } = setup();
    discover.mockResolvedValue(discovered(['https://127.0.0.1/private', 'https://guides.example/a?utm_source=search',
      'https://guides.example/a', 'https://guides.example/b', 'https://guides.example/c', 'https://guides.example/d']));
    const result = await workflow.query(query, context);
    expect(evaluateCandidates.mock.calls[0][0].candidates.map((item: { url: string }) => item.url))
      .toEqual(['https://guides.example/a', 'https://guides.example/b', 'https://guides.example/c']);
    expect(evaluateCandidates.mock.calls[1][0].candidates.map((item: { url: string }) => item.url)).toEqual(['https://guides.example/d']);
    expect(result.body).toMatchObject({ revision: 2, discovery: { remainingCandidateUrls: 2, remainingTotalAcquisitionMs: 0 } });
  });

  it('honors explicit 2.5-second stage caps under a 38-second parent and preserves host recovery accounting', async () => {
    jest.useFakeTimers();
    try {
      process.env.ARCANOS_GAMING_GUIDE_STAGE_TIMEOUT_MS = '2500';
      const { workflow, discover, evaluateCandidates } = setup();
      const controller = new AbortController();
      const startedAt = Date.now();
      discover.mockImplementation(async () => {
        jest.setSystemTime(Date.now() + 4_000);
        return discovered(['https://guides.example/initial']);
      });
      evaluateCandidates.mockImplementationOnce(async (_input: unknown, operation: { maxElapsedMs: number }) => {
        expect(operation.maxElapsedMs).toBe(9_500);
        jest.setSystemTime(Date.now() + operation.maxElapsedMs);
        return { accepted: [], knowledge: empty, decisions: [], acquisitionWorkMs: operation.maxElapsedMs };
      });
      const result = await runWithRequestAbortContext({ controller, signal: controller.signal,
        deadlineAt: startedAt + 38_000, timeoutMs: 38_000 }, () => workflow.query(query, { ...context, signal: controller.signal }));
      expect(result.body).toMatchObject({ revision: 1, nextAction: 'search', discovery: {
        continuationRequired: true, replacementAllowed: true, remainingTotalAcquisitionMs: 14_500 } });
      expect(38_000 - (Date.now() - startedAt)).toBe(24_500);
      expect(discover).toHaveBeenCalledTimes(1); expect(evaluateCandidates).toHaveBeenCalledTimes(1);
      // A fresh request may use the existing grant; no workflow or allowance is renewed.
      const continued = await workflow.candidates({ contractVersion, workflowId: result.body.workflowId,
        expectedRevision: result.body.revision, idempotencyKey: 'http-deadline-host-recovery',
        candidates: [{ url: 'https://host.example/replacement' }] }, context);
      expect(continued.body).toMatchObject({ revision: 2, nextAction: 'stop', discovery: { remainingTotalAcquisitionMs: 2_500 } });
      expect(evaluateCandidates.mock.calls[1][1].maxElapsedMs).toBe(12_000);
    } finally { jest.useRealTimers(); }
  });

  it('returns the original resumable grant if search uses the remaining automatic-work window', async () => {
    jest.useFakeTimers();
    try {
      process.env.ARCANOS_GAMING_GUIDE_STAGE_TIMEOUT_MS = '2500';
      const { workflow, discover, evaluateCandidates } = setup();
      const controller = new AbortController();
      const startedAt = Date.now();
      discover.mockImplementation(async () => {
        jest.setSystemTime(startedAt + 13_500);
        return discovered();
      });
      const result = await runWithRequestAbortContext({ controller, signal: controller.signal,
        deadlineAt: startedAt + 38_000, timeoutMs: 38_000 }, () => workflow.query(query, context));
      expect(result.body).toMatchObject({ revision: 0, nextAction: 'search', discovery: {
        continuationRequired: true, remainingTotalAcquisitionMs: 24_000, remainingCandidateUrls: 6 } });
      expect(evaluateCandidates).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });

  it('does no automatic search when the parent already has only the generation reserve remaining', async () => {
    const { workflow, discover, evaluateCandidates } = setup();
    const controller = new AbortController();
    const result = await runWithRequestAbortContext({ controller, signal: controller.signal,
      deadlineAt: Date.now() + 24_000, timeoutMs: 38_000 }, () => workflow.query(query, context));
    expect(result.body).toMatchObject({ revision: 0, nextAction: 'search', discovery: { continuationRequired: true } });
    expect(discover).not.toHaveBeenCalled(); expect(evaluateCandidates).not.toHaveBeenCalled();
  });

  it('aborts only the automatic search window and cleans its timer without cancelling the parent workflow', async () => {
    jest.useFakeTimers();
    try {
      process.env.ARCANOS_GAMING_GUIDE_STAGE_TIMEOUT_MS = '2500';
      const { workflow, discover, evaluateCandidates } = setup();
      const controller = new AbortController();
      let notify!: () => void;
      const searching = new Promise<void>(resolve => { notify = resolve; });
      discover.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
        notify();
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        return { ...discovered([]), discoveryFailureReason: 'DISCOVERY_PROVIDER_TIMEOUT' };
      });
      const pending = runWithRequestAbortContext({ controller, signal: controller.signal,
        deadlineAt: Date.now() + 38_000, timeoutMs: 38_000 }, () => workflow.query(query, { ...context, signal: controller.signal }));
      await searching;
      await jest.advanceTimersByTimeAsync(13_500);
      const result = await pending;
      expect(result.body).toMatchObject({ revision: 0, nextAction: 'search', reason: 'DISCOVERY_PROVIDER_TIMEOUT',
        discovery: { continuationRequired: true, remainingTotalAcquisitionMs: 24_000 } });
      expect(controller.signal.aborted).toBe(false); expect(evaluateCandidates).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });

  it.each(['pipeline', 'module'] as const)('yields before search when an operator %s cap cannot fit the generation target', async cap => {
    process.env[cap === 'pipeline' ? 'ARCANOS_GAMING_GUIDE_PIPELINE_TIMEOUT_MS' : 'ARCANOS_GAMING_MODULE_TIMEOUT_MS'] = '10000';
    const { workflow, discover, evaluateCandidates } = setup();
    const result = await workflow.query(query, context);
    expect(result.body).toMatchObject({ revision: 0, nextAction: 'search', discovery: {
      continuationRequired: true, remainingCandidateUrls: 6, remainingTotalAcquisitionMs: 24_000 } });
    expect(discover).not.toHaveBeenCalled(); expect(evaluateCandidates).not.toHaveBeenCalled();
  });
});

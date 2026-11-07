import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { GamingKnowledgeProvenanceRecord } from '../src/core/db/repositories/gamingSourceRepository.js';
import { GAMING_CLEAR_POLICY_VERSION } from '../src/shared/gaming/gamingClearPolicy.js';
import { GAMING_FRESHNESS_POLICY_VERSION } from '../src/shared/gaming/gamingFreshnessCore.js';

const search = jest.fn<(...args: any[]) => Promise<GamingKnowledgeProvenanceRecord[]>>();
const findSources = jest.fn<(...args: any[]) => Promise<Array<{ sourceId: string; gameKey: string; gameName: string }>>>();
const logInfo = jest.fn();
jest.unstable_mockModule('@core/db/repositories/gamingSourceRepository.js', () => ({ searchActiveGamingKnowledge: search,
  findActiveGamingSourceIdentities: findSources }));
jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({ logger: { info: logInfo, warn: jest.fn() } }));
const { retrieveStoredGamingKnowledge } = await import('../src/services/gamingStoredKnowledge.js');

const input = { game: 'Platinum Lantern', prompt: 'How do I cross the crystal bridge?', mode: 'guide' as const, failOnUnavailable: true };
const text = 'In Platinum Lantern, use the silver telescope to cross the crystal bridge. Rotate the telescope toward the eastern beacon before crossing the bridge.';
function row(id: string, held = false): GamingKnowledgeProvenanceRecord {
  const content = id === 'eligible-two' ? 'At the crystal bridge, lower the copper lever to unlock the return route. Cross the crystal bridge after the bronze latch opens.' : text;
  return { recordId: id, recordType: 'guide', semanticKey: id, payloadHash: 'a'.repeat(64), title: null, patch: null,
    searchText: content, normalized: { text: content }, recordCreatedAt: new Date(), sourceId: held ? 'held-source' : 'source-one', gameKey: 'platinum-lantern',
    gameName: input.game, canonicalUrl: 'https://guides.example.org/bridge', canonicalUrlHash: 'b'.repeat(64),
    publicUrl: 'https://guides.example.org/bridge', host: 'guides.example.org', sourceType: 'supplied', trustScore: 0.8,
    revisionId: 'revision-one', contentHash: 'c'.repeat(64), fetchedAt: new Date(), publishedAt: null, revisionPatch: null,
    extractor: 'synthetic', extractorVersion: '1', normalizerSchemaVersion: '1', extractionMetrics: {}, relevance: 0.8,
    provenance: { sourceIdentityPolicyVersion: GAMING_CLEAR_POLICY_VERSION,
      ...(held ? { classification: 'reference_only', generationEligible: false } : {}),
      acquiredApplicability: { extractorVersion: GAMING_FRESHNESS_POLICY_VERSION, contentHash: 'c'.repeat(64), game: input.game,
        metadataConflict: false, metadataUnverified: false } } };
}
beforeEach(() => { search.mockReset(); logInfo.mockClear(); findSources.mockReset();
  findSources.mockResolvedValue([{ sourceId: 'source-one', gameKey: 'platinum-lantern', gameName: 'Platinum Lantern' }]); });

describe('stored Gaming authority refill bounds', () => {
  test('deduplicates overlapping pages without returning held rows as evidence', async () => {
    const first = Array.from({ length: 19 }, (_, index) => row(`held-${index}`, true));
    search.mockResolvedValueOnce([...first, row('eligible-one')]);
    search.mockResolvedValueOnce([row('eligible-one'), ...first.slice(0, 18), row('eligible-two')]);
    search.mockResolvedValueOnce([]);
    const result = await retrieveStoredGamingKnowledge(input, { resolveVerifiedPatch: () => undefined });
    expect(search).toHaveBeenCalledTimes(3);
    expect(search.mock.calls.map(([query]) => query.offset ?? 0)).toEqual([0, 20, 40]);
    expect(new Set(result.evidence?.map(chunk => chunk.recordId))).toEqual(new Set(['eligible-one', 'eligible-two']));
    expect(result.evidence).toHaveLength(2);
    expect(result.clearEvidenceAssessment?.decision).toBe('accept');
    const signals = search.mock.calls.map(([, options]) => options.signal);
    expect(signals.every(signal => signal === signals[0])).toBe(true);
  });

  test('the original deadline cancels a blocked refill rather than reporting empty exhausted knowledge', async () => {
    search.mockImplementation(async (query, options) => {
      if (!query.offset) return Array.from({ length: 20 }, (_, index) => row(`held-${index}`, true));
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    });
    await expect(retrieveStoredGamingKnowledge({ ...input, queryTimeoutMs: 25 }, { resolveVerifiedPatch: () => undefined }))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1][1].signal.aborted).toBe(true);
    expect(logInfo.mock.calls.some(([event]) => event === 'gaming.stored_retrieval.completed')).toBe(false);
  });

  test('discards a source that changes revision during refill instead of mixing source generations', async () => {
    const held = Array.from({ length: 19 }, (_, index) => ({ ...row(`held-${index}`, true), sourceId: 'held-source' }));
    search.mockResolvedValueOnce([row('eligible-one'), ...held]);
    search.mockResolvedValueOnce([{ ...row('eligible-two'), revisionId: 'revision-two' }, ...held]);
    search.mockResolvedValueOnce([row('eligible-old-revision-later')]);
    const result = await retrieveStoredGamingKnowledge(input, { resolveVerifiedPatch: () => undefined });
    expect(search).toHaveBeenCalledTimes(3);
    expect(result.evidence ?? []).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.context).toBe('');
    expect(result.context).not.toContain('copper lever');
    expect(result.clearEvidenceAssessment?.decision).not.toBe('accept');
  });

  test.each(['durable-history', 'explicit-retention'])('evicts previously collected authority after observing a new %s hold', async hold => {
    const held = Array.from({ length: 19 }, (_, index) => ({ ...row(`held-${index}`, true), sourceId: 'held-source' }));
    search.mockResolvedValueOnce([row('eligible-one'), ...held]);
    search.mockResolvedValueOnce([{ ...row('eligible-two', hold === 'explicit-retention'),
      sourceId: 'source-one', revisionId: 'revision-two', ...(hold === 'durable-history' ? { authorityReassessmentRequired: true } : {}) }]);
    const result = await retrieveStoredGamingKnowledge(input, { resolveVerifiedPatch: () => undefined });
    expect(search).toHaveBeenCalledTimes(2);
    expect(result.context).toBe('');
    expect(result.sources).toEqual([]);
    expect(result.evidence ?? []).toEqual([]);
    expect(result.clearEvidenceAssessment?.decision).not.toBe('accept');
  });

  test('returns an actually exhausted held-only source without adding authority', async () => {
    search.mockResolvedValueOnce(Array.from({ length: 20 }, (_, index) => row(`held-${index}`, true)));
    search.mockResolvedValueOnce([row('held-last', true)]);
    const result = await retrieveStoredGamingKnowledge(input, { resolveVerifiedPatch: () => undefined });
    expect(search).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ context: '', sources: [], sourceKnown: true });
    expect(result.evidence ?? []).toEqual([]);
    expect(logInfo).toHaveBeenCalledWith('gaming.stored_retrieval.completed', expect.objectContaining({ lexicalCandidateCount: 21,
      mergedCandidateCount: 21, selectedChunkCount: 0 }));
  });

  test('preserves collected authoritative evidence when only a later refill reaches its deadline', async () => {
    search.mockImplementation(async (query, options) => {
      if (!query.offset) return [row('eligible-one'), ...Array.from({ length: 19 }, (_, index) => row(`held-${index}`, true))];
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    });
    const result = await retrieveStoredGamingKnowledge({ ...input, queryTimeoutMs: 30 }, { resolveVerifiedPatch: () => undefined });
    expect(result.evidence?.map(chunk => chunk.recordId)).toEqual(['eligible-one']);
    expect(result.clearEvidenceAssessment?.decision).toBe('accept');
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1][1].signal.aborted).toBe(true);
  });

  test('caller cancellation still rejects when an earlier page supplied usable evidence', async () => {
    const controller = new AbortController();
    search.mockImplementation(async (query, options) => {
      if (!query.offset) return [row('eligible-one'), ...Array.from({ length: 19 }, (_, index) => row(`held-${index}`, true))];
      queueMicrotask(() => controller.abort(new Error('owner cancelled')));
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    });
    await expect(retrieveStoredGamingKnowledge({ ...input, signal: controller.signal }, { resolveVerifiedPatch: () => undefined }))
      .rejects.toThrow('owner cancelled');
    expect(logInfo.mock.calls.some(([event]) => event === 'gaming.stored_retrieval.completed')).toBe(false);
  });

  test('a later observed hold cannot return earlier authority when subsequent refill times out', async () => {
    const held = Array.from({ length: 19 }, (_, index) => row(`held-${index}`, true));
    search.mockImplementation(async (query, options) => {
      if (!query.offset) return [row('eligible-one'), ...held];
      if (query.offset === 20) return [{ ...row('new-held'), sourceId: 'source-one', revisionId: 'new-revision', authorityReassessmentRequired: true }, ...held];
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    });
    await expect(retrieveStoredGamingKnowledge({ ...input, queryTimeoutMs: 30 }, { resolveVerifiedPatch: () => undefined }))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    expect(logInfo.mock.calls.some(([event]) => event === 'gaming.stored_retrieval.completed')).toBe(false);
  });

  test('continues past twenty held source identities to a lower-ranked eligible source', async () => {
    const identities = Array.from({ length: 20 }, (_, index) => ({ sourceId: `held-source-${index}`, gameKey: 'platinum-lantern', gameName: input.game }));
    findSources.mockImplementation(async query => query.offset ? [{ sourceId: 'source-one', gameKey: 'platinum-lantern', gameName: input.game }] : identities);
    search.mockImplementation(async query => query.sourceIds.includes('source-one') ? [row('eligible-one')]
      : query.offset ? [] : identities.map((source, index) => ({ ...row(`held-${index}`, true), sourceId: source.sourceId })));
    const result = await retrieveStoredGamingKnowledge(input, { resolveVerifiedPatch: () => undefined });
    expect(result.evidence?.map(chunk => chunk.recordId)).toEqual(['eligible-one']);
    expect(result.clearEvidenceAssessment?.decision).toBe('accept');
    expect(findSources.mock.calls.map(([query]) => query.offset ?? 0)).toEqual([0, 20]);
    expect(search.mock.calls.every(([query]) => query.sourceIds.length <= 20)).toBe(true);
    expect(search.mock.calls.every(([, options]) => options.signal === search.mock.calls[0][1].signal)).toBe(true);
  });

  test('preserves authoritative records for PostgreSQL statement timeout while other SQL failures still fail closed', async () => {
    for (const statementTimeout of [true, false]) {
      search.mockReset();
      search.mockResolvedValueOnce([row('eligible-one'), ...Array.from({ length: 19 }, (_, index) => row(`held-${index}`, true))]);
      const error = Object.assign(new Error(statementTimeout ? 'canceling statement due to statement timeout' : 'connection lost'),
        { code: statementTimeout ? '57014' : '08006' });
      search.mockRejectedValueOnce(error);
      const pending = retrieveStoredGamingKnowledge(input, { resolveVerifiedPatch: () => undefined });
      if (statementTimeout) {
        const result = await pending;
        expect(result.evidence?.map(chunk => chunk.recordId)).toEqual(['eligible-one']);
        expect(result.clearEvidenceAssessment?.decision).toBe('accept');
      } else await expect(pending).rejects.toBe(error);
    }
  });
});

import type { GamingKnowledgeProvenanceRecord } from '@core/db/repositories/gamingSourceRepository.js';
import { findActiveGamingSourceIdentities, searchActiveGamingKnowledge } from '@core/db/repositories/gamingSourceRepository.js';
import { logger } from '@platform/logging/structuredLogging.js';
import {
  MAX_STORED_GAMING_CANDIDATES,
  buildStoredGamingLexicalQuery,
  selectStoredGamingEvidence as selectStoredGamingEvidenceCore,
  formatStoredGamingEvidence as formatStoredGamingEvidenceCore,
  type GamingStoredEvidenceCandidate,
  type GamingStoredEvidenceLimits,
  type GamingStoredKnowledgeContext,
  type GamingStoredKnowledgeInput,
  type GamingStoredPatchResolver
} from '@shared/gaming/gamingStoredEvidenceCore.js';
import { GAMING_BUILD_RESOURCE_HARD_LIMITS } from './gamingBuildResourceSchema.js';
import { getGamingRagChunkChars, getGamingRagMaxChunks, getGamingRagMaxSources, getGamingWebContextMaxChars } from './gamingConfig.js';
import { canonicalizeGamingGameName } from './gamingGameDetection.js';
import { normalizeGamingGameIdentity } from '@shared/gaming/gamingGameIdentity.js';
import { buildGamingRetrievalTerms, GAMING_RETRIEVAL_POLICY_VERSION } from '@shared/gaming/gamingRetrievalPolicy.js';

export { buildStoredGamingLexicalQuery } from '@shared/gaming/gamingStoredEvidenceCore.js';
export type {
  GamingStoredEvidenceChunk,
  GamingStoredKnowledgeInput,
  GamingStoredKnowledgeSource,
  GamingStoredKnowledgeContext
} from '@shared/gaming/gamingStoredEvidenceCore.js';

type PatchResolver = GamingStoredPatchResolver<GamingKnowledgeProvenanceRecord>;
const MAX_CONCURRENT_LOOKUPS = 4;
let activeLookups = 0;

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value!))) : fallback;
}

function getStoredGamingEvidenceLimits(): GamingStoredEvidenceLimits {
  return {
    chunkChars: getGamingRagChunkChars(),
    maxChunks: getGamingRagMaxChunks(),
    maxSources: getGamingRagMaxSources(),
    maxContextChars: getGamingWebContextMaxChars(),
    structuredEvidenceChars: GAMING_BUILD_RESOURCE_HARD_LIMITS.maxEvidenceChars
  };
}

/** Bind runtime configuration to the production-shared pure selection policy. */
export function selectStoredGamingEvidence(records: readonly GamingKnowledgeProvenanceRecord[], input: GamingStoredKnowledgeInput,
  resolvePatch: PatchResolver = () => undefined): GamingStoredEvidenceCandidate[] {
  return selectStoredGamingEvidenceCore(records, input, getStoredGamingEvidenceLimits(), resolvePatch);
}

/** Preserve the service formatter API while keeping configuration outside the core. */
export function formatStoredGamingEvidence(candidates: readonly GamingStoredEvidenceCandidate[], input: Pick<GamingStoredKnowledgeInput, 'sourceIndexOffset' | 'maxContextChars' | 'spoilerMode'>): GamingStoredKnowledgeContext {
  return formatStoredGamingEvidenceCore(candidates, input, { maxContextChars: getGamingWebContextMaxChars() });
}

export async function retrieveStoredGamingKnowledge(input: GamingStoredKnowledgeInput,
  options: { resolveVerifiedPatch: PatchResolver }): Promise<GamingStoredKnowledgeContext> {
  const startedAt = Date.now();
  const { query } = buildStoredGamingLexicalQuery(input.prompt, input.game, input.mode === 'guide' ? input : undefined);
  if ((!query && input.mode !== 'guide') || input.maxContextChars === 0 || getGamingWebContextMaxChars() === 0) return { context: '', sources: [] };
  input.signal?.throwIfAborted();
  const preciseGameKey = normalizeGamingGameIdentity(input.game).slice(0, 120);
  const gameKey = input.mode === 'guide' || input.hybridRetrieval ? preciseGameKey
    : canonicalizeGamingGameName(input.game).normalize('NFKC').toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 160);
  const resolveSourceIdentity = input.mode === 'guide' || input.hybridRetrieval || preciseGameKey !== gameKey;
  let sourceKnown = false;
  let records: GamingKnowledgeProvenanceRecord[];
  try {
    if (activeLookups >= MAX_CONCURRENT_LOOKUPS) throw Object.assign(new Error('Stored Gaming knowledge lookup capacity is busy.'), { name: 'GamingStoredKnowledgeLookupBusyError' });
    activeLookups += 1;
    const queryTimeoutMs = boundedInteger(input.queryTimeoutMs, 1_000, 1, 1_000);
    const controller = new AbortController();
    const relayAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', relayAbort, { once: true });
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('Stored Gaming knowledge lookup timed out.'), { name: 'TimeoutError' })), queryTimeoutMs);
    let rejectAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    try {
      // The caller may leave after the deadline, but admission stays charged until the
      // actual pool waiter/query settles. Its aborted signal forbids stale DB work.
      const pending = Promise.resolve().then(async () => {
        const lookupStartedAt = Date.now();
        const identities = resolveSourceIdentity
          ? await findActiveGamingSourceIdentities({ game: input.game, ...((input.mode === 'guide' || input.hybridRetrieval) && input.edition ? { edition: input.edition } : {}), mode: input.hybridRetrieval ? undefined : input.mode }, { queryTimeoutMs, signal: controller.signal })
          : undefined;
        // Newly ingested precise titles can differ from the historical build/meta
        // alias key. Prefer their exact catalog scope, retaining the legacy fallback.
        const sources = input.mode === 'guide' || input.hybridRetrieval || identities?.length ? identities : undefined;
        sourceKnown = (input.mode === 'guide' || input.hybridRetrieval === true) && Boolean(sources?.length);
        controller.signal.throwIfAborted();
        // Catalog presence never substitutes for positively relevant gameplay evidence.
        if (!query || (sources && !sources.length)) return [];
        const remainingMs = Math.max(1, queryTimeoutMs - (Date.now() - lookupStartedAt));
        return searchActiveGamingKnowledge({ gameKey: sources?.length ? preciseGameKey : gameKey, query, mode: input.hybridRetrieval ? undefined : input.mode, limit: MAX_STORED_GAMING_CANDIDATES,
          ...(sources ? { sourceIds: sources.map(source => source.sourceId) } : {}) },
        { queryTimeoutMs: remainingMs, signal: controller.signal });
      }).finally(() => { activeLookups -= 1; });
      records = await Promise.race([pending, aborted]);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', relayAbort);
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
    }
    input.signal?.throwIfAborted();
  } catch (error) {
    if (input.signal?.aborted) throw error;
    if (input.failOnUnavailable) throw error;
    logger.warn('gaming.stored_retrieval_failed', { module: 'gaming-stored-knowledge', mode: input.mode, errorType: error instanceof Error ? error.name : 'unknown' });
    return { context: '', sources: [], ...(sourceKnown ? { sourceKnown } : {}) };
  }
  const candidates = selectStoredGamingEvidence(records, input, options.resolveVerifiedPatch);
  const result = formatStoredGamingEvidence(candidates, input);
  const retrievalTerms = buildGamingRetrievalTerms(input);
  logger.info('gaming.stored_retrieval.completed', {
    ...(input.mode === 'guide' ? { retrievalPolicyVersion: GAMING_RETRIEVAL_POLICY_VERSION,
      requestTermCount: retrievalTerms.requestTerms.length, playerContextTermCount: retrievalTerms.contextTerms.length,
      effectiveSpoilerMode: input.spoilerMode ?? 'none' } : {}),
    lexicalCandidateCount: records.length, semanticCandidateCount: 0,
    mergedCandidateCount: new Set(records.map(record => record.recordId)).size,
    selectedChunkCount: result.evidence?.length ?? 0, selectedContextChars: result.context.length,
    ...(input.mode === 'guide' ? { sourceKnown } : {}),
    retrievalElapsedMs: Date.now() - startedAt
  });
  return { ...result, ...(input.mode === 'guide' || input.hybridRetrieval ? { sourceKnown } : {}) };
}

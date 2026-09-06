import type { GamingKnowledgeProvenanceRecord } from '@core/db/repositories/gamingSourceRepository.js';
import { searchActiveGamingKnowledge } from '@core/db/repositories/gamingSourceRepository.js';
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
export function formatStoredGamingEvidence(candidates: readonly GamingStoredEvidenceCandidate[], input: Pick<GamingStoredKnowledgeInput, 'sourceIndexOffset' | 'maxContextChars'>): GamingStoredKnowledgeContext {
  return formatStoredGamingEvidenceCore(candidates, input, { maxContextChars: getGamingWebContextMaxChars() });
}

export async function retrieveStoredGamingKnowledge(input: GamingStoredKnowledgeInput,
  options: { resolveVerifiedPatch: PatchResolver }): Promise<GamingStoredKnowledgeContext> {
  const startedAt = Date.now();
  const { query } = buildStoredGamingLexicalQuery(input.prompt, input.game);
  if (!query || input.maxContextChars === 0 || getGamingWebContextMaxChars() === 0) return { context: '', sources: [] };
  input.signal?.throwIfAborted();
  const gameKey = canonicalizeGamingGameName(input.game).normalize('NFKC').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 160);
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
      const pending = Promise.resolve().then(() => searchActiveGamingKnowledge({ gameKey, query, mode: input.mode, limit: MAX_STORED_GAMING_CANDIDATES },
        { queryTimeoutMs, signal: controller.signal })).finally(() => { activeLookups -= 1; });
      records = await Promise.race([pending, aborted]);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', relayAbort);
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
    }
    input.signal?.throwIfAborted();
  } catch (error) {
    if (input.signal?.aborted) throw error;
    logger.warn('gaming.stored_retrieval_failed', { module: 'gaming-stored-knowledge', mode: input.mode, errorType: error instanceof Error ? error.name : 'unknown' });
    return { context: '', sources: [] };
  }
  const candidates = selectStoredGamingEvidence(records, input, options.resolveVerifiedPatch);
  const result = formatStoredGamingEvidence(candidates, input);
  logger.info('gaming.stored_retrieval.completed', {
    lexicalCandidateCount: records.length, semanticCandidateCount: 0,
    mergedCandidateCount: new Set(records.map(record => record.recordId)).size,
    selectedChunkCount: result.evidence?.length ?? 0, selectedContextChars: result.context.length,
    retrievalElapsedMs: Date.now() - startedAt
  });
  return result;
}

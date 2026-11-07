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
import { canonicalizeGamingGameName, detectGamingLeadingGameAlias } from './gamingGameDetection.js';
import { normalizeGamingGameIdentity } from '@shared/gaming/gamingGameIdentity.js';
import { buildGamingRetrievalTerms, GAMING_RETRIEVAL_POLICY_VERSION } from '@shared/gaming/gamingRetrievalPolicy.js';
import { assessGamingClearEvidence, assessGamingRequestCoverage } from '@shared/gaming/gamingClearEvidence.js';
import { GAMING_CLEAR_POLICY_VERSION, parseGamingClearAssessment } from '@shared/gaming/gamingClearPolicy.js';
import { gamingSourceHasAuthorityRestriction } from '@shared/gaming/gamingSourceAuthority.js';

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
  const validatedRecords = records.slice(0, MAX_STORED_GAMING_CANDIDATES).map(record => {
    const assessment = parseGamingClearAssessment(record.provenance?.gamingClear);
    const bound = assessment?.profile === 'source'
      && assessment.subjectHash === (record.provenance?.approvedContentHash ?? record.revisionId);
    // An invalidated explicit approval cannot fall back to independently stored
    // applicability and regain its old identity authority. Keep its text and
    // restrictions readable, but require source reassessment before generation.
    const priorAssessmentInvalid = record.provenance?.gamingClear !== undefined && !bound;
    // An unassessed historical revision has no independent acquired-identity
    // proof. Keep its text readable, but do not let a complete old game snapshot
    // regain generation authority before a current server-owned reassessment.
    const identityProofMissing = !bound && record.provenance?.sourceIdentityPolicyVersion !== GAMING_CLEAR_POLICY_VERSION;
    const acquiredApplicability = record.provenance?.acquiredApplicability;
    const provenance = (priorAssessmentInvalid || identityProofMissing) && acquiredApplicability && typeof acquiredApplicability === 'object'
      && !Array.isArray(acquiredApplicability) ? { ...record.provenance,
        acquiredApplicability: { ...acquiredApplicability, metadataUnverified: true } } : record.provenance;
    return { ...record, provenance, ...(bound ? { clearSourceAssessment: assessment } : {}) };
  });
  return selectStoredGamingEvidenceCore(validatedRecords, input, getStoredGamingEvidenceLimits(), resolvePatch, assessGamingRequestCoverage);
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
  // Recognition may request the precise source lookup, but never replace the
  // requested title with a franchise parent or strip an unfamiliar subtitle.
  const recognizedParent = detectGamingLeadingGameAlias(input.game).game;
  const resolveSourceIdentity = input.mode === 'guide' || input.hybridRetrieval || preciseGameKey !== gameKey
    || Boolean(recognizedParent && normalizeGamingGameIdentity(recognizedParent) !== preciseGameKey);
  let sourceKnown = false;
  let lexicalCandidateCount = 0;
  const lexicalRecordIds = new Set<string>();
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
        const eligible: GamingKnowledgeProvenanceRecord[] = [];
        const sourceRevisions = new Map<string, string>();
        const invalidatedSources = new Set<string>();
        let offset = 0;
        // Retained rows stay available to raw owner inspection. Refill the
        // generation pool past them rather than treating one full held page as
        // exhausted knowledge. Every page shares the original lookup deadline.
        while (eligible.length < MAX_STORED_GAMING_CANDIDATES) {
          controller.signal.throwIfAborted();
          const remainingMs = queryTimeoutMs - (Date.now() - lookupStartedAt);
          if (remainingMs <= 0) throw Object.assign(new Error('Stored Gaming knowledge lookup timed out.'), { name: 'TimeoutError' });
          const page = await searchActiveGamingKnowledge({ gameKey: sources?.length ? preciseGameKey : gameKey, query,
            mode: input.hybridRetrieval ? undefined : input.mode, limit: MAX_STORED_GAMING_CANDIDATES,
            ...(offset ? { offset } : {}), ...(sources ? { sourceIds: sources.map(source => source.sourceId) } : {}) },
          { queryTimeoutMs: remainingMs, signal: controller.signal });
          lexicalCandidateCount += page.length;
          for (const record of page) {
            const duplicate = lexicalRecordIds.has(record.recordId);
            lexicalRecordIds.add(record.recordId);
            // A refresh or hold may commit between pages. Once observed, discard
            // that source for this lookup, including previously collected rows.
            const observedRevision = sourceRevisions.get(record.sourceId);
            if (record.authorityReassessmentRequired === true || gamingSourceHasAuthorityRestriction(record.provenance)
              || observedRevision !== undefined && observedRevision !== record.revisionId) {
              invalidatedSources.add(record.sourceId);
              for (let index = eligible.length - 1; index >= 0; index -= 1) {
                if (eligible[index].sourceId === record.sourceId) eligible.splice(index, 1);
              }
              continue;
            }
            if (invalidatedSources.has(record.sourceId) || duplicate) continue;
            sourceRevisions.set(record.sourceId, record.revisionId);
            eligible.push(record);
          }
          if (page.length < MAX_STORED_GAMING_CANDIDATES) break;
          offset += page.length;
        }
        return eligible.slice(0, MAX_STORED_GAMING_CANDIDATES);
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
  // Assess only passages that survived formatting. The assembled live/stored
  // set is assessed again before generation, allowing complementary evidence.
  const clearEvidenceAssessment = assessGamingClearEvidence(input, result, { identityVerified: true });
  if (result.evidence?.length) result.clearEvidenceAssessment = clearEvidenceAssessment;
  logger.info('gaming.clear.evidence.completed', {
    rubricVersion: clearEvidenceAssessment.rubricVersion, profile: clearEvidenceAssessment.profile,
    policyProfile: clearEvidenceAssessment.policyProfile, subjectHash: clearEvidenceAssessment.subjectHash,
    assessmentMethod: clearEvidenceAssessment.assessmentMethod, assessmentStatus: clearEvidenceAssessment.assessmentStatus,
    dimensionScores: Object.fromEntries(Object.entries(clearEvidenceAssessment.dimensionScores).map(([key, value]) => [key, value.score])),
    overall: clearEvidenceAssessment.overall, decision: clearEvidenceAssessment.decision,
    reasonCodes: clearEvidenceAssessment.findings.map(finding => finding.code),
    blockingFindingCount: clearEvidenceAssessment.blockingFindings.length,
    elapsedMs: Date.now() - startedAt, budgetOutcome: 'within_existing_selection_budget'
  });
  const retrievalTerms = buildGamingRetrievalTerms(input);
  logger.info('gaming.stored_retrieval.completed', {
    ...(input.mode === 'guide' ? { retrievalPolicyVersion: GAMING_RETRIEVAL_POLICY_VERSION,
      requestTermCount: retrievalTerms.requestTerms.length, playerContextTermCount: retrievalTerms.contextTerms.length,
      effectiveSpoilerMode: input.spoilerMode ?? 'none' } : {}),
    lexicalCandidateCount, semanticCandidateCount: 0,
    mergedCandidateCount: lexicalRecordIds.size,
    selectedChunkCount: result.evidence?.length ?? 0, selectedContextChars: result.context.length,
    ...(input.mode === 'guide' ? { sourceKnown } : {}),
    retrievalElapsedMs: Date.now() - startedAt
  });
  return { ...result, ...(input.mode === 'guide' || input.hybridRetrieval ? { sourceKnown } : {}) };
}

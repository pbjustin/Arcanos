import { gamingApplicabilityScopeRequired } from '@shared/gaming/gamingGuideApplicability.js';
import { resolveGamingRequestEdition, gamingEditionEvidenceMatchesRequest, normalizeGamingMinecraftEdition } from '@shared/gaming/gamingGameIdentity.js';
import { createHash, randomUUID } from 'node:crypto';
import { logger } from '@platform/logging/structuredLogging.js';
import { normalizeGamingGameIdentity, resolveGamingGuideIdentity } from '@shared/gaming/gamingGameIdentity.js';
import { classifyGamingDocumentQuality, selectGamingSourceAdmissionUrl } from '@shared/gaming/gamingDocumentIngestionCore.js';
import { buildGamingRetrievalTerms, buildGamingRequestRequirements, hasGamingRelevantGuideContribution, gamingTermCoverage } from '@shared/gaming/gamingRetrievalPolicy.js';
import {
  assessGamingSourcePolicy, extractGamingFreshnessMetadata, classifyGamingQuestionFreshness, gamingSeasonalPatchRequired,
  type GamingFreshnessEvidence
} from '@shared/gaming/gamingFreshnessCore.js';
import {
  selectStoredGamingEvidence, projectStoredGamingEvidenceCandidates, selectGamingCoverageEvidence, formatStoredGamingEvidence,
  type GamingStoredEvidenceRecord, type GamingStoredEvidenceChunk, type GamingStoredKnowledgeContext, type GamingStoredKnowledgeInput
} from '@shared/gaming/gamingStoredEvidenceCore.js';
import { filterGamingDocumentInstructions } from './gamingDocumentExtraction.js';
import { describeGamingDocumentSource, resolveGamingDocument, isResolvedGamingDocumentIdentityVerified, projectGamingDocumentPublicUrl,
  GamingDocumentAcquisitionError, GAMING_DOCUMENT_ACQUISITION_POLICY_VERSION, type ResolvedGamingDocument } from './gamingDocumentResolution.js';
import { chunkGamingDocument, GAMING_DURABLE_DOCUMENT_LIMITS } from './gamingDurableDocumentChunks.js';
import { sanitizeGamingDiscoveryCandidateUrl } from './gamingSourceDiscovery.js';
import { getGamingRagChunkChars, getGamingRagMaxChunks, getGamingRagMaxSources, getGamingWebContextMaxChars, getGamingWebContextFetchTimeoutMs } from './gamingConfig.js';
import { createApprovedGamingSourceIngestion, hashGamingApprovedDocument, type GamingSourceGatewayContext } from './gamingSourceIngestion.js';
import { assessGamingClearSource, gamingClearHistoricalSourceVerified, gamingClearIntactSourceText } from '@shared/gaming/gamingClearSource.js';
import { GAMING_CLEAR_VERSION, gamingClearHash, type GamingClearAssessment } from '@shared/gaming/gamingClearPolicy.js';
import { GAMING_HYBRID_LIMITS } from '@shared/gaming/gamingHybridContract.js';
import { pickGamingPlayerContext } from '@shared/gaming/gamingPlayerContext.js';
import { gamingPlatformEvidenceMatchesRequest } from '@shared/gaming/gamingPlatformIdentity.js';
import { assessGamingStructuralUsability, selectGamingSourceEditionScopedEvidence } from '@shared/gaming/gamingStructuralEvidence.js';
import type { GamingStructureDiagnostics } from '@shared/gaming/gamingEvidenceUnits.js';
import { GAMING_CURRENTNESS_ADAPTER_VERSION } from '@shared/gaming/gamingCurrentnessAdapters.js';
import { assessGamingClearEvidence, assessGamingRequestCoverage, gamingSelectedEvidenceIds, type GamingRequestCoverageAssessment } from '@shared/gaming/gamingClearEvidence.js';

export const GAMING_HYBRID_CANDIDATE_POLICY_VERSION = 'gaming-hybrid-candidates/v1';
export const GAMING_HYBRID_CANDIDATE_LIMITS = Object.freeze({ count: GAMING_HYBRID_LIMITS.candidates,
  artifactTtlMs: GAMING_HYBRID_LIMITS.workflowTtlMs, totalFetchMs: GAMING_HYBRID_LIMITS.candidateTimeoutMs });
export type GamingHybridStoragePolicy = 'transient_only' | 'ask_before_store' | 'auto_store_approved';

/** Every frontend field is only a hint. Only url is used to acquire evidence. */
export interface GamingHybridCandidateInput {
  url: string;
  title?: string;
  discoveredAt?: string;
  discoveryMethod?: string;
  claimedGame?: string;
  claimedPatch?: string;
  claimedPublisher?: string;
  claimedCategory?: string;
}

export interface GamingHybridCandidateDecision {
  submittedIndex: number;
  origin?: 'submitted' | 'required_official_article';
  candidateId?: string;
  url?: string;
  decision: 'accepted_transient' | 'eligible_for_ingestion' | 'already_indexed' | 'rejected' | 'requires_confirmation';
  reasonCodes: string[];
  sourceCategory?: string;
  contentHash?: string;
}

/** Internal request artifact. Never serialize this object into an Action response. */
export interface GamingHybridAcceptedCandidate {
  candidateId: string;
  actorScopeHash: string;
  workflowId?: string;
  contentHash: string;
  policyVersion: typeof GAMING_HYBRID_CANDIDATE_POLICY_VERSION;
  expiresAt: number;
  game: string;
  recordType: 'guide' | 'build' | 'meta';
  publicUrl: string;
  document: ResolvedGamingDocument;
  freshness: GamingFreshnessEvidence;
  sourcePolicy: ReturnType<typeof assessGamingSourcePolicy>;
  sourceAssessment: GamingClearAssessment;
  assessmentBinding: string;
  sourceContext: GamingStoredKnowledgeInput & { region?: string };
  sourceMetadataBinding: string;
  /** Server-created content-bound records retained for v2 recovery selection. */
  evidenceRecords?: GamingStoredEvidenceRecord[];
}

interface GamingHybridCandidateDependencies {
  resolveDocument?: typeof resolveGamingDocument;
  sourcePolicy?: typeof assessGamingSourcePolicy;
  extractFreshness?: typeof extractGamingFreshnessMetadata;
  now?: () => Date;
}

const actorHash = (actorKey: string) => createHash('sha256').update(actorKey, 'utf8').digest('hex');
const sourceMetadataBinding = (freshness: GamingFreshnessEvidence, policy: ReturnType<typeof assessGamingSourcePolicy>): string => {
  const metadata = { ...freshness } as Record<string, unknown>;
  // Only the workflow's separately artifact-bound official index attestation is additive.
  delete metadata.currentVerification;
  return gamingClearHash({ freshness: metadata, policy });
};

function isReviewedOfficialCurrentnessSource(policy: ReturnType<typeof assessGamingSourcePolicy>): boolean {
  return Boolean(policy.ruleId && policy.authority === 'official'
    && (policy.category === 'official_updates' && ['current_index', 'article'].includes(policy.currentness)
      || policy.category === 'official_status' && policy.currentness === 'live_status'));
}

function unsafeHints(candidate: GamingHybridCandidateInput): boolean {
  return Object.entries(candidate).some(([key, value]) => key !== 'url' && value !== undefined
    && (typeof value !== 'string' || value.length > 240
      || filterGamingDocumentInstructions(value) !== value.normalize('NFKC').replace(/\s+/gu, ' ').trim()));
}

/** Safe acquisition happens once. Full documents stay internal; existing chunks and selection bound context. */
export async function evaluateGamingHybridCandidates(
  submission: GamingStoredKnowledgeInput & { candidates: readonly GamingHybridCandidateInput[]; region?: string;
    discoveryType?: 'gameplay_evidence' | 'currentness_verification'; protocolVersion?: 'gaming-hybrid-v1' | 'gaming-hybrid-v2' },
  context: { actorKey: string; requestId?: string; traceId?: string; workflowId?: string; signal?: AbortSignal; maxElapsedMs?: number },
  dependencies: GamingHybridCandidateDependencies = {}
): Promise<{ decisions: GamingHybridCandidateDecision[]; accepted: GamingHybridAcceptedCandidate[]; knowledge: GamingStoredKnowledgeContext;
  currentnessEvidence?: GamingFreshnessEvidence[]; currentnessFailureBlocksAdvisory?: boolean; acquisitionWorkMs?: number }> {
  // Keep discovery hints outside the evidence request. Acquisition alone establishes
  // document identity; no frontend label enters CLEAR, applicability or selection.
  const { candidates: submittedCandidates, ...request } = submission;
  const input = { ...request, edition: resolveGamingRequestEdition(request) };
  if (!context.actorKey || submittedCandidates.length < 1 || submittedCandidates.length > GAMING_HYBRID_CANDIDATE_LIMITS.count) {
    throw Object.assign(new Error('Submit one to three candidate URLs within an authenticated workflow.'), { code: 'GAMING_HYBRID_CANDIDATE_LIMIT' });
  }
  const now = dependencies.now ?? (() => new Date());
  const acquisitionStartedAt = Date.now();
  const allowedMs = context.maxElapsedMs === undefined ? GAMING_HYBRID_CANDIDATE_LIMITS.totalFetchMs
    : Math.max(0, Math.min(GAMING_HYBRID_CANDIDATE_LIMITS.totalFetchMs, context.maxElapsedMs));
  const deadlineAt = acquisitionStartedAt + allowedMs;
  const v2 = input.protocolVersion === 'gaming-hybrid-v2';
  const selectionInput = v2 ? { ...input, requireRequestCoverage: true } : input;
  const callerSignal = context.signal ?? input.signal;
  // The same absolute acquisition deadline also bounds extraction/chunking,
  // while external cancellation retains its distinct workflow failure meaning.
  const acquisitionSignal = v2 ? AbortSignal.timeout(Math.max(0, Math.ceil(allowedMs))) : undefined;
  const signal = acquisitionSignal && callerSignal ? AbortSignal.any([callerSignal, acquisitionSignal]) : acquisitionSignal ?? callerSignal;
  const seen = new Set<string>();
  const accepted: GamingHybridAcceptedCandidate[] = [];
  const decisions: GamingHybridCandidateDecision[] = [];
  const currentnessEvidence: GamingFreshnessEvidence[] = [];
  let currentnessFailureBlocksAdvisory = false;
  const allRecords: GamingStoredEvidenceRecord[] = [];
  const terms = buildGamingRetrievalTerms(input).focusTerms;
  const queue: Array<{ candidate: GamingHybridCandidateInput; submittedIndex: number; origin?: 'required_official_article' }> =
    submittedCandidates.map((candidate, submittedIndex) => ({ candidate, submittedIndex }));
  for (const { candidate, submittedIndex, origin } of queue) {
    callerSignal?.throwIfAborted();
    let publicUrl: string | undefined;
    let sourceAssessed = false;
    const sourceStartedAt = Date.now();
    const candidateReference = randomUUID();
    let extractionDiagnostic: GamingStructureDiagnostics | undefined;
    let missingClaimFields: string[] = [];
    let acquisitionDiagnostic: Record<string, string | number> = {
      stage: 'admission', policyVersion: GAMING_DOCUMENT_ACQUISITION_POLICY_VERSION, redirectCount: 0, failingHop: 0
    };
    const reject = (reason: string) => {
      if (!sourceAssessed) logger.info('gaming.clear.source.not_run', { requestId: context.requestId, traceId: context.traceId,
        workflowId: context.workflowId, submittedIndex, origin: origin ?? 'submitted', candidateReference, acquisition: acquisitionDiagnostic,
        rubricVersion: GAMING_CLEAR_VERSION, profile: 'source', assessmentStatus: 'not_run', reasonCodes: [reason],
        extraction: extractionDiagnostic, missingClaimFields,
        elapsedMs: Date.now() - sourceStartedAt });
      decisions.push({ submittedIndex, ...(origin ? { origin } : {}), ...(publicUrl ? { url: projectGamingDocumentPublicUrl(publicUrl) } : {}), decision: 'rejected', reasonCodes: [reason] });
    };
    if (unsafeHints(candidate)) { reject('UNTRUSTED_METADATA_INVALID'); continue; }
    try {
      if (typeof candidate.url !== 'string' || candidate.url.length > 2_048) { reject('INVALID_URL'); continue; }
      const admission = sanitizeGamingDiscoveryCandidateUrl(candidate.url);
      if (!admission.url || admission.rejected) {
        if (admission.rejection) acquisitionDiagnostic = { ...acquisitionDiagnostic, ...admission.rejection };
        reject(v2 && ['unsupported_document_type', 'source_category_excluded'].includes(admission.rejection?.subreason ?? '')
          ? 'UNSUPPORTED_SOURCE_FORMAT' : 'URL_BLOCKED'); continue;
      }
      if (new URL(admission.url).protocol !== 'https:') {
        acquisitionDiagnostic = { ...acquisitionDiagnostic, category: 'security', subreason: 'unsupported_scheme', ruleId: 'gaming.https_required' };
        reject('URL_BLOCKED'); continue;
      }
      const description = describeGamingDocumentSource(admission.url);
      publicUrl = selectGamingSourceAdmissionUrl(admission.url, description);
      // An unavailable or unreadable arbitrary URL is not an official currentness
      // attempt. Review the admitted identity before acquisition, then recheck the
      // trusted resolver's final identity below; frontend hints grant no authority.
      if (input.discoveryType === 'currentness_verification'
        && !isReviewedOfficialCurrentnessSource((dependencies.sourcePolicy ?? assessGamingSourcePolicy)(publicUrl, input.game))) {
        reject('REVIEWED_OFFICIAL_CURRENTNESS_SOURCE_REQUIRED'); continue;
      }
      if (seen.has(publicUrl)) { reject('DUPLICATE_URL'); continue; }
      seen.add(publicUrl);
      if (Date.now() >= deadlineAt) { reject('FETCH_BUDGET_EXHAUSTED'); continue; }
      const document = await (dependencies.resolveDocument ?? resolveGamingDocument)(publicUrl,
        GAMING_DURABLE_DOCUMENT_LIMITS.documentChars, { documentPurpose: 'durable', signal, deadlineAt,
          timeoutMs: Math.min(5_000, getGamingWebContextFetchTimeoutMs(), Math.max(1, deadlineAt - Date.now())), includeLinks: false });
      callerSignal?.throwIfAborted();
      if (v2 && (acquisitionSignal?.aborted || Date.now() >= deadlineAt)) { reject('SOURCE_TIMEOUT'); continue; }
      extractionDiagnostic = document.structureDiagnostics;
      acquisitionDiagnostic = { stage: 'extraction', policyVersion: document.acquisition?.policyVersion ?? GAMING_DOCUMENT_ACQUISITION_POLICY_VERSION,
        redirectCount: document.acquisition?.redirectCount ?? 0, failingHop: document.acquisition?.redirectCount ?? 0 };
      if (!isResolvedGamingDocumentIdentityVerified(document, publicUrl)) { reject('RESOLVED_SOURCE_IDENTITY_MISMATCH'); continue; }
      // Only the trusted resolver can establish the final publisher and citation identity.
      publicUrl = document.publicUrl;
      if (document.metrics.instructionFiltered) { reject('SOURCE_INSTRUCTIONS_REJECTED'); continue; }
      const intactText = gamingClearIntactSourceText(document);
      const quality = classifyGamingDocumentQuality({ cleanedText: intactText,
        navigationDensity: document.extraction.navigationDensity, truncated: document.metrics.truncated, minUsefulTextChars: 120 });
      const structural = assessGamingStructuralUsability({ units: document.evidenceUnits, ...input });
      missingClaimFields = structural.missingFields;
      if (!structural.hasIntactUsableUnit && (quality === 'unusable' || quality === 'metadata-only')) { reject('INSUFFICIENT_EXTRACTION'); continue; }
      if (!structural.hasIntactUsableUnit && intactText.trim().length < 120) { reject('INSUFFICIENT_EXTRACTION'); continue; }
      if (document.sourceUseRestricted || /\b(?:no (?:automated|machine) (?:access|use)|automated (?:access|use) (?:is )?prohibited|do not (?:store|redistribute) (?:this|our) content)\b/iu.test(document.text)) {
        reject('SOURCE_USE_RESTRICTED'); continue;
      }
      const reviewedPolicy = (dependencies.sourcePolicy ?? assessGamingSourcePolicy)(document.publicUrl, input.game);
      // Frontend role/publisher hints and an acquired canonical tag cannot create authority.
      if (input.discoveryType === 'currentness_verification' && !isReviewedOfficialCurrentnessSource(reviewedPolicy)) {
        reject('REVIEWED_OFFICIAL_CURRENTNESS_SOURCE_REQUIRED'); continue;
      }
      const policy = classifyGamingQuestionFreshness({ prompt: input.prompt, mode: input.mode }) === 'live_status'
        ? { ...reviewedPolicy, durableAllowed: false, autoStoreAllowed: false } : reviewedPolicy;
      const freshness = (dependencies.extractFreshness ?? extractGamingFreshnessMetadata)(document, input, now());
      if (policy.authority === 'official' && (policy.category === 'official_updates'
        || policy.category === 'official_status' && policy.currentness === 'live_status')) {
        logger.info('gaming.currentness.candidate_evaluated', {
          requestId: context.requestId, workflowId: context.workflowId, origin: origin ?? 'submitted', gameIdentityHash: gamingClearHash(input.game),
          ruleId: policy.ruleId, adapterVersion: freshness.currentnessMetadata?.adapterVersion,
          sourceRole: policy.currentness === 'current_index' ? 'currentness_index' : policy.currentness === 'live_status' ? 'live_status' : 'patch_authority',
          adapterStatus: freshness.currentnessMetadata?.status ?? (policy.currentness === 'live_status' ? undefined : 'incomplete'),
          reasonCodes: freshness.currentnessMetadata?.reasons.slice(0, 8) ?? (policy.currentness === 'live_status' ? [] : ['OFFICIAL_ARTICLE_APPLICABILITY_ONLY']),
          contentHash: hashGamingApprovedDocument(document), policyVersion: policy.policyVersion,
          effectivePatchHash: freshness.currentPatch || freshness.patch ? gamingClearHash(freshness.currentPatch ?? freshness.patch) : undefined,
          effectiveBuildHash: freshness.currentBuild || freshness.build ? gamingClearHash(freshness.currentBuild ?? freshness.build) : undefined,
          cacheStatus: 'acquired', elapsedMs: Math.max(0, Date.now() - sourceStartedAt)
        });
      }
      policy.autoStoreAllowed = policy.autoStoreAllowed && freshness.autoStoreAllowed;
      if (normalizeGamingGameIdentity(freshness.game) !== normalizeGamingGameIdentity(input.game)) { reject('GAME_MISMATCH'); continue; }
      const scoped = selectGamingSourceEditionScopedEvidence(document, input, freshness.edition);
      if (scoped.reasonCodes.includes('GAME_MISMATCH')) { reject('GAME_MISMATCH'); continue; }
      if (scoped.status === 'conflict') { reject('EDITION_CONFLICT'); continue; }
      if (scoped.status === 'unverified' && scoped.reasonCodes.length) { reject('EDITION_UNVERIFIED'); continue; }
      if (input.edition && !gamingEditionEvidenceMatchesRequest(freshness.edition, input.edition, input)) {
        reject(freshness.edition ? 'EDITION_CONFLICT' : 'EDITION_UNVERIFIED'); continue;
      }
      if (!input.edition && freshness.edition && !gamingEditionEvidenceMatchesRequest(freshness.edition, undefined, input)
        && !(normalizeGamingGameIdentity(input.game) === 'minecraft' && normalizeGamingMinecraftEdition(freshness.edition))) { reject('EDITION_UNVERIFIED'); continue; }
      const applies = (values: string[] | undefined, wanted: string | undefined) => !values?.length
        || values.some(value => value.toLowerCase() === 'all' || value.toLowerCase() === wanted?.toLowerCase());
      if (freshness.platforms?.length && !gamingPlatformEvidenceMatchesRequest(freshness.platforms, input.platform) && (input.platform || gamingApplicabilityScopeRequired(input, 'platform')
        || input.discoveryType === 'currentness_verification')) { reject(input.platform ? 'PLATFORM_MISMATCH' : 'PLATFORM_UNVERIFIED'); continue; }
      if (!applies(freshness.regions, input.region) && (input.region || gamingApplicabilityScopeRequired(input, 'region')
        || input.discoveryType === 'currentness_verification')) { reject(input.region ? 'REGION_MISMATCH' : 'REGION_UNVERIFIED'); continue; }
      if (freshness.metadataConflict) {
        // A rejected, scoped official contradiction remains negative evidence. Dropping
        // it would let another accepted index falsely appear unanimous.
        if (policy.authority === 'official' && policy.ruleId && (policy.category === 'official_updates'
          || policy.category === 'official_status' && policy.currentness === 'live_status')) {
          currentnessEvidence.push({ ...freshness, id: candidateReference });
        }
        reject('CONTRADICTORY_SOURCE_METADATA'); continue;
      }
      const contentHash = hashGamingApprovedDocument(document);
      const candidateId = randomUUID();
      freshness.id = candidateId;
      const sourceAssessment = assessGamingClearSource(input, document, { subjectId: candidateId, subjectHash: contentHash,
        actorScopeHash: actorHash(context.actorKey), sourcePolicy: policy, freshness, now: now(), ...(v2 ? { allowPartialCoverage: true } : {}) });
      sourceAssessed = true;
      logger.info('gaming.clear.source.completed', { requestId: context.requestId, traceId: context.traceId,
        rubricVersion: sourceAssessment.rubricVersion, profile: sourceAssessment.profile, policyProfile: sourceAssessment.policyProfile,
        workflowId: context.workflowId, submittedIndex, candidateReference, acquisition: acquisitionDiagnostic,
        extraction: extractionDiagnostic, missingClaimFields,
        sourceRole: sourceAssessment.sourceRole, subjectHash: contentHash, assessmentMethod: sourceAssessment.assessmentMethod,
        assessmentStatus: sourceAssessment.assessmentStatus, dimensionScores: sourceAssessment.dimensionScores,
        overall: sourceAssessment.overall, decision: sourceAssessment.decision, blockingFindingCount: sourceAssessment.blockingFindings.length,
        elapsedMs: Date.now() - sourceStartedAt, budgetOutcome: 'within_existing_acquisition_budget' });
      const identityReasons = sourceAssessment.dimensionScores.alignment.reasonCodes;
      if (!['accept', 'partial'].includes(sourceAssessment.decision)
        || identityReasons.some(reason => ['GAME_MISMATCH', 'GAME_IDENTITY_UNVERIFIED', 'EDITION_CONFLICT', 'EDITION_UNVERIFIED', 'EDITION_REQUIRED'].includes(reason))) {
        reject(identityReasons.find(reason => ['GAME_MISMATCH', 'EDITION_CONFLICT'].includes(reason))
          ?? identityReasons.find(reason => ['GAME_IDENTITY_UNVERIFIED', 'EDITION_UNVERIFIED', 'EDITION_REQUIRED'].includes(reason))
          ?? sourceAssessment.dimensionScores.leverage.reasonCodes.find(reason => reason === 'QUESTION_COVERAGE_INSUFFICIENT')
          ?? sourceAssessment.blockingFindings[0]?.code ?? 'GAMING_CLEAR_SOURCE_REJECTED'); continue;
      }
      const chunks = await chunkGamingDocument(scoped.status === 'verified' ? scoped.text : intactText,
        { signal, evidenceUnits: scoped.status === 'verified' ? scoped.units : document.evidenceUnits });
      callerSignal?.throwIfAborted();
      if (v2 && (acquisitionSignal?.aborted || Date.now() >= deadlineAt)) { reject('SOURCE_TIMEOUT'); continue; }
      const records = chunks.chunks.map(chunk => ({
        recordId: `${candidateId}:${chunk.ordinal}`, recordType: input.mode === 'guide' ? 'guide' as const : input.mode === 'build' ? 'build' as const : 'meta' as const,
        title: document.metadata.title ?? null, searchText: chunk.text,
        normalized: { text: chunk.text, ...(chunk.evidenceUnits?.length ? { evidenceUnits: chunk.evidenceUnits } : {}), chunk: { ordinal: chunk.ordinal, totalChunks: chunk.totalChunks,
          startChar: chunk.startChar, endChar: chunk.endChar, headingPath: chunk.headingPath } },
        sourceId: candidateId, publicUrl: publicUrl!, sourceType: policy.category, revisionId: contentHash,
        clearSourceAssessment: sourceAssessment,
        fetchedAt: now(), publishedAt: null, provenance: { resolverId: document.resolution.resolverId,
          resolverVersion: document.resolution.resolverVersion, resolutionStrategy: document.resolution.strategy,
          gameName: input.game, edition: freshness.edition ?? input.edition, gamingClear: sourceAssessment },
        relevance: Math.max(gamingTermCoverage(chunk.text, terms), v2 && (hasGamingRelevantGuideContribution(chunk.text, input)
          || buildGamingRequestRequirements(input).some(requirement => gamingTermCoverage(chunk.text, requirement.terms) === 1)) ? 0.25 : 0)
      })).filter(record => record.relevance >= 0.25);
      // An official index/status page can verify applicability even when it does not cover the gameplay anchor.
      if (!records.length && !['current_index', 'live_status'].includes(policy.currentness)
        && input.discoveryType !== 'currentness_verification') { reject('QUESTION_COVERAGE_INSUFFICIENT'); continue; }
      const sourceContext = { ...pickGamingPlayerContext(input), game: input.game, prompt: input.prompt, mode: input.mode,
        requestedVersion: input.requestedVersion, region: input.region };
      const artifact: GamingHybridAcceptedCandidate = { candidateId, actorScopeHash: actorHash(context.actorKey),
        ...(context.workflowId ? { workflowId: context.workflowId } : {}), contentHash,
        policyVersion: GAMING_HYBRID_CANDIDATE_POLICY_VERSION, expiresAt: now().getTime() + GAMING_HYBRID_CANDIDATE_LIMITS.artifactTtlMs,
        game: input.edition && resolveGamingGuideIdentity(input.game, input.edition) !== normalizeGamingGameIdentity(input.game)
          ? `${input.game} ${input.edition}` : input.game,
        recordType: input.mode,
        publicUrl, document: { ...document, rawDocument: undefined }, freshness, sourcePolicy: policy,
        sourceAssessment, assessmentBinding: gamingClearHash({ sourceAssessment, sourceContext }), sourceContext,
        sourceMetadataBinding: sourceMetadataBinding(freshness, policy), ...(v2 ? { evidenceRecords: records } : {}) };
      accepted.push(artifact);
      allRecords.push(...records);
      decisions.push({ submittedIndex, ...(origin ? { origin } : {}), candidateId, url: publicUrl,
        decision: policy.durableAllowed && sourceAssessment.qualityEligible && !document.metrics.truncated ? 'eligible_for_ingestion' : 'accepted_transient',
        reasonCodes: [records.length ? 'VALIDATED_RELEVANT_CONTENT' : 'VALIDATED_APPLICABILITY_SOURCE',
          ...(document.metrics.truncated ? ['EXTRACTION_PARTIAL'] : [])], sourceCategory: policy.category, contentHash });
      // A reviewed index may require one exact article. Complete that relationship inside
      // this operation's existing document/time budget; arbitrary links and articles cannot recurse.
      const currentness = freshness.currentnessMetadata;
      const requiredUrl = currentness?.requiredArticleUrl;
      if (input.discoveryType === 'currentness_verification' && !origin
        && policy.authority === 'official' && policy.category === 'official_updates' && policy.currentness === 'current_index'
        && currentness?.adapterVersion === GAMING_CURRENTNESS_ADAPTER_VERSION && currentness.ruleId === policy.ruleId
        && currentness.status === 'incomplete' && currentness.requiredArticlePatch && requiredUrl
        && queue.length < GAMING_HYBRID_CANDIDATE_LIMITS.count) {
        const admission = sanitizeGamingDiscoveryCandidateUrl(requiredUrl);
        const companionPolicy = (dependencies.sourcePolicy ?? assessGamingSourcePolicy)(requiredUrl, input.game);
        if (admission.url === requiredUrl && !admission.rejected && new URL(requiredUrl).protocol === 'https:'
          && companionPolicy.authority === 'official' && companionPolicy.category === 'official_updates'
          && companionPolicy.currentness === 'article' && currentness.requiredArticleRuleIds?.includes(companionPolicy.ruleId ?? '')
          && !seen.has(requiredUrl) && !queue.some(item => sanitizeGamingDiscoveryCandidateUrl(item.candidate.url).url === requiredUrl)) {
          queue.push({ candidate: { url: requiredUrl }, submittedIndex, origin: 'required_official_article' });
        }
      }
    } catch (error) {
      if (callerSignal?.aborted) throw error;
      if (acquisitionSignal?.aborted) { reject('SOURCE_TIMEOUT'); continue; }
      if (error instanceof GamingDocumentAcquisitionError) {
        acquisitionDiagnostic = { ...error.acquisition };
        // Public acquisition reasons remain bounded. Preserve the internal
        // integrity/security distinction so an unavailable index cannot hide it.
        const unavailable = ['DNS_FAILED', 'FETCH_FAILED', 'DEADLINE_EXCEEDED', 'HTTP_RESPONSE_UNUSABLE', 'CONDITIONAL_CONTENT_UNAVAILABLE'];
        if (!unavailable.includes(error.acquisition.subreason) || error.status === 401 || error.status === 403)
          currentnessFailureBlocksAdvisory = true;
        reject(error.code); continue;
      }
      const status = (error as { response?: { status?: number } })?.response?.status;
      reject(status === 401 || status === 403 ? 'SOURCE_INACCESSIBLE' : status && [301, 302, 303, 307, 308].includes(status)
        ? 'REDIRECT_NOT_ALLOWED' : error instanceof Error && /(?:timeout|deadline|abort)/iu.test(error.name + error.message)
          ? 'SOURCE_TIMEOUT' : 'SOURCE_FETCH_FAILED');
    }
  }
  const limits = { chunkChars: getGamingRagChunkChars(), maxChunks: getGamingRagMaxChunks(),
    maxSources: Math.min(3, getGamingRagMaxSources()), maxContextChars: getGamingWebContextMaxChars(), structuredEvidenceChars: 8_000 };
  // Rank the complete bounded document before the existing selector's top-20 bound.
  allRecords.sort((a, b) => b.relevance - a.relevance || a.recordId.localeCompare(b.recordId));
  const selected = selectStoredGamingEvidence(allRecords, v2 ? { ...selectionInput,
    requiredSourceIds: requiredGamingHybridSourceIds(input, accepted) } : selectionInput, limits, undefined, assessGamingRequestCoverage);
  const knowledge = formatStoredGamingEvidence(selected, input, limits);
  knowledge.context = knowledge.context.replaceAll('Origin: stored gaming knowledge;', 'Origin: backend-validated transient Gaming evidence;');
  logger.info('gaming.hybrid.candidates_evaluated', { requestId: context.requestId, traceId: context.traceId,
    policyVersion: GAMING_HYBRID_CANDIDATE_POLICY_VERSION, candidateCount: submittedCandidates.length,
    evaluatedCandidateCount: queue.length, requiredArticleCount: queue.filter(item => item.origin === 'required_official_article').length,
    acceptedCount: accepted.length, rejectedCount: decisions.filter(decision => decision.decision === 'rejected').length,
    selectedChunkCount: knowledge.evidence?.length ?? 0, selectedContextChars: knowledge.context.length,
    decisions: decisions.map(decision => ({ candidateId: decision.candidateId, decision: decision.decision, reasons: decision.reasonCodes })) });
  return { decisions, accepted, knowledge, acquisitionWorkMs: Math.max(0, Date.now() - acquisitionStartedAt), ...(currentnessEvidence.length ? { currentnessEvidence } : {}),
    ...(currentnessFailureBlocksAdvisory ? { currentnessFailureBlocksAdvisory } : {}) };
}

/** Artifact validity never comes from discovery hints or caller-selected IDs. */
function validGamingHybridArtifact(candidate: GamingHybridAcceptedCandidate,
  context: { actorKey: string; workflowId: string; now?: number }): boolean {
  return candidate.actorScopeHash === actorHash(context.actorKey) && candidate.workflowId === context.workflowId
    && candidate.expiresAt > (context.now ?? Date.now()) && candidate.policyVersion === GAMING_HYBRID_CANDIDATE_POLICY_VERSION
    && candidate.publicUrl === candidate.document.publicUrl
    && isResolvedGamingDocumentIdentityVerified(candidate.document, candidate.document.requestedUrl)
    && candidate.contentHash === hashGamingApprovedDocument(candidate.document)
    && candidate.sourceAssessment?.rubricVersion === GAMING_CLEAR_VERSION
    && candidate.sourceAssessment.subjectHash === candidate.contentHash
    && candidate.assessmentBinding === gamingClearHash({ sourceAssessment: candidate.sourceAssessment, sourceContext: candidate.sourceContext })
    && candidate.sourceMetadataBinding === sourceMetadataBinding(candidate.freshness, candidate.sourcePolicy);
}

/** Original supplied URL identity is backend-intake data, never a publisher/ranking hint. */
function requiredGamingHybridSourceIds(input: GamingStoredKnowledgeInput,
  accepted: readonly GamingHybridAcceptedCandidate[]): string[] {
  const requiredUrls = new Set((input.guideUrls ?? []).flatMap(url => {
    const admission = sanitizeGamingDiscoveryCandidateUrl(url);
    return admission.url && !admission.rejected ? [admission.url] : [];
  }));
  return accepted.filter(candidate => requiredUrls.has(candidate.document.requestedUrl)).map(candidate => candidate.candidateId);
}

/** Reuse the existing record selector over every still-valid accepted artifact. */
export function selectGamingHybridAcceptedEvidence(input: GamingStoredKnowledgeInput,
  accepted: readonly GamingHybridAcceptedCandidate[], context: { actorKey: string; workflowId: string; now?: number }): GamingStoredKnowledgeContext {
  if (accepted.some(candidate => !validGamingHybridArtifact(candidate, context)
    || candidate.sourceContext.prompt !== input.prompt || candidate.sourceContext.mode !== input.mode
    || normalizeGamingGameIdentity(candidate.sourceContext.game) !== normalizeGamingGameIdentity(input.game))) {
    throw Object.assign(new Error('Accepted evidence does not belong to this valid workflow.'), { code: 'EVIDENCE_MEMBERSHIP_INVALID' });
  }
  const records = accepted.flatMap(candidate => {
    const intactText = gamingClearIntactSourceText(candidate.document);
    return (candidate.evidenceRecords ?? []).filter(record => record.sourceId === candidate.candidateId
      && record.revisionId === candidate.contentHash && record.publicUrl === candidate.publicUrl
      && intactText.includes(typeof record.normalized.text === 'string' ? record.normalized.text : record.searchText));
  });
  const limits = hybridEvidenceLimits();
  const fullPool: GamingStoredKnowledgeContext = { context: '', sources: accepted.map(candidate => ({
    sourceId: candidate.candidateId, game: candidate.sourceContext.game, edition: candidate.freshness.edition ?? candidate.sourceContext.edition,
    url: candidate.publicUrl, sourceType: candidate.sourcePolicy.category, origin: 'live',
    fetchedAt: candidate.freshness.fetchedAt, snippet: '', clearSourceAssessment: candidate.sourceAssessment,
    freshnessMetadata: { ...candidate.freshness }
  })), evidence: records.map(record => ({ sourceId: record.sourceId, revisionId: record.revisionId, recordId: record.recordId,
    recordType: record.recordType, publicUrl: record.publicUrl, text: record.searchText,
    ...(Array.isArray(record.normalized.evidenceUnits) ? { evidenceUnits: record.normalized.evidenceUnits as ResolvedGamingDocument['evidenceUnits'] } : {}),
    lexicalScore: record.relevance, combinedScore: record.relevance, provenance: { fetchedAt: record.fetchedAt.toISOString() }
  })) };
  const fullAssessment = assessGamingClearEvidence(input, fullPool, { requireRequestCoverage: true, now: new Date(context.now ?? Date.now()) });
  const selected = selectStoredGamingEvidence(records, { ...input, requireRequestCoverage: true,
    requiredSourceIds: requiredGamingHybridSourceIds(input, accepted) }, limits, undefined, assessGamingRequestCoverage);
  const knowledge = formatStoredGamingEvidence(selected, input, limits);
  knowledge.materialConflict = hasGamingMaterialConflict(fullAssessment);
  knowledge.structuralConflictAssessmentUnavailable = fullAssessment.blockingFindings
    .some(finding => finding.code === 'STRUCTURAL_CONFLICT_ASSESSMENT_UNVERIFIED');
  for (const source of knowledge.sources) source.origin = 'live';
  return knowledge;
}

function hasGamingMaterialConflict(assessment: GamingClearAssessment): boolean {
  return assessment.blockingFindings.some(finding => ['CONTRADICTORY_EVIDENCE', 'CONTRADICTORY_STRUCTURAL_RECORDS',
    'APPLICABILITY_CONFLICT', 'CONFLICTING_CURRENTNESS'].includes(finding.code));
}

function hybridEvidenceLimits() {
  return { chunkChars: getGamingRagChunkChars(), maxChunks: getGamingRagMaxChunks(),
    maxSources: Math.min(3, getGamingRagMaxSources()), maxContextChars: getGamingWebContextMaxChars(), structuredEvidenceChars: 8_000 };
}

/**
 * Compact the already-admissible pool using the existing selector and coverage
 * adapter. Contradictions are assessed by CLEAR on the full pool before this
 * projection, so removing redundant chunks never adjudicates a material conflict.
 */
export interface GamingHybridEvidenceSelection extends GamingRequestCoverageAssessment {
  knowledge: GamingStoredKnowledgeContext;
  selectedCandidateIds: string[];
  selectedEvidenceIds: string[];
  materialConflict: boolean;
  inspectionUnavailable?: boolean;
}

export function selectGamingHybridEvidence(input: GamingStoredKnowledgeInput,
  knowledge: GamingStoredKnowledgeContext, context: { requiredSourceIds?: readonly string[] } = {}): GamingHybridEvidenceSelection {
  const limits = hybridEvidenceLimits();
  const fullAssessment = assessGamingClearEvidence({ ...input, game: input.game }, knowledge, { requireRequestCoverage: true });
  const materialConflict = knowledge.materialConflict === true || hasGamingMaterialConflict(fullAssessment);
  const inspectionUnavailable = knowledge.structuralConflictAssessmentUnavailable === true || fullAssessment.blockingFindings
    .some(finding => finding.code === 'STRUCTURAL_CONFLICT_ASSESSMENT_UNVERIFIED');
  if (inspectionUnavailable) return { knowledge: { context: '', sources: [], evidence: [], sourceKnown: knowledge.sourceKnown,
    structuralConflictAssessmentUnavailable: true }, selectedCandidateIds: [], selectedEvidenceIds: [], coverageSatisfied: false,
    missingCoverage: [], gapAssessmentStatus: 'unknown' as const, requirementSupport: [], materialConflict, inspectionUnavailable: true };
  if (materialConflict) return { knowledge: { context: '', sources: [], evidence: [], sourceKnown: knowledge.sourceKnown },
    selectedCandidateIds: [], selectedEvidenceIds: [], coverageSatisfied: false, missingCoverage: [],
    gapAssessmentStatus: 'unknown' as const, requirementSupport: [], materialConflict: true };
  const records: GamingStoredEvidenceRecord[] = (knowledge.evidence ?? []).flatMap(chunk => {
    const source = knowledge.sources.find(item => item.sourceId === chunk.sourceId && item.url === chunk.publicUrl);
    if (!source) return [];
    const fetchedAt = new Date(chunk.provenance.fetchedAt);
    if (!Number.isFinite(fetchedAt.getTime())) return [];
    return [{ recordId: chunk.recordId, recordType: chunk.recordType, title: source.title ?? null, gameName: source.game,
      searchText: chunk.text, normalized: { text: chunk.text, ...(chunk.evidenceUnits?.length ? { evidenceUnits: chunk.evidenceUnits } : {}) },
      sourceId: chunk.sourceId, publicUrl: chunk.publicUrl, sourceType: source.sourceType, revisionId: chunk.revisionId,
      fetchedAt, publishedAt: source.publishedAt ? new Date(source.publishedAt) : null,
      clearSourceAssessment: source.clearSourceAssessment, provenance: {}, relevance: Math.max(0.01, chunk.lexicalScore) }];
  });
  const proofs = knowledge.sources.flatMap(source => {
    if (!context.requiredSourceIds?.includes(source.sourceId)
      || !(['currentness_index', 'live_status'].includes(source.clearSourceAssessment?.sourceRole ?? '')
        || ['current_index', 'live_status'].includes(String(source.freshnessMetadata?.currentness ?? '')))) return [];
    const passages = (knowledge.evidence ?? []).filter(chunk => chunk.sourceId === source.sourceId && chunk.publicUrl === source.url
      && chunk.text.length > 0 && chunk.text.length <= 8_000);
    const evidence = passages.find(chunk => chunk.recordId === `${source.sourceId}:verification`) ?? passages[0];
    return evidence ? [{ evidence, source }] : [];
  });
  const proofIds = new Set(proofs.map(proof => proof.source.sourceId));
  // Admission still uses the established bounded record projection. Selection
  // costs the original intact passages and required proof together, including
  // their headers, rather than imposing a separate source-identity ceiling.
  const projected = projectStoredGamingEvidenceCandidates(records.filter(record => !proofIds.has(record.sourceId)),
    { ...input, requireRequestCoverage: true, requiredSourceIds: context.requiredSourceIds }, limits,
    record => knowledge.sources.find(source => source.sourceId === record.sourceId)?.patchVersion);
  // Preserve server-owned metadata/provenance and intact original passages rather
  // than introducing a second excerpt or rewriting citation identity.
  const candidates = projected.flatMap(candidate => {
    const original = knowledge.evidence?.find(chunk => chunk.recordId === candidate.evidence.recordId && chunk.sourceId === candidate.evidence.sourceId);
    const source = knowledge.sources.find(item => item.sourceId === candidate.source.sourceId && item.url === candidate.source.url);
    return original && source ? [{ evidence: original, source }] : [];
  });
  const selected = selectGamingCoverageEvidence([...candidates, ...proofs],
    { ...input, requireRequestCoverage: true, requiredSourceIds: context.requiredSourceIds }, limits, assessGamingRequestCoverage);
  const compact = formatStoredGamingEvidence(selected, input, limits);
  compact.sourceKnown = knowledge.sourceKnown;
  const coverage = assessGamingRequestCoverage(input, compact);
  return { knowledge: compact, selectedCandidateIds: [...new Set(compact.sources.filter(source => source.origin === 'live').map(source => source.sourceId))],
    selectedEvidenceIds: gamingSelectedEvidenceIds(compact), ...coverage, materialConflict };
}

/** Match the established source-bound projection, which may select disjoint intact sentences. */
function isGamingHybridChunkBound(chunk: GamingStoredEvidenceChunk, candidate: GamingHybridAcceptedCandidate): boolean {
  const record = candidate.evidenceRecords?.find(item => item.recordId === chunk.recordId
    && item.sourceId === candidate.candidateId && item.revisionId === candidate.contentHash && item.publicUrl === candidate.publicUrl);
  if (!record || !gamingClearIntactSourceText(candidate.document).includes(typeof record.normalized.text === 'string'
    ? record.normalized.text : record.searchText)) return false;
  const projected = projectStoredGamingEvidenceCandidates([record], { ...candidate.sourceContext, requireRequestCoverage: true }, hybridEvidenceLimits())[0]?.evidence;
  return projected?.text === chunk.text && (chunk.evidenceUnits ?? []).every(unit => projected.evidenceUnits
    ?.some(approved => gamingClearHash(approved) === gamingClearHash(unit)));
}

/** Defense in depth at both generation and citation return boundaries. */
export function assertGamingHybridEvidenceMembership(knowledge: GamingStoredKnowledgeContext,
  accepted: readonly GamingHybridAcceptedCandidate[], context: { actorKey: string; workflowId: string; now?: number }): void {
  const invalid = accepted.some(candidate => !validGamingHybridArtifact(candidate, context));
  const live = knowledge.sources.filter(source => source.origin === 'live');
  const missing = live.some(source => !accepted.some(candidate => candidate.candidateId === source.sourceId && candidate.publicUrl === source.url))
    || (knowledge.evidence ?? []).some(chunk => !knowledge.sources.some(source => source.sourceId === chunk.sourceId && source.url === chunk.publicUrl)
      || live.some(source => source.sourceId === chunk.sourceId) && !accepted.some(candidate => candidate.candidateId === chunk.sourceId
        && candidate.publicUrl === chunk.publicUrl && candidate.contentHash === chunk.revisionId
        && (chunk.recordId === `${candidate.candidateId}:verification` && candidate.freshness.currentness === 'current_index'
          || isGamingHybridChunkBound(chunk, candidate))));
  if (invalid || missing) throw Object.assign(new Error('Selected evidence does not belong to this valid workflow.'), { code: 'EVIDENCE_MEMBERSHIP_INVALID' });
}

/** Storage eligibility, actor permission, and consent are independent of answer sufficiency. */
export async function createApprovedGamingHybridIngestion(input: {
  candidates: readonly GamingHybridAcceptedCandidate[];
  storagePolicy: GamingHybridStoragePolicy;
  confirmed: boolean;
  idempotencyKey: string;
}, context: GamingSourceGatewayContext & { canStore: boolean; canAutoStore: boolean }) {
  const denied = (code: string, message: string) => ({ statusCode: 403, payload: { ok: false, error: { code, message } } });
  if (!context.canStore || input.storagePolicy === 'transient_only') return denied('GAMING_HYBRID_STORAGE_FORBIDDEN', 'Storage is not authorized for this request.');
  if (input.storagePolicy === 'ask_before_store' && !input.confirmed) return denied('GAMING_HYBRID_CONFIRMATION_REQUIRED', 'Confirm storage before requesting ingestion.');
  if (input.storagePolicy === 'auto_store_approved' && !context.canAutoStore) return denied('GAMING_HYBRID_AUTO_STORAGE_FORBIDDEN', 'Automatic storage requires configured standing permission.');
  if (input.candidates.length < 1 || input.candidates.length > 3) return denied('GAMING_HYBRID_CANDIDATE_LIMIT', 'Select one to three approved candidates.');
  for (const candidate of input.candidates) {
    if (candidate.actorScopeHash !== actorHash(context.actorKey) || candidate.expiresAt <= Date.now()
      || candidate.policyVersion !== GAMING_HYBRID_CANDIDATE_POLICY_VERSION
      || candidate.publicUrl !== candidate.document.publicUrl
      || !isResolvedGamingDocumentIdentityVerified(candidate.document, candidate.document.requestedUrl)
      || candidate.contentHash !== hashGamingApprovedDocument(candidate.document)
      || candidate.sourceAssessment?.rubricVersion !== GAMING_CLEAR_VERSION
      || candidate.sourceAssessment.subjectHash !== candidate.contentHash
      || candidate.assessmentBinding !== gamingClearHash({ sourceAssessment: candidate.sourceAssessment, sourceContext: candidate.sourceContext })
      || candidate.sourceMetadataBinding !== sourceMetadataBinding(candidate.freshness, candidate.sourcePolicy)) {
      return denied('GAMING_HYBRID_APPROVAL_INVALID', 'The source approval expired or does not belong to this caller.');
    }
    // Applicability can expire inside the artifact TTL; recheck every bound source
    // at the storage decision. Combined currentness may also close earlier uncertainty.
    const reassessed = assessGamingClearSource(candidate.sourceContext, candidate.document, { subjectId: candidate.candidateId,
      subjectHash: candidate.contentHash, actorScopeHash: candidate.actorScopeHash, sourcePolicy: candidate.sourcePolicy,
      freshness: candidate.freshness, now: new Date() });
    // Retain the same logical approval identity when revalidation changes only its
    // check time, so retrying an unchanged enqueue keeps existing idempotency.
    if (gamingClearHash({ ...reassessed, evaluatedAt: candidate.sourceAssessment.evaluatedAt }) !== gamingClearHash(candidate.sourceAssessment)) {
      candidate.sourceAssessment = reassessed;
      candidate.assessmentBinding = gamingClearHash({ sourceAssessment: reassessed, sourceContext: candidate.sourceContext });
    }
    if (!candidate.sourcePolicy.durableAllowed || !candidate.sourceAssessment.qualityEligible || candidate.document.metrics.truncated
      || (input.storagePolicy === 'auto_store_approved' && !candidate.sourcePolicy.autoStoreAllowed)) {
      return denied('GAMING_HYBRID_SOURCE_STORAGE_DISALLOWED', 'The selected source category does not qualify for this storage policy.');
    }
  }
  return createApprovedGamingSourceIngestion(input.candidates.map(candidate => ({
    url: candidate.document.requestedUrl, game: candidate.game, contentHash: candidate.contentHash,
    actorScopeHash: candidate.actorScopeHash, policyVersion: candidate.policyVersion,
    recordType: candidate.recordType,
    sourceTrustType: candidate.sourcePolicy.authority === 'official' ? 'official' as const
      : candidate.sourcePolicy.authority === 'specialist' ? 'curated' as const : 'supplied' as const,
    freshness: { ...candidate.freshness }, sourceAssessment: candidate.sourceAssessment,
    applicabilityContext: { game: candidate.sourceContext.game, mode: candidate.sourceContext.mode,
      classification: classifyGamingQuestionFreshness(candidate.sourceContext),
      seasonalPatchRequired: gamingSeasonalPatchRequired({ ...candidate.sourceContext, question: candidate.sourceContext.prompt }),
      historical: gamingClearHistoricalSourceVerified(candidate.sourceContext, candidate.freshness, new Date()),
      requestedVersion: candidate.sourceContext.requestedVersion, contextFingerprint: candidate.sourceAssessment.contextFingerprint,
      edition: candidate.sourceContext.edition, platform: candidate.sourceContext.platform, region: candidate.sourceContext.region }
  })), input.idempotencyKey, { ...context, canStore: true });
}

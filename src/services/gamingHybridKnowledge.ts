import { resolveGamingRequestEdition } from '@shared/gaming/gamingGameIdentity.js';
import { createHash, randomUUID } from 'node:crypto';
import { getEnvBoolean } from '@platform/runtime/env.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { redactString } from '@shared/redaction.js';
import { GAMING_HYBRID_CONTRACT_VERSION, GAMING_HYBRID_V2_CONTRACT_VERSION, GAMING_HYBRID_V2_LIMITS, gamingHybridLimitsForVersion, GAMING_HYBRID_LIMITS as LIMITS,
  gamingHybridQuerySchema, gamingHybridCandidatesSchema, gamingHybridIngestionSchema, gamingHybridRequestedContractVersion,
  type GamingHybridQuery, type GamingHybridResponse } from '@shared/gaming/gamingHybridContract.js';
import { resolveGamingPlayerContext, validateGamingPlayerContextInput } from '@shared/gaming/gamingPlayerContext.js';
import { buildGamingRetrievalTerms } from '@shared/gaming/gamingRetrievalPolicy.js';
import { assessGamingProgressionRequest } from '@shared/gaming/gamingProgressionPolicy.js';
import { buildGamingRecoveryResponse, resolveGamingGenerationFailureReason } from '@shared/gaming/gamingRecoveryResponse.js';
import { assessGamingSourcePolicy, classifyGamingQuestionFreshness, evaluateGamingFreshness, getGamingCurrentnessDiscoverySources, GAMING_FRESHNESS_DEFAULTS, type GamingFreshnessEvidence } from '@shared/gaming/gamingFreshnessCore.js';
import { combineGamingCurrentnessEvidence, GAMING_CURRENTNESS_ADAPTER_VERSION } from '@shared/gaming/gamingCurrentnessAdapters.js';
import { resolveGamingHybridCandidateAttempt, resolveGamingHybridCurrentnessReason, projectGamingHybridCandidateRetention,
  projectGamingHybridCandidateEvidence, normalizeGamingHybridCandidateUrl, gamingHybridRequiredGuideUrls, gamingHybridCitationTargets, projectGamingHybridSuppliedGuides } from '@shared/gaming/gamingHybridPolicyCore.js';
import { assessGamingClearEvidence } from '@shared/gaming/gamingClearEvidence.js';
import { GAMING_CLEAR_APPROVED_ANSWER, hasBoundGamingClearAnswer, type GamingClearAnswerCarrier } from '@shared/gaming/gamingClearAnswerBinding.js';
import { gamingClearHash } from '@shared/gaming/gamingClearPolicy.js';
import { resolveGamingFreshnessDisposition, selectGamingAdvisoryGameplayEvidence, isGamingAdvisoryCurrentnessOperation,
  gamingAnswerClaimsVerifiedCurrentness } from '@shared/gaming/gamingFreshnessDisposition.js';
import { buildStoredGamingKnowledgeContext, type GamingSourceGatewayContext } from './gamingSourceIngestion.js';
import { formatStoredGamingEvidence, type GamingStoredKnowledgeContext } from './gamingStoredKnowledge.js';
import type { runGameplayPipeline, GamingPipelineInput } from './gamingPipeline.js';
import { getGamingWebContextMaxChars } from './gamingConfig.js';
import { evaluateGamingHybridCandidates, createApprovedGamingHybridIngestion, selectGamingHybridEvidence,
  selectGamingHybridAcceptedEvidence, assertGamingHybridEvidenceMembership, type GamingHybridAcceptedCandidate } from './gamingHybridCandidates.js';

export interface GamingHybridCallContext extends GamingSourceGatewayContext { signal?: AbortSignal; canStore?: boolean; canAutoStore?: boolean }
export interface GamingHybridResult { status: number; body: GamingHybridResponse }
type Operation = { hash: string; promise: Promise<GamingHybridResult>; retryable?: boolean; generationTimedOutWithEvidence?: boolean };
type DiscoveryType = 'gameplay_evidence' | 'currentness_verification';
type CandidateSubmission = { key: string; knowledge: GamingStoredKnowledgeContext;
  decisions: GamingHybridResponse['candidates']; freshness: GamingFreshnessEvidence[]; currentnessFailureBlocksAdvisory?: boolean };
interface CurrentVerification {
  artifactHash: string;
  indexHash: string;
  evidence: GamingFreshnessEvidence;
  snippet: string;
  workflowId?: string;
  actorScopeHash?: string;
  contextHash?: string;
  policyVersion?: string;
  bindingHash?: string;
}
type Workflow = {
  id: string; actor: string; createdAt: number; input: GamingHybridQuery; pipeline: GamingPipelineInput;
  revision: number; closed?: boolean; activeOperationKey?: string;
  acquisitionWorkMs: number; submittedUrls: Set<string>;
  round: number; currentnessRound: number; accepted: GamingHybridAcceptedCandidate[]; operations: Map<string, Operation>;
  pendingDiscovery?: DiscoveryType;
  budgetKey: string;
  last?: GamingHybridResponse;
  knowledge?: GamingStoredKnowledgeContext;
  candidateOperationKey?: string;
  candidateSubmission?: CandidateSubmission;
  currentnessOperationKey?: string;
  currentnessSubmission?: CandidateSubmission;
  answer?: GamingHybridResponse['answer'];
  /** Earliest expiry of the actual applicability proof, not the workflow creation time. */
  evidenceExpiresAt?: number;
};
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalizedBudgetValue = (value: unknown): unknown => typeof value === 'string'
  ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
  : Array.isArray(value) ? value.map(normalizedBudgetValue) : value;
function queryBudgetKey(actor: string, input: GamingHybridQuery): string {
  return hash([actor, Object.entries(input).filter(([key]) => !['idempotencyKey', 'storagePolicy', 'version',
    'answerDepth', 'spoilerTolerance', 'mode'].includes(key))
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, normalizedBudgetValue(value)])]);
}

/** Dependency seams replace only external effects in deterministic integration tests. */
export interface GamingHybridDependencies {
  retrieve: typeof buildStoredGamingKnowledgeContext;
  evaluateCandidates: typeof evaluateGamingHybridCandidates;
  ingest: typeof createApprovedGamingHybridIngestion;
  generate: typeof runGameplayPipeline;
  now: () => number;
}

export function createGamingHybridWorkflow(overrides: Partial<GamingHybridDependencies> = {}) {
  const deps: GamingHybridDependencies = { retrieve: buildStoredGamingKnowledgeContext, evaluateCandidates: evaluateGamingHybridCandidates,
    ingest: createApprovedGamingHybridIngestion,
    generate: async (input, evidence) => (await import('./gamingPipeline.js')).runGameplayPipeline(input, evidence),
    now: Date.now, ...overrides };
  // Transient request context only. Jobs/revisions remain in the existing durable pipeline.
  // A restart or another replica misses safely; it never grants additional artifact access.
  const workflows = new Map<string, Workflow>();
  const queries = new Map<string, { workflowId: string; operation: Operation }>();
  const budgets = new Map<string, string>();
  const rates = new Map<string, { start: number; count: number }>();
  const expiredQueries = new Map<string, number>();
  function prune() {
    for (const [id, workflow] of workflows) {
      const freshnessClass = classifyGamingQuestionFreshness(workflow.pipeline);
      const ttl = Math.min(LIMITS.workflowTtlMs, GAMING_FRESHNESS_DEFAULTS[freshnessClass]);
      if (deps.now() - workflow.createdAt >= ttl) {
        if (workflow.input.contractVersion === GAMING_HYBRID_V2_CONTRACT_VERSION) {
          for (const [key, entry] of queries) if (entry.workflowId === id && expiredQueries.size < LIMITS.workflows)
            expiredQueries.set(key, deps.now() + LIMITS.workflowTtlMs);
        }
        workflows.delete(id);
      }
    }
    for (const [id, query] of queries) if (!workflows.has(query.workflowId)) queries.delete(id);
    for (const [key, id] of budgets) if (!workflows.has(id)) budgets.delete(key);
    for (const [key, expiresAt] of expiredQueries) if (deps.now() >= expiresAt) expiredQueries.delete(key);
    for (const [id, rate] of rates) if (deps.now() - rate.start >= LIMITS.rateWindowMs) rates.delete(id);
  }
  function base(context: GamingHybridCallContext, workflow?: Workflow, requestedContractVersion?: GamingHybridQuery['contractVersion']): GamingHybridResponse {
    const contractVersion = workflow?.input.contractVersion ?? requestedContractVersion ?? GAMING_HYBRID_CONTRACT_VERSION;
    const v2 = contractVersion === GAMING_HYBRID_V2_CONTRACT_VERSION;
    return { contractVersion,
      ...(v2 ? { revision: workflow?.revision ?? 0, selectedCandidateIds: [], selectedEvidenceIds: [],
        coverageSatisfied: false, missingCoverage: [], gapAssessmentStatus: 'not_assessed' as const, requirementSupport: [] } : {}), requestId: context.requestId ?? randomUUID(),
      ...(workflow ? { workflowId: workflow.id } : {}), state: 'temporarily_unavailable', nextAction: 'retry_later',
      reason: 'SERVICE_UNAVAILABLE', sourceKnown: false, evidenceSelected: false, freshnessStatus: 'unverified' };
  }
  function failure(context: GamingHybridCallContext, reason: string, status: number, workflow?: Workflow, requestedContractVersion?: GamingHybridQuery['contractVersion']): GamingHybridResult {
    return { status, body: { ...base(context, workflow, requestedContractVersion), reason, nextAction: status >= 500 || status === 429 ? 'retry_later' : 'stop' } };
  }
  function currentResponse(context: GamingHybridCallContext, workflow: Workflow, result: GamingHybridResult): GamingHybridResult {
    if (result.body.answer && workflow.evidenceExpiresAt !== undefined && deps.now() >= workflow.evidenceExpiresAt) {
      workflow.answer = undefined;
      const expired = failure(context, 'EVIDENCE_REVALIDATION_REQUIRED', 409, workflow);
      expired.body.sourceKnown = result.body.sourceKnown;
      return expired;
    }
    return result;
  }
  function admit(context: GamingHybridCallContext, requestedContractVersion?: GamingHybridQuery['contractVersion']): GamingHybridResult | undefined {
    prune();
    if (!context.actorKey) return failure(context, 'AUTHENTICATION_REQUIRED', 401, undefined, requestedContractVersion);
    const actor = hash(context.actorKey);
    const rate = rates.get(actor);
    if (rate && rate.count >= LIMITS.operationsPerActor) return failure(context, 'SUBMISSION_LIMIT_REACHED', 429, undefined, requestedContractVersion);
    if (!rate && rates.size >= LIMITS.workflows) return failure(context, 'SERVICE_CAPACITY_REACHED', 503, undefined, requestedContractVersion);
    rates.set(actor, { start: rate?.start ?? deps.now(), count: (rate?.count ?? 0) + 1 });
  }
  function own(id: string, context: GamingHybridCallContext): Workflow | undefined {
    const workflow = workflows.get(id);
    return workflow?.actor === hash(context.actorKey) ? workflow : undefined;
  }
  async function protect(context: GamingHybridCallContext, workflow: Workflow, work: () => Promise<GamingHybridResult>): Promise<GamingHybridResult> {
    try {
      context.signal?.throwIfAborted();
      const outcome = await work();
      if (workflow.input.contractVersion === GAMING_HYBRID_V2_CONTRACT_VERSION) context.signal?.throwIfAborted();
      const freshnessClass = classifyGamingQuestionFreshness(workflow.pipeline);
      const expired = deps.now() - workflow.createdAt >= Math.min(LIMITS.workflowTtlMs, GAMING_FRESHNESS_DEFAULTS[freshnessClass]);
      const result = currentResponse(context, workflow, expired && workflow.input.contractVersion === GAMING_HYBRID_V2_CONTRACT_VERSION
        ? failure(context, 'WORKFLOW_EXPIRED', 409, workflow) : outcome);
      if (workflow.input.contractVersion === GAMING_HYBRID_V2_CONTRACT_VERSION) {
        result.body.revision = workflow.revision;
        if (['answer', 'stop', 'clarify'].includes(result.body.nextAction)) workflow.closed = true;
      }
      workflow.last = result.body;
      if (result.body.answer) workflow.answer = result.body.answer;
      logger.info('gaming.hybrid.handoff', { requestId: result.body.requestId, workflowId: workflow.id,
        state: result.body.state, nextAction: result.body.nextAction, pendingDiscovery: workflow.pendingDiscovery,
        reason: result.body.reason, freshnessStatus: result.body.freshnessStatus,
        sourceKnown: result.body.sourceKnown, evidenceSelected: result.body.evidenceSelected, round: workflow.round,
        currentnessRound: workflow.currentnessRound, candidateCount: workflow.accepted.length,
        protocolVersion: workflow.input.contractVersion, revision: workflow.revision,
        selectedCandidateCount: result.body.selectedCandidateIds?.length, selectedEvidenceCount: result.body.selectedEvidenceIds?.length,
        coverageSatisfied: result.body.coverageSatisfied, recoveryRemaining: result.body.discovery?.recoveryRemaining,
        outcome: result.body.nextAction,
        acquisitionWorkMs: workflow.acquisitionWorkMs, submittedCandidateUrlCount: workflow.submittedUrls.size,
        elapsedMs: Math.max(0, deps.now() - workflow.createdAt) });
      return result;
    } catch (error) {
      if (workflow.input.contractVersion === GAMING_HYBRID_V2_CONTRACT_VERSION && context.signal?.aborted) {
        workflow.closed = true; workflow.pendingDiscovery = undefined;
        const cancelled = failure(context, 'REQUEST_CANCELLED', 409, workflow);
        workflow.last = cancelled.body;
        return cancelled;
      }
      if (workflow.input.contractVersion === GAMING_HYBRID_V2_CONTRACT_VERSION
        && typeof error === 'object' && error !== null && 'code' in error && error.code === 'EVIDENCE_MEMBERSHIP_INVALID') {
        workflow.closed = true; workflow.pendingDiscovery = undefined;
        const invalid = failure(context, 'EVIDENCE_MEMBERSHIP_INVALID', 409, workflow);
        workflow.last = invalid.body; return invalid;
      }
      // Deliberately no raw exception, question, URL, document, or model reasoning.
      const failed = failure(context, 'SERVICE_UNAVAILABLE', 503, workflow);
      if (workflow.answer) failed.body.answer = workflow.answer;
      return currentResponse(context, workflow, failed);
    }
  }
  function searchQueries(workflow: Workflow, type: DiscoveryType = 'gameplay_evidence',
    gaps: readonly string[] = [], gapAssessmentStatus?: GamingHybridResponse['gapAssessmentStatus']): string[] {
    const clean = (value: string) => redactString(value).replace(/https?:\/\/\S+|\S+@\S+|\b\d{7,}\b|\[[^\]]*REDACT[^\]]*\]/giu, ' ')
      .replace(/[^\p{L}\p{N} .:'-]/gu, ' ').replace(/\s+/gu, ' ').trim();
    const input = workflow.input;
    // Deliberately omit free-form constraints and unrelated conversation/player fields.
    const v2 = input.contractVersion === GAMING_HYBRID_V2_CONTRACT_VERSION;
    const scope = [input.game, input.edition, input.platform, ...(v2 ? [] : [input.region]), input.requestedVersion].filter(Boolean).map(value => clean(value!)).join(' ');
    if (type === 'currentness_verification') {
      const classification = classifyGamingQuestionFreshness(workflow.pipeline);
      return classification === 'live_status'
        ? [`${scope} official live server status`.slice(0, 350), `${scope} official current maintenance status`.slice(0, 350)]
        : classification === 'seasonal'
          ? [`${scope} official current season index`.slice(0, 350), `${scope} official season update patch build history`.slice(0, 350)]
          : [`${scope} official latest patch notes update index`.slice(0, 350), `${scope} official current patch build hotfix history`.slice(0, 350)];
    }
    const safeTopics = ['weapon', 'configuration', 'stats', 'allocation', 'armor', 'equipment', 'skills', 'abilities',
      'strategy', 'boss', 'quest', 'location', 'item', 'objective', 'resources', 'progression', 'build', 'rotation', 'upgrade', 'route'];
    const assessedFocus = gapAssessmentStatus === 'assessed' && gaps.length ? gaps.join(' ') : input.question;
    const focus = v2 ? safeTopics.filter(topic => new RegExp(`\\b${topic}s?\\b`, 'iu').test(assessedFocus)).join(' ')
      : clean(input.question).slice(0, 180);
    return [`${scope} ${focus}`.slice(0, 350), `${scope} gameplay guide ${focus}`.slice(0, 350)];
  }
  function discovery(context: GamingHybridCallContext, workflow: Workflow, body: GamingHybridResponse,
    hasGameplayEvidence = false): GamingHybridResult {
    const classification = classifyGamingQuestionFreshness(workflow.pipeline);
    const currentness = Boolean(resolveGamingHybridCurrentnessReason({ classification, freshnessStatus: body.freshnessStatus,
      hasGameplayEvidence, reasons: [body.reason] }));
    const v2 = workflow.input.contractVersion === GAMING_HYBRID_V2_CONTRACT_VERSION;
    const type: DiscoveryType = v2 && body.coverageSatisfied === false && !currentness ? 'gameplay_evidence'
      : currentness || workflow.currentnessRound > 0 ? 'currentness_verification' : 'gameplay_evidence';
    const round = type === 'currentness_verification' ? workflow.currentnessRound : workflow.round;
    const limits = gamingHybridLimitsForVersion(workflow.input.contractVersion);
    const maxRounds = type === 'currentness_verification' ? LIMITS.currentnessRounds : limits.discoveryRounds;
    const acquisitionRemaining = v2 ? Math.max(0, GAMING_HYBRID_V2_LIMITS.totalCandidateTimeoutMs - workflow.acquisitionWorkMs) : LIMITS.candidateTimeoutMs;
    const urlsRemaining = v2 ? Math.max(0, GAMING_HYBRID_V2_LIMITS.totalCandidateUrls - workflow.submittedUrls.size) : LIMITS.candidates;
    const blocked = v2 && (workflow.closed || body.coverageSatisfied === true && type === 'gameplay_evidence'
      || ['CONFLICTING_CURRENTNESS', 'CONTRADICTORY_EVIDENCE', 'APPLICABILITY_CONFLICT', 'SOURCE_USE_RESTRICTED',
        'STRUCTURAL_CONFLICT_ASSESSMENT_UNVERIFIED'].includes(body.reason));
    const permitted = !blocked && (type === 'currentness_verification' || acquisitionRemaining > 0 && urlsRemaining > 0) && round < maxRounds && (type === 'currentness_verification' ? currentness : v2 || workflow.currentnessRound === 0);
    workflow.pendingDiscovery = permitted ? type : undefined;
    if (permitted && currentness) logger.info('gaming.freshness.verification_requested', {
      requestId: context.requestId, workflowId: workflow.id, gameIdentityHash: hash(workflow.input.game),
      freshnessStatus: body.freshnessStatus, reasonCodes: [body.reason], policyVersion: GAMING_HYBRID_CONTRACT_VERSION,
      round, maxRounds, cacheStatus: body.reason === 'REVALIDATION_DUE' ? 'expired' : 'missing'
    });
    if (type === 'currentness_verification' && round >= maxRounds) logger.info('gaming.currentness.exhausted', {
      requestId: context.requestId, workflowId: workflow.id, round, maxRounds,
      freshnessStatus: body.freshnessStatus, reasonCodes: [body.reason]
    });
    const reviewedSources = type === 'currentness_verification'
      ? getGamingCurrentnessDiscoverySources(workflow.input.game, undefined, classification === 'live_status' ? 'live_status' : 'current_index')
      : undefined;
    return { status: 200, body: { ...body, state: 'discovery_required',
      nextAction: permitted ? type === 'currentness_verification' ? 'verify_currentness' : 'search' : 'stop',
      ...(currentness ? { gameplayEvidenceStatus: permitted ? 'currentness_pending' as const : 'unverified' as const,
        currentnessRequirements: classification === 'live_status' ? ['official_source_required', 'official_live_status_required'] as const
          : ['official_source_required', 'current_patch_or_build_required', 'hotfix_check_required_if_supported'] as const
      } : {}),
      discovery: { type, round, maxRounds, maxCandidates: LIMITS.candidates, searchQueries: searchQueries(workflow, type, body.missingCoverage, body.gapAssessmentStatus),
        continuationRequired: permitted,
        ...(v2 ? { replacementAllowed: permitted && type === 'gameplay_evidence' && round === 1,
          recoveryRemaining: permitted && type === 'gameplay_evidence' ? Math.max(0, limits.discoveryRounds - Math.max(1, round)) : 0,
          nextSubmissionCandidateLimit: permitted ? Math.min(LIMITS.candidates, type === 'currentness_verification' ? LIMITS.candidates : urlsRemaining) : 0,
          remainingTotalAcquisitionMs: acquisitionRemaining, remainingCandidateUrls: urlsRemaining } : {}), ...(reviewedSources?.length ? { reviewedSources } : {}) } } };
  }
  function candidateAcquisitionOutcome(result: GamingHybridResult, decisions: GamingHybridResponse['candidates']): GamingHybridResult {
    const acquisitionReasons = new Set(['INVALID_URL', 'URL_BLOCKED', 'REDIRECT_NOT_ALLOWED', 'SOURCE_FETCH_FAILED',
      'SOURCE_INACCESSIBLE', 'SOURCE_TIMEOUT', 'FETCH_BUDGET_EXHAUSTED', 'RESOLVED_SOURCE_IDENTITY_MISMATCH']);
    if (!result.body.answer && !result.body.evidenceSelected && decisions?.length
      && decisions.every(item => item.decision === 'rejected' && item.reasonCodes.every(reason => acquisitionReasons.has(reason)))) {
      result.body.reason = 'SOURCE_ACQUISITION_UNVERIFIED';
      result.body.qualification = 'The supplied sources could not be verified through backend acquisition. This does not establish that no public guide or location exists.';
    }
    if (!result.body.answer && !result.body.evidenceSelected && decisions?.length
      && decisions.every(item => item.decision === 'rejected')) {
      if (decisions.every(item => item.reasonCodes.includes('INSUFFICIENT_EXTRACTION'))) {
        result.body.reason = 'SOURCE_EXTRACTION_INSUFFICIENT';
        result.body.qualification = 'Could not extract intact usable evidence from the supplied sources. This does not establish that no public guide or location exists.';
      } else if (decisions.some(item => item.reasonCodes.includes('QUESTION_COVERAGE_INSUFFICIENT'))) {
        result.body.reason = 'QUESTION_COVERAGE_INSUFFICIENT';
        result.body.qualification = 'Extracted source content, but no supported record establishes the requested facts and their relationships.';
      }
    }
    return result;
  }
  async function answer(context: GamingHybridCallContext, workflow: Workflow, knowledge: GamingStoredKnowledgeContext,
    candidateFreshness: GamingFreshnessEvidence[] = [], acceptedCandidates: readonly GamingHybridAcceptedCandidate[] = workflow.accepted): Promise<GamingHybridResult> {
    const evaluationStartedAt = deps.now();
    const input = workflow.input;
    const v2 = input.contractVersion === GAMING_HYBRID_V2_CONTRACT_VERSION;
    if (v2) context.signal?.throwIfAborted();
    if (v2 && deps.now() - workflow.createdAt >= Math.min(LIMITS.workflowTtlMs,
      GAMING_FRESHNESS_DEFAULTS[classifyGamingQuestionFreshness(workflow.pipeline)]))
      return failure(context, 'WORKFLOW_EXPIRED', 409, workflow);
    for (const source of knowledge.sources) {
      const acquiredMetadata = candidateFreshness.find(item => item.id === source.sourceId && item.url === source.url);
      if (acquiredMetadata) source.freshnessMetadata = { ...acquiredMetadata };
    }
    if (v2) assertGamingHybridEvidenceMembership(knowledge, acceptedCandidates, { actorKey: context.actorKey, workflowId: workflow.id, now: deps.now() });
    const verificationContextHash = hash([workflow.actor, workflow.id, input.game, input.edition, input.platform, input.region,
      input.requestedVersion, GAMING_HYBRID_CONTRACT_VERSION]);
    const gameplayCandidates = acceptedCandidates.filter(item => !['current_index', 'live_status'].includes(item.freshness.currentness)
      && item.freshness.category !== 'official_updates' && item.freshness.category !== 'official_status');
    const gameplayIds = new Set(knowledge.sources.filter(source => {
      const metadata = candidateFreshness.find(item => item.url === source.url) ?? source.freshnessMetadata;
      return metadata?.currentness !== 'current_index' && metadata?.category !== 'official_updates' && metadata?.category !== 'official_status';
    }).map(source => source.sourceId));
    const hasGameplayEvidence = (knowledge.evidence ?? []).some(chunk => gameplayIds.has(chunk.sourceId));
    let body: GamingHybridResponse = { ...base(context, workflow), sourceKnown: knowledge.sourceKnown === true || knowledge.sources.length > 0 };
    if (assessGamingProgressionRequest(workflow.pipeline).clarificationNeeded) return { status: 200, body: { ...body,
      state: 'clarification_required', nextAction: 'clarify', reason: 'PROGRESS_POINT_REQUIRED',
      clarification: buildGamingRecoveryResponse({ ...workflow.pipeline, evidenceSelected: false, sourceKnown: body.sourceKnown }).slice(0, 1_000) } };
    const requiredSourceIds = acceptedCandidates.filter(candidate => (workflow.pipeline.guideUrls ?? []).some(url =>
      normalizeGamingHybridCandidateUrl(candidate.document.requestedUrl) === normalizeGamingHybridCandidateUrl(url))).map(candidate => candidate.candidateId);
    if (v2) {
      const genericBuildTerms = new Set(['give', 'make', 'recommend', 'suggest', 'provide', 'best', 'good', 'some', 'build', 'character']);
      if ((input.mode === 'build' || /\bbuild\b/iu.test(input.question)) && !input.class && !input.role && !input.constraints?.length
        && !buildGamingRetrievalTerms(workflow.pipeline).requestTerms.some(term => !genericBuildTerms.has(term)))
        return { status: 200, body: { ...body, state: 'clarification_required', nextAction: 'clarify',
          reason: 'BUILD_GOAL_REQUIRED', clarification: 'What playstyle or goal should this build support?' } };
      const requiredUrls = workflow.pipeline.guideUrls ?? [];
      if (requiredUrls.some(url => !acceptedCandidates.some(candidate => normalizeGamingHybridCandidateUrl(candidate.document.requestedUrl) === normalizeGamingHybridCandidateUrl(url)
        && knowledge.sources.some(source => source.sourceId === candidate.candidateId && source.url === candidate.publicUrl
          && (knowledge.evidence ?? []).some(chunk => chunk.sourceId === source.sourceId && chunk.text.trim())))))
        return discovery(context, workflow, { ...body, missingCoverage: ['required_supplied_guide'],
          gapAssessmentStatus: 'assessed', reason: 'REQUIRED_SUPPLIED_GUIDE_UNAVAILABLE' });
      const selection = selectGamingHybridEvidence({ ...workflow.pipeline, game: input.game }, knowledge, { requiredSourceIds });
      body = { ...body, selectedCandidateIds: selection.selectedCandidateIds, selectedEvidenceIds: selection.selectedEvidenceIds,
        coverageSatisfied: selection.coverageSatisfied, missingCoverage: selection.missingCoverage,
        gapAssessmentStatus: selection.gapAssessmentStatus, requirementSupport: selection.requirementSupport };
      if (selection.inspectionUnavailable) return discovery(context, workflow, { ...body, evidenceSelected: false,
        coverageSatisfied: false, reason: 'STRUCTURAL_CONFLICT_ASSESSMENT_UNVERIFIED' });
      if (selection.materialConflict) return discovery(context, workflow, { ...body, evidenceSelected: false,
        coverageSatisfied: false, reason: 'CONTRADICTORY_EVIDENCE' });
      if ('clarification' in selection && selection.clarification) return { status: 200, body: { ...body, state: 'clarification_required',
        nextAction: 'clarify', reason: 'REQUEST_CLARIFICATION_REQUIRED', clarification: selection.clarification } };
      if (!selection.coverageSatisfied) return discovery(context, workflow, { ...body,
        evidenceSelected: selection.selectedEvidenceIds.length > 0, reason: 'QUESTION_COVERAGE_INSUFFICIENT' });
    }
    const evidence: GamingFreshnessEvidence[] = knowledge.sources.map(source => {
      const candidate = candidateFreshness.find(item => item.url === source.url);
      const metadata = candidate ?? source.freshnessMetadata as unknown as GamingFreshnessEvidence | undefined;
      return { ...assessGamingSourcePolicy(source.url, input.game), ...(metadata ?? {}), id: source.sourceId,
        url: source.url, game: metadata?.game ?? input.game, fetchedAt: metadata?.fetchedAt ?? source.fetchedAt,
        ...(!metadata && classifyGamingQuestionFreshness({ prompt: input.question, mode: input.mode, requestedVersion: input.requestedVersion }) === 'stable'
          ? { verifiedAt: source.fetchedAt } : {}),
        metadataConfidence: metadata?.metadataConfidence ?? 'unknown' };
    });
    // Reuse only an internally persisted index attestation bound to this exact accepted artifact.
    // Its own checked time still expires under the ordinary freshness policy.
    for (const source of knowledge.sources) {
      const verification = source.freshnessMetadata?.currentVerification as CurrentVerification | undefined;
      // Durable cache readers preserve the creating workflow as proof provenance;
      // they do not pretend a new request created or refreshed that attestation.
      const originContextHash = verification && hash([workflow.actor, verification.workflowId, input.game,
        input.edition, input.platform, input.region, input.requestedVersion, GAMING_HYBRID_CONTRACT_VERSION]);
      if (verification && source.approvedContentHash === verification.artifactHash
        && typeof verification.workflowId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(verification.workflowId)
        && verification.actorScopeHash === workflow.actor && verification.contextHash === originContextHash
        && verification.policyVersion === GAMING_HYBRID_CONTRACT_VERSION
        && verification.bindingHash === gamingClearHash({ ...verification, bindingHash: undefined })
        && /^[a-f0-9]{64}$/u.test(verification.indexHash) && verification.snippet?.length <= 600
        && verification.evidence?.currentness === 'current_index'
        && (!verification.evidence.currentnessMetadata
          || verification.evidence.currentnessMetadata.adapterVersion === GAMING_CURRENTNESS_ADAPTER_VERSION)
        && assessGamingSourcePolicy(verification.evidence.url, input.game).ruleId === verification.evidence.ruleId) {
        if (!evidence.some(item => item.url === verification.evidence.url)) evidence.push(verification.evidence);
        if (!knowledge.sources.some(item => item.url === verification.evidence.url)) {
          const index = verification.evidence;
          knowledge.sources.push({ sourceId: index.id, url: index.url, sourceType: 'official_updates',
            fetchedAt: index.fetchedAt, snippet: verification.snippet, freshnessMetadata: { ...index } });
          knowledge.evidence ??= [];
          knowledge.evidence.push({ sourceId: index.id, revisionId: verification.indexHash, recordId: `${index.id}:verification`,
            recordType: 'guide', publicUrl: index.url, text: verification.snippet, lexicalScore: 1, combinedScore: 1,
            provenance: { fetchedAt: index.fetchedAt } });
        }
      }
    }
    // An official release index can corroborate applicability without matching the gameplay question.
    for (const item of candidateFreshness) if (!evidence.some(existing => existing.id === item.id && existing.url === item.url)) evidence.push(item);
    evidence.splice(0, evidence.length, ...combineGamingCurrentnessEvidence(evidence, new Date(deps.now())));
    const freshness = evaluateGamingFreshness({ question: input.question, game: input.game, mode: input.mode,
      requestedVersion: input.requestedVersion, edition: input.edition, platform: input.platform, region: input.region,
      evidence, now: new Date(deps.now()) });
    const disposition = resolveGamingFreshnessDisposition(workflow.pipeline);
    const advisory = disposition === 'ADVISORY' && !freshness.usable
      ? selectGamingAdvisoryGameplayEvidence({ game: input.game, freshness, evidence, now: new Date(deps.now()) }) : undefined;
    const advisoryAllowed = Boolean(advisory && !advisory.conflict
      && workflow.currentnessRound >= LIMITS.currentnessRounds
      && workflow.currentnessSubmission && !workflow.currentnessSubmission.currentnessFailureBlocksAdvisory
      && isGamingAdvisoryCurrentnessOperation({ decisions: workflow.currentnessSubmission.decisions ?? [] })
      && !freshness.reasons.some(reason => ['REQUESTED_PATCH_NOT_CURRENT', 'HISTORICAL_AS_OF_UNSUPPORTED',
        'EVIDENCE_LIMIT_EXCEEDED', 'INVALID_VERIFICATION_TIME'].includes(reason)));
    const selected = new Set(freshness.selectedEvidenceIds);
    if (advisory && !advisory.conflict) for (const id of advisory.selectedEvidenceIds) selected.add(id);
    if (freshness.usable) {
      const historical = Boolean(input.requestedVersion && /\b(?:as\s+of|historical|previous\s+patch|old\s+patch)\b/iu.test(input.question));
      const selectedProof = evidence.filter(item => selected.has(item.id));
      const timeProof = historical ? [] : selectedProof.filter(item => freshness.classification === 'stable'
        || freshness.classification === 'live_status' || item.currentness === 'current_index');
      const deadlines = timeProof.flatMap(item => [Date.parse(item.verifiedAt ?? '') + GAMING_FRESHNESS_DEFAULTS[freshness.classification],
        ...(freshness.classification === 'live_status' ? [Date.parse(item.sourceUpdatedAt ?? '') + GAMING_FRESHNESS_DEFAULTS.live_status] : [])]);
      if (!historical) deadlines.push(...selectedProof.flatMap(item => item.effectiveUntil ? [Date.parse(item.effectiveUntil)] : []));
      workflow.evidenceExpiresAt = Math.min(workflow.createdAt + LIMITS.workflowTtlMs, ...deadlines.filter(Number.isFinite));
    }
    if (freshness.usable) {
      const index = acceptedCandidates.find(item => item.freshness.currentness === 'current_index' && selected.has(item.candidateId));
      if (index) {
        const completedIndex = evidence.find(item => item.id === index.candidateId)!;
        const snippet = [
          'Backend-verified official release index; applicability verification only.',
          freshness.effectivePatch ? `Applicable patch: ${freshness.effectivePatch}.` : '',
          freshness.effectiveBuild ? `Applicable build: ${freshness.effectiveBuild}.` : '',
          freshness.season ? `Applicable season: ${freshness.season}.` : '',
          completedIndex.effectiveFrom ? `Effective from: ${completedIndex.effectiveFrom}.` : '',
          completedIndex.verifiedAt ? `Verified at: ${completedIndex.verifiedAt}.` : ''
        ].filter(Boolean).join(' ').slice(0, 600);
        for (const candidate of acceptedCandidates) if (selected.has(candidate.candidateId) && candidate !== index) {
          const verification: CurrentVerification = { artifactHash: candidate.contentHash, indexHash: index.contentHash,
            evidence: { ...completedIndex }, snippet, workflowId: workflow.id, actorScopeHash: workflow.actor,
            contextHash: verificationContextHash, policyVersion: GAMING_HYBRID_CONTRACT_VERSION };
          // JSONB may reorder every object's keys. Use the shared canonical hash
          // while preserving array order and every bound metadata value.
          verification.bindingHash = gamingClearHash(verification);
          Object.assign(candidate.freshness, { currentVerification: verification });
        }
        if (!knowledge.sources.some(source => source.sourceId === index.candidateId)) {
          knowledge.sources.push({ sourceId: index.candidateId, url: index.publicUrl, sourceType: 'official_updates',
            fetchedAt: completedIndex.fetchedAt, snippet, origin: 'live', freshnessMetadata: { ...completedIndex } });
          knowledge.evidence ??= [];
          knowledge.evidence.push({ sourceId: index.candidateId, revisionId: index.contentHash, recordId: `${index.candidateId}:verification`,
            recordType: 'guide', publicUrl: index.publicUrl, text: snippet, lexicalScore: 1, combinedScore: 1,
            provenance: { fetchedAt: index.freshness.fetchedAt } });
        }
      }
    }
    if (workflow.currentnessRound > 0) logger.info(freshness.status === 'conflicting'
      ? 'gaming.currentness.conflicting' : freshness.usable ? 'gaming.currentness.verified' : 'gaming.currentness.candidate_evaluated', {
      requestId: context.requestId, workflowId: workflow.id, gameIdentityHash: hash(input.game),
      ruleIds: evidence.filter(item => item.authority === 'official').flatMap(item => item.ruleId ? [item.ruleId] : []).slice(0, 3),
      adapterVersion: GAMING_CURRENTNESS_ADAPTER_VERSION, sourceRole: freshness.classification === 'live_status' ? 'live_status' : 'currentness_index',
      freshnessStatus: freshness.status,
      effectivePatchHash: freshness.effectivePatch ? hash(freshness.effectivePatch) : undefined,
      effectiveBuildHash: freshness.effectiveBuild ? hash(freshness.effectiveBuild) : undefined,
      reasonCodes: freshness.reasons.slice(0, 8), policyVersion: freshness.policyVersion, cacheStatus: 'workflow',
      elapsedMs: Math.max(0, deps.now() - evaluationStartedAt)
    });
    const candidates = (knowledge.evidence ?? []).flatMap(chunk => {
      const source = knowledge.sources.find(entry => entry.sourceId === chunk.sourceId);
      return source && selected.has(source.sourceId) ? [{ evidence: chunk, source }] : [];
    });
    const structuredReport = candidates.some(candidate => candidate.evidence.evidenceUnits?.length);
    const applicabilityUnverified = structuredReport && freshness.classification === 'stable'
      && !freshness.effectivePatch;
    const qualification = [advisory ? advisory.qualification : freshness.qualification,
      ...evidence.filter(item => selected.has(item.id)).slice(0, 3).flatMap(item => [
        !input.platform && item.platforms?.length && !item.platforms.some(value => value.toLowerCase() === 'all')
          ? `A cited guide reports platform scope ${JSON.stringify(item.platforms.slice(0, 2))}; applicability to other platforms was not independently verified.` : '',
        !input.region && item.regions?.length && !item.regions.some(value => value.toLowerCase() === 'all')
          ? `A cited guide reports region scope ${JSON.stringify(item.regions.slice(0, 2))}; applicability to other regions was not independently verified.` : '',
        item.metadataWarnings?.includes('PUBLICATION_DATE_UNVERIFIED')
          ? 'A cited guide reports an unusable publication or update date; that date was not used as freshness proof.' : ''
      ]),
      structuredReport ? 'Structured records are source reports. Preserve their qualifiers and attribution; they do not establish independent in-game observation.' : '',
      applicabilityUnverified ? 'Current in-game applicability is unverified. A recent source fetch verifies acquisition only.' : '',
      knowledge.sources.some(source => source.clearSourceAssessment?.findings.some(finding => finding.code === 'EXTRACTION_PARTIAL'))
        ? 'Some sources were only partially extracted. Use only the intact cited passages and state material coverage limits.' : '',
      freshness.verifiedAsOf ? `Last backend verification: ${freshness.verifiedAsOf}.` : '',
      freshness.effectivePatch ? `${advisory ? 'Official index reports update' : 'Applicable update'}: ${freshness.effectivePatch}.` : '',
      freshness.effectiveBuild ? `${advisory ? 'Official index reports hotfix/build' : 'Applicable hotfix/build'}: ${freshness.effectiveBuild}.` : '',
      freshness.season ? `${advisory ? 'Official index reports season' : 'Applicable season'}: ${freshness.season}.` : '',
      ...(advisory ? evidence.filter(item => selected.has(item.id)).slice(0, 3).map(item => [
        item.publishedAt ? `Guide publication date: ${item.publishedAt}.` : '',
        item.patch ? `Guide-reported patch: ${item.patch}.` : '', item.build ? `Guide-reported build: ${item.build}.` : ''
      ].filter(Boolean).join(' ')) : []),
      'Official changes establish announced mechanics, not the best strategy. Keep community recommendations distinct from official facts.'
    ].filter(Boolean).join(' ').slice(0, 1_000);
    const generationContextBudget = Math.max(0, getGamingWebContextMaxChars() - qualification.length - 2);
    let usable = formatStoredGamingEvidence(candidates, { spoilerMode: workflow.pipeline.spoilerMode,
      maxContextChars: generationContextBudget });
    if (v2 && candidates.length) {
      const requiredProofIds = evidence.filter(item => selected.has(item.id) && ['current_index', 'live_status'].includes(item.currentness)).map(item => item.id);
      const selection = selectGamingHybridEvidence({ ...workflow.pipeline, game: input.game,
        maxContextChars: generationContextBudget }, { ...knowledge, context: '',
        evidence: candidates.map(candidate => candidate.evidence), sources: knowledge.sources.filter(source => selected.has(source.sourceId)) },
        { requiredSourceIds: [...new Set([...requiredSourceIds, ...requiredProofIds])] });
      usable = selection.knowledge;
      body = { ...body, selectedCandidateIds: selection.selectedCandidateIds, selectedEvidenceIds: selection.selectedEvidenceIds,
        coverageSatisfied: selection.coverageSatisfied, missingCoverage: selection.missingCoverage,
        gapAssessmentStatus: selection.gapAssessmentStatus, requirementSupport: selection.requirementSupport };
      if (selection.inspectionUnavailable) return discovery(context, workflow, { ...body, evidenceSelected: false,
        coverageSatisfied: false, reason: 'STRUCTURAL_CONFLICT_ASSESSMENT_UNVERIFIED' });
      if (selection.materialConflict) return discovery(context, workflow, { ...body, evidenceSelected: false,
        coverageSatisfied: false, reason: 'CONTRADICTORY_EVIDENCE' });
      if (!selection.coverageSatisfied) return discovery(context, workflow, { ...body,
        evidenceSelected: selection.selectedEvidenceIds.length > 0, reason: 'QUESTION_COVERAGE_INSUFFICIENT' });
      assertGamingHybridEvidenceMembership(usable, acceptedCandidates, { actorKey: context.actorKey, workflowId: workflow.id, now: deps.now() });
    }
    // Keep the selected set's backend applicability facts beside its passages so
    // the final pipeline can independently bind and reassess the same evidence.
    for (const source of usable.sources) {
      const metadata = evidence.find(item => item.id === source.sourceId || item.url === source.url);
      if (metadata) {
        source.game = metadata.game;
        source.freshnessMetadata = { ...metadata };
        if (metadata.edition) source.edition = metadata.edition;
      }
    }
    const gameplaySelected = usable.evidence?.some(chunk => !chunk.recordId.endsWith(':verification')) === true;
    const guideStatuses = (freshness.guideApplicability ?? []).filter(item => gameplayIds.has(item.evidenceId));
    for (const guide of guideStatuses.slice(0, 8)) logger.info('gaming.guide.applicability_evaluated', {
      requestId: context.requestId, workflowId: workflow.id, gameIdentityHash: hash(input.game),
      sourceRole: input.mode === 'build' ? 'build_analysis' : 'gameplay_guide', evidenceIdHash: hash(guide.evidenceId),
      applicabilityStatus: guide.status, freshnessStatus: freshness.status, reasonCodes: guide.reasons.slice(0, 8),
      effectivePatchHash: guide.effectivePatch ? hash(guide.effectivePatch) : undefined,
      effectiveBuildHash: guide.effectiveBuild ? hash(guide.effectiveBuild) : undefined,
      policyVersion: freshness.policyVersion, adapterVersion: GAMING_CURRENTNESS_ADAPTER_VERSION,
      cacheStatus: 'workflow', elapsedMs: Math.max(0, deps.now() - evaluationStartedAt)
    });
    const evaluatedApplicabilityStatus: GamingHybridResponse['applicabilityStatus'] = freshness.status === 'conflicting'
      || guideStatuses.some(item => item.status === 'conflicting') ? 'conflicting'
      : guideStatuses.length && guideStatuses.every(item => item.status === 'verified_current') ? 'verified_current'
        : guideStatuses.some(item => item.status === 'verified_current' || item.status === 'partially_verified') ? 'partially_verified'
          : guideStatuses.some(item => item.status === 'stale') ? 'stale' : 'unverified';
    const applicabilityStatus = advisoryAllowed && evaluatedApplicabilityStatus === 'verified_current'
      ? 'partially_verified' : advisoryAllowed && advisory?.status === 'stale' ? 'stale' : evaluatedApplicabilityStatus;
    body = { ...body, evidenceSelected: (freshness.usable || advisoryAllowed) && gameplaySelected,
      freshnessStatus: advisory?.conflict ? 'conflicting' : advisoryAllowed ? advisory!.status
        : applicabilityUnverified ? 'unverified' : freshness.status,
      acceptedGameplayCandidateCount: gameplayCandidates.length,
      ...(freshness.classification !== 'stable' ? { applicabilityStatus,
        gameplayEvidenceStatus: freshness.usable && gameplaySelected ? 'freshness_verified' as const
          : applicabilityStatus === 'stale' ? 'stale' as const : hasGameplayEvidence ? 'accepted_transient' as const : 'unverified' as const } : {}),
      ...(freshness.verifiedAsOf && !applicabilityUnverified ? { verifiedAsOf: freshness.verifiedAsOf } : {}),
      ...(freshness.effectivePatch ? { effectivePatch: freshness.effectivePatch } : {}),
      ...(freshness.effectiveBuild ? { effectiveBuild: freshness.effectiveBuild } : {}), qualification };
    const currentnessReason = resolveGamingHybridCurrentnessReason({ classification: freshness.classification,
      freshnessStatus: freshness.status, hasGameplayEvidence, reasons: freshness.reasons });
    if (advisory?.conflict) return discovery(context, workflow, { ...body,
      evidenceSelected: false, applicabilityStatus: 'conflicting', reason: 'CONFLICTING_CURRENTNESS' }, hasGameplayEvidence);
    if ((!freshness.usable && !advisory) || !gameplaySelected) return discovery(context, workflow,
      { ...body, reason: !knowledge.evidence?.length ? 'COVERAGE_INSUFFICIENT'
        : currentnessReason ?? freshness.reasons[0] ?? 'CURRENT_APPLICABILITY_UNVERIFIED' }, hasGameplayEvidence);
    // Quality of individual documents is insufficient: judge the actual retained
    // set after freshness exclusions and the existing context/chunk budgets.
    const clearStartedAt = deps.now();
    const clearEvidenceAssessment = assessGamingClearEvidence({ ...workflow.pipeline, game: input.game }, usable, {
      freshness, freshnessEvidence: evidence.filter(item => selected.has(item.id)),
      identityVerified: true, actorScopeHash: workflow.actor, now: new Date(deps.now()), allowAdvisoryFreshness: Boolean(advisory), ...(v2 ? { requireRequestCoverage: true } : {})
    });
    logger.info('gaming.clear.evidence.completed', {
      requestId: context.requestId, workflowId: workflow.id,
      rubricVersion: clearEvidenceAssessment.rubricVersion, profile: clearEvidenceAssessment.profile,
      policyProfile: clearEvidenceAssessment.policyProfile, subjectHash: clearEvidenceAssessment.subjectHash,
      assessmentMethod: clearEvidenceAssessment.assessmentMethod, assessmentStatus: clearEvidenceAssessment.assessmentStatus,
      dimensionScores: Object.fromEntries(Object.entries(clearEvidenceAssessment.dimensionScores).map(([key, value]) => [key, value.score])),
      overall: clearEvidenceAssessment.overall, decision: clearEvidenceAssessment.decision,
      reasonCodes: clearEvidenceAssessment.findings.map(finding => finding.code), blockingFindingCount: clearEvidenceAssessment.blockingFindings.length,
      elapsedMs: deps.now() - clearStartedAt, budgetOutcome: 'within_existing_selection_budget'
    });
    if (clearEvidenceAssessment.decision !== 'accept') return discovery(context, workflow, {
      ...body, evidenceSelected: false, reason: clearEvidenceAssessment.blockingFindings[0]?.code ?? 'COVERAGE_INSUFFICIENT'
    });
    if (!freshness.usable && !advisoryAllowed) return discovery(context, workflow,
      { ...body, evidenceSelected: false, reason: currentnessReason ?? freshness.reasons[0] ?? 'CURRENT_APPLICABILITY_UNVERIFIED' }, hasGameplayEvidence);
    if (v2 && (workflow.pipeline.guideUrls ?? []).some(url => !acceptedCandidates.some(candidate =>
      normalizeGamingHybridCandidateUrl(candidate.document.requestedUrl) === normalizeGamingHybridCandidateUrl(url)
        && usable.sources.some(source => source.sourceId === candidate.candidateId && source.url === candidate.publicUrl)
        && usable.evidence?.some(chunk => chunk.sourceId === candidate.candidateId && chunk.text.trim()))))
      return discovery(context, workflow, { ...body, evidenceSelected: false, coverageSatisfied: false,
        missingCoverage: ['required_supplied_guide'], gapAssessmentStatus: 'assessed', reason: 'REQUIRED_SUPPLIED_GUIDE_NOT_SELECTED' });
    usable.clearEvidenceAssessment = clearEvidenceAssessment;
    const preparedKnowledge = { knowledge: { ...usable, sourceKnown: body.sourceKnown },
      current: freshness.usable, qualification, actorScopeHash: workflow.actor, advisoryFreshnessAllowed: advisoryAllowed,
      ...(v2 ? { requireRequestCoverage: true, suppliedGuides: projectGamingHybridSuppliedGuides({ requiredUrls: workflow.pipeline.guideUrls ?? [],
        accepted: acceptedCandidates, knowledge: usable, actorScopeHash: createHash('sha256').update(context.actorKey, 'utf8').digest('hex'),
        workflowId: workflow.id, now: deps.now() }) } : {}) };
    if (v2) context.signal?.throwIfAborted();
    if (v2 && deps.now() - workflow.createdAt >= Math.min(LIMITS.workflowTtlMs,
      GAMING_FRESHNESS_DEFAULTS[classifyGamingQuestionFreshness(workflow.pipeline)]))
      return failure(context, 'WORKFLOW_EXPIRED', 409, workflow);
    workflow.pendingDiscovery = undefined;
    const generated = await deps.generate(workflow.pipeline, preparedKnowledge);
    const response = !v2 && advisoryAllowed && !generated.data.response.includes(advisory!.qualification)
      ? `${advisory!.qualification}\n\n${generated.data.response}` : generated.data.response;
    if (generated.data.fallbackReason || generated.data.grounding?.groundingStatus !== 'grounded'
      || !generated.data.response.trim() || response.length > 18_000
      || advisoryAllowed && gamingAnswerClaimsVerifiedCurrentness(generated.data.response)) {
      const reason = generated.data.fallbackReason || !v2 ? resolveGamingGenerationFailureReason({
        fallbackReason: generated.data.fallbackReason, evidenceSelected: body.evidenceSelected
      }) : 'INVALID_GENERATED_ANSWER';
      return { status: 503, body: { ...body, ...(v2 ? { nextAction: 'stop' as const } : {}), reason } };
    }
    if (v2) {
      const finalPipelineEvidenceAssessment = assessGamingClearEvidence({ ...workflow.pipeline, game: input.game }, usable,
        { actorScopeHash: workflow.actor, allowAdvisoryFreshness: advisoryAllowed, requireRequestCoverage: true });
      const answerAssessment = (generated.data as typeof generated.data & GamingClearAnswerCarrier)[GAMING_CLEAR_APPROVED_ANSWER];
      const allowedRefs = new Set((usable.evidence ?? []).flatMap(chunk => [chunk.sourceId, chunk.revisionId, chunk.recordId]));
      const answerRefs = [...Object.values(answerAssessment?.dimensionScores ?? {}).flatMap(dimension => dimension.evidenceRefs),
        ...(answerAssessment?.findings ?? []).flatMap(finding => finding.evidenceRefs)];
      if (finalPipelineEvidenceAssessment.decision !== 'accept' || !hasBoundGamingClearAnswer(generated.data) || answerAssessment?.contextFingerprint !== finalPipelineEvidenceAssessment.contextFingerprint
        || answerRefs.some(ref => !allowedRefs.has(ref)))
        return { status: 503, body: { ...body, nextAction: 'stop', reason: 'INVALID_GENERATED_ANSWER' } };
      assertGamingHybridEvidenceMembership(usable, acceptedCandidates, { actorKey: context.actorKey, workflowId: workflow.id, now: deps.now() });
      if (gamingHybridCitationTargets(response).some(url => !usable.sources.some(source => source.url === url))
        || generated.data.sources.some(source => !usable.sources.some(selectedSource => source.url === selectedSource.url
        && (source.sourceId === undefined || source.sourceId === selectedSource.sourceId))))
        return { status: 503, body: { ...body, nextAction: 'stop', reason: 'INVALID_GENERATED_CITATIONS' } };
      if (qualification && !response.includes(qualification) && advisoryAllowed && !response.includes(advisory!.qualification))
        return { status: 503, body: { ...body, nextAction: 'stop', reason: 'REQUIRED_QUALIFICATION_MISSING' } };
    }
    workflow.pendingDiscovery = undefined;
    return { status: 200, body: { ...body, state: 'answer_ready', nextAction: 'answer', reason: 'ACCEPTED_EVIDENCE',
      answer: { response, sources: generated.data.sources.slice(0, 8).map(source => ({
        url: source.url, title: source.title, sourceId: source.sourceId, patchVersion: source.patchVersion, fetchedAt: source.fetchedAt })),
      provenance: 'arcanos-trinity', requestId: body.requestId } } };
  }
  function runOnce(workflow: Workflow, key: string, payload: unknown, context: GamingHybridCallContext,
    work: () => Promise<GamingHybridResult>): Promise<GamingHybridResult> {
    const digest = hash(payload);
    const existing = workflow.operations.get(key);
    if (existing?.hash !== undefined && existing.hash !== digest) return Promise.resolve(failure(context, 'IDEMPOTENCY_CONFLICT', 409, workflow));
    if (existing && !existing.retryable) return existing.promise.then(result => currentResponse(context, workflow, result));
    if (workflow.operations.size >= 6) return Promise.resolve(failure(context, 'SUBMISSION_LIMIT_REACHED', 429, workflow));
    const promise = Promise.resolve().then(() => protect(context, workflow, work)).then(result => {
      if (workflow.input.contractVersion !== GAMING_HYBRID_V2_CONTRACT_VERSION && (result.status >= 500 || result.status === 429)) {
        const operation = workflow.operations.get(key);
        if (operation) operation.retryable = true;
      }
      return result;
    });
    workflow.operations.set(key, { hash: digest, promise });
    return promise;
  }
  return {
    async query(payload: unknown, context: GamingHybridCallContext): Promise<GamingHybridResult> {
      const parsed = gamingHybridQuerySchema.safeParse(payload);
      const denied = admit(context, parsed.success ? parsed.data.contractVersion : gamingHybridRequestedContractVersion(payload)); if (denied) return denied;
      if (!parsed.success) return failure(context, 'INVALID_REQUEST', 400, undefined, gamingHybridRequestedContractVersion(payload));
      if (validateGamingPlayerContextInput(parsed.data)) return failure(context, 'INVALID_REQUEST', 400, undefined, parsed.data.contractVersion);
      const input = parsed.data;
      input.requestedVersion ??= input.version;
      if (input.version && input.requestedVersion !== input.version) return failure(context, 'VERSION_CONTEXT_CONFLICT', 400, undefined, input.contractVersion);
      const key = hash([context.actorKey, input.idempotencyKey]);
      if (input.contractVersion === GAMING_HYBRID_V2_CONTRACT_VERSION && expiredQueries.has(key))
        return failure(context, 'WORKFLOW_EXPIRED', 409, undefined, input.contractVersion);
      const prior = queries.get(key);
      if (prior) {
        if (prior.operation.hash !== hash(input)) return failure(context, 'IDEMPOTENCY_CONFLICT', 409, undefined, input.contractVersion);
        if (input.contractVersion === GAMING_HYBRID_V2_CONTRACT_VERSION || !prior.operation.retryable) return prior.operation.promise.then(result => {
          const workflow = workflows.get(prior.workflowId);
          return workflow ? currentResponse(context, workflow, { ...result, body: workflow.last ?? result.body }) : failure(context, 'WORKFLOW_UNAVAILABLE', 404, undefined, input.contractVersion);
        });
        const retained = workflows.get(prior.workflowId);
        if (retained?.knowledge && prior.operation.generationTimedOutWithEvidence) {
          // A client retry resumes this payload-bound generation operation. Reassess
          // the retained evidence under its original age/TTL before another attempt.
          const knowledge = retained.knowledge;
          const operation: Operation = { hash: prior.operation.hash, promise: Promise.resolve().then(() =>
            protect(context, retained, () => answer(context, retained, knowledge))).then(result => {
            if (result.status >= 500 || result.status === 429) {
              operation.retryable = true;
              operation.generationTimedOutWithEvidence = result.body.reason === 'PROVIDER_TIMEOUT_WITH_EVIDENCE';
            }
            return result;
          }) };
          prior.operation = operation;
          return operation.promise;
        }
        workflows.delete(prior.workflowId);
      }
      const actor = hash(context.actorKey);
      const budgetKey = queryBudgetKey(actor, input);
      const retainedId = budgets.get(budgetKey);
      const retained = retainedId ? workflows.get(retainedId) : undefined;
      if (retained) {
        const incomingContext = resolveGamingPlayerContext(input, input.question);
        // Shared acquisition budgets do not make answers interchangeable across
        // freshness modes or spoiler/depth preferences. Keep the original workflow
        // intact and withhold its answer when the effective request has changed.
        if (input.mode !== retained.pipeline.mode || incomingContext.spoilerMode !== retained.pipeline.spoilerMode
          || incomingContext.answerDepth !== retained.pipeline.answerDepth)
          return failure(context, 'QUERY_CONTEXT_CONFLICT', 409, retained);
        // A new key or a changed storage policy cannot create more search operations.
        // The original storage policy remains authoritative for this retained workflow.
        const operation = [...queries.values()].find(entry => entry.workflowId === retained.id)?.operation;
        if (operation) {
          const promise = retained.last?.ingestion ? protect(context, retained, async () => {
            retained.knowledge = await deps.retrieve({ ...retained.pipeline, game: retained.input.game,
              failOnUnavailable: true, hybridRetrieval: true, signal: context.signal });
            return answer(context, retained, retained.knowledge);
          }) : operation.promise.then(result => currentResponse(context, retained,
            { ...result, body: retained.last ?? result.body }));
          queries.set(key, { workflowId: retained.id, operation: { hash: hash(input), promise } });
          return promise;
        }
      }
      if (workflows.size >= LIMITS.workflows || [...workflows.values()].filter(item => item.actor === actor).length >= LIMITS.workflowsPerActor)
        return failure(context, 'WORKFLOW_CAPACITY_REACHED', 429, undefined, input.contractVersion);
      const workflow: Workflow = { id: randomUUID(), actor, budgetKey, createdAt: deps.now(), input,
        revision: 0, acquisitionWorkMs: 0, submittedUrls: new Set(),
        round: 0, currentnessRound: 0, accepted: [], operations: new Map(),
        pipeline: { ...resolveGamingPlayerContext(input, input.question), game: input.game, prompt: input.question,
          mode: input.mode, requestedVersion: input.requestedVersion, region: input.region, edition: resolveGamingRequestEdition(input),
          guideUrls: input.contractVersion === GAMING_HYBRID_V2_CONTRACT_VERSION ? gamingHybridRequiredGuideUrls(input.question) : [], auditEnabled: false } };
      workflows.set(workflow.id, workflow);
      budgets.set(budgetKey, workflow.id);
      const promise = protect(context, workflow, async () => {
        workflow.knowledge = await deps.retrieve({ ...workflow.pipeline, game: input.game, failOnUnavailable: true, hybridRetrieval: true, signal: context.signal });
        return answer(context, workflow, workflow.knowledge);
      }).then(result => {
        if (input.contractVersion !== GAMING_HYBRID_V2_CONTRACT_VERSION && (result.status >= 500 || result.status === 429)) {
          const entry = queries.get(key);
          if (entry) {
            entry.operation.retryable = true;
            entry.operation.generationTimedOutWithEvidence = result.body.reason === 'PROVIDER_TIMEOUT_WITH_EVIDENCE';
          }
        }
        return result;
      });
      queries.set(key, { workflowId: workflow.id, operation: { hash: hash(input), promise } });
      return promise;
    },
    async candidates(payload: unknown, context: GamingHybridCallContext): Promise<GamingHybridResult> {
      const parsed = gamingHybridCandidatesSchema.safeParse(payload);
      const denied = admit(context, parsed.success ? parsed.data.contractVersion : gamingHybridRequestedContractVersion(payload)); if (denied) return denied;
      if (!parsed.success) return failure(context, 'INVALID_REQUEST', 400, undefined, gamingHybridRequestedContractVersion(payload));
      const input = parsed.data;
      const workflow = own(input.workflowId, context);
      if (!workflow) return failure(context, 'WORKFLOW_UNAVAILABLE', 404, undefined, input.contractVersion);
      if (input.contractVersion !== workflow.input.contractVersion) return failure(context, 'PROTOCOL_VERSION_MISMATCH', 409, workflow);
      const v2 = input.contractVersion === GAMING_HYBRID_V2_CONTRACT_VERSION;
      const operationKey = `candidates:${input.idempotencyKey}`;
      const existing = workflow.operations.get(operationKey);
      if (v2 && !existing) {
        if (workflow.closed) return failure(context, 'WORKFLOW_CLOSED', 409, workflow);
        if (workflow.activeOperationKey) return failure(context, 'SUBMISSION_IN_PROGRESS', 409, workflow);
        if (input.expectedRevision !== workflow.revision) return failure(context, 'STALE_WORKFLOW_REVISION', 409, workflow);
      }
      const anticipatedDiscovery = input.discoveryType ?? workflow.pendingDiscovery;
      if (v2 && !existing && anticipatedDiscovery === 'gameplay_evidence') {
        const urls = input.candidates.map(candidate => normalizeGamingHybridCandidateUrl(candidate.url));
        if (urls.some(url => workflow.submittedUrls.has(url))) return failure(context, 'CANDIDATE_URL_ALREADY_SUBMITTED', 409, workflow);
        if (workflow.submittedUrls.size + new Set(urls).size > GAMING_HYBRID_V2_LIMITS.totalCandidateUrls
          || workflow.acquisitionWorkMs >= GAMING_HYBRID_V2_LIMITS.totalCandidateTimeoutMs)
          return failure(context, 'ACQUISITION_BUDGET_EXHAUSTED', 409, workflow);
      }
      const discoveryType: DiscoveryType = input.discoveryType
        ?? (workflow.currentnessOperationKey === input.idempotencyKey ? 'currentness_verification'
          : workflow.candidateOperationKey === input.idempotencyKey ? 'gameplay_evidence'
            : workflow.pendingDiscovery ?? 'gameplay_evidence');
      const reservedOperation = v2 && !existing;
      if (reservedOperation) workflow.activeOperationKey = operationKey;
      return runOnce(workflow, operationKey, input, context, async () => {
        const currentness = discoveryType === 'currentness_verification';
        const submission = currentness ? workflow.currentnessSubmission : workflow.candidateSubmission;
        if (submission?.key === input.idempotencyKey) {
          const result = await answer(context, workflow, submission.knowledge, submission.freshness);
          result.body.candidates = submission.decisions;
          return candidateAcquisitionOutcome(result, result.body.candidates);
        }
        const attempt = resolveGamingHybridCandidateAttempt({ operationKey: currentness ? workflow.currentnessOperationKey : workflow.candidateOperationKey,
          requestedKey: input.idempotencyKey, round: currentness ? workflow.currentnessRound : workflow.round,
          nextAction: workflow.pendingDiscovery === 'currentness_verification' ? 'verify_currentness'
            : workflow.pendingDiscovery === 'gameplay_evidence' ? 'search' : undefined,
          expectedAction: currentness ? 'verify_currentness' : 'search',
          maxRounds: currentness ? LIMITS.currentnessRounds : gamingHybridLimitsForVersion(workflow.input.contractVersion).discoveryRounds });
        if (attempt === 'deny') return failure(context, currentness ? 'CURRENTNESS_LIMIT_REACHED' : 'DISCOVERY_LIMIT_REACHED', 409, workflow);
        if (currentness && workflow.accepted.some(item => item.expiresAt <= deps.now()
          || item.workflowId !== undefined && item.workflowId !== workflow.id
          || item.actorScopeHash !== undefined && item.actorScopeHash !== createHash('sha256').update(context.actorKey, 'utf8').digest('hex')))
          return failure(context, 'EVIDENCE_REVALIDATION_REQUIRED', 409, workflow);
        if (v2 && attempt === 'begin') {
          if (!currentness) {
            const urls = input.candidates.map(candidate => normalizeGamingHybridCandidateUrl(candidate.url));
            if (urls.some(url => workflow.submittedUrls.has(url))) return failure(context, 'CANDIDATE_URL_ALREADY_SUBMITTED', 409, workflow);
            if (workflow.submittedUrls.size + new Set(urls).size > GAMING_HYBRID_V2_LIMITS.totalCandidateUrls
              || workflow.acquisitionWorkMs >= GAMING_HYBRID_V2_LIMITS.totalCandidateTimeoutMs)
              return failure(context, 'ACQUISITION_BUDGET_EXHAUSTED', 409, workflow);
            for (const url of urls) workflow.submittedUrls.add(url);
          }
          workflow.revision += 1;
          workflow.pendingDiscovery = undefined;
        }
        if (attempt === 'begin') {
          // Charge before yielding. A failed acquisition can resume only this payload-bound
          // operation; alternative submissions cannot spend another discovery round.
          if (currentness) {
            workflow.currentnessRound += 1; workflow.currentnessOperationKey = input.idempotencyKey;
            logger.info('gaming.currentness.operation_started', { requestId: context.requestId, workflowId: workflow.id,
              round: workflow.currentnessRound, maxRounds: LIMITS.currentnessRounds, candidateCount: input.candidates.length });
          }
          else { workflow.round += 1; workflow.candidateOperationKey = input.idempotencyKey; }
        }
        const acquisitionStartedAt = deps.now();
        const acquisitionAllowanceMs = v2 && !currentness ? Math.min(LIMITS.candidateTimeoutMs,
          Math.max(0, GAMING_HYBRID_V2_LIMITS.totalCandidateTimeoutMs - workflow.acquisitionWorkMs)) : LIMITS.candidateTimeoutMs;
        let evaluated: Awaited<ReturnType<typeof deps.evaluateCandidates>>;
        let chargedAcquisitionMs = 0;
        try {
          evaluated = await deps.evaluateCandidates({ ...workflow.pipeline, game: workflow.input.game,
            region: workflow.input.region, candidates: input.candidates, discoveryType,
            ...(v2 ? { protocolVersion: GAMING_HYBRID_V2_CONTRACT_VERSION } : {}) },
          { ...context, workflowId: workflow.id, ...(v2 ? { maxElapsedMs: acquisitionAllowanceMs } : {}) });
          chargedAcquisitionMs = Math.max(0, evaluated.acquisitionWorkMs ?? deps.now() - acquisitionStartedAt);
        } finally {
          if (v2 && !currentness) workflow.acquisitionWorkMs += Math.max(chargedAcquisitionMs, deps.now() - acquisitionStartedAt);
        }
        if (v2) context.signal?.throwIfAborted();
        evaluated.knowledge.sources.forEach(source => { source.origin = 'live'; });
        const retainedChars = [...workflows.values()].flatMap(item => item.accepted).reduce((total, item) => total + item.document.text.length, 0);
        const { retainArtifacts, decisions } = projectGamingHybridCandidateRetention({ retainedChars,
          candidateChars: evaluated.accepted.reduce((total, item) => total + item.document.text.length, 0), decisions: evaluated.decisions });
        if (retainArtifacts) workflow.accepted = [...workflow.accepted, ...evaluated.accepted];
        const artifacts = retainArtifacts ? workflow.accepted : [...workflow.accepted, ...evaluated.accepted];
        const prior = v2 ? workflow.currentnessSubmission?.knowledge ?? workflow.candidateSubmission?.knowledge ?? workflow.knowledge
          : currentness ? workflow.candidateSubmission?.knowledge ?? workflow.knowledge : workflow.knowledge;
        // Retain only bounded evidence/freshness for answer retries when full artifacts
        // do not fit. Their candidate IDs must never advertise a storage handle.
        const { knowledge: combined, freshness: candidateFreshness } = projectGamingHybridCandidateEvidence({
          prior, knowledge: evaluated.knowledge, acceptedFreshness: evaluated.accepted.map(item => item.freshness),
          priorFreshness: v2 ? workflow.currentnessSubmission?.freshness ?? workflow.candidateSubmission?.freshness
            : currentness ? workflow.candidateSubmission?.freshness : undefined,
          currentnessEvidence: evaluated.currentnessEvidence
        });
        if (v2) {
          const retained = selectGamingHybridAcceptedEvidence({ ...workflow.pipeline, game: workflow.input.game }, artifacts,
            { actorKey: context.actorKey, workflowId: workflow.id, now: deps.now() });
          // Re-select complete backend artifacts so incomplete accepted documents
          // remain available to complement recovery. Retention capacity never
          // bypasses full-pool conflict inspection for transient artifacts.
          combined.materialConflict ||= retained.materialConflict;
          combined.structuralConflictAssessmentUnavailable ||= retained.structuralConflictAssessmentUnavailable;
          const retainedSourceIds = new Set(retained.sources.map(source => source.sourceId));
          combined.sources = [...retained.sources, ...combined.sources.filter(source => !retainedSourceIds.has(source.sourceId))];
          combined.evidence = [...(retained.evidence ?? []), ...(combined.evidence ?? []).filter(chunk => !retainedSourceIds.has(chunk.sourceId))];
        }
        const nextSubmission = { key: input.idempotencyKey, knowledge: combined, decisions, freshness: candidateFreshness,
          ...(evaluated.currentnessFailureBlocksAdvisory ? { currentnessFailureBlocksAdvisory: true } : {}) };
        if (currentness) workflow.currentnessSubmission = nextSubmission;
        else workflow.candidateSubmission = nextSubmission;
        const result = await answer(context, workflow, combined, candidateFreshness, artifacts);
        result.body.candidates = decisions;
        if (v2 && !retainArtifacts && result.body.discovery && result.body.nextAction !== 'stop') {
          workflow.pendingDiscovery = undefined;
          result.body.nextAction = 'stop'; result.body.reason = 'ARTIFACT_CAPACITY_REACHED';
          result.body.discovery.continuationRequired = false; result.body.discovery.replacementAllowed = false;
          result.body.discovery.recoveryRemaining = 0; result.body.discovery.nextSubmissionCandidateLimit = 0;
        }
        if (v2 && result.body.discovery) {
          const failures = decisions.filter(decision => decision.url && decision.decision === 'rejected'
            && decision.reasonCodes.some(reason => ['SOURCE_INACCESSIBLE', 'SOURCE_FETCH_FAILED', 'SOURCE_TIMEOUT'].includes(reason)));
          result.body.discovery.acquisitionHints = failures.slice(0, 6).map(decision => ({ scope: 'url' as const,
            target: decision.url!, reasonCode: decision.reasonCodes[0], observedAt: new Date(deps.now()).toISOString(),
            expiresAt: new Date(workflow.createdAt + Math.min(LIMITS.workflowTtlMs,
              GAMING_FRESHNESS_DEFAULTS[classifyGamingQuestionFreshness(workflow.pipeline)])).toISOString() }));
        }
        return candidateAcquisitionOutcome(result, decisions);
      }).finally(() => { if (reservedOperation && workflow.activeOperationKey === operationKey) workflow.activeOperationKey = undefined; });
    },
    async ingest(payload: unknown, context: GamingHybridCallContext): Promise<GamingHybridResult> {
      const parsed = gamingHybridIngestionSchema.safeParse(payload);
      const denied = admit(context, parsed.success ? parsed.data.contractVersion : gamingHybridRequestedContractVersion(payload)); if (denied) return denied;
      if (!parsed.success) return failure(context, 'INVALID_REQUEST', 400, undefined, gamingHybridRequestedContractVersion(payload));
      const input = parsed.data;
      const workflow = own(input.workflowId, context);
      if (!workflow) return failure(context, 'WORKFLOW_UNAVAILABLE', 404, undefined, input.contractVersion);
      if (input.contractVersion !== workflow.input.contractVersion) return failure(context, 'PROTOCOL_VERSION_MISMATCH', 409, workflow);
      return runOnce(workflow, `ingest:${input.idempotencyKey}`, input, context, async () => {
        if (workflow.input.storagePolicy === 'transient_only' || input.storagePolicy === 'transient_only') return failure(context, 'STORAGE_POLICY_DENIED', 403, workflow);
        if (input.storagePolicy !== workflow.input.storagePolicy) return failure(context, 'STORAGE_POLICY_MISMATCH', 403, workflow);
        const candidates = workflow.accepted.filter(item => input.candidateIds.includes(item.candidateId));
        if (candidates.length !== new Set(input.candidateIds).size) return failure(context, 'CANDIDATE_UNAVAILABLE', 404, workflow);
        const result = await deps.ingest({ candidates, storagePolicy: input.storagePolicy, confirmed: input.confirmStore,
          idempotencyKey: input.idempotencyKey }, { ...context, canStore: context.canStore === true,
          canAutoStore: context.canAutoStore ?? getEnvBoolean('ARCANOS_GAMING_HYBRID_AUTO_STORE_APPROVED', false) });
        if (!result.payload.ok || !('ingestionId' in result.payload)) {
          const failed = failure(context, result.payload.error?.code ?? 'INGESTION_UNAVAILABLE', result.statusCode, workflow);
          failed.body = { ...(workflow.last ?? failed.body), ...failed.body, ...(workflow.answer ? { answer: workflow.answer, evidenceSelected: true } : {}) };
          return failed;
        }
        const ingestion = result.payload;
        const terminalFailure = ['failed', 'cancelled', 'expired'].includes(ingestion.status);
        const resultRequired = ['completed', 'completed_with_errors'].includes(ingestion.status);
        // A deduplicated submission can return an already terminal job. Only the
        // status result's per-source extraction outcomes establish saved knowledge.
        const state = terminalFailure || resultRequired
          ? workflow.answer ? 'answer_ready' : terminalFailure ? 'temporarily_unavailable' : 'ingestion_pending'
          : 'ingestion_pending';
        const nextAction = terminalFailure ? workflow.answer ? 'answer' : 'stop' : 'poll_ingestion';
        const reason = terminalFailure ? `INGESTION_${ingestion.status.toUpperCase()}`
          : resultRequired ? 'INGESTION_RESULT_REQUIRED'
            : ingestion.status === 'running' ? 'INGESTION_PROCESSING' : 'INGESTION_QUEUED';
        return { status: result.statusCode, body: { ...(workflow.last ?? base(context, workflow)), requestId: context.requestId ?? randomUUID(),
          ...(workflow.answer ? { answer: workflow.answer, evidenceSelected: true } : {}),
          state, nextAction, reason,
          ingestion: { ingestionId: ingestion.ingestionId, status: ingestion.status,
            statusUrl: `/gpt-access/gaming/sources/ingestions/${ingestion.ingestionId}`, maxPolls: LIMITS.polls } } };
      });
    }
  };
}

export const gamingHybridWorkflow = createGamingHybridWorkflow();

import { createHash, randomUUID } from 'node:crypto';
import { getEnvBoolean } from '@platform/runtime/env.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { redactString } from '@shared/redaction.js';
import { GAMING_HYBRID_CONTRACT_VERSION, GAMING_HYBRID_LIMITS as LIMITS,
  gamingHybridQuerySchema, gamingHybridCandidatesSchema, gamingHybridIngestionSchema,
  type GamingHybridQuery, type GamingHybridResponse } from '@shared/gaming/gamingHybridContract.js';
import { resolveGamingPlayerContext, validateGamingPlayerContextInput } from '@shared/gaming/gamingPlayerContext.js';
import { assessGamingProgressionRequest } from '@shared/gaming/gamingProgressionPolicy.js';
import { buildGamingRecoveryResponse } from '@shared/gaming/gamingRecoveryResponse.js';
import { assessGamingSourcePolicy, classifyGamingQuestionFreshness, evaluateGamingFreshness, getGamingCurrentnessDiscoverySources, GAMING_FRESHNESS_DEFAULTS, type GamingFreshnessEvidence } from '@shared/gaming/gamingFreshnessCore.js';
import { combineGamingCurrentnessEvidence, GAMING_CURRENTNESS_ADAPTER_VERSION } from '@shared/gaming/gamingCurrentnessAdapters.js';
import { resolveGamingHybridCandidateAttempt, resolveGamingHybridCurrentnessReason, projectGamingHybridCandidateRetention } from '@shared/gaming/gamingHybridPolicyCore.js';
import { assessGamingClearEvidence } from '@shared/gaming/gamingClearEvidence.js';
import { gamingClearHash } from '@shared/gaming/gamingClearPolicy.js';
import { buildStoredGamingKnowledgeContext, type GamingSourceGatewayContext } from './gamingSourceIngestion.js';
import { formatStoredGamingEvidence, type GamingStoredKnowledgeContext } from './gamingStoredKnowledge.js';
import type { runGameplayPipeline, GamingPipelineInput } from './gamingPipeline.js';
import { getGamingWebContextMaxChars } from './gamingConfig.js';
import { evaluateGamingHybridCandidates, createApprovedGamingHybridIngestion, type GamingHybridAcceptedCandidate } from './gamingHybridCandidates.js';

export interface GamingHybridCallContext extends GamingSourceGatewayContext { signal?: AbortSignal; canStore?: boolean; canAutoStore?: boolean }
export interface GamingHybridResult { status: number; body: GamingHybridResponse }
type Operation = { hash: string; promise: Promise<GamingHybridResult>; retryable?: boolean };
type DiscoveryType = 'gameplay_evidence' | 'currentness_verification';
type CandidateSubmission = { key: string; knowledge: GamingStoredKnowledgeContext;
  decisions: GamingHybridResponse['candidates']; freshness: GamingFreshnessEvidence[] };
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
  function prune() {
    for (const [id, workflow] of workflows) {
      const freshnessClass = classifyGamingQuestionFreshness(workflow.pipeline);
      const ttl = Math.min(LIMITS.workflowTtlMs, GAMING_FRESHNESS_DEFAULTS[freshnessClass]);
      if (deps.now() - workflow.createdAt >= ttl) workflows.delete(id);
    }
    for (const [id, query] of queries) if (!workflows.has(query.workflowId)) queries.delete(id);
    for (const [key, id] of budgets) if (!workflows.has(id)) budgets.delete(key);
    for (const [id, rate] of rates) if (deps.now() - rate.start >= LIMITS.rateWindowMs) rates.delete(id);
  }
  function base(context: GamingHybridCallContext, workflow?: Workflow): GamingHybridResponse {
    return { contractVersion: GAMING_HYBRID_CONTRACT_VERSION, requestId: context.requestId ?? randomUUID(),
      ...(workflow ? { workflowId: workflow.id } : {}), state: 'temporarily_unavailable', nextAction: 'retry_later',
      reason: 'SERVICE_UNAVAILABLE', sourceKnown: false, evidenceSelected: false, freshnessStatus: 'unverified' };
  }
  function failure(context: GamingHybridCallContext, reason: string, status: number, workflow?: Workflow): GamingHybridResult {
    return { status, body: { ...base(context, workflow), reason, nextAction: status >= 500 || status === 429 ? 'retry_later' : 'stop' } };
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
  function admit(context: GamingHybridCallContext): GamingHybridResult | undefined {
    prune();
    if (!context.actorKey) return failure(context, 'AUTHENTICATION_REQUIRED', 401);
    const actor = hash(context.actorKey);
    const rate = rates.get(actor);
    if (rate && rate.count >= LIMITS.operationsPerActor) return failure(context, 'SUBMISSION_LIMIT_REACHED', 429);
    if (!rate && rates.size >= LIMITS.workflows) return failure(context, 'SERVICE_CAPACITY_REACHED', 503);
    rates.set(actor, { start: rate?.start ?? deps.now(), count: (rate?.count ?? 0) + 1 });
  }
  function own(id: string, context: GamingHybridCallContext): Workflow | undefined {
    const workflow = workflows.get(id);
    return workflow?.actor === hash(context.actorKey) ? workflow : undefined;
  }
  async function protect(context: GamingHybridCallContext, workflow: Workflow, work: () => Promise<GamingHybridResult>): Promise<GamingHybridResult> {
    try {
      context.signal?.throwIfAborted();
      const result = currentResponse(context, workflow, await work());
      workflow.last = result.body;
      if (result.body.answer) workflow.answer = result.body.answer;
      logger.info('gaming.hybrid.handoff', { requestId: result.body.requestId, workflowId: workflow.id,
        state: result.body.state, nextAction: result.body.nextAction, pendingDiscovery: workflow.pendingDiscovery,
        reason: result.body.reason, freshnessStatus: result.body.freshnessStatus,
        sourceKnown: result.body.sourceKnown, evidenceSelected: result.body.evidenceSelected, round: workflow.round,
        currentnessRound: workflow.currentnessRound, candidateCount: workflow.accepted.length });
      return result;
    } catch {
      // Deliberately no raw exception, question, URL, document, or model reasoning.
      const failed = failure(context, 'SERVICE_UNAVAILABLE', 503, workflow);
      if (workflow.answer) failed.body.answer = workflow.answer;
      return currentResponse(context, workflow, failed);
    }
  }
  function searchQueries(workflow: Workflow, type: DiscoveryType = 'gameplay_evidence'): string[] {
    const clean = (value: string) => redactString(value).replace(/https?:\/\/\S+|\S+@\S+|\b\d{7,}\b|\[[^\]]*REDACT[^\]]*\]/giu, ' ')
      .replace(/[^\p{L}\p{N} .:'-]/gu, ' ').replace(/\s+/gu, ' ').trim();
    const input = workflow.input;
    // Deliberately omit free-form constraints and unrelated conversation/player fields.
    const scope = [input.game, input.edition, input.platform, input.region, input.requestedVersion].filter(Boolean).map(value => clean(value!)).join(' ');
    if (type === 'currentness_verification') {
      const classification = classifyGamingQuestionFreshness(workflow.pipeline);
      return classification === 'live_status'
        ? [`${scope} official live server status`.slice(0, 350), `${scope} official current maintenance status`.slice(0, 350)]
        : classification === 'seasonal'
          ? [`${scope} official current season index`.slice(0, 350), `${scope} official season update patch build history`.slice(0, 350)]
          : [`${scope} official latest patch notes update index`.slice(0, 350), `${scope} official current patch build hotfix history`.slice(0, 350)];
    }
    const focus = clean(input.question).slice(0, 180);
    return [`${scope} ${focus}`.slice(0, 350), `${scope} gameplay guide ${focus}`.slice(0, 350)];
  }
  function discovery(context: GamingHybridCallContext, workflow: Workflow, body: GamingHybridResponse,
    hasGameplayEvidence = false): GamingHybridResult {
    const classification = classifyGamingQuestionFreshness(workflow.pipeline);
    const currentness = Boolean(resolveGamingHybridCurrentnessReason({ classification, freshnessStatus: body.freshnessStatus,
      hasGameplayEvidence, reasons: [body.reason] }));
    const type: DiscoveryType = currentness || workflow.currentnessRound > 0 ? 'currentness_verification' : 'gameplay_evidence';
    const round = type === 'currentness_verification' ? workflow.currentnessRound : workflow.round;
    const maxRounds = type === 'currentness_verification' ? LIMITS.currentnessRounds : LIMITS.discoveryRounds;
    const permitted = round < maxRounds && (type === 'currentness_verification' ? currentness : workflow.currentnessRound === 0);
    workflow.pendingDiscovery = permitted ? type : undefined;
    if (permitted && currentness) logger.info('gaming.freshness.verification_requested', {
      requestId: context.requestId, workflowId: workflow.id, game: workflow.input.game.slice(0, 120),
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
      discovery: { type, round, maxRounds, maxCandidates: LIMITS.candidates, searchQueries: searchQueries(workflow, type),
        continuationRequired: permitted, ...(reviewedSources?.length ? { reviewedSources } : {}) } } };
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
    const selected = new Set(freshness.selectedEvidenceIds);
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
      requestId: context.requestId, workflowId: workflow.id, game: input.game.slice(0, 120),
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
    const qualification = [freshness.qualification,
      structuredReport ? 'Structured records are source reports. Preserve their qualifiers and attribution; they do not establish independent in-game observation.' : '',
      applicabilityUnverified ? 'Current in-game applicability is unverified. A recent source fetch verifies acquisition only.' : '',
      knowledge.sources.some(source => source.clearSourceAssessment?.findings.some(finding => finding.code === 'EXTRACTION_PARTIAL'))
        ? 'Some sources were only partially extracted. Use only the intact cited passages and state material coverage limits.' : '',
      freshness.verifiedAsOf ? `Last backend verification: ${freshness.verifiedAsOf}.` : '',
      freshness.effectivePatch ? `Applicable update: ${freshness.effectivePatch}.` : '',
      freshness.effectiveBuild ? `Applicable hotfix/build: ${freshness.effectiveBuild}.` : '',
      freshness.season ? `Applicable season: ${freshness.season}.` : '',
      'Official changes establish announced mechanics, not the best strategy. Keep community recommendations distinct from official facts.'
    ].filter(Boolean).join(' ').slice(0, 1_000);
    const usable = formatStoredGamingEvidence(candidates, { spoilerMode: workflow.pipeline.spoilerMode,
      maxContextChars: Math.max(0, getGamingWebContextMaxChars() - qualification.length - 2) });
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
      requestId: context.requestId, workflowId: workflow.id, game: input.game.slice(0, 120),
      sourceRole: input.mode === 'build' ? 'build_analysis' : 'gameplay_guide', evidenceIdHash: hash(guide.evidenceId),
      applicabilityStatus: guide.status, freshnessStatus: freshness.status, reasonCodes: guide.reasons.slice(0, 8),
      effectivePatchHash: guide.effectivePatch ? hash(guide.effectivePatch) : undefined,
      effectiveBuildHash: guide.effectiveBuild ? hash(guide.effectiveBuild) : undefined,
      policyVersion: freshness.policyVersion, adapterVersion: GAMING_CURRENTNESS_ADAPTER_VERSION,
      cacheStatus: 'workflow', elapsedMs: Math.max(0, deps.now() - evaluationStartedAt)
    });
    const applicabilityStatus: GamingHybridResponse['applicabilityStatus'] = freshness.status === 'conflicting'
      || guideStatuses.some(item => item.status === 'conflicting') ? 'conflicting'
      : guideStatuses.length && guideStatuses.every(item => item.status === 'verified_current') ? 'verified_current'
        : guideStatuses.some(item => item.status === 'verified_current' || item.status === 'partially_verified') ? 'partially_verified'
          : guideStatuses.some(item => item.status === 'stale') ? 'stale' : 'unverified';
    body = { ...body, evidenceSelected: gameplaySelected, freshnessStatus: applicabilityUnverified ? 'unverified' : freshness.status,
      acceptedGameplayCandidateCount: gameplayCandidates.length,
      ...(freshness.classification !== 'stable' ? { applicabilityStatus,
        gameplayEvidenceStatus: freshness.usable && gameplaySelected ? 'freshness_verified' as const
          : applicabilityStatus === 'stale' ? 'stale' as const : hasGameplayEvidence ? 'accepted_transient' as const : 'unverified' as const } : {}),
      ...(freshness.verifiedAsOf && !applicabilityUnverified ? { verifiedAsOf: freshness.verifiedAsOf } : {}),
      ...(freshness.effectivePatch ? { effectivePatch: freshness.effectivePatch } : {}),
      ...(freshness.effectiveBuild ? { effectiveBuild: freshness.effectiveBuild } : {}), qualification };
    const currentnessReason = resolveGamingHybridCurrentnessReason({ classification: freshness.classification,
      freshnessStatus: freshness.status, hasGameplayEvidence, reasons: freshness.reasons });
    if (!freshness.usable || !gameplaySelected) return discovery(context, workflow,
      { ...body, reason: !knowledge.evidence?.length ? 'COVERAGE_INSUFFICIENT'
        : currentnessReason ?? freshness.reasons[0] ?? 'CURRENT_APPLICABILITY_UNVERIFIED' }, hasGameplayEvidence);
    // Quality of individual documents is insufficient: judge the actual retained
    // set after freshness exclusions and the existing context/chunk budgets.
    const clearStartedAt = deps.now();
    const clearEvidenceAssessment = assessGamingClearEvidence({ ...workflow.pipeline, game: input.game }, usable, {
      freshness, freshnessEvidence: evidence.filter(item => selected.has(item.id)),
      identityVerified: true, actorScopeHash: workflow.actor, now: new Date(deps.now())
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
    usable.clearEvidenceAssessment = clearEvidenceAssessment;
    const preparedKnowledge = { knowledge: { ...usable, sourceKnown: body.sourceKnown },
      current: freshness.usable, qualification, actorScopeHash: workflow.actor };
    const generated = await deps.generate(workflow.pipeline, preparedKnowledge);
    if (generated.data.fallbackReason || generated.data.grounding?.groundingStatus !== 'grounded'
      || !generated.data.response.trim() || generated.data.response.length > 18_000) {
      return { status: 503, body: { ...body, reason: 'GENERATION_UNAVAILABLE' } };
    }
    workflow.pendingDiscovery = undefined;
    return { status: 200, body: { ...body, state: 'answer_ready', nextAction: 'answer', reason: 'ACCEPTED_EVIDENCE',
      answer: { response: generated.data.response, sources: generated.data.sources.slice(0, 8).map(source => ({
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
      if (result.status >= 500 || result.status === 429) {
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
      const denied = admit(context); if (denied) return denied;
      const parsed = gamingHybridQuerySchema.safeParse(payload);
      if (!parsed.success || validateGamingPlayerContextInput(parsed.data)) return failure(context, 'INVALID_REQUEST', 400);
      const input = parsed.data;
      input.requestedVersion ??= input.version;
      if (input.version && input.requestedVersion !== input.version) return failure(context, 'VERSION_CONTEXT_CONFLICT', 400);
      const key = hash([context.actorKey, input.idempotencyKey]);
      const prior = queries.get(key);
      if (prior) {
        if (prior.operation.hash !== hash(input)) return failure(context, 'IDEMPOTENCY_CONFLICT', 409);
        if (!prior.operation.retryable) return prior.operation.promise.then(result => {
          const workflow = workflows.get(prior.workflowId);
          return workflow ? currentResponse(context, workflow, { ...result, body: workflow.last ?? result.body }) : failure(context, 'WORKFLOW_UNAVAILABLE', 404);
        });
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
        return failure(context, 'WORKFLOW_CAPACITY_REACHED', 429);
      const workflow: Workflow = { id: randomUUID(), actor, budgetKey, createdAt: deps.now(), input,
        round: 0, currentnessRound: 0, accepted: [], operations: new Map(),
        pipeline: { ...resolveGamingPlayerContext(input, input.question), game: input.game, prompt: input.question,
          mode: input.mode, requestedVersion: input.requestedVersion, region: input.region, guideUrls: [], auditEnabled: false } };
      workflows.set(workflow.id, workflow);
      budgets.set(budgetKey, workflow.id);
      const promise = protect(context, workflow, async () => {
        workflow.knowledge = await deps.retrieve({ ...workflow.pipeline, game: input.game, failOnUnavailable: true, hybridRetrieval: true, signal: context.signal });
        return answer(context, workflow, workflow.knowledge);
      }).then(result => {
        if (result.status >= 500 || result.status === 429) {
          const entry = queries.get(key);
          if (entry) entry.operation.retryable = true;
        }
        return result;
      });
      queries.set(key, { workflowId: workflow.id, operation: { hash: hash(input), promise } });
      return promise;
    },
    async candidates(payload: unknown, context: GamingHybridCallContext): Promise<GamingHybridResult> {
      const denied = admit(context); if (denied) return denied;
      const parsed = gamingHybridCandidatesSchema.safeParse(payload);
      if (!parsed.success) return failure(context, 'INVALID_REQUEST', 400);
      const input = parsed.data;
      const workflow = own(input.workflowId, context);
      if (!workflow) return failure(context, 'WORKFLOW_UNAVAILABLE', 404);
      const discoveryType: DiscoveryType = input.discoveryType
        ?? (workflow.currentnessOperationKey === input.idempotencyKey ? 'currentness_verification'
          : workflow.candidateOperationKey === input.idempotencyKey ? 'gameplay_evidence'
            : workflow.pendingDiscovery ?? 'gameplay_evidence');
      return runOnce(workflow, `candidates:${input.idempotencyKey}`, input, context, async () => {
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
          maxRounds: currentness ? LIMITS.currentnessRounds : LIMITS.discoveryRounds });
        if (attempt === 'deny') return failure(context, currentness ? 'CURRENTNESS_LIMIT_REACHED' : 'DISCOVERY_LIMIT_REACHED', 409, workflow);
        if (currentness && workflow.accepted.some(item => item.expiresAt <= deps.now()
          || item.workflowId !== undefined && item.workflowId !== workflow.id
          || item.actorScopeHash !== undefined && item.actorScopeHash !== createHash('sha256').update(context.actorKey, 'utf8').digest('hex')))
          return failure(context, 'EVIDENCE_REVALIDATION_REQUIRED', 409, workflow);
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
        const evaluated = await deps.evaluateCandidates({ ...workflow.pipeline, game: workflow.input.game,
          region: workflow.input.region, candidates: input.candidates, discoveryType }, { ...context, workflowId: workflow.id });
        evaluated.knowledge.sources.forEach(source => { source.origin = 'live'; });
        const retainedChars = [...workflows.values()].flatMap(item => item.accepted).reduce((total, item) => total + item.document.text.length, 0);
        const { retainArtifacts, decisions } = projectGamingHybridCandidateRetention({ retainedChars,
          candidateChars: evaluated.accepted.reduce((total, item) => total + item.document.text.length, 0), decisions: evaluated.decisions });
        if (retainArtifacts) workflow.accepted = [...workflow.accepted, ...evaluated.accepted];
        const prior = currentness ? workflow.candidateSubmission?.knowledge ?? workflow.knowledge : workflow.knowledge;
        const combined = { context: '', sources: [...evaluated.knowledge.sources,
          ...(prior?.sources ?? []).filter(source => !evaluated.knowledge.sources.some(next => next.url === source.url))],
          evidence: [...(evaluated.knowledge.evidence ?? []),
            ...(prior?.evidence ?? []).filter(chunk => !evaluated.knowledge.sources.some(next => next.url === chunk.publicUrl))],
          sourceKnown: prior?.sourceKnown };
        // Retain only bounded evidence/freshness for answer retries when full artifacts
        // do not fit. Their candidate IDs must never advertise a storage handle.
        const candidateFreshness = [...(currentness ? workflow.candidateSubmission?.freshness ?? [] : []),
          ...evaluated.accepted.map(item => item.freshness), ...(evaluated.currentnessEvidence ?? [])];
        const nextSubmission = { key: input.idempotencyKey, knowledge: combined, decisions, freshness: candidateFreshness };
        if (currentness) workflow.currentnessSubmission = nextSubmission;
        else workflow.candidateSubmission = nextSubmission;
        const artifacts = retainArtifacts ? workflow.accepted : [...workflow.accepted, ...evaluated.accepted];
        const result = await answer(context, workflow, combined, candidateFreshness, artifacts);
        result.body.candidates = decisions;
        return candidateAcquisitionOutcome(result, decisions);
      });
    },
    async ingest(payload: unknown, context: GamingHybridCallContext): Promise<GamingHybridResult> {
      const denied = admit(context); if (denied) return denied;
      const parsed = gamingHybridIngestionSchema.safeParse(payload);
      if (!parsed.success) return failure(context, 'INVALID_REQUEST', 400);
      const input = parsed.data;
      const workflow = own(input.workflowId, context);
      if (!workflow) return failure(context, 'WORKFLOW_UNAVAILABLE', 404);
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

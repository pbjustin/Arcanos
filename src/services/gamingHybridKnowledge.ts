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
import { assessGamingSourcePolicy, classifyGamingQuestionFreshness, evaluateGamingFreshness, GAMING_FRESHNESS_DEFAULTS, type GamingFreshnessEvidence } from '@shared/gaming/gamingFreshnessCore.js';
import { resolveGamingHybridCandidateAttempt, projectGamingHybridCandidateRetention } from '@shared/gaming/gamingHybridPolicyCore.js';
import { assessGamingClearEvidence } from '@shared/gaming/gamingClearEvidence.js';
import { buildStoredGamingKnowledgeContext, type GamingSourceGatewayContext } from './gamingSourceIngestion.js';
import { formatStoredGamingEvidence, type GamingStoredKnowledgeContext } from './gamingStoredKnowledge.js';
import type { runGameplayPipeline, GamingPipelineInput } from './gamingPipeline.js';
import { getGamingWebContextMaxChars } from './gamingConfig.js';
import { evaluateGamingHybridCandidates, createApprovedGamingHybridIngestion, type GamingHybridAcceptedCandidate } from './gamingHybridCandidates.js';

export interface GamingHybridCallContext extends GamingSourceGatewayContext { signal?: AbortSignal; canStore?: boolean; canAutoStore?: boolean }
export interface GamingHybridResult { status: number; body: GamingHybridResponse }
type Operation = { hash: string; promise: Promise<GamingHybridResult>; retryable?: boolean };
interface CurrentVerification {
  artifactHash: string;
  indexHash: string;
  evidence: GamingFreshnessEvidence;
  snippet: string;
}
type Workflow = {
  id: string; actor: string; createdAt: number; input: GamingHybridQuery; pipeline: GamingPipelineInput;
  round: number; accepted: GamingHybridAcceptedCandidate[]; operations: Map<string, Operation>;
  last?: GamingHybridResponse;
  knowledge?: GamingStoredKnowledgeContext;
  candidateOperationKey?: string;
  candidateSubmission?: { key: string; knowledge: GamingStoredKnowledgeContext; decisions: GamingHybridResponse['candidates']; freshness: GamingFreshnessEvidence[] };
  answer?: GamingHybridResponse['answer'];
  /** Earliest expiry of the actual applicability proof, not the workflow creation time. */
  evidenceExpiresAt?: number;
};
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

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
  const rates = new Map<string, { start: number; count: number }>();
  function prune() {
    for (const [id, workflow] of workflows) {
      const freshnessClass = classifyGamingQuestionFreshness(workflow.pipeline);
      const ttl = Math.min(LIMITS.workflowTtlMs, GAMING_FRESHNESS_DEFAULTS[freshnessClass]);
      if (deps.now() - workflow.createdAt >= ttl) workflows.delete(id);
    }
    for (const [id, query] of queries) if (!workflows.has(query.workflowId)) queries.delete(id);
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
        state: result.body.state, reason: result.body.reason, freshnessStatus: result.body.freshnessStatus,
        sourceKnown: result.body.sourceKnown, evidenceSelected: result.body.evidenceSelected, round: workflow.round,
        candidateCount: workflow.accepted.length });
      return result;
    } catch {
      // Deliberately no raw exception, question, URL, document, or model reasoning.
      const failed = failure(context, 'SERVICE_UNAVAILABLE', 503, workflow);
      if (workflow.answer) failed.body.answer = workflow.answer;
      return currentResponse(context, workflow, failed);
    }
  }
  function searchQueries(workflow: Workflow): string[] {
    const clean = (value: string) => redactString(value).replace(/https?:\/\/\S+|\S+@\S+|\b\d{7,}\b|\[[^\]]*REDACT[^\]]*\]/giu, ' ')
      .replace(/[^\p{L}\p{N} .:'-]/gu, ' ').replace(/\s+/gu, ' ').trim();
    const input = workflow.input;
    // Deliberately omit free-form constraints and unrelated conversation/player fields.
    const scope = [input.game, input.edition, input.platform, input.region, input.requestedVersion].filter(Boolean).map(value => clean(value!)).join(' ');
    const focus = clean(input.question).slice(0, 180);
    return [`${scope} ${focus}`.slice(0, 350), `${scope} official latest patch hotfix release notes`.slice(0, 350)];
  }
  function discovery(context: GamingHybridCallContext, workflow: Workflow, body: GamingHybridResponse): GamingHybridResult {
    return { status: 200, body: { ...body, state: 'discovery_required', nextAction: workflow.round < LIMITS.discoveryRounds ? 'search' : 'stop',
      discovery: { round: workflow.round, maxRounds: LIMITS.discoveryRounds, maxCandidates: LIMITS.candidates, searchQueries: searchQueries(workflow) } } };
  }
  async function answer(context: GamingHybridCallContext, workflow: Workflow, knowledge: GamingStoredKnowledgeContext,
    candidateFreshness: GamingFreshnessEvidence[] = [], acceptedCandidates: readonly GamingHybridAcceptedCandidate[] = workflow.accepted): Promise<GamingHybridResult> {
    const input = workflow.input;
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
      if (verification && source.approvedContentHash === verification.artifactHash
        && /^[a-f0-9]{64}$/u.test(verification.indexHash) && verification.snippet?.length <= 600
        && verification.evidence?.currentness === 'current_index'
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
    for (const item of candidateFreshness) if (!evidence.some(existing => existing.url === item.url)) evidence.push(item);
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
        const snippet = [
          'Backend-verified official release index; applicability verification only.',
          freshness.effectivePatch ? `Applicable patch: ${freshness.effectivePatch}.` : '',
          freshness.effectiveBuild ? `Applicable build: ${freshness.effectiveBuild}.` : '',
          freshness.season ? `Applicable season: ${freshness.season}.` : '',
          index.freshness.effectiveFrom ? `Effective from: ${index.freshness.effectiveFrom}.` : '',
          index.freshness.verifiedAt ? `Verified at: ${index.freshness.verifiedAt}.` : ''
        ].filter(Boolean).join(' ').slice(0, 600);
        for (const candidate of acceptedCandidates) if (selected.has(candidate.candidateId) && candidate !== index) {
          Object.assign(candidate.freshness, { currentVerification: { artifactHash: candidate.contentHash,
            indexHash: index.contentHash, evidence: { ...index.freshness }, snippet } satisfies CurrentVerification });
        }
        if (!knowledge.sources.some(source => source.sourceId === index.candidateId)) {
          knowledge.sources.push({ sourceId: index.candidateId, url: index.publicUrl, sourceType: 'official_updates',
            fetchedAt: index.freshness.fetchedAt, snippet, origin: 'live' });
          knowledge.evidence ??= [];
          knowledge.evidence.push({ sourceId: index.candidateId, revisionId: index.contentHash, recordId: `${index.candidateId}:verification`,
            recordType: 'guide', publicUrl: index.publicUrl, text: snippet, lexicalScore: 1, combinedScore: 1,
            provenance: { fetchedAt: index.freshness.fetchedAt } });
        }
      }
    }
    const candidates = (knowledge.evidence ?? []).flatMap(chunk => {
      const source = knowledge.sources.find(entry => entry.sourceId === chunk.sourceId);
      return source && selected.has(source.sourceId) ? [{ evidence: chunk, source }] : [];
    });
    const qualification = [freshness.qualification,
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
    body = { ...body, evidenceSelected: gameplaySelected, freshnessStatus: freshness.status,
      ...(freshness.verifiedAsOf ? { verifiedAsOf: freshness.verifiedAsOf } : {}),
      ...(freshness.effectivePatch ? { effectivePatch: freshness.effectivePatch } : {}),
      ...(freshness.effectiveBuild ? { effectiveBuild: freshness.effectiveBuild } : {}), qualification };
    if (!freshness.usable || !gameplaySelected) return discovery(context, workflow,
      { ...body, reason: !knowledge.evidence?.length ? 'COVERAGE_INSUFFICIENT' : freshness.reasons[0] ?? 'CURRENT_APPLICABILITY_UNVERIFIED' });
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
          return workflow ? currentResponse(context, workflow, result) : failure(context, 'WORKFLOW_UNAVAILABLE', 404);
        });
        workflows.delete(prior.workflowId);
      }
      const actor = hash(context.actorKey);
      if (workflows.size >= LIMITS.workflows || [...workflows.values()].filter(item => item.actor === actor).length >= LIMITS.workflowsPerActor)
        return failure(context, 'WORKFLOW_CAPACITY_REACHED', 429);
      const workflow: Workflow = { id: randomUUID(), actor, createdAt: deps.now(), input, round: 0, accepted: [], operations: new Map(),
        pipeline: { ...resolveGamingPlayerContext(input, input.question), game: input.game, prompt: input.question,
          mode: input.mode, requestedVersion: input.requestedVersion, region: input.region, guideUrls: [], auditEnabled: false } };
      workflows.set(workflow.id, workflow);
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
      return runOnce(workflow, `candidates:${input.idempotencyKey}`, input, context, async () => {
        if (workflow.candidateSubmission?.key === input.idempotencyKey) {
          const result = await answer(context, workflow, workflow.candidateSubmission.knowledge, workflow.candidateSubmission.freshness);
          result.body.candidates = workflow.candidateSubmission.decisions;
          return result;
        }
        const attempt = resolveGamingHybridCandidateAttempt({ operationKey: workflow.candidateOperationKey,
          requestedKey: input.idempotencyKey, round: workflow.round, nextAction: workflow.last?.nextAction, maxRounds: LIMITS.discoveryRounds });
        if (attempt === 'deny') return failure(context, 'DISCOVERY_LIMIT_REACHED', 409, workflow);
        if (attempt === 'begin') {
          // Charge before yielding. A failed acquisition can resume only this payload-bound
          // operation; alternative submissions cannot spend another discovery round.
          workflow.round += 1;
          workflow.candidateOperationKey = input.idempotencyKey;
        }
        const evaluated = await deps.evaluateCandidates({ ...workflow.pipeline, game: workflow.input.game,
          region: workflow.input.region, candidates: input.candidates }, context);
        evaluated.knowledge.sources.forEach(source => { source.origin = 'live'; });
        const retainedChars = [...workflows.values()].flatMap(item => item.accepted).reduce((total, item) => total + item.document.text.length, 0);
        const { retainArtifacts, decisions } = projectGamingHybridCandidateRetention({ retainedChars,
          candidateChars: evaluated.accepted.reduce((total, item) => total + item.document.text.length, 0), decisions: evaluated.decisions });
        if (retainArtifacts) workflow.accepted = evaluated.accepted;
        const prior = workflow.knowledge;
        const combined = { context: '', sources: [...evaluated.knowledge.sources,
          ...(prior?.sources ?? []).filter(source => !evaluated.knowledge.sources.some(next => next.url === source.url))],
          evidence: [...(evaluated.knowledge.evidence ?? []),
            ...(prior?.evidence ?? []).filter(chunk => !evaluated.knowledge.sources.some(next => next.url === chunk.publicUrl))],
          sourceKnown: prior?.sourceKnown };
        // Retain only bounded evidence/freshness for answer retries when full artifacts
        // do not fit. Their candidate IDs must never advertise a storage handle.
        const candidateFreshness = evaluated.accepted.map(item => item.freshness);
        workflow.candidateSubmission = { key: input.idempotencyKey, knowledge: combined, decisions, freshness: candidateFreshness };
        const result = await answer(context, workflow, combined, candidateFreshness, evaluated.accepted);
        result.body.candidates = decisions;
        return result;
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

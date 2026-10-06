import { randomUUID } from 'node:crypto';
import { getRequestAbortSignal, getRequestRemainingMs } from '@arcanos/runtime';
import { createGamingHybridWorkflow, type GamingHybridResult } from './services/gamingHybridKnowledge.js';
import { evaluateGamingHybridCandidates } from './services/gamingHybridCandidates.js';
import { resolveGamingDocument } from './services/gamingDocumentResolution.js';
import type { GamingPipelineInput, GamingPipelineRuntime, GamingPreparedEvidence } from './services/gamingPipeline.js';
import type { GamingSuccessEnvelope } from './services/gamingModes.js';
import { gamingHybridQuerySchema, type GamingHybridQuery } from './shared/gaming/gamingHybridContract.js';
import { validateGamingPlayerContextInput } from './shared/gaming/gamingPlayerContext.js';
import { hasBoundGamingClearAnswer } from './shared/gaming/gamingClearAnswerBinding.js';
import { gamingClearHash, type GamingClearAssessment } from './shared/gaming/gamingClearPolicy.js';
import { createLiveValidationObservation, emptyLiveValidationStages, liveValidationDuration,
  type LiveValidationObservation, type LiveValidationStageEvent, type LiveValidationClarification } from './shared/gaming/liveValidationObservation.js';
import type { LivePreviewEvidenceInput } from '../scripts/live-pr-preview-verifier.mjs';
import type { LivePreviewFailureCode } from '../scripts/live-pr-preview-verifier.mjs';

export type LivePrPreviewAudit = NonNullable<LivePreviewEvidenceInput['audit']>;
export interface LivePrPreviewModuleObserver {
  onSourceAcquisition(status: 'passed' | 'failed'): void;
  onSourceValidation(status: 'passed' | 'rejected'): void;
  onAnswerAuditStart(): void;
  onAudit(audit: LivePrPreviewAudit): void;
  onFailure(code: LivePreviewFailureCode): void;
}
export interface LivePrPreviewModuleResult {
  result?: unknown;
  accepted: boolean;
  audit?: LivePrPreviewAudit;
  failureCode?: LivePreviewFailureCode;
}
export interface LivePrPreviewModuleAdapter {
  moduleId: string;
  validateInput(value: unknown): { ok: true; input: unknown } | { ok: false };
  execute(input: unknown, observer: LivePrPreviewModuleObserver): Promise<LivePrPreviewModuleResult>;
}

const clarificationFields = ['platform', 'region', 'edition', 'currentArea', 'lastCompletedObjective', 'progressPoint',
  'class', 'role', 'constraints'] as const;
export type LiveValidationGamingClarificationReply = Partial<Pick<GamingHybridQuery, typeof clarificationFields[number]>>;
export interface LiveValidationGamingInput {
  query: GamingHybridQuery;
  candidateUrls: string[];
  clarificationReplies?: LiveValidationGamingClarificationReply[];
}
export type LiveValidationGamingHooks = Pick<GamingPipelineRuntime,
  'onEvidenceAssessment' | 'onAnswerAuditStart' | 'onAnswerAudit'> & { onStage: (event: LiveValidationStageEvent) => void };
export type LiveValidationGamingExecutor = (input: GamingPipelineInput, prepared: GamingPreparedEvidence,
  hooks: LiveValidationGamingHooks) => Promise<GamingSuccessEnvelope>;
export interface LiveValidationGamingAdapter extends LivePrPreviewModuleAdapter {
  getLastObservation(): LiveValidationObservation | undefined;
}
const sourceFailureCodes = new Set(['SOURCE_FETCH_FAILED', 'SOURCE_TIMEOUT', 'SOURCE_EXTRACTION_FAILED', 'SOURCE_INACCESSIBLE',
  'REDIRECT_NOT_ALLOWED', 'SOURCE_TOO_LARGE', 'URL_BLOCKED',
  'RESOLVED_SOURCE_IDENTITY_MISMATCH', 'FETCH_BUDGET_EXHAUSTED', 'INVALID_URL', 'UNSUPPORTED_SOURCE_FORMAT',
  'UNTRUSTED_METADATA_INVALID', 'REVIEWED_OFFICIAL_CURRENTNESS_SOURCE_REQUIRED', 'DUPLICATE_URL']);

/** The isolated validation service calls the real v2 workflow with transient dependencies. */
export function createLiveValidationGamingAdapter(execute: LiveValidationGamingExecutor,
  options: { now?: () => number; sourceGuard?: (url: string) => void } = {}): LiveValidationGamingAdapter {
  const now = options.now ?? Date.now;
  let lastObservation: LiveValidationObservation | undefined;
  return {
    moduleId: 'gaming',
    getLastObservation: () => lastObservation ? structuredClone(lastObservation) : undefined,
    validateInput(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
      const record = value as Record<string, unknown>;
      if (Object.keys(record).some(key => !['query', 'candidateUrls', 'clarificationReplies'].includes(key))) return { ok: false };
      const parsed = gamingHybridQuerySchema.safeParse(record.query);
      if (!parsed.success || parsed.data.contractVersion !== 'gaming-hybrid-v2'
        || parsed.data.workflowId !== undefined || parsed.data.expectedRevision !== undefined
        || validateGamingPlayerContextInput(parsed.data)
        || parsed.data.storagePolicy !== 'transient_only' || !Array.isArray(record.candidateUrls)
        || record.candidateUrls.length > 3 || new Set(record.candidateUrls).size !== record.candidateUrls.length
        || record.candidateUrls.some(value => {
          if (typeof value !== 'string' || value.length > 2_048) return true;
          try { const url = new URL(value); return url.protocol !== 'https:' || Boolean(url.username || url.password); } catch { return true; }
        })) return { ok: false };
      const replies: LiveValidationGamingClarificationReply[] = [];
      let refined = parsed.data;
      if (record.clarificationReplies !== undefined) {
        if (!Array.isArray(record.clarificationReplies) || record.clarificationReplies.length > 8) return { ok: false };
        for (const reply of record.clarificationReplies) {
          if (!reply || typeof reply !== 'object' || Array.isArray(reply) || !Object.keys(reply).length
            || Object.keys(reply).some(key => !clarificationFields.includes(key as typeof clarificationFields[number]))) return { ok: false };
          const updated = { ...refined, ...reply };
          const validated = gamingHybridQuerySchema.safeParse(updated);
          if (!validated.success || validated.data.contractVersion !== 'gaming-hybrid-v2'
            || validateGamingPlayerContextInput(updated)) return { ok: false };
          replies.push(Object.fromEntries(Object.keys(reply).map(key => [key, validated.data[key as typeof clarificationFields[number]]])));
          refined = validated.data;
        }
      }
      return { ok: true, input: { query: parsed.data, candidateUrls: [...record.candidateUrls],
        ...(record.clarificationReplies !== undefined ? { clarificationReplies: replies } : {}) } as LiveValidationGamingInput };
    },
    async execute(value, observer) {
      const input = value as LiveValidationGamingInput;
      lastObservation = undefined;
      const stages = emptyLiveValidationStages();
      const auditStartBudget: LiveValidationObservation['auditStartBudget'] = { runtimeRemainingMs: null, requestRemainingMs: null };
      const started = new Map<string, number>();
      const onStage = (event: LiveValidationStageEvent) => {
        if (!Object.hasOwn(stages, event.stage)) return;
        if (event.phase === 'started') {
          started.set(event.stage, now()); stages[event.stage] = { status: 'started', elapsedMs: null };
          if (event.stage === 'answer_audit') {
            auditStartBudget.runtimeRemainingMs = liveValidationDuration(event.remainingBudgetMs);
            auditStartBudget.requestRemainingMs = liveValidationDuration(event.requestRemainingMs);
          }
        } else {
          stages[event.stage] = { status: event.phase === 'completed' ? 'passed' : event.timedOut ? 'timed_out' : 'failed',
            elapsedMs: liveValidationDuration(event.elapsedMs) ?? (started.has(event.stage) ? Math.max(0, now() - started.get(event.stage)!) : null) };
          if (event.phase === 'failed' && event.timedOut && ['intake', 'reasoning', 'final'].includes(event.stage)) {
            fail('MODEL_TIMEOUT');
            onStage({ stage: 'generation', phase: 'failed', timedOut: true });
          }
        }
      };
      let result: GamingSuccessEnvelope | undefined;
      let evidenceAssessment: GamingClearAssessment | undefined;
      let answerAssessment: GamingClearAssessment | undefined;
      let final: GamingHybridResult | undefined;
      let failureCode: LivePreviewFailureCode | undefined;
      let acquired = false;
      const clarification: LiveValidationClarification = { version: 1, submittedCount: 0, completedCount: 0,
        postAcquisitionCount: 0, sameWorkflow: false, revisionsAdvanced: false, retainedEvidence: false,
        budgetsPreserved: false, acquisitionCount: 0 };
      let sameWorkflow = true;
      let revisionsAdvanced = true;
      let retainedEvidence = true;
      let budgetsPreserved = true;
      const fail = (code: LivePreviewFailureCode) => { failureCode = code; observer.onFailure(code); };
      const scope = randomUUID();
      const context = { actorKey: 'live-validation:' + scope, requestId: 'live-validation:' + scope,
        signal: getRequestAbortSignal(), canStore: false, canAutoStore: false };
      const workflow = createGamingHybridWorkflow({ now,
        retrieve: async () => ({ context: '', sources: [], evidence: [], sourceKnown: false }),
        ingest: async () => { throw new Error('LIVE_VALIDATION_STORAGE_DENIED'); },
        evaluateCandidates: async (submission, actorContext) => {
          clarification.acquisitionCount += 1;
          onStage({ stage: 'acquisition', phase: 'started' });
          try {
            const evaluation = await evaluateGamingHybridCandidates(submission, actorContext, {
              resolveDocument: (url, maxChars, fetchOptions) => resolveGamingDocument(url, maxChars,
                { ...fetchOptions, onRequestUrl: options.sourceGuard })
            });
            const codes = evaluation.decisions.flatMap(decision => decision.reasonCodes);
            acquired = evaluation.accepted.length > 0 || evaluation.decisions.some(decision =>
              !decision.reasonCodes.every(code => sourceFailureCodes.has(code)));
            observer.onSourceAcquisition(acquired ? 'passed' : 'failed');
            const incompatible = codes.some(code => ['GAME_MISMATCH', 'EDITION_CONFLICT', 'PATCH_MISMATCH', 'APPLICABILITY_CONFLICT'].includes(code));
            const usable = evaluation.accepted.length > 0;
            observer.onSourceValidation(usable && !incompatible ? 'passed' : 'rejected');
            if (incompatible) fail('INCOMPATIBLE_SOURCE');
            else if (!usable) fail(acquired ? 'INSUFFICIENT_EVIDENCE' : 'ACQUISITION_FAILURE');
            onStage({ stage: 'acquisition', phase: acquired ? 'completed' : 'failed',
              ...(!acquired && codes.includes('SOURCE_TIMEOUT') ? { timedOut: true } : {}) });
            return evaluation;
          } catch (error) {
            observer.onSourceAcquisition('failed'); fail('ACQUISITION_FAILURE');
            onStage({ stage: 'acquisition', phase: 'failed', timedOut: context.signal?.aborted });
            throw error;
          }
        },
        generate: async (params, prepared) => {
          if (!prepared) throw new Error('LIVE_VALIDATION_PREPARED_EVIDENCE_REQUIRED');
          onStage({ stage: 'generation', phase: 'started' });
          try {
            result = await execute(params, prepared, {
            onStage,
            onEvidenceAssessment: assessment => {
              evidenceAssessment = structuredClone(assessment);
              observer.onSourceValidation(assessment.decision === 'accept' ? 'passed' : 'rejected');
              if (assessment.decision !== 'accept') fail('INSUFFICIENT_EVIDENCE');
            },
            onAnswerAuditStart: () => {
              onStage({ stage: 'generation', phase: 'completed' });
              // More precise runtime-budget metadata, when supplied, comes from onStage.
              if (!started.has('answer_audit')) onStage({ stage: 'answer_audit', phase: 'started', requestRemainingMs: getRequestRemainingMs() });
              observer.onAnswerAuditStart();
            },
            onAnswerAudit: value => {
              answerAssessment = structuredClone(value.assessment);
              observer.onAudit({ assessmentStatus: value.assessment.assessmentStatus, decision: value.assessment.decision, boundToFinalAnswer: false });
              const timedOut = value.assessment.findings.some(finding => finding.code === 'AUDIT_TIMEOUT');
              if (stages.answer_audit.status === 'started' || stages.answer_audit.status === 'not_run') {
                onStage({ stage: 'answer_audit', phase: value.assessment.assessmentStatus === 'completed' ? 'completed' : 'failed', timedOut });
              }
              if (timedOut) fail('AUDIT_TIMEOUT');
            }
            });
          } catch (error) {
            if (stages.generation.status === 'started') onStage({ stage: 'generation', phase: 'failed' });
            throw error;
          }
          if (stages.generation.status === 'started') onStage({ stage: 'generation', phase: result.data.fallbackReason ? 'failed' : 'completed' });
          return result;
        }
      });
      try {
        let query = input.query;
        let nextReply = 0;
        let submittedCandidates = false;
        final = await workflow.query(query, context);
        while (final.body.workflowId) {
          if (final.body.nextAction === 'clarify' && input.clarificationReplies?.[nextReply]) {
            const prior = final.body;
            const acquisitionCount = clarification.acquisitionCount;
            query = gamingHybridQuerySchema.parse({ ...query, ...input.clarificationReplies[nextReply],
              workflowId: prior.workflowId, expectedRevision: prior.revision,
              idempotencyKey: `live-validation-clarification-${nextReply + 1}` });
            nextReply += 1;
            clarification.submittedCount += 1;
            final = await workflow.query(query, context);
            if (final.status === 200) {
              clarification.completedCount += 1;
              sameWorkflow &&= final.body.workflowId === prior.workflowId;
              revisionsAdvanced &&= typeof prior.revision === 'number' && final.body.revision === prior.revision + 1;
              if (acquisitionCount > 0) {
                clarification.postAcquisitionCount += 1;
                const sameIds = (left?: string[], right?: string[]) => Boolean(left?.length && right?.length
                  && left.length === right.length && left.every(id => right.includes(id)));
                retainedEvidence &&= sameIds(prior.selectedCandidateIds, final.body.selectedCandidateIds)
                  && sameIds(prior.selectedEvidenceIds, final.body.selectedEvidenceIds);
                const allowanceFields = ['type', 'round', 'maxRounds', 'recoveryRemaining', 'remainingCandidateUrls', 'remainingTotalAcquisitionMs'] as const;
                budgetsPreserved &&= clarification.acquisitionCount === acquisitionCount && Boolean(prior.discovery)
                  && (final.body.discovery ? allowanceFields.every(field => prior.discovery?.[field] === final?.body.discovery?.[field])
                    : final.body.nextAction === 'answer');
              }
            }
            continue;
          }
          if (final.body.nextAction === 'search' && !submittedCandidates && input.candidateUrls.length) {
            submittedCandidates = true;
            final = await workflow.candidates({ contractVersion: 'gaming-hybrid-v2', workflowId: final.body.workflowId,
              expectedRevision: final.body.revision, discoveryType: final.body.discovery?.type ?? 'gameplay_evidence',
              idempotencyKey: 'live-validation-candidates', candidates: input.candidateUrls.map(url => ({ url })) }, context);
            continue;
          }
          break;
        }
      } catch { /* Failure observations never grant acceptance. */ }
      clarification.sameWorkflow = clarification.completedCount > 0 && sameWorkflow;
      clarification.revisionsAdvanced = clarification.completedCount > 0 && revisionsAdvanced;
      clarification.retainedEvidence = clarification.postAcquisitionCount > 0 && retainedEvidence;
      clarification.budgetsPreserved = clarification.postAcquisitionCount > 0 && budgetsPreserved;
      const accepted = Boolean(acquired && result && !failureCode && !result.data.fallbackReason
        && clarification.submittedCount === (input.clarificationReplies?.length ?? 0)
        && clarification.completedCount === clarification.submittedCount
        && (!clarification.submittedCount || clarification.sameWorkflow && clarification.revisionsAdvanced)
        && (!clarification.postAcquisitionCount || clarification.retainedEvidence && clarification.budgetsPreserved)
        && evidenceAssessment?.decision === 'accept' && hasBoundGamingClearAnswer(result.data)
        && answerAssessment?.profile === 'answer' && answerAssessment.assessmentStatus === 'completed' && answerAssessment.decision === 'accept'
        && answerAssessment?.subjectHash === gamingClearHash(result.data.response)
        && answerAssessment.contextFingerprint === evidenceAssessment.contextFingerprint
        && final?.status === 200 && final.body.state === 'answer_ready' && final.body.nextAction === 'answer'
        && final.body.answer?.response === result.data.response);
      const audit: LivePrPreviewAudit | undefined = answerAssessment ? { assessmentStatus: answerAssessment.assessmentStatus,
        decision: answerAssessment.decision, boundToFinalAnswer: accepted } : undefined;
      lastObservation = createLiveValidationObservation({ body: final?.body, accepted, audit, stages, auditStartBudget,
        ...(input.clarificationReplies?.length ? { clarification } : {}) });
      return { result, accepted, audit, failureCode };
    }
  };
}

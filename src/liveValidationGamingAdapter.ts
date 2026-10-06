import { randomUUID } from 'node:crypto';
import { getRequestAbortSignal, getRequestRemainingMs } from '@arcanos/runtime';
import { createGamingHybridWorkflow, type GamingHybridResult } from './services/gamingHybridKnowledge.js';
import { evaluateGamingHybridCandidates } from './services/gamingHybridCandidates.js';
import { resolveGamingDocument } from './services/gamingDocumentResolution.js';
import type { GamingPipelineInput, GamingPipelineRuntime, GamingPreparedEvidence } from './services/gamingPipeline.js';
import type { GamingSuccessEnvelope } from './services/gamingModes.js';
import { gamingHybridQuerySchema, type GamingHybridQuery } from './shared/gaming/gamingHybridContract.js';
import { hasBoundGamingClearAnswer } from './shared/gaming/gamingClearAnswerBinding.js';
import { gamingClearHash, type GamingClearAssessment } from './shared/gaming/gamingClearPolicy.js';
import { createLiveValidationObservation, emptyLiveValidationStages, liveValidationDuration,
  type LiveValidationObservation, type LiveValidationStageEvent } from './shared/gaming/liveValidationObservation.js';
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

export interface LiveValidationGamingInput { query: GamingHybridQuery; candidateUrls: string[] }
export type LiveValidationGamingHooks = Pick<GamingPipelineRuntime,
  'onEvidenceAssessment' | 'onAnswerAuditStart' | 'onAnswerAudit'> & { onStage: (event: LiveValidationStageEvent) => void };
export type LiveValidationGamingExecutor = (input: GamingPipelineInput, prepared: GamingPreparedEvidence,
  hooks: LiveValidationGamingHooks) => Promise<GamingSuccessEnvelope>;
export interface LiveValidationGamingAdapter extends LivePrPreviewModuleAdapter {
  getLastObservation(): LiveValidationObservation | undefined;
}
const sourceFailureCodes = new Set(['SOURCE_FETCH_FAILED', 'SOURCE_TIMEOUT', 'SOURCE_EXTRACTION_FAILED', 'URL_BLOCKED',
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
      if (Object.keys(record).some(key => !['query', 'candidateUrls'].includes(key))) return { ok: false };
      const parsed = gamingHybridQuerySchema.safeParse(record.query);
      if (!parsed.success || parsed.data.contractVersion !== 'gaming-hybrid-v2'
        || parsed.data.storagePolicy !== 'transient_only' || !Array.isArray(record.candidateUrls)
        || record.candidateUrls.length > 3 || new Set(record.candidateUrls).size !== record.candidateUrls.length
        || record.candidateUrls.some(value => {
          if (typeof value !== 'string' || value.length > 2_048) return true;
          try { const url = new URL(value); return url.protocol !== 'https:' || Boolean(url.username || url.password); } catch { return true; }
        })) return { ok: false };
      return { ok: true, input: { query: parsed.data, candidateUrls: [...record.candidateUrls] } as LiveValidationGamingInput };
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
        }
      };
      let result: GamingSuccessEnvelope | undefined;
      let evidenceAssessment: GamingClearAssessment | undefined;
      let answerAssessment: GamingClearAssessment | undefined;
      let final: GamingHybridResult | undefined;
      let failureCode: LivePreviewFailureCode | undefined;
      let acquired = false;
      const fail = (code: LivePreviewFailureCode) => { failureCode = code; observer.onFailure(code); };
      const scope = randomUUID();
      const context = { actorKey: 'live-validation:' + scope, requestId: 'live-validation:' + scope,
        signal: getRequestAbortSignal(), canStore: false, canAutoStore: false };
      const workflow = createGamingHybridWorkflow({ now,
        retrieve: async () => ({ context: '', sources: [], evidence: [], sourceKnown: false }),
        ingest: async () => { throw new Error('LIVE_VALIDATION_STORAGE_DENIED'); },
        evaluateCandidates: async (submission, actorContext) => {
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
            if (stages.generation.status === 'started') onStage({ stage: 'generation', phase: 'failed', timedOut: context.signal?.aborted });
            throw error;
          }
          if (stages.generation.status === 'started') onStage({ stage: 'generation', phase: result.data.fallbackReason ? 'failed' : 'completed' });
          return result;
        }
      });
      try {
        final = await workflow.query(input.query, context);
        if (final.body.nextAction === 'search' && final.body.workflowId && input.candidateUrls.length) {
          final = await workflow.candidates({ contractVersion: 'gaming-hybrid-v2', workflowId: final.body.workflowId,
            expectedRevision: final.body.revision, discoveryType: final.body.discovery?.type ?? 'gameplay_evidence',
            idempotencyKey: 'live-validation-candidates', candidates: input.candidateUrls.map(url => ({ url })) }, context);
        }
      } catch { /* Failure observations never grant acceptance. */ }
      const accepted = Boolean(acquired && result && !failureCode && !result.data.fallbackReason
        && evidenceAssessment?.decision === 'accept' && hasBoundGamingClearAnswer(result.data)
        && answerAssessment?.profile === 'answer' && answerAssessment.assessmentStatus === 'completed' && answerAssessment.decision === 'accept'
        && answerAssessment?.subjectHash === gamingClearHash(result.data.response)
        && answerAssessment.contextFingerprint === evidenceAssessment.contextFingerprint
        && final?.status === 200 && final.body.state === 'answer_ready' && final.body.nextAction === 'answer'
        && final.body.answer?.response === result.data.response);
      const audit: LivePrPreviewAudit | undefined = answerAssessment ? { assessmentStatus: answerAssessment.assessmentStatus,
        decision: answerAssessment.decision, boundToFinalAnswer: accepted } : undefined;
      lastObservation = createLiveValidationObservation({ body: final?.body, accepted, audit, stages, auditStartBudget });
      return { result, accepted, audit, failureCode };
    }
  };
}

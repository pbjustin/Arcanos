import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { runWithRequestAbortTimeout } from '@arcanos/runtime';
import { createLivePreviewEvidence } from '../scripts/live-pr-preview-verifier.mjs';
import type { LivePreviewCaseId, LivePreviewFailureCode, LivePreviewEvidenceInput } from '../scripts/live-pr-preview-verifier.mjs';

/** This factory is imported only by the separate private preview entry point. */
export const LIVE_PR_PREVIEW_PREFIX = '/__preview/live';
export const LIVE_PR_PREVIEW_ROUTE = LIVE_PR_PREVIEW_PREFIX + '/:moduleId';
export interface LivePrPreviewSession {
  mode: 'live-backend-v1';
  sourceCommit: string;
  approvedSourceCommit: string;
  deploymentId: string;
  environmentName: string;
  prNumber: number;
  expiresAtMs: number;
  testBearer: string;
  maxRequests: number;
  requestTimeoutMs: number;
  moduleIds: readonly string[];
}
export interface LivePrPreviewObservation {
  stage: 'generation' | 'answer_audit';
  generationCalls: number;
  auditCalls: number;
  timeoutStage?: 'generation' | 'answer_audit';
  budgetExhausted?: boolean;
}
export type LivePrPreviewAudit = NonNullable<LivePreviewEvidenceInput['audit']>;
export interface LivePrPreviewModuleObserver {
  onSourceAcquisition(status: 'passed' | 'failed'): void;
  onSourceValidation(status: 'passed' | 'rejected'): void;
  onAnswerAuditStart(): void;
  onAudit(audit: LivePrPreviewAudit): void;
  onFailure(code: LivePreviewFailureCode): void;
}
export interface LivePrPreviewModuleResult {
  /** Normalized grounded-answer projection; raw provider output cannot establish acceptance. */
  result?: unknown;
  accepted: boolean;
  audit?: LivePrPreviewAudit;
  failureCode?: LivePreviewFailureCode;
}
export interface LivePrPreviewModuleAdapter {
  moduleId: string;
  validateInput(value: unknown): { ok: true; input: unknown } | { ok: false };
  /** Fixed backend function owned by this adapter, never an arbitrary module dispatcher. */
  execute(input: unknown, observer: LivePrPreviewModuleObserver): Promise<LivePrPreviewModuleResult>;
}
export interface LivePrPreviewDependencies {
  adapters: readonly LivePrPreviewModuleAdapter[];
  observation(): LivePrPreviewObservation;
  usage(): Promise<Parameters<typeof createLivePreviewEvidence>[1]['usage']>;
  now?: () => number;
}

export function validateLivePrPreviewSession(session: LivePrPreviewSession): void {
  if (session.mode !== 'live-backend-v1'
    || !/^[0-9a-f]{40}$/u.test(session.sourceCommit)
    || session.approvedSourceCommit !== session.sourceCommit
    || !Number.isSafeInteger(session.prNumber) || session.prNumber < 1
    || session.environmentName !== `live-pr-${session.prNumber}`
    || !/^[0-9a-f-]{36}$/u.test(session.deploymentId)
    || !/^arcanos-preview-[0-9a-f]{64}$/u.test(session.testBearer)
    || !Number.isSafeInteger(session.expiresAtMs)
    || !Number.isSafeInteger(session.maxRequests) || session.maxRequests < 1 || session.maxRequests > 64
    || !Number.isSafeInteger(session.requestTimeoutMs) || session.requestTimeoutMs < 1 || session.requestTimeoutMs > 120_000) {
    throw new Error('LIVE_PREVIEW_SESSION_INVALID');
  }
  if (!Array.isArray(session.moduleIds) || session.moduleIds.length < 1 || session.moduleIds.length > 16
    || new Set(session.moduleIds).size !== session.moduleIds.length
    || session.moduleIds.some(module => !/^[a-z][a-z0-9_-]{0,63}$/u.test(module))) throw new Error('LIVE_PREVIEW_MODULES_INVALID');
}

export function createLivePrPreviewApplication(session: LivePrPreviewSession, deps: LivePrPreviewDependencies) {
  validateLivePrPreviewSession(session);
  const approvedSession = Object.freeze({ ...session, moduleIds: Object.freeze([...session.moduleIds]) });
  const adapters = new Map(deps.adapters.map(adapter => [adapter.moduleId, adapter]));
  if (adapters.size !== deps.adapters.length || [...adapters.keys()].some(module => !/^[a-z][a-z0-9_-]{0,63}$/u.test(module))) {
    throw new Error('LIVE_PREVIEW_ADAPTERS_INVALID');
  }
  const now = deps.now ?? Date.now;
  const app = express();
  app.disable('x-powered-by');
  let active = false;
  let requests = 0;
  const expected = Buffer.from(`Bearer ${approvedSession.testBearer}`);
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.post(LIVE_PR_PREVIEW_ROUTE, (req, res, next) => {
    const authHeaders = req.rawHeaders.filter((_, i) => i % 2 === 0)
      .filter(name => name.toLowerCase() === 'authorization');
    const actual = Buffer.from(req.header('authorization') ?? '');
    if (authHeaders.length !== 1 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.status(401).json({ code: 'UNAUTHORIZED_TEST_IDENTITY' }); return;
    }
    if (!approvedSession.moduleIds.includes(req.params.moduleId) || !adapters.has(req.params.moduleId)) {
      res.status(403).json({ code: 'LIVE_PREVIEW_MODULE_UNAPPROVED' }); return;
    }
    if (now() >= approvedSession.expiresAtMs) { res.status(403).json({ code: 'LIVE_PREVIEW_EXPIRED' }); return; }
    if (active || requests >= approvedSession.maxRequests) { res.status(429).json({ code: 'BUDGET_EXHAUSTED' }); return; }
    if (!req.is('application/json')) { res.status(415).json({ code: 'LIVE_PREVIEW_REQUEST_INVALID' }); return; }
    next();
  }, express.json({ limit: 32_768, strict: true, inflate: false }), async (req, res) => {
    const caseId: LivePreviewCaseId = req.body?.caseId;
    if (!['useful_grounded_guide', 'incompatible_source', 'insufficient_evidence', 'acquisition_failure',
      'model_timeout', 'audit_timeout', 'exhausted_budget'].includes(caseId)) {
      res.status(400).json({ code: 'LIVE_PREVIEW_REQUEST_INVALID' }); return;
    }
    const adapter = adapters.get(req.params.moduleId)!;
    const validated = adapter.validateInput(req.body?.input);
    if (!validated.ok) {
      res.status(400).json({ code: 'LIVE_PREVIEW_REQUEST_INVALID' }); return;
    }
    // Express parsing may overlap: reserve again immediately before asynchronous execution.
    if (now() >= approvedSession.expiresAtMs) { res.status(403).json({ code: 'LIVE_PREVIEW_EXPIRED' }); return; }
    if (active || requests >= approvedSession.maxRequests) {
      res.status(429).json({ code: 'BUDGET_EXHAUSTED' }); return;
    }
    active = true;
    requests++;
    let moduleResult: LivePrPreviewModuleResult | undefined;
    const sourceStages: { acquisition: 'passed' | 'failed' | 'not_run'; validation: 'passed' | 'rejected' | 'not_run' }
      = { acquisition: 'not_run', validation: 'not_run' };
    let audit: LivePrPreviewAudit | undefined;
    let auditStarted = false;
    let failureCode: LivePreviewFailureCode | undefined;
    let pipelineFailed = false;
    let executionSettled = true;
    let evidenceSettled = false;
    const releaseWhenSettled = () => { if (executionSettled && evidenceSettled) active = false; };
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnect);
    try {
      moduleResult = await runWithRequestAbortTimeout({
        timeoutMs: Math.min(approvedSession.requestTimeoutMs, approvedSession.expiresAtMs - now()),
        parentSignal: controller.signal,
        abortMessage: 'Live preview request deadline exceeded.',
      }, () => {
        executionSettled = false;
        const execution = Promise.resolve().then(() => adapter.execute(validated.input, {
          onSourceAcquisition: status => { sourceStages.acquisition = status; },
          onSourceValidation: status => { sourceStages.validation = status; },
          onAnswerAuditStart: () => { auditStarted = true; },
          onAudit: value => { audit = structuredClone(value); },
          onFailure: code => { failureCode = code; },
        }));
        const settle = () => { executionSettled = true; releaseWhenSettled(); };
        void execution.then(settle, settle);
        return execution;
      });
    } catch (error) {
      void error;
      pipelineFailed = true;
    }
    try {
      // Trusted broker accounting settles before interpreting this request's observed transports.
      const usage = await deps.usage();
      const observation = deps.observation();
      failureCode = moduleResult?.failureCode ?? failureCode;
      audit = moduleResult?.audit ?? audit;
      if (observation.budgetExhausted) failureCode = 'BUDGET_EXHAUSTED';
      else if (observation.timeoutStage) failureCode = observation.timeoutStage === 'answer_audit' ? 'AUDIT_TIMEOUT' : 'MODEL_TIMEOUT';
      const bound = Boolean(moduleResult?.accepted && audit?.assessmentStatus === 'completed'
        && audit.decision === 'accept' && audit.boundToFinalAnswer);
      const evidence = createLivePreviewEvidence({ ...approvedSession, moduleId: adapter.moduleId }, {
        caseId, result: moduleResult?.result, failureCode, audit,
        usage,
        stages: {
          authorization: 'passed', budget: failureCode === 'BUDGET_EXHAUSTED' ? 'exhausted' : 'passed',
          source_acquisition: sourceStages.acquisition,
          source_validation: sourceStages.validation,
          generation: failureCode === 'MODEL_TIMEOUT' ? 'timed_out' : auditStarted || bound ? 'passed'
            : observation.generationCalls > 0 ? 'failed' : 'not_run',
          answer_audit: failureCode === 'AUDIT_TIMEOUT' ? 'timed_out' : audit?.decision === 'accept' ? 'passed'
            : auditStarted ? 'failed' : 'not_run',
          delivery: bound && !failureCode && !pipelineFailed && sourceStages.acquisition === 'passed'
            && sourceStages.validation === 'passed' && observation.generationCalls > 0 && observation.auditCalls > 0 ? 'passed' : 'rejected',
        },
      });
      res.status(200).json(evidence);
    } catch {
      res.status(503).json({ code: 'LIVE_PREVIEW_EVIDENCE_UNAVAILABLE' });
    } finally {
      res.off('close', disconnect);
      evidenceSettled = true;
      releaseWhenSettled();
    }
  });
  app.use((_req, res) => { res.status(404).json({ code: 'LIVE_PREVIEW_ROUTE_UNAVAILABLE' }); });
  app.use((_: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ code: 'LIVE_PREVIEW_REQUEST_INVALID' });
  });
  return app;
}

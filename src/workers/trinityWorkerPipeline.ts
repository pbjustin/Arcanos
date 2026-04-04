import type OpenAI from 'openai';
import {
  runThroughBrain,
  type TrinityResult,
  type TrinityToolBackedCapabilities
} from '@core/logic/trinity.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { createRuntimeBudgetWithLimit } from '@platform/resilience/runtimeBudget.js';
import {
  createAbortError,
  getRequestAbortSignal,
  isAbortError,
  runWithRequestAbortTimeout
} from '@arcanos/runtime';
import { sleep } from '@shared/sleep.js';
import type { CognitiveDomain } from '@shared/types/cognitiveDomain.js';
import { getWorkerExecutionLimits } from './workerExecutionLimits.js';

export interface WorkerTrinityRequest {
  prompt: string;
  sessionId?: string;
  memorySessionId?: string;
  tokenAuditSessionId?: string;
  overrideAuditSafe?: string;
  cognitiveDomain?: CognitiveDomain;
  sourceEndpoint?: string;
  toolBackedCapabilities?: TrinityToolBackedCapabilities;
  requestedVerbosity?: 'minimal' | 'normal' | 'detailed';
  maxWords?: number | null;
  answerMode?: 'direct' | 'explained' | 'audit' | 'debug';
  debugPipeline?: boolean;
  strictUserVisibleOutput?: boolean;
}

export type PlannerFailureClassification =
  | 'timeout'
  | 'abort'
  | 'network'
  | 'upstream'
  | 'input'
  | 'unknown';

export interface PlannerExecutionFailureDetails {
  sourceEndpoint: string;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  attemptsUsed: number;
  durationMs: number;
  finalFailureClassification: PlannerFailureClassification;
  transientFailure: boolean;
  retryable: boolean;
  errorName: string;
  errorMessage: string;
  errorCode?: string;
  statusCode?: number;
}

interface PlannerExecutionError extends Error {
  plannerExecution?: PlannerExecutionFailureDetails;
}

function isPlannerSourceEndpoint(sourceEndpoint: string): boolean {
  return sourceEndpoint === 'dag.agent.planner';
}

function extractErrorName(error: unknown): string {
  if (error instanceof Error && typeof error.name === 'string' && error.name.trim().length > 0) {
    return error.name;
  }

  if (typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string') {
    return String((error as { name: string }).name);
  }

  return 'Error';
}

function extractErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === 'string' && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

function extractStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const candidate = error as { status?: unknown; statusCode?: unknown; httpCode?: unknown };
  if (typeof candidate.status === 'number') {
    return candidate.status;
  }
  if (typeof candidate.statusCode === 'number') {
    return candidate.statusCode;
  }
  if (typeof candidate.httpCode === 'number') {
    return candidate.httpCode;
  }

  return undefined;
}

function classifyPlannerFailure(error: unknown): {
  classification: PlannerFailureClassification;
  transientFailure: boolean;
  errorName: string;
  errorMessage: string;
  errorCode?: string;
  statusCode?: number;
} {
  const errorMessage = resolveErrorMessage(error);
  const normalizedMessage = errorMessage.toLowerCase();
  const errorName = extractErrorName(error);
  const errorCode = extractErrorCode(error);
  const statusCode = extractStatusCode(error);

  if (statusCode === 429 || (typeof statusCode === 'number' && statusCode >= 500)) {
    return {
      classification: 'upstream',
      transientFailure: true,
      errorName,
      errorMessage,
      errorCode,
      statusCode
    };
  }

  if (
    typeof statusCode === 'number' &&
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 408 &&
    statusCode !== 409 &&
    statusCode !== 429
  ) {
    return {
      classification: 'input',
      transientFailure: false,
      errorName,
      errorMessage,
      errorCode,
      statusCode
    };
  }

  if (
    normalizedMessage.includes('validation') ||
    normalizedMessage.includes('schema') ||
    normalizedMessage.includes('malformed') ||
    normalizedMessage.includes('invalid') ||
    normalizedMessage.includes('missing') ||
    normalizedMessage.includes('unsupported')
  ) {
    return {
      classification: 'input',
      transientFailure: false,
      errorName,
      errorMessage,
      errorCode,
      statusCode
    };
  }

  if (
    normalizedMessage.includes('timed out') ||
    normalizedMessage.includes('timeout') ||
    errorName === 'RuntimeBudgetExceededError'
  ) {
    return {
      classification: 'timeout',
      transientFailure: true,
      errorName,
      errorMessage,
      errorCode,
      statusCode
    };
  }

  if (isAbortError(error) || normalizedMessage.includes('request was aborted')) {
    return {
      classification: 'abort',
      transientFailure: true,
      errorName,
      errorMessage,
      errorCode,
      statusCode
    };
  }

  if (
    errorCode === 'ECONNRESET' ||
    errorCode === 'ECONNREFUSED' ||
    errorCode === 'EAI_AGAIN' ||
    errorCode === 'ENOTFOUND' ||
    errorCode === 'ETIMEDOUT' ||
    errorCode === 'EPIPE' ||
    normalizedMessage.includes('socket hang up') ||
    normalizedMessage.includes('network') ||
    normalizedMessage.includes('connection reset')
  ) {
    return {
      classification: 'network',
      transientFailure: true,
      errorName,
      errorMessage,
      errorCode,
      statusCode
    };
  }

  return {
    classification: 'unknown',
    transientFailure: false,
    errorName,
    errorMessage,
    errorCode,
    statusCode
  };
}

function createPlannerExecutionError(
  error: unknown,
  details: PlannerExecutionFailureDetails
): PlannerExecutionError {
  const plannerError = new Error(details.errorMessage) as PlannerExecutionError;
  plannerError.name = 'PlannerExecutionError';
  plannerError.plannerExecution = details;

  const errorCode = extractErrorCode(error);
  const statusCode = extractStatusCode(error);
  if (typeof errorCode === 'string') {
    (plannerError as PlannerExecutionError & { code?: string }).code = errorCode;
  }
  if (typeof statusCode === 'number') {
    (plannerError as PlannerExecutionError & { status?: number }).status = statusCode;
  }
  if (error instanceof Error) {
    plannerError.cause = error;
  }

  return plannerError;
}

function buildTrinityRunOptions(
  request: WorkerTrinityRequest,
  sourceEndpoint: string,
  watchdogModelTimeoutMs: number
) {
  return {
    cognitiveDomain: request.cognitiveDomain,
    sourceEndpoint,
    watchdogModelTimeoutMs,
    ...(request.toolBackedCapabilities ? { toolBackedCapabilities: request.toolBackedCapabilities } : {}),
    ...(typeof request.memorySessionId === 'string' && request.memorySessionId.trim().length > 0
      ? { memorySessionId: request.memorySessionId.trim() }
      : {}),
    ...(typeof request.tokenAuditSessionId === 'string' && request.tokenAuditSessionId.trim().length > 0
      ? { tokenAuditSessionId: request.tokenAuditSessionId.trim() }
      : {}),
    ...(request.requestedVerbosity ? { requestedVerbosity: request.requestedVerbosity } : {}),
    ...(request.maxWords !== undefined ? { maxWords: request.maxWords } : {}),
    ...(request.answerMode ? { answerMode: request.answerMode } : {}),
    ...(typeof request.debugPipeline === 'boolean' ? { debugPipeline: request.debugPipeline } : {}),
    ...(typeof request.strictUserVisibleOutput === 'boolean'
      ? { strictUserVisibleOutput: request.strictUserVisibleOutput }
      : {})
  };
}

function calculatePlannerRetryDelayMs(
  attempt: number,
  baseDelayMs: number,
  timeoutMs: number
): number {
  return Math.min(timeoutMs, baseDelayMs * Math.max(1, 2 ** Math.max(0, attempt - 1)));
}

async function runPlannerWithRetries(
  openaiClient: OpenAI,
  request: WorkerTrinityRequest,
  sourceEndpoint: string,
  workerExecutionLimits: ReturnType<typeof getWorkerExecutionLimits>
): Promise<TrinityResult> {
  const maxAttempts = Math.max(1, workerExecutionLimits.plannerMaxRetries + 1);
  const requestId = request.sessionId ?? sourceEndpoint;
  const runtimeBudgetLimitMs = Math.min(
    workerExecutionLimits.workerTrinityRuntimeBudgetMs,
    workerExecutionLimits.plannerTimeoutMs
  );
  const trinityRunOptions = buildTrinityRunOptions(
    request,
    sourceEndpoint,
    workerExecutionLimits.plannerTimeoutMs
  );
  const plannerStartedAtMs = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const parentSignal = getRequestAbortSignal();
    if (parentSignal?.aborted) {
      throw parentSignal.reason instanceof Error
        ? parentSignal.reason
        : createAbortError('planner_parent_request_aborted');
    }

    try {
      return await runWithRequestAbortTimeout(
        {
          timeoutMs: workerExecutionLimits.plannerTimeoutMs,
          requestId,
          parentSignal,
          abortMessage: `Planner DAG node timed out after ${workerExecutionLimits.plannerTimeoutMs}ms`
        },
        () =>
          runThroughBrain(
            openaiClient,
            request.prompt,
            request.sessionId,
            request.overrideAuditSafe,
            trinityRunOptions,
            createRuntimeBudgetWithLimit(runtimeBudgetLimitMs)
          )
      );
    } catch (error: unknown) {
      const classifiedFailure = classifyPlannerFailure(error);
      const durationMs = Date.now() - plannerStartedAtMs;
      const retryScheduled =
        classifiedFailure.transientFailure &&
        attempt < maxAttempts;

      logger.warn('planner.dag.execution.failure', {
        module: 'dag.planner',
        operation: 'execution',
        sourceEndpoint,
        attempt,
        maxAttempts,
        timeoutMs: workerExecutionLimits.plannerTimeoutMs,
        classification: classifiedFailure.classification,
        transientFailure: classifiedFailure.transientFailure,
        retryScheduled,
        durationMs,
        errorName: classifiedFailure.errorName,
        errorCode: classifiedFailure.errorCode,
        statusCode: classifiedFailure.statusCode,
        errorMessage: classifiedFailure.errorMessage
      });

      if (!retryScheduled) {
        throw createPlannerExecutionError(error, {
          sourceEndpoint,
          timeoutMs: workerExecutionLimits.plannerTimeoutMs,
          maxRetries: workerExecutionLimits.plannerMaxRetries,
          retryBackoffMs: workerExecutionLimits.plannerRetryBackoffMs,
          attemptsUsed: attempt,
          durationMs,
          finalFailureClassification: classifiedFailure.classification,
          transientFailure: classifiedFailure.transientFailure,
          retryable: false,
          errorName: classifiedFailure.errorName,
          errorMessage: classifiedFailure.errorMessage,
          ...(typeof classifiedFailure.errorCode === 'string'
            ? { errorCode: classifiedFailure.errorCode }
            : {}),
          ...(typeof classifiedFailure.statusCode === 'number'
            ? { statusCode: classifiedFailure.statusCode }
            : {})
        });
      }

      const retryDelayMs = calculatePlannerRetryDelayMs(
        attempt,
        workerExecutionLimits.plannerRetryBackoffMs,
        workerExecutionLimits.plannerTimeoutMs
      );
      logger.warn('planner.dag.execution.retry', {
        module: 'dag.planner',
        operation: 'retry',
        sourceEndpoint,
        attempt,
        maxAttempts,
        retryDelayMs,
        classification: classifiedFailure.classification,
        errorMessage: classifiedFailure.errorMessage
      });
      await sleep(retryDelayMs, { unref: true });
    }
  }

  throw createPlannerExecutionError(new Error('Planner execution failed unexpectedly.'), {
    sourceEndpoint,
    timeoutMs: workerExecutionLimits.plannerTimeoutMs,
    maxRetries: workerExecutionLimits.plannerMaxRetries,
    retryBackoffMs: workerExecutionLimits.plannerRetryBackoffMs,
    attemptsUsed: maxAttempts,
    durationMs: 0,
    finalFailureClassification: 'unknown',
    transientFailure: false,
    retryable: false,
    errorName: 'PlannerExecutionError',
    errorMessage: 'Planner execution failed unexpectedly.'
  });
}

/**
 * Execute one worker-originated prompt through the shared Trinity pipeline.
 *
 * Purpose:
 * - Keep queued asks, queued DAG nodes, and in-process workers on one Trinity invocation path.
 *
 * Inputs/outputs:
 * - Input: OpenAI client plus worker routing metadata.
 * - Output: normalized Trinity result from the shared brain pipeline.
 *
 * Edge case behavior:
 * - Falls back to `worker.dispatch` when no worker-specific source endpoint is supplied.
 */
export async function runWorkerTrinityPrompt(
  openaiClient: OpenAI,
  request: WorkerTrinityRequest
): Promise<TrinityResult> {
  const workerExecutionLimits = getWorkerExecutionLimits();
  const normalizedSourceEndpoint =
    typeof request.sourceEndpoint === 'string' && request.sourceEndpoint.trim().length > 0
      ? request.sourceEndpoint.trim()
      : 'worker.dispatch';

  //audit Assumption: worker-triggered Trinity runs must always emit a source endpoint for traceability; failure risk: mixed worker traffic becomes impossible to debug in routing telemetry; expected invariant: every worker AI call carries a stable endpoint label; handling strategy: default missing or blank endpoints to `worker.dispatch`.
  if (isPlannerSourceEndpoint(normalizedSourceEndpoint)) {
    return runPlannerWithRetries(
      openaiClient,
      request,
      normalizedSourceEndpoint,
      workerExecutionLimits
    );
  }

  const trinityRunOptions = buildTrinityRunOptions(
    request,
    normalizedSourceEndpoint,
    workerExecutionLimits.workerTrinityStageTimeoutMs
  );

  return runThroughBrain(
    openaiClient,
    request.prompt,
    request.sessionId,
    request.overrideAuditSafe,
    trinityRunOptions,
    createRuntimeBudgetWithLimit(workerExecutionLimits.workerTrinityRuntimeBudgetMs)
  );
}

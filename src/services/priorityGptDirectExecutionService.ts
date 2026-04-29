import {
  getJobById,
  recordJobHeartbeat,
  updateJob
} from '@core/db/repositories/jobRepository.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { logger } from '@platform/logging/structuredLogging.js';
import {
  recordGptJobEvent,
  recordGptJobTiming
} from '@platform/observability/appMetrics.js';
import type { routeGptRequest as routeGptRequestType } from '@routes/_core/gptDispatch.js';
import { parseQueuedGptJobInput } from '@shared/gpt/asyncGptJob.js';
import { computeGptJobLifecycleDeadlines } from '@shared/gpt/gptJobLifecycle.js';
import {
  resolveGptWaitTimeoutMs,
  resolvePriorityGptDirectExecutionConcurrency
} from '@shared/gpt/priorityGpt.js';
import { createAbortError, isAbortError } from '@arcanos/runtime';

export interface PriorityGptDirectExecutionSlot {
  release: () => void;
}

export interface PriorityGptDirectExecutionSnapshot {
  active: number;
  capacity: number;
  available: number;
}

const DIRECT_HEARTBEAT_INTERVAL_MS = 5_000;
let activePriorityDirectExecutions = 0;
let routeGptRequestLoader: Promise<typeof routeGptRequestType> | null = null;

async function loadRouteGptRequest(): Promise<typeof routeGptRequestType> {
  routeGptRequestLoader ??= import('@routes/_core/gptDispatch.js').then(
    (module) => module.routeGptRequest
  );
  return routeGptRequestLoader;
}

function hydrateQueuedGptBodyPrompt(
  body: Record<string, unknown>,
  prompt: string | undefined
): Record<string, unknown> {
  if (!prompt) {
    return body;
  }

  if (
    typeof body.prompt === 'string' ||
    typeof body.message === 'string' ||
    typeof body.query === 'string' ||
    typeof body.text === 'string' ||
    typeof body.content === 'string'
  ) {
    return body;
  }

  return {
    ...body,
    prompt
  };
}

export function getPriorityGptDirectExecutionSnapshot(
  env: NodeJS.ProcessEnv = process.env
): PriorityGptDirectExecutionSnapshot {
  const capacity = resolvePriorityGptDirectExecutionConcurrency(env);
  const active = Math.min(activePriorityDirectExecutions, capacity);

  return {
    active,
    capacity,
    available: Math.max(0, capacity - active)
  };
}

export function tryAcquirePriorityGptDirectExecutionSlot(
  env: NodeJS.ProcessEnv = process.env
): PriorityGptDirectExecutionSlot | null {
  const capacity = resolvePriorityGptDirectExecutionConcurrency(env);
  if (activePriorityDirectExecutions >= capacity) {
    return null;
  }

  activePriorityDirectExecutions += 1;
  let released = false;

  return {
    release: () => {
      if (released) {
        return;
      }

      released = true;
      activePriorityDirectExecutions = Math.max(0, activePriorityDirectExecutions - 1);
    }
  };
}

/**
 * Start API-process execution for a reserved priority GPT job.
 * Purpose: let custom GPT requests use immediate worker capacity without entering the normal queue lane.
 * Inputs/outputs: accepts a pre-created running job plus the reserved slot; persists terminal job state.
 * Edge case behavior: failures are logged and converted to terminal job rows, avoiding hidden retry loops.
 */
export function startReservedPriorityGptDirectExecution(params: {
  jobId: string;
  rawInput: unknown;
  workerId: string;
  slot: PriorityGptDirectExecutionSlot;
  requestLogger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
}): void {
  void executeReservedPriorityGptDirectExecution(params)
    .catch((error: unknown) => {
      logger.error('gpt.priority_direct.unhandled_error', {
        jobId: params.jobId,
        workerId: params.workerId,
        error: resolveErrorMessage(error)
      });
    });
}

async function executeReservedPriorityGptDirectExecution(params: {
  jobId: string;
  rawInput: unknown;
  workerId: string;
  slot: PriorityGptDirectExecutionSlot;
  requestLogger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
}): Promise<void> {
  const parsedGptJobInput = parseQueuedGptJobInput(params.rawInput ?? {});
  const startedAtMs = Date.now();
  const leaseMs = Math.max(15_000, resolveGptWaitTimeoutMs() + 5_000);
  const cancellationController = new AbortController();
  const heartbeatHandle = setInterval(() => {
    void recordJobHeartbeat(params.jobId, {
      workerId: params.workerId,
      leaseMs
    })
      .then((updatedJob) => {
        if (
          updatedJob?.cancel_requested_at &&
          !cancellationController.signal.aborted
        ) {
          cancellationController.abort(
            createAbortError(updatedJob.cancel_reason ?? 'GPT job cancellation requested.')
          );
        }
      })
      .catch((error: unknown) => {
        logger.warn('gpt.priority_direct.heartbeat_failed', {
          jobId: params.jobId,
          workerId: params.workerId,
          error: resolveErrorMessage(error)
        });
      });
  }, DIRECT_HEARTBEAT_INTERVAL_MS);

  try {
    if (!parsedGptJobInput.ok) {
      await updateJob(
        params.jobId,
        'failed',
        null,
        `Invalid GPT job.input: ${parsedGptJobInput.error}`,
        {
          priorityDirectExecution: {
            completedAt: new Date().toISOString(),
            failure: 'invalid_input'
          }
        },
        computeGptJobLifecycleDeadlines('failed')
      );
      return;
    }

    const { gptId, body, prompt, requestId, bypassIntentRouting } = parsedGptJobInput.value;
    const latestJob = await getJobById(params.jobId);
    if (!latestJob) {
      params.requestLogger?.warn?.('gpt.priority_direct.job_missing', {
        jobId: params.jobId,
        workerId: params.workerId
      });
      return;
    }

    if (latestJob.cancel_requested_at) {
      await updateJob(
        params.jobId,
        'cancelled',
        null,
        latestJob.cancel_reason ?? 'Job cancellation requested before priority GPT execution started.',
        {
          priorityDirectExecution: {
            completedAt: new Date().toISOString(),
            cancelledBeforeStart: true
          }
        },
        {
          ...computeGptJobLifecycleDeadlines('cancelled'),
          cancelRequestedAt: new Date().toISOString(),
          cancelReason: latestJob.cancel_reason ?? 'Priority GPT direct execution cancelled.'
        }
      );
      return;
    }

    const routeLogger = logger.child({
      module: 'priority-gpt-direct',
      gptId,
      requestId,
      jobId: params.jobId
    });
    params.requestLogger?.info?.('gpt.priority_direct.started', {
      gptId,
      requestId,
      jobId: params.jobId,
      workerId: params.workerId
    });

    const routeGptRequest = await loadRouteGptRequest();
    const envelope = await routeGptRequest({
      gptId,
      body: hydrateQueuedGptBodyPrompt(body, prompt),
      requestId,
      logger: routeLogger,
      bypassIntentRouting,
      runtimeExecutionMode: 'background',
      parentAbortSignal: cancellationController.signal
    });

    if (cancellationController.signal.aborted) {
      const reason = cancellationController.signal.reason;
      throw reason instanceof Error
        ? reason
        : createAbortError('GPT job cancellation requested.');
    }

    if (!envelope.ok) {
      const errorMessage = `${envelope.error.code}: ${envelope.error.message}`;
      await updateJob(
        params.jobId,
        'failed',
        envelope,
        errorMessage,
        {
          priorityDirectExecution: {
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAtMs,
            retryable:
              envelope.error.code === 'MODULE_TIMEOUT' ||
              envelope.error.code === 'MODULE_ERROR'
          },
          lastFailure: {
            at: new Date().toISOString(),
            reason: errorMessage,
            retryable:
              envelope.error.code === 'MODULE_TIMEOUT' ||
              envelope.error.code === 'MODULE_ERROR',
            retryExhausted: true,
            priorityDirectExecution: true
          }
        },
        computeGptJobLifecycleDeadlines('failed')
      );
      recordGptJobEvent({
        event:
          envelope.error.code === 'MODULE_TIMEOUT' || envelope.error.code === 'MODULE_ERROR'
            ? 'retryable_failure'
            : 'non_retryable_failure',
        status: 'failed',
        retryable:
          envelope.error.code === 'MODULE_TIMEOUT' ||
          envelope.error.code === 'MODULE_ERROR'
      });
      return;
    }

    await updateJob(
      params.jobId,
      'completed',
      envelope,
      null,
      {
        priorityDirectExecution: {
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAtMs
        }
      },
      computeGptJobLifecycleDeadlines('completed')
    );
    recordGptJobEvent({
      event: 'completed',
      status: 'completed',
      retryable: false
    });
    recordGptJobTiming({
      phase: 'execution',
      outcome: 'completed',
      durationMs: Date.now() - startedAtMs
    });
    params.requestLogger?.info?.('gpt.priority_direct.completed', {
      gptId,
      requestId,
      jobId: params.jobId,
      durationMs: Date.now() - startedAtMs
    });
  } catch (error: unknown) {
    const errorMessage = resolveErrorMessage(error);
    const aborted = isAbortError(error);
    await updateJob(
      params.jobId,
      aborted ? 'cancelled' : 'failed',
      null,
      errorMessage,
      {
        priorityDirectExecution: {
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAtMs,
          thrown: true,
          aborted
        },
        lastFailure: {
          at: new Date().toISOString(),
          reason: errorMessage,
          retryable: false,
          retryExhausted: true,
          priorityDirectExecution: true
        }
      },
      {
        ...computeGptJobLifecycleDeadlines(aborted ? 'cancelled' : 'failed'),
        ...(aborted
          ? {
              cancelRequestedAt: new Date().toISOString(),
              cancelReason: errorMessage
            }
          : {})
      }
    );
    params.requestLogger?.warn?.('gpt.priority_direct.failed', {
      jobId: params.jobId,
      workerId: params.workerId,
      durationMs: Date.now() - startedAtMs,
      error: errorMessage
    });
  } finally {
    clearInterval(heartbeatHandle);
    params.slot.release();
  }
}

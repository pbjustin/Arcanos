import {
  createClaimedJobFence,
  getJobById,
  recordJobHeartbeat,
  updateClaimedJobTerminal,
  type ClaimedJobTerminalStatus,
  type UpdateClaimedJobTerminalOptions
} from '@core/db/repositories/jobRepository.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { logger } from '@platform/logging/structuredLogging.js';
import {
  recordGptJobEvent,
  recordGptJobTiming
} from '@platform/observability/appMetrics.js';
import {
  createAiExecutionContext,
  runWithAiExecutionContext
} from '@services/openai/aiExecutionContext.js';
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
  claimGeneration: string;
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
  claimGeneration: string;
  rawInput: unknown;
  workerId: string;
  slot: PriorityGptDirectExecutionSlot;
  requestLogger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
}): Promise<void> {
  const startedAtMs = Date.now();
  const leaseMs = Math.max(15_000, resolveGptWaitTimeoutMs() + 5_000);
  let fence!: ReturnType<typeof createClaimedJobFence>;
  let fenceReady = false;
  const cancellationController = new AbortController();
  let heartbeatTimeout: NodeJS.Timeout | null = null;
  let heartbeatStopped = false;
  let leaseLost = false;
  let cancellationRecorded = false;
  const stopHeartbeat = (): void => {
    heartbeatStopped = true;
    if (heartbeatTimeout) {
      clearTimeout(heartbeatTimeout);
      heartbeatTimeout = null;
    }
  };
  const persistTerminal = async (
    status: ClaimedJobTerminalStatus,
    options: Omit<UpdateClaimedJobTerminalOptions, 'fence'>
  ) => {
    return updateClaimedJobTerminal(params.jobId, status, {
      ...options,
      fence
    });
  };
  const abortExecution = (message: string): void => {
    if (!cancellationController.signal.aborted) {
      cancellationController.abort(createAbortError(message));
    }
  };
  const recordCancellation = (errorMessage: string): void => {
    if (cancellationRecorded) {
      return;
    }

    cancellationRecorded = true;
    recordGptJobEvent({
      event: 'cancelled',
      status: 'cancelled',
      retryable: false
    });
    recordGptJobTiming({
      phase: 'execution',
      outcome: 'cancelled',
      durationMs: Date.now() - startedAtMs
    });
    params.requestLogger?.info?.('gpt.priority_direct.cancelled', {
      jobId: params.jobId,
      workerId: params.workerId,
      durationMs: Date.now() - startedAtMs,
      error: errorMessage
    });
  };
  const finalizeCancellationAfterTerminalCasMiss = async (): Promise<boolean> => {
    const currentJob = await getJobById(params.jobId);
    const leaseExpiresAtMs = currentJob?.lease_expires_at
      ? new Date(currentJob.lease_expires_at).getTime()
      : Number.NaN;
    if (
      !currentJob ||
      currentJob.status !== 'running' ||
      currentJob.last_worker_id !== fence.workerId ||
      currentJob.claim_generation !== fence.claimGeneration ||
      !Number.isFinite(leaseExpiresAtMs) ||
      leaseExpiresAtMs < Date.now() ||
      !currentJob.cancel_requested_at
    ) {
      leaseLost = true;
      return false;
    }

    const cancellationReason =
      currentJob.cancel_reason ??
      'Priority GPT cancellation won the terminal persistence race.';
    const terminalJob = await persistTerminal('cancelled', {
      output: null,
      errorMessage: cancellationReason,
      autonomyState: {
        priorityDirectExecution: {
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAtMs,
          cancellationWonTerminalRace: true
        }
      },
      metadata: {
        ...computeGptJobLifecycleDeadlines('cancelled'),
        cancelRequestedAt: new Date().toISOString(),
        cancelReason: cancellationReason
      }
    });
    if (!terminalJob) {
      leaseLost = true;
      return false;
    }

    recordCancellation(cancellationReason);
    return true;
  };
  const scheduleNextHeartbeat = (): void => {
    if (heartbeatStopped || cancellationController.signal.aborted) {
      return;
    }

    heartbeatTimeout = setTimeout(() => {
      void runHeartbeat();
    }, DIRECT_HEARTBEAT_INTERVAL_MS);
  };
  const runHeartbeat = async (): Promise<void> => {
    if (heartbeatStopped || cancellationController.signal.aborted) {
      return;
    }

    try {
      const updatedJob = await recordJobHeartbeat(params.jobId, {
        fence,
        leaseMs
      });

      if (heartbeatStopped || cancellationController.signal.aborted) {
        return;
      }

      if (!updatedJob) {
        leaseLost = true;
        abortExecution('GPT job lease lost or job completed elsewhere.');
        return;
      }

      if (updatedJob.cancel_requested_at) {
        abortExecution(updatedJob.cancel_reason ?? 'GPT job cancellation requested.');
        return;
      }
    } catch (error: unknown) {
      if (!heartbeatStopped) {
        logger.warn('gpt.priority_direct.heartbeat_failed', {
          jobId: params.jobId,
          workerId: params.workerId,
          error: resolveErrorMessage(error)
        });
      }
    }

    scheduleNextHeartbeat();
  };

  try {
    fence = createClaimedJobFence(params.workerId, params.claimGeneration);
    fenceReady = true;
    const parsedGptJobInput = parseQueuedGptJobInput(params.rawInput ?? {});
    if (!parsedGptJobInput.ok) {
      const terminalJob = await persistTerminal(
        'failed',
        {
          output: null,
          errorMessage: `Invalid GPT job.input: ${parsedGptJobInput.error}`,
          autonomyState: {
            priorityDirectExecution: {
              completedAt: new Date().toISOString(),
              failure: 'invalid_input'
            }
          },
          metadata: computeGptJobLifecycleDeadlines('failed')
        }
      );
      if (!terminalJob) {
        if (await finalizeCancellationAfterTerminalCasMiss()) {
          return;
        }
        params.requestLogger?.warn?.('gpt.priority_direct.lease_lost', {
          jobId: params.jobId,
          workerId: params.workerId,
          durationMs: Date.now() - startedAtMs
        });
      }
      return;
    }

    const {
      gptId,
      body,
      prompt,
      requestId,
      traceId,
      correlationId,
      bypassIntentRouting,
      backstageMutationAdmission,
    } = parsedGptJobInput.value;
    const preflightJob = await recordJobHeartbeat(params.jobId, {
      fence,
      leaseMs
    });
    if (!preflightJob) {
      leaseLost = true;
      params.requestLogger?.warn?.('gpt.priority_direct.lease_lost', {
        jobId: params.jobId,
        workerId: params.workerId,
        durationMs: Date.now() - startedAtMs,
        phase: 'preflight'
      });
      return;
    }

    if (preflightJob.cancel_requested_at) {
      const terminalJob = await persistTerminal(
        'cancelled',
        {
          output: null,
          errorMessage:
            preflightJob.cancel_reason ??
            'Job cancellation requested before priority GPT execution started.',
          autonomyState: {
            priorityDirectExecution: {
              completedAt: new Date().toISOString(),
              cancelledBeforeStart: true
            }
          },
          metadata: {
            ...computeGptJobLifecycleDeadlines('cancelled'),
            cancelRequestedAt: new Date().toISOString(),
            cancelReason: preflightJob.cancel_reason ?? 'Priority GPT direct execution cancelled.'
          }
        }
      );
      if (!terminalJob) {
        leaseLost = true;
        params.requestLogger?.warn?.('gpt.priority_direct.lease_lost', {
          jobId: params.jobId,
          workerId: params.workerId,
          durationMs: Date.now() - startedAtMs
        });
      } else {
        recordCancellation(
          preflightJob.cancel_reason ??
          'Job cancellation requested before priority GPT execution started.'
        );
      }
      return;
    }

    scheduleNextHeartbeat();
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
    const aiExecutionContext = createAiExecutionContext({
      sourceType: 'job',
      sourceName: 'gpt',
      requestId: requestId ?? correlationId ?? params.jobId,
      traceId: traceId ?? correlationId ?? requestId,
      jobId: params.jobId,
      budget: {
        maxCalls: 24
      }
    });
    const envelope = await runWithAiExecutionContext(aiExecutionContext, () => routeGptRequest({
      gptId,
      body: hydrateQueuedGptBodyPrompt(body, prompt),
      requestId,
      traceId: traceId ?? correlationId ?? requestId ?? null,
      logger: routeLogger,
      bypassIntentRouting,
      runtimeExecutionMode: 'background',
      parentAbortSignal: cancellationController.signal,
      enforceQueuedBackstageMutationAdmission: true,
      queuedBackstageMutationAdmission: backstageMutationAdmission,
    }));

    stopHeartbeat();
    if (cancellationController.signal.aborted) {
      const reason = cancellationController.signal.reason;
      throw reason instanceof Error
        ? reason
        : createAbortError('GPT job cancellation requested.');
    }

    if (!envelope.ok) {
      const errorMessage = `${envelope.error.code}: ${envelope.error.message}`;
      const terminalJob = await persistTerminal(
        'failed',
        {
          output: envelope,
          errorMessage,
          autonomyState: {
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
          metadata: computeGptJobLifecycleDeadlines('failed')
        }
      );
      if (!terminalJob) {
        if (await finalizeCancellationAfterTerminalCasMiss()) {
          return;
        }
        params.requestLogger?.warn?.('gpt.priority_direct.lease_lost', {
          jobId: params.jobId,
          workerId: params.workerId,
          durationMs: Date.now() - startedAtMs
        });
        return;
      }
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

    const terminalJob = await persistTerminal(
      'completed',
      {
        output: envelope,
        errorMessage: null,
        autonomyState: {
          priorityDirectExecution: {
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAtMs
          }
        },
        metadata: computeGptJobLifecycleDeadlines('completed')
      }
    );
    if (!terminalJob) {
      if (await finalizeCancellationAfterTerminalCasMiss()) {
        return;
      }
      params.requestLogger?.warn?.('gpt.priority_direct.lease_lost', {
        jobId: params.jobId,
        workerId: params.workerId,
        durationMs: Date.now() - startedAtMs
      });
      return;
    }
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
    stopHeartbeat();
    if (!fenceReady) {
      throw error;
    }

    const errorMessage = resolveErrorMessage(error);
    const aborted = isAbortError(error);
    if (leaseLost) {
      params.requestLogger?.warn?.('gpt.priority_direct.lease_lost', {
        jobId: params.jobId,
        workerId: params.workerId,
        durationMs: Date.now() - startedAtMs,
        error: errorMessage
      });
      return;
    }

    const terminalJob = await persistTerminal(
      aborted ? 'cancelled' : 'failed',
      {
        output: null,
        errorMessage,
        autonomyState: {
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
        metadata: {
          ...computeGptJobLifecycleDeadlines(aborted ? 'cancelled' : 'failed'),
          ...(aborted
            ? {
                cancelRequestedAt: new Date().toISOString(),
                cancelReason: errorMessage
              }
            : {})
        }
      }
    );
    if (!terminalJob) {
      if (!aborted && await finalizeCancellationAfterTerminalCasMiss()) {
        return;
      }
      leaseLost = true;
      params.requestLogger?.warn?.('gpt.priority_direct.lease_lost', {
        jobId: params.jobId,
        workerId: params.workerId,
        durationMs: Date.now() - startedAtMs,
        error: errorMessage
      });
      return;
    }
    if (aborted) {
      recordCancellation(errorMessage);
      return;
    }
    params.requestLogger?.warn?.('gpt.priority_direct.failed', {
      jobId: params.jobId,
      workerId: params.workerId,
      durationMs: Date.now() - startedAtMs,
      error: errorMessage
    });
  } finally {
    stopHeartbeat();
    params.slot.release();
  }
}

import { EventEmitter } from 'events';
import { runThroughBrain, type TrinityResult } from "@core/logic/trinity.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { getConfig } from "@platform/runtime/unifiedConfig.js";
import { config as runtimeConfig } from "@platform/runtime/config.js";
import { getEnvNumber, getEnv } from "@platform/runtime/env.js";
import { requireOpenAIClientOrAdapter } from "@services/openai/clientBridge.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { acquireExecutionLock } from "@services/safety/executionLock.js";
import { emitSafetyAuditEvent } from "@services/safety/auditEvents.js";
import { interpreterSupervisor } from "@services/safety/interpreterSupervisor.js";
import { activateUnsafeCondition, incrementWorkerFailure } from "@services/safety/runtimeState.js";
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import type { CognitiveDomain } from '@shared/types/cognitiveDomain.js';

// ✅ Environment setup
// Use config layer for env access (adapter boundary pattern)
const workerCountEnv = getEnv('WORKER_COUNT') || "4";
const workerModelEnv = getEnv('WORKER_MODEL') || getEnv('AI_MODEL') || "gpt-4o";
// Set process.env for backward compatibility (runtime state modification is acceptable)
process.env.WORKER_COUNT = workerCountEnv;
process.env.WORKER_MODEL = workerModelEnv;

// Environment configuration
const config = getConfig();
export const workerSettings = {
  runWorkers: config.runWorkers,
  count: getEnvNumber('WORKER_COUNT', 4),
  model: workerModelEnv
};

// Worker runtime bookkeeping
interface WorkerRuntimeState {
  started: boolean;
  startedAt?: string;
  workerIds: string[];
  totalDispatched: number;
  lastDispatchAt?: string;
  lastInputPreview?: string;
  lastResult?: WorkerResult | null;
  lastError?: string | null;
}

/**
 * Structured worker dispatch request for the in-process runtime.
 *
 * Purpose:
 * - Preserve task metadata so direct worker dispatch uses the same Trinity routing hints as queued jobs.
 *
 * Inputs/outputs:
 * - Input: prompt plus optional session, audit, and routing metadata.
 * - Output: normalized worker request consumed by the task queue.
 *
 * Edge case behavior:
 * - `sourceEndpoint` defaults later during execution when omitted.
 */
export interface WorkerDispatchRequest {
  input: string;
  sessionId?: string;
  overrideAuditSafe?: string;
  cognitiveDomain?: CognitiveDomain;
  sourceEndpoint?: string;
}

/**
 * Worker dispatch options including retry metadata.
 *
 * Purpose:
 * - Allow callers to combine Trinity routing hints with queue retry controls.
 *
 * Inputs/outputs:
 * - Input: worker request metadata plus retry configuration.
 * - Output: normalized dispatch options for `dispatchArcanosTask`.
 *
 * Edge case behavior:
 * - Retry settings fall back to runtime defaults when omitted.
 */
export interface WorkerDispatchOptions {
  sessionId?: string;
  overrideAuditSafe?: string;
  cognitiveDomain?: CognitiveDomain;
  sourceEndpoint?: string;
  attempts?: number;
  backoffMs?: number;
}

export interface WorkerRuntimeStatus {
  enabled: boolean;
  model: string;
  configuredCount: number;
  started: boolean;
  startedAt?: string;
  activeListeners: number;
  workerIds: string[];
  totalDispatched: number;
  lastDispatchAt?: string;
  lastInputPreview?: string;
  lastResult?: WorkerResult | null;
  lastError?: string;
}

const runtimeState: WorkerRuntimeState = {
  started: false,
  workerIds: [],
  totalDispatched: 0,
  lastResult: null,
  lastError: null
};

// Simple task queue based on EventEmitter with retry & backoff
export class WorkerTaskQueue extends EventEmitter {
  register(task: (request: WorkerDispatchRequest) => Promise<WorkerResult>): void {
    this.on('task', task);
  }

  async dispatch(
    request: WorkerDispatchRequest,
    options: { attempts?: number; backoffMs?: number } = {}
  ): Promise<WorkerResult[]> {
    const listeners = this.listeners('task');
    const { attempts = 3, backoffMs = 1000 } = options;
    const results: WorkerResult[] = [];
    const inputPreview = request.input.slice(0, 120);

    for (const listener of listeners) {
      let attempt = 0;
      let delay = backoffMs;
      while (attempt < attempts) {
        try {
          const result = await (listener as (request: WorkerDispatchRequest) => Promise<WorkerResult>)(request);
          results.push(result);
          logger.info('[WORKER] Task completed', { inputPreview });
          break;
        } catch (err) {
          attempt++;
          if (attempt >= attempts) {
            const errorMessage = resolveErrorMessage(err);
            logger.error('[WORKER] Task failed after max retries', {
              inputPreview,
              error: errorMessage
            });
            results.push({ error: errorMessage });
          } else {
            logger.warn(`[WORKER] Task failed - retrying in ${delay}ms`, {
              attempt,
              inputPreview,
              error: resolveErrorMessage(err)
            });
            await new Promise(res => {
              const timeout = setTimeout(res, delay);
              // Allow process to exit if this is the only pending timer
              if (typeof timeout.unref === 'function') timeout.unref();
            });
            delay *= 2;
          }
        }
      }
    }

    return results;
  }
}

export const workerTaskQueue = new WorkerTaskQueue();
export type WorkerResult = Partial<TrinityResult> & {
  error?: string;
  workerId?: string;
};

function normalizeWorkerDispatchRequest(
  input: string,
  options: WorkerDispatchOptions = {}
): {
  request: WorkerDispatchRequest;
  retry: { attempts?: number; backoffMs?: number };
} {
  return {
    request: {
      input,
      sessionId: options.sessionId,
      overrideAuditSafe: options.overrideAuditSafe,
      cognitiveDomain: options.cognitiveDomain,
      sourceEndpoint: options.sourceEndpoint
    },
    retry: {
      attempts: options.attempts,
      backoffMs: options.backoffMs
    }
  };
}

/**
 * Execute one in-process worker task through the Trinity brain.
 *
 * Purpose:
 * - Ensure direct worker dispatch uses the same backend AI pipeline as queued `jobRunner` execution.
 *
 * Inputs/outputs:
 * - Input: structured worker dispatch request.
 * - Output: Trinity result or a structured worker error.
 *
 * Edge case behavior:
 * - Returns `{ error }` when the OpenAI adapter is unavailable.
 */
export async function workerTask(request: WorkerDispatchRequest): Promise<WorkerResult> {
  let client;
  try {
    ({ client } = requireOpenAIClientOrAdapter('OpenAI adapter unavailable'));
  } catch {
    return { error: 'OpenAI adapter unavailable' };
  }

  const runtimeBudget = createRuntimeBudget();
  return runThroughBrain(
    client,
    request.input,
    request.sessionId,
    request.overrideAuditSafe,
    {
      cognitiveDomain: request.cognitiveDomain,
      sourceEndpoint: request.sourceEndpoint || 'worker.dispatch'
    },
    runtimeBudget
  );
}

// ✅ Worker startup
export interface WorkerBootstrapSummary {
  started: boolean;
  alreadyRunning: boolean;
  runWorkers: boolean;
  workerCount: number;
  workerIds: string[];
  model: string;
  startedAt?: string;
  message: string;
}

function createWorkerHandler(workerId: string) {
  return async (request: WorkerDispatchRequest): Promise<WorkerResult> => {
    const cycleId = interpreterSupervisor.beginCycle(`worker:${workerId}`, {
      category: 'worker',
      metadata: {
        source: 'worker-task-queue'
      }
    });
    logger.info('[WORKER] Dispatching task', {
      workerId,
      inputPreview: request.input.slice(0, 120),
      sourceEndpoint: request.sourceEndpoint || 'worker.dispatch'
    });

    try {
      interpreterSupervisor.heartbeat(cycleId);
      const result = await workerTask(request);
      interpreterSupervisor.heartbeat(cycleId);
      interpreterSupervisor.completeCycle(cycleId);

      logger.info('[WORKER] Task processed', {
        workerId,
        activeModel: result.activeModel,
        error: result.error
      });

      return { ...result, workerId };
    } catch (error) {
      const message = resolveErrorMessage(error);
      interpreterSupervisor.failCycle(cycleId, message);
      throw error;
    }
  };
}

function startWorkersUnsafe(force = false): WorkerBootstrapSummary {
  if (!workerSettings.runWorkers && !force) {
    return {
      started: false,
      alreadyRunning: false,
      runWorkers: false,
      workerCount: 0,
      workerIds: [],
      model: workerSettings.model,
      message: 'RUN_WORKERS disabled; workers not started.'
    };
  }

  if (runtimeState.started && !force) {
    return {
      started: false,
      alreadyRunning: true,
      runWorkers: workerSettings.runWorkers,
      workerCount: runtimeState.workerIds.length,
      workerIds: runtimeState.workerIds,
      model: workerSettings.model,
      startedAt: runtimeState.startedAt,
      message: 'Workers already running.'
    };
  }

  // Reset existing listeners when forcing a restart
  if (force && runtimeState.started) {
    workerTaskQueue.removeAllListeners('task');
    runtimeState.workerIds = [];
  }

  for (let i = 0; i < workerSettings.count; i++) {
    const workerId = `arcanos-worker-${i + 1}`;
    logger.info('[WORKER] Starting worker', { workerId, model: workerSettings.model });
    workerTaskQueue.register(createWorkerHandler(workerId));
    runtimeState.workerIds.push(workerId);
  }

  runtimeState.started = true;
  runtimeState.startedAt = new Date().toISOString();

  return {
    started: true,
    alreadyRunning: false,
    runWorkers: true,
    workerCount: runtimeState.workerIds.length,
    workerIds: runtimeState.workerIds,
    model: workerSettings.model,
    startedAt: runtimeState.startedAt,
    message: 'Workers started successfully.'
  };
}

export async function startWorkers(force = false): Promise<WorkerBootstrapSummary> {
  const lock = await acquireExecutionLock('worker-runtime:start');
  //audit Assumption: worker runtime spawn/restart must be single-active; failure risk: duplicate listeners and double execution; expected invariant: lock collision suppresses duplicate start; handling strategy: return duplicate-suppressed summary.
  if (!lock) {
    emitSafetyAuditEvent({
      event: 'worker_start_duplicate_suppressed',
      severity: 'warn',
      details: {
        force
      }
    });
    return {
      started: false,
      alreadyRunning: runtimeState.started,
      runWorkers: workerSettings.runWorkers,
      workerCount: runtimeState.workerIds.length,
      workerIds: runtimeState.workerIds,
      model: workerSettings.model,
      startedAt: runtimeState.startedAt,
      message: 'Worker start suppressed by execution lock.'
    };
  }

  try {
    //audit Assumption: repeated forced restarts inside threshold window indicate unstable worker runtime; failure risk: restart storm and conflicting state writes; expected invariant: threshold breach blocks further restarts; handling strategy: activate unsafe condition and fail closed.
    if (force) {
      const restartCounter = incrementWorkerFailure(
        'worker-runtime:start',
        runtimeConfig.safety.workerRestartThreshold,
        runtimeConfig.safety.workerRestartWindowMs
      );
      if (restartCounter.exceeded) {
        activateUnsafeCondition({
          code: 'WORKER_RESTART_THRESHOLD',
          message: 'Worker restart threshold exceeded',
          metadata: {
            count: restartCounter.count,
            threshold: runtimeConfig.safety.workerRestartThreshold
          }
        });
        return {
          started: false,
          alreadyRunning: runtimeState.started,
          runWorkers: workerSettings.runWorkers,
          workerCount: runtimeState.workerIds.length,
          workerIds: runtimeState.workerIds,
          model: workerSettings.model,
          startedAt: runtimeState.startedAt,
          message: 'Worker restart threshold exceeded; execution blocked.'
        };
      }
    }

    return startWorkersUnsafe(force);
  } finally {
    await lock.release();
  }
}

export async function dispatchArcanosTask(
  input: string,
  options: WorkerDispatchOptions = {}
): Promise<WorkerResult[]> {
  const normalizedDispatch = normalizeWorkerDispatchRequest(input, options);
  const inputPreview = normalizedDispatch.request.input.slice(0, 120);
  logger.info('[WORKER] Incoming dispatch', { inputPreview });

  const bootstrap = await startWorkers();

  let results: WorkerResult[];

  if (!bootstrap.runWorkers) {
    // RUN_WORKERS disabled; execute synchronously via core logic
    const directResult = await workerTask(normalizedDispatch.request);
    results = [{ ...directResult, workerId: 'arcanos-core-direct' }];
  } else {
    results = await workerTaskQueue.dispatch(normalizedDispatch.request, normalizedDispatch.retry);
    if (results.length === 0) {
      const fallbackResult = await workerTask(normalizedDispatch.request);
      results = [{ ...fallbackResult, workerId: 'arcanos-core-direct' }];
    }
  }

  runtimeState.totalDispatched += results.length;
  runtimeState.lastDispatchAt = new Date().toISOString();
  runtimeState.lastInputPreview = inputPreview;

  const primaryResult = results[0];
  runtimeState.lastResult = primaryResult ?? null;
  runtimeState.lastError = primaryResult?.error ?? null;

  return results;
}

export function getWorkerRuntimeStatus(): WorkerRuntimeStatus {
  return {
    enabled: workerSettings.runWorkers,
    model: workerSettings.model,
    configuredCount: workerSettings.count,
    started: runtimeState.started,
    startedAt: runtimeState.startedAt,
    activeListeners: workerTaskQueue.listenerCount('task'),
    workerIds: runtimeState.workerIds,
    totalDispatched: runtimeState.totalDispatched,
    lastDispatchAt: runtimeState.lastDispatchAt,
    lastInputPreview: runtimeState.lastInputPreview,
    lastResult: runtimeState.lastResult ?? undefined,
    lastError: runtimeState.lastError ?? undefined
  };
}

if (workerSettings.runWorkers) {
  void startWorkers();
}

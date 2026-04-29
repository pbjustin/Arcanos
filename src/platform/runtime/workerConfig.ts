import { EventEmitter } from 'events';
import type { TrinityResult } from "@core/logic/trinity.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { getConfig, resolveWorkerRuntimeMode } from "@platform/runtime/unifiedConfig.js";
import { config as runtimeConfig } from "@platform/runtime/config.js";
import { getEnvNumber, getEnv } from "@platform/runtime/env.js";
import { requireOpenAIClientOrAdapter } from "@services/openai/clientBridge.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { acquireExecutionLock } from "@services/safety/executionLock.js";
import { emitSafetyAuditEvent } from "@services/safety/auditEvents.js";
import { interpreterSupervisor } from "@services/safety/interpreterSupervisor.js";
import { activateUnsafeCondition, incrementWorkerFailure } from "@services/safety/runtimeState.js";
import type { CognitiveDomain } from '@shared/types/cognitiveDomain.js';
import { runWorkerTrinityPrompt } from '@workers/trinityWorkerPipeline.js';

// ✅ Environment setup
// Use config layer for env access (adapter boundary pattern)
const workerCountEnv = getEnv('WORKER_COUNT') || "4";
const workerModelEnv = getEnv('WORKER_MODEL') || getEnv('AI_MODEL') || "gpt-4o";
// Set process.env for backward compatibility (runtime state modification is acceptable)
process.env.WORKER_COUNT = workerCountEnv;
process.env.WORKER_MODEL = workerModelEnv;

// Environment configuration
const config = getConfig();
const workerRuntimeMode = resolveWorkerRuntimeMode();
export const workerSettings = {
  runWorkers: config.runWorkers,
  count: getEnvNumber('WORKER_COUNT', 4),
  model: workerModelEnv
};

if (workerRuntimeMode.requestedRunWorkers && !workerRuntimeMode.resolvedRunWorkers) {
  logger.warn('[WORKER] In-process worker startup suppressed for this service role', {
    module: 'core',
    serviceName: workerRuntimeMode.railwayServiceName,
    processKind: workerRuntimeMode.processKind,
    reason: workerRuntimeMode.reason
  });
}

// Worker runtime bookkeeping
interface WorkerRuntimeState {
  started: boolean;
  startedAt?: string;
  workerIds: string[];
  workerHandlers: Map<string, (request: WorkerDispatchRequest) => Promise<WorkerResult>>;
  surgeWorkerSequence: number;
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
  maxActiveWorkers: number;
  surgeWorkerCount: number;
  started: boolean;
  dispatcherStarted?: boolean;
  startedAt?: string;
  activeListeners: number;
  workerIds: string[];
  totalDispatched: number;
  lastPollAt?: string;
  lastClaimAttemptAt?: string;
  lastClaimResult?: string;
  disabledReason?: string | null;
  lastDispatchAt?: string;
  lastInputPreview?: string;
  lastResult?: WorkerResult | null;
  lastError?: string;
}

const runtimeState: WorkerRuntimeState = {
  started: false,
  workerIds: [],
  workerHandlers: new Map(),
  surgeWorkerSequence: 0,
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

export interface WorkerScaleUpResult {
  supported: boolean;
  applied: boolean;
  deltaRequested: number;
  deltaApplied: number;
  activeWorkerCount: number;
  maxActiveWorkers: number;
  workerIds: string[];
  message: string;
}

export interface WorkerRecycleResult {
  supported: boolean;
  applied: boolean;
  workerId: string;
  activeWorkerCount: number;
  workerIds: string[];
  message: string;
}

function getMaxActiveWorkers(): number {
  return Math.max(
    workerSettings.count,
    workerSettings.count + Math.max(0, config.predictiveScaleUpMaxExtraWorkers ?? 2)
  );
}

function registerWorkerHandler(workerId: string): void {
  if (runtimeState.workerHandlers.has(workerId)) {
    return;
  }

  const handler = createWorkerHandler(workerId);
  runtimeState.workerHandlers.set(workerId, handler);
  workerTaskQueue.register(handler);
  if (!runtimeState.workerIds.includes(workerId)) {
    runtimeState.workerIds.push(workerId);
  }
}

function unregisterWorkerHandler(workerId: string): boolean {
  const handler = runtimeState.workerHandlers.get(workerId);
  if (!handler) {
    return false;
  }

  workerTaskQueue.off('task', handler);
  runtimeState.workerHandlers.delete(workerId);
  runtimeState.workerIds = runtimeState.workerIds.filter((candidateId) => candidateId !== workerId);
  return true;
}

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

  return runWorkerTrinityPrompt(client, {
    prompt: request.input,
    sessionId: request.sessionId,
    overrideAuditSafe: request.overrideAuditSafe,
    cognitiveDomain: request.cognitiveDomain,
    sourceEndpoint: request.sourceEndpoint
  });
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

function buildWorkersDisabledSummary(): WorkerBootstrapSummary {
  const message =
    workerRuntimeMode.reason === 'process_kind_web'
      ? 'RUN_WORKERS disabled for explicit web process role; workers not started.'
      : 'RUN_WORKERS disabled; workers not started.';

  logger.warn('[worker-runtime] enabled/disabled reason', {
    module: 'worker-runtime',
    enabled: false,
    disabledReason: message,
    processKind: workerRuntimeMode.processKind,
    requestedRunWorkers: workerRuntimeMode.requestedRunWorkers
  });

  return {
    started: false,
    alreadyRunning: false,
    runWorkers: false,
    workerCount: 0,
    workerIds: [],
    model: workerSettings.model,
    message
  };
}

function createWorkerHandler(workerId: string) {
  return async (request: WorkerDispatchRequest): Promise<WorkerResult> => {
    logger.info('[WORKER] Dispatching task', {
      workerId,
      inputPreview: request.input.slice(0, 120),
      sourceEndpoint: request.sourceEndpoint || 'worker.dispatch'
    });

    const result = await interpreterSupervisor.runSupervisedCycle(
      `worker:${workerId}`,
      async () => {
        return workerTask(request);
      },
      {
        category: 'worker',
        metadata: {
          source: 'worker-task-queue'
        }
      }
    );

    logger.info('[WORKER] Task processed', {
      workerId,
      activeModel: result.activeModel,
      error: result.error
    });

    return { ...result, workerId };
  };
}

function startWorkersUnsafe(force = false): WorkerBootstrapSummary {
  if (!workerSettings.runWorkers) {
    return buildWorkersDisabledSummary();
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
    runtimeState.workerHandlers.clear();
  }

  for (let i = 0; i < workerSettings.count; i++) {
    const workerId = `arcanos-worker-${i + 1}`;
    logger.info('[WORKER] Starting worker', { workerId, model: workerSettings.model });
    registerWorkerHandler(workerId);
  }

  runtimeState.started = true;
  runtimeState.startedAt = new Date().toISOString();
  logger.info('[worker-runtime] polling loop started', {
    module: 'worker-runtime',
    enabled: true,
    started: true,
    activeListeners: workerTaskQueue.listenerCount('task'),
    workerIds: runtimeState.workerIds
  });

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
  logger.info('[worker-runtime] start requested', {
    module: 'worker-runtime',
    force,
    enabled: workerSettings.runWorkers,
    configuredCount: workerSettings.count,
    processKind: workerRuntimeMode.processKind
  });
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
  const activeListeners = workerTaskQueue.listenerCount('task');
  const disabledReason = workerSettings.runWorkers
    ? null
    : workerRuntimeMode.reason === 'process_kind_web'
    ? 'RUN_WORKERS disabled for explicit web process role; workers not started.'
    : 'RUN_WORKERS disabled; workers not started.';

  return {
    enabled: workerSettings.runWorkers,
    model: workerSettings.model,
    configuredCount: workerSettings.count,
    maxActiveWorkers: getMaxActiveWorkers(),
    surgeWorkerCount: Math.max(0, runtimeState.workerIds.length - workerSettings.count),
    started: runtimeState.started,
    dispatcherStarted: runtimeState.started && activeListeners > 0,
    startedAt: runtimeState.startedAt,
    activeListeners,
    workerIds: runtimeState.workerIds,
    totalDispatched: runtimeState.totalDispatched,
    lastClaimResult: workerSettings.runWorkers ? undefined : 'disabled',
    disabledReason,
    lastDispatchAt: runtimeState.lastDispatchAt,
    lastInputPreview: runtimeState.lastInputPreview,
    lastResult: runtimeState.lastResult ?? undefined,
    lastError: runtimeState.lastError ?? undefined
  };
}

export async function scaleWorkersUp(delta = 1): Promise<WorkerScaleUpResult> {
  const normalizedDelta = Math.max(1, Math.trunc(delta));
  const lock = await acquireExecutionLock('worker-runtime:start');
  if (!lock) {
    return {
      supported: true,
      applied: false,
      deltaRequested: normalizedDelta,
      deltaApplied: 0,
      activeWorkerCount: runtimeState.workerIds.length,
      maxActiveWorkers: getMaxActiveWorkers(),
      workerIds: [...runtimeState.workerIds],
      message: 'Worker scale-up suppressed by execution lock.'
    };
  }

  try {
    if (!workerSettings.runWorkers) {
      return {
        supported: false,
        applied: false,
        deltaRequested: normalizedDelta,
        deltaApplied: 0,
        activeWorkerCount: runtimeState.workerIds.length,
        maxActiveWorkers: getMaxActiveWorkers(),
        workerIds: [...runtimeState.workerIds],
        message: 'RUN_WORKERS disabled; scale-up unsupported.'
      };
    }

    if (!runtimeState.started) {
      startWorkersUnsafe(false);
    }

    const maxActiveWorkers = getMaxActiveWorkers();
    const capacityRemaining = Math.max(0, maxActiveWorkers - runtimeState.workerIds.length);
    const deltaApplied = Math.min(normalizedDelta, capacityRemaining);

    for (let index = 0; index < deltaApplied; index += 1) {
      runtimeState.surgeWorkerSequence += 1;
      const workerId = `arcanos-worker-surge-${runtimeState.surgeWorkerSequence}`;
      logger.info('[WORKER] Scaling worker runtime', { workerId, model: workerSettings.model });
      registerWorkerHandler(workerId);
    }

    return {
      supported: true,
      applied: deltaApplied > 0,
      deltaRequested: normalizedDelta,
      deltaApplied,
      activeWorkerCount: runtimeState.workerIds.length,
      maxActiveWorkers,
      workerIds: [...runtimeState.workerIds],
      message:
        deltaApplied > 0
          ? `Scaled worker runtime by ${deltaApplied} listener(s).`
          : 'Worker runtime is already at predictive scale-up capacity.'
    };
  } finally {
    await lock.release();
  }
}

export async function recycleWorker(workerId: string): Promise<WorkerRecycleResult> {
  const normalizedWorkerId = workerId.trim();
  const lock = await acquireExecutionLock('worker-runtime:start');
  if (!lock) {
    return {
      supported: true,
      applied: false,
      workerId: normalizedWorkerId,
      activeWorkerCount: runtimeState.workerIds.length,
      workerIds: [...runtimeState.workerIds],
      message: 'Worker recycle suppressed by execution lock.'
    };
  }

  try {
    if (!workerSettings.runWorkers) {
      return {
        supported: false,
        applied: false,
        workerId: normalizedWorkerId,
        activeWorkerCount: runtimeState.workerIds.length,
        workerIds: [...runtimeState.workerIds],
        message: 'RUN_WORKERS disabled; targeted recycle unsupported.'
      };
    }

    if (!runtimeState.started) {
      startWorkersUnsafe(false);
    }

    if (!runtimeState.workerHandlers.has(normalizedWorkerId)) {
      return {
        supported: false,
        applied: false,
        workerId: normalizedWorkerId,
        activeWorkerCount: runtimeState.workerIds.length,
        workerIds: [...runtimeState.workerIds],
        message: `Worker ${normalizedWorkerId} is not managed by this runtime.`
      };
    }

    unregisterWorkerHandler(normalizedWorkerId);
    registerWorkerHandler(normalizedWorkerId);

    return {
      supported: true,
      applied: true,
      workerId: normalizedWorkerId,
      activeWorkerCount: runtimeState.workerIds.length,
      workerIds: [...runtimeState.workerIds],
      message: `Recycled worker ${normalizedWorkerId}.`
    };
  } finally {
    await lock.release();
  }
}

if (workerSettings.runWorkers) {
  void startWorkers().catch((error: unknown) => {
    logger.error(
      '[worker-runtime] startup failed',
      {
        module: 'worker-runtime',
        processKind: workerRuntimeMode.processKind,
        configuredCount: workerSettings.count
      },
      { errorMessage: resolveErrorMessage(error) },
      error instanceof Error ? error : undefined
    );
    setImmediate(() => {
      throw error;
    });
  });
}

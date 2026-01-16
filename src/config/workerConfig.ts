import { EventEmitter } from 'events';
import { getOpenAIClient, createGPT5Reasoning } from '../services/openai.js';
import { runARCANOS } from '../logic/arcanos.js';
import { logger } from '../utils/structuredLogging.js';
import { env } from '../utils/env.js';

// ✅ Environment setup
process.env.WORKER_COUNT = process.env.WORKER_COUNT || "4";
process.env.WORKER_MODEL = process.env.AI_MODEL || "gpt-4o"; // Use configured model with latest default

// Environment configuration
export const workerSettings = {
  runWorkers: env.RUN_WORKERS,
  count: parseInt(process.env.WORKER_COUNT || '4', 10),
  model: process.env.WORKER_MODEL || process.env.AI_MODEL || 'gpt-4o'
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
  register(task: (input: string) => Promise<WorkerResult>): void {
    this.on('task', task);
  }

  async dispatch(
    input: string,
    options: { attempts?: number; backoffMs?: number } = {}
  ): Promise<WorkerResult[]> {
    const listeners = this.listeners('task');
    const { attempts = 3, backoffMs = 1000 } = options;
    const results: WorkerResult[] = [];

    for (const listener of listeners) {
      let attempt = 0;
      let delay = backoffMs;
      while (attempt < attempts) {
        try {
          const result = await (listener as (input: string) => Promise<WorkerResult>)(input);
          results.push(result);
          logger.info('[WORKER] Task completed', { inputPreview: input.slice(0, 120) });
          break;
        } catch (err) {
          attempt++;
          if (attempt >= attempts) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            logger.error('[WORKER] Task failed after max retries', {
              inputPreview: input.slice(0, 120),
              error: errorMessage
            });
            results.push({ error: errorMessage });
          } else {
            logger.warn(`[WORKER] Task failed - retrying in ${delay}ms`, {
              attempt,
              inputPreview: input.slice(0, 120),
              error: err instanceof Error ? err.message : err
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

// ✅ GPT-5.1 reasoning function using centralized helper
export async function gpt5Reasoning(prompt: string): Promise<string> {
  const client = getOpenAIClient();
  if (!client) return '[Fallback: GPT-5.1 unavailable]';

  const result = await createGPT5Reasoning(
    client,
    prompt,
    'ARCANOS: Use GPT-5.1 for deep reasoning on every request. Return structured analysis only.'
  );

  if (result.error) {
    logger.warn('[WORKER] GPT-5.1 reasoning fallback triggered', {
      error: result.error
    });
  } else if (result.model) {
    logger.info('[WORKER] GPT-5.1 reasoning confirmed', {
      model: result.model
    });
  }

  return result.content;
}

// Use the return type of runARCANOS to keep compatibility
type ArcanosResult = Awaited<ReturnType<typeof runARCANOS>>;
export type WorkerResult = Partial<ArcanosResult> & {
  reasoning?: string;
  error?: string;
  requiresReasoning?: boolean;
  reasoningPrompt?: string;
  workerId?: string;
};

// ✅ ARCANOS core logic alias for compatibility with problem statement
export async function arcanosCoreLogic(input: string): Promise<WorkerResult> {
  const client = getOpenAIClient();
  if (!client) {
    return { error: 'OpenAI client unavailable' } as WorkerResult;
  }

  const logicOutput = await runARCANOS(client, input);
  
  // Transform the output to match problem statement structure
  const result: WorkerResult = {
    ...logicOutput,
    requiresReasoning: logicOutput.reasoningDelegation?.used || false,
    reasoningPrompt: logicOutput.reasoningDelegation?.delegatedQuery
  };

  return result;
}

// ✅ Worker main task
export async function workerTask(input: string): Promise<WorkerResult> {
  // Step 1: Run ARCANOS core logic
  const logicOutput = await arcanosCoreLogic(input);

  // Step 2: If reasoning is required, consult GPT-5.1
  if (logicOutput.requiresReasoning && logicOutput.reasoningPrompt) {
    const reasoning = await gpt5Reasoning(logicOutput.reasoningPrompt);
    return { ...logicOutput, reasoning };
  }

  return logicOutput;
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
  return async (input: string): Promise<WorkerResult> => {
    logger.info('[WORKER] Dispatching task', {
      workerId,
      inputPreview: input.slice(0, 120)
    });

    const result = await workerTask(input);

    logger.info('[WORKER] Task processed', {
      workerId,
      requiresReasoning: result.requiresReasoning,
      error: result.error
    });

    return { ...result, workerId };
  };
}

export function startWorkers(force = false): WorkerBootstrapSummary {
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

export async function dispatchArcanosTask(
  input: string,
  options: { attempts?: number; backoffMs?: number } = {}
): Promise<WorkerResult[]> {
  const inputPreview = input.slice(0, 120);
  logger.info('[WORKER] Incoming dispatch', { inputPreview });

  const bootstrap = startWorkers();

  let results: WorkerResult[];

  if (!bootstrap.runWorkers) {
    // RUN_WORKERS disabled; execute synchronously via core logic
    const directResult = await workerTask(input);
    results = [{ ...directResult, workerId: 'arcanos-core-direct' }];
  } else {
    results = await workerTaskQueue.dispatch(input, options);
    if (results.length === 0) {
      const fallbackResult = await workerTask(input);
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
  startWorkers();
}


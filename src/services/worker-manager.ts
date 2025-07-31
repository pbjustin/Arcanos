// Worker registration and dispatch utilities
// Adds name validation and per-worker dispatch locking

import { AIDispatcher } from './ai-dispatcher';

// Use a Set for active workers
const activeWorkers: Set<string> = new Set();
// Optional schedule callbacks per worker
const workerSchedules: Record<string, (task: any) => void> = {};

// Scoped dispatch locks per worker type
const dispatchLocks: Record<string, boolean> = {};

/** Validate worker name - only allow alphanumeric, underscore and hyphen */
export function isValidWorker(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

/**
 * Register a worker if valid and not already registered
 */
export interface WorkerOptions {
  service?: string;
  schedule?: (task: any) => void;
}

export function registerWorker(name: string, options: WorkerOptions = {}): void {
  if (!isValidWorker(name)) {
    console.warn(`Rejected worker: ${name}`);
    return;
  }
  if (activeWorkers.has(name)) return;
  activeWorkers.add(name);
  if (options.schedule) {
    workerSchedules[name] = options.schedule;
  }
  initializeWorker(name);
}

export function getWorkerSchedule(name: string): ((task: any) => void) | undefined {
  return workerSchedules[name];
}

/**
 * Initialize worker placeholder - extend as needed
 */
function initializeWorker(name: string): void {
  console.log(`[WORKER-MANAGER] Initializing worker ${name}`);
}

/**
 * Dispatch a worker job safely by preventing overlapping dispatches
 */
export async function safeDispatch(workerType: string): Promise<void> {
  if (dispatchLocks[workerType]) return;
  dispatchLocks[workerType] = true;
  try {
    await sendToFineTunedModel(workerType);
  } finally {
    dispatchLocks[workerType] = false;
  }
}

/**
 * Send dispatch information to the fine-tuned model
 */
async function sendToFineTunedModel(workerType: string): Promise<void> {
  const dispatcher = new AIDispatcher();
  await dispatcher.dispatch({ type: 'worker', payload: { worker: workerType } });
}


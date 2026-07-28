import { getJobById } from '@core/db/repositories/jobRepository.js';
import type { JobData } from '@core/db/schema.js';
import { sleep } from '@shared/sleep.js';
import {
  pollQueuedJobCompletion,
  resolveQueuedJobPollIntervalMs,
  resolveQueuedJobWaitForResultMs
} from '@services/queuedJobCompletionPolling.js';

export const DEFAULT_ASYNC_ASK_WAIT_FOR_RESULT_MS = 15_000;
export const MAX_ASYNC_ASK_WAIT_FOR_RESULT_MS = 30_000;
export const DEFAULT_ASYNC_ASK_WAIT_POLL_MS = 250;
export const MAX_ASYNC_ASK_WAIT_POLLS = 601;

export interface WaitForQueuedAskJobCompletionOptions {
  waitForResultMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface QueuedAskCompletionDependencies {
  getJobByIdFn?: typeof getJobById;
  sleepFn?: typeof sleep;
  nowFn?: () => number;
}

export type QueuedAskCompletionResult =
  | { state: 'completed'; job: JobData }
  | { state: 'failed'; job: JobData }
  | { state: 'pending'; job: JobData | null }
  | { state: 'missing'; job: null };

/**
 * Resolve the bounded wait window for async `/ask` completion.
 * Purpose: centralize the default hybrid queue-wait behavior for callers that want a fast result when available.
 * Inputs/outputs: accepts an optional request override and environment; returns a clamped millisecond duration.
 * Edge case behavior: non-finite or negative values fall back to defaults, and explicit `0` disables waiting.
 */
export function resolveAsyncAskWaitForResultMs(
  requestedWaitMs: number | undefined,
  env: NodeJS.ProcessEnv = process.env
): number {
  return resolveQueuedJobWaitForResultMs({
    requestedWaitMs,
    configuredWaitMs: env.ASK_ASYNC_WAIT_FOR_RESULT_MS,
    defaultWaitMs: DEFAULT_ASYNC_ASK_WAIT_FOR_RESULT_MS,
    maxWaitMs: MAX_ASYNC_ASK_WAIT_FOR_RESULT_MS
  });
}

/**
 * Resolve the poll interval used while waiting for async `/ask` completion.
 * Purpose: keep queue polling bounded and environment-configurable without duplicating clamp logic in route handlers.
 * Inputs/outputs: accepts an optional request override and environment; returns a positive poll interval in milliseconds.
 * Edge case behavior: invalid values fall back to defaults and the interval is clamped to 50-1000ms.
 */
export function resolveAsyncAskPollIntervalMs(
  requestedPollIntervalMs: number | undefined,
  env: NodeJS.ProcessEnv = process.env
): number {
  return resolveQueuedJobPollIntervalMs({
    requestedPollIntervalMs,
    configuredPollIntervalMs: env.ASK_ASYNC_WAIT_POLL_MS,
    defaultPollIntervalMs: DEFAULT_ASYNC_ASK_WAIT_POLL_MS
  });
}

function isQueuedAskJobTerminal(job: JobData): boolean {
  return job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
}

function mapQueuedAskJobObservation(job: JobData | null): QueuedAskCompletionResult {
  if (!job) {
    return {
      state: 'missing',
      job: null
    };
  }

  if (isQueuedAskJobTerminal(job)) {
    return {
      state: job.status === 'completed' ? 'completed' : 'failed',
      job
    };
  }

  return {
    state: 'pending',
    job
  };
}

/**
 * Wait briefly for one queued async `/ask` job to reach a terminal state.
 * Purpose: let the main `/ask` route return a completed result when the worker finishes quickly, while preserving the existing poll contract for slower jobs.
 * Inputs/outputs: accepts a queued job id, optional wait tuning, and injectable DB/time dependencies; returns the latest observable queue state.
 * Edge case behavior: missing jobs fail closed, aborts reject promptly, and non-terminal jobs return `pending` once either the time or independent poll bound expires.
 */
export async function waitForQueuedAskJobCompletion(
  jobId: string,
  options: WaitForQueuedAskJobCompletionOptions = {},
  dependencies: QueuedAskCompletionDependencies = {}
): Promise<QueuedAskCompletionResult> {
  const waitForResultMs = resolveAsyncAskWaitForResultMs(options.waitForResultMs);
  const pollIntervalMs = resolveAsyncAskPollIntervalMs(options.pollIntervalMs);
  const getJobByIdFn = dependencies.getJobByIdFn ?? getJobById;
  const sleepFn = dependencies.sleepFn ?? sleep;
  const nowFn = dependencies.nowFn ?? Date.now;

  return pollQueuedJobCompletion<JobData, QueuedAskCompletionResult>({
    jobId,
    waitForResultMs,
    pollIntervalMs,
    maxPolls: MAX_ASYNC_ASK_WAIT_POLLS,
    signal: options.signal,
    readJob: getJobByIdFn,
    sleepFn,
    nowFn,
    mapObservation: mapQueuedAskJobObservation,
    buildPendingObservation: job => ({ state: 'pending', job })
  });
}

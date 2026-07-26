import { getJobById } from '@core/db/repositories/jobRepository.js';
import type { JobData } from '@core/db/schema.js';
import { sleep } from '@shared/sleep.js';
import {
  pollQueuedJobCompletion,
  resolveQueuedJobPollIntervalMs,
  resolveQueuedJobWaitForResultMs
} from '@services/queuedJobCompletionPolling.js';

export const DEFAULT_ASYNC_GPT_WAIT_FOR_RESULT_MS = 3_500;
export const MAX_ASYNC_GPT_WAIT_FOR_RESULT_MS = 30_000;
export const DEFAULT_ASYNC_GPT_WAIT_POLL_MS = 250;
export const MAX_ASYNC_GPT_WAIT_POLLS = 601;

export interface WaitForQueuedGptJobCompletionOptions {
  waitForResultMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface QueuedGptCompletionDependencies {
  getJobByIdFn?: typeof getJobById;
  sleepFn?: typeof sleep;
  nowFn?: () => number;
}

export type QueuedGptCompletionResult =
  | { state: 'completed'; job: JobData }
  | { state: 'failed'; job: JobData }
  | { state: 'cancelled'; job: JobData }
  | { state: 'expired'; job: JobData }
  | { state: 'pending'; job: JobData | null }
  | { state: 'missing'; job: null };

async function getQueuedGptJobWithAbortPrecedence(
  jobId: string,
  getJobByIdFn: typeof getJobById,
  signal?: AbortSignal
): Promise<JobData | null> {
  try {
    return await getJobByIdFn(jobId);
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
}

/**
 * Resolve the bounded wait window for async `/gpt/:gptId` completion.
 * Purpose: keep hybrid queue-wait behavior centralized so fast worker completions can still return inline.
 * Inputs/outputs: accepts an optional request override and environment; returns a clamped millisecond duration.
 * Edge case behavior: explicit `0` disables waiting so callers can force immediate 202 responses.
 */
export function resolveAsyncGptWaitForResultMs(
  requestedWaitMs: number | undefined,
  env: NodeJS.ProcessEnv = process.env
): number {
  return resolveQueuedJobWaitForResultMs({
    requestedWaitMs,
    configuredWaitMs: env.GPT_ASYNC_WAIT_FOR_RESULT_MS,
    defaultWaitMs: DEFAULT_ASYNC_GPT_WAIT_FOR_RESULT_MS,
    maxWaitMs: MAX_ASYNC_GPT_WAIT_FOR_RESULT_MS
  });
}

/**
 * Resolve the poll interval used while waiting for async GPT completion.
 * Purpose: bound queue polling cost while keeping the wait path responsive for completed jobs.
 * Inputs/outputs: accepts an optional request override and environment; returns a positive poll interval in milliseconds.
 * Edge case behavior: invalid values fall back to defaults and clamp to 50-1000ms.
 */
export function resolveAsyncGptPollIntervalMs(
  requestedPollIntervalMs: number | undefined,
  env: NodeJS.ProcessEnv = process.env
): number {
  return resolveQueuedJobPollIntervalMs({
    requestedPollIntervalMs,
    configuredPollIntervalMs: env.GPT_ASYNC_WAIT_POLL_MS,
    defaultPollIntervalMs: DEFAULT_ASYNC_GPT_WAIT_POLL_MS
  });
}

function isQueuedGptJobTerminal(job: JobData): boolean {
  return (
    job.status === 'completed' ||
    job.status === 'failed' ||
    job.status === 'cancelled' ||
    job.status === 'expired'
  );
}

function mapQueuedGptJobObservation(job: JobData | null): QueuedGptCompletionResult {
  if (!job) {
    return {
      state: 'missing',
      job: null
    };
  }

  if (isQueuedGptJobTerminal(job)) {
    return {
      state:
        job.status === 'completed'
          ? 'completed'
          : job.status === 'cancelled'
          ? 'cancelled'
          : job.status === 'expired'
          ? 'expired'
          : 'failed',
      job
    };
  }

  return {
    state: 'pending',
    job
  };
}

/**
 * Wait briefly for one queued GPT job to reach a terminal state.
 * Purpose: let the route return the final GPT envelope when the worker finishes quickly, while preserving explicit polling for longer jobs.
 * Inputs/outputs: accepts a queued job id, optional wait tuning, and injectable DB/time dependencies; returns the latest observable queue state.
 * Edge case behavior: missing jobs fail closed, aborts reject promptly, and non-terminal jobs return `pending` once either the time or independent poll bound expires.
 */
export async function waitForQueuedGptJobCompletion(
  jobId: string,
  options: WaitForQueuedGptJobCompletionOptions = {},
  dependencies: QueuedGptCompletionDependencies = {}
): Promise<QueuedGptCompletionResult> {
  const waitForResultMs = resolveAsyncGptWaitForResultMs(options.waitForResultMs);
  const pollIntervalMs = resolveAsyncGptPollIntervalMs(options.pollIntervalMs);
  const getJobByIdFn = dependencies.getJobByIdFn ?? getJobById;
  const sleepFn = dependencies.sleepFn ?? sleep;
  const nowFn = dependencies.nowFn ?? Date.now;

  return pollQueuedJobCompletion<JobData, QueuedGptCompletionResult>({
    jobId,
    waitForResultMs,
    pollIntervalMs,
    maxPolls: MAX_ASYNC_GPT_WAIT_POLLS,
    signal: options.signal,
    readJob: currentJobId =>
      getQueuedGptJobWithAbortPrecedence(
        currentJobId,
        getJobByIdFn,
        options.signal
      ),
    sleepFn,
    nowFn,
    mapObservation: mapQueuedGptJobObservation,
    buildPendingObservation: job => ({ state: 'pending', job })
  });
}

import { getJobById } from '@core/db/repositories/jobRepository.js';
import type { JobData } from '@core/db/schema.js';
import { sleep } from '@shared/sleep.js';

export const DEFAULT_ASYNC_GPT_WAIT_FOR_RESULT_MS = 3_500;
export const MAX_ASYNC_GPT_WAIT_FOR_RESULT_MS = 15_000;
export const DEFAULT_ASYNC_GPT_WAIT_POLL_MS = 250;

export interface WaitForQueuedGptJobCompletionOptions {
  waitForResultMs?: number;
  pollIntervalMs?: number;
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

function readPositiveInteger(rawValue: string | undefined, fallbackValue: number): number {
  const parsedValue = rawValue ? Number(rawValue) : Number.NaN;
  return Number.isFinite(parsedValue) && parsedValue >= 0
    ? Math.trunc(parsedValue)
    : fallbackValue;
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
  const defaultWaitMs = readPositiveInteger(
    env.GPT_ASYNC_WAIT_FOR_RESULT_MS,
    DEFAULT_ASYNC_GPT_WAIT_FOR_RESULT_MS
  );
  const rawWaitMs = requestedWaitMs ?? defaultWaitMs;

  if (rawWaitMs === 0) {
    return 0;
  }

  const normalizedWaitMs = Number(rawWaitMs);
  if (!Number.isFinite(normalizedWaitMs) || normalizedWaitMs < 0) {
    return Math.min(MAX_ASYNC_GPT_WAIT_FOR_RESULT_MS, defaultWaitMs);
  }

  return Math.min(MAX_ASYNC_GPT_WAIT_FOR_RESULT_MS, Math.trunc(normalizedWaitMs));
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
  const defaultPollIntervalMs = readPositiveInteger(
    env.GPT_ASYNC_WAIT_POLL_MS,
    DEFAULT_ASYNC_GPT_WAIT_POLL_MS
  );
  const rawPollIntervalMs = requestedPollIntervalMs ?? defaultPollIntervalMs;
  const normalizedPollIntervalMs = Number(rawPollIntervalMs);

  if (!Number.isFinite(normalizedPollIntervalMs) || normalizedPollIntervalMs <= 0) {
    return defaultPollIntervalMs;
  }

  return Math.min(1_000, Math.max(50, Math.trunc(normalizedPollIntervalMs)));
}

function isQueuedGptJobTerminal(job: JobData): boolean {
  return (
    job.status === 'completed' ||
    job.status === 'failed' ||
    job.status === 'cancelled' ||
    job.status === 'expired'
  );
}

/**
 * Wait briefly for one queued GPT job to reach a terminal state.
 * Purpose: let the route return the final GPT envelope when the worker finishes quickly, while preserving explicit polling for longer jobs.
 * Inputs/outputs: accepts a queued job id, optional wait tuning, and injectable DB/time dependencies; returns the latest observable queue state.
 * Edge case behavior: missing jobs fail closed, and non-terminal jobs return `pending` once the bounded wait expires.
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

  if (waitForResultMs === 0) {
    return {
      state: 'pending',
      job: null
    };
  }

  const waitDeadlineMs = nowFn() + waitForResultMs;

  while (nowFn() <= waitDeadlineMs) {
    const job = await getJobByIdFn(jobId);

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

    const remainingWaitMs = waitDeadlineMs - nowFn();
    if (remainingWaitMs <= 0) {
      return {
        state: 'pending',
        job
      };
    }

    await sleepFn(Math.min(pollIntervalMs, remainingWaitMs));
  }

  const lastObservedJob = await getJobByIdFn(jobId);

  if (!lastObservedJob) {
    return {
      state: 'missing',
      job: null
    };
  }

  if (isQueuedGptJobTerminal(lastObservedJob)) {
    return {
      state:
        lastObservedJob.status === 'completed'
          ? 'completed'
          : lastObservedJob.status === 'cancelled'
          ? 'cancelled'
          : lastObservedJob.status === 'expired'
          ? 'expired'
          : 'failed',
      job: lastObservedJob
    };
  }

  return {
    state: 'pending',
    job: lastObservedJob
  };
}

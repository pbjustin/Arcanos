import { getJobById } from '@core/db/repositories/jobRepository.js';
import type { JobData } from '@core/db/schema.js';
import { sleep } from '@shared/sleep.js';

export const DEFAULT_ASYNC_ASK_WAIT_FOR_RESULT_MS = 15_000;
export const MAX_ASYNC_ASK_WAIT_FOR_RESULT_MS = 30_000;
export const DEFAULT_ASYNC_ASK_WAIT_POLL_MS = 250;

export interface WaitForQueuedAskJobCompletionOptions {
  waitForResultMs?: number;
  pollIntervalMs?: number;
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

function readPositiveInteger(
  rawValue: string | undefined,
  fallbackValue: number
): number {
  const parsedValue = rawValue ? Number(rawValue) : Number.NaN;
  return Number.isFinite(parsedValue) && parsedValue >= 0
    ? Math.trunc(parsedValue)
    : fallbackValue;
}

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
  const defaultWaitMs = readPositiveInteger(
    env.ASK_ASYNC_WAIT_FOR_RESULT_MS,
    DEFAULT_ASYNC_ASK_WAIT_FOR_RESULT_MS
  );
  const rawWaitMs = requestedWaitMs ?? defaultWaitMs;

  //audit Assumption: callers may deliberately disable the hybrid wait path with `0`; failure risk: forced waiting regresses existing fire-and-poll flows; expected invariant: `0` remains a valid opt-out; handling strategy: preserve zero before positive clamping.
  if (rawWaitMs === 0) {
    return 0;
  }

  const normalizedWaitMs = Number(rawWaitMs);
  if (!Number.isFinite(normalizedWaitMs) || normalizedWaitMs < 0) {
    return Math.min(MAX_ASYNC_ASK_WAIT_FOR_RESULT_MS, defaultWaitMs);
  }

  return Math.min(MAX_ASYNC_ASK_WAIT_FOR_RESULT_MS, Math.trunc(normalizedWaitMs));
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
  const defaultPollIntervalMs = readPositiveInteger(
    env.ASK_ASYNC_WAIT_POLL_MS,
    DEFAULT_ASYNC_ASK_WAIT_POLL_MS
  );
  const rawPollIntervalMs = requestedPollIntervalMs ?? defaultPollIntervalMs;
  const normalizedPollIntervalMs = Number(rawPollIntervalMs);

  if (!Number.isFinite(normalizedPollIntervalMs) || normalizedPollIntervalMs <= 0) {
    return defaultPollIntervalMs;
  }

  return Math.min(1_000, Math.max(50, Math.trunc(normalizedPollIntervalMs)));
}

function isQueuedAskJobTerminal(job: JobData): boolean {
  return job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
}

/**
 * Wait briefly for one queued async `/ask` job to reach a terminal state.
 * Purpose: let the main `/ask` route return a completed result when the worker finishes quickly, while preserving the existing poll contract for slower jobs.
 * Inputs/outputs: accepts a queued job id, optional wait tuning, and injectable DB/time dependencies; returns the latest observable queue state.
 * Edge case behavior: missing jobs fail closed, and non-terminal jobs return `pending` once the bounded wait window expires.
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

  //audit Assumption: some callers only want queue creation and explicit polling; failure risk: unnecessary DB churn after enqueue; expected invariant: zero wait bypasses polling entirely; handling strategy: short-circuit with `pending`.
  if (waitForResultMs === 0) {
    return {
      state: 'pending',
      job: null
    };
  }

  const waitDeadlineMs = nowFn() + waitForResultMs;

  while (nowFn() <= waitDeadlineMs) {
    const job = await getJobByIdFn(jobId);

    //audit Assumption: successfully enqueued jobs should remain visible until terminal or explicitly deleted; failure risk: callers misread a missing row as a long-running job; expected invariant: missing rows surface as an operational failure; handling strategy: fail closed with `missing`.
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

    const remainingWaitMs = waitDeadlineMs - nowFn();

    //audit Assumption: once the wait budget is exhausted the caller should resume explicit polling; failure risk: route blocks indefinitely on long jobs; expected invariant: the hybrid wait path remains bounded; handling strategy: return the last active job snapshot as `pending`.
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

  if (isQueuedAskJobTerminal(lastObservedJob)) {
    return {
      state: lastObservedJob.status === 'completed' ? 'completed' : 'failed',
      job: lastObservedJob
    };
  }

  return {
    state: 'pending',
    job: lastObservedJob
  };
}

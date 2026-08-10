import { computeGptJobLifecycleDeadlines } from '@shared/gpt/gptJobLifecycle.js';

export const DEFAULT_ASK_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_DAG_NODE_TERMINAL_RETENTION_MS = 60 * 60 * 1_000;
export const MIN_NON_GPT_TERMINAL_RETENTION_MS = 60 * 60 * 1_000;
export const MAX_NON_GPT_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface QueueJobLifecycleDeadlines {
  idempotencyUntil: string | null;
  retentionUntil: string | null;
}

function readBoundedDurationMs(
  rawValue: string | undefined,
  fallbackValue: number
): number {
  const parsedValue = rawValue ? Number(rawValue) : Number.NaN;
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallbackValue;
  }

  return Math.min(
    MAX_NON_GPT_TERMINAL_RETENTION_MS,
    Math.max(MIN_NON_GPT_TERMINAL_RETENTION_MS, Math.trunc(parsedValue))
  );
}

/**
 * Resolve the retention window for durable non-GPT queue results.
 *
 * Only completed or cancelled `ask` and `dag-node` rows are eligible. Failed
 * rows remain under the separate failed-job retention policy, and every other
 * job type remains outside this lifecycle.
 */
export function resolveNonGptTerminalRetentionWindowMs(
  jobType: string,
  status: string,
  env: NodeJS.ProcessEnv = process.env
): number {
  if (status !== 'completed' && status !== 'cancelled') {
    return 0;
  }

  if (jobType === 'ask') {
    return readBoundedDurationMs(
      env.QUEUE_ASK_TERMINAL_RETENTION_MS,
      DEFAULT_ASK_TERMINAL_RETENTION_MS
    );
  }

  if (jobType === 'dag-node') {
    return readBoundedDurationMs(
      env.QUEUE_DAG_NODE_TERMINAL_RETENTION_MS,
      DEFAULT_DAG_NODE_TERMINAL_RETENTION_MS
    );
  }

  return 0;
}

/**
 * Compute queue lifecycle deadlines through one shared policy seam.
 *
 * GPT delegates to its canonical lifecycle unchanged. Non-GPT retention is
 * deliberately positive-allowlisted and never manufactures an idempotency
 * deadline; any caller-supplied or persisted idempotency window remains
 * authoritative at the repository boundary.
 */
export function computeQueueJobLifecycleDeadlines(
  jobType: string,
  status: string,
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env
): QueueJobLifecycleDeadlines {
  if (jobType === 'gpt') {
    return computeGptJobLifecycleDeadlines(status, now, env);
  }

  const retentionWindowMs = resolveNonGptTerminalRetentionWindowMs(
    jobType,
    status,
    env
  );
  if (retentionWindowMs <= 0) {
    return {
      idempotencyUntil: null,
      retentionUntil: null
    };
  }

  return {
    idempotencyUntil: null,
    retentionUntil: new Date(now.getTime() + retentionWindowMs).toISOString()
  };
}

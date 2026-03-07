export interface JobRunnerRuntimeSettings {
  pollMs: number;
  idleBackoffMs: number;
  concurrency: number;
  baseWorkerId: string;
  statsWorkerId: string;
}

export interface JobRunnerSlotDefinition {
  slotIndex: number;
  slotNumber: number;
  workerId: string;
  statsWorkerId: string;
  isInspectorSlot: boolean;
}

function readPositiveIntegerEnvValue(
  rawValue: string | undefined,
  fallback: number
): number {
  const parsedValue = rawValue ? Number(rawValue) : Number.NaN;
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

/**
 * Resolve queue-worker runtime settings from the environment.
 * Purpose: centralize Railway worker polling and concurrency configuration in one pure helper.
 * Inputs/outputs: accepts an optional environment object and returns normalized runtime settings.
 * Edge case behavior: invalid or missing numeric env values fall back to safe positive defaults.
 */
export function resolveJobRunnerRuntimeSettings(
  env: NodeJS.ProcessEnv = process.env
): JobRunnerRuntimeSettings {
  //audit Assumption: explicit job-worker concurrency should override legacy worker-count settings; failure risk: accidental single-slot runtime despite configured worker fan-out; expected invariant: JOB_WORKER_CONCURRENCY wins, WORKER_COUNT remains a compatibility fallback, and runtime always resolves at least one consumer slot; handling strategy: normalize the env cascade in one place.
  const concurrency = readPositiveIntegerEnvValue(
    env.JOB_WORKER_CONCURRENCY,
    readPositiveIntegerEnvValue(env.WORKER_COUNT, 1)
  );
  const baseWorkerId =
    env.JOB_WORKER_ID?.trim() ||
    env.WORKER_ID?.trim() ||
    'async-queue';

  return {
    pollMs: readPositiveIntegerEnvValue(env.JOB_WORKER_POLL_MS, 250),
    idleBackoffMs: readPositiveIntegerEnvValue(env.JOB_WORKER_IDLE_BACKOFF_MS, 1_000),
    concurrency,
    baseWorkerId,
    statsWorkerId: env.JOB_WORKER_STATS_ID?.trim() || baseWorkerId
  };
}

/**
 * Build normalized queue-consumer slot definitions for one worker process.
 * Purpose: generate distinct worker ids for leases and snapshots while preserving a shared stats identity.
 * Inputs/outputs: accepts resolved runtime settings and returns one slot definition per consumer.
 * Edge case behavior: a single-slot runtime keeps the base worker id unchanged for backward compatibility.
 */
export function buildJobRunnerSlotDefinitions(
  runtimeSettings: JobRunnerRuntimeSettings
): JobRunnerSlotDefinition[] {
  return Array.from({ length: runtimeSettings.concurrency }, (_, slotIndex) => {
    const slotNumber = slotIndex + 1;
    const workerId =
      runtimeSettings.concurrency === 1
        ? runtimeSettings.baseWorkerId
        : `${runtimeSettings.baseWorkerId}-slot-${slotNumber}`;

    return {
      slotIndex,
      slotNumber,
      workerId,
      statsWorkerId: runtimeSettings.statsWorkerId,
      isInspectorSlot: slotIndex === 0
    };
  });
}

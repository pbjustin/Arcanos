const DEFAULT_PRIORITY_GPT_IDS = [
  'arcanos-core',
  'arcanos-audit',
  'arcanos-build',
  'arcanos-research',
  'arcanos-write',
  'arcanos-guide',
  'arcanos-sim',
  'arcanos-tracker',
  'arcanos-tutor',
  'arcanos-daemon',
  'core',
  'audit',
  'build',
  'research',
  'write',
  'guide',
  'sim',
  'tracker',
  'tutor'
] as const;

export const PRIORITY_GPT_JOB_PRIORITY = 0;
export const PRIORITY_QUEUE_LANE_MAX_PRIORITY = 10;
export const DEFAULT_PRIORITY_QUEUE_WEIGHT = 5;
export const DEFAULT_GPT_DIRECT_EXECUTION_THRESHOLD_MS = 8_000;
export const DEFAULT_GPT_WAIT_TIMEOUT_MS = 24_000;
export const DEFAULT_GPT_JOB_MAX_RETRIES = 1;
export const DEFAULT_PRIORITY_GPT_DIRECT_EXECUTION_CONCURRENCY = 1;

function normalizeId(value: string | null | undefined): string | null {
  const normalizedValue = value?.trim().toLowerCase();
  return normalizedValue && normalizedValue.length > 0 ? normalizedValue : null;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map(entry => normalizeId(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function readPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  options: { min?: number; max?: number } = {}
): number {
  const parsedValue = Number(env[name]);
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;

  if (!Number.isFinite(parsedValue) || parsedValue < min) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(parsedValue)));
}

function readNonNegativeInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  options: { max?: number } = {}
): number {
  const parsedValue = Number(env[name]);
  const max = options.max ?? Number.MAX_SAFE_INTEGER;

  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    return fallback;
  }

  return Math.min(max, Math.trunc(parsedValue));
}

export function getPriorityGptIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return Array.from(
    new Set([
      ...DEFAULT_PRIORITY_GPT_IDS,
      ...parseCsv(env.PRIORITY_GPT_IDS)
    ])
  );
}

export function isPriorityGpt(
  gptId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const normalizedGptId = normalizeId(gptId);
  if (!normalizedGptId) {
    return false;
  }

  return getPriorityGptIds(env).includes(normalizedGptId);
}

export function isPriorityQueueEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PRIORITY_QUEUE_ENABLED?.trim().toLowerCase() !== 'false';
}

export function resolvePriorityQueueWeight(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInteger(env, 'PRIORITY_QUEUE_WEIGHT', DEFAULT_PRIORITY_QUEUE_WEIGHT, {
    min: 1,
    max: 100
  });
}

export function resolveGptDirectExecutionThresholdMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  return readPositiveInteger(
    env,
    'GPT_DIRECT_EXECUTION_THRESHOLD_MS',
    DEFAULT_GPT_DIRECT_EXECUTION_THRESHOLD_MS,
    {
      min: 250,
      max: DEFAULT_GPT_WAIT_TIMEOUT_MS
    }
  );
}

export function resolveGptWaitTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInteger(env, 'GPT_WAIT_TIMEOUT_MS', DEFAULT_GPT_WAIT_TIMEOUT_MS, {
    min: 1_000,
    max: 120_000
  });
}

export function resolveGptJobMaxRetries(env: NodeJS.ProcessEnv = process.env): number {
  return readNonNegativeInteger(env, 'GPT_JOB_MAX_RETRIES', DEFAULT_GPT_JOB_MAX_RETRIES, {
    max: 10
  });
}

export function resolvePriorityGptDirectExecutionConcurrency(
  env: NodeJS.ProcessEnv = process.env
): number {
  return readPositiveInteger(
    env,
    'GPT_PRIORITY_DIRECT_EXECUTION_CONCURRENCY',
    DEFAULT_PRIORITY_GPT_DIRECT_EXECUTION_CONCURRENCY,
    {
      min: 1,
      max: 20
    }
  );
}

export function mapGptJobStatusToClientStatus(
  jobStatus: string | null | undefined
): 'queued' | 'running' | 'completed' | 'timeout' {
  switch (jobStatus) {
    case 'completed':
      return 'completed';
    case 'running':
      return 'running';
    case 'failed':
    case 'cancelled':
    case 'expired':
      return 'completed';
    case 'pending':
    default:
      return 'queued';
  }
}

export function isPriorityQueueLaneJob(job: {
  job_type?: string | null;
  priority?: number | string | null;
}): boolean {
  const priority = Number(job.priority ?? Number.NaN);
  return (
    job.job_type === 'gpt' &&
    Number.isFinite(priority) &&
    priority <= PRIORITY_QUEUE_LANE_MAX_PRIORITY
  );
}

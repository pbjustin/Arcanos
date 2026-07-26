const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_JOB_RETENTION_SECONDS = 3600;
const DEFAULT_MAX_COMPLETED_JOBS = 1000;
const DEFAULT_MAX_FAILED_JOBS = 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const DEFAULT_WORKER_STARTUP_TIMEOUT_MS = 30000;

function requireEnv(
  environment: NodeJS.ProcessEnv,
  name: string
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseIntegerEnv(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `Invalid ${name} value "${raw}". Expected an integer between ${min} and ${max}.`
    );
  }

  return value;
}

export function resolveRuntimeHttpConfig(
  environment: NodeJS.ProcessEnv
): Readonly<{ port: number }> {
  return Object.freeze({
    port: parseIntegerEnv(
      environment,
      "PORT",
      DEFAULT_HTTP_PORT,
      1,
      65535
    )
  });
}

export function resolveRuntimeQueueRetentionConfig(
  environment: NodeJS.ProcessEnv
): Readonly<{
  jobRetentionSeconds: number;
  maxCompletedJobs: number;
  maxFailedJobs: number;
}> {
  return Object.freeze({
    jobRetentionSeconds: parseIntegerEnv(
      environment,
      "AI_RUNTIME_JOB_RETENTION_SECONDS",
      DEFAULT_JOB_RETENTION_SECONDS,
      60,
      604800
    ),
    maxCompletedJobs: parseIntegerEnv(
      environment,
      "AI_RUNTIME_MAX_COMPLETED_JOBS",
      DEFAULT_MAX_COMPLETED_JOBS,
      1,
      100000
    ),
    maxFailedJobs: parseIntegerEnv(
      environment,
      "AI_RUNTIME_MAX_FAILED_JOBS",
      DEFAULT_MAX_FAILED_JOBS,
      1,
      100000
    )
  });
}

export function assertRuntimeWorkerProviderConfiguration(
  environment: NodeJS.ProcessEnv
): void {
  requireEnv(environment, "OPENAI_API_KEY");
}

export function resolveRuntimeShutdownConfig(
  environment: NodeJS.ProcessEnv
): Readonly<{ timeoutMs: number }> {
  return Object.freeze({
    timeoutMs: parseIntegerEnv(
      environment,
      "AI_RUNTIME_SHUTDOWN_TIMEOUT_MS",
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      1000,
      300000
    )
  });
}

export function resolveRuntimeWorkerStartupConfig(
  environment: NodeJS.ProcessEnv
): Readonly<{ timeoutMs: number }> {
  return Object.freeze({
    timeoutMs: parseIntegerEnv(
      environment,
      "AI_RUNTIME_WORKER_STARTUP_TIMEOUT_MS",
      DEFAULT_WORKER_STARTUP_TIMEOUT_MS,
      1000,
      300000
    )
  });
}

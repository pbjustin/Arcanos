const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_REDIS_PORT = 6379;
const DEFAULT_JOB_RETENTION_SECONDS = 3600;
const DEFAULT_MAX_COMPLETED_JOBS = 1000;
const DEFAULT_MAX_FAILED_JOBS = 1000;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseIntegerEnv(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = process.env[name];
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

export const runtimeEnv = Object.freeze({
  PORT: parseIntegerEnv("PORT", DEFAULT_HTTP_PORT, 1, 65535),
  REDIS_HOST: requireEnv("REDIS_HOST"),
  REDIS_PORT: parseIntegerEnv("REDIS_PORT", DEFAULT_REDIS_PORT, 1, 65535),
  OPENAI_API_KEY: requireEnv("OPENAI_API_KEY"),
  JOB_RETENTION_SECONDS: parseIntegerEnv(
    "AI_RUNTIME_JOB_RETENTION_SECONDS",
    DEFAULT_JOB_RETENTION_SECONDS,
    60,
    604800
  ),
  MAX_COMPLETED_JOBS: parseIntegerEnv(
    "AI_RUNTIME_MAX_COMPLETED_JOBS",
    DEFAULT_MAX_COMPLETED_JOBS,
    1,
    100000
  ),
  MAX_FAILED_JOBS: parseIntegerEnv(
    "AI_RUNTIME_MAX_FAILED_JOBS",
    DEFAULT_MAX_FAILED_JOBS,
    1,
    100000
  )
});


import type { JobName } from '../../jobs/index.js';

const OPENAI_KEY_ENV_PRIORITY = [
  'OPENAI_API_KEY',
  'RAILWAY_OPENAI_API_KEY',
  'API_KEY',
  'OPENAI_KEY'
] as const;

const OPENAI_BASE_URL_ENV_PRIORITY = [
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE_URL',
  'OPENAI_API_BASE'
] as const;

const OPENAI_KEY_PLACEHOLDERS = new Set([
  '',
  'your-openai-api-key-here',
  'your-openai-key-here'
]);

const SENSITIVE_KEY_HINTS = ['token', 'secret', 'password', 'authorization', 'apikey', 'api_key', 'connection'];
const SENSITIVE_VALUE_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{20,}\b/,
  /\bBearer\s+[a-zA-Z0-9._-]{12,}\b/i,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/,
  /\b(?:postgres|postgresql|mysql|mongodb):\/\/[^@\s]+:[^@\s]+@/i
];

const ALLOWED_JOB_TYPES: readonly JobName[] = [
  'OPENAI_COMPLETION',
  'OPENAI_EMBEDDING',
  'MEMORY_SET',
  'MEMORY_GET',
  'MEMORY_SYNC'
] as const;

/**
 * Worker OpenAI runtime configuration resolved from environment.
 */
export interface WorkerOpenAIConfig {
  apiKey: string | null;
  baseURL?: string;
  timeoutMs: number;
  maxRetries: number;
  defaultChatModel: string;
  defaultEmbeddingModel: string;
}

/**
 * Parsed worker job contract from environment.
 */
export interface WorkerJobContract {
  jobType: JobName | null;
  payload: unknown | null;
  payloadRaw: string | null;
  error?: string;
}

/**
 * Read a runtime env value as a trimmed string.
 *
 * @param key - Environment variable name.
 * @returns Trimmed value or undefined if unset/blank.
 */
export function readRuntimeEnvValue(key: string): string | undefined {
  const raw = process.env[key];
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse a positive integer env value with fallback default.
 *
 * @param key - Environment variable name.
 * @param fallback - Fallback integer when env is missing/invalid.
 * @returns Parsed positive integer.
 */
function parsePositiveIntEnv(key: string, fallback: number): number {
  const value = readRuntimeEnvValue(key);
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  //audit Assumption: timeout/retry env values should be positive integers; risk: NaN/negative causing unstable runtime behavior; invariant: safe positive integer output; handling: fallback default on invalid input.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve worker-side OpenAI configuration from centralized env access.
 *
 * @returns Worker OpenAI runtime configuration.
 */
export function resolveWorkerOpenAIConfig(): WorkerOpenAIConfig {
  let apiKey: string | null = null;

  for (const envName of OPENAI_KEY_ENV_PRIORITY) {
    const value = readRuntimeEnvValue(envName);
    if (!value) {
      continue;
    }
    //audit Assumption: placeholder keys should never initialize SDK clients; risk: false-positive key configuration; invariant: placeholders treated as missing; handling: skip placeholder values.
    if (OPENAI_KEY_PLACEHOLDERS.has(value.toLowerCase())) {
      continue;
    }
    apiKey = value;
    break;
  }

  let baseURL: string | undefined;
  for (const envName of OPENAI_BASE_URL_ENV_PRIORITY) {
    const value = readRuntimeEnvValue(envName);
    if (value) {
      baseURL = value;
      break;
    }
  }

  return {
    apiKey,
    baseURL,
    timeoutMs: parsePositiveIntEnv('WORKER_API_TIMEOUT_MS', 60000),
    maxRetries: parsePositiveIntEnv('OPENAI_MAX_RETRIES', 2),
    defaultChatModel: readRuntimeEnvValue('WORKER_OPENAI_MODEL') || readRuntimeEnvValue('OPENAI_MODEL') || 'gpt-4.1-mini',
    defaultEmbeddingModel: readRuntimeEnvValue('EMBEDDING_MODEL') || 'text-embedding-3-large'
  };
}

/**
 * Resolve worker job type and payload from the runtime contract.
 *
 * @returns Parsed worker job contract.
 */
export function resolveWorkerJobContract(): WorkerJobContract {
  const rawJobType = readRuntimeEnvValue('WORKER_JOB');
  const payloadRaw = readRuntimeEnvValue('WORKER_PAYLOAD') ?? null;

  //audit Assumption: worker runtime may start in idle mode without env contract; risk: boot-time false errors; invariant: null contract indicates no dispatch; handling: return null job/payload without throwing.
  if (!rawJobType || !payloadRaw) {
    return {
      jobType: null,
      payload: null,
      payloadRaw
    };
  }

  //audit Assumption: only known job names should be accepted from env contract; risk: arbitrary dispatch execution; invariant: job type must match allowlist; handling: reject unknown names with explicit error.
  if (!ALLOWED_JOB_TYPES.includes(rawJobType as JobName)) {
    return {
      jobType: null,
      payload: null,
      payloadRaw,
      error: `Unknown WORKER_JOB value: ${rawJobType}`
    };
  }

  try {
    return {
      jobType: rawJobType as JobName,
      payloadRaw,
      payload: JSON.parse(payloadRaw)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    //audit Assumption: WORKER_PAYLOAD must be valid JSON for deterministic dispatch; risk: runtime crash on invalid payload; invariant: parse failures reported explicitly; handling: return structured contract error.
    return {
      jobType: rawJobType as JobName,
      payloadRaw,
      payload: null,
      error: `Invalid WORKER_PAYLOAD JSON: ${message}`
    };
  }
}

/**
 * Sanitize worker log payloads by redacting secret-like keys and values.
 *
 * @param payload - Arbitrary payload to sanitize.
 * @returns Sanitized payload.
 */
export function sanitizeWorkerLogPayload(payload: unknown): unknown {
  if (typeof payload === 'string') {
    //audit Assumption: token-like literals may appear in stringified payloads; risk: credential leakage via worker stdout; invariant: sensitive literals redacted; handling: regex-based replacement.
    if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(payload))) {
      return '[REDACTED]';
    }
    return payload;
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => sanitizeWorkerLogPayload(item));
  }

  if (payload && typeof payload === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      //audit Assumption: key hints detect common secret fields; risk: accidental credential logging; invariant: hinted keys are redacted; handling: redact by key or sanitize recursively.
      if (SENSITIVE_KEY_HINTS.some((hint) => key.toLowerCase().includes(hint))) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeWorkerLogPayload(value);
      }
    }
    return sanitized;
  }

  return payload;
}

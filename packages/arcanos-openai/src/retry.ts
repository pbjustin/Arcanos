import { OPENAI_RESILIENCE_DEFAULTS } from "./resilience.js";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  retryOnStatus?: number[];
  /** Called before sleeping for the next attempt. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** If provided, will stop retrying when aborted. */
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  if (signal.aborted) return Promise.reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function expBackoff(attempt: number, base: number, max: number, jitter: number): number {
  const raw = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)));
  const j = jitter ? Math.floor(Math.random() * jitter) : 0;
  return raw + j;
}

export function getHttpStatus(err: unknown): number | undefined {
  const anyErr: any = err as any;
  // Common shapes across OpenAI SDK / fetch wrappers
  return (
    anyErr?.status ??
    anyErr?.response?.status ??
    anyErr?.error?.status ??
    anyErr?.cause?.status
  );
}

export function isRetryableOpenAIError(err: unknown, retryOnStatus: number[]): boolean {
  const status = getHttpStatus(err);
  if (status && retryOnStatus.includes(status)) return true;
  const anyErr: any = err as any;
  const code = anyErr?.code ?? anyErr?.error?.code;
  // Network-ish failures often show up without status
  if (!status && (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ENOTFOUND")) return true;
  if (anyErr?.name === "APIConnectionError") return true;
  return false;
}

/**
 * Retry helper with exponential backoff + jitter.
 * Use this to wrap OpenAI SDK calls in any runtime (backend/workers/runtime).
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? OPENAI_RESILIENCE_DEFAULTS.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? OPENAI_RESILIENCE_DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? OPENAI_RESILIENCE_DEFAULTS.maxDelayMs;
  const jitterMs = options.jitterMs ?? OPENAI_RESILIENCE_DEFAULTS.jitterMs;
  const retryOnStatus = options.retryOnStatus ?? [...OPENAI_RESILIENCE_DEFAULTS.retryOnStatus];
  const signal = options.signal;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const retryable = isRetryableOpenAIError(err, retryOnStatus);
      if (!retryable || attempt >= maxAttempts) throw err;
      const delayMs = expBackoff(attempt, baseDelayMs, maxDelayMs, jitterMs);
      options.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs, signal);
    }
  }
  throw lastErr;
}

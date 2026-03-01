/**
 * Shared OpenAI resilience defaults.
 * These are intentionally conservative and can be overridden by callers.
 */
export const OPENAI_RESILIENCE_DEFAULTS = {
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 5_000,
  jitterMs: 250,
  retryOnStatus: [408, 409, 425, 429, 500, 502, 503, 504] as number[]
} as const;

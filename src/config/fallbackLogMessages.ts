/**
 * Centralized fallback logging templates to keep middleware messaging consistent
 */

export const FALLBACK_LOG_MESSAGES = {
  degraded: (endpoint: string, reason: string): string =>
    `🔄 Fallback mode activated for ${endpoint} - ${reason}`,
  preemptive: (endpoint: string): string =>
    `🔄 Preemptive fallback mode activated for ${endpoint} - OpenAI client unavailable`
} as const;

export const FALLBACK_LOG_REASON = {
  unknown: 'unknown',
  unavailable: 'OpenAI client unavailable'
} as const;

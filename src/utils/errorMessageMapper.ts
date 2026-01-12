import { ERROR_MESSAGE_PATTERNS } from '../config/errorMessages.js';

/**
 * Maps raw error objects/messages to user-friendly text using configured patterns.
 * Returns null when no mapping is found so callers can fall back to the original error.
 */
export function mapErrorToFriendlyMessage(error: unknown): string | null {
  if (!error) return null;

  const rawMessage = error instanceof Error ? error.message : String(error);
  const normalizedMessage = rawMessage.toLowerCase();

  const matched = ERROR_MESSAGE_PATTERNS.find(entry =>
    entry.patterns.some(pattern => normalizedMessage.includes(pattern))
  );

  return matched?.message ?? null;
}

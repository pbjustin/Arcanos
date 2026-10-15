/**
 * Error Message Resolution and Mapping
 * Consolidated utilities for error message extraction and user-friendly mapping
 */

import { stringifyError } from '@shared/errorUtils.js';
import { ERROR_MESSAGE_PATTERNS } from '@platform/runtime/errorMessages.js';

export { resolveErrorMessage } from '@shared/errorUtils.js';

/**
 * Maps raw error objects/messages to user-friendly text using configured patterns.
 * Returns null when no mapping is found so callers can fall back to the original error.
 */
export function mapErrorToFriendlyMessage(error: unknown): string | null {
  if (!error) return null;

  const rawMessage = stringifyError(error);
  const normalizedMessage = rawMessage.toLowerCase();

  const matched = ERROR_MESSAGE_PATTERNS.find(entry =>
    entry.patterns.some(pattern => normalizedMessage.includes(pattern))
  );

  return matched?.message ?? null;
}

import { Response } from 'express';

/**
 * Build a JSON payload with a standardized ISO timestamp.
 *
 * Purpose: Ensure consistent timestamping for API responses.
 * Inputs/Outputs: Accepts a payload object and returns a new object with a timestamp field.
 * Edge cases: Preserves a caller-provided timestamp when supplied to avoid overrides.
 */
export function buildTimestampedPayload<T extends Record<string, unknown>>(
  payload: T
): T & { timestamp: string } {
  const existingTimestamp = (payload as { timestamp?: unknown }).timestamp;

  //audit Assumption: callers might provide a timestamp; risk: overwriting intended timestamps; invariant: payload has a string timestamp; handling: reuse valid existing timestamp.
  if (typeof existingTimestamp === 'string' && existingTimestamp.length > 0) {
    return {
      ...payload,
      timestamp: existingTimestamp
    };
  }

  //audit Assumption: missing timestamp should be generated; risk: time skew if system clock is wrong; invariant: timestamp is ISO string; handling: generate fresh ISO timestamp.
  return {
    ...payload,
    timestamp: new Date().toISOString()
  };
}

/**
 * Send a standardized error response with context.
 *
 * Purpose: Return consistent JSON error payloads for API consumers.
 * Inputs/Outputs: Accepts Express response, status code, error identifiers, and context; sends JSON response.
 * Edge cases: Context keys can override base fields except timestamp (timestamp is preserved if provided).
 */
export function sendJsonError(
  res: Response,
  statusCode: number,
  error: string,
  message: string,
  context: Record<string, unknown> = {}
): void {
  //audit Assumption: context may include overrides; risk: conflicting fields; invariant: error payload retains required fields; handling: spread context after base fields.
  const payload = buildTimestampedPayload({
    error,
    message,
    ...context
  });

  res.status(statusCode).json(payload);
}

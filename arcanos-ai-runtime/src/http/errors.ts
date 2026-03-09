import type { Response } from 'express';

/**
 * Purpose: Return a standard 400 response for invalid client input.
 * Inputs/Outputs: Express response, error code, and optional detail list -> writes a 400 JSON payload.
 * Edge case behavior: Omits the `details` field when no details are provided.
 */
export function sendBadRequest(res: Response, code: string, details?: string[]): void {
  const payload: Record<string, unknown> = { error: code };

  //audit assumption: details are optional enrichment for client debugging; failure risk: empty arrays clutter the contract and create unstable snapshots; expected invariant: `details` is emitted only when populated; handling strategy: guard on length before assignment.
  if (details && details.length > 0) {
    payload.details = details;
  }

  sendJson(res, 400, payload);
}

/**
 * Purpose: Return a standard 404 response for missing runtime resources.
 * Inputs/Outputs: Express response and error code -> writes a 404 JSON payload.
 * Edge case behavior: Always emits the same `{ error }` contract for predictable callers.
 */
export function sendNotFound(res: Response, code: string): void {
  sendJson(res, 404, { error: code });
}

/**
 * Purpose: Write an arbitrary JSON payload with the provided HTTP status.
 * Inputs/Outputs: Express response, status code, payload -> writes the response body.
 * Edge case behavior: Passes payload through unchanged so callers control the exact JSON shape.
 */
export function sendJson(res: Response, status: number, payload: unknown): void {
  res.status(status).json(payload);
}

/**
 * Purpose: Return a standard 500 JSON payload for runtime request failures.
 * Inputs/Outputs: Express response and payload -> writes a 500 JSON response.
 * Edge case behavior: Leaves payload shaping to the caller so error contracts stay explicit.
 */
export function sendInternalErrorPayload(res: Response, payload: unknown): void {
  sendJson(res, 500, payload);
}

/**
 * Purpose: Return a standard 500 JSON payload for code-based server errors.
 * Inputs/Outputs: Express response, code, and optional details -> writes a 500 JSON response.
 * Edge case behavior: Omits `details` when none are supplied.
 */
export function sendInternalErrorCode(res: Response, code: string, details?: string[]): void {
  const payload: Record<string, unknown> = { error: code };

  //audit assumption: optional error details should only be surfaced when present; failure risk: empty arrays create inconsistent contracts; expected invariant: `details` exists only with meaningful content; handling strategy: guard assignment behind a populated-array check.
  if (details && details.length > 0) {
    payload.details = details;
  }
  sendInternalErrorPayload(res, payload);
}

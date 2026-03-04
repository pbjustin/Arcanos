import type { Response } from 'express';

export function sendJson(res: Response, status: number, payload: unknown): void {
  res.status(status).json(payload);
}

export function sendInternalErrorPayload(res: Response, payload: unknown): void {
  sendJson(res, 500, payload);
}

export function sendInternalErrorCode(res: Response, code: string, details?: string[]): void {
  const payload: Record<string, unknown> = { error: code };
  if (details && details.length > 0) {
    payload.details = details;
  }
  sendInternalErrorPayload(res, payload);
}

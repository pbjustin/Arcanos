import type { Response } from 'express';
import {
  buildValidationErrorResponse,
  sendValidationError,
  sendServerError,
  sendNotFoundError,
  sendUnauthorizedError,
  type ValidationErrorOptions,
  type ValidationErrorPayload,
  type StandardErrorPayload,
  type NotFoundErrorPayload,
  type UnauthorizedErrorPayload
} from '@core/lib/errors/responses.js';

/**
 * Alias: many route call sites prefer "internal" naming.
 * This keeps route code expressive while still using a single implementation.
 */

/**
 * Lightweight code-first error helpers (useful for existing endpoints that return { error: 'CODE' }).
 * Keeps backwards compatibility while still centralizing boilerplate.
 */
export function sendBadRequest(res: Response, code: string, details?: string[]): void {
  const payload: Record<string, unknown> = { error: code };
  if (details && details.length > 0) {
    payload.details = details;
  }
  res.status(400).json(payload);
}

export function sendNotFound(res: Response, code: string): void {
  res.status(404).json({ error: code });
}


export function sendJson(res: Response, status: number, payload: unknown): void {
  res.status(status).json(payload);
}

export function sendBadRequestPayload(res: Response, payload: unknown): void {
  sendJson(res, 400, payload);
}

export function sendNotFoundPayload(res: Response, payload: unknown): void {
  sendJson(res, 404, payload);
}

export function sendInternalErrorPayload(res: Response, payload: unknown): void {
  sendJson(res, 500, payload);
}

export function sendInternalErrorCode(res: Response, code: string, details?: string[]): void {
  const payload: Record<string, unknown> = { error: code };
  if (details && details.length > 0) {
    payload.details = details;
  }
  sendJson(res, 500, payload);
}

export function sendInternalError(res: Response, message: string, error?: Error): void {
  sendServerError(res, message, error);
}

export {
  buildValidationErrorResponse,
  sendValidationError,
  sendServerError,
  sendNotFoundError,
  sendUnauthorizedError,
  type ValidationErrorOptions,
  type ValidationErrorPayload,
  type StandardErrorPayload,
  type NotFoundErrorPayload,
  type UnauthorizedErrorPayload
};
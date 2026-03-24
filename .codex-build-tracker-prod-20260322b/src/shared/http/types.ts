import type { Request } from 'express';

export type RequestLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RequestScopedLogger {
  debug: (event: string, data?: Record<string, unknown>) => void;
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
  error: (event: string, data?: Record<string, unknown>) => void;
}

export interface ValidatedRequestParts {
  body?: unknown;
  params?: unknown;
  query?: unknown;
}

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    traceId?: string;
    logger?: RequestScopedLogger;
    log?: (event: string, data?: Record<string, unknown>, level?: RequestLogLevel) => void;
    validated?: ValidatedRequestParts;
  }
}

/**
 * Helper to access requestId with a stable fallback.
 */
export function getRequestId(req: Request): string {
  return typeof req.requestId === 'string' && req.requestId.trim().length > 0 ? req.requestId : 'unknown';
}

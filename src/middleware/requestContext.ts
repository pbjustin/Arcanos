import type { NextFunction, Request, Response } from 'express';
import { generateRequestId } from '@shared/idGenerator.js';
import { resolveSafeRequestPath } from '@shared/requestPathSanitizer.js';
import { redactSensitive } from '@shared/redaction.js';

export type RequestLogLevel = 'debug' | 'info' | 'warn' | 'error';

interface RequestLogPayload {
  timestamp: string;
  level: RequestLogLevel;
  event: string;
  requestId: string;
  method: string;
  path: string;
  latencyMs?: number;
  data?: Record<string, unknown>;
}

function resolveRequestId(req: Request): string {
  const rawHeader = req.headers['x-request-id'];
  const candidate = typeof rawHeader === 'string' ? rawHeader : Array.isArray(rawHeader) ? rawHeader[0] : '';
  const trimmed = candidate.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }
  return generateRequestId('req');
}

function emitRequestLog(payload: RequestLogPayload): void {
  console.log(JSON.stringify(payload));
}

interface RequestScopedLogger {
  debug: (event: string, data?: Record<string, unknown>) => void;
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
  error: (event: string, data?: Record<string, unknown>) => void;
}

function createRequestLogger(req: Request, requestId: string): RequestScopedLogger {
  const sanitizedPath = resolveSafeRequestPath(req);
  const base = {
    requestId,
    method: req.method,
    path: sanitizedPath
  };

  const logWithLevel = (
    level: RequestLogLevel,
    event: string,
    data?: Record<string, unknown>,
    latencyMs?: number
  ): void => {
    emitRequestLog({
      timestamp: new Date().toISOString(),
      level,
      event,
      requestId,
      method: base.method,
      path: base.path,
      latencyMs,
      data: data ? (redactSensitive(data) as Record<string, unknown>) : undefined
    });
  };

  return {
    debug: (event, data) => logWithLevel('debug', event, data),
    info: (event, data) => logWithLevel('info', event, data),
    warn: (event, data) => logWithLevel('warn', event, data),
    error: (event, data) => logWithLevel('error', event, data)
  };
}

/**
 * Purpose: Attach request-scoped logging context with request ID, redaction, and latency metrics.
 * Inputs/Outputs: Express middleware; enriches req with `requestId`, `logger`, and `log` helpers.
 * Edge cases: Preserves inbound x-request-id when provided, otherwise generates a new request id.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = resolveRequestId(req);
  const startTimeMs = Date.now();
  const requestPath = resolveSafeRequestPath(req);
  const requestLogger = createRequestLogger(req, requestId);

  req.requestId = requestId;
  req.logger = requestLogger;
  req.log = (event: string, data?: Record<string, unknown>, level: RequestLogLevel = 'info') => {
    requestLogger[level](event, data);
  };

  res.setHeader('x-request-id', requestId);

  requestLogger.info('request.received', {
    ip: req.ip,
    userAgent: req.get('user-agent') || null
  });

  res.on('finish', () => {
    const latencyMs = Date.now() - startTimeMs;
    const statusCode = res.statusCode;
    const completionData = {
      statusCode,
      contentLength: res.getHeader('content-length') ?? null
    };

    let level: RequestLogLevel = 'info';
    if (statusCode >= 500) {
      level = 'error';
    } else if (statusCode >= 400) {
      level = 'warn';
    }

    emitRequestLog({
      timestamp: new Date().toISOString(),
      level,
      event: 'request.completed',
      requestId,
      method: req.method,
      path: requestPath,
      latencyMs,
      data: completionData
    });
  });

  next();
}

export default requestContext;

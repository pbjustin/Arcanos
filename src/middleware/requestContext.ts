import type { NextFunction, Request, Response } from 'express';
import { generateRequestId } from "@shared/idGenerator.js";
import { resolveSafeRequestPath } from "@shared/requestPathSanitizer.js";

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

const REDACTED_VALUE = '[REDACTED]';
const SENSITIVE_KEY_PATTERN = /(authorization|cookie|token|password|secret|api[-_]?key|private[-_]?key)/i;
const SENSITIVE_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9]{12,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:postgres|postgresql|mysql|mongodb):\/\/[^@\s]+:[^@\s]+@/i
];

function redactString(value: string): string {
  //audit Assumption: token-like literals in logs are sensitive regardless of field name; failure risk: credential disclosure in centralized logs; expected invariant: token patterns are always redacted; handling strategy: replace matching strings with sentinel.
  if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    return REDACTED_VALUE;
  }
  return value;
}

function redactLogValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    //audit Assumption: key-name redaction catches secrets missed by value pattern checks; failure risk: leakage through nested objects; expected invariant: sensitive keys never log raw values; handling strategy: key-pattern based masking.
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      redacted[key] = REDACTED_VALUE;
      continue;
    }
    redacted[key] = redactLogValue(nestedValue);
  }
  return redacted;
}

function resolveRequestId(req: Request): string {
  const rawHeader = req.headers['x-request-id'];
  const candidate = typeof rawHeader === 'string' ? rawHeader : Array.isArray(rawHeader) ? rawHeader[0] : '';
  const trimmed = candidate.trim();
  //audit Assumption: inbound request-id may be absent or blank; failure risk: missing correlation id across logs; expected invariant: every request has a non-empty id; handling strategy: generate fallback id.
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
      data: data ? (redactLogValue(data) as Record<string, unknown>) : undefined
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

    //audit Assumption: status class should determine completion severity while preserving a uniform schema for analytics; failure risk: fractured log queries across levels; expected invariant: request.completed always includes top-level latency and data payload; handling strategy: compute level first, then emit a single structured shape.
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

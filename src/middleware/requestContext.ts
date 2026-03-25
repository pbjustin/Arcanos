import type { NextFunction, Request, Response } from 'express';
import { generateRequestId } from '@shared/idGenerator.js';
import { resolveSafeRequestPath } from '@shared/requestPathSanitizer.js';
import { redactSensitive } from '@shared/redaction.js';
import { runtimeDiagnosticsService } from '@services/runtimeDiagnosticsService.js';
import {
  recordHttpRequestCompletion,
  recordHttpRequestEnd,
  recordHttpRequestStart,
  resolveMetricRouteLabel,
  shouldSkipHttpMetrics,
} from '@platform/observability/appMetrics.js';

export type RequestLogLevel = 'debug' | 'info' | 'warn' | 'error';

interface RequestLogPayload {
  timestamp: string;
  level: RequestLogLevel;
  event: string;
  traceId: string;
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

function resolveTraceId(req: Request): string {
  const rawHeader = req.headers['x-trace-id'];
  const candidate = typeof rawHeader === 'string' ? rawHeader : Array.isArray(rawHeader) ? rawHeader[0] : '';
  const trimmed = candidate.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }
  return generateRequestId('trace');
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

function createRequestLogger(req: Request, requestId: string, traceId: string): RequestScopedLogger {
  const sanitizedPath = resolveSafeRequestPath(req);
  const base = {
    traceId,
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
      traceId: base.traceId,
      requestId: base.requestId,
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
  const traceId = resolveTraceId(req);
  const startTimeMs = Date.now();
  const requestPath = resolveSafeRequestPath(req);
  const requestLogger = createRequestLogger(req, requestId, traceId);
  const trackHttpMetrics = !shouldSkipHttpMetrics(req);
  let metricsRecorded = false;

  if (trackHttpMetrics) {
    recordHttpRequestStart();
  }

  req.requestId = requestId;
  req.traceId = traceId;
  req.logger = requestLogger;
  req.log = (event: string, data?: Record<string, unknown>, level: RequestLogLevel = 'info') => {
    requestLogger[level](event, data);
  };

  res.setHeader('x-request-id', requestId);
  res.setHeader('x-trace-id', traceId);
  //audit Assumption: downstream handlers may persist the trace id from res.locals even when request typing is erased; failure risk: trace propagation silently drops at route boundaries; expected invariant: the same trace id is reachable from both req and res.locals; handling strategy: mirror the generated id onto locals during request bootstrap.
  (res.locals as Record<string, unknown>).auditTraceId = traceId;

  requestLogger.info('request.received', {
    ip: req.ip,
    userAgent: req.get('user-agent') || null
  });

  const finalizeHttpMetrics = (): void => {
    if (!trackHttpMetrics || metricsRecorded) {
      return;
    }

    metricsRecorded = true;
    const route = resolveMetricRouteLabel(req);
    recordHttpRequestCompletion({
      route,
      method: req.method,
      statusCode: res.statusCode,
      durationMs: Date.now() - startTimeMs,
      requestBytes: Number.parseInt(req.get('content-length') ?? '0', 10) || 0,
      responseBytes:
        Number.parseInt(String(res.getHeader('x-response-bytes') ?? ''), 10) ||
        Number.parseInt(String(res.getHeader('content-length') ?? ''), 10) ||
        0,
    });
    recordHttpRequestEnd();
  };

  res.on('finish', () => {
    const latencyMs = Date.now() - startTimeMs;
    const statusCode = res.statusCode;
    const route = resolveMetricRouteLabel(req);
    const completionData = {
      statusCode,
      contentLength: res.getHeader('content-length') ?? null
    };

    runtimeDiagnosticsService.recordRequestCompletion(statusCode, latencyMs, route);

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
      traceId,
      requestId,
      method: req.method,
      path: requestPath,
      latencyMs,
      data: completionData
    });

    finalizeHttpMetrics();
  });

  res.on('close', () => {
    if (!metricsRecorded && trackHttpMetrics) {
      recordHttpRequestEnd();
      metricsRecorded = true;
    }
  });

  next();
}

export default requestContext;

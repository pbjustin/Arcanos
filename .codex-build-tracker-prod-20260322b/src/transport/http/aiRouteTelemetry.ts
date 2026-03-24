import crypto from 'node:crypto';
import type { Request } from 'express';

import { resolveErrorMessage } from '@core/lib/errors/index.js';

export interface AiRouteTraceContext {
  endpoint: string;
  inputHash: string;
  requestedModel: string | null;
  requestId: string;
  traceId: string;
  startedAtMs: number;
}

function resolveTraceId(req: Request): string {
  if (typeof req.traceId === 'string' && req.traceId.trim().length > 0) {
    return req.traceId;
  }

  if (typeof req.requestId === 'string' && req.requestId.trim().length > 0) {
    return req.requestId;
  }

  return 'unknown';
}

/**
 * Purpose: derive a deterministic, non-reversible hash for operator-visible prompt tracing.
 * Inputs/Outputs: accepts raw user input text and returns a SHA-256 hex digest.
 * Edge cases: empty strings still produce a stable digest so error logs can correlate malformed-but-present prompts.
 */
export function buildInputHash(input: string): string {
  //audit Assumption: prompt contents themselves should not be logged for observability; failure risk: sensitive user inputs leak into structured logs; expected invariant: tracing keeps a stable correlation key without exposing prompt text; handling strategy: hash the normalized input before logging.
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Purpose: start request-scoped telemetry for AI endpoints with prompt hashing and model intent metadata.
 * Inputs/Outputs: request + endpoint + prompt + requested model -> immutable trace context for later completion/error logs.
 * Edge cases: routes without requestContext still receive stable `unknown` correlation fields instead of throwing.
 */
export function beginAiRouteTrace(
  req: Request,
  endpoint: string,
  input: string,
  requestedModel?: string | null
): AiRouteTraceContext {
  const traceContext: AiRouteTraceContext = {
    endpoint,
    inputHash: buildInputHash(input),
    requestedModel: requestedModel?.trim() || null,
    requestId: req.requestId ?? 'unknown',
    traceId: resolveTraceId(req),
    startedAtMs: Date.now()
  };

  req.logger?.info('ai.route.started', {
    endpoint: traceContext.endpoint,
    inputHash: traceContext.inputHash,
    requestedModel: traceContext.requestedModel
  });

  return traceContext;
}

/**
 * Purpose: emit completion telemetry for AI endpoints using the same trace context as the start event.
 * Inputs/Outputs: request + trace context + execution metadata -> structured completion log.
 * Edge cases: absent extra metadata is omitted to keep logs compact and machine-stable.
 */
export function completeAiRouteTrace(
  req: Request,
  traceContext: AiRouteTraceContext,
  details: {
    activeModel?: string | null;
    fallbackFlag?: boolean;
    fallbackReason?: string | null;
    extra?: Record<string, unknown>;
  } = {}
): void {
  req.logger?.info('ai.route.completed', {
    endpoint: traceContext.endpoint,
    inputHash: traceContext.inputHash,
    requestedModel: traceContext.requestedModel,
    activeModel: details.activeModel?.trim() || null,
    fallbackFlag: details.fallbackFlag ?? false,
    fallbackReason: details.fallbackReason ?? null,
    latencyMs: Date.now() - traceContext.startedAtMs,
    ...(details.extra ?? {})
  });
}

/**
 * Purpose: emit structured error telemetry for AI endpoints before HTTP error payloads are written.
 * Inputs/Outputs: request + trace context + thrown error + optional metadata -> structured failure log.
 * Edge cases: 4xx-style failures are logged as warnings while 5xx faults remain errors.
 */
export function failAiRouteTrace(
  req: Request,
  traceContext: AiRouteTraceContext,
  error: unknown,
  details: {
    activeModel?: string | null;
    fallbackFlag?: boolean;
    fallbackReason?: string | null;
    statusCode?: number;
    extra?: Record<string, unknown>;
  } = {}
): void {
  const errorMessage = resolveErrorMessage(error);
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  const logLevel: 'warn' | 'error' = details.statusCode !== undefined && details.statusCode < 500 ? 'warn' : 'error';

  req.logger?.[logLevel]('ai.route.failed', {
    endpoint: traceContext.endpoint,
    inputHash: traceContext.inputHash,
    requestedModel: traceContext.requestedModel,
    activeModel: details.activeModel?.trim() || null,
    fallbackFlag: details.fallbackFlag ?? false,
    fallbackReason: details.fallbackReason ?? null,
    errorType: errorName,
    errorMessage,
    latencyMs: Date.now() - traceContext.startedAtMs,
    ...(details.extra ?? {})
  });
}

import { logExecution } from '@core/db/repositories/executionLogRepository.js';
import type { CefHandlerContext, CefTraceStatus } from './types.js';

export type CefTraceLevel = 'info' | 'warn' | 'error';

interface CefBoundaryTraceMetadata {
  status: CefTraceStatus;
  startedAtMs?: number;
  durationMs?: number;
  errorCode?: string | null;
  fallbackUsed?: boolean;
  retryCount?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Persist one CEF boundary trace event.
 *
 * Purpose:
 * - Make command and handler execution observable from the single CEF boundary log stream.
 *
 * Inputs/outputs:
 * - Input: log level, event name, typed handler context, and optional metadata.
 * - Output: none.
 *
 * Edge case behavior:
 * - Delegates storage fallback behavior to `logExecution`, which already degrades to console logging when the DB is unavailable.
 */
export async function traceCefBoundary(
  level: CefTraceLevel,
  message: string,
  context: CefHandlerContext,
  traceMetadata: CefBoundaryTraceMetadata
): Promise<void> {
  const timestamp = new Date().toISOString();
  const durationMs = typeof traceMetadata.durationMs === 'number'
    ? traceMetadata.durationMs
    : typeof traceMetadata.startedAtMs === 'number'
      ? Math.max(0, Date.now() - traceMetadata.startedAtMs)
      : 0;

  await logExecution('cef-boundary', level, message, {
    traceId: context.traceId ?? context.commandTraceId,
    command: context.command,
    handler: `${context.domain}:${context.handlerMethod}`,
    timestamp,
    status: traceMetadata.status,
    durationMs,
    errorCode: traceMetadata.errorCode ?? null,
    fallbackUsed: traceMetadata.fallbackUsed ?? false,
    retryCount: traceMetadata.retryCount ?? 0,
    commandTraceId: context.commandTraceId,
    executionId: context.executionId ?? null,
    capabilityId: context.capabilityId ?? null,
    stepId: context.stepId ?? null,
    source: context.source ?? null,
    domain: context.domain,
    handlerMethod: context.handlerMethod,
    ...(traceMetadata.metadata ?? {})
  });
}

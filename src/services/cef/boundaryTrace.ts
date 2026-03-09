import { logExecution } from '@core/db/repositories/executionLogRepository.js';
import type { CefHandlerContext } from './types.js';

export type CefTraceLevel = 'info' | 'warn' | 'error';

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
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await logExecution('cef-boundary', level, message, {
    command: context.command,
    commandTraceId: context.commandTraceId,
    traceId: context.traceId ?? null,
    executionId: context.executionId ?? null,
    capabilityId: context.capabilityId ?? null,
    stepId: context.stepId ?? null,
    source: context.source ?? null,
    domain: context.domain,
    handlerMethod: context.handlerMethod,
    ...metadata
  });
}

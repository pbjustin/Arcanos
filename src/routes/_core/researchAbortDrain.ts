import {
  createAbortError,
  createLinkedAbortController,
  runWithRequestAbortContext,
  type RequestAbortContext,
} from '@arcanos/runtime/requestAbort';

export interface ResearchAbortDrainOptions {
  timeoutMs: number;
  deadlineAt?: number;
  requestId?: string;
  parentSignal?: AbortSignal;
  abortMessage?: string;
}

function resolveAbortReason(signal: AbortSignal, fallbackMessage: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : createAbortError(fallbackMessage);
}

/**
 * Run cooperative Research work under a linked deadline without racing its
 * promise. Cancellation is surfaced only after the active callback settles,
 * which keeps HTTP/module wrappers from leaving Research work detached.
 */
export async function runResearchWithAbortDrain<T>(
  options: ResearchAbortDrainOptions,
  callback: () => Promise<T> | T,
): Promise<T> {
  const abortMessage = options.abortMessage
    ?? `Research request timed out after ${options.timeoutMs}ms`;
  const requestedTimeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.max(1, Math.trunc(options.timeoutMs))
    : 1;
  const deadlineRemainingMs = Number.isFinite(options.deadlineAt)
    ? Math.trunc((options.deadlineAt as number) - Date.now())
    : requestedTimeoutMs;
  if (deadlineRemainingMs <= 0) {
    throw options.parentSignal?.aborted
      ? resolveAbortReason(options.parentSignal, abortMessage)
      : createAbortError(abortMessage);
  }
  const timeoutMs = Math.min(requestedTimeoutMs, deadlineRemainingMs);
  const linked = createLinkedAbortController({
    timeoutMs,
    parentSignal: options.parentSignal,
    abortMessage,
  });
  const deadlineAt = Number.isFinite(options.deadlineAt)
    ? Math.min(linked.deadlineAt, options.deadlineAt as number)
    : linked.deadlineAt;
  const context: RequestAbortContext = {
    requestId: options.requestId,
    controller: linked.controller,
    signal: linked.signal,
    deadlineAt,
    timeoutMs,
  };
  const throwIfCancelled = () => {
    if (linked.signal.aborted) {
      throw resolveAbortReason(linked.signal, abortMessage);
    }
    if (Date.now() >= deadlineAt) {
      const reason = createAbortError(abortMessage);
      linked.controller.abort(reason);
      throw reason;
    }
  };

  try {
    throwIfCancelled();

    try {
      const value = await runWithRequestAbortContext(context, callback);
      throwIfCancelled();
      return value;
    } catch (error: unknown) {
      throwIfCancelled();
      throw error;
    }
  } finally {
    linked.cleanup();
  }
}

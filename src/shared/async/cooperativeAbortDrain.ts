import {
  createAbortError,
  runWithRequestAbortContext,
  type RequestAbortContext,
} from '@arcanos/runtime';

export const COOPERATIVE_DEADLINE_EXCEEDED_CODE =
  'COOPERATIVE_DEADLINE_EXCEEDED';

export class CooperativeDeadlineExceededError extends Error {
  readonly code = COOPERATIVE_DEADLINE_EXCEEDED_CODE;
  readonly scope: string;

  constructor(scope: string, message: string) {
    super(message);
    this.name = 'AbortError';
    this.scope = scope;
  }
}

export function isCooperativeDeadlineExceededError(
  value: unknown,
  scope?: string
): value is CooperativeDeadlineExceededError {
  return value instanceof CooperativeDeadlineExceededError
    && (scope === undefined || value.scope === scope);
}

function resolveParentAbortReason(
  signal: AbortSignal,
  fallbackMessage: string
): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : createAbortError(fallbackMessage);
}

/**
 * Abort cooperative work at one finite deadline and wait for its callback to
 * settle before returning. This prevents a caller from terminalizing durable
 * work while the provider callback is still unwinding from cancellation.
 */
export async function runWithCooperativeAbortDrain<T>(
  options: {
    timeoutMs: number;
    deadlineAt?: number;
    requestId?: string;
    parentSignal?: AbortSignal;
    abortMessage: string;
    scope: string;
    onDeadline?: () => void;
    maxDrainMs?: number;
  },
  callback: () => Promise<T> | T
): Promise<T> {
  const requestedTimeoutMs = Number.isFinite(options.timeoutMs)
    && options.timeoutMs > 0
    ? Math.max(1, Math.trunc(options.timeoutMs))
    : 1;
  const startedAtMs = Date.now();
  const requestedDeadlineAt = startedAtMs + requestedTimeoutMs;
  const deadlineAt = Number.isFinite(options.deadlineAt)
    ? Math.min(requestedDeadlineAt, Math.trunc(options.deadlineAt as number))
    : requestedDeadlineAt;

  if (options.parentSignal?.aborted) {
    throw resolveParentAbortReason(options.parentSignal, options.abortMessage);
  }
  if (deadlineAt <= startedAtMs) {
    throw new CooperativeDeadlineExceededError(
      options.scope,
      options.abortMessage
    );
  }

  const controller = new AbortController();
  const deadlineError = new CooperativeDeadlineExceededError(
    options.scope,
    options.abortMessage
  );
  let deadlineFired = false;
  const onParentAbort = () => {
    if (!controller.signal.aborted && options.parentSignal) {
      controller.abort(resolveParentAbortReason(
        options.parentSignal,
        options.abortMessage
      ));
    }
  };
  options.parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timeoutHandle = setTimeout(() => {
    if (options.parentSignal?.aborted || controller.signal.aborted) {
      return;
    }
    deadlineFired = true;
    try {
      options.onDeadline?.();
    } catch {
      // Deadline observers must not replace or interrupt cancellation.
    }
    if (!controller.signal.aborted) {
      controller.abort(deadlineError);
    }
  }, Math.max(1, deadlineAt - startedAtMs));
  if (typeof timeoutHandle.unref === 'function') {
    timeoutHandle.unref();
  }

  const context: RequestAbortContext = {
    requestId: options.requestId,
    controller,
    signal: controller.signal,
    deadlineAt,
    timeoutMs: Math.max(1, deadlineAt - startedAtMs),
  };
  const maxDrainMs = Number.isFinite(options.maxDrainMs)
    && (options.maxDrainMs as number) > 0
    ? Math.max(1, Math.trunc(options.maxDrainMs as number))
    : null;
  let drainTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let onControllerAbort: (() => void) | null = null;
  const boundedDrain = maxDrainMs === null
    ? null
    : new Promise<never>((_resolve, reject) => {
        onControllerAbort = () => {
          if (drainTimeoutHandle !== null) {
            return;
          }
          drainTimeoutHandle = setTimeout(() => {
            reject(controller.signal.reason instanceof Error
              ? controller.signal.reason
              : createAbortError(options.abortMessage));
          }, maxDrainMs);
          if (typeof drainTimeoutHandle.unref === 'function') {
            drainTimeoutHandle.unref();
          }
        };
        controller.signal.addEventListener('abort', onControllerAbort, { once: true });
        if (controller.signal.aborted) {
          onControllerAbort();
        }
      });

  const throwForAbort = (): void => {
    if (options.parentSignal?.aborted) {
      throw resolveParentAbortReason(options.parentSignal, options.abortMessage);
    }
    if (deadlineFired || Date.now() >= deadlineAt) {
      throw deadlineError;
    }
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : createAbortError(options.abortMessage);
    }
  };

  try {
    throwForAbort();
    try {
      const callbackExecution = Promise.resolve().then(() =>
        runWithRequestAbortContext(context, callback)
      );
      const value = boundedDrain === null
        ? await callbackExecution
        : await Promise.race([callbackExecution, boundedDrain]);
      throwForAbort();
      return value;
    } catch (error: unknown) {
      throwForAbort();
      throw error;
    }
  } finally {
    clearTimeout(timeoutHandle);
    if (drainTimeoutHandle !== null) {
      clearTimeout(drainTimeoutHandle);
    }
    if (onControllerAbort) {
      controller.signal.removeEventListener('abort', onControllerAbort);
    }
    options.parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

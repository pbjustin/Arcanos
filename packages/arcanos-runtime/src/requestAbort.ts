import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestAbortContext {
  requestId?: string;
  controller: AbortController;
  signal: AbortSignal;
  deadlineAt: number;
  timeoutMs: number;
}

const requestAbortStorage = new AsyncLocalStorage<RequestAbortContext>();

function normalizeTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return 1;
  }

  return Math.max(1, Math.trunc(timeoutMs));
}

export function createAbortError(message = 'request_aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  const values = [candidate.name, candidate.code, candidate.message]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase());

  return values.some((value) => value.includes('abort') || value.includes('cancel'));
}

export function runWithRequestAbortContext<T>(
  context: RequestAbortContext,
  callback: () => Promise<T> | T
): Promise<T> | T {
  return requestAbortStorage.run(context, callback);
}

export function getRequestAbortContext(): RequestAbortContext | null {
  return requestAbortStorage.getStore() ?? null;
}

export function getRequestAbortSignal(): AbortSignal | undefined {
  return requestAbortStorage.getStore()?.signal;
}

export function getRequestRemainingMs(now = Date.now()): number | null {
  const activeContext = requestAbortStorage.getStore();
  if (!activeContext) {
    return null;
  }

  return Math.max(0, activeContext.deadlineAt - now);
}

export function throwIfRequestAborted(): void {
  const activeSignal = getRequestAbortSignal();
  if (activeSignal?.aborted) {
    throw createAbortError();
  }
}

export function createLinkedAbortController(options: {
  timeoutMs: number;
  parentSignal?: AbortSignal;
  abortMessage?: string;
}): {
  controller: AbortController;
  signal: AbortSignal;
  deadlineAt: number;
  cleanup: () => void;
} {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  const abortMessage = options.abortMessage ?? `request timed out after ${timeoutMs}ms`;
  const parentSignal = options.parentSignal;

  const abort = (reason?: unknown) => {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort(reason ?? createAbortError(abortMessage));
  };

  const onParentAbort = () => abort(parentSignal?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) {
      abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  const timeoutHandle = setTimeout(() => abort(createAbortError(abortMessage)), timeoutMs);

  return {
    controller,
    signal: controller.signal,
    deadlineAt,
    cleanup: () => {
      clearTimeout(timeoutHandle);
      if (parentSignal) {
        parentSignal.removeEventListener('abort', onParentAbort);
      }
    }
  };
}

export async function runWithRequestAbortTimeout<T>(
  options: {
    timeoutMs: number;
    requestId?: string;
    parentSignal?: AbortSignal;
    abortMessage?: string;
    onAbort?: (reason: unknown, context: RequestAbortContext) => void;
  },
  callback: () => Promise<T> | T
): Promise<T> {
  const linked = createLinkedAbortController({
    timeoutMs: options.timeoutMs,
    parentSignal: options.parentSignal,
    abortMessage: options.abortMessage
  });
  const requestAbortContext: RequestAbortContext = {
    requestId: options.requestId,
    controller: linked.controller,
    signal: linked.signal,
    deadlineAt: linked.deadlineAt,
    timeoutMs: normalizeTimeoutMs(options.timeoutMs)
  };
  let abortHandled = false;

  const notifyAbort = (reason: unknown) => {
    if (abortHandled) {
      return;
    }
    abortHandled = true;
    if (typeof options.onAbort !== 'function') {
      return;
    }

    try {
      options.onAbort(reason, requestAbortContext);
    } catch {
      // Preserve the original abort flow even if the observer fails.
    }
  };

  try {
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        linked.signal.removeEventListener('abort', onAbort);
        const reason = linked.signal.reason;
        notifyAbort(reason);
        reject(reason instanceof Error ? reason : createAbortError());
      };

      if (linked.signal.aborted) {
        onAbort();
        return;
      }

      linked.signal.addEventListener('abort', onAbort, { once: true });

      Promise.resolve(
        runWithRequestAbortContext(
          requestAbortContext,
          callback
        )
      ).then(
        (value) => {
          linked.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          linked.signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  } finally {
    linked.cleanup();
  }
}

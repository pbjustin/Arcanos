import type { Request, Response } from 'express';

import {
  createAbortError,
  runWithRequestAbortContext,
  type RequestAbortContext,
} from '@arcanos/runtime';

const UNBOUNDED_REQUEST_DEADLINE = Number.MAX_SAFE_INTEGER;

export interface ClientDisconnectAbortScope {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  run<T>(callback: (signal: AbortSignal) => Promise<T> | T): Promise<T> | T;
  cleanup(): void;
}

/**
 * Bind in-process request work to the lifetime of its HTTP response.
 *
 * The scope intentionally owns no timeout. Service-level workflows remain
 * responsible for their aggregate deadline while this parent signal only
 * represents caller disconnect/abort state.
 */
export function createClientDisconnectAbortScope(
  req: Request,
  res: Response,
  abortMessage: string,
): ClientDisconnectAbortScope {
  const controller = new AbortController();
  let cleanedUp = false;

  const abort = () => {
    if (res.writableEnded || controller.signal.aborted) {
      return;
    }
    controller.abort(createAbortError(abortMessage));
  };

  req.once('aborted', abort);
  res.once('close', abort);
  if (req.aborted || res.destroyed) {
    abort();
  }

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    req.off('aborted', abort);
    res.off('close', abort);
  };

  const context: RequestAbortContext = {
    requestId: req.requestId,
    controller,
    signal: controller.signal,
    deadlineAt: UNBOUNDED_REQUEST_DEADLINE,
    timeoutMs: UNBOUNDED_REQUEST_DEADLINE,
  };

  return {
    controller,
    signal: controller.signal,
    run: callback => runWithRequestAbortContext(
      context,
      () => callback(controller.signal),
    ),
    cleanup,
  };
}

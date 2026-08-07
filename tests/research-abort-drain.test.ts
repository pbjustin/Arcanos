import { describe, expect, it, jest } from '@jest/globals';

import {
  createAbortError,
  getRequestAbortSignal,
} from '@arcanos/runtime';
import { runResearchWithAbortDrain } from '../src/routes/_core/researchAbortDrain.js';

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('Research abort drain', () => {
  it('rejects a pre-aborted parent before admitting callback work', async () => {
    const parentController = new AbortController();
    const reason = createAbortError('Research client disconnected');
    parentController.abort(reason);
    const callback = jest.fn(async () => undefined);

    await expect(runResearchWithAbortDrain({
      timeoutMs: 1_000,
      parentSignal: parentController.signal,
    }, callback)).rejects.toBe(reason);
    expect(callback).not.toHaveBeenCalled();
  });

  it('waits for cooperative cancellation cleanup before settling the wrapper', async () => {
    const started = createDeferred();
    const aborted = createDeferred();
    const releaseDrain = createDeferred();
    let drained = false;
    let settled = false;

    const pending = runResearchWithAbortDrain({ timeoutMs: 20 }, async () => {
      const signal = getRequestAbortSignal();
      expect(signal).toBeDefined();
      started.resolve();
      if (!signal?.aborted) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      aborted.resolve();
      await releaseDrain.promise;
      drained = true;
      throw signal?.reason ?? createAbortError('Research workflow timed out');
    });
    void pending.catch(() => undefined).finally(() => {
      settled = true;
    });

    await started.promise;
    await aborted.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(drained).toBe(false);

    releaseDrain.resolve();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(drained).toBe(true);
  });

  it('rejects an expired parent deadline before admitting callback work', async () => {
    const callback = jest.fn(async () => undefined);

    await expect(runResearchWithAbortDrain({
      timeoutMs: 1_000,
      deadlineAt: Date.now() - 1,
      abortMessage: 'Research parent deadline expired',
    }, callback)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Research parent deadline expired',
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it('fails closed when callback completion observes an expired deadline before its timer runs', async () => {
    let now = 1_000;
    const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => now);
    let callbackSignal: AbortSignal | undefined;

    try {
      await expect(runResearchWithAbortDrain({
        timeoutMs: 10,
        abortMessage: 'Research workflow deadline expired',
      }, () => {
        callbackSignal = getRequestAbortSignal();
        now = 1_011;
        return 'late result';
      })).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Research workflow deadline expired',
      });
      expect(callbackSignal?.aborted).toBe(true);
    } finally {
      dateNow.mockRestore();
    }
  });
});

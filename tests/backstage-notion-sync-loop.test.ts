import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  BACKSTAGE_NOTION_SYNC_INTERVAL_DEFAULT_MS,
  BACKSTAGE_NOTION_SYNC_INTERVAL_MAX_MS,
  BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS,
  resolveBackstageNotionSyncIntervalMs,
  startBackstageNotionSyncLoop,
} from '../src/workers/backstageNotionSyncLoop.js';

const loggerInfo = jest.fn();
const loggerWarn = jest.fn();
const testLogger = { info: loggerInfo, warn: loggerWarn };

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('Backstage Notion synchronization loop', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs immediately and schedules each recurring cycle after completion', async () => {
    const sync = jest.fn(async () => []);
    const handle = startBackstageNotionSyncLoop({
      intervalMs: BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS,
      sync,
      logger: testLogger,
    });

    expect(sync).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS - 1);
    expect(sync).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it('never overlaps a pending cycle with later interval time', async () => {
    const firstCycle = createDeferred<readonly []>();
    const sync = jest.fn(() => firstCycle.promise);
    const handle = startBackstageNotionSyncLoop({
      intervalMs: BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS,
      sync,
      logger: testLogger,
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(BACKSTAGE_NOTION_SYNC_INTERVAL_MAX_MS);
    expect(sync).toHaveBeenCalledTimes(1);

    firstCycle.resolve([]);
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS);
    expect(sync).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it('isolates one failed cycle and continues recurring synchronization', async () => {
    const sync = jest.fn()
      .mockRejectedValueOnce(new Error('test-only synchronization failure'))
      .mockResolvedValueOnce([]);
    const handle = startBackstageNotionSyncLoop({
      intervalMs: BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS,
      sync,
      logger: testLogger,
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      'backstage.notion_rag.sync_cycle_failed',
      expect.objectContaining({ module: 'backstage-notion-sync' }),
      { errorMessage: 'test-only synchronization failure' },
      expect.any(Error)
    );

    await jest.advanceTimersByTimeAsync(BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(loggerInfo).toHaveBeenCalledWith(
      'backstage.notion_rag.sync_cycle_completed',
      expect.objectContaining({ configuredUniverses: 0 })
    );

    handle.stop();
  });

  it('reports isolated root failures without losing the configured universe count', async () => {
    const sync = jest.fn(async () => [{
      universeId: 'failed-universe',
      status: 'failed' as const,
      pageCount: 0,
      chunkCount: 0,
      manifestHash: null,
      snapshotId: null,
      verifiedAt: null,
      errorCode: 'BACKSTAGE_NOTION_SYNC_INCOMPLETE',
    }]);
    const handle = startBackstageNotionSyncLoop({
      intervalMs: BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS,
      sync,
      logger: testLogger,
    });

    await jest.advanceTimersByTimeAsync(0);

    expect(loggerWarn).toHaveBeenCalledWith(
      'backstage.notion_rag.sync_cycle_completed_with_failures',
      expect.objectContaining({
        configuredUniverses: 1,
        activated: 0,
        unchanged: 0,
        leaseBusy: 0,
        failed: 1,
      })
    );
    expect(loggerInfo).not.toHaveBeenCalledWith(
      'backstage.notion_rag.sync_cycle_completed',
      expect.anything()
    );

    handle.stop();
  });

  it('aborts an active cycle and prevents recurrence when the parent signal aborts', async () => {
    const parentController = new AbortController();
    let cycleSignal: AbortSignal | undefined;
    const sync = jest.fn(({ signal }: { signal?: AbortSignal }) => {
      cycleSignal = signal;
      return new Promise<readonly []>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    startBackstageNotionSyncLoop({
      intervalMs: BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS,
      signal: parentController.signal,
      sync,
      logger: testLogger,
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(cycleSignal?.aborted).toBe(false);
    parentController.abort(new Error('test-only worker shutdown'));
    await jest.advanceTimersByTimeAsync(0);
    expect(cycleSignal?.aborted).toBe(true);

    await jest.advanceTimersByTimeAsync(BACKSTAGE_NOTION_SYNC_INTERVAL_MAX_MS);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('stop aborts active work and is idempotent', async () => {
    let cycleSignal: AbortSignal | undefined;
    const sync = jest.fn(({ signal }: { signal?: AbortSignal }) => {
      cycleSignal = signal;
      return new Promise<readonly []>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const handle = startBackstageNotionSyncLoop({
      intervalMs: BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS,
      sync,
      logger: testLogger,
    });

    await jest.advanceTimersByTimeAsync(0);
    handle.stop();
    handle.stop();
    await jest.advanceTimersByTimeAsync(0);

    expect(cycleSignal?.aborted).toBe(true);
    await jest.advanceTimersByTimeAsync(BACKSTAGE_NOTION_SYNC_INTERVAL_MAX_MS);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('bounds explicit synchronization intervals', () => {
    expect(resolveBackstageNotionSyncIntervalMs(1))
      .toBe(BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS);
    expect(resolveBackstageNotionSyncIntervalMs(
      BACKSTAGE_NOTION_SYNC_INTERVAL_MAX_MS + 1
    )).toBe(BACKSTAGE_NOTION_SYNC_INTERVAL_MAX_MS);
    expect(resolveBackstageNotionSyncIntervalMs(Number.NaN))
      .toBe(BACKSTAGE_NOTION_SYNC_INTERVAL_DEFAULT_MS);
    expect(resolveBackstageNotionSyncIntervalMs(0))
      .toBe(BACKSTAGE_NOTION_SYNC_INTERVAL_DEFAULT_MS);
  });

  it('starts after readiness commits and always stops during job-runner cleanup', () => {
    const source = fs
      .readFileSync(path.resolve('src/workers/jobRunner.ts'), 'utf8')
      .replace(/\r\n/gu, '\n');
    const readinessBarrierIndex = source.indexOf(
      'await commitAllWorkerSlotsReadyOrThrow('
    );
    const readinessSignalIndex = source.indexOf(
      'emitWorkerBootstrapReadySignal()',
      readinessBarrierIndex
    );
    const syncStartIndex = source.indexOf(
      'backstageNotionSyncHandle = startBackstageNotionSyncLoop({',
      readinessSignalIndex
    );
    const runtimeBarrierIndex = source.indexOf(
      'await Promise.all(slotRuntimePromises)',
      syncStartIndex
    );
    const syncStopIndex = source.indexOf(
      'backstageNotionSyncHandle?.stop()',
      runtimeBarrierIndex
    );

    expect([
      readinessBarrierIndex,
      readinessSignalIndex,
      syncStartIndex,
      runtimeBarrierIndex,
      syncStopIndex,
    ]).not.toContain(-1);
    expect(readinessBarrierIndex).toBeLessThan(readinessSignalIndex);
    expect(readinessSignalIndex).toBeLessThan(syncStartIndex);
    expect(syncStartIndex).toBeLessThan(runtimeBarrierIndex);
    expect(runtimeBarrierIndex).toBeLessThan(syncStopIndex);
    expect(source).not.toContain('await startBackstageNotionSyncLoop(');
  });
});

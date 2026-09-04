import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { BackstageNotionSyncResult } from '../src/services/backstageNotionSync.js';
import {
  WorkerAiCallBudgetPausedError,
  instrumentOpenAIOperation,
} from '../src/core/adapters/openai.adapter.js';
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
const universeId = 'my-universe-2k26';

function syncResult(
  status: BackstageNotionSyncResult['status']
): BackstageNotionSyncResult {
  return {
    universeId,
    status,
    pageCount: status === 'failed' || status === 'lease-busy' ? 0 : 1,
    chunkCount: status === 'failed' || status === 'lease-busy' ? 0 : 1,
    manifestHash: status === 'failed' || status === 'lease-busy'
      ? null
      : 'c'.repeat(64),
    snapshotId: status === 'failed' || status === 'lease-busy'
      ? null
      : '22222222-2222-4222-8222-222222222222',
    verifiedAt: status === 'failed' || status === 'lease-busy'
      ? null
      : new Date('2026-08-19T12:05:00.000Z'),
    ...(status === 'failed'
      ? { errorCode: 'BACKSTAGE_NOTION_SYNC_INCOMPLETE' }
      : {}),
  };
}

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

  it('keeps process readiness independent from a cold sync beyond 300 seconds', async () => {
    const coldSync = createDeferred<readonly BackstageNotionSyncResult[]>();
    const sync = jest.fn(() => coldSync.promise);
    let processReady = false;

    const handle = startBackstageNotionSyncLoop({
      intervalMs: BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS,
      sync,
      logger: testLogger,
      reportBootstrapLifecycle: true,
    });
    // jobRunner commits the sentinel synchronously after installing this timer.
    processReady = true;

    expect(sync).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalledWith(
      'backstage.notion_sync.bootstrap_scheduled',
      expect.objectContaining({ processReady: false, syncInProgress: false })
    );

    await jest.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(processReady).toBe(true);
    expect(loggerInfo).toHaveBeenCalledWith(
      'backstage.notion_sync.bootstrap_started',
      expect.objectContaining({ syncInProgress: true })
    );

    await jest.advanceTimersByTimeAsync(300_001);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(processReady).toBe(true);
    expect(loggerInfo).not.toHaveBeenCalledWith(
      'backstage.notion_sync.bootstrap_completed',
      expect.anything()
    );

    coldSync.resolve([syncResult('activated')]);
    await jest.advanceTimersByTimeAsync(0);
    expect(processReady).toBe(true);
    expect(loggerInfo).toHaveBeenCalledWith(
      'backstage.notion_sync.bootstrap_completed',
      expect.objectContaining({
        syncInProgress: false,
        syncOutcome: 'activated',
      })
    );

    handle.stop();
  });

  it.each([
    ['lease-busy', 'info', 'backstage.notion_sync.bootstrap_lease_busy'],
    ['failed', 'warn', 'backstage.notion_sync.bootstrap_failed'],
  ] as const)(
    'keeps bootstrap asynchronous when the first cycle is %s',
    async (status, level, event) => {
      const sync = jest.fn(async () => [syncResult(status)]);
      const handle = startBackstageNotionSyncLoop({
        intervalMs: BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS,
        sync,
        logger: testLogger,
        reportBootstrapLifecycle: true,
      });
      const processReady = true;

      await jest.advanceTimersByTimeAsync(0);

      expect(processReady).toBe(true);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(level === 'info' ? loggerInfo : loggerWarn).toHaveBeenCalledWith(
        event,
        expect.objectContaining({
          syncInProgress: false,
        })
      );

      handle.stop();
    }
  );

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
      expect.objectContaining({ module: 'backstage-notion-sync' })
    );
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain(
      'test-only synchronization failure'
    );

    await jest.advanceTimersByTimeAsync(BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(loggerInfo).toHaveBeenCalledWith(
      'backstage.notion_rag.sync_cycle_completed',
      expect.objectContaining({ configuredUniverses: 0 })
    );

    handle.stop();
  });

  it('keeps bootstrap failure telemetry and repeated shutdown fail-safe', async () => {
    const sync = jest.fn()
      .mockRejectedValue(new Error('test-only synchronization failure'));
    const throwingLogger = {
      info: jest.fn(() => {
        throw new Error('test-only info logger failure');
      }),
      warn: jest.fn(() => {
        throw new Error('test-only warn logger failure');
      }),
    };
    const handle = startBackstageNotionSyncLoop({
      intervalMs: BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS,
      sync,
      logger: throwingLogger,
      reportBootstrapLifecycle: true,
    });

    await expect(jest.advanceTimersByTimeAsync(0)).resolves.toBeUndefined();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(throwingLogger.warn).toHaveBeenCalledWith(
      'backstage.notion_sync.bootstrap_failed',
      expect.objectContaining({
        syncInProgress: false,
        syncOutcome: 'failed',
      })
    );

    expect(() => handle.stop()).not.toThrow();
    expect(() => handle.stop()).not.toThrow();
  });

  it('surfaces a swallowed worker budget pause before classifying a sync result', async () => {
    const budgetError = new WorkerAiCallBudgetPausedError(
      '2026-08-30T15:00:00.000Z'
    );
    const onOperationalFailure = jest.fn();
    const sync = jest.fn(async () => {
      try {
        await instrumentOpenAIOperation({
          operation: 'embeddings_create',
          model: 'text-embedding-3-small',
          callback: async () => {
            throw budgetError;
          },
        });
      } catch {
        // Production synchronization may project an isolated provider failure.
      }
      return [syncResult('failed')];
    });
    const handle = startBackstageNotionSyncLoop({
      intervalMs: BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS,
      sync,
      logger: testLogger,
      workerBudget: {
        statsWorkerId: 'async-queue',
        workerId: 'async-queue-slot-1',
        maxCallsPerHour: 120,
        onOperationalFailure,
      },
    });

    await jest.advanceTimersByTimeAsync(0);

    expect(onOperationalFailure).toHaveBeenCalledWith(budgetError);
    expect(loggerWarn).toHaveBeenCalledWith(
      'backstage.notion_rag.sync_cycle_failed',
      expect.objectContaining({ module: 'backstage-notion-sync' })
    );
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain(
      budgetError.message
    );
    expect(loggerWarn).not.toHaveBeenCalledWith(
      'backstage.notion_rag.sync_cycle_completed_with_failures',
      expect.anything()
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

  it('stop-and-drain aborts active work, waits for cleanup, and is idempotent', async () => {
    let cycleSignal: AbortSignal | undefined;
    let releaseCleanup!: () => void;
    const sync = jest.fn(({ signal }: { signal?: AbortSignal }) => {
      cycleSignal = signal;
      return new Promise<readonly []>((resolve) => {
        releaseCleanup = () => resolve([]);
      });
    });
    const handle = startBackstageNotionSyncLoop({
      intervalMs: BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS,
      sync,
      logger: testLogger,
    });

    await jest.advanceTimersByTimeAsync(0);
    let drained = false;
    const firstDrain = handle.stopAndDrain();
    const second = handle.stopAndDrain();
    expect(second).toBe(firstDrain);
    const first = firstDrain.then(() => { drained = true; });
    expect(cycleSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(drained).toBe(false);
    releaseCleanup();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(drained).toBe(true);
    expect(loggerInfo).not.toHaveBeenCalledWith(
      'backstage.notion_rag.sync_cycle_completed',
      expect.anything()
    );
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

  it('commits core readiness before either asynchronous authority cycle can run', () => {
    const source = fs
      .readFileSync(path.resolve('src/workers/jobRunner.ts'), 'utf8')
      .replace(/\r\n/gu, '\n');
    const databaseBootstrapIndex = source.indexOf(
      "await initializeJobRunnerDatabaseWithRetry('job-runner'"
    );
    const adapterInitializationIndex = source.indexOf(
      'initializeWorkerOpenAIAdapterIfConfigured();',
      databaseBootstrapIndex
    );
    const configurationPreflightIndex = source.indexOf(
      'validateBackstageNotionSynchronizationConfiguration();',
      adapterInitializationIndex
    );
    const partitionPolicyIndex = source.indexOf(
      'const backstageNotionPartitionPolicy =',
      configurationPreflightIndex
    );
    const coordinatorIndex = source.indexOf(
      'createBackstageNotionSynchronizationCoordinator()',
      partitionPolicyIndex
    );
    const executorIndex = source.indexOf(
      'createBackstageNotionPartitionSyncJobExecutor({',
      coordinatorIndex
    );
    const slotStartIndex = source.indexOf(
      'const slotRuntimePromise = runWorkerConsumerSlot(',
      executorIndex
    );
    const executorInjectionIndex = source.indexOf(
      'partitionSyncExecutor',
      slotStartIndex
    );
    const readinessBarrierIndex = source.indexOf(
      'await commitAllWorkerSlotsReadyOrThrow(',
      executorInjectionIndex
    );
    const syncStartIndex = source.indexOf(
      'backstageNotionLoopHandles.monolith = startBackstageNotionSyncLoop({',
      readinessBarrierIndex
    );
    const shadowStartIndex = source.indexOf(
      'startBackstageNotionPartitionShadowLoop({',
      syncStartIndex
    );
    const readinessSignalIndex = source.indexOf(
      'emitWorkerBootstrapReadySignal()',
      shadowStartIndex
    );
    const runtimeBarrierIndex = source.indexOf(
      'await Promise.all(slotRuntimePromises)',
      readinessSignalIndex
    );
    const syncDrainIndex = source.indexOf(
      'backstageNotionLoopHandles.monolith?.stopAndDrain()',
      runtimeBarrierIndex
    );
    const shadowDrainIndex = source.indexOf(
      'backstageNotionLoopHandles.partition?.stopAndDrain()',
      runtimeBarrierIndex
    );

    expect([
      databaseBootstrapIndex,
      adapterInitializationIndex,
      configurationPreflightIndex,
      partitionPolicyIndex,
      coordinatorIndex,
      executorIndex,
      slotStartIndex,
      executorInjectionIndex,
      readinessBarrierIndex,
      readinessSignalIndex,
      syncStartIndex,
      shadowStartIndex,
      runtimeBarrierIndex,
      syncDrainIndex,
      shadowDrainIndex,
    ]).not.toContain(-1);
    expect(databaseBootstrapIndex).toBeLessThan(adapterInitializationIndex);
    expect(adapterInitializationIndex).toBeLessThan(configurationPreflightIndex);
    expect(configurationPreflightIndex).toBeLessThan(partitionPolicyIndex);
    expect(partitionPolicyIndex).toBeLessThan(coordinatorIndex);
    expect(coordinatorIndex).toBeLessThan(executorIndex);
    expect(executorIndex).toBeLessThan(slotStartIndex);
    expect(slotStartIndex).toBeLessThan(executorInjectionIndex);
    expect(executorInjectionIndex).toBeLessThan(readinessBarrierIndex);
    expect(readinessBarrierIndex).toBeLessThan(syncStartIndex);
    expect(syncStartIndex).toBeLessThan(shadowStartIndex);
    expect(shadowStartIndex).toBeLessThan(readinessSignalIndex);
    expect(readinessSignalIndex).toBeLessThan(runtimeBarrierIndex);
    expect(runtimeBarrierIndex).toBeLessThan(syncDrainIndex);
    expect(runtimeBarrierIndex).toBeLessThan(shadowDrainIndex);
    expect(source.indexOf('await Promise.all([', runtimeBarrierIndex))
      .toBeLessThan(syncDrainIndex);
    expect(source).not.toContain('await startBackstageNotionSyncLoop(');
    expect(source).not.toContain('await startBackstageNotionPartitionShadowLoop(');
    expect(source).not.toContain(
      'await loadBackstageNotionPartitionCutoverGateEvidenceSet('
    );
    expect(source).not.toContain('ensureBackstageNotionWorkerReadiness');
    expect(source).not.toContain('runBackstageNotionWorkerReadinessGate');
    expect(source).toContain(
      'cutoverEvidence: backstageNotionPartitionCutoverEvidence'
    );
    expect(source).toContain(
      'loadCutoverEvidence:\n                loadBackstageNotionPartitionCutoverGateEvidenceSet'
    );
  });

  it('does not require an OpenAI adapter for a keyless worker startup', () => {
    const source = fs
      .readFileSync(path.resolve('src/workers/jobRunner.ts'), 'utf8')
      .replace(/\r\n/gu, '\n');
    const helperStartIndex = source.indexOf(
      'function initializeWorkerOpenAIAdapterIfConfigured(): void {'
    );
    const helperEndIndex = source.indexOf(
      '\nfunction hasDatabaseConfiguration()',
      helperStartIndex
    );
    const helperSource = source.slice(helperStartIndex, helperEndIndex);
    const missingKeyGuardIndex = helperSource.indexOf(
      'if (!unified.openaiApiKey?.trim()) {'
    );
    const earlyReturnIndex = helperSource.indexOf('return;', missingKeyGuardIndex);
    const providerRuntimeSyncIndex = helperSource.indexOf(
      'syncOpenAIProviderRuntime({',
      earlyReturnIndex
    );
    const adapterInitializationIndex = helperSource.indexOf(
      'initOpenAIClient();',
      providerRuntimeSyncIndex
    );

    expect(helperStartIndex).toBeGreaterThanOrEqual(0);
    expect(helperEndIndex).toBeGreaterThan(helperStartIndex);
    expect(missingKeyGuardIndex).toBeGreaterThanOrEqual(0);
    expect(earlyReturnIndex).toBeGreaterThan(missingKeyGuardIndex);
    expect(providerRuntimeSyncIndex).toBeGreaterThan(earlyReturnIndex);
    expect(adapterInitializationIndex).toBeGreaterThan(providerRuntimeSyncIndex);
  });

});

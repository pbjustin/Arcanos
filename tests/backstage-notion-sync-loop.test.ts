import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { BackstageNotionActiveInventory } from '../src/core/db/repositories/backstageNotionRagRepository.js';
import type { BackstageNotionAuthorityConfiguration } from '../src/services/backstageNotionAuthority.js';
import {
  BACKSTAGE_NOTION_RAG_INDEX_FORMAT,
  type BackstageNotionSyncResult,
} from '../src/services/backstageNotionSync.js';
import { BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION } from '../src/shared/backstage/backstageNotionRagCore.js';
import {
  BACKSTAGE_NOTION_SYNC_INTERVAL_DEFAULT_MS,
  BACKSTAGE_NOTION_SYNC_INTERVAL_MAX_MS,
  BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS,
  BACKSTAGE_NOTION_WORKER_READINESS_ERROR_CODE,
  ensureBackstageNotionWorkerReadiness,
  resolveBackstageNotionSyncIntervalMs,
  startBackstageNotionSyncLoop,
} from '../src/workers/backstageNotionSyncLoop.js';

const loggerInfo = jest.fn();
const loggerWarn = jest.fn();
const testLogger = { info: loggerInfo, warn: loggerWarn };
const universeId = 'my-universe-2k26';
const rootPageId = '21f5a0ff-752e-8065-a204-e1735b744185';

const validConfiguration: BackstageNotionAuthorityConfiguration = {
  status: 'valid',
  roots: [{
    universeId,
    rootPageId,
    displayName: 'WWE Universe Mode',
  }],
};

function inventory(current: boolean): BackstageNotionActiveInventory {
  const timestamp = new Date('2026-08-19T12:00:00.000Z');
  return {
    authority: 'notion',
    verifiedAt: timestamp,
    snapshot: {
      id: '11111111-1111-4111-8111-111111111111',
      universeId,
      rootPageId,
      manifestHash: 'a'.repeat(64),
      embeddingModel: 'text-embedding-3-small',
      pageCount: 1,
      chunkCount: 1,
      sourceMaxEditedAt: timestamp,
      syncHolderId: 'test-holder',
      createdAt: timestamp,
    },
    pages: [{
      pageId: rootPageId,
      parentPageId: null,
      title: 'WWE Universe Mode',
      canonicalUrl: null,
      contentHash: 'b'.repeat(64),
      sourceLastEditedAt: timestamp,
      depth: 0,
      path: ['WWE Universe Mode'],
      metadata: current
        ? {
            headingIndexVersion: BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION,
            indexFormat: BACKSTAGE_NOTION_RAG_INDEX_FORMAT,
          }
        : {},
    }],
  };
}

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

  it('passes readiness without repository or provider work when no authority is configured', async () => {
    const loadActiveInventory = jest.fn(async () => null);
    const sync = jest.fn(async () => []);

    await expect(ensureBackstageNotionWorkerReadiness({
      readConfiguration: () => ({ status: 'absent', roots: [] }),
      repository: { loadActiveInventory },
      sync,
    })).resolves.toEqual({
      configuredUniverses: 0,
      currentBeforeSync: 0,
      syncAttempted: false,
      activated: 0,
      unchanged: 0,
    });
    expect(loadActiveInventory).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it('passes readiness from current inventory without calling the Notion sync', async () => {
    const loadActiveInventory = jest.fn(async () => inventory(true));
    const sync = jest.fn(async () => []);

    await expect(ensureBackstageNotionWorkerReadiness({
      readConfiguration: () => validConfiguration,
      repository: { loadActiveInventory },
      sync,
    })).resolves.toEqual({
      configuredUniverses: 1,
      currentBeforeSync: 1,
      syncAttempted: false,
      activated: 0,
      unchanged: 0,
    });
    expect(loadActiveInventory).toHaveBeenCalledTimes(1);
    expect(loadActiveInventory).toHaveBeenCalledWith(universeId);
    expect(sync).not.toHaveBeenCalled();
  });

  it.each(['activated', 'unchanged'] as const)(
    'admits readiness after a successful %s upgrade and current inventory reload',
    async status => {
      const loadActiveInventory = jest.fn()
        .mockResolvedValueOnce(inventory(false))
        .mockResolvedValueOnce(inventory(true));
      const sync = jest.fn(async () => [syncResult(status)]);

      await expect(ensureBackstageNotionWorkerReadiness({
        readConfiguration: () => validConfiguration,
        repository: { loadActiveInventory },
        sync,
      })).resolves.toEqual({
        configuredUniverses: 1,
        currentBeforeSync: 0,
        syncAttempted: true,
        activated: status === 'activated' ? 1 : 0,
        unchanged: status === 'unchanged' ? 1 : 0,
      });
      expect(loadActiveInventory).toHaveBeenCalledTimes(2);
      expect(sync).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['lease-busy', 'failed'] as const)(
    'fails readiness when the required upgrade result is %s',
    async status => {
      const loadActiveInventory = jest.fn(async () => inventory(false));
      const sync = jest.fn(async () => [syncResult(status)]);

      await expect(ensureBackstageNotionWorkerReadiness({
        readConfiguration: () => validConfiguration,
        repository: { loadActiveInventory },
        sync,
      })).rejects.toMatchObject({
        code: BACKSTAGE_NOTION_WORKER_READINESS_ERROR_CODE,
        reason: 'sync-result-incomplete',
      });
      expect(loadActiveInventory).toHaveBeenCalledTimes(1);
    }
  );

  it('fails readiness when synchronization omits one configured authority', async () => {
    const secondUniverseId = 'secondary-universe';
    const twoRootConfiguration: BackstageNotionAuthorityConfiguration = {
      status: 'valid',
      roots: [
        ...validConfiguration.roots,
        {
          universeId: secondUniverseId,
          rootPageId: '31f5a0ff-752e-8065-a204-e1735b744185',
          displayName: 'Secondary Universe',
        },
      ],
    };
    const loadActiveInventory = jest.fn(async () => null);
    const sync = jest.fn(async () => [syncResult('activated')]);

    await expect(ensureBackstageNotionWorkerReadiness({
      readConfiguration: () => twoRootConfiguration,
      repository: { loadActiveInventory },
      sync,
    })).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_WORKER_READINESS_ERROR_CODE,
      reason: 'sync-result-incomplete',
    });
    expect(loadActiveInventory).toHaveBeenCalledTimes(2);
    expect(loadActiveInventory).toHaveBeenCalledWith(secondUniverseId);
  });

  it('fails readiness when a successful sync does not leave current page metadata', async () => {
    const loadActiveInventory = jest.fn(async () => inventory(false));
    const sync = jest.fn(async () => [syncResult('activated')]);

    await expect(ensureBackstageNotionWorkerReadiness({
      readConfiguration: () => validConfiguration,
      repository: { loadActiveInventory },
      sync,
    })).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_WORKER_READINESS_ERROR_CODE,
      reason: 'index-not-current',
    });
    expect(loadActiveInventory).toHaveBeenCalledTimes(2);
  });

  it('fails readiness before repository or provider work for invalid configuration', async () => {
    const invalidConfiguration: BackstageNotionAuthorityConfiguration = {
      status: 'invalid',
      roots: [],
      reason: 'invalid_shape',
    };
    const loadActiveInventory = jest.fn(async () => null);
    const sync = jest.fn(async () => []);

    await expect(ensureBackstageNotionWorkerReadiness({
      readConfiguration: () => invalidConfiguration,
      repository: { loadActiveInventory },
      sync,
    })).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_WORKER_READINESS_ERROR_CODE,
      reason: 'configuration-invalid',
    });
    expect(loadActiveInventory).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it('fails readiness immediately for caller and reasonless abort signals', async () => {
    const callerReason = new Error('test-only readiness shutdown');
    const callerController = new AbortController();
    callerController.abort(callerReason);

    await expect(ensureBackstageNotionWorkerReadiness({
      signal: callerController.signal,
    })).rejects.toBe(callerReason);
    await expect(ensureBackstageNotionWorkerReadiness({
      signal: {
        aborted: true,
        reason: undefined,
      } as AbortSignal,
    })).rejects.toThrow('Backstage Notion worker readiness aborted.');
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

  it('gates readiness before the signal, then starts and stops the recurring loop', () => {
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
    const notionReadinessIndex = source.indexOf(
      'await ensureBackstageNotionWorkerReadiness({',
      adapterInitializationIndex
    );
    const readinessBarrierIndex = source.indexOf(
      'await commitAllWorkerSlotsReadyOrThrow(',
      notionReadinessIndex
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
      databaseBootstrapIndex,
      adapterInitializationIndex,
      notionReadinessIndex,
      readinessBarrierIndex,
      readinessSignalIndex,
      syncStartIndex,
      runtimeBarrierIndex,
      syncStopIndex,
    ]).not.toContain(-1);
    expect(databaseBootstrapIndex).toBeLessThan(adapterInitializationIndex);
    expect(adapterInitializationIndex).toBeLessThan(notionReadinessIndex);
    expect(notionReadinessIndex).toBeLessThan(readinessBarrierIndex);
    expect(readinessBarrierIndex).toBeLessThan(readinessSignalIndex);
    expect(readinessSignalIndex).toBeLessThan(syncStartIndex);
    expect(syncStartIndex).toBeLessThan(runtimeBarrierIndex);
    expect(runtimeBarrierIndex).toBeLessThan(syncStopIndex);
    expect(source).not.toContain('await startBackstageNotionSyncLoop(');
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

  it('uses the production readiness dependency defaults with a bounded signal', async () => {
    const loadActiveInventory = jest.fn()
      .mockResolvedValueOnce(inventory(false))
      .mockResolvedValueOnce(inventory(true));
    const getRepository = jest.fn(() => ({ loadActiveInventory }));
    const readConfiguration = jest.fn(() => validConfiguration);
    const sync = jest.fn(async () => [syncResult('activated')]);

    jest.resetModules();
    jest.unstable_mockModule(
      '@core/db/repositories/backstageNotionRagRepository.js',
      () => ({ getBackstageNotionRagRepository: getRepository })
    );
    jest.unstable_mockModule(
      '@services/backstageNotionAuthority.js',
      () => ({ readBackstageNotionAuthorityConfiguration: readConfiguration })
    );
    jest.unstable_mockModule(
      '@services/backstageNotionSync.js',
      () => ({
        BACKSTAGE_NOTION_RAG_INDEX_FORMAT,
        syncConfiguredBackstageNotionAuthorities: sync,
      })
    );

    try {
      const defaultsModule = await import(
        '../src/workers/backstageNotionSyncLoop.js'
      );
      const controller = new AbortController();

      await expect(defaultsModule.ensureBackstageNotionWorkerReadiness({
        signal: controller.signal,
      })).resolves.toEqual({
        configuredUniverses: 1,
        currentBeforeSync: 0,
        syncAttempted: true,
        activated: 1,
        unchanged: 0,
      });
      expect(readConfiguration).toHaveBeenCalledTimes(1);
      expect(getRepository).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledWith({ signal: controller.signal });
      expect(loadActiveInventory).toHaveBeenCalledTimes(2);
    } finally {
      jest.unstable_unmockModule(
        '@core/db/repositories/backstageNotionRagRepository.js'
      );
      jest.unstable_unmockModule('@services/backstageNotionAuthority.js');
      jest.unstable_unmockModule('@services/backstageNotionSync.js');
      jest.resetModules();
    }
  });
});

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, jest, test } from '@jest/globals';

import {
  requiresBackstageNotionMonolithWorkerReadiness,
  resolveBackstageNotionPartitionShadowPolicy,
  runBackstageNotionWorkerReadinessGate,
  startBackstageNotionPartitionShadowLoop,
  type BackstageNotionPartitionShadowCycleResult,
} from '../src/workers/backstageNotionPartitionShadowLoop.js';
import {
  createBackstageNotionSynchronizationCoordinator,
  startBackstageNotionSyncLoop,
} from '../src/workers/backstageNotionSyncLoop.js';
import type {
  BackstageNotionPartitionCutoverGateEvidence,
} from '../src/shared/backstage/backstageNotionPartitionCutoverGate.js';
import { DEFAULT_OPENAI_EMBEDDING_MODEL } from
  '../src/services/openai/embeddings.js';

const INTERVAL_MS = 60_000;
const ROOT_PAGE_ID = '11111111-1111-4111-8111-111111111111';
const MONOLITH_SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const PARTITION_MANIFEST_ID = '33333333-3333-4333-8333-333333333333';
const FRESH_SNAPSHOT_ID = '44444444-4444-4444-8444-444444444444';
const CONFIGURATION_VERSION_ID = '55555555-5555-4555-8555-555555555555';

const VALID_CONFIGURATION = JSON.stringify({
  version: 1,
  generation: 'shadow-generation-1',
  universes: [{
    universeId: 'my-universe-2k26',
    shards: [{
      shardKey: 'raw/2026',
      rootPageId: ROOT_PAGE_ID,
      displayName: 'Monday Night Raw 2026',
      retrievalTier: 'hot',
      required: true,
      scopeTags: ['brand:raw', 'year:2026'],
      categoryTags: ['current-canon'],
      capacity: {
        maxPages: 512,
        maxChunks: 2_048,
        maxDepth: 16,
        maxContentCodePoints: 4_000_000,
      },
    }],
  }],
});
const VALID_SEMANTIC_DIGEST = resolveBackstageNotionPartitionShadowPolicy(
  environment({
    ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'shadow',
    ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON: VALID_CONFIGURATION,
  })
).semanticDigest!;

function completeCutoverEvidence(): BackstageNotionPartitionCutoverGateEvidence {
  const now = Date.now();
  const sourceGenerationId = '66666666-6666-4666-8666-666666666666';
  return Object.freeze({
    evidenceVersion: 1,
    reconciliationGeneration: 7,
    activeReconciliationGeneration: 7,
    publishedReconciliationGeneration: 7,
    universeId: 'my-universe-2k26',
    manifestId: PARTITION_MANIFEST_ID,
    activeManifestId: PARTITION_MANIFEST_ID,
    manifestState: 'sealed' as const,
    manifestReadable: true,
    manifestConfigurationVersionId: CONFIGURATION_VERSION_ID,
    activeConfigurationVersionId: CONFIGURATION_VERSION_ID,
    configurationHash: VALID_SEMANTIC_DIGEST,
    activeConfigurationHash: VALID_SEMANTIC_DIGEST,
    sourceGenerationId,
    sourceDigest: 'a'.repeat(64),
    sourcePageCount: 2,
    sourceChunkCount: 3,
    sourceVerifiedAt: new Date(now - 120_000),
    sourceVerificationHash: 'b'.repeat(64),
    manifestPageCount: 2,
    manifestChunkCount: 3,
    embeddingModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
    indexFormatVersion: 1,
    memberCount: 1,
    omissionCount: 0,
    members: Object.freeze([Object.freeze({
      shardKey: 'raw/2026',
      snapshotId: FRESH_SNAPSHOT_ID,
      sourceGenerationId,
      indexFormatVersion: 1,
      pageCount: 2,
      chunkCount: 3,
      decision: 'fresh' as const,
      readable: true,
    })]),
    leaseFencingClear: true,
    unresolvedActivationCount: 0,
    parity: Object.freeze({
      shadowComparisonCompleted: true,
      exactScopeParityPassed: true,
      relevantRetrievalParityPassed: true,
      completeScopeParityPassed: true,
      cursorStabilityPassed: true,
    }),
    rollbackMonolithSnapshotId: MONOLITH_SNAPSHOT_ID,
    rollbackMonolithReadable: true,
    rollbackMonolithChunkCount: 4,
    rollbackMonolithValidationVerifiedAt: new Date(now - 120_000),
    rollbackMonolithVerifiedAt: new Date(now - 120_000),
    rollbackMonolithValidUntil: new Date(now + 60 * 60_000),
    verifiedAt: new Date(now - 60_000),
    expiresAt: new Date(now + 60 * 60_000),
  });
}

function environment(values: Readonly<Record<string, string | undefined>>) {
  return (name: string): string | undefined => values[name];
}

function successfulCycleResult(): BackstageNotionPartitionShadowCycleResult {
  return {
    synchronization: {
      kind: 'full_reconciliation',
      universes: [{
        universeId: 'my-universe-2k26',
        configurationVersionId: CONFIGURATION_VERSION_ID,
        manifestStatus: 'published',
        manifestId: PARTITION_MANIFEST_ID,
        memberCount: 1,
        omissionCount: 0,
        manifestOmissions: [],
        shardResults: [{
          universeId: 'my-universe-2k26',
          shardKey: 'raw/2026',
          status: 'fresh',
          safeReasonCode: null,
          freshSnapshotId: FRESH_SNAPSHOT_ID,
          fullSourceScan: true,
          pageCount: 2,
          chunkCount: 3,
          pageVersionReuseCount: 1,
          embeddedChunkCount: 1,
          leaseReleaseVerified: true,
          pageChanges: {
            added: 1,
            changed: 0,
            moved: 0,
            deleted: 0,
            unchanged: 1,
          },
        }],
      }],
    },
    coverage: [{
      universeId: 'my-universe-2k26',
      monolithSnapshotId: MONOLITH_SNAPSHOT_ID,
      partitionManifestId: PARTITION_MANIFEST_ID,
      partitionConfigurationHash: VALID_SEMANTIC_DIGEST,
      monolithPageCount: 2,
      monolithChunkCount: 4,
      partitionPageCount: 2,
      partitionChunkCount: 3,
      sharedPageCount: 2,
      monolithOnlyPageCount: 0,
      partitionOnlyPageCount: 0,
      monolithOnlyPageIds: [],
      partitionOnlyPageIds: [],
    }],
    coverageUnavailable: 0,
  };
}

function shadowEnvironment(): (name: string) => string | undefined {
  return environment({
    ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'shadow',
    ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON: VALID_CONFIGURATION,
  });
}

function partitionedEnvironment(): (name: string) => string | undefined {
  return environment({
    ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'partitioned',
    ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON: VALID_CONFIGURATION,
  });
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('Backstage Notion partition shadow worker policy', () => {
  test.each([
    [{}, false, 'absent', 'MODE_ABSENT'],
    [{ ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'monolith' }, false,
      'monolith', 'MODE_MONOLITH'],
    [{ ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: ' shadow ' }, false,
      'invalid', 'MODE_INVALID'],
    [{ ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'SHADOW' }, false,
      'invalid', 'MODE_INVALID'],
    [{ ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'future' }, false,
      'invalid', 'MODE_INVALID'],
    [{ ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'shadow' }, false,
      'shadow', 'SHADOW_CONFIGURATION_ABSENT'],
    [{
      ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'shadow',
      ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON: '{',
    }, false, 'shadow', 'SHADOW_CONFIGURATION_INVALID'],
    [{
      ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'partitioned',
    }, false, 'partitioned', 'PARTITIONED_CONFIGURATION_ABSENT'],
    [{
      ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'partitioned',
      ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON: '{',
    }, false, 'partitioned', 'PARTITIONED_CONFIGURATION_INVALID'],
    [{
      ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'partitioned',
      ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON: VALID_CONFIGURATION,
    }, true, 'partitioned', 'PARTITIONED_CUTOVER_GATE_CLOSED'],
    [{
      ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'shadow',
      ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON: VALID_CONFIGURATION,
    }, true, 'shadow', 'SHADOW_ENABLED'],
  ] as const)(
    'resolves exact mode/configuration policy %#',
    (values, enabled, requestedMode, reasonCode) => {
      expect(resolveBackstageNotionPartitionShadowPolicy(environment(values)))
        .toMatchObject({ enabled, requestedMode, reasonCode });
    }
  );

  test('turns an environment-reader exception into a bounded disabled policy', () => {
    expect(resolveBackstageNotionPartitionShadowPolicy(() => {
      throw new Error('raw environment failure');
    })).toEqual(expect.objectContaining({
      enabled: false,
      configurationStatus: 'unavailable',
      reasonCode: 'ENVIRONMENT_READ_FAILED',
    }));
  });

  test.each([
    ['shadow', shadowEnvironment()],
    ['partitioned-without-evidence', partitionedEnvironment()],
  ] as const)(
    'requires monolith readiness for %s',
    async (_mode, readEnvironment) => {
      const policy = resolveBackstageNotionPartitionShadowPolicy(readEnvironment);
      const ensureReadiness = jest.fn(async () => ({ configuredUniverses: 1 }));

      expect(requiresBackstageNotionMonolithWorkerReadiness(policy)).toBe(true);
      await expect(runBackstageNotionWorkerReadinessGate(
        policy,
        ensureReadiness
      )).resolves.toEqual({
        monolithReadinessRequired: true,
        evidence: { configuredUniverses: 1 },
      });
      expect(ensureReadiness).toHaveBeenCalledTimes(1);
    }
  );

  test('skips a duplicate monolith crawl only for admitted partitioned mode', async () => {
    const policy = resolveBackstageNotionPartitionShadowPolicy(
      partitionedEnvironment(),
      [completeCutoverEvidence()]
    );
    const ensureReadiness = jest.fn(async () => ({ configuredUniverses: 1 }));

    expect(policy).toMatchObject({
      cutoverAvailable: true,
      effectiveReadMode: 'partitioned',
      reasonCode: 'PARTITIONED_ENABLED',
    });
    expect(requiresBackstageNotionMonolithWorkerReadiness(policy)).toBe(false);
    await expect(runBackstageNotionWorkerReadinessGate(
      policy,
      ensureReadiness
    )).resolves.toEqual({
      monolithReadinessRequired: false,
      evidence: null,
    });
    expect(ensureReadiness).not.toHaveBeenCalled();
  });

  test.each([
    ['absent', environment({})],
    ['monolith', environment({
      ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'monolith',
    })],
    ['invalid-mode', environment({
      ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'SHADOW',
    })],
    ['missing-shadow-config', environment({
      ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'shadow',
    })],
    ['invalid-partitioned-config', environment({
      ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'partitioned',
      ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON: '{',
    })],
  ] as const)(
    'runs and propagates monolith readiness for the %s fallback policy',
    async (_case, readEnvironment) => {
      const policy = resolveBackstageNotionPartitionShadowPolicy(readEnvironment);
      const failure = new Error('bounded monolith readiness failure');
      const ensureReadiness = jest.fn(async () => Promise.reject(failure));

      expect(requiresBackstageNotionMonolithWorkerReadiness(policy)).toBe(true);
      await expect(runBackstageNotionWorkerReadinessGate(
        policy,
        ensureReadiness
      )).rejects.toBe(failure);
      expect(ensureReadiness).toHaveBeenCalledTimes(1);
    }
  );

  test('never logs invalid raw mode or raw partition configuration', async () => {
    const warn = jest.fn();
    const secretRawValue = ' Shadow secret-root-page ';
    const handle = startBackstageNotionPartitionShadowLoop({
      readEnvironment: environment({
        ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: secretRawValue,
        ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON: '{"secret":"page-content"}',
      }),
      logger: { info: jest.fn(), warn } as never,
    });

    expect(handle.enabled).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secretRawValue);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('page-content');
    await expect(handle.stopAndDrain()).resolves.toBeUndefined();
  });

  test.each([
    {},
    { ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'monolith' },
    { ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'SHADOW' },
    { ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'shadow' },
    {
      ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'shadow',
      ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON: '{',
    },
    {
      ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'partitioned',
    },
    {
      ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'partitioned',
      ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON: '{',
    },
  ])('performs zero shadow work for disabled policy %#', async values => {
    jest.useFakeTimers();
    const runCycle = jest.fn(async () => successfulCycleResult());
    const handle = startBackstageNotionPartitionShadowLoop({
      readEnvironment: environment(values),
      intervalMs: INTERVAL_MS,
      runCycle,
      logger: { info: jest.fn(), warn: jest.fn() } as never,
    });

    expect(handle.enabled).toBe(false);
    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(runCycle).not.toHaveBeenCalled();
    await handle.stopAndDrain();
  });
});

describe('Backstage Notion partition shadow worker lifecycle', () => {
  test.each([
    ['shadow', shadowEnvironment(), undefined, 'monolith', true, true, false, false],
    [
      'partitioned-gate-closed',
      partitionedEnvironment(),
      undefined,
      'monolith',
      false,
      false,
      false,
      false,
    ],
    [
      'partitioned-admitted',
      partitionedEnvironment(),
      [completeCutoverEvidence()],
      'partitioned',
      false,
      false,
      true,
      true,
    ],
  ] as const)(
    'keeps the loop active with writes enabled only in exact shadow mode: %s',
    async (_mode, readEnvironment, cutoverEvidence, effectiveReadMode,
      partitionSyncEnabled, shadowSyncEnabled, partitionedReadEnabled,
      cutoverAvailable) => {
      jest.useFakeTimers();
      const info = jest.fn();
      const runCycle = jest.fn(async () => successfulCycleResult());
      const handle = startBackstageNotionPartitionShadowLoop({
        readEnvironment,
        intervalMs: INTERVAL_MS,
        initialDelayMs: 0,
        runCycle,
        logger: { info, warn: jest.fn() } as never,
        cutoverEvidence,
      });

      expect(handle.enabled).toBe(true);
      expect(info).toHaveBeenCalledWith(
        'backstage.notion_partition.shadow_enabled',
        expect.objectContaining({
          effectiveReadMode,
          partitionSyncEnabled,
          shadowSyncEnabled,
          partitionedReadEnabled,
          cutoverAvailable,
        })
      );
      expect(JSON.stringify(info.mock.calls)).not.toContain(ROOT_PAGE_ID);
      await jest.advanceTimersByTimeAsync(0);
      if (partitionSyncEnabled) {
        expect(runCycle).toHaveBeenCalledTimes(1);
        expect(info).toHaveBeenCalledWith(
          'backstage.notion_partition.shadow_cycle_completed',
          expect.objectContaining({ effectiveReadMode })
        );
      } else {
        expect(runCycle).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledWith(
          'backstage.notion_partition.shadow_cycle_skipped',
          expect.objectContaining({
            effectiveReadMode,
            partitionSyncEnabled: false,
          })
        );
      }
      await handle.stopAndDrain();
    }
  );

  test('refreshes durable evidence in partitioned mode without running a write cycle', async () => {
    jest.useFakeTimers();
    const info = jest.fn();
    const loadCutoverEvidence = jest.fn(async () => Object.freeze([]));
    const runCycle = jest.fn(async () => successfulCycleResult());
    const handle = startBackstageNotionPartitionShadowLoop({
      readEnvironment: partitionedEnvironment(),
      intervalMs: INTERVAL_MS,
      runCycle,
      logger: { info, warn: jest.fn() } as never,
      cutoverEvidence: [completeCutoverEvidence()],
      loadCutoverEvidence,
    });

    expect(info).toHaveBeenCalledWith(
      'backstage.notion_partition.shadow_enabled',
      expect.objectContaining({
        effectiveReadMode: 'partitioned',
        cutoverAvailable: true,
      })
    );
    await jest.advanceTimersByTimeAsync(0);

    expect(loadCutoverEvidence).toHaveBeenCalledTimes(1);
    expect(loadCutoverEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ semanticDigest: VALID_SEMANTIC_DIGEST })
    );
    expect(info).toHaveBeenCalledWith(
      'backstage.notion_partition.shadow_cycle_skipped',
      expect.objectContaining({
        effectiveReadMode: 'monolith',
        cutoverAvailable: false,
        partitionSyncEnabled: false,
        reasonCode: 'PARTITIONED_CUTOVER_GATE_CLOSED',
      })
    );
    expect(runCycle).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(loadCutoverEvidence).toHaveBeenCalledTimes(2);
    expect(runCycle).not.toHaveBeenCalled();
    await handle.stopAndDrain();
    expect(info).toHaveBeenCalledWith(
      'backstage.notion_partition.shadow_drained',
      expect.objectContaining({ effectiveReadMode: 'monolith' })
    );
  });

  test('rechecks exact shadow mode inside the coordinator before writer effects', async () => {
    jest.useFakeTimers();
    const info = jest.fn();
    const values: Record<string, string | undefined> = {
      ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'shadow',
      ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON: VALID_CONFIGURATION,
    };
    const runCycle = jest.fn(async () => successfulCycleResult());
    const coordinator = {
      runExclusive: async <T>(operation: () => Promise<T>): Promise<T> => {
        values.ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE = 'partitioned';
        return operation();
      },
    };
    const handle = startBackstageNotionPartitionShadowLoop({
      readEnvironment: environment(values),
      intervalMs: INTERVAL_MS,
      initialDelayMs: 0,
      coordinator,
      runCycle,
      logger: { info, warn: jest.fn() } as never,
    });

    await jest.advanceTimersByTimeAsync(0);

    expect(runCycle).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      'backstage.notion_partition.shadow_cycle_skipped',
      expect.objectContaining({
        effectiveReadMode: 'monolith',
        partitionSyncEnabled: false,
        reasonCode: 'PARTITIONED_CUTOVER_GATE_CLOSED',
      })
    );
    await handle.stopAndDrain();
  });

  test('delays the first cycle and measures recurrence from terminal completion', async () => {
    jest.useFakeTimers();
    let resolveCycle!: (value: BackstageNotionPartitionShadowCycleResult) => void;
    const runCycle = jest.fn()
      .mockImplementationOnce(() => new Promise<BackstageNotionPartitionShadowCycleResult>(
        resolve => { resolveCycle = resolve; }
      ))
      .mockResolvedValue(successfulCycleResult());
    const handle = startBackstageNotionPartitionShadowLoop({
      readEnvironment: shadowEnvironment(),
      intervalMs: INTERVAL_MS,
      runCycle,
      logger: { info: jest.fn(), warn: jest.fn() } as never,
    });

    expect(handle.enabled).toBe(true);
    await jest.advanceTimersByTimeAsync(INTERVAL_MS - 1);
    expect(runCycle).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(runCycle).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(runCycle).toHaveBeenCalledTimes(1);

    resolveCycle(successfulCycleResult());
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS - 1);
    expect(runCycle).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(runCycle).toHaveBeenCalledTimes(2);
    await handle.stopAndDrain();
  });

  test('contains synchronous cycle construction failures and schedules a later cycle', async () => {
    jest.useFakeTimers();
    const warn = jest.fn();
    const runCycle = jest.fn(() => {
      throw new Error(`provider body ${ROOT_PAGE_ID}`);
    });
    const handle = startBackstageNotionPartitionShadowLoop({
      readEnvironment: shadowEnvironment(),
      intervalMs: INTERVAL_MS,
      initialDelayMs: 0,
      runCycle,
      logger: { info: jest.fn(), warn } as never,
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(ROOT_PAGE_ID);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('provider body');
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(runCycle).toHaveBeenCalledTimes(2);
    await handle.stopAndDrain();
  });

  test('stop before the first tick is idempotent and starts no work', async () => {
    jest.useFakeTimers();
    const runCycle = jest.fn(async () => successfulCycleResult());
    const handle = startBackstageNotionPartitionShadowLoop({
      readEnvironment: shadowEnvironment(),
      intervalMs: INTERVAL_MS,
      runCycle,
      logger: { info: jest.fn(), warn: jest.fn() } as never,
    });

    const first = handle.stopAndDrain();
    const second = handle.stopAndDrain();
    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(runCycle).not.toHaveBeenCalled();
  });

  test('propagates abort and waits for active cleanup before drain settles', async () => {
    jest.useFakeTimers();
    const info = jest.fn();
    let releaseCleanup!: () => void;
    let observedSignal: AbortSignal | null = null;
    const runCycle = jest.fn(({ signal }: { signal: AbortSignal }) => {
      observedSignal = signal;
      return new Promise<BackstageNotionPartitionShadowCycleResult>(resolve => {
        releaseCleanup = () => resolve(successfulCycleResult());
      });
    });
    const handle = startBackstageNotionPartitionShadowLoop({
      readEnvironment: shadowEnvironment(),
      intervalMs: INTERVAL_MS,
      initialDelayMs: 0,
      runCycle,
      logger: { info, warn: jest.fn() } as never,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(runCycle).toHaveBeenCalledTimes(1);

    let drained = false;
    const drain = handle.stopAndDrain().then(() => { drained = true; });
    expect(observedSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(drained).toBe(false);
    releaseCleanup();
    await drain;
    expect(drained).toBe(true);
    expect(info).not.toHaveBeenCalledWith(
      'backstage.notion_partition.shadow_cycle_completed',
      expect.anything()
    );
    await expect(handle.stopAndDrain()).resolves.toBeUndefined();
  });

  test('serializes monolith and shadow synchronization through one coordinator', async () => {
    jest.useFakeTimers();
    const coordinator = createBackstageNotionSynchronizationCoordinator();
    let active = 0;
    let maximumActive = 0;
    let releaseMonolith!: () => void;
    let releaseShadow!: () => void;
    const monolithSync = jest.fn(() => new Promise<readonly []>(resolve => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      releaseMonolith = () => {
        active -= 1;
        resolve([]);
      };
    }));
    const shadowSync = jest.fn(() => new Promise<BackstageNotionPartitionShadowCycleResult>(
      resolve => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        releaseShadow = () => {
          active -= 1;
          resolve(successfulCycleResult());
        };
      }
    ));
    const monolith = startBackstageNotionSyncLoop({
      intervalMs: INTERVAL_MS,
      coordinator,
      sync: monolithSync,
      logger: { info: jest.fn(), warn: jest.fn() } as never,
    });
    const shadow = startBackstageNotionPartitionShadowLoop({
      readEnvironment: shadowEnvironment(),
      intervalMs: INTERVAL_MS,
      initialDelayMs: 0,
      coordinator,
      runCycle: shadowSync,
      logger: { info: jest.fn(), warn: jest.fn() } as never,
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(monolithSync).toHaveBeenCalledTimes(1);
    expect(shadowSync).not.toHaveBeenCalled();
    releaseMonolith();
    for (let attempt = 0; attempt < 10 && shadowSync.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    expect(shadowSync).toHaveBeenCalledTimes(1);
    expect(maximumActive).toBe(1);
    const drain = Promise.all([
      monolith.stopAndDrain(),
      shadow.stopAndDrain(),
    ]);
    releaseShadow();
    await drain;
    expect(active).toBe(0);
  });

  test('drains shadow-active and legacy-queued shutdown without starting legacy work', async () => {
    jest.useFakeTimers();
    const coordinator = createBackstageNotionSynchronizationCoordinator();
    let releaseShadow!: () => void;
    const shadowSync = jest.fn(() => new Promise<BackstageNotionPartitionShadowCycleResult>(
      resolve => {
        releaseShadow = () => resolve(successfulCycleResult());
      }
    ));
    const monolithSync = jest.fn(async () => []);
    const shadow = startBackstageNotionPartitionShadowLoop({
      readEnvironment: shadowEnvironment(),
      intervalMs: INTERVAL_MS,
      initialDelayMs: 0,
      coordinator,
      runCycle: shadowSync,
      logger: { info: jest.fn(), warn: jest.fn() } as never,
    });
    const monolith = startBackstageNotionSyncLoop({
      intervalMs: INTERVAL_MS,
      coordinator,
      sync: monolithSync,
      logger: { info: jest.fn(), warn: jest.fn() } as never,
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(shadowSync).toHaveBeenCalledTimes(1);
    expect(monolithSync).not.toHaveBeenCalled();
    const drains = Promise.all([
      shadow.stopAndDrain(),
      monolith.stopAndDrain(),
    ]);
    releaseShadow();
    await drains;
    expect(monolithSync).not.toHaveBeenCalled();
  });

  test('releases the synchronization coordinator after a rejected operation', async () => {
    const coordinator = createBackstageNotionSynchronizationCoordinator();
    const first = coordinator.runExclusive(async () => {
      throw new Error('first operation failed');
    });
    const second = coordinator.runExclusive(async () => 'second completed');

    await expect(first).rejects.toThrow('first operation failed');
    await expect(second).resolves.toBe('second completed');
  });

  test('contains logger failures and emits only aggregate cycle evidence', async () => {
    jest.useFakeTimers();
    const info = jest.fn()
      .mockImplementationOnce(() => { throw new Error('logger failed'); })
      .mockImplementation(() => undefined);
    const warn = jest.fn();
    const handle = startBackstageNotionPartitionShadowLoop({
      readEnvironment: shadowEnvironment(),
      intervalMs: INTERVAL_MS,
      initialDelayMs: 0,
      runCycle: async () => successfulCycleResult(),
      logger: { info, warn } as never,
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(info).toHaveBeenCalledWith(
      'backstage.notion_partition.shadow_cycle_completed',
      expect.objectContaining({
        fullSourceScan: true,
        shardsFullyScanned: 1,
        manifestsPublished: 1,
        shardsFresh: 1,
        pageVersionsReused: 1,
        chunksEmbedded: 1,
        coverageCurrentConfiguration: 1,
        coverageOtherConfiguration: 0,
        coverageExactPageParity: 1,
      })
    );
    const logs = JSON.stringify([info.mock.calls, warn.mock.calls]);
    expect(logs).not.toContain(ROOT_PAGE_ID);
    expect(logs).not.toContain(MONOLITH_SNAPSHOT_ID);
    expect(logs).not.toContain(PARTITION_MANIFEST_ID);
    expect(logs).not.toContain('Monday Night Raw');
    await handle.stopAndDrain();
  });

  test('reports stale-manifest coverage separately from the requested configuration', async () => {
    jest.useFakeTimers();
    const warn = jest.fn();
    const result = successfulCycleResult();
    const handle = startBackstageNotionPartitionShadowLoop({
      readEnvironment: shadowEnvironment(),
      intervalMs: INTERVAL_MS,
      initialDelayMs: 0,
      runCycle: async () => ({
        ...result,
        coverage: result.coverage.map(item => ({
          ...item,
          partitionConfigurationHash: 'f'.repeat(64),
        })),
      }),
      logger: { info: jest.fn(), warn } as never,
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith(
      'backstage.notion_partition.shadow_cycle_completed_with_failures',
      expect.objectContaining({
        coverageCurrentConfiguration: 0,
        coverageOtherConfiguration: 1,
        coverageExactPageParity: 0,
      })
    );
    await handle.stopAndDrain();
  });

  test('retains synchronization outcomes when bounded coverage is unavailable', async () => {
    jest.useFakeTimers();
    const warn = jest.fn();
    const result = successfulCycleResult();
    const handle = startBackstageNotionPartitionShadowLoop({
      readEnvironment: shadowEnvironment(),
      intervalMs: INTERVAL_MS,
      initialDelayMs: 0,
      runCycle: async () => ({
        ...result,
        coverage: [],
        coverageUnavailable: 1,
      }),
      logger: { info: jest.fn(), warn } as never,
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith(
      'backstage.notion_partition.shadow_cycle_completed_with_failures',
      expect.objectContaining({
        manifestsPublished: 1,
        shardsFresh: 1,
        coverageCompared: 0,
        coverageUnavailable: 1,
      })
    );
    await handle.stopAndDrain();
  });

  test('keeps PR-1 retrieval independent of partition mode and storage', () => {
    const shadowSource = fs.readFileSync(
      path.resolve('src/workers/backstageNotionPartitionShadowLoop.ts'),
      'utf8'
    );
    const retrievalSource = fs.readFileSync(
      path.resolve('src/services/backstageNotionRag.ts'),
      'utf8'
    );
    const defaultCycleIndex = shadowSource.indexOf('async function runDefaultShadowCycle(');
    const repositoryFactoryIndex = shadowSource.indexOf(
      'getBackstageNotionPartitionRepository()',
      defaultCycleIndex
    );
    const captureFactoryIndex = shadowSource.indexOf(
      'createBackstageNotionPartitionProviderCaptureDependencies({',
      repositoryFactoryIndex
    );
    expect(defaultCycleIndex).toBeGreaterThan(-1);
    expect(repositoryFactoryIndex).toBeGreaterThan(defaultCycleIndex);
    expect(captureFactoryIndex).toBeGreaterThan(repositoryFactoryIndex);
    expect(shadowSource).toContain(
      'createEmbeddings(inputs, undefined, { signal })'
    );
    expect(shadowSource).toContain(
      'embeddingDimension: DEFAULT_OPENAI_EMBEDDING_DIMENSION'
    );
    expect(retrievalSource).not.toContain('backstageNotionPartition');
    expect(retrievalSource).not.toContain('PARTITIONED_INDEX_MODE');
  });
});

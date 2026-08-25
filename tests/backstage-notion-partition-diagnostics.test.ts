import { describe, expect, jest, test } from '@jest/globals';

import type {
  BackstageNotionPartitionDiagnosticsState,
} from '../src/core/db/repositories/backstageNotionPartitionRepository.js';
import {
  getBackstageNotionPartitionDiagnostics,
} from '../src/services/backstageNotionPartitionDiagnostics.js';
import {
  BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME,
  BACKSTAGE_NOTION_PARTITIONS_ENV_NAME,
  parseBackstageNotionPartitionConfiguration,
} from '../src/shared/backstage/backstageNotionPartitionCore.js';

const UNIVERSE_ID = 'my-universe-2k26';
const HOT_SHARD = 'raw/2026';
const ARCHIVE_SHARD = 'archive/raw/2025';
const HOT_ROOT_ID = '11111111-1111-4111-8111-111111111111';
const ARCHIVE_ROOT_ID = '22222222-2222-4222-8222-222222222222';
const HOT_PARTITION_ID = '33333333-3333-4333-8333-333333333333';
const ARCHIVE_PARTITION_ID = '44444444-4444-4444-8444-444444444444';
const HOT_SNAPSHOT_ID = '55555555-5555-4555-8555-555555555555';
const ARCHIVE_SNAPSHOT_ID = '66666666-6666-4666-8666-666666666666';
const CONFIGURATION_ID = '77777777-7777-4777-8777-777777777777';
const MANIFEST_ID = '88888888-8888-4888-8888-888888888888';
const GENERATION = 'diagnostics-generation-1';
const NOW = new Date('2026-08-25T12:00:00.000Z');
const CONFIGURATION = JSON.stringify({
  version: 1,
  generation: GENERATION,
  universes: [{
    universeId: UNIVERSE_ID,
    shards: [{
      shardKey: HOT_SHARD,
      rootPageId: HOT_ROOT_ID,
      displayName: 'secret-hot-display-name',
      retrievalTier: 'hot',
      required: true,
      scopeTags: ['brand:raw', 'year:2026'],
      categoryTags: ['current'],
      capacity: {
        maxPages: 512,
        maxChunks: 2_048,
        maxDepth: 16,
        maxContentCodePoints: 4_000_000,
      },
    }, {
      shardKey: ARCHIVE_SHARD,
      rootPageId: ARCHIVE_ROOT_ID,
      displayName: 'secret-archive-display-name',
      retrievalTier: 'archive',
      required: false,
      scopeTags: ['brand:raw', 'year:2025'],
      categoryTags: ['archive'],
      capacity: {
        maxPages: 512,
        maxChunks: 2_048,
        maxDepth: 16,
        maxContentCodePoints: 4_000_000,
      },
    }],
  }],
});
const PARSED_CONFIGURATION = parseBackstageNotionPartitionConfiguration(CONFIGURATION);
if (PARSED_CONFIGURATION.status !== 'valid') {
  throw new Error('Test partition configuration must be valid.');
}
const CONFIGURATION_HASH = PARSED_CONFIGURATION.semanticDigest;

function environment(
  values: Readonly<Record<string, string | undefined>> = {}
): (name: string) => string | undefined {
  const defaults: Readonly<Record<string, string | undefined>> = {
    [BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME]: 'shadow',
    [BACKSTAGE_NOTION_PARTITIONS_ENV_NAME]: CONFIGURATION,
  };
  return name => Object.hasOwn(values, name) ? values[name] : defaults[name];
}

function diagnosticsState(
  overrides: Partial<BackstageNotionPartitionDiagnosticsState> = {}
): BackstageNotionPartitionDiagnosticsState {
  return {
    universeId: UNIVERSE_ID,
    observedAt: new Date(NOW),
    authorityActive: true,
    desiredConfigurationVersionId: CONFIGURATION_ID,
    desiredConfigurationGeneration: GENERATION,
    desiredConfigurationHash: CONFIGURATION_HASH,
    headGeneration: '4',
    manifestGeneration: '3',
    activeManifest: {
      manifestId: MANIFEST_ID,
      configurationVersionId: CONFIGURATION_ID,
      configurationGeneration: GENERATION,
      configurationHash: CONFIGURATION_HASH,
      createdAt: new Date('2026-08-25T11:50:00.000Z'),
      sealedAt: new Date('2026-08-25T11:51:00.000Z'),
      memberCount: 1,
      omissionCount: 1,
      pageCount: 362,
      chunkCount: 3_253,
    },
    activeJobCount: 3,
    unconfiguredActiveJobCount: 1,
    shards: [{
      shardKey: HOT_SHARD,
      partitionVersionId: HOT_PARTITION_ID,
      currentHeadPartitionVersionId: HOT_PARTITION_ID,
      retrievalTier: 'hot',
      required: true,
      scopeTags: ['brand:raw', 'year:2026'],
      categoryTags: ['current'],
      headGeneration: '2',
      snapshotGeneration: '2',
      lastAttemptAt: new Date('2026-08-25T11:48:00.000Z'),
      lastVerifiedAt: new Date('2026-08-25T11:49:00.000Z'),
      lastKnownGood: {
        snapshotId: HOT_SNAPSHOT_ID,
        partitionVersionId: HOT_PARTITION_ID,
        exactForConfiguredPartition: true,
        pageCount: 100,
        chunkCount: 1_319,
        createdAt: new Date('2026-08-25T11:47:00.000Z'),
        sealedAt: new Date('2026-08-25T11:48:00.000Z'),
      },
      manifestRecord: {
        kind: 'member',
        decision: 'retained_last_known_good',
        snapshotId: HOT_SNAPSHOT_ID,
        verifiedAt: new Date('2026-08-25T11:49:00.000Z'),
        pageCount: 100,
        chunkCount: 1_319,
      },
      lease: {
        acquiredAt: new Date('2026-08-25T11:59:00.000Z'),
        expiresAt: new Date('2026-08-25T12:04:00.000Z'),
      },
      activeJobs: {
        total: 1,
        pending: 1,
        running: 0,
        configurationStale: 0,
      },
    }, {
      shardKey: ARCHIVE_SHARD,
      partitionVersionId: ARCHIVE_PARTITION_ID,
      currentHeadPartitionVersionId: ARCHIVE_PARTITION_ID,
      retrievalTier: 'archive',
      required: false,
      scopeTags: ['brand:raw', 'year:2025'],
      categoryTags: ['archive'],
      headGeneration: '1',
      snapshotGeneration: '1',
      lastAttemptAt: null,
      lastVerifiedAt: new Date('2026-08-24T11:00:00.000Z'),
      lastKnownGood: {
        snapshotId: ARCHIVE_SNAPSHOT_ID,
        partitionVersionId: ARCHIVE_PARTITION_ID,
        exactForConfiguredPartition: true,
        pageCount: 262,
        chunkCount: 1_934,
        createdAt: new Date('2026-08-24T10:00:00.000Z'),
        sealedAt: new Date('2026-08-24T10:30:00.000Z'),
      },
      manifestRecord: {
        kind: 'omission',
        decision: 'optional_unavailable',
        safeReasonCode: 'SHARD_CAPACITY_EXCEEDED',
      },
      lease: null,
      activeJobs: {
        total: 1,
        pending: 0,
        running: 1,
        configurationStale: 0,
      },
    }],
    ...overrides,
  };
}

function repository(state: BackstageNotionPartitionDiagnosticsState | null) {
  return {
    loadUniverseDiagnosticsState: jest.fn(async () => state),
  };
}

describe('Backstage Notion partition diagnostics service', () => {
  test('projects independent shard readiness without exposing corpus or configuration secrets', async () => {
    const fakeRepository = repository(diagnosticsState());
    const result = await getBackstageNotionPartitionDiagnostics({
      universeId: UNIVERSE_ID,
      dependencies: {
        readEnvironment: environment(),
        repository: fakeRepository,
        now: () => new Date(NOW),
        readMaximumStalenessMs: () => 24 * 60 * 60 * 1_000,
      },
    });

    expect(result.statusCode).toBe(200);
    expect(result.payload).toMatchObject({
      ok: true,
      data: {
        version: 1,
        universeId: UNIVERSE_ID,
        mode: 'shadow',
        configurationStatus: 'active',
        activeManifest: {
          manifestId: MANIFEST_ID,
          configurationCurrent: true,
          pageCount: 362,
          chunkCount: 3_253,
        },
        shards: [{
          shardKey: ARCHIVE_SHARD,
          activation: 'optional_unavailable',
          safeReasonCode: 'SHARD_CAPACITY_EXCEEDED',
          freshness: 'unavailable',
          retrievalReady: false,
          activeJobs: { queued: 0, running: 1 },
        }, {
          shardKey: HOT_SHARD,
          activation: 'retained_last_known_good',
          freshness: 'fresh',
          retrievalReady: true,
          lease: { active: true },
          activeJobs: { queued: 1, running: 0 },
        }],
        summary: {
          requiredShardsReady: true,
          completeScopeReady: false,
          operationalAggregatesAvailable: true,
          retrievalReadyShards: 1,
          unavailableShards: 1,
          activeLeases: 1,
          queuedJobs: 1,
          runningJobs: 1,
          unconfiguredActiveJobs: 1,
        },
      },
    });
    expect(fakeRepository.loadUniverseDiagnosticsState)
      .toHaveBeenCalledWith(UNIVERSE_ID);

    const serialized = JSON.stringify(result.payload);
    for (const forbidden of [
      HOT_ROOT_ID,
      ARCHIVE_ROOT_ID,
      CONFIGURATION_HASH,
      'secret-hot-display-name',
      'secret-archive-display-name',
      'brand:raw',
      'year:2026',
      'provider-secret',
      'markdown',
      'embedding',
      'lease-token',
      'job-input',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('keeps historical activation separate from current stale and future-clock freshness', async () => {
    const staleState = diagnosticsState();
    const staleShards = staleState.shards.map((shard, index) => index === 0
      ? {
          ...shard,
          manifestRecord: {
            kind: 'member' as const,
            decision: 'fresh' as const,
            snapshotId: HOT_SNAPSHOT_ID,
            verifiedAt: new Date('2026-08-25T09:00:00.000Z'),
            pageCount: 100,
            chunkCount: 1_319,
          },
          lease: null,
        }
      : {
          ...shard,
          manifestRecord: {
            kind: 'member' as const,
            decision: 'retained_last_known_good' as const,
            snapshotId: ARCHIVE_SNAPSHOT_ID,
            verifiedAt: new Date('2026-08-25T12:06:00.001Z'),
            pageCount: 262,
            chunkCount: 1_934,
          },
        });
    const state = diagnosticsState({
      activeManifest: {
        ...staleState.activeManifest!,
        memberCount: 2,
        omissionCount: 0,
      },
      activeJobCount: 2,
      unconfiguredActiveJobCount: 0,
      shards: staleShards,
    });
    const result = await getBackstageNotionPartitionDiagnostics({
      universeId: UNIVERSE_ID,
      dependencies: {
        readEnvironment: environment(),
        repository: repository(state),
        now: () => new Date(NOW),
        readMaximumStalenessMs: () => 60 * 60 * 1_000,
      },
    });

    expect(result.statusCode).toBe(200);
    expect(result.payload).toMatchObject({
      data: {
        shards: [{
          activation: 'retained_last_known_good',
          freshness: 'future_clock',
          retrievalReady: false,
        }, {
          activation: 'fresh',
          freshness: 'stale',
          retrievalReady: false,
        }],
        summary: {
          requiredShardsReady: false,
          completeScopeReady: false,
          staleShards: 1,
        },
      },
    });
  });

  test('returns bounded uninitialized diagnostics without inventing authority or job state', async () => {
    const result = await getBackstageNotionPartitionDiagnostics({
      universeId: UNIVERSE_ID,
      dependencies: {
        readEnvironment: environment(),
        repository: repository(null),
        now: () => new Date(NOW),
        readMaximumStalenessMs: () => undefined,
      },
    });

    expect(result).toMatchObject({
      statusCode: 200,
      payload: {
        data: {
          configurationStatus: 'uninitialized',
          activeManifest: null,
          shards: [
            {
              shardKey: ARCHIVE_SHARD,
              activation: 'unavailable',
              activeJobs: null,
            },
            {
              shardKey: HOT_SHARD,
              activation: 'unavailable',
              activeJobs: null,
            },
          ],
          summary: {
            operationalAggregatesAvailable: false,
            activeLeases: null,
            queuedJobs: null,
            runningJobs: null,
            unconfiguredActiveJobs: null,
          },
        },
      },
    });
  });

  test('fails closed for database errors, cross-generation state, and corrupt safe metadata', async () => {
    const databaseFailure = {
      loadUniverseDiagnosticsState: jest.fn(async () => {
        throw new Error('provider-secret database detail');
      }),
    };
    const crossGeneration = diagnosticsState({
      desiredConfigurationHash: 'a'.repeat(64),
    });
    const corrupt = diagnosticsState({
      shards: diagnosticsState().shards.map((shard, index) => index === 1
        ? {
            ...shard,
            manifestRecord: {
              kind: 'omission' as const,
              decision: 'optional_unavailable' as const,
              safeReasonCode: 'PROVIDER_SECRET' as never,
            },
          }
        : shard),
    });

    for (const diagnosticRepository of [
      databaseFailure,
      repository(crossGeneration),
      repository(corrupt),
    ]) {
      const result = await getBackstageNotionPartitionDiagnostics({
        universeId: UNIVERSE_ID,
        dependencies: {
          readEnvironment: environment(),
          repository: diagnosticRepository,
          now: () => new Date(NOW),
          readMaximumStalenessMs: () => 60 * 60 * 1_000,
        },
      });
      expect(result).toEqual({
        statusCode: 503,
        payload: {
          ok: false,
          error: {
            code: 'BACKSTAGE_NOTION_PARTITION_DIAGNOSTICS_UNAVAILABLE',
            message: 'Partition diagnostics are unavailable.',
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain('provider-secret');
    }
  });

  test('rejects disabled, malformed, and unknown targets before database access', async () => {
    const fakeRepository = repository(diagnosticsState());
    const cases = [{
      values: {
        [BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME]: 'monolith',
      },
      statusCode: 409,
    }, {
      values: {
        [BACKSTAGE_NOTION_PARTITIONS_ENV_NAME]: '{',
      },
      statusCode: 503,
    }, {
      values: {},
      universeId: 'unknown-universe',
      statusCode: 404,
    }] as const;

    for (const testCase of cases) {
      const result = await getBackstageNotionPartitionDiagnostics({
        universeId: testCase.universeId ?? UNIVERSE_ID,
        dependencies: {
          readEnvironment: environment(testCase.values),
          repository: fakeRepository,
          now: () => new Date(NOW),
          readMaximumStalenessMs: () => undefined,
        },
      });
      expect(result.statusCode).toBe(testCase.statusCode);
    }
    expect(fakeRepository.loadUniverseDiagnosticsState).not.toHaveBeenCalled();
  });

  test('constructs the default repository lazily and bounds a missing pool', async () => {
    await expect(getBackstageNotionPartitionDiagnostics({
      universeId: UNIVERSE_ID,
      dependencies: {
        readEnvironment: environment({
          [BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME]: 'monolith',
        }),
      },
    })).resolves.toEqual({
      statusCode: 409,
      payload: {
        ok: false,
        error: {
          code: 'BACKSTAGE_NOTION_PARTITION_DIAGNOSTICS_DISABLED',
          message: 'Partition diagnostics are disabled.',
        },
      },
    });

    await expect(getBackstageNotionPartitionDiagnostics({
      universeId: UNIVERSE_ID,
      dependencies: {
        readEnvironment: environment(),
        now: () => new Date(NOW),
      },
    })).resolves.toEqual({
      statusCode: 503,
      payload: {
        ok: false,
        error: {
          code: 'BACKSTAGE_NOTION_PARTITION_DIAGNOSTICS_UNAVAILABLE',
          message: 'Partition diagnostics are unavailable.',
        },
      },
    });
  });
});

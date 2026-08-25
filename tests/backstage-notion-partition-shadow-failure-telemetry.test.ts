import { afterEach, expect, jest, test } from '@jest/globals';

import {
  getTelemetrySnapshot,
  resetTelemetry,
} from '../src/platform/logging/telemetry.js';
import {
  startBackstageNotionPartitionShadowLoop,
  type BackstageNotionPartitionShadowCycleResult,
} from '../src/workers/backstageNotionPartitionShadowLoop.js';

const ALIASED_ROOT_PAGE_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ROOT_PAGE_ID = '22222222-2222-4222-8222-222222222222';
const CONFIGURATION_VERSION_ID = '44444444-4444-4444-8444-444444444444';
const UNIVERSE_A_ID = 'my-universe-a';
const UNIVERSE_B_ID = 'my-universe-b';
const EXPECTED_UNIVERSE_A_IDENTITY =
  'opaque-IGh-01EcK9jqcKsZSvhvhc5v94zTu8b1Wgym0Eog0qU';
const EXPECTED_UNIVERSE_B_IDENTITY =
  'opaque-EiLtTD-g4RCBn14vcVuoXOVKyrCZ6LK4r8lkzJ9XC2M';

const CAPACITY = Object.freeze({
  maxPages: 512,
  maxChunks: 2_048,
  maxDepth: 16,
  maxContentCodePoints: 4_000_000,
});

const PARTITION_CONFIGURATION = JSON.stringify({
  version: 1,
  generation: 'failure-telemetry-1',
  universes: [{
    universeId: UNIVERSE_A_ID,
    shards: [{
      shardKey: ALIASED_ROOT_PAGE_ID,
      rootPageId: ALIASED_ROOT_PAGE_ID,
      displayName: 'Universe A current canon',
      retrievalTier: 'hot',
      required: true,
      scopeTags: ['universe:a'],
      categoryTags: ['current-canon'],
      capacity: CAPACITY,
    }],
  }, {
    universeId: UNIVERSE_B_ID,
    shards: [{
      shardKey: ALIASED_ROOT_PAGE_ID,
      rootPageId: SECOND_ROOT_PAGE_ID,
      displayName: 'Universe B current canon',
      retrievalTier: 'hot',
      required: true,
      scopeTags: ['universe:b'],
      categoryTags: ['current-canon'],
      capacity: CAPACITY,
    }],
  }],
});

const ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'shadow',
  ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON: PARTITION_CONFIGURATION,
});

function readEnvironment(name: string): string | undefined {
  return ENVIRONMENT[name];
}

const EMPTY_PAGE_CHANGES = Object.freeze({
  added: 0,
  changed: 0,
  moved: 0,
  deleted: 0,
  unchanged: 0,
});

function failedCycleResult(): BackstageNotionPartitionShadowCycleResult {
  return {
    synchronization: {
      kind: 'full_reconciliation',
      universes: [{
        universeId: UNIVERSE_B_ID,
        configurationVersionId: CONFIGURATION_VERSION_ID,
        manifestStatus: 'blocked',
        manifestId: null,
        memberCount: 0,
        omissionCount: 0,
        manifestOmissions: [],
        shardResults: [{
          universeId: UNIVERSE_B_ID,
          shardKey: ALIASED_ROOT_PAGE_ID,
          status: 'failed',
          safeReasonCode: 'SHARD_SOURCE_DRIFT',
          freshSnapshotId: null,
          fullSourceScan: true,
          pageCount: 0,
          chunkCount: 0,
          pageVersionReuseCount: 0,
          embeddedChunkCount: 0,
          leaseReleaseVerified: true,
          pageChanges: EMPTY_PAGE_CHANGES,
        }],
      }, {
        universeId: UNIVERSE_A_ID,
        configurationVersionId: CONFIGURATION_VERSION_ID,
        manifestStatus: 'blocked',
        manifestId: null,
        memberCount: 0,
        omissionCount: 0,
        manifestOmissions: [],
        shardResults: [{
          universeId: UNIVERSE_A_ID,
          shardKey: ALIASED_ROOT_PAGE_ID,
          status: 'failed',
          safeReasonCode: null,
          freshSnapshotId: null,
          fullSourceScan: true,
          pageCount: 0,
          chunkCount: 0,
          pageVersionReuseCount: 0,
          embeddedChunkCount: 0,
          leaseReleaseVerified: true,
          pageChanges: EMPTY_PAGE_CHANGES,
        }],
      }],
    },
    coverage: [],
    coverageUnavailable: 0,
  };
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  resetTelemetry();
});

test('logs deterministic safe identities for every failed partition shard', async () => {
  jest.useFakeTimers();
  const warn = jest.fn();
  const handle = startBackstageNotionPartitionShadowLoop({
    readEnvironment,
    intervalMs: 60_000,
    initialDelayMs: 0,
    runCycle: async () => failedCycleResult(),
    logger: { info: jest.fn(), warn } as never,
  });

  await jest.advanceTimersByTimeAsync(0);

  expect(warn).toHaveBeenCalledWith(
    'backstage.notion_partition.shadow_cycle_completed_with_failures',
    expect.objectContaining({
      shardsFailed: 2,
      failedShards: [{
        shardIdentity: EXPECTED_UNIVERSE_A_IDENTITY,
        safeReasonCode: 'SHARD_SYNC_FAILED',
      }, {
        shardIdentity: EXPECTED_UNIVERSE_B_IDENTITY,
        safeReasonCode: 'SHARD_SOURCE_DRIFT',
      }],
    })
  );
  const serializedLogs = JSON.stringify(warn.mock.calls);
  expect(serializedLogs).not.toContain(ALIASED_ROOT_PAGE_ID);
  expect(serializedLogs).not.toContain(SECOND_ROOT_PAGE_ID);
  expect(serializedLogs).not.toContain(UNIVERSE_A_ID);
  expect(serializedLogs).not.toContain(UNIVERSE_B_ID);

  await handle.stopAndDrain();
});

test('keeps raw partition identifiers out of production log sinks', async () => {
  jest.useFakeTimers();
  resetTelemetry();
  const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const handle = startBackstageNotionPartitionShadowLoop({
    readEnvironment,
    intervalMs: 60_000,
    initialDelayMs: 0,
    runCycle: async () => failedCycleResult(),
  });

  await jest.advanceTimersByTimeAsync(0);

  const cycleLog = getTelemetrySnapshot().traces.recentLogs.find(
    entry => entry.message
      === 'backstage.notion_partition.shadow_cycle_completed_with_failures'
  );
  expect(cycleLog?.context).toEqual(expect.objectContaining({
    shardsFailed: 2,
    failedShards: [{
      shardIdentity: EXPECTED_UNIVERSE_A_IDENTITY,
      safeReasonCode: 'SHARD_SYNC_FAILED',
    }, {
      shardIdentity: EXPECTED_UNIVERSE_B_IDENTITY,
      safeReasonCode: 'SHARD_SOURCE_DRIFT',
    }],
  }));
  const serializedSinks = JSON.stringify({
    console: consoleLog.mock.calls,
    telemetry: getTelemetrySnapshot().traces.recentLogs,
  });
  expect(serializedSinks).not.toContain(ALIASED_ROOT_PAGE_ID);
  expect(serializedSinks).not.toContain(SECOND_ROOT_PAGE_ID);
  expect(serializedSinks).not.toContain(UNIVERSE_A_ID);
  expect(serializedSinks).not.toContain(UNIVERSE_B_ID);

  await handle.stopAndDrain();
});

test('keeps complete failure telemetry bounded at the 512-shard configuration limit', async () => {
  jest.useFakeTimers();
  const scaleUniverses = Array.from({ length: 4 }, (_, universeIndex) => ({
    universeId: `scale-universe-${universeIndex}`,
    shards: Array.from({ length: 128 }, (_, shardIndex) => {
      const globalIndex = universeIndex * 128 + shardIndex;
      return {
        shardKey: `scale/${String(shardIndex).padStart(3, '0')}`,
        rootPageId: `aaaaaaaa-aaaa-4aaa-8aaa-${globalIndex.toString(16).padStart(12, '0')}`,
        displayName: `Scale shard ${globalIndex}`,
        retrievalTier: 'hot',
        required: true,
        scopeTags: ['scale'],
        categoryTags: ['failure-telemetry'],
        capacity: CAPACITY,
      };
    }),
  }));
  const scaleEnvironment: Readonly<Record<string, string>> = Object.freeze({
    ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'shadow',
    ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON: JSON.stringify({
      version: 1,
      generation: 'failure-telemetry-scale-1',
      universes: scaleUniverses,
    }),
  });
  const scaleResult: BackstageNotionPartitionShadowCycleResult = {
    synchronization: {
      kind: 'full_reconciliation',
      universes: [...scaleUniverses].reverse().map(universe => ({
        universeId: universe.universeId,
        configurationVersionId: CONFIGURATION_VERSION_ID,
        manifestStatus: 'blocked',
        manifestId: null,
        memberCount: 0,
        omissionCount: 0,
        manifestOmissions: [],
        shardResults: [...universe.shards].reverse().map(shard => ({
          universeId: universe.universeId,
          shardKey: shard.shardKey,
          status: 'failed' as const,
          safeReasonCode: 'SHARD_SOURCE_DRIFT' as const,
          freshSnapshotId: null,
          fullSourceScan: true,
          pageCount: 0,
          chunkCount: 0,
          pageVersionReuseCount: 0,
          embeddedChunkCount: 0,
          leaseReleaseVerified: true,
          pageChanges: EMPTY_PAGE_CHANGES,
        })),
      })),
    },
    coverage: [],
    coverageUnavailable: 0,
  };
  const warn = jest.fn();
  const handle = startBackstageNotionPartitionShadowLoop({
    readEnvironment: name => scaleEnvironment[name],
    intervalMs: 60_000,
    initialDelayMs: 0,
    runCycle: async () => scaleResult,
    logger: { info: jest.fn(), warn } as never,
  });

  await jest.advanceTimersByTimeAsync(0);

  const cycleCall = warn.mock.calls.find(
    call => call[0] === 'backstage.notion_partition.shadow_cycle_completed_with_failures'
  );
  if (!cycleCall) {
    throw new Error('Expected the maximum-scale failure cycle log.');
  }
  const metadata = cycleCall[1] as {
    readonly shardsFailed: number;
    readonly failedShards: readonly Readonly<{
      shardIdentity: string;
      safeReasonCode: string;
    }>[];
  };
  expect(metadata.shardsFailed).toBe(512);
  expect(metadata.failedShards).toHaveLength(metadata.shardsFailed);
  expect(new Set(metadata.failedShards.map(shard => shard.shardIdentity))).toHaveProperty(
    'size',
    metadata.shardsFailed
  );
  expect(metadata.failedShards.every(
    shard => /^opaque-[A-Za-z0-9_-]{43}$/u.test(shard.shardIdentity)
      && shard.safeReasonCode === 'SHARD_SOURCE_DRIFT'
  )).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(metadata), 'utf8')).toBeLessThanOrEqual(64 * 1024);

  await handle.stopAndDrain();
});

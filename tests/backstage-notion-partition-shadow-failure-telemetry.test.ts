import { afterEach, expect, jest, test } from '@jest/globals';

import {
  startBackstageNotionPartitionShadowLoop,
  type BackstageNotionPartitionShadowCycleResult,
} from '../src/workers/backstageNotionPartitionShadowLoop.js';

const RAW_ROOT_PAGE_ID = '11111111-1111-4111-8111-111111111111';
const NXT_ROOT_PAGE_ID = '22222222-2222-4222-8222-222222222222';
const SHARED_ROOT_PAGE_ID = '33333333-3333-4333-8333-333333333333';
const CONFIGURATION_VERSION_ID = '44444444-4444-4444-8444-444444444444';
const FRESH_SNAPSHOT_ID = '55555555-5555-4555-8555-555555555555';

const PARTITION_CONFIGURATION = JSON.stringify({
  version: 1,
  generation: 'failure-telemetry-1',
  universes: [{
    universeId: 'my-universe-2k26',
    shards: [{
      shardKey: 'raw/current',
      rootPageId: RAW_ROOT_PAGE_ID,
      displayName: 'Raw current canon',
      retrievalTier: 'hot',
      required: true,
      scopeTags: ['brand:raw'],
      categoryTags: ['current-canon'],
      capacity: {
        maxPages: 512,
        maxChunks: 2_048,
        maxDepth: 16,
        maxContentCodePoints: 4_000_000,
      },
    }, {
      shardKey: 'nxt/current',
      rootPageId: NXT_ROOT_PAGE_ID,
      displayName: 'NXT current canon',
      retrievalTier: 'hot',
      required: true,
      scopeTags: ['brand:nxt'],
      categoryTags: ['current-canon'],
      capacity: {
        maxPages: 512,
        maxChunks: 2_048,
        maxDepth: 16,
        maxContentCodePoints: 4_000_000,
      },
    }, {
      shardKey: 'shared/kayfabe',
      rootPageId: SHARED_ROOT_PAGE_ID,
      displayName: 'Shared kayfabe',
      retrievalTier: 'hot',
      required: true,
      scopeTags: ['shared'],
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
        universeId: 'my-universe-2k26',
        configurationVersionId: CONFIGURATION_VERSION_ID,
        manifestStatus: 'blocked',
        manifestId: null,
        memberCount: 0,
        omissionCount: 0,
        manifestOmissions: [],
        shardResults: [{
          universeId: 'my-universe-2k26',
          shardKey: 'raw/current',
          status: 'fresh',
          safeReasonCode: null,
          freshSnapshotId: FRESH_SNAPSHOT_ID,
          fullSourceScan: true,
          pageCount: 12,
          chunkCount: 24,
          pageVersionReuseCount: 12,
          embeddedChunkCount: 0,
          leaseReleaseVerified: true,
          pageChanges: {
            ...EMPTY_PAGE_CHANGES,
            unchanged: 12,
          },
        }, {
          universeId: 'my-universe-2k26',
          shardKey: 'shared/kayfabe',
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
        }, {
          universeId: 'my-universe-2k26',
          shardKey: 'nxt/current',
          status: 'failed',
          safeReasonCode: 'SHARD_CAPTURE_INCOMPLETE',
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
        shardKey: 'nxt/current',
        safeReasonCode: 'SHARD_CAPTURE_INCOMPLETE',
      }, {
        shardKey: 'shared/kayfabe',
        safeReasonCode: 'SHARD_SOURCE_DRIFT',
      }],
    })
  );
  const serializedLogs = JSON.stringify(warn.mock.calls);
  expect(serializedLogs).not.toContain(RAW_ROOT_PAGE_ID);
  expect(serializedLogs).not.toContain(NXT_ROOT_PAGE_ID);
  expect(serializedLogs).not.toContain(SHARED_ROOT_PAGE_ID);

  await handle.stopAndDrain();
});

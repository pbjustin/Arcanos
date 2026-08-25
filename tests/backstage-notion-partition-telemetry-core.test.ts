import { describe, expect, test } from '@jest/globals';

import {
  BACKSTAGE_NOTION_PARTITION_FAILED_SHARD_IDENTITY_FORMAT,
  projectBackstageNotionPartitionFailedShardTelemetry,
} from '../src/shared/backstage/backstageNotionPartitionTelemetryCore.js';

const ROOT_PAGE_ID_ALIAS = '11111111-1111-4111-8111-111111111111';

describe('Backstage Notion partition telemetry projection', () => {
  test('filters, orders, defaults, and irreversibly separates composite shard identities', () => {
    const input = [
      {
        universeId: 'my-universe-b',
        shardKey: ROOT_PAGE_ID_ALIAS,
        status: 'failed' as const,
        safeReasonCode: 'SHARD_SOURCE_DRIFT',
      },
      {
        universeId: 'my-universe-a',
        shardKey: 'healthy-shard',
        status: 'fresh' as const,
        safeReasonCode: null,
      },
      {
        universeId: 'my-universe-a',
        shardKey: ROOT_PAGE_ID_ALIAS,
        status: 'failed' as const,
        safeReasonCode: null,
      },
    ];

    const projected =
      projectBackstageNotionPartitionFailedShardTelemetry(input);

    expect(BACKSTAGE_NOTION_PARTITION_FAILED_SHARD_IDENTITY_FORMAT).toBe(
      'backstage-notion-partition-shard-telemetry-v1'
    );
    expect(projected).toEqual([
      {
        shardIdentity:
          'opaque-IGh-01EcK9jqcKsZSvhvhc5v94zTu8b1Wgym0Eog0qU',
        safeReasonCode: 'SHARD_SYNC_FAILED',
      },
      {
        shardIdentity:
          'opaque-EiLtTD-g4RCBn14vcVuoXOVKyrCZ6LK4r8lkzJ9XC2M',
        safeReasonCode: 'SHARD_SOURCE_DRIFT',
      },
    ]);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(projected.every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify(projected)).not.toContain(ROOT_PAGE_ID_ALIAS);
    expect(JSON.stringify(projected)).not.toContain('my-universe');
    expect(input.map(item => item.universeId)).toEqual([
      'my-universe-b',
      'my-universe-a',
      'my-universe-a',
    ]);
  });
});

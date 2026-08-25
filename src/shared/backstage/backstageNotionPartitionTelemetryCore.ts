import { createHash } from 'node:crypto';

import type {
  BackstageNotionPartitionShardAttemptSummary,
} from './backstageNotionPartitionSyncCore.js';

export const BACKSTAGE_NOTION_PARTITION_FAILED_SHARD_IDENTITY_FORMAT =
  'backstage-notion-partition-shard-telemetry-v1';

export interface BackstageNotionPartitionShardTelemetryInput {
  readonly universeId: string;
  readonly shardKey: string;
  readonly status: BackstageNotionPartitionShardAttemptSummary['status'];
  readonly safeReasonCode:
    BackstageNotionPartitionShardAttemptSummary['safeReasonCode'];
}

export interface BackstageNotionPartitionFailedShardTelemetryEntry {
  readonly shardIdentity: string;
  readonly safeReasonCode: string;
}

function buildFailedShardIdentity(
  universeId: string,
  shardKey: string
): string {
  const digest = createHash('sha256').update(JSON.stringify({
    format: BACKSTAGE_NOTION_PARTITION_FAILED_SHARD_IDENTITY_FORMAT,
    universeId,
    shardKey,
  }), 'utf8').digest('base64url');
  return `opaque-${digest}`;
}

/**
 * Project failed shard coordinates into deterministic, non-reversible telemetry.
 * Raw universe IDs and shard keys must never cross this boundary.
 */
export function projectBackstageNotionPartitionFailedShardTelemetry(
  shardResults: readonly BackstageNotionPartitionShardTelemetryInput[]
): readonly BackstageNotionPartitionFailedShardTelemetryEntry[] {
  return Object.freeze(
    shardResults
      .filter(shard => shard.status === 'failed')
      .sort((left, right) => (
        left.universeId < right.universeId ? -1
          : left.universeId > right.universeId ? 1
            : left.shardKey < right.shardKey ? -1
              : left.shardKey > right.shardKey ? 1
                : 0
      ))
      .map(shard => Object.freeze({
        shardIdentity: buildFailedShardIdentity(
          shard.universeId,
          shard.shardKey
        ),
        safeReasonCode: shard.safeReasonCode ?? 'SHARD_SYNC_FAILED',
      }))
  );
}

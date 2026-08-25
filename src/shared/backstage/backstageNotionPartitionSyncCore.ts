import type {
  BackstageNotionPartitionDefinition,
  BackstageNotionPartitionUniverse,
  BackstageNotionRetrievalTier,
} from './backstageNotionPartitionCore.js';

const TIER_ORDER: Readonly<Record<BackstageNotionRetrievalTier, number>> = {
  hot: 0,
  cold: 1,
  archive: 2,
};

export const BACKSTAGE_NOTION_PARTITION_OPTIONAL_UNAVAILABLE_REASON_CODES = [
  'SHARD_ABORTED',
  'SHARD_CAPACITY_EXCEEDED',
  'SHARD_CAPTURE_INCOMPLETE',
  'SHARD_INDEX_INCOMPATIBLE',
  'SHARD_LEASE_BUSY',
  'SHARD_LEASE_LOST',
  'SHARD_NOT_REQUESTED',
  'SHARD_OWNERSHIP_CONFLICT',
  'SHARD_SOURCE_DRIFT',
  'SHARD_SYNC_FAILED',
] as const;

export type BackstageNotionPartitionOptionalUnavailableReasonCode =
  (typeof BACKSTAGE_NOTION_PARTITION_OPTIONAL_UNAVAILABLE_REASON_CODES)[number];

export interface BackstageNotionPartitionReconciliationJob {
  readonly universeId: string;
  readonly shardKey: string;
  readonly retrievalTier: BackstageNotionRetrievalTier;
  readonly required: boolean;
  readonly definition: BackstageNotionPartitionDefinition;
}

export interface BackstageNotionPartitionShardAttemptSummary {
  readonly shardKey: string;
  readonly status:
    | 'fresh'
    | 'failed'
    | 'lease-busy'
    | 'aborted'
    | 'not-requested';
  readonly safeReasonCode: BackstageNotionPartitionOptionalUnavailableReasonCode | null;
  readonly freshSnapshotId: string | null;
}

export interface BackstageNotionPartitionLastKnownGoodCandidate {
  readonly snapshotId: string;
  readonly partitionVersionId: string;
  readonly embeddingModel: string;
  readonly embeddingVersion: number;
  readonly embeddingDimension: number;
  readonly indexFormatVersion: number;
  readonly verifiedAt: Date;
}

export interface BackstageNotionPartitionIndexCompatibility {
  readonly embeddingModel: string;
  readonly embeddingVersion: number;
  readonly embeddingDimension: number;
  readonly indexFormatVersion: number;
}

export type BackstageNotionPartitionManifestPolicyDecision =
  | Readonly<{
      kind: 'fresh';
      shardKey: string;
      snapshotId: string;
      partitionVersionId: string;
      verifiedAt: Date;
    }>
  | Readonly<{
      kind: 'retained_last_known_good';
      shardKey: string;
      snapshotId: string;
      partitionVersionId: string;
      verifiedAt: Date;
    }>
  | Readonly<{
      kind: 'optional_unavailable';
      shardKey: string;
      partitionVersionId: string;
      safeReasonCode: BackstageNotionPartitionOptionalUnavailableReasonCode;
    }>
  | Readonly<{
      kind: 'required_unavailable';
      shardKey: string;
      partitionVersionId: string;
      safeReasonCode: BackstageNotionPartitionOptionalUnavailableReasonCode;
    }>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Produce one deterministic full-reconciliation queue without starting work. */
export function planBackstageNotionPartitionFullReconciliation(
  universes: readonly BackstageNotionPartitionUniverse[]
): readonly BackstageNotionPartitionReconciliationJob[] {
  return Object.freeze(universes.flatMap(universe => universe.shards.map(definition =>
    Object.freeze({
      universeId: universe.universeId,
      shardKey: definition.shardKey,
      retrievalTier: definition.retrievalTier,
      required: definition.required,
      definition,
    })
  )).sort((left, right) => (
    TIER_ORDER[left.retrievalTier] - TIER_ORDER[right.retrievalTier]
    || compareText(left.universeId, right.universeId)
    || compareText(left.shardKey, right.shardKey)
  )));
}

/**
 * Decide one shard's manifest membership from terminal database state. A
 * last-known-good snapshot is eligible only for the exact desired immutable
 * partition version and within the finite retention allowance.
 */
export function decideBackstageNotionPartitionManifestMembership(input: {
  readonly definition: BackstageNotionPartitionDefinition;
  readonly partitionVersionId: string;
  readonly attempt: BackstageNotionPartitionShardAttemptSummary;
  readonly terminalActiveSnapshot: BackstageNotionPartitionLastKnownGoodCandidate | null;
  readonly expectedIndex: BackstageNotionPartitionIndexCompatibility;
  readonly now: Date;
  readonly lastKnownGoodMaximumAgeMs: number;
}): BackstageNotionPartitionManifestPolicyDecision {
  const candidate = input.terminalActiveSnapshot;
  const candidateAgeMs = candidate
    ? input.now.getTime() - candidate.verifiedAt.getTime()
    : Number.POSITIVE_INFINITY;
  const candidateEligible = candidate !== null
    && candidate.partitionVersionId === input.partitionVersionId
    && candidate.embeddingModel === input.expectedIndex.embeddingModel
    && candidate.embeddingVersion === input.expectedIndex.embeddingVersion
    && candidate.embeddingDimension === input.expectedIndex.embeddingDimension
    && candidate.indexFormatVersion === input.expectedIndex.indexFormatVersion
    && candidateAgeMs >= 0
    && candidateAgeMs <= input.lastKnownGoodMaximumAgeMs;

  if (
    input.attempt.status === 'fresh'
    && candidateEligible
    && input.attempt.freshSnapshotId === candidate.snapshotId
  ) {
    return Object.freeze({
      kind: 'fresh',
      shardKey: input.definition.shardKey,
      snapshotId: candidate.snapshotId,
      partitionVersionId: input.partitionVersionId,
      verifiedAt: candidate.verifiedAt,
    });
  }
  if (candidateEligible) {
    return Object.freeze({
      kind: 'retained_last_known_good',
      shardKey: input.definition.shardKey,
      snapshotId: candidate.snapshotId,
      partitionVersionId: input.partitionVersionId,
      verifiedAt: candidate.verifiedAt,
    });
  }
  const indexIncompatible = candidate !== null
    && candidate.partitionVersionId === input.partitionVersionId
    && (
      candidate.embeddingModel !== input.expectedIndex.embeddingModel
      || candidate.embeddingVersion !== input.expectedIndex.embeddingVersion
      || candidate.embeddingDimension !== input.expectedIndex.embeddingDimension
      || candidate.indexFormatVersion !== input.expectedIndex.indexFormatVersion
    );
  const safeReasonCode = indexIncompatible
    ? 'SHARD_INDEX_INCOMPATIBLE'
    : input.attempt.safeReasonCode ?? 'SHARD_SYNC_FAILED';
  return Object.freeze(input.definition.required
    ? {
        kind: 'required_unavailable' as const,
        shardKey: input.definition.shardKey,
        partitionVersionId: input.partitionVersionId,
        safeReasonCode,
      }
    : {
        kind: 'optional_unavailable' as const,
        shardKey: input.definition.shardKey,
        partitionVersionId: input.partitionVersionId,
        safeReasonCode,
      });
}

import { createHash } from 'node:crypto';

export interface BackstageNotionPartitionSourceGenerationMember {
  readonly shardKey: string;
  readonly partitionVersionId: string;
  readonly sourceManifestHash: string;
  readonly pageCount: number;
  readonly chunkCount: number;
}

/**
 * Hash one exact, complete configured-shard capture generation. The opaque
 * generation UUID is deliberately excluded so identical source captures have
 * the same deterministic digest across reconciliation attempts.
 */
export function hashBackstageNotionPartitionSourceGeneration(input: {
  readonly universeId: string;
  readonly members: readonly BackstageNotionPartitionSourceGenerationMember[];
}): string {
  const members = [...input.members]
    .sort((left, right) => left.shardKey < right.shardKey
      ? -1
      : left.shardKey > right.shardKey
        ? 1
        : 0)
    .map(member => ({
      shardKey: member.shardKey,
      partitionVersionId: member.partitionVersionId,
      sourceManifestHash: member.sourceManifestHash,
      pageCount: member.pageCount,
      chunkCount: member.chunkCount,
    }));
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    universeId: input.universeId,
    shards: members,
  }), 'utf8').digest('hex');
}

export function hashBackstageNotionPartitionSourceVerification(input: {
  readonly universeId: string;
  readonly sourceGenerationId: string;
  readonly members: readonly Readonly<{
    shardKey: string;
    sourceManifestHash: string;
    terminalDriftHash: string;
  }>[];
}): string {
  const members = [...input.members]
    .sort((left, right) => left.shardKey < right.shardKey
      ? -1
      : left.shardKey > right.shardKey
        ? 1
        : 0)
    .map(member => ({
      shardKey: member.shardKey,
      sourceManifestHash: member.sourceManifestHash,
      terminalDriftHash: member.terminalDriftHash,
    }));
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    universeId: input.universeId,
    sourceGenerationId: input.sourceGenerationId,
    shards: members,
  }), 'utf8').digest('hex');
}

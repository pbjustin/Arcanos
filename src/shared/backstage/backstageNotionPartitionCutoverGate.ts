import {
  BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS,
  BACKSTAGE_NOTION_PARTITION_MAX_PAGES,
  BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE,
} from './backstageNotionPartitionCore.js';
import {
  BACKSTAGE_NOTION_RAG_MAX_STALENESS_MAX_MS,
  BACKSTAGE_NOTION_RAG_MAX_STALENESS_MIN_MS,
} from './backstageNotionSnapshotStatus.js';
import {
  BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT,
} from './backstageNotionSyncCore.js';

export const BACKSTAGE_NOTION_PARTITION_CUTOVER_EVIDENCE_VERSION = 1;
export const BACKSTAGE_NOTION_PARTITION_SUPPORTED_INDEX_FORMAT_VERSION = 1;
export const BACKSTAGE_NOTION_PARTITION_CUTOVER_EVIDENCE_MAX_AGE_MS =
  24 * 60 * 60 * 1_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UNIVERSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHARD_KEY_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/u;

export type BackstageNotionPartitionCutoverGateReasonCode =
  | 'CUTOVER_EVIDENCE_MISSING'
  | 'CUTOVER_EVIDENCE_INVALID'
  | 'CUTOVER_EVIDENCE_OUTSIDE_VALIDITY_WINDOW'
  | 'CUTOVER_MANIFEST_NOT_ACTIVE'
  | 'CUTOVER_MANIFEST_NOT_SEALED'
  | 'CUTOVER_MANIFEST_UNREADABLE'
  | 'CUTOVER_CONFIGURATION_MISMATCH'
  | 'CUTOVER_RECONCILIATION_GENERATION_MISMATCH'
  | 'CUTOVER_SOURCE_GENERATION_MISMATCH'
  | 'CUTOVER_SOURCE_COVERAGE_MISMATCH'
  | 'CUTOVER_SOURCE_VERIFICATION_INVALID'
  | 'CUTOVER_SHARD_SET_INCOMPLETE'
  | 'CUTOVER_SHARD_NOT_FRESH'
  | 'CUTOVER_SHARD_UNREADABLE'
  | 'CUTOVER_OMISSIONS_PRESENT'
  | 'CUTOVER_EMBEDDING_MODEL_UNSUPPORTED'
  | 'CUTOVER_INDEX_FORMAT_UNSUPPORTED'
  | 'CUTOVER_LEASE_FENCING_UNRESOLVED'
  | 'CUTOVER_ACTIVATION_UNRESOLVED'
  | 'CUTOVER_SHADOW_COMPARISON_INCOMPLETE'
  | 'CUTOVER_EXACT_SCOPE_PARITY_FAILED'
  | 'CUTOVER_RELEVANT_RETRIEVAL_PARITY_FAILED'
  | 'CUTOVER_COMPLETE_SCOPE_PARITY_FAILED'
  | 'CUTOVER_CURSOR_STABILITY_FAILED'
  | 'CUTOVER_ROLLBACK_MONOLITH_UNAVAILABLE';

export interface BackstageNotionPartitionCutoverMemberEvidence {
  readonly shardKey: string;
  readonly snapshotId: string;
  readonly sourceGenerationId: string;
  readonly indexFormatVersion: number;
  readonly pageCount: number;
  readonly chunkCount: number;
  readonly decision: 'fresh' | 'retained_last_known_good';
  readonly readable: boolean;
}

export interface BackstageNotionPartitionCutoverParityEvidence {
  readonly shadowComparisonCompleted: boolean;
  readonly exactScopeParityPassed: boolean;
  readonly relevantRetrievalParityPassed: boolean;
  readonly completeScopeParityPassed: boolean;
  readonly cursorStabilityPassed: boolean;
}

/**
 * Bounded, content-free evidence for one exact active partition generation.
 * This is deliberately not inferred from configuration or mode alone.
 */
export interface BackstageNotionPartitionCutoverGateEvidence {
  readonly evidenceVersion: number;
  readonly reconciliationGeneration: number;
  readonly activeReconciliationGeneration: number;
  readonly publishedReconciliationGeneration: number;
  readonly universeId: string;
  readonly manifestId: string;
  readonly activeManifestId: string;
  readonly manifestState: 'building' | 'sealed';
  readonly manifestReadable: boolean;
  readonly manifestConfigurationVersionId: string;
  readonly activeConfigurationVersionId: string;
  readonly configurationHash: string;
  readonly activeConfigurationHash: string;
  readonly sourceGenerationId: string;
  readonly sourceDigest: string;
  readonly sourcePageCount: number;
  readonly sourceChunkCount: number;
  readonly sourceVerifiedAt: Date | string;
  readonly sourceVerificationHash: string;
  readonly manifestPageCount: number;
  readonly manifestChunkCount: number;
  readonly embeddingModel: string;
  readonly indexFormatVersion: number;
  readonly memberCount: number;
  readonly omissionCount: number;
  readonly members: readonly BackstageNotionPartitionCutoverMemberEvidence[];
  readonly leaseFencingClear: boolean;
  readonly unresolvedActivationCount: number;
  readonly parity: BackstageNotionPartitionCutoverParityEvidence;
  readonly rollbackMonolithSnapshotId: string | null;
  readonly rollbackMonolithReadable: boolean;
  readonly rollbackMonolithChunkCount: number;
  readonly rollbackMonolithVerifiedAt: Date | string | null;
  readonly rollbackMonolithValidUntil: Date | string | null;
  readonly verifiedAt: Date | string;
  readonly expiresAt: Date | string;
}

export interface BackstageNotionPartitionCutoverGateEvaluation {
  readonly available: boolean;
  readonly effectiveReadMode: 'monolith' | 'partitioned';
  readonly manifestId: string | null;
  readonly reasonCodes: readonly BackstageNotionPartitionCutoverGateReasonCode[];
}

function closedEvaluation(
  reasonCode: BackstageNotionPartitionCutoverGateReasonCode
): BackstageNotionPartitionCutoverGateEvaluation {
  return Object.freeze({
    available: false,
    effectiveReadMode: 'monolith' as const,
    manifestId: null,
    reasonCodes: Object.freeze([reasonCode]),
  });
}

function timeOf(value: Date | string): number | null {
  const date = value instanceof Date
    ? value
    : typeof value === 'string'
      ? new Date(value)
      : null;
  const milliseconds = date?.getTime();
  return milliseconds !== undefined && Number.isFinite(milliseconds)
    ? milliseconds
    : null;
}

function isBoundedCount(value: number): boolean {
  return Number.isSafeInteger(value)
    && value >= 0
    && value <= BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE;
}

function isPositiveBoundedCount(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function validParity(
  value: BackstageNotionPartitionCutoverParityEvidence
): boolean {
  return value !== null
    && typeof value === 'object'
    && typeof value.shadowComparisonCompleted === 'boolean'
    && typeof value.exactScopeParityPassed === 'boolean'
    && typeof value.relevantRetrievalParityPassed === 'boolean'
    && typeof value.completeScopeParityPassed === 'boolean'
    && typeof value.cursorStabilityPassed === 'boolean';
}

function validExpectedInput(input: {
  readonly universeId: string;
  readonly configurationHash: string;
  readonly configuredShardKeys: readonly string[];
  readonly maximumStalenessMs: number;
  readonly supportedEmbeddingModel: string;
  readonly now: Date;
}): boolean {
  return UNIVERSE_ID_PATTERN.test(input.universeId)
    && SHA256_PATTERN.test(input.configurationHash)
    && Number.isSafeInteger(input.maximumStalenessMs)
    && input.maximumStalenessMs >= BACKSTAGE_NOTION_RAG_MAX_STALENESS_MIN_MS
    && input.maximumStalenessMs <= BACKSTAGE_NOTION_RAG_MAX_STALENESS_MAX_MS
    && input.supportedEmbeddingModel.length >= 1
    && input.supportedEmbeddingModel.length <= 200
    && input.supportedEmbeddingModel === input.supportedEmbeddingModel.trim()
    && input.now instanceof Date
    && Number.isFinite(input.now.getTime())
    && Array.isArray(input.configuredShardKeys)
    && input.configuredShardKeys.length >= 1
    && input.configuredShardKeys.length
      <= BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
    && input.configuredShardKeys.every(shardKey => SHARD_KEY_PATTERN.test(shardKey))
    && new Set(input.configuredShardKeys).size === input.configuredShardKeys.length;
}

function validEvidenceShape(
  evidence: BackstageNotionPartitionCutoverGateEvidence
): boolean {
  return evidence !== null
    && typeof evidence === 'object'
    && evidence.evidenceVersion
      === BACKSTAGE_NOTION_PARTITION_CUTOVER_EVIDENCE_VERSION
    && Number.isSafeInteger(evidence.reconciliationGeneration)
    && evidence.reconciliationGeneration > 0
    && Number.isSafeInteger(evidence.activeReconciliationGeneration)
    && evidence.activeReconciliationGeneration > 0
    && Number.isSafeInteger(evidence.publishedReconciliationGeneration)
    && evidence.publishedReconciliationGeneration > 0
    && UNIVERSE_ID_PATTERN.test(evidence.universeId)
    && UUID_PATTERN.test(evidence.manifestId)
    && UUID_PATTERN.test(evidence.activeManifestId)
    && (evidence.manifestState === 'building' || evidence.manifestState === 'sealed')
    && typeof evidence.manifestReadable === 'boolean'
    && UUID_PATTERN.test(evidence.manifestConfigurationVersionId)
    && UUID_PATTERN.test(evidence.activeConfigurationVersionId)
    && SHA256_PATTERN.test(evidence.configurationHash)
    && SHA256_PATTERN.test(evidence.activeConfigurationHash)
    && UUID_PATTERN.test(evidence.sourceGenerationId)
    && SHA256_PATTERN.test(evidence.sourceDigest)
    && isPositiveBoundedCount(
      evidence.sourcePageCount,
      BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
        * BACKSTAGE_NOTION_PARTITION_MAX_PAGES
    )
    && isPositiveBoundedCount(
      evidence.sourceChunkCount,
      BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
        * BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS
    )
    && timeOf(evidence.sourceVerifiedAt) !== null
    && SHA256_PATTERN.test(evidence.sourceVerificationHash)
    && isPositiveBoundedCount(
      evidence.manifestPageCount,
      BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
        * BACKSTAGE_NOTION_PARTITION_MAX_PAGES
    )
    && isPositiveBoundedCount(
      evidence.manifestChunkCount,
      BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
        * BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS
    )
    && typeof evidence.embeddingModel === 'string'
    && evidence.embeddingModel.length >= 1
    && evidence.embeddingModel.length <= 200
    && evidence.embeddingModel === evidence.embeddingModel.trim()
    && Number.isSafeInteger(evidence.indexFormatVersion)
    && evidence.indexFormatVersion > 0
    && isBoundedCount(evidence.memberCount)
    && isBoundedCount(evidence.omissionCount)
    && Array.isArray(evidence.members)
    && evidence.members.length
      <= BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
    && evidence.members.every(member => (
      member !== null
      && typeof member === 'object'
      && SHARD_KEY_PATTERN.test(member.shardKey)
      && UUID_PATTERN.test(member.snapshotId)
      && UUID_PATTERN.test(member.sourceGenerationId)
      && Number.isSafeInteger(member.indexFormatVersion)
      && member.indexFormatVersion > 0
      && isPositiveBoundedCount(
        member.pageCount,
        BACKSTAGE_NOTION_PARTITION_MAX_PAGES
      )
      && isPositiveBoundedCount(
        member.chunkCount,
        BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS
      )
      && (member.decision === 'fresh'
        || member.decision === 'retained_last_known_good')
      && typeof member.readable === 'boolean'
    ))
    && typeof evidence.leaseFencingClear === 'boolean'
    && isBoundedCount(evidence.unresolvedActivationCount)
    && validParity(evidence.parity)
    && (evidence.rollbackMonolithSnapshotId === null
      || UUID_PATTERN.test(evidence.rollbackMonolithSnapshotId))
    && typeof evidence.rollbackMonolithReadable === 'boolean'
    && Number.isSafeInteger(evidence.rollbackMonolithChunkCount)
    && evidence.rollbackMonolithChunkCount >= 0
    && evidence.rollbackMonolithChunkCount
      <= BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT
    && (evidence.rollbackMonolithVerifiedAt === null
      || timeOf(evidence.rollbackMonolithVerifiedAt) !== null)
    && (evidence.rollbackMonolithValidUntil === null
      || timeOf(evidence.rollbackMonolithValidUntil) !== null)
    && timeOf(evidence.verifiedAt) !== null
    && timeOf(evidence.expiresAt) !== null;
}

/**
 * Admit partitioned reads only from explicit evidence for the exact runtime
 * configuration and active immutable manifest. Every missing or malformed
 * input resolves to monolith.
 */
export function evaluateBackstageNotionPartitionCutoverGate(input: {
  readonly universeId: string;
  readonly configurationHash: string;
  readonly configuredShardKeys: readonly string[];
  readonly maximumStalenessMs: number;
  readonly supportedEmbeddingModel: string;
  readonly evidence?: BackstageNotionPartitionCutoverGateEvidence | null;
  readonly now?: Date;
}): BackstageNotionPartitionCutoverGateEvaluation {
  const now = input.now ?? new Date();
  if (!validExpectedInput({
    universeId: input.universeId,
    configurationHash: input.configurationHash,
    configuredShardKeys: input.configuredShardKeys,
    maximumStalenessMs: input.maximumStalenessMs,
    supportedEmbeddingModel: input.supportedEmbeddingModel,
    now,
  })) {
    return closedEvaluation('CUTOVER_EVIDENCE_INVALID');
  }
  if (input.evidence === undefined || input.evidence === null) {
    return closedEvaluation('CUTOVER_EVIDENCE_MISSING');
  }
  const evidence = input.evidence;
  try {
    if (!validEvidenceShape(evidence)) {
      return closedEvaluation('CUTOVER_EVIDENCE_INVALID');
    }
  } catch {
    return closedEvaluation('CUTOVER_EVIDENCE_INVALID');
  }

  const reasons: BackstageNotionPartitionCutoverGateReasonCode[] = [];
  const add = (reason: BackstageNotionPartitionCutoverGateReasonCode): void => {
    if (!reasons.includes(reason)) {
      reasons.push(reason);
    }
  };
  const verifiedAt = timeOf(evidence.verifiedAt)!;
  const expiresAt = timeOf(evidence.expiresAt)!;
  if (
    verifiedAt > now.getTime()
    || expiresAt < now.getTime()
    || expiresAt <= verifiedAt
    || expiresAt - verifiedAt
      > BACKSTAGE_NOTION_PARTITION_CUTOVER_EVIDENCE_MAX_AGE_MS
  ) {
    add('CUTOVER_EVIDENCE_OUTSIDE_VALIDITY_WINDOW');
  }
  if (evidence.universeId !== input.universeId) {
    add('CUTOVER_CONFIGURATION_MISMATCH');
  }
  if (
    evidence.reconciliationGeneration
      !== evidence.activeReconciliationGeneration
    || evidence.publishedReconciliationGeneration
      !== evidence.activeReconciliationGeneration
  ) {
    add('CUTOVER_RECONCILIATION_GENERATION_MISMATCH');
  }
  if (evidence.manifestId !== evidence.activeManifestId) {
    add('CUTOVER_MANIFEST_NOT_ACTIVE');
  }
  if (evidence.manifestState !== 'sealed') {
    add('CUTOVER_MANIFEST_NOT_SEALED');
  }
  if (!evidence.manifestReadable) {
    add('CUTOVER_MANIFEST_UNREADABLE');
  }
  if (
    evidence.manifestConfigurationVersionId
      !== evidence.activeConfigurationVersionId
    ||
    evidence.configurationHash !== input.configurationHash
    || evidence.activeConfigurationHash !== input.configurationHash
  ) {
    add('CUTOVER_CONFIGURATION_MISMATCH');
  }
  const sourceVerifiedAt = timeOf(evidence.sourceVerifiedAt)!;
  if (
    sourceVerifiedAt > verifiedAt
    || sourceVerifiedAt > now.getTime()
  ) {
    add('CUTOVER_SOURCE_VERIFICATION_INVALID');
  }
  if (evidence.members.some(member => (
    member.sourceGenerationId !== evidence.sourceGenerationId
  ))) {
    add('CUTOVER_SOURCE_GENERATION_MISMATCH');
  }
  const memberPageCount = evidence.members.reduce(
    (total, member) => total + member.pageCount,
    0
  );
  const memberChunkCount = evidence.members.reduce(
    (total, member) => total + member.chunkCount,
    0
  );
  if (
    evidence.sourcePageCount !== evidence.manifestPageCount
    || evidence.sourceChunkCount !== evidence.manifestChunkCount
    || memberPageCount !== evidence.manifestPageCount
    || memberChunkCount !== evidence.manifestChunkCount
  ) {
    add('CUTOVER_SOURCE_COVERAGE_MISMATCH');
  }
  if (
    evidence.embeddingModel !== input.supportedEmbeddingModel
  ) {
    add('CUTOVER_EMBEDDING_MODEL_UNSUPPORTED');
  }
  if (
    evidence.indexFormatVersion
      !== BACKSTAGE_NOTION_PARTITION_SUPPORTED_INDEX_FORMAT_VERSION
  ) {
    add('CUTOVER_INDEX_FORMAT_UNSUPPORTED');
  }
  if (evidence.omissionCount !== 0) {
    add('CUTOVER_OMISSIONS_PRESENT');
  }

  const configuredKeys = new Set(input.configuredShardKeys);
  const memberKeys = new Set(evidence.members.map(member => member.shardKey));
  if (
    evidence.memberCount !== evidence.members.length
    || evidence.memberCount !== input.configuredShardKeys.length
    || memberKeys.size !== evidence.members.length
    || memberKeys.size !== configuredKeys.size
    || evidence.members.some(member => !configuredKeys.has(member.shardKey))
  ) {
    add('CUTOVER_SHARD_SET_INCOMPLETE');
  }
  if (evidence.members.some(member => member.decision !== 'fresh')) {
    add('CUTOVER_SHARD_NOT_FRESH');
  }
  if (evidence.members.some(member => !member.readable)) {
    add('CUTOVER_SHARD_UNREADABLE');
  }
  if (evidence.members.some(member => (
    member.indexFormatVersion !== evidence.indexFormatVersion
  ))) {
    add('CUTOVER_INDEX_FORMAT_UNSUPPORTED');
  }
  if (!evidence.leaseFencingClear) {
    add('CUTOVER_LEASE_FENCING_UNRESOLVED');
  }
  if (evidence.unresolvedActivationCount !== 0) {
    add('CUTOVER_ACTIVATION_UNRESOLVED');
  }
  if (!evidence.parity.shadowComparisonCompleted) {
    add('CUTOVER_SHADOW_COMPARISON_INCOMPLETE');
  }
  if (!evidence.parity.exactScopeParityPassed) {
    add('CUTOVER_EXACT_SCOPE_PARITY_FAILED');
  }
  if (!evidence.parity.relevantRetrievalParityPassed) {
    add('CUTOVER_RELEVANT_RETRIEVAL_PARITY_FAILED');
  }
  if (!evidence.parity.completeScopeParityPassed) {
    add('CUTOVER_COMPLETE_SCOPE_PARITY_FAILED');
  }
  if (!evidence.parity.cursorStabilityPassed) {
    add('CUTOVER_CURSOR_STABILITY_FAILED');
  }
  const rollbackMonolithVerifiedAt = evidence.rollbackMonolithVerifiedAt === null
    ? null
    : timeOf(evidence.rollbackMonolithVerifiedAt);
  const rollbackMonolithValidUntil = evidence.rollbackMonolithValidUntil === null
    ? null
    : timeOf(evidence.rollbackMonolithValidUntil);
  if (
    evidence.rollbackMonolithSnapshotId === null
    || !evidence.rollbackMonolithReadable
    || evidence.rollbackMonolithChunkCount < 1
    || rollbackMonolithVerifiedAt === null
    || rollbackMonolithValidUntil === null
    || rollbackMonolithVerifiedAt > verifiedAt
    || rollbackMonolithValidUntil <= rollbackMonolithVerifiedAt
    || rollbackMonolithValidUntil < now.getTime()
    || now.getTime() - rollbackMonolithVerifiedAt > input.maximumStalenessMs
  ) {
    add('CUTOVER_ROLLBACK_MONOLITH_UNAVAILABLE');
  }

  const available = reasons.length === 0;
  return Object.freeze({
    available,
    effectiveReadMode: available ? 'partitioned' as const : 'monolith' as const,
    manifestId: evidence.manifestId,
    reasonCodes: Object.freeze(reasons),
  });
}

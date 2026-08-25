import {
  BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS,
  BACKSTAGE_NOTION_PARTITION_MAX_PAGES,
  isBackstageNotionPartitionGeneration,
  isBackstageNotionShardKey,
  isBackstageNotionUniverseId,
} from '@shared/backstage/backstageNotionPartitionCore.js';
import {
  BACKSTAGE_NOTION_PARTITION_OPTIONAL_UNAVAILABLE_REASON_CODES,
  type BackstageNotionPartitionOptionalUnavailableReasonCode,
} from '@shared/backstage/backstageNotionPartitionSyncCore.js';

export const BACKSTAGE_NOTION_PARTITION_SYNC_JOB_TYPE =
  'backstage-notion-partition-sync';
export const BACKSTAGE_NOTION_PARTITION_SYNC_JOB_PROTOCOL =
  'backstage-notion-partition-sync-job-v1';
export const BACKSTAGE_NOTION_PARTITION_SYNC_RESULT_PROTOCOL =
  'backstage-notion-partition-sync-result-v1';
export const BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION = 1;
export const BACKSTAGE_NOTION_PARTITION_SYNC_IDEMPOTENCY_WINDOW_MS =
  24 * 60 * 60 * 1_000;
export const BACKSTAGE_NOTION_PARTITION_SYNC_MAX_ACTIVE_JOBS = 16;
export const BACKSTAGE_NOTION_PARTITION_SYNC_MAX_AI_CALLS = 512;

const REQUEST_KEYS = new Set(['shardKey', 'version']);
const JOB_INPUT_KEYS = new Set([
  'configurationDigest',
  'configurationGeneration',
  'protocol',
  'shardKey',
  'universeId',
  'version',
]);
const PAGE_CHANGE_KEYS = new Set([
  'added',
  'changed',
  'deleted',
  'moved',
  'unchanged',
]);
const RESULT_KEYS = new Set([
  'chunkCount',
  'embeddedChunkCount',
  'freshSnapshotId',
  'fullSourceScan',
  'manifestId',
  'manifestStatus',
  'outcome',
  'pageChanges',
  'pageCount',
  'pageVersionReuseCount',
  'protocol',
  'safeReasonCode',
  'shardKey',
  'universeId',
  'version',
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const BACKSTAGE_NOTION_PARTITION_SYNC_OPERATION_REASON_CODES = [
  'CONFIGURATION_STALE',
  'CONFIGURATION_UNAVAILABLE',
  'MANIFEST_BLOCKED',
  'MANIFEST_DEFERRED',
  'MODE_DISABLED',
  'SYNC_FAILED',
  'TARGET_UNAVAILABLE',
  ...BACKSTAGE_NOTION_PARTITION_OPTIONAL_UNAVAILABLE_REASON_CODES,
] as const;

export type BackstageNotionPartitionSyncOperationReasonCode =
  (typeof BACKSTAGE_NOTION_PARTITION_SYNC_OPERATION_REASON_CODES)[number];

export interface BackstageNotionPartitionSyncRequestBody {
  readonly version: typeof BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION;
  readonly shardKey: string;
}

export interface BackstageNotionPartitionSyncJobInput {
  readonly protocol: typeof BACKSTAGE_NOTION_PARTITION_SYNC_JOB_PROTOCOL;
  readonly version: typeof BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION;
  readonly universeId: string;
  readonly shardKey: string;
  readonly configurationGeneration: string;
  readonly configurationDigest: string;
}

export interface BackstageNotionPartitionSyncJobResult {
  readonly protocol: typeof BACKSTAGE_NOTION_PARTITION_SYNC_RESULT_PROTOCOL;
  readonly version: typeof BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION;
  readonly outcome: 'synchronized' | 'completed_with_errors';
  readonly safeReasonCode: BackstageNotionPartitionSyncOperationReasonCode | null;
  readonly universeId: string;
  readonly shardKey: string;
  readonly fullSourceScan: boolean;
  readonly manifestStatus: 'published' | 'blocked' | 'deferred' | 'not_attempted';
  readonly manifestId: string | null;
  readonly freshSnapshotId: string | null;
  readonly pageCount: number;
  readonly chunkCount: number;
  readonly pageVersionReuseCount: number;
  readonly embeddedChunkCount: number;
  readonly pageChanges: Readonly<{
    added: number;
    changed: number;
    moved: number;
    deleted: number;
    unchanged: number;
  }>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every(key => expected.has(key));
}

function isBoundedCount(
  value: unknown,
  maximum: number
): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= maximum;
}

function isNullableUuid(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && UUID_PATTERN.test(value));
}

export function parseBackstageNotionPartitionSyncRequestBody(
  value: unknown
): BackstageNotionPartitionSyncRequestBody | null {
  if (
    !isPlainObject(value)
    || !hasExactKeys(value, REQUEST_KEYS)
    || value.version !== BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION
    || !isBackstageNotionShardKey(value.shardKey)
  ) {
    return null;
  }
  return Object.freeze({
    version: BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
    shardKey: value.shardKey,
  });
}

export function parseBackstageNotionPartitionSyncJobInput(
  value: unknown
): BackstageNotionPartitionSyncJobInput | null {
  if (
    !isPlainObject(value)
    || !hasExactKeys(value, JOB_INPUT_KEYS)
    || value.protocol !== BACKSTAGE_NOTION_PARTITION_SYNC_JOB_PROTOCOL
    || value.version !== BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION
    || !isBackstageNotionUniverseId(value.universeId)
    || !isBackstageNotionShardKey(value.shardKey)
    || !isBackstageNotionPartitionGeneration(value.configurationGeneration)
    || typeof value.configurationDigest !== 'string'
    || !SHA256_PATTERN.test(value.configurationDigest)
  ) {
    return null;
  }
  return Object.freeze({
    protocol: BACKSTAGE_NOTION_PARTITION_SYNC_JOB_PROTOCOL,
    version: BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
    universeId: value.universeId,
    shardKey: value.shardKey,
    configurationGeneration: value.configurationGeneration,
    configurationDigest: value.configurationDigest,
  });
}

export function parseBackstageNotionPartitionSyncJobResult(
  value: unknown
): BackstageNotionPartitionSyncJobResult | null {
  if (!isPlainObject(value) || !hasExactKeys(value, RESULT_KEYS)) {
    return null;
  }
  const reasonCode = value.safeReasonCode;
  const pageChanges = value.pageChanges;
  const manifestStatus = value.manifestStatus;
  if (
    value.protocol !== BACKSTAGE_NOTION_PARTITION_SYNC_RESULT_PROTOCOL
    || value.version !== BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION
    || (value.outcome !== 'synchronized' && value.outcome !== 'completed_with_errors')
    || (
      reasonCode !== null
      && !BACKSTAGE_NOTION_PARTITION_SYNC_OPERATION_REASON_CODES.includes(
        reasonCode as BackstageNotionPartitionSyncOperationReasonCode
      )
    )
    || (value.outcome === 'synchronized') !== (reasonCode === null)
    || !isBackstageNotionUniverseId(value.universeId)
    || !isBackstageNotionShardKey(value.shardKey)
    || typeof value.fullSourceScan !== 'boolean'
    || (
      manifestStatus !== 'published'
      && manifestStatus !== 'blocked'
      && manifestStatus !== 'deferred'
      && manifestStatus !== 'not_attempted'
    )
    || !isNullableUuid(value.manifestId)
    || !isNullableUuid(value.freshSnapshotId)
    || !isBoundedCount(value.pageCount, BACKSTAGE_NOTION_PARTITION_MAX_PAGES)
    || !isBoundedCount(value.chunkCount, BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS)
    || !isBoundedCount(
      value.pageVersionReuseCount,
      BACKSTAGE_NOTION_PARTITION_MAX_PAGES
    )
    || !isBoundedCount(
      value.embeddedChunkCount,
      BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS
    )
    || !isPlainObject(pageChanges)
    || !hasExactKeys(pageChanges, PAGE_CHANGE_KEYS)
    || !isBoundedCount(pageChanges.added, BACKSTAGE_NOTION_PARTITION_MAX_PAGES)
    || !isBoundedCount(pageChanges.changed, BACKSTAGE_NOTION_PARTITION_MAX_PAGES)
    || !isBoundedCount(pageChanges.moved, BACKSTAGE_NOTION_PARTITION_MAX_PAGES)
    || !isBoundedCount(pageChanges.deleted, BACKSTAGE_NOTION_PARTITION_MAX_PAGES)
    || !isBoundedCount(pageChanges.unchanged, BACKSTAGE_NOTION_PARTITION_MAX_PAGES)
    || value.pageVersionReuseCount > value.pageCount
    || value.embeddedChunkCount > value.chunkCount
    || pageChanges.added
      + pageChanges.changed
      + pageChanges.moved
      + pageChanges.unchanged !== value.pageCount
    || (manifestStatus === 'published') !== (value.manifestId !== null)
    || (
      manifestStatus === 'not_attempted'
      && (
        value.fullSourceScan !== false
        || value.freshSnapshotId !== null
        || value.pageCount !== 0
        || value.chunkCount !== 0
        || value.pageVersionReuseCount !== 0
        || value.embeddedChunkCount !== 0
        || pageChanges.added !== 0
        || pageChanges.changed !== 0
        || pageChanges.moved !== 0
        || pageChanges.deleted !== 0
        || pageChanges.unchanged !== 0
      )
    )
    || (
      value.outcome === 'synchronized'
      && (
        value.fullSourceScan !== true
        || manifestStatus !== 'published'
        || value.freshSnapshotId === null
        || value.pageCount < 1
        || value.chunkCount < 1
      )
    )
    || (
      value.freshSnapshotId !== null
      && (
        value.fullSourceScan !== true
        || value.pageCount < 1
        || value.chunkCount < 1
      )
    )
  ) {
    return null;
  }
  return Object.freeze({
    protocol: BACKSTAGE_NOTION_PARTITION_SYNC_RESULT_PROTOCOL,
    version: BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
    outcome: value.outcome,
    safeReasonCode: reasonCode as BackstageNotionPartitionSyncOperationReasonCode | null,
    universeId: value.universeId,
    shardKey: value.shardKey,
    fullSourceScan: value.fullSourceScan,
    manifestStatus,
    manifestId: value.manifestId,
    freshSnapshotId: value.freshSnapshotId,
    pageCount: value.pageCount,
    chunkCount: value.chunkCount,
    pageVersionReuseCount: value.pageVersionReuseCount,
    embeddedChunkCount: value.embeddedChunkCount,
    pageChanges: Object.freeze({
      added: pageChanges.added,
      changed: pageChanges.changed,
      moved: pageChanges.moved,
      deleted: pageChanges.deleted,
      unchanged: pageChanges.unchanged,
    }),
  });
}

export type {
  BackstageNotionPartitionOptionalUnavailableReasonCode,
};

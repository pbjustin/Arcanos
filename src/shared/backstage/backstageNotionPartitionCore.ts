import { createHash } from 'node:crypto';

export const BACKSTAGE_NOTION_PARTITIONS_ENV_NAME =
  'ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON';
export const BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME =
  'ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE';

export const BACKSTAGE_NOTION_PARTITION_CONFIGURATION_VERSION = 1;
export const BACKSTAGE_NOTION_PARTITION_MAX_CONFIG_BYTES = 256 * 1024;
export const BACKSTAGE_NOTION_PARTITION_MAX_UNIVERSES = 32;
export const BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE = 128;
export const BACKSTAGE_NOTION_PARTITION_MAX_TOTAL_SHARDS = 512;
export const BACKSTAGE_NOTION_PARTITION_MAX_TAGS_PER_KIND = 32;
export const BACKSTAGE_NOTION_PARTITION_MAX_PAGES = 512;
export const BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS = 2_048;
export const BACKSTAGE_NOTION_PARTITION_MAX_DEPTH = 16;
export const BACKSTAGE_NOTION_PARTITION_MAX_CONTENT_CODE_POINTS = 4_000_000;

const BACKSTAGE_NOTION_PARTITION_SEMANTIC_FORMAT =
  'backstage-notion-partition-configuration-v1';
const BACKSTAGE_UNIVERSE_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BACKSTAGE_NOTION_PARTITION_GENERATION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BACKSTAGE_NOTION_SHARD_KEY_PATTERN =
  /^[a-z0-9][a-z0-9._:/-]{0,127}$/u;
const BACKSTAGE_NOTION_PARTITION_TAG_PATTERN =
  /^[a-z0-9][a-z0-9._:/-]{0,63}$/u;
const NOTION_PAGE_ID_PATTERN =
  /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu;
const FORBIDDEN_IDENTITY_VALUES = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
const CONFIGURATION_KEYS = new Set(['generation', 'universes', 'version']);
const UNIVERSE_KEYS = new Set(['shards', 'universeId']);
const SHARD_KEYS = new Set([
  'capacity',
  'categoryTags',
  'displayName',
  'required',
  'retrievalTier',
  'rootPageId',
  'scopeTags',
  'shardKey',
]);
const REQUIRED_SHARD_KEYS = [
  'capacity',
  'displayName',
  'required',
  'retrievalTier',
  'rootPageId',
  'shardKey',
] as const;
const CAPACITY_KEYS = new Set([
  'maxChunks',
  'maxContentCodePoints',
  'maxDepth',
  'maxPages',
]);

export type BackstageNotionRetrievalTier = 'hot' | 'cold' | 'archive';
export type BackstageNotionPartitionedIndexMode =
  | 'monolith'
  | 'shadow'
  | 'partitioned';

export function isBackstageNotionUniverseId(value: unknown): value is string {
  return typeof value === 'string'
    && BACKSTAGE_UNIVERSE_ID_PATTERN.test(value)
    && !FORBIDDEN_IDENTITY_VALUES.has(value);
}

export function isBackstageNotionPartitionGeneration(
  value: unknown
): value is string {
  return typeof value === 'string'
    && BACKSTAGE_NOTION_PARTITION_GENERATION_PATTERN.test(value)
    && !FORBIDDEN_IDENTITY_VALUES.has(value);
}

export function isBackstageNotionShardKey(value: unknown): value is string {
  return typeof value === 'string'
    && BACKSTAGE_NOTION_SHARD_KEY_PATTERN.test(value)
    && !FORBIDDEN_IDENTITY_VALUES.has(value);
}

export type BackstageNotionPartitionedIndexModeResolution = Readonly<{
  mode: BackstageNotionPartitionedIndexMode;
  status: 'absent' | 'valid' | 'invalid';
}>;

/** Keep partition writers confined to the exact shadow rollout mode. */
export function isBackstageNotionPartitionSyncWriterEnabled(
  resolution: BackstageNotionPartitionedIndexModeResolution
): boolean {
  return resolution.status === 'valid' && resolution.mode === 'shadow';
}

export interface BackstageNotionPartitionCapacity {
  readonly maxPages: number;
  readonly maxChunks: number;
  readonly maxDepth: number;
  readonly maxContentCodePoints: number;
}

export interface BackstageNotionPartitionDefinition {
  readonly universeId: string;
  readonly shardKey: string;
  readonly rootPageId: string;
  readonly displayName: string;
  readonly retrievalTier: BackstageNotionRetrievalTier;
  readonly required: boolean;
  readonly scopeTags: readonly string[];
  readonly categoryTags: readonly string[];
  readonly capacity: BackstageNotionPartitionCapacity;
}

export interface BackstageNotionPartitionUniverse {
  readonly universeId: string;
  readonly shards: readonly BackstageNotionPartitionDefinition[];
}

export type BackstageNotionPartitionConfigurationInvalidReason =
  | 'invalid_json'
  | 'invalid_shape'
  | 'too_large';

export type BackstageNotionPartitionConfiguration =
  | Readonly<{
      status: 'absent';
      generation: null;
      semanticDigest: null;
      universes: readonly [];
    }>
  | Readonly<{
      status: 'invalid';
      generation: null;
      semanticDigest: null;
      universes: readonly [];
      reason: BackstageNotionPartitionConfigurationInvalidReason;
    }>
  | Readonly<{
      status: 'valid';
      version: typeof BACKSTAGE_NOTION_PARTITION_CONFIGURATION_VERSION;
      generation: string;
      semanticDigest: string;
      universes: readonly BackstageNotionPartitionUniverse[];
    }>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasClosedShape(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: readonly string[]
): boolean {
  const keys = Object.keys(value);
  return keys.every(key => allowedKeys.has(key))
    && requiredKeys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeNotionPageId(value: string): string | null {
  if (!NOTION_PAGE_ID_PATTERN.test(value)) {
    return null;
  }
  const compact = value.replaceAll('-', '').toLowerCase();
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join('-');
}

function isValidDisplayName(value: string): boolean {
  const codePointLength = Array.from(value).length;
  return value === value.trim()
    && codePointLength >= 1
    && codePointLength <= 160
    && !/[\u0000-\u001F\u007F-\u009F]/u.test(value)
    && !/[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u.test(value);
}

function isBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number
): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function parseTags(value: unknown): readonly string[] | null {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (
    !Array.isArray(value)
    || value.length > BACKSTAGE_NOTION_PARTITION_MAX_TAGS_PER_KIND
    || value.some(tag => (
      typeof tag !== 'string'
      || !BACKSTAGE_NOTION_PARTITION_TAG_PATTERN.test(tag)
      || FORBIDDEN_IDENTITY_VALUES.has(tag)
    ))
    || new Set(value).size !== value.length
  ) {
    return null;
  }
  return Object.freeze([...value].sort(compareCanonicalText));
}

function parseCapacity(value: unknown): BackstageNotionPartitionCapacity | null {
  if (
    !isPlainObject(value)
    || !hasClosedShape(value, CAPACITY_KEYS, [...CAPACITY_KEYS])
    || !isBoundedInteger(
      value.maxPages,
      1,
      BACKSTAGE_NOTION_PARTITION_MAX_PAGES
    )
    || !isBoundedInteger(
      value.maxChunks,
      1,
      BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS
    )
    || !isBoundedInteger(
      value.maxDepth,
      0,
      BACKSTAGE_NOTION_PARTITION_MAX_DEPTH
    )
    || !isBoundedInteger(
      value.maxContentCodePoints,
      1,
      BACKSTAGE_NOTION_PARTITION_MAX_CONTENT_CODE_POINTS
    )
  ) {
    return null;
  }
  return Object.freeze({
    maxPages: value.maxPages,
    maxChunks: value.maxChunks,
    maxDepth: value.maxDepth,
    maxContentCodePoints: value.maxContentCodePoints,
  });
}

function invalidConfiguration(
  reason: BackstageNotionPartitionConfigurationInvalidReason
): BackstageNotionPartitionConfiguration {
  return Object.freeze({
    status: 'invalid' as const,
    generation: null,
    semanticDigest: null,
    universes: Object.freeze([]) as readonly [],
    reason,
  });
}

function semanticDigest(
  universes: readonly BackstageNotionPartitionUniverse[]
): string {
  return createHash('sha256').update(JSON.stringify({
    format: BACKSTAGE_NOTION_PARTITION_SEMANTIC_FORMAT,
    version: BACKSTAGE_NOTION_PARTITION_CONFIGURATION_VERSION,
    universes: universes.map(universe => ({
      universeId: universe.universeId,
      shards: universe.shards.map(shard => ({
        shardKey: shard.shardKey,
        rootPageId: shard.rootPageId,
        displayName: shard.displayName,
        retrievalTier: shard.retrievalTier,
        required: shard.required,
        scopeTags: shard.scopeTags,
        categoryTags: shard.categoryTags,
        capacity: shard.capacity,
      })),
    })),
  }), 'utf8').digest('hex');
}

/** Resolve only exact, lowercase rollout modes; unsafe values remain monolithic. */
export function parseBackstageNotionPartitionedIndexMode(
  rawValue: string | undefined
): BackstageNotionPartitionedIndexModeResolution {
  if (rawValue === undefined) {
    return Object.freeze({ status: 'absent' as const, mode: 'monolith' as const });
  }
  if (
    rawValue === 'monolith'
    || rawValue === 'shadow'
    || rawValue === 'partitioned'
  ) {
    return Object.freeze({ status: 'valid' as const, mode: rawValue });
  }
  return Object.freeze({ status: 'invalid' as const, mode: 'monolith' as const });
}

/** Parse and canonically order the additive partition configuration envelope. */
export function parseBackstageNotionPartitionConfiguration(
  rawValue: string | undefined
): BackstageNotionPartitionConfiguration {
  if (rawValue === undefined) {
    return Object.freeze({
      status: 'absent' as const,
      generation: null,
      semanticDigest: null,
      universes: Object.freeze([]) as readonly [],
    });
  }
  if (
    rawValue.length === 0
    || Buffer.byteLength(rawValue, 'utf8')
      > BACKSTAGE_NOTION_PARTITION_MAX_CONFIG_BYTES
  ) {
    return invalidConfiguration(rawValue.length === 0 ? 'invalid_shape' : 'too_large');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue) as unknown;
  } catch {
    return invalidConfiguration('invalid_json');
  }
  if (
    !isPlainObject(parsed)
    || !hasClosedShape(
      parsed,
      CONFIGURATION_KEYS,
      ['generation', 'universes', 'version']
    )
    || parsed.version !== BACKSTAGE_NOTION_PARTITION_CONFIGURATION_VERSION
    || !isBackstageNotionPartitionGeneration(parsed.generation)
    || !Array.isArray(parsed.universes)
    || parsed.universes.length < 1
    || parsed.universes.length > BACKSTAGE_NOTION_PARTITION_MAX_UNIVERSES
  ) {
    return invalidConfiguration('invalid_shape');
  }

  const universes: BackstageNotionPartitionUniverse[] = [];
  const seenUniverseIds = new Set<string>();
  let totalShards = 0;

  for (const rawUniverse of parsed.universes) {
    if (
      !isPlainObject(rawUniverse)
      || !hasClosedShape(rawUniverse, UNIVERSE_KEYS, ['shards', 'universeId'])
      || !isBackstageNotionUniverseId(rawUniverse.universeId)
      || seenUniverseIds.has(rawUniverse.universeId)
      || !Array.isArray(rawUniverse.shards)
      || rawUniverse.shards.length < 1
      || rawUniverse.shards.length
        > BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
    ) {
      return invalidConfiguration('invalid_shape');
    }
    seenUniverseIds.add(rawUniverse.universeId);
    totalShards += rawUniverse.shards.length;
    if (totalShards > BACKSTAGE_NOTION_PARTITION_MAX_TOTAL_SHARDS) {
      return invalidConfiguration('invalid_shape');
    }

    const shards: BackstageNotionPartitionDefinition[] = [];
    const seenShardKeys = new Set<string>();
    const seenRootPageIds = new Set<string>();
    for (const rawShard of rawUniverse.shards) {
      if (
        !isPlainObject(rawShard)
        || !hasClosedShape(rawShard, SHARD_KEYS, REQUIRED_SHARD_KEYS)
        || !isBackstageNotionShardKey(rawShard.shardKey)
        || seenShardKeys.has(rawShard.shardKey)
        || typeof rawShard.rootPageId !== 'string'
        || rawShard.rootPageId !== rawShard.rootPageId.trim()
        || typeof rawShard.displayName !== 'string'
        || !isValidDisplayName(rawShard.displayName)
        || !['hot', 'cold', 'archive'].includes(String(rawShard.retrievalTier))
        || typeof rawShard.required !== 'boolean'
        || (
          rawShard.retrievalTier === 'archive'
          && rawShard.required === true
        )
      ) {
        return invalidConfiguration('invalid_shape');
      }
      const rootPageId = normalizeNotionPageId(rawShard.rootPageId);
      const scopeTags = parseTags(rawShard.scopeTags);
      const categoryTags = parseTags(rawShard.categoryTags);
      const capacity = parseCapacity(rawShard.capacity);
      if (
        !rootPageId
        || seenRootPageIds.has(rootPageId)
        || scopeTags === null
        || categoryTags === null
        || capacity === null
      ) {
        return invalidConfiguration('invalid_shape');
      }
      seenShardKeys.add(rawShard.shardKey);
      seenRootPageIds.add(rootPageId);
      shards.push(Object.freeze({
        universeId: rawUniverse.universeId,
        shardKey: rawShard.shardKey,
        rootPageId,
        displayName: rawShard.displayName,
        retrievalTier: rawShard.retrievalTier as BackstageNotionRetrievalTier,
        required: rawShard.required,
        scopeTags,
        categoryTags,
        capacity,
      }));
    }
    shards.sort((left, right) => compareCanonicalText(left.shardKey, right.shardKey));
    universes.push(Object.freeze({
      universeId: rawUniverse.universeId,
      shards: Object.freeze(shards),
    }));
  }

  universes.sort((left, right) => compareCanonicalText(
    left.universeId,
    right.universeId
  ));
  const canonicalUniverses = Object.freeze(universes);
  return Object.freeze({
    status: 'valid' as const,
    version: BACKSTAGE_NOTION_PARTITION_CONFIGURATION_VERSION,
    generation: parsed.generation,
    semanticDigest: semanticDigest(canonicalUniverses),
    universes: canonicalUniverses,
  });
}

/** Resolve one exact universe without weakening configuration validity. */
export function resolveBackstageNotionPartitionUniverse(
  configuration: BackstageNotionPartitionConfiguration,
  universeId: string
): BackstageNotionPartitionUniverse | null {
  if (
    configuration.status !== 'valid'
    || universeId !== universeId.trim()
    || !BACKSTAGE_UNIVERSE_ID_PATTERN.test(universeId)
  ) {
    return null;
  }
  return configuration.universes.find(universe => universe.universeId === universeId)
    ?? null;
}

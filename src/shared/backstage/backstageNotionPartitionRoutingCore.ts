import { createHash } from 'node:crypto';

import {
  BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE,
  BACKSTAGE_NOTION_PARTITION_MAX_TAGS_PER_KIND,
  type BackstageNotionRetrievalTier,
} from './backstageNotionPartitionCore.js';

export const BACKSTAGE_NOTION_PARTITION_ROUTING_VERSION = 1;
export const BACKSTAGE_NOTION_PARTITION_ROUTING_MAX_SELECTORS = 32;

const ROUTING_DIGEST_FORMAT = 'backstage-notion-partition-routing-resolution-v1';
const UNIVERSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHARD_KEY_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/u;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,63}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GENERATION_PATTERN = /^[1-9][0-9]{0,18}$/u;
const SAFE_REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const FORBIDDEN_IDENTITY_VALUES = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
const TIER_ORDER: Readonly<Record<BackstageNotionRetrievalTier, number>> = {
  hot: 0,
  cold: 1,
  archive: 2,
};

export type BackstageNotionPartitionRoutingCardinality =
  | 'exactly_one'
  | 'all_matching';

export interface BackstageNotionPartitionRoutingSelector {
  readonly allScopeTags: readonly string[];
  readonly allCategoryTags: readonly string[];
}

export type BackstageNotionPartitionRoutingIntent =
  | Readonly<{
      kind: 'relevant';
      cardinality: BackstageNotionPartitionRoutingCardinality;
      allowedTiers: readonly BackstageNotionRetrievalTier[];
      explicitArchive: boolean;
      selectors: readonly BackstageNotionPartitionRoutingSelector[];
    }>
  | Readonly<{
      kind: 'complete_all';
      cardinality: 'all_matching';
    }>
  | Readonly<{
      kind: 'resolved_scope';
      cardinality: 'exactly_one';
      shardKey: string;
    }>;

export type BackstageNotionPartitionCutoverValidationCaseKind =
  | 'exact_scope'
  | 'relevant'
  | 'complete_scope';

/**
 * Keep sampled relevant cutover validation unscoped while requiring an exact
 * scope for exhaustive validation cases.
 */
export function isBackstageNotionPartitionCutoverValidationScopeCompatible(
  kind: BackstageNotionPartitionCutoverValidationCaseKind,
  hasScope: boolean
): boolean {
  return kind === 'relevant' ? !hasScope : hasScope;
}

export interface BackstageNotionPartitionRoutingMemberState {
  readonly shardKey: string;
  readonly partitionVersionId: string;
  readonly snapshotId: string;
  readonly retrievalTier: BackstageNotionRetrievalTier;
  readonly required: boolean;
  readonly decision: 'fresh' | 'retained_last_known_good';
  readonly verifiedAt: Date | string;
  readonly scopeTags: readonly string[];
  readonly categoryTags: readonly string[];
}

export interface BackstageNotionPartitionRoutingOmissionState {
  readonly shardKey: string;
  readonly partitionVersionId: string;
  readonly retrievalTier: BackstageNotionRetrievalTier;
  readonly required: false;
  readonly decision: 'optional_unavailable' | 'optional_disabled';
  readonly safeReasonCode: string;
  readonly scopeTags: readonly string[];
  readonly categoryTags: readonly string[];
}

export interface BackstageNotionPartitionRoutingState {
  readonly universeId: string;
  readonly manifestId: string;
  readonly manifestGeneration: string;
  readonly configurationVersionId: string;
  readonly configurationHash: string;
  readonly configurationCurrent: boolean;
  readonly embeddingModel: string;
  readonly embeddingVersion: number;
  readonly embeddingDimension: number;
  readonly indexFormatVersion: number;
  readonly members: readonly BackstageNotionPartitionRoutingMemberState[];
  readonly omissions: readonly BackstageNotionPartitionRoutingOmissionState[];
}

export interface BackstageNotionPartitionResolvedShard {
  readonly shardKey: string;
  readonly partitionVersionId: string;
  readonly snapshotId: string;
  readonly retrievalTier: BackstageNotionRetrievalTier;
  readonly required: boolean;
  readonly decision: 'fresh' | 'retained_last_known_good';
  readonly verifiedAt: string;
}

export interface BackstageNotionPartitionMatchedOmission {
  readonly shardKey: string;
  readonly partitionVersionId: string;
  readonly retrievalTier: BackstageNotionRetrievalTier;
  readonly decision: 'optional_unavailable' | 'optional_disabled';
  readonly safeReasonCode: string;
}

interface BackstageNotionPartitionRoutingResolutionBase {
  readonly routingVersion: typeof BACKSTAGE_NOTION_PARTITION_ROUTING_VERSION;
  readonly universeId: string;
  readonly manifestId: string;
  readonly manifestGeneration: string;
  readonly configurationVersionId: string;
  readonly configurationHash: string;
  readonly configurationCurrent: boolean;
  readonly embeddingModel: string;
  readonly embeddingVersion: number;
  readonly embeddingDimension: number;
  readonly indexFormatVersion: number;
  readonly intent: BackstageNotionPartitionRoutingIntent;
  readonly resolutionDigest: string;
}

export type BackstageNotionPartitionRoutingResolution =
  | (BackstageNotionPartitionRoutingResolutionBase & Readonly<{
      status: 'resolved';
      cardinality: BackstageNotionPartitionRoutingCardinality;
      complete: boolean;
      shards: readonly BackstageNotionPartitionResolvedShard[];
      matchingOmissions: readonly BackstageNotionPartitionMatchedOmission[];
    }>)
  | (BackstageNotionPartitionRoutingResolutionBase & Readonly<{
      status: 'not_found';
      cardinality: BackstageNotionPartitionRoutingCardinality;
      availableMatchCount: 0;
      omittedMatchCount: 0;
    }>)
  | (BackstageNotionPartitionRoutingResolutionBase & Readonly<{
      status: 'ambiguous';
      cardinality: 'exactly_one';
      availableMatchCount: number;
      omittedMatchCount: number;
    }>)
  | (BackstageNotionPartitionRoutingResolutionBase & Readonly<{
      status: 'indeterminate';
      cardinality: BackstageNotionPartitionRoutingCardinality;
      availableMatchCount: number;
      matchingOmissions: readonly BackstageNotionPartitionMatchedOmission[];
    }>);

interface NormalizedRoutingMember extends BackstageNotionPartitionResolvedShard {
  readonly scopeTags: readonly string[];
  readonly categoryTags: readonly string[];
}

interface NormalizedRoutingOmission extends BackstageNotionPartitionMatchedOmission {
  readonly required: false;
  readonly scopeTags: readonly string[];
  readonly categoryTags: readonly string[];
}

interface NormalizedRoutingState extends Omit<
  BackstageNotionPartitionRoutingState,
  'members' | 'omissions'
> {
  readonly members: readonly NormalizedRoutingMember[];
  readonly omissions: readonly NormalizedRoutingOmission[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireClosedRecord(
  value: unknown,
  label: string,
  keys: readonly string[]
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be a plain closed object.`);
  }
  const expected = new Set(keys);
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== expected.size
    || actualKeys.some(key => typeof key !== 'string' || !expected.has(key))
  ) {
    throw new Error(`${label} contains missing or unknown fields.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}.${key} must be an inert data property.`);
    }
  }
  return value;
}

function requirePattern(
  value: unknown,
  label: string,
  pattern: RegExp
): string {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || !pattern.test(value)
    || FORBIDDEN_IDENTITY_VALUES.has(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireUuid(value: unknown, label: string): string {
  return requirePattern(value, label, UUID_PATTERN).toLowerCase();
}

function requireInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(`${label} is outside its supported range.`);
  }
  return value;
}

function requireBoundedDataArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): readonly unknown[] {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum
    || value.length > maximum
  ) {
    throw new Error(`${label} exceeds its bounded array contract.`);
  }
  const allowedKeys = new Set<PropertyKey>(['length']);
  for (let index = 0; index < value.length; index += 1) {
    allowedKeys.add(String(index));
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an inert data property.`);
    }
  }
  if (Reflect.ownKeys(value).some(key => !allowedKeys.has(key))) {
    throw new Error(`${label} contains unknown array fields.`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  if (!(value instanceof Date) && typeof value !== 'string') {
    throw new Error(`${label} must be a finite timestamp.`);
  }
  const timestamp = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`${label} must be a finite timestamp.`);
  }
  return timestamp.toISOString();
}

function requireTier(value: unknown, label: string): BackstageNotionRetrievalTier {
  if (value !== 'hot' && value !== 'cold' && value !== 'archive') {
    throw new Error(`${label} is not a supported retrieval tier.`);
  }
  return value;
}

function normalizeTags(value: unknown, label: string): readonly string[] {
  const rawTags = requireBoundedDataArray(
    value,
    label,
    0,
    BACKSTAGE_NOTION_PARTITION_MAX_TAGS_PER_KIND
  );
  const tags = rawTags.map((tag, index) => requirePattern(
    tag,
    `${label}[${index}]`,
    TAG_PATTERN
  ));
  if (new Set(tags).size !== tags.length) {
    throw new Error(`${label} contains duplicate tags.`);
  }
  return Object.freeze([...tags].sort(compareText));
}

function normalizeSelector(
  value: unknown,
  index: number
): BackstageNotionPartitionRoutingSelector {
  const label = `intent.selectors[${index}]`;
  const record = requireClosedRecord(
    value,
    label,
    ['allScopeTags', 'allCategoryTags']
  );
  return Object.freeze({
    allScopeTags: normalizeTags(record.allScopeTags, `${label}.allScopeTags`),
    allCategoryTags: normalizeTags(
      record.allCategoryTags,
      `${label}.allCategoryTags`
    ),
  });
}

function selectorKey(selector: BackstageNotionPartitionRoutingSelector): string {
  return JSON.stringify([selector.allScopeTags, selector.allCategoryTags]);
}

export function normalizeBackstageNotionPartitionRoutingIntent(
  value: unknown
): BackstageNotionPartitionRoutingIntent {
  if (!isPlainRecord(value)) {
    throw new Error('intent must be a plain closed object.');
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  if (!kindDescriptor || !Object.hasOwn(kindDescriptor, 'value')) {
    throw new Error('intent.kind must be an inert data property.');
  }
  const kind = kindDescriptor.value;
  if (kind === 'complete_all') {
    const record = requireClosedRecord(
      value,
      'intent',
      ['kind', 'cardinality']
    );
    if (record.cardinality !== 'all_matching') {
      throw new Error('complete_all intent requires all_matching cardinality.');
    }
    return Object.freeze({ kind, cardinality: 'all_matching' as const });
  }
  if (kind === 'resolved_scope') {
    const record = requireClosedRecord(
      value,
      'intent',
      ['kind', 'cardinality', 'shardKey']
    );
    if (record.cardinality !== 'exactly_one') {
      throw new Error('resolved_scope intent requires exactly_one cardinality.');
    }
    return Object.freeze({
      kind,
      cardinality: 'exactly_one' as const,
      shardKey: requirePattern(record.shardKey, 'intent.shardKey', SHARD_KEY_PATTERN),
    });
  }
  if (kind !== 'relevant') {
    throw new Error('intent.kind is unsupported.');
  }
  const record = requireClosedRecord(
    value,
    'intent',
    ['kind', 'cardinality', 'allowedTiers', 'explicitArchive', 'selectors']
  );
  if (
    record.cardinality !== 'exactly_one'
    && record.cardinality !== 'all_matching'
  ) {
    throw new Error('intent.cardinality is unsupported.');
  }
  const rawAllowedTiers = requireBoundedDataArray(
    record.allowedTiers,
    'intent.allowedTiers',
    1,
    3
  );
  const allowedTiers = rawAllowedTiers.map((tier, index) => requireTier(
    tier,
    `intent.allowedTiers[${index}]`
  ));
  if (new Set(allowedTiers).size !== allowedTiers.length) {
    throw new Error('intent.allowedTiers contains duplicate tiers.');
  }
  if (typeof record.explicitArchive !== 'boolean') {
    throw new Error('intent.explicitArchive must be boolean.');
  }
  const includesArchive = allowedTiers.includes('archive');
  if (includesArchive !== record.explicitArchive) {
    throw new Error('Archive routing requires one exact explicit opt-in.');
  }
  const rawSelectors = requireBoundedDataArray(
    record.selectors,
    'intent.selectors',
    1,
    BACKSTAGE_NOTION_PARTITION_ROUTING_MAX_SELECTORS
  );
  const selectors = rawSelectors.map(normalizeSelector)
    .sort((left, right) => compareText(selectorKey(left), selectorKey(right)));
  const selectorKeys = selectors.map(selectorKey);
  if (new Set(selectorKeys).size !== selectorKeys.length) {
    throw new Error('intent.selectors contains duplicate selectors.');
  }
  const emptySelectors = selectors.filter(selector => (
    selector.allScopeTags.length === 0
    && selector.allCategoryTags.length === 0
  ));
  if (emptySelectors.length > 0 && selectors.length !== 1) {
    throw new Error('An empty default selector cannot be combined with narrower selectors.');
  }
  return Object.freeze({
    kind,
    cardinality: record.cardinality,
    allowedTiers: Object.freeze([...allowedTiers].sort((left, right) => (
      TIER_ORDER[left] - TIER_ORDER[right]
    ))),
    explicitArchive: record.explicitArchive,
    selectors: Object.freeze(selectors),
  });
}

function normalizeMember(
  value: unknown,
  index: number
): NormalizedRoutingMember {
  const label = `state.members[${index}]`;
  const record = requireClosedRecord(value, label, [
    'shardKey',
    'partitionVersionId',
    'snapshotId',
    'retrievalTier',
    'required',
    'decision',
    'verifiedAt',
    'scopeTags',
    'categoryTags',
  ]);
  if (typeof record.required !== 'boolean') {
    throw new Error(`${label}.required must be boolean.`);
  }
  if (record.decision !== 'fresh' && record.decision !== 'retained_last_known_good') {
    throw new Error(`${label}.decision is unsupported.`);
  }
  return Object.freeze({
    shardKey: requirePattern(record.shardKey, `${label}.shardKey`, SHARD_KEY_PATTERN),
    partitionVersionId: requireUuid(
      record.partitionVersionId,
      `${label}.partitionVersionId`
    ),
    snapshotId: requireUuid(record.snapshotId, `${label}.snapshotId`),
    retrievalTier: requireTier(record.retrievalTier, `${label}.retrievalTier`),
    required: record.required,
    decision: record.decision,
    verifiedAt: requireTimestamp(record.verifiedAt, `${label}.verifiedAt`),
    scopeTags: normalizeTags(record.scopeTags, `${label}.scopeTags`),
    categoryTags: normalizeTags(record.categoryTags, `${label}.categoryTags`),
  });
}

function normalizeOmission(
  value: unknown,
  index: number
): NormalizedRoutingOmission {
  const label = `state.omissions[${index}]`;
  const record = requireClosedRecord(value, label, [
    'shardKey',
    'partitionVersionId',
    'retrievalTier',
    'required',
    'decision',
    'safeReasonCode',
    'scopeTags',
    'categoryTags',
  ]);
  if (record.required !== false) {
    throw new Error(`${label}.required must be false.`);
  }
  if (
    record.decision !== 'optional_unavailable'
    && record.decision !== 'optional_disabled'
  ) {
    throw new Error(`${label}.decision is unsupported.`);
  }
  return Object.freeze({
    shardKey: requirePattern(record.shardKey, `${label}.shardKey`, SHARD_KEY_PATTERN),
    partitionVersionId: requireUuid(
      record.partitionVersionId,
      `${label}.partitionVersionId`
    ),
    retrievalTier: requireTier(record.retrievalTier, `${label}.retrievalTier`),
    required: false,
    decision: record.decision,
    safeReasonCode: requirePattern(
      record.safeReasonCode,
      `${label}.safeReasonCode`,
      SAFE_REASON_CODE_PATTERN
    ),
    scopeTags: normalizeTags(record.scopeTags, `${label}.scopeTags`),
    categoryTags: normalizeTags(record.categoryTags, `${label}.categoryTags`),
  });
}

function normalizeState(value: unknown): NormalizedRoutingState {
  const record = requireClosedRecord(value, 'state', [
    'universeId',
    'manifestId',
    'manifestGeneration',
    'configurationVersionId',
    'configurationHash',
    'configurationCurrent',
    'embeddingModel',
    'embeddingVersion',
    'embeddingDimension',
    'indexFormatVersion',
    'members',
    'omissions',
  ]);
  if (typeof record.configurationCurrent !== 'boolean') {
    throw new Error('state.configurationCurrent must be boolean.');
  }
  if (
    typeof record.embeddingModel !== 'string'
    || record.embeddingModel !== record.embeddingModel.trim()
    || record.embeddingModel.length < 1
    || record.embeddingModel.length > 200
  ) {
    throw new Error('state.embeddingModel is invalid.');
  }
  const rawMembers = requireBoundedDataArray(
    record.members,
    'state.members',
    1,
    BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
  );
  const rawOmissions = requireBoundedDataArray(
    record.omissions,
    'state.omissions',
    0,
    BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
  );
  if (
    rawMembers.length + rawOmissions.length
      > BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
  ) {
    throw new Error('state member and omission counts exceed the manifest bound.');
  }
  const members = rawMembers.map(normalizeMember)
    .sort((left, right) => compareText(left.shardKey, right.shardKey));
  const omissions = rawOmissions.map(normalizeOmission)
    .sort((left, right) => compareText(left.shardKey, right.shardKey));
  const shardKeys = [...members, ...omissions].map(item => item.shardKey);
  if (new Set(shardKeys).size !== shardKeys.length) {
    throw new Error('state contains duplicate shard identities.');
  }
  return Object.freeze({
    universeId: requirePattern(record.universeId, 'state.universeId', UNIVERSE_ID_PATTERN),
    manifestId: requireUuid(record.manifestId, 'state.manifestId'),
    manifestGeneration: requirePattern(
      record.manifestGeneration,
      'state.manifestGeneration',
      GENERATION_PATTERN
    ),
    configurationVersionId: requireUuid(
      record.configurationVersionId,
      'state.configurationVersionId'
    ),
    configurationHash: requirePattern(
      record.configurationHash,
      'state.configurationHash',
      SHA256_PATTERN
    ),
    configurationCurrent: record.configurationCurrent,
    embeddingModel: record.embeddingModel,
    embeddingVersion: requireInteger(
      record.embeddingVersion,
      'state.embeddingVersion',
      1
    ),
    embeddingDimension: requireInteger(
      record.embeddingDimension,
      'state.embeddingDimension',
      1,
      8_192
    ),
    indexFormatVersion: requireInteger(
      record.indexFormatVersion,
      'state.indexFormatVersion',
      1
    ),
    members: Object.freeze(members),
    omissions: Object.freeze(omissions),
  });
}

function matchesSelector(
  item: Pick<NormalizedRoutingMember, 'scopeTags' | 'categoryTags'>,
  selector: BackstageNotionPartitionRoutingSelector
): boolean {
  const scopeTags = new Set(item.scopeTags);
  const categoryTags = new Set(item.categoryTags);
  return selector.allScopeTags.every(tag => scopeTags.has(tag))
    && selector.allCategoryTags.every(tag => categoryTags.has(tag));
}

function selectMatches(
  state: NormalizedRoutingState,
  intent: BackstageNotionPartitionRoutingIntent
): {
  members: readonly NormalizedRoutingMember[];
  omissions: readonly NormalizedRoutingOmission[];
} {
  if (intent.kind === 'complete_all') {
    return { members: state.members, omissions: state.omissions };
  }
  if (intent.kind === 'resolved_scope') {
    return {
      members: state.members.filter(member => member.shardKey === intent.shardKey),
      omissions: state.omissions.filter(omission => omission.shardKey === intent.shardKey),
    };
  }
  const allowedTiers = new Set(intent.allowedTiers);
  const matches = (
    item: Pick<NormalizedRoutingMember, 'retrievalTier' | 'scopeTags' | 'categoryTags'>
  ) => allowedTiers.has(item.retrievalTier)
    && intent.selectors.some(selector => matchesSelector(item, selector));
  return {
    members: state.members.filter(matches),
    omissions: state.omissions.filter(matches),
  };
}

function projectShard(member: NormalizedRoutingMember): BackstageNotionPartitionResolvedShard {
  return Object.freeze({
    shardKey: member.shardKey,
    partitionVersionId: member.partitionVersionId,
    snapshotId: member.snapshotId,
    retrievalTier: member.retrievalTier,
    required: member.required,
    decision: member.decision,
    verifiedAt: member.verifiedAt,
  });
}

function projectOmission(
  omission: NormalizedRoutingOmission
): BackstageNotionPartitionMatchedOmission {
  return Object.freeze({
    shardKey: omission.shardKey,
    partitionVersionId: omission.partitionVersionId,
    retrievalTier: omission.retrievalTier,
    decision: omission.decision,
    safeReasonCode: omission.safeReasonCode,
  });
}

function resolutionDigest(input: {
  readonly state: NormalizedRoutingState;
  readonly intent: BackstageNotionPartitionRoutingIntent;
  readonly status: BackstageNotionPartitionRoutingResolution['status'];
  readonly members: readonly NormalizedRoutingMember[];
  readonly omissions: readonly NormalizedRoutingOmission[];
}): string {
  return createHash('sha256').update(JSON.stringify({
    format: ROUTING_DIGEST_FORMAT,
    version: BACKSTAGE_NOTION_PARTITION_ROUTING_VERSION,
    universeId: input.state.universeId,
    manifestId: input.state.manifestId,
    manifestGeneration: input.state.manifestGeneration,
    configurationVersionId: input.state.configurationVersionId,
    configurationHash: input.state.configurationHash,
    embeddingModel: input.state.embeddingModel,
    embeddingVersion: input.state.embeddingVersion,
    embeddingDimension: input.state.embeddingDimension,
    indexFormatVersion: input.state.indexFormatVersion,
    intent: input.intent,
    status: input.status,
    members: input.members.map(member => ({
      shardKey: member.shardKey,
      partitionVersionId: member.partitionVersionId,
      snapshotId: member.snapshotId,
      retrievalTier: member.retrievalTier,
      required: member.required,
      decision: member.decision,
      verifiedAt: member.verifiedAt,
    })),
    omissions: input.omissions.map(omission => ({
      shardKey: omission.shardKey,
      partitionVersionId: omission.partitionVersionId,
      retrievalTier: omission.retrievalTier,
      decision: omission.decision,
      safeReasonCode: omission.safeReasonCode,
    })),
  }), 'utf8').digest('hex');
}

/**
 * Resolve a closed server-derived intent against one already pinned immutable
 * manifest routing state. This function performs no database or query-text work.
 */
export function resolveBackstageNotionPartitionRouting(
  stateInput: unknown,
  intentInput: unknown
): BackstageNotionPartitionRoutingResolution {
  const state = normalizeState(stateInput);
  const intent = normalizeBackstageNotionPartitionRoutingIntent(intentInput);
  const matches = selectMatches(state, intent);
  const cardinality = intent.cardinality;
  const mustBeExhaustive = intent.kind === 'complete_all';
  let status: BackstageNotionPartitionRoutingResolution['status'];
  if (cardinality === 'exactly_one') {
    status = matches.members.length > 1
      ? 'ambiguous'
      : matches.omissions.length > 0
        ? 'indeterminate'
        : matches.members.length === 1
          ? 'resolved'
          : 'not_found';
  } else if (mustBeExhaustive && matches.omissions.length > 0) {
    status = 'indeterminate';
  } else if (matches.members.length > 0) {
    status = 'resolved';
  } else {
    status = matches.omissions.length > 0 ? 'indeterminate' : 'not_found';
  }
  const base = Object.freeze({
    routingVersion: BACKSTAGE_NOTION_PARTITION_ROUTING_VERSION,
    universeId: state.universeId,
    manifestId: state.manifestId,
    manifestGeneration: state.manifestGeneration,
    configurationVersionId: state.configurationVersionId,
    configurationHash: state.configurationHash,
    configurationCurrent: state.configurationCurrent,
    embeddingModel: state.embeddingModel,
    embeddingVersion: state.embeddingVersion,
    embeddingDimension: state.embeddingDimension,
    indexFormatVersion: state.indexFormatVersion,
    intent,
    resolutionDigest: resolutionDigest({
      state,
      intent,
      status,
      members: matches.members,
      omissions: matches.omissions,
    }),
  });
  if (status === 'resolved') {
    return Object.freeze({
      ...base,
      status,
      cardinality,
      complete: matches.omissions.length === 0,
      shards: Object.freeze(matches.members.map(projectShard)),
      matchingOmissions: Object.freeze(matches.omissions.map(projectOmission)),
    });
  }
  if (status === 'ambiguous') {
    return Object.freeze({
      ...base,
      status,
      cardinality: 'exactly_one' as const,
      availableMatchCount: matches.members.length,
      omittedMatchCount: matches.omissions.length,
    });
  }
  if (status === 'indeterminate') {
    return Object.freeze({
      ...base,
      status,
      cardinality,
      availableMatchCount: matches.members.length,
      matchingOmissions: Object.freeze(matches.omissions.map(projectOmission)),
    });
  }
  return Object.freeze({
    ...base,
    status,
    cardinality,
    availableMatchCount: 0 as const,
    omittedMatchCount: 0 as const,
  });
}

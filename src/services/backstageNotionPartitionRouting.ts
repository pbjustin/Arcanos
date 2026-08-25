import {
  BACKSTAGE_NOTION_PARTITION_SCOPE_LOOKUP_MAX_PATH_SEGMENTS,
  getBackstageNotionPartitionRepository,
  type BackstageNotionActiveManifestRoutingState,
  type BackstageNotionManifestScopeOwnerLookup,
  type BackstageNotionManifestScopeOwnerResolution,
  type PostgresBackstageNotionPartitionRepository,
} from '@core/db/repositories/backstageNotionPartitionRepository.js';
import { getEnvNumber } from '@platform/runtime/env.js';
import {
  normalizeBackstageNotionPartitionRoutingIntent,
  resolveBackstageNotionPartitionRouting,
  type BackstageNotionPartitionRoutingIntent,
  type BackstageNotionPartitionRoutingResolution,
} from '@shared/backstage/backstageNotionPartitionRoutingCore.js';
import {
  resolveEffectiveBackstageNotionAuthorityRoot,
  type BackstageNotionAuthorityRoot,
} from './backstageNotionAuthority.js';

export const BACKSTAGE_NOTION_PARTITION_ROUTING_DEFAULT_STALENESS_MS =
  24 * 60 * 60 * 1_000;
export const BACKSTAGE_NOTION_PARTITION_ROUTING_MIN_STALENESS_MS =
  5 * 60 * 1_000;
export const BACKSTAGE_NOTION_PARTITION_ROUTING_MAX_STALENESS_MS =
  7 * 24 * 60 * 60 * 1_000;
export const BACKSTAGE_NOTION_PARTITION_ROUTING_MAX_FUTURE_SKEW_MS =
  5 * 60 * 1_000;
export const BACKSTAGE_NOTION_PARTITION_ROUTING_STALENESS_ENV_NAME =
  'ARCANOS_BACKSTAGE_NOTION_RAG_MAX_STALENESS_MS';
export const BACKSTAGE_NOTION_PARTITION_ROUTING_UNAVAILABLE_CODE =
  'BACKSTAGE_NOTION_PARTITION_ROUTING_UNAVAILABLE';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

type PartitionRoutingRepository = Pick<
  PostgresBackstageNotionPartitionRepository,
  | 'loadActiveManifestRoutingState'
  | 'loadManifestRoutingState'
  | 'resolveManifestScopeOwner'
>;

export interface BackstageNotionPartitionRoutingDependencies {
  readonly repository?: PartitionRoutingRepository;
  readonly now?: () => Date;
  readonly maximumStalenessMs?: number;
  readonly readMaximumStalenessMs?: () => number | undefined;
  readonly resolveAuthorityRoot?: (
    universeId: string
  ) => BackstageNotionAuthorityRoot | null
    | Promise<BackstageNotionAuthorityRoot | null>;
}

export class BackstageNotionPartitionRoutingUnavailableError extends Error {
  readonly code = BACKSTAGE_NOTION_PARTITION_ROUTING_UNAVAILABLE_CODE;

  constructor() {
    super('The partitioned Backstage Notion routing generation is unavailable.');
    this.name = 'BackstageNotionPartitionRoutingUnavailableError';
  }
}

export type BackstageNotionPartitionScopeRoutingResolution =
  | Readonly<{ status: 'not_found' | 'ambiguous' }>
  | Readonly<{
      status: 'resolved';
      owner: Extract<
        BackstageNotionManifestScopeOwnerResolution,
        { status: 'resolved' }
      >;
      routing: Extract<
        BackstageNotionPartitionRoutingResolution,
        { status: 'resolved' }
      >;
    }>;

function maximumStalenessMs(
  value: number | undefined,
  readConfiguredValue: () => number | undefined
): number {
  const candidate = value
    ?? readConfiguredValue()
    ?? BACKSTAGE_NOTION_PARTITION_ROUTING_DEFAULT_STALENESS_MS;
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return BACKSTAGE_NOTION_PARTITION_ROUTING_DEFAULT_STALENESS_MS;
  }
  return Math.max(
    BACKSTAGE_NOTION_PARTITION_ROUTING_MIN_STALENESS_MS,
    Math.min(
      BACKSTAGE_NOTION_PARTITION_ROUTING_MAX_STALENESS_MS,
      Math.trunc(candidate)
    )
  );
}

function normalizeScopeLookup(
  value: unknown
): BackstageNotionManifestScopeOwnerLookup {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new Error('lookup must be a plain closed object.');
  }
  const requiredKeys = new Set(['pageTitleKey', 'pagePathKey', 'scopeKind']);
  const allowedKeys = new Set([...requiredKeys, 'sectionPathKey']);
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length < requiredKeys.size
    || actualKeys.length > allowedKeys.size
    || actualKeys.some(key => (
      typeof key !== 'string'
      || !allowedKeys.has(key)
    ))
    || [...requiredKeys].some(key => !actualKeys.includes(key))
  ) {
    throw new Error('lookup contains missing or unknown fields.');
  }
  const record: Record<string, unknown> = {};
  for (const key of actualKeys) {
    if (typeof key !== 'string') {
      throw new Error('lookup contains missing or unknown fields.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`lookup.${key} must be an inert data property.`);
    }
    record[key] = descriptor.value;
  }
  if (
    typeof record.pageTitleKey !== 'string'
    || !SHA256_PATTERN.test(record.pageTitleKey)
  ) {
    throw new Error('lookup.pageTitleKey is invalid.');
  }
  if (record.scopeKind !== 'page' && record.scopeKind !== 'subtree') {
    throw new Error('lookup.scopeKind is invalid.');
  }
  const normalizePath = (
    path: unknown,
    label: 'pagePathKey' | 'sectionPathKey',
    maximumSegments: number
  ): readonly string[] | null => {
    if (path === null) {
      return null;
    }
    if (
      !Array.isArray(path)
      || Object.getPrototypeOf(path) !== Array.prototype
      || path.length < 1
      || path.length > maximumSegments
    ) {
      throw new Error(`lookup.${label} exceeds its bounded array contract.`);
    }
    const arrayKeys = new Set<PropertyKey>(['length']);
    const normalized: string[] = [];
    for (let index = 0; index < path.length; index += 1) {
      arrayKeys.add(String(index));
      const descriptor = Object.getOwnPropertyDescriptor(path, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new Error(`lookup.${label}[${index}] must be an inert data property.`);
      }
      if (
        typeof descriptor.value !== 'string'
        || !SHA256_PATTERN.test(descriptor.value)
      ) {
        throw new Error(`lookup.${label}[${index}] is invalid.`);
      }
      normalized.push(descriptor.value);
    }
    if (Reflect.ownKeys(path).some(key => !arrayKeys.has(key))) {
      throw new Error(`lookup.${label} contains unknown array fields.`);
    }
    return Object.freeze(normalized);
  };
  const pagePathKey = normalizePath(
    record.pagePathKey,
    'pagePathKey',
    BACKSTAGE_NOTION_PARTITION_SCOPE_LOOKUP_MAX_PATH_SEGMENTS
  );
  const sectionPathSupplied = Object.hasOwn(record, 'sectionPathKey');
  const sectionPathKey = sectionPathSupplied
    ? normalizePath(record.sectionPathKey, 'sectionPathKey', 32)
    : undefined;
  if (record.scopeKind === 'subtree' && sectionPathKey !== undefined
    && sectionPathKey !== null) {
    throw new Error('lookup.sectionPathKey is unsupported for subtree scope.');
  }
  return Object.freeze({
    pageTitleKey: record.pageTitleKey,
    pagePathKey,
    ...(sectionPathSupplied ? { sectionPathKey: sectionPathKey ?? null } : {}),
    scopeKind: record.scopeKind,
  });
}

function routingCoreState(state: BackstageNotionActiveManifestRoutingState) {
  return Object.freeze({
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
    members: Object.freeze(state.members.map(member => Object.freeze({
      shardKey: member.shardKey,
      partitionVersionId: member.partitionVersionId,
      snapshotId: member.snapshotId,
      retrievalTier: member.retrievalTier,
      required: member.required,
      decision: member.decision,
      verifiedAt: member.verifiedAt,
      scopeTags: member.scopeTags,
      categoryTags: member.categoryTags,
    }))),
    omissions: Object.freeze(state.omissions.map(omission => Object.freeze({
      shardKey: omission.shardKey,
      partitionVersionId: omission.partitionVersionId,
      retrievalTier: omission.retrievalTier,
      required: false as const,
      decision: omission.decision,
      safeReasonCode: omission.safeReasonCode,
      scopeTags: omission.scopeTags,
      categoryTags: omission.categoryTags,
    }))),
  });
}

function validateSelectedFreshness(
  state: BackstageNotionActiveManifestRoutingState,
  resolution: BackstageNotionPartitionRoutingResolution,
  now: Date,
  stalenessMs: number
): void {
  const nowMs = now.getTime();
  if (
    !Number.isFinite(nowMs)
    || !Number.isFinite(state.manifestCreatedAt.getTime())
    || !Number.isFinite(state.manifestSealedAt.getTime())
    || state.manifestCreatedAt.getTime() > state.manifestSealedAt.getTime()
    || state.manifestSealedAt.getTime() - nowMs
      > BACKSTAGE_NOTION_PARTITION_ROUTING_MAX_FUTURE_SKEW_MS
  ) {
    throw new BackstageNotionPartitionRoutingUnavailableError();
  }
  if (resolution.status !== 'resolved') {
    return;
  }

  const memberByShard = new Map(state.members.map(member => [
    member.shardKey,
    member,
  ]));
  for (const selected of resolution.shards) {
    const member = memberByShard.get(selected.shardKey);
    if (
      !member
      || member.partitionVersionId !== selected.partitionVersionId
      || member.snapshotId !== selected.snapshotId
      || member.verifiedAt.toISOString() !== selected.verifiedAt
      || !Number.isFinite(member.verifiedAt.getTime())
      || !Number.isFinite(member.snapshotCreatedAt.getTime())
      || !Number.isFinite(member.snapshotSealedAt.getTime())
      || member.snapshotCreatedAt.getTime() > member.snapshotSealedAt.getTime()
      || member.snapshotSealedAt.getTime() > state.manifestSealedAt.getTime()
      || member.verifiedAt.getTime() > state.manifestSealedAt.getTime()
      || nowMs - member.verifiedAt.getTime() > stalenessMs
      || member.verifiedAt.getTime() - nowMs
        > BACKSTAGE_NOTION_PARTITION_ROUTING_MAX_FUTURE_SKEW_MS
    ) {
      throw new BackstageNotionPartitionRoutingUnavailableError();
    }
  }
}

async function loadRoutingState(
  universeId: string,
  repository: PartitionRoutingRepository
): Promise<BackstageNotionActiveManifestRoutingState> {
  try {
    const state = await repository.loadActiveManifestRoutingState(universeId);
    if (!state) {
      throw new BackstageNotionPartitionRoutingUnavailableError();
    }
    return state;
  } catch (error) {
    if (error instanceof BackstageNotionPartitionRoutingUnavailableError) {
      throw error;
    }
    throw new BackstageNotionPartitionRoutingUnavailableError();
  }
}

async function loadPinnedRoutingState(
  universeId: string,
  manifestId: string,
  repository: PartitionRoutingRepository
): Promise<BackstageNotionActiveManifestRoutingState> {
  try {
    const state = await repository.loadManifestRoutingState(
      universeId,
      manifestId
    );
    if (!state || state.manifestId !== manifestId) {
      throw new BackstageNotionPartitionRoutingUnavailableError();
    }
    return state;
  } catch (error) {
    if (error instanceof BackstageNotionPartitionRoutingUnavailableError) {
      throw error;
    }
    throw new BackstageNotionPartitionRoutingUnavailableError();
  }
}

function dependencies(
  overrides: BackstageNotionPartitionRoutingDependencies
): {
  readonly repository: PartitionRoutingRepository;
  readonly now: Date;
  readonly maximumStalenessMs: number;
  readonly resolveAuthorityRoot: (
    universeId: string
  ) => BackstageNotionAuthorityRoot | null
    | Promise<BackstageNotionAuthorityRoot | null>;
} {
  const now = overrides.now?.() ?? new Date();
  return Object.freeze({
    repository: overrides.repository ?? getBackstageNotionPartitionRepository(),
    now: new Date(now.getTime()),
    maximumStalenessMs: maximumStalenessMs(
      overrides.maximumStalenessMs,
      overrides.readMaximumStalenessMs ?? (() => getEnvNumber(
        BACKSTAGE_NOTION_PARTITION_ROUTING_STALENESS_ENV_NAME,
        BACKSTAGE_NOTION_PARTITION_ROUTING_DEFAULT_STALENESS_MS
      ))
    ),
    resolveAuthorityRoot: overrides.resolveAuthorityRoot
      ?? resolveEffectiveBackstageNotionAuthorityRoot,
  });
}

async function requireExactAuthority(
  universeId: string,
  resolveAuthorityRoot: (
    exactUniverseId: string
  ) => BackstageNotionAuthorityRoot | null
    | Promise<BackstageNotionAuthorityRoot | null>
): Promise<void> {
  let authorityRoot: BackstageNotionAuthorityRoot | null;
  try {
    authorityRoot = await resolveAuthorityRoot(universeId);
  } catch {
    throw new BackstageNotionPartitionRoutingUnavailableError();
  }
  if (!authorityRoot || authorityRoot.universeId !== universeId) {
    throw new BackstageNotionPartitionRoutingUnavailableError();
  }
}

function resolveRequestFromState(
  state: BackstageNotionActiveManifestRoutingState,
  intent: BackstageNotionPartitionRoutingIntent,
  now: Date,
  stalenessMs: number
): BackstageNotionPartitionRoutingResolution {
  let resolution: BackstageNotionPartitionRoutingResolution;
  try {
    resolution = resolveBackstageNotionPartitionRouting(
      routingCoreState(state),
      intent
    );
  } catch {
    throw new BackstageNotionPartitionRoutingUnavailableError();
  }
  validateSelectedFreshness(state, resolution, now, stalenessMs);
  return resolution;
}

async function resolveScopeFromState(
  universeId: string,
  state: BackstageNotionActiveManifestRoutingState,
  lookup: BackstageNotionManifestScopeOwnerLookup,
  repository: PartitionRoutingRepository,
  now: Date,
  stalenessMs: number
): Promise<BackstageNotionPartitionScopeRoutingResolution> {
  let owner: BackstageNotionManifestScopeOwnerResolution;
  try {
    owner = await repository.resolveManifestScopeOwner(
      universeId,
      state.manifestId,
      lookup
    );
  } catch {
    throw new BackstageNotionPartitionRoutingUnavailableError();
  }
  if (owner.status === 'invalid') {
    throw new BackstageNotionPartitionRoutingUnavailableError();
  }
  if (owner.status !== 'resolved') {
    return Object.freeze({ status: owner.status });
  }
  const routing = resolveRequestFromState(
    state,
    {
      kind: 'resolved_scope',
      cardinality: 'exactly_one',
      shardKey: owner.shardKey,
    },
    now,
    stalenessMs
  );
  if (
    routing.status !== 'resolved'
    || owner.manifestId !== state.manifestId
    || routing.shards.length !== 1
    || routing.shards[0]?.partitionVersionId !== owner.partitionVersionId
    || routing.shards[0]?.snapshotId !== owner.snapshotId
  ) {
    throw new BackstageNotionPartitionRoutingUnavailableError();
  }
  return Object.freeze({ status: 'resolved', owner, routing });
}

/**
 * Resolve one closed server-derived intent against the exact active immutable
 * manifest. Only selected members participate in freshness admission.
 */
export async function resolveBackstageNotionPartitionRequest(
  universeId: string,
  intentInput: unknown,
  overrides: BackstageNotionPartitionRoutingDependencies = {}
): Promise<BackstageNotionPartitionRoutingResolution> {
  const intent = normalizeBackstageNotionPartitionRoutingIntent(intentInput);
  const resolvedDependencies = dependencies(overrides);
  await requireExactAuthority(
    universeId,
    resolvedDependencies.resolveAuthorityRoot
  );
  const state = await loadRoutingState(
    universeId,
    resolvedDependencies.repository
  );
  return resolveRequestFromState(
    state,
    intent,
    resolvedDependencies.now,
    resolvedDependencies.maximumStalenessMs
  );
}

/** Resolve a closed intent against one exact sealed immutable manifest. */
export async function resolveBackstageNotionPartitionPinnedRequest(
  universeId: string,
  manifestId: string,
  intentInput: unknown,
  overrides: BackstageNotionPartitionRoutingDependencies = {}
): Promise<BackstageNotionPartitionRoutingResolution> {
  const intent = normalizeBackstageNotionPartitionRoutingIntent(intentInput);
  const resolvedDependencies = dependencies(overrides);
  await requireExactAuthority(
    universeId,
    resolvedDependencies.resolveAuthorityRoot
  );
  const state = await loadPinnedRoutingState(
    universeId,
    manifestId,
    resolvedDependencies.repository
  );
  return resolveRequestFromState(
    state,
    intent,
    resolvedDependencies.now,
    resolvedDependencies.maximumStalenessMs
  );
}

/** Resolve an exact page/subtree owner before selecting its one manifest shard. */
export async function resolveBackstageNotionPartitionScopeRequest(
  universeId: string,
  lookupInput: unknown,
  overrides: BackstageNotionPartitionRoutingDependencies = {}
): Promise<BackstageNotionPartitionScopeRoutingResolution> {
  const lookup = normalizeScopeLookup(lookupInput);
  const resolvedDependencies = dependencies(overrides);
  await requireExactAuthority(
    universeId,
    resolvedDependencies.resolveAuthorityRoot
  );
  const state = await loadRoutingState(
    universeId,
    resolvedDependencies.repository
  );
  return resolveScopeFromState(
    universeId,
    state,
    lookup,
    resolvedDependencies.repository,
    resolvedDependencies.now,
    resolvedDependencies.maximumStalenessMs
  );
}

/** Resolve an exact scope owner against one sealed immutable manifest. */
export async function resolveBackstageNotionPartitionPinnedScopeRequest(
  universeId: string,
  manifestId: string,
  lookupInput: unknown,
  overrides: BackstageNotionPartitionRoutingDependencies = {}
): Promise<BackstageNotionPartitionScopeRoutingResolution> {
  const lookup = normalizeScopeLookup(lookupInput);
  const resolvedDependencies = dependencies(overrides);
  await requireExactAuthority(
    universeId,
    resolvedDependencies.resolveAuthorityRoot
  );
  const state = await loadPinnedRoutingState(
    universeId,
    manifestId,
    resolvedDependencies.repository
  );
  return resolveScopeFromState(
    universeId,
    state,
    lookup,
    resolvedDependencies.repository,
    resolvedDependencies.now,
    resolvedDependencies.maximumStalenessMs
  );
}

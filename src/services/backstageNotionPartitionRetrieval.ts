import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';

import { isAbortError } from '@arcanos/runtime';
import {
  BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_MAX_RESULTS,
  getBackstageNotionPartitionRepository,
  type BackstageNotionManifestScopeChunk,
  type BackstageNotionManifestScopePageAfter,
  type BackstageNotionPartitionCandidateShard,
  type BackstageNotionPartitionExactScope,
  type BackstageNotionPartitionRankedCandidate,
  type PostgresBackstageNotionPartitionRepository,
} from '@core/db/repositories/backstageNotionPartitionRepository.js';
import { logger } from '@platform/logging/structuredLogging.js';
import {
  BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS,
  BACKSTAGE_NOTION_PARTITION_MAX_PAGES,
  BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE,
} from '@shared/backstage/backstageNotionPartitionCore.js';
import {
  normalizeBackstageNotionPartitionRoutingIntent,
  type BackstageNotionPartitionMatchedOmission,
  type BackstageNotionPartitionResolvedShard,
  type BackstageNotionPartitionRoutingIntent,
  type BackstageNotionPartitionRoutingResolution,
} from '@shared/backstage/backstageNotionPartitionRoutingCore.js';
import {
  BACKSTAGE_NOTION_RAG_CHUNK_FORMAT,
  buildBackstageNotionRagUntrustedContextPrompt,
  type BackstageNotionRagChunk,
} from '@shared/backstage/backstageNotionRagCore.js';
import {
  normalizeBackstageNotionScopeKey,
  normalizeBackstageNotionScopePath,
} from '@shared/backstage/backstageNotionScopeIndex.js';
import {
  isBackstageNotionEnrichmentAuthorized,
  markBackstageNotionEnrichmentUsed,
} from './backstageNotionEnrichmentAuthorization.js';
import {
  BackstageNotionCursorInvalidError,
  BackstageNotionIndexUnavailableError,
  BackstageNotionScopeResolutionError,
  BACKSTAGE_NOTION_RAG_MAX_CHUNKS_PER_PAGE,
  BACKSTAGE_NOTION_RAG_MAX_QUERY_CODE_POINTS,
  BACKSTAGE_NOTION_RAG_RETRIEVED_CHUNKS,
  isBackstageNotionCursorInvalidError,
  isBackstageNotionIndexUnavailableError,
  isBackstageNotionScopeResolutionError,
  type BackstageNotionRagCitation,
  type BackstageNotionRagCoverage,
  type BackstageNotionRagQuery,
  type BackstageNotionRagResolvedScope,
  type BackstageNotionRagRetrievalMode,
} from './backstageNotionRag.js';
import {
  resolveBackstageNotionPartitionPinnedRequest,
  resolveBackstageNotionPartitionPinnedScopeRequest,
  resolveBackstageNotionPartitionRequest,
  resolveBackstageNotionPartitionScopeRequest,
  type BackstageNotionPartitionScopeRoutingResolution,
} from './backstageNotionPartitionRouting.js';
import { createEmbedding } from './openai/embeddings.js';

export const BACKSTAGE_NOTION_PARTITION_RETRIEVAL_CURSOR_VERSION = 1;

const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHARD_KEY_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/u;
const CURSOR_FORMAT = 'backstage-notion-partition-retrieval-cursor-v1';
const CURSOR_KEY_FORMAT = 'backstage-notion-partition-retrieval-cursor-key-v1';
const CURSOR_ENVELOPE_VERSION = 1;
const CURSOR_IV_BYTES = 12;
const CURSOR_TAG_BYTES = 16;
const SELECTION_DIGEST_FORMAT = 'backstage-notion-partition-retrieval-selection-v1';
const SCOPE_BINDING_FORMAT = 'backstage-notion-partition-retrieval-scope-v1';
const REQUEST_BINDING_FORMAT = 'backstage-notion-partition-retrieval-request-v1';
const MAX_SCOPE_CHUNKS = BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
  * BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS;
const MAX_SCOPE_PAGES = BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
  * BACKSTAGE_NOTION_PARTITION_MAX_PAGES;

type ResolvedRouting = Extract<
  BackstageNotionPartitionRoutingResolution,
  { status: 'resolved' }
>;

type PartitionRetrievalRepository = Pick<
  PostgresBackstageNotionPartitionRepository,
  'rankManifestShardCandidates' | 'loadManifestScopeChunkPage'
>;

interface PartitionScopeLookup {
  readonly pageTitleKey: string;
  readonly pagePathKey: readonly string[] | null;
  readonly sectionPathKey: readonly string[] | null;
  readonly scopeKind: 'page' | 'subtree';
}

export interface BackstageNotionPartitionRetrievalPlan {
  readonly query: BackstageNotionRagQuery;
  /** Closed server-derived routing only; never copy this field from a caller body. */
  readonly relevantRoutingIntent?: BackstageNotionPartitionRoutingIntent;
}

export interface BackstageNotionPartitionRetrievalDependencies {
  readonly repository?: PartitionRetrievalRepository;
  readonly resolveRequest?: (
    universeId: string,
    intent: BackstageNotionPartitionRoutingIntent
  ) => Promise<BackstageNotionPartitionRoutingResolution>;
  readonly resolveScopeRequest?: (
    universeId: string,
    lookup: PartitionScopeLookup
  ) => Promise<BackstageNotionPartitionScopeRoutingResolution>;
  readonly resolvePinnedRequest?: (
    universeId: string,
    manifestId: string,
    intent: BackstageNotionPartitionRoutingIntent
  ) => Promise<BackstageNotionPartitionRoutingResolution>;
  readonly resolvePinnedScopeRequest?: (
    universeId: string,
    manifestId: string,
    lookup: PartitionScopeLookup
  ) => Promise<BackstageNotionPartitionScopeRoutingResolution>;
  readonly embedQuery?: (query: string) => Promise<number[]>;
  /** Commit 10 supplies this server-only secret resolver at the serving boundary. */
  readonly resolveCursorEncryptionSecret?: () => string | undefined;
}

export interface BackstageNotionPartitionRetrievalShard
  extends BackstageNotionPartitionResolvedShard {}

export interface BackstageNotionPartitionRagCitation
  extends BackstageNotionRagCitation {
  readonly shardKey: string;
  readonly partitionVersionId: string;
  readonly snapshotId: string;
  readonly pageVersionId: string;
  readonly chunkVersionId: string;
  readonly canonicalUrl: string;
  readonly sourceLastEditedAt: string;
}

export interface BackstageNotionPartitionRagRetrieval {
  readonly universeId: string;
  readonly manifestId: string;
  readonly configurationVersionId: string;
  readonly configurationHash: string;
  readonly configurationCurrent: boolean;
  readonly selectionDigest: string;
  readonly routingComplete: boolean;
  readonly selectedShards: readonly BackstageNotionPartitionRetrievalShard[];
  readonly matchingOmissions: readonly BackstageNotionPartitionMatchedOmission[];
  readonly verifiedAt: Date;
  readonly prompt: string;
  readonly chunkCount: number;
  readonly truncated: boolean;
  readonly retrievalMode: BackstageNotionRagRetrievalMode;
  readonly resolvedScope: BackstageNotionRagResolvedScope | null;
  readonly coverage: BackstageNotionRagCoverage;
  readonly nextCursor: string | null;
  readonly citations: readonly BackstageNotionPartitionRagCitation[];
}

interface NormalizedPageScope {
  readonly pageTitle: string;
  readonly pagePath?: readonly string[];
  readonly sectionPath?: readonly string[];
  readonly scopeKind: 'page';
}

interface NormalizedSubtreeScope {
  readonly pageTitle: string;
  readonly pagePath?: readonly string[];
  readonly scopeKind: 'subtree';
}

type NormalizedScope = NormalizedPageScope | NormalizedSubtreeScope;

interface NormalizedQuery {
  readonly query: string;
  readonly bindingQuery: string;
  readonly retrievalMode: BackstageNotionRagRetrievalMode;
  readonly retrievalScope?: NormalizedScope;
  readonly bindingScope?: Readonly<{
    pageTitle: string;
    pagePath?: readonly string[];
    sectionPath?: readonly string[];
    scopeKind?: 'page' | 'subtree';
  }>;
  readonly cursor?: string;
}

interface CursorBody {
  readonly v: typeof BACKSTAGE_NOTION_PARTITION_RETRIEVAL_CURSOR_VERSION;
  readonly manifestId: string;
  readonly configurationVersionId: string;
  readonly configurationHash: string;
  readonly selectionDigest: string;
  readonly requestBinding: string;
  readonly scopeBinding: string;
  readonly scopeChunkCount: number;
  readonly scopePageCount: number;
  readonly after: BackstageNotionManifestScopePageAfter;
}

interface DecodedCursor {
  readonly after: BackstageNotionManifestScopePageAfter;
  readonly scopeChunkCount: number;
  readonly scopePageCount: number;
}

type RetrievalMaterial = BackstageNotionPartitionRankedCandidate
  | BackstageNotionManifestScopeChunk;

interface ProjectedMaterial {
  readonly material: RetrievalMaterial;
  readonly chunk: BackstageNotionRagChunk;
  readonly citation: BackstageNotionPartitionRagCitation;
  readonly after: BackstageNotionManifestScopePageAfter;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function frozenStringArray(value: readonly string[]): string[] {
  const copy = [...value];
  Object.freeze(copy);
  return copy;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function readClosedDataObject(
  value: unknown,
  requiredKeys: readonly string[],
  allowedKeys: readonly string[]
): Readonly<Record<string, unknown>> {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }
  const allowed = new Set(allowedKeys);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length < requiredKeys.length
    || actual.length > allowed.size
    || actual.some(key => typeof key !== 'string' || !allowed.has(key))
    || requiredKeys.some(key => !actual.includes(key))
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of actual) {
    if (typeof key !== 'string') {
      throw new BackstageNotionIndexUnavailableError();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new BackstageNotionIndexUnavailableError();
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function normalizeScopeSegment(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || codePointLength(value) > 500) {
    return null;
  }
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return normalized || null;
}

function normalizeScopePath(
  value: unknown,
  maximumSegments: number
): Readonly<{
  normalized: readonly string[];
  binding: readonly string[];
}> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1
    || value.length > maximumSegments
  ) {
    return null;
  }
  const allowedKeys = new Set<PropertyKey>(['length']);
  const normalized: string[] = [];
  const binding: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    allowedKeys.add(String(index));
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      return null;
    }
    const segment = normalizeScopeSegment(descriptor.value);
    if (segment === null) {
      return null;
    }
    normalized.push(segment);
    binding.push(descriptor.value);
  }
  if (Reflect.ownKeys(value).some(key => !allowedKeys.has(key))) {
    return null;
  }
  return Object.freeze({
    normalized: Object.freeze(normalized),
    binding: Object.freeze(binding),
  });
}

function normalizeQuery(input: BackstageNotionRagQuery): NormalizedQuery {
  if (typeof input === 'string') {
    return Object.freeze({
      query: input.trim(),
      bindingQuery: input,
      retrievalMode: 'relevant' as const,
    });
  }
  const queryRecord = readClosedDataObject(
    input,
    ['query'],
    ['query', 'retrievalScope', 'retrievalMode', 'mode', 'cursor']
  );
  const bindingQuery = typeof queryRecord.query === 'string'
    ? queryRecord.query
    : '';
  const requestedMode = queryRecord.retrievalMode
    ?? queryRecord.mode
    ?? 'relevant';
  if (
    (queryRecord.retrievalMode !== undefined && queryRecord.mode !== undefined
      && queryRecord.retrievalMode !== queryRecord.mode)
    || (requestedMode !== 'relevant' && requestedMode !== 'complete_scope')
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }
  let retrievalScope: NormalizedScope | undefined;
  let bindingScope: NormalizedQuery['bindingScope'];
  if (queryRecord.retrievalScope !== undefined) {
    const scope = readClosedDataObject(
      queryRecord.retrievalScope,
      ['pageTitle'],
      ['pageTitle', 'pagePath', 'sectionPath', 'scopeKind']
    );
    const bindingPageTitle = scope.pageTitle;
    const pageTitle = normalizeScopeSegment(bindingPageTitle);
    const pagePathSnapshot = normalizeScopePath(scope.pagePath, 101);
    const sectionPathSnapshot = normalizeScopePath(scope.sectionPath, 32);
    const scopeKind = scope.scopeKind ?? 'page';
    if (
      pageTitle === null
      || pagePathSnapshot === null
      || sectionPathSnapshot === null
      || (scopeKind !== 'page' && scopeKind !== 'subtree')
      || (scopeKind === 'subtree' && sectionPathSnapshot !== undefined)
    ) {
      throw new BackstageNotionIndexUnavailableError();
    }
    retrievalScope = scopeKind === 'subtree'
      ? Object.freeze({
          pageTitle,
          ...(pagePathSnapshot
            ? { pagePath: pagePathSnapshot.normalized }
            : {}),
          scopeKind,
        })
      : Object.freeze({
          pageTitle,
          ...(pagePathSnapshot
            ? { pagePath: pagePathSnapshot.normalized }
            : {}),
          ...(sectionPathSnapshot
            ? { sectionPath: sectionPathSnapshot.normalized }
            : {}),
          scopeKind,
        });
    bindingScope = Object.freeze({
      pageTitle: bindingPageTitle as string,
      ...(pagePathSnapshot ? { pagePath: pagePathSnapshot.binding } : {}),
      ...(sectionPathSnapshot
        ? { sectionPath: sectionPathSnapshot.binding }
        : {}),
      ...(Object.hasOwn(scope, 'scopeKind') ? { scopeKind } : {}),
    });
  }
  if (queryRecord.cursor !== undefined && (
    requestedMode !== 'complete_scope'
    || typeof queryRecord.cursor !== 'string'
    || !CURSOR_PATTERN.test(queryRecord.cursor)
  )) {
    throw new BackstageNotionCursorInvalidError();
  }
  return Object.freeze({
    query: bindingQuery.trim(),
    bindingQuery,
    retrievalMode: requestedMode,
    ...(retrievalScope ? { retrievalScope } : {}),
    ...(bindingScope ? { bindingScope } : {}),
    ...(queryRecord.cursor ? { cursor: queryRecord.cursor } : {}),
  });
}

function normalizePlan(input: BackstageNotionPartitionRetrievalPlan): {
  readonly request: NormalizedQuery;
  readonly relevantRoutingIntent?: BackstageNotionPartitionRoutingIntent;
} {
  const plan = readClosedDataObject(
    input,
    ['query'],
    ['query', 'relevantRoutingIntent']
  );
  const request = normalizeQuery(plan.query as BackstageNotionRagQuery);
  const suppliedIntent = Object.hasOwn(plan, 'relevantRoutingIntent');
  if (
    suppliedIntent
    && (request.retrievalMode !== 'relevant' || request.retrievalScope !== undefined)
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }
  if (request.retrievalMode === 'relevant' && request.retrievalScope === undefined) {
    if (!suppliedIntent) {
      throw new BackstageNotionIndexUnavailableError();
    }
    let intent: BackstageNotionPartitionRoutingIntent;
    try {
      intent = normalizeBackstageNotionPartitionRoutingIntent(
        plan.relevantRoutingIntent
      );
    } catch {
      throw new BackstageNotionIndexUnavailableError();
    }
    if (intent.kind !== 'relevant') {
      throw new BackstageNotionIndexUnavailableError();
    }
    return Object.freeze({ request, relevantRoutingIntent: intent });
  }
  return Object.freeze({ request });
}

function requestBinding(request: NormalizedQuery): string {
  return sha256(JSON.stringify({
    format: REQUEST_BINDING_FORMAT,
    query: request.bindingQuery,
    retrievalMode: request.retrievalMode,
    retrievalScope: request.bindingScope ?? null,
  }));
}

function scopeBinding(scope: BackstageNotionPartitionExactScope | null): string {
  return sha256(JSON.stringify({
    format: SCOPE_BINDING_FORMAT,
    scope: scope ?? { scopeKind: 'all' },
  }));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function selectionDigest(routing: ResolvedRouting): string {
  const intent = routing.intent.kind === 'relevant'
    ? {
        kind: routing.intent.kind,
        cardinality: routing.intent.cardinality,
        allowedTiers: [...routing.intent.allowedTiers],
        explicitArchive: routing.intent.explicitArchive,
        selectors: routing.intent.selectors.map(selector => ({
          allScopeTags: [...selector.allScopeTags],
          allCategoryTags: [...selector.allCategoryTags],
        })),
      }
    : routing.intent.kind === 'resolved_scope'
      ? {
          kind: routing.intent.kind,
          cardinality: routing.intent.cardinality,
          shardKey: routing.intent.shardKey,
        }
      : {
          kind: routing.intent.kind,
          cardinality: routing.intent.cardinality,
        };
  const shards = routing.shards.map(shard => ({
    shardKey: shard.shardKey,
    partitionVersionId: shard.partitionVersionId,
    snapshotId: shard.snapshotId,
    retrievalTier: shard.retrievalTier,
    required: shard.required,
    decision: shard.decision,
    verifiedAt: shard.verifiedAt,
  })).sort((left, right) => (
    compareText(left.shardKey, right.shardKey)
    || compareText(left.partitionVersionId, right.partitionVersionId)
    || compareText(left.snapshotId, right.snapshotId)
  ));
  const omissions = routing.matchingOmissions.map(omission => ({
    shardKey: omission.shardKey,
    partitionVersionId: omission.partitionVersionId,
    retrievalTier: omission.retrievalTier,
    decision: omission.decision,
    safeReasonCode: omission.safeReasonCode,
  })).sort((left, right) => (
    compareText(left.shardKey, right.shardKey)
    || compareText(left.partitionVersionId, right.partitionVersionId)
  ));
  return sha256(JSON.stringify({
    format: SELECTION_DIGEST_FORMAT,
    routingVersion: routing.routingVersion,
    universeId: routing.universeId,
    manifestId: routing.manifestId,
    configurationVersionId: routing.configurationVersionId,
    configurationHash: routing.configurationHash,
    embeddingModel: routing.embeddingModel,
    embeddingVersion: routing.embeddingVersion,
    embeddingDimension: routing.embeddingDimension,
    indexFormatVersion: routing.indexFormatVersion,
    intent,
    status: routing.status,
    complete: routing.complete,
    shards,
    omissions,
  }));
}

function cursorEncryptionKey(secret: string, universeId: string): Buffer {
  return createHmac('sha256', secret).update(JSON.stringify({
    format: CURSOR_KEY_FORMAT,
    universeId,
  }), 'utf8').digest();
}

function cursorAuthenticatedData(universeId: string): Buffer {
  return Buffer.from(JSON.stringify({
    format: CURSOR_FORMAT,
    universeId,
  }), 'utf8');
}

function resolveCursorEncryptionSecret(
  resolver: (() => string | undefined) | undefined
): string {
  const secret = resolver?.();
  if (
    typeof secret !== 'string'
    || Buffer.byteLength(secret, 'utf8') < 32
    || Buffer.byteLength(secret, 'utf8') > 4_096
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }
  return secret;
}

function encodeCursor(
  body: CursorBody,
  secret: string,
  universeId: string
): string {
  const initializationVector = randomBytes(CURSOR_IV_BYTES);
  const cipher = createCipheriv(
    'aes-256-gcm',
    cursorEncryptionKey(secret, universeId),
    initializationVector
  );
  cipher.setAAD(cursorAuthenticatedData(universeId));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(body), 'utf8'),
    cipher.final(),
  ]);
  const encoded = Buffer.concat([
    Buffer.from([CURSOR_ENVELOPE_VERSION]),
    initializationVector,
    ciphertext,
    cipher.getAuthTag(),
  ]).toString('base64url');
  if (!CURSOR_PATTERN.test(encoded)) {
    throw new BackstageNotionIndexUnavailableError();
  }
  return encoded;
}

function normalizeCursorAfter(value: unknown): BackstageNotionManifestScopePageAfter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BackstageNotionCursorInvalidError();
  }
  if (Object.keys(value).sort().join(',') !== 'chunkVersionId,ordinal,pageId,shardKey') {
    throw new BackstageNotionCursorInvalidError();
  }
  const after = value as Partial<BackstageNotionManifestScopePageAfter>;
  const shardKey = after.shardKey;
  const pageId = after.pageId;
  const ordinal = after.ordinal;
  const chunkVersionId = after.chunkVersionId;
  if (
    typeof shardKey !== 'string'
    || !SHARD_KEY_PATTERN.test(shardKey)
    || typeof pageId !== 'string'
    || !UUID_PATTERN.test(pageId)
    || typeof ordinal !== 'number'
    || !Number.isSafeInteger(ordinal)
    || ordinal < 0
    || ordinal >= BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS
    || typeof chunkVersionId !== 'string'
    || !UUID_PATTERN.test(chunkVersionId)
  ) {
    throw new BackstageNotionCursorInvalidError();
  }
  return Object.freeze({
    shardKey,
    pageId: pageId.toLowerCase(),
    ordinal,
    chunkVersionId: chunkVersionId.toLowerCase(),
  });
}

function decryptCursor(input: {
  readonly cursor: string;
  readonly secret: string;
  readonly universeId: string;
}): CursorBody {
  let parsed: unknown;
  try {
    const envelope = Buffer.from(input.cursor, 'base64url');
    if (
      envelope.toString('base64url') !== input.cursor
      || envelope.length <= 1 + CURSOR_IV_BYTES + CURSOR_TAG_BYTES
      || envelope[0] !== CURSOR_ENVELOPE_VERSION
    ) {
      throw new Error('invalid cursor envelope');
    }
    const initializationVector = envelope.subarray(1, 1 + CURSOR_IV_BYTES);
    const authenticationTag = envelope.subarray(envelope.length - CURSOR_TAG_BYTES);
    const ciphertext = envelope.subarray(
      1 + CURSOR_IV_BYTES,
      envelope.length - CURSOR_TAG_BYTES
    );
    const decipher = createDecipheriv(
      'aes-256-gcm',
      cursorEncryptionKey(input.secret, input.universeId),
      initializationVector
    );
    decipher.setAAD(cursorAuthenticatedData(input.universeId));
    decipher.setAuthTag(authenticationTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new BackstageNotionCursorInvalidError();
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',') !== [
      'after',
      'configurationHash',
      'configurationVersionId',
      'manifestId',
      'requestBinding',
      'selectionDigest',
      'scopeBinding',
      'scopeChunkCount',
      'scopePageCount',
      'v',
    ].sort().join(',')
  ) {
    throw new BackstageNotionCursorInvalidError();
  }
  const candidate = parsed as Partial<CursorBody>;
  const scopeChunkCount = candidate.scopeChunkCount;
  const scopePageCount = candidate.scopePageCount;
  if (
    candidate.v !== BACKSTAGE_NOTION_PARTITION_RETRIEVAL_CURSOR_VERSION
    || typeof candidate.manifestId !== 'string'
    || !UUID_PATTERN.test(candidate.manifestId)
    || typeof candidate.configurationVersionId !== 'string'
    || !UUID_PATTERN.test(candidate.configurationVersionId)
    || typeof candidate.configurationHash !== 'string'
    || !SHA256_PATTERN.test(candidate.configurationHash)
    || typeof candidate.selectionDigest !== 'string'
    || !SHA256_PATTERN.test(candidate.selectionDigest)
    || typeof candidate.requestBinding !== 'string'
    || !SHA256_PATTERN.test(candidate.requestBinding)
    || typeof candidate.scopeBinding !== 'string'
    || !SHA256_PATTERN.test(candidate.scopeBinding)
    || typeof scopeChunkCount !== 'number'
    || !Number.isSafeInteger(scopeChunkCount)
    || scopeChunkCount < 1
    || scopeChunkCount > MAX_SCOPE_CHUNKS
    || typeof scopePageCount !== 'number'
    || !Number.isSafeInteger(scopePageCount)
    || scopePageCount < 1
    || scopePageCount > MAX_SCOPE_PAGES
  ) {
    throw new BackstageNotionCursorInvalidError();
  }
  const after = normalizeCursorAfter(candidate.after);
  return Object.freeze({
    v: candidate.v,
    manifestId: candidate.manifestId.toLowerCase(),
    configurationVersionId: candidate.configurationVersionId.toLowerCase(),
    configurationHash: candidate.configurationHash,
    selectionDigest: candidate.selectionDigest,
    requestBinding: candidate.requestBinding,
    scopeBinding: candidate.scopeBinding,
    scopeChunkCount,
    scopePageCount,
    after,
  });
}

function validateCursorBinding(input: {
  readonly body: CursorBody;
  readonly routing: ResolvedRouting;
  readonly selectionDigest: string;
  readonly requestBinding: string;
  readonly scopeBinding: string;
}): DecodedCursor {
  if (
    input.body.manifestId !== input.routing.manifestId
    || input.body.configurationVersionId !== input.routing.configurationVersionId
    || input.body.configurationHash !== input.routing.configurationHash
    || input.body.selectionDigest !== input.selectionDigest
    || input.body.requestBinding !== input.requestBinding
    || input.body.scopeBinding !== input.scopeBinding
  ) {
    throw new BackstageNotionCursorInvalidError();
  }
  return Object.freeze({
    after: input.body.after,
    scopeChunkCount: input.body.scopeChunkCount,
    scopePageCount: input.body.scopePageCount,
  });
}

function candidateShards(
  routing: ResolvedRouting
): readonly BackstageNotionPartitionCandidateShard[] {
  return Object.freeze(routing.shards.map(shard => Object.freeze({
    shardKey: shard.shardKey,
    partitionVersionId: shard.partitionVersionId,
    snapshotId: shard.snapshotId,
  })));
}

function exactScope(
  scopeResolution: Extract<
    BackstageNotionPartitionScopeRoutingResolution,
    { status: 'resolved' }
  >
): BackstageNotionPartitionExactScope {
  const { owner, routing } = scopeResolution;
  const shard = routing.shards[0];
  if (
    routing.shards.length !== 1
    || !shard
    || shard.shardKey !== owner.shardKey
    || shard.partitionVersionId !== owner.partitionVersionId
    || shard.snapshotId !== owner.snapshotId
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }
  return Object.freeze({
    shardKey: owner.shardKey,
    partitionVersionId: owner.partitionVersionId,
    snapshotId: owner.snapshotId,
    pageId: owner.pageId,
    scopeKind: owner.scopeKind,
    sectionOccurrencePath: owner.sectionOccurrencePath === null
      ? null
      : Object.freeze([...owner.sectionOccurrencePath]),
    expectedPageCount: owner.scopePageCount,
    expectedChunkCount: owner.scopeChunkCount,
  });
}

function resolvedScope(
  resolution: Extract<
    BackstageNotionPartitionScopeRoutingResolution,
    { status: 'resolved' }
  >
): BackstageNotionRagResolvedScope {
  const owner = resolution.owner;
  return Object.freeze({
    pageTitle: owner.pageTitle,
    pagePath: frozenStringArray(owner.pagePath),
    ...(owner.scopeKind === 'subtree' ? { scopeKind: 'subtree' as const } : {}),
    ...(owner.sectionPath === null
      ? {}
      : { sectionPath: frozenStringArray(owner.sectionPath) }),
  });
}

function isFiniteNonzeroVector(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 8_192
    && value.every(component => typeof component === 'number' && Number.isFinite(component))
    && value.some(component => component !== 0);
}

function pathStartsWith(
  candidate: readonly string[],
  requested: readonly string[]
): boolean {
  return requested.length <= candidate.length
    && requested.every((segment, index) => (
      normalizeBackstageNotionScopeKey(segment)
        === normalizeBackstageNotionScopeKey(candidate[index] ?? '')
    ));
}

function occurrenceStartsWith(
  candidate: readonly number[],
  requested: readonly number[]
): boolean {
  return requested.length <= candidate.length
    && requested.every((occurrence, index) => candidate[index] === occurrence);
}

function projectMaterial(input: {
  readonly universeId: string;
  readonly material: RetrievalMaterial;
  readonly shardByKey: ReadonlyMap<string, BackstageNotionPartitionResolvedShard>;
  readonly scope: BackstageNotionPartitionExactScope | null;
  readonly resolvedScope: BackstageNotionRagResolvedScope | null;
}): ProjectedMaterial {
  const material = input.material;
  const shard = input.shardByKey.get(material.shardKey);
  if (
    !shard
    || shard.partitionVersionId !== material.partitionVersionId
    || shard.snapshotId !== material.snapshotId
    || !UUID_PATTERN.test(material.pageId)
    || !UUID_PATTERN.test(material.pageVersionId)
    || !UUID_PATTERN.test(material.chunkVersionId)
    || !SHA256_PATTERN.test(material.pageContentHash)
    || !SHA256_PATTERN.test(material.contentHash)
    || sha256(material.content) !== material.contentHash
    || codePointLength(material.content) !== material.contentCodePoints
    || material.pagePath.length < 1
    || !Number.isSafeInteger(material.ordinal)
    || material.ordinal < 0
    || material.ordinal >= BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS
    || !Number.isFinite(material.sourceLastEditedAt.getTime())
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }
  if (input.scope) {
    if (
      material.shardKey !== input.scope.shardKey
      || material.partitionVersionId !== input.scope.partitionVersionId
      || material.snapshotId !== input.scope.snapshotId
      || (
        input.scope.scopeKind === 'page'
        && material.pageId !== input.scope.pageId
      )
      || (
        input.scope.scopeKind === 'subtree'
        && (
          !input.resolvedScope
          || !pathStartsWith(material.pagePath, input.resolvedScope.pagePath)
        )
      )
      || (
        input.scope.sectionOccurrencePath !== null
        && !occurrenceStartsWith(
          material.headingOccurrencePath,
          input.scope.sectionOccurrencePath
        )
      )
    ) {
      throw new BackstageNotionIndexUnavailableError();
    }
  }
  const chunkId = sha256(JSON.stringify({
    format: BACKSTAGE_NOTION_RAG_CHUNK_FORMAT,
    pageId: material.pageId,
    ordinal: material.ordinal,
    contentHash: material.contentHash,
  }));
  const sourceLastEditedAt = material.sourceLastEditedAt.toISOString();
  const chunk: BackstageNotionRagChunk = Object.freeze({
    chunkId,
    universeId: input.universeId,
    pageId: material.pageId,
    parentPageId: material.parentPageId,
    title: material.pageTitle,
    path: Object.freeze([...material.pagePath]),
    headingPath: Object.freeze([...material.headingPath]),
    headingOccurrencePath: Object.freeze([...material.headingOccurrencePath]),
    category: material.category,
    ordinal: material.ordinal,
    content: material.content,
    codePoints: material.contentCodePoints,
    contentHash: material.contentHash,
    sourceHash: material.pageContentHash,
    sourceLastEditedAt,
  });
  return Object.freeze({
    material,
    chunk,
    citation: Object.freeze({
      pageId: material.pageId,
      pageTitle: material.pageTitle,
      pagePath: frozenStringArray(material.pagePath),
      headingPath: frozenStringArray(material.headingPath),
      category: material.category,
      chunkId,
      contentHash: material.contentHash,
      shardKey: material.shardKey,
      partitionVersionId: material.partitionVersionId,
      snapshotId: material.snapshotId,
      pageVersionId: material.pageVersionId,
      chunkVersionId: material.chunkVersionId,
      canonicalUrl: material.canonicalUrl,
      sourceLastEditedAt,
    }),
    after: Object.freeze({
      shardKey: material.shardKey,
      pageId: material.pageId,
      ordinal: material.ordinal,
      chunkVersionId: material.chunkVersionId,
    }),
  });
}

function projectMaterials(input: {
  readonly universeId: string;
  readonly materials: readonly RetrievalMaterial[];
  readonly routing: ResolvedRouting;
  readonly scope: BackstageNotionPartitionExactScope | null;
  readonly resolvedScope: BackstageNotionRagResolvedScope | null;
}): readonly ProjectedMaterial[] {
  if (input.materials.length > BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_MAX_RESULTS) {
    throw new BackstageNotionIndexUnavailableError();
  }
  const shardByKey = new Map(input.routing.shards.map(shard => [shard.shardKey, shard]));
  const seen = new Set<string>();
  const projected = input.materials.map(material => projectMaterial({
    universeId: input.universeId,
    material,
    shardByKey,
    scope: input.scope,
    resolvedScope: input.resolvedScope,
  }));
  for (const candidate of projected) {
    const key = JSON.stringify(candidate.after);
    if (seen.has(key)) {
      throw new BackstageNotionIndexUnavailableError();
    }
    seen.add(key);
  }
  return Object.freeze(projected);
}

function selectRelevant(
  candidates: readonly ProjectedMaterial[],
  exactPage: boolean
): readonly ProjectedMaterial[] {
  if (exactPage) {
    return Object.freeze(candidates.slice(0, BACKSTAGE_NOTION_RAG_RETRIEVED_CHUNKS));
  }
  const selected: ProjectedMaterial[] = [];
  const pageCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (selected.length >= BACKSTAGE_NOTION_RAG_RETRIEVED_CHUNKS) {
      break;
    }
    const pageCount = pageCounts.get(candidate.material.pageId) ?? 0;
    if (pageCount >= BACKSTAGE_NOTION_RAG_MAX_CHUNKS_PER_PAGE) {
      continue;
    }
    selected.push(candidate);
    pageCounts.set(candidate.material.pageId, pageCount + 1);
  }
  return Object.freeze(selected);
}

function oldestVerification(routing: ResolvedRouting): Date {
  const timestamps = routing.shards.map(shard => new Date(shard.verifiedAt).getTime());
  const oldest = Math.min(...timestamps);
  if (!Number.isFinite(oldest)) {
    throw new BackstageNotionIndexUnavailableError();
  }
  return new Date(oldest);
}

function baseResult(input: {
  readonly universeId: string;
  readonly routing: ResolvedRouting;
  readonly selectionDigest: string;
  readonly verifiedAt: Date;
  readonly request: NormalizedQuery;
  readonly resolvedScope: BackstageNotionRagResolvedScope | null;
  readonly prompt: string;
  readonly promptChunkCount: number;
  readonly promptTruncated: boolean;
  readonly scopeChunkCount: number;
  readonly scopePageCount: number;
  readonly selected: readonly ProjectedMaterial[];
  readonly exhaustive: boolean;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}): BackstageNotionPartitionRagRetrieval {
  const selectedForPrompt = input.selected.slice(0, input.promptChunkCount);
  const selectedPages = new Set(selectedForPrompt.map(item => item.material.pageId)).size;
  const omittedChunks = Math.max(0, input.scopeChunkCount - input.promptChunkCount);
  const baseCoverage = {
    status: input.exhaustive ? 'complete' as const : 'sampled' as const,
    scopeChunks: input.scopeChunkCount,
    selectedChunks: input.promptChunkCount,
    omittedChunks,
    promptTruncated: input.promptTruncated,
    exhaustive: input.exhaustive,
    hasMore: input.hasMore,
    ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
  };
  const coverage: BackstageNotionRagCoverage = input.resolvedScope?.scopeKind === 'subtree'
    ? {
        ...baseCoverage,
        scopePages: input.scopePageCount,
        selectedPages,
        omittedPages: input.scopePageCount - selectedPages,
      }
    : baseCoverage;
  return Object.freeze({
    universeId: input.universeId,
    manifestId: input.routing.manifestId,
    configurationVersionId: input.routing.configurationVersionId,
    configurationHash: input.routing.configurationHash,
    configurationCurrent: input.routing.configurationCurrent,
    selectionDigest: input.selectionDigest,
    routingComplete: input.routing.complete,
    selectedShards: Object.freeze(input.routing.shards.map(shard => Object.freeze({
      ...shard,
    }))),
    matchingOmissions: Object.freeze(input.routing.matchingOmissions.map(omission => (
      Object.freeze({ ...omission })
    ))),
    verifiedAt: new Date(input.verifiedAt.getTime()),
    prompt: input.prompt,
    chunkCount: input.promptChunkCount,
    truncated: omittedChunks > 0 || input.promptTruncated,
    retrievalMode: input.request.retrievalMode,
    resolvedScope: input.resolvedScope,
    coverage: Object.freeze(coverage),
    nextCursor: input.nextCursor,
    citations: Object.freeze(selectedForPrompt.map(item => item.citation)),
  });
}

async function retrieveUnsafe(
  universeId: string,
  planInput: BackstageNotionPartitionRetrievalPlan,
  overrides: BackstageNotionPartitionRetrievalDependencies
): Promise<BackstageNotionPartitionRagRetrieval> {
  const plan = normalizePlan(planInput);
  if (
    !isBackstageNotionEnrichmentAuthorized()
    || !plan.request.query
    || codePointLength(plan.request.bindingQuery)
      > BACKSTAGE_NOTION_RAG_MAX_QUERY_CODE_POINTS
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }
  const repository = overrides.repository ?? getBackstageNotionPartitionRepository();
  const resolveRequest = overrides.resolveRequest
    ?? resolveBackstageNotionPartitionRequest;
  const resolveScopeRequest = overrides.resolveScopeRequest
    ?? resolveBackstageNotionPartitionScopeRequest;
  const resolvePinnedRequest = overrides.resolvePinnedRequest
    ?? resolveBackstageNotionPartitionPinnedRequest;
  const resolvePinnedScopeRequest = overrides.resolvePinnedScopeRequest
    ?? resolveBackstageNotionPartitionPinnedScopeRequest;
  const isCompleteScope = plan.request.retrievalMode === 'complete_scope';
  const boundRequest = isCompleteScope ? requestBinding(plan.request) : null;
  const cursorSecret = isCompleteScope
    ? resolveCursorEncryptionSecret(overrides.resolveCursorEncryptionSecret)
    : null;
  const cursorBody = plan.request.cursor
    ? decryptCursor({
        cursor: plan.request.cursor,
        secret: cursorSecret!,
        universeId,
      })
    : null;
  if (cursorBody && cursorBody.requestBinding !== boundRequest) {
    throw new BackstageNotionCursorInvalidError();
  }

  let routing: ResolvedRouting;
  let scope: BackstageNotionPartitionExactScope | null = null;
  let canonicalScope: BackstageNotionRagResolvedScope | null = null;
  if (plan.request.retrievalScope) {
    const requestedScope = plan.request.retrievalScope;
    const lookup = Object.freeze({
      pageTitleKey: normalizeBackstageNotionScopeKey(requestedScope.pageTitle),
      pagePathKey: requestedScope.pagePath
        ? normalizeBackstageNotionScopePath(requestedScope.pagePath)
        : null,
      sectionPathKey: requestedScope.scopeKind === 'page'
        && requestedScope.sectionPath
        ? normalizeBackstageNotionScopePath(requestedScope.sectionPath)
        : null,
      scopeKind: requestedScope.scopeKind,
    });
    const scopeResolution = cursorBody
      ? await resolvePinnedScopeRequest(
          universeId,
          cursorBody.manifestId,
          lookup
        )
      : await resolveScopeRequest(universeId, lookup);
    if (scopeResolution.status !== 'resolved') {
      throw new BackstageNotionScopeResolutionError(scopeResolution.status);
    }
    routing = scopeResolution.routing;
    scope = exactScope(scopeResolution);
    canonicalScope = resolvedScope(scopeResolution);
    if (!routing.complete) {
      throw new BackstageNotionIndexUnavailableError();
    }
  } else {
    const intent = plan.request.retrievalMode === 'complete_scope'
      ? Object.freeze({
          kind: 'complete_all' as const,
          cardinality: 'all_matching' as const,
        })
      : plan.relevantRoutingIntent!;
    const resolution = cursorBody
      ? await resolvePinnedRequest(universeId, cursorBody.manifestId, intent)
      : await resolveRequest(universeId, intent);
    if (resolution.status !== 'resolved') {
      throw new BackstageNotionIndexUnavailableError();
    }
    routing = resolution;
    if (plan.request.retrievalMode === 'complete_scope' && !routing.complete) {
      throw new BackstageNotionIndexUnavailableError();
    }
  }
  if (routing.universeId !== universeId || routing.shards.length < 1) {
    throw new BackstageNotionIndexUnavailableError();
  }
  const shards = candidateShards(routing);
  const resolvedSelectionDigest = selectionDigest(routing);
  const verifiedAt = oldestVerification(routing);
  const boundScope = isCompleteScope ? scopeBinding(scope) : null;
  const decodedCursor = cursorBody
    ? validateCursorBinding({
        body: cursorBody,
        routing,
        selectionDigest: resolvedSelectionDigest,
        requestBinding: boundRequest!,
        scopeBinding: boundScope!,
      })
    : null;

  let result: BackstageNotionPartitionRagRetrieval;
  let searchStrategy: string;
  if (plan.request.retrievalMode === 'relevant') {
    const queryEmbedding = await (overrides.embedQuery ?? createEmbedding)(
      plan.request.query
    );
    if (
      !isFiniteNonzeroVector(queryEmbedding)
      || queryEmbedding.length !== routing.embeddingDimension
    ) {
      throw new BackstageNotionIndexUnavailableError();
    }
    const ranked = await repository.rankManifestShardCandidates({
      universeId,
      manifestId: routing.manifestId,
      configurationVersionId: routing.configurationVersionId,
      configurationHash: routing.configurationHash,
      embeddingModel: routing.embeddingModel,
      embeddingVersion: routing.embeddingVersion,
      embeddingDimension: routing.embeddingDimension,
      indexFormatVersion: routing.indexFormatVersion,
      shards,
      scope,
      queryText: plan.request.query,
      queryEmbedding,
      limit: BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_MAX_RESULTS,
    });
    if (
      ranked.status !== 'ready'
      || ranked.manifestId !== routing.manifestId
      || ranked.selectedShardCount !== shards.length
      || ranked.selectedChunkCount < 1
      || ranked.selectedChunkCount > MAX_SCOPE_CHUNKS
      || (scope !== null && ranked.selectedChunkCount !== scope.expectedChunkCount)
      || ranked.candidates.length < 1
      || ranked.candidates.length > BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_MAX_RESULTS
    ) {
      throw new BackstageNotionIndexUnavailableError();
    }
    const candidates = projectMaterials({
      universeId,
      materials: ranked.candidates,
      routing,
      scope,
      resolvedScope: canonicalScope,
    });
    const selected = selectRelevant(
      candidates,
      scope?.scopeKind === 'page'
    );
    const prompt = buildBackstageNotionRagUntrustedContextPrompt(
      selected.map(item => item.chunk),
      { maximumChunks: BACKSTAGE_NOTION_RAG_RETRIEVED_CHUNKS }
    );
    if (prompt.chunkCount < 1) {
      throw new BackstageNotionIndexUnavailableError();
    }
    const scopeChunkCount = scope?.expectedChunkCount ?? ranked.selectedChunkCount;
    const scopePageCount = scope?.expectedPageCount
      ?? new Set(ranked.candidates.map(candidate => candidate.pageId)).size;
    result = baseResult({
      universeId,
      routing,
      selectionDigest: resolvedSelectionDigest,
      verifiedAt,
      request: plan.request,
      resolvedScope: canonicalScope,
      prompt: prompt.prompt,
      promptChunkCount: prompt.chunkCount,
      promptTruncated: prompt.truncated,
      scopeChunkCount,
      scopePageCount,
      selected,
      exhaustive: false,
      hasMore: false,
      nextCursor: null,
    });
    searchStrategy = ranked.strategy;
  } else {
    const page = await repository.loadManifestScopeChunkPage({
      universeId,
      manifestId: routing.manifestId,
      configurationVersionId: routing.configurationVersionId,
      configurationHash: routing.configurationHash,
      indexFormatVersion: routing.indexFormatVersion,
      shards,
      scope,
      after: decodedCursor?.after ?? null,
      limit: BACKSTAGE_NOTION_RAG_RETRIEVED_CHUNKS,
    });
    if (
      page.status !== 'ready'
      || page.manifestId !== routing.manifestId
      || page.selectedShardCount !== shards.length
      || page.scopeChunkCount < 1
      || page.scopeChunkCount > MAX_SCOPE_CHUNKS
      || page.scopePageCount < 1
      || page.scopePageCount > MAX_SCOPE_PAGES
      || page.chunks.length < 1
      || page.chunks.length > BACKSTAGE_NOTION_RAG_RETRIEVED_CHUNKS
      || (page.hasMore && page.chunks.length !== BACKSTAGE_NOTION_RAG_RETRIEVED_CHUNKS)
      || (scope !== null && (
        page.scopeChunkCount !== scope.expectedChunkCount
        || page.scopePageCount !== scope.expectedPageCount
      ))
      || (decodedCursor !== null && (
        page.scopeChunkCount !== decodedCursor.scopeChunkCount
        || page.scopePageCount !== decodedCursor.scopePageCount
      ))
    ) {
      throw new BackstageNotionIndexUnavailableError();
    }
    const selected = projectMaterials({
      universeId,
      materials: page.chunks,
      routing,
      scope,
      resolvedScope: canonicalScope,
    });
    const prompt = buildBackstageNotionRagUntrustedContextPrompt(
      selected.map(item => item.chunk),
      { maximumChunks: BACKSTAGE_NOTION_RAG_RETRIEVED_CHUNKS }
    );
    const completedPromptChunks = prompt.chunkCount - (prompt.partialChunk ? 1 : 0);
    if (prompt.chunkCount < 1 || (prompt.partialChunk && completedPromptChunks < 1)) {
      throw new BackstageNotionIndexUnavailableError();
    }
    const hasMore = page.hasMore || completedPromptChunks < selected.length;
    const lastCompleted = completedPromptChunks > 0
      ? selected[completedPromptChunks - 1]
      : undefined;
    if (hasMore && !lastCompleted) {
      throw new BackstageNotionIndexUnavailableError();
    }
    const nextCursor = hasMore
      ? encodeCursor({
          v: BACKSTAGE_NOTION_PARTITION_RETRIEVAL_CURSOR_VERSION,
          manifestId: routing.manifestId,
          configurationVersionId: routing.configurationVersionId,
          configurationHash: routing.configurationHash,
          selectionDigest: resolvedSelectionDigest,
          requestBinding: boundRequest!,
          scopeBinding: boundScope!,
          scopeChunkCount: page.scopeChunkCount,
          scopePageCount: page.scopePageCount,
          after: lastCompleted!.after,
        }, cursorSecret!, universeId)
      : null;
    result = baseResult({
      universeId,
      routing,
      selectionDigest: resolvedSelectionDigest,
      verifiedAt,
      request: plan.request,
      resolvedScope: canonicalScope,
      prompt: prompt.prompt,
      promptChunkCount: prompt.chunkCount,
      promptTruncated: prompt.truncated,
      scopeChunkCount: page.scopeChunkCount,
      scopePageCount: page.scopePageCount,
      selected,
      exhaustive: decodedCursor === null && !hasMore && !prompt.truncated,
      hasMore,
      nextCursor,
    });
    searchStrategy = 'manifest_keyset_v1';
  }

  try {
    markBackstageNotionEnrichmentUsed();
  } catch {
    throw new BackstageNotionIndexUnavailableError();
  }
  try {
    logger.info('backstage.notion_partition_rag.retrieved', {
      universeId,
      manifestId: routing.manifestId,
      selectionDigest: resolvedSelectionDigest,
      configurationCurrent: routing.configurationCurrent,
      selectedShardCount: routing.shards.length,
      matchingOmissionCount: routing.matchingOmissions.length,
      routingComplete: routing.complete,
      retrievalMode: plan.request.retrievalMode,
      scopeKind: canonicalScope?.sectionPath
        ? 'section'
        : canonicalScope?.scopeKind ?? (canonicalScope ? 'page' : 'all'),
      scopeChunks: result.coverage.scopeChunks,
      retrievedChunks: result.chunkCount,
      promptTruncated: result.coverage.promptTruncated,
      hasMore: result.coverage.hasMore,
      searchStrategy,
    });
  } catch {
    // Diagnostics must never disclose or alter authoritative content.
  }
  return result;
}

/**
 * Dormant partition retrieval boundary. Commit 10 owns every production call
 * site and cutover decision; this function never selects itself for serving.
 */
export async function retrieveBackstageNotionPartitionRagContext(
  universeId: string,
  plan: BackstageNotionPartitionRetrievalPlan,
  dependencies: BackstageNotionPartitionRetrievalDependencies = {}
): Promise<BackstageNotionPartitionRagRetrieval> {
  try {
    return await retrieveUnsafe(universeId, plan, dependencies);
  } catch (error) {
    if (
      isAbortError(error)
      || isBackstageNotionCursorInvalidError(error)
      || isBackstageNotionIndexUnavailableError(error)
      || isBackstageNotionScopeResolutionError(error)
    ) {
      throw error;
    }
    throw new BackstageNotionIndexUnavailableError();
  }
}

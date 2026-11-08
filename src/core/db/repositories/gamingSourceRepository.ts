import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

import { getPool, isDatabaseConnected } from '../client.js';
import { getEnv } from '@platform/runtime/env.js';
import { normalizeGamingGameIdentity, resolveGamingGuideIdentity } from '@shared/gaming/gamingGameIdentity.js';
import { createGamingStoredAuthorityAssessment, hasGamingStoredAuthorityAssessment, gamingSourceHasAuthorityRestriction, GAMING_STORED_AUTHORITY_VERSION,
  type GamingSourceAuthorityAuthorization } from '@shared/gaming/gamingSourceAuthority.js';

export const GAMING_SOURCE_TYPES = [
  'official',
  'patch_notes',
  'wiki',
  'curated',
  'supplied'
] as const;

export const GAMING_KNOWLEDGE_RECORD_TYPES = [
  'guide',
  'build',
  'meta'
] as const;

export type GamingSourceType = typeof GAMING_SOURCE_TYPES[number];
export type GamingKnowledgeRecordType = typeof GAMING_KNOWLEDGE_RECORD_TYPES[number];
export type GamingSourceStatus = 'active' | 'degraded' | 'disabled';
export type GamingKnowledgeRecordStatus = 'active' | 'superseded';
export type GamingSourceRevisionState = 'created' | 'updated' | 'unchanged';
export type GamingDateInput = Date | string;

export interface PersistGamingKnowledgeRecordInput {
  recordType: GamingKnowledgeRecordType;
  semanticKey: string;
  payloadHash: string;
  title?: string | null;
  patch?: string | null;
  searchText: string;
  normalized: Record<string, unknown>;
}

export interface PersistGamingSourceRevisionInput {
  gameKey: string;
  gameName?: string;
  canonicalUrl: string;
  publicUrl?: string;
  sourceType: GamingSourceType;
  trustScore?: number;
  priority?: number;
  contentHash: string;
  cleanedContent: string;
  etag?: string | null;
  lastModified?: string | null;
  fetchedAt?: GamingDateInput;
  publishedAt?: GamingDateInput | null;
  patch?: string | null;
  extractor: string;
  extractorVersion: string;
  normalizerSchemaVersion: string;
  provenance?: Record<string, unknown>;
  extractionMetrics?: Record<string, unknown>;
  records: readonly PersistGamingKnowledgeRecordInput[];
  /** Private worker authorization; public inputs cannot submit persistence authority. */
  authorityAuthorization?: GamingSourceAuthorityAuthorization;
}

export interface PersistGamingSourceRevisionResult {
  sourceId: string;
  revisionId: string;
  state: GamingSourceRevisionState;
  recordsCreated: number;
  /** Number of records from prior revisions atomically marked superseded. */
  recordsUpdated: number;
  requiresReassessment?: true;
}

/** Private, metadata-only observation of a restriction on an existing source. */
export interface GamingSourceAuthorityHoldInput {
  sourceId?: string;
  gameKey: string;
  canonicalUrl: string;
  reason: 'SOURCE_USE_RESTRICTED';
  observedAt?: GamingDateInput;
}

export interface GamingSourceLatestRevision {
  id: string;
  contentHash: string;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: Date;
  publishedAt: Date | null;
  patch: string | null;
  extractor: string;
  extractorVersion: string;
  normalizerSchemaVersion: string;
  provenance?: Record<string, unknown>;
}

export interface GamingSourceRecord {
  id: string;
  gameKey: string;
  /** Display-name compatibility alias used by the Gaming ingestion service. */
  game: string;
  gameName: string;
  canonicalUrl: string;
  canonicalUrlHash: string;
  publicUrl: string;
  host: string;
  sourceType: GamingSourceType;
  trustScore: number;
  priority: number;
  status: GamingSourceStatus;
  lastCheckedAt: Date | null;
  lastSuccessAt: Date | null;
  nextRefreshAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  latestRevision: GamingSourceLatestRevision | null;
}

export interface QueryActiveGamingKnowledgeInput {
  gameKey: string;
  /** Internal IDs resolved from trusted catalog metadata, never public caller aliases. */
  sourceIds?: readonly string[];
  query: string;
  limit?: number;
  /** Internal bounded-deadline refill, in the same deterministic lexical order. */
  offset?: number;
  mode?: GamingKnowledgeRecordType;
}

export interface GamingSourceIdentity {
  sourceId: string;
  gameKey: string;
  gameName: string;
}

export interface FindActiveGamingSourceIdentitiesInput {
  game: string;
  edition?: string;
  mode?: GamingKnowledgeRecordType;
  /** Internal continuation under the original retrieval deadline. */
  offset?: number;
}

export interface QueryActiveGamingKnowledgeOptions {
  queryTimeoutMs?: number;
  signal?: AbortSignal;
}

/** A history count is not a reusable source-authority grant, including when it is unchanged. */
export type GamingSourceAuthoritySnapshot = { status: 'unconfigured' }
  | { status: 'available'; restrictedRevisionCount: number; requiresReassessment: boolean };

export interface GamingSourceAuthoritySnapshotInput {
  gameKey: string;
  /** Server-derived exact registry aliases/edition variants, never a related-game expansion. */
  gameKeys?: readonly string[];
  canonicalUrl: string;
}

export interface GamingKnowledgeProvenanceRecord {
  recordId: string;
  recordType: GamingKnowledgeRecordType;
  semanticKey: string;
  payloadHash: string;
  title: string | null;
  patch: string | null;
  searchText: string;
  normalized: Record<string, unknown>;
  recordCreatedAt: Date;
  sourceId: string;
  gameKey: string;
  gameName: string;
  canonicalUrl: string;
  canonicalUrlHash: string;
  publicUrl: string;
  host: string;
  sourceType: GamingSourceType;
  trustScore: number;
  revisionId: string;
  contentHash: string;
  fetchedAt: Date;
  publishedAt: Date | null;
  revisionPatch: string | null;
  extractor: string;
  extractorVersion: string;
  normalizerSchemaVersion: string;
  provenance: Record<string, unknown>;
  extractionMetrics: Record<string, unknown>;
  relevance: number;
  /** Independently projected from durable source history, never a caller label. */
  authorityReassessmentRequired?: boolean;
}

interface PreparedGamingKnowledgeRecord {
  record_type: GamingKnowledgeRecordType;
  semantic_key: string;
  payload_hash: string;
  title: string | null;
  patch: string | null;
  search_text: string;
  normalized: Record<string, unknown>;
}

interface PreparedPersistInput {
  gameKey: string;
  explicitGameName: string | null;
  gameNameForInsert: string;
  canonicalUrl: string;
  canonicalUrlHash: string;
  publicUrl: string;
  host: string;
  sourceType: GamingSourceType;
  trustScore: number;
  priority: number;
  contentHash: string;
  cleanedContent: string;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: Date;
  publishedAt: Date | null;
  patch: string | null;
  extractor: string;
  extractorVersion: string;
  normalizerSchemaVersion: string;
  provenanceJson: string;
  extractionMetricsJson: string;
  records: PreparedGamingKnowledgeRecord[];
  authorityAuthorizationJson?: string;
}

type TimestampValue = Date | string;

interface GamingSourceRow {
  id: string;
  game_key: string;
  game_name: string;
  canonical_url: string;
  canonical_url_hash: string;
  public_url: string;
  host: string;
  source_type: GamingSourceType;
  trust_score: number | string;
  priority: number | string;
  status: GamingSourceStatus;
  last_checked_at: TimestampValue | null;
  last_success_at: TimestampValue | null;
  next_refresh_at: TimestampValue | null;
  last_error_code: string | null;
  created_at: TimestampValue;
  updated_at: TimestampValue;
  latest_revision_id?: string | null;
  latest_content_hash?: string | null;
  latest_etag?: string | null;
  latest_last_modified?: string | null;
  latest_fetched_at?: TimestampValue | null;
  latest_published_at?: TimestampValue | null;
  latest_patch?: string | null;
  latest_extractor?: string | null;
  latest_extractor_version?: string | null;
  latest_normalizer_schema_version?: string | null;
  latest_provenance?: unknown;
  authority_history_requires_reassessment?: boolean;
  restricted_revision_count?: string;
  authority_grant_revision_count?: string;
}

interface GamingRevisionIdentityRow {
  id: string;
}

interface GamingKnowledgeQueryRow {
  record_id: string;
  record_type: GamingKnowledgeRecordType;
  semantic_key: string;
  payload_hash: string;
  title: string | null;
  record_patch: string | null;
  search_text: string;
  normalized: unknown;
  record_created_at: TimestampValue;
  source_id: string;
  game_key: string;
  game_name: string;
  canonical_url: string;
  canonical_url_hash: string;
  public_url: string;
  host: string;
  source_type: GamingSourceType;
  trust_score: number | string;
  revision_id: string;
  content_hash: string;
  fetched_at: TimestampValue;
  published_at: TimestampValue | null;
  revision_patch: string | null;
  extractor: string;
  extractor_version: string;
  normalizer_schema_version: string;
  provenance: unknown;
  source_has_non_authoritative_history?: boolean;
  source_restricted_revision_count?: string;
  extraction_metrics: unknown;
  relevance: number | string;
}

const SOURCE_COLUMNS = `
  id,
  game_key,
  game_name,
  canonical_url,
  canonical_url_hash,
  public_url,
  host,
  source_type,
  trust_score,
  priority,
  status,
  last_checked_at,
  last_success_at,
  next_refresh_at,
  last_error_code,
  created_at,
  updated_at
`;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SOURCE_TYPE_SET = new Set<string>(GAMING_SOURCE_TYPES);
const RECORD_TYPE_SET = new Set<string>(GAMING_KNOWLEDGE_RECORD_TYPES);
const SENSITIVE_URL_PARAMETER_PATTERN = /(?:^|[_-])(?:api[_-]?key|auth|credential|password|secret|sig|signature|token)(?:$|[_-])/iu;
const MAX_RECORDS_PER_REVISION = 500;
const DEFAULT_QUERY_LIMIT = 12;
const MAX_QUERY_LIMIT = 50;
const MAX_QUERY_TIMEOUT_MS = 30_000;
// The alias is fixed at both call sites. Historical restrictions are immutable;
// making another revision active cannot erase the source's retention boundary.
const NON_AUTHORITATIVE_HISTORY_SQL = `(
  (authority_revision.provenance ? 'generationEligible' AND authority_revision.provenance->'generationEligible' IS DISTINCT FROM 'true'::jsonb)
  OR (authority_revision.provenance ? 'classification' AND authority_revision.provenance->'classification' IS DISTINCT FROM '"verified"'::jsonb)
  OR authority_revision.provenance->'clearReassessmentRequired' = 'true'::jsonb
)`;
const AUTHORITY_REASSESSMENT_HISTORY_SQL = `(${NON_AUTHORITATIVE_HISTORY_SQL}
  OR authority_revision.provenance ? 'gamingClear'
  OR authority_revision.provenance ? 'approvedContentHash'
  OR authority_revision.provenance ? 'hybridPolicyVersion'
  OR authority_revision.provenance ? 'authorityAssessment'
)`;

export class GamingSourceCanonicalHashCollisionError extends Error {
  constructor() {
    super('A Gaming source URL hash matched a different canonical URL.');
    this.name = 'GamingSourceCanonicalHashCollisionError';
  }
}

export class GamingSourceRepositoryUnavailableError extends Error {
  constructor() {
    super('Gaming source persistence is unavailable.');
    this.name = 'GamingSourceRepositoryUnavailableError';
  }
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string.`);
  }
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(`${label} must contain between 1 and ${maxLength} characters.`);
  }
  return normalized;
}

function requiredContent(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new TypeError(`${label} must contain between 1 and ${maxLength} characters.`);
  }
  return value;
}

function optionalString(
  value: unknown,
  label: string,
  maxLength: number
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string' && !value.trim()) {
    return null;
  }
  return requiredString(value, label, maxLength);
}

function normalizeQueryTimeoutMs(value: number | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_QUERY_TIMEOUT_MS) {
    throw new TypeError(
      `queryTimeoutMs must be an integer between 1 and ${MAX_QUERY_TIMEOUT_MS}.`
    );
  }
  return value;
}

function throwIfQueryAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  const error = new Error('Gaming knowledge query aborted.');
  error.name = 'AbortError';
  throw error;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeHash(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a SHA-256 digest.`);
  }
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be a lowercase hexadecimal SHA-256 digest.`);
  }
  return normalized;
}

function normalizePublicHttpUrl(value: unknown, label: string): string {
  const raw = requiredString(value, label, 4096);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError(`${label} must be a valid absolute URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${label} must use HTTP or HTTPS.`);
  }
  if (parsed.username || parsed.password) {
    throw new TypeError(`${label} must not contain credentials.`);
  }
  for (const parameterName of parsed.searchParams.keys()) {
    if (SENSITIVE_URL_PARAMETER_PATTERN.test(parameterName)) {
      throw new TypeError(`${label} must not contain sensitive query parameters.`);
    }
  }
  parsed.hash = '';
  const normalized = parsed.toString();
  if (normalized.length > 4096) {
    throw new TypeError(`${label} must not exceed 4096 characters.`);
  }
  return normalized;
}

function normalizeDate(value: unknown, label: string, fallback?: Date): Date {
  if (value === undefined && fallback) {
    return fallback;
  }
  if (!(value instanceof Date) && typeof value !== 'string') {
    throw new TypeError(`${label} must be a Date or ISO date string.`);
  }
  const normalized = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(normalized.getTime())) {
    throw new TypeError(`${label} must be a valid date.`);
  }
  return normalized;
}

function normalizeOptionalDate(value: unknown, label: string): Date | null {
  if (value === undefined || value === null) {
    return null;
  }
  return normalizeDate(value, label);
}

function serializeJsonObject(value: unknown, label: string): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  let serialized: string;
  try {
    const candidate = JSON.stringify(value);
    if (candidate === undefined) {
      throw new TypeError(`${label} must be JSON serializable.`);
    }
    serialized = candidate;
  } catch {
    throw new TypeError(`${label} must be JSON serializable.`);
  }
  const reparsed = JSON.parse(serialized) as unknown;
  if (typeof reparsed !== 'object' || reparsed === null || Array.isArray(reparsed)) {
    throw new TypeError(`${label} must serialize to a JSON object.`);
  }
  return serialized;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseDate(value: TimestampValue): Date {
  return value instanceof Date ? value : new Date(value);
}

function parseOptionalDate(value: TimestampValue | null): Date | null {
  return value === null ? null : parseDate(value);
}

function normalizeTrustScore(value: unknown): number {
  const normalized = value === undefined ? 0.5 : value;
  if (typeof normalized !== 'number' || !Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
    throw new TypeError('trustScore must be a finite number between 0 and 1.');
  }
  return normalized;
}

function normalizePriority(value: unknown): number {
  const normalized = value === undefined ? 0 : value;
  if (!Number.isInteger(normalized) || (normalized as number) < 0 || (normalized as number) > 100) {
    throw new TypeError('priority must be an integer between 0 and 100.');
  }
  return normalized as number;
}

function prepareRecord(
  input: PersistGamingKnowledgeRecordInput,
  revisionPatch: string | null,
  index: number
): PreparedGamingKnowledgeRecord {
  if (!RECORD_TYPE_SET.has(input.recordType)) {
    throw new TypeError(`records[${index}].recordType is not supported.`);
  }
  return {
    record_type: input.recordType,
    semantic_key: requiredString(input.semanticKey, `records[${index}].semanticKey`, 500),
    payload_hash: normalizeHash(input.payloadHash, `records[${index}].payloadHash`),
    title: optionalString(input.title, `records[${index}].title`, 500),
    patch: input.patch === undefined
      ? revisionPatch
      : optionalString(input.patch, `records[${index}].patch`, 120),
    search_text: requiredContent(input.searchText, `records[${index}].searchText`, 100000),
    normalized: JSON.parse(
      serializeJsonObject(input.normalized, `records[${index}].normalized`)
    ) as Record<string, unknown>
  };
}

function preparePersistInput(input: PersistGamingSourceRevisionInput): PreparedPersistInput {
  const rawGameKey = requiredString(input.gameKey, 'gameKey', 120);
  const gameKey = rawGameKey.toLowerCase();
  const explicitGameName = input.gameName === undefined
    ? null
    : requiredString(input.gameName, 'gameName', 120);
  const canonicalUrl = normalizePublicHttpUrl(input.canonicalUrl, 'canonicalUrl');
  const publicUrl = normalizePublicHttpUrl(input.publicUrl ?? canonicalUrl, 'publicUrl');
  const parsedCanonicalUrl = new URL(canonicalUrl);
  if (!SOURCE_TYPE_SET.has(input.sourceType)) {
    throw new TypeError('sourceType is not supported.');
  }
  if (
    !Array.isArray(input.records)
    || input.records.length < 1
    || input.records.length > MAX_RECORDS_PER_REVISION
  ) {
    throw new TypeError(
      `records must contain between 1 and ${MAX_RECORDS_PER_REVISION} entries.`
    );
  }
  const patch = optionalString(input.patch, 'patch', 120);
  const preparedRecords = input.records.map((record, index) => prepareRecord(record, patch, index));
  const deduplicatedRecords = Array.from(
    new Map(
      preparedRecords.map(record => [
        `${record.semantic_key}\u0000${record.payload_hash}`,
        record
      ])
    ).values()
  );

  return {
    gameKey,
    explicitGameName,
    gameNameForInsert: explicitGameName ?? rawGameKey,
    canonicalUrl,
    canonicalUrlHash: sha256(canonicalUrl),
    publicUrl,
    host: parsedCanonicalUrl.hostname.toLowerCase(),
    sourceType: input.sourceType,
    trustScore: normalizeTrustScore(input.trustScore),
    priority: normalizePriority(input.priority),
    contentHash: normalizeHash(input.contentHash, 'contentHash'),
    cleanedContent: requiredContent(input.cleanedContent, 'cleanedContent', 1000000),
    etag: optionalString(input.etag, 'etag', 1024),
    lastModified: optionalString(input.lastModified, 'lastModified', 256),
    fetchedAt: normalizeDate(input.fetchedAt, 'fetchedAt', new Date()),
    publishedAt: normalizeOptionalDate(input.publishedAt, 'publishedAt'),
    patch,
    extractor: requiredString(input.extractor, 'extractor', 120),
    extractorVersion: requiredString(input.extractorVersion, 'extractorVersion', 120),
    normalizerSchemaVersion: requiredString(
      input.normalizerSchemaVersion,
      'normalizerSchemaVersion',
      120
    ),
    provenanceJson: serializeJsonObject(input.provenance ?? {}, 'provenance'),
    extractionMetricsJson: serializeJsonObject(
      input.extractionMetrics ?? {},
      'extractionMetrics'
    ),
    ...(input.authorityAuthorization === undefined ? {} : {
      authorityAuthorizationJson: serializeJsonObject(input.authorityAuthorization, 'authorityAuthorization')
    }),
    records: deduplicatedRecords
  };
}

function mapLatestRevision(row: GamingSourceRow): GamingSourceLatestRevision | null {
  if (
    !row.latest_revision_id
    || !row.latest_content_hash
    || !row.latest_fetched_at
    || !row.latest_extractor
    || !row.latest_extractor_version
    || !row.latest_normalizer_schema_version
  ) {
    return null;
  }
  return {
    id: row.latest_revision_id,
    contentHash: row.latest_content_hash,
    etag: row.latest_etag ?? null,
    lastModified: row.latest_last_modified ?? null,
    fetchedAt: parseDate(row.latest_fetched_at),
    publishedAt: parseOptionalDate(row.latest_published_at ?? null),
    patch: row.latest_patch ?? null,
    extractor: row.latest_extractor,
    extractorVersion: row.latest_extractor_version,
    normalizerSchemaVersion: row.latest_normalizer_schema_version,
    provenance: parseJsonObject(row.latest_provenance)
  };
}

function mapSourceRow(row: GamingSourceRow): GamingSourceRecord {
  return {
    id: row.id,
    gameKey: row.game_key,
    game: row.game_name,
    gameName: row.game_name,
    canonicalUrl: row.canonical_url,
    canonicalUrlHash: row.canonical_url_hash,
    publicUrl: row.public_url,
    host: row.host,
    sourceType: row.source_type,
    trustScore: Number(row.trust_score),
    priority: Number(row.priority),
    status: row.status,
    lastCheckedAt: parseOptionalDate(row.last_checked_at),
    lastSuccessAt: parseOptionalDate(row.last_success_at),
    nextRefreshAt: parseOptionalDate(row.next_refresh_at),
    lastErrorCode: row.last_error_code,
    createdAt: parseDate(row.created_at),
    updatedAt: parseDate(row.updated_at),
    latestRevision: mapLatestRevision(row)
  };
}

function assertUuid(value: string, label: string): string {
  const normalized = requiredString(value, label, 36);
  if (!UUID_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be a UUID.`);
  }
  return normalized;
}

export class PostgresGamingSourceRepository {
  constructor(private readonly pool: Pool) {}

  async readGamingSourceAuthorityRestrictionCount(input: { gameKey: string; canonicalUrl: string },
    options: QueryActiveGamingKnowledgeOptions = {}): Promise<number> {
    const gameKey = requiredString(input.gameKey, 'gameKey', 120).toLowerCase();
    const canonicalUrl = normalizePublicHttpUrl(input.canonicalUrl, 'canonicalUrl');
    const result = await this.queryWithDeadline<{ restricted_revision_count: string }>(
      `SELECT COUNT(*) AS restricted_revision_count
       FROM gaming_source_revisions AS authority_revision
       JOIN gaming_sources AS source ON source.id = authority_revision.source_id
       WHERE source.game_key = $1 AND source.canonical_url_hash = $2 AND source.canonical_url = $3
         AND ${NON_AUTHORITATIVE_HISTORY_SQL}`,
      [gameKey, sha256(canonicalUrl), canonicalUrl], options);
    const count = Number(result.rows[0]?.restricted_revision_count);
    if (!Number.isSafeInteger(count) || count < 0) throw new GamingSourceRepositoryUnavailableError();
    return count;
  }

  async readGamingSourceAuthoritySnapshot(input: GamingSourceAuthoritySnapshotInput,
    options: QueryActiveGamingKnowledgeOptions = {}): Promise<{ restrictedRevisionCount: number; requiresReassessment: boolean }> {
    if (input.gameKeys !== undefined && (!Array.isArray(input.gameKeys) || input.gameKeys.length > 36))
      throw new TypeError('gameKeys must contain at most 36 exact source keys.');
    const gameKeys = [...new Set([input.gameKey, ...(input.gameKeys ?? [])]
      .map(value => requiredString(value, 'gameKey', 120).toLowerCase()))];
    if (gameKeys.length > 36) throw new TypeError('gameKeys must contain at most 36 exact source keys.');
    const canonicalUrl = normalizePublicHttpUrl(input.canonicalUrl, 'canonicalUrl');
    const result = await this.queryWithDeadline<{ restricted_revision_count: string; requires_reassessment: boolean }>(
      `SELECT COUNT(*) FILTER (WHERE ${NON_AUTHORITATIVE_HISTORY_SQL}) AS restricted_revision_count,
         COUNT(*) > 0 AS requires_reassessment
       FROM gaming_source_revisions AS authority_revision
       JOIN gaming_sources AS source ON source.id = authority_revision.source_id
       WHERE source.game_key = ANY($1::text[]) AND source.canonical_url_hash = $2 AND source.canonical_url = $3`,
      [gameKeys, sha256(canonicalUrl), canonicalUrl], options);
    const count = Number(result.rows[0]?.restricted_revision_count);
    const requiresReassessment = result.rows[0]?.requires_reassessment;
    if (!Number.isSafeInteger(count) || count < 0 || typeof requiresReassessment !== 'boolean')
      throw new GamingSourceRepositoryUnavailableError();
    return { restrictedRevisionCount: count, requiresReassessment };
  }

  /** Bounded reads share the same stale-pool-waiter and transaction cancellation guard. */
  private async queryWithDeadline<Row extends QueryResultRow>(queryText: string, queryValues: unknown[],
    options: QueryActiveGamingKnowledgeOptions): Promise<QueryResult<Row>> {
    const queryTimeoutMs = normalizeQueryTimeoutMs(options.queryTimeoutMs);
    if (queryTimeoutMs === null && options.signal === undefined) return this.pool.query<Row>(queryText, queryValues);
    throwIfQueryAborted(options.signal);
    const client = await this.pool.connect();
    let transactionStarted = false;
    let releaseError: Error | undefined;
    try {
      // A timed-out pool waiter must never begin work after finally acquiring a client.
      throwIfQueryAborted(options.signal);
      await client.query('BEGIN');
      transactionStarted = true;
      if (queryTimeoutMs !== null) await client.query("SELECT set_config('statement_timeout', $1, true)", [`${queryTimeoutMs}ms`]);
      throwIfQueryAborted(options.signal);
      const result = await client.query<Row>(queryText, queryValues);
      throwIfQueryAborted(options.signal);
      await client.query('COMMIT');
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        try { await client.query('ROLLBACK'); }
        catch (rollbackError) {
          releaseError = rollbackError instanceof Error ? rollbackError : new Error('Gaming knowledge query rollback failed.');
        }
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async findActiveGamingSourceIdentities(input: FindActiveGamingSourceIdentitiesInput,
    options: QueryActiveGamingKnowledgeOptions = {}): Promise<GamingSourceIdentity[]> {
    const game = requiredString(input.game, 'game', 120);
    const edition = input.edition === undefined ? undefined : requiredString(input.edition, 'edition', 120);
    const identity = resolveGamingGuideIdentity(game, edition);
    const lookupTitle = identity === normalizeGamingGameIdentity(game) ? game : `${game} ${edition}`;
    if (!identity) return [];
    if (input.mode !== undefined && !RECORD_TYPE_SET.has(input.mode)) throw new TypeError('mode is not supported.');
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('offset must be a nonnegative safe integer.');
    // The builtin Unicode collation exists in PostgreSQL 17 and 18. Normalize
    // both raw titles in SQL, then apply the shared strict identity check below:
    // PostgreSQL's simple case mapping is not JavaScript's full case mapping.
    const result = await this.queryWithDeadline<{ source_id: string; game_key: string; game_name: string }>(
      `SELECT source.id AS source_id, source.game_key, source.game_name
       FROM gaming_sources AS source
       WHERE source.status = 'active'
         AND trim(both '-' from regexp_replace(upper(normalize(translate(source.game_name, '™®©’‘''', ''), NFKC) COLLATE pg_catalog.pg_c_utf8), '[^[:alnum:]+]+', '-', 'g'))
           = trim(both '-' from regexp_replace(upper(normalize(translate($1::text, '™®©’‘''', ''), NFKC) COLLATE pg_catalog.pg_c_utf8), '[^[:alnum:]+]+', '-', 'g'))
         AND EXISTS (
           SELECT 1 FROM gaming_source_revisions AS revision
           JOIN gaming_knowledge_records AS knowledge ON knowledge.source_revision_id = revision.id
           WHERE revision.source_id = source.id AND knowledge.status = 'active'
             AND knowledge.game_key = source.game_key
             AND ($2::text IS NULL OR knowledge.record_type = $2)
         )
       ORDER BY source.trust_score DESC, source.priority DESC, source.id ASC
       LIMIT 20${offset ? ' OFFSET $3' : ''}`, [lookupTitle, input.mode ?? null, ...(offset ? [offset] : [])], options);
    // Recheck using the shared Unicode policy before IDs can scope a knowledge query.
    return result.rows.filter(row => normalizeGamingGameIdentity(row.game_name) === identity)
      .map(row => ({ sourceId: row.source_id, gameKey: row.game_key, gameName: row.game_name }));
  }

  async recordGamingSourceAuthorityHold(input: GamingSourceAuthorityHoldInput): Promise<{ sourceId: string; revisionId: string } | null> {
    const requestedSourceId = input.sourceId === undefined ? null : assertUuid(input.sourceId, 'sourceId');
    const gameKey = requiredString(input.gameKey, 'gameKey', 120).toLowerCase();
    const canonicalUrl = normalizePublicHttpUrl(input.canonicalUrl, 'canonicalUrl');
    const reason = input.reason;
    if (reason !== 'SOURCE_USE_RESTRICTED') throw new TypeError('Unsupported source authority hold reason.');
    const observedAt = normalizeDate(input.observedAt, 'observedAt', new Date());
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const source = await client.query<{ id: string }>(
        `SELECT id FROM gaming_sources
         WHERE ($1::uuid IS NULL OR id = $1) AND game_key = $2 AND canonical_url_hash = $3 AND canonical_url = $4
         FOR UPDATE`, [requestedSourceId, gameKey, sha256(canonicalUrl), canonicalUrl]);
      const sourceId = source.rows[0]?.id;
      if (!sourceId) { await client.query('COMMIT'); return null; }
      // A separate statement after the lock observes newly committed grants.
      // Repeated observations in one grant epoch share an idempotent hold row;
      // a new restriction after fresh authority must create another boundary.
      const grants = await client.query<{ authority_grant_revision_count: string }>(
        `SELECT COUNT(*) AS authority_grant_revision_count FROM gaming_source_revisions
         WHERE source_id = $1 AND provenance ? 'authorityAssessment'`, [sourceId]);
      const version = `gaming-source-authority-hold/v1:${sha256(JSON.stringify({ reason,
        grants: Number(grants.rows[0]?.authority_grant_revision_count ?? 0) }))}`;
      const contentHash = sha256('gaming-source-authority-hold/v1:SOURCE_USE_RESTRICTED');
      const provenance = { classification: 'rejected', generationEligible: false, clearReassessmentRequired: true,
        classificationReasons: [reason], authorityHold: { version: 'gaming-source-authority-hold/v1', reason } };
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO gaming_source_revisions (source_id, content_hash, cleaned_content, etag, last_modified,
           fetched_at, published_at, patch, extractor, extractor_version, normalizer_schema_version, provenance, extraction_metrics)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)
         ON CONFLICT (source_id, content_hash, extractor, extractor_version, normalizer_schema_version) DO NOTHING RETURNING id`,
        [sourceId, contentHash, 'SOURCE_AUTHORITY_HOLD', null, null, observedAt, null, null,
          'gaming-source-authority-hold', version, '1', JSON.stringify(provenance), JSON.stringify({ authorityHold: true, chunkCount: 0 })]);
      let revisionId = inserted.rows[0]?.id;
      if (!revisionId) {
        const previous = await client.query<{ id: string }>(
          `SELECT id FROM gaming_source_revisions WHERE source_id = $1 AND content_hash = $2
           AND extractor = $3 AND extractor_version = $4 AND normalizer_schema_version = $5 LIMIT 1`,
          [sourceId, contentHash, 'gaming-source-authority-hold', version, '1']);
        revisionId = previous.rows[0]?.id;
      }
      if (!revisionId) throw new Error('The source authority hold could not be recorded.');
      await client.query(`UPDATE gaming_sources SET last_checked_at = $2, last_error_code = 'SOURCE_USE_RESTRICTED', updated_at = NOW() WHERE id = $1`, [sourceId, observedAt]);
      await client.query('COMMIT');
      return { sourceId, revisionId };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async persistGamingSourceRevision(
    input: PersistGamingSourceRevisionInput
  ): Promise<PersistGamingSourceRevisionResult> {
    const prepared = preparePersistInput(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.persistPreparedRevision(client, prepared);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async persistPreparedRevision(
    client: PoolClient,
    input: PreparedPersistInput
  ): Promise<PersistGamingSourceRevisionResult> {
    const insertedSource = await client.query<GamingSourceRow>(
      `INSERT INTO gaming_sources (
         game_key,
         game_name,
         canonical_url,
         canonical_url_hash,
         public_url,
         host,
         source_type,
         trust_score,
         priority,
         status,
         last_checked_at,
         last_success_at,
         last_error_code,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $10, NULL, NOW(), NOW())
       ON CONFLICT (game_key, canonical_url_hash) DO NOTHING
       RETURNING ${SOURCE_COLUMNS}`,
      [
        input.gameKey,
        input.gameNameForInsert,
        input.canonicalUrl,
        input.canonicalUrlHash,
        input.publicUrl,
        input.host,
        input.sourceType,
        input.trustScore,
        input.priority,
        input.fetchedAt
      ]
    );

    let source = insertedSource.rows[0];
    const sourceCreated = Boolean(source);
    let authorityHistoryRequiresReassessment = false;
    let restrictedRevisionCount = 0;
    let authorityGrantRevisionCount = 0;
    if (!source) {
      const lockedSource = await client.query<GamingSourceRow>(
        `SELECT ${SOURCE_COLUMNS}
         FROM gaming_sources
         WHERE game_key = $1
           AND canonical_url_hash = $2
         FOR UPDATE`,
        [input.gameKey, input.canonicalUrlHash]
      );
      source = lockedSource.rows[0];
      if (!source) {
        throw new Error('Gaming source upsert did not return a source row.');
      }
      if (source.canonical_url !== input.canonicalUrl) {
        throw new GamingSourceCanonicalHashCollisionError();
      }
      // This statement starts after the row lock is acquired. A projection in
      // the locking SELECT could use a snapshot from before a competing writer.
      const updatedSource = await client.query<GamingSourceRow>(
        `UPDATE gaming_sources
         SET game_name = COALESCE($2, game_name),
             public_url = $3,
             host = $4,
             source_type = $5,
             trust_score = $6,
             priority = $7,
             status = 'active',
             last_checked_at = $8,
             last_success_at = $8,
             last_error_code = NULL,
             updated_at = NOW()
         WHERE id = $1
         RETURNING ${SOURCE_COLUMNS}, EXISTS (
           SELECT 1 FROM gaming_source_revisions AS authority_revision
           WHERE authority_revision.source_id = gaming_sources.id
             AND ${AUTHORITY_REASSESSMENT_HISTORY_SQL}
         ) AS authority_history_requires_reassessment,
         (SELECT COUNT(*) FROM gaming_source_revisions AS authority_revision
           WHERE authority_revision.source_id = gaming_sources.id AND ${NON_AUTHORITATIVE_HISTORY_SQL}) AS restricted_revision_count,
         (SELECT COUNT(*) FROM gaming_source_revisions AS authority_revision
           WHERE authority_revision.source_id = gaming_sources.id AND authority_revision.provenance ? 'authorityAssessment') AS authority_grant_revision_count`,
        [
          source.id,
          input.explicitGameName,
          input.publicUrl,
          input.host,
          input.sourceType,
          input.trustScore,
          input.priority,
          input.fetchedAt
        ]
      );
      source = updatedSource.rows[0];
      if (!source) {
        throw new Error('Gaming source update did not return a source row.');
      }
      authorityHistoryRequiresReassessment = source.authority_history_requires_reassessment === true;
      restrictedRevisionCount = Number(source.restricted_revision_count ?? 0);
      authorityGrantRevisionCount = Number(source.authority_grant_revision_count ?? 0);
    }

    const provenance = JSON.parse(input.provenanceJson) as Record<string, unknown>;
    const authorization = input.authorityAuthorizationJson
      ? JSON.parse(input.authorityAuthorizationJson) as GamingSourceAuthorityAuthorization : undefined;
    const authorityAssessment = createGamingStoredAuthorityAssessment(provenance, input.contentHash, authorization, restrictedRevisionCount);
    const requiresReassessment = !authorityAssessment && (authorityHistoryRequiresReassessment || authorization !== undefined);
    // Provenance labels alone cannot mint authority. Only the separately supplied,
    // current and exact-content worker assessment can write the durable grant.
    delete provenance.authorityAssessment;
    let authorityChanged = false;
    if (authorityAssessment) provenance.authorityAssessment = authorityAssessment;
    else if (requiresReassessment && !gamingSourceHasAuthorityRestriction(provenance)) {
      authorityChanged = provenance.generationEligible !== false;
      provenance.generationEligible = false;
      if (!['stored_unverified', 'reference_only', 'needs_reassessment', 'rejected'].includes(String(provenance.classification))) {
        provenance.classification = 'needs_reassessment';
      }
      provenance.clearReassessmentRequired = true;
      provenance.classificationReasons = ['SOURCE_REASSESSMENT_REQUIRED'];
      if (provenance.acquiredApplicability && typeof provenance.acquiredApplicability === 'object'
        && !Array.isArray(provenance.acquiredApplicability)) {
        provenance.acquiredApplicability = { ...provenance.acquiredApplicability, metadataUnverified: true };
      }
    }
    if (authorityAssessment || gamingSourceHasAuthorityRestriction(provenance)) {
      // An unchanged eligible source can answer another question without a new
      // revision. Keep the exact assessment in its immutable provenance, while
      // revision identity follows content, policy and the retained-history epoch.
      input.extractorVersion = `gaming-source-authority-v1:${sha256(JSON.stringify({
        policyVersion: GAMING_STORED_AUTHORITY_VERSION, extractorVersion: input.extractorVersion,
        authority: authorityAssessment ? { version: authorityAssessment.version,
          revisionContentHash: authorityAssessment.revisionContentHash,
          approvedDocumentHash: authorityAssessment.approvedDocumentHash,
          restrictedRevisionCount: authorityAssessment.restrictedRevisionCount }
          // Reusing held bytes after a later grant is a new hold. This prevents
          // old B reactivation from leaving A's earlier grant current forever.
          : { disposition: 'requires_reassessment', authorityGrantRevisionCount }
      }))}`;
    }
    input.provenanceJson = serializeJsonObject(provenance, 'provenance');

    const existingRevision = await client.query<GamingRevisionIdentityRow>(
      `SELECT id
       FROM gaming_source_revisions
       WHERE source_id = $1
         AND content_hash = $2
         AND extractor = $3
         AND extractor_version = $4
         AND normalizer_schema_version = $5
         AND EXISTS (
           SELECT 1 FROM gaming_knowledge_records AS active_knowledge
           WHERE active_knowledge.source_revision_id = gaming_source_revisions.id
             AND active_knowledge.status = 'active'
         )
       LIMIT 1`,
      [
        source.id,
        input.contentHash,
        input.extractor,
        input.extractorVersion,
        input.normalizerSchemaVersion
      ]
    );
    if (existingRevision.rows[0]) {
      const hybridFreshness = (JSON.parse(input.provenanceJson) as Record<string, unknown>).hybridFreshness;
      if (hybridFreshness && typeof hybridFreshness === 'object' && !Array.isArray(hybridFreshness)) {
        // Exact content/policy identity already matched under the source lock. Revalidation
        // advances only resource verification metadata; it does not manufacture a revision
        // or assert that another URL has no newer game update.
        await client.query(
          `UPDATE gaming_source_revisions
           SET provenance = jsonb_set(provenance, '{hybridFreshness}', $2::jsonb)
           WHERE id = $1
             AND COALESCE(provenance->'hybridFreshness'->>'verifiedAt', '') <= COALESCE($2::jsonb->>'verifiedAt', '')`,
          [existingRevision.rows[0].id, JSON.stringify(hybridFreshness)]
        );
      }
      return {
        sourceId: source.id,
        revisionId: existingRevision.rows[0].id,
        state: 'unchanged',
        recordsCreated: 0,
        recordsUpdated: 0,
        ...(authorityChanged ? { requiresReassessment: true as const } : {})
      };
    }

    const insertedRevision = await client.query<GamingRevisionIdentityRow>(
      `INSERT INTO gaming_source_revisions (
         source_id,
         content_hash,
         cleaned_content,
         etag,
         last_modified,
         fetched_at,
         published_at,
         patch,
         extractor,
         extractor_version,
         normalizer_schema_version,
         provenance,
         extraction_metrics,
         created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, NOW())
       ON CONFLICT (
         source_id,
         content_hash,
         extractor,
         extractor_version,
         normalizer_schema_version
       ) DO NOTHING
       RETURNING id`,
      [
        source.id,
        input.contentHash,
        input.cleanedContent,
        input.etag,
        input.lastModified,
        input.fetchedAt,
        input.publishedAt,
        input.patch,
        input.extractor,
        input.extractorVersion,
        input.normalizerSchemaVersion,
        input.provenanceJson,
        input.extractionMetricsJson
      ]
    );

    let revisionId = insertedRevision.rows[0]?.id;
    if (!revisionId) {
      const concurrentRevision = await client.query<GamingRevisionIdentityRow>(
        `SELECT id
         FROM gaming_source_revisions
         WHERE source_id = $1
           AND content_hash = $2
           AND extractor = $3
           AND extractor_version = $4
           AND normalizer_schema_version = $5
         LIMIT 1`,
        [
          source.id,
          input.contentHash,
          input.extractor,
          input.extractorVersion,
          input.normalizerSchemaVersion
        ]
      );
      revisionId = concurrentRevision.rows[0]?.id;
      if (!revisionId) {
        throw new Error('Gaming source revision insert did not return a revision row.');
      }
      // A -> B -> A can reuse A's immutable revision and chunk identities, but
      // its superseded records must become current again within this transaction.
    }

    const supersededRecords = await client.query<{ id: string }>(
      `UPDATE gaming_knowledge_records AS knowledge
       SET status = 'superseded',
           superseded_at = NOW(),
           updated_at = NOW()
       FROM gaming_source_revisions AS revision
       WHERE knowledge.source_revision_id = revision.id
         AND revision.source_id = $1
         AND revision.id <> $2
         AND knowledge.status = 'active'
       RETURNING knowledge.id`,
      [source.id, revisionId]
    );

    let recordsCreated = 0;
    if (!insertedRevision.rows[0]) {
      await client.query(
        `UPDATE gaming_knowledge_records
         SET status = 'active', superseded_at = NULL, updated_at = NOW()
         WHERE source_revision_id = $1 AND status = 'superseded'`,
        [revisionId]
      );
    }
    if (input.records.length > 0) {
      const insertedRecords = await client.query<{ id: string }>(
        `INSERT INTO gaming_knowledge_records (
           source_revision_id,
           game_key,
           record_type,
           semantic_key,
           payload_hash,
           title,
           patch,
           search_text,
           normalized,
           status,
           superseded_at,
           created_at,
           updated_at
         )
         SELECT
           $1,
           $2,
           record.record_type,
           record.semantic_key,
           record.payload_hash,
           record.title,
           record.patch,
           record.search_text,
           record.normalized,
           'active',
           NULL,
           NOW(),
           NOW()
         FROM jsonb_to_recordset($3::jsonb) AS record(
           record_type TEXT,
           semantic_key TEXT,
           payload_hash TEXT,
           title TEXT,
           patch TEXT,
           search_text TEXT,
           normalized JSONB
         )
         ON CONFLICT (source_revision_id, semantic_key, payload_hash) DO NOTHING
         RETURNING id`,
        [revisionId, input.gameKey, JSON.stringify(input.records)]
      );
      recordsCreated = insertedRecords.rowCount ?? insertedRecords.rows.length;
    }

    return {
      sourceId: source.id,
      revisionId,
      state: sourceCreated ? 'created' : 'updated',
      recordsCreated,
      recordsUpdated: supersededRecords.rowCount ?? supersededRecords.rows.length,
      ...(authorityChanged ? { requiresReassessment: true as const } : {})
    };
  }

  async findGamingSourceById(id: string): Promise<GamingSourceRecord | null> {
    const normalizedId = assertUuid(id, 'id');
    const result = await this.pool.query<GamingSourceRow>(
      `SELECT
         source.id,
         source.game_key,
         source.game_name,
         source.canonical_url,
         source.canonical_url_hash,
         source.public_url,
         source.host,
         source.source_type,
         source.trust_score,
         source.priority,
         source.status,
         source.last_checked_at,
         source.last_success_at,
         source.next_refresh_at,
         source.last_error_code,
         source.created_at,
         source.updated_at,
         latest.id AS latest_revision_id,
         latest.content_hash AS latest_content_hash,
         latest.etag AS latest_etag,
         latest.last_modified AS latest_last_modified,
         latest.fetched_at AS latest_fetched_at,
         latest.published_at AS latest_published_at,
         latest.patch AS latest_patch,
         latest.extractor AS latest_extractor,
         latest.extractor_version AS latest_extractor_version,
         latest.normalizer_schema_version AS latest_normalizer_schema_version,
         latest.provenance AS latest_provenance
       FROM gaming_sources AS source
       LEFT JOIN LATERAL (
         SELECT
           revision.id,
           revision.content_hash,
           revision.etag,
           revision.last_modified,
           revision.fetched_at,
           revision.published_at,
           revision.patch,
           revision.extractor,
           revision.extractor_version,
           revision.normalizer_schema_version,
           revision.provenance
         FROM gaming_source_revisions AS revision
         WHERE revision.source_id = source.id
         ORDER BY EXISTS (
           SELECT 1 FROM gaming_knowledge_records AS active_record
           WHERE active_record.source_revision_id = revision.id AND active_record.status = 'active'
         ) DESC, revision.fetched_at DESC, revision.created_at DESC
         LIMIT 1
       ) AS latest ON TRUE
       WHERE source.id = $1
       LIMIT 1`,
      [normalizedId]
    );
    return result.rows[0] ? mapSourceRow(result.rows[0]) : null;
  }

  async queryActiveGamingKnowledge(
    input: QueryActiveGamingKnowledgeInput,
    options: QueryActiveGamingKnowledgeOptions = {}
  ): Promise<GamingKnowledgeProvenanceRecord[]> {
    const gameKey = requiredString(input.gameKey, 'gameKey', 120).toLowerCase();
    if (typeof input.query !== 'string' || input.query.length > 2000) {
      throw new TypeError('query must be a string no longer than 2000 characters.');
    }
    if (input.mode !== undefined && !RECORD_TYPE_SET.has(input.mode)) {
      throw new TypeError('mode is not supported.');
    }
    const requestedLimit = input.limit ?? DEFAULT_QUERY_LIMIT;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new TypeError('limit must be a positive integer.');
    }
    const limit = Math.min(requestedLimit, MAX_QUERY_LIMIT);
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('offset must be a nonnegative safe integer.');
    const sourceIds = input.sourceIds === undefined ? null : [...new Set(input.sourceIds.map(id => assertUuid(id, 'sourceId')))];
    if (sourceIds && sourceIds.length > 20) throw new TypeError('sourceIds cannot exceed 20.');
    const queryText = `WITH search_input AS (
         SELECT CASE
            WHEN NULLIF(btrim($2::text), '') IS NULL THEN NULL
            ELSE websearch_to_tsquery('simple'::regconfig, $2::text)
         END AS query
       )
       SELECT
         knowledge.id AS record_id,
         knowledge.record_type,
         knowledge.semantic_key,
         knowledge.payload_hash,
         knowledge.title,
         knowledge.patch AS record_patch,
         knowledge.search_text,
         knowledge.normalized,
         knowledge.created_at AS record_created_at,
         source.id AS source_id,
         source.game_key,
         source.game_name,
         source.canonical_url,
         source.canonical_url_hash,
         source.public_url,
         source.host,
         source.source_type,
         source.trust_score,
         revision.id AS revision_id,
         revision.content_hash,
         revision.fetched_at,
         revision.published_at,
         revision.patch AS revision_patch,
         revision.extractor,
         revision.extractor_version,
         revision.normalizer_schema_version,
         revision.provenance,
         revision.extraction_metrics,
         EXISTS (
           SELECT 1 FROM gaming_source_revisions AS authority_revision
           WHERE authority_revision.source_id = source.id AND ${AUTHORITY_REASSESSMENT_HISTORY_SQL}
         ) AS source_has_non_authoritative_history,
         (SELECT COUNT(*) FROM gaming_source_revisions AS authority_revision
           WHERE authority_revision.source_id = source.id AND ${NON_AUTHORITATIVE_HISTORY_SQL}) AS source_restricted_revision_count,
         COALESCE(
           ts_rank_cd(
             to_tsvector('simple'::regconfig, knowledge.search_text),
             search_input.query
           ),
           0
         ) AS relevance
       FROM gaming_knowledge_records AS knowledge
       JOIN gaming_source_revisions AS revision
         ON revision.id = knowledge.source_revision_id
       JOIN gaming_sources AS source
         ON source.id = revision.source_id
       CROSS JOIN search_input
       WHERE (($5::uuid[] IS NULL AND knowledge.game_key = $1) OR source.id = ANY($5::uuid[]))
         AND knowledge.game_key = source.game_key
         AND knowledge.status = 'active'
         AND source.status = 'active'
         AND ($3::text IS NULL OR knowledge.record_type = $3)
         AND (
           search_input.query IS NOT NULL
           AND to_tsvector('simple'::regconfig, knowledge.search_text) @@ search_input.query
         )
       ORDER BY
         relevance DESC,
          source.trust_score DESC,
          revision.fetched_at DESC,
          knowledge.created_at DESC,
          knowledge.id ASC
        LIMIT $4${offset ? ' OFFSET $6' : ''}`;
    const queryValues = [gameKey, input.query, input.mode ?? null, limit, sourceIds, ...(offset ? [offset] : [])];
    const result = await this.queryWithDeadline<GamingKnowledgeQueryRow>(queryText, queryValues, options);

    return result.rows.map(row => {
      const provenance = parseJsonObject(row.provenance);
      const authorityReassessmentRequired = row.source_has_non_authoritative_history === true
        && !hasGamingStoredAuthorityAssessment(provenance, row.content_hash, Number(row.source_restricted_revision_count ?? 0));
      return {
        recordId: row.record_id,
        recordType: row.record_type,
        semanticKey: row.semantic_key,
        payloadHash: row.payload_hash,
        title: row.title,
        patch: row.record_patch,
        searchText: row.search_text,
        normalized: parseJsonObject(row.normalized),
        recordCreatedAt: parseDate(row.record_created_at),
        sourceId: row.source_id,
        gameKey: row.game_key,
        gameName: row.game_name,
        canonicalUrl: row.canonical_url,
        canonicalUrlHash: row.canonical_url_hash,
        publicUrl: row.public_url,
        host: row.host,
        sourceType: row.source_type,
        trustScore: Number(row.trust_score),
        revisionId: row.revision_id,
        contentHash: row.content_hash,
        fetchedAt: parseDate(row.fetched_at),
        publishedAt: parseOptionalDate(row.published_at),
        revisionPatch: row.revision_patch,
        extractor: row.extractor,
        extractorVersion: row.extractor_version,
        normalizerSchemaVersion: row.normalizer_schema_version,
        provenance,
        extractionMetrics: parseJsonObject(row.extraction_metrics),
        relevance: Number(row.relevance),
        ...(authorityReassessmentRequired ? { authorityReassessmentRequired: true } : {})
      };
    });
  }
}

function requireGamingSourcePool(): Pool {
  if (!isDatabaseConnected()) {
    throw new GamingSourceRepositoryUnavailableError();
  }
  const pool = getPool();
  if (!pool) {
    throw new GamingSourceRepositoryUnavailableError();
  }
  return pool;
}

export function createGamingSourceRepository(pool?: Pool): PostgresGamingSourceRepository {
  return new PostgresGamingSourceRepository(pool ?? requireGamingSourcePool());
}

export async function persistGamingSourceRevision(
  input: PersistGamingSourceRevisionInput
): Promise<PersistGamingSourceRevisionResult> {
  return createGamingSourceRepository().persistGamingSourceRevision(input);
}

export async function recordGamingSourceAuthorityHold(input: GamingSourceAuthorityHoldInput): Promise<{ sourceId: string; revisionId: string } | null> {
  return createGamingSourceRepository().recordGamingSourceAuthorityHold(input);
}

export async function readGamingSourceAuthorityRestrictionCount(input: { gameKey: string; canonicalUrl: string },
  options: QueryActiveGamingKnowledgeOptions = {}): Promise<number> {
  return createGamingSourceRepository().readGamingSourceAuthorityRestrictionCount(input, options);
}

/** A missing database differs from unavailable durable authority; never turn a failed read into epoch zero. */
export async function readGamingSourceAuthoritySnapshot(input: GamingSourceAuthoritySnapshotInput,
  options: QueryActiveGamingKnowledgeOptions = {}): Promise<GamingSourceAuthoritySnapshot> {
  options.signal?.throwIfAborted();
  const configured = ['DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DATABASE_PUBLIC_URL',
    'PGUSER', 'PGPASSWORD', 'PGHOST', 'PGPORT', 'PGDATABASE'].some(name => {
    const value = getEnv(name)?.trim();
    return Boolean(value && !['undefined', 'null'].includes(value.toLowerCase()));
  });
  if (!configured) return { status: 'unconfigured' };
  const queryTimeoutMs = Math.min(1_000, normalizeQueryTimeoutMs(options.queryTimeoutMs) ?? 1_000);
  const deadline = AbortSignal.timeout(queryTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason);
    if (signal.aborted) rejectAbort();
    else signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    const snapshot = await Promise.race([
      createGamingSourceRepository().readGamingSourceAuthoritySnapshot(input, { queryTimeoutMs, signal }), aborted
    ]);
    return { status: 'available', ...snapshot };
  } finally { signal.removeEventListener('abort', rejectAbort); }
}

export async function findGamingSourceById(id: string): Promise<GamingSourceRecord | null> {
  return createGamingSourceRepository().findGamingSourceById(id);
}

export const getGamingSourceById = findGamingSourceById;

export async function queryActiveGamingKnowledge(
  input: QueryActiveGamingKnowledgeInput,
  options: QueryActiveGamingKnowledgeOptions = {}
): Promise<GamingKnowledgeProvenanceRecord[]> {
  return createGamingSourceRepository().queryActiveGamingKnowledge(input, options);
}

export const searchActiveGamingKnowledge = queryActiveGamingKnowledge;

export async function findActiveGamingSourceIdentities(
  input: FindActiveGamingSourceIdentitiesInput,
  options: QueryActiveGamingKnowledgeOptions = {}
): Promise<GamingSourceIdentity[]> {
  return createGamingSourceRepository().findActiveGamingSourceIdentities(input, options);
}

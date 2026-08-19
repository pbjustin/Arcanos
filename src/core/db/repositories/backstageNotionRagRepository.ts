import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { getPool } from '../client.js';

export const BACKSTAGE_NOTION_SYNC_LEASE_MIN_MS = 1_000;
export const BACKSTAGE_NOTION_SYNC_LEASE_MAX_MS = 15 * 60 * 1_000;
export const BACKSTAGE_NOTION_MAX_PAGES_PER_SNAPSHOT = 5_000;
export const BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT = 50_000;
export const BACKSTAGE_NOTION_MAX_REUSABLE_EMBEDDING_HASHES = 1_000;

const UNIVERSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

type TimestampValue = Date | string;

export type BackstageNotionAuthority = 'postgres' | 'notion';

export interface BackstageNotionAuthorityHead {
  universeId: string;
  authority: BackstageNotionAuthority;
  activeSnapshotId: string | null;
  rootPageId: string | null;
}

export interface BackstageNotionSyncLease {
  universeId: string;
  holderId: string;
  leaseToken: string;
  acquiredAt: Date;
  expiresAt: Date;
}

export interface BackstageNotionSnapshotPageInput {
  pageId: string;
  parentPageId?: string | null;
  title: string;
  canonicalUrl?: string | null;
  contentHash: string;
  markdown: string;
  sourceLastEditedAt?: Date | string | null;
  depth: number;
  path: string[];
  metadata?: Record<string, unknown>;
}

export interface BackstageNotionSnapshotChunkInput {
  chunkId: string;
  pageId: string;
  ordinal: number;
  contentHash: string;
  content: string;
  codePoints: number;
  embedding: number[];
  headingPath?: string[];
  metadata?: Record<string, unknown>;
}

export interface ActivateBackstageNotionSnapshotInput {
  universeId: string;
  rootPageId: string;
  manifestHash: string;
  embeddingModel: string;
  sourceMaxEditedAt?: Date | string | null;
  lease: Pick<BackstageNotionSyncLease, 'holderId' | 'leaseToken'>;
  pages: BackstageNotionSnapshotPageInput[];
  chunks: BackstageNotionSnapshotChunkInput[];
}

export interface BackstageNotionSnapshotRecord {
  id: string;
  universeId: string;
  rootPageId: string;
  manifestHash: string;
  embeddingModel: string;
  pageCount: number;
  chunkCount: number;
  sourceMaxEditedAt: Date | null;
  syncHolderId: string;
  createdAt: Date;
}

export interface BackstageNotionActiveChunk {
  id: string;
  pageId: string;
  pageTitle: string;
  pageUrl: string | null;
  pagePath: string[];
  ordinal: number;
  contentHash: string;
  content: string;
  codePoints: number;
  embeddingModel: string;
  embedding: number[];
  headingPath: string[];
  metadata: Record<string, unknown>;
}

export interface BackstageNotionActiveSnapshot {
  authority: 'notion';
  verifiedAt: Date;
  snapshot: BackstageNotionSnapshotRecord;
  chunks: BackstageNotionActiveChunk[];
  truncated: boolean;
}

export interface BackstageNotionPageInventoryRecord {
  pageId: string;
  parentPageId: string | null;
  title: string;
  canonicalUrl: string | null;
  contentHash: string;
  sourceLastEditedAt: Date | null;
  depth: number;
  path: string[];
  metadata: Record<string, unknown>;
}

export interface BackstageNotionActiveInventory {
  authority: 'notion';
  verifiedAt: Date;
  snapshot: BackstageNotionSnapshotRecord;
  pages: BackstageNotionPageInventoryRecord[];
}

export interface BackstageNotionRagRepository {
  loadAuthorityHead(universeId: string): Promise<BackstageNotionAuthorityHead | null>;
  acquireSyncLease(
    universeId: string,
    holderId: string,
    ttlMs: number
  ): Promise<BackstageNotionSyncLease | null>;
  releaseSyncLease(
    universeId: string,
    holderId: string,
    leaseToken: string
  ): Promise<boolean>;
  loadReusableEmbeddings(
    universeId: string,
    embeddingModel: string,
    contentHashes: string[]
  ): Promise<Map<string, number[]>>;
  markActiveSnapshotVerified(
    universeId: string,
    manifestHash: string,
    lease: Pick<BackstageNotionSyncLease, 'holderId' | 'leaseToken'>
  ): Promise<Date | null>;
  activateSnapshot(
    input: ActivateBackstageNotionSnapshotInput
  ): Promise<BackstageNotionSnapshotRecord>;
  loadActiveSnapshot(
    universeId: string,
    maxChunks: number
  ): Promise<BackstageNotionActiveSnapshot | null>;
  loadActiveInventory(universeId: string): Promise<BackstageNotionActiveInventory | null>;
}

interface AuthorityHeadRow {
  universe_id: string;
  authority: string;
  active_snapshot_id: string | null;
  root_page_id: string | null;
}

interface LeaseRow {
  universe_id: string;
  holder_id: string;
  lease_token: string;
  acquired_at: TimestampValue;
  expires_at: TimestampValue;
}

interface SnapshotRow {
  snapshot_id: string;
  universe_id: string;
  root_page_id: string;
  manifest_hash: string;
  embedding_model: string;
  page_count: number | string;
  chunk_count: number | string;
  source_max_edited_at: TimestampValue | null;
  sync_holder_id: string;
  snapshot_created_at: TimestampValue;
}

interface ActiveChunkRow extends SnapshotRow {
  authority: 'notion';
  verified_at: TimestampValue;
  chunk_id: string;
  page_id: string;
  page_title: string;
  canonical_url: string | null;
  page_path: unknown;
  ordinal: number | string;
  content_hash: string;
  content: string;
  code_points: number | string;
  chunk_embedding_model: string;
  embedding: unknown;
  heading_path: unknown;
  chunk_metadata: unknown;
}

interface InventoryRow extends SnapshotRow {
  authority: 'notion';
  verified_at: TimestampValue;
  page_id: string;
  parent_page_id: string | null;
  title: string;
  canonical_url: string | null;
  content_hash: string;
  source_last_edited_at: TimestampValue | null;
  depth: number | string;
  path: unknown;
  page_metadata: unknown;
}

interface ReusableEmbeddingRow {
  content_hash: string;
  embedding: unknown;
}

interface PreparedPage {
  page_id: string;
  parent_page_id: string | null;
  title: string;
  canonical_url: string | null;
  content_hash: string;
  markdown: string;
  source_last_edited_at: string | null;
  depth: number;
  path: string[];
  metadata: Record<string, unknown>;
}

interface PreparedChunk {
  chunk_id: string;
  page_id: string;
  ordinal: number;
  content_hash: string;
  content: string;
  code_points: number;
  embedding: number[];
  heading_path: string[];
  metadata: Record<string, unknown>;
}

interface PreparedSnapshotInput {
  universeId: string;
  rootPageId: string;
  manifestHash: string;
  embeddingModel: string;
  sourceMaxEditedAt: Date | null;
  holderId: string;
  leaseToken: string;
  pages: PreparedPage[];
  chunks: PreparedChunk[];
}

export class BackstageNotionRagRepositoryUnavailableError extends Error {
  readonly code = 'BACKSTAGE_NOTION_RAG_REPOSITORY_UNAVAILABLE';

  constructor() {
    super('Backstage Notion RAG persistence requires PostgreSQL.');
    this.name = 'BackstageNotionRagRepositoryUnavailableError';
  }
}

export class BackstageNotionSyncLeaseError extends Error {
  readonly code = 'BACKSTAGE_NOTION_SYNC_LEASE_LOST';

  constructor() {
    super('The Backstage Notion synchronization lease is absent, expired, or no longer owned by this synchronizer.');
    this.name = 'BackstageNotionSyncLeaseError';
  }
}

function normalizeUniverseId(value: string): string {
  const normalized = value.trim();
  if (!UNIVERSE_ID_PATTERN.test(normalized)) {
    throw new Error('universeId must be 1-128 supported characters.');
  }
  return normalized;
}

function normalizeRequiredText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} must contain 1-${maxLength} characters.`);
  }
  return normalized;
}

function normalizeUuid(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a canonical UUID.`);
  }
  return normalized;
}

function normalizeSha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return normalized;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeDate(value: Date | string, label: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${label} must be a valid finite timestamp.`);
  }
  return date;
}

function parseDate(value: TimestampValue, label: string): Date {
  return normalizeDate(value, label);
}

function normalizeInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function parseInteger(value: number | string, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} is not a safe integer.`);
  }
  return parsed;
}

function normalizeStringArray(
  value: string[],
  label: string,
  maxItems: number,
  maxItemLength = 500
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} must contain at most ${maxItems} strings.`);
  }
  return value.map((item, index) =>
    normalizeRequiredText(item, `${label}[${index}]`, maxItemLength)
  );
}

function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${label} is not a string array.`);
  }
  return value.map(item => item as string);
}

function normalizeJsonObject(
  value: Record<string, unknown> | undefined,
  label: string
): Record<string, unknown> {
  const candidate = value ?? {};
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(candidate);
  } catch {
    throw new Error(`${label} must be JSON serializable.`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > 262_144) {
    throw new Error(`${label} exceeds the 262144-byte limit.`);
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function parseJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function normalizeEmbedding(value: number[], label: string): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8192) {
    throw new Error(`${label} must contain 1-8192 dimensions.`);
  }
  if (value.some(component => typeof component !== 'number' || !Number.isFinite(component))) {
    throw new Error(`${label} must contain only finite numbers.`);
  }
  return [...value];
}

function parseEmbedding(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array.`);
  }
  return normalizeEmbedding(value as number[], label);
}

function normalizeCanonicalUrl(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 4096) {
    throw new Error('canonicalUrl must contain 1-4096 characters when provided.');
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('canonicalUrl must be a valid URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('canonicalUrl must use HTTPS.');
  }
  return parsed.toString();
}

function prepareSnapshotInput(input: ActivateBackstageNotionSnapshotInput): PreparedSnapshotInput {
  const universeId = normalizeUniverseId(input.universeId);
  const rootPageId = normalizeUuid(input.rootPageId, 'rootPageId');
  const manifestHash = normalizeSha256(input.manifestHash, 'manifestHash');
  const embeddingModel = normalizeRequiredText(input.embeddingModel, 'embeddingModel', 200);
  const holderId = normalizeRequiredText(input.lease.holderId, 'lease.holderId', 200);
  const leaseToken = normalizeUuid(input.lease.leaseToken, 'lease.leaseToken');
  const sourceMaxEditedAt = input.sourceMaxEditedAt === undefined || input.sourceMaxEditedAt === null
    ? null
    : normalizeDate(input.sourceMaxEditedAt, 'sourceMaxEditedAt');

  if (
    !Array.isArray(input.pages)
    || input.pages.length < 1
    || input.pages.length > BACKSTAGE_NOTION_MAX_PAGES_PER_SNAPSHOT
  ) {
    throw new Error(`pages must contain 1-${BACKSTAGE_NOTION_MAX_PAGES_PER_SNAPSHOT} records.`);
  }
  if (
    !Array.isArray(input.chunks)
    || input.chunks.length < 1
    || input.chunks.length > BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT
  ) {
    throw new Error(`chunks must contain 1-${BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT} records.`);
  }

  const pageIds = new Set<string>();
  const pages = input.pages.map((page, index): PreparedPage => {
    const pageId = normalizeUuid(page.pageId, `pages[${index}].pageId`);
    if (pageIds.has(pageId)) {
      throw new Error(`pages contains duplicate pageId ${pageId}.`);
    }
    pageIds.add(pageId);
    const parentPageId = page.parentPageId === undefined || page.parentPageId === null
      ? null
      : normalizeUuid(page.parentPageId, `pages[${index}].parentPageId`);
    const depth = normalizeInteger(page.depth, `pages[${index}].depth`, 0, 100);
    const path = normalizeStringArray(page.path, `pages[${index}].path`, 101);
    if (path.length !== depth + 1) {
      throw new Error(`pages[${index}].path must contain exactly depth + 1 items.`);
    }
    if (Buffer.byteLength(page.markdown, 'utf8') > 10_485_760) {
      throw new Error(`pages[${index}].markdown exceeds the 10485760-byte limit.`);
    }
    const title = normalizeRequiredText(page.title, `pages[${index}].title`, 500);
    const contentHash = normalizeSha256(page.contentHash, `pages[${index}].contentHash`);
    const expectedSourceHash = sha256(JSON.stringify({
      format: 'backstage-notion-rag-page-v1',
      universeId,
      pageId,
      parentPageId,
      title,
      path,
      markdown: page.markdown
    }));
    if (contentHash !== expectedSourceHash) {
      throw new Error(`pages[${index}].contentHash does not match the normalized page.`);
    }
    return {
      page_id: pageId,
      parent_page_id: parentPageId,
      title,
      canonical_url: normalizeCanonicalUrl(page.canonicalUrl),
      content_hash: contentHash,
      markdown: page.markdown,
      source_last_edited_at:
        page.sourceLastEditedAt === undefined || page.sourceLastEditedAt === null
          ? null
          : normalizeDate(
            page.sourceLastEditedAt,
            `pages[${index}].sourceLastEditedAt`
          ).toISOString(),
      depth,
      path,
      metadata: normalizeJsonObject(page.metadata, `pages[${index}].metadata`)
    };
  });

  const rootPage = pages.find(page => page.page_id === rootPageId);
  if (!rootPage || rootPage.parent_page_id !== null || rootPage.depth !== 0) {
    throw new Error('rootPageId must identify the single depth-zero page with no parent.');
  }
  for (const [index, page] of pages.entries()) {
    if (page.page_id !== rootPageId && page.parent_page_id === null) {
      throw new Error(`pages[${index}] is outside the rooted hierarchy.`);
    }
    if (page.parent_page_id !== null && !pageIds.has(page.parent_page_id)) {
      throw new Error(`pages[${index}].parentPageId is not present in this full snapshot.`);
    }
  }
  const pageById = new Map(pages.map(page => [page.page_id, page]));
  for (const [index, page] of pages.entries()) {
    if (page.parent_page_id === null) {
      continue;
    }
    const parent = pageById.get(page.parent_page_id);
    if (!parent || parent.depth !== page.depth - 1) {
      throw new Error(`pages[${index}] does not descend exactly one level from its parent.`);
    }
    if (parent.path.some((segment, pathIndex) => page.path[pathIndex] !== segment)) {
      throw new Error(`pages[${index}].path does not extend its parent path.`);
    }
  }

  const chunkIds = new Set<string>();
  const positions = new Set<string>();
  let embeddingDimensions: number | null = null;
  const chunks = input.chunks.map((chunk, index): PreparedChunk => {
    const chunkId = normalizeSha256(chunk.chunkId, `chunks[${index}].chunkId`);
    const pageId = normalizeUuid(chunk.pageId, `chunks[${index}].pageId`);
    if (!pageIds.has(pageId)) {
      throw new Error(`chunks[${index}].pageId is not present in this full snapshot.`);
    }
    if (chunkIds.has(chunkId)) {
      throw new Error(`chunks contains duplicate chunkId ${chunkId}.`);
    }
    chunkIds.add(chunkId);
    const ordinal = normalizeInteger(chunk.ordinal, `chunks[${index}].ordinal`, 0, 1_000_000);
    const position = `${pageId}:${ordinal}`;
    if (positions.has(position)) {
      throw new Error(`chunks contains duplicate page ordinal ${position}.`);
    }
    positions.add(position);
    if (!chunk.content.trim() || Buffer.byteLength(chunk.content, 'utf8') > 131_072) {
      throw new Error(`chunks[${index}].content must contain 1-131072 UTF-8 bytes.`);
    }
    const contentHash = normalizeSha256(chunk.contentHash, `chunks[${index}].contentHash`);
    if (contentHash !== sha256(chunk.content)) {
      throw new Error(`chunks[${index}].contentHash does not match its content.`);
    }
    const expectedChunkId = sha256(JSON.stringify({
      format: 'backstage-notion-rag-chunk-v1',
      pageId,
      ordinal,
      contentHash
    }));
    if (chunkId !== expectedChunkId) {
      throw new Error(`chunks[${index}].chunkId does not match its deterministic identity.`);
    }
    const codePoints = normalizeInteger(
      chunk.codePoints,
      `chunks[${index}].codePoints`,
      1,
      131_072
    );
    if (codePoints !== Array.from(chunk.content).length) {
      throw new Error(`chunks[${index}].codePoints does not match its content.`);
    }
    const embedding = normalizeEmbedding(chunk.embedding, `chunks[${index}].embedding`);
    embeddingDimensions ??= embedding.length;
    if (embedding.length !== embeddingDimensions) {
      throw new Error('All snapshot embeddings must have the same dimensionality.');
    }
    return {
      chunk_id: chunkId,
      page_id: pageId,
      ordinal,
      content_hash: contentHash,
      content: chunk.content,
      code_points: codePoints,
      embedding,
      heading_path: normalizeStringArray(
        chunk.headingPath ?? [],
        `chunks[${index}].headingPath`,
        32
      ),
      metadata: normalizeJsonObject(chunk.metadata, `chunks[${index}].metadata`)
    };
  });

  const ordinalsByPage = new Map<string, number[]>();
  for (const chunk of chunks) {
    const ordinals = ordinalsByPage.get(chunk.page_id) ?? [];
    ordinals.push(chunk.ordinal);
    ordinalsByPage.set(chunk.page_id, ordinals);
  }
  for (const [pageId, ordinals] of ordinalsByPage) {
    ordinals.sort((left, right) => left - right);
    if (ordinals.some((ordinal, index) => ordinal !== index)) {
      throw new Error(`chunks for page ${pageId} must use contiguous zero-based ordinals.`);
    }
  }
  for (const [index, page] of pages.entries()) {
    if (page.markdown.trim() && !ordinalsByPage.has(page.page_id)) {
      throw new Error(`pages[${index}] has retrievable content but no chunks.`);
    }
  }

  return {
    universeId,
    rootPageId,
    manifestHash,
    embeddingModel,
    sourceMaxEditedAt,
    holderId,
    leaseToken,
    pages,
    chunks
  };
}

function mapLease(row: LeaseRow): BackstageNotionSyncLease {
  return {
    universeId: normalizeUniverseId(row.universe_id),
    holderId: row.holder_id,
    leaseToken: normalizeUuid(row.lease_token, 'lease_token'),
    acquiredAt: parseDate(row.acquired_at, 'acquired_at'),
    expiresAt: parseDate(row.expires_at, 'expires_at')
  };
}

function mapAuthorityHead(row: AuthorityHeadRow): BackstageNotionAuthorityHead {
  const authority = row.authority;
  if (authority !== 'postgres' && authority !== 'notion') {
    throw new Error('authority is not a supported Backstage Notion authority.');
  }
  const activeSnapshotId = row.active_snapshot_id === null
    ? null
    : normalizeUuid(row.active_snapshot_id, 'active_snapshot_id');
  const rootPageId = row.root_page_id === null
    ? null
    : normalizeUuid(row.root_page_id, 'root_page_id');
  if ((activeSnapshotId === null) !== (rootPageId === null)) {
    throw new Error('Backstage Notion authority head has an incomplete active snapshot reference.');
  }
  if (authority === 'notion' && activeSnapshotId === null) {
    throw new Error('Backstage Notion authority head is missing its active snapshot.');
  }
  return {
    universeId: normalizeUniverseId(row.universe_id),
    authority,
    activeSnapshotId,
    rootPageId
  };
}

function mapSnapshot(row: SnapshotRow): BackstageNotionSnapshotRecord {
  return {
    id: normalizeUuid(row.snapshot_id, 'snapshot_id'),
    universeId: normalizeUniverseId(row.universe_id),
    rootPageId: normalizeUuid(row.root_page_id, 'root_page_id'),
    manifestHash: normalizeSha256(row.manifest_hash, 'manifest_hash'),
    embeddingModel: row.embedding_model,
    pageCount: parseInteger(row.page_count, 'page_count'),
    chunkCount: parseInteger(row.chunk_count, 'chunk_count'),
    sourceMaxEditedAt: row.source_max_edited_at === null
      ? null
      : parseDate(row.source_max_edited_at, 'source_max_edited_at'),
    syncHolderId: row.sync_holder_id,
    createdAt: parseDate(row.snapshot_created_at, 'snapshot_created_at')
  };
}

async function rollbackQuietly(client: PoolClient): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return true;
  } catch {
    return false;
  }
}

export class PostgresBackstageNotionRagRepository implements BackstageNotionRagRepository {
  constructor(private readonly pool: Pool) {}

  async loadAuthorityHead(
    universeId: string
  ): Promise<BackstageNotionAuthorityHead | null> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const result = await this.pool.query<AuthorityHeadRow>(
      `SELECT
         head.universe_id,
         head.authority,
         head.active_snapshot_id,
         snapshot.root_page_id
       FROM backstage_notion_universe_heads AS head
       LEFT JOIN backstage_notion_snapshots AS snapshot
         ON snapshot.universe_id = head.universe_id
        AND snapshot.id = head.active_snapshot_id
       WHERE head.universe_id = $1`,
      [normalizedUniverseId]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const head = mapAuthorityHead(row);
    if (head.universeId !== normalizedUniverseId) {
      throw new Error('Backstage Notion authority head escaped its requested universe scope.');
    }
    return head;
  }

  async acquireSyncLease(
    universeId: string,
    holderId: string,
    ttlMs: number
  ): Promise<BackstageNotionSyncLease | null> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const normalizedHolderId = normalizeRequiredText(holderId, 'holderId', 200);
    const normalizedTtlMs = normalizeInteger(
      ttlMs,
      'ttlMs',
      BACKSTAGE_NOTION_SYNC_LEASE_MIN_MS,
      BACKSTAGE_NOTION_SYNC_LEASE_MAX_MS
    );
    const leaseToken = randomUUID();

    await this.pool.query(
      `INSERT INTO backstage_notion_universe_heads (universe_id)
       VALUES ($1)
       ON CONFLICT (universe_id) DO NOTHING`,
      [normalizedUniverseId]
    );

    const result = await this.pool.query<LeaseRow>(
      `INSERT INTO backstage_notion_sync_leases (
         universe_id,
         holder_id,
         lease_token,
         acquired_at,
         expires_at
       )
       VALUES (
         $1,
         $2,
         $3::UUID,
         clock_timestamp(),
         clock_timestamp() + ($4::BIGINT * INTERVAL '1 millisecond')
       )
       ON CONFLICT (universe_id) DO UPDATE
       SET
         holder_id = EXCLUDED.holder_id,
         lease_token = EXCLUDED.lease_token,
         acquired_at = EXCLUDED.acquired_at,
         expires_at = EXCLUDED.expires_at
       WHERE backstage_notion_sync_leases.expires_at <= clock_timestamp()
          OR backstage_notion_sync_leases.holder_id = EXCLUDED.holder_id
       RETURNING universe_id, holder_id, lease_token, acquired_at, expires_at`,
      [normalizedUniverseId, normalizedHolderId, leaseToken, normalizedTtlMs]
    );

    const row = result.rows[0];
    return row ? mapLease(row) : null;
  }

  async releaseSyncLease(
    universeId: string,
    holderId: string,
    leaseToken: string
  ): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM backstage_notion_sync_leases
       WHERE universe_id = $1
         AND holder_id = $2
         AND lease_token = $3::UUID`,
      [
        normalizeUniverseId(universeId),
        normalizeRequiredText(holderId, 'holderId', 200),
        normalizeUuid(leaseToken, 'leaseToken')
      ]
    );
    return result.rowCount === 1;
  }

  async loadReusableEmbeddings(
    universeId: string,
    embeddingModel: string,
    contentHashes: string[]
  ): Promise<Map<string, number[]>> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const normalizedModel = normalizeRequiredText(embeddingModel, 'embeddingModel', 200);
    if (!Array.isArray(contentHashes) || contentHashes.length > BACKSTAGE_NOTION_MAX_REUSABLE_EMBEDDING_HASHES) {
      throw new Error(
        `contentHashes must contain at most ${BACKSTAGE_NOTION_MAX_REUSABLE_EMBEDDING_HASHES} hashes.`
      );
    }
    const normalizedHashes = [...new Set(contentHashes.map((hash, index) =>
      normalizeSha256(hash, `contentHashes[${index}]`)
    ))];
    if (normalizedHashes.length === 0) {
      return new Map();
    }

    const result = await this.pool.query<ReusableEmbeddingRow>(
      `SELECT DISTINCT ON (chunk.content_hash)
         chunk.content_hash,
         chunk.embedding
       FROM backstage_notion_snapshot_chunks AS chunk
       INNER JOIN backstage_notion_snapshots AS snapshot
         ON snapshot.universe_id = chunk.universe_id
        AND snapshot.id = chunk.snapshot_id
       WHERE chunk.universe_id = $1
         AND chunk.embedding_model = $2
         AND chunk.content_hash = ANY($3::TEXT[])
       ORDER BY
         chunk.content_hash,
         snapshot.created_at DESC,
         snapshot.id DESC,
         chunk.created_at DESC,
         chunk.id DESC`,
      [normalizedUniverseId, normalizedModel, normalizedHashes]
    );

    return new Map(result.rows.map(row => [
      normalizeSha256(row.content_hash, 'content_hash'),
      parseEmbedding(row.embedding, 'embedding')
    ]));
  }

  async markActiveSnapshotVerified(
    universeId: string,
    manifestHash: string,
    lease: Pick<BackstageNotionSyncLease, 'holderId' | 'leaseToken'>
  ): Promise<Date | null> {
    const result = await this.pool.query<{ last_verified_at: TimestampValue }>(
      `UPDATE backstage_notion_universe_heads AS head
       SET
         last_verified_at = clock_timestamp(),
         updated_at = clock_timestamp()
       FROM backstage_notion_snapshots AS snapshot,
            backstage_notion_sync_leases AS lease
       WHERE head.universe_id = $1
         AND head.authority = 'notion'
         AND snapshot.universe_id = head.universe_id
         AND snapshot.id = head.active_snapshot_id
         AND snapshot.manifest_hash = $2
         AND lease.universe_id = head.universe_id
         AND lease.holder_id = $3
         AND lease.lease_token = $4::UUID
         AND lease.expires_at > clock_timestamp()
       RETURNING head.last_verified_at`,
      [
        normalizeUniverseId(universeId),
        normalizeSha256(manifestHash, 'manifestHash'),
        normalizeRequiredText(lease.holderId, 'lease.holderId', 200),
        normalizeUuid(lease.leaseToken, 'lease.leaseToken')
      ]
    );
    const row = result.rows[0];
    return row ? parseDate(row.last_verified_at, 'last_verified_at') : null;
  }

  async activateSnapshot(
    input: ActivateBackstageNotionSnapshotInput
  ): Promise<BackstageNotionSnapshotRecord> {
    const prepared = prepareSnapshotInput(input);
    const snapshotId = randomUUID();
    const client = await this.pool.connect();
    let discardClient = false;

    try {
      await client.query('BEGIN');
      const leaseResult = await client.query<{ universe_id: string }>(
        `SELECT lease.universe_id
         FROM backstage_notion_sync_leases AS lease
         WHERE lease.universe_id = $1
           AND lease.holder_id = $2
           AND lease.lease_token = $3::UUID
           AND lease.expires_at > clock_timestamp()
         FOR UPDATE OF lease`,
         [prepared.universeId, prepared.holderId, prepared.leaseToken]
      );
      if (leaseResult.rows.length !== 1) {
        throw new BackstageNotionSyncLeaseError();
      }

      // Drain every legacy writer before touching the authority head. Legacy
      // DML takes its table lock before the trigger performs a locking head
      // read, so this order prevents a writer/cutover lock inversion.
      await client.query(
        `LOCK TABLE
           backstage_wrestlers,
           backstage_events,
           backstage_story_beats,
           backstage_storylines,
           backstage_canon_heads,
           backstage_canon_revisions,
           backstage_storyline_threads,
           backstage_storyline_participants,
           backstage_storyline_canon_beats
         IN SHARE ROW EXCLUSIVE MODE`
      );

      const epochResult = await client.query(
        `UPDATE backstage_notion_authority_epoch
         SET
           epoch = CASE
             WHEN epoch = 9223372036854775807 THEN 0
             ELSE epoch + 1
           END,
           updated_at = clock_timestamp()
         WHERE singleton = TRUE
         RETURNING epoch`
      );
      if (epochResult.rowCount !== 1) {
        throw new Error('Backstage Notion authority epoch could not be advanced.');
      }

      // Once all legacy writers are drained, exclude authority readers and
      // refreshers until the immutable candidate and its head flip commit.
      // No earlier statement in this transaction touches this table, avoiding
      // an ACCESS SHARE -> ACCESS EXCLUSIVE upgrade deadlock between syncs.
      await client.query(
        'LOCK TABLE backstage_notion_universe_heads IN ACCESS EXCLUSIVE MODE'
      );

      const snapshotResult = await client.query<SnapshotRow>(
        `INSERT INTO backstage_notion_snapshots (
           id,
           universe_id,
           root_page_id,
           manifest_hash,
           embedding_model,
           page_count,
           chunk_count,
           source_max_edited_at,
           sync_holder_id
         )
         VALUES ($1::UUID, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING
           id AS snapshot_id,
           universe_id,
           root_page_id,
           manifest_hash,
           embedding_model,
           page_count,
           chunk_count,
           source_max_edited_at,
           sync_holder_id,
           created_at AS snapshot_created_at`,
        [
          snapshotId,
          prepared.universeId,
          prepared.rootPageId,
          prepared.manifestHash,
          prepared.embeddingModel,
          prepared.pages.length,
          prepared.chunks.length,
          prepared.sourceMaxEditedAt,
          prepared.holderId
        ]
      );

      await client.query(
        `INSERT INTO backstage_notion_snapshot_pages (
           snapshot_id,
           universe_id,
           page_id,
           parent_page_id,
           title,
           canonical_url,
           content_hash,
           markdown,
           source_last_edited_at,
           depth,
           path,
           metadata
         )
         SELECT
           $1::UUID,
           $2,
           page.page_id,
           page.parent_page_id,
           page.title,
           page.canonical_url,
           page.content_hash,
           page.markdown,
           page.source_last_edited_at::TIMESTAMPTZ,
           page.depth,
           page.path,
           page.metadata
         FROM jsonb_to_recordset($3::JSONB) AS page(
           page_id TEXT,
           parent_page_id TEXT,
           title TEXT,
           canonical_url TEXT,
           content_hash TEXT,
           markdown TEXT,
           source_last_edited_at TEXT,
           depth INTEGER,
           path JSONB,
           metadata JSONB
         )`,
        [snapshotId, prepared.universeId, JSON.stringify(prepared.pages)]
      );

      await client.query(
        `INSERT INTO backstage_notion_snapshot_chunks (
           id,
           snapshot_id,
           universe_id,
           page_id,
           ordinal,
           content_hash,
           content,
           code_points,
           embedding_model,
           embedding,
           heading_path,
           metadata
         )
         SELECT
           chunk.chunk_id,
           $1::UUID,
           $2,
           chunk.page_id,
           chunk.ordinal,
           chunk.content_hash,
           chunk.content,
           chunk.code_points,
           $3,
           chunk.embedding,
           chunk.heading_path,
           chunk.metadata
         FROM jsonb_to_recordset($4::JSONB) AS chunk(
           chunk_id TEXT,
           page_id TEXT,
           ordinal INTEGER,
           content_hash TEXT,
           content TEXT,
           code_points INTEGER,
           embedding JSONB,
           heading_path JSONB,
           metadata JSONB
         )`,
        [
          snapshotId,
          prepared.universeId,
          prepared.embeddingModel,
          JSON.stringify(prepared.chunks)
        ]
      );

      const activationResult = await client.query(
        `UPDATE backstage_notion_universe_heads AS head
         SET
           authority = 'notion',
           active_snapshot_id = $2::UUID,
           activated_at = clock_timestamp(),
           last_verified_at = clock_timestamp(),
           updated_at = clock_timestamp()
         FROM backstage_notion_sync_leases AS lease
         WHERE head.universe_id = $1
           AND lease.universe_id = head.universe_id
           AND lease.holder_id = $3
           AND lease.lease_token = $4::UUID
           AND lease.expires_at > clock_timestamp()
           AND (
             head.authority = 'postgres'
             OR EXISTS (
               SELECT 1
               FROM backstage_notion_snapshots AS active_snapshot
               WHERE active_snapshot.universe_id = head.universe_id
                 AND active_snapshot.id = head.active_snapshot_id
                 AND active_snapshot.root_page_id = $5
             )
           )`,
         [
           prepared.universeId,
           snapshotId,
           prepared.holderId,
           prepared.leaseToken,
           prepared.rootPageId
         ]
      );
      if (activationResult.rowCount !== 1) {
        throw new Error('Backstage Notion snapshot head could not be activated.');
      }

      await client.query('COMMIT');
      const snapshotRow = snapshotResult.rows[0];
      if (!snapshotRow) {
        throw new Error('Backstage Notion snapshot insert could not be confirmed.');
      }
      return mapSnapshot(snapshotRow);
    } catch (error) {
      if (!(await rollbackQuietly(client))) {
        discardClient = true;
      }
      throw error;
    } finally {
      client.release(discardClient);
    }
  }

  async loadActiveSnapshot(
    universeId: string,
    maxChunks: number
  ): Promise<BackstageNotionActiveSnapshot | null> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const normalizedMaxChunks = normalizeInteger(
      maxChunks,
      'maxChunks',
      1,
      BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT
    );
    const result = await this.pool.query<ActiveChunkRow>(
      `SELECT
         head.authority,
         head.last_verified_at AS verified_at,
         snapshot.id AS snapshot_id,
         snapshot.universe_id,
         snapshot.root_page_id,
         snapshot.manifest_hash,
         snapshot.embedding_model,
         snapshot.page_count,
         snapshot.chunk_count,
         snapshot.source_max_edited_at,
         snapshot.sync_holder_id,
         snapshot.created_at AS snapshot_created_at,
         chunk.id AS chunk_id,
         chunk.page_id,
         page.title AS page_title,
         page.canonical_url,
         page.path AS page_path,
         chunk.ordinal,
         chunk.content_hash,
         chunk.content,
         chunk.code_points,
         chunk.embedding_model AS chunk_embedding_model,
         chunk.embedding,
         chunk.heading_path,
         chunk.metadata AS chunk_metadata
       FROM backstage_notion_universe_heads AS head
       INNER JOIN backstage_notion_snapshots AS snapshot
         ON snapshot.universe_id = head.universe_id
        AND snapshot.id = head.active_snapshot_id
       INNER JOIN backstage_notion_snapshot_chunks AS chunk
         ON chunk.universe_id = head.universe_id
        AND chunk.snapshot_id = head.active_snapshot_id
       INNER JOIN backstage_notion_snapshot_pages AS page
         ON page.universe_id = chunk.universe_id
        AND page.snapshot_id = chunk.snapshot_id
        AND page.page_id = chunk.page_id
       WHERE head.universe_id = $1
         AND head.authority = 'notion'
       ORDER BY chunk.page_id, chunk.ordinal, chunk.id
       LIMIT $2`,
      [normalizedUniverseId, normalizedMaxChunks + 1]
    );
    if (result.rows.length === 0) {
      return null;
    }

    const rows = result.rows.slice(0, normalizedMaxChunks);
    return {
      authority: 'notion',
      verifiedAt: parseDate(rows[0].verified_at, 'verified_at'),
      snapshot: mapSnapshot(rows[0]),
      chunks: rows.map(row => ({
        id: normalizeSha256(row.chunk_id, 'chunk_id'),
        pageId: normalizeUuid(row.page_id, 'page_id'),
        pageTitle: row.page_title,
        pageUrl: row.canonical_url,
        pagePath: parseStringArray(row.page_path, 'page_path'),
        ordinal: parseInteger(row.ordinal, 'ordinal'),
        contentHash: normalizeSha256(row.content_hash, 'content_hash'),
        content: row.content,
        codePoints: parseInteger(row.code_points, 'code_points'),
        embeddingModel: row.chunk_embedding_model,
        embedding: parseEmbedding(row.embedding, 'embedding'),
        headingPath: parseStringArray(row.heading_path, 'heading_path'),
        metadata: parseJsonObject(row.chunk_metadata, 'chunk_metadata')
      })),
      truncated: result.rows.length > normalizedMaxChunks
    };
  }

  async loadActiveInventory(
    universeId: string
  ): Promise<BackstageNotionActiveInventory | null> {
    const result = await this.pool.query<InventoryRow>(
      `SELECT
         head.authority,
         head.last_verified_at AS verified_at,
         snapshot.id AS snapshot_id,
         snapshot.universe_id,
         snapshot.root_page_id,
         snapshot.manifest_hash,
         snapshot.embedding_model,
         snapshot.page_count,
         snapshot.chunk_count,
         snapshot.source_max_edited_at,
         snapshot.sync_holder_id,
         snapshot.created_at AS snapshot_created_at,
         page.page_id,
         page.parent_page_id,
         page.title,
         page.canonical_url,
         page.content_hash,
         page.source_last_edited_at,
         page.depth,
         page.path,
         page.metadata AS page_metadata
       FROM backstage_notion_universe_heads AS head
       INNER JOIN backstage_notion_snapshots AS snapshot
         ON snapshot.universe_id = head.universe_id
        AND snapshot.id = head.active_snapshot_id
       INNER JOIN backstage_notion_snapshot_pages AS page
         ON page.universe_id = head.universe_id
        AND page.snapshot_id = head.active_snapshot_id
       WHERE head.universe_id = $1
         AND head.authority = 'notion'
       ORDER BY page.depth, page.page_id`,
      [normalizeUniverseId(universeId)]
    );
    if (result.rows.length === 0) {
      return null;
    }
    return {
      authority: 'notion',
      verifiedAt: parseDate(result.rows[0].verified_at, 'verified_at'),
      snapshot: mapSnapshot(result.rows[0]),
      pages: result.rows.map(row => ({
        pageId: normalizeUuid(row.page_id, 'page_id'),
        parentPageId: row.parent_page_id === null
          ? null
          : normalizeUuid(row.parent_page_id, 'parent_page_id'),
        title: row.title,
        canonicalUrl: row.canonical_url,
        contentHash: normalizeSha256(row.content_hash, 'content_hash'),
        sourceLastEditedAt: row.source_last_edited_at === null
          ? null
          : parseDate(row.source_last_edited_at, 'source_last_edited_at'),
        depth: parseInteger(row.depth, 'depth'),
        path: parseStringArray(row.path, 'path'),
        metadata: parseJsonObject(row.page_metadata, 'page_metadata')
      }))
    };
  }
}

export function getBackstageNotionRagRepository(
  pool: Pool | null = getPool()
): BackstageNotionRagRepository {
  if (!pool) {
    throw new BackstageNotionRagRepositoryUnavailableError();
  }
  return new PostgresBackstageNotionRagRepository(pool);
}

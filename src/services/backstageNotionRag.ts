import { createHash, createHmac } from 'node:crypto';

import { isAbortError } from '@arcanos/runtime';
import {
  BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT,
  getBackstageNotionRagRepository,
  type BackstageNotionActiveChunk,
  type BackstageNotionRagRepository,
} from '@core/db/repositories/backstageNotionRagRepository.js';
import { getEnvNumber } from '@platform/runtime/env.js';
import { logger } from '@platform/logging/structuredLogging.js';
import {
  BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION,
  buildBackstageNotionRagUntrustedContextPrompt,
  type BackstageNotionRagCategory,
  type BackstageNotionRagChunk,
} from '@shared/backstage/backstageNotionRagCore.js';
import { cosineSimilarity } from '@shared/vectorUtils.js';
import { timingSafeEqualOpaqueSecret } from '@shared/security/opaqueSecret.js';
import {
  resolveEffectiveBackstageNotionAuthorityRoot,
  type BackstageNotionAuthorityRoot,
} from './backstageNotionAuthority.js';
import {
  isBackstageNotionEnrichmentAuthorized,
  markBackstageNotionEnrichmentUsed,
} from './backstageNotionEnrichmentAuthorization.js';
import {
  createEmbedding,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
} from './openai/embeddings.js';

export {
  BACKSTAGE_NOTION_RAG_SYSTEM_POLICY_PROMPT,
} from '@shared/backstage/backstageNotionRagCore.js';

export const BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS =
  BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT;
export const BACKSTAGE_NOTION_RAG_RETRIEVED_CHUNKS = 12;
export const BACKSTAGE_NOTION_RAG_MAX_CHUNKS_PER_PAGE = 3;
export const BACKSTAGE_NOTION_RAG_MAX_QUERY_CODE_POINTS = 32_000;
export const BACKSTAGE_NOTION_RAG_MAX_STALENESS_ENV_NAME =
  'ARCANOS_BACKSTAGE_NOTION_RAG_MAX_STALENESS_MS';
export const BACKSTAGE_NOTION_RAG_MAX_STALENESS_DEFAULT_MS = 24 * 60 * 60 * 1_000;
export const BACKSTAGE_NOTION_RAG_MAX_STALENESS_MIN_MS = 5 * 60 * 1_000;
export const BACKSTAGE_NOTION_RAG_MAX_STALENESS_MAX_MS = 7 * 24 * 60 * 60 * 1_000;
export const BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_CODE =
  'BACKSTAGE_NOTION_INDEX_UNAVAILABLE';
export const BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_MESSAGE =
  'The authoritative Backstage Notion index is temporarily unavailable.';
export const BACKSTAGE_NOTION_SCOPE_RESOLUTION_ERROR_CODE =
  'BACKSTAGE_NOTION_SCOPE_UNRESOLVED';
export const BACKSTAGE_NOTION_CURSOR_INVALID_ERROR_CODE =
  'BACKSTAGE_NOTION_CURSOR_INVALID';
export const BACKSTAGE_NOTION_CURSOR_INVALID_ERROR_MESSAGE =
  'The Backstage continuity cursor is invalid or no longer applies. Restart the scoped read without a cursor.';
export const BACKSTAGE_NOTION_RAG_CURSOR_VERSION = 1;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/u;
const CATEGORIES = new Set<BackstageNotionRagCategory>([
  'championships',
  'events',
  'general',
  'kayfabe',
  'nxt',
  'raw',
  'roster',
  'smackdown',
  'storylines',
]);

export class BackstageNotionIndexUnavailableError extends Error {
  readonly code = BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_CODE;
  readonly httpStatus = 503;
  readonly retryable = true;

  constructor() {
    super(BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_MESSAGE);
    this.name = 'BackstageNotionIndexUnavailableError';
  }
}

export function isBackstageNotionIndexUnavailableError(
  value: unknown
): value is BackstageNotionIndexUnavailableError {
  return value instanceof BackstageNotionIndexUnavailableError;
}

export type BackstageNotionScopeResolutionReason = 'not_found' | 'ambiguous';

export class BackstageNotionScopeResolutionError extends Error {
  readonly code = BACKSTAGE_NOTION_SCOPE_RESOLUTION_ERROR_CODE;
  readonly httpStatus: number;
  readonly retryable = false;

  constructor(readonly reason: BackstageNotionScopeResolutionReason) {
    super(reason === 'not_found'
      ? 'The requested Backstage Notion scope was not found.'
      : 'The requested Backstage Notion scope is ambiguous.');
    this.name = 'BackstageNotionScopeResolutionError';
    this.httpStatus = reason === 'not_found' ? 404 : 409;
  }
}

export function isBackstageNotionScopeResolutionError(
  value: unknown
): value is BackstageNotionScopeResolutionError {
  return value instanceof BackstageNotionScopeResolutionError;
}

export class BackstageNotionCursorInvalidError extends Error {
  readonly code = BACKSTAGE_NOTION_CURSOR_INVALID_ERROR_CODE;
  readonly httpStatus = 409;
  readonly retryable = false;

  constructor() {
    super(BACKSTAGE_NOTION_CURSOR_INVALID_ERROR_MESSAGE);
    this.name = 'BackstageNotionCursorInvalidError';
  }
}

export function isBackstageNotionCursorInvalidError(
  value: unknown
): value is BackstageNotionCursorInvalidError {
  return value instanceof BackstageNotionCursorInvalidError;
}

export interface BackstageNotionRagRetrievalScope {
  pageTitle: string;
  pagePath?: readonly string[];
  sectionPath?: readonly string[];
}

export type BackstageNotionRagRetrievalMode = 'relevant' | 'complete_scope';

export interface BackstageNotionRagQueryRequest {
  query: string;
  retrievalScope?: BackstageNotionRagRetrievalScope;
  retrievalMode?: BackstageNotionRagRetrievalMode;
  /** Internal compatibility alias while callers migrate to retrievalMode. */
  mode?: BackstageNotionRagRetrievalMode;
  cursor?: string;
}

export type BackstageNotionRagQuery = string | BackstageNotionRagQueryRequest;

export interface BackstageNotionRagRetrievalDependencies {
  repository?: Pick<BackstageNotionRagRepository, 'loadActiveSnapshot'>;
  resolveAuthorityRoot?: (
    universeId: string
  ) => BackstageNotionAuthorityRoot | null | Promise<BackstageNotionAuthorityRoot | null>;
  embedQuery?: (query: string) => Promise<number[]>;
  now?: () => Date;
  maximumStalenessMs?: number;
}

export interface BackstageNotionRagCitation {
  pageId: string;
  pageTitle: string;
  pagePath: string[];
  headingPath: string[];
  category: BackstageNotionRagCategory;
  chunkId: string;
  contentHash: string;
}

export interface BackstageNotionRagResolvedScope {
  pageTitle: string;
  pagePath: string[];
  sectionPath?: string[];
}

export interface BackstageNotionRagCoverage {
  status: 'complete' | 'sampled';
  scopeChunks: number;
  selectedChunks: number;
  omittedChunks: number;
  promptTruncated: boolean;
  exhaustive: boolean;
  hasMore: boolean;
  nextCursor?: string;
}

export interface BackstageNotionRagRetrieval {
  universeId: string;
  snapshotId: string;
  verifiedAt: Date;
  prompt: string;
  chunkCount: number;
  truncated: boolean;
  retrievalMode: BackstageNotionRagRetrievalMode;
  resolvedScope: BackstageNotionRagResolvedScope | null;
  coverage: BackstageNotionRagCoverage;
  nextCursor: string | null;
  citations: BackstageNotionRagCitation[];
}

interface NormalizedRetrievalScope {
  pageTitle: string;
  pagePath?: readonly string[];
  sectionPath?: readonly string[];
}

interface NormalizedQueryRequest {
  query: string;
  bindingQuery: string;
  retrievalScope?: NormalizedRetrievalScope;
  retrievalMode: BackstageNotionRagRetrievalMode;
  cursor?: string;
}

interface ResolvedScopedChunks {
  chunks: RankedChunk[];
  scope: BackstageNotionRagResolvedScope;
}

interface CursorPayloadBody {
  v: number;
  snapshotId: string;
  requestBinding: string;
  offset: number;
}

interface CursorPayload extends CursorPayloadBody {
  mac: string;
}

interface RankedChunk {
  chunk: BackstageNotionRagChunk;
  active: BackstageNotionActiveChunk;
  score: number;
}

function resolveMaximumStalenessMs(value: number | undefined): number {
  const candidate = value ?? getEnvNumber(
    BACKSTAGE_NOTION_RAG_MAX_STALENESS_ENV_NAME,
    BACKSTAGE_NOTION_RAG_MAX_STALENESS_DEFAULT_MS
  );
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return BACKSTAGE_NOTION_RAG_MAX_STALENESS_DEFAULT_MS;
  }
  return Math.max(
    BACKSTAGE_NOTION_RAG_MAX_STALENESS_MIN_MS,
    Math.min(BACKSTAGE_NOTION_RAG_MAX_STALENESS_MAX_MS, Math.trunc(candidate))
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function compareDeterministicText(left: string, right: string): number {
  const leftCodePoints = Array.from(left, character => (
    character.codePointAt(0) ?? 0
  ));
  const rightCodePoints = Array.from(right, character => (
    character.codePointAt(0) ?? 0
  ));
  const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftCodePoints[index] ?? 0) - (rightCodePoints[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftCodePoints.length - rightCodePoints.length;
}

function compareDeterministicPath(
  left: readonly string[],
  right: readonly string[]
): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = compareDeterministicText(
      left[index] ?? '',
      right[index] ?? ''
    );
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

function isSafeIndexedMetadataSegment(value: unknown): value is string {
  return typeof value === 'string'
    && Boolean(value.trim())
    && codePointLength(value) <= 500
    && !/[<>\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u
      .test(value);
}

function normalizedMatchText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

function normalizedScopeSegment(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return normalized && codePointLength(normalized) <= 500 ? normalized : null;
}

function normalizeScopePath(
  value: unknown,
  maximumSegments: number
): readonly string[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumSegments) {
    return null;
  }
  const normalized = value.map(normalizedScopeSegment);
  return normalized.some(segment => segment === null)
    ? null
    : Object.freeze(normalized as string[]);
}

function normalizeQueryRequest(input: BackstageNotionRagQuery): NormalizedQueryRequest {
  if (typeof input === 'string') {
    const query = input.trim();
    return {
      query,
      bindingQuery: normalizedMatchText(query),
      retrievalMode: 'relevant',
    };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BackstageNotionIndexUnavailableError();
  }
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  const requestedMode = input.retrievalMode ?? input.mode ?? 'relevant';
  if (
    (input.retrievalMode !== undefined && input.mode !== undefined
      && input.retrievalMode !== input.mode)
    || (requestedMode !== 'relevant' && requestedMode !== 'complete_scope')
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }
  let retrievalScope: NormalizedRetrievalScope | undefined;
  if (input.retrievalScope !== undefined) {
    if (
      !input.retrievalScope
      || typeof input.retrievalScope !== 'object'
      || Array.isArray(input.retrievalScope)
    ) {
      throw new BackstageNotionIndexUnavailableError();
    }
    const pageTitle = normalizedScopeSegment(input.retrievalScope.pageTitle);
    const pagePath = normalizeScopePath(input.retrievalScope.pagePath, 101);
    const sectionPath = normalizeScopePath(input.retrievalScope.sectionPath, 32);
    if (!pageTitle || pagePath === null || sectionPath === null) {
      throw new BackstageNotionIndexUnavailableError();
    }
    retrievalScope = {
      pageTitle,
      ...(pagePath ? { pagePath } : {}),
      ...(sectionPath ? { sectionPath } : {}),
    };
  }
  if (input.cursor !== undefined && (
    requestedMode !== 'complete_scope'
    || typeof input.cursor !== 'string'
    || !CURSOR_PATTERN.test(input.cursor)
  )) {
    throw new BackstageNotionCursorInvalidError();
  }
  return {
    query,
    bindingQuery: normalizedMatchText(query),
    ...(retrievalScope ? { retrievalScope } : {}),
    retrievalMode: requestedMode,
    ...(input.cursor ? { cursor: input.cursor } : {}),
  };
}

function pathsMatch(
  requested: readonly string[],
  candidate: readonly string[]
): boolean {
  return requested.length === candidate.length
    && requested.every((segment, index) => (
      normalizedMatchText(segment) === normalizedMatchText(candidate[index] ?? '')
    ));
}

function pathStartsWith(
  candidate: readonly string[],
  requestedPrefix: readonly string[]
): boolean {
  return requestedPrefix.length <= candidate.length
    && requestedPrefix.every((segment, index) => (
      normalizedMatchText(segment) === normalizedMatchText(candidate[index] ?? '')
    ));
}

function requestBinding(request: NormalizedQueryRequest): string {
  return sha256(JSON.stringify({
    v: BACKSTAGE_NOTION_RAG_CURSOR_VERSION,
    query: request.bindingQuery,
    retrievalMode: request.retrievalMode,
    retrievalScope: request.retrievalScope
      ? {
          pageTitle: normalizedMatchText(request.retrievalScope.pageTitle),
          pagePath: request.retrievalScope.pagePath?.map(normalizedMatchText),
          sectionPath: request.retrievalScope.sectionPath?.map(normalizedMatchText),
        }
      : null,
  }));
}

function buildCursorSigningKey(input: {
  universeId: string;
  snapshotId: string;
  manifestHash: string;
  rootPageId: string;
}): string {
  return sha256(JSON.stringify({
    format: 'backstage-notion-rag-cursor-key-v1',
    ...input,
  }));
}

function signCursorPayload(payload: CursorPayloadBody, signingKey: string): string {
  return createHmac('sha256', signingKey)
    .update(JSON.stringify(payload), 'utf8')
    .digest('base64url');
}

function encodeCursor(payload: CursorPayloadBody, signingKey: string): string {
  return Buffer.from(JSON.stringify({
    ...payload,
    mac: signCursorPayload(payload, signingKey),
  } satisfies CursorPayload), 'utf8').toString('base64url');
}

function decodeCursor(
  cursor: string | undefined,
  snapshotId: string,
  binding: string,
  maximumOffset: number,
  signingKey: string
): number {
  if (!cursor) {
    return 0;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new BackstageNotionCursorInvalidError();
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',')
      !== 'mac,offset,requestBinding,snapshotId,v'
    || (parsed as Partial<CursorPayload>).v !== BACKSTAGE_NOTION_RAG_CURSOR_VERSION
    || (parsed as Partial<CursorPayload>).snapshotId !== snapshotId
    || (parsed as Partial<CursorPayload>).requestBinding !== binding
    || !Number.isSafeInteger((parsed as Partial<CursorPayload>).offset)
    || typeof (parsed as Partial<CursorPayload>).mac !== 'string'
  ) {
    throw new BackstageNotionCursorInvalidError();
  }
  const candidate = parsed as CursorPayload;
  const payload: CursorPayloadBody = {
    v: candidate.v,
    snapshotId: candidate.snapshotId,
    requestBinding: candidate.requestBinding,
    offset: candidate.offset,
  };
  if (!timingSafeEqualOpaqueSecret(
    candidate.mac,
    signCursorPayload(payload, signingKey)
  )) {
    throw new BackstageNotionCursorInvalidError();
  }
  const offset = candidate.offset;
  if (offset < 0 || offset >= maximumOffset) {
    throw new BackstageNotionCursorInvalidError();
  }
  return offset;
}

function isFiniteNonzeroVector(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 8192
    && value.every(component => typeof component === 'number' && Number.isFinite(component))
    && value.some(component => component !== 0);
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase('en-US')
      .split(/[^\p{L}\p{N}]+/u)
      .filter(token => token.length >= 3)
      .slice(0, 256)
  );
}

function lexicalBoost(queryTokens: ReadonlySet<string>, chunk: BackstageNotionActiveChunk): number {
  if (queryTokens.size === 0) {
    return 0;
  }
  const chunkTokens = tokenize([
    chunk.pageTitle,
    ...chunk.pagePath,
    ...chunk.headingPath,
    typeof chunk.metadata.category === 'string' ? chunk.metadata.category : '',
    Array.from(chunk.content).slice(0, 600).join(''),
  ].join(' '));
  let overlap = 0;
  for (const token of queryTokens) {
    if (chunkTokens.has(token)) {
      overlap += 1;
    }
  }
  return Math.min(0.12, (overlap / Math.max(1, queryTokens.size)) * 0.12);
}

function mapCategory(value: unknown): BackstageNotionRagCategory {
  if (typeof value !== 'string' || !CATEGORIES.has(value as BackstageNotionRagCategory)) {
    throw new BackstageNotionIndexUnavailableError();
  }
  return value as BackstageNotionRagCategory;
}

function mapActiveChunk(active: BackstageNotionActiveChunk): BackstageNotionRagChunk {
  const sourceHash = active.metadata.sourceHash;
  const sourceLastEditedAt = active.metadata.sourceLastEditedAt;
  const headingOccurrencePath = active.metadata.headingOccurrencePath;
  const expectedChunkId = sha256(JSON.stringify({
    format: 'backstage-notion-rag-chunk-v1',
    pageId: active.pageId,
    ordinal: active.ordinal,
    contentHash: active.contentHash,
  }));
  if (
    !SHA256_PATTERN.test(active.id)
    || active.id !== expectedChunkId
    || !SHA256_PATTERN.test(active.contentHash)
    || active.contentHash !== sha256(active.content)
    || typeof sourceHash !== 'string'
    || !SHA256_PATTERN.test(sourceHash)
    || active.embeddingModel !== DEFAULT_OPENAI_EMBEDDING_MODEL
    || !UUID_PATTERN.test(active.pageId)
    || !Number.isSafeInteger(active.ordinal)
    || active.ordinal < 0
    || !active.content.trim()
    || active.codePoints !== codePointLength(active.content)
    || !isSafeIndexedMetadataSegment(active.pageTitle)
    || active.pagePath.length < 1
    || active.pagePath.length > 101
    || active.pagePath.some(segment => !isSafeIndexedMetadataSegment(segment))
    || !Array.isArray(active.headingPath)
    || active.headingPath.length > 32
    || active.headingPath.some(segment => (
      !isSafeIndexedMetadataSegment(segment)
    ))
    || active.metadata.headingIndexVersion !== BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION
    || !Array.isArray(headingOccurrencePath)
    || headingOccurrencePath.length !== active.headingPath.length
    || headingOccurrencePath.some(occurrence => (
      !Number.isSafeInteger(occurrence) || occurrence < 1
    ))
    || (
      sourceLastEditedAt !== null
      && (
        typeof sourceLastEditedAt !== 'string'
        || !UTC_TIMESTAMP_PATTERN.test(sourceLastEditedAt)
      )
    )
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }
  return {
    chunkId: active.id,
    universeId: '',
    pageId: active.pageId,
    parentPageId: null,
    title: active.pageTitle,
    path: active.pagePath,
    headingPath: active.headingPath,
    headingOccurrencePath: headingOccurrencePath as number[],
    category: mapCategory(active.metadata.category),
    ordinal: active.ordinal,
    content: active.content,
    codePoints: active.codePoints,
    contentHash: active.contentHash,
    sourceHash,
    sourceLastEditedAt,
  };
}

function validatePageMetadataConsistency(chunks: readonly RankedChunk[]): void {
  const metadataByPage = new Map<string, string>();
  for (const candidate of chunks) {
    const signature = JSON.stringify({
      title: candidate.active.pageTitle,
      path: candidate.active.pagePath,
    });
    const prior = metadataByPage.get(candidate.active.pageId);
    if (prior !== undefined && prior !== signature) {
      throw new BackstageNotionIndexUnavailableError();
    }
    metadataByPage.set(candidate.active.pageId, signature);
  }
}

function resolveScopedChunks(
  chunks: readonly RankedChunk[],
  requested: NormalizedRetrievalScope
): ResolvedScopedChunks {
  const pages = new Map<string, RankedChunk[]>();
  for (const candidate of chunks) {
    if (
      normalizedMatchText(candidate.active.pageTitle)
        !== normalizedMatchText(requested.pageTitle)
      || (
        requested.pagePath
        && !pathsMatch(requested.pagePath, candidate.active.pagePath)
      )
    ) {
      continue;
    }
    const pageChunks = pages.get(candidate.active.pageId) ?? [];
    pageChunks.push(candidate);
    pages.set(candidate.active.pageId, pageChunks);
  }
  if (pages.size === 0) {
    throw new BackstageNotionScopeResolutionError('not_found');
  }
  if (pages.size > 1) {
    throw new BackstageNotionScopeResolutionError('ambiguous');
  }

  const pageChunks = [...pages.values()][0] ?? [];
  const representative = pageChunks[0];
  if (!representative) {
    throw new BackstageNotionScopeResolutionError('not_found');
  }
  let scopedChunks = pageChunks;
  let resolvedSectionPath: string[] | undefined;
  if (requested.sectionPath) {
    scopedChunks = pageChunks.filter(candidate => (
      pathStartsWith(candidate.active.headingPath, requested.sectionPath ?? [])
    ));
    if (scopedChunks.length === 0) {
      throw new BackstageNotionScopeResolutionError('not_found');
    }
    const occurrences = new Set(scopedChunks.map(candidate => (
      JSON.stringify(candidate.chunk.headingOccurrencePath.slice(
        0,
        requested.sectionPath?.length ?? 0
      ))
    )));
    if (occurrences.size > 1) {
      throw new BackstageNotionScopeResolutionError('ambiguous');
    }
    const canonicalHeadingPath = scopedChunks[0]?.active.headingPath ?? [];
    resolvedSectionPath = canonicalHeadingPath.slice(0, requested.sectionPath.length);
  }

  return {
    chunks: scopedChunks,
    scope: {
      pageTitle: representative.active.pageTitle,
      pagePath: [...representative.active.pagePath],
      ...(resolvedSectionPath ? { sectionPath: resolvedSectionPath } : {}),
    },
  };
}

function selectDiversifiedChunks(ranked: readonly RankedChunk[]): RankedChunk[] {
  const selected: RankedChunk[] = [];
  const pageCounts = new Map<string, number>();
  for (const candidate of ranked) {
    if (selected.length >= BACKSTAGE_NOTION_RAG_RETRIEVED_CHUNKS) {
      break;
    }
    const count = pageCounts.get(candidate.active.pageId) ?? 0;
    if (count >= BACKSTAGE_NOTION_RAG_MAX_CHUNKS_PER_PAGE) {
      continue;
    }
    selected.push(candidate);
    pageCounts.set(candidate.active.pageId, count + 1);
  }
  return selected;
}

function sortByPageOrdinal(chunks: readonly RankedChunk[]): RankedChunk[] {
  return [...chunks].sort((left, right) => (
    compareDeterministicPath(left.active.pagePath, right.active.pagePath)
    || compareDeterministicText(left.active.pageTitle, right.active.pageTitle)
    || left.active.ordinal - right.active.ordinal
    || compareDeterministicText(left.active.id, right.active.id)
  ));
}

async function retrieveBackstageNotionRagContextUnsafe(
  universeId: string,
  query: BackstageNotionRagQuery,
  dependencies: BackstageNotionRagRetrievalDependencies = {}
): Promise<BackstageNotionRagRetrieval> {
  const request = normalizeQueryRequest(query);
  if (
    !isBackstageNotionEnrichmentAuthorized()
    || !request.query
    || codePointLength(request.query) > BACKSTAGE_NOTION_RAG_MAX_QUERY_CODE_POINTS
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }
  const authorityRoot = await (
    dependencies.resolveAuthorityRoot ?? resolveEffectiveBackstageNotionAuthorityRoot
  )(universeId);
  if (!authorityRoot || authorityRoot.universeId !== universeId) {
    throw new BackstageNotionIndexUnavailableError();
  }

  const repository = dependencies.repository ?? getBackstageNotionRagRepository();
  const active = await repository.loadActiveSnapshot(
    universeId,
    BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS
  );
  const now = dependencies.now?.() ?? new Date();
  const maximumStalenessMs = resolveMaximumStalenessMs(
    dependencies.maximumStalenessMs
  );
  if (
    !active
    || active.authority !== 'notion'
    || active.truncated
    || active.snapshot.universeId !== universeId
    || active.snapshot.rootPageId !== authorityRoot.rootPageId
    || active.snapshot.embeddingModel !== DEFAULT_OPENAI_EMBEDDING_MODEL
    || !UUID_PATTERN.test(active.snapshot.id)
    || !SHA256_PATTERN.test(active.snapshot.manifestHash)
    || !Number.isSafeInteger(active.snapshot.pageCount)
    || active.snapshot.pageCount < 1
    || !Number.isSafeInteger(active.snapshot.chunkCount)
    || active.snapshot.chunkCount !== active.chunks.length
    || !Number.isFinite(now.getTime())
    || !Number.isFinite(active.verifiedAt.getTime())
    || !Number.isFinite(active.snapshot.createdAt.getTime())
    || active.verifiedAt.getTime() < active.snapshot.createdAt.getTime()
    || now.getTime() - active.verifiedAt.getTime() > maximumStalenessMs
    || active.verifiedAt.getTime() - now.getTime() > 5 * 60 * 1_000
    || active.chunks.length < 1
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }

  const validatedChunks = active.chunks.map((chunk): RankedChunk => {
    if (!isFiniteNonzeroVector(chunk.embedding)) {
      throw new BackstageNotionIndexUnavailableError();
    }
    return {
      active: chunk,
      chunk: { ...mapActiveChunk(chunk), universeId },
      score: 0,
    };
  });
  const embeddingDimensions = validatedChunks[0]?.active.embedding.length;
  if (
    embeddingDimensions === undefined
    || validatedChunks.some(candidate => (
      candidate.active.embedding.length !== embeddingDimensions
    ))
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }
  validatePageMetadataConsistency(validatedChunks);

  const resolved = request.retrievalScope
    ? resolveScopedChunks(validatedChunks, request.retrievalScope)
    : null;
  const scopeCandidates = resolved?.chunks ?? validatedChunks;
  let selected: RankedChunk[];
  let offset = 0;
  const binding = requestBinding(request);
  const cursorSigningKey = buildCursorSigningKey({
    universeId,
    snapshotId: active.snapshot.id,
    manifestHash: active.snapshot.manifestHash,
    rootPageId: authorityRoot.rootPageId,
  });
  if (request.retrievalMode === 'complete_scope') {
    const ordered = sortByPageOrdinal(scopeCandidates);
    offset = decodeCursor(
      request.cursor,
      active.snapshot.id,
      binding,
      ordered.length,
      cursorSigningKey
    );
    selected = ordered.slice(
      offset,
      offset + BACKSTAGE_NOTION_RAG_RETRIEVED_CHUNKS
    );
  } else {
    const queryEmbedding = await (dependencies.embedQuery ?? createEmbedding)(request.query);
    if (
      !isFiniteNonzeroVector(queryEmbedding)
      || queryEmbedding.length !== embeddingDimensions
    ) {
      throw new BackstageNotionIndexUnavailableError();
    }
    const queryTokens = tokenize(request.query);
    const ranked = scopeCandidates.map((candidate): RankedChunk => {
      const score = cosineSimilarity(queryEmbedding, candidate.active.embedding)
        + lexicalBoost(queryTokens, candidate.active);
      if (!Number.isFinite(score)) {
        throw new BackstageNotionIndexUnavailableError();
      }
      return { ...candidate, score };
    }).sort((left, right) => (
      right.score - left.score
      || compareDeterministicText(left.active.pageId, right.active.pageId)
      || left.active.ordinal - right.active.ordinal
      || compareDeterministicText(left.active.id, right.active.id)
    ));
    selected = resolved
      ? ranked.slice(0, BACKSTAGE_NOTION_RAG_RETRIEVED_CHUNKS)
      : selectDiversifiedChunks(ranked);
  }
  const promptContext = buildBackstageNotionRagUntrustedContextPrompt(
    selected.map(candidate => candidate.chunk),
    { maximumChunks: BACKSTAGE_NOTION_RAG_RETRIEVED_CHUNKS }
  );
  if (promptContext.chunkCount < 1) {
    throw new BackstageNotionIndexUnavailableError();
  }

  const selectedForPrompt = selected.slice(0, promptContext.chunkCount);
  const completedPromptChunks = promptContext.chunkCount
    - (promptContext.partialChunk ? 1 : 0);
  if (
    request.retrievalMode === 'complete_scope'
    && promptContext.partialChunk
    && completedPromptChunks < 1
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }
  const nextOffset = offset + completedPromptChunks;
  const hasMore = request.retrievalMode === 'complete_scope'
    && nextOffset < scopeCandidates.length;
  const nextCursor = hasMore
    ? encodeCursor({
        v: BACKSTAGE_NOTION_RAG_CURSOR_VERSION,
        snapshotId: active.snapshot.id,
        requestBinding: binding,
        offset: nextOffset,
      }, cursorSigningKey)
    : null;
  const exhaustive = request.retrievalMode === 'complete_scope'
    && offset === 0
    && !hasMore
    && !promptContext.truncated;
  const omittedChunks = Math.max(
    0,
    scopeCandidates.length - promptContext.chunkCount
  );
  const coverage: BackstageNotionRagCoverage = {
    status: exhaustive ? 'complete' : 'sampled',
    scopeChunks: scopeCandidates.length,
    selectedChunks: promptContext.chunkCount,
    omittedChunks,
    promptTruncated: promptContext.truncated,
    exhaustive,
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
  };

  try {
    markBackstageNotionEnrichmentUsed();
  } catch {
    throw new BackstageNotionIndexUnavailableError();
  }
  try {
    logger.info('backstage.notion_rag.retrieved', {
      universeId,
      snapshotId: active.snapshot.id,
      candidateChunks: active.chunks.length,
      scopeChunks: scopeCandidates.length,
      retrievedChunks: promptContext.chunkCount,
      retrievalMode: request.retrievalMode,
      scoped: resolved !== null,
      corpusOmitted: omittedChunks > 0,
      promptTruncated: promptContext.truncated,
      hasMore,
    });
  } catch {
    // Retrieval diagnostics must never disclose or alter authoritative content.
  }
  return {
    universeId,
    snapshotId: active.snapshot.id,
    verifiedAt: active.verifiedAt,
    prompt: promptContext.prompt,
    chunkCount: promptContext.chunkCount,
    truncated: omittedChunks > 0 || promptContext.truncated,
    retrievalMode: request.retrievalMode,
    resolvedScope: resolved?.scope ?? null,
    coverage,
    nextCursor,
    citations: selectedForPrompt.map(({ active: chunk }) => ({
      pageId: chunk.pageId,
      pageTitle: chunk.pageTitle,
      pagePath: [...chunk.pagePath],
      headingPath: [...chunk.headingPath],
      category: mapCategory(chunk.metadata.category),
      chunkId: chunk.id,
      contentHash: chunk.contentHash,
    })),
  };
}

/**
 * Retrieve bounded, snapshot-consistent Notion authority context for one
 * request. Dependency and projection failures are deliberately collapsed to a
 * fixed retryable outage so provider, database, and indexed content details
 * cannot escape through dispatcher logs or public error envelopes.
 */
export async function retrieveBackstageNotionRagContext(
  universeId: string,
  query: BackstageNotionRagQuery,
  dependencies: BackstageNotionRagRetrievalDependencies = {}
): Promise<BackstageNotionRagRetrieval> {
  try {
    return await retrieveBackstageNotionRagContextUnsafe(
      universeId,
      query,
      dependencies
    );
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

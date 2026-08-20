import { createHash, createHmac } from 'node:crypto';

import { isAbortError } from '@arcanos/runtime';
import {
  BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT,
  BACKSTAGE_NOTION_MAX_PAGES_PER_SNAPSHOT,
  getBackstageNotionRagRepository,
  type BackstageNotionActiveChunk,
  type BackstageNotionActiveChunkMetadata,
  type BackstageNotionActiveSnapshot,
  type BackstageNotionActiveSnapshotHeader,
  type BackstageNotionRagRepository,
  type BackstageNotionSnapshotChunkPageSelector,
  type BackstageNotionSnapshotScopeLookup,
  type BackstageNotionSnapshotScopeResolution,
} from '@core/db/repositories/backstageNotionRagRepository.js';
import { getEnvNumber } from '@platform/runtime/env.js';
import { logger } from '@platform/logging/structuredLogging.js';
import {
  BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION,
  buildBackstageNotionRagUntrustedContextPrompt,
  type BackstageNotionRagCategory,
  type BackstageNotionRagChunk,
} from '@shared/backstage/backstageNotionRagCore.js';
import {
  normalizeBackstageNotionScopeKey,
  normalizeBackstageNotionScopePath,
} from '@shared/backstage/backstageNotionScopeIndex.js';
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
export const BACKSTAGE_NOTION_RAG_CURSOR_VERSION = 3;

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
  scopeKind?: BackstageNotionRagScopeKind;
}

export type BackstageNotionRagScopeKind = 'page' | 'subtree';
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
  repository?: Pick<
    BackstageNotionRagRepository,
    | 'loadActiveSnapshot'
    | 'loadActiveSnapshotHeader'
    | 'resolveSnapshotScope'
    | 'loadSnapshotChunkPage'
  >;
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
  scopeKind?: 'subtree';
}

interface BackstageNotionRagCoverageBase {
  status: 'complete' | 'sampled';
  scopeChunks: number;
  selectedChunks: number;
  omittedChunks: number;
  promptTruncated: boolean;
  exhaustive: boolean;
  hasMore: boolean;
  nextCursor?: string;
}

export type BackstageNotionRagCoverage = BackstageNotionRagCoverageBase & (
  | {
      scopePages?: never;
      selectedPages?: never;
      omittedPages?: never;
    }
  | {
      scopePages: number;
      selectedPages: number;
      omittedPages: number;
    }
);

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

interface NormalizedRetrievalScopeBase {
  pageTitle: string;
  pagePath?: readonly string[];
}

interface NormalizedPageRetrievalScope extends NormalizedRetrievalScopeBase {
  sectionPath?: readonly string[];
  scopeKind: 'page';
}

interface NormalizedSubtreeRetrievalScope extends NormalizedRetrievalScopeBase {
  sectionPath?: never;
  scopeKind: 'subtree';
}

type NormalizedRetrievalScope =
  | NormalizedPageRetrievalScope
  | NormalizedSubtreeRetrievalScope;

interface BindingRetrievalScope {
  pageTitle: string;
  pagePath?: readonly string[];
  sectionPath?: readonly string[];
  scopeKind?: BackstageNotionRagScopeKind;
}

interface NormalizedQueryRequest {
  query: string;
  bindingQuery: string;
  retrievalScope?: NormalizedRetrievalScope;
  bindingRetrievalScope?: BindingRetrievalScope;
  retrievalMode: BackstageNotionRagRetrievalMode;
  cursor?: string;
}

interface ScopeCandidate {
  active: BackstageNotionActiveChunkMetadata;
  headingOccurrencePath: number[];
  category: BackstageNotionRagCategory;
  sourceHash: string;
  sourceLastEditedAt: string | null;
}

interface ResolvedScopedChunks<T extends ScopeCandidate> {
  chunks: T[];
  scope: BackstageNotionRagResolvedScope;
  selector: BackstageNotionSnapshotChunkPageSelector;
}

interface CursorPayloadBody {
  v: number;
  snapshotId: string;
  requestBinding: string;
  scopeKind: 'all' | BackstageNotionRagScopeKind;
  scopeChunkCount: number;
  scopePageCount: number;
  offset: number;
}

interface CursorPayload extends CursorPayloadBody {
  mac: string;
}

interface DecodedCursor {
  offset: number;
  scopeKind: 'all' | BackstageNotionRagScopeKind;
  scopeChunkCount: number;
  scopePageCount: number;
}

interface SelectedChunk extends ScopeCandidate {
  chunk: BackstageNotionRagChunk;
  score: number;
}

interface RankedChunk extends SelectedChunk {
  active: BackstageNotionActiveChunk;
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
    character.codePointAt(0)!
  ));
  const rightCodePoints = Array.from(right, character => (
    character.codePointAt(0)!
  ));
  const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftCodePoints[index]! - rightCodePoints[index]!;
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
      left[index]!,
      right[index]!
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

function normalizedScopeSegment(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function exactScopeSegment(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return value.trim() && codePointLength(value) <= 500 ? value : null;
}

function exactScopePath(
  value: unknown,
  maximumSegments: number
): readonly string[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumSegments) {
    return null;
  }
  const exact = value.map(exactScopeSegment);
  return exact.some(segment => segment === null)
    ? null
    : Object.freeze(exact as string[]);
}

function normalizeQueryRequest(input: BackstageNotionRagQuery): NormalizedQueryRequest {
  if (typeof input === 'string') {
    const query = input.trim();
    return {
      query,
      bindingQuery: input,
      retrievalMode: 'relevant',
    };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BackstageNotionIndexUnavailableError();
  }
  const bindingQuery = typeof input.query === 'string' ? input.query : '';
  const query = bindingQuery.trim();
  const requestedMode = input.retrievalMode ?? input.mode ?? 'relevant';
  if (
    (input.retrievalMode !== undefined && input.mode !== undefined
      && input.retrievalMode !== input.mode)
    || (requestedMode !== 'relevant' && requestedMode !== 'complete_scope')
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }
  let retrievalScope: NormalizedRetrievalScope | undefined;
  let bindingRetrievalScope: BindingRetrievalScope | undefined;
  if (input.retrievalScope !== undefined) {
    if (
      !input.retrievalScope
      || typeof input.retrievalScope !== 'object'
      || Array.isArray(input.retrievalScope)
    ) {
      throw new BackstageNotionIndexUnavailableError();
    }
    const bindingPageTitle = exactScopeSegment(input.retrievalScope.pageTitle);
    const bindingPagePath = exactScopePath(input.retrievalScope.pagePath, 101);
    const bindingSectionPath = exactScopePath(input.retrievalScope.sectionPath, 32);
    const bindingScopeKind = input.retrievalScope.scopeKind;
    const scopeKind = bindingScopeKind ?? 'page';
    const pageTitle = bindingPageTitle
      ? normalizedScopeSegment(bindingPageTitle)
      : null;
    const pagePath = bindingPagePath?.map(normalizedScopeSegment);
    const sectionPath = bindingSectionPath?.map(normalizedScopeSegment);
    if (
      !bindingPageTitle
      || bindingPagePath === null
      || bindingSectionPath === null
      || (scopeKind !== 'page' && scopeKind !== 'subtree')
      || (scopeKind === 'subtree' && bindingSectionPath !== undefined)
      || !pageTitle
      || pagePath?.some(segment => !segment)
      || sectionPath?.some(segment => !segment)
    ) {
      throw new BackstageNotionIndexUnavailableError();
    }
    retrievalScope = scopeKind === 'subtree'
      ? {
          pageTitle,
          ...(pagePath ? { pagePath: pagePath as string[] } : {}),
          scopeKind,
        }
      : {
          pageTitle,
          ...(pagePath ? { pagePath: pagePath as string[] } : {}),
          ...(sectionPath ? { sectionPath: sectionPath as string[] } : {}),
          scopeKind,
        };
    bindingRetrievalScope = {
      pageTitle: bindingPageTitle,
      ...(bindingPagePath ? { pagePath: bindingPagePath } : {}),
      ...(bindingSectionPath ? { sectionPath: bindingSectionPath } : {}),
      ...(bindingScopeKind ? { scopeKind: bindingScopeKind } : {}),
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
    bindingQuery,
    ...(retrievalScope ? { retrievalScope } : {}),
    ...(bindingRetrievalScope ? { bindingRetrievalScope } : {}),
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
      normalizeBackstageNotionScopeKey(segment)
        === normalizeBackstageNotionScopeKey(candidate[index] ?? '')
    ));
}

function pathStartsWith(
  candidate: readonly string[],
  requestedPrefix: readonly string[]
): boolean {
  return requestedPrefix.length <= candidate.length
    && requestedPrefix.every((segment, index) => (
      normalizeBackstageNotionScopeKey(segment)
        === normalizeBackstageNotionScopeKey(candidate[index] ?? '')
    ));
}

function buildSnapshotScopeLookup(
  requested: NormalizedRetrievalScope
): BackstageNotionSnapshotScopeLookup {
  return {
    pageTitleKey: normalizeBackstageNotionScopeKey(requested.pageTitle),
    pagePathKey: requested.pagePath
      ? normalizeBackstageNotionScopePath(requested.pagePath)
      : null,
    sectionPathKey: requested.sectionPath
      ? normalizeBackstageNotionScopePath(requested.sectionPath)
      : null,
    scopeKind: requested.scopeKind,
  };
}

function validateResolvedSnapshotScope(
  resolution: Extract<BackstageNotionSnapshotScopeResolution, { status: 'resolved' }>,
  requested: NormalizedRetrievalScope,
  snapshotChunkCount: number,
  snapshotPageCount: number
): {
  scope: BackstageNotionRagResolvedScope;
  selector: BackstageNotionSnapshotChunkPageSelector;
  scopeChunkCount: number;
  scopePageCount: number;
} {
  const sectionOccurrencePath = resolution.selector.sectionOccurrencePath;
  if (
    !isSafeIndexedMetadataSegment(resolution.pageTitle)
    || resolution.pagePath.length < 1
    || resolution.pagePath.length > 101
    || resolution.pagePath.some(segment => !isSafeIndexedMetadataSegment(segment))
    || normalizeBackstageNotionScopeKey(resolution.pageTitle)
      !== normalizeBackstageNotionScopeKey(requested.pageTitle)
    || (
      requested.pagePath
      && !pathsMatch(requested.pagePath, resolution.pagePath)
    )
    || !UUID_PATTERN.test(resolution.selector.pageId ?? '')
    || resolution.selector.scopeKind !== requested.scopeKind
    || !Number.isSafeInteger(resolution.scopeChunkCount)
    || resolution.scopeChunkCount < 1
    || resolution.scopeChunkCount > snapshotChunkCount
    || !Number.isSafeInteger(resolution.scopePageCount)
    || resolution.scopePageCount < 1
    || resolution.scopePageCount > snapshotPageCount
    || resolution.scopePageCount > resolution.scopeChunkCount
    || (
      requested.scopeKind === 'page'
      && resolution.scopePageCount !== 1
    )
    || (
      requested.sectionPath === undefined
      && (
        resolution.sectionPath !== null
        || sectionOccurrencePath !== null
      )
    )
    || (
      requested.sectionPath !== undefined
      && (
        !Array.isArray(resolution.sectionPath)
        || resolution.sectionPath.length !== requested.sectionPath.length
        || resolution.sectionPath.some(segment => !isSafeIndexedMetadataSegment(segment))
        || !pathStartsWith(resolution.sectionPath, requested.sectionPath)
        || sectionOccurrencePath === null
        || sectionOccurrencePath.length !== requested.sectionPath.length
        || sectionOccurrencePath.some(occurrence => (
          !Number.isSafeInteger(occurrence)
          || occurrence < 1
          || occurrence > BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS
        ))
      )
    )
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }

  return {
    scope: {
      pageTitle: resolution.pageTitle,
      pagePath: [...resolution.pagePath],
      ...(requested.scopeKind === 'subtree' ? { scopeKind: 'subtree' as const } : {}),
      ...(resolution.sectionPath
        ? { sectionPath: [...resolution.sectionPath] }
        : {}),
    },
    selector: {
      pageId: resolution.selector.pageId,
      scopeKind: resolution.selector.scopeKind,
      sectionOccurrencePath: sectionOccurrencePath === null
        ? null
        : [...sectionOccurrencePath],
    },
    scopeChunkCount: resolution.scopeChunkCount,
    scopePageCount: resolution.scopePageCount,
  };
}

function requestBinding(request: NormalizedQueryRequest): string {
  return sha256(JSON.stringify({
    v: BACKSTAGE_NOTION_RAG_CURSOR_VERSION,
    query: request.bindingQuery,
    retrievalMode: request.retrievalMode,
    retrievalScope: request.bindingRetrievalScope
      ? {
          pageTitle: request.bindingRetrievalScope.pageTitle,
          pagePath: request.bindingRetrievalScope.pagePath,
          sectionPath: request.bindingRetrievalScope.sectionPath,
          scopeKind: request.bindingRetrievalScope.scopeKind,
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
    format: 'backstage-notion-rag-cursor-key-v3',
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
  cursor: string,
  snapshotId: string,
  binding: string,
  signingKey: string
): DecodedCursor {
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
      !== 'mac,offset,requestBinding,scopeChunkCount,scopeKind,scopePageCount,snapshotId,v'
    || (parsed as Partial<CursorPayload>).v !== BACKSTAGE_NOTION_RAG_CURSOR_VERSION
    || (parsed as Partial<CursorPayload>).snapshotId !== snapshotId
    || (parsed as Partial<CursorPayload>).requestBinding !== binding
    || !Number.isSafeInteger((parsed as Partial<CursorPayload>).scopeChunkCount)
    || (parsed as Partial<CursorPayload>).scopeChunkCount! < 1
    || (parsed as Partial<CursorPayload>).scopeChunkCount!
      > BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS
    || !['all', 'page', 'subtree'].includes(
      (parsed as Partial<CursorPayload>).scopeKind ?? ''
    )
    || !Number.isSafeInteger((parsed as Partial<CursorPayload>).scopePageCount)
    || (parsed as Partial<CursorPayload>).scopePageCount! < 1
    || (parsed as Partial<CursorPayload>).scopePageCount!
      > BACKSTAGE_NOTION_MAX_PAGES_PER_SNAPSHOT
    || !Number.isSafeInteger((parsed as Partial<CursorPayload>).offset)
    || (parsed as Partial<CursorPayload>).offset! < 0
    || (parsed as Partial<CursorPayload>).offset!
      >= BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS
    || typeof (parsed as Partial<CursorPayload>).mac !== 'string'
  ) {
    throw new BackstageNotionCursorInvalidError();
  }
  const candidate = parsed as CursorPayload;
  const payload: CursorPayloadBody = {
    v: candidate.v,
    snapshotId: candidate.snapshotId,
    requestBinding: candidate.requestBinding,
    scopeKind: candidate.scopeKind,
    scopeChunkCount: candidate.scopeChunkCount,
    scopePageCount: candidate.scopePageCount,
    offset: candidate.offset,
  };
  if (!timingSafeEqualOpaqueSecret(
    candidate.mac,
    signCursorPayload(payload, signingKey)
  )) {
    throw new BackstageNotionCursorInvalidError();
  }
  return {
    offset: candidate.offset,
    scopeKind: candidate.scopeKind,
    scopeChunkCount: candidate.scopeChunkCount,
    scopePageCount: candidate.scopePageCount,
  };
}

function validateCursorOffset(offset: number, maximumOffset: number): void {
  if (offset >= maximumOffset) {
    throw new BackstageNotionCursorInvalidError();
  }
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

function validateActiveChunkMetadata(
  active: BackstageNotionActiveChunkMetadata
): ScopeCandidate {
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
    || typeof sourceHash !== 'string'
    || !SHA256_PATTERN.test(sourceHash)
    || active.embeddingModel !== DEFAULT_OPENAI_EMBEDDING_MODEL
    || !UUID_PATTERN.test(active.pageId)
    || !Number.isSafeInteger(active.ordinal)
    || active.ordinal < 0
    || !Number.isSafeInteger(active.codePoints)
    || active.codePoints < 1
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
      !Number.isSafeInteger(occurrence)
      || occurrence < 1
      || occurrence > BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS
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
    active,
    headingOccurrencePath: headingOccurrencePath as number[],
    category: mapCategory(active.metadata.category),
    sourceHash,
    sourceLastEditedAt,
  };
}

function mapActiveChunkContent(
  candidate: ScopeCandidate,
  content: unknown,
  universeId: string
): BackstageNotionRagChunk {
  const { active } = candidate;
  if (
    typeof content !== 'string'
    || !content.trim()
    || active.contentHash !== sha256(content)
    || active.codePoints !== codePointLength(content)
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }
  return {
    chunkId: active.id,
    universeId,
    pageId: active.pageId,
    parentPageId: null,
    title: active.pageTitle,
    path: active.pagePath,
    headingPath: active.headingPath,
    headingOccurrencePath: candidate.headingOccurrencePath,
    category: candidate.category,
    ordinal: active.ordinal,
    content,
    codePoints: active.codePoints,
    contentHash: active.contentHash,
    sourceHash: candidate.sourceHash,
    sourceLastEditedAt: candidate.sourceLastEditedAt,
  };
}

function validatePageMetadataConsistency(chunks: readonly ScopeCandidate[]): void {
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

function resolveScopedChunks<T extends ScopeCandidate>(
  chunks: readonly T[],
  requested: NormalizedPageRetrievalScope
): ResolvedScopedChunks<T> {
  const pages = new Map<string, T[]>();
  for (const candidate of chunks) {
    if (
      normalizeBackstageNotionScopeKey(candidate.active.pageTitle)
        !== normalizeBackstageNotionScopeKey(requested.pageTitle)
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

  const pageChunks = [...pages.values()][0]!;
  const representative = pageChunks[0]!;
  let scopedChunks = pageChunks;
  let resolvedSectionPath: string[] | undefined;
  const requestedSectionPath = requested.sectionPath;
  if (requestedSectionPath) {
    scopedChunks = pageChunks.filter(candidate => (
      pathStartsWith(candidate.active.headingPath, requestedSectionPath)
    ));
    if (scopedChunks.length === 0) {
      throw new BackstageNotionScopeResolutionError('not_found');
    }
    const occurrences = new Set(scopedChunks.map(candidate => (
      JSON.stringify(candidate.headingOccurrencePath.slice(
        0,
        requestedSectionPath.length
      ))
    )));
    if (occurrences.size > 1) {
      throw new BackstageNotionScopeResolutionError('ambiguous');
    }
    const canonicalHeadingPath = scopedChunks[0]!.active.headingPath;
    resolvedSectionPath = canonicalHeadingPath.slice(0, requestedSectionPath.length);
  }

  return {
    chunks: scopedChunks,
    scope: {
      pageTitle: representative.active.pageTitle,
      pagePath: [...representative.active.pagePath],
      ...(resolvedSectionPath ? { sectionPath: resolvedSectionPath } : {}),
    },
    selector: {
      pageId: representative.active.pageId,
      scopeKind: 'page',
      sectionOccurrencePath: requestedSectionPath
        ? [...scopedChunks[0]!.headingOccurrencePath.slice(
            0,
            requestedSectionPath.length
          )]
        : null,
    },
  };
}

function validateSelectedScopePage(
  chunks: readonly ScopeCandidate[],
  requested: NormalizedRetrievalScope,
  selector: BackstageNotionSnapshotChunkPageSelector
): BackstageNotionRagResolvedScope {
  const representative = chunks[0];
  const sectionOccurrencePath = selector.sectionOccurrencePath;
  const requestedSectionPath = requested.sectionPath;
  if (
    !representative
    || selector.pageId === null
    || selector.scopeKind !== 'page'
    || chunks.some(candidate => (
      candidate.active.pageId !== representative.active.pageId
      || normalizeBackstageNotionScopeKey(candidate.active.pageTitle)
        !== normalizeBackstageNotionScopeKey(requested.pageTitle)
      || (
        requested.pagePath !== undefined
        && !pathsMatch(requested.pagePath, candidate.active.pagePath)
      )
    ))
    || (
      requestedSectionPath === undefined
      && sectionOccurrencePath !== null
    )
    || (
      requestedSectionPath !== undefined
      && (
        sectionOccurrencePath === null
        || sectionOccurrencePath.length !== requestedSectionPath.length
        || chunks.some(candidate => (
          !pathStartsWith(candidate.active.headingPath, requestedSectionPath)
          || sectionOccurrencePath.some((occurrence, index) => (
            candidate.headingOccurrencePath[index] !== occurrence
          ))
        ))
      )
    )
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }

  return {
    pageTitle: representative.active.pageTitle,
    pagePath: [...representative.active.pagePath],
    ...(requestedSectionPath
      ? {
          sectionPath: representative.active.headingPath.slice(
            0,
            requestedSectionPath.length
          ),
        }
      : {}),
  };
}

function validateSelectedSubtreePage(
  chunks: readonly ScopeCandidate[],
  resolvedScope: BackstageNotionRagResolvedScope,
  selector: BackstageNotionSnapshotChunkPageSelector
): void {
  if (
    resolvedScope.scopeKind !== 'subtree'
    || selector.scopeKind !== 'subtree'
    || selector.pageId === null
    || selector.sectionOccurrencePath !== null
    || chunks.length < 1
    || chunks.some(candidate => (
      !pathStartsWith(candidate.active.pagePath, resolvedScope.pagePath)
    ))
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }
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

function sortByPageOrdinal<T extends ScopeCandidate>(chunks: readonly T[]): T[] {
  return [...chunks].sort((left, right) => (
    compareDeterministicPath(left.active.pagePath, right.active.pagePath)
    || compareDeterministicText(left.active.pageTitle, right.active.pageTitle)
    || left.active.ordinal - right.active.ordinal
    || compareDeterministicText(left.active.id, right.active.id)
  ));
}

function validateActiveSnapshotHeader<T extends BackstageNotionActiveSnapshotHeader>(
  active: T | null,
  universeId: string,
  rootPageId: string,
  now: Date,
  maximumStalenessMs: number
): T {
  if (
    !active
    || active.authority !== 'notion'
    || active.snapshot.universeId !== universeId
    || active.snapshot.rootPageId !== rootPageId
    || active.snapshot.embeddingModel !== DEFAULT_OPENAI_EMBEDDING_MODEL
    || !UUID_PATTERN.test(active.snapshot.id)
    || !SHA256_PATTERN.test(active.snapshot.manifestHash)
    || !Number.isSafeInteger(active.snapshot.pageCount)
    || active.snapshot.pageCount < 1
    || active.snapshot.pageCount > BACKSTAGE_NOTION_MAX_PAGES_PER_SNAPSHOT
    || !Number.isSafeInteger(active.snapshot.chunkCount)
    || active.snapshot.chunkCount < 1
    || active.snapshot.chunkCount > BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS
    || !Number.isFinite(now.getTime())
    || !Number.isFinite(active.verifiedAt.getTime())
    || !Number.isFinite(active.snapshot.createdAt.getTime())
    || active.verifiedAt.getTime() < active.snapshot.createdAt.getTime()
    || now.getTime() - active.verifiedAt.getTime() > maximumStalenessMs
    || active.verifiedAt.getTime() - now.getTime() > 5 * 60 * 1_000
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }
  return active;
}

function validateActiveSnapshotProjection<T extends BackstageNotionActiveSnapshot>(
  active: T | null,
  universeId: string,
  rootPageId: string,
  now: Date,
  maximumStalenessMs: number
): T {
  const validated = validateActiveSnapshotHeader(
    active,
    universeId,
    rootPageId,
    now,
    maximumStalenessMs
  );
  if (
    validated.truncated
    || validated.snapshot.chunkCount !== validated.chunks.length
    || validated.chunks.length < 1
  ) {
    throw new BackstageNotionIndexUnavailableError();
  }
  return validated;
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
    || codePointLength(request.bindingQuery)
      > BACKSTAGE_NOTION_RAG_MAX_QUERY_CODE_POINTS
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
  const now = dependencies.now?.() ?? new Date();
  const maximumStalenessMs = resolveMaximumStalenessMs(
    dependencies.maximumStalenessMs
  );
  let active: BackstageNotionActiveSnapshotHeader;
  let relevantSnapshot: BackstageNotionActiveSnapshot | null = null;
  if (request.retrievalMode === 'complete_scope') {
    active = validateActiveSnapshotHeader(
      await repository.loadActiveSnapshotHeader(universeId),
      universeId,
      authorityRoot.rootPageId,
      now,
      maximumStalenessMs
    );
  } else {
    relevantSnapshot = validateActiveSnapshotProjection(
      await repository.loadActiveSnapshot(
        universeId,
        BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS
      ),
      universeId,
      authorityRoot.rootPageId,
      now,
      maximumStalenessMs
    );
    active = relevantSnapshot;
  }

  let selected: SelectedChunk[];
  let offset = 0;
  let scopeChunks = 0;
  let scopePages = active.snapshot.pageCount;
  let resolvedScope: BackstageNotionRagResolvedScope | null = null;
  let completeScopeSelector: BackstageNotionSnapshotChunkPageSelector | null = null;
  let completeScopeKind: 'all' | BackstageNotionRagScopeKind = 'all';
  const binding = requestBinding(request);
  const cursorSigningKey = buildCursorSigningKey({
    universeId,
    snapshotId: active.snapshot.id,
    manifestHash: active.snapshot.manifestHash,
    rootPageId: authorityRoot.rootPageId,
  });
  const resolveRequestedScope = async (
    requestedScope: NormalizedRetrievalScope
  ) => {
    const resolution = await repository.resolveSnapshotScope(
      universeId,
      active.snapshot.id,
      buildSnapshotScopeLookup(requestedScope)
    );
    if (resolution.status === 'not_found' || resolution.status === 'ambiguous') {
      throw new BackstageNotionScopeResolutionError(resolution.status);
    }
    if (resolution.status !== 'resolved') {
      throw new BackstageNotionIndexUnavailableError();
    }
    return validateResolvedSnapshotScope(
      resolution,
      requestedScope,
      active.snapshot.chunkCount,
      active.snapshot.pageCount
    );
  };
  if (request.retrievalMode === 'complete_scope') {
    const decodedCursor = request.cursor
      ? decodeCursor(
          request.cursor,
          active.snapshot.id,
          binding,
          cursorSigningKey
        )
      : null;
    if (request.retrievalScope) {
      const validatedResolution = await resolveRequestedScope(request.retrievalScope);
      resolvedScope = validatedResolution.scope;
      completeScopeSelector = validatedResolution.selector;
      completeScopeKind = request.retrievalScope.scopeKind;
      scopeChunks = validatedResolution.scopeChunkCount;
      scopePages = validatedResolution.scopePageCount;
    } else {
      completeScopeSelector = {
        pageId: null,
        scopeKind: 'all',
        sectionOccurrencePath: null,
      };
      completeScopeKind = 'all';
      scopeChunks = active.snapshot.chunkCount;
      scopePages = active.snapshot.pageCount;
    }
    if (request.cursor) {
      const decoded = decodedCursor!;
      offset = decoded.offset;
      if (
        decoded.scopeKind !== completeScopeKind
        || decoded.scopeChunkCount !== scopeChunks
        || decoded.scopePageCount !== scopePages
        || scopeChunks > active.snapshot.chunkCount
        || scopePages > active.snapshot.pageCount
      ) {
        throw new BackstageNotionCursorInvalidError();
      }
      validateCursorOffset(offset, scopeChunks);
    }
    const paged = await repository.loadSnapshotChunkPage(
      universeId,
      active.snapshot.id,
      completeScopeSelector,
      scopeChunks,
      offset,
      BACKSTAGE_NOTION_RAG_RETRIEVED_CHUNKS
    );
    if (
      !Number.isSafeInteger(paged.scopeChunkCount)
      || paged.scopeChunkCount < 1
      || paged.scopeChunkCount > active.snapshot.chunkCount
      || paged.scopeChunkCount !== scopeChunks
      || (
        completeScopeSelector.scopeKind === 'all'
        && paged.scopeChunkCount !== active.snapshot.chunkCount
      )
    ) {
      throw new BackstageNotionIndexUnavailableError();
    }
    scopeChunks = paged.scopeChunkCount;
    const expectedPageLength = Math.min(
      BACKSTAGE_NOTION_RAG_RETRIEVED_CHUNKS,
      scopeChunks - offset
    );
    if (paged.chunks.length !== expectedPageLength) {
      throw new BackstageNotionIndexUnavailableError();
    }
    const pageCandidates = paged.chunks.map(validateActiveChunkMetadata);
    validatePageMetadataConsistency(pageCandidates);
    const pageIds = pageCandidates.map(candidate => candidate.active.id);
    if (
      new Set(pageIds).size !== pageIds.length
      || sortByPageOrdinal(pageCandidates).some((candidate, index) => (
        candidate.active.id !== pageIds[index]
      ))
    ) {
      throw new BackstageNotionIndexUnavailableError();
    }
    if (request.retrievalScope) {
      if (request.retrievalScope.scopeKind === 'subtree') {
        validateSelectedSubtreePage(
          pageCandidates,
          resolvedScope!,
          completeScopeSelector
        );
      } else {
        const selectedScope = validateSelectedScopePage(
          pageCandidates,
          request.retrievalScope,
          completeScopeSelector
        );
        if (JSON.stringify(selectedScope) !== JSON.stringify(resolvedScope)) {
          throw new BackstageNotionIndexUnavailableError();
        }
      }
    }
    selected = pageCandidates.map((candidate, index): SelectedChunk => {
      const pageChunk = paged.chunks[index];
      return {
        ...candidate,
        chunk: mapActiveChunkContent(candidate, pageChunk?.content, universeId),
        score: 0,
      };
    });
  } else {
    const relevantActive = relevantSnapshot!;
    const validatedChunks = relevantActive.chunks.map((chunk): RankedChunk => {
      if (!isFiniteNonzeroVector(chunk.embedding)) {
        throw new BackstageNotionIndexUnavailableError();
      }
      const candidate = validateActiveChunkMetadata(chunk);
      return {
        ...candidate,
        active: chunk,
        chunk: mapActiveChunkContent(candidate, chunk.content, universeId),
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
    let resolved: ResolvedScopedChunks<RankedChunk> | null = null;
    let scopeCandidates: RankedChunk[] = validatedChunks;
    if (request.retrievalScope?.scopeKind === 'subtree') {
      const validatedResolution = await resolveRequestedScope(request.retrievalScope);
      resolvedScope = validatedResolution.scope;
      scopeChunks = validatedResolution.scopeChunkCount;
      scopePages = validatedResolution.scopePageCount;
      scopeCandidates = validatedChunks.filter(candidate => (
        pathStartsWith(candidate.active.pagePath, validatedResolution.scope.pagePath)
      ));
      if (
        scopeCandidates.length !== scopeChunks
        || new Set(scopeCandidates.map(candidate => candidate.active.pageId)).size
          !== scopePages
      ) {
        throw new BackstageNotionIndexUnavailableError();
      }
    } else if (request.retrievalScope?.scopeKind === 'page') {
      resolved = resolveScopedChunks(validatedChunks, request.retrievalScope);
      resolvedScope = resolved.scope;
      scopeCandidates = resolved.chunks;
      scopeChunks = scopeCandidates.length;
      scopePages = 1;
    }
    scopeChunks = scopeCandidates.length;
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
    selected = request.retrievalScope?.scopeKind === 'subtree'
      ? selectDiversifiedChunks(ranked)
      : resolved
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
    && nextOffset < scopeChunks;
  let nextCursor: string | null = null;
  if (hasMore) {
    nextCursor = encodeCursor({
      v: BACKSTAGE_NOTION_RAG_CURSOR_VERSION,
      snapshotId: active.snapshot.id,
      requestBinding: binding,
      scopeKind: completeScopeKind,
      scopeChunkCount: scopeChunks,
      scopePageCount: scopePages,
      offset: nextOffset,
    }, cursorSigningKey);
  }
  const exhaustive = request.retrievalMode === 'complete_scope'
    && offset === 0
    && !hasMore
    && !promptContext.truncated;
  const omittedChunks = Math.max(
    0,
    scopeChunks - promptContext.chunkCount
  );
  const selectedPages = new Set(
    selectedForPrompt.map(candidate => candidate.active.pageId)
  ).size;
  const isSubtreeScope = resolvedScope?.scopeKind === 'subtree';
  if (isSubtreeScope && selectedPages > scopePages) {
    throw new BackstageNotionIndexUnavailableError();
  }
  const baseCoverage: BackstageNotionRagCoverageBase = {
    status: exhaustive ? 'complete' : 'sampled',
    scopeChunks,
    selectedChunks: promptContext.chunkCount,
    omittedChunks,
    promptTruncated: promptContext.truncated,
    exhaustive,
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
  };
  const coverage: BackstageNotionRagCoverage = isSubtreeScope
    ? {
        ...baseCoverage,
        scopePages,
        selectedPages,
        omittedPages: scopePages - selectedPages,
      }
    : baseCoverage;

  try {
    markBackstageNotionEnrichmentUsed();
  } catch {
    throw new BackstageNotionIndexUnavailableError();
  }
  try {
    logger.info('backstage.notion_rag.retrieved', {
      universeId,
      snapshotId: active.snapshot.id,
      candidateChunks: active.snapshot.chunkCount,
      scopeChunks,
      retrievedChunks: promptContext.chunkCount,
      retrievalMode: request.retrievalMode,
      scoped: resolvedScope !== null,
      scopeKind: resolvedScope?.scopeKind ?? (resolvedScope ? 'page' : 'all'),
      ...(isSubtreeScope
        ? {
            scopePages,
            selectedPages,
            omittedPages: scopePages - selectedPages,
          }
        : {}),
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
    resolvedScope,
    coverage,
    nextCursor,
    citations: selectedForPrompt.map(({ active: chunk, category }) => ({
      pageId: chunk.pageId,
      pageTitle: chunk.pageTitle,
      pagePath: [...chunk.pagePath],
      headingPath: [...chunk.headingPath],
      category,
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

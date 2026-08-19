import { createHash } from 'node:crypto';

import { isAbortError } from '@arcanos/runtime';
import {
  getBackstageNotionRagRepository,
  type BackstageNotionActiveChunk,
  type BackstageNotionRagRepository,
} from '@core/db/repositories/backstageNotionRagRepository.js';
import { getEnvNumber } from '@platform/runtime/env.js';
import { logger } from '@platform/logging/structuredLogging.js';
import {
  buildBackstageNotionRagUntrustedContextPrompt,
  type BackstageNotionRagCategory,
  type BackstageNotionRagChunk,
} from '@shared/backstage/backstageNotionRagCore.js';
import { cosineSimilarity } from '@shared/vectorUtils.js';
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

export const BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS = 2_048;
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

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
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
  category: BackstageNotionRagCategory;
  chunkId: string;
  contentHash: string;
}

export interface BackstageNotionRagRetrieval {
  universeId: string;
  snapshotId: string;
  verifiedAt: Date;
  prompt: string;
  chunkCount: number;
  truncated: boolean;
  citations: BackstageNotionRagCitation[];
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
    || !active.pageTitle.trim()
    || active.pagePath.length < 1
    || active.pagePath.some(segment => typeof segment !== 'string' || !segment.trim())
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
    category: mapCategory(active.metadata.category),
    ordinal: active.ordinal,
    content: active.content,
    codePoints: active.codePoints,
    contentHash: active.contentHash,
    sourceHash,
    sourceLastEditedAt,
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

async function retrieveBackstageNotionRagContextUnsafe(
  universeId: string,
  query: string,
  dependencies: BackstageNotionRagRetrievalDependencies = {}
): Promise<BackstageNotionRagRetrieval> {
  const normalizedQuery = query.trim();
  if (
    !isBackstageNotionEnrichmentAuthorized()
    || !normalizedQuery
    || codePointLength(normalizedQuery) > BACKSTAGE_NOTION_RAG_MAX_QUERY_CODE_POINTS
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

  const validatedChunks = active.chunks.map(chunk => {
    if (!isFiniteNonzeroVector(chunk.embedding)) {
      throw new BackstageNotionIndexUnavailableError();
    }
    return {
      active: chunk,
      chunk: { ...mapActiveChunk(chunk), universeId },
    };
  });
  const queryEmbedding = await (dependencies.embedQuery ?? createEmbedding)(normalizedQuery);
  if (!isFiniteNonzeroVector(queryEmbedding)) {
    throw new BackstageNotionIndexUnavailableError();
  }
  const queryTokens = tokenize(normalizedQuery);
  const ranked = validatedChunks.map(({ active: chunk, chunk: mapped }): RankedChunk => {
    if (chunk.embedding.length !== queryEmbedding.length) {
      throw new BackstageNotionIndexUnavailableError();
    }
    const score = cosineSimilarity(queryEmbedding, chunk.embedding)
      + lexicalBoost(queryTokens, chunk);
    if (!Number.isFinite(score)) {
      throw new BackstageNotionIndexUnavailableError();
    }
    return {
      active: chunk,
      chunk: mapped,
      score,
    };
  }).sort((left, right) => (
    right.score - left.score
    || left.active.pageId.localeCompare(right.active.pageId)
    || left.active.ordinal - right.active.ordinal
    || left.active.id.localeCompare(right.active.id)
  ));
  const selected = selectDiversifiedChunks(ranked);
  const promptContext = buildBackstageNotionRagUntrustedContextPrompt(
    selected.map(candidate => candidate.chunk),
    { maximumChunks: BACKSTAGE_NOTION_RAG_RETRIEVED_CHUNKS }
  );
  if (promptContext.chunkCount < 1) {
    throw new BackstageNotionIndexUnavailableError();
  }

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
      retrievedChunks: promptContext.chunkCount,
      truncated: promptContext.truncated,
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
    truncated: promptContext.truncated,
    citations: selected.slice(0, promptContext.chunkCount).map(({ active: chunk }) => ({
      pageId: chunk.pageId,
      pageTitle: chunk.pageTitle,
      pagePath: [...chunk.pagePath],
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
  query: string,
  dependencies: BackstageNotionRagRetrievalDependencies = {}
): Promise<BackstageNotionRagRetrieval> {
  try {
    return await retrieveBackstageNotionRagContextUnsafe(
      universeId,
      query,
      dependencies
    );
  } catch (error) {
    if (isAbortError(error) || isBackstageNotionIndexUnavailableError(error)) {
      throw error;
    }
    throw new BackstageNotionIndexUnavailableError();
  }
}

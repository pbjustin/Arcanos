import type {
  BackstageNotionReusableChunkMaterial,
  BackstageNotionReusablePageMaterial,
  BackstageNotionStoredChunkVersion,
  BackstageNotionStoredEmbedding,
  BackstageNotionStoredPageVersion,
  FindBackstageNotionReusableChunkMaterialsInput,
  FindBackstageNotionReusablePageMaterialInput,
  StoreBackstageNotionChunkVersionInput,
  StoreBackstageNotionEmbeddingInput,
  StoreBackstageNotionPageVersionInput,
} from '@core/db/repositories/backstageNotionPartitionRepository.js';
import {
  BACKSTAGE_NOTION_PARTITION_MATERIAL_LOOKUP_MAX_CHUNKS,
} from '@core/db/repositories/backstageNotionPartitionRepository.js';
import {
  BACKSTAGE_NOTION_RAG_CHUNK_CODE_POINTS,
  categorizeBackstageNotionRagContent,
  chunkBackstageNotionInspectedPage,
  type BackstageNotionInspectedRagPage,
  type BackstageNotionPreparedRagPage,
  type BackstageNotionRagCategory,
} from '@shared/backstage/backstageNotionRagCore.js';
import { hashBackstageNotionPageMaterial } from '@shared/backstage/backstageNotionPartitionMaterialCore.js';
import { normalizeBackstageNotionScopePath } from '@shared/backstage/backstageNotionScopeIndex.js';

// v1 binds the current sanitization format to the fixed 1,800-code-point
// chunk policy below. Any sanitization or chunk-boundary change must bump the
// corresponding persisted version before new material is reused.
export const BACKSTAGE_NOTION_PARTITION_PAGE_FORMAT_VERSION = 1;
export const BACKSTAGE_NOTION_PARTITION_CHUNKER_VERSION = 1;
export const BACKSTAGE_NOTION_PARTITION_CHUNK_CODE_POINTS =
  BACKSTAGE_NOTION_RAG_CHUNK_CODE_POINTS;
export const BACKSTAGE_NOTION_PARTITION_EMBEDDING_BATCH_SIZE = 32;

export class BackstageNotionPartitionMaterialCapacityError extends Error {
  constructor() {
    super('The page material exceeds the remaining shard chunk capacity.');
    this.name = 'BackstageNotionPartitionMaterialCapacityError';
  }
}

export interface BackstageNotionPartitionMaterialRepository {
  findReusablePageMaterial(
    input: FindBackstageNotionReusablePageMaterialInput
  ): Promise<BackstageNotionReusablePageMaterial | null>;
  findReusableChunkMaterials(
    input: FindBackstageNotionReusableChunkMaterialsInput
  ): Promise<readonly BackstageNotionReusableChunkMaterial[]>;
  storeChunkVersion(
    input: StoreBackstageNotionChunkVersionInput
  ): Promise<BackstageNotionStoredChunkVersion>;
  storeEmbedding(
    input: StoreBackstageNotionEmbeddingInput
  ): Promise<BackstageNotionStoredEmbedding>;
  storePageVersion(
    input: StoreBackstageNotionPageVersionInput
  ): Promise<BackstageNotionStoredPageVersion>;
}

export interface ResolveBackstageNotionPartitionPageMaterialInput {
  readonly page: BackstageNotionInspectedRagPage;
  readonly embeddingModel: string;
  readonly embeddingVersion: number;
  readonly embeddingDimension: number;
  /** Reject before writing or embedding when the page exceeds this remaining budget. */
  readonly maximumChunkCount?: number;
  readonly signal?: AbortSignal;
}

export interface BackstageNotionResolvedPartitionChunk {
  readonly ordinal: number;
  readonly chunkVersionId: string;
  readonly contentHash: string;
  readonly headingPath: readonly string[];
  readonly scopeHeadingPathKey: readonly string[];
  readonly headingOccurrencePath: readonly number[];
  readonly category: BackstageNotionRagCategory;
}

export interface BackstageNotionResolvedPartitionPageMaterial {
  readonly pageVersionId: string;
  readonly contentHash: string;
  readonly pageFormatVersion: number;
  readonly chunkerVersion: number;
  readonly pageVersionReused: boolean;
  readonly chunkingPerformed: boolean;
  readonly reusedChunkCount: number;
  readonly embeddedChunkCount: number;
  readonly chunks: readonly BackstageNotionResolvedPartitionChunk[];
}

export interface BackstageNotionPartitionMaterialDependencies {
  readonly repository: BackstageNotionPartitionMaterialRepository;
  readonly embedBatch: (contents: readonly string[]) => Promise<readonly (readonly number[])[]>;
  readonly chunkPage?: (
    page: BackstageNotionInspectedRagPage,
    options: { readonly maximumCodePoints: number }
  ) => BackstageNotionPreparedRagPage;
}

interface ResolvedNormalizedChunk {
  readonly chunkVersionId: string;
  readonly contentHash: string;
  readonly content: string;
  readonly embeddingAvailable: boolean;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

async function raceWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (!signal) {
    return operation;
  }
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted.', 'AbortError')
    ));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error))
    );
  });
}

function normalizeEmbeddingConfiguration(input: {
  readonly embeddingModel: string;
  readonly embeddingVersion: number;
  readonly embeddingDimension: number;
}): void {
  if (
    input.embeddingModel !== input.embeddingModel.trim()
    || input.embeddingModel.length === 0
    || input.embeddingModel.length > 200
    || /[\u0000-\u001f\u007f]/u.test(input.embeddingModel)
  ) {
    throw new TypeError('embeddingModel is invalid.');
  }
  if (!Number.isSafeInteger(input.embeddingVersion) || input.embeddingVersion < 1) {
    throw new TypeError('embeddingVersion is invalid.');
  }
  if (
    !Number.isSafeInteger(input.embeddingDimension)
    || input.embeddingDimension < 1
    || input.embeddingDimension > 4_096
  ) {
    throw new TypeError('embeddingDimension is invalid.');
  }
}

function validateEmbedding(
  embedding: readonly number[],
  expectedDimension: number
): readonly number[] {
  if (!Array.isArray(embedding) || embedding.length !== expectedDimension) {
    throw new Error('Embedding provider returned an unexpected vector dimension.');
  }
  const normalized = Object.freeze(embedding.map((component, index) => {
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw new Error(`Embedding provider returned an invalid component at ${index}.`);
    }
    return component;
  }));
  if (!Number.isFinite(Math.hypot(...normalized)) || Math.hypot(...normalized) <= 0) {
    throw new Error('Embedding provider returned a zero or invalid vector.');
  }
  return normalized;
}

async function findChunkMaterials(
  repository: BackstageNotionPartitionMaterialRepository,
  input: Omit<FindBackstageNotionReusableChunkMaterialsInput, 'contentHashes'>,
  contentHashes: readonly string[],
  signal: AbortSignal | undefined
): Promise<ReadonlyMap<string, BackstageNotionReusableChunkMaterial>> {
  const found = new Map<string, BackstageNotionReusableChunkMaterial>();
  for (
    let offset = 0;
    offset < contentHashes.length;
    offset += BACKSTAGE_NOTION_PARTITION_MATERIAL_LOOKUP_MAX_CHUNKS
  ) {
    throwIfAborted(signal);
    const batch = contentHashes.slice(
      offset,
      offset + BACKSTAGE_NOTION_PARTITION_MATERIAL_LOOKUP_MAX_CHUNKS
    );
    const materials = await repository.findReusableChunkMaterials({
      ...input,
      contentHashes: batch,
    });
    for (const material of materials) {
      if (!batch.includes(material.contentHash) || found.has(material.contentHash)) {
        throw new Error('Reusable chunk lookup returned ambiguous material.');
      }
      if (
        hashBackstageNotionPageMaterial(material.content) !== material.contentHash
        || codePointLength(material.content) !== material.contentCodePoints
      ) {
        throw new Error('Reusable chunk lookup returned corrupt material.');
      }
      found.set(material.contentHash, material);
    }
  }
  return found;
}

async function ensureEmbeddings(input: {
  readonly chunks: readonly ResolvedNormalizedChunk[];
  readonly universeId: string;
  readonly embeddingModel: string;
  readonly embeddingVersion: number;
  readonly embeddingDimension: number;
  readonly signal: AbortSignal | undefined;
  readonly dependencies: BackstageNotionPartitionMaterialDependencies;
}): Promise<number> {
  const missingByVersion = new Map<string, ResolvedNormalizedChunk>();
  input.chunks.forEach(chunk => {
    if (!chunk.embeddingAvailable) {
      missingByVersion.set(chunk.chunkVersionId, chunk);
    }
  });
  const missing = [...missingByVersion.values()];
  for (
    let offset = 0;
    offset < missing.length;
    offset += BACKSTAGE_NOTION_PARTITION_EMBEDDING_BATCH_SIZE
  ) {
    throwIfAborted(input.signal);
    const batch = missing.slice(
      offset,
      offset + BACKSTAGE_NOTION_PARTITION_EMBEDDING_BATCH_SIZE
    );
    const embeddings = await raceWithSignal(
      input.dependencies.embedBatch(batch.map(chunk => chunk.content)),
      input.signal
    );
    if (embeddings.length !== batch.length) {
      throw new Error('Embedding provider returned an incomplete Notion batch.');
    }
    const validatedEmbeddings = embeddings.map(embedding =>
      validateEmbedding(embedding, input.embeddingDimension)
    );
    for (const [index, chunk] of batch.entries()) {
      throwIfAborted(input.signal);
      const embedding = validatedEmbeddings[index];
      if (!embedding) {
        throw new Error('Embedding provider returned an incomplete Notion batch.');
      }
      await input.dependencies.repository.storeEmbedding({
        universeId: input.universeId,
        chunkVersionId: chunk.chunkVersionId,
        embeddingModel: input.embeddingModel,
        embeddingVersion: input.embeddingVersion,
        embedding,
      });
    }
  }
  return missing.length;
}

function categoryForPlacement(
  page: BackstageNotionInspectedRagPage,
  headingPath: readonly string[],
  content: string
): BackstageNotionRagCategory {
  return categorizeBackstageNotionRagContent({
    title: page.title,
    path: [...page.path, ...headingPath],
    content,
  });
}

function resolvedChunksFromPageMaterial(
  page: BackstageNotionInspectedRagPage,
  material: BackstageNotionReusablePageMaterial
): readonly BackstageNotionResolvedPartitionChunk[] {
  return Object.freeze(material.chunks.map(chunk => Object.freeze({
    ordinal: chunk.ordinal,
    chunkVersionId: chunk.chunkVersionId,
    contentHash: chunk.contentHash,
    headingPath: chunk.headingPath,
    scopeHeadingPathKey: chunk.scopeHeadingPathKey,
    headingOccurrencePath: chunk.headingOccurrencePath,
    category: categoryForPlacement(page, chunk.headingPath, chunk.content),
  })));
}

/**
 * Reuse derived immutable material after a live page has been captured and
 * inspected. Notion hierarchy/content capture remains a full provider scan;
 * this function makes chunking and embedding incremental, not source polling.
 */
export async function resolveBackstageNotionPartitionPageMaterial(
  input: ResolveBackstageNotionPartitionPageMaterialInput,
  dependencies: BackstageNotionPartitionMaterialDependencies
): Promise<BackstageNotionResolvedPartitionPageMaterial> {
  normalizeEmbeddingConfiguration(input);
  if (
    input.maximumChunkCount !== undefined
    && (!Number.isSafeInteger(input.maximumChunkCount) || input.maximumChunkCount < 0)
  ) {
    throw new TypeError('maximumChunkCount is invalid.');
  }
  throwIfAborted(input.signal);
  const contentHash = hashBackstageNotionPageMaterial(input.page.sanitizedMarkdown);
  const lookupBase = {
    universeId: input.page.universeId,
    embeddingModel: input.embeddingModel,
    embeddingVersion: input.embeddingVersion,
    embeddingDimension: input.embeddingDimension,
    chunkerVersion: BACKSTAGE_NOTION_PARTITION_CHUNKER_VERSION,
  } as const;
  const reusablePage = await dependencies.repository.findReusablePageMaterial({
    ...lookupBase,
    pageId: input.page.pageId,
    contentHash,
    pageFormatVersion: BACKSTAGE_NOTION_PARTITION_PAGE_FORMAT_VERSION,
  });
  throwIfAborted(input.signal);
  if (reusablePage) {
    if (
      input.maximumChunkCount !== undefined
      && reusablePage.chunks.length > input.maximumChunkCount
    ) {
      throw new BackstageNotionPartitionMaterialCapacityError();
    }
    const normalizedChunks = reusablePage.chunks.map(chunk => ({
      chunkVersionId: chunk.chunkVersionId,
      contentHash: chunk.contentHash,
      content: chunk.content,
      embeddingAvailable: chunk.embeddingAvailable,
    }));
    const embeddedChunkCount = await ensureEmbeddings({
      chunks: normalizedChunks,
      universeId: input.page.universeId,
      embeddingModel: input.embeddingModel,
      embeddingVersion: input.embeddingVersion,
      embeddingDimension: input.embeddingDimension,
      signal: input.signal,
      dependencies,
    });
    return Object.freeze({
      pageVersionId: reusablePage.pageVersionId,
      contentHash,
      pageFormatVersion: BACKSTAGE_NOTION_PARTITION_PAGE_FORMAT_VERSION,
      chunkerVersion: BACKSTAGE_NOTION_PARTITION_CHUNKER_VERSION,
      pageVersionReused: true,
      chunkingPerformed: false,
      reusedChunkCount: new Set(reusablePage.chunks.map(chunk => chunk.chunkVersionId)).size,
      embeddedChunkCount,
      chunks: resolvedChunksFromPageMaterial(input.page, reusablePage),
    });
  }

  const prepared = (dependencies.chunkPage ?? chunkBackstageNotionInspectedPage)(
    input.page,
    { maximumCodePoints: BACKSTAGE_NOTION_PARTITION_CHUNK_CODE_POINTS }
  );
  if (
    input.maximumChunkCount !== undefined
    && prepared.chunks.length > input.maximumChunkCount
  ) {
    throw new BackstageNotionPartitionMaterialCapacityError();
  }
  const uniqueChunks = new Map<string, (typeof prepared.chunks)[number]>();
  prepared.chunks.forEach(chunk => {
    const existing = uniqueChunks.get(chunk.contentHash);
    if (existing && existing.content !== chunk.content) {
      throw new Error('Chunker returned a content-hash collision.');
    }
    uniqueChunks.set(chunk.contentHash, chunk);
  });
  const hashes = [...uniqueChunks.keys()];
  let reusableByHash = await findChunkMaterials(
    dependencies.repository,
    lookupBase,
    hashes,
    input.signal
  );
  const initiallyReusableChunkCount = reusableByHash.size;
  for (const [hash, chunk] of uniqueChunks) {
    if (reusableByHash.has(hash)) {
      continue;
    }
    throwIfAborted(input.signal);
    await dependencies.repository.storeChunkVersion({
      universeId: input.page.universeId,
      contentHash: hash,
      chunkerVersion: BACKSTAGE_NOTION_PARTITION_CHUNKER_VERSION,
      content: chunk.content,
      contentCodePoints: chunk.codePoints,
    });
  }
  if (reusableByHash.size !== hashes.length) {
    reusableByHash = await findChunkMaterials(
      dependencies.repository,
      lookupBase,
      hashes,
      input.signal
    );
  }
  if (reusableByHash.size !== hashes.length) {
    throw new Error('Stored chunk material could not be resolved.');
  }
  const normalizedChunks = hashes.map(hash => {
    const material = reusableByHash.get(hash);
    if (!material || material.content !== uniqueChunks.get(hash)?.content) {
      throw new Error('Reusable chunk lookup returned conflicting content.');
    }
    return {
      chunkVersionId: material.chunkVersionId,
      contentHash: material.contentHash,
      content: material.content,
      embeddingAvailable: material.embeddingAvailable,
    };
  });
  const embeddedChunkCount = await ensureEmbeddings({
    chunks: normalizedChunks,
    universeId: input.page.universeId,
    embeddingModel: input.embeddingModel,
    embeddingVersion: input.embeddingVersion,
    embeddingDimension: input.embeddingDimension,
    signal: input.signal,
    dependencies,
  });
  throwIfAborted(input.signal);
  const chunkReferences = prepared.chunks.map(chunk => {
    const material = reusableByHash.get(chunk.contentHash);
    if (!material) {
      throw new Error('Stored chunk material could not be resolved.');
    }
    return Object.freeze({
      ordinal: chunk.ordinal,
      chunkVersionId: material.chunkVersionId,
      headingPath: chunk.headingPath,
      scopeHeadingPathKey: Object.freeze(
        normalizeBackstageNotionScopePath(chunk.headingPath)
      ),
      headingOccurrencePath: chunk.headingOccurrencePath,
    });
  });
  const storedPage = await dependencies.repository.storePageVersion({
    universeId: input.page.universeId,
    pageId: input.page.pageId,
    contentHash,
    pageFormatVersion: BACKSTAGE_NOTION_PARTITION_PAGE_FORMAT_VERSION,
    chunkerVersion: BACKSTAGE_NOTION_PARTITION_CHUNKER_VERSION,
    markdown: input.page.sanitizedMarkdown,
    contentCodePoints: codePointLength(input.page.sanitizedMarkdown),
    chunks: chunkReferences,
  });
  const resolvedChunks = prepared.chunks.map(chunk => {
    const material = reusableByHash.get(chunk.contentHash);
    if (!material) {
      throw new Error('Stored chunk material could not be resolved.');
    }
    return Object.freeze({
      ordinal: chunk.ordinal,
      chunkVersionId: material.chunkVersionId,
      contentHash: chunk.contentHash,
      headingPath: chunk.headingPath,
      scopeHeadingPathKey: Object.freeze(
        normalizeBackstageNotionScopePath(chunk.headingPath)
      ),
      headingOccurrencePath: chunk.headingOccurrencePath,
      category: chunk.category,
    });
  });
  return Object.freeze({
    pageVersionId: storedPage.id,
    contentHash,
    pageFormatVersion: BACKSTAGE_NOTION_PARTITION_PAGE_FORMAT_VERSION,
    chunkerVersion: BACKSTAGE_NOTION_PARTITION_CHUNKER_VERSION,
    pageVersionReused: storedPage.reused,
    chunkingPerformed: true,
    reusedChunkCount: initiallyReusableChunkCount,
    embeddedChunkCount,
    chunks: Object.freeze(resolvedChunks),
  });
}

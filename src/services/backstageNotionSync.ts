import { createHash, randomUUID } from 'node:crypto';

import {
  BACKSTAGE_NOTION_MAX_REUSABLE_EMBEDDING_HASHES,
  BACKSTAGE_NOTION_SYNC_LEASE_MAX_MS,
  getBackstageNotionRagRepository,
  type BackstageNotionActiveInventory,
  type BackstageNotionRagRepository,
  type BackstageNotionSnapshotChunkInput,
  type BackstageNotionSnapshotPageInput,
} from '@core/db/repositories/backstageNotionRagRepository.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { getEnv } from '@platform/runtime/env.js';
import {
  readBackstageNotionAuthorityConfiguration,
  type BackstageNotionAuthorityEnvironmentReader,
  type BackstageNotionAuthorityRoot,
} from './backstageNotionAuthority.js';
import {
  BackstageNotionReadError,
  fetchBackstageNotionMarkdownPage,
  fetchBackstageNotionPageMetadata,
  readBackstageNotionAccessToken,
  type BackstageNotionFetchImplementation,
  type BackstageNotionPageMetadata,
} from '@shared/backstage/backstageNotionContextCore.js';
import {
  prepareBackstageNotionRagPage,
  type BackstageNotionPreparedRagPage,
} from '@shared/backstage/backstageNotionRagCore.js';
import {
  createEmbeddings,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
} from './openai/embeddings.js';
import { sleep } from '@shared/sleep.js';

export const BACKSTAGE_NOTION_SYNC_MAX_PAGES = 512;
export const BACKSTAGE_NOTION_SYNC_MAX_DEPTH = 16;
export const BACKSTAGE_NOTION_SYNC_MAX_TOTAL_CODE_POINTS = 4_000_000;
export const BACKSTAGE_NOTION_SYNC_MAX_CHUNKS = 5_000;
export const BACKSTAGE_NOTION_SYNC_FETCH_TIMEOUT_MS = 15_000;
export const BACKSTAGE_NOTION_SYNC_REQUEST_SPACING_MS = 350;
export const BACKSTAGE_NOTION_SYNC_FETCH_ATTEMPTS = 3;
export const BACKSTAGE_NOTION_SYNC_EMBEDDING_BATCH_SIZE = 32;

const SYNC_HOLDER_ID = `backstage-notion-rag:${process.pid}:${randomUUID()}`;
const UNSUPPORTED_ENHANCED_MARKDOWN_PATTERN =
  /<(?:audio|bookmark|database|embed|file|image|link-preview|pdf|unknown|video)\b/iu;

export const BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE =
  'BACKSTAGE_NOTION_SYNC_CONFIGURATION_INVALID';
export const BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE =
  'BACKSTAGE_NOTION_SYNC_INCOMPLETE';
export const BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT_ERROR_CODE =
  'BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT';

export class BackstageNotionSyncError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'BackstageNotionSyncError';
  }
}

export interface BackstageNotionSyncDependencies {
  repository?: BackstageNotionRagRepository;
  fetchImpl?: BackstageNotionFetchImplementation;
  readEnvironment?: BackstageNotionAuthorityEnvironmentReader;
  embedBatch?: (inputs: readonly string[]) => Promise<number[][]>;
  signal?: AbortSignal;
  holderId?: string;
  requestSpacingMs?: number;
  fetchTimeoutMs?: number;
  retryBaseDelayMs?: number;
}

export interface BackstageNotionSyncResult {
  universeId: string;
  status: 'activated' | 'unchanged' | 'lease-busy';
  pageCount: number;
  chunkCount: number;
  manifestHash: string | null;
  snapshotId: string | null;
  verifiedAt: Date | null;
}

interface PendingPage {
  pageId: string;
  parentPageId: string | null;
  title: string;
  depth: number;
  path: string[];
}

interface CapturedPage {
  prepared: BackstageNotionPreparedRagPage;
  metadata: BackstageNotionPageMetadata;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function boundedNonnegativeMilliseconds(
  value: number | undefined,
  fallback: number
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
}

function safeLog(
  level: 'info' | 'warn',
  event: string,
  metadata: Record<string, unknown>
): void {
  try {
    logger[level](event, metadata);
  } catch {
    // Synchronization diagnostics must not alter snapshot or lease outcomes.
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  throw reason instanceof Error || reason instanceof DOMException
    ? reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

async function waitWithSignal(
  milliseconds: number,
  signal: AbortSignal | undefined
): Promise<void> {
  if (milliseconds <= 0) {
    throwIfAborted(signal);
    return;
  }
  await sleep(milliseconds, signal ? { signal } : undefined);
}

async function runWithTimeout<T>(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timeoutHandle = setTimeout(() => {
    controller.abort(new DOMException('Notion request timed out.', 'AbortError'));
  }, timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeoutHandle);
    parentSignal?.removeEventListener('abort', forwardAbort);
  }
}

function shouldRetryFetch(error: unknown): boolean {
  if (error instanceof BackstageNotionReadError) {
    return /^(?:http_(?:429|500|502|503|504|529)|request_failed)$/u.test(
      error.category
    );
  }
  return error instanceof Error && error.name === 'AbortError';
}

function createNotionRequestRunner(input: {
  spacingMs: number;
  timeoutMs: number;
  retryBaseDelayMs: number;
  signal?: AbortSignal;
}) {
  let lastRequestAt = 0;
  return async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= BACKSTAGE_NOTION_SYNC_FETCH_ATTEMPTS; attempt += 1) {
      throwIfAborted(input.signal);
      const remainingSpacing = input.spacingMs - (Date.now() - lastRequestAt);
      await waitWithSignal(Math.max(0, remainingSpacing), input.signal);
      lastRequestAt = Date.now();
      try {
        return await runWithTimeout(input.timeoutMs, input.signal, operation);
      } catch (error) {
        if (input.signal?.aborted) {
          throwIfAborted(input.signal);
        }
        lastError = error;
        if (
          attempt >= BACKSTAGE_NOTION_SYNC_FETCH_ATTEMPTS
          || !shouldRetryFetch(error)
        ) {
          throw error;
        }
        await waitWithSignal(
          input.retryBaseDelayMs * 2 ** (attempt - 1),
          input.signal
        );
      }
    }
    throw lastError;
  };
}

function validateFetchedPage(
  pending: PendingPage,
  metadata: BackstageNotionPageMetadata
): void {
  if (
    metadata.pageId !== pending.pageId
    || metadata.inTrash
    || (
      pending.parentPageId !== null
      && metadata.parentPageId !== pending.parentPageId
    )
  ) {
    throw new BackstageNotionSyncError(
      BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
      'The configured Notion hierarchy could not be verified completely.'
    );
  }
}

function buildManifestHash(pages: readonly CapturedPage[]): string {
  const manifest = [...pages]
    .sort((left, right) => left.prepared.pageId.localeCompare(right.prepared.pageId))
    .map(page => ({
      pageId: page.prepared.pageId,
      parentPageId: page.prepared.parentPageId,
      title: page.prepared.title,
      path: page.prepared.path,
      sourceHash: page.prepared.sourceHash,
      lastEditedAt: page.metadata.lastEditedAt.toISOString(),
    }));
  return sha256(JSON.stringify({
    format: 'backstage-notion-rag-manifest-v1',
    pages: manifest,
  }));
}

function canonicalPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replaceAll('-', '')}`;
}

async function loadReusableEmbeddings(
  repository: BackstageNotionRagRepository,
  universeId: string,
  hashes: readonly string[]
): Promise<Map<string, number[]>> {
  const reusable = new Map<string, number[]>();
  for (
    let index = 0;
    index < hashes.length;
    index += BACKSTAGE_NOTION_MAX_REUSABLE_EMBEDDING_HASHES
  ) {
    const batch = hashes.slice(
      index,
      index + BACKSTAGE_NOTION_MAX_REUSABLE_EMBEDDING_HASHES
    );
    const loaded = await repository.loadReusableEmbeddings(
      universeId,
      DEFAULT_OPENAI_EMBEDDING_MODEL,
      batch
    );
    for (const [hash, embedding] of loaded) {
      reusable.set(hash, embedding);
    }
  }
  return reusable;
}

async function buildSnapshotChunks(input: {
  universeId: string;
  pages: readonly CapturedPage[];
  repository: BackstageNotionRagRepository;
  embedBatch: (inputs: readonly string[]) => Promise<number[][]>;
}): Promise<BackstageNotionSnapshotChunkInput[]> {
  const chunks = input.pages.flatMap(page => [...page.prepared.chunks]);
  if (chunks.length < 1 || chunks.length > BACKSTAGE_NOTION_SYNC_MAX_CHUNKS) {
    throw new BackstageNotionSyncError(
      BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
      'The Notion hierarchy did not produce a complete bounded retrieval index.'
    );
  }

  const byHash = new Map<string, string>();
  for (const chunk of chunks) {
    byHash.set(chunk.contentHash, chunk.content);
  }
  const hashes = [...byHash.keys()].sort();
  const embeddings = await loadReusableEmbeddings(
    input.repository,
    input.universeId,
    hashes
  );
  const missingHashes = hashes.filter(hash => !embeddings.has(hash));
  for (
    let index = 0;
    index < missingHashes.length;
    index += BACKSTAGE_NOTION_SYNC_EMBEDDING_BATCH_SIZE
  ) {
    const batchHashes = missingHashes.slice(
      index,
      index + BACKSTAGE_NOTION_SYNC_EMBEDDING_BATCH_SIZE
    );
    const batchEmbeddings = await input.embedBatch(
      batchHashes.map(hash => byHash.get(hash) ?? '')
    );
    if (batchEmbeddings.length !== batchHashes.length) {
      throw new Error('Embedding provider returned an incomplete Notion batch.');
    }
    batchHashes.forEach((hash, batchIndex) => {
      const embedding = batchEmbeddings[batchIndex];
      if (!embedding || embedding.length === 0) {
        throw new Error('Embedding provider returned an empty Notion vector.');
      }
      embeddings.set(hash, embedding);
    });
  }

  return chunks.map(chunk => ({
    chunkId: chunk.chunkId,
    pageId: chunk.pageId,
    ordinal: chunk.ordinal,
    contentHash: chunk.contentHash,
    content: chunk.content,
    codePoints: chunk.codePoints,
    embedding: embeddings.get(chunk.contentHash) ?? [],
    headingPath: [],
    metadata: {
      category: chunk.category,
      sourceHash: chunk.sourceHash,
      sourceLastEditedAt: chunk.sourceLastEditedAt,
    },
  }));
}

function buildSnapshotPages(
  pages: readonly CapturedPage[]
): BackstageNotionSnapshotPageInput[] {
  return pages.map(({ prepared, metadata }) => ({
    pageId: prepared.pageId,
    parentPageId: prepared.parentPageId,
    title: prepared.title,
    canonicalUrl: canonicalPageUrl(prepared.pageId),
    contentHash: prepared.sourceHash,
    markdown: prepared.sanitizedMarkdown,
    sourceLastEditedAt: metadata.lastEditedAt,
    depth: prepared.path.length - 1,
    path: [...prepared.path],
    metadata: {
      category: prepared.category,
      chunkCount: prepared.chunks.length,
      contentCodePoints: codePointLength(prepared.sanitizedMarkdown),
    },
  }));
}

async function verifyHierarchyDidNotDrift(input: {
  pages: readonly CapturedPage[];
  request: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  fetchImpl: BackstageNotionFetchImplementation;
  accessToken: string;
}): Promise<void> {
  for (const page of input.pages) {
    const verified = await input.request(signal =>
      fetchBackstageNotionPageMetadata(
        input.fetchImpl,
        input.accessToken,
        page.prepared.pageId,
        signal
      )
    );
    if (
      verified.inTrash
      || verified.parentPageId !== page.metadata.parentPageId
      || verified.lastEditedAt.getTime() !== page.metadata.lastEditedAt.getTime()
    ) {
      throw new BackstageNotionSyncError(
        BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT_ERROR_CODE,
        'The Notion hierarchy changed during synchronization; the candidate snapshot was discarded.'
      );
    }
  }
}

async function captureHierarchy(input: {
  root: BackstageNotionAuthorityRoot;
  fetchImpl: BackstageNotionFetchImplementation;
  accessToken: string;
  request: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
}): Promise<CapturedPage[]> {
  const queue: PendingPage[] = [{
    pageId: input.root.rootPageId,
    parentPageId: null,
    title: input.root.displayName,
    depth: 0,
    path: [input.root.displayName],
  }];
  const discovered = new Map<string, string | null>([[input.root.rootPageId, null]]);
  const captured: CapturedPage[] = [];
  let totalCodePoints = 0;

  while (queue.length > 0) {
    const pending = queue.shift();
    if (!pending) {
      break;
    }
    if (
      pending.depth > BACKSTAGE_NOTION_SYNC_MAX_DEPTH
      || captured.length >= BACKSTAGE_NOTION_SYNC_MAX_PAGES
    ) {
      throw new BackstageNotionSyncError(
        BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
        'The configured Notion hierarchy exceeds the bounded synchronization limits.'
      );
    }

    const metadata = await input.request(signal =>
      fetchBackstageNotionPageMetadata(
        input.fetchImpl,
        input.accessToken,
        pending.pageId,
        signal
      )
    );
    validateFetchedPage(pending, metadata);
    const markdown = await input.request(signal =>
      fetchBackstageNotionMarkdownPage(
        input.fetchImpl,
        input.accessToken,
        pending.pageId,
        signal
      )
    );
    if (
      markdown.truncated
      || markdown.unknownBlockCount > 0
      || UNSUPPORTED_ENHANCED_MARKDOWN_PATTERN.test(markdown.markdown)
    ) {
      throw new BackstageNotionSyncError(
        BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
        'The Notion hierarchy contains truncated or unsupported content and was not activated.'
      );
    }
    totalCodePoints += codePointLength(markdown.markdown);
    if (totalCodePoints > BACKSTAGE_NOTION_SYNC_MAX_TOTAL_CODE_POINTS) {
      throw new BackstageNotionSyncError(
        BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
        'The configured Notion hierarchy exceeds the total synchronization limit.'
      );
    }

    const prepared = prepareBackstageNotionRagPage({
      universeId: input.root.universeId,
      pageId: pending.pageId,
      parentPageId: pending.parentPageId,
      title: pending.title,
      path: pending.path,
      markdown: markdown.markdown,
      sourceLastEditedAt: metadata.lastEditedAt.toISOString(),
    });
    const rawChildPageTagCount = Array.from(
      markdown.markdown.matchAll(/<page\b/giu)
    ).length;
    if (
      prepared.invalidChildPageTagCount > 0
      || prepared.childPageTagCount !== rawChildPageTagCount
    ) {
      throw new BackstageNotionSyncError(
        BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
        'The Notion hierarchy contains an ambiguous child-page reference.'
      );
    }
    captured.push({ prepared, metadata });

    for (const child of prepared.childPages) {
      const priorParent = discovered.get(child.pageId);
      if (priorParent !== undefined) {
        if (priorParent !== pending.pageId) {
          throw new BackstageNotionSyncError(
            BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
            'The Notion hierarchy contains a cycle or multi-parent page.'
          );
        }
        continue;
      }
      discovered.set(child.pageId, pending.pageId);
      queue.push({
        pageId: child.pageId,
        parentPageId: pending.pageId,
        title: child.title,
        depth: pending.depth + 1,
        path: [...pending.path, child.title],
      });
    }
  }

  return captured;
}

function sourceMaximumEditedAt(pages: readonly CapturedPage[]): Date | null {
  if (pages.length === 0) {
    return null;
  }
  return new Date(Math.max(...pages.map(page => page.metadata.lastEditedAt.getTime())));
}

function initialActivationMeetsCoverage(input: {
  root: BackstageNotionAuthorityRoot;
  activeInventory: BackstageNotionActiveInventory | null;
  pageCount: number;
}): boolean {
  return input.activeInventory !== null
    || input.root.initialMinimumPageCount === undefined
    || input.pageCount >= input.root.initialMinimumPageCount;
}

/** Build and atomically activate one complete rooted Notion hierarchy. */
export async function syncBackstageNotionAuthorityRoot(
  root: BackstageNotionAuthorityRoot,
  dependencies: BackstageNotionSyncDependencies = {}
): Promise<BackstageNotionSyncResult> {
  const repository = dependencies.repository ?? getBackstageNotionRagRepository();
  const readEnvironment = dependencies.readEnvironment
    ?? ((name: string) => getEnv(name));
  let accessToken: string | null;
  try {
    accessToken = readBackstageNotionAccessToken(readEnvironment);
  } catch {
    accessToken = null;
  }
  if (!accessToken) {
    throw new BackstageNotionSyncError(
      BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE,
      'Backstage Notion synchronization is not configured safely.'
    );
  }
  throwIfAborted(dependencies.signal);
  const holderId = dependencies.holderId ?? SYNC_HOLDER_ID;
  const lease = await repository.acquireSyncLease(
    root.universeId,
    holderId,
    BACKSTAGE_NOTION_SYNC_LEASE_MAX_MS
  );
  if (!lease) {
    return {
      universeId: root.universeId,
      status: 'lease-busy',
      pageCount: 0,
      chunkCount: 0,
      manifestHash: null,
      snapshotId: null,
      verifiedAt: null,
    };
  }

  try {
    const authorityHead = await repository.loadAuthorityHead(root.universeId);
    if (
      authorityHead?.authority === 'notion'
      && authorityHead.rootPageId !== root.rootPageId
    ) {
      throw new BackstageNotionSyncError(
        BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE,
        'The configured Notion authority root conflicts with the persisted authority root.'
      );
    }
    const activeInventory = await repository.loadActiveInventory(root.universeId);
    if (
      activeInventory !== null
      && activeInventory.snapshot.rootPageId !== root.rootPageId
    ) {
      throw new BackstageNotionSyncError(
        BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE,
        'The configured Notion authority root conflicts with the persisted authority root.'
      );
    }

    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const request = createNotionRequestRunner({
      spacingMs: boundedNonnegativeMilliseconds(
        dependencies.requestSpacingMs,
        BACKSTAGE_NOTION_SYNC_REQUEST_SPACING_MS
      ),
      timeoutMs: Math.max(1, boundedNonnegativeMilliseconds(
        dependencies.fetchTimeoutMs,
        BACKSTAGE_NOTION_SYNC_FETCH_TIMEOUT_MS
      )),
      retryBaseDelayMs: boundedNonnegativeMilliseconds(
        dependencies.retryBaseDelayMs,
        500
      ),
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    });
    const startedAt = Date.now();
    const pages = await captureHierarchy({
      root,
      fetchImpl,
      accessToken,
      request,
    });
    if (!initialActivationMeetsCoverage({
      root,
      activeInventory,
      pageCount: pages.length,
    })) {
      throw new BackstageNotionSyncError(
        BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
        'The first Notion snapshot did not meet its configured minimum page coverage.'
      );
    }
    await verifyHierarchyDidNotDrift({
      pages,
      request,
      fetchImpl,
      accessToken,
    });
    const manifestHash = buildManifestHash(pages);

    if (activeInventory?.snapshot.manifestHash === manifestHash) {
      const verifiedAt = await repository.markActiveSnapshotVerified(
        root.universeId,
        manifestHash,
        lease
      );
      if (!verifiedAt) {
        throw new BackstageNotionSyncError(
          BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT_ERROR_CODE,
          'The active Notion snapshot changed before verification could be recorded.'
        );
      }
      safeLog('info', 'backstage.notion_rag.sync_unchanged', {
        universeId: root.universeId,
        pageCount: pages.length,
        chunkCount: activeInventory.snapshot.chunkCount,
        durationMs: Date.now() - startedAt,
      });
      return {
        universeId: root.universeId,
        status: 'unchanged',
        pageCount: pages.length,
        chunkCount: activeInventory.snapshot.chunkCount,
        manifestHash,
        snapshotId: activeInventory.snapshot.id,
        verifiedAt,
      };
    }

    const snapshotChunks = await buildSnapshotChunks({
      universeId: root.universeId,
      pages,
      repository,
      embedBatch: dependencies.embedBatch ?? (inputs => createEmbeddings(inputs)),
    });
    const snapshot = await repository.activateSnapshot({
      universeId: root.universeId,
      rootPageId: root.rootPageId,
      manifestHash,
      embeddingModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
      sourceMaxEditedAt: sourceMaximumEditedAt(pages),
      lease,
      pages: buildSnapshotPages(pages),
      chunks: snapshotChunks,
    });
    safeLog('info', 'backstage.notion_rag.sync_activated', {
      universeId: root.universeId,
      pageCount: snapshot.pageCount,
      chunkCount: snapshot.chunkCount,
      durationMs: Date.now() - startedAt,
    });
    return {
      universeId: root.universeId,
      status: 'activated',
      pageCount: snapshot.pageCount,
      chunkCount: snapshot.chunkCount,
      manifestHash,
      snapshotId: snapshot.id,
      verifiedAt: snapshot.createdAt,
    };
  } finally {
    try {
      await repository.releaseSyncLease(
        root.universeId,
        lease.holderId,
        lease.leaseToken
      );
    } catch {
      safeLog('warn', 'backstage.notion_rag.sync_lease_release_failed', {
        universeId: root.universeId,
      });
    }
  }
}

/** Synchronize every exactly configured authority root sequentially. */
export async function syncConfiguredBackstageNotionAuthorities(
  dependencies: BackstageNotionSyncDependencies = {}
): Promise<BackstageNotionSyncResult[]> {
  const configuration = readBackstageNotionAuthorityConfiguration({
    ...(dependencies.readEnvironment
      ? { readEnvironment: dependencies.readEnvironment }
      : {}),
  });
  if (configuration.status === 'absent') {
    return [];
  }
  if (configuration.status === 'invalid') {
    throw new BackstageNotionSyncError(
      BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE,
      'Backstage Notion authority configuration is invalid.'
    );
  }

  const results: BackstageNotionSyncResult[] = [];
  for (const root of configuration.roots) {
    throwIfAborted(dependencies.signal);
    results.push(await syncBackstageNotionAuthorityRoot(root, dependencies));
  }
  return results;
}

import { createHash, randomUUID } from 'node:crypto';

import {
  BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT,
  BACKSTAGE_NOTION_MAX_REUSABLE_EMBEDDING_HASHES,
  BACKSTAGE_NOTION_SYNC_LEASE_MAX_MS,
  BackstageNotionSnapshotWriteError,
  BackstageNotionSyncLeaseError,
  getBackstageNotionRagRepository,
  type BackstageNotionActiveInventory,
  type BackstageNotionRagRepository,
  type BackstageNotionSnapshotChunkInput,
  type BackstageNotionSnapshotPageInput,
  type BackstageNotionSyncLease,
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
  BACKSTAGE_NOTION_RAG_CHUNK_FORMAT,
  BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION,
  BACKSTAGE_NOTION_RAG_PAGE_FORMAT,
  prepareBackstageNotionRagPage,
  type BackstageNotionPreparedRagPage,
} from '@shared/backstage/backstageNotionRagCore.js';
import {
  BACKSTAGE_NOTION_RAG_INDEX_FORMAT,
  normalizeBackstageNotionScopeKey,
  normalizeBackstageNotionScopePath,
} from '@shared/backstage/backstageNotionScopeIndex.js';
import {
  createEmbeddings,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
} from './openai/embeddings.js';
import { sleep } from '@shared/sleep.js';

export const BACKSTAGE_NOTION_SYNC_MAX_PAGES = 512;
export const BACKSTAGE_NOTION_SYNC_MAX_DEPTH = 16;
export const BACKSTAGE_NOTION_SYNC_MAX_TOTAL_CODE_POINTS = 4_000_000;
export const BACKSTAGE_NOTION_SYNC_MAX_CHUNKS =
  BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT;
export const BACKSTAGE_NOTION_SYNC_FETCH_TIMEOUT_MS = 15_000;
export const BACKSTAGE_NOTION_SYNC_REQUEST_SPACING_MS = 350;
export const BACKSTAGE_NOTION_SYNC_FETCH_ATTEMPTS = 3;
export const BACKSTAGE_NOTION_SYNC_EMBEDDING_BATCH_SIZE = 32;
export const BACKSTAGE_NOTION_SYNC_LEASE_RENEW_INTERVAL_MS = 60_000;
export { BACKSTAGE_NOTION_RAG_INDEX_FORMAT };

const BACKSTAGE_NOTION_RAG_MANIFEST_FORMAT =
  'backstage-notion-rag-manifest-v5';

const SYNC_HOLDER_ID = `backstage-notion-rag:${process.pid}:${randomUUID()}`;
const UNSUPPORTED_ENHANCED_MARKDOWN_PATTERN =
  /<(?:audio|bookmark|database|embed|file|image|link-preview|pdf|unknown|video)\b/iu;

export const BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE =
  'BACKSTAGE_NOTION_SYNC_CONFIGURATION_INVALID';
export const BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE =
  'BACKSTAGE_NOTION_SYNC_INCOMPLETE';
export const BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT_ERROR_CODE =
  'BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT';
export const BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE =
  'BACKSTAGE_NOTION_SYNC_ROOT_FAILED';

export const BACKSTAGE_NOTION_SYNC_FAILURE_PHASES = [
  'authorization',
  'root_resolution',
  'discovery',
  'page_fetch',
  'block_fetch',
  'pagination',
  'normalization',
  'chunking',
  'embedding',
  'persistence',
  'completeness_validation',
  'activation',
  'cleanup',
  'deadline',
  'lease',
] as const;

export const BACKSTAGE_NOTION_SYNC_FAILURE_REASONS = [
  'deadline_exhausted',
  'rate_limit_exhausted',
  'transient_retry_exhausted',
  'permanent_notion_error',
  'inaccessible_page',
  'pagination_incomplete',
  'discovered_page_missing',
  'source_changed',
  'chunk_limit_reached',
  'embedding_failed',
  'persistence_failed',
  'completeness_mismatch',
  'activation_failed',
  'lease_lost',
  'invalid_configuration',
  'unexpected_failure',
] as const;

export type BackstageNotionSyncFailurePhase =
  (typeof BACKSTAGE_NOTION_SYNC_FAILURE_PHASES)[number];
export type BackstageNotionSyncFailureReason =
  (typeof BACKSTAGE_NOTION_SYNC_FAILURE_REASONS)[number];

export interface BackstageNotionSyncFailureDiagnostics {
  phase: BackstageNotionSyncFailurePhase;
  reason: BackstageNotionSyncFailureReason;
  pagesDiscovered: number;
  pagesFetched: number;
  blocksFetched: number;
  paginationRequests: number;
  chunksProduced: number;
  chunksEmbedded: number;
  notionRetryCount: number;
  rateLimitWaitMs: number;
  elapsedMs: number;
  candidateSnapshotCreated: boolean;
  candidateSnapshotValidated: boolean;
  candidateSnapshotActivated: boolean;
}

interface BackstageNotionSyncProgress extends Omit<
  BackstageNotionSyncFailureDiagnostics,
  'phase' | 'reason' | 'elapsedMs'
> {
  startedAt: number;
  phase: BackstageNotionSyncFailurePhase;
}

export class BackstageNotionSyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly diagnostics?: BackstageNotionSyncFailureDiagnostics
  ) {
    super(message);
    this.name = 'BackstageNotionSyncError';
  }
}

class BackstageNotionGlobalConfigurationError extends BackstageNotionSyncError {}

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
  leaseRenewalIntervalMs?: number;
}

export interface BackstageNotionSyncResult {
  universeId: string;
  status: 'activated' | 'unchanged' | 'lease-busy' | 'failed';
  pageCount: number;
  chunkCount: number;
  manifestHash: string | null;
  snapshotId: string | null;
  verifiedAt: Date | null;
  errorCode?: string;
  failure?: BackstageNotionSyncFailureDiagnostics;
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

function createSyncProgress(): BackstageNotionSyncProgress {
  return {
    startedAt: Date.now(),
    phase: 'authorization',
    pagesDiscovered: 0,
    pagesFetched: 0,
    blocksFetched: 0,
    paginationRequests: 0,
    chunksProduced: 0,
    chunksEmbedded: 0,
    notionRetryCount: 0,
    rateLimitWaitMs: 0,
    candidateSnapshotCreated: false,
    candidateSnapshotValidated: false,
    candidateSnapshotActivated: false,
  };
}

function snapshotSyncFailureDiagnostics(
  progress: BackstageNotionSyncProgress,
  phase: BackstageNotionSyncFailurePhase,
  reason: BackstageNotionSyncFailureReason
): BackstageNotionSyncFailureDiagnostics {
  return {
    phase,
    reason,
    pagesDiscovered: progress.pagesDiscovered,
    pagesFetched: progress.pagesFetched,
    blocksFetched: progress.blocksFetched,
    paginationRequests: progress.paginationRequests,
    chunksProduced: progress.chunksProduced,
    chunksEmbedded: progress.chunksEmbedded,
    notionRetryCount: progress.notionRetryCount,
    rateLimitWaitMs: progress.rateLimitWaitMs,
    elapsedMs: Math.max(0, Date.now() - progress.startedAt),
    candidateSnapshotCreated: progress.candidateSnapshotCreated,
    candidateSnapshotValidated: progress.candidateSnapshotValidated,
    candidateSnapshotActivated: progress.candidateSnapshotActivated,
  };
}

function incompleteSyncError(
  progress: BackstageNotionSyncProgress,
  phase: BackstageNotionSyncFailurePhase,
  reason: BackstageNotionSyncFailureReason,
  message: string
): BackstageNotionSyncError {
  return new BackstageNotionSyncError(
    BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
    message,
    snapshotSyncFailureDiagnostics(progress, phase, reason)
  );
}

function classifyNotionReadFailure(
  error: BackstageNotionReadError,
  currentPhase: BackstageNotionSyncFailurePhase
): Pick<BackstageNotionSyncFailureDiagnostics, 'phase' | 'reason'> {
  if (error.category === 'http_429') {
    return { phase: 'deadline', reason: 'rate_limit_exhausted' };
  }
  if (/^http_(?:500|502|503|504|529)$/u.test(error.category)) {
    return { phase: 'page_fetch', reason: 'transient_retry_exhausted' };
  }
  if (/^http_(?:401|403|404)$/u.test(error.category)) {
    return {
      phase: currentPhase === 'pagination' ? 'pagination' : 'page_fetch',
      reason: 'inaccessible_page',
    };
  }
  return { phase: 'page_fetch', reason: 'permanent_notion_error' };
}

function wrapSyncFailure(
  error: unknown,
  progress: BackstageNotionSyncProgress
): BackstageNotionSyncError | BackstageNotionSyncLeaseError | unknown {
  if (error instanceof BackstageNotionSyncError) {
    return error.diagnostics
      ? error
      : new BackstageNotionSyncError(
          error.code,
          error.message,
          snapshotSyncFailureDiagnostics(
            progress,
            progress.phase,
            error.code === BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE
              ? 'invalid_configuration'
              : error.code === BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT_ERROR_CODE
                ? 'source_changed'
                : 'unexpected_failure'
          )
        );
  }
  if (error instanceof BackstageNotionSyncLeaseError) {
    return error;
  }
  if (error instanceof BackstageNotionSnapshotWriteError) {
    return new BackstageNotionSyncError(
      BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
      'Backstage Notion synchronization could not complete safely.',
      snapshotSyncFailureDiagnostics(
        progress,
        error.phase,
        error.phase === 'completeness_validation'
          ? 'completeness_mismatch'
          : error.phase === 'activation'
            ? 'activation_failed'
            : 'persistence_failed'
      )
    );
  }
  if (error instanceof BackstageNotionReadError) {
    const failure = classifyNotionReadFailure(error, progress.phase);
    return new BackstageNotionSyncError(
      failure.reason === 'inaccessible_page'
        ? BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE
        : BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
      'Backstage Notion synchronization could not complete safely.',
      snapshotSyncFailureDiagnostics(progress, failure.phase, failure.reason)
    );
  }
  if (
    (error instanceof Error || error instanceof DOMException)
    && error.name === 'AbortError'
  ) {
    return error;
  }
  return new BackstageNotionSyncError(
    BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
    'Backstage Notion synchronization could not complete safely.',
    snapshotSyncFailureDiagnostics(
      progress,
      progress.phase,
      progress.phase === 'embedding'
        ? 'embedding_failed'
        : progress.phase === 'persistence'
          ? 'persistence_failed'
          : progress.phase === 'activation'
            ? 'activation_failed'
            : 'unexpected_failure'
    )
  );
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

async function raceWithSignal<T>(
  operation: () => Promise<T>,
  signal: AbortSignal
): Promise<T> {
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
    const onAbort = (): void => {
      finish(() => {
        try {
          throwIfAborted(signal);
        } catch (error) {
          reject(error);
        }
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    void pending.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error))
    );
  });
}

class BackstageNotionLeaseHeartbeat {
  private readonly controller = new AbortController();
  private readonly forwardParentAbort: (() => void) | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private renewalInFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly repository: BackstageNotionRagRepository,
    private readonly lease: BackstageNotionSyncLease,
    private readonly renewalIntervalMs: number,
    private readonly parentSignal: AbortSignal | undefined
  ) {
    this.forwardParentAbort = parentSignal
      ? () => this.controller.abort(parentSignal.reason)
      : null;
    if (this.forwardParentAbort) {
      parentSignal?.addEventListener('abort', this.forwardParentAbort, { once: true });
    }
    if (parentSignal?.aborted) {
      this.controller.abort(parentSignal.reason);
    } else {
      this.scheduleRenewal();
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.forwardParentAbort) {
      this.parentSignal?.removeEventListener('abort', this.forwardParentAbort);
    }
    await this.renewalInFlight?.catch(() => undefined);
  }

  private scheduleRenewal(): void {
    if (
      this.stopped
      || this.controller.signal.aborted
      || this.timer
      || this.renewalInFlight
    ) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped || this.controller.signal.aborted) {
        return;
      }
      const renewal = this.renewLease();
      this.renewalInFlight = renewal;
      void renewal.then(() => {
        if (this.renewalInFlight === renewal) {
          this.renewalInFlight = null;
        }
        this.scheduleRenewal();
      });
    }, this.renewalIntervalMs);
    this.timer.unref?.();
  }

  private async renewLease(): Promise<void> {
    try {
      const renewed = await this.repository.renewSyncLease(
        this.lease.universeId,
        this.lease.holderId,
        this.lease.leaseToken,
        BACKSTAGE_NOTION_SYNC_LEASE_MAX_MS
      );
      if (
        !renewed
        || renewed.universeId !== this.lease.universeId
        || renewed.holderId !== this.lease.holderId
        || renewed.leaseToken !== this.lease.leaseToken
      ) {
        throw new BackstageNotionSyncLeaseError();
      }
    } catch (error) {
      if (this.stopped || this.controller.signal.aborted) {
        return;
      }
      this.controller.abort(
        error instanceof BackstageNotionSyncLeaseError
          ? error
          : new BackstageNotionSyncLeaseError()
      );
    }
  }
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
  metadata: BackstageNotionPageMetadata,
  progress: BackstageNotionSyncProgress
): void {
  if (
    metadata.pageId !== pending.pageId
    || metadata.inTrash
    || (
      pending.parentPageId !== null
      && metadata.parentPageId !== pending.parentPageId
    )
  ) {
    throw incompleteSyncError(
      progress,
      'completeness_validation',
      metadata.inTrash ? 'inaccessible_page' : 'discovered_page_missing',
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
    format: BACKSTAGE_NOTION_RAG_MANIFEST_FORMAT,
    indexFormat: BACKSTAGE_NOTION_RAG_INDEX_FORMAT,
    pageFormat: BACKSTAGE_NOTION_RAG_PAGE_FORMAT,
    chunkFormat: BACKSTAGE_NOTION_RAG_CHUNK_FORMAT,
    embeddingModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
    pages: manifest,
  }));
}

function canonicalPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replaceAll('-', '')}`;
}

async function loadReusableEmbeddings(
  repository: BackstageNotionRagRepository,
  universeId: string,
  hashes: readonly string[],
  signal: AbortSignal
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
    const loaded = await raceWithSignal(
      () => repository.loadReusableEmbeddings(
        universeId,
        DEFAULT_OPENAI_EMBEDDING_MODEL,
        batch
      ),
      signal
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
  signal: AbortSignal;
  progress: BackstageNotionSyncProgress;
}): Promise<BackstageNotionSnapshotChunkInput[]> {
  const chunks = input.pages.flatMap(page => [...page.prepared.chunks]);
  input.progress.phase = 'chunking';
  input.progress.chunksProduced = chunks.length;
  if (chunks.length < 1 || chunks.length > BACKSTAGE_NOTION_SYNC_MAX_CHUNKS) {
    throw incompleteSyncError(
      input.progress,
      'chunking',
      'chunk_limit_reached',
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
    hashes,
    input.signal
  );
  const missingHashes = hashes.filter(hash => !embeddings.has(hash));
  input.progress.phase = 'embedding';
  for (
    let index = 0;
    index < missingHashes.length;
    index += BACKSTAGE_NOTION_SYNC_EMBEDDING_BATCH_SIZE
  ) {
    const batchHashes = missingHashes.slice(
      index,
      index + BACKSTAGE_NOTION_SYNC_EMBEDDING_BATCH_SIZE
    );
    const batchEmbeddings = await raceWithSignal(
      () => input.embedBatch(
        batchHashes.map(hash => byHash.get(hash) ?? '')
      ),
      input.signal
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
    input.progress.chunksEmbedded += batchHashes.length;
  }

  return chunks.map(chunk => ({
    chunkId: chunk.chunkId,
    pageId: chunk.pageId,
    ordinal: chunk.ordinal,
    contentHash: chunk.contentHash,
    content: chunk.content,
    codePoints: chunk.codePoints,
    embedding: embeddings.get(chunk.contentHash) ?? [],
    headingPath: [...chunk.headingPath],
    metadata: {
      category: chunk.category,
      headingIndexVersion: BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION,
      headingOccurrencePath: [...chunk.headingOccurrencePath],
      scopeHeadingPathKey: normalizeBackstageNotionScopePath(chunk.headingPath),
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
      headingIndexVersion: BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION,
      indexFormat: BACKSTAGE_NOTION_RAG_INDEX_FORMAT,
      scopePathKey: normalizeBackstageNotionScopePath(prepared.path),
      scopeTitleKey: normalizeBackstageNotionScopeKey(prepared.title),
    },
  }));
}

async function verifyHierarchyDidNotDrift(input: {
  pages: readonly CapturedPage[];
  request: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  fetchImpl: BackstageNotionFetchImplementation;
  accessToken: string;
  progress: BackstageNotionSyncProgress;
}): Promise<void> {
  input.progress.phase = 'completeness_validation';
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
        'The Notion hierarchy changed during synchronization; the candidate snapshot was discarded.',
        snapshotSyncFailureDiagnostics(
          input.progress,
          'completeness_validation',
          'source_changed'
        )
      );
    }
  }
}

async function captureHierarchy(input: {
  root: BackstageNotionAuthorityRoot;
  fetchImpl: BackstageNotionFetchImplementation;
  accessToken: string;
  request: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  progress: BackstageNotionSyncProgress;
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
  input.progress.phase = 'discovery';
  input.progress.pagesDiscovered = 1;

  while (queue.length > 0) {
    const pending = queue.shift();
    if (!pending) {
      break;
    }
    if (
      pending.depth > BACKSTAGE_NOTION_SYNC_MAX_DEPTH
      || captured.length >= BACKSTAGE_NOTION_SYNC_MAX_PAGES
    ) {
      throw incompleteSyncError(
        input.progress,
        'discovery',
        'completeness_mismatch',
        'The configured Notion hierarchy exceeds the bounded synchronization limits.'
      );
    }

    input.progress.phase = 'page_fetch';
    const metadata = await input.request(signal =>
      fetchBackstageNotionPageMetadata(
        input.fetchImpl,
        input.accessToken,
        pending.pageId,
        signal
      )
    );
    validateFetchedPage(pending, metadata, input.progress);
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

function requireBackstageNotionAccessToken(
  readEnvironment: BackstageNotionAuthorityEnvironmentReader
): string {
  let accessToken: string | null;
  try {
    accessToken = readBackstageNotionAccessToken(readEnvironment);
  } catch {
    accessToken = null;
  }
  if (!accessToken) {
    throw new BackstageNotionGlobalConfigurationError(
      BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE,
      'Backstage Notion synchronization is not configured safely.'
    );
  }
  return accessToken;
}

function rootFailureCode(error: unknown): string {
  if (
    error instanceof BackstageNotionSyncError
    || error instanceof BackstageNotionSyncLeaseError
  ) {
    return error.code;
  }
  return BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE;
}

function rootFailureDiagnostics(
  error: unknown
): BackstageNotionSyncFailureDiagnostics {
  if (error instanceof BackstageNotionSyncError && error.diagnostics) {
    return error.diagnostics;
  }
  const progress = createSyncProgress();
  return snapshotSyncFailureDiagnostics(
    progress,
    error instanceof BackstageNotionSyncLeaseError ? 'lease' : 'cleanup',
    error instanceof BackstageNotionSyncLeaseError
      ? 'lease_lost'
      : 'unexpected_failure'
  );
}

/** Build and atomically activate one complete rooted Notion hierarchy. */
export async function syncBackstageNotionAuthorityRoot(
  root: BackstageNotionAuthorityRoot,
  dependencies: BackstageNotionSyncDependencies = {}
): Promise<BackstageNotionSyncResult> {
  const progress = createSyncProgress();
  const repository = dependencies.repository ?? getBackstageNotionRagRepository();
  const readEnvironment = dependencies.readEnvironment ?? getEnv;
  let accessToken: string;
  try {
    accessToken = requireBackstageNotionAccessToken(readEnvironment);
  } catch (error) {
    throw wrapSyncFailure(error, progress);
  }
  throwIfAborted(dependencies.signal);
  const holderId = dependencies.holderId ?? SYNC_HOLDER_ID;
  progress.phase = 'lease';
  let lease: BackstageNotionSyncLease | null;
  try {
    lease = await repository.acquireSyncLease(
      root.universeId,
      holderId,
      BACKSTAGE_NOTION_SYNC_LEASE_MAX_MS
    );
  } catch (error) {
    throw wrapSyncFailure(error, progress);
  }
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
  const heartbeat = new BackstageNotionLeaseHeartbeat(
    repository,
    lease,
    Math.max(1, Math.min(
      Math.floor(BACKSTAGE_NOTION_SYNC_LEASE_MAX_MS / 3),
      boundedNonnegativeMilliseconds(
        dependencies.leaseRenewalIntervalMs,
        BACKSTAGE_NOTION_SYNC_LEASE_RENEW_INTERVAL_MS
      )
    )),
    dependencies.signal
  );

  try {
    progress.phase = 'root_resolution';
    const authorityHead = await raceWithSignal(
      () => repository.loadAuthorityHead(root.universeId),
      heartbeat.signal
    );
    if (
      authorityHead?.authority === 'notion'
      && authorityHead.rootPageId !== root.rootPageId
    ) {
      throw new BackstageNotionSyncError(
        BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE,
        'The configured Notion authority root conflicts with the persisted authority root.'
      );
    }
    const activeInventory = await raceWithSignal(
      () => repository.loadActiveInventory(root.universeId),
      heartbeat.signal
    );
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
      signal: heartbeat.signal,
    });
    const startedAt = Date.now();
    const pages = await captureHierarchy({
      root,
      fetchImpl,
      accessToken,
      request,
      progress,
    });
    progress.phase = 'completeness_validation';
    if (!initialActivationMeetsCoverage({
      root,
      activeInventory,
      pageCount: pages.length,
    })) {
      throw incompleteSyncError(
        progress,
        'completeness_validation',
        'completeness_mismatch',
        'The first Notion snapshot did not meet its configured minimum page coverage.'
      );
    }
    const manifestHash = buildManifestHash(pages);

    if (
      activeInventory?.snapshot.manifestHash === manifestHash
      && activeInventory.snapshot.embeddingModel === DEFAULT_OPENAI_EMBEDDING_MODEL
      && activeInventory.snapshot.chunkCount <= BACKSTAGE_NOTION_SYNC_MAX_CHUNKS
    ) {
      await verifyHierarchyDidNotDrift({
        pages,
        request,
        fetchImpl,
        accessToken,
        progress,
      });
      throwIfAborted(heartbeat.signal);
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
      embedBatch: dependencies.embedBatch ?? createEmbeddings,
      signal: heartbeat.signal,
      progress,
    });
    progress.candidateSnapshotCreated = true;
    await verifyHierarchyDidNotDrift({
      pages,
      request,
      fetchImpl,
      accessToken,
      progress,
    });
    progress.candidateSnapshotValidated = true;
    throwIfAborted(heartbeat.signal);
    progress.phase = 'persistence';
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
    progress.phase = 'activation';
    progress.candidateSnapshotActivated = true;
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
  } catch (error) {
    throw wrapSyncFailure(error, progress);
  } finally {
    await heartbeat.stop();
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
  requireBackstageNotionAccessToken(
    dependencies.readEnvironment ?? getEnv
  );

  const results: BackstageNotionSyncResult[] = [];
  for (const root of configuration.roots) {
    throwIfAborted(dependencies.signal);
    try {
      results.push(await syncBackstageNotionAuthorityRoot(root, dependencies));
    } catch (error) {
      throwIfAborted(dependencies.signal);
      if (error instanceof BackstageNotionGlobalConfigurationError) {
        throw error;
      }
      const errorCode = rootFailureCode(error);
      const failure = rootFailureDiagnostics(error);
      safeLog('warn', 'backstage.notion_rag.sync_root_failed', {
        universeId: root.universeId,
        errorCode,
        ...failure,
      });
      results.push({
        universeId: root.universeId,
        status: 'failed',
        pageCount: 0,
        chunkCount: 0,
        manifestHash: null,
        snapshotId: null,
        verifiedAt: null,
        errorCode,
        failure,
      });
    }
  }
  return results;
}

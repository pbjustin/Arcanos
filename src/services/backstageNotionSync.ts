import { createHash, randomUUID } from 'node:crypto';

import {
  BACKSTAGE_NOTION_MAX_REUSABLE_EMBEDDING_HASHES,
  BACKSTAGE_NOTION_SYNC_LEASE_MAX_MS,
  BackstageNotionSnapshotCommitUnknownError,
  BackstageNotionSnapshotDeadlineError,
  BackstageNotionSnapshotWriteError,
  BackstageNotionSyncLeaseError,
  getBackstageNotionRagRepository,
  type BackstageNotionActiveInventory,
  type BackstageNotionRagRepository,
  type BackstageNotionSnapshotChunkInput,
  type BackstageNotionSnapshotPageInput,
  type BackstageNotionSyncLease,
} from '@core/db/repositories/backstageNotionRagRepository.js';
import {
  getBackstageNotionSyncStatusRepository,
  type BackstageNotionSyncAttemptRecord,
  type BackstageNotionSyncStatusRepository,
} from '@core/db/repositories/backstageNotionSyncStatusRepository.js';
import {
  BACKSTAGE_NOTION_MAX_WRITABLE_CHUNKS_PER_SNAPSHOT,
  acquireBackstageNotionSyncLeaseWithLateRelease,
  shouldVerifyBackstageNotionSnapshotUnchanged,
} from '@shared/backstage/backstageNotionSyncCore.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { getEnv } from '@platform/runtime/env.js';
import {
  readBackstageNotionAuthorityConfiguration,
  type BackstageNotionAuthorityEnvironmentReader,
  type BackstageNotionAuthorityRoot,
} from './backstageNotionAuthority.js';
import {
  BACKSTAGE_NOTION_MAX_PAGE_TITLE_PROPERTY_ITEMS,
  BackstageNotionReadError,
  assembleBackstageNotionPageTitle,
  fetchBackstageNotionDatabaseMetadata,
  fetchBackstageNotionMarkdownPage,
  fetchBackstageNotionPageMetadata,
  fetchBackstageNotionPageTitleProperty,
  normalizeBackstageNotionPageId,
  queryBackstageNotionDataSource,
  readBackstageNotionAccessToken,
  type BackstageNotionDatabaseMetadata,
  type BackstageNotionEndpointKind,
  type BackstageNotionFailureCategory,
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
import type {
  BackstageNotionSyncFailurePhase,
  BackstageNotionSyncFailureReason,
} from '@shared/backstage/backstageNotionSnapshotStatus.js';

export {
  BACKSTAGE_NOTION_SYNC_FAILURE_PHASES,
  BACKSTAGE_NOTION_SYNC_FAILURE_REASONS,
  type BackstageNotionSyncFailurePhase,
  type BackstageNotionSyncFailureReason,
} from '@shared/backstage/backstageNotionSnapshotStatus.js';

export const BACKSTAGE_NOTION_SYNC_MAX_PAGES = 512;
export const BACKSTAGE_NOTION_SYNC_MAX_DEPTH = 16;
export const BACKSTAGE_NOTION_SYNC_MAX_TOTAL_CODE_POINTS = 4_000_000;
export const BACKSTAGE_NOTION_SYNC_MAX_CHUNKS =
  BACKSTAGE_NOTION_MAX_WRITABLE_CHUNKS_PER_SNAPSHOT;
export const BACKSTAGE_NOTION_SYNC_FETCH_TIMEOUT_MS = 15_000;
export const BACKSTAGE_NOTION_SYNC_REQUEST_SPACING_MS = 350;
export const BACKSTAGE_NOTION_SYNC_FETCH_ATTEMPTS = 3;
export const BACKSTAGE_NOTION_SYNC_EMBEDDING_BATCH_SIZE = 32;
export const BACKSTAGE_NOTION_SYNC_MAX_MARKDOWN_SEGMENTS_PER_PAGE = 256;
export const BACKSTAGE_NOTION_SYNC_MAX_DATA_SOURCE_QUERY_REQUESTS = 1_024;
export const BACKSTAGE_NOTION_SYNC_MAX_RETRY_AFTER_MS = 60_000;
export const BACKSTAGE_NOTION_SYNC_RETRY_JITTER_MAX_MS = 250;
export const BACKSTAGE_NOTION_SYNC_LEASE_RENEW_INTERVAL_MS = 60_000;
// Preserve the original cycle's non-spacing headroom while admitting one
// complete-title request in both capture and verification for every page.
export const BACKSTAGE_NOTION_SYNC_CYCLE_TIMEOUT_MS =
  14 * 60 * 1_000
  + BACKSTAGE_NOTION_SYNC_MAX_PAGES
    * 2
    * BACKSTAGE_NOTION_SYNC_REQUEST_SPACING_MS;
export const BACKSTAGE_NOTION_SYNC_CLEANUP_TIMEOUT_MS = 5_000;
export { BACKSTAGE_NOTION_RAG_INDEX_FORMAT };

const BACKSTAGE_NOTION_RAG_MANIFEST_FORMAT =
  'backstage-notion-rag-manifest-v6';

const SYNC_HOLDER_ID = `backstage-notion-rag:${process.pid}:${randomUUID()}`;
const UNSUPPORTED_ENHANCED_MARKDOWN_PATTERN =
  /<(?:audio|bookmark|database|embed|file|image|link-preview|pdf|unknown|video)\b/iu;
const UNKNOWN_ENHANCED_MARKDOWN_TAG_PATTERN = /<unknown\b[^>]*>/giu;
const NOTION_IDENTIFIER_IN_TAG_PATTERN =
  /(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/giu;

export const BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE =
  'BACKSTAGE_NOTION_SYNC_CONFIGURATION_INVALID';
export const BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE =
  'BACKSTAGE_NOTION_SYNC_INCOMPLETE';
export const BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT_ERROR_CODE =
  'BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT';
export const BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE =
  'BACKSTAGE_NOTION_SYNC_ROOT_FAILED';

export interface BackstageNotionSyncFailureDiagnostics {
  phase: BackstageNotionSyncFailurePhase;
  reason: BackstageNotionSyncFailureReason;
  pagesDiscovered: number;
  pagesFetched: number;
  blocksFetched: number;
  paginationRequests: number;
  normalizedSegments: number;
  emptySegmentsRemoved: number;
  exactDuplicatesRemoved: number;
  adjacentSegmentsMerged: number;
  chunksProduced: number;
  chunksEmbedded: number;
  minimumChunkCodePoints: number;
  maximumChunkCodePoints: number;
  medianChunkCodePoints: number;
  reusedEmbeddingCount: number;
  newEmbeddingCount: number;
  notionRetryCount: number;
  rateLimitWaitMs: number;
  notionHttpStatus: number | null;
  notionProviderCode: string | null;
  notionFailureCategory: BackstageNotionFailureCategory | null;
  notionResponseContentType: string | null;
  notionResponseSchemaValid: boolean | null;
  notionEndpointKind: BackstageNotionEndpointKind | null;
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
  syncStatusRepository?: BackstageNotionSyncStatusRepository;
  fetchImpl?: BackstageNotionFetchImplementation;
  readEnvironment?: BackstageNotionAuthorityEnvironmentReader;
  embedBatch?: (
    inputs: readonly string[],
    signal?: AbortSignal
  ) => Promise<number[][]>;
  signal?: AbortSignal;
  holderId?: string;
  requestSpacingMs?: number;
  fetchTimeoutMs?: number;
  cycleTimeoutMs?: number;
  retryBaseDelayMs?: number;
  leaseRenewalIntervalMs?: number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
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
  expectedProviderParentPageId?: string | null;
  expectedProviderParentDataSourceId?: string | null;
  membershipDataSourceId?: string | null;
  appendProviderTitleToPath?: boolean;
  preloadedMetadata?: BackstageNotionPageMetadata;
}

interface CapturedPage {
  prepared: BackstageNotionPreparedRagPage;
  metadata: BackstageNotionPageMetadata;
  sourceObjectType: 'page' | 'database';
  membershipDataSourceId: string | null;
  databaseDataSourceIds: readonly string[];
}

interface DatabaseRootPageMembership {
  pageId: string;
  dataSourceId: string;
}

interface DatabaseRootCaptureState {
  metadata: BackstageNotionDatabaseMetadata;
  pages: readonly DatabaseRootPageMembership[];
}

interface CapturedHierarchy {
  pages: CapturedPage[];
  databaseRoot: DatabaseRootCaptureState | null;
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
    normalizedSegments: 0,
    emptySegmentsRemoved: 0,
    exactDuplicatesRemoved: 0,
    adjacentSegmentsMerged: 0,
    chunksProduced: 0,
    chunksEmbedded: 0,
    minimumChunkCodePoints: 0,
    maximumChunkCodePoints: 0,
    medianChunkCodePoints: 0,
    reusedEmbeddingCount: 0,
    newEmbeddingCount: 0,
    notionRetryCount: 0,
    rateLimitWaitMs: 0,
    notionHttpStatus: null,
    notionProviderCode: null,
    notionFailureCategory: null,
    notionResponseContentType: null,
    notionResponseSchemaValid: null,
    notionEndpointKind: null,
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
    normalizedSegments: progress.normalizedSegments,
    emptySegmentsRemoved: progress.emptySegmentsRemoved,
    exactDuplicatesRemoved: progress.exactDuplicatesRemoved,
    adjacentSegmentsMerged: progress.adjacentSegmentsMerged,
    chunksProduced: progress.chunksProduced,
    chunksEmbedded: progress.chunksEmbedded,
    minimumChunkCodePoints: progress.minimumChunkCodePoints,
    maximumChunkCodePoints: progress.maximumChunkCodePoints,
    medianChunkCodePoints: progress.medianChunkCodePoints,
    reusedEmbeddingCount: progress.reusedEmbeddingCount,
    newEmbeddingCount: progress.newEmbeddingCount,
    notionRetryCount: progress.notionRetryCount,
    rateLimitWaitMs: progress.rateLimitWaitMs,
    notionHttpStatus: progress.notionHttpStatus,
    notionProviderCode: progress.notionProviderCode,
    notionFailureCategory: progress.notionFailureCategory,
    notionResponseContentType: progress.notionResponseContentType,
    notionResponseSchemaValid: progress.notionResponseSchemaValid,
    notionEndpointKind: progress.notionEndpointKind,
    elapsedMs: Math.max(0, Date.now() - progress.startedAt),
    candidateSnapshotCreated: progress.candidateSnapshotCreated,
    candidateSnapshotValidated: progress.candidateSnapshotValidated,
    candidateSnapshotActivated: progress.candidateSnapshotActivated,
  };
}

function syncAttemptDiagnosticsState(
  progress: Pick<
    BackstageNotionSyncProgress,
    | 'pagesDiscovered'
    | 'pagesFetched'
    | 'blocksFetched'
    | 'chunksProduced'
    | 'chunksEmbedded'
    | 'candidateSnapshotCreated'
    | 'candidateSnapshotValidated'
    | 'candidateSnapshotActivated'
  >
) {
  return {
    pagesDiscovered: progress.pagesDiscovered,
    pagesFetched: progress.pagesFetched,
    blocksFetched: progress.blocksFetched,
    chunksProduced: progress.chunksProduced,
    chunksEmbedded: progress.chunksEmbedded,
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
    return { phase: currentPhase, reason: 'rate_limit_exhausted' };
  }
  if (/^(?:http_(?:409|500|502|503|504|529)|request_failed)$/u.test(error.category)) {
    return { phase: currentPhase, reason: 'transient_retry_exhausted' };
  }
  if (/^http_(?:401|403)$/u.test(error.category)) {
    return { phase: 'authorization', reason: 'permanent_notion_error' };
  }
  if (error.category === 'http_404') {
    return {
      phase: currentPhase,
      reason: 'inaccessible_page',
    };
  }
  return { phase: currentPhase, reason: 'permanent_notion_error' };
}

function captureNotionReadDiagnostics(
  progress: BackstageNotionSyncProgress,
  error: BackstageNotionReadError
): void {
  progress.notionHttpStatus = error.notionHttpStatus;
  progress.notionProviderCode = error.notionProviderCode;
  progress.notionFailureCategory = error.notionFailureCategory;
  progress.notionResponseContentType = error.notionResponseContentType;
  progress.notionResponseSchemaValid = error.notionResponseSchemaValid;
  progress.notionEndpointKind = error.notionEndpointKind;
}

class BackstageNotionRequestDeadlineError extends Error {
  constructor() {
    super('The bounded Notion request deadline was exhausted.');
    this.name = 'BackstageNotionRequestDeadlineError';
  }
}

function remainingCycleMilliseconds(deadlineAtMs: number): number {
  const remainingMs = Math.trunc(deadlineAtMs - Date.now());
  if (remainingMs < 1) {
    throw new BackstageNotionCycleDeadlineError();
  }
  return remainingMs;
}

class BackstageNotionCycleDeadlineError extends Error {
  constructor() {
    super('The bounded Notion synchronization cycle deadline was exhausted.');
    this.name = 'BackstageNotionCycleDeadlineError';
  }
}

class DiagnosedBackstageNotionSyncLeaseError extends BackstageNotionSyncLeaseError {
  constructor(readonly diagnostics: BackstageNotionSyncFailureDiagnostics) {
    super();
    this.name = 'DiagnosedBackstageNotionSyncLeaseError';
  }
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
    return error instanceof DiagnosedBackstageNotionSyncLeaseError
      ? error
      : new DiagnosedBackstageNotionSyncLeaseError(
          snapshotSyncFailureDiagnostics(progress, 'lease', 'lease_lost')
        );
  }
  if (error instanceof BackstageNotionSnapshotDeadlineError) {
    return new BackstageNotionSyncError(
      BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
      'Backstage Notion synchronization could not complete safely.',
      snapshotSyncFailureDiagnostics(
        progress,
        error.phase,
        'deadline_exhausted'
      )
    );
  }
  if (error instanceof BackstageNotionSnapshotCommitUnknownError) {
    return new BackstageNotionSyncError(
      BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
      'Backstage Notion synchronization could not complete safely.',
      snapshotSyncFailureDiagnostics(progress, 'activation', 'activation_failed')
    );
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
    captureNotionReadDiagnostics(progress, error);
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
    error instanceof BackstageNotionRequestDeadlineError
    || error instanceof BackstageNotionCycleDeadlineError
  ) {
    return new BackstageNotionSyncError(
      BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
      'Backstage Notion synchronization could not complete safely.',
      snapshotSyncFailureDiagnostics(
        progress,
        progress.phase,
        'deadline_exhausted'
      )
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

class BackstageNotionCycleDeadline {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly forwardParentAbort: (() => void) | null;
  private readonly parentSignal: AbortSignal | undefined;
  readonly deadlineAtMs: number;

  constructor(timeoutMs: number, parentSignal: AbortSignal | undefined) {
    this.parentSignal = parentSignal;
    this.deadlineAtMs = Date.now() + timeoutMs;
    this.forwardParentAbort = parentSignal
      ? () => this.controller.abort(parentSignal.reason)
      : null;
    if (this.forwardParentAbort) {
      parentSignal?.addEventListener('abort', this.forwardParentAbort, { once: true });
    }
    if (parentSignal?.aborted) {
      this.controller.abort(parentSignal.reason);
    }
    this.timer = setTimeout(() => {
      this.controller.abort(new BackstageNotionCycleDeadlineError());
    }, timeoutMs);
    this.timer.unref?.();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  dispose(): void {
    clearTimeout(this.timer);
    if (this.forwardParentAbort) {
      this.parentSignal?.removeEventListener('abort', this.forwardParentAbort);
    }
  }
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
    const renewalInFlight = this.renewalInFlight;
    if (renewalInFlight) {
      await runWithTimeout(
        BACKSTAGE_NOTION_SYNC_CLEANUP_TIMEOUT_MS,
        undefined,
        signal => raceWithSignal(() => renewalInFlight, signal)
      ).catch(() => undefined);
    }
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
    controller.abort(new BackstageNotionRequestDeadlineError());
  }, timeoutMs);
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const rejectOnAbort = (): void => {
      const reason = controller.signal.reason;
      reject(
        reason instanceof Error || reason instanceof DOMException
          ? reason
          : new DOMException('The operation was aborted.', 'AbortError')
      );
    };
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([operation(controller.signal), abortPromise]);
  } finally {
    clearTimeout(timeoutHandle);
    parentSignal?.removeEventListener('abort', forwardAbort);
  }
}

async function releaseSyncLeaseBounded(
  repository: BackstageNotionRagRepository,
  universeId: string,
  lease: Pick<BackstageNotionSyncLease, 'holderId' | 'leaseToken'>
): Promise<void> {
  try {
    await runWithTimeout(
      BACKSTAGE_NOTION_SYNC_CLEANUP_TIMEOUT_MS,
      undefined,
      signal => raceWithSignal(
        () => repository.releaseSyncLease(
          universeId,
          lease.holderId,
          lease.leaseToken
        ),
        signal
      )
    );
  } catch {
    safeLog('warn', 'backstage.notion_rag.sync_lease_release_failed', {
      universeId,
    });
  }
}

async function acquireSyncLeaseWithinCycle(
  repository: BackstageNotionRagRepository,
  universeId: string,
  holderId: string,
  signal: AbortSignal
): Promise<BackstageNotionSyncLease | null> {
  // The repository call cannot be cancelled after dispatch. If cancellation
  // wins the race, fence-clean any exact lease that commits afterward.
  return acquireBackstageNotionSyncLeaseWithLateRelease({
    acquire: () => repository.acquireSyncLease(
      universeId,
      holderId,
      BACKSTAGE_NOTION_SYNC_LEASE_MAX_MS
    ),
    assertCanAcquire: () => throwIfAborted(signal),
    releaseLate: lease => releaseSyncLeaseBounded(
      repository,
      universeId,
      lease
    ),
    waitForAcquisition: pendingAcquisition => raceWithSignal(
      () => pendingAcquisition,
      signal
    ),
  });
}

function shouldRetryFetch(error: unknown): boolean {
  if (error instanceof BackstageNotionReadError) {
    if (
      /^(?:http_429|http_529)$/u.test(error.category)
      && (error.retryAfterMs ?? 0) > BACKSTAGE_NOTION_SYNC_MAX_RETRY_AFTER_MS
    ) {
      return false;
    }
    return /^(?:http_(?:409|429|500|502|503|504|529)|request_failed)$/u.test(
      error.category
    );
  }
  return error instanceof BackstageNotionRequestDeadlineError
    || (error instanceof Error && error.name === 'AbortError');
}

function createNotionRequestRunner(input: {
  spacingMs: number;
  timeoutMs: number;
  retryBaseDelayMs: number;
  progress: BackstageNotionSyncProgress;
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  deadlineAtMs: number;
  signal?: AbortSignal;
}) {
  let lastRequestAt = 0;
  return async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= BACKSTAGE_NOTION_SYNC_FETCH_ATTEMPTS; attempt += 1) {
      throwIfAborted(input.signal);
      let remainingCycleMs = remainingCycleMilliseconds(input.deadlineAtMs);
      const remainingSpacing = input.spacingMs - (Date.now() - lastRequestAt);
      await input.wait(
        Math.min(Math.max(0, remainingSpacing), remainingCycleMs),
        input.signal
      );
      remainingCycleMs = remainingCycleMilliseconds(input.deadlineAtMs);
      lastRequestAt = Date.now();
      try {
        return await runWithTimeout(
          Math.min(input.timeoutMs, remainingCycleMs),
          input.signal,
          operation
        );
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
        input.progress.notionRetryCount += 1;
        const backoffDelayMs = input.retryBaseDelayMs * 2 ** (attempt - 1);
        const randomValue = input.random();
        const retryJitterMs = Number.isFinite(randomValue)
          ? Math.floor(
              Math.min(1, Math.max(0, randomValue))
                * BACKSTAGE_NOTION_SYNC_RETRY_JITTER_MAX_MS
            )
          : 0;
        const retryDelayMs = Math.max(
          backoffDelayMs,
          error instanceof BackstageNotionReadError
            ? error.retryAfterMs ?? 0
            : 0
        ) + retryJitterMs;
        if (retryDelayMs >= remainingCycleMilliseconds(input.deadlineAtMs)) {
          throw new BackstageNotionCycleDeadlineError();
        }
        if (
          error instanceof BackstageNotionReadError
          && /^(?:http_429|http_529)$/u.test(error.category)
        ) {
          input.progress.rateLimitWaitMs += retryDelayMs;
        }
        await input.wait(retryDelayMs, input.signal);
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
      pending.expectedProviderParentPageId !== undefined
      && metadata.parentPageId !== pending.expectedProviderParentPageId
    )
    || (
      pending.expectedProviderParentDataSourceId !== undefined
      && (metadata.parentDataSourceId ?? null)
        !== pending.expectedProviderParentDataSourceId
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
      sourceObjectType: page.sourceObjectType,
      sourceParentType: page.metadata.parentType ?? null,
      sourceParentId: page.metadata.parentId ?? null,
      sourceTitle: page.metadata.title ?? null,
      membershipDataSourceId: page.membershipDataSourceId,
      databaseDataSourceIds: [...page.databaseDataSourceIds].sort(),
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
  embedBatch: (
    inputs: readonly string[],
    signal?: AbortSignal
  ) => Promise<number[][]>;
  signal: AbortSignal;
  progress: BackstageNotionSyncProgress;
}): Promise<BackstageNotionSnapshotChunkInput[]> {
  const chunks = input.pages.flatMap(page => [...page.prepared.chunks]);
  const sortedChunkSizes = chunks
    .map(chunk => chunk.codePoints)
    .sort((left, right) => left - right);
  const middleChunkIndex = Math.floor(sortedChunkSizes.length / 2);
  input.progress.normalizedSegments = input.pages.reduce(
    (total, page) => total + page.prepared.chunkDiagnostics.normalizedSegments,
    0
  );
  input.progress.emptySegmentsRemoved = input.pages.reduce(
    (total, page) => total + page.prepared.chunkDiagnostics.emptySegmentsRemoved,
    0
  );
  input.progress.exactDuplicatesRemoved = input.pages.reduce(
    (total, page) => total + page.prepared.chunkDiagnostics.exactDuplicatesRemoved,
    0
  );
  input.progress.adjacentSegmentsMerged = input.pages.reduce(
    (total, page) => total + page.prepared.chunkDiagnostics.adjacentSegmentsMerged,
    0
  );
  input.progress.phase = 'chunking';
  input.progress.chunksProduced = chunks.length;
  input.progress.minimumChunkCodePoints = sortedChunkSizes[0] ?? 0;
  input.progress.maximumChunkCodePoints = sortedChunkSizes.at(-1) ?? 0;
  input.progress.medianChunkCodePoints = sortedChunkSizes.length === 0
    ? 0
    : sortedChunkSizes.length % 2 === 1
      ? sortedChunkSizes[middleChunkIndex]!
      : Math.floor(
          ((sortedChunkSizes[middleChunkIndex - 1] ?? 0)
            + (sortedChunkSizes[middleChunkIndex] ?? 0)) / 2
        );
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
  input.progress.phase = 'embedding';
  const embeddings = await loadReusableEmbeddings(
    input.repository,
    input.universeId,
    hashes,
    input.signal
  );
  const missingHashes = hashes.filter(hash => !embeddings.has(hash));
  input.progress.reusedEmbeddingCount = hashes.length - missingHashes.length;
  input.progress.newEmbeddingCount = missingHashes.length;
  let embeddingDimension: number | null = null;
  const validateEmbedding = (embedding: number[] | undefined): number[] => {
    if (
      !Array.isArray(embedding)
      || embedding.length < 1
      || embedding.length > 8_192
      || embedding.some(component => !Number.isFinite(component))
      || (
        embeddingDimension !== null
        && embedding.length !== embeddingDimension
      )
    ) {
      throw incompleteSyncError(
        input.progress,
        'embedding',
        'embedding_failed',
        'The Notion hierarchy could not be embedded completely.'
      );
    }
    embeddingDimension ??= embedding.length;
    return embedding;
  };
  for (const embedding of embeddings.values()) {
    validateEmbedding(embedding);
  }
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
        batchHashes.map(hash => byHash.get(hash) ?? ''),
        input.signal
      ),
      input.signal
    );
    if (batchEmbeddings.length !== batchHashes.length) {
      throw new Error('Embedding provider returned an incomplete Notion batch.');
    }
    batchHashes.forEach((hash, batchIndex) => {
      const embedding = batchEmbeddings[batchIndex];
      embeddings.set(hash, validateEmbedding(embedding));
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
    embedding: validateEmbedding(embeddings.get(chunk.contentHash)),
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
  return pages.map(({ prepared, metadata, sourceObjectType }) => ({
    pageId: prepared.pageId,
    parentPageId: prepared.parentPageId,
    title: prepared.title,
    canonicalUrl: sourceObjectType === 'page'
      ? canonicalPageUrl(prepared.pageId)
      : null,
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
      sourceObjectType,
      scopePathKey: normalizeBackstageNotionScopePath(prepared.path),
      scopeTitleKey: normalizeBackstageNotionScopeKey(prepared.title),
    },
  }));
}

function isExactDatabaseRootFallback(error: unknown): boolean {
  return error instanceof BackstageNotionReadError
    && error.category === 'http_400'
    && error.notionHttpStatus === 400
    && error.notionProviderCode === 'validation_error'
    && error.notionFailureCategory === 'permanent_provider'
    && error.notionResponseContentType === 'application/json'
    && error.notionResponseSchemaValid === true
    && error.notionEndpointKind === 'page_metadata';
}

function databaseRootStateMatches(
  left: DatabaseRootCaptureState,
  right: DatabaseRootCaptureState
): boolean {
  if (
    left.metadata.databaseId !== right.metadata.databaseId
    || left.metadata.inTrash !== right.metadata.inTrash
    || left.metadata.parentType !== right.metadata.parentType
    || left.metadata.parentId !== right.metadata.parentId
    || left.metadata.title !== right.metadata.title
    || left.metadata.lastEditedAt.getTime()
      !== right.metadata.lastEditedAt.getTime()
  ) {
    return false;
  }
  const leftDataSourceIds = [...left.metadata.dataSourceIds].sort();
  const rightDataSourceIds = [...right.metadata.dataSourceIds].sort();
  if (
    leftDataSourceIds.length !== rightDataSourceIds.length
    || leftDataSourceIds.some((value, index) => (
      value !== rightDataSourceIds[index]
    ))
    || left.pages.length !== right.pages.length
  ) {
    return false;
  }
  return left.pages.every((page, index) => {
    const candidate = right.pages[index];
    return candidate !== undefined
      && page.pageId === candidate.pageId
      && page.dataSourceId === candidate.dataSourceId;
  });
}

async function loadDatabaseRootCaptureState(input: {
  rootPageId: string;
  request: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  fetchImpl: BackstageNotionFetchImplementation;
  accessToken: string;
  progress: BackstageNotionSyncProgress;
}): Promise<DatabaseRootCaptureState> {
  input.progress.phase = 'page_fetch';
  const metadata = await input.request(signal =>
    fetchBackstageNotionDatabaseMetadata(
      input.fetchImpl,
      input.accessToken,
      input.rootPageId,
      signal
    )
  );
  if (metadata.inTrash) {
    throw incompleteSyncError(
      input.progress,
      'completeness_validation',
      'inaccessible_page',
      'The configured Notion database authority root is unavailable.'
    );
  }

  const pages: DatabaseRootPageMembership[] = [];
  const seenPageIds = new Set<string>([input.rootPageId]);
  let queryRequestCount = 0;
  for (const dataSourceId of [...metadata.dataSourceIds].sort()) {
    let cursor: string | null = null;
    const seenCursorDigests = new Set<string>();
    while (true) {
      if (
        queryRequestCount
        >= BACKSTAGE_NOTION_SYNC_MAX_DATA_SOURCE_QUERY_REQUESTS
      ) {
        throw incompleteSyncError(
          input.progress,
          'pagination',
          'pagination_incomplete',
          'The Notion database authority root exceeds the bounded query limit.'
        );
      }
      input.progress.phase = cursor === null ? 'discovery' : 'pagination';
      if (cursor !== null) {
        input.progress.paginationRequests += 1;
      }
      queryRequestCount += 1;
      const response = await input.request(signal =>
        queryBackstageNotionDataSource(
          input.fetchImpl,
          input.accessToken,
          dataSourceId,
          cursor,
          signal
        )
      );
      for (const result of response.results) {
        if (result.kind === 'data_source') {
          throw incompleteSyncError(
            input.progress,
            'discovery',
            'completeness_mismatch',
            'The Notion database authority root contains a nested database that cannot be synchronized completely.'
          );
        }
        if (
          seenPageIds.has(result.pageId)
          || pages.length >= BACKSTAGE_NOTION_SYNC_MAX_PAGES
        ) {
          throw incompleteSyncError(
            input.progress,
            'completeness_validation',
            'completeness_mismatch',
            'The Notion database authority root could not be verified completely.'
          );
        }
        seenPageIds.add(result.pageId);
        pages.push({ pageId: result.pageId, dataSourceId });
      }
      if (!response.hasMore) {
        break;
      }
      const nextCursor = response.nextCursor;
      const nextCursorDigest = nextCursor === null ? null : sha256(nextCursor);
      if (
        nextCursor === null
        || nextCursorDigest === null
        || seenCursorDigests.has(nextCursorDigest)
      ) {
        throw incompleteSyncError(
          input.progress,
          'pagination',
          'pagination_incomplete',
          'The Notion database authority root returned incomplete or cyclic pagination.'
        );
      }
      seenCursorDigests.add(nextCursorDigest);
      cursor = nextCursor;
    }
  }
  if (pages.length === 0) {
    throw incompleteSyncError(
      input.progress,
      'completeness_validation',
      'completeness_mismatch',
      'The Notion database authority root did not expose any complete pages.'
    );
  }
  pages.sort((left, right) => left.pageId.localeCompare(right.pageId));
  return { metadata, pages: Object.freeze(pages) };
}

async function fetchCompleteBackstageNotionPageTitle(input: {
  pageId: string;
  request: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  fetchImpl: BackstageNotionFetchImplementation;
  accessToken: string;
  progress: BackstageNotionSyncProgress;
  firstPhase: BackstageNotionSyncFailurePhase;
}): Promise<string> {
  const titleParts: string[] = [];
  const seenCursorDigests = new Set<string>();
  let cursor: string | null = null;

  while (true) {
    input.progress.phase = cursor === null ? input.firstPhase : 'pagination';
    if (cursor !== null) {
      input.progress.paginationRequests += 1;
    }
    const response = await input.request(signal =>
      fetchBackstageNotionPageTitleProperty(
        input.fetchImpl,
        input.accessToken,
        input.pageId,
        cursor,
        signal
      )
    );
    const nextItemCount = titleParts.length + response.titleParts.length;
    if (
      nextItemCount > BACKSTAGE_NOTION_MAX_PAGE_TITLE_PROPERTY_ITEMS
      || (
        response.hasMore
        && nextItemCount >= BACKSTAGE_NOTION_MAX_PAGE_TITLE_PROPERTY_ITEMS
      )
    ) {
      throw incompleteSyncError(
        input.progress,
        'pagination',
        'pagination_incomplete',
        'The Notion page title exceeds the bounded synchronization limits.'
      );
    }
    titleParts.push(...response.titleParts);
    if (!response.hasMore) {
      break;
    }
    const nextCursor = response.nextCursor;
    const nextCursorDigest = nextCursor === null ? null : sha256(nextCursor);
    if (
      nextCursor === null
      || nextCursorDigest === null
      || seenCursorDigests.has(nextCursorDigest)
    ) {
      throw incompleteSyncError(
        input.progress,
        'pagination',
        'pagination_incomplete',
        'The Notion page title returned incomplete or cyclic pagination.'
      );
    }
    seenCursorDigests.add(nextCursorDigest);
    cursor = nextCursor;
  }

  const title = assembleBackstageNotionPageTitle(titleParts);
  if (title === null) {
    throw incompleteSyncError(
      input.progress,
      'completeness_validation',
      'completeness_mismatch',
      'A Notion database row did not expose a complete bounded title.'
    );
  }
  return title;
}

function sourceDriftError(
  progress: BackstageNotionSyncProgress
): BackstageNotionSyncError {
  return new BackstageNotionSyncError(
    BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT_ERROR_CODE,
    'The Notion hierarchy changed during synchronization; the candidate snapshot was discarded.',
    snapshotSyncFailureDiagnostics(
      progress,
      'completeness_validation',
      'source_changed'
    )
  );
}

async function verifyHierarchyDidNotDrift(input: {
  pages: readonly CapturedPage[];
  databaseRoot: DatabaseRootCaptureState | null;
  rootPageId: string;
  request: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  fetchImpl: BackstageNotionFetchImplementation;
  accessToken: string;
  progress: BackstageNotionSyncProgress;
}): Promise<void> {
  input.progress.phase = 'completeness_validation';
  for (const page of input.pages) {
    if (
      input.databaseRoot !== null
      && page.prepared.pageId === input.rootPageId
    ) {
      continue;
    }
    input.progress.phase = 'completeness_validation';
    const verifiedMetadata = await input.request(signal =>
      fetchBackstageNotionPageMetadata(
        input.fetchImpl,
        input.accessToken,
        page.prepared.pageId,
        signal,
        { requireTitle: page.membershipDataSourceId !== null }
      )
    );
    const verifiedTitle = page.membershipDataSourceId === null
      ? verifiedMetadata.title
      : verifiedMetadata.titleIsComplete === true
        && typeof verifiedMetadata.title === 'string'
        ? verifiedMetadata.title
        : await fetchCompleteBackstageNotionPageTitle({
          pageId: page.prepared.pageId,
          request: input.request,
          fetchImpl: input.fetchImpl,
          accessToken: input.accessToken,
          progress: input.progress,
          firstPhase: 'completeness_validation',
        });
    const verified: BackstageNotionPageMetadata = {
      ...verifiedMetadata,
      title: verifiedTitle,
      ...(page.membershipDataSourceId === null ? {} : { titleIsComplete: true }),
    };
    if (
      verified.inTrash
      || verified.parentPageId !== page.metadata.parentPageId
      || (verified.parentDataSourceId ?? null)
        !== (page.metadata.parentDataSourceId ?? null)
      || (verified.parentType ?? null) !== (page.metadata.parentType ?? null)
      || (verified.parentId ?? null) !== (page.metadata.parentId ?? null)
      || verified.lastEditedAt.getTime() !== page.metadata.lastEditedAt.getTime()
      || (
        page.metadata.title !== undefined
        && page.metadata.title !== null
        && verified.title !== page.metadata.title
      )
    ) {
      throw sourceDriftError(input.progress);
    }
  }
  if (input.databaseRoot !== null) {
    const verifiedDatabaseRoot = await loadDatabaseRootCaptureState({
      rootPageId: input.rootPageId,
      request: input.request,
      fetchImpl: input.fetchImpl,
      accessToken: input.accessToken,
      progress: input.progress,
    });
    if (!databaseRootStateMatches(input.databaseRoot, verifiedDatabaseRoot)) {
      throw sourceDriftError(input.progress);
    }
  }
}

async function captureHierarchy(input: {
  root: BackstageNotionAuthorityRoot;
  fetchImpl: BackstageNotionFetchImplementation;
  accessToken: string;
  request: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  progress: BackstageNotionSyncProgress;
}): Promise<CapturedHierarchy> {
  const queue: PendingPage[] = [];
  const discovered = new Map<string, string | null>([
    [input.root.rootPageId, null],
  ]);
  const captured: CapturedPage[] = [];
  let totalCodePoints = 0;
  input.progress.pagesDiscovered = 1;
  input.progress.phase = 'page_fetch';
  let rootPageMetadata: BackstageNotionPageMetadata | null = null;
  let databaseRoot: DatabaseRootCaptureState | null = null;
  try {
    rootPageMetadata = await input.request(signal =>
      fetchBackstageNotionPageMetadata(
        input.fetchImpl,
        input.accessToken,
        input.root.rootPageId,
        signal
      )
    );
  } catch (error) {
    if (!isExactDatabaseRootFallback(error)) {
      throw error;
    }
    databaseRoot = await loadDatabaseRootCaptureState({
      rootPageId: input.root.rootPageId,
      request: input.request,
      fetchImpl: input.fetchImpl,
      accessToken: input.accessToken,
      progress: input.progress,
    });
  }

  if (databaseRoot === null) {
    queue.push({
      pageId: input.root.rootPageId,
      parentPageId: null,
      title: input.root.displayName,
      depth: 0,
      path: [input.root.displayName],
      preloadedMetadata: rootPageMetadata ?? undefined,
    });
  } else {
    const metadata: BackstageNotionPageMetadata = {
      pageId: input.root.rootPageId,
      parentPageId: null,
      parentDataSourceId: null,
      parentType: databaseRoot.metadata.parentType,
      parentId: databaseRoot.metadata.parentId,
      title: databaseRoot.metadata.title,
      lastEditedAt: databaseRoot.metadata.lastEditedAt,
      inTrash: false,
    };
    captured.push({
      prepared: prepareBackstageNotionRagPage({
        universeId: input.root.universeId,
        pageId: input.root.rootPageId,
        parentPageId: null,
        title: input.root.displayName,
        path: [input.root.displayName],
        markdown: '',
        sourceLastEditedAt: metadata.lastEditedAt.toISOString(),
      }),
      metadata,
      sourceObjectType: 'database',
      membershipDataSourceId: null,
      databaseDataSourceIds: databaseRoot.metadata.dataSourceIds,
    });
    for (const page of databaseRoot.pages) {
      discovered.set(page.pageId, input.root.rootPageId);
      queue.push({
        pageId: page.pageId,
        parentPageId: input.root.rootPageId,
        title: '',
        depth: 1,
        path: [input.root.displayName],
        expectedProviderParentDataSourceId: page.dataSourceId,
        membershipDataSourceId: page.dataSourceId,
        appendProviderTitleToPath: true,
      });
    }
    input.progress.pagesDiscovered = discovered.size;
  }
  let providerPagesFetched = 0;
  const maximumCapturedRecords = BACKSTAGE_NOTION_SYNC_MAX_PAGES
    + (databaseRoot === null ? 0 : 1);

  while (queue.length > 0) {
    const pending = queue.shift();
    if (!pending) {
      break;
    }
    if (
      pending.depth > BACKSTAGE_NOTION_SYNC_MAX_DEPTH
      || captured.length >= maximumCapturedRecords
    ) {
      throw incompleteSyncError(
        input.progress,
        'discovery',
        'completeness_mismatch',
        'The configured Notion hierarchy exceeds the bounded synchronization limits.'
      );
    }

    input.progress.phase = 'page_fetch';
    const fetchedMetadata = pending.preloadedMetadata ?? await input.request(signal =>
      fetchBackstageNotionPageMetadata(
        input.fetchImpl,
        input.accessToken,
        pending.pageId,
        signal,
        { requireTitle: pending.appendProviderTitleToPath === true }
      )
    );
    validateFetchedPage(pending, fetchedMetadata, input.progress);
    const title = pending.appendProviderTitleToPath
      ? fetchedMetadata.titleIsComplete === true
        && typeof fetchedMetadata.title === 'string'
        ? fetchedMetadata.title
        : await fetchCompleteBackstageNotionPageTitle({
            pageId: pending.pageId,
            request: input.request,
            fetchImpl: input.fetchImpl,
            accessToken: input.accessToken,
            progress: input.progress,
            firstPhase: 'page_fetch',
          })
      : pending.title;
    if (typeof title !== 'string' || title.length === 0) {
      throw incompleteSyncError(
        input.progress,
        'completeness_validation',
        'completeness_mismatch',
        'A Notion database row did not expose complete page metadata.'
      );
    }
    const path = pending.appendProviderTitleToPath
      ? [...pending.path, title]
      : pending.path;
    const metadata: BackstageNotionPageMetadata = {
      ...fetchedMetadata,
      ...(pending.appendProviderTitleToPath
        ? { title, titleIsComplete: true }
        : {}),
    };
    const markdown = await fetchCompleteBackstageNotionMarkdown({
      pageId: pending.pageId,
      fetchImpl: input.fetchImpl,
      accessToken: input.accessToken,
      request: input.request,
      progress: input.progress,
    });
    if (UNSUPPORTED_ENHANCED_MARKDOWN_PATTERN.test(markdown)) {
      throw incompleteSyncError(
        input.progress,
        'normalization',
        'permanent_notion_error',
        'The Notion hierarchy contains truncated or unsupported content and was not activated.'
      );
    }
    totalCodePoints += codePointLength(markdown);
    if (totalCodePoints > BACKSTAGE_NOTION_SYNC_MAX_TOTAL_CODE_POINTS) {
      throw incompleteSyncError(
        input.progress,
        'chunking',
        'chunk_limit_reached',
        'The configured Notion hierarchy exceeds the total synchronization limit.'
      );
    }

    input.progress.phase = 'normalization';
    const prepared = prepareBackstageNotionRagPage({
      universeId: input.root.universeId,
      pageId: pending.pageId,
      parentPageId: pending.parentPageId,
      title,
      path,
      markdown,
      sourceLastEditedAt: metadata.lastEditedAt.toISOString(),
    });
    const rawChildPageTagCount = Array.from(
      markdown.matchAll(/<page\b/giu)
    ).length;
    if (
      prepared.invalidChildPageTagCount > 0
      || prepared.childPageTagCount !== rawChildPageTagCount
    ) {
      throw incompleteSyncError(
        input.progress,
        'normalization',
        'completeness_mismatch',
        'The Notion hierarchy contains an ambiguous child-page reference.'
      );
    }
    captured.push({
      prepared,
      metadata,
      sourceObjectType: 'page',
      membershipDataSourceId: pending.membershipDataSourceId ?? null,
      databaseDataSourceIds: Object.freeze([]),
    });
    providerPagesFetched += 1;
    input.progress.pagesFetched = providerPagesFetched;

    for (const child of prepared.childPages) {
      const priorParent = discovered.get(child.pageId);
      if (priorParent !== undefined) {
        if (priorParent !== pending.pageId) {
          throw incompleteSyncError(
            input.progress,
            'discovery',
            'completeness_mismatch',
            'The Notion hierarchy contains a cycle or multi-parent page.'
          );
        }
        continue;
      }
      discovered.set(child.pageId, pending.pageId);
      input.progress.pagesDiscovered = discovered.size;
      queue.push({
        pageId: child.pageId,
        parentPageId: pending.pageId,
        title: child.title,
        depth: pending.depth + 1,
        path: [...path, child.title],
        expectedProviderParentPageId: pending.pageId,
        expectedProviderParentDataSourceId: null,
      });
    }
  }

  return { pages: captured, databaseRoot };
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

function unknownEnhancedMarkdownTagIdentifiers(tag: string): string[] {
  return [...new Set(
    Array.from(
      tag.matchAll(NOTION_IDENTIFIER_IN_TAG_PATTERN),
      match => normalizeBackstageNotionPageId(match[0])
    ).filter((candidate): candidate is string => candidate !== null)
  )];
}

async function fetchCompleteBackstageNotionMarkdown(input: {
  pageId: string;
  fetchImpl: BackstageNotionFetchImplementation;
  accessToken: string;
  request: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  progress: BackstageNotionSyncProgress;
}): Promise<string> {
  const seenIdentifiers = new Set<string>();
  let fetchedCodePoints = 0;

  const fetchSegment = async (identifier: string, root: boolean): Promise<string> => {
    if (
      seenIdentifiers.has(identifier)
      || seenIdentifiers.size >= BACKSTAGE_NOTION_SYNC_MAX_MARKDOWN_SEGMENTS_PER_PAGE
    ) {
      throw incompleteSyncError(
        input.progress,
        'pagination',
        'pagination_incomplete',
        'The Notion hierarchy contains incomplete or cyclic Markdown continuation data.'
      );
    }
    seenIdentifiers.add(identifier);
    input.progress.phase = root ? 'block_fetch' : 'pagination';
    if (!root) {
      input.progress.paginationRequests += 1;
    }
    const response = await input.request(signal =>
      fetchBackstageNotionMarkdownPage(
        input.fetchImpl,
        input.accessToken,
        identifier,
        signal
      )
    );
    input.progress.blocksFetched += 1;
    fetchedCodePoints += codePointLength(response.markdown);
    if (fetchedCodePoints > BACKSTAGE_NOTION_SYNC_MAX_TOTAL_CODE_POINTS) {
      throw incompleteSyncError(
        input.progress,
        'chunking',
        'chunk_limit_reached',
        'The configured Notion hierarchy exceeds the total synchronization limit.'
      );
    }

    const unknownBlockIds = [...(response.unknownBlockIds ?? [])];
    if (
      unknownBlockIds.length !== response.unknownBlockCount
      || (response.truncated && unknownBlockIds.length === 0)
    ) {
      throw incompleteSyncError(
        input.progress,
        'pagination',
        'pagination_incomplete',
        'The Notion hierarchy contains incomplete Markdown continuation data.'
      );
    }

    const resolvedByIdentifier = new Map<string, string>();
    for (const unknownBlockId of unknownBlockIds) {
      resolvedByIdentifier.set(
        unknownBlockId,
        await fetchSegment(unknownBlockId, false)
      );
    }

    let invalidReplacement = false;
    const replacedIdentifiers = new Set<string>();
    const completeMarkdown = response.markdown.replace(
      UNKNOWN_ENHANCED_MARKDOWN_TAG_PATTERN,
      tag => {
        const matchingIdentifiers = unknownEnhancedMarkdownTagIdentifiers(tag)
          .filter(identifier => resolvedByIdentifier.has(identifier));
        const tagIdentifier = matchingIdentifiers[0];
        if (matchingIdentifiers.length !== 1 || !tagIdentifier) {
          invalidReplacement = true;
          return tag;
        }
        if (replacedIdentifiers.has(tagIdentifier)) {
          invalidReplacement = true;
          return tag;
        }
        replacedIdentifiers.add(tagIdentifier);
        return resolvedByIdentifier.get(tagIdentifier) ?? tag;
      }
    );
    if (
      invalidReplacement
      || replacedIdentifiers.size !== resolvedByIdentifier.size
      || /<unknown\b/iu.test(completeMarkdown)
    ) {
      throw incompleteSyncError(
        input.progress,
        'pagination',
        'pagination_incomplete',
        'The Notion hierarchy contains unresolved Markdown continuation data.'
      );
    }
    return completeMarkdown;
  };

  return fetchSegment(input.pageId, true);
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
  if (error instanceof DiagnosedBackstageNotionSyncLeaseError) {
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
  const syncStatusRepository = dependencies.syncStatusRepository
    ?? (dependencies.repository
      ? null
      : getBackstageNotionSyncStatusRepository());
  const readEnvironment = dependencies.readEnvironment ?? getEnv;
  let accessToken: string;
  try {
    accessToken = requireBackstageNotionAccessToken(readEnvironment);
  } catch (error) {
    throw wrapSyncFailure(error, progress);
  }
  throwIfAborted(dependencies.signal);
  const cycleDeadline = new BackstageNotionCycleDeadline(
    Math.max(1, Math.min(
      BACKSTAGE_NOTION_SYNC_CYCLE_TIMEOUT_MS,
      boundedNonnegativeMilliseconds(
        dependencies.cycleTimeoutMs,
        BACKSTAGE_NOTION_SYNC_CYCLE_TIMEOUT_MS
      )
    )),
    dependencies.signal
  );
  const holderId = dependencies.holderId ?? SYNC_HOLDER_ID;
  progress.phase = 'lease';
  let lease: BackstageNotionSyncLease | null;
  try {
    lease = await acquireSyncLeaseWithinCycle(
      repository,
      root.universeId,
      holderId,
      cycleDeadline.signal
    );
  } catch (error) {
    cycleDeadline.dispose();
    throw wrapSyncFailure(error, progress);
  }
  if (!lease) {
    cycleDeadline.dispose();
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
    cycleDeadline.signal
  );
  let syncAttempt: BackstageNotionSyncAttemptRecord | null = null;

  try {
    if (syncStatusRepository) {
      syncAttempt = await raceWithSignal(
        () => syncStatusRepository.beginSyncAttempt({
          universeId: root.universeId,
          lease,
        }),
        heartbeat.signal
      );
    }
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
      progress,
      wait: dependencies.wait ?? waitWithSignal,
      random: dependencies.random ?? Math.random,
      deadlineAtMs: cycleDeadline.deadlineAtMs,
      signal: heartbeat.signal,
    });
    const startedAt = Date.now();
    const hierarchy = await captureHierarchy({
      root,
      fetchImpl,
      accessToken,
      request,
      progress,
    });
    const pages = hierarchy.pages;
    progress.phase = 'completeness_validation';
    if (!initialActivationMeetsCoverage({
      root,
      activeInventory,
      pageCount: pages.filter(page => page.sourceObjectType === 'page').length,
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
      activeInventory
      && shouldVerifyBackstageNotionSnapshotUnchanged({
        chunkCount: activeInventory.snapshot.chunkCount,
        embeddingModelMatches:
          activeInventory.snapshot.embeddingModel
            === DEFAULT_OPENAI_EMBEDDING_MODEL,
        manifestMatches: activeInventory.snapshot.manifestHash === manifestHash,
      })
    ) {
      await verifyHierarchyDidNotDrift({
        pages,
        databaseRoot: hierarchy.databaseRoot,
        rootPageId: root.rootPageId,
        request,
        fetchImpl,
        accessToken,
        progress,
      });
      throwIfAborted(heartbeat.signal);
      const verifiedAt = await raceWithSignal(
        () => repository.markActiveSnapshotVerified(
          root.universeId,
          manifestHash,
          lease
        ),
        heartbeat.signal
      );
      if (!verifiedAt) {
        throw new BackstageNotionSyncError(
          BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT_ERROR_CODE,
          'The active Notion snapshot changed before verification could be recorded.'
        );
      }
      if (syncStatusRepository && syncAttempt) {
        try {
          const completed = await raceWithSignal(
            () => syncStatusRepository.completeSyncAttempt({
              universeId: root.universeId,
              attemptId: syncAttempt!.attemptId,
              generation: syncAttempt!.generation,
              outcome: 'unchanged',
              failurePhase: null,
              failureReason: null,
              ...syncAttemptDiagnosticsState(progress),
              activatedSnapshotId: activeInventory.snapshot.id,
            }),
            heartbeat.signal
          );
          if (!completed) {
            safeLog('warn', 'backstage.notion_rag.sync_status_record_failed', {
              universeId: root.universeId,
              outcome: 'unchanged',
            });
          }
        } catch {
          safeLog('warn', 'backstage.notion_rag.sync_status_record_failed', {
            universeId: root.universeId,
            outcome: 'unchanged',
          });
        }
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
      embedBatch: dependencies.embedBatch ?? (
        (inputs, signal) => createEmbeddings(inputs, undefined, { signal })
      ),
      signal: heartbeat.signal,
      progress,
    });
    progress.candidateSnapshotCreated = true;
    await verifyHierarchyDidNotDrift({
      pages,
      databaseRoot: hierarchy.databaseRoot,
      rootPageId: root.rootPageId,
      request,
      fetchImpl,
      accessToken,
      progress,
    });
    progress.candidateSnapshotValidated = true;
    throwIfAborted(heartbeat.signal);
    remainingCycleMilliseconds(cycleDeadline.deadlineAtMs);
    progress.phase = 'persistence';
    const snapshot = await repository.activateSnapshot({
      universeId: root.universeId,
      rootPageId: root.rootPageId,
      manifestHash,
      embeddingModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
      sourceMaxEditedAt: sourceMaximumEditedAt(pages),
      lease,
      deadlineAtMs: cycleDeadline.deadlineAtMs,
      pages: buildSnapshotPages(pages),
      chunks: snapshotChunks,
    });
    progress.phase = 'activation';
    progress.candidateSnapshotActivated = true;
    if (syncStatusRepository && syncAttempt) {
      try {
        const completed = await raceWithSignal(
          () => syncStatusRepository.completeSyncAttempt({
            universeId: root.universeId,
            attemptId: syncAttempt!.attemptId,
            generation: syncAttempt!.generation,
            outcome: 'activated',
            failurePhase: null,
            failureReason: null,
            ...syncAttemptDiagnosticsState(progress),
            activatedSnapshotId: snapshot.id,
          }),
          heartbeat.signal
        );
        if (!completed) {
          safeLog('warn', 'backstage.notion_rag.sync_status_record_failed', {
            universeId: root.universeId,
            outcome: 'activated',
          });
        }
      } catch {
        safeLog('warn', 'backstage.notion_rag.sync_status_record_failed', {
          universeId: root.universeId,
          outcome: 'activated',
        });
      }
    }
    safeLog('info', 'backstage.notion_rag.sync_activated', {
      universeId: root.universeId,
      pageCount: snapshot.pageCount,
      chunkCount: snapshot.chunkCount,
      normalizedSegments: progress.normalizedSegments,
      emptySegmentsRemoved: progress.emptySegmentsRemoved,
      exactDuplicatesRemoved: progress.exactDuplicatesRemoved,
      adjacentSegmentsMerged: progress.adjacentSegmentsMerged,
      chunksProduced: progress.chunksProduced,
      chunksEmbedded: progress.chunksEmbedded,
      minimumChunkCodePoints: progress.minimumChunkCodePoints,
      maximumChunkCodePoints: progress.maximumChunkCodePoints,
      medianChunkCodePoints: progress.medianChunkCodePoints,
      reusedEmbeddingCount: progress.reusedEmbeddingCount,
      newEmbeddingCount: progress.newEmbeddingCount,
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
    const wrapped = wrapSyncFailure(error, progress);
    if (syncStatusRepository && syncAttempt) {
      try {
        if (!progress.candidateSnapshotActivated) {
          const failure = rootFailureDiagnostics(wrapped);
          await syncStatusRepository.completeSyncAttempt({
            universeId: root.universeId,
            attemptId: syncAttempt.attemptId,
            generation: syncAttempt.generation,
            outcome: 'failed',
            failurePhase: failure.phase,
            failureReason: failure.reason,
            ...syncAttemptDiagnosticsState(failure),
            activatedSnapshotId: null,
          });
        }
      } catch {
        safeLog('warn', 'backstage.notion_rag.sync_status_record_failed', {
          universeId: root.universeId,
          outcome: progress.candidateSnapshotActivated ? 'activated' : 'failed',
        });
      }
    }
    throw wrapped;
  } finally {
    await heartbeat.stop();
    try {
      await releaseSyncLeaseBounded(repository, root.universeId, lease);
    } finally {
      cycleDeadline.dispose();
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

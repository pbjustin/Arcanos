import { createHash, randomUUID } from 'node:crypto';

import {
  BACKSTAGE_NOTION_PARTITION_LEASE_MAX_MS,
  BackstageNotionPartitionRepositoryError,
  type ActivateBackstageNotionShardSnapshotInput,
  type ActivateBackstageNotionUniverseManifestInput,
  type ActivatedBackstageNotionShardSnapshot,
  type ActivatedBackstageNotionUniverseManifest,
  type BackstageNotionPartitionHeadExpectation,
  type BackstageNotionPartitionLease,
  type BackstageNotionPartitionLeaseFence,
  type BackstageNotionPartitionShardPageInventoryItem,
  type BackstageNotionPartitionSynchronizationState,
  type BackstageNotionProviderLease,
  type BackstageNotionUniverseHeadExpectation,
  type RegisteredBackstageNotionPartitionConfiguration,
  type VerifiedBackstageNotionSourceGeneration,
  type VerifyBackstageNotionSourceGenerationInput,
} from '@core/db/repositories/backstageNotionPartitionRepository.js';
import {
  BACKSTAGE_NOTION_PARTITION_CHUNKER_VERSION,
  BACKSTAGE_NOTION_PARTITION_PAGE_FORMAT_VERSION,
  BackstageNotionPartitionMaterialCapacityError,
  resolveBackstageNotionPartitionPageMaterial,
  type BackstageNotionPartitionMaterialRepository,
  type BackstageNotionResolvedPartitionPageMaterial,
} from './backstageNotionPartitionMaterial.js';
import {
  BACKSTAGE_NOTION_PARTITION_MAX_PAGES,
  type BackstageNotionPartitionConfiguration,
  type BackstageNotionPartitionDefinition,
  type BackstageNotionPartitionUniverse,
} from '@shared/backstage/backstageNotionPartitionCore.js';
import {
  decideBackstageNotionPartitionManifestMembership,
  planBackstageNotionPartitionFullReconciliation,
  type BackstageNotionPartitionOptionalUnavailableReasonCode,
  type BackstageNotionPartitionReconciliationJob,
  type BackstageNotionPartitionShardAttemptSummary,
} from '@shared/backstage/backstageNotionPartitionSyncCore.js';
import {
  inspectBackstageNotionRagPage,
  type BackstageNotionInspectedRagPage,
} from '@shared/backstage/backstageNotionRagCore.js';
import {
  BackstageNotionReadError,
  fetchBackstageNotionMarkdownPage,
  fetchBackstageNotionPageMetadata,
  readBackstageNotionAccessToken,
  type BackstageNotionEnvironmentReader,
  type BackstageNotionFetchImplementation,
  type BackstageNotionMarkdownResponse,
  type BackstageNotionPageMetadata,
} from '@shared/backstage/backstageNotionContextCore.js';
import {
  normalizeBackstageNotionScopeKey,
  normalizeBackstageNotionScopePath,
} from '@shared/backstage/backstageNotionScopeIndex.js';
import {
  classifyBackstageNotionPageMaterials,
  hashBackstageNotionPageMaterial,
} from '@shared/backstage/backstageNotionPartitionMaterialCore.js';
import {
  hashBackstageNotionPartitionSourceGeneration,
} from '@shared/backstage/backstageNotionPartitionSourceGeneration.js';

export const BACKSTAGE_NOTION_PARTITION_SYNC_INDEX_FORMAT_VERSION = 1;
export const BACKSTAGE_NOTION_PARTITION_SYNC_EMBEDDING_VERSION = 1;
export const BACKSTAGE_NOTION_PARTITION_SYNC_DEFAULT_CONCURRENCY = 2;
export const BACKSTAGE_NOTION_PARTITION_SYNC_MAX_CONCURRENCY = 8;
export const BACKSTAGE_NOTION_PARTITION_SYNC_DEFAULT_LKG_MAX_AGE_MS =
  24 * 60 * 60 * 1_000;
export const BACKSTAGE_NOTION_PARTITION_SYNC_PROVIDER_LEASE_TTL_MS = 60_000;
export const BACKSTAGE_NOTION_PARTITION_SYNC_PROVIDER_POLL_MS = 50;
export const BACKSTAGE_NOTION_PARTITION_SYNC_NOTION_REQUEST_DELAY_MS = 350;
export const BACKSTAGE_NOTION_PARTITION_CAPTURE_FETCH_TIMEOUT_MS = 15_000;
export const BACKSTAGE_NOTION_PARTITION_CAPTURE_FETCH_ATTEMPTS = 3;
export const BACKSTAGE_NOTION_PARTITION_CAPTURE_RETRY_BASE_DELAY_MS = 250;

const NOTION_PROVIDER_KEY = 'notion';
const NOTION_PROVIDER_MODEL_KEY = 'notion-api-v1';
const EMBEDDING_PROVIDER_KEY = 'openai';
const UNSUPPORTED_ENHANCED_MARKDOWN_PATTERN =
  /<(?:audio|bookmark|database|embed|file|image|link-preview|pdf|unknown|video)\b/iu;

export type BackstageNotionPartitionSyncErrorCode =
  | 'BACKSTAGE_NOTION_PARTITION_SYNC_CONFIGURATION_INVALID'
  | 'BACKSTAGE_NOTION_PARTITION_SYNC_STALE_CONFIGURATION'
  | 'BACKSTAGE_NOTION_PARTITION_SYNC_CAPTURE_INCOMPLETE'
  | 'BACKSTAGE_NOTION_PARTITION_SYNC_CAPACITY_EXCEEDED'
  | 'BACKSTAGE_NOTION_PARTITION_SYNC_SOURCE_DRIFT'
  | 'BACKSTAGE_NOTION_PARTITION_SYNC_LEASE_LOST';

export class BackstageNotionPartitionSyncError extends Error {
  constructor(
    readonly code: BackstageNotionPartitionSyncErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'BackstageNotionPartitionSyncError';
  }
}

export interface BackstageNotionPartitionCapturedPageMetadata {
  readonly pageId: string;
  readonly parentPageId: string | null;
  readonly inTrash: boolean;
  readonly lastEditedAt: Date;
}

export interface BackstageNotionPartitionCapturedPage {
  readonly page: BackstageNotionInspectedRagPage;
  readonly metadata: BackstageNotionPartitionCapturedPageMetadata;
}

export interface BackstageNotionPartitionFullCapture {
  /** The provider has no delta feed: every run must scan hierarchy and content. */
  readonly captureMode: 'full_hierarchy_content_scan';
  readonly pages: readonly BackstageNotionPartitionCapturedPage[];
  readonly completeness: Readonly<{
    truncatedPageCount: number;
    unsupportedBlockCount: number;
    ambiguousChildReferenceCount: number;
  }>;
  readonly capturedAt: Date;
}

export interface BackstageNotionPartitionVerificationPass {
  readonly verificationMode: 'full_metadata_second_pass';
  readonly pages: readonly BackstageNotionPartitionCapturedPageMetadata[];
  readonly verifiedAt: Date;
}

export interface BackstageNotionPartitionProviderPermit {
  runNotionRequest<T>(
    operation: (providerSignal: AbortSignal) => Promise<T>,
    signal: AbortSignal
  ): Promise<T>;
}

export interface BackstageNotionPartitionCaptureDependencies {
  readonly captureFullHierarchy: (input: {
    readonly definition: BackstageNotionPartitionDefinition;
    readonly provider: BackstageNotionPartitionProviderPermit;
    readonly signal: AbortSignal;
  }) => Promise<BackstageNotionPartitionFullCapture>;
  readonly verifyFullHierarchy: (input: {
    readonly definition: BackstageNotionPartitionDefinition;
    readonly captured: BackstageNotionPartitionFullCapture;
    readonly provider: BackstageNotionPartitionProviderPermit;
    readonly signal: AbortSignal;
  }) => Promise<BackstageNotionPartitionVerificationPass>;
}

export interface BackstageNotionPartitionProviderCaptureOptions {
  readonly readEnvironment: BackstageNotionEnvironmentReader;
  readonly fetchImpl: BackstageNotionFetchImplementation;
  readonly fetchPageMetadata?: typeof fetchBackstageNotionPageMetadata;
  readonly fetchMarkdownPage?: typeof fetchBackstageNotionMarkdownPage;
  readonly requestTimeoutMs?: number;
  readonly fetchAttempts?: number;
  readonly retryBaseDelayMs?: number;
  readonly now?: () => Date;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface BackstageNotionPartitionSyncRepository
  extends BackstageNotionPartitionMaterialRepository {
  loadUniverseHead(universeId: string): Promise<BackstageNotionUniverseHeadExpectation | null>;
  registerConfiguration(input: {
    readonly configurationGeneration: string;
    readonly configurationHash: string;
    readonly universe: BackstageNotionPartitionUniverse;
    readonly expectedUniverseHead: BackstageNotionUniverseHeadExpectation | null;
  }): Promise<RegisteredBackstageNotionPartitionConfiguration>;
  loadUniverseSynchronizationState(
    universeId: string,
    configurationVersionId: string
  ): Promise<BackstageNotionPartitionSynchronizationState | null>;
  loadShardPageInventory(
    universeId: string,
    shardKey: string,
    snapshotId: string,
    maximumPages: number
  ): Promise<readonly BackstageNotionPartitionShardPageInventoryItem[]>;
  acquireShardLease(
    universeId: string,
    shardKey: string,
    holderId: string,
    ttlMs: number
  ): Promise<BackstageNotionPartitionLease | null>;
  renewShardLease(
    universeId: string,
    shardKey: string,
    lease: BackstageNotionPartitionLeaseFence,
    ttlMs: number
  ): Promise<BackstageNotionPartitionLease | null>;
  releaseShardLease(
    universeId: string,
    shardKey: string,
    lease: BackstageNotionPartitionLeaseFence
  ): Promise<boolean>;
  acquireProviderLease(
    providerKey: string,
    modelKey: string,
    holderId: string,
    ttlMs: number,
    nextRequestDelayMs?: number
  ): Promise<BackstageNotionProviderLease | null>;
  renewProviderLease(
    providerKey: string,
    modelKey: string,
    lease: BackstageNotionPartitionLeaseFence,
    ttlMs: number,
    nextRequestDelayMs?: number
  ): Promise<BackstageNotionProviderLease | null>;
  releaseProviderLease(
    providerKey: string,
    modelKey: string,
    lease: BackstageNotionPartitionLeaseFence
  ): Promise<boolean>;
  activateShardSnapshot(
    input: ActivateBackstageNotionShardSnapshotInput
  ): Promise<ActivatedBackstageNotionShardSnapshot>;
  activateUniverseManifest(
    input: ActivateBackstageNotionUniverseManifestInput
  ): Promise<ActivatedBackstageNotionUniverseManifest>;
  verifySourceGeneration(
    input: VerifyBackstageNotionSourceGenerationInput
  ): Promise<VerifiedBackstageNotionSourceGeneration>;
}

export interface BackstageNotionPartitionSyncDependencies
  extends BackstageNotionPartitionCaptureDependencies {
  readonly repository: BackstageNotionPartitionSyncRepository;
  readonly embeddingModel: string;
  readonly embeddingDimension: number;
  readonly embedBatch: (
    inputs: readonly string[],
    signal: AbortSignal
  ) => Promise<readonly (readonly number[])[]>;
  readonly holderId?: string;
  readonly signal?: AbortSignal;
  readonly concurrency?: number;
  readonly shardLeaseTtlMs?: number;
  readonly providerLeaseTtlMs?: number;
  readonly providerPollMs?: number;
  readonly notionRequestDelayMs?: number;
  readonly embeddingRequestDelayMs?: number;
  readonly lastKnownGoodMaximumAgeMs?: number;
  readonly now?: () => Date;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** Restrict one manual reconciliation to an exact stable shard identity. */
  readonly selection?: BackstageNotionPartitionSyncSelection;
}

export interface BackstageNotionPartitionSyncSelection {
  readonly universeId: string;
  readonly shardKey: string;
}

export interface BackstageNotionPartitionShardSyncResult
  extends BackstageNotionPartitionShardAttemptSummary {
  readonly universeId: string;
  readonly fullSourceScan: boolean;
  readonly pageCount: number;
  readonly chunkCount: number;
  readonly sourceGenerationId: string | null;
  readonly sourceManifestHash: string | null;
  readonly pageVersionReuseCount: number;
  readonly embeddedChunkCount: number;
  readonly leaseReleaseVerified: boolean;
  readonly pageChanges: Readonly<{
    added: number;
    changed: number;
    moved: number;
    deleted: number;
    unchanged: number;
  }>;
}

export interface BackstageNotionPartitionUniverseSyncResult {
  readonly universeId: string;
  readonly configurationVersionId: string;
  readonly manifestStatus: 'published' | 'blocked' | 'deferred';
  readonly manifestId: string | null;
  readonly memberCount: number;
  readonly omissionCount: number;
  /** True only after one terminal metadata pass revalidated every shard capture. */
  readonly sourceGenerationVerified: boolean;
  readonly manifestOmissions: readonly Readonly<{
    shardKey: string;
    safeReasonCode: string;
  }>[];
  readonly shardResults: readonly BackstageNotionPartitionShardSyncResult[];
}

export interface BackstageNotionPartitionSynchronizationResult {
  readonly kind: 'full_reconciliation' | 'targeted_reconciliation';
  readonly universes: readonly BackstageNotionPartitionUniverseSyncResult[];
}

interface RegisteredUniverse {
  readonly universe: BackstageNotionPartitionUniverse;
  readonly registration: RegisteredBackstageNotionPartitionConfiguration;
  readonly initialState: BackstageNotionPartitionSynchronizationState;
}

interface ShardTask extends BackstageNotionPartitionReconciliationJob {
  readonly registered: RegisteredUniverse;
  readonly partitionVersionId: string;
  readonly expectedHead: BackstageNotionPartitionHeadExpectation;
  readonly sourceGenerationId: string;
}

interface ShardSourceCaptureEvidence {
  readonly sourceGenerationId: string;
  readonly sourceManifestHash: string;
  readonly partitionVersionId: string;
  readonly definition: BackstageNotionPartitionDefinition;
  readonly capture: BackstageNotionPartitionFullCapture;
}

type SourceGenerationBarrierEvidence = VerifiedBackstageNotionSourceGeneration;

const PROCESS_PROVIDER_TAILS = new Map<string, Promise<void>>();

export function groupBackstageNotionPartitionRootPageIdsByUniverse(
  universes: readonly BackstageNotionPartitionUniverse[]
): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(universes.map(universe => [
    universe.universeId,
    new Set(universe.shards.map(shard => shard.rootPageId)),
  ] as const));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

async function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (milliseconds <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const finish = (callback: () => void): void => {
      signal.removeEventListener('abort', abort);
      callback();
    };
    const timeout = setTimeout(() => finish(resolve), milliseconds);
    const abort = (): void => {
      clearTimeout(timeout);
      finish(() => reject(signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted.', 'AbortError')));
    };
    signal.addEventListener('abort', abort, { once: true });
    timeout.unref?.();
    if (signal.aborted) {
      abort();
    }
  });
}

async function runCaptureRequestWithTimeout<T>(
  timeoutMs: number,
  providerSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  throwIfAborted(providerSignal);
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(providerSignal.reason);
  providerSignal.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new DOMException('Notion request timed out.', 'AbortError'));
  }, timeoutMs);
  timeout.unref?.();
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (providerSignal.aborted) {
      throwIfAborted(providerSignal);
    }
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new DOMException('Notion request timed out.', 'AbortError');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    providerSignal.removeEventListener('abort', forwardAbort);
  }
}

function shouldRetryPartitionCaptureRequest(error: unknown): boolean {
  if (error instanceof BackstageNotionReadError) {
    return /^(?:http_(?:429|500|502|503|504|529)|request_failed)$/u.test(
      error.category
    );
  }
  return error instanceof Error && error.name === 'AbortError';
}

interface PartitionCapturePendingPage {
  readonly pageId: string;
  readonly parentPageId: string | null;
  readonly title: string;
  readonly depth: number;
  readonly path: readonly string[];
}

/**
 * Build the concrete provider adapter used by the worker wiring. Notion has no
 * authoritative delta feed, so each shard still performs a bounded full
 * hierarchy/content scan plus a full metadata verification pass.
 */
export function createBackstageNotionPartitionProviderCaptureDependencies(
  options: BackstageNotionPartitionProviderCaptureOptions
): BackstageNotionPartitionCaptureDependencies {
  if (typeof options.fetchImpl !== 'function') {
    throw new TypeError('fetchImpl is required.');
  }
  const accessToken = readBackstageNotionAccessToken(options.readEnvironment);
  if (!accessToken) {
    throw new BackstageNotionPartitionSyncError(
      'BACKSTAGE_NOTION_PARTITION_SYNC_CONFIGURATION_INVALID',
      'Partition synchronization requires a valid purpose-bound Notion token.'
    );
  }
  const fetchMetadata = options.fetchPageMetadata
    ?? fetchBackstageNotionPageMetadata;
  const fetchMarkdown = options.fetchMarkdownPage
    ?? fetchBackstageNotionMarkdownPage;
  const timeoutMs = boundedInteger(
    options.requestTimeoutMs,
    BACKSTAGE_NOTION_PARTITION_CAPTURE_FETCH_TIMEOUT_MS,
    1,
    60_000
  );
  const attempts = boundedInteger(
    options.fetchAttempts,
    BACKSTAGE_NOTION_PARTITION_CAPTURE_FETCH_ATTEMPTS,
    1,
    5
  );
  const retryBaseDelayMs = boundedInteger(
    options.retryBaseDelayMs,
    BACKSTAGE_NOTION_PARTITION_CAPTURE_RETRY_BASE_DELAY_MS,
    0,
    60_000
  );
  const wait = options.wait ?? defaultWait;
  const now = options.now ?? (() => new Date());

  const request = async <T>(input: {
    readonly provider: BackstageNotionPartitionProviderPermit;
    readonly signal: AbortSignal;
    readonly operation: (signal: AbortSignal) => Promise<T>;
  }): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      throwIfAborted(input.signal);
      try {
        return await input.provider.runNotionRequest(
          providerSignal => runCaptureRequestWithTimeout(
            timeoutMs,
            providerSignal,
            input.operation
          ),
          input.signal
        );
      } catch (error) {
        throwIfAborted(input.signal);
        lastError = error;
        if (attempt >= attempts || !shouldRetryPartitionCaptureRequest(error)) {
          throw error;
        }
        await wait(retryBaseDelayMs * 2 ** (attempt - 1), input.signal);
      }
    }
    throw lastError;
  };

  const readMetadata = (
    pageId: string,
    provider: BackstageNotionPartitionProviderPermit,
    signal: AbortSignal
  ): Promise<BackstageNotionPageMetadata> => request({
    provider,
    signal,
    operation: requestSignal => fetchMetadata(
      options.fetchImpl,
      accessToken,
      pageId,
      requestSignal
    ),
  });
  const readMarkdown = (
    pageId: string,
    provider: BackstageNotionPartitionProviderPermit,
    signal: AbortSignal
  ): Promise<BackstageNotionMarkdownResponse> => request({
    provider,
    signal,
    operation: requestSignal => fetchMarkdown(
      options.fetchImpl,
      accessToken,
      pageId,
      requestSignal
    ),
  });

  return Object.freeze({
    captureFullHierarchy: async ({
      definition,
      provider,
      signal,
    }: Parameters<
      BackstageNotionPartitionCaptureDependencies['captureFullHierarchy']
    >[0]) => {
      const queue: PartitionCapturePendingPage[] = [{
        pageId: definition.rootPageId,
        parentPageId: null,
        title: definition.displayName,
        depth: 0,
        path: Object.freeze([definition.displayName]),
      }];
      const discovered = new Map<string, string | null>([[
        definition.rootPageId,
        null,
      ]]);
      const pages: BackstageNotionPartitionCapturedPage[] = [];
      let totalSourceCodePoints = 0;

      while (queue.length > 0) {
        throwIfAborted(signal);
        const pending = queue.shift();
        if (!pending) {
          break;
        }
        if (
          pending.depth > definition.capacity.maxDepth
          || pages.length >= definition.capacity.maxPages
        ) {
          throw new BackstageNotionPartitionSyncError(
            'BACKSTAGE_NOTION_PARTITION_SYNC_CAPACITY_EXCEEDED',
            'The partition hierarchy exceeds its configured capacity.'
          );
        }
        const metadata = await readMetadata(pending.pageId, provider, signal);
        if (
          metadata.pageId !== pending.pageId
          || metadata.inTrash
          || (
            pending.parentPageId !== null
            && metadata.parentPageId !== pending.parentPageId
          )
        ) {
          throw new BackstageNotionPartitionSyncError(
            'BACKSTAGE_NOTION_PARTITION_SYNC_CAPTURE_INCOMPLETE',
            'The partition hierarchy metadata is incomplete or inconsistent.'
          );
        }
        const markdown = await readMarkdown(pending.pageId, provider, signal);
        if (
          markdown.truncated
          || markdown.unknownBlockCount > 0
          || UNSUPPORTED_ENHANCED_MARKDOWN_PATTERN.test(markdown.markdown)
        ) {
          throw new BackstageNotionPartitionSyncError(
            'BACKSTAGE_NOTION_PARTITION_SYNC_CAPTURE_INCOMPLETE',
            'The partition hierarchy contains truncated or unsupported content.'
          );
        }
        totalSourceCodePoints += codePointLength(markdown.markdown);
        if (totalSourceCodePoints > definition.capacity.maxContentCodePoints) {
          throw new BackstageNotionPartitionSyncError(
            'BACKSTAGE_NOTION_PARTITION_SYNC_CAPACITY_EXCEEDED',
            'The partition hierarchy exceeds its configured content capacity.'
          );
        }
        const page = inspectBackstageNotionRagPage({
          universeId: definition.universeId,
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
          page.invalidChildPageTagCount > 0
          || page.childPageTagCount !== rawChildPageTagCount
        ) {
          throw new BackstageNotionPartitionSyncError(
            'BACKSTAGE_NOTION_PARTITION_SYNC_CAPTURE_INCOMPLETE',
            'The partition hierarchy contains an ambiguous child-page reference.'
          );
        }
        pages.push(Object.freeze({
          page,
          metadata: Object.freeze({
            pageId: metadata.pageId,
            parentPageId: metadata.parentPageId,
            inTrash: metadata.inTrash,
            lastEditedAt: new Date(metadata.lastEditedAt),
          }),
        }));

        for (const child of page.childPages) {
          const priorParent = discovered.get(child.pageId);
          if (priorParent !== undefined) {
            if (priorParent !== pending.pageId) {
              throw new BackstageNotionPartitionSyncError(
                'BACKSTAGE_NOTION_PARTITION_SYNC_CAPTURE_INCOMPLETE',
                'The partition hierarchy contains a cycle or multi-parent page.'
              );
            }
            continue;
          }
          if (
            discovered.size >= definition.capacity.maxPages
            || pending.depth + 1 > definition.capacity.maxDepth
          ) {
            throw new BackstageNotionPartitionSyncError(
              'BACKSTAGE_NOTION_PARTITION_SYNC_CAPACITY_EXCEEDED',
              'The partition hierarchy exceeds its configured capacity.'
            );
          }
          discovered.set(child.pageId, pending.pageId);
          queue.push(Object.freeze({
            pageId: child.pageId,
            parentPageId: pending.pageId,
            title: child.title,
            depth: pending.depth + 1,
            path: Object.freeze([...pending.path, child.title]),
          }));
        }
      }
      return Object.freeze({
        captureMode: 'full_hierarchy_content_scan' as const,
        pages: Object.freeze(pages),
        completeness: Object.freeze({
          truncatedPageCount: 0,
          unsupportedBlockCount: 0,
          ambiguousChildReferenceCount: 0,
        }),
        capturedAt: new Date(now()),
      });
    },
    verifyFullHierarchy: async ({
      definition,
      captured,
      provider,
      signal,
    }: Parameters<
      BackstageNotionPartitionCaptureDependencies['verifyFullHierarchy']
    >[0]) => {
      if (
        captured.pages.length < 1
        || captured.pages.length > definition.capacity.maxPages
      ) {
        throw new BackstageNotionPartitionSyncError(
          'BACKSTAGE_NOTION_PARTITION_SYNC_SOURCE_DRIFT',
          'The captured partition hierarchy cannot be verified completely.'
        );
      }
      const pages: BackstageNotionPartitionCapturedPageMetadata[] = [];
      for (const capturedPage of captured.pages) {
        const metadata = await readMetadata(capturedPage.page.pageId, provider, signal);
        pages.push(Object.freeze({
          pageId: metadata.pageId,
          parentPageId: metadata.parentPageId,
          inTrash: metadata.inTrash,
          lastEditedAt: new Date(metadata.lastEditedAt),
        }));
      }
      return Object.freeze({
        verificationMode: 'full_metadata_second_pass' as const,
        pages: Object.freeze(pages),
        verifiedAt: new Date(now()),
      });
    },
  });
}

function linkedAbortController(parent: AbortSignal | undefined): {
  readonly controller: AbortController;
  readonly unlink: () => void;
} {
  const controller = new AbortController();
  const forward = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) {
    forward();
  } else {
    parent?.addEventListener('abort', forward, { once: true });
  }
  return {
    controller,
    unlink: () => parent?.removeEventListener('abort', forward),
  };
}

class RenewableLease<TLease extends BackstageNotionPartitionLeaseFence> {
  private readonly linked: ReturnType<typeof linkedAbortController>;
  private current: TLease;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private renewal: Promise<void> | null = null;
  private stopped = false;

  constructor(
    initial: TLease,
    parentSignal: AbortSignal | undefined,
    private readonly intervalMs: number,
    private readonly renew: (lease: TLease) => Promise<TLease | null>
  ) {
    this.current = initial;
    this.linked = linkedAbortController(parentSignal);
    if (!this.linked.controller.signal.aborted) {
      this.schedule();
    }
  }

  get signal(): AbortSignal {
    return this.linked.controller.signal;
  }

  get fence(): TLease {
    return this.current;
  }

  async stop(): Promise<TLease> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.renewal?.catch(() => undefined);
    this.linked.unlink();
    return this.current;
  }

  private schedule(): void {
    if (this.stopped || this.linked.controller.signal.aborted || this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      const running = this.runRenewal();
      this.renewal = running;
      void running.finally(() => {
        if (this.renewal === running) {
          this.renewal = null;
        }
        this.schedule();
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private async runRenewal(): Promise<void> {
    try {
      const renewed = await this.renew(this.current);
      if (!renewed) {
        throw new BackstageNotionPartitionSyncError(
          'BACKSTAGE_NOTION_PARTITION_SYNC_LEASE_LOST',
          'The partition synchronization lease was lost.'
        );
      }
      this.current = renewed;
    } catch (error) {
      if (!this.stopped && !this.linked.controller.signal.aborted) {
        this.linked.controller.abort(error);
      }
    }
  }
}

class PartitionProviderGovernor implements BackstageNotionPartitionProviderPermit {
  constructor(
    private readonly dependencies: BackstageNotionPartitionSyncDependencies,
    private readonly holderId: string,
    private readonly leaseTtlMs: number,
    private readonly pollMs: number
  ) {}

  runNotionRequest<T>(
    operation: (providerSignal: AbortSignal) => Promise<T>,
    signal: AbortSignal
  ): Promise<T> {
    return this.run(
      NOTION_PROVIDER_KEY,
      NOTION_PROVIDER_MODEL_KEY,
      operation,
      signal,
      boundedInteger(
        this.dependencies.notionRequestDelayMs,
        BACKSTAGE_NOTION_PARTITION_SYNC_NOTION_REQUEST_DELAY_MS,
        0,
        60_000
      )
    );
  }

  runEmbeddingRequest<T>(
    operation: (providerSignal: AbortSignal) => Promise<T>,
    signal: AbortSignal
  ): Promise<T> {
    return this.run(
      EMBEDDING_PROVIDER_KEY,
      this.dependencies.embeddingModel,
      operation,
      signal,
      boundedInteger(this.dependencies.embeddingRequestDelayMs, 0, 0, 60_000)
    );
  }

  private async run<T>(
    providerKey: string,
    modelKey: string,
    operation: (providerSignal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    nextRequestDelayMs: number
  ): Promise<T> {
    const processKey = `${providerKey}\u0000${modelKey}`;
    const previous = PROCESS_PROVIDER_TAILS.get(processKey) ?? Promise.resolve();
    let releaseLocal!: () => void;
    const localTail = new Promise<void>(resolve => {
      releaseLocal = resolve;
    });
    PROCESS_PROVIDER_TAILS.set(processKey, localTail);
    await previous;
    try {
      throwIfAborted(signal);
      let lease: BackstageNotionProviderLease | null = null;
      while (!lease) {
        throwIfAborted(signal);
        lease = await this.dependencies.repository.acquireProviderLease(
          providerKey,
          modelKey,
          this.holderId,
          this.leaseTtlMs,
          nextRequestDelayMs
        );
        if (!lease) {
          await (this.dependencies.wait ?? defaultWait)(this.pollMs, signal);
        }
      }
      const heartbeat = new RenewableLease(
        lease,
        signal,
        Math.max(1, Math.floor(this.leaseTtlMs / 3)),
        fence => this.dependencies.repository.renewProviderLease(
          providerKey,
          modelKey,
          fence,
          this.leaseTtlMs,
          nextRequestDelayMs
        )
      );
      try {
        throwIfAborted(heartbeat.signal);
        try {
          const result = await operation(heartbeat.signal);
          throwIfAborted(heartbeat.signal);
          return result;
        } catch (error) {
          if (heartbeat.signal.aborted) {
            throwIfAborted(heartbeat.signal);
          }
          throw error;
        }
      } finally {
        const terminalFence = await heartbeat.stop();
        const released = await this.dependencies.repository.releaseProviderLease(
          providerKey,
          modelKey,
          terminalFence
        ).catch(() => false);
        if (!released) {
          throw new BackstageNotionPartitionSyncError(
            'BACKSTAGE_NOTION_PARTITION_SYNC_LEASE_LOST',
            'The provider coordination lease release was not confirmed.'
          );
        }
      }
    } finally {
      releaseLocal();
      if (PROCESS_PROVIDER_TAILS.get(processKey) === localTail) {
        PROCESS_PROVIDER_TAILS.delete(processKey);
      }
    }
  }
}

export function validateBackstageNotionPartitionCapture(input: {
  readonly definition: BackstageNotionPartitionDefinition;
  readonly capture: BackstageNotionPartitionFullCapture;
  readonly configuredRootPageIds: ReadonlySet<string>;
}): ReadonlyMap<string, readonly string[]> {
  const { definition, capture } = input;
  if (
    capture.captureMode !== 'full_hierarchy_content_scan'
    || capture.pages.length < 1
    || capture.completeness.truncatedPageCount !== 0
    || capture.completeness.unsupportedBlockCount !== 0
    || capture.completeness.ambiguousChildReferenceCount !== 0
  ) {
    throw new BackstageNotionPartitionSyncError(
      'BACKSTAGE_NOTION_PARTITION_SYNC_CAPTURE_INCOMPLETE',
      'The partition hierarchy capture was incomplete.'
    );
  }
  const byId = new Map<string, BackstageNotionPartitionCapturedPage>();
  let totalCodePoints = 0;
  for (const captured of capture.pages) {
    const page = captured.page;
    if (
      page.universeId !== definition.universeId
      || page.pageId !== captured.metadata.pageId
      || (
        page.pageId !== definition.rootPageId
        && page.parentPageId !== captured.metadata.parentPageId
      )
      || captured.metadata.inTrash
      || byId.has(page.pageId)
      || page.sourceLastEditedAt !== captured.metadata.lastEditedAt.toISOString()
    ) {
      throw new BackstageNotionPartitionSyncError(
        'BACKSTAGE_NOTION_PARTITION_SYNC_CAPTURE_INCOMPLETE',
        'The partition hierarchy capture was inconsistent.'
      );
    }
    if (
      page.pageId !== definition.rootPageId
      && input.configuredRootPageIds.has(page.pageId)
    ) {
      throw new BackstageNotionPartitionSyncError(
        'BACKSTAGE_NOTION_PARTITION_SYNC_CAPTURE_INCOMPLETE',
        'The partition hierarchy overlaps another configured shard root.'
      );
    }
    byId.set(page.pageId, captured);
    totalCodePoints += codePointLength(page.sanitizedMarkdown);
  }
  const root = byId.get(definition.rootPageId);
  if (!root || root.page.parentPageId !== null) {
    throw new BackstageNotionPartitionSyncError(
      'BACKSTAGE_NOTION_PARTITION_SYNC_CAPTURE_INCOMPLETE',
      'The partition root was not captured exactly.'
    );
  }
  const idPaths = new Map<string, readonly string[]>();
  const resolvePath = (pageId: string, visiting: ReadonlySet<string>): readonly string[] => {
    const cached = idPaths.get(pageId);
    if (cached) {
      return cached;
    }
    if (visiting.has(pageId)) {
      throw new BackstageNotionPartitionSyncError(
        'BACKSTAGE_NOTION_PARTITION_SYNC_CAPTURE_INCOMPLETE',
        'The partition hierarchy contains a cycle.'
      );
    }
    const captured = byId.get(pageId);
    if (!captured) {
      throw new BackstageNotionPartitionSyncError(
        'BACKSTAGE_NOTION_PARTITION_SYNC_CAPTURE_INCOMPLETE',
        'The partition hierarchy contains an unknown parent.'
      );
    }
    const nextVisiting = new Set(visiting).add(pageId);
    const path = captured.page.parentPageId === null
      ? [pageId]
      : [...resolvePath(captured.page.parentPageId, nextVisiting), pageId];
    const frozen = Object.freeze(path);
    idPaths.set(pageId, frozen);
    return frozen;
  };
  for (const pageId of byId.keys()) {
    const idPath = resolvePath(pageId, new Set());
    const captured = byId.get(pageId)!;
    const expectedScopePath = idPath.map(ancestorPageId =>
      byId.get(ancestorPageId)!.page.title
    );
    if (
      captured.page.path.length !== expectedScopePath.length
      || captured.page.path.some(
        (segment, index) => segment !== expectedScopePath[index]
      )
    ) {
      throw new BackstageNotionPartitionSyncError(
        'BACKSTAGE_NOTION_PARTITION_SYNC_CAPTURE_INCOMPLETE',
        'The partition hierarchy contains inconsistent scope ancestry.'
      );
    }
  }
  const maximumDepth = Math.max(...[...idPaths.values()].map(path => path.length - 1));
  if (
    capture.pages.length > definition.capacity.maxPages
    || totalCodePoints > definition.capacity.maxContentCodePoints
    || maximumDepth > definition.capacity.maxDepth
  ) {
    throw new BackstageNotionPartitionSyncError(
      'BACKSTAGE_NOTION_PARTITION_SYNC_CAPACITY_EXCEEDED',
      'The partition hierarchy exceeds its configured capacity.'
    );
  }
  return idPaths;
}

function verifySecondPass(
  capture: BackstageNotionPartitionFullCapture,
  verification: BackstageNotionPartitionVerificationPass
): string {
  if (
    verification.verificationMode !== 'full_metadata_second_pass'
    || verification.pages.length !== capture.pages.length
  ) {
    throw new BackstageNotionPartitionSyncError(
      'BACKSTAGE_NOTION_PARTITION_SYNC_SOURCE_DRIFT',
      'The partition hierarchy changed during synchronization.'
    );
  }
  const capturedById = new Map(capture.pages.map(page => [page.metadata.pageId, page.metadata]));
  const seen = new Set<string>();
  for (const metadata of verification.pages) {
    const captured = capturedById.get(metadata.pageId);
    if (
      !captured
      || seen.has(metadata.pageId)
      || metadata.inTrash
      || metadata.parentPageId !== captured.parentPageId
      || metadata.lastEditedAt.getTime() !== captured.lastEditedAt.getTime()
    ) {
      throw new BackstageNotionPartitionSyncError(
        'BACKSTAGE_NOTION_PARTITION_SYNC_SOURCE_DRIFT',
        'The partition hierarchy changed during synchronization.'
      );
    }
    seen.add(metadata.pageId);
  }
  return sha256(JSON.stringify([...seen].sort().map(pageId => {
    const metadata = capturedById.get(pageId)!;
    return {
      pageId,
      parentPageId: metadata.parentPageId,
      lastEditedAt: metadata.lastEditedAt.toISOString(),
    };
  })));
}

function captureManifestHash(capture: BackstageNotionPartitionFullCapture): string {
  return sha256(JSON.stringify(capture.pages.map(({ page, metadata }) => ({
    pageId: page.pageId,
    parentPageId: page.parentPageId,
    sourceParentPageId: metadata.parentPageId,
    sourceHash: page.sourceHash,
    lastEditedAt: metadata.lastEditedAt.toISOString(),
  })).sort((left, right) => left.pageId.localeCompare(right.pageId))));
}

function safeReasonCode(error: unknown): BackstageNotionPartitionOptionalUnavailableReasonCode {
  if (error instanceof BackstageNotionPartitionSyncError) {
    switch (error.code) {
      case 'BACKSTAGE_NOTION_PARTITION_SYNC_CAPACITY_EXCEEDED':
        return 'SHARD_CAPACITY_EXCEEDED';
      case 'BACKSTAGE_NOTION_PARTITION_SYNC_CAPTURE_INCOMPLETE':
        return 'SHARD_CAPTURE_INCOMPLETE';
      case 'BACKSTAGE_NOTION_PARTITION_SYNC_SOURCE_DRIFT':
        return 'SHARD_SOURCE_DRIFT';
      case 'BACKSTAGE_NOTION_PARTITION_SYNC_LEASE_LOST':
        return 'SHARD_LEASE_LOST';
      default:
        return 'SHARD_SYNC_FAILED';
    }
  }
  if (
    error instanceof BackstageNotionPartitionRepositoryError
    && error.code === 'BACKSTAGE_NOTION_PARTITION_LEASE_LOST'
  ) {
    return 'SHARD_LEASE_LOST';
  }
  return 'SHARD_SYNC_FAILED';
}

function abortedResult(
  task: ShardTask,
  fullSourceScan = false
): BackstageNotionPartitionShardSyncResult {
  return Object.freeze({
    universeId: task.universeId,
    shardKey: task.shardKey,
    status: 'aborted',
    safeReasonCode: 'SHARD_ABORTED',
    freshSnapshotId: null,
    fullSourceScan,
    pageCount: 0,
    chunkCount: 0,
    sourceGenerationId: null,
    sourceManifestHash: null,
    pageVersionReuseCount: 0,
    embeddedChunkCount: 0,
    leaseReleaseVerified: true,
    pageChanges: EMPTY_PAGE_CHANGES,
  });
}

const EMPTY_PAGE_CHANGES = Object.freeze({
  added: 0,
  changed: 0,
  moved: 0,
  deleted: 0,
  unchanged: 0,
});

function notRequestedResult(
  universeId: string,
  shardKey: string
): BackstageNotionPartitionShardSyncResult {
  return Object.freeze({
    universeId,
    shardKey,
    status: 'not-requested',
    safeReasonCode: 'SHARD_NOT_REQUESTED',
    freshSnapshotId: null,
    fullSourceScan: false,
    pageCount: 0,
    chunkCount: 0,
    sourceGenerationId: null,
    sourceManifestHash: null,
    pageVersionReuseCount: 0,
    embeddedChunkCount: 0,
    leaseReleaseVerified: true,
    pageChanges: EMPTY_PAGE_CHANGES,
  });
}

async function syncShard(
  task: ShardTask,
  dependencies: BackstageNotionPartitionSyncDependencies,
  governor: PartitionProviderGovernor,
  configuredRootPageIds: ReadonlySet<string>,
  holderId: string,
  shardLeaseTtlMs: number,
  sourceCaptureEvidence: Map<string, ShardSourceCaptureEvidence>
): Promise<BackstageNotionPartitionShardSyncResult> {
  if (dependencies.signal?.aborted) {
    return abortedResult(task);
  }
  let lease: BackstageNotionPartitionLease | null;
  try {
    lease = await dependencies.repository.acquireShardLease(
      task.universeId,
      task.shardKey,
      holderId,
      shardLeaseTtlMs
    );
  } catch (error) {
    if (dependencies.signal?.aborted) {
      return abortedResult(task);
    }
    return Object.freeze({
      universeId: task.universeId,
      shardKey: task.shardKey,
      status: 'failed',
      safeReasonCode: safeReasonCode(error),
      freshSnapshotId: null,
      fullSourceScan: false,
      pageCount: 0,
      chunkCount: 0,
      sourceGenerationId: null,
      sourceManifestHash: null,
      pageVersionReuseCount: 0,
      embeddedChunkCount: 0,
      leaseReleaseVerified: true,
      pageChanges: EMPTY_PAGE_CHANGES,
    });
  }
  if (!lease) {
    return Object.freeze({
      universeId: task.universeId,
      shardKey: task.shardKey,
      status: 'lease-busy',
      safeReasonCode: 'SHARD_LEASE_BUSY',
      freshSnapshotId: null,
      fullSourceScan: false,
      pageCount: 0,
      chunkCount: 0,
      sourceGenerationId: null,
      sourceManifestHash: null,
      pageVersionReuseCount: 0,
      embeddedChunkCount: 0,
      leaseReleaseVerified: true,
      pageChanges: EMPTY_PAGE_CHANGES,
    });
  }
  const heartbeat = new RenewableLease(
    lease,
    dependencies.signal,
    Math.max(1, Math.floor(shardLeaseTtlMs / 3)),
    fence => dependencies.repository.renewShardLease(
      task.universeId,
      task.shardKey,
      fence,
      shardLeaseTtlMs
    )
  );
  let terminalFence: BackstageNotionPartitionLeaseFence = lease;
  let fullSourceScan = false;
  const attempt = await (async (): Promise<BackstageNotionPartitionShardSyncResult> => {
    try {
    const capture = await dependencies.captureFullHierarchy({
      definition: task.definition,
      provider: governor,
      signal: heartbeat.signal,
    });
    fullSourceScan = capture.captureMode === 'full_hierarchy_content_scan';
    const idPaths = validateBackstageNotionPartitionCapture({
      definition: task.definition,
      capture,
      configuredRootPageIds,
    });
    const priorInventory = task.expectedHead.activeSnapshotId === null
      ? Object.freeze([])
      : await dependencies.repository.loadShardPageInventory(
          task.universeId,
          task.shardKey,
          task.expectedHead.activeSnapshotId,
          BACKSTAGE_NOTION_PARTITION_MAX_PAGES
        );
    if (new Set(priorInventory.map(item => item.pageId)).size !== priorInventory.length) {
      throw new BackstageNotionPartitionSyncError(
        'BACKSTAGE_NOTION_PARTITION_SYNC_CAPTURE_INCOMPLETE',
        'The prior partition inventory contains duplicate page identity.'
      );
    }
    const pageChangeClassifications = classifyBackstageNotionPageMaterials(
      priorInventory.map(item => ({
        pageId: item.pageId,
        contentHash: item.contentHash,
        parentPageId: item.parentPageId,
        title: item.title,
        path: item.scopePath,
      })),
      capture.pages.map(({ page }) => ({
        pageId: page.pageId,
        contentHash: hashBackstageNotionPageMaterial(page.sanitizedMarkdown),
        parentPageId: page.parentPageId,
        title: page.title,
        path: page.path,
      }))
    );
    const pageChanges = Object.freeze(pageChangeClassifications.reduce(
      (counts, classification) => {
        counts[classification.state] += 1;
        return counts;
      },
      { added: 0, changed: 0, moved: 0, deleted: 0, unchanged: 0 }
    ));
    const materialByPageId = new Map<string, BackstageNotionResolvedPartitionPageMaterial>();
    let pageVersionReuseCount = 0;
    let embeddedChunkCount = 0;
    let chunkCount = 0;
    for (const captured of capture.pages) {
      throwIfAborted(heartbeat.signal);
      let material: BackstageNotionResolvedPartitionPageMaterial;
      try {
        material = await resolveBackstageNotionPartitionPageMaterial({
          page: captured.page,
          embeddingModel: dependencies.embeddingModel,
          embeddingVersion: BACKSTAGE_NOTION_PARTITION_SYNC_EMBEDDING_VERSION,
          embeddingDimension: dependencies.embeddingDimension,
          maximumChunkCount: task.definition.capacity.maxChunks - chunkCount,
          signal: heartbeat.signal,
        }, {
          repository: dependencies.repository,
          embedBatch: contents => governor.runEmbeddingRequest(
            providerSignal => dependencies.embedBatch(contents, providerSignal),
            heartbeat.signal
          ),
        });
      } catch (error) {
        if (error instanceof BackstageNotionPartitionMaterialCapacityError) {
          throw new BackstageNotionPartitionSyncError(
            'BACKSTAGE_NOTION_PARTITION_SYNC_CAPACITY_EXCEEDED',
            'The partition retrieval material exceeds its configured capacity.'
          );
        }
        throw error;
      }
      materialByPageId.set(captured.page.pageId, material);
      pageVersionReuseCount += material.pageVersionReused ? 1 : 0;
      embeddedChunkCount += material.embeddedChunkCount;
      chunkCount += material.chunks.length;
    }
    if (chunkCount < 1 || chunkCount > task.definition.capacity.maxChunks) {
      throw new BackstageNotionPartitionSyncError(
        'BACKSTAGE_NOTION_PARTITION_SYNC_CAPACITY_EXCEEDED',
        'The partition retrieval material exceeds its configured capacity.'
      );
    }
    const verification = await dependencies.verifyFullHierarchy({
      definition: task.definition,
      captured: capture,
      provider: governor,
      signal: heartbeat.signal,
    });
    const driftHash = verifySecondPass(capture, verification);
    const sourceManifestHash = captureManifestHash(capture);
    const completenessHash = sha256(JSON.stringify({
      pageCount: capture.pages.length,
      chunkCount,
      pageFormatVersion: BACKSTAGE_NOTION_PARTITION_PAGE_FORMAT_VERSION,
      chunkerVersion: BACKSTAGE_NOTION_PARTITION_CHUNKER_VERSION,
      indexFormatVersion: BACKSTAGE_NOTION_PARTITION_SYNC_INDEX_FORMAT_VERSION,
    }));
    terminalFence = await heartbeat.stop();
    throwIfAborted(heartbeat.signal);
    const activated = await dependencies.repository.activateShardSnapshot({
      snapshotId: randomUUID(),
      universeId: task.universeId,
      shardKey: task.shardKey,
      partitionVersionId: task.partitionVersionId,
      rootPageId: task.definition.rootPageId,
      sourceGenerationId: task.sourceGenerationId,
      sourceManifestHash,
      embeddingModel: dependencies.embeddingModel,
      embeddingVersion: BACKSTAGE_NOTION_PARTITION_SYNC_EMBEDDING_VERSION,
      indexFormatVersion: BACKSTAGE_NOTION_PARTITION_SYNC_INDEX_FORMAT_VERSION,
      sourceMaxLastEditedAt: new Date(Math.max(...capture.pages.map(page =>
        page.metadata.lastEditedAt.getTime()
      ))),
      expectedHead: task.expectedHead,
      lease: terminalFence,
      pages: capture.pages.map(({ page, metadata }) => ({
        pageId: page.pageId,
        pageVersionId: materialByPageId.get(page.pageId)!.pageVersionId,
        parentPageId: page.parentPageId,
        title: page.title,
        canonicalUrl: `https://www.notion.so/${page.pageId.replaceAll('-', '')}`,
        sourceLastEditedAt: metadata.lastEditedAt,
        depth: idPaths.get(page.pageId)!.length - 1,
        path: idPaths.get(page.pageId)!,
        scopePath: page.path,
        scopeTitleKey: normalizeBackstageNotionScopeKey(page.title),
        scopePathKey: normalizeBackstageNotionScopePath(page.path),
      })),
      occurrences: capture.pages.flatMap(({ page }) => {
        const material = materialByPageId.get(page.pageId)!;
        return material.chunks.map(chunk => ({
          pageId: page.pageId,
          pageVersionId: material.pageVersionId,
          ordinal: chunk.ordinal,
          chunkVersionId: chunk.chunkVersionId,
          category: chunk.category,
        }));
      }),
      verifications: [{
        kind: 'capture',
        resultHash: sourceManifestHash,
        verifiedAt: capture.capturedAt,
      }, {
        kind: 'source_drift',
        resultHash: driftHash,
        verifiedAt: verification.verifiedAt,
      }, {
        kind: 'completeness',
        resultHash: completenessHash,
        verifiedAt: verification.verifiedAt,
      }],
    });
    sourceCaptureEvidence.set(`${task.universeId}\u0000${task.shardKey}`, Object.freeze({
      sourceGenerationId: task.sourceGenerationId,
      sourceManifestHash,
      partitionVersionId: task.partitionVersionId,
      definition: task.definition,
      capture,
    }));
    return Object.freeze({
      universeId: task.universeId,
      shardKey: task.shardKey,
      status: 'fresh',
      safeReasonCode: null,
      freshSnapshotId: activated.snapshotId,
      fullSourceScan,
      pageCount: activated.pageCount,
      chunkCount: activated.chunkCount,
      sourceGenerationId: task.sourceGenerationId,
      sourceManifestHash,
      pageVersionReuseCount,
      embeddedChunkCount,
      leaseReleaseVerified: false,
      pageChanges,
    });
    } catch (error) {
      if (dependencies.signal?.aborted) {
        return abortedResult(task, fullSourceScan);
      }
      return Object.freeze({
        universeId: task.universeId,
        shardKey: task.shardKey,
        status: 'failed',
        safeReasonCode: safeReasonCode(error),
        freshSnapshotId: null,
        fullSourceScan,
        pageCount: 0,
        chunkCount: 0,
        sourceGenerationId: null,
        sourceManifestHash: null,
        pageVersionReuseCount: 0,
        embeddedChunkCount: 0,
        leaseReleaseVerified: false,
        pageChanges: EMPTY_PAGE_CHANGES,
      });
    }
  })();
  terminalFence = await heartbeat.stop();
  const leaseReleaseVerified = await dependencies.repository.releaseShardLease(
    task.universeId,
    task.shardKey,
    terminalFence
  ).catch(() => false);
  return Object.freeze({ ...attempt, leaseReleaseVerified });
}

async function verifySourceGenerationBarrier(input: {
  readonly registered: RegisteredUniverse;
  readonly attempts: readonly BackstageNotionPartitionShardSyncResult[];
  readonly sourceCaptureEvidence: ReadonlyMap<string, ShardSourceCaptureEvidence>;
  readonly dependencies: BackstageNotionPartitionSyncDependencies;
  readonly governor: PartitionProviderGovernor;
}): Promise<SourceGenerationBarrierEvidence | null> {
  if (
    input.attempts.length !== input.registered.universe.shards.length
    || input.attempts.some(attempt => attempt.status !== 'fresh')
  ) {
    return null;
  }
  try {
    const terminalVerifications: {
      shardKey: string;
      partitionVersionId: string;
      snapshotId: string;
      sourceManifestHash: string;
      pageCount: number;
      chunkCount: number;
      resultHash: string;
      verifiedAt: Date;
    }[] = [];
    let sourceGenerationId: string | null = null;
    for (const definition of input.registered.universe.shards) {
      throwIfAborted(input.dependencies.signal);
      const attempt = input.attempts.find(result => result.shardKey === definition.shardKey);
      const evidence = input.sourceCaptureEvidence.get(
        `${input.registered.universe.universeId}\u0000${definition.shardKey}`
      );
      if (
        !attempt
        || !evidence
        || attempt.sourceGenerationId === null
        || attempt.sourceManifestHash === null
        || attempt.freshSnapshotId === null
        || evidence.sourceGenerationId !== attempt.sourceGenerationId
        || evidence.sourceManifestHash !== attempt.sourceManifestHash
      ) {
        return null;
      }
      if (
        sourceGenerationId !== null
        && sourceGenerationId !== evidence.sourceGenerationId
      ) {
        return null;
      }
      sourceGenerationId = evidence.sourceGenerationId;
      const verification = await input.dependencies.verifyFullHierarchy({
        definition: evidence.definition,
        captured: evidence.capture,
        provider: input.governor,
        signal: input.dependencies.signal ?? new AbortController().signal,
      });
      terminalVerifications.push({
        shardKey: definition.shardKey,
        partitionVersionId: evidence.partitionVersionId,
        snapshotId: attempt.freshSnapshotId,
        sourceManifestHash: evidence.sourceManifestHash,
        pageCount: attempt.pageCount,
        chunkCount: attempt.chunkCount,
        resultHash: verifySecondPass(evidence.capture, verification),
        verifiedAt: verification.verifiedAt,
      });
    }
    if (sourceGenerationId === null) {
      return null;
    }
    const ordered = terminalVerifications.sort((left, right) =>
      left.shardKey < right.shardKey ? -1 : left.shardKey > right.shardKey ? 1 : 0
    );
    return await input.dependencies.repository.verifySourceGeneration({
      universeId: input.registered.universe.universeId,
      configurationVersionId: input.registered.registration.configurationVersionId,
      sourceGenerationId,
      members: ordered.map(item => ({
        shardKey: item.shardKey,
        partitionVersionId: item.partitionVersionId,
        snapshotId: item.snapshotId,
        sourceManifestHash: item.sourceManifestHash,
        pageCount: item.pageCount,
        chunkCount: item.chunkCount,
        terminalDriftHash: item.resultHash,
        verifiedAt: item.verifiedAt,
      })),
    });
  } catch {
    return null;
  }
}

async function runBoundedShardTasks(
  tasks: readonly ShardTask[],
  concurrency: number,
  run: (task: ShardTask) => Promise<BackstageNotionPartitionShardSyncResult>
): Promise<readonly BackstageNotionPartitionShardSyncResult[]> {
  const results = new Array<BackstageNotionPartitionShardSyncResult>(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      const task = tasks[index];
      if (task) {
        results[index] = await run(task);
      }
    }
  });
  await Promise.all(workers);
  return Object.freeze(results);
}

function buildManifestInput(input: {
  readonly registered: RegisteredUniverse;
  readonly terminal: BackstageNotionPartitionSynchronizationState;
  readonly attempts: ReadonlyMap<string, BackstageNotionPartitionShardSyncResult>;
  readonly embeddingModel: string;
  readonly embeddingDimension: number;
  readonly now: Date;
  readonly lastKnownGoodMaximumAgeMs: number;
  readonly sourceBarrier: SourceGenerationBarrierEvidence;
}): ActivateBackstageNotionUniverseManifestInput | null {
  const definitionByKey = new Map(input.registered.universe.shards.map(shard => [
    shard.shardKey,
    shard,
  ]));
  const members: ActivateBackstageNotionUniverseManifestInput['members'][number][] = [];
  const omissions: ActivateBackstageNotionUniverseManifestInput['omissions'][number][] = [];
  const sourceMembers: Readonly<{
    shardKey: string;
    partitionVersionId: string;
    sourceManifestHash: string;
    pageCount: number;
    chunkCount: number;
  }>[] = [];
  let sourceGenerationId: string | null = null;
  for (const terminalShard of input.terminal.shards) {
    const definition = definitionByKey.get(terminalShard.shardKey);
    const attempt = input.attempts.get(terminalShard.shardKey);
    if (!definition || !attempt) {
      return null;
    }
    const decision = decideBackstageNotionPartitionManifestMembership({
      definition,
      partitionVersionId: terminalShard.partitionVersionId,
      attempt,
      terminalActiveSnapshot: terminalShard.activeSnapshot,
      expectedIndex: {
        embeddingModel: input.embeddingModel,
        embeddingVersion: BACKSTAGE_NOTION_PARTITION_SYNC_EMBEDDING_VERSION,
        embeddingDimension: input.embeddingDimension,
        indexFormatVersion: BACKSTAGE_NOTION_PARTITION_SYNC_INDEX_FORMAT_VERSION,
      },
      now: input.now,
      lastKnownGoodMaximumAgeMs: input.lastKnownGoodMaximumAgeMs,
    });
    if (decision.kind !== 'fresh') {
      return null;
    }
    if (
      attempt.sourceGenerationId === null
      || attempt.sourceManifestHash === null
      || (
        sourceGenerationId !== null
        && attempt.sourceGenerationId !== sourceGenerationId
      )
    ) {
      return null;
    }
    sourceGenerationId = attempt.sourceGenerationId;
    sourceMembers.push(Object.freeze({
      shardKey: decision.shardKey,
      partitionVersionId: decision.partitionVersionId,
      sourceManifestHash: attempt.sourceManifestHash,
      pageCount: attempt.pageCount,
      chunkCount: attempt.chunkCount,
    }));
    members.push({
      shardKey: decision.shardKey,
      partitionVersionId: decision.partitionVersionId,
      snapshotId: decision.snapshotId,
      decision: decision.kind,
      verifiedAt: decision.verifiedAt,
      expectedHead: terminalShard.expectedHead,
    });
  }
  if (
    members.length !== input.registered.universe.shards.length
    || omissions.length !== 0
    || sourceGenerationId === null
    || sourceGenerationId !== input.sourceBarrier.sourceGenerationId
    || sourceMembers.length !== members.length
  ) {
    return null;
  }
  const canonicalSourceMembers = [...sourceMembers].sort((left, right) =>
    left.shardKey < right.shardKey ? -1 : left.shardKey > right.shardKey ? 1 : 0
  );
  const sourcePageCount = canonicalSourceMembers.reduce(
    (total, member) => total + member.pageCount,
    0
  );
  const sourceChunkCount = canonicalSourceMembers.reduce(
    (total, member) => total + member.chunkCount,
    0
  );
  const sourceDigest = hashBackstageNotionPartitionSourceGeneration({
    universeId: input.registered.universe.universeId,
    members: canonicalSourceMembers,
  });
  return {
    manifestId: randomUUID(),
    universeId: input.registered.universe.universeId,
    configurationVersionId: input.terminal.configurationVersionId,
    configurationGeneration: input.terminal.configurationGeneration,
    configurationHash: input.terminal.configurationHash,
    sourceGenerationId,
    sourceDigest,
    sourcePageCount,
    sourceChunkCount,
    sourceVerifiedAt: input.sourceBarrier.sourceVerifiedAt,
    sourceVerificationHash: input.sourceBarrier.sourceVerificationHash,
    indexFormatVersion: BACKSTAGE_NOTION_PARTITION_SYNC_INDEX_FORMAT_VERSION,
    reconciliationGeneration:
      input.registered.registration.reconciliationGeneration,
    expectedUniverseHead: input.terminal.expectedUniverseHead,
    members,
    omissions,
  };
}

async function publishManifest(input: {
  readonly registered: RegisteredUniverse;
  readonly attempts: readonly BackstageNotionPartitionShardSyncResult[];
  readonly dependencies: BackstageNotionPartitionSyncDependencies;
  readonly lastKnownGoodMaximumAgeMs: number;
  readonly sourceBarrier: SourceGenerationBarrierEvidence;
}): Promise<Pick<BackstageNotionPartitionUniverseSyncResult,
  | 'manifestStatus'
  | 'manifestId'
  | 'memberCount'
  | 'omissionCount'
  | 'manifestOmissions'>> {
  if (input.attempts.some(attempt => !attempt.leaseReleaseVerified)) {
    return {
      manifestStatus: 'deferred',
      manifestId: null,
      memberCount: 0,
      omissionCount: 0,
      manifestOmissions: Object.freeze([]),
    };
  }
  const attempts = new Map(input.attempts.map(attempt => [attempt.shardKey, attempt]));
  for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
    let terminal: BackstageNotionPartitionSynchronizationState | null;
    try {
      terminal = await input.dependencies.repository.loadUniverseSynchronizationState(
        input.registered.universe.universeId,
        input.registered.registration.configurationVersionId
      );
    } catch {
      return {
        manifestStatus: 'deferred',
        manifestId: null,
        memberCount: 0,
        omissionCount: 0,
        manifestOmissions: Object.freeze([]),
      };
    }
    if (!terminal) {
      return {
        manifestStatus: 'deferred',
        manifestId: null,
        memberCount: 0,
        omissionCount: 0,
        manifestOmissions: Object.freeze([]),
      };
    }
    const manifestInput = buildManifestInput({
      registered: input.registered,
      terminal,
      attempts,
      embeddingModel: input.dependencies.embeddingModel,
      embeddingDimension: input.dependencies.embeddingDimension,
      now: (input.dependencies.now ?? (() => new Date()))(),
    lastKnownGoodMaximumAgeMs: input.lastKnownGoodMaximumAgeMs,
    sourceBarrier: input.sourceBarrier,
    });
    if (!manifestInput) {
      return {
        manifestStatus: 'blocked',
        manifestId: null,
        memberCount: 0,
        omissionCount: 0,
        manifestOmissions: Object.freeze([]),
      };
    }
    try {
      const published = await input.dependencies.repository.activateUniverseManifest(
        manifestInput
      );
      return {
        manifestStatus: 'published',
        manifestId: published.manifestId,
        memberCount: published.memberCount,
        omissionCount: published.omissionCount,
        manifestOmissions: published.omissions,
      };
    } catch (error) {
      if (
        error instanceof BackstageNotionPartitionRepositoryError
        && (
          error.code === 'BACKSTAGE_NOTION_PARTITION_OWNERSHIP_CONFLICT'
          || error.code
            === 'BACKSTAGE_NOTION_PARTITION_REQUIRED_SHARD_UNAVAILABLE'
        )
      ) {
        return {
          manifestStatus: 'blocked',
          manifestId: null,
          memberCount: 0,
          omissionCount: 0,
          manifestOmissions: Object.freeze([]),
        };
      }
      const retryable = error instanceof BackstageNotionPartitionRepositoryError
        && (
          error.code === 'BACKSTAGE_NOTION_PARTITION_STALE_HEAD'
          || error.code === 'BACKSTAGE_NOTION_PARTITION_STALE_CONFIGURATION'
        );
      if (!retryable || attemptIndex > 0) {
        return {
          manifestStatus: 'deferred',
          manifestId: null,
          memberCount: 0,
          omissionCount: 0,
          manifestOmissions: Object.freeze([]),
        };
      }
    }
  }
  return {
    manifestStatus: 'deferred',
    manifestId: null,
    memberCount: 0,
    omissionCount: 0,
    manifestOmissions: Object.freeze([]),
  };
}

/**
 * Execute a full configured reconciliation or one exact targeted shard.
 * Notion source capture remains a full hierarchy scan for every attempted
 * shard; incremental reuse begins after sanitized page material is captured,
 * where immutable chunks and embeddings are resolved by content identity.
 */
export async function syncBackstageNotionPartitionConfiguration(
  configuration: BackstageNotionPartitionConfiguration,
  dependencies: BackstageNotionPartitionSyncDependencies
): Promise<BackstageNotionPartitionSynchronizationResult> {
  if (configuration.status !== 'valid') {
    throw new BackstageNotionPartitionSyncError(
      'BACKSTAGE_NOTION_PARTITION_SYNC_CONFIGURATION_INVALID',
      'Partition synchronization requires an exact valid configuration.'
    );
  }
  if (
    dependencies.embeddingModel !== dependencies.embeddingModel.trim()
    || dependencies.embeddingModel.length < 1
    || dependencies.embeddingModel.length > 200
    || !Number.isSafeInteger(dependencies.embeddingDimension)
    || dependencies.embeddingDimension < 1
    || dependencies.embeddingDimension > 4_096
  ) {
    throw new BackstageNotionPartitionSyncError(
      'BACKSTAGE_NOTION_PARTITION_SYNC_CONFIGURATION_INVALID',
      'Partition synchronization embedding configuration is invalid.'
    );
  }
  const selectedUniverse = dependencies.selection
    ? configuration.universes.find(universe => (
        universe.universeId === dependencies.selection!.universeId
      ))
    : null;
  const selectedShard = selectedUniverse && dependencies.selection
    ? selectedUniverse.shards.find(shard => (
        shard.shardKey === dependencies.selection!.shardKey
      ))
    : null;
  if (dependencies.selection && (!selectedUniverse || !selectedShard)) {
    throw new BackstageNotionPartitionSyncError(
      'BACKSTAGE_NOTION_PARTITION_SYNC_CONFIGURATION_INVALID',
      'The selected partition shard is not present in the exact configuration.'
    );
  }
  throwIfAborted(dependencies.signal);
  const holderId = dependencies.holderId
    ?? `backstage-notion-partition:${process.pid}:${randomUUID()}`;
  const shardLeaseTtlMs = boundedInteger(
    dependencies.shardLeaseTtlMs,
    BACKSTAGE_NOTION_PARTITION_LEASE_MAX_MS,
    1_000,
    BACKSTAGE_NOTION_PARTITION_LEASE_MAX_MS
  );
  const providerLeaseTtlMs = boundedInteger(
    dependencies.providerLeaseTtlMs,
    BACKSTAGE_NOTION_PARTITION_SYNC_PROVIDER_LEASE_TTL_MS,
    1_000,
    BACKSTAGE_NOTION_PARTITION_LEASE_MAX_MS
  );
  const concurrency = boundedInteger(
    dependencies.concurrency,
    BACKSTAGE_NOTION_PARTITION_SYNC_DEFAULT_CONCURRENCY,
    1,
    BACKSTAGE_NOTION_PARTITION_SYNC_MAX_CONCURRENCY
  );
  const providerPollMs = boundedInteger(
    dependencies.providerPollMs,
    BACKSTAGE_NOTION_PARTITION_SYNC_PROVIDER_POLL_MS,
    1,
    60_000
  );
  const lastKnownGoodMaximumAgeMs = boundedInteger(
    dependencies.lastKnownGoodMaximumAgeMs,
    BACKSTAGE_NOTION_PARTITION_SYNC_DEFAULT_LKG_MAX_AGE_MS,
    1,
    7 * 24 * 60 * 60 * 1_000
  );
  const registered: RegisteredUniverse[] = [];
  const universesToRegister = selectedUniverse
    ? [selectedUniverse]
    : configuration.universes;
  for (const universe of universesToRegister) {
    throwIfAborted(dependencies.signal);
    const expectedUniverseHead = await dependencies.repository.loadUniverseHead(
      universe.universeId
    );
    const registration = await dependencies.repository.registerConfiguration({
      configurationGeneration: configuration.generation,
      configurationHash: configuration.semanticDigest,
      universe,
      expectedUniverseHead,
    });
    const initialState = await dependencies.repository.loadUniverseSynchronizationState(
      universe.universeId,
      registration.configurationVersionId
    );
    if (!initialState) {
      throw new BackstageNotionPartitionSyncError(
        'BACKSTAGE_NOTION_PARTITION_SYNC_STALE_CONFIGURATION',
        'The registered partition configuration changed before synchronization.'
      );
    }
    registered.push(Object.freeze({ universe, registration, initialState }));
  }
  const registeredByUniverse = new Map(registered.map(item => [
    item.universe.universeId,
    item,
  ]));
  const sourceGenerationIds = new Map(registered.map(item => [
    item.universe.universeId,
    randomUUID(),
  ]));
  const planned = planBackstageNotionPartitionFullReconciliation(
    universesToRegister
  ).filter(job => !dependencies.selection || (
    job.universeId === dependencies.selection.universeId
    && job.shardKey === dependencies.selection.shardKey
  ));
  const tasks = planned.map(job => {
    const registeredUniverse = registeredByUniverse.get(job.universeId)!;
    const definitionState = registeredUniverse.initialState.shards.find(
      shard => shard.shardKey === job.shardKey
    );
    if (!definitionState) {
      throw new BackstageNotionPartitionSyncError(
        'BACKSTAGE_NOTION_PARTITION_SYNC_STALE_CONFIGURATION',
        'The registered partition definition is unavailable.'
      );
    }
    return Object.freeze({
      ...job,
      registered: registeredUniverse,
      partitionVersionId: definitionState.partitionVersionId,
      expectedHead: definitionState.expectedHead,
      sourceGenerationId: sourceGenerationIds.get(job.universeId)!,
    });
  });
  const configuredRootPageIdsByUniverse =
    groupBackstageNotionPartitionRootPageIdsByUniverse(configuration.universes);
  const governor = new PartitionProviderGovernor(
    dependencies,
    holderId,
    providerLeaseTtlMs,
    providerPollMs
  );
  const sourceCaptureEvidence = new Map<string, ShardSourceCaptureEvidence>();
  const shardResults = await runBoundedShardTasks(
    tasks,
    concurrency,
    task => syncShard(
      task,
      dependencies,
      governor,
      configuredRootPageIdsByUniverse.get(task.universeId)!,
      holderId,
      shardLeaseTtlMs,
      sourceCaptureEvidence
    )
  );
  const universeResults: BackstageNotionPartitionUniverseSyncResult[] = [];
  for (const registeredUniverse of registered) {
    const executedResults = shardResults.filter(
      result => result.universeId === registeredUniverse.universe.universeId
    );
    const executedByShardKey = new Map(executedResults.map(result => [
      result.shardKey,
      result,
    ]));
    const results = registeredUniverse.universe.shards.map(definition => (
      executedByShardKey.get(definition.shardKey)
      ?? notRequestedResult(
        registeredUniverse.universe.universeId,
        definition.shardKey
      )
    ));
    const sourceBarrier = dependencies.signal?.aborted
      ? null
      : await verifySourceGenerationBarrier({
          registered: registeredUniverse,
          attempts: results,
          sourceCaptureEvidence,
          dependencies,
          governor,
        });
    const publication = dependencies.signal?.aborted
      ? {
          manifestStatus: 'deferred' as const,
          manifestId: null,
          memberCount: 0,
          omissionCount: 0,
          manifestOmissions: Object.freeze([]),
        }
      : sourceBarrier === null
        ? {
            manifestStatus: 'blocked' as const,
            manifestId: null,
            memberCount: 0,
            omissionCount: 0,
            manifestOmissions: Object.freeze([]),
          }
        : await publishManifest({
          registered: registeredUniverse,
          attempts: results,
            dependencies,
            lastKnownGoodMaximumAgeMs,
            sourceBarrier,
        });
    universeResults.push(Object.freeze({
      universeId: registeredUniverse.universe.universeId,
      configurationVersionId: registeredUniverse.registration.configurationVersionId,
      sourceGenerationVerified: sourceBarrier !== null,
      ...publication,
      shardResults: Object.freeze(results),
    }));
  }
  return Object.freeze({
    kind: dependencies.selection
      ? 'targeted_reconciliation'
      : 'full_reconciliation',
    universes: Object.freeze(universeResults),
  });
}

import {
  getBackstageNotionRagRepository,
  type BackstageNotionActiveInventory,
  type BackstageNotionRagRepository,
} from '@core/db/repositories/backstageNotionRagRepository.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { getEnvNumber } from '@platform/runtime/env.js';
import { resolveErrorMessage } from '@shared/errorUtils.js';
import {
  readBackstageNotionAuthorityConfiguration,
  type BackstageNotionAuthorityConfiguration,
  type BackstageNotionAuthorityRoot,
} from '@services/backstageNotionAuthority.js';
import {
  BACKSTAGE_NOTION_RAG_INDEX_FORMAT,
  syncConfiguredBackstageNotionAuthorities,
  type BackstageNotionSyncResult,
} from '@services/backstageNotionSync.js';
import {
  BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION,
} from '@shared/backstage/backstageNotionRagCore.js';

export const BACKSTAGE_NOTION_SYNC_INTERVAL_ENV_NAME =
  'ARCANOS_BACKSTAGE_NOTION_SYNC_INTERVAL_MS';
export const BACKSTAGE_NOTION_SYNC_INTERVAL_DEFAULT_MS = 15 * 60 * 1_000;
export const BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS = 60 * 1_000;
export const BACKSTAGE_NOTION_SYNC_INTERVAL_MAX_MS = 24 * 60 * 60 * 1_000;
export const BACKSTAGE_NOTION_WORKER_READINESS_ERROR_CODE =
  'BACKSTAGE_NOTION_WORKER_READINESS_FAILED';

export type BackstageNotionWorkerReadinessFailureReason =
  | 'configuration-invalid'
  | 'index-not-current'
  | 'sync-result-incomplete';

export class BackstageNotionWorkerReadinessError extends Error {
  readonly code = BACKSTAGE_NOTION_WORKER_READINESS_ERROR_CODE;

  constructor(
    readonly reason: BackstageNotionWorkerReadinessFailureReason,
    message: string
  ) {
    super(message);
    this.name = 'BackstageNotionWorkerReadinessError';
  }
}

export interface BackstageNotionWorkerReadinessEvidence {
  configuredUniverses: number;
  currentBeforeSync: number;
  syncAttempted: boolean;
  activated: number;
  unchanged: number;
}

export interface BackstageNotionWorkerReadinessDependencies {
  signal?: AbortSignal;
  readConfiguration?: () => BackstageNotionAuthorityConfiguration;
  repository?: Pick<BackstageNotionRagRepository, 'loadActiveInventory'>;
  sync?: typeof syncConfiguredBackstageNotionAuthorities;
}

export interface BackstageNotionSyncLoopHandle {
  stop(): void;
  stopAndDrain(): Promise<void>;
}

export interface BackstageNotionSynchronizationCoordinator {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export interface BackstageNotionSyncLoopDependencies {
  signal?: AbortSignal;
  intervalMs?: number;
  sync?: typeof syncConfiguredBackstageNotionAuthorities;
  logger?: Pick<typeof logger, 'info' | 'warn'>;
  coordinator?: BackstageNotionSynchronizationCoordinator;
}

/** Serialize legacy and partition crawls owned by one worker process. */
export function createBackstageNotionSynchronizationCoordinator():
BackstageNotionSynchronizationCoordinator {
  let tail: Promise<void> = Promise.resolve();
  return Object.freeze({
    async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
      let release!: () => void;
      const previous = tail;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    },
  });
}

function throwIfReadinessAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('Backstage Notion worker readiness aborted.');
  }
}

function isCurrentBackstageNotionInventory(
  root: BackstageNotionAuthorityRoot,
  inventory: BackstageNotionActiveInventory | null
): boolean {
  if (
    !inventory
    || inventory.snapshot.universeId !== root.universeId
    || inventory.snapshot.rootPageId !== root.rootPageId
    || inventory.snapshot.pageCount < 1
    || inventory.snapshot.chunkCount < 1
    || inventory.snapshot.pageCount !== inventory.pages.length
    || !inventory.pages.some(page => page.pageId === root.rootPageId)
    || new Set(inventory.pages.map(page => page.pageId)).size
      !== inventory.pages.length
  ) {
    return false;
  }
  return inventory.pages.every(page => (
    page.metadata.indexFormat === BACKSTAGE_NOTION_RAG_INDEX_FORMAT
    && page.metadata.headingIndexVersion
      === BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION
  ));
}

async function countCurrentBackstageNotionInventories(
  roots: readonly BackstageNotionAuthorityRoot[],
  repository: Pick<BackstageNotionRagRepository, 'loadActiveInventory'>,
  signal: AbortSignal | undefined
): Promise<number> {
  const inventories = await Promise.all(roots.map(async root => {
    throwIfReadinessAborted(signal);
    const inventory = await repository.loadActiveInventory(root.universeId);
    throwIfReadinessAborted(signal);
    return isCurrentBackstageNotionInventory(root, inventory);
  }));
  return inventories.filter(Boolean).length;
}

function validateReadinessSyncResults(
  roots: readonly BackstageNotionAuthorityRoot[],
  results: readonly BackstageNotionSyncResult[]
): void {
  const configuredUniverseIds = new Set(roots.map(root => root.universeId));
  const seenUniverseIds = new Set<string>();
  for (const result of results) {
    if (
      !configuredUniverseIds.has(result.universeId)
      || seenUniverseIds.has(result.universeId)
      || (result.status !== 'activated' && result.status !== 'unchanged')
    ) {
      throw new BackstageNotionWorkerReadinessError(
        'sync-result-incomplete',
        'Backstage Notion readiness synchronization did not complete every configured authority.'
      );
    }
    seenUniverseIds.add(result.universeId);
  }
  if (seenUniverseIds.size !== roots.length) {
    throw new BackstageNotionWorkerReadinessError(
      'sync-result-incomplete',
      'Backstage Notion readiness synchronization omitted a configured authority.'
    );
  }
}

/**
 * Prove every configured authority has an active snapshot built by the current
 * heading/index format before the worker can advertise ordinary readiness.
 */
export async function ensureBackstageNotionWorkerReadiness(
  dependencies: BackstageNotionWorkerReadinessDependencies = {}
): Promise<BackstageNotionWorkerReadinessEvidence> {
  throwIfReadinessAborted(dependencies.signal);
  const configuration = (dependencies.readConfiguration
    ?? readBackstageNotionAuthorityConfiguration)();
  if (configuration.status === 'absent') {
    return {
      configuredUniverses: 0,
      currentBeforeSync: 0,
      syncAttempted: false,
      activated: 0,
      unchanged: 0,
    };
  }
  if (configuration.status === 'invalid') {
    throw new BackstageNotionWorkerReadinessError(
      'configuration-invalid',
      'Backstage Notion authority configuration is invalid during worker readiness.'
    );
  }

  const repository = dependencies.repository ?? getBackstageNotionRagRepository();
  const currentBeforeSync = await countCurrentBackstageNotionInventories(
    configuration.roots,
    repository,
    dependencies.signal
  );
  if (currentBeforeSync === configuration.roots.length) {
    return {
      configuredUniverses: configuration.roots.length,
      currentBeforeSync,
      syncAttempted: false,
      activated: 0,
      unchanged: 0,
    };
  }

  throwIfReadinessAborted(dependencies.signal);
  const sync = dependencies.sync ?? syncConfiguredBackstageNotionAuthorities;
  const results = await sync({
    ...(dependencies.signal ? { signal: dependencies.signal } : {}),
  });
  throwIfReadinessAborted(dependencies.signal);
  validateReadinessSyncResults(configuration.roots, results);

  const currentAfterSync = await countCurrentBackstageNotionInventories(
    configuration.roots,
    repository,
    dependencies.signal
  );
  if (currentAfterSync !== configuration.roots.length) {
    throw new BackstageNotionWorkerReadinessError(
      'index-not-current',
      'Backstage Notion active snapshots are not current after readiness synchronization.'
    );
  }

  return {
    configuredUniverses: configuration.roots.length,
    currentBeforeSync,
    syncAttempted: true,
    activated: results.filter(result => result.status === 'activated').length,
    unchanged: results.filter(result => result.status === 'unchanged').length,
  };
}

export function resolveBackstageNotionSyncIntervalMs(value: number | undefined): number {
  const candidate = value ?? getEnvNumber(
    BACKSTAGE_NOTION_SYNC_INTERVAL_ENV_NAME,
    BACKSTAGE_NOTION_SYNC_INTERVAL_DEFAULT_MS
  );
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return BACKSTAGE_NOTION_SYNC_INTERVAL_DEFAULT_MS;
  }
  return Math.max(
    BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS,
    Math.min(BACKSTAGE_NOTION_SYNC_INTERVAL_MAX_MS, Math.trunc(candidate))
  );
}

/** Start one non-overlapping, worker-owned Notion synchronization loop. */
export function startBackstageNotionSyncLoop(
  dependencies: BackstageNotionSyncLoopDependencies = {}
): BackstageNotionSyncLoopHandle {
  const intervalMs = resolveBackstageNotionSyncIntervalMs(dependencies.intervalMs);
  const sync = dependencies.sync ?? syncConfiguredBackstageNotionAuthorities;
  const loopLogger = dependencies.logger ?? logger;
  const loopAbortController = new AbortController();
  let stopped = false;
  let running = false;
  let timeoutHandle: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let drainPromise: Promise<void> | null = null;

  const schedule = (delayMs: number): void => {
    if (stopped || loopAbortController.signal.aborted) {
      return;
    }
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      const cycle = runOnce();
      inFlight = cycle;
      void cycle.finally(() => {
        if (inFlight === cycle) {
          inFlight = null;
        }
      });
    }, delayMs);
    timeoutHandle.unref?.();
  };

  const runOnce = async (): Promise<void> => {
    if (stopped || loopAbortController.signal.aborted) {
      return;
    }
    if (running) {
      loopLogger.warn('backstage.notion_rag.sync_overlap_skipped', {
        module: 'backstage-notion-sync',
      });
      schedule(intervalMs);
      return;
    }
    running = true;
    const startedAt = Date.now();
    try {
      const synchronize = (): Promise<readonly BackstageNotionSyncResult[]> => {
        if (loopAbortController.signal.aborted) {
          throw loopAbortController.signal.reason
            ?? new DOMException('The operation was aborted.', 'AbortError');
        }
        return sync({ signal: loopAbortController.signal });
      };
      const results = dependencies.coordinator
        ? await dependencies.coordinator.runExclusive(synchronize)
        : await synchronize();
      if (loopAbortController.signal.aborted) {
        throw loopAbortController.signal.reason
          ?? new DOMException('The operation was aborted.', 'AbortError');
      }
      const failed = results.filter(result => result.status === 'failed').length;
      const metadata = {
        module: 'backstage-notion-sync',
        configuredUniverses: results.length,
        activated: results.filter(result => result.status === 'activated').length,
        unchanged: results.filter(result => result.status === 'unchanged').length,
        leaseBusy: results.filter(result => result.status === 'lease-busy').length,
        failed,
        durationMs: Date.now() - startedAt,
      };
      if (failed > 0) {
        loopLogger.warn(
          'backstage.notion_rag.sync_cycle_completed_with_failures',
          metadata
        );
      } else {
        loopLogger.info('backstage.notion_rag.sync_cycle_completed', metadata);
      }
    } catch (error) {
      if (!loopAbortController.signal.aborted) {
        loopLogger.warn(
          'backstage.notion_rag.sync_cycle_failed',
          {
            module: 'backstage-notion-sync',
            durationMs: Date.now() - startedAt,
          },
          { errorMessage: resolveErrorMessage(error) },
          error instanceof Error ? error : undefined
        );
      }
    } finally {
      running = false;
      schedule(intervalMs);
    }
  };

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    loopAbortController.abort(dependencies.signal?.reason);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    dependencies.signal?.removeEventListener('abort', stop);
  };
  const stopAndDrain = (): Promise<void> => {
    if (drainPromise) {
      return drainPromise;
    }
    stop();
    const activeCycle = inFlight;
    drainPromise = (async () => {
      await activeCycle;
    })();
    return drainPromise;
  };
  if (dependencies.signal?.aborted) {
    stop();
  } else {
    dependencies.signal?.addEventListener('abort', stop, { once: true });
  }
  schedule(0);

  return { stop, stopAndDrain };
}

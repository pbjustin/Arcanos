import { logger } from '@platform/logging/structuredLogging.js';
import { getEnvNumber } from '@platform/runtime/env.js';
import {
  syncConfiguredBackstageNotionAuthorities,
  type BackstageNotionSyncResult,
} from '@services/backstageNotionSync.js';
import {
  createAiExecutionContext,
  runWithAiExecutionContext,
  type AiExecutionContext,
  type WorkerAiCallBudget,
} from '@services/openai/aiExecutionContext.js';
import {
  classifyWorkerAiBudgetError,
  normalizeWorkerAiBudgetError,
} from '@core/adapters/openai.adapter.js';

export const BACKSTAGE_NOTION_SYNC_INTERVAL_ENV_NAME =
  'ARCANOS_BACKSTAGE_NOTION_SYNC_INTERVAL_MS';
export const BACKSTAGE_NOTION_SYNC_INTERVAL_DEFAULT_MS = 15 * 60 * 1_000;
export const BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS = 60 * 1_000;
export const BACKSTAGE_NOTION_SYNC_INTERVAL_MAX_MS = 24 * 60 * 60 * 1_000;

export interface BackstageNotionSyncLoopHandle {
  stop(): void;
  stopAndDrain(): Promise<void>;
}

export interface BackstageNotionSynchronizationCoordinator {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

function rethrowRecordedWorkerBudgetFailure(context: AiExecutionContext): void {
  if (context.workerBudgetFailure === null) {
    return;
  }
  const normalized = normalizeWorkerAiBudgetError(context.workerBudgetFailure);
  if (classifyWorkerAiBudgetError(normalized)) {
    throw normalized;
  }
}

export interface BackstageNotionSyncLoopDependencies {
  signal?: AbortSignal;
  workerBudget?: WorkerAiCallBudget;
  intervalMs?: number;
  sync?: typeof syncConfiguredBackstageNotionAuthorities;
  logger?: Pick<typeof logger, 'info' | 'warn'>;
  coordinator?: BackstageNotionSynchronizationCoordinator;
  reportBootstrapLifecycle?: boolean;
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
  let bootstrapCyclePending = dependencies.reportBootstrapLifecycle === true;

  const log = (
    level: 'info' | 'warn',
    event: string,
    metadata: Readonly<Record<string, unknown>>
  ): void => {
    try {
      loopLogger[level](event, metadata);
    } catch {
      // Lifecycle telemetry must never change synchronization or readiness.
    }
  };

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
    const bootstrapCycle = bootstrapCyclePending;
    bootstrapCyclePending = false;
    const startedAt = Date.now();
    if (bootstrapCycle) {
      log('info', 'backstage.notion_sync.bootstrap_started', {
        module: 'backstage-notion-sync',
        syncInProgress: true,
      });
    }
    try {
      const synchronize = (): Promise<readonly BackstageNotionSyncResult[]> => {
        if (loopAbortController.signal.aborted) {
          throw loopAbortController.signal.reason
            ?? new DOMException('The operation was aborted.', 'AbortError');
        }
        return sync({ signal: loopAbortController.signal });
      };
      const runSynchronized = (): Promise<readonly BackstageNotionSyncResult[]> => (
        dependencies.coordinator
          ? dependencies.coordinator.runExclusive(synchronize)
          : synchronize()
      );
      let syncContext: AiExecutionContext | null = null;
      const results = dependencies.workerBudget
        ? await runWithAiExecutionContext(syncContext = createAiExecutionContext({
            sourceType: 'background',
            sourceName: 'backstage-notion-sync-loop',
            workerBudget: dependencies.workerBudget,
          }), runSynchronized)
        : await runSynchronized();
      if (syncContext) {
        rethrowRecordedWorkerBudgetFailure(syncContext);
      }
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
        log(
          'warn',
          'backstage.notion_rag.sync_cycle_completed_with_failures',
          metadata
        );
      } else {
        log('info', 'backstage.notion_rag.sync_cycle_completed', metadata);
      }
      if (bootstrapCycle) {
        if (failed > 0) {
          log('warn', 'backstage.notion_sync.bootstrap_failed', {
            ...metadata,
            syncInProgress: false,
            syncOutcome: 'failed',
          });
        } else if (metadata.leaseBusy > 0) {
          log('info', 'backstage.notion_sync.bootstrap_lease_busy', {
            ...metadata,
            syncInProgress: false,
            syncOutcome: 'lease_busy',
          });
        } else {
          log('info', 'backstage.notion_sync.bootstrap_completed', {
            ...metadata,
            syncInProgress: false,
            syncOutcome: metadata.activated > 0 ? 'activated' : 'unchanged',
          });
        }
      }
    } catch {
      if (!loopAbortController.signal.aborted) {
        const metadata = {
          module: 'backstage-notion-sync',
          durationMs: Date.now() - startedAt,
        };
        log(
          'warn',
          'backstage.notion_rag.sync_cycle_failed',
          metadata
        );
        if (bootstrapCycle) {
          log('warn', 'backstage.notion_sync.bootstrap_failed', {
            ...metadata,
            syncInProgress: false,
            syncOutcome: 'failed',
          });
        }
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
  if (dependencies.reportBootstrapLifecycle) {
    log('info', 'backstage.notion_sync.bootstrap_scheduled', {
      module: 'backstage-notion-sync',
      processReady: false,
      syncInProgress: false,
    });
  }
  schedule(0);

  return { stop, stopAndDrain };
}

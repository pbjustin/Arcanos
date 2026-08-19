import { logger } from '@platform/logging/structuredLogging.js';
import { getEnvNumber } from '@platform/runtime/env.js';
import { resolveErrorMessage } from '@shared/errorUtils.js';
import { syncConfiguredBackstageNotionAuthorities } from '@services/backstageNotionSync.js';

export const BACKSTAGE_NOTION_SYNC_INTERVAL_ENV_NAME =
  'ARCANOS_BACKSTAGE_NOTION_SYNC_INTERVAL_MS';
export const BACKSTAGE_NOTION_SYNC_INTERVAL_DEFAULT_MS = 15 * 60 * 1_000;
export const BACKSTAGE_NOTION_SYNC_INTERVAL_MIN_MS = 60 * 1_000;
export const BACKSTAGE_NOTION_SYNC_INTERVAL_MAX_MS = 24 * 60 * 60 * 1_000;

export interface BackstageNotionSyncLoopHandle {
  stop(): void;
}

export interface BackstageNotionSyncLoopDependencies {
  signal?: AbortSignal;
  intervalMs?: number;
  sync?: typeof syncConfiguredBackstageNotionAuthorities;
  logger?: Pick<typeof logger, 'info' | 'warn'>;
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

  const schedule = (delayMs: number): void => {
    if (stopped || loopAbortController.signal.aborted) {
      return;
    }
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      void runOnce();
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
      const results = await sync({
        signal: loopAbortController.signal,
      });
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
  if (dependencies.signal?.aborted) {
    stop();
  } else {
    dependencies.signal?.addEventListener('abort', stop, { once: true });
  }
  schedule(0);

  return { stop };
}

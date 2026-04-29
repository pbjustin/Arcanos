import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import {
  buildJobRunnerSlotDefinitions,
  computeDeterministicIntervalJitterMs,
  createNonOverlappingTaskRunner,
  isEntrypointModule,
  isRetryableJobRunnerDatabaseBootstrapError,
  resolveJobRunnerEntrypointRuntimeMode,
  resolveJobRunnerDatabaseBootstrapSettings,
  resolveProviderPauseMs,
  resolveJobRunnerRuntimeSettings,
  selectJobRunnerSlotTransientRetryEvent
} from '../src/workers/jobRunnerRuntime.js';

describe('jobRunnerRuntime', () => {
  it('falls back to WORKER_COUNT when explicit job-worker concurrency is absent', () => {
    const runtimeSettings = resolveJobRunnerRuntimeSettings({
      WORKER_COUNT: '3',
      JOB_WORKER_ID: 'async-queue'
    } as NodeJS.ProcessEnv);

    expect(runtimeSettings.concurrency).toBe(3);
    expect(runtimeSettings.baseWorkerId).toBe('async-queue');
    expect(runtimeSettings.statsWorkerId).toBe('async-queue');
  });

  it('prefers explicit job-worker concurrency and generates distinct slot ids', () => {
    const runtimeSettings = resolveJobRunnerRuntimeSettings({
      JOB_WORKER_CONCURRENCY: '2',
      JOB_WORKER_ID: 'railway-worker',
      JOB_WORKER_STATS_ID: 'railway-worker',
      JOB_WORKER_POLL_MS: '500',
      JOB_WORKER_IDLE_BACKOFF_MS: '1500',
      WORKER_COUNT: '5'
    } as NodeJS.ProcessEnv);

    const slotDefinitions = buildJobRunnerSlotDefinitions(runtimeSettings);

    expect(runtimeSettings.concurrency).toBe(2);
    expect(runtimeSettings.pollMs).toBe(500);
    expect(runtimeSettings.idleBackoffMs).toBe(1500);
    expect(slotDefinitions.map(slot => slot.workerId)).toEqual([
      'railway-worker-slot-1',
      'railway-worker-slot-2'
    ]);
    expect(slotDefinitions[0]?.isInspectorSlot).toBe(true);
    expect(slotDefinitions[1]?.isInspectorSlot).toBe(false);
    expect(slotDefinitions.every(slot => slot.statsWorkerId === 'railway-worker')).toBe(true);
  });

  it('keeps the base worker id unchanged for a single-slot runtime', () => {
    const runtimeSettings = resolveJobRunnerRuntimeSettings({
      JOB_WORKER_CONCURRENCY: '1',
      JOB_WORKER_ID: 'async-queue'
    } as NodeJS.ProcessEnv);

    expect(buildJobRunnerSlotDefinitions(runtimeSettings)).toEqual([
      {
        slotIndex: 0,
        slotNumber: 1,
        workerId: 'async-queue',
        statsWorkerId: 'async-queue',
        isInspectorSlot: true
      }
    ]);
  });

  it('computes stable per-worker interval jitter inside the heartbeat interval', () => {
    const intervalMs = 30_000;
    const first = computeDeterministicIntervalJitterMs('async-queue-slot-1', intervalMs);
    const second = computeDeterministicIntervalJitterMs('async-queue-slot-1', intervalMs);
    const other = computeDeterministicIntervalJitterMs('async-queue-slot-2', intervalMs);

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(intervalMs);
    expect(other).toBeGreaterThanOrEqual(0);
    expect(other).toBeLessThan(intervalMs);
    expect(other).not.toBe(first);
  });

  it('detects direct job runner entrypoint execution without matching imports', () => {
    const jobRunnerPath = path.resolve('dist/workers/jobRunner.js');
    const moduleUrl = pathToFileURL(jobRunnerPath).href;

    expect(isEntrypointModule(moduleUrl, [process.execPath, jobRunnerPath])).toBe(true);
    expect(isEntrypointModule(moduleUrl, [process.execPath, path.resolve('dist/start-server.js')])).toBe(false);
    expect(isEntrypointModule(moduleUrl, [process.execPath])).toBe(false);
  });

  it('normalizes database bootstrap retry settings', () => {
    const retrySettings = resolveJobRunnerDatabaseBootstrapSettings({
      JOB_WORKER_DB_BOOTSTRAP_RETRY_MS: '2500',
      JOB_WORKER_DB_BOOTSTRAP_MAX_RETRY_MS: '12000',
      JOB_WORKER_DB_BOOTSTRAP_MAX_ATTEMPTS: '5'
    } as NodeJS.ProcessEnv);

    expect(retrySettings).toEqual({
      retryMs: 2500,
      maxRetryMs: 12000,
      maxAttempts: 5
    });
  });

  it('disables the direct job runner entrypoint for explicit web runtime mode', () => {
    const mode = resolveJobRunnerEntrypointRuntimeMode({
      resolvedRunWorkers: false,
      reason: 'process_kind_web'
    });

    expect(mode).toEqual({
      enabled: false,
      disabledReason: 'RUN_WORKERS disabled for explicit web process role; workers not started.',
      reason: 'RUN_WORKERS disabled for explicit web process role; workers not started.'
    });
  });

  it('disables the direct job runner entrypoint when RUN_WORKERS resolves false', () => {
    const mode = resolveJobRunnerEntrypointRuntimeMode({
      resolvedRunWorkers: false,
      reason: 'requested'
    });

    expect(mode).toEqual({
      enabled: false,
      disabledReason: 'RUN_WORKERS disabled; workers not started.',
      reason: 'RUN_WORKERS disabled; workers not started.'
    });
  });

  it('enables the direct job runner entrypoint when worker runtime resolves enabled', () => {
    const mode = resolveJobRunnerEntrypointRuntimeMode({
      resolvedRunWorkers: true,
      reason: 'process_kind_worker'
    });

    expect(mode).toEqual({
      enabled: true,
      disabledReason: null,
      reason: 'ARCANOS_PROCESS_KIND=worker starts the dedicated async queue dispatcher'
    });
  });

  it('uses indefinite database bootstrap retries by default', () => {
    const retrySettings = resolveJobRunnerDatabaseBootstrapSettings({} as NodeJS.ProcessEnv);

    expect(retrySettings).toEqual({
      retryMs: 5000,
      maxRetryMs: 30000,
      maxAttempts: null
    });
  });

  it('defers provider-unavailable jobs until the provider retry window instead of idle backoff', () => {
    const nowMs = Date.parse('2026-04-28T20:00:00.000Z');

    expect(
      resolveProviderPauseMs('2026-04-28T20:01:00.000Z', 1_000, nowMs)
    ).toBe(60_000);
    expect(
      resolveProviderPauseMs('2026-04-28T20:00:00.500Z', 1_000, nowMs)
    ).toBe(1_000);
  });

  it('falls back to a positive provider pause when retry timestamps are absent or stale', () => {
    const nowMs = Date.parse('2026-04-28T20:00:00.000Z');

    expect(resolveProviderPauseMs(null, 250, nowMs)).toBe(1_000);
    expect(resolveProviderPauseMs('2026-04-28T19:59:59.000Z', 2_500, nowMs)).toBe(2_500);
    expect(resolveProviderPauseMs('not-a-date', Number.NaN, nowMs)).toBe(1_000);
  });

  it('classifies transient database bootstrap reachability errors as retryable', () => {
    expect(
      isRetryableJobRunnerDatabaseBootstrapError(
        new Error('timeout exceeded when trying to connect')
      )
    ).toBe(true);
    expect(isRetryableJobRunnerDatabaseBootstrapError(new Error('ENOTFOUND railway.internal'))).toBe(true);
    expect(isRetryableJobRunnerDatabaseBootstrapError(new Error('relation "job_data" does not exist'))).toBe(false);
  });

  it('keeps database context on outer slot transient retry logs', () => {
    expect(
      selectJobRunnerSlotTransientRetryEvent(
        new Error('Postgres pool connection timeout while claiming from job_data')
      )
    ).toBe('worker.database.transient_error_retry');
  });

  it('uses a generic outer slot retry log for non-database provider/network transients', () => {
    expect(
      selectJobRunnerSlotTransientRetryEvent(
        new Error('OpenAI provider request ETIMEDOUT')
      )
    ).toBe('worker.transient_error_retry');
    expect(
      selectJobRunnerSlotTransientRetryEvent(
        new Error('socket connect timeout while probing provider')
      )
    ).toBe('worker.transient_error_retry');
  });

  it('does not infer database context from broad worker runtime labels', () => {
    expect(
      selectJobRunnerSlotTransientRetryEvent(
        new Error('worker_runtime slot failed during provider connect timeout')
      )
    ).toBe('worker.transient_error_retry');
  });

  it('skips overlapping interval work while a task is still running', async () => {
    let nowMs = 0;
    let resolveFirstTask: (() => void) | null = null;
    let executedTasks = 0;
    const skipEvents: Array<{
      taskName: string;
      skippedCount: number;
      runningForMs: number | null;
    }> = [];
    const runner = createNonOverlappingTaskRunner(
      () => new Promise<void>((resolve) => {
        executedTasks += 1;
        resolveFirstTask = resolve;
      }),
      {
        taskName: 'worker-heartbeat',
        skipLogMinIntervalMs: 1,
        nowMs: () => nowMs,
        onSkip: (event) => skipEvents.push(event)
      }
    );

    const firstRun = runner();

    expect(runner.isRunning()).toBe(true);
    nowMs = 10;
    await expect(runner()).resolves.toBe(false);
    expect(skipEvents).toEqual([
      {
        taskName: 'worker-heartbeat',
        skippedCount: 1,
        runningForMs: 10
      }
    ]);

    resolveFirstTask?.();
    await expect(firstRun).resolves.toBe(true);
    expect(runner.isRunning()).toBe(false);

    const secondRun = runner();
    nowMs = 20;
    await expect(runner()).resolves.toBe(false);
    expect(skipEvents).toEqual([
      {
        taskName: 'worker-heartbeat',
        skippedCount: 1,
        runningForMs: 10
      },
      {
        taskName: 'worker-heartbeat',
        skippedCount: 1,
        runningForMs: 10
      }
    ]);
    resolveFirstTask?.();
    await expect(secondRun).resolves.toBe(true);
    expect(executedTasks).toBe(2);
  });

  it('unlocks after a task failure', async () => {
    let shouldFail = true;
    const runner = createNonOverlappingTaskRunner(
      async () => {
        if (shouldFail) {
          throw new Error('heartbeat failed');
        }
      },
      { taskName: 'worker-heartbeat' }
    );

    await expect(runner()).rejects.toThrow('heartbeat failed');
    expect(runner.isRunning()).toBe(false);
    shouldFail = false;
    await expect(runner()).resolves.toBe(true);
  });

  it('guards bootstrap retry sleeps with shutdown checks', () => {
    const source = fs.readFileSync(path.resolve('src/workers/jobRunner.ts'), 'utf8');

    expect(source).toContain('worker.shutdown.before_autonomy_bootstrap');
    expect(source).toContain("logWorkerShutdownDuringBootstrap(workerId, 'database_exception_retry')");
    expect(source).toContain("logWorkerShutdownDuringBootstrap(workerId, 'database_status_retry')");
    expect(source).toContain("logWorkerShutdownDuringBootstrap(autonomyService.getWorkerId(), 'autonomy_retry')");
  });

  it('caps delayed worker interval work at one active task per slot and source', async () => {
    const slots = buildJobRunnerSlotDefinitions(resolveJobRunnerRuntimeSettings({
      JOB_WORKER_CONCURRENCY: '8',
      JOB_WORKER_ID: 'async-queue'
    } as NodeJS.ProcessEnv));
    const taskNames = [
      ...slots.map(slot => `${slot.workerId}:worker-heartbeat`),
      'async-queue-slot-1:watchdog',
      'async-queue-slot-1:inspector'
    ];
    let activeTasks = 0;
    let maxActiveTasks = 0;
    let executedTasks = 0;
    let skippedRuns = 0;
    let skipLogEvents = 0;
    const completeTasks: Array<() => void> = [];

    const runners = taskNames.map(taskName => createNonOverlappingTaskRunner(
      () => new Promise<void>((resolve) => {
        executedTasks += 1;
        activeTasks += 1;
        maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
        completeTasks.push(() => {
          activeTasks -= 1;
          resolve();
        });
      }),
      {
        taskName,
        skipLogMinIntervalMs: 1,
        onSkip: () => {
          skipLogEvents += 1;
        }
      }
    ));

    const initialRuns = runners.map(runner => runner());
    for (let tick = 0; tick < 5; tick += 1) {
      const results = await Promise.all(runners.map(runner => runner()));
      skippedRuns += results.filter(result => result === false).length;
    }

    expect(executedTasks).toBe(10);
    expect(maxActiveTasks).toBe(10);
    expect(skippedRuns).toBe(50);
    expect(skipLogEvents).toBe(10);

    completeTasks.splice(0).forEach(completeTask => completeTask());
    await expect(Promise.all(initialRuns)).resolves.toEqual(Array(10).fill(true));
  });
});

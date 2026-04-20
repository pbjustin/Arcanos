import { describe, expect, it } from '@jest/globals';

import {
  buildJobRunnerSlotDefinitions,
  isRetryableJobRunnerDatabaseBootstrapError,
  resolveJobRunnerDatabaseBootstrapSettings,
  resolveJobRunnerRuntimeSettings
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

  it('uses indefinite database bootstrap retries by default', () => {
    const retrySettings = resolveJobRunnerDatabaseBootstrapSettings({} as NodeJS.ProcessEnv);

    expect(retrySettings).toEqual({
      retryMs: 5000,
      maxRetryMs: 30000,
      maxAttempts: null
    });
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
});

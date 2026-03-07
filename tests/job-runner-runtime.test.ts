import { describe, expect, it } from '@jest/globals';

import {
  buildJobRunnerSlotDefinitions,
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
});

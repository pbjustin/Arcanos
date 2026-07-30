import { describe, expect, it } from '@jest/globals';

import { projectPublicWorkerHealth } from '../src/shared/http/workerHealthProjection.js';

const JOB_UUID_SENTINEL = '123e4567-e89b-42d3-a456-426614174000';
const PROMPT_SENTINEL = 'PUBLIC_WORKER_PROMPT_SENTINEL';
const RESULT_SENTINEL = 'PUBLIC_WORKER_RESULT_SENTINEL';
const ERROR_SENTINEL = 'PUBLIC_WORKER_ERROR_SENTINEL';
const ABSOLUTE_PATH_SENTINEL =
  'C:\\private\\arcanos\\PUBLIC_WORKERS_DIRECTORY_SENTINEL';

function collectObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectObjectKeys);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  return Object.entries(value).flatMap(([key, nestedValue]) => [
    key,
    ...collectObjectKeys(nestedValue),
  ]);
}

describe('public worker health projection', () => {
  it('reconstructs only normalized states, aggregate counts, and timestamps', () => {
    const poisonedInput = {
      timestamp: '2026-07-29T12:00:00.000Z',
      status: 'HEALTHY',
      runtime: {
        status: 'ACTIVE',
        totalDispatched: 11,
        startedAt: '2026-07-29T11:00:00.000Z',
        lastDispatchAt: '2026-07-29T11:59:00.000Z',
        workerIds: [JOB_UUID_SENTINEL],
        lastInputPreview: PROMPT_SENTINEL,
        lastResult: { output: RESULT_SENTINEL },
        lastError: ERROR_SENTINEL,
      },
      workers: {
        status: 'DEGRADED',
        total: 8,
        available: 7,
        configured: 4,
        active: 3,
        observed: 2,
        stale: 1,
        degraded: 1,
        unhealthy: 0,
        lastHeartbeatAt: '2026-07-29T11:58:00.000Z',
        activeJobs: [JOB_UUID_SENTINEL],
        currentJobId: JOB_UUID_SENTINEL,
        lastError: ERROR_SENTINEL,
      },
      queue: {
        status: 'STALLED',
        total: 16,
        pending: 2,
        running: 1,
        completed: 10,
        retainedFailed: 3,
        delayed: 1,
        stalledRunning: 1,
        lastUpdatedAt: '2026-07-29T11:57:00.000Z',
        latestJob: {
          id: JOB_UUID_SENTINEL,
          input: PROMPT_SENTINEL,
          output: RESULT_SENTINEL,
          error: ERROR_SENTINEL,
        },
        recentFailedJobs: [{
          id: JOB_UUID_SENTINEL,
          error: ERROR_SENTINEL,
        }],
      },
      memory: {
        status: 'ACTIVE',
        routes: 5,
        lastUpdatedAt: '2026-07-29T11:56:00.000Z',
        lastResult: RESULT_SENTINEL,
      },
      workersDirectory: ABSOLUTE_PATH_SENTINEL,
      latestJob: { id: JOB_UUID_SENTINEL },
      recentFailedJobs: [{ id: JOB_UUID_SENTINEL }],
      activeJobs: [JOB_UUID_SENTINEL],
      currentJobId: JOB_UUID_SENTINEL,
      lastError: ERROR_SENTINEL,
      workerIds: [JOB_UUID_SENTINEL],
      lastInputPreview: PROMPT_SENTINEL,
      lastResult: RESULT_SENTINEL,
    } as unknown as Parameters<typeof projectPublicWorkerHealth>[0];
    const payload = projectPublicWorkerHealth(poisonedInput);

    expect(payload).toEqual({
      status: 'healthy',
      overallStatus: 'healthy',
      totalWorkers: 8,
      availableWorkers: 7,
      runtime: {
        status: 'active',
        totalDispatched: 11,
        startedAt: '2026-07-29T11:00:00.000Z',
        lastDispatchAt: '2026-07-29T11:59:00.000Z',
      },
      workers: {
        status: 'degraded',
        total: 8,
        available: 7,
        configured: 4,
        active: 3,
        observed: 2,
        stale: 1,
        degraded: 1,
        unhealthy: 0,
        lastHeartbeatAt: '2026-07-29T11:58:00.000Z',
      },
      queue: {
        status: 'stalled',
        total: 16,
        pending: 2,
        running: 1,
        completed: 10,
        retainedFailed: 3,
        delayed: 1,
        stalledRunning: 1,
        lastUpdatedAt: '2026-07-29T11:57:00.000Z',
      },
      memory: {
        status: 'active',
        routes: 5,
        lastUpdatedAt: '2026-07-29T11:56:00.000Z',
      },
      timestamp: '2026-07-29T12:00:00.000Z',
    });

    const serialized = JSON.stringify(payload);
    for (const sentinel of [
      JOB_UUID_SENTINEL,
      PROMPT_SENTINEL,
      RESULT_SENTINEL,
      ERROR_SENTINEL,
      'PUBLIC_WORKERS_DIRECTORY_SENTINEL',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(collectObjectKeys(payload)).toEqual(
      expect.not.arrayContaining([
        'latestJob',
        'recentFailedJobs',
        'activeJobs',
        'currentJobId',
        'lastError',
        'workerIds',
        'lastInputPreview',
        'lastResult',
        'workersDirectory',
      ])
    );
  });

  it('normalizes invalid aggregate values without synthesizing timestamps', () => {
    expect(projectPublicWorkerHealth({
      timestamp: 'not-a-timestamp',
      status: ERROR_SENTINEL,
      runtime: {
        status: ERROR_SENTINEL,
        totalDispatched: -1,
      },
      workers: {
        status: ERROR_SENTINEL,
        total: Number.POSITIVE_INFINITY,
      },
      queue: {
        status: ERROR_SENTINEL,
      },
      memory: {
        status: ERROR_SENTINEL,
      },
    })).toEqual({
      status: 'unknown',
      overallStatus: 'unknown',
      totalWorkers: null,
      availableWorkers: null,
      runtime: {
        status: 'unknown',
        totalDispatched: null,
        startedAt: null,
        lastDispatchAt: null,
      },
      workers: {
        status: 'unknown',
        total: null,
        available: null,
        configured: null,
        active: null,
        observed: null,
        stale: null,
        degraded: null,
        unhealthy: null,
        lastHeartbeatAt: null,
      },
      queue: {
        status: 'unavailable',
        total: null,
        pending: null,
        running: null,
        completed: null,
        retainedFailed: null,
        delayed: null,
        stalledRunning: null,
        lastUpdatedAt: null,
      },
      memory: {
        status: 'unknown',
        routes: null,
        lastUpdatedAt: null,
      },
      timestamp: null,
    });
  });
});

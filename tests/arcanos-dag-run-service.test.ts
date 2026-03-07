import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  ArcanosDagRunService,
  type DagRunWaitResult
} from '../src/services/arcanosDagRunService.js';

function buildStoredRunRecord(updatedAt: string) {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    template: 'verification-default',
    plannerNodeId: 'planner',
    rootNodeId: 'writer',
    status: 'running',
    createdAt: '2026-03-07T00:00:00.000Z',
    updatedAt,
    summary: {
      runId: 'run-1',
      sessionId: 'session-1',
      template: 'verification-default',
      status: 'running',
      plannerNodeId: 'planner',
      rootNodeId: 'writer',
      createdAt: '2026-03-07T00:00:00.000Z',
      updatedAt
    },
    nodesById: new Map(),
    events: [],
    errors: [],
    guardViolations: [],
    metrics: {
      totalNodes: 0,
      maxParallelNodesObserved: 0,
      maxSpawnDepthObserved: 0,
      totalRetries: 0,
      totalFailures: 0,
      totalAiCalls: 0,
      estimatedCostUsd: 0,
      wallClockDurationMs: 0,
      sumNodeDurationMs: 0,
      queueWaitMsP50: 0,
      queueWaitMsP95: 0
    },
    verification: {
      runCompleted: false,
      plannerSpawnedChildren: false,
      parallelExecutionObserved: false,
      aggregationRanLast: false,
      retryPolicyRespected: true,
      budgetPolicyRespected: true,
      deadlockDetected: false,
      stalledJobsDetected: false,
      loopDetected: false
    },
    limits: {
      maxConcurrency: 5,
      maxSpawnDepth: 3,
      maxChildrenPerNode: 5,
      maxRetriesPerNode: 2,
      maxAiCallsPerRun: 20,
      defaultNodeTimeoutMs: 60000
    },
    features: {
      dagOrchestration: true,
      parallelExecution: true,
      recursiveSpawning: false,
      jobTreeInspection: true,
      eventStreaming: false
    },
    loopDetected: false
  } as any;
}

describe('ArcanosDagRunService.waitForRunUpdate', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('returns immediately when the run is already newer than the caller cursor', async () => {
    const service = new ArcanosDagRunService();
    const record = buildStoredRunRecord('2026-03-07T00:00:05.000Z');

    (service as any).runsById.set('run-1', record);

    const result = await service.waitForRunUpdate('run-1', {
      updatedAfter: '2026-03-07T00:00:01.000Z',
      waitForUpdateMs: 5000
    });

    expect(result).toEqual({
      run: expect.objectContaining({
        runId: 'run-1',
        updatedAt: '2026-03-07T00:00:05.000Z'
      }),
      updated: true,
      waited: false
    });
  });

  it('resolves waiting callers when the run summary advances', async () => {
    const service = new ArcanosDagRunService();
    const record = buildStoredRunRecord('2026-03-07T00:00:01.000Z');

    (service as any).runsById.set('run-1', record);

    const waitPromise = service.waitForRunUpdate('run-1', {
      updatedAfter: '2026-03-07T00:00:01.000Z',
      waitForUpdateMs: 5000
    }) as Promise<DagRunWaitResult | null>;

    record.updatedAt = '2026-03-07T00:00:03.000Z';
    record.summary = {
      ...record.summary,
      updatedAt: '2026-03-07T00:00:03.000Z',
      status: 'complete'
    };
    record.status = 'complete';

    await jest.advanceTimersByTimeAsync(250);

    await expect(waitPromise).resolves.toEqual({
      run: expect.objectContaining({
        updatedAt: '2026-03-07T00:00:03.000Z',
        status: 'complete'
      }),
      updated: true,
      waited: true
    });
  });

  it('returns the latest summary when the wait window expires without a change', async () => {
    const service = new ArcanosDagRunService();
    const record = buildStoredRunRecord('2026-03-07T00:00:01.000Z');

    (service as any).runsById.set('run-1', record);

    const waitPromise = service.waitForRunUpdate('run-1', {
      updatedAfter: '2026-03-07T00:00:01.000Z',
      waitForUpdateMs: 5000
    }) as Promise<DagRunWaitResult | null>;

    await jest.advanceTimersByTimeAsync(5000);

    await expect(waitPromise).resolves.toEqual({
      run: expect.objectContaining({
        updatedAt: '2026-03-07T00:00:01.000Z'
      }),
      updated: false,
      waited: true
    });
  });
});

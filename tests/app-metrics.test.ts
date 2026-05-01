import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const getWorkerControlHealthMock = jest.fn();

jest.unstable_mockModule('@services/workerControlService.js', () => ({
  getWorkerControlHealth: getWorkerControlHealthMock
}));

async function loadMetricsModule() {
  jest.resetModules();
  jest.clearAllMocks();
  const metricsModule = await import('../src/platform/observability/appMetrics.js');
  metricsModule.resetAppMetricsForTests();
  return metricsModule;
}

describe('app metrics registry', () => {
  beforeEach(() => {
    delete process.env.METRICS_AUTH_TOKEN;
    process.env.METRICS_ENABLED = 'true';
    process.env.METRICS_INCLUDE_WORKER_STATE = 'false';
    getWorkerControlHealthMock.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('emits dispatcher, DAG, dependency, and worker metrics with bounded labels', async () => {
    const {
      metricsRegistry,
      recordDagRunRequest,
    recordDagRunStatus,
    recordDependencyCall,
    recordDispatcherFallback,
    recordDispatcherRoute,
    recordMemoryDispatchIgnored,
    recordUnknownGpt,
    recordWorkerFailureTotal,
    recordWorkerJobDuration,
      recordWorkerJobTotal,
      recordWorkerQueueLatency,
      recordWorkerQueueDepth,
      recordWorkerRetryTotal,
    } = await loadMetricsModule();

    recordDispatcherRoute({
      gptId: 'arcanos-core',
      module: 'ARCANOS:CORE',
      route: 'core',
      handler: 'module-dispatcher',
      outcome: 'ok',
    });
    recordDispatcherFallback({
      gptId: 'arcanos-core',
      module: 'ARCANOS:CORE',
      reason: 'memory_ignored_retry_dag',
    });
    recordMemoryDispatchIgnored({
      gptId: 'arcanos-core',
      module: 'ARCANOS:CORE',
      reason: 'memory_ignored_retry_dag',
    });
    recordUnknownGpt({
      gptId: 'missing-core',
      outcome: 'not_registered',
    });

    recordDagRunRequest({
      handler: 'trace',
      outcome: 'ok',
      snapshotSource: 'persisted',
      durationMs: 125,
      lookupDurationsMs: {
        local: 3,
        persisted: 18,
        total: 125,
      },
      nodesReturned: 7,
      buildDurationsMs: {
        nodes: 12,
        events: 40,
        metrics: 6,
        verification: 4,
      },
    });
    recordDagRunStatus('complete');

    recordDependencyCall({
      dependency: 'postgres',
      operation: 'select',
      outcome: 'ok',
      durationMs: 14,
    });
    recordDependencyCall({
      dependency: 'postgres',
      operation: 'select',
      outcome: 'error',
      error: new Error('statement timeout'),
    });

    recordWorkerJobDuration({
      jobType: 'dag-node',
      outcome: 'completed',
      durationMs: 220,
    });
    recordWorkerJobTotal('processed', 5);
    recordWorkerQueueDepth('pending', 3);
    recordWorkerQueueLatency('oldest_pending', 1250);
    recordWorkerFailureTotal('terminal', 1);
    recordWorkerRetryTotal('scheduled', 2);

    const metricsText = await metricsRegistry.metrics();

    expect(metricsText).toMatch(/dispatcher_route_total\{[^}]*gpt_id="arcanos-core"[^}]*handler="module-dispatcher"[^}]*outcome="ok"[^}]*\} 1/);
    expect(metricsText).toMatch(/unknown_gpt_total\{[^}]*gpt_id="missing-core"[^}]*outcome="not_registered"[^}]*\} 1/);
    expect(metricsText).toMatch(/dag_run_requests_total\{[^}]*handler="trace"[^}]*outcome="ok"[^}]*snapshot_source="persisted"[^}]*\} 1/);
    expect(metricsText).toMatch(/dag_node_fetch_duration_ms_bucket\{[^}]*handler="trace"[^}]*snapshot_source="persisted"[^}]*\} \d+/);
    expect(metricsText).toMatch(/dependency_calls_total\{[^}]*dependency="postgres"[^}]*operation="select"[^}]*outcome="ok"[^}]*\} 1/);
    expect(metricsText).toMatch(/dependency_timeouts_total\{[^}]*dependency="postgres"[^}]*operation="select"[^}]*\} 1/);
    expect(metricsText).toMatch(/worker_job_duration_ms_bucket\{[^}]*job_type="dag-node"[^}]*outcome="completed"[^}]*\} \d+/);
    expect(metricsText).toMatch(/worker_queue_depth\{[^}]*state="pending"[^}]*\} 3/);
    expect(metricsText).toMatch(/worker_queue_latency_ms\{[^}]*scope="oldest_pending"[^}]*\} 1250/);
    expect(metricsText).toContain('process_heap_used_bytes');
    expect(metricsText).toContain('event_loop_lag_ms');
  });

  it('reconstructs worker watchdog counters from persisted snapshots without double counting', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-12T01:05:00.000Z'));
    process.env.METRICS_INCLUDE_WORKER_STATE = 'true';

    const healthResponses = [
      {
        queueSummary: {
          pending: 1,
          running: 1,
          delayed: 0,
          failed: 4,
          completed: 8,
          stalledRunning: 0,
          oldestPendingJobAgeMs: 1200
        },
        operationalHealth: {
          overallStatus: 'healthy',
          recentFailed: 0,
          workerHeartbeatAgeMs: 2500
        },
        historicalDebt: {
          retryExhaustedJobs: 1,
          deadLetterJobs: 1
        },
        workers: [
          {
            workerId: 'async-queue-slot-1',
            processedJobs: 12,
            scheduledRetries: 2,
            terminalFailures: 1,
            staleWorkersDetected: 2,
            stalledJobsDetected: 3,
            recoveredJobs: 2,
            deadLetterJobs: 1,
            recoveryActions: 3
          }
        ]
      },
      {
        queueSummary: {
          pending: 0,
          running: 1,
          delayed: 0,
          failed: 4,
          completed: 9,
          stalledRunning: 0,
          oldestPendingJobAgeMs: 600
        },
        operationalHealth: {
          overallStatus: 'healthy',
          recentFailed: 0,
          workerHeartbeatAgeMs: 1800
        },
        historicalDebt: {
          retryExhaustedJobs: 1,
          deadLetterJobs: 1
        },
        workers: [
          {
            workerId: 'async-queue-slot-1',
            processedJobs: 13,
            scheduledRetries: 2,
            terminalFailures: 1,
            staleWorkersDetected: 3,
            stalledJobsDetected: 4,
            recoveredJobs: 3,
            deadLetterJobs: 1,
            recoveryActions: 4
          }
        ]
      },
      {
        queueSummary: {
          pending: 0,
          running: 1,
          delayed: 0,
          failed: 4,
          completed: 10,
          stalledRunning: 0,
          oldestPendingJobAgeMs: 500
        },
        operationalHealth: {
          overallStatus: 'healthy',
          recentFailed: 0,
          workerHeartbeatAgeMs: 900
        },
        historicalDebt: {
          retryExhaustedJobs: 1,
          deadLetterJobs: 1
        },
        workers: [
          {
            workerId: 'async-queue-slot-1',
            processedJobs: 14,
            scheduledRetries: 2,
            terminalFailures: 1,
            staleWorkersDetected: 0,
            stalledJobsDetected: 1,
            recoveredJobs: 1,
            deadLetterJobs: 0,
            recoveryActions: 1
          }
        ]
      }
    ];

    getWorkerControlHealthMock
      .mockResolvedValueOnce(healthResponses[0] as any)
      .mockResolvedValueOnce(healthResponses[1] as any)
      .mockResolvedValueOnce(healthResponses[2] as any);

    const { getMetricsText } = await loadMetricsModule();

    let metricsText = await getMetricsText();
    expect(metricsText).not.toMatch(/worker_stale_total\{[^}]*reason="persisted_snapshot"/);
    expect(metricsText).not.toMatch(/worker_stalled_jobs_total\{[^}]*action="requeue"/);
    expect(metricsText).not.toMatch(/worker_stalled_jobs_total\{[^}]*action="dead_letter"/);
    expect(metricsText).not.toMatch(/worker_recovered_jobs_total\{[^}]*action="requeue"/);
    expect(metricsText).not.toMatch(/worker_recovered_jobs_total\{[^}]*action="dead_letter"/);
    expect(metricsText).not.toMatch(/worker_recovery_actions_total\{[^}]*action="persisted_snapshot"[^}]*source="worker_health"/);

    metricsText = await getMetricsText();
    expect(metricsText).not.toMatch(/worker_stale_total\{[^}]*reason="persisted_snapshot"/);
    expect(getWorkerControlHealthMock).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(6_000);
    metricsText = await getMetricsText();
    expect(metricsText).toMatch(/worker_stale_total\{[^}]*reason="persisted_snapshot"[^}]*\} 1/);
    expect(metricsText).toMatch(/worker_stalled_jobs_total\{[^}]*action="requeue"[^}]*\} 1/);
    expect(metricsText).not.toMatch(/worker_stalled_jobs_total\{[^}]*action="dead_letter"/);
    expect(metricsText).toMatch(/worker_recovered_jobs_total\{[^}]*action="requeue"[^}]*\} 1/);
    expect(metricsText).not.toMatch(/worker_recovered_jobs_total\{[^}]*action="dead_letter"/);
    expect(metricsText).not.toMatch(/worker_recovery_actions_total\{[^}]*action="persisted_snapshot"[^}]*source="worker_health"/);

    jest.advanceTimersByTime(6_000);
    metricsText = await getMetricsText();
    expect(metricsText).toMatch(/worker_stale_total\{[^}]*reason="persisted_snapshot"[^}]*\} 1/);
    expect(metricsText).toMatch(/worker_stalled_jobs_total\{[^}]*action="requeue"[^}]*\} 2/);
    expect(metricsText).toMatch(/worker_recovered_jobs_total\{[^}]*action="requeue"[^}]*\} 2/);
  });
});

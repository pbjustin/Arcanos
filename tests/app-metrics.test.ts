import { beforeEach, describe, expect, it, jest } from '@jest/globals';

async function loadMetricsModule() {
  jest.resetModules();
  const metricsModule = await import('../src/platform/observability/appMetrics.js');
  metricsModule.resetAppMetricsForTests();
  return metricsModule;
}

describe('app metrics registry', () => {
  beforeEach(() => {
    delete process.env.METRICS_AUTH_TOKEN;
    process.env.METRICS_ENABLED = 'true';
    process.env.METRICS_INCLUDE_WORKER_STATE = 'false';
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
      recordMcpAutoInvoke,
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
      handler: 'mcp-dispatcher',
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
    recordMcpAutoInvoke({
      gptId: 'arcanos-core',
      module: 'ARCANOS:CORE',
      toolName: 'dag.run.latest',
      reason: 'prompt_requests_latest_dag_run',
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

    expect(metricsText).toMatch(/dispatcher_route_total\{[^}]*gpt_id="arcanos-core"[^}]*handler="mcp-dispatcher"[^}]*outcome="ok"[^}]*\} 1/);
    expect(metricsText).toMatch(/unknown_gpt_total\{[^}]*gpt_id="missing-core"[^}]*outcome="not_registered"[^}]*\} 1/);
    expect(metricsText).toMatch(/mcp_auto_invoke_total\{[^}]*tool_name="dag\.run\.latest"[^}]*\} 1/);
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
});

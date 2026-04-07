import type { Request, Response } from 'express';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const METRICS_SERVICE_NAME = process.env.RAILWAY_SERVICE_NAME?.trim() || 'arcanos-backend';
const WORKER_METRICS_REFRESH_TTL_MS = 5_000;

const eventLoopDelayMonitor = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelayMonitor.enable();

const metricsRegistry = new Registry();
metricsRegistry.setDefaultLabels({
  service: METRICS_SERVICE_NAME,
});

const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of completed HTTP requests.',
  labelNames: ['route', 'method', 'status_code'] as const,
  registers: [metricsRegistry],
});

const httpRequestDurationMs = new Histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP request duration in milliseconds.',
  labelNames: ['route', 'method', 'status_code'] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 15_000, 30_000],
  registers: [metricsRegistry],
});

const httpRequestErrorsTotal = new Counter({
  name: 'http_request_errors_total',
  help: 'Total number of completed HTTP requests with 4xx or 5xx status codes.',
  labelNames: ['route', 'method', 'status_code'] as const,
  registers: [metricsRegistry],
});

const inFlightRequests = new Gauge({
  name: 'in_flight_requests',
  help: 'Current number of active HTTP requests.',
  registers: [metricsRegistry],
});

const responseSizeBytes = new Histogram({
  name: 'response_size_bytes',
  help: 'Serialized HTTP response size in bytes.',
  labelNames: ['route', 'method', 'status_code'] as const,
  buckets: [128, 512, 1_024, 4_096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304],
  registers: [metricsRegistry],
});

const requestSizeBytes = new Histogram({
  name: 'request_size_bytes',
  help: 'Incoming HTTP request size in bytes.',
  labelNames: ['route', 'method'] as const,
  buckets: [0, 128, 512, 1_024, 4_096, 16_384, 65_536, 262_144, 1_048_576],
  registers: [metricsRegistry],
});

const dispatcherRouteTotal = new Counter({
  name: 'dispatcher_route_total',
  help: 'Dispatcher routing outcomes by GPT, module, route, and handler.',
  labelNames: ['gpt_id', 'module', 'route', 'handler', 'outcome'] as const,
  registers: [metricsRegistry],
});

const dispatcherMisroutesTotal = new Counter({
  name: 'dispatcher_misroutes_total',
  help: 'Visible dispatcher misroutes that required fallback or recovery.',
  labelNames: ['gpt_id', 'module', 'reason'] as const,
  registers: [metricsRegistry],
});

const dispatcherFallbackTotal = new Counter({
  name: 'dispatcher_fallback_total',
  help: 'Dispatcher fallback decisions by reason.',
  labelNames: ['gpt_id', 'module', 'reason'] as const,
  registers: [metricsRegistry],
});

const unknownGptTotal = new Counter({
  name: 'unknown_gpt_total',
  help: 'Unknown GPT identifiers rejected by the dispatcher.',
  labelNames: ['gpt_id', 'outcome'] as const,
  registers: [metricsRegistry],
});

const memoryDispatchIgnoredTotal = new Counter({
  name: 'memory_dispatch_ignored_total',
  help: 'Memory-dispatcher commands ignored and eligible for fallback.',
  labelNames: ['gpt_id', 'module', 'reason'] as const,
  registers: [metricsRegistry],
});

const mcpAutoInvokeTotal = new Counter({
  name: 'mcp_auto_invoke_total',
  help: 'Automatic MCP invoke dispatch selections.',
  labelNames: ['gpt_id', 'module', 'tool_name', 'reason'] as const,
  registers: [metricsRegistry],
});

const dagRunRequestsTotal = new Counter({
  name: 'dag_run_requests_total',
  help: 'DAG read or trace requests handled by the service.',
  labelNames: ['handler', 'outcome', 'snapshot_source'] as const,
  registers: [metricsRegistry],
});

const dagRunDurationMs = new Histogram({
  name: 'dag_run_duration_ms',
  help: 'DAG request duration in milliseconds.',
  labelNames: ['handler', 'outcome'] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 15_000, 30_000],
  registers: [metricsRegistry],
});

const dagRunLookupDurationMs = new Histogram({
  name: 'dag_run_lookup_duration_ms',
  help: 'DAG run lookup duration in milliseconds.',
  labelNames: ['handler', 'lookup', 'snapshot_source'] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000],
  registers: [metricsRegistry],
});

const dagNodeFetchDurationMs = new Histogram({
  name: 'dag_node_fetch_duration_ms',
  help: 'DAG node tree build duration in milliseconds.',
  labelNames: ['handler', 'snapshot_source'] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500],
  registers: [metricsRegistry],
});

const dagEventsFetchDurationMs = new Histogram({
  name: 'dag_events_fetch_duration_ms',
  help: 'DAG events section build duration in milliseconds.',
  labelNames: ['handler', 'snapshot_source'] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500],
  registers: [metricsRegistry],
});

const dagMetricsFetchDurationMs = new Histogram({
  name: 'dag_metrics_fetch_duration_ms',
  help: 'DAG metrics section build duration in milliseconds.',
  labelNames: ['handler', 'snapshot_source'] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500],
  registers: [metricsRegistry],
});

const dagVerificationFetchDurationMs = new Histogram({
  name: 'dag_verification_fetch_duration_ms',
  help: 'DAG verification section build duration in milliseconds.',
  labelNames: ['handler', 'snapshot_source'] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500],
  registers: [metricsRegistry],
});

const dagTraceTimeoutsTotal = new Counter({
  name: 'dag_trace_timeouts_total',
  help: 'Timed out DAG trace requests.',
  labelNames: ['handler', 'reason'] as const,
  registers: [metricsRegistry],
});

const dagRunsByStatusTotal = new Counter({
  name: 'dag_runs_by_status_total',
  help: 'DAG run status transitions observed by the service.',
  labelNames: ['dag_status'] as const,
  registers: [metricsRegistry],
});

const dagNodesReturnedCount = new Histogram({
  name: 'dag_nodes_returned_count',
  help: 'Number of DAG nodes returned by inspection handlers.',
  labelNames: ['handler', 'outcome'] as const,
  buckets: [0, 1, 5, 10, 25, 50, 100, 250, 500, 1_000],
  registers: [metricsRegistry],
});

const workerJobsTotal = new Gauge({
  name: 'worker_jobs_total',
  help: 'Worker job totals from persisted queue-worker snapshots.',
  labelNames: ['scope'] as const,
  registers: [metricsRegistry],
});

const workerJobDurationMs = new Histogram({
  name: 'worker_job_duration_ms',
  help: 'Worker job duration in milliseconds.',
  labelNames: ['job_type', 'outcome'] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000],
  registers: [metricsRegistry],
});

const workerQueueDepth = new Gauge({
  name: 'worker_queue_depth',
  help: 'Current worker queue depth by state.',
  labelNames: ['state'] as const,
  registers: [metricsRegistry],
});

const workerQueueLatencyMs = new Gauge({
  name: 'worker_queue_latency_ms',
  help: 'Current worker queue wait time in milliseconds.',
  labelNames: ['scope'] as const,
  registers: [metricsRegistry],
});

const workerFailuresTotal = new Gauge({
  name: 'worker_failures_total',
  help: 'Worker failure totals from persisted queue-worker snapshots.',
  labelNames: ['scope'] as const,
  registers: [metricsRegistry],
});

const workerRetriesTotal = new Gauge({
  name: 'worker_retries_total',
  help: 'Worker retry totals from persisted queue-worker snapshots.',
  labelNames: ['scope'] as const,
  registers: [metricsRegistry],
});

const gptRequestEventsTotal = new Counter({
  name: 'gpt_request_events_total',
  help: 'GPT request idempotency and dedupe events.',
  labelNames: ['event', 'source'] as const,
  registers: [metricsRegistry],
});

const gptJobEventsTotal = new Counter({
  name: 'gpt_job_events_total',
  help: 'GPT job lifecycle events by event, status, and retryability.',
  labelNames: ['event', 'status', 'retryable'] as const,
  registers: [metricsRegistry],
});

const gptJobTimingMs = new Histogram({
  name: 'gpt_job_timing_ms',
  help: 'GPT job queue wait, execution, and end-to-end timings in milliseconds.',
  labelNames: ['phase', 'outcome'] as const,
  buckets: [10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 180_000],
  registers: [metricsRegistry],
});

const dependencyCallsTotal = new Counter({
  name: 'dependency_calls_total',
  help: 'Dependency calls by dependency, operation, and outcome.',
  labelNames: ['dependency', 'operation', 'outcome'] as const,
  registers: [metricsRegistry],
});

const dependencyCallDurationMs = new Histogram({
  name: 'dependency_call_duration_ms',
  help: 'Dependency call duration in milliseconds.',
  labelNames: ['dependency', 'operation', 'outcome'] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000],
  registers: [metricsRegistry],
});

const dependencyFailuresTotal = new Counter({
  name: 'dependency_failures_total',
  help: 'Failed dependency calls.',
  labelNames: ['dependency', 'operation'] as const,
  registers: [metricsRegistry],
});

const dependencyTimeoutsTotal = new Counter({
  name: 'dependency_timeouts_total',
  help: 'Timed out dependency calls.',
  labelNames: ['dependency', 'operation'] as const,
  registers: [metricsRegistry],
});

const aiCallsTotal = new Counter({
  name: 'ai_calls_total',
  help: 'AI provider calls by source, model, operation, and outcome.',
  labelNames: ['provider', 'operation', 'source_type', 'source_name', 'model', 'outcome'] as const,
  registers: [metricsRegistry],
});

const aiCallDurationMs = new Histogram({
  name: 'ai_call_duration_ms',
  help: 'AI provider call duration in milliseconds.',
  labelNames: ['provider', 'operation', 'source_type', 'source_name', 'model', 'outcome'] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000],
  registers: [metricsRegistry],
});

const aiTokensTotal = new Counter({
  name: 'ai_tokens_total',
  help: 'AI tokens consumed by source, model, operation, and token type.',
  labelNames: ['provider', 'operation', 'source_type', 'source_name', 'model', 'token_type'] as const,
  registers: [metricsRegistry],
});

const aiBudgetExceededTotal = new Counter({
  name: 'ai_budget_exceeded_total',
  help: 'AI boundary budget exceed events by source and limit kind.',
  labelNames: ['provider', 'source_type', 'source_name', 'limit_kind'] as const,
  registers: [metricsRegistry],
});

const processHeapUsedBytes = new Gauge({
  name: 'process_heap_used_bytes',
  help: 'Heap used by the current Node.js process.',
  registers: [metricsRegistry],
});

const processRssBytes = new Gauge({
  name: 'process_rss_bytes',
  help: 'Resident set size for the current Node.js process.',
  registers: [metricsRegistry],
});

const eventLoopLagMs = new Gauge({
  name: 'event_loop_lag_ms',
  help: 'Observed mean event loop lag in milliseconds.',
  registers: [metricsRegistry],
});

let lastWorkerMetricsRefreshAtMs = 0;
let pendingWorkerMetricsRefresh: Promise<void> | null = null;

function normalizeLabel(value: string | number | null | undefined, fallback = 'unknown'): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }

  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeRoutePath(routePath: string): string {
  const normalized = routePath.replace(/\/+/g, '/');
  if (normalized.length === 0) {
    return '/';
  }
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

export function resolveMetricRouteLabel(req: Request): string {
  const routePath = req.route?.path;
  if (typeof routePath === 'string') {
    return normalizeRoutePath(`${req.baseUrl || ''}${routePath}`);
  }

  if (Array.isArray(routePath) && routePath.length > 0 && typeof routePath[0] === 'string') {
    return normalizeRoutePath(`${req.baseUrl || ''}${routePath[0]}`);
  }

  return 'unmatched';
}

export function shouldSkipHttpMetrics(req: Request): boolean {
  return req.path === '/metrics' || req.originalUrl === '/metrics';
}

function coerceByteSize(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }

  if (typeof value === 'string') {
    const parsedValue = Number.parseInt(value, 10);
    return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : 0;
  }

  return 0;
}

export function recordHttpRequestStart(): void {
  inFlightRequests.inc();
}

export function recordHttpRequestCompletion(input: {
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
  requestBytes?: number;
  responseBytes?: number;
}): void {
  const route = normalizeLabel(input.route, 'unmatched');
  const method = normalizeLabel(input.method, 'UNKNOWN').toUpperCase();
  const statusCode = normalizeLabel(input.statusCode, '0');
  const requestBytes = Math.max(0, Math.trunc(input.requestBytes ?? 0));
  const responseBytes = Math.max(0, Math.trunc(input.responseBytes ?? 0));

  httpRequestsTotal.inc({ route, method, status_code: statusCode });
  httpRequestDurationMs.observe({ route, method, status_code: statusCode }, Math.max(0, input.durationMs));
  requestSizeBytes.observe({ route, method }, requestBytes);
  responseSizeBytes.observe({ route, method, status_code: statusCode }, responseBytes);
  if (Number.parseInt(statusCode, 10) >= 400) {
    httpRequestErrorsTotal.inc({ route, method, status_code: statusCode });
  }
}

export function recordHttpRequestEnd(): void {
  inFlightRequests.dec();
}

export function recordDispatcherRoute(input: {
  gptId: string;
  module?: string | null;
  route?: string | null;
  handler: string;
  outcome: string;
}): void {
  dispatcherRouteTotal.inc({
    gpt_id: normalizeLabel(input.gptId),
    module: normalizeLabel(input.module),
    route: normalizeLabel(input.route),
    handler: normalizeLabel(input.handler),
    outcome: normalizeLabel(input.outcome),
  });
}

export function recordDispatcherMisroute(input: {
  gptId: string;
  module?: string | null;
  reason: string;
}): void {
  dispatcherMisroutesTotal.inc({
    gpt_id: normalizeLabel(input.gptId),
    module: normalizeLabel(input.module),
    reason: normalizeLabel(input.reason),
  });
}

export function recordDispatcherFallback(input: {
  gptId: string;
  module?: string | null;
  reason: string;
}): void {
  dispatcherFallbackTotal.inc({
    gpt_id: normalizeLabel(input.gptId),
    module: normalizeLabel(input.module),
    reason: normalizeLabel(input.reason),
  });
}

export function recordUnknownGpt(input: {
  gptId: string;
  outcome?: string;
}): void {
  unknownGptTotal.inc({
    gpt_id: normalizeLabel(input.gptId),
    outcome: normalizeLabel(input.outcome, 'unknown_gpt'),
  });
}

export function recordMemoryDispatchIgnored(input: {
  gptId: string;
  module?: string | null;
  reason: string;
}): void {
  memoryDispatchIgnoredTotal.inc({
    gpt_id: normalizeLabel(input.gptId),
    module: normalizeLabel(input.module),
    reason: normalizeLabel(input.reason),
  });
}

export function recordMcpAutoInvoke(input: {
  gptId: string;
  module?: string | null;
  toolName: string;
  reason: string;
}): void {
  mcpAutoInvokeTotal.inc({
    gpt_id: normalizeLabel(input.gptId),
    module: normalizeLabel(input.module),
    tool_name: normalizeLabel(input.toolName),
    reason: normalizeLabel(input.reason),
  });
}

export function recordDagRunRequest(input: {
  handler: string;
  outcome: string;
  snapshotSource?: string | null;
  durationMs?: number;
  lookupDurationsMs?: Partial<Record<'local' | 'persisted' | 'total', number>>;
  nodesReturned?: number;
  buildDurationsMs?: Partial<Record<'nodes' | 'events' | 'metrics' | 'verification', number>>;
}): void {
  const handler = normalizeLabel(input.handler);
  const outcome = normalizeLabel(input.outcome);
  const snapshotSource = normalizeLabel(input.snapshotSource, 'none');

  dagRunRequestsTotal.inc({
    handler,
    outcome,
    snapshot_source: snapshotSource,
  });

  if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)) {
    dagRunDurationMs.observe({ handler, outcome }, Math.max(0, input.durationMs));
  }

  if (input.lookupDurationsMs) {
    if (typeof input.lookupDurationsMs.local === 'number') {
      dagRunLookupDurationMs.observe(
        { handler, lookup: 'local', snapshot_source: snapshotSource },
        Math.max(0, input.lookupDurationsMs.local)
      );
    }
    if (typeof input.lookupDurationsMs.persisted === 'number') {
      dagRunLookupDurationMs.observe(
        { handler, lookup: 'persisted', snapshot_source: snapshotSource },
        Math.max(0, input.lookupDurationsMs.persisted)
      );
    }
    if (typeof input.lookupDurationsMs.total === 'number') {
      dagRunLookupDurationMs.observe(
        { handler, lookup: 'total', snapshot_source: snapshotSource },
        Math.max(0, input.lookupDurationsMs.total)
      );
    }
  }

  if (typeof input.nodesReturned === 'number' && Number.isFinite(input.nodesReturned)) {
    dagNodesReturnedCount.observe({ handler, outcome }, Math.max(0, input.nodesReturned));
  }

  if (input.buildDurationsMs) {
    if (typeof input.buildDurationsMs.nodes === 'number') {
      dagNodeFetchDurationMs.observe(
        { handler, snapshot_source: snapshotSource },
        Math.max(0, input.buildDurationsMs.nodes)
      );
    }
    if (typeof input.buildDurationsMs.events === 'number') {
      dagEventsFetchDurationMs.observe(
        { handler, snapshot_source: snapshotSource },
        Math.max(0, input.buildDurationsMs.events)
      );
    }
    if (typeof input.buildDurationsMs.metrics === 'number') {
      dagMetricsFetchDurationMs.observe(
        { handler, snapshot_source: snapshotSource },
        Math.max(0, input.buildDurationsMs.metrics)
      );
    }
    if (typeof input.buildDurationsMs.verification === 'number') {
      dagVerificationFetchDurationMs.observe(
        { handler, snapshot_source: snapshotSource },
        Math.max(0, input.buildDurationsMs.verification)
      );
    }
  }
}

export function recordDagTraceTimeout(input: {
  handler?: string;
  reason: string;
}): void {
  dagTraceTimeoutsTotal.inc({
    handler: normalizeLabel(input.handler, 'trace'),
    reason: normalizeLabel(input.reason),
  });
}

export function recordDagRunStatus(status: string): void {
  dagRunsByStatusTotal.inc({
    dag_status: normalizeLabel(status),
  });
}

export function recordWorkerJobTotal(scope: string, value: number): void {
  workerJobsTotal.set({ scope: normalizeLabel(scope) }, Math.max(0, value));
}

export function recordWorkerJobDuration(input: {
  jobType: string;
  outcome: string;
  durationMs: number;
}): void {
  workerJobDurationMs.observe(
    {
      job_type: normalizeLabel(input.jobType),
      outcome: normalizeLabel(input.outcome),
    },
    Math.max(0, input.durationMs)
  );
}

export function recordWorkerQueueDepth(state: string, value: number): void {
  workerQueueDepth.set({ state: normalizeLabel(state) }, Math.max(0, value));
}

export function recordWorkerQueueLatency(scope: string, value: number): void {
  workerQueueLatencyMs.set({ scope: normalizeLabel(scope) }, Math.max(0, value));
}

export function recordWorkerFailureTotal(scope: string, value: number): void {
  workerFailuresTotal.set({ scope: normalizeLabel(scope) }, Math.max(0, value));
}

export function recordWorkerRetryTotal(scope: string, value: number): void {
  workerRetriesTotal.set({ scope: normalizeLabel(scope) }, Math.max(0, value));
}

export function recordGptRequestEvent(input: {
  event: string;
  source?: string | null;
}): void {
  gptRequestEventsTotal.inc({
    event: normalizeLabel(input.event),
    source: normalizeLabel(input.source)
  });
}

export function recordGptJobEvent(input: {
  event: string;
  status?: string | null;
  retryable?: boolean | null;
}): void {
  gptJobEventsTotal.inc({
    event: normalizeLabel(input.event),
    status: normalizeLabel(input.status),
    retryable:
      input.retryable === null || input.retryable === undefined
        ? 'unknown'
        : input.retryable
        ? 'true'
        : 'false'
  });
}

export function recordGptJobTiming(input: {
  phase: 'queue_wait' | 'execution' | 'end_to_end';
  outcome: string;
  durationMs: number | null | undefined;
}): void {
  if (typeof input.durationMs !== 'number' || !Number.isFinite(input.durationMs) || input.durationMs < 0) {
    return;
  }

  gptJobTimingMs.observe({
    phase: normalizeLabel(input.phase),
    outcome: normalizeLabel(input.outcome)
  }, input.durationMs);
}

function isTimeoutError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
      ? error
      : '';
  const normalizedMessage = message.toLowerCase();
  return (
    normalizedMessage.includes('timeout') ||
    normalizedMessage.includes('timed out') ||
    normalizedMessage.includes('statement timeout') ||
    normalizedMessage.includes('abort')
  );
}

export function recordDependencyCall(input: {
  dependency: string;
  operation: string;
  outcome: string;
  durationMs?: number;
  error?: unknown;
}): void {
  const dependency = normalizeLabel(input.dependency);
  const operation = normalizeLabel(input.operation);
  const outcome = normalizeLabel(input.outcome);

  dependencyCallsTotal.inc({
    dependency,
    operation,
    outcome,
  });

  if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)) {
    dependencyCallDurationMs.observe(
      { dependency, operation, outcome },
      Math.max(0, input.durationMs)
    );
  }

  if (outcome !== 'ok' && outcome !== 'hit') {
    dependencyFailuresTotal.inc({ dependency, operation });
  }

  if (isTimeoutError(input.error) || outcome === 'timeout') {
    dependencyTimeoutsTotal.inc({ dependency, operation });
  }
}

export function recordAiOperation(input: {
  provider: string;
  operation: string;
  sourceType?: string | null;
  sourceName?: string | null;
  model?: string | null;
  outcome: string;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}): void {
  const provider = normalizeLabel(input.provider, 'openai');
  const operation = normalizeLabel(input.operation);
  const sourceType = normalizeLabel(input.sourceType, 'unknown');
  const sourceName = normalizeLabel(input.sourceName, 'unknown');
  const model = normalizeLabel(input.model, 'unknown');
  const outcome = normalizeLabel(input.outcome);

  aiCallsTotal.inc({
    provider,
    operation,
    source_type: sourceType,
    source_name: sourceName,
    model,
    outcome,
  });

  if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)) {
    aiCallDurationMs.observe(
      {
        provider,
        operation,
        source_type: sourceType,
        source_name: sourceName,
        model,
        outcome,
      },
      Math.max(0, input.durationMs),
    );
  }

  const promptTokens = Math.max(0, Math.trunc(input.promptTokens ?? 0));
  const completionTokens = Math.max(0, Math.trunc(input.completionTokens ?? 0));
  const totalTokens = Math.max(0, Math.trunc(input.totalTokens ?? 0));

  if (promptTokens > 0) {
    aiTokensTotal.inc({
      provider,
      operation,
      source_type: sourceType,
      source_name: sourceName,
      model,
      token_type: 'prompt',
    }, promptTokens);
  }

  if (completionTokens > 0) {
    aiTokensTotal.inc({
      provider,
      operation,
      source_type: sourceType,
      source_name: sourceName,
      model,
      token_type: 'completion',
    }, completionTokens);
  }

  if (totalTokens > 0) {
    aiTokensTotal.inc({
      provider,
      operation,
      source_type: sourceType,
      source_name: sourceName,
      model,
      token_type: 'total',
    }, totalTokens);
  }
}

export function recordAiBudgetExceeded(input: {
  provider: string;
  sourceType?: string | null;
  sourceName?: string | null;
  limitKind: 'calls' | 'prompt_tokens' | 'completion_tokens' | 'total_tokens';
}): void {
  aiBudgetExceededTotal.inc({
    provider: normalizeLabel(input.provider, 'openai'),
    source_type: normalizeLabel(input.sourceType, 'unknown'),
    source_name: normalizeLabel(input.sourceName, 'unknown'),
    limit_kind: normalizeLabel(input.limitKind),
  });
}

function refreshProcessMetrics(): void {
  const memoryUsage = process.memoryUsage();
  processHeapUsedBytes.set(memoryUsage.heapUsed);
  processRssBytes.set(memoryUsage.rss);
  eventLoopLagMs.set(Number(eventLoopDelayMonitor.mean) / 1_000_000 || 0);
}

function resetWorkerSnapshotMetrics(): void {
  recordWorkerQueueDepth('pending', 0);
  recordWorkerQueueDepth('running', 0);
  recordWorkerQueueDepth('delayed', 0);
  recordWorkerQueueDepth('failed', 0);
  recordWorkerQueueDepth('stalled', 0);
  recordWorkerQueueLatency('oldest_pending', 0);
  recordWorkerJobTotal('processed', 0);
  recordWorkerJobTotal('running', 0);
  recordWorkerJobTotal('pending', 0);
  recordWorkerJobTotal('completed', 0);
  recordWorkerJobTotal('failed', 0);
  recordWorkerJobTotal('recovered', 0);
  recordWorkerFailureTotal('terminal', 0);
  recordWorkerFailureTotal('queue_failed_rows', 0);
  recordWorkerRetryTotal('scheduled', 0);
}

async function refreshWorkerMetrics(): Promise<void> {
  if (process.env.METRICS_INCLUDE_WORKER_STATE === 'false') {
    resetWorkerSnapshotMetrics();
    return;
  }

  const nowMs = Date.now();
  if (nowMs - lastWorkerMetricsRefreshAtMs < WORKER_METRICS_REFRESH_TTL_MS) {
    return;
  }

  if (pendingWorkerMetricsRefresh) {
    return pendingWorkerMetricsRefresh;
  }

  pendingWorkerMetricsRefresh = (async () => {
    try {
      const { getWorkerControlHealth } = await import('@services/workerControlService.js');
      const health = await getWorkerControlHealth();
      const queueSummary = health.queueSummary;

      recordWorkerQueueDepth('pending', queueSummary?.pending ?? 0);
      recordWorkerQueueDepth('running', queueSummary?.running ?? 0);
      recordWorkerQueueDepth('delayed', queueSummary?.delayed ?? 0);
      recordWorkerQueueDepth('failed', queueSummary?.failed ?? 0);
      recordWorkerQueueDepth('stalled', queueSummary?.stalledRunning ?? 0);
      recordWorkerQueueLatency('oldest_pending', queueSummary?.oldestPendingJobAgeMs ?? 0);

      let processedJobs = 0;
      let scheduledRetries = 0;
      let terminalFailures = 0;
      let recoveredJobs = 0;

      for (const worker of health.workers) {
        processedJobs += typeof worker.processedJobs === 'number' ? worker.processedJobs : 0;
        scheduledRetries += typeof worker.scheduledRetries === 'number' ? worker.scheduledRetries : 0;
        terminalFailures += typeof worker.terminalFailures === 'number' ? worker.terminalFailures : 0;
        recoveredJobs += typeof worker.recoveredJobs === 'number' ? worker.recoveredJobs : 0;
      }

      recordWorkerJobTotal('processed', processedJobs);
      recordWorkerJobTotal('running', queueSummary?.running ?? 0);
      recordWorkerJobTotal('pending', queueSummary?.pending ?? 0);
      recordWorkerJobTotal('completed', queueSummary?.completed ?? 0);
      recordWorkerJobTotal('failed', queueSummary?.failed ?? 0);
      recordWorkerJobTotal('recovered', recoveredJobs);

      recordWorkerFailureTotal('terminal', terminalFailures);
      recordWorkerFailureTotal('queue_failed_rows', queueSummary?.failed ?? 0);
      recordWorkerRetryTotal('scheduled', scheduledRetries);
    } catch {
      resetWorkerSnapshotMetrics();
    } finally {
      lastWorkerMetricsRefreshAtMs = Date.now();
      pendingWorkerMetricsRefresh = null;
    }
  })();

  return pendingWorkerMetricsRefresh;
}

function isMetricsEnabled(): boolean {
  return process.env.METRICS_ENABLED !== 'false';
}

function isMetricsRequestAuthorized(req: Request): boolean {
  const expectedToken = process.env.METRICS_AUTH_TOKEN?.trim();
  if (!expectedToken) {
    return true;
  }

  const bearerToken = req.header('authorization')?.replace(/^Bearer\s+/i, '').trim();
  const headerToken = req.header('x-metrics-token')?.trim();
  return bearerToken === expectedToken || headerToken === expectedToken;
}

export async function writeMetricsResponse(req: Request, res: Response): Promise<void> {
  if (!isMetricsEnabled()) {
    res.status(404).json({
      error: 'Metrics endpoint disabled',
    });
    return;
  }

  if (!isMetricsRequestAuthorized(req)) {
    res.status(403).json({
      error: 'Forbidden',
    });
    return;
  }

  refreshProcessMetrics();
  await refreshWorkerMetrics();

  res.setHeader('Content-Type', metricsRegistry.contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.send(await metricsRegistry.metrics());
}

export async function getMetricsText(): Promise<string> {
  refreshProcessMetrics();
  await refreshWorkerMetrics();
  return metricsRegistry.metrics();
}

export function resetAppMetricsForTests(): void {
  metricsRegistry.resetMetrics();
  lastWorkerMetricsRefreshAtMs = 0;
  pendingWorkerMetricsRefresh = null;
  inFlightRequests.set(0);
  eventLoopDelayMonitor.reset();
  resetWorkerSnapshotMetrics();
}

export { metricsRegistry };

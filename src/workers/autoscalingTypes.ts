export type WorkerPoolName =
  | 'main_runtime_pool'
  | 'async_queue_pool'
  | 'audit_safe_pool'
  | 'creative_domain_pool';

export interface WorkerJobMetadata {
  domain: 'main' | 'async' | 'audit' | 'creative';
  priority: number;
  auditSafe: boolean;
  sessionId: string;
}

export interface WorkerJob<TPayload = unknown> {
  id: string;
  payload: TPayload;
  metadata: WorkerJobMetadata;
  enqueuedAtMs: number;
}

export interface PoolQueueMetrics {
  depth: number;
  oldestJobAgeSeconds: number;
}

export interface PoolRuntimeMetrics {
  cpuRatio: number;
  workers: number;
}

export interface AutoscalingMetricsSnapshot {
  async: PoolQueueMetrics;
  main: PoolRuntimeMetrics;
  audit: PoolQueueMetrics;
  creative: PoolQueueMetrics;
  baselineTrafficByDomain: Record<WorkerJobMetadata['domain'], number>;
  currentTrafficByDomain: Record<WorkerJobMetadata['domain'], number>;
}

export interface ScalingAction {
  pool: WorkerPoolName;
  scaleTo: number;
  reason: 'queue_backlog' | 'job_latency' | 'cpu_pressure' | 'domain_surge';
}

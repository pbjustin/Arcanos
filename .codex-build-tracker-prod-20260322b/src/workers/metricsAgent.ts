import type {
  AutoscalingMetricsSnapshot,
  WorkerJobMetadata
} from './autoscalingTypes.js';
import type { WorkerQueueService } from './queueService.js';
import type { WorkerManager } from './manager.js';

export interface MetricsDependencies {
  readCpuRatio: () => number;
  readMemoryPressureRatio?: () => number;
  readApiLatencyMs?: () => number;
  queueService: WorkerQueueService;
  workerManager: WorkerManager;
  readCurrentTrafficByDomain: () => Record<WorkerJobMetadata['domain'], number>;
  readBaselineTrafficByDomain: () => Record<WorkerJobMetadata['domain'], number>;
}

/**
 * Collects queue, runtime, and traffic telemetry for autoscaling decisions.
 *
 * Purpose:
 * - Build one normalized metrics snapshot that scaler logic can evaluate.
 *
 * Inputs/outputs:
 * - Input: dependency-injected CPU, queue, worker-count, and domain traffic readers.
 * - Output: autoscaling metrics snapshot.
 *
 * Edge case behavior:
 * - Clamps invalid CPU samples to [0,1] to keep scaler thresholds deterministic.
 */
export class MetricsAgent {
  constructor(private readonly dependencies: MetricsDependencies) {}

  /**
   * Read one telemetry snapshot.
   */
  collectMetrics(nowMs: number = Date.now()): AutoscalingMetricsSnapshot {
    const rawCpuRatio = this.dependencies.readCpuRatio();
    const rawMemoryPressureRatio = this.dependencies.readMemoryPressureRatio?.() ?? 0;
    const rawApiLatencyMs = this.dependencies.readApiLatencyMs?.() ?? 0;

    //audit Assumption: CPU sensors can occasionally report out-of-range values under host jitter; failure risk: invalid ratios trigger false scaling actions; expected invariant: cpuRatio is bounded to [0,1]; handling strategy: clamp samples to safe bounds.
    const normalizedCpuRatio = Math.min(1, Math.max(0, rawCpuRatio));
    //audit Assumption: memory pressure readers can spike above 100% or below zero during host reporting jitter; failure risk: invalid memory ratios trigger false scale-up; expected invariant: memoryPressureRatio is bounded to [0,1]; handling strategy: clamp samples to safe bounds.
    const normalizedMemoryPressureRatio = Math.min(1, Math.max(0, rawMemoryPressureRatio));
    const normalizedApiLatencyMs = Math.max(0, rawApiLatencyMs);

    return {
      async: {
        depth: this.dependencies.queueService.getQueueDepth('async_queue_pool'),
        oldestJobAgeSeconds: this.dependencies.queueService.getOldestJobAgeSeconds('async_queue_pool', nowMs)
      },
      main: {
        cpuRatio: normalizedCpuRatio,
        memoryPressureRatio: normalizedMemoryPressureRatio,
        apiLatencyMs: normalizedApiLatencyMs,
        workers: this.dependencies.workerManager.count('main_runtime_pool')
      },
      audit: {
        depth: this.dependencies.queueService.getQueueDepth('audit_safe_pool'),
        oldestJobAgeSeconds: this.dependencies.queueService.getOldestJobAgeSeconds('audit_safe_pool', nowMs)
      },
      creative: {
        depth: this.dependencies.queueService.getQueueDepth('creative_domain_pool'),
        oldestJobAgeSeconds: this.dependencies.queueService.getOldestJobAgeSeconds('creative_domain_pool', nowMs)
      },
      baselineTrafficByDomain: this.dependencies.readBaselineTrafficByDomain(),
      currentTrafficByDomain: this.dependencies.readCurrentTrafficByDomain()
    };
  }
}

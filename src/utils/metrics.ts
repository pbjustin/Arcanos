import { healthMetrics } from '../platform/logging/logger.js';

export interface DagMetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  /** Latest duration per metric name, wrapped in an array for snapshot compatibility. */
  durationsMs: Record<string, number[]>;
}

export interface DagMetricsRecorder {
  incrementCounter(metricName: string, amount?: number): void;
  recordGauge(metricName: string, value: number): void;
  recordDuration(metricName: string, durationMs: number): void;
  snapshot(): DagMetricsSnapshot;
}

class InMemoryDagMetricsRecorder implements DagMetricsRecorder {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly durationsMs = new Map<string, number>();

  incrementCounter(metricName: string, amount: number = 1): void {
    const currentValue = this.counters.get(metricName) ?? 0;
    const nextValue = currentValue + amount;
    this.counters.set(metricName, nextValue);
    healthMetrics.record(`dag.counter.${metricName}`, nextValue);
  }

  recordGauge(metricName: string, value: number): void {
    this.gauges.set(metricName, value);
    healthMetrics.record(`dag.gauge.${metricName}`, value);
  }

  recordDuration(metricName: string, durationMs: number): void {
    // The worker singleton retains one value per fixed metric name, never job history.
    this.durationsMs.set(metricName, durationMs);
    healthMetrics.record(`dag.duration.${metricName}`, durationMs);
  }

  snapshot(): DagMetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters.entries()),
      gauges: Object.fromEntries(this.gauges.entries()),
      durationsMs: Object.fromEntries(
        Array.from(this.durationsMs, ([metricName, durationMs]) => [metricName, [durationMs]])
      )
    };
  }
}

/**
 * Create a DAG metrics recorder backed by in-memory counters and shared health metrics.
 *
 * Purpose:
 * - Provide lightweight orchestration telemetry without introducing another metrics backend.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: a metrics recorder safe for repeated DAG runs in the same process.
 *
 * Edge case behavior:
 * - Reuses process-local state only; metrics reset when the process restarts.
 */
export function createDagMetricsRecorder(): DagMetricsRecorder {
  return new InMemoryDagMetricsRecorder();
}

export const dagMetrics: DagMetricsRecorder = createDagMetricsRecorder();

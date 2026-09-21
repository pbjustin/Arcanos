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

export type DagMetricSink = (metricName: string, value: number) => void;

class InMemoryDagMetricsRecorder implements DagMetricsRecorder {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly durationsMs = new Map<string, number>();

  constructor(private readonly recordHealthMetric: DagMetricSink) {}

  incrementCounter(metricName: string, amount: number = 1): void {
    const currentValue = this.counters.get(metricName) ?? 0;
    const nextValue = currentValue + amount;
    this.counters.set(metricName, nextValue);
    this.recordHealthMetric(`dag.counter.${metricName}`, nextValue);
  }

  recordGauge(metricName: string, value: number): void {
    this.gauges.set(metricName, value);
    this.recordHealthMetric(`dag.gauge.${metricName}`, value);
  }

  recordDuration(metricName: string, durationMs: number): void {
    // The worker singleton retains one value per fixed metric name, never job history.
    this.durationsMs.set(metricName, durationMs);
    this.recordHealthMetric(`dag.duration.${metricName}`, durationMs);
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

/** Create the production recorder with an explicitly supplied metric sink. */
export function createDagMetricsRecorderCore(recordHealthMetric: DagMetricSink): DagMetricsRecorder {
  return new InMemoryDagMetricsRecorder(recordHealthMetric);
}

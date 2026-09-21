import {
  createDagMetricsRecorderCore,
  type DagMetricsRecorder,
  type DagMetricsSnapshot
} from './dagMetricsCore.js';

export const DAG_METRICS_RETENTION_PREVIEW_VERSION = 'dag-metrics-retention/v1';
const FAILURE = 'DAG_METRICS_RETENTION_PREVIEW_FIXTURE_FAILED';
const OBSERVATIONS_PER_SERIES = 15_000;

function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function retainedDurations(recorder: DagMetricsRecorder): Map<string, unknown> {
  return (recorder as unknown as { durationsMs: Map<string, unknown> }).durationsMs;
}

function requireSnapshot(
  snapshot: DagMetricsSnapshot,
  observations: number,
  lastSuccess: number,
  lastFailure: number
): void {
  requireProof(Object.keys(snapshot.counters).length === 2);
  requireProof(snapshot.counters.node_success === observations);
  requireProof(snapshot.counters.node_failure === observations * 2);
  requireProof(Object.keys(snapshot.gauges).length === 1);
  requireProof(snapshot.gauges.queued_nodes === observations % 7);
  requireProof(Object.keys(snapshot.durationsMs).length === 2);
  requireProof(Array.isArray(snapshot.durationsMs.node_execution));
  requireProof(Array.isArray(snapshot.durationsMs.node_execution_failed));
  requireProof(snapshot.durationsMs.node_execution.length === 1);
  requireProof(snapshot.durationsMs.node_execution_failed.length === 1);
  requireProof(snapshot.durationsMs.node_execution[0] === lastSuccess);
  requireProof(snapshot.durationsMs.node_execution_failed[0] === lastFailure);
}

/**
 * Exercise the same recorder core used by production with a fixed synthetic
 * sink. This proves compiled retention behavior, not queue or provider execution.
 */
export function assertDagMetricsRetentionPreviewFixture(): void {
  const healthSink = new Map<string, number>();
  let healthWrites = 0;
  const recorder = createDagMetricsRecorderCore((metricName, value) => {
    healthWrites += 1;
    healthSink.set(metricName, value);
  });
  const independent = createDagMetricsRecorderCore(() => undefined);
  const storage = retainedDurations(recorder);
  requireProof(storage instanceof Map);
  const initialDurationCount = storage.size;
  requireProof(initialDurationCount === 0);
  let earlierSnapshot: DagMetricsSnapshot | undefined;

  for (let batch = 1; batch <= 2; batch += 1) {
    const first = (batch - 1) * OBSERVATIONS_PER_SERIES / 2 + 1;
    const last = batch * OBSERVATIONS_PER_SERIES / 2;
    // No snapshots inside either batch: a read-time trim cannot hide history.
    for (let observation = first; observation <= last; observation += 1) {
      const duration = observation === OBSERVATIONS_PER_SERIES ? 0 : observation;
      recorder.recordDuration('node_execution', duration);
      recorder.recordDuration('node_execution_failed', duration * 2);
      recorder.incrementCounter('node_success');
      recorder.incrementCounter('node_failure', 2);
      recorder.recordGauge('queued_nodes', observation % 7);
    }

    const lastDuration = last === OBSERVATIONS_PER_SERIES ? 0 : last;
    // Check actual retained storage before calling snapshot at each checkpoint.
    requireProof(retainedDurations(recorder) === storage);
    requireProof(storage.size === 2);
    requireProof([...storage.values()].every(value => typeof value === 'number'));
    requireProof(storage.get('node_execution') === lastDuration);
    requireProof(storage.get('node_execution_failed') === lastDuration * 2);
    requireProof(healthWrites === last * 5 && healthSink.size === 5);
    requireProof(healthSink.get('dag.counter.node_success') === last);
    requireProof(healthSink.get('dag.counter.node_failure') === last * 2);
    requireProof(healthSink.get('dag.gauge.queued_nodes') === last % 7);
    requireProof(healthSink.get('dag.duration.node_execution') === lastDuration);
    requireProof(healthSink.get('dag.duration.node_execution_failed') === lastDuration * 2);
    const snapshot = recorder.snapshot();
    requireSnapshot(snapshot, last, lastDuration, lastDuration * 2);
    if (batch === 1) earlierSnapshot = snapshot;
  }

  requireProof(earlierSnapshot !== undefined);
  requireSnapshot(earlierSnapshot, 7_500, 7_500, 15_000);
  const mutatedSnapshot = recorder.snapshot();
  mutatedSnapshot.counters.node_success = -1;
  mutatedSnapshot.gauges.queued_nodes = -1;
  mutatedSnapshot.durationsMs.node_execution.push(-1);
  mutatedSnapshot.durationsMs.extra = [-1];
  requireSnapshot(recorder.snapshot(), OBSERVATIONS_PER_SERIES, 0, 0);
  requireSnapshot(earlierSnapshot, 7_500, 7_500, 15_000);
  requireProof(storage.size === 2 && storage.get('node_execution') === 0);
  requireProof(storage.get('node_execution_failed') === 0);
  requireProof(retainedDurations(independent).size === 0);
  const independentSnapshot = independent.snapshot();
  requireProof(Object.keys(independentSnapshot.counters).length === 0);
  requireProof(Object.keys(independentSnapshot.gauges).length === 0);
  requireProof(Object.keys(independentSnapshot.durationsMs).length === 0);
}

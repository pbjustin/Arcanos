import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { DagMetricsRecorder } from '../src/utils/metrics.js';

function retainedDurations(recorder: DagMetricsRecorder): Map<string, unknown> {
  // Inspect storage as well as snapshots so bounded output cannot conceal retained history.
  return (recorder as unknown as { durationsMs: Map<string, unknown> }).durationsMs;
}

describe('DAG metrics retention', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('starts empty and gives each factory recorder independent state', async () => {
    const { createDagMetricsRecorder, dagMetrics } = await import('../src/utils/metrics.js');
    const first = createDagMetricsRecorder();
    const second = createDagMetricsRecorder();
    const emptySnapshot = { counters: {}, gauges: {}, durationsMs: {} };

    expect(first.snapshot()).toEqual(emptySnapshot);
    expect(second.snapshot()).toEqual(emptySnapshot);
    expect(dagMetrics.snapshot()).toEqual(emptySnapshot);

    first.incrementCounter('node_success');
    first.recordGauge('queued_nodes', 4);
    first.recordDuration('node_execution', 12);

    expect(first.snapshot()).toEqual({
      counters: { node_success: 1 },
      gauges: { queued_nodes: 4 },
      durationsMs: { node_execution: [12] }
    });
    expect(second.snapshot()).toEqual(emptySnapshot);
    expect(dagMetrics.snapshot()).toEqual(emptySnapshot);
  });

  it('retains two duration scalars after 20,000 observations while cumulative counters and latest values remain correct', async () => {
    const { dagMetrics } = await import('../src/utils/metrics.js');
    const { healthMetrics } = await import('../src/platform/logging/logger.js');
    const observationsPerSeries = 10_000;

    for (let observation = 1; observation <= observationsPerSeries; observation += 1) {
      dagMetrics.recordDuration('node_execution', observation);
      dagMetrics.recordDuration('node_execution_failed', observation * 2);
      dagMetrics.incrementCounter('node_success');
      dagMetrics.incrementCounter('node_failure', 2);
      dagMetrics.recordGauge('queued_nodes', observation % 7);
    }

    // Check retained state before snapshot() so read-time trimming cannot hide history.
    const storage = retainedDurations(dagMetrics);
    expect(storage.size).toBe(2);
    expect([...storage.values()].every(value => typeof value === 'number')).toBe(true);
    expect(Object.fromEntries(storage)).toEqual({
      node_execution: 10_000,
      node_execution_failed: 20_000
    });

    const snapshot = dagMetrics.snapshot();
    expect(snapshot.counters).toEqual({ node_success: 10_000, node_failure: 20_000 });
    expect(snapshot.gauges).toEqual({ queued_nodes: 4 });
    expect(healthMetrics.getMetrics()).toMatchObject({
      'dag.counter.node_success': { value: 10_000 },
      'dag.counter.node_failure': { value: 20_000 },
      'dag.gauge.queued_nodes': { value: 4 },
      'dag.duration.node_execution': { value: 10_000 },
      'dag.duration.node_execution_failed': { value: 20_000 }
    });
    expect(Object.values(snapshot.durationsMs).map(samples => samples.length)).toEqual([1, 1]);
    expect(snapshot.durationsMs).toEqual({
      node_execution: [10_000],
      node_execution_failed: [20_000]
    });

    for (let observation = 1; observation <= observationsPerSeries; observation += 1) {
      dagMetrics.recordDuration('node_execution', observation + observationsPerSeries);
      dagMetrics.incrementCounter('node_success');
    }

    expect(retainedDurations(dagMetrics)).toBe(storage);
    expect(storage.size).toBe(2);
    expect(Object.fromEntries(storage)).toEqual({
      node_execution: 20_000,
      node_execution_failed: 20_000
    });
    expect(dagMetrics.snapshot().counters.node_success).toBe(20_000);
  });

  it('returns detached snapshots with the existing array shape and latest duration, including zero', async () => {
    const { createDagMetricsRecorder } = await import('../src/utils/metrics.js');
    const recorder = createDagMetricsRecorder();
    recorder.incrementCounter('node_success');
    recorder.recordGauge('queued_nodes', 3);
    recorder.recordDuration('node_execution', 12);

    const priorSnapshot = recorder.snapshot();
    const modifiedSnapshot = recorder.snapshot();
    modifiedSnapshot.counters.node_success = 999;
    modifiedSnapshot.gauges.queued_nodes = 999;
    modifiedSnapshot.durationsMs.node_execution.push(999);
    modifiedSnapshot.durationsMs.extra = [999];

    expect(recorder.snapshot()).toEqual({
      counters: { node_success: 1 },
      gauges: { queued_nodes: 3 },
      durationsMs: { node_execution: [12] }
    });
    recorder.recordDuration('node_execution', 0);
    expect(recorder.snapshot().durationsMs).toEqual({ node_execution: [0] });
    expect(priorSnapshot.durationsMs).toEqual({ node_execution: [12] });
    expect(JSON.parse(JSON.stringify(recorder.snapshot()))).toEqual(recorder.snapshot());
  });

  it('reinitializes the singleton and shared health metrics without a production reset hook', async () => {
    const firstModule = await import('../src/utils/metrics.js');
    firstModule.dagMetrics.incrementCounter('node_success');
    firstModule.dagMetrics.recordDuration('node_execution', 7);

    jest.resetModules();

    const secondModule = await import('../src/utils/metrics.js');
    const { healthMetrics } = await import('../src/platform/logging/logger.js');
    expect(secondModule.dagMetrics).not.toBe(firstModule.dagMetrics);
    expect(secondModule.dagMetrics.snapshot()).toEqual({ counters: {}, gauges: {}, durationsMs: {} });
    expect(healthMetrics.getMetrics()).toEqual({});
    expect(firstModule.dagMetrics.snapshot().counters).toEqual({ node_success: 1 });
  });
});

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { DagMetricsRecorder } from '../src/shared/dag/dagMetricsCore.js';

const actual = await import('../src/shared/dag/dagMetricsCore.js');
const createRecorder = jest.fn(actual.createDagMetricsRecorderCore);
jest.unstable_mockModule('../src/shared/dag/dagMetricsCore.js', () => ({
  ...actual,
  createDagMetricsRecorderCore: createRecorder
}));
const {
  assertDagMetricsRetentionPreviewFixture,
  DAG_METRICS_RETENTION_PREVIEW_VERSION
} = await import('../src/shared/dag/dagMetricsPreviewFixture.js');

const FAILURE = 'DAG_METRICS_RETENTION_PREVIEW_FIXTURE_FAILED';

function retainedDurations(recorder: DagMetricsRecorder): Map<string, unknown> {
  return (recorder as unknown as { durationsMs: Map<string, unknown> }).durationsMs;
}

describe('sealed production DAG metrics retention fixture', () => {
  beforeEach(() => createRecorder.mockReset().mockImplementation(actual.createDagMetricsRecorderCore));

  it('executes repeatable fixed observations against the production core with isolated state', () => {
    expect(assertDagMetricsRetentionPreviewFixture()).toBeUndefined();
    expect(assertDagMetricsRetentionPreviewFixture()).toBeUndefined();
    expect(DAG_METRICS_RETENTION_PREVIEW_VERSION).toBe('dag-metrics-retention/v1');
    expect(createRecorder).toHaveBeenCalledTimes(4);
    const first = createRecorder.mock.results[0].value as DagMetricsRecorder;
    const second = createRecorder.mock.results[2].value as DagMetricsRecorder;
    expect(first).not.toBe(second);
    expect(first.snapshot().counters).toEqual({ node_success: 15_000, node_failure: 30_000 });
  });

  it.each(['append history', 'hide history in latest-only output', 'trim history during snapshot'])(
    'rejects %s before any snapshot can conceal retained observations', mode => {
      const snapshotCalls = jest.fn();
      createRecorder.mockImplementation(sink => {
        const recorder = actual.createDagMetricsRecorderCore(sink);
        const storage = retainedDurations(recorder);
        const snapshot = recorder.snapshot.bind(recorder);
        recorder.recordDuration = (metricName, durationMs) => {
          const history = (storage.get(metricName) ?? []) as number[];
          history.push(durationMs);
          storage.set(metricName, history);
          sink(`dag.duration.${metricName}`, durationMs);
        };
        recorder.snapshot = () => {
          snapshotCalls();
          if (mode === 'trim history during snapshot') {
            for (const [name, history] of storage) {
              storage.set(name, (history as number[]).at(-1));
            }
          }
          const result = snapshot();
          if (mode === 'hide history in latest-only output') {
            result.durationsMs = Object.fromEntries([...storage].map(([name, history]) => [
              name, [(history as number[]).at(-1)!]
            ]));
          }
          return result;
        };
        return recorder;
      });
      expect(assertDagMetricsRetentionPreviewFixture).toThrow(FAILURE);
      expect(snapshotCalls).not.toHaveBeenCalled();
    }
  );

  it('rejects latest values that incorrectly discard zero observations', () => {
    createRecorder.mockImplementation(sink => {
      const recorder = actual.createDagMetricsRecorderCore(sink);
      const recordDuration = recorder.recordDuration.bind(recorder);
      recorder.recordDuration = (name, durationMs) => {
        if (durationMs) recordDuration(name, durationMs);
      };
      return recorder;
    });
    expect(assertDagMetricsRetentionPreviewFixture).toThrow(FAILURE);
  });

  it('rejects a health sink that silently drops duration forwarding', () => {
    createRecorder.mockImplementation(sink => actual.createDagMetricsRecorderCore((name, value) => {
      if (!name.startsWith('dag.duration.')) sink(name, value);
    }));
    expect(assertDagMetricsRetentionPreviewFixture).toThrow(FAILURE);
  });

  it('rejects counters that stop accumulating', () => {
    createRecorder.mockImplementation(sink => {
      const recorder = actual.createDagMetricsRecorderCore(sink);
      const increment = recorder.incrementCounter.bind(recorder);
      recorder.incrementCounter = (name, amount) => {
        if (!recorder.snapshot().counters[name]) increment(name, amount);
      };
      return recorder;
    });
    expect(assertDagMetricsRetentionPreviewFixture).toThrow(FAILURE);
  });

  it('rejects shared duration arrays even when snapshots show the latest value', () => {
    createRecorder.mockImplementation(sink => {
      const recorder = actual.createDagMetricsRecorderCore(sink);
      const snapshot = recorder.snapshot.bind(recorder);
      const sharedDurations = new Map<string, number[]>();
      recorder.snapshot = () => {
        const result = snapshot();
        for (const [name, values] of Object.entries(result.durationsMs)) {
          const shared = sharedDurations.get(name) ?? [];
          shared[0] = values[0];
          sharedDurations.set(name, shared);
          result.durationsMs[name] = shared;
        }
        return result;
      };
      return recorder;
    });
    expect(assertDagMetricsRetentionPreviewFixture).toThrow(FAILURE);
  });

  it('rejects factory calls that accidentally share recorder state', () => {
    createRecorder.mockImplementation(sink => {
      const recorder = actual.createDagMetricsRecorderCore(sink);
      createRecorder.mockImplementation(() => recorder);
      return recorder;
    });
    expect(assertDagMetricsRetentionPreviewFixture).toThrow(FAILURE);
  });
});

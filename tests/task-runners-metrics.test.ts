import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { DagNodeJobInput } from '../src/jobs/jobSchema.js';
import type { DagTaskRunnerDependencies } from '../src/workers/taskRunners.js';

describe('runDagNodeJob production-default metrics', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps the real singleton bounded across 5,001 successful and 5,001 failed DAG jobs', async () => {
    const { runDagNodeJob } = await import('../src/workers/taskRunners.js');
    const { dagAgentManager } = await import('../src/agents/agentManager.js');
    const { dagMetrics } = await import('../src/utils/metrics.js');
    const { healthMetrics } = await import('../src/platform/logging/logger.js');
    let now = 1_000;
    let durationMs = 0;
    let fail = false;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    dagAgentManager.registerAgent('metrics-retention-test', async () => {
      now += durationMs;
      if (fail) {
        throw new Error('Expected metrics fixture failure.');
      }
      return { result: 'Completed metrics fixture.' };
    });
    // Deliberately omit metrics: this must use the production-default singleton.
    const dependencies: DagTaskRunnerDependencies = {
      runPrompt: async () => {
        throw new Error('The metrics fixture must not call a provider.');
      },
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      },
      artifactStore: {
        writeArtifact: async () => 'metrics-fixture-artifact',
        readArtifact: async () => {
          throw new Error('The metrics fixture has no dependency artifacts.');
        }
      }
    };
    const jobInput: DagNodeJobInput = {
      dagId: 'dagrun_metrics_fixture',
      node: {
        id: 'metrics-node',
        type: 'agent',
        dependencies: [],
        executionKey: 'metrics-retention-test'
      },
      payload: {},
      dependencyResults: {},
      sharedState: {},
      depth: 0,
      attempt: 0,
      maxRetries: 0,
      waitingTimeoutMs: 60_000
    };
    const jobsPerStatus = 5_001;
    expect(dagMetrics.snapshot()).toEqual({ counters: {}, gauges: {}, durationsMs: {} });

    for (let index = 0; index < jobsPerStatus; index += 1) {
      jobInput.dagId = `dagrun_metrics_fixture_${index}`;
      fail = false;
      durationMs = index % 23;
      const success = await runDagNodeJob(jobInput, dependencies);
      expect(success.status).toBe('success');
      expect(success.metrics?.durationMs).toBe(durationMs);

      fail = true;
      durationMs = index % 17;
      const failure = await runDagNodeJob(jobInput, dependencies);
      expect(failure.status).toBe('failed');
      expect(failure.output).toMatchObject({ durationMs });
    }

    const snapshot = dagMetrics.snapshot();
    expect(snapshot.counters).toEqual({ node_success: jobsPerStatus, node_failure: jobsPerStatus });
    expect(Object.values(snapshot.durationsMs).map(samples => samples.length)).toEqual([1, 1]);
    expect(snapshot.durationsMs).toEqual({
      node_execution: [(jobsPerStatus - 1) % 23],
      node_execution_failed: [(jobsPerStatus - 1) % 17]
    });
    expect(healthMetrics.getMetrics()).toMatchObject({
      'dag.counter.node_success': { value: jobsPerStatus },
      'dag.counter.node_failure': { value: jobsPerStatus },
      'dag.duration.node_execution': { value: (jobsPerStatus - 1) % 23 },
      'dag.duration.node_execution_failed': { value: (jobsPerStatus - 1) % 17 }
    });
  });
});

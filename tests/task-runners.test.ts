import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { dagAgentManager } from '../src/agents/agentManager.js';
import type { DagNodeJobInput } from '../src/jobs/jobSchema.js';
import { runDagNodeJob } from '../src/workers/taskRunners.js';

const TEST_AUDIT_EXECUTION_KEY = 'audit-regression-test';

function buildDagNodeJobInput(): DagNodeJobInput {
  return {
    dagId: 'dagrun_regression_1',
    node: {
      id: 'audit',
      type: 'agent',
      dependencies: ['planner', 'build'],
      executionKey: TEST_AUDIT_EXECUTION_KEY,
      metadata: {
        jobType: 'verify'
      }
    },
    payload: {
      prompt: 'Validate the DAG verification output using the provided dependency outputs.'
    },
    dependencyResults: {},
    sharedState: {
      sessionId: 'session-1'
    },
    depth: 1,
    attempt: 0,
    maxRetries: 2,
    waitingTimeoutMs: 60_000
  };
}

describe('runDagNodeJob', () => {
  beforeEach(() => {
    dagAgentManager.registerAgent(TEST_AUDIT_EXECUTION_KEY, async () => ({
      result: 'Validated the provided dependency outputs and found the DAG structurally consistent.',
      reasoningHonesty: {
        responseMode: 'answer'
      },
      auditSafe: {
        auditFlags: ['VERIFY_OUTPUT_NORMALIZED']
      }
    }));
  });

  it('normalizes DAG verification worker output to include a stable summary field', async () => {
    const writeArtifactMock = jest.fn().mockResolvedValue('artifact-ref');
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };
    const metrics = {
      incrementCounter: jest.fn(),
      recordGauge: jest.fn(),
      recordDuration: jest.fn(),
      snapshot: jest.fn(() => ({
        counters: {},
        gauges: {},
        durationsMs: {}
      }))
    };

    const result = await runDagNodeJob(buildDagNodeJobInput(), {
      runPrompt: jest.fn(),
      logger,
      metrics,
      artifactStore: {
        writeArtifact: writeArtifactMock,
        readArtifact: jest.fn()
      }
    });

    expect(result.status).toBe('success');
    expect(result.output).toMatchObject({
      result: 'Validated the provided dependency outputs and found the DAG structurally consistent.',
      summary: 'Validated the provided dependency outputs and found the DAG structurally consistent.'
    });
    expect(writeArtifactMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        summary: 'Validated the provided dependency outputs and found the DAG structurally consistent.'
      })
    }));
    expect(logger.info).toHaveBeenCalledWith('DAG verification node output', expect.objectContaining({
      dagId: 'dagrun_regression_1',
      nodeId: 'audit',
      summaryPreview: expect.stringContaining('Validated the provided dependency outputs')
    }));
  });
});

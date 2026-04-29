import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { dagAgentManager } from '../src/agents/agentManager.js';
import type { DagNodeJobInput } from '../src/jobs/jobSchema.js';
import { runDagNodeJob } from '../src/workers/taskRunners.js';

const TEST_AUDIT_EXECUTION_KEY = 'audit-regression-test';
const TEST_PLANNER_EXECUTION_KEY = 'planner-regression-test';

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

function buildPlannerDagNodeJobInput(): DagNodeJobInput {
  return {
    dagId: 'dagrun_planner_1',
    node: {
      id: 'planner',
      type: 'agent',
      dependencies: [],
      executionKey: TEST_PLANNER_EXECUTION_KEY
    },
    payload: {
      prompt: 'Create the execution plan.'
    },
    dependencyResults: {},
    sharedState: {
      sessionId: 'session-planner-1'
    },
    depth: 0,
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
    dagAgentManager.registerAgent(TEST_PLANNER_EXECUTION_KEY, async (_context, helpers) => {
      return helpers.runPrompt('Create the execution plan.', {
        sourceEndpoint: 'dag.agent.planner'
      });
    });
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

  it('surfaces structured planner failure metadata and marks the result as non-retryable after planner retries exhaust', async () => {
    const plannerError = new Error('Request was aborted.') as Error & {
      plannerExecution?: Record<string, unknown>;
    };
    plannerError.plannerExecution = {
      sourceEndpoint: 'dag.agent.planner',
      timeoutMs: 90_000,
      maxRetries: 2,
      retryBackoffMs: 500,
      attemptsUsed: 3,
      durationMs: 12_345,
      finalFailureClassification: 'abort',
      transientFailure: true,
      retryable: false,
      errorName: 'AbortError',
      errorMessage: 'Request was aborted.'
    };

    const result = await runDagNodeJob(buildPlannerDagNodeJobInput(), {
      runPrompt: jest.fn().mockRejectedValue(plannerError),
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
      },
      metrics: {
        incrementCounter: jest.fn(),
        recordGauge: jest.fn(),
        recordDuration: jest.fn(),
        snapshot: jest.fn(() => ({
          counters: {},
          gauges: {},
          durationsMs: {}
        }))
      },
      artifactStore: {
        writeArtifact: jest.fn().mockResolvedValue('planner-failure-artifact'),
        readArtifact: jest.fn()
      }
    });

    expect(result.status).toBe('failed');
    expect(result.retryable).toBe(false);
    expect(result.output).toMatchObject({
      errorMessage: 'Request was aborted.',
      errorName: 'AbortError',
      durationMs: 12_345,
      retryCountUsed: 2,
      finalFailureClassification: 'abort',
      transientFailure: true,
      retryable: false,
      plannerExecution: expect.objectContaining({
        attemptsUsed: 3,
        timeoutMs: 90_000
      })
    });
  });

  it('fails closed when a queued DAG node references an unknown execution key', async () => {
    const runPromptMock = jest.fn();
    const writeArtifactMock = jest.fn().mockResolvedValue('missing-handler-artifact');

    const result = await runDagNodeJob(
      {
        ...buildDagNodeJobInput(),
        node: {
          id: 'missing-handler',
          type: 'agent',
          dependencies: [],
          executionKey: 'missing-handler-regression-test'
        },
        payload: {},
        dependencyResults: {}
      },
      {
        runPrompt: runPromptMock,
        logger: {
          debug: jest.fn(),
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn()
        },
        metrics: {
          incrementCounter: jest.fn(),
          recordGauge: jest.fn(),
          recordDuration: jest.fn(),
          snapshot: jest.fn(() => ({
            counters: {},
            gauges: {},
            durationsMs: {}
          }))
        },
        artifactStore: {
          writeArtifact: writeArtifactMock,
          readArtifact: jest.fn()
        }
      }
    );

    expect(result).toMatchObject({
      nodeId: 'missing-handler',
      status: 'failed',
      errorMessage: 'No DAG agent handler registered for executionKey="missing-handler-regression-test".',
      artifactRef: 'missing-handler-artifact'
    });
    expect(runPromptMock).not.toHaveBeenCalled();
    expect(writeArtifactMock).toHaveBeenCalledWith(expect.objectContaining({
      artifactKind: 'failure',
      nodeId: 'missing-handler',
      payload: expect.objectContaining({
        errorMessage: 'No DAG agent handler registered for executionKey="missing-handler-regression-test".'
      })
    }));
  });
});

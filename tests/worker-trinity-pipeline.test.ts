import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runThroughBrainMock = jest.fn();
const createRuntimeBudgetWithLimitMock = jest.fn(() => ({ budgetId: 'runtime-budget' }));
const getWorkerExecutionLimitsMock = jest.fn(() => ({
  workerTrinityRuntimeBudgetMs: 420_000,
  workerTrinityStageTimeoutMs: 180_000,
  dagMaxTokenBudget: 250_000,
  dagNodeTimeoutMs: 420_000,
  dagQueueClaimGraceMs: 120_000
}));

jest.unstable_mockModule('@core/logic/trinity.js', () => ({
  runThroughBrain: runThroughBrainMock
}));

jest.unstable_mockModule('@platform/resilience/runtimeBudget.js', () => ({
  createRuntimeBudgetWithLimit: createRuntimeBudgetWithLimitMock
}));

jest.unstable_mockModule('../src/workers/workerExecutionLimits.js', () => ({
  getWorkerExecutionLimits: getWorkerExecutionLimitsMock
}));

const { runWorkerTrinityPrompt } = await import('../src/workers/trinityWorkerPipeline.js');

describe('runWorkerTrinityPrompt', () => {
  beforeEach(() => {
    runThroughBrainMock.mockReset();
    createRuntimeBudgetWithLimitMock.mockClear();
    getWorkerExecutionLimitsMock.mockClear();
    runThroughBrainMock.mockResolvedValue({ result: 'ok' });
  });

  it('forwards worker routing metadata into Trinity', async () => {
    const openaiClient = {} as never;

    await runWorkerTrinityPrompt(openaiClient, {
      prompt: 'Audit the DAG output',
      sessionId: 'session-123',
      tokenAuditSessionId: 'session-123:dag:run-1:audit:a0',
      overrideAuditSafe: 'allow',
      cognitiveDomain: 'diagnostic',
      sourceEndpoint: 'dag.agent.audit'
    });

    expect(createRuntimeBudgetWithLimitMock).toHaveBeenCalledTimes(1);
    expect(runThroughBrainMock).toHaveBeenCalledWith(
      openaiClient,
      'Audit the DAG output',
      'session-123',
      'allow',
      {
        cognitiveDomain: 'diagnostic',
        sourceEndpoint: 'dag.agent.audit',
        tokenAuditSessionId: 'session-123:dag:run-1:audit:a0',
        watchdogModelTimeoutMs: 180_000
      },
      { budgetId: 'runtime-budget' }
    );
    expect(createRuntimeBudgetWithLimitMock).toHaveBeenCalledWith(420_000);
  });

  it('applies the default worker source endpoint when the caller omits one', async () => {
    const openaiClient = {} as never;

    await runWorkerTrinityPrompt(openaiClient, {
      prompt: 'Research the latest deployment logs'
    });

    expect(runThroughBrainMock).toHaveBeenCalledWith(
      openaiClient,
      'Research the latest deployment logs',
      undefined,
      undefined,
      {
        cognitiveDomain: undefined,
        sourceEndpoint: 'worker.dispatch',
        watchdogModelTimeoutMs: 180_000
      },
      { budgetId: 'runtime-budget' }
    );
  });
});

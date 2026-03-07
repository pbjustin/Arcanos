import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runThroughBrainMock = jest.fn();
const createRuntimeBudgetMock = jest.fn(() => ({ budgetId: 'runtime-budget' }));

jest.unstable_mockModule('@core/logic/trinity.js', () => ({
  runThroughBrain: runThroughBrainMock
}));

jest.unstable_mockModule('@platform/resilience/runtimeBudget.js', () => ({
  createRuntimeBudget: createRuntimeBudgetMock
}));

const { runWorkerTrinityPrompt } = await import('../src/workers/trinityWorkerPipeline.js');

describe('runWorkerTrinityPrompt', () => {
  beforeEach(() => {
    runThroughBrainMock.mockReset();
    createRuntimeBudgetMock.mockClear();
    runThroughBrainMock.mockResolvedValue({ result: 'ok' });
  });

  it('forwards worker routing metadata into Trinity', async () => {
    const openaiClient = {} as never;

    await runWorkerTrinityPrompt(openaiClient, {
      prompt: 'Audit the DAG output',
      sessionId: 'session-123',
      overrideAuditSafe: 'allow',
      cognitiveDomain: 'diagnostic',
      sourceEndpoint: 'dag.agent.audit'
    });

    expect(createRuntimeBudgetMock).toHaveBeenCalledTimes(1);
    expect(runThroughBrainMock).toHaveBeenCalledWith(
      openaiClient,
      'Audit the DAG output',
      'session-123',
      'allow',
      {
        cognitiveDomain: 'diagnostic',
        sourceEndpoint: 'dag.agent.audit'
      },
      { budgetId: 'runtime-budget' }
    );
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
        sourceEndpoint: 'worker.dispatch'
      },
      { budgetId: 'runtime-budget' }
    );
  });
});

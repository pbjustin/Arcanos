import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runWorkerPromptMock = jest.fn();

const { createDagNodeRunPromptBridge } = await import('../src/workers/dagNodePromptBridge.js');

describe('createDagNodeRunPromptBridge', () => {
  beforeEach(() => {
    runWorkerPromptMock.mockReset();
    runWorkerPromptMock.mockResolvedValue({ result: 'ok' });
  });

  it('forwards DAG capability flags into the worker Trinity request', async () => {
    const openaiClient = {} as never;
    const runPrompt = createDagNodeRunPromptBridge(openaiClient, {
      runWorkerPrompt: runWorkerPromptMock
    });

    await runPrompt('Validate the provided dependency outputs.', {
      sessionId: 'session-123',
      tokenAuditSessionId: 'session-123:dag:run-1:audit:a0',
      overrideAuditSafe: 'allow',
      cognitiveDomain: 'diagnostic',
      toolBackedCapabilities: {
        verifyProvidedData: true
      },
      sourceEndpoint: 'dag.agent.audit'
    });

    expect(runWorkerPromptMock).toHaveBeenCalledWith(openaiClient, {
      prompt: 'Validate the provided dependency outputs.',
      sessionId: 'session-123',
      tokenAuditSessionId: 'session-123:dag:run-1:audit:a0',
      overrideAuditSafe: 'allow',
      cognitiveDomain: 'diagnostic',
      toolBackedCapabilities: {
        verifyProvidedData: true
      },
      sourceEndpoint: 'dag.agent.audit'
    });
  });

  it('omits empty capability metadata when the agent did not declare any', async () => {
    const openaiClient = {} as never;
    const runPrompt = createDagNodeRunPromptBridge(openaiClient, {
      runWorkerPrompt: runWorkerPromptMock
    });

    await runPrompt('Summarize the planner output.', {
      sourceEndpoint: 'dag.agent.writer'
    });

    expect(runWorkerPromptMock).toHaveBeenCalledWith(openaiClient, {
      prompt: 'Summarize the planner output.',
      sessionId: undefined,
      tokenAuditSessionId: undefined,
      overrideAuditSafe: undefined,
      cognitiveDomain: undefined,
      sourceEndpoint: 'dag.agent.writer'
    });
  });
});

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runWorkerPromptMock = jest.fn();

const { createDagNodeRunPromptBridge } = await import('../src/workers/dagNodePromptBridge.js');
const { isTrinityDagGptAccessEnabled } = await import('../src/services/trinity/adapter.js');

describe('createDagNodeRunPromptBridge', () => {
  beforeEach(() => {
    runWorkerPromptMock.mockReset();
    runWorkerPromptMock.mockResolvedValue({ result: 'ok' });
  });

  it('forwards DAG capability flags into the worker Trinity request', async () => {
    const openaiClient = {} as never;
    const runPrompt = createDagNodeRunPromptBridge(openaiClient, {
      runWorkerPrompt: runWorkerPromptMock,
      useGptAccess: false
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
      runWorkerPrompt: runWorkerPromptMock,
      useGptAccess: false
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

  it('routes DAG prompts through GPT Access when enabled', async () => {
    const openaiClient = {} as never;
    const routeViaGptAccessMock = jest.fn(async () => ({ result: 'via-gateway' }));
    const runPrompt = createDagNodeRunPromptBridge(openaiClient, {
      runWorkerPrompt: runWorkerPromptMock,
      routeViaGptAccess: routeViaGptAccessMock,
      useGptAccess: true
    });

    const result = await runPrompt('Plan the DAG execution.', {
      sessionId: 'session-123',
      tokenAuditSessionId: 'session-123:dag:run-1:planner:a0',
      dagId: 'dagrun_123',
      nodeId: 'planner',
      executionKey: 'planner',
      nodeMetadata: {
        pipeline: 'trinity',
        pipelineTemplate: 'trinity-core'
      },
      attempt: 0,
      sourceEndpoint: 'dag.agent.planner'
    });

    expect(result).toEqual({ result: 'via-gateway' });
    expect(routeViaGptAccessMock).toHaveBeenCalledWith({
      prompt: 'Plan the DAG execution.',
      options: expect.objectContaining({
        dagId: 'dagrun_123',
        nodeId: 'planner',
        executionKey: 'planner',
        sourceEndpoint: 'dag.agent.planner'
      }),
      config: undefined
    });
    expect(runWorkerPromptMock).not.toHaveBeenCalled();
  });

  it('only enables implicit GPT Access routing when nested queue capacity is available', () => {
    expect(isTrinityDagGptAccessEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isTrinityDagGptAccessEnabled({ WORKER_COUNT: '1' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isTrinityDagGptAccessEnabled({ JOB_WORKER_CONCURRENCY: '2' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isTrinityDagGptAccessEnabled({
      TRINITY_DAG_GPT_ACCESS_ENABLED: 'true',
      WORKER_COUNT: '1'
    } as NodeJS.ProcessEnv)).toBe(true);
  });
});

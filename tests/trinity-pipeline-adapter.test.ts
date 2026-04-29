import { describe, expect, it, jest } from '@jest/globals';

const {
  TRINITY_CORE_DAG_TEMPLATE_NAME
} = await import('../src/dag/templates.js');
const {
  TrinityPipelineAdapterError,
  compilePipelineToDag,
  createArcanosCoreJob,
  enqueueDagRun,
  isTrinityDagGptAccessEnabled,
  resolveTrinityPipeline,
  routeDagNodeToGptAccess
} = await import('../src/services/trinity/adapter.js');

describe('trinity pipeline adapter', () => {
  it('enables DAG GPT Access routing only when explicitly enabled or worker capacity is safe', () => {
    expect(isTrinityDagGptAccessEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isTrinityDagGptAccessEnabled({
      JOB_WORKER_CONCURRENCY: '2'
    } as NodeJS.ProcessEnv)).toBe(true);
    expect(isTrinityDagGptAccessEnabled({
      TRINITY_DAG_GPT_ACCESS_ENABLED: 'false'
    } as NodeJS.ProcessEnv)).toBe(false);
    expect(isTrinityDagGptAccessEnabled({
      TRINITY_PIPELINE_GPT_ACCESS_ENABLED: '1'
    } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('resolves the canonical Trinity pipeline and default core GPT IDs', () => {
    const pipeline = resolveTrinityPipeline({
      pipelineId: 'default',
      input: {
        goal: 'Verify the adapter.'
      }
    });

    expect(pipeline).toEqual(expect.objectContaining({
      pipelineId: 'trinity',
      template: TRINITY_CORE_DAG_TEMPLATE_NAME,
      gptId: 'arcanos-core',
      input: expect.objectContaining({
        goal: 'Verify the adapter.',
        pipeline: 'trinity',
        pipelineTemplate: TRINITY_CORE_DAG_TEMPLATE_NAME,
        gptId: 'arcanos-core'
      })
    }));

    expect(resolveTrinityPipeline({ gptId: 'core' }).gptId).toBe('core');
  });

  it('fails clearly for unknown Trinity GPT IDs', () => {
    expect(() => resolveTrinityPipeline({ gptId: 'unknown' })).toThrow(TrinityPipelineAdapterError);
    expect(() => resolveTrinityPipeline({ gptId: 'unknown' })).toThrow(
      'Trinity pipeline requires an allowed GPT ID'
    );
  });

  it('compiles a resolved Trinity pipeline to the DAG run contract', () => {
    const pipeline = resolveTrinityPipeline({
      sessionId: 'session-123',
      template: 'planner-research-build-audit-writer',
      input: {
        prompt: 'Build and audit a release plan.'
      }
    });
    const compiled = compilePipelineToDag(pipeline);

    expect(compiled.createRunRequest).toEqual({
      sessionId: 'session-123',
      template: TRINITY_CORE_DAG_TEMPLATE_NAME,
      input: expect.objectContaining({
        prompt: 'Build and audit a release plan.',
        pipeline: 'trinity',
        pipelineTemplate: TRINITY_CORE_DAG_TEMPLATE_NAME
      })
    });
    expect(compiled.templateDefinition.graph.entrypoints).toEqual(['planner']);
    expect(compiled.templateDefinition.graph.nodes.planner.metadata).toEqual(expect.objectContaining({
      pipeline: 'trinity',
      pipelineTemplate: TRINITY_CORE_DAG_TEMPLATE_NAME,
      agentRole: 'planner',
      jobType: 'plan'
    }));
  });

  it('enqueues compiled DAG runs with request metadata', async () => {
    const compiled = compilePipelineToDag(resolveTrinityPipeline({
      sessionId: 'session-123',
      input: { goal: 'Create the DAG.' }
    }));
    const createDagRunMock = jest.fn(async (request) => ({
      pipeline: 'trinity',
      trinity_version: '1.0',
      runId: 'dagrun_1',
      sessionId: request.sessionId,
      template: request.template,
      status: 'queued',
      createdAt: '2026-04-28T00:00:00.000Z',
      updatedAt: '2026-04-28T00:00:00.000Z'
    }));

    const run = await enqueueDagRun(compiled, {
      requestId: 'req-123',
      traceId: 'trace-123'
    }, {
      createDagRun: createDagRunMock
    });

    expect(run.runId).toBe('dagrun_1');
    expect(createDagRunMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-123',
      template: TRINITY_CORE_DAG_TEMPLATE_NAME,
      input: expect.objectContaining({
        goal: 'Create the DAG.',
        requestId: 'req-123',
        traceId: 'trace-123'
      })
    }));
  });

  it('creates Arcanos core jobs through GPT Access job creation', async () => {
    const createAiJobMock = jest.fn(async () => ({
      statusCode: 202,
      payload: {
        ok: true,
        jobId: '11111111-1111-4111-8111-111111111111',
        traceId: 'trace-123',
        status: 'queued',
        deduped: false,
        resultEndpoint: '/gpt-access/jobs/result'
      }
    }));

    const job = await createArcanosCoreJob({
      gptId: 'core',
      task: 'Run the core prompt.',
      input: {
        pipeline: 'trinity'
      }
    }, {
      actorKey: 'test-actor',
      requestId: 'req-123',
      traceId: 'trace-123',
      createAiJob: createAiJobMock
    });

    expect(job).toEqual({
      jobId: '11111111-1111-4111-8111-111111111111',
      gptId: 'core',
      status: 'queued',
      traceId: 'trace-123',
      resultEndpoint: '/gpt-access/jobs/result',
      deduped: false
    });
    expect(createAiJobMock).toHaveBeenCalledWith({
      gptId: 'core',
      task: 'Run the core prompt.',
      input: {
        pipeline: 'trinity'
      },
      maxOutputTokens: 2048
    }, expect.objectContaining({
      actorKey: 'test-actor',
      requestId: 'req-123',
      traceId: 'trace-123'
    }));
  });

  it('routes DAG node prompts through GPT Access and unwraps the Arcanos core envelope', async () => {
    const createAiJobMock = jest.fn(async () => ({
      statusCode: 202,
      payload: {
        ok: true,
        jobId: '22222222-2222-4222-8222-222222222222',
        traceId: 'trace-456',
        status: 'queued',
        deduped: false,
        resultEndpoint: '/gpt-access/jobs/result'
      }
    }));
    const getJobResultMock = jest.fn(async () => ({
      statusCode: 200,
      payload: {
        ok: true,
        jobId: '22222222-2222-4222-8222-222222222222',
        status: 'completed',
        result: {
          ok: true,
          result: {
            result: 'core output',
            summary: 'core output'
          },
          _route: {
            module: 'ARCANOS:CORE'
          }
        },
        error: null
      }
    }));

    const result = await routeDagNodeToGptAccess({
      prompt: 'Audit the DAG output.',
      options: {
        sessionId: 'session-123',
        tokenAuditSessionId: 'session-123:dag:run-1:audit:a0',
        dagId: 'dagrun_1',
        nodeId: 'audit',
        executionKey: 'audit',
        attempt: 0,
        cognitiveDomain: 'diagnostic',
        toolBackedCapabilities: {
          verifyProvidedData: true
        },
        sourceEndpoint: 'dag.agent.audit'
      },
      config: {
        requestId: 'req-456',
        traceId: 'trace-456',
        waitForResultMs: 10,
        pollIntervalMs: 1,
        createAiJob: createAiJobMock,
        getJobResult: getJobResultMock
      }
    });

    expect(result).toEqual({
      result: 'core output',
      summary: 'core output'
    });
    expect(createAiJobMock).toHaveBeenCalledWith(expect.objectContaining({
      gptId: 'arcanos-core',
      task: 'Audit the DAG output.',
      input: expect.objectContaining({
        pipeline: 'trinity',
        template: TRINITY_CORE_DAG_TEMPLATE_NAME,
        dagId: 'dagrun_1',
        nodeId: 'audit',
        executionKey: 'audit',
        sourceEndpoint: 'dag.agent.audit',
        tokenAuditSessionId: 'session-123:dag:run-1:audit:a0',
        toolBackedCapabilities: {
          verifyProvidedData: true
        }
      })
    }), expect.objectContaining({
      requestId: 'req-456',
      traceId: 'trace-456'
    }));
    expect(getJobResultMock).toHaveBeenCalledWith({
      jobId: '22222222-2222-4222-8222-222222222222',
      traceId: 'trace-456'
    });
  });
});

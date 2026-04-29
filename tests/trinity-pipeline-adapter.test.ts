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
      JOB_WORKER_CONCURRENCY: '2',
      DAG_MAX_CONCURRENT_NODES: '1'
    } as NodeJS.ProcessEnv)).toBe(true);
    expect(isTrinityDagGptAccessEnabled({
      TRINITY_DAG_GPT_ACCESS_ENABLED: 'false'
    } as NodeJS.ProcessEnv)).toBe(false);
    expect(isTrinityDagGptAccessEnabled({
      TRINITY_PIPELINE_GPT_ACCESS_ENABLED: '1',
      JOB_WORKER_CONCURRENCY: '2',
      DAG_MAX_CONCURRENT_NODES: '1'
    } as NodeJS.ProcessEnv)).toBe(true);
    expect(() => isTrinityDagGptAccessEnabled({
      TRINITY_DAG_GPT_ACCESS_ENABLED: 'true',
      WORKER_COUNT: '1'
    } as NodeJS.ProcessEnv)).toThrow('requires JOB_WORKER_CONCURRENCY or WORKER_COUNT to be at least DAG_MAX_CONCURRENT_NODES + 1');
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
    expect(resolveTrinityPipeline({ pipelineId: 'trinity' })).toEqual(expect.objectContaining({
      pipelineId: 'trinity',
      template: TRINITY_CORE_DAG_TEMPLATE_NAME
    }));
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
    }, expect.objectContaining({
      actorKey: 'system:trinity-pipeline-adapter',
      requestId: 'req-456',
      traceId: 'trace-456'
    }));
  });

  it('throws when the completed GPT Access result contains a failed inner envelope', async () => {
    const createAiJobMock = jest.fn(async () => ({
      statusCode: 202,
      payload: {
        ok: true,
        jobId: '33333333-3333-4333-8333-333333333333',
        traceId: 'trace-789',
        status: 'queued',
        deduped: false,
        resultEndpoint: '/gpt-access/jobs/result'
      }
    }));
    const getJobResultMock = jest.fn(async () => ({
      statusCode: 200,
      payload: {
        ok: true,
        jobId: '33333333-3333-4333-8333-333333333333',
        status: 'completed',
        result: {
          ok: false,
          error: {
            code: 'MODULE_TIMEOUT',
            message: 'The inner dispatcher timed out.'
          }
        },
        error: null
      }
    }));

    await expect(routeDagNodeToGptAccess({
      prompt: 'Audit the DAG output.',
      options: {
        sourceEndpoint: 'dag.agent.audit'
      },
      config: {
        requestId: 'req-789',
        traceId: 'trace-789',
        waitForResultMs: 10,
        pollIntervalMs: 1,
        createAiJob: createAiJobMock,
        getJobResult: getJobResultMock
      }
    })).rejects.toMatchObject({
      code: 'TRINITY_INNER_EXECUTION_FAILED',
      message: 'The inner dispatcher timed out.'
    });
  });

  it('propagates GPT Access job-result gateway failures', async () => {
    const createAiJobMock = jest.fn(async () => ({
      statusCode: 202,
      payload: {
        ok: true,
        jobId: '44444444-4444-4444-8444-444444444444',
        traceId: 'trace-result-failure',
        status: 'queued',
        deduped: false,
        resultEndpoint: '/gpt-access/jobs/result'
      }
    }));
    const getJobResultMock = jest.fn(async () => ({
      statusCode: 503,
      payload: {
        ok: false,
        error: {
          code: 'GPT_ACCESS_JOBS_UNAVAILABLE',
          message: 'Result backend unavailable.'
        }
      }
    }));

    await expect(routeDagNodeToGptAccess({
      prompt: 'Audit the DAG output.',
      options: {
        sourceEndpoint: 'dag.agent.audit'
      },
      config: {
        requestId: 'req-result-failure',
        traceId: 'trace-result-failure',
        waitForResultMs: 10,
        pollIntervalMs: 1,
        createAiJob: createAiJobMock,
        getJobResult: getJobResultMock
      }
    })).rejects.toMatchObject({
      code: 'GPT_ACCESS_JOB_RESULT_FAILED',
      statusCode: 503,
      message: 'Result backend unavailable.'
    });
  });

  it('times out polling when the GPT Access job never reaches a terminal state', async () => {
    const createAiJobMock = jest.fn(async () => ({
      statusCode: 202,
      payload: {
        ok: true,
        jobId: '55555555-5555-4555-8555-555555555555',
        traceId: 'trace-timeout',
        status: 'queued',
        deduped: false,
        resultEndpoint: '/gpt-access/jobs/result'
      }
    }));
    const getJobResultMock = jest.fn(async () => ({
      statusCode: 200,
      payload: {
        ok: true,
        jobId: '55555555-5555-4555-8555-555555555555',
        status: 'pending',
        result: null,
        error: null
      }
    }));
    const cancelJobMock = jest.fn(async () => null);

    await expect(routeDagNodeToGptAccess({
      prompt: 'Wait for a core result.',
      options: {
        sourceEndpoint: 'dag.agent.writer'
      },
      config: {
        requestId: 'req-timeout',
        traceId: 'trace-timeout',
        waitForResultMs: 1,
        pollIntervalMs: 1,
        createAiJob: createAiJobMock,
        getJobResult: getJobResultMock,
        cancelJob: cancelJobMock
      }
    })).rejects.toMatchObject({
      code: 'GPT_ACCESS_JOB_TIMEOUT',
      message: expect.stringContaining('Timed out after 1ms')
    });

    expect(getJobResultMock).toHaveBeenCalled();
    expect(cancelJobMock).toHaveBeenCalledWith(
      '55555555-5555-4555-8555-555555555555',
      expect.stringContaining('timed out')
    );
  });

  it('stops polling when the worker shutdown signal is aborted', async () => {
    const shutdownController = new AbortController();
    const createAiJobMock = jest.fn(async () => ({
      statusCode: 202,
      payload: {
        ok: true,
        jobId: '44444444-4444-4444-8444-444444444444',
        traceId: 'trace-abort',
        status: 'queued',
        deduped: false,
        resultEndpoint: '/gpt-access/jobs/result'
      }
    }));
    const cancelJobMock = jest.fn(async () => null);
    const getJobResultMock = jest.fn(async () => {
      setTimeout(() => shutdownController.abort(new Error('worker shutdown')), 0);
      return {
        statusCode: 200,
        payload: {
          ok: true,
          jobId: '44444444-4444-4444-8444-444444444444',
          status: 'pending',
          result: null,
          error: null
        }
      };
    });

    await expect(routeDagNodeToGptAccess({
      prompt: 'Wait for a core result.',
      options: {
        sourceEndpoint: 'dag.agent.writer'
      },
      config: {
        requestId: 'req-abort',
        traceId: 'trace-abort',
        waitForResultMs: 60_000,
        pollIntervalMs: 60_000,
        abortSignal: shutdownController.signal,
        createAiJob: createAiJobMock,
        getJobResult: getJobResultMock,
        cancelJob: cancelJobMock
      }
    })).rejects.toMatchObject({
      code: 'GPT_ACCESS_JOB_POLL_ABORTED'
    });

    expect(getJobResultMock).toHaveBeenCalledTimes(1);
    expect(cancelJobMock).toHaveBeenCalledWith(
      '44444444-4444-4444-8444-444444444444',
      expect.stringContaining('aborted')
    );
  });
});

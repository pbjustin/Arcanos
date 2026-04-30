import { describe, expect, it, jest } from '@jest/globals';

import {
  classifyOperatorIntent,
  dispatchOperatorRequest,
  type OperatorIntentDispatcherClients
} from '../../src/platform/operator/OperatorIntentDispatcher.js';
import {
  OperatorControlPlaneClient,
  type GptAccessClientResult,
  type GptAccessTransport
} from '../../src/platform/operator/controlPlaneClient.js';
import { type CreateReasoningJobRequest } from '../../src/platform/operator/gptReasoningClient.js';

const COMPLETED_JOB_ID = '11111111-1111-4111-8111-111111111111';

function clientResult(endpoint: string, payload: unknown): GptAccessClientResult {
  return {
    endpoint: endpoint as GptAccessClientResult['endpoint'],
    statusCode: 200,
    payload
  };
}

function buildMockClients(controlPayload: unknown = { ok: true, status: 'healthy' }) {
  const getStatusMock = jest.fn(async () => clientResult('/gpt-access/status', controlPayload));
  const getWorkersStatusMock = jest.fn(async () => clientResult('/gpt-access/workers/status', controlPayload));
  const getWorkerHelperHealthMock = jest.fn(async () => clientResult('/gpt-access/worker-helper/health', controlPayload));
  const runDeepDiagnosticsMock = jest.fn(async () => clientResult('/gpt-access/diagnostics/deep', controlPayload));
  const explainApprovedQueryMock = jest.fn(async () => clientResult('/gpt-access/db/explain', controlPayload));
  const queryLogsMock = jest.fn(async () => clientResult('/gpt-access/logs/query', controlPayload));
  const runMcpToolMock = jest.fn(async () => clientResult('/gpt-access/mcp', controlPayload));
  const getJobResultMock = jest.fn(async () => clientResult('/gpt-access/jobs/result', controlPayload));
  const createReasoningJobMock = jest.fn(async (input: CreateReasoningJobRequest) =>
    clientResult('/gpt-access/jobs/create', {
      ok: true,
      jobId: '22222222-2222-4222-8222-222222222222',
      traceId: 'trace-reasoning',
      status: 'queued',
      resultEndpoint: '/gpt-access/jobs/result',
      received: input
    })
  );
  const getReasoningJobResultMock = jest.fn(async () =>
    clientResult('/gpt-access/jobs/result', {
      ok: true,
      jobId: COMPLETED_JOB_ID,
      status: 'completed'
    })
  );

  const clients: OperatorIntentDispatcherClients = {
    controlPlane: {
      getStatus: getStatusMock,
      getWorkersStatus: getWorkersStatusMock,
      getWorkerHelperHealth: getWorkerHelperHealthMock,
      runDeepDiagnostics: runDeepDiagnosticsMock,
      explainApprovedQuery: explainApprovedQueryMock,
      queryLogs: queryLogsMock,
      runMcpTool: runMcpToolMock,
      getJobResult: getJobResultMock
    },
    reasoning: {
      createReasoningJob: createReasoningJobMock,
      getReasoningJobResult: getReasoningJobResultMock
    }
  };

  return {
    clients,
    mocks: {
      getStatusMock,
      getWorkersStatusMock,
      getWorkerHelperHealthMock,
      runDeepDiagnosticsMock,
      explainApprovedQueryMock,
      queryLogsMock,
      runMcpToolMock,
      getJobResultMock,
      createReasoningJobMock,
      getReasoningJobResultMock
    }
  };
}

describe('OperatorIntentDispatcher', () => {
  it('routes worker, runtime, queue, logs, and job lookup requests to the control plane', () => {
    const prompts = [
      'show worker status',
      'inspect runtime health',
      'inspect queue depth',
      'query backend logs for errors',
      'look up job result for 11111111-1111-4111-8111-111111111111',
      'Railway deployment status for ARCANOS_PROCESS_KIND'
    ];

    for (const prompt of prompts) {
      expect(classifyOperatorIntent(prompt)).toEqual(expect.objectContaining({
        routeKind: 'control_plane',
        selectedTool: expect.not.stringContaining('/gpt/')
      }));
    }
  });

  it('routes normal writing and reasoning requests to GPT reasoning jobs', () => {
    const classification = classifyOperatorIntent('Draft a concise code review summary for this patch.');

    expect(classification).toEqual(expect.objectContaining({
      routeKind: 'gpt_reasoning',
      selectedTool: 'gpt_reasoning.jobs.create',
      reason: 'operator_request_matches_gpt_reasoning_signal'
    }));
  });

  it('routes diagnostics plus AI interpretation requests to hybrid mode', () => {
    const classification = classifyOperatorIntent('run diagnostics and have AI explain the likely issue');

    expect(classification).toEqual(expect.objectContaining({
      routeKind: 'hybrid',
      selectedTool: 'diagnostics.deep'
    }));
    expect(classification.matchedSignals).toEqual(expect.arrayContaining(['diagnostics', 'explain']));
  });

  it('rejects arbitrary SQL before calling the transport', async () => {
    const transportRequestMock = jest.fn();
    const client = new OperatorControlPlaneClient({
      request: transportRequestMock
    } as unknown as GptAccessTransport);

    await expect(client.explainApprovedQuery({
      queryKey: 'queue_pending',
      params: {},
      sql: 'SELECT * FROM job_data'
    } as any)).rejects.toMatchObject({
      code: 'OPERATOR_CONTROL_PLANE_REQUEST_REJECTED'
    });
    expect(transportRequestMock).not.toHaveBeenCalled();
  });

  it('rejects arbitrary URL, header, proxy, and auth passthrough fields', async () => {
    const transportRequestMock = jest.fn();
    const client = new OperatorControlPlaneClient({
      request: transportRequestMock
    } as unknown as GptAccessTransport);
    const unsafePayloads = [
      { url: 'https://internal.example' },
      { headers: { authorization: 'Bearer secret-token-value' } },
      { proxy: 'http://127.0.0.1:8080' },
      { auth: { bearer: 'secret-token-value' } }
    ];

    for (const payload of unsafePayloads) {
      await expect(client.queryLogs(payload as any)).rejects.toMatchObject({
        code: 'OPERATOR_CONTROL_PLANE_REQUEST_REJECTED'
      });
    }
    expect(transportRequestMock).not.toHaveBeenCalled();
  });

  it('does not call createReasoningJob for control-plane requests', async () => {
    const { clients, mocks } = buildMockClients();

    const result = await dispatchOperatorRequest({
      input: 'show worker runtime status',
      clients
    });

    expect(result.routeKind).toBe('control_plane');
    expect(mocks.getWorkersStatusMock).toHaveBeenCalledTimes(1);
    expect(mocks.createReasoningJobMock).not.toHaveBeenCalled();
  });

  it('sanitizes hybrid control-plane results before creating GPT context', async () => {
    const callOrder: string[] = [];
    const controlPayload = {
      ok: true,
      traceId: 'trace-control-1',
      status: 'degraded',
      counts: {
        pending: 4,
        running: 1
      },
      authorization: 'Bearer live-secret-token',
      headers: {
        cookie: 'sessionid=secret-session'
      },
      message: 'OPENAI_API_KEY=sk-test-placeholder-value DATABASE_URL=postgres://user:pass@host/db token=railway_abcdefghijklmnop',
      env: {
        OPENAI_API_KEY: 'sk-test-placeholder-value',
        RUN_WORKERS: 'true'
      }
    };
    const { clients, mocks } = buildMockClients(controlPayload);
    mocks.runDeepDiagnosticsMock.mockImplementationOnce(async () => {
      callOrder.push('control');
      return clientResult('/gpt-access/diagnostics/deep', controlPayload);
    });
    mocks.createReasoningJobMock.mockImplementationOnce(async (input: CreateReasoningJobRequest) => {
      callOrder.push('reasoning');
      return clientResult('/gpt-access/jobs/create', {
        ok: true,
        jobId: '22222222-2222-4222-8222-222222222222',
        traceId: 'trace-reasoning',
        status: 'queued',
        resultEndpoint: '/gpt-access/jobs/result',
        received: input
      });
    });

    const result = await dispatchOperatorRequest({
      input: 'run diagnostics and have AI explain the worker queue risk',
      clients
    });

    expect(result.routeKind).toBe('hybrid');
    expect(callOrder).toEqual(['control', 'reasoning']);
    const reasoningInput = mocks.createReasoningJobMock.mock.calls[0]?.[0];
    const renderedReasoningInput = JSON.stringify(reasoningInput);
    expect(reasoningInput?.task).toBe(
      'Interpret the provided sanitized operational observation and produce concise guidance for the operator.'
    );
    expect(reasoningInput?.task).not.toMatch(/\b(?:diagnostics|worker|queue|runtime)\b/i);
    expect(renderedReasoningInput).toContain('trace-control-1');
    expect(renderedReasoningInput).toContain('degraded');
    expect(renderedReasoningInput).toContain('"pending":4');
    expect(renderedReasoningInput).not.toContain('worker queue risk');
    expect(renderedReasoningInput).not.toContain('live-secret-token');
    expect(renderedReasoningInput).not.toContain('secret-session');
    expect(renderedReasoningInput).not.toContain('sk-test-placeholder-value');
    expect(renderedReasoningInput).not.toContain('postgres://user:pass@host/db');
    expect(renderedReasoningInput).not.toContain('railway_abcdefghijklmnop');
  });
});

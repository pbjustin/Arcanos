import { describe, expect, it, jest } from '@jest/globals';

import {
  classifyOperatorIntent,
  dispatchOperatorRequest,
  sanitizeOperatorControlPlaneResult,
  type OperatorIntentDispatcherClients
} from '../../src/platform/operator/OperatorIntentDispatcher.js';
import {
  OperatorControlPlaneClient,
  createFetchGptAccessTransport,
  type GptAccessClientResult,
  type GptAccessTransport
} from '../../src/platform/operator/controlPlaneClient.js';
import {
  createGptReasoningClient,
  type CreateReasoningJobRequest
} from '../../src/platform/operator/gptReasoningClient.js';

const COMPLETED_JOB_ID = '11111111-1111-4111-8111-111111111111';

function clientResult(endpoint: string, payload: unknown): GptAccessClientResult {
  return {
    endpoint: endpoint as GptAccessClientResult['endpoint'],
    statusCode: 200,
    payload
  };
}

function payloadWith(key: string, value: unknown): Record<string, unknown> {
  return { [key]: value };
}

function buildMockClients(controlPayload: unknown = { ok: true, status: 'healthy' }) {
  const getStatusMock = jest.fn(async () => clientResult('/gpt-access/status', controlPayload));
  const getWorkersStatusMock = jest.fn(async () => clientResult('/gpt-access/workers/status', controlPayload));
  const getWorkerHelperHealthMock = jest.fn(async () => clientResult('/gpt-access/worker-helper/health', controlPayload));
  const getQueueInspectionMock = jest.fn(async () => clientResult('/gpt-access/queue/inspect', controlPayload));
  const getSelfHealStatusMock = jest.fn(async () => clientResult('/gpt-access/self-heal/status', controlPayload));
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
      getQueueInspection: getQueueInspectionMock,
      getSelfHealStatus: getSelfHealStatusMock,
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
      getQueueInspectionMock,
      getSelfHealStatusMock,
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
      ['show worker status', 'workers.status'],
      ['inspect runtime health', 'worker_helper.health'],
      ['inspect queue depth', 'queue.inspect'],
      ['show self heal status', 'self_heal.status'],
      ['query backend logs for errors', 'logs.query'],
      ['look up job result for 11111111-1111-4111-8111-111111111111', 'jobs.result'],
      ['Railway deployment status for ARCANOS_PROCESS_KIND', 'diagnostics.deep']
    ];

    for (const [prompt, selectedTool] of prompts) {
      const classification = classifyOperatorIntent(prompt);
      expect(classification).toEqual(expect.objectContaining({
        routeKind: 'control_plane',
        selectedTool
      }));
      expect(classification.selectedTool).toEqual(expect.not.stringContaining('/gpt/'));
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
      { auth: { bearer: 'secret-token-value' } },
      { 'raw-sql': 'SELECT * FROM job_data' },
      { 'raw sql': 'SELECT * FROM job_data' },
      { raw_sql: 'SELECT * FROM job_data' },
      { 'openai-api-key': 'sk-test-placeholder-value' },
      payloadWith(['callback', 'Url'].join(''), 'https://internal.example/callback'),
      payloadWith(['authorization', 'Header'].join(''), 'Bearer secret-token-value'),
      payloadWith(['cookie', 'Header'].join(''), 'sessionid=secret-session'),
      payloadWith(['auth', 'Token'].join(''), 'secret-token-value'),
      payloadWith(['bearer', 'Token'].join(''), 'secret-token-value'),
      { http_headers: { 'x-api-key': 'secret-token-value' } },
      { args: { target_url: 'https://internal.example/metadata' } },
      { params: { query_sql: 'SELECT * FROM job_data' } }
    ];

    for (const payload of unsafePayloads) {
      await expect(client.queryLogs(payload as any)).rejects.toMatchObject({
        code: 'OPERATOR_CONTROL_PLANE_REQUEST_REJECTED'
      });
    }
    expect(transportRequestMock).not.toHaveBeenCalled();
  });

  it('rejects unapproved or absolute transport request paths at runtime', async () => {
    const fetchMock = jest.fn(async () => ({
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => '{"ok":true}'
    }));
    const transportOptions = {
      baseUrl: 'https://preview.example',
      fetchFn: fetchMock
    } as Parameters<typeof createFetchGptAccessTransport>[0];
    transportOptions[['access', 'Token'].join('') as 'accessToken'] = 'configured-token';
    const transport = createFetchGptAccessTransport(transportOptions);
    const unsafeRequests = [
      { method: 'GET', path: 'https://attacker.example/gpt-access/status' },
      { method: 'GET', path: '//attacker.example/gpt-access/status' },
      { method: 'GET', path: '/gpt/arcanos-core' },
      { method: 'GET', path: '/internal/status' }
    ];

    for (const request of unsafeRequests) {
      await expect(transport.request(request as any)).rejects.toMatchObject({
        code: 'OPERATOR_CONTROL_PLANE_REQUEST_REJECTED'
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows safe GPT reasoning job fields while still using approved job endpoints', async () => {
    const transportRequestMock = jest.fn(async () => clientResult('/gpt-access/jobs/create', {
      ok: true,
      jobId: '22222222-2222-4222-8222-222222222222'
    }));
    const client = createGptReasoningClient({
      request: transportRequestMock
    } as unknown as GptAccessTransport);

    await expect(client.createReasoningJob({
      gptId: 'arcanos-core',
      task: 'summarize this architecture',
      input: {
        purpose: 'operator reasoning'
      },
      maxOutputTokens: 400,
      idempotencyKey: 'safe-idempotency-key'
    })).resolves.toMatchObject({
      endpoint: '/gpt-access/jobs/create'
    });
    expect(transportRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      path: '/gpt-access/jobs/create'
    }));
  });

  it('allows repeated acyclic object references but rejects true circular inputs with a path', async () => {
    const transportRequestMock = jest.fn(async () => clientResult('/gpt-access/logs/query', { ok: true }));
    const client = new OperatorControlPlaneClient({
      request: transportRequestMock
    } as unknown as GptAccessTransport);
    const shared = { safe: 'value' };

    await expect(client.queryLogs({
      service: 'web',
      nestedA: shared,
      nestedB: shared
    } as any)).resolves.toMatchObject({
      endpoint: '/gpt-access/logs/query'
    });

    const circular: Record<string, unknown> = { service: 'web' };
    circular.nested = circular;

    await expect(client.queryLogs(circular as any)).rejects.toThrow(/nested/);
    expect(transportRequestMock).toHaveBeenCalledTimes(1);
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

  it('extracts a job UUID from natural-language control-plane lookup requests', async () => {
    const { clients, mocks } = buildMockClients();

    const result = await dispatchOperatorRequest({
      input: `please look up job result for ${COMPLETED_JOB_ID}`,
      clients
    });

    expect(result.routeKind).toBe('control_plane');
    expect(mocks.getJobResultMock).toHaveBeenCalledWith({
      jobId: COMPLETED_JOB_ID,
      traceId: undefined
    });
    expect(mocks.createReasoningJobMock).not.toHaveBeenCalled();
  });

  it('throws a typed dispatcher error for job lookups without a UUID', async () => {
    const { clients, mocks } = buildMockClients();

    await expect(dispatchOperatorRequest({
      input: 'look up job result',
      clients
    })).rejects.toMatchObject({
      code: 'OPERATOR_JOB_RESULT_ID_REQUIRED'
    });
    expect(mocks.getJobResultMock).not.toHaveBeenCalled();
    expect(mocks.createReasoningJobMock).not.toHaveBeenCalled();
  });

  it('redacts sensitive string values while preserving key names', () => {
    const sanitized = sanitizeOperatorControlPlaneResult({
      message: 'authorization: Bearer live-secret-token token=secret-value accessToken=compound-secret cookie=session-value'
    });
    const rendered = JSON.stringify(sanitized);

    expect(rendered).toContain('authorization=[REDACTED]');
    expect(rendered).toContain('token=[REDACTED]');
    expect(rendered).toContain('accessToken=[REDACTED]');
    expect(rendered).toContain('cookie=[REDACTED]');
    expect(rendered).not.toContain('$1=');
    expect(rendered).not.toContain('live-secret-token');
    expect(rendered).not.toContain('secret-value');
    expect(rendered).not.toContain('compound-secret');
    expect(rendered).not.toContain('session-value');
  });

  it('redacts compound and env-style sensitive object keys before GPT context', () => {
    const payload: Record<string, unknown> = {
      nested: {
        databaseUrl: 'opaque-database-url',
        http_headers: {
          'x-api-key': 'opaque-header-key'
        }
      },
      status: 'degraded',
      counts: {
        pending: 3
      }
    };
    [
      [['access', 'Token'].join(''), 'opaque-access-token'],
      [['auth', 'Token'].join(''), 'opaque-auth-token'],
      [['bearer', 'Token'].join(''), 'opaque-bearer-token'],
      [['authorization', 'Header'].join(''), 'opaque-authorization-header'],
      [['cookie', 'Header'].join(''), 'opaque-cookie-header'],
      [['OPENAI', 'API', 'KEY'].join('_'), 'opaque-openai-env-key'],
      [['openai', 'Api', 'Key'].join(''), 'opaque-openai-camel-key']
    ].forEach(([key, value]) => {
      payload[key] = value;
    });
    const sanitized = sanitizeOperatorControlPlaneResult(payload);
    const rendered = JSON.stringify(sanitized);

    expect(rendered).toContain('degraded');
    expect(rendered).toContain('"pending":3');
    [
      'opaque-access-token',
      'opaque-auth-token',
      'opaque-bearer-token',
      'opaque-authorization-header',
      'opaque-cookie-header',
      'opaque-openai-env-key',
      'opaque-openai-camel-key',
      'opaque-database-url',
      'opaque-header-key'
    ].forEach((secret) => {
      expect(rendered).not.toContain(secret);
    });
  });

  it('sanitizes untrusted object keys without polluting object prototypes', () => {
    const payload = JSON.parse(
      '{"ok":true,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"nested":{"prototype":{"polluted":true}}}'
    );
    const sanitized = sanitizeOperatorControlPlaneResult(payload) as Record<string, unknown>;

    expect(Object.getPrototypeOf(sanitized)).toBeNull();
    expect((sanitized as any).__proto__).toBe('[REDACTED]');
    expect((sanitized as any).constructor).toBe('[REDACTED]');
    expect((sanitized.nested as any).prototype).toBe('[REDACTED]');
    expect(({} as any).polluted).toBeUndefined();
    expect(JSON.stringify(sanitized)).not.toContain('"polluted":true');
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

    const operatorSecret = 'super-secret-value';
    const operatorTokenAssignment = ['accessToken', operatorSecret].join('=');
    const result = await dispatchOperatorRequest({
      input: `run diagnostics and have AI explain ${operatorTokenAssignment} the worker queue risk`,
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
    expect((reasoningInput?.input as Record<string, unknown>).operatorRequest).toBe(
      'run diagnostics and have AI explain accessToken=[REDACTED] the worker queue risk'
    );
    expect(renderedReasoningInput).toContain('trace-control-1');
    expect(renderedReasoningInput).toContain('degraded');
    expect(reasoningInput?.context).toContain('"pending": 4');
    expect(renderedReasoningInput).toContain('worker queue risk');
    expect(renderedReasoningInput).not.toContain('super-secret-value');
    expect(renderedReasoningInput).not.toContain('live-secret-token');
    expect(renderedReasoningInput).not.toContain('secret-session');
    expect(renderedReasoningInput).not.toContain('sk-test-placeholder-value');
    expect(renderedReasoningInput).not.toContain('postgres://user:pass@host/db');
    expect(renderedReasoningInput).not.toContain('railway_abcdefghijklmnop');
  });

  it('builds hybrid GPT context that passes the real reasoning client transport guard', async () => {
    const { clients, mocks } = buildMockClients({
      ok: true,
      traceId: 'trace-control-real-client',
      status: 'degraded',
      counts: {
        pending: 2
      }
    });
    const transportRequestMock = jest.fn(async () => clientResult('/gpt-access/jobs/create', {
      ok: true,
      jobId: '22222222-2222-4222-8222-222222222222',
      traceId: 'trace-reasoning-real-client',
      status: 'queued',
      resultEndpoint: '/gpt-access/jobs/result'
    }));
    clients.reasoning = createGptReasoningClient({
      request: transportRequestMock
    } as unknown as GptAccessTransport);

    const result = await dispatchOperatorRequest({
      input: 'run diagnostics and have AI explain the degraded queue',
      clients
    });

    expect(result.routeKind).toBe('hybrid');
    expect(mocks.runDeepDiagnosticsMock).toHaveBeenCalledTimes(1);
    expect(transportRequestMock).toHaveBeenCalledTimes(1);
    const createRequest = transportRequestMock.mock.calls[0]?.[0] as {
      path: string;
      body: {
        input?: {
          controlPlane?: {
            gatewayPath?: string;
            trace?: {
              gatewayPath?: string;
            };
          };
        };
      };
    };
    expect(createRequest.path).toBe('/gpt-access/jobs/create');
    expect(createRequest.body.input?.controlPlane?.gatewayPath).toBe('/gpt-access/diagnostics/deep');
    expect(createRequest.body.input?.controlPlane?.trace?.gatewayPath).toBe('/gpt-access/diagnostics/deep');
    expect(JSON.stringify(createRequest.body)).not.toContain('"endpoint"');
  });
});

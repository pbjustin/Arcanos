import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ActionPlanRecord } from '../src/shared/types/actionPlan.js';

const getAuthoritativePlanMock = jest.fn();
const createPlanMock = jest.fn();
const listAuthoritativePlansMock = jest.fn();
const updateAuthoritativePlanStatusMock = jest.fn();
const buildClear2SummaryMock = jest.fn();
const requestExecutionMock = jest.fn();
const replayExecutionMock = jest.fn();
const apiLoggerWarnMock = jest.fn();
const apiLoggerErrorMock = jest.fn();

jest.unstable_mockModule('../src/stores/actionPlanStore.js', () => ({
  createPlan: createPlanMock,
  getAuthoritativePlan: getAuthoritativePlanMock,
  listAuthoritativePlans: listAuthoritativePlansMock,
  updateAuthoritativePlanStatus: updateAuthoritativePlanStatusMock,
}));

jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: jest.fn(() => ({ enableActionPlans: true })),
}));

jest.unstable_mockModule('../src/services/clear2.js', () => ({
  buildClear2Summary: buildClear2SummaryMock,
}));

jest.unstable_mockModule('@services/actionPlanExecution/service.js', () => ({
  createActionPlanExecutionService: () => ({
    requestExecution: requestExecutionMock,
    replayExecution: replayExecutionMock,
  }),
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  apiLogger: {
    debug: jest.fn(), info: jest.fn(), warn: apiLoggerWarnMock, error: apiLoggerErrorMock,
    child: jest.fn(),
  },
  aiLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() },
  dbLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() },
  workerLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() },
  logger: {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    child: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  },
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const plansRouter = (await import('../src/routes/plans.js')).default;

const requesterToken = 'r'.repeat(40);
const authKeys = [
  'ACTION_PLAN_REQUEST_TOKEN',
  'ACTION_PLAN_REQUEST_PRINCIPAL_ID',
  'NODE_ENV',
  'ACTION_PLAN_EXECUTION_LOCAL_REALM',
] as const;
const originalEnv = Object.fromEntries(authKeys.map(key => [key, process.env[key]]));

function restoreEnv() {
  for (const key of authKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function configureEnv() {
  process.env.ACTION_PLAN_REQUEST_TOKEN = requesterToken;
  process.env.ACTION_PLAN_REQUEST_PRINCIPAL_ID = 'requester-1';
  process.env.NODE_ENV = 'test';
  process.env.ACTION_PLAN_EXECUTION_LOCAL_REALM = 'local-test';
}

function buildPlan(): ActionPlanRecord {
  const timestamp = new Date('2026-07-17T12:00:00.000Z');
  return {
    id: 'plan-1', createdBy: 'user', origin: 'phase2e-test', status: 'approved', confidence: 0.9,
    requiresConfirmation: false, idempotencyKey: 'plan-key-1', expiresAt: null,
    createdAt: timestamp, updatedAt: timestamp, clearScore: null,
    ownerPrincipalId: 'requester-1', executionRealm: 'local-test',
    executionProtocolVersion: 2, executionGeneration: 1,
    actions: [{
      id: 'action-1', planId: 'plan-1', agentId: 'agent-1', capability: 'terminal.run',
      params: { command: 'synthetic-noop' }, timeoutMs: 1000, rollbackAction: null, sortOrder: 0,
    }],
  };
}

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '64kb', strict: true }));
  app.use(plansRouter);
  return app;
}

function command() {
  return request(buildApp())
    .post('/plans/plan-1/execute')
    .set('Authorization', `Bearer ${requesterToken}`)
    .set('Idempotency-Key', 'command-key-1');
}

describe('Phase 2E command-only legacy execute route', () => {
  beforeEach(() => {
    restoreEnv();
    configureEnv();
    jest.clearAllMocks();
    getAuthoritativePlanMock.mockResolvedValue(buildPlan());
    buildClear2SummaryMock.mockReturnValue({ overall: 0.9, decision: 'allow' });
    replayExecutionMock.mockResolvedValue(null);
    requestExecutionMock.mockResolvedValue({
      ok: true,
      code: 'ACTION_PLAN_EXECUTION_COMMAND_ACCEPTED',
      protocol_version: 'action-plan-execution-v1',
      command_id: 'command-1',
      plan_id: 'plan-1',
      disposition: 'COMMAND_CREATED',
      runs: [{ run_id: 'run-1', action_id: 'action-1', state: 'REQUESTED' }],
    });
  });

  afterAll(restoreEnv);

  it.each([
    ['get', '/api/test'],
    ['post', '/clear'],
  ] as const)('does not intercept the unrelated %s %s route', async (method, path) => {
    const app = express();
    app.use(express.json());
    app.use(plansRouter);
    app.get('/api/test', (_req, res) => res.json({ route: 'api-test' }));
    app.post('/clear', (_req, res) => res.json({ route: 'clear' }));

    const response = method === 'get'
      ? await request(app).get(path)
      : await request(app).post(path).send({});
    expect(response.status).toBe(200);
    expect(response.body.route).toBe(path === '/api/test' ? 'api-test' : 'clear');
    expect(response.headers['cache-control']).not.toBe('no-store');
  });

  it('rejects unknown or deeply nested creation fields before persistence', async () => {
    const valid = {
      created_by: 'user', origin: 'phase2e-test', idempotency_key: 'plan-create-key',
      actions: [{ agent_id: 'agent-1', capability: 'terminal.run', params: { command: 'synthetic' } }],
    };
    const unknown = await request(buildApp())
      .post('/plans')
      .set('Authorization', `Bearer ${requesterToken}`)
      .send({ ...valid, unexpected: true });
    let nested: unknown = 'leaf';
    for (let index = 0; index < 10; index += 1) nested = { nested };
    const deep = await request(buildApp())
      .post('/plans')
      .set('Authorization', `Bearer ${requesterToken}`)
      .send({ ...valid, actions: [{ ...valid.actions[0], params: nested }] });

    expect([unknown.status, deep.status]).toEqual([400, 400]);
    expect(unknown.body.error.code).toBe('ACTION_PLAN_EXECUTION_REQUEST_INVALID');
    expect(deep.body.error.code).toBe('ACTION_PLAN_EXECUTION_REQUEST_INVALID');
    expect(createPlanMock).not.toHaveBeenCalled();
  });

  it('rejects an ActionPlan action identifier that the Python executor cannot parse', async () => {
    const response = await request(buildApp())
      .post('/plans')
      .set('Authorization', `Bearer ${requesterToken}`)
      .send({
        created_by: 'user', origin: 'phase2e-test', idempotency_key: 'plan-create-key',
        actions: [{
          action_id: 'bad id', agent_id: 'agent-1', capability: 'terminal.run',
          params: { command: 'synthetic' },
        }],
      });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ACTION_PLAN_EXECUTION_REQUEST_INVALID');
    expect(createPlanMock).not.toHaveBeenCalled();
  });

  it.each([
    '/plans?status=unknown',
    '/plans?limit=0',
    '/plans?limit=1&limit=2',
    '/plans?unexpected=true',
  ])('rejects invalid list query %s before an authoritative read', async path => {
    const response = await request(buildApp())
      .get(path)
      .set('Authorization', `Bearer ${requesterToken}`);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ACTION_PLAN_EXECUTION_REQUEST_INVALID');
    expect(listAuthoritativePlansMock).not.toHaveBeenCalled();
  });

  it('accepts only an explicit empty command and creates runs without accepting a result', async () => {
    const response = await command().send({});
    expect(response.status).toBe(202);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      code: 'ACTION_PLAN_EXECUTION_COMMAND_ACCEPTED',
      command_id: 'command-1',
      runs: [{ run_id: 'run-1', action_id: 'action-1', state: 'REQUESTED' }],
    });
    expect(requestExecutionMock).toHaveBeenCalledWith(expect.objectContaining({
      planId: 'plan-1', idempotencyKey: 'command-key-1',
      actor: { role: 'requester', principalId: 'requester-1' },
    }));
    expect(updateAuthoritativePlanStatusMock).not.toHaveBeenCalled();
  });

  it.each([
    { action_id: 'action-1', agent_id: 'agent-1', status: 'success' },
    { action_id: 'action-1', snapshot_id: 'snapshot-1', outcome: 'failed', error: { code: 'FAILED' } },
  ])('rejects a result-shaped body with the dedicated-endpoint migration error and zero effect', async body => {
    const response = await command().send(body);
    expect(response.status).toBe(409);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      error: {
        code: 'ACTION_PLAN_RESULT_ENDPOINT_REQUIRED',
        message: 'Use the dedicated ActionPlan execution result endpoint.',
      },
    }));
    expect(getAuthoritativePlanMock).not.toHaveBeenCalled();
    expect(buildClear2SummaryMock).not.toHaveBeenCalled();
    expect(requestExecutionMock).not.toHaveBeenCalled();
    expect(updateAuthoritativePlanStatusMock).not.toHaveBeenCalled();
  });

  it.each([
    { arbitrary: true },
    { output: { ignored: true } },
    { outcome: '?', unrelated: true },
    { action_id: 'action-1', agent_id: 'agent-1', status: 'success', unrelated: true },
  ])('rejects ambiguous body %j rather than guessing command or result semantics', async body => {
    const response = await command().send(body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ACTION_PLAN_EXECUTION_REQUEST_INVALID');
    expect(getAuthoritativePlanMock).not.toHaveBeenCalled();
    expect(replayExecutionMock).not.toHaveBeenCalled();
    expect(requestExecutionMock).not.toHaveBeenCalled();
  });

  it('fails closed before plan reads when authentication or idempotency is absent', async () => {
    const unauthenticated = await request(buildApp())
      .post('/plans/plan-1/execute')
      .set('Idempotency-Key', 'command-key-1')
      .send({});
    const noIdempotency = await request(buildApp())
      .post('/plans/plan-1/execute')
      .set('Authorization', `Bearer ${requesterToken}`)
      .send({});
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.error.code).toBe('ACTION_PLAN_EXECUTION_AUTH_REQUIRED');
    expect(noIdempotency.status).toBe(400);
    expect(noIdempotency.body.error.code).toBe('ACTION_PLAN_EXECUTION_REQUEST_INVALID');
    expect(getAuthoritativePlanMock).not.toHaveBeenCalled();
    expect(requestExecutionMock).not.toHaveBeenCalled();
  });

  it.each(['in_progress', 'completed', 'failed'] as const)(
    'returns the original command after response loss even when plan state advanced to %s',
    async status => {
      getAuthoritativePlanMock.mockResolvedValue({
        ...buildPlan(),
        status,
        clearScore: {
          id: 'clear-1', planId: 'plan-1', overall: 0.9, decision: 'allow', notes: null,
          clarity: 0.9, leverage: 0.9, efficiency: 0.9, alignment: 0.9, resilience: 0.9,
          createdAt: new Date('2026-07-17T11:59:00.000Z'),
        },
      });
      replayExecutionMock.mockResolvedValue({
        ok: true,
        code: 'ACTION_PLAN_EXECUTION_COMMAND_ACCEPTED',
        protocol_version: 'action-plan-execution-v1',
        command_id: 'command-original',
        plan_id: 'plan-1',
        disposition: 'COMMAND_REPLAY',
        runs: [{ run_id: 'run-original', action_id: 'action-1', state: 'SUCCEEDED' }],
      });

      const response = await command().send({});

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ disposition: 'COMMAND_REPLAY', command_id: 'command-original' });
      expect(replayExecutionMock).toHaveBeenCalledWith(expect.objectContaining({
        planId: 'plan-1', idempotencyKey: 'command-key-1',
      }));
      expect(buildClear2SummaryMock).not.toHaveBeenCalled();
      expect(requestExecutionMock).not.toHaveBeenCalled();
    },
  );

  it.each(['in_progress', 'completed', 'failed'] as const)(
    'does not let a different key bypass the %s lifecycle gate',
    async status => {
      getAuthoritativePlanMock.mockResolvedValue({
        ...buildPlan(),
        status,
        clearScore: {
          id: 'clear-1', planId: 'plan-1', overall: 0.9, decision: 'allow', notes: null,
          clarity: 0.9, leverage: 0.9, efficiency: 0.9, alignment: 0.9, resilience: 0.9,
          createdAt: new Date('2026-07-17T11:59:00.000Z'),
        },
      });
      replayExecutionMock.mockResolvedValue(null);

      const response = await command().set('Idempotency-Key', 'different-command-key').send({});

      expect(response.status).toBe(409);
      expect(replayExecutionMock).toHaveBeenCalledTimes(1);
      expect(buildClear2SummaryMock).not.toHaveBeenCalled();
      expect(requestExecutionMock).not.toHaveBeenCalled();
    },
  );

  it('persists an explicit coherent CLEAR block and creates no execution run', async () => {
    buildClear2SummaryMock.mockReturnValue({ overall: 0.2, decision: 'block' });
    updateAuthoritativePlanStatusMock.mockResolvedValue({ ...buildPlan(), status: 'blocked' });
    const response = await command().send({});
    expect(response.status).toBe(403);
    expect(updateAuthoritativePlanStatusMock).toHaveBeenCalledWith(expect.objectContaining({
      planId: 'plan-1', executionRealm: 'local-test', status: 'blocked',
    }));
    expect(requestExecutionMock).not.toHaveBeenCalled();
  });

  it.each([
    ['indeterminate', { overall: null, decision: null }, 'CLEAR_EVALUATION_UNAVAILABLE'],
    ['invalid', { overall: 2, decision: 'allow' }, 'CLEAR_RESULT_INVALID'],
  ] as const)('creates no run for a %s CLEAR result', async (_name, clear, errorCode) => {
    buildClear2SummaryMock.mockReturnValue(clear);
    const response = await command().send({});
    expect(response.status).toBe(errorCode === 'CLEAR_EVALUATION_UNAVAILABLE' ? 503 : 500);
    expect(response.body.error).toBe(errorCode);
    expect(requestExecutionMock).not.toHaveBeenCalled();
    expect(updateAuthoritativePlanStatusMock).not.toHaveBeenCalled();
  });

  it('turns a CLEAR dependency exception into a fixed unavailable response with zero persistence', async () => {
    const sentinel = 'private-clear-dependency-sentinel';
    buildClear2SummaryMock.mockImplementation(() => { throw new Error(sentinel); });
    const response = await command().send({});
    expect(response.status).toBe(503);
    const observable = JSON.stringify({
      body: response.body, warn: apiLoggerWarnMock.mock.calls, error: apiLoggerErrorMock.mock.calls,
    });
    expect(response.body.error).toBe('CLEAR_EVALUATION_UNAVAILABLE');
    expect(observable).not.toContain(sentinel);
    expect(requestExecutionMock).not.toHaveBeenCalled();
    expect(updateAuthoritativePlanStatusMock).not.toHaveBeenCalled();
  });

  it('rejects a blocked lifecycle before CLEAR or repository effects even with stored allow evidence', async () => {
    getAuthoritativePlanMock.mockResolvedValue({
      ...buildPlan(),
      status: 'blocked',
      clearScore: {
        id: 'clear-stored', planId: 'plan-1', overall: 0.9, decision: 'allow', notes: null,
        clarity: 0.9, leverage: 0.9, efficiency: 0.9, alignment: 0.9, resilience: 0.9,
        createdAt: new Date('2026-07-17T11:59:00.000Z'),
      },
    });
    const response = await command().send({});
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ category: 'ACTION_PLAN_POLICY_BLOCKED' });
    expect(buildClear2SummaryMock).not.toHaveBeenCalled();
    expect(requestExecutionMock).not.toHaveBeenCalled();
    expect(updateAuthoritativePlanStatusMock).not.toHaveBeenCalled();
  });

  it('does not disclose dependency, credential, path, or SQL sentinels in response or logs', async () => {
    const sentinels = ['private-token-sentinel', 'C:\\private\\plan.json', 'SELECT secret FROM credentials'];
    requestExecutionMock.mockRejectedValue(new Error(sentinels.join(' | ')));
    const response = await command().send({});
    const observable = JSON.stringify({
      body: response.body,
      warn: apiLoggerWarnMock.mock.calls,
      error: apiLoggerErrorMock.mock.calls,
    });
    expect(response.status).toBe(500);
    for (const sentinel of sentinels) expect(observable).not.toContain(sentinel);
    expect(requestExecutionMock).toHaveBeenCalledTimes(1);
  });
});

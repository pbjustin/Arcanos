import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const buildClear2SummaryMock = jest.fn();
const apiLoggerErrorMock = jest.fn();
const getAuthoritativePlanMock = jest.fn();
const childLoggerMock = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.unstable_mockModule('../src/services/clear2.js', () => ({
  buildClear2Summary: buildClear2SummaryMock,
}));

jest.unstable_mockModule('../src/stores/actionPlanStore.js', () => ({
  getAuthoritativePlan: getAuthoritativePlanMock,
}));

jest.unstable_mockModule('../src/platform/runtime/unifiedConfig.js', () => ({
  getConfig: jest.fn(() => ({ enableClear2: true })),
}));

jest.unstable_mockModule('../src/platform/logging/structuredLogging.js', () => ({
  apiLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: apiLoggerErrorMock,
  },
  aiLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  dbLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  workerLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(() => childLoggerMock),
  },
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const clearRouter = (await import('../src/routes/clear.js')).default;

const requestBody = {
  actions: [{
    agent_id: 'phase2b-agent',
    capability: 'inspect',
    params: {},
  }],
  origin: 'phase2b-clear-route-test',
  confidence: 0.8,
};
const requesterToken = 'r'.repeat(40);
const operatorToken = 'o'.repeat(40);
const executorToken = 'e'.repeat(40);
const authKeys = [
  'ACTION_PLAN_REQUEST_TOKEN',
  'ACTION_PLAN_REQUEST_PRINCIPAL_ID',
  'ACTION_PLAN_OPERATOR_TOKEN',
  'ACTION_PLAN_OPERATOR_PRINCIPAL_ID',
  'ACTION_PLAN_EXECUTOR_TOKEN',
  'ACTION_PLAN_EXECUTOR_PRINCIPAL_ID',
  'ACTION_PLAN_EXECUTOR_INSTANCE_ID',
  'ACTION_PLAN_EXECUTOR_AGENT_ID',
  'ACTION_PLAN_EXECUTION_LOCAL_REALM',
  'NODE_ENV',
] as const;
const originalEnv = Object.fromEntries(authKeys.map(key => [key, process.env[key]]));

function configureAuth() {
  process.env.ACTION_PLAN_REQUEST_TOKEN = requesterToken;
  process.env.ACTION_PLAN_REQUEST_PRINCIPAL_ID = 'requester-1';
  process.env.ACTION_PLAN_OPERATOR_TOKEN = operatorToken;
  process.env.ACTION_PLAN_OPERATOR_PRINCIPAL_ID = 'operator-1';
  process.env.ACTION_PLAN_EXECUTOR_TOKEN = executorToken;
  process.env.ACTION_PLAN_EXECUTOR_PRINCIPAL_ID = 'executor-1';
  process.env.ACTION_PLAN_EXECUTOR_INSTANCE_ID = 'executor-instance-1';
  process.env.ACTION_PLAN_EXECUTOR_AGENT_ID = 'agent-1';
  process.env.ACTION_PLAN_EXECUTION_LOCAL_REALM = 'local-test';
  process.env.NODE_ENV = 'test';
}

function restoreEnv() {
  for (const key of authKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const validSummary = {
  clarity: 0.8,
  leverage: 0.8,
  efficiency: 0.8,
  alignment: 0.8,
  resilience: 0.8,
  overall: 0.8,
  decision: 'allow',
  notes: 'synthetic valid summary',
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.requestId = 'phase2b-clear-http-request';
    req.traceId = 'phase2b-clear-http-trace';
    next();
  });
  app.use(clearRouter);
  return app;
}

describe('HTTP direct CLEAR evaluation contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureAuth();
  });

  afterAll(restoreEnv);

  it('preserves a valid evaluator response', async () => {
    buildClear2SummaryMock.mockReturnValue(validSummary);

    const response = await request(buildApp()).post('/clear/evaluate').send(requestBody);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(validSummary);
    expect(apiLoggerErrorMock).not.toHaveBeenCalled();
  });

  it.each([
    ['null result', null, 503, 'CLEAR_EVALUATION_UNAVAILABLE', 'CLEAR evaluation is unavailable.'],
    ['missing decision', { ...validSummary, decision: undefined }, 503, 'CLEAR_EVALUATION_UNAVAILABLE', 'CLEAR evaluation is unavailable.'],
    ['contradictory result', { ...validSummary, overall: 0.2 }, 500, 'CLEAR_RESULT_INVALID', 'CLEAR evaluation returned an invalid result.'],
    ['malformed score', { ...validSummary, overall: Number.NaN }, 500, 'CLEAR_RESULT_INVALID', 'CLEAR evaluation returned an invalid result.'],
  ] as const)('rejects %s without returning HTTP 200', async (_label, result, status, category, message) => {
    buildClear2SummaryMock.mockReturnValue(result);

    const response = await request(buildApp()).post('/clear/evaluate').send(requestBody);

    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: category, message });
  });

  it('sanitizes evaluator exceptions and diagnostic logging', async () => {
    const internalDetail = [
      ['Authorization', 'Bearer', ['phase2b', 'clear-route', 'marker'].join('-')].join(' '),
      ['SELECT', '*', 'FROM', 'private_clear_route'].join(' '),
      ['C:', 'private', 'clear-route.log'].join('\\'),
    ].join(' | ');
    buildClear2SummaryMock.mockImplementation(() => {
      throw new Error(internalDetail);
    });

    const response = await request(buildApp()).post('/clear/evaluate').send(requestBody);
    const observable = JSON.stringify({ body: response.body, text: response.text, logs: apiLoggerErrorMock.mock.calls });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'CLEAR_EVALUATION_UNAVAILABLE',
      message: 'CLEAR evaluation is unavailable.',
    });
    expect(observable).not.toContain(internalDetail);
    expect(observable).not.toContain('private_clear_route');
    expect(observable).not.toContain('clear-route.log');
  });
});

describe('stored ActionPlan CLEAR score authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureAuth();
    getAuthoritativePlanMock.mockResolvedValue({
      id: 'plan-1',
      ownerPrincipalId: 'requester-1',
      executionRealm: 'local-test',
      clearScore: validSummary,
    });
  });

  afterAll(restoreEnv);

  it('fails closed without an authenticated principal and does not read storage', async () => {
    const response = await request(buildApp()).get('/clear/plan-1');

    expect(response.status).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.error.code).toBe('ACTION_PLAN_EXECUTION_AUTH_REQUIRED');
    expect(getAuthoritativePlanMock).not.toHaveBeenCalled();
  });

  it('forbids an executor credential from reading a plan score', async () => {
    const response = await request(buildApp())
      .get('/clear/plan-1')
      .set('Authorization', `Bearer ${executorToken}`);

    expect(response.status).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.error.code).toBe('ACTION_PLAN_EXECUTION_FORBIDDEN');
    expect(getAuthoritativePlanMock).not.toHaveBeenCalled();
  });

  it('returns the authoritative score only to the owning requester', async () => {
    const response = await request(buildApp())
      .get('/clear/plan-1')
      .set('Authorization', `Bearer ${requesterToken}`);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual(validSummary);
    expect(getAuthoritativePlanMock).toHaveBeenCalledWith('plan-1');
  });

  it('allows the explicit operator role to inspect a current-realm score', async () => {
    getAuthoritativePlanMock.mockResolvedValue({
      id: 'plan-1',
      ownerPrincipalId: 'different-owner',
      executionRealm: 'local-test',
      clearScore: validSummary,
    });

    const response = await request(buildApp())
      .get('/clear/plan-1')
      .set('Authorization', `Bearer ${operatorToken}`);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual(validSummary);
  });

  it.each([
    ['different owner', { ownerPrincipalId: 'requester-2', executionRealm: 'local-test' }],
    ['different realm', { ownerPrincipalId: 'requester-1', executionRealm: 'local:other' }],
  ])('conceals a plan with a %s as not found', async (_label, conflicting) => {
    getAuthoritativePlanMock.mockResolvedValue({
      id: 'plan-1',
      clearScore: validSummary,
      ...conflicting,
    });

    const response = await request(buildApp())
      .get('/clear/plan-1')
      .set('Authorization', `Bearer ${requesterToken}`);

    expect(response.status).toBe(404);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.error.code).toBe('ACTION_PLAN_EXECUTION_NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toContain('synthetic valid summary');
  });

  it('fails closed on authoritative storage failure without a cache fallback', async () => {
    getAuthoritativePlanMock.mockRejectedValue(
      new Error('credential-sentinel SELECT secret C:\\private\\clear.sql'),
    );

    const response = await request(buildApp())
      .get('/clear/plan-1')
      .set('Authorization', `Bearer ${requesterToken}`);
    const observable = JSON.stringify({ response: response.body, logs: apiLoggerErrorMock.mock.calls });

    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.error.code).toBe('ACTION_PLAN_EXECUTION_PERSISTENCE_FAILED');
    expect(getAuthoritativePlanMock).toHaveBeenCalledTimes(1);
    expect(observable).not.toContain('credential-sentinel');
    expect(observable).not.toContain('clear.sql');
  });
});

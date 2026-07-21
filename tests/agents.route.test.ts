import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const operatorToken = 'o'.repeat(40);
const requesterToken = 'r'.repeat(40);
const authEnvKeys = [
  'ACTION_PLAN_OPERATOR_TOKEN',
  'ACTION_PLAN_OPERATOR_PRINCIPAL_ID',
  'ACTION_PLAN_REQUEST_TOKEN',
  'ACTION_PLAN_REQUEST_PRINCIPAL_ID',
] as const;
const originalAuthEnv = Object.fromEntries(authEnvKeys.map(key => [key, process.env[key]]));
process.env.ACTION_PLAN_OPERATOR_TOKEN = operatorToken;
process.env.ACTION_PLAN_OPERATOR_PRINCIPAL_ID = 'operator-1';
process.env.ACTION_PLAN_REQUEST_TOKEN = requesterToken;
process.env.ACTION_PLAN_REQUEST_PRINCIPAL_ID = 'requester-1';

const mockRegisterAgent = jest.fn();
const mockGetAuthoritativeAgent = jest.fn();
const mockUpdateHeartbeat = jest.fn();
const mockListAuthoritativeAgents = jest.fn();
const mockGrantAuthoritativeCapabilities = jest.fn();
const mockGetConfig = jest.fn();
const mockApiLoggerError = jest.fn();

jest.unstable_mockModule('../src/stores/agentRegistry.js', () => ({
  registerAgent: mockRegisterAgent,
  getAuthoritativeAgent: mockGetAuthoritativeAgent,
  updateHeartbeat: mockUpdateHeartbeat,
  listAuthoritativeAgents: mockListAuthoritativeAgents,
  grantAuthoritativeCapabilities: mockGrantAuthoritativeCapabilities,
}));

jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: mockGetConfig
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', async () => {
  const actual = await import('../src/platform/logging/logger.js');
  return {
    ...actual,
    apiLogger: new Proxy(actual.apiLogger, {
      get(target, property, receiver) {
        if (property === 'error') return mockApiLoggerError;
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
});

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const router = (await import('../src/routes/agents.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

const validRegistrationPayload = {
  role: 'executor',
  capabilities: ['terminal.run'],
  public_key: 'pub-key-1'
};

function authorizeOperator<T extends { set(name: string, value: string): T }>(requestBuilder: T): T {
  return requestBuilder.set('Authorization', `Bearer ${operatorToken}`);
}

afterAll(() => {
  for (const key of authEnvKeys) {
    const value = originalAuthEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('agents routes', () => {
  beforeEach(() => {
    mockRegisterAgent.mockReset();
    mockGetAuthoritativeAgent.mockReset();
    mockUpdateHeartbeat.mockReset();
    mockListAuthoritativeAgents.mockReset();
    mockGrantAuthoritativeCapabilities.mockReset();
    mockGetConfig.mockReset();
    mockApiLoggerError.mockReset();
    mockGetConfig.mockReturnValue({ enableActionPlans: true });
  });

  it('returns 503 when action plans are disabled', async () => {
    mockGetConfig.mockReturnValue({ enableActionPlans: false });

    const response = await authorizeOperator(request(buildApp())
      .post('/agents/register')
      ).send(validRegistrationPayload);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'ActionPlans are not enabled' });
    expect(mockRegisterAgent).not.toHaveBeenCalled();
  });

  it('registers an agent and returns 201 when action plans are enabled', async () => {
    const registeredAgent = {
      id: 'agent-1',
      role: 'executor',
      capabilities: ['terminal.run'],
      status: 'idle'
    };
    mockRegisterAgent.mockResolvedValue(registeredAgent);

    const response = await authorizeOperator(request(buildApp())
      .post('/agents/register')
      ).send(validRegistrationPayload);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject(registeredAgent);
    expect(mockRegisterAgent).toHaveBeenCalledWith(expect.objectContaining({
      role: 'executor',
      capabilities: ['terminal.run']
    }));
  });

  it('returns 500 when registerAgent throws', async () => {
    mockRegisterAgent.mockRejectedValue(new Error('register failed'));

    const response = await authorizeOperator(request(buildApp())
      .post('/agents/register')
      ).send(validRegistrationPayload);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'ACTION_PLAN_AGENT_OPERATION_FAILED',
        message: 'ActionPlan agent operation failed.',
      },
    });
  });

  it('lists all registered agents with count', async () => {
    mockListAuthoritativeAgents.mockResolvedValue([
      { id: 'agent-1' },
      { id: 'agent-2' }
    ]);

    const response = await authorizeOperator(request(buildApp()).get('/agents'));

    expect(response.status).toBe(200);
    expect(response.body.count).toBe(2);
    expect(response.body.agents).toHaveLength(2);
  });

  it('returns 404 for unknown agent id on status endpoint', async () => {
    mockGetAuthoritativeAgent.mockResolvedValue(null);

    const response = await authorizeOperator(request(buildApp()).get('/agents/unknown-agent'));

    expect(response.status).toBe(404);
    expect(response.body.error).toContain('Agent not found');
  });

  it('returns agent details for known agent id on status endpoint', async () => {
    mockGetAuthoritativeAgent.mockResolvedValue({
      id: 'agent-1',
      role: 'executor',
      status: 'idle'
    });

    const response = await authorizeOperator(request(buildApp()).get('/agents/agent-1'));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: 'agent-1',
      role: 'executor',
      status: 'idle'
    });
  });

  it('returns 500 when getAgent throws', async () => {
    mockGetAuthoritativeAgent.mockRejectedValue(new Error('lookup failed'));

    const response = await authorizeOperator(request(buildApp()).get('/agents/agent-1'));

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('ACTION_PLAN_AGENT_OPERATION_FAILED');
  });

  it('disables the legacy heartbeat with a fixed no-store response and zero registry mutation', async () => {
    const response = await authorizeOperator(
      request(buildApp()).post('/agents/agent-1/heartbeat'),
    );

    expect(response.status).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'ACTION_PLAN_LEGACY_AGENT_HEARTBEAT_DISABLED',
        message: 'Legacy ActionPlan agent heartbeat is disabled.',
      },
    });
    expect(mockUpdateHeartbeat).not.toHaveBeenCalled();
  });

  it('returns 500 when listAgents throws', async () => {
    mockListAuthoritativeAgents.mockRejectedValue(new Error('storage read failed'));

    const response = await authorizeOperator(request(buildApp()).get('/agents'));

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('ACTION_PLAN_AGENT_OPERATION_FAILED');
  });

  it('grants capabilities only to the authenticated operator principal', async () => {
    mockGrantAuthoritativeCapabilities.mockResolvedValue({
      id: 'agent-1',
      capabilities: ['terminal.run', 'vision.analyze']
    });

    const response = await authorizeOperator(request(buildApp())
      .post('/agents/agent-1/capabilities/grant')
      ).send({ capabilities: ['vision.analyze'] });

    expect(response.status).toBe(200);
    expect(mockGrantAuthoritativeCapabilities).toHaveBeenCalledWith('agent-1', ['vision.analyze']);
    expect(response.body.agent.capabilities).toContain('vision.analyze');
  });

  it('returns 404 when capability grant target is missing', async () => {
    mockGrantAuthoritativeCapabilities.mockResolvedValue(null);

    const response = await authorizeOperator(request(buildApp())
      .post('/agents/missing/capabilities/grant')
      ).send({ capabilities: ['vision.analyze'] });

    expect(response.status).toBe(404);
    expect(response.body.error).toContain('Agent not found');
  });

  it('fails closed without authentication and rejects requester privilege escalation', async () => {
    const unauthenticated = await request(buildApp()).get('/agents');
    const requesterOnly = await request(buildApp())
      .get('/agents')
      .set('Authorization', `Bearer ${requesterToken}`);

    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers['cache-control']).toBe('no-store');
    expect(unauthenticated.body.error.code).toBe('ACTION_PLAN_EXECUTION_AUTH_REQUIRED');
    expect(requesterOnly.status).toBe(403);
    expect(requesterOnly.headers['cache-control']).toBe('no-store');
    expect(requesterOnly.body.error.code).toBe('ACTION_PLAN_EXECUTION_FORBIDDEN');
    expect(mockListAuthoritativeAgents).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'register',
      arrange: (error: Error) => mockRegisterAgent.mockRejectedValueOnce(error),
      request: () => authorizeOperator(request(buildApp())
        .post('/agents/register'))
        .send(validRegistrationPayload),
    },
    {
      name: 'list',
      arrange: (error: Error) => mockListAuthoritativeAgents.mockRejectedValueOnce(error),
      request: () => authorizeOperator(request(buildApp()).get('/agents')),
    },
    {
      name: 'get',
      arrange: (error: Error) => mockGetAuthoritativeAgent.mockRejectedValueOnce(error),
      request: () => authorizeOperator(request(buildApp()).get('/agents/agent-1')),
    },
    {
      name: 'grant',
      arrange: (error: Error) => mockGrantAuthoritativeCapabilities.mockRejectedValueOnce(error),
      request: () => authorizeOperator(request(buildApp())
        .post('/agents/agent-1/capabilities/grant'))
        .send({ capabilities: ['terminal.run'] }),
    },
  ])('does not disclose dependency details when authoritative $name fails', async ({ arrange, request: makeRequest }) => {
    const dependencyDetail = [
      ['Authorization', 'Bearer', ['phase2e', 'agent', 'marker'].join('-')].join(' '),
      ['SELECT', '*', 'FROM', 'private_agent_table'].join(' '),
      ['C:', 'private', 'agent-registry.log'].join('\\'),
    ].join(' | ');
    arrange(new Error(dependencyDetail));

    const response = await makeRequest();
    const observable = JSON.stringify({ body: response.body, logs: mockApiLoggerError.mock.calls });

    expect(response.status).toBe(500);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'ACTION_PLAN_AGENT_OPERATION_FAILED',
        message: 'ActionPlan agent operation failed.',
      },
    });
    expect(observable).not.toContain(dependencyDetail);
    expect(observable).not.toContain('private_agent_table');
    expect(observable).not.toContain('agent-registry.log');
    expect(mockApiLoggerError).toHaveBeenCalledWith(
      'ActionPlan agent operation failed',
      expect.objectContaining({
        errorCode: 'ACTION_PLAN_AGENT_OPERATION_FAILED',
        errorClass: 'Error',
      }),
    );
  });
});

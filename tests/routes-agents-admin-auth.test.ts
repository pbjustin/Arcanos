import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const operatorToken = 'a'.repeat(40);
const operatorTokenBeforeTest = process.env.ACTION_PLAN_OPERATOR_TOKEN;
const operatorPrincipalBeforeTest = process.env.ACTION_PLAN_OPERATOR_PRINCIPAL_ID;
process.env.ACTION_PLAN_OPERATOR_TOKEN = operatorToken;
process.env.ACTION_PLAN_OPERATOR_PRINCIPAL_ID = 'phase2e-operator';

const registerAgentMock = jest.fn();
const getAuthoritativeAgentMock = jest.fn();
const updateHeartbeatMock = jest.fn();
const listAuthoritativeAgentsMock = jest.fn();
const grantAuthoritativeCapabilitiesMock = jest.fn();

jest.unstable_mockModule('../src/stores/agentRegistry.js', () => ({
  registerAgent: registerAgentMock,
  getAuthoritativeAgent: getAuthoritativeAgentMock,
  updateHeartbeat: updateHeartbeatMock,
  listAuthoritativeAgents: listAuthoritativeAgentsMock,
  grantAuthoritativeCapabilities: grantAuthoritativeCapabilitiesMock,
}));

jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: () => ({
    enableActionPlans: true
  })
}));

const agentsRouter = (await import('../src/routes/agents.js')).default;

/**
 * Build an app that mounts the agents router.
 *
 * Purpose: integration-test agent route auth branches using real middleware.
 * Inputs/outputs: none -> express app instance.
 * Edge cases: N/A.
 */
function createAgentsApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(agentsRouter);
  return app;
}

describe('routes/agents admin capability auth', () => {
  beforeEach(() => {
    registerAgentMock.mockReset();
    getAuthoritativeAgentMock.mockReset();
    updateHeartbeatMock.mockReset();
    listAuthoritativeAgentsMock.mockReset();
    grantAuthoritativeCapabilitiesMock.mockReset();
  });

  it('rejects unauthenticated capability grants and permits the configured operator', async () => {
    const app = createAgentsApp();
    grantAuthoritativeCapabilitiesMock.mockResolvedValueOnce({
      id: 'agent-1',
      role: 'planner',
      capabilities: ['self_improve_admin'],
      publicKey: null,
      status: 'idle',
      lastHeartbeat: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const unauthenticated = await request(app)
      .post('/agents/agent-1/capabilities/grant')
      .send({ capabilities: ['self_improve_admin'] })
      .expect(401);
    const response = await request(app)
      .post('/agents/agent-1/capabilities/grant')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ capabilities: ['self_improve_admin'] })
      .expect(200);

    expect(unauthenticated.headers['cache-control']).toBe('no-store');
    expect(unauthenticated.body.error.code).toBe('ACTION_PLAN_EXECUTION_AUTH_REQUIRED');
    expect(grantAuthoritativeCapabilitiesMock).toHaveBeenCalledTimes(1);
    expect(grantAuthoritativeCapabilitiesMock).toHaveBeenCalledWith('agent-1', ['self_improve_admin']);
    expect(response.body.agent.id).toBe('agent-1');
  });
});

afterAll(() => {
  if (operatorTokenBeforeTest === undefined) delete process.env.ACTION_PLAN_OPERATOR_TOKEN;
  else process.env.ACTION_PLAN_OPERATOR_TOKEN = operatorTokenBeforeTest;
  if (operatorPrincipalBeforeTest === undefined) delete process.env.ACTION_PLAN_OPERATOR_PRINCIPAL_ID;
  else process.env.ACTION_PLAN_OPERATOR_PRINCIPAL_ID = operatorPrincipalBeforeTest;
});

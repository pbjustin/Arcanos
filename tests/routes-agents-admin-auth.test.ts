import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const registerAgentMock = jest.fn();
const getAgentMock = jest.fn();
const updateHeartbeatMock = jest.fn();
const listAgentsMock = jest.fn();
const grantCapabilitiesMock = jest.fn();

let currentAdminKey = 'secret123';

jest.unstable_mockModule('../src/stores/agentRegistry.js', () => ({
  registerAgent: registerAgentMock,
  getAgent: getAgentMock,
  updateHeartbeat: updateHeartbeatMock,
  listAgents: listAgentsMock,
  grantCapabilities: grantCapabilitiesMock
}));

jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: () => ({
    enableActionPlans: true,
    adminKey: currentAdminKey
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
    getAgentMock.mockReset();
    updateHeartbeatMock.mockReset();
    listAgentsMock.mockReset();
    grantCapabilitiesMock.mockReset();
    currentAdminKey = 'secret123';
  });

  it('rejects capability grants when header length differs', async () => {
    const app = createAgentsApp();

    await request(app)
      .post('/agents/agent-1/capabilities/grant')
      .set('x-admin-api-key', 'short')
      .send({ capabilities: ['self_improve_admin'] })
      .expect(403);

    expect(grantCapabilitiesMock).not.toHaveBeenCalled();
  });

  it('rejects capability grants when header length matches but content differs', async () => {
    const app = createAgentsApp();

    await request(app)
      .post('/agents/agent-1/capabilities/grant')
      .set('x-admin-api-key', 'secret124')
      .send({ capabilities: ['self_improve_admin'] })
      .expect(403);

    expect(grantCapabilitiesMock).not.toHaveBeenCalled();
  });

  it('allows capability grants with matching admin key', async () => {
    const app = createAgentsApp();
    grantCapabilitiesMock.mockResolvedValueOnce({
      id: 'agent-1',
      role: 'planner',
      capabilities: ['self_improve_admin'],
      publicKey: null,
      status: 'idle',
      lastHeartbeat: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const response = await request(app)
      .post('/agents/agent-1/capabilities/grant')
      .set('x-admin-api-key', 'secret123')
      .send({ capabilities: ['self_improve_admin'] })
      .expect(200);

    expect(grantCapabilitiesMock).toHaveBeenCalledWith('agent-1', ['self_improve_admin']);
    expect(response.body.agent.id).toBe('agent-1');
  });
});

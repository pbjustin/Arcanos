import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRegisterAgent = jest.fn();
const mockGetAgent = jest.fn();
const mockUpdateHeartbeat = jest.fn();
const mockListAgents = jest.fn();
const mockGrantCapabilities = jest.fn();
const mockGetConfig = jest.fn();

jest.unstable_mockModule('../src/stores/agentRegistry.js', () => ({
  registerAgent: mockRegisterAgent,
  getAgent: mockGetAgent,
  updateHeartbeat: mockUpdateHeartbeat,
  listAgents: mockListAgents,
  grantCapabilities: mockGrantCapabilities
}));

jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: mockGetConfig
}));

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

describe('agents routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConfig.mockReturnValue({ enableActionPlans: true });
  });

  it('returns 503 when action plans are disabled', async () => {
    mockGetConfig.mockReturnValue({ enableActionPlans: false });

    const response = await request(buildApp())
      .post('/agents/register')
      .send(validRegistrationPayload);

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

    const response = await request(buildApp())
      .post('/agents/register')
      .send(validRegistrationPayload);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject(registeredAgent);
    expect(mockRegisterAgent).toHaveBeenCalledWith(expect.objectContaining({
      role: 'executor',
      capabilities: ['terminal.run']
    }));
  });

  it('returns 500 when registerAgent throws', async () => {
    mockRegisterAgent.mockRejectedValue(new Error('register failed'));

    const response = await request(buildApp())
      .post('/agents/register')
      .send(validRegistrationPayload);

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to register agent');
  });

  it('lists all registered agents with count', async () => {
    mockListAgents.mockResolvedValue([
      { id: 'agent-1' },
      { id: 'agent-2' }
    ]);

    const response = await request(buildApp()).get('/agents');

    expect(response.status).toBe(200);
    expect(response.body.count).toBe(2);
    expect(response.body.agents).toHaveLength(2);
  });

  it('returns 404 for unknown agent id on status endpoint', async () => {
    mockGetAgent.mockResolvedValue(null);

    const response = await request(buildApp()).get('/agents/unknown-agent');

    expect(response.status).toBe(404);
    expect(response.body.error).toContain('Agent not found');
  });

  it('returns agent details for known agent id on status endpoint', async () => {
    mockGetAgent.mockResolvedValue({
      id: 'agent-1',
      role: 'executor',
      status: 'idle'
    });

    const response = await request(buildApp()).get('/agents/agent-1');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: 'agent-1',
      role: 'executor',
      status: 'idle'
    });
  });

  it('returns 500 when getAgent throws', async () => {
    mockGetAgent.mockRejectedValue(new Error('lookup failed'));

    const response = await request(buildApp()).get('/agents/agent-1');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to get agent');
  });

  it('returns updated agent on heartbeat', async () => {
    const updatedAgent = {
      id: 'agent-1',
      status: 'idle'
    };
    mockUpdateHeartbeat.mockResolvedValue(updatedAgent);

    const response = await request(buildApp()).post('/agents/agent-1/heartbeat');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject(updatedAgent);
  });

  it('returns 404 on heartbeat when agent does not exist', async () => {
    mockUpdateHeartbeat.mockResolvedValue(null);

    const response = await request(buildApp()).post('/agents/ghost/heartbeat');

    expect(response.status).toBe(404);
    expect(response.body.error).toContain('Agent not found');
  });

  it('returns 500 when updateHeartbeat throws', async () => {
    mockUpdateHeartbeat.mockRejectedValue(new Error('heartbeat failed'));

    const response = await request(buildApp()).post('/agents/agent-1/heartbeat');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to update heartbeat');
  });

  it('returns 500 when listAgents throws', async () => {
    mockListAgents.mockRejectedValue(new Error('storage read failed'));

    const response = await request(buildApp()).get('/agents');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to list agents');
  });

  it('grants capabilities without admin header auth', async () => {
    mockGrantCapabilities.mockResolvedValue({
      id: 'agent-1',
      capabilities: ['terminal.run', 'vision.analyze']
    });

    const response = await request(buildApp())
      .post('/agents/agent-1/capabilities/grant')
      .send({ capabilities: ['vision.analyze'] });

    expect(response.status).toBe(200);
    expect(mockGrantCapabilities).toHaveBeenCalledWith('agent-1', ['vision.analyze']);
    expect(response.body.agent.capabilities).toContain('vision.analyze');
  });

  it('returns 404 when capability grant target is missing', async () => {
    mockGrantCapabilities.mockResolvedValue(null);

    const response = await request(buildApp())
      .post('/agents/missing/capabilities/grant')
      .send({ capabilities: ['vision.analyze'] });

    expect(response.status).toBe(404);
    expect(response.body.error).toContain('Agent not found');
  });
});

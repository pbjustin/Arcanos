import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const claimLocalAgentJobMock = jest.fn();
const getLocalAgentJobForDeviceMock = jest.fn();
const heartbeatLocalAgentJobMock = jest.fn();
const submitLocalAgentJobResultMock = jest.fn();
const resolveAuthorizedLocalAgentDeviceMock = jest.fn();
const updateHeartbeatMock = jest.fn();

class MockLocalAgentJobRepositoryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

class MockLocalAgentDevicePolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

jest.unstable_mockModule(
  '../src/core/db/repositories/localAgentJobRepository.js',
  () => ({
    claimLocalAgentJob: claimLocalAgentJobMock,
    getLocalAgentJobForDevice: getLocalAgentJobForDeviceMock,
    heartbeatLocalAgentJob: heartbeatLocalAgentJobMock,
    LOCAL_AGENT_JOB_PROTOCOL_VERSION: 'local-agent-job-v1',
    LocalAgentJobRepositoryError: MockLocalAgentJobRepositoryError,
    readLocalAgentJobEnvelope: jest.fn(),
    submitLocalAgentJobResult: submitLocalAgentJobResultMock
  })
);
jest.unstable_mockModule(
  '../src/services/localAgent/devicePolicy.js',
  () => ({
    LocalAgentDevicePolicyError: MockLocalAgentDevicePolicyError,
    resolveAuthorizedLocalAgentDevice: resolveAuthorizedLocalAgentDeviceMock
  })
);
jest.unstable_mockModule('../src/stores/agentRegistry.js', () => ({
  updateHeartbeat: updateHeartbeatMock
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const router = (await import('../src/routes/gpt-access-local-agent.js')).default;

const executorToken = 'e'.repeat(40);
const requesterToken = 'r'.repeat(40);
const deviceId = '20000000-0000-4000-8000-000000000001';
const keys = [
  'ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN',
  'ARCANOS_LOCAL_AGENT_EXECUTOR_PRINCIPAL_ID',
  'ARCANOS_LOCAL_AGENT_EXECUTOR_INSTANCE_ID',
  'ARCANOS_LOCAL_AGENT_EXECUTOR_DEVICE_ID',
  'ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN',
  'ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN_EXPIRES_AT',
  'ACTION_PLAN_REQUEST_TOKEN',
  'ACTION_PLAN_REQUEST_PRINCIPAL_ID'
] as const;
const originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

function restoreEnv(): void {
  for (const key of keys) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function configureEnv(): void {
  process.env.ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN = executorToken;
  process.env.ARCANOS_LOCAL_AGENT_EXECUTOR_PRINCIPAL_ID = 'local-agent:executor';
  process.env.ARCANOS_LOCAL_AGENT_EXECUTOR_INSTANCE_ID = 'local-agent:instance';
  process.env.ARCANOS_LOCAL_AGENT_EXECUTOR_DEVICE_ID = deviceId;
  delete process.env.ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN;
  delete process.env.ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN_EXPIRES_AT;
  process.env.ACTION_PLAN_REQUEST_TOKEN = requesterToken;
  process.env.ACTION_PLAN_REQUEST_PRINCIPAL_ID = 'requester:primary';
}

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '64kb', strict: true }));
  app.use('/gpt-access/local-agent', router);
  return app;
}

describe('local-agent outbound HTTP protocol', () => {
  beforeEach(() => {
    restoreEnv();
    configureEnv();
    jest.clearAllMocks();
    resolveAuthorizedLocalAgentDeviceMock.mockResolvedValue({
      deviceId,
      agentId: deviceId,
      instanceId: 'local-agent:instance',
      principalId: 'local-agent:executor',
      capabilities: ['git.status'],
      record: {}
    });
    updateHeartbeatMock.mockResolvedValue({
      status: 'idle',
      lastHeartbeat: new Date('2026-07-24T12:00:00.000Z')
    });
    claimLocalAgentJobMock.mockResolvedValue(null);
  });

  afterAll(restoreEnv);

  test('requires only the dedicated local-agent credential and audience', async () => {
    const unauthenticated = await request(buildApp())
      .post('/gpt-access/local-agent/heartbeat')
      .send({});
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.error.code).toBe(
      'LOCAL_AGENT_EXECUTOR_AUTH_REQUIRED'
    );

    const actionPlanCredential = await request(buildApp())
      .post('/gpt-access/local-agent/heartbeat')
      .set('Authorization', `Bearer ${requesterToken}`)
      .send({});
    expect(actionPlanCredential.status).toBe(401);
    expect(actionPlanCredential.body.error.code).toBe(
      'LOCAL_AGENT_EXECUTOR_AUTH_REQUIRED'
    );
    expect(resolveAuthorizedLocalAgentDeviceMock).not.toHaveBeenCalled();
  });

  test('accepts only an empty JSON object for the authenticated heartbeat', async () => {
    const rejected = await request(buildApp())
      .post('/gpt-access/local-agent/heartbeat')
      .set('Authorization', `Bearer ${executorToken}`)
      .send([]);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('LOCAL_AGENT_REQUEST_INVALID');

    const accepted = await request(buildApp())
      .post('/gpt-access/local-agent/heartbeat')
      .set('Authorization', `Bearer ${executorToken}`)
      .send({});
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      ok: true,
      code: 'LOCAL_AGENT_HEARTBEAT_ACCEPTED',
      deviceId,
      status: 'idle'
    });
    expect(updateHeartbeatMock).toHaveBeenCalledWith(deviceId);
    expect(resolveAuthorizedLocalAgentDeviceMock).toHaveBeenCalledWith([], {
      principal: expect.objectContaining({
        role: 'local-agent-executor',
        audience: 'local-agent-protocol',
        executorDeviceId: deviceId
      }),
      requireFreshHeartbeat: false
    });
  });

  test('claims no work with a bounded opaque claim key and no model authority fields', async () => {
    const response = await request(buildApp())
      .post('/gpt-access/local-agent/jobs/claim')
      .set('Authorization', `Bearer ${executorToken}`)
      .send({ claimKey: 'claim-key-1' });

    expect(response.status).toBe(204);
    expect(claimLocalAgentJobMock).toHaveBeenCalledWith(expect.objectContaining({
      deviceId,
      claimKeyHash: expect.any(String),
      deviceScopes: ['git.status']
    }));
  });

  test('reports a stale registered device as unavailable for job claims', async () => {
    resolveAuthorizedLocalAgentDeviceMock.mockRejectedValueOnce(
      new MockLocalAgentDevicePolicyError(
        'LOCAL_AGENT_DEVICE_OFFLINE',
        'The registered local-agent device heartbeat is stale or unavailable.'
      )
    );

    const response = await request(buildApp())
      .post('/gpt-access/local-agent/jobs/claim')
      .set('Authorization', `Bearer ${executorToken}`)
      .send({ claimKey: 'claim-key-1' });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('LOCAL_AGENT_DEVICE_OFFLINE');
    expect(claimLocalAgentJobMock).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const getAuthoritativeAgentMock = jest.fn();

jest.unstable_mockModule('../src/stores/agentRegistry.js', () => ({
  getAuthoritativeAgent: getAuthoritativeAgentMock
}));

const {
  assertLocalAgentWorkspaceAllowed,
  resolveAuthorizedLocalAgentDevice
} = await import('../src/services/localAgent/devicePolicy.js');

const DEVICE_ID = '20000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-07-24T12:00:00.000Z');
const EXECUTOR_ENV = {
  ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN: 'x'.repeat(32),
  ARCANOS_LOCAL_AGENT_EXECUTOR_PRINCIPAL_ID: 'local-agent:executor',
  ARCANOS_LOCAL_AGENT_EXECUTOR_INSTANCE_ID: 'local-agent:instance',
  ARCANOS_LOCAL_AGENT_EXECUTOR_DEVICE_ID: DEVICE_ID,
  ARCANOS_LOCAL_AGENT_HEARTBEAT_TTL_MS: '90000',
  ARCANOS_LOCAL_AGENT_WORKSPACES: 'personal,team:alpha'
} satisfies NodeJS.ProcessEnv;

beforeEach(() => {
  jest.clearAllMocks();
  getAuthoritativeAgentMock.mockResolvedValue({
    id: DEVICE_ID,
    role: 'executor',
    capabilities: ['git.status', 'patch.apply'],
    publicKey: null,
    status: 'idle',
    lastHeartbeat: NOW,
    createdAt: new Date('2026-07-24T10:00:00.000Z'),
    updatedAt: new Date('2026-07-24T12:00:00.000Z')
  });
});

describe('local-agent registered-device policy', () => {
  test('pins the purpose-bound executor identity to an authoritative agent and scope', async () => {
    await expect(
      resolveAuthorizedLocalAgentDevice(['git.status'], {
        env: EXECUTOR_ENV,
        principal: {
          role: 'local-agent-executor',
          audience: 'local-agent-protocol',
          principalId: 'local-agent:executor',
          executorInstanceId: 'local-agent:instance',
          executorDeviceId: DEVICE_ID,
          credentialVersion: 'current',
          scopes: [
            'local-agent.heartbeat',
            'local-agent.jobs.claim',
            'local-agent.jobs.heartbeat',
            'local-agent.jobs.result'
          ]
        },
        now: NOW
      })
    ).resolves.toMatchObject({
      deviceId: DEVICE_ID,
      instanceId: 'local-agent:instance',
      principalId: 'local-agent:executor',
      capabilities: ['git.status', 'patch.apply']
    });
    expect(getAuthoritativeAgentMock).toHaveBeenCalledWith(DEVICE_ID);
  });

  test('rejects identity drift and missing device scopes', async () => {
    await expect(
      resolveAuthorizedLocalAgentDevice([], {
        env: EXECUTOR_ENV,
        principal: {
          role: 'local-agent-executor',
          audience: 'local-agent-protocol',
          principalId: 'local-agent:executor',
          executorInstanceId: 'different-instance',
          executorDeviceId: DEVICE_ID,
          credentialVersion: 'current',
          scopes: [
            'local-agent.heartbeat',
            'local-agent.jobs.claim',
            'local-agent.jobs.heartbeat',
            'local-agent.jobs.result'
          ]
        },
        now: NOW
      })
    ).rejects.toMatchObject({
      code: 'LOCAL_AGENT_DEVICE_IDENTITY_MISMATCH'
    });

    await expect(
      resolveAuthorizedLocalAgentDevice(['repo.search'], {
        env: EXECUTOR_ENV,
        now: NOW
      })
    ).rejects.toMatchObject({
      code: 'LOCAL_AGENT_DEVICE_SCOPE_DENIED'
    });
  });

  test('allows only server-configured workspace identifiers', () => {
    expect(() =>
      assertLocalAgentWorkspaceAllowed('personal', EXECUTOR_ENV)
    ).not.toThrow();
    expect(() =>
      assertLocalAgentWorkspaceAllowed('attacker', EXECUTOR_ENV)
    ).toThrow(expect.objectContaining({
      code: 'LOCAL_AGENT_WORKSPACE_DENIED'
    }));
  });

  test('fails execution closed for a stale heartbeat but allows heartbeat recovery', async () => {
    getAuthoritativeAgentMock.mockResolvedValueOnce({
      id: DEVICE_ID,
      role: 'executor',
      capabilities: ['git.status'],
      publicKey: null,
      status: 'error',
      lastHeartbeat: new Date('2026-07-23T12:00:00.000Z'),
      createdAt: new Date('2026-07-23T10:00:00.000Z'),
      updatedAt: new Date('2026-07-23T12:00:00.000Z')
    });

    await expect(
      resolveAuthorizedLocalAgentDevice(['git.status'], {
        env: EXECUTOR_ENV,
        now: NOW
      })
    ).rejects.toMatchObject({
      code: 'LOCAL_AGENT_DEVICE_OFFLINE'
    });

    getAuthoritativeAgentMock.mockResolvedValueOnce({
      id: DEVICE_ID,
      role: 'executor',
      capabilities: ['git.status'],
      publicKey: null,
      status: 'error',
      lastHeartbeat: new Date('2026-07-23T12:00:00.000Z'),
      createdAt: new Date('2026-07-23T10:00:00.000Z'),
      updatedAt: new Date('2026-07-23T12:00:00.000Z')
    });
    await expect(
      resolveAuthorizedLocalAgentDevice([], {
        env: EXECUTOR_ENV,
        now: NOW,
        requireFreshHeartbeat: false
      })
    ).resolves.toMatchObject({
      deviceId: DEVICE_ID,
      record: { status: 'error' }
    });
  });

  test('does not let heartbeat recovery revive revoked capability membership', async () => {
    getAuthoritativeAgentMock.mockResolvedValueOnce({
      id: DEVICE_ID,
      role: 'executor',
      capabilities: [],
      publicKey: null,
      status: 'error',
      lastHeartbeat: new Date('2026-07-23T12:00:00.000Z'),
      createdAt: new Date('2026-07-23T10:00:00.000Z'),
      updatedAt: new Date('2026-07-23T12:00:00.000Z')
    });

    await expect(
      resolveAuthorizedLocalAgentDevice([], {
        env: EXECUTOR_ENV,
        now: NOW,
        requireFreshHeartbeat: false
      })
    ).rejects.toMatchObject({
      code: 'LOCAL_AGENT_DEVICE_SCOPE_DENIED'
    });
  });
});

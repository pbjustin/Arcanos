import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { createHash } from 'node:crypto';

const findOrCreateLocalAgentJobMock = jest.fn();
const assertLocalAgentWorkspaceAllowedMock = jest.fn();
const resolveAuthorizedLocalAgentDeviceMock = jest.fn();

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
    findOrCreateLocalAgentJob: findOrCreateLocalAgentJobMock,
    LocalAgentJobRepositoryError: MockLocalAgentJobRepositoryError,
    LOCAL_AGENT_JOB_PROTOCOL_VERSION: 'local-agent-job-v1'
  })
);
jest.unstable_mockModule(
  '../src/services/localAgent/devicePolicy.js',
  () => ({
    assertLocalAgentWorkspaceAllowed: assertLocalAgentWorkspaceAllowedMock,
    LocalAgentDevicePolicyError: MockLocalAgentDevicePolicyError,
    resolveAuthorizedLocalAgentDevice: resolveAuthorizedLocalAgentDeviceMock
  })
);

const { executeLocalAgentActionAsJob } = await import(
  '../src/services/localAgent/service.js'
);

const context = {
  source: 'gpt-access' as const,
  principalId: 'operator:primary',
  workspaceId: 'personal',
  actorKey: 'actor:test',
  requestId: 'request:test',
  traceId: 'trace:test',
  idempotencyKey: 'turn:test'
};

beforeEach(() => {
  jest.clearAllMocks();
  resolveAuthorizedLocalAgentDeviceMock.mockResolvedValue({
    deviceId: '20000000-0000-4000-8000-000000000001',
    agentId: '20000000-0000-4000-8000-000000000001',
    instanceId: 'local-agent:instance',
    principalId: 'local-agent:executor',
    capabilities: ['git.status', 'tests.run', 'patch.apply'],
    record: {}
  });
  findOrCreateLocalAgentJobMock.mockResolvedValue({
    job: {
      id: '10000000-0000-4000-8000-000000000001',
      status: 'pending',
      expires_at: new Date('2026-07-24T13:00:00.000Z')
    },
    created: true,
    deduped: false,
    dedupeReason: 'new_job'
  });
});

describe('local-agent GPT Access job service', () => {
  test('keeps requester ownership distinct from executor identity and isolates same-key device jobs', async () => {
    for (const requesterDeviceId of ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']) {
      await executeLocalAgentActionAsJob({ action: 'git.status', payload: {}, context: { ...context, requesterDeviceId } });
    }
    const first = findOrCreateLocalAgentJobMock.mock.calls[0][0] as {
      envelope: { gptAccessDeviceOwner: { deviceId: string }; job: { deviceId: string } };
      idempotencyScopeHash: string; idempotencyKeyHash: string; requestFingerprintHash: string;
    };
    const second = findOrCreateLocalAgentJobMock.mock.calls[1][0] as typeof first;
    expect(first.envelope.gptAccessDeviceOwner.deviceId).toBe('11111111-1111-4111-8111-111111111111');
    expect(second.envelope.gptAccessDeviceOwner.deviceId).toBe('22222222-2222-4222-8222-222222222222');
    expect(first.envelope.job.deviceId).toBe('20000000-0000-4000-8000-000000000001');
    expect(first.idempotencyScopeHash).not.toBe(second.idempotencyScopeHash);
    expect(first.idempotencyKeyHash).not.toBe(second.idempotencyKeyHash);
    expect(first.requestFingerprintHash).not.toBe(second.requestFingerprintHash);
  });

  test('preserves operator idempotency bindings and stable retries for one requester device', async () => {
    await executeLocalAgentActionAsJob({ action: 'git.status', payload: {}, context });
    const deviceContext = { ...context, requesterDeviceId: '11111111-1111-4111-8111-111111111111' };
    await executeLocalAgentActionAsJob({ action: 'git.status', payload: {}, context: deviceContext });
    await executeLocalAgentActionAsJob({ action: 'git.status', payload: {}, context: deviceContext });
    const hashes = findOrCreateLocalAgentJobMock.mock.calls.map(call => (call[0] as { idempotencyKeyHash: string }).idempotencyKeyHash);
    expect(hashes[0]).toBe(createHash('sha256').update('local-agent-idempotency-key-v1\0turn:test', 'utf8').digest('hex'));
    expect(hashes[1]).not.toBe(hashes[0]);
    expect(hashes[2]).toBe(hashes[1]);
  });
  test('queues read-only work with only server-controlled authority fields', async () => {
    await expect(
      executeLocalAgentActionAsJob({
        action: 'git.status',
        payload: {},
        context
      })
    ).resolves.toMatchObject({
      ok: true,
      accepted: true,
      action: 'git.status',
      status: 'pending',
      poll: '/gpt-access/jobs/result'
    });

    const createInput = findOrCreateLocalAgentJobMock.mock.calls[0]?.[0] as {
      envelope: Record<string, unknown>;
    };
    expect(createInput.envelope).toMatchObject({
      protocolVersion: 'local-agent-job-v1',
      job: {
        action: 'git.status',
        payload: {},
        principal: 'operator:primary',
        workspace: 'personal',
        deviceId: '20000000-0000-4000-8000-000000000001',
        authorization: {
          decision: 'allow'
        },
        readOnly: true,
        mayModifyFiles: false
      }
    });
    expect(JSON.stringify(createInput.envelope)).not.toMatch(
      /confirmationToken|confirmation_token|repositoryRoot|rootPath|authorizationToken/iu
    );
    expect(resolveAuthorizedLocalAgentDeviceMock).toHaveBeenCalledWith([
      'git.status'
    ]);
  });

  test('fails status and enqueue closed when the device heartbeat is stale', async () => {
    resolveAuthorizedLocalAgentDeviceMock.mockRejectedValueOnce(
      new MockLocalAgentDevicePolicyError(
        'LOCAL_AGENT_DEVICE_OFFLINE',
        'The registered local-agent device heartbeat is stale or unavailable.'
      )
    );

    await expect(
      executeLocalAgentActionAsJob({
        action: 'local_agent.status',
        payload: {},
        context
      })
    ).resolves.toMatchObject({
      ok: false,
      accepted: false,
      action: 'local_agent.status',
      error: {
        code: 'LOCAL_AGENT_DEVICE_OFFLINE'
      }
    });
    expect(resolveAuthorizedLocalAgentDeviceMock).toHaveBeenCalledWith([
      'local_agent.status'
    ]);
    expect(findOrCreateLocalAgentJobMock).not.toHaveBeenCalled();
  });

  test('refuses patch.apply without exact challenge evidence', async () => {
    const payload = {
      patch: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n',
      expectedPatchSha256: 'a'.repeat(64)
    };
    await expect(
      executeLocalAgentActionAsJob({
        action: 'patch.apply',
        payload,
        context
      })
    ).resolves.toMatchObject({
      ok: false,
      accepted: false,
      error: {
        code: 'LOCAL_AGENT_CONFIRMATION_REQUIRED'
      }
    });
    expect(findOrCreateLocalAgentJobMock).not.toHaveBeenCalled();
  });

  test('refuses tests.run when confirmation did not consume an exact challenge', async () => {
    await expect(
      executeLocalAgentActionAsJob({
        action: 'tests.run',
        payload: {
          profile: 'python-unit'
        },
        context: {
          ...context,
          confirmation: {
            status: 'manual',
            usedChallengeToken: false
          }
        }
      })
    ).resolves.toMatchObject({
      ok: false,
      accepted: false,
      error: {
        code: 'LOCAL_AGENT_CONFIRMATION_REQUIRED'
      }
    });
    expect(findOrCreateLocalAgentJobMock).not.toHaveBeenCalled();
  });

  test('persists tests.run only with exact consumed challenge evidence', async () => {
    await expect(
      executeLocalAgentActionAsJob({
        action: 'tests.run',
        payload: {
          profile: 'python-unit'
        },
        context: {
          ...context,
          confirmation: {
            status: 'challenge-token',
            usedChallengeToken: true
          }
        }
      })
    ).resolves.toMatchObject({
      ok: true,
      accepted: true,
      action: 'tests.run'
    });

    const createInput = findOrCreateLocalAgentJobMock.mock.calls[0]?.[0] as {
      envelope: {
        job: Record<string, unknown>;
      };
    };
    expect(createInput.envelope.job['authorization']).toMatchObject({
      decision: 'confirmed',
      evidenceId: expect.any(String)
    });
    expect(createInput.envelope.job['authorization']).not.toHaveProperty('token');
  });

  test('persists one confirmed patch assignment without forwarding a confirmation token', async () => {
    const payload = {
      patch: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n',
      expectedPatchSha256: 'a'.repeat(64)
    };
    await expect(
      executeLocalAgentActionAsJob({
        action: 'patch.apply',
        payload,
        context: {
          ...context,
          confirmation: {
            status: 'challenge-token',
            usedChallengeToken: true
          }
        }
      })
    ).resolves.toMatchObject({
      ok: true,
      accepted: true,
      action: 'patch.apply'
    });

    const createInput = findOrCreateLocalAgentJobMock.mock.calls[0]?.[0] as {
      envelope: {
        job: {
          'authorization': Record<string, unknown>;
        };
      };
    };
    expect(createInput.envelope.job.authorization).toMatchObject({
      decision: 'confirmed',
      evaluatedAt: expect.any(String),
      evidenceId: expect.any(String)
    });
    expect(createInput.envelope.job.authorization).not.toHaveProperty('token');
  });
});

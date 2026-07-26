import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const recordHeartbeat = jest.fn();
const getTokenForInstance = jest.fn<(instanceId: string) => string | null>();
const setTokenForInstance = jest.fn();
const saveTokens = jest.fn();
const listPendingCommands = jest.fn();
const acknowledgeCommands = jest.fn();
const recordCommandResult = jest.fn();
const getCommandResult = jest.fn();
const createPendingActions = jest.fn();
const consumePendingActions = jest.fn();
const queueCommand = jest.fn();
const queueCommandForInstance = jest.fn();

jest.unstable_mockModule('@services/safety/runtimeState.js', () => ({
  activateUnsafeCondition: jest.fn(() => ({})),
  buildUnsafeToProceedPayload: jest.fn(() => ({})),
  clearUnsafeCondition: jest.fn(() => false),
  clearUnsafeConditionsByQuarantine: jest.fn(() => 0),
  getActiveQuarantines: jest.fn(() => []),
  getActiveUnsafeConditions: jest.fn(() => []),
  getSafetyRuntimeSnapshot: jest.fn(() => ({
    conditions: [],
    counters: {
      duplicateSuppressions: 0,
      healthyCycles: {},
      heartbeatMisses: {},
      quarantineActivations: 0,
      workerFailures: {},
    },
    quarantines: [],
    trustedHashes: {},
    updatedAt: '2026-01-01T00:00:00.000Z',
  })),
  getTrustedHash: jest.fn(() => undefined),
  hasUnsafeBlockingConditions: jest.fn(() => false),
  incrementHeartbeatMiss: jest.fn(() => 0),
  incrementHealthyCycle: jest.fn(() => 0),
  incrementWorkerFailure: jest.fn(() => 0),
  reconcileAutoRecoverableQuarantinesForProcessStart: jest.fn(() => 0),
  recordDuplicateSuppression: jest.fn(() => 0),
  registerQuarantine: jest.fn(() => ({})),
  releaseQuarantine: jest.fn(() => false),
  resetFailureSignals: jest.fn(),
  resetSafetyRuntimeStateForTests: jest.fn(),
  setTrustedHash: jest.fn(),
}));

const daemonStore = {
  recordHeartbeat,
  getTokenForInstance,
  setTokenForInstance,
  saveTokens,
  listPendingCommands,
  acknowledgeCommands,
  recordCommandResult,
  getCommandResult,
  createPendingActions,
  consumePendingActions,
  queueCommand,
  queueCommandForInstance,
};

jest.unstable_mockModule('@routes/api-daemon/context.js', () => ({
  daemonLogger: {
    child: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
  daemonStore,
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const {
  default: apiDaemonRouter,
  getDaemonCommandResultForInstance,
} = await import('../src/routes/api-daemon.js');

const daemonEnvironmentName = 'ARCANOS_DAEMON_ACCESS_TOKEN';
const daemonAccessToken = 'daemon-route-access-token-1234567890';
const historicalPartition = 'historical-opaque-partition-value';
const canonicalPartition = 'anonymous-daemon';
const originalDaemonDefaultToken = process.env.DAEMON_DEFAULT_TOKEN;
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);

const storeMocks = [
  recordHeartbeat,
  getTokenForInstance,
  setTokenForInstance,
  saveTokens,
  listPendingCommands,
  acknowledgeCommands,
  recordCommandResult,
  getCommandResult,
  createPendingActions,
  consumePendingActions,
  queueCommand,
  queueCommandForInstance,
] as const;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiDaemonRouter);
  return app;
}

function heartbeatBody(instanceId: string) {
  return {
    clientId: 'contained-daemon-client',
    instanceId,
    version: 'test',
  };
}

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

describe('daemon route authentication and store-partition contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPurposeBoundCredentialEnvironment();
    process.env[daemonEnvironmentName] = daemonAccessToken;
    delete process.env.DAEMON_DEFAULT_TOKEN;
    getTokenForInstance.mockReturnValue(null);
    listPendingCommands.mockReturnValue([]);
    acknowledgeCommands.mockReturnValue(0);
    consumePendingActions.mockReturnValue(0);
    getCommandResult.mockReturnValue(null);
  });

  it.each([
    [
      'heartbeat',
      () => request(buildApp())
        .post('/api/daemon/heartbeat')
        .send(heartbeatBody('denied-heartbeat')),
    ],
    [
      'command poll',
      () => request(buildApp())
        .get('/api/daemon/commands?instance_id=denied-poll'),
    ],
    [
      'command acknowledgement',
      () => request(buildApp())
        .post('/api/daemon/commands/ack')
        .send({ commandIds: ['command-1'], instanceId: 'denied-ack' }),
    ],
    [
      'command result',
      () => request(buildApp())
        .post('/api/daemon/commands/result')
        .send({
          commandId: 'command-1',
          instanceId: 'denied-result',
          result: { ok: true },
        }),
    ],
    [
      'action confirmation',
      () => request(buildApp())
        .post('/api/daemon/confirm-actions')
        .send({
          confirmation_token: 'confirmation-1',
          instanceId: 'denied-confirmation',
        }),
    ],
    [
      'registry',
      () => request(buildApp()).get('/api/daemon/registry'),
    ],
  ] as const)('denies unauthenticated %s access before any daemon-store call', async (
    _label,
    makeRequest
  ) => {
    const response = await makeRequest();

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('DAEMON_AUTH_REQUIRED');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(storeMocks.every((storeMock) => storeMock.mock.calls.length === 0)).toBe(true);
  });

  it('fails closed before store access when server credential configuration is unavailable', async () => {
    delete process.env[daemonEnvironmentName];

    const response = await request(buildApp())
      .post('/api/daemon/heartbeat')
      .set('x-arcanos-daemon-token', daemonAccessToken)
      .send(heartbeatBody('unavailable-heartbeat'));

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('DAEMON_AUTH_UNAVAILABLE');
    expect(storeMocks.every((storeMock) => storeMock.mock.calls.length === 0)).toBe(true);
  });

  it('does not grant access through Bearer, GPT id, cookie, query, or body carriers', async () => {
    const response = await request(buildApp())
      .post(`/api/daemon/heartbeat?daemon_token=${encodeURIComponent(daemonAccessToken)}`)
      .set('Authorization', `Bearer ${daemonAccessToken}`)
      .set('x-gpt-id', daemonAccessToken)
      .set('Cookie', `daemon_token=${daemonAccessToken}`)
      .send({
        ...heartbeatBody('alternate-carrier-heartbeat'),
        daemonToken: daemonAccessToken,
      });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('DAEMON_AUTH_REQUIRED');
    expect(storeMocks.every((storeMock) => storeMock.mock.calls.length === 0)).toBe(true);
  });

  it('preserves a historical partition and resolves it before recording heartbeat state', async () => {
    getTokenForInstance.mockReturnValue(historicalPartition);

    const response = await request(buildApp())
      .post('/api/daemon/heartbeat')
      .set('Authorization', 'Bearer test-unrelated-backend-token-1234567890')
      .set('x-arcanos-daemon-token', daemonAccessToken)
      .send(heartbeatBody('historical-daemon'));

    expect(response.status).toBe(200);
    expect(response.body.pong).toBe(true);
    expect(getTokenForInstance).toHaveBeenCalledWith('historical-daemon');
    expect(recordHeartbeat).toHaveBeenCalledWith(
      historicalPartition,
      expect.objectContaining({
        clientId: 'contained-daemon-client',
        instanceId: 'historical-daemon',
      })
    );
    expect(getTokenForInstance.mock.invocationCallOrder[0]).toBeLessThan(
      recordHeartbeat.mock.invocationCallOrder[0]
    );
    expect(setTokenForInstance).not.toHaveBeenCalled();
    expect(saveTokens).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain(historicalPartition);
    expect(JSON.stringify(response.body)).not.toContain(daemonAccessToken);
  });

  it('registers a new instance with only the canonical non-secret partition before heartbeat mutation', async () => {
    const response = await request(buildApp())
      .post('/api/daemon/heartbeat')
      .set('x-arcanos-daemon-token', daemonAccessToken)
      .send(heartbeatBody('new-daemon'));

    expect(response.status).toBe(200);
    expect(setTokenForInstance).toHaveBeenCalledWith('new-daemon', canonicalPartition);
    expect(saveTokens).toHaveBeenCalledTimes(1);
    expect(recordHeartbeat).toHaveBeenCalledWith(
      canonicalPartition,
      expect.objectContaining({ instanceId: 'new-daemon' })
    );
    expect(setTokenForInstance.mock.invocationCallOrder[0]).toBeLessThan(
      recordHeartbeat.mock.invocationCallOrder[0]
    );
    expect(saveTokens.mock.invocationCallOrder[0]).toBeLessThan(
      recordHeartbeat.mock.invocationCallOrder[0]
    );
    expect(JSON.stringify(storeMocks.flatMap((storeMock) => storeMock.mock.calls)))
      .not.toContain(daemonAccessToken);
  });

  it('uses the stored historical partition consistently for poll, ack, and result write', async () => {
    getTokenForInstance.mockReturnValue(historicalPartition);
    listPendingCommands.mockReturnValue([
      {
        id: 'command-1',
        name: 'inspect',
        payload: { target: 'runtime' },
        issuedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    acknowledgeCommands.mockReturnValue(1);

    const pollResponse = await request(buildApp())
      .get('/api/daemon/commands?instance_id=historical-daemon')
      .set('x-arcanos-daemon-token', daemonAccessToken);
    const ackResponse = await request(buildApp())
      .post('/api/daemon/commands/ack')
      .set('x-arcanos-daemon-token', daemonAccessToken)
      .send({ commandIds: ['command-1'], instanceId: 'historical-daemon' });
    const resultResponse = await request(buildApp())
      .post('/api/daemon/commands/result')
      .set('x-arcanos-daemon-token', daemonAccessToken)
      .send({
        commandId: 'command-1',
        instanceId: 'historical-daemon',
        result: { ok: true },
      });

    expect(pollResponse.status).toBe(200);
    expect(ackResponse.status).toBe(200);
    expect(resultResponse.status).toBe(200);
    expect(listPendingCommands).toHaveBeenCalledWith(
      historicalPartition,
      'historical-daemon'
    );
    expect(acknowledgeCommands).toHaveBeenCalledWith(
      historicalPartition,
      'historical-daemon',
      ['command-1'],
      expect.any(Number)
    );
    expect(recordCommandResult).toHaveBeenCalledWith(
      historicalPartition,
      'historical-daemon',
      'command-1',
      { ok: true }
    );
  });

  it('requires heartbeat registration before consuming an action confirmation', async () => {
    const response = await request(buildApp())
      .post('/api/daemon/confirm-actions')
      .set('x-arcanos-daemon-token', daemonAccessToken)
      .send({
        confirmation_token: 'confirmation-1',
        instanceId: 'unregistered-daemon',
      });

    expect(response.status).toBe(404);
    expect(consumePendingActions).not.toHaveBeenCalled();
    expect(queueCommandForInstance).not.toHaveBeenCalled();
  });

  it('passes only the registered store partition into confirmation consumption', async () => {
    getTokenForInstance.mockReturnValue(historicalPartition);
    consumePendingActions.mockReturnValue(2);

    const response = await request(buildApp())
      .post('/api/daemon/confirm-actions')
      .set('x-arcanos-daemon-token', daemonAccessToken)
      .send({
        confirmation_token: 'confirmation-1',
        instanceId: 'historical-daemon',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'executed', queued: 2 });
    expect(consumePendingActions).toHaveBeenCalledWith(
      'confirmation-1',
      'historical-daemon',
      historicalPartition
    );
  });

  it.each([
    ['historical', historicalPartition],
    ['canonical fallback', null],
  ] as const)('looks up command results using the %s partition and ignores DAEMON_DEFAULT_TOKEN', (
    _label,
    storedPartition
  ) => {
    process.env.DAEMON_DEFAULT_TOKEN = 'deprecated-default-partition-value';
    getTokenForInstance.mockReturnValue(storedPartition);
    getCommandResult.mockReturnValue({
      result: { ok: true },
      reportedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(getDaemonCommandResultForInstance('result-daemon', 'command-1')).toEqual({
      ok: true,
    });
    expect(getCommandResult).toHaveBeenCalledWith(
      storedPartition ?? canonicalPartition,
      'result-daemon',
      'command-1'
    );
    expect(JSON.stringify(getCommandResult.mock.calls))
      .not.toContain('deprecated-default-partition-value');
  });

  it('returns a terminal 404 for an authenticated unknown daemon path', async () => {
    const response = await request(buildApp())
      .post('/api/daemon/unknown-operation')
      .set('x-arcanos-daemon-token', daemonAccessToken)
      .send({ operation: 'unknown' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: 'Not Found',
      message: 'Daemon endpoint not found',
    });
    expect(storeMocks.every((storeMock) => storeMock.mock.calls.length === 0)).toBe(true);
  });

  it('no longer exposes the shadowed daemon-router /api/update implementation', async () => {
    const response = await request(buildApp())
      .post('/api/update')
      .send({ updateType: 'status', data: { ok: true } });

    expect(response.status).toBe(404);
    expect(storeMocks.every((storeMock) => storeMock.mock.calls.length === 0)).toBe(true);
  });
});

afterAll(() => {
  clearPurposeBoundCredentialEnvironment();
  for (const [environmentName, value] of originalCredentialEnvironment) {
    if (value !== undefined) {
      process.env[environmentName] = value;
    }
  }
  if (originalDaemonDefaultToken === undefined) {
    delete process.env.DAEMON_DEFAULT_TOKEN;
  } else {
    process.env.DAEMON_DEFAULT_TOKEN = originalDaemonDefaultToken;
  }
});

import { afterEach, describe, expect, it, jest } from '@jest/globals';

const recordHeartbeat = jest.fn();
const getTokenForInstance = jest.fn<() => string | undefined>();
const setTokenForInstance = jest.fn();
const saveTokens = jest.fn();

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
  createPendingActions: jest.fn(),
  consumePendingActions: jest.fn(),
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
const { default: apiDaemonRouter } = await import('../src/routes/api-daemon.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(apiDaemonRouter);
  return app;
}

function heartbeatBody(instanceId: string) {
  return {
    clientId: 'phase2a-daemon-client',
    instanceId,
    version: 'test',
  };
}

describe('daemon heartbeat credential contract', () => {
  afterEach(() => {
    jest.clearAllMocks();
    getTokenForInstance.mockReturnValue(undefined);
  });

  it('accepts the existing exact binding without rewriting token persistence', async () => {
    getTokenForInstance.mockReturnValue('anonymous-daemon');

    const response = await request(buildApp())
      .post('/api/daemon/heartbeat')
      .send(heartbeatBody('phase2a-existing-daemon'));

    expect(response.status).toBe(200);
    expect(response.body.pong).toBe(true);
    expect(recordHeartbeat).toHaveBeenCalledTimes(1);
    expect(setTokenForInstance).not.toHaveBeenCalled();
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it('preserves mismatch denial and the existing record-before-ownership-check ordering', async () => {
    const expectedCredential = ['opaque', 'existing', 'credential-marker'].join('-');
    getTokenForInstance.mockReturnValue(expectedCredential);

    const response = await request(buildApp())
      .post('/api/daemon/heartbeat')
      .send(heartbeatBody('phase2a-conflicting-daemon'));

    expect(response.status).toBe(403);
    expect(recordHeartbeat).toHaveBeenCalledTimes(1);
    expect(setTokenForInstance).not.toHaveBeenCalled();
    expect(saveTokens).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body).includes(expectedCredential)).toBe(false);
  });

  it('preserves first-registration binding and persistence calls', async () => {
    const response = await request(buildApp())
      .post('/api/daemon/heartbeat')
      .send(heartbeatBody('phase2a-new-daemon'));

    expect(response.status).toBe(200);
    expect(setTokenForInstance).toHaveBeenCalledTimes(1);
    expect(saveTokens).toHaveBeenCalledTimes(1);
  });
});

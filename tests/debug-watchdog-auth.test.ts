import { afterEach, describe, expect, it, jest } from '@jest/globals';

const setTrustedHash = jest.fn();
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
  setTrustedHash,
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const { registerRoutes } = await import('../src/routes/register.js');

const originalDebugWatchdog = process.env.DEBUG_WATCHDOG;
const originalDebugWatchdogKey = process.env.DEBUG_WATCHDOG_KEY;

function restoreEnvironment(): void {
  if (originalDebugWatchdog === undefined) {
    delete process.env.DEBUG_WATCHDOG;
  } else {
    process.env.DEBUG_WATCHDOG = originalDebugWatchdog;
  }
  if (originalDebugWatchdogKey === undefined) {
    delete process.env.DEBUG_WATCHDOG_KEY;
  } else {
    process.env.DEBUG_WATCHDOG_KEY = originalDebugWatchdogKey;
  }
}

function buildApp() {
  const app = express();
  registerRoutes(app);
  return app;
}

describe('debug watchdog credential contract', () => {
  afterEach(() => {
    restoreEnvironment();
  });

  it('preserves key-optional policy and Node header normalization before exact equality', async () => {
    process.env.DEBUG_WATCHDOG = 'true';
    delete process.env.DEBUG_WATCHDOG_KEY;
    const unconfigured = await request(buildApp()).get('/debug/watchdog');
    expect(unconfigured.status).toBe(200);

    const credential = ['phase2a', 'watchdog', 'sécurité'].join('-');
    const wrongSameLength = `${credential.slice(0, -1)}x`;
    process.env.DEBUG_WATCHDOG_KEY = credential;
    const app = buildApp();
    const missing = await request(app).get('/debug/watchdog');
    const wrong = await request(app).get('/debug/watchdog').set('x-debug-key', wrongSameLength);
    const whitespaceChanged = await request(app).get('/debug/watchdog').set('x-debug-key', ` ${credential}`);
    const exact = await request(app).get('/debug/watchdog').set('x-debug-key', credential);

    expect([missing.status, wrong.status, whitespaceChanged.status, exact.status]).toEqual([
      403,
      403,
      200,
      200,
    ]);
    const deniedOutput = JSON.stringify([
      missing.body,
      wrong.body,
    ]);
    expect(
      [credential, wrongSameLength].some((value) => deniedOutput.includes(value)),
    ).toBe(false);
  });
});

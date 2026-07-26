import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { PURPOSE_BOUND_CREDENTIAL_ENV_NAMES } from '../src/shared/security/purposeBoundCredential.js';

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

const debugWatchdogEnvironmentNames = [
  'DEBUG_WATCHDOG',
  ...PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
] as const;
const originalDebugWatchdogEnvironment = new Map(
  debugWatchdogEnvironmentNames.map((environmentName) => [
    environmentName,
    process.env[environmentName],
  ])
);

function restoreEnvironment(): void {
  for (const [environmentName, originalValue] of originalDebugWatchdogEnvironment) {
    if (originalValue === undefined) {
      delete process.env[environmentName];
    } else {
      process.env[environmentName] = originalValue;
    }
  }
}

function buildApp() {
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  return app;
}

describe('debug watchdog credential contract', () => {
  beforeEach(() => {
    for (const environmentName of debugWatchdogEnvironmentNames) {
      delete process.env[environmentName];
    }
  });

  afterEach(() => {
    restoreEnvironment();
  });

  it.each([undefined, 'false'] as const)(
    'leaves the route unmounted when DEBUG_WATCHDOG is %p',
    async (featureFlag) => {
      if (featureFlag !== undefined) {
        process.env.DEBUG_WATCHDOG = featureFlag;
      }
      process.env.DEBUG_WATCHDOG_KEY =
        'disabled-watchdog-credential-marker-123456';

      const response = await request(buildApp()).get('/debug/watchdog');

      expect(response.status).toBe(404);
    }
  );

  it.each([
    undefined,
    '',
    'short-debug-key',
    'change-me-debug-watchdog-key-123456789',
    ` ${'x'.repeat(32)}`,
    `${'x'.repeat(32)} `,
    'x'.repeat(4_097),
  ])(
    'fails closed without diagnostics for invalid server configuration %p',
    async (configuredKey) => {
      process.env.DEBUG_WATCHDOG = 'true';
      if (configuredKey !== undefined) {
        process.env.DEBUG_WATCHDOG_KEY = configuredKey;
      }

      const response = await request(buildApp()).get('/debug/watchdog');

      expect(response.status).toBe(503);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({ error: 'Service Unavailable' });
      expect(response.body).not.toHaveProperty('trinity');
      expect(response.body).not.toHaveProperty('runtime');
      expect(response.body).not.toHaveProperty('modelTimeouts');
      if (configuredKey) {
        expect(JSON.stringify(response.body)).not.toContain(configuredKey);
      }
    }
  );

  it('fails closed when the watchdog key reuses another purpose-bound credential', async () => {
    const credential = 'colliding-watchdog-credential-marker-123456';
    process.env.DEBUG_WATCHDOG = 'true';
    process.env.DEBUG_WATCHDOG_KEY = credential;
    process.env.ARCANOS_MEMORY_ACCESS_TOKEN = credential;

    const response = await request(buildApp())
      .get('/debug/watchdog')
      .set('x-debug-key', credential);

    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(response.body)).not.toContain(credential);
  });

  it('accepts only the exact custom header while preserving Node header normalization', async () => {
    process.env.DEBUG_WATCHDOG = 'true';
    const credential = ['phase2b', 'watchdog', 'sécurité', 'credential', '123456'].join('-');
    const wrongSameLength = `${credential.slice(0, -1)}x`;
    process.env.DEBUG_WATCHDOG_KEY = credential;
    const app = buildApp();
    const missing = await request(app).get('/debug/watchdog');
    const wrong = await request(app).get('/debug/watchdog').set('x-debug-key', wrongSameLength);
    const bearerOnly = await request(app)
      .get('/debug/watchdog')
      .set('Authorization', `Bearer ${credential}`);
    const queryOnly = await request(app)
      .get(`/debug/watchdog?x-debug-key=${encodeURIComponent(credential)}`);
    const cookieOnly = await request(app)
      .get('/debug/watchdog')
      .set('Cookie', `x-debug-key=${credential}`);
    const bodyOnly = await request(app)
      .get('/debug/watchdog')
      .send({ debugKey: credential });
    const whitespaceChanged = await request(app).get('/debug/watchdog').set('x-debug-key', ` ${credential}`);
    const exact = await request(app).get('/debug/watchdog').set('x-debug-key', credential);

    expect([
      missing.status,
      wrong.status,
      bearerOnly.status,
      queryOnly.status,
      cookieOnly.status,
      bodyOnly.status,
      whitespaceChanged.status,
      exact.status,
    ]).toEqual([
      403,
      403,
      403,
      403,
      403,
      403,
      200,
      200,
    ]);
    expect(exact.headers['cache-control']).toBe('no-store');
    expect(exact.body).toEqual(expect.objectContaining({
      trinity: expect.any(Object),
      runtime: expect.any(Object),
      modelTimeouts: expect.any(Object),
    }));
    const deniedOutput = JSON.stringify([
      missing.body,
      wrong.body,
      bearerOnly.body,
      queryOnly.body,
      cookieOnly.body,
      bodyOnly.body,
    ]);
    expect(
      [credential, wrongSameLength].some((value) => deniedOutput.includes(value)),
    ).toBe(false);
  });

  it('applies credential rotation, revocation, and invalidation without rebuilding the app', async () => {
    const originalCredential = 'watchdog-rotation-old-credential-123456';
    const rotatedCredential = 'watchdog-rotation-new-credential-123456';
    process.env.DEBUG_WATCHDOG = 'true';
    process.env.DEBUG_WATCHDOG_KEY = originalCredential;
    const app = buildApp();

    expect(
      (await request(app).get('/debug/watchdog').set('x-debug-key', originalCredential)).status
    ).toBe(200);

    process.env.DEBUG_WATCHDOG_KEY = rotatedCredential;
    expect(
      (await request(app).get('/debug/watchdog').set('x-debug-key', originalCredential)).status
    ).toBe(403);
    expect(
      (await request(app).get('/debug/watchdog').set('x-debug-key', rotatedCredential)).status
    ).toBe(200);

    delete process.env.DEBUG_WATCHDOG_KEY;
    const revoked = await request(app)
      .get('/debug/watchdog')
      .set('x-debug-key', rotatedCredential);
    expect(revoked.status).toBe(503);
    expect(JSON.stringify(revoked.body)).not.toContain(rotatedCredential);
  });
});

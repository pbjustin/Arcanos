import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneToken =
  'reinforcement-metrics-token-123456789012';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;

function configureControlPlane(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID =
    'operator:reinforcement-metrics';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'arcanos:read';
}

/**
 * Build reinforcement router with isolated dependency mocks.
 *
 * Purpose: verify metrics export endpoint wiring without DB/network side effects.
 * Inputs/outputs: no inputs -> supertest-compatible express app.
 * Edge cases: audit middleware is bypassed in test mode to simplify route assertions.
 */
async function buildReinforcementTestApp() {
  jest.resetModules();
  configureControlPlane();

  const judgedTelemetry = {
    attempts: 5,
    duplicatesSkipped: 2,
    persistedWrites: 3,
    persistenceFailures: 0,
    cacheEvictions: 1,
    cacheSize: 7,
    cacheMaxEntries: 200,
    idempotencyWindowMs: 300000,
    lastEventAt: '2026-03-05T00:00:00.000Z'
  };

  const reinforcementHealth = {
    status: 'ok',
    mode: 'reinforcement',
    window: 50,
    digestSize: 8,
    storedContexts: 10,
    audits: 3,
    minimumClearScore: 0.85
  };

  jest.unstable_mockModule('@transport/http/middleware/auditTrace.js', () => ({
    auditTrace: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
  }));
  jest.unstable_mockModule('@services/contextualReinforcement.js', () => ({
    registerContextEntry: jest.fn(),
    getReinforcementHealth: () => reinforcementHealth
  }));
  jest.unstable_mockModule('@services/memoryDigest.js', () => ({
    getMemoryDigest: () => ({ mode: 'reinforcement', window: 50, digest: [], entries: [] })
  }));
  jest.unstable_mockModule('@services/audit.js', () => ({
    processClearFeedback: jest.fn()
  }));
  jest.unstable_mockModule('@services/judgedResponseFeedback.js', () => ({
    processJudgedResponseFeedback: jest.fn(),
    getJudgedFeedbackRuntimeTelemetry: () => judgedTelemetry
  }));
  jest.unstable_mockModule('@core/lib/errors/index.js', () => ({
    resolveErrorMessage: (error: unknown) => String(error)
  }));
  jest.unstable_mockModule('@shared/http/index.js', () => ({
    sendBadRequest: (res: express.Response, code: string) => res.status(400).json({ error: code })
  }));

  const { default: reinforcementRouter } = await import('../src/routes/reinforcement.js');
  const app = express();
  app.use(express.json());
  app.use('/', reinforcementRouter);
  return { app, judgedTelemetry, reinforcementHealth };
}

describe('reinforcement metrics route', () => {
  it('returns judged-feedback runtime telemetry snapshot', async () => {
    const { app, judgedTelemetry, reinforcementHealth } = await buildReinforcementTestApp();

    const anonymousResponse = await request(app).get('/reinforcement/metrics');
    const response = await request(app)
      .get('/reinforcement/metrics')
      .set('Authorization', `Bearer ${controlPlaneToken}`);

    expect(anonymousResponse.status).toBe(401);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      status: 'ok',
      judgedFeedback: judgedTelemetry,
      reinforcement: reinforcementHealth
    });
  });
});

afterAll(() => {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
  for (const [environmentName, value] of originalCredentialEnvironment) {
    if (value !== undefined) {
      process.env[environmentName] = value;
    }
  }
  if (originalPrincipalId === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = originalPrincipalId;
  }
  if (originalScopes === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_SCOPES;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_SCOPES = originalScopes;
  }
});

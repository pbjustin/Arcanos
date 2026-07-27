import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';
import {
  AFOL_DECISION_BODY_LIMIT_BYTES,
} from '../src/services/controlPlane/afolBodyParser.js';

const controlPlaneToken = 'afol-route-token-123456789012345678901234567';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(
  scopes = 'arcanos:read,mcp:invoke',
  principalId = 'operator:afol-route'
): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = principalId;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

configureControlPlane();

const decideMock = jest.fn();
const getStatusMock = jest.fn();
const getRecentMock = jest.fn();
const logErrorMock = jest.fn();
const getAnalyticsSnapshotMock = jest.fn();

jest.unstable_mockModule('@core/afol/engine.js', () => ({
  decide: decideMock,
}));
jest.unstable_mockModule('@core/afol/health.js', () => ({
  getStatus: getStatusMock,
}));
jest.unstable_mockModule('@core/afol/logger.js', () => ({
  getRecent: getRecentMock,
  logError: logErrorMock,
}));
jest.unstable_mockModule('@core/afol/analytics.js', () => ({
  getAnalyticsSnapshot: getAnalyticsSnapshotMock,
}));

const afolRouter = (await import('../src/routes/afol.js')).default;

function buildDecision(overrides: Record<string, unknown> = {}) {
  return {
    id: 'afol_123_test',
    ok: true,
    policy: {
      allow: true,
      primaryAvailable: true,
      backupAvailable: true,
      rationale: 'Primary path stable',
    },
    route: {
      name: 'primary',
      reason: 'Primary healthy',
    },
    response: {
      route: 'primary',
      input: 'raw prompt sentinel',
      output: 'Safe AFOL answer.',
      model: 'ft:afol-model',
      cached: false,
      metadata: {
        routeReason: 'Primary healthy',
        intent: 'raw intent sentinel',
      },
    },
    meta: {
      latencyMs: 12,
      timestamp: '2026-07-27T12:00:00.000Z',
    },
    ...overrides,
  };
}

function buildApp(): Express {
  const app = express();
  app.use('/api/afol', afolRouter);
  return app;
}

function afolPost(app: Express, body: Record<string, unknown>) {
  return request(app)
    .post('/api/afol/decide')
    .set('Authorization', `Bearer ${controlPlaneToken}`)
    .send(body);
}

function afolRead(app: Express, path: string) {
  return request(app)
    .get(path)
    .set('Authorization', `Bearer ${controlPlaneToken}`);
}

function buildRedactionSentinel(payload: string): string {
  return ['s', 'k-', payload].join('');
}

describe('AFOL route security and redaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureControlPlane();
    decideMock.mockResolvedValue(buildDecision());
    getStatusMock.mockReturnValue({
      redis: { ok: true, latency: 14 },
      postgres: { ok: true, latency: 28 },
      api: { ok: true, latency: 53 },
    });
    getRecentMock.mockReturnValue([]);
    getAnalyticsSnapshotMock.mockReturnValue({
      totals: { decisions: 0, successful: 0, rejected: 0 },
      perRoute: { primary: 0, backup: 0, reject: 0 },
      latency: { averageMs: 0, lastMs: 0 },
      recent: [],
      lastUpdated: null,
    });
  });

  it('rejects manual compatibility approval and does not invoke AFOL', async () => {
    const response = await afolPost(buildApp(), { prompt: 'hello' })
      .set('x-confirmed', 'yes')
      .set('x-gpt-id', 'trusted-test-gpt')
      .set('x-arcanos-confirm-token', 'compatibility-marker');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(response.headers['x-confirmation-challenge']).toEqual(
      expect.any(String)
    );
    expect(decideMock).not.toHaveBeenCalled();
  });

  it('rejects deeply nested sub-limit JSON before issuing a challenge', async () => {
    const nestedBody = `${'{"a":'.repeat(6_000)}0${'}'.repeat(6_000)}`;
    expect(Buffer.byteLength(nestedBody, 'utf8')).toBeLessThan(
      AFOL_DECISION_BODY_LIMIT_BYTES
    );

    const response = await request(buildApp())
      .post('/api/afol/decide')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('Content-Type', 'application/json')
      .send(nestedBody);

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: 'AFOL_REQUEST_INVALID',
      message: 'AFOL request is invalid.',
    });
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
    expect(decideMock).not.toHaveBeenCalled();
  });

  it('invokes once after consuming the exact challenge and rejects replay', async () => {
    const app = buildApp();
    const body = { prompt: 'hello', intent: 'answer' };
    const pending = await afolPost(app, body);
    const challengeId = pending.headers['x-confirmation-challenge'];
    const confirmed = await afolPost(app, body)
      .set('x-confirmed', `token:${challengeId}`);
    const replay = await afolPost(app, body)
      .set('x-confirmed', `token:${challengeId}`);

    expect(pending.status).toBe(403);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.response.output).toBe('Safe AFOL answer.');
    expect(confirmed.body.response.input).toBe('[REDACTED_PROMPT]');
    expect(confirmed.body.response.metadata.intent).toBe('[REDACTED_INTENT]');
    expect(replay.status).toBe(403);
    expect(decideMock).toHaveBeenCalledTimes(1);
    expect(decideMock).toHaveBeenCalledWith(body);
  });

  it('independently binds challenges to the body and principal', async () => {
    const app = buildApp();
    const originalBody = { prompt: 'first' };
    const changedBody = { prompt: 'second' };
    const bodyPending = await afolPost(app, originalBody);
    const bodyChallengeId = bodyPending.headers['x-confirmation-challenge'];

    const changed = await afolPost(app, changedBody)
      .set('x-confirmed', `token:${bodyChallengeId}`);
    const principalPending = await afolPost(app, originalBody);
    const principalChallengeId =
      principalPending.headers['x-confirmation-challenge'];
    configureControlPlane(
      'arcanos:read,mcp:invoke',
      'operator:afol-route-other'
    );
    const changedPrincipal = await afolPost(app, originalBody)
      .set('x-confirmed', `token:${principalChallengeId}`);

    expect(bodyPending.status).toBe(403);
    expect(changed.status).toBe(403);
    expect(principalPending.status).toBe(403);
    expect(changedPrincipal.status).toBe(403);
    expect(decideMock).not.toHaveBeenCalled();
  });

  it('credential-redacts the live answer and fixes provider error text', async () => {
    const sentinel = buildRedactionSentinel('123456789012345678901234567890');
    decideMock.mockResolvedValue(buildDecision({
      ok: false,
      response: {
        route: 'primary',
        input: `prompt ${sentinel}`,
        output: `provider echoed ${sentinel}`,
        model: 'ft:afol-model',
        cached: false,
        error: `provider failed with ${sentinel}`,
        metadata: {
          routeReason: 'Primary healthy',
          intent: `intent ${sentinel}`,
          degraded: true,
        },
      },
    }));
    const app = buildApp();
    const body = { prompt: `prompt ${sentinel}` };
    const pending = await afolPost(app, body);
    const response = await afolPost(app, body)
      .set('x-confirmed', `token:${pending.headers['x-confirmation-challenge']}`);
    const rendered = JSON.stringify(response.body);

    expect(response.status).toBe(200);
    expect(response.body.response.output).toBe('[REDACTED]');
    expect(response.body.response.error).toBe(
      'AFOL route execution could not be completed.'
    );
    expect(rendered).not.toContain(sentinel);
    expect(rendered).not.toContain('provider failed');
  });

  it('never exposes historical prompts, completions, intents, or errors', async () => {
    const sentinel = buildRedactionSentinel('abcdefghijklmnopqrstuvwxyz123456');
    const historicalDecision = buildDecision({
      response: {
        route: 'primary',
        input: `historical prompt ${sentinel}`,
        output: 'historical completion sentinel',
        model: 'ft:afol-model',
        cached: true,
        error: `historical provider error ${sentinel}`,
        metadata: {
          routeReason: 'attacker-controlled reason',
          intent: 'historical intent sentinel',
        },
      },
    });
    getRecentMock.mockReturnValue([{
      timestamp: '2026-07-27T12:00:00.000Z',
      input: `raw log input ${sentinel}`,
      decision: historicalDecision,
      error: `raw log error ${sentinel}`,
    }]);
    getAnalyticsSnapshotMock.mockReturnValue({
      totals: { decisions: 1, successful: 1, rejected: 0 },
      perRoute: { primary: 1, backup: 0, reject: 0 },
      latency: { averageMs: 12, lastMs: 12 },
      recent: [historicalDecision],
      lastUpdated: '2026-07-27T12:00:00.000Z',
    });
    const app = buildApp();
    const logs = await afolRead(app, '/api/afol/logs');
    const analytics = await afolRead(app, '/api/afol/analytics');
    const rendered = JSON.stringify({
      logs: logs.body,
      analytics: analytics.body,
    });

    expect(logs.status).toBe(200);
    expect(analytics.status).toBe(200);
    expect(logs.body[0].input).toBe('[REDACTED_PROMPT]');
    expect(logs.body[0].decision.response.output).toBe('[REDACTED_OUTPUT]');
    expect(analytics.body.recent[0].response.output).toBe('[REDACTED_OUTPUT]');
    expect(rendered).not.toContain(sentinel);
    expect(rendered).not.toContain('historical completion sentinel');
    expect(rendered).not.toContain('historical intent sentinel');
    expect(rendered).not.toContain('historical provider error');
    expect(rendered).not.toContain('attacker-controlled reason');
  });

  it('returns a fixed failure without logging the thrown message', async () => {
    const sentinel = buildRedactionSentinel(
      'thrownsentinel123456789012345678'
    );
    decideMock.mockRejectedValue(new Error(`provider exception ${sentinel}`));
    const app = buildApp();
    const body = { prompt: 'fail safely' };
    const pending = await afolPost(app, body);
    const response = await afolPost(app, body)
      .set('x-confirmed', `token:${pending.headers['x-confirmation-challenge']}`);

    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({
      code: 'AFOL_DECISION_FAILED',
      message: 'AFOL decision could not be completed.',
    });
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect((logErrorMock.mock.calls[0]?.[1] as Error).message).toBe(
      'AFOL route execution could not be completed.'
    );
  });

  it('keeps the fixed failure envelope when the legacy file logger throws', async () => {
    const sentinel = buildRedactionSentinel(
      'logfailuresentinel123456789012345'
    );
    decideMock.mockRejectedValue(new Error('provider unavailable'));
    logErrorMock.mockImplementationOnce(() => {
      throw new Error(`unwritable log path ${sentinel}`);
    });
    const app = buildApp();
    const body = { prompt: 'fail with logger unavailable' };
    const pending = await afolPost(app, body);
    const response = await afolPost(app, body)
      .set('x-confirmed', `token:${pending.headers['x-confirmation-challenge']}`);

    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({
      code: 'AFOL_DECISION_FAILED',
      message: 'AFOL decision could not be completed.',
    });
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(logErrorMock).toHaveBeenCalledTimes(1);
  });

  it('projects only the fixed AFOL health services', async () => {
    getStatusMock.mockReturnValue({
      redis: { ok: true, latency: 14 },
      postgres: { ok: false, latency: 28 },
      api: { ok: true, latency: 53 },
      'internal-secret-service': {
        ok: true,
        latency: 1,
        detail: 'private endpoint',
      },
    });

    const response = await afolRead(buildApp(), '/api/afol/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      redis: { ok: true, latency: 14 },
      postgres: { ok: false, latency: 28 },
      api: { ok: true, latency: 53 },
    });
  });
});

afterAll(() => {
  clearPurposeBoundCredentialEnvironment();
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

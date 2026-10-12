import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  createRateLimitMiddleware,
  getRequestClientAddress,
  MAX_RATE_LIMIT_ENTRIES,
} from '../src/platform/runtime/security.js';
import { createGptAccessRateLimit } from '../src/services/gptAccessRateLimit.js';
import { PURPOSE_BOUND_CREDENTIAL_ENV_NAMES } from '../src/shared/security/purposeBoundCredential.js';

// Real HTTP authentication, scope/capability gates, coordinator and mitigation
// state. Only external effects are replaced; an attempted effect fails the test.
const forbiddenEffect = jest.fn(async () => {
  throw new Error('Synthetic security fixture forbids external effects.');
});
const findAgent = jest.fn(async () => null as Record<string, unknown> | null);
const audit = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const originalEnvironment = process.env;
const accessToken = 'mock-self-healing-control-token-1234567890';
const automationSecret = 'synthetic-self-healing-automation-secret-1234567890';
let principalSequence = 0;

jest.unstable_mockModule('@prisma/client', () => ({
  PrismaClient: class {
    agent = { findUnique: findAgent };
  },
  Prisma: {},
}));
jest.unstable_mockModule('@platform/runtime/redisLifecycle.js', () => ({
  executeRedisOperation: forbiddenEffect,
  getRedisLifecycleSnapshot: () => ({ configured: false, state: 'DISABLED', connected: false }),
}));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle: forbiddenEffect }));
jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({ recoverStaleJobs: forbiddenEffect }));
jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  getWorkerRuntimeStatus: () => ({ enabled: false, started: false, configuredCount: 0, activeListeners: 0, workerIds: [] }),
  recycleWorker: forbiddenEffect, scaleWorkersUp: forbiddenEffect, healWorkerRuntime: forbiddenEffect,
}));
jest.unstable_mockModule('@services/workerControlService.js', () => ({
  getWorkerControlHealth: forbiddenEffect, healWorkerRuntime: forbiddenEffect,
}));
jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({
  getWorkerAutonomySettings: () => ({ staleAfterMs: 60_000, watchdogIdleMs: 120_000, defaultMaxRetries: 2 }),
}));
jest.unstable_mockModule('@services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: { getRollingRequestWindow: forbiddenEffect, getRequestWindowSince: forbiddenEffect },
}));
jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({
  getTelemetrySnapshot: forbiddenEffect,
  recordTraceEvent: jest.fn(), recordLogEvent: jest.fn(), markOperation: jest.fn(), onTelemetry: jest.fn(),
}));
jest.unstable_mockModule('@services/openai/serviceHealth.js', () => ({
  getOpenAIServiceHealth: forbiddenEffect, reinitializeOpenAIProvider: forbiddenEffect,
}));
jest.unstable_mockModule('@services/selfImprove/predictiveHealingService.js', () => ({
  runPredictiveHealingFromLoop: forbiddenEffect,
}));
jest.unstable_mockModule('@services/selfImprove/selfHealTelemetry.js', () => ({
  inferSelfHealComponentFromAction: () => null,
  inferSelfHealComponentFromRequest: () => null,
  recordSelfHealEvent: jest.fn(), resetSelfHealTelemetryForTests: jest.fn(),
}));
jest.unstable_mockModule('@services/railwayClient.js', () => ({
  deployService: forbiddenEffect, listProjects: forbiddenEffect, isRailwayApiConfigured: () => false,
}));

let router: typeof import('../src/routes/self-improve.js')['default'];
let coordinator: typeof import('../src/services/selfImprove/selfHealingLoop.js');
let healing: typeof import('../src/services/selfImprove/selfHealingV2.js');
let promptMitigation: typeof import('../src/services/openai/promptRouteMitigation.js');
let killSwitch: typeof import('../src/services/incidentResponse/killSwitch.js');

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...originalEnvironment, NODE_ENV: 'test', ARCANOS_PROCESS_KIND: 'worker', RUN_WORKERS: 'false',
    SELF_IMPROVE_ENABLED: 'true', SELF_IMPROVE_ACTUATOR_MODE: 'daemon',
    SELF_IMPROVE_AUTONOMY_LEVEL: '3', SELF_IMPROVE_FREEZE: 'false',
    PREDICTIVE_HEALING_ENABLED: 'false', PREDICTIVE_AUTO_EXECUTE: 'false',
    PREDICTIVE_HEALING_DRY_RUN: 'true', LOG_LEVEL: 'error',
  };
  for (const key of [
    ...PURPOSE_BOUND_CREDENTIAL_ENV_NAMES, 'OPENAI_API_KEY', 'RAILWAY_OPENAI_API_KEY',
    'OPENAI_BASE_URL', 'RAILWAY_OPENAI_BASE_URL', 'RAILWAY_API_TOKEN', 'RAILWAY_TOKEN',
    'DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DATABASE_PUBLIC_URL', 'REDIS_URL',
  ]) delete environment[key];
  return environment;
}

function configurePrincipal(scopes = 'self-heal:decide,self-heal:execute,self-improve:control'): void {
  principalSequence += 1;
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = accessToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = `operator:synthetic-security:${principalSequence}`;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function buildControlApp(): express.Express {
  const app = express();
  app.use((req, _res, next) => {
    req.requestId = 'synthetic-security-request';
    req.logger = audit as never;
    next();
  });
  app.use(express.json());
  app.use(router);
  return app;
}

function actualConsumerState() {
  return {
    trinity: healing.getTrinitySelfHealingStatus(),
    prompt: promptMitigation.getPromptRouteMitigationState(),
    coordinator: coordinator.getSelfHealingLoopStatus(),
  };
}

beforeAll(async () => {
  process.env = isolatedEnvironment();
  router = (await import('../src/routes/self-improve.js')).default;
  coordinator = await import('../src/services/selfImprove/selfHealingLoop.js');
  healing = await import('../src/services/selfImprove/selfHealingV2.js');
  promptMitigation = await import('../src/services/openai/promptRouteMitigation.js');
  killSwitch = await import('../src/services/incidentResponse/killSwitch.js');
});

beforeEach(async () => {
  process.env = isolatedEnvironment();
  configurePrincipal();
  healing.resetTrinitySelfHealingStateForTests();
  coordinator.resetSelfHealingLoopStateForTests();
  await killSwitch.unfreezeSelfImprove('synthetic reset');
  await killSwitch.setAutonomyLevel(3, 'synthetic reset');
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnvironment;
});

describe('S13 / Scenario E: actual self-healing HTTP security boundary', () => {
  it('rejects forged agent and automation identities before the actual coordinator or any actuator', async () => {
    process.env.ARCANOS_AUTOMATION_SECRET = automationSecret;
    process.env.ARCANOS_AUTOMATION_HEADER = 'x-arcanos-automation';
    const before = actualConsumerState();
    const beforeKillSwitch = await killSwitch.getKillSwitchStatus();
    for (const authorization of [undefined, 'Bearer mock-invalid-control-token-1234567890']) {
      const pending = request(buildControlApp()).post('/api/self-improve/run?token=private-query-payload')
        .set('x-agent-id', 'forged-agent')
        .set('x-arcanos-automation', automationSecret)
        .set('x-forwarded-for', '198.51.100.99')
        .send({ trigger: 'incident', context: { secret: 'mock-private-body-payload' } });
      if (authorization) pending.set('Authorization', authorization);
      const response = await pending;
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(actualConsumerState()).toEqual(before);
    expect(coordinator.getSelfHealingLoopStatus().tickCount).toBe(0);
    expect(await killSwitch.getKillSwitchStatus()).toEqual(beforeKillSwitch);
    expect(findAgent).not.toHaveBeenCalled();
    expect(forbiddenEffect).not.toHaveBeenCalled();
    expect(audit.warn).toHaveBeenCalledWith('control_plane.http_auth.denied', {
      reason: 'missing_auth', statusCode: 401,
    });
    const serializedAudit = JSON.stringify(audit.warn.mock.calls);
    for (const sensitive of [accessToken, automationSecret, 'private-query-payload', 'private-body-payload']) {
      expect(serializedAudit).not.toContain(sensitive);
    }
  });

  it('denies missing execution scope before capability lookup and consumer-state mutation', async () => {
    configurePrincipal('self-heal:decide');
    const before = actualConsumerState();
    const response = await request(buildControlApp()).post('/api/self-improve/run?secret=private-query-payload')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('x-agent-id', 'forged-agent')
      .send({ trigger: 'incident' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
    expect(actualConsumerState()).toEqual(before);
    expect(findAgent).not.toHaveBeenCalled();
    expect(forbiddenEffect).not.toHaveBeenCalled();
    expect(audit.warn).toHaveBeenCalledWith('self_improve.http_authorization.denied', {
      reason: 'missing_scope', statusCode: 403, method: 'POST',
    });
    expect(JSON.stringify(audit.warn.mock.calls)).not.toContain('private-query-payload');
  });

  it('rejects every unauthenticated control mutation without changing the real safety actuator state', async () => {
    const before = await killSwitch.getKillSwitchStatus();
    for (const [path, body] of [
      ['/api/self-improve/freeze', {}],
      ['/api/self-improve/unfreeze', {}],
      ['/api/self-improve/autonomy', { level: 0 }],
    ] as const) {
      const response = await request(buildControlApp()).post(path)
        .set('x-agent-id', 'forged-agent')
        .send(body);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
      expect(await killSwitch.getKillSwitchStatus()).toEqual(before);
    }
    expect(findAgent).not.toHaveBeenCalled();
    expect(forbiddenEffect).not.toHaveBeenCalled();
    expect(coordinator.getSelfHealingLoopStatus().tickCount).toBe(0);
  });

  it('fails a missing registry capability closed after genuine bearer and scope authorization', async () => {
    const before = actualConsumerState();
    const response = await request(buildControlApp()).post('/api/self-improve/run')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('x-agent-id', 'nonexistent-synthetic-agent')
      .send({ trigger: 'incident' });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Agent lacks required capability');
    expect(findAgent).toHaveBeenCalledWith({ where: { id: 'nonexistent-synthetic-agent' } });
    expect(actualConsumerState()).toEqual(before);
    expect(forbiddenEffect).not.toHaveBeenCalled();
  });

  it('proves a properly authorized request reaches the real restrictive kill-switch actuator', async () => {
    process.env.ARCANOS_AUTOMATION_SECRET = automationSecret;
    process.env.ARCANOS_AUTOMATION_HEADER = 'x-arcanos-automation';
    expect(await killSwitch.getKillSwitchStatus()).toMatchObject({ frozen: false, autonomyLevel: 3 });
    const response = await request(buildControlApp()).post('/api/self-improve/freeze')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('x-arcanos-automation', automationSecret)
      .send({ reason: 'synthetic authorized safety restriction' });
    expect(response.status).toBe(200);
    expect(response.body.killSwitch).toEqual(await killSwitch.getKillSwitchStatus());
    expect(response.body.killSwitch).toMatchObject({ frozen: true, autonomyLevel: 0 });
    expect(audit.info).toHaveBeenCalledWith('self_improve.http_action.authorized', expect.objectContaining({
      action: 'freeze', direction: 'restrictive',
      principalId: process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID,
    }));
    expect(coordinator.getSelfHealingLoopStatus().tickCount).toBe(0);
    expect(forbiddenEffect).not.toHaveBeenCalled();
  });
});

describe('S16: rate-limit saturation uses actual admission middleware', () => {
  it('enforces the hard map ceiling with accurate expiry and no overflow allocation or actor eviction', () => {
    const nowMs = Date.parse('2026-10-12T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    const limiter = createRateLimitMiddleware({ maxRequests: 1, windowMs: 900_000, maxEntries: 1_000_000 });
    const res = {
      set: jest.fn(), status: jest.fn(), json: jest.fn(),
    } as unknown as Response;
    (res.status as jest.Mock).mockReturnValue(res);
    const consumer = jest.fn() as unknown as NextFunction;
    const mapSet = jest.spyOn(Map.prototype, 'set');
    const actorRequest = (index: number) => ({
      ip: `synthetic-network-${index}`, header: () => undefined,
    } as unknown as Request);
    try {
      for (let index = 0; index < MAX_RATE_LIMIT_ENTRIES + 1_000; index += 1) {
        limiter(actorRequest(index), res, consumer);
      }
      const storedCounters = mapSet.mock.calls.filter(([, value]) => value && typeof value === 'object' && 'resetTime' in value);
      expect(storedCounters).toHaveLength(MAX_RATE_LIMIT_ENTRIES);
      expect(new Set(storedCounters.map(([key]) => key)).size).toBe(MAX_RATE_LIMIT_ENTRIES);
      expect(storedCounters.every(([key]) => typeof key === 'string' && /^[a-f0-9]{64}$/u.test(key))).toBe(true);
      expect(consumer).toHaveBeenCalledTimes(MAX_RATE_LIMIT_ENTRIES);
      expect(res.status).toHaveBeenCalledTimes(1_000);
      expect(res.set).toHaveBeenLastCalledWith(expect.objectContaining({
        'Retry-After': '900', 'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': new Date(nowMs + 900_000).toISOString(),
      }));
      limiter(actorRequest(0), res, consumer);
      expect(consumer).toHaveBeenCalledTimes(MAX_RATE_LIMIT_ENTRIES);
      expect(res.status).toHaveBeenCalledTimes(1_001);
    } finally {
      mapSet.mockRestore();
    }
    jest.spyOn(Date, 'now').mockReturnValue(nowMs + 900_000);
    limiter(actorRequest(MAX_RATE_LIMIT_ENTRIES + 1_000), res, consumer);
    expect(consumer).toHaveBeenCalledTimes(MAX_RATE_LIMIT_ENTRIES + 1);
  });
});

describe('S17: actual GPT-access admission honors the configured proxy trust boundary', () => {
  it('rejects spoofed header/session/credential rotation from a direct peer before the consumer executes', async () => {
    const app = express();
    const consumer = jest.fn();
    app.use(createGptAccessRateLimit({ maxRequests: 1, windowMs: 60_000 }));
    app.post('/synthetic-consumer', (req, res) => {
      consumer();
      res.json({ address: getRequestClientAddress(req) });
    });
    const first = await request(app).post('/synthetic-consumer')
      .set('x-forwarded-for', '198.51.100.1').set('x-real-ip', '198.51.100.2');
    expect(first.status).toBe(200);
    expect(first.body.address).not.toBe('198.51.100.1');
    expect(first.body.address).not.toBe('198.51.100.2');
    for (let index = 0; index < 10; index += 1) {
      const denied = await request(app).post('/synthetic-consumer')
        .set('x-forwarded-for', `198.51.100.${index + 10}`)
        .set('x-real-ip', `203.0.113.${index + 10}`)
        .set('Forwarded', `for=192.0.2.${index + 10}`)
        .set('x-session-id', `rotating-session-${index}`)
        .set('Authorization', `Bearer mock-rotating-invalid-token-${index}`);
      expect(denied.status).toBe(429);
      expect(denied.headers['x-ratelimit-bucket']).toBe('gpt-access');
      expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(denied.headers['retry-after'])).toBeLessThanOrEqual(60);
    }
    expect(consumer).toHaveBeenCalledTimes(1);
  });

  it('uses the first untrusted hop instead of a spoofed leftmost address behind explicit trusted proxies', async () => {
    const app = express();
    app.set('trust proxy', (address: string) => ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.2'].includes(address));
    app.use(createGptAccessRateLimit({ maxRequests: 1, windowMs: 60_000 }));
    const consumer = jest.fn();
    app.get('/synthetic-consumer', (req, res) => {
      consumer();
      res.json({ address: getRequestClientAddress(req) });
    });
    const first = await request(app).get('/synthetic-consumer')
      .set('x-forwarded-for', '198.51.100.1, 203.0.113.20, 10.0.0.2');
    expect(first.status).toBe(200);
    expect(first.body.address).toBe('203.0.113.20');
    await request(app).get('/synthetic-consumer')
      .set('x-forwarded-for', '198.51.100.99, 203.0.113.20, 10.0.0.2')
      .expect(429);
    const otherCaller = await request(app).get('/synthetic-consumer')
      .set('x-forwarded-for', '198.51.100.99, 203.0.113.21, 10.0.0.2');
    expect(otherCaller.status).toBe(200);
    expect(otherCaller.body.address).toBe('203.0.113.21');
    expect(consumer).toHaveBeenCalledTimes(2);
  });
});

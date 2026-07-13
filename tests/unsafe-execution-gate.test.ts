import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import safetyRouter from '../src/routes/safety.js';
import unsafeExecutionGate from '../src/middleware/unsafeExecutionGate.js';
import {
  activateUnsafeCondition,
  reconcileAutoRecoverableQuarantinesForProcessStart,
  registerQuarantine,
  resetSafetyRuntimeStateForTests
} from '../src/services/safety/runtimeState.js';

function createUnsafeApp() {
  const app = express();
  app.use(express.json());
  app.use(unsafeExecutionGate);
  app.use(safetyRouter);
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/mutate', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

function activateIntegrityUnsafeConditionForTest() {
  const quarantine = registerQuarantine({
    kind: 'integrity',
    reason: 'test integrity failure',
    integrityFailure: true,
    autoRecoverable: false,
    metadata: {
      entityId: 'test:integrity'
    }
  });

  activateUnsafeCondition({
    code: 'PATTERN_INTEGRITY_FAILURE',
    message: 'Integrity mismatch during test',
    quarantineId: quarantine.quarantineId,
    metadata: {
      entityId: 'test:integrity'
    }
  });

  return quarantine.quarantineId;
}

describe('unsafeExecutionGate', () => {
  const originalAdminKey = process.env.ADMIN_KEY;

  beforeEach(() => {
    process.env.ADMIN_KEY = 'test-admin-key';
    resetSafetyRuntimeStateForTests();
  });

  afterEach(() => {
    resetSafetyRuntimeStateForTests();
  });

  afterAll(() => {
    if (originalAdminKey === undefined) {
      delete process.env.ADMIN_KEY;
    } else {
      process.env.ADMIN_KEY = originalAdminKey;
    }
  });

  it('blocks mutating requests with unsafe-to-proceed payload when unsafe state is active', async () => {
    const app = createUnsafeApp();
    activateIntegrityUnsafeConditionForTest();

    const response = await request(app).post('/mutate').send({ action: 'write' });
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('UNSAFE_TO_PROCEED');
    expect(Array.isArray(response.body.conditions)).toBe(true);
    expect(response.body.conditions).toContain('PATTERN_INTEGRITY_FAILURE');
  });

  it('keeps read-only endpoints available while unsafe state is active', async () => {
    const app = createUnsafeApp();
    activateIntegrityUnsafeConditionForTest();

    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('contains a valid Gaming evidence retry as a correlated HTTP 200 JSON envelope while unsafe', async () => {
    const app = createUnsafeApp();
    activateIntegrityUnsafeConditionForTest();

    const response = await request(app)
      .post('/gpt/arcanos-gaming/evidence-retry')
      .send({
        game: 'Palworld',
        mode: 'guide',
        originalPrompt: 'Look up a current beginner guide for Palworld 1.0.',
        candidateUrls: [],
        requestedVersion: '1.0',
        evidenceAttempt: 1
      });

    expect(response.status).toBe(200);
    expect(response.type).toBe('application/json');
    expect(response.body).toMatchObject({
      ok: true,
      requestId: expect.any(String),
      traceId: expect.any(String),
      result: {
        ok: false,
        route: 'gaming',
        mode: 'guide',
        error: { code: 'UNSAFE_TO_PROCEED' }
      },
      _route: {
        requestId: expect.any(String),
        traceId: expect.any(String),
        gptId: 'arcanos-gaming',
        route: 'gaming'
      }
    });
  });

  it('returns bounded JSON 400 for an invalid Gaming evidence retry while unsafe', async () => {
    const app = createUnsafeApp();
    activateIntegrityUnsafeConditionForTest();

    const response = await request(app)
      .post('/gpt/arcanos-gaming/evidence-retry')
      .send({
        game: 'Palworld',
        mode: 'guide',
        originalPrompt: 'Palworld guide',
        candidateUrls: [],
        evidenceAttempt: 2
      });

    expect(response.status).toBe(400);
    expect(response.type).toBe('application/json');
    expect(response.body).toMatchObject({
      ok: false,
      requestId: expect.any(String),
      traceId: expect.any(String),
      error: { code: 'EVIDENCE_RETRY_LIMIT_REACHED' }
    });
  });

  it.each([
    '/gpt/arcanos-gaming/evidence-retry/extra',
    '/gpt/arcanos-gaming/unrelated'
  ])('does not broaden Gaming unsafe semantics to nested path %s', async (path) => {
    const app = createUnsafeApp();
    activateIntegrityUnsafeConditionForTest();

    const response = await request(app).post(path).send({ action: 'query' });

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('UNSAFE_TO_PROCEED');
    expect(response.body).not.toHaveProperty('result.route', 'gaming');
  });

  it('restores mutating access after operator-confirmed quarantine release', async () => {
    const app = createUnsafeApp();
    const quarantineId = activateIntegrityUnsafeConditionForTest();

    const blockedResponse = await request(app).post('/mutate').send({ action: 'write' });
    expect(blockedResponse.status).toBe(503);

    const releaseResponse = await request(app)
      .post(`/status/safety/quarantine/${quarantineId}/release`)
      .set('x-api-key', 'test-admin-key')
      .set('x-operator-id', 'operator:test-suite')
      .send({
        confirmation: `release:${quarantineId}`,
        note: 'release from test suite'
      });
    expect(releaseResponse.status).toBe(200);
    expect(releaseResponse.body.released).toBe(true);

    const unblockedResponse = await request(app).post('/mutate').send({ action: 'write' });
    expect(unblockedResponse.status).toBe(200);
    expect(unblockedResponse.body.ok).toBe(true);
  });

  it('releases stale auto-recoverable worker quarantines after process restart reconciliation', async () => {
    const app = createUnsafeApp();
    const quarantine = registerQuarantine({
      kind: 'worker',
      reason: 'test heartbeat loss',
      integrityFailure: false,
      autoRecoverable: true,
      metadata: {
        entityId: 'worker:test-restart-recovery'
      }
    });

    activateUnsafeCondition({
      code: 'INTERPRETER_HEARTBEAT_LOSS',
      message: 'Heartbeat loss during test',
      quarantineId: quarantine.quarantineId,
      metadata: {
        entityId: 'worker:test-restart-recovery'
      }
    });

    const blockedResponse = await request(app).post('/mutate').send({ action: 'write' });
    expect(blockedResponse.status).toBe(503);

    const recoveryResult = reconcileAutoRecoverableQuarantinesForProcessStart(
      new Date(Date.now() + 1000).toISOString(),
      'operator:test-process-restart'
    );
    expect(recoveryResult.releasedQuarantineIds).toContain(quarantine.quarantineId);
    expect(recoveryResult.resetEntityIds).toContain('worker:test-restart-recovery');

    const unblockedResponse = await request(app).post('/mutate').send({ action: 'write' });
    expect(unblockedResponse.status).toBe(200);
    expect(unblockedResponse.body.ok).toBe(true);
  });
});

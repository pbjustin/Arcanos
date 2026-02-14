import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import safetyRouter from '../src/routes/safety.js';
import unsafeExecutionGate from '../src/middleware/unsafeExecutionGate.js';
import {
  activateUnsafeCondition,
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
});

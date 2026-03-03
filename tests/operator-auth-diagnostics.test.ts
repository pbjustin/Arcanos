import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import safetyRouter from '../src/routes/safety.js';

function createSafetyApp() {
  const app = express();
  app.use(express.json());
  app.use(safetyRouter);
  return app;
}

describe('operator auth diagnostics', () => {
  const originalAdminKey = process.env.ADMIN_KEY;

  beforeEach(() => {
    process.env.ADMIN_KEY = 'test-admin-key';
  });

  afterAll(() => {
    if (originalAdminKey === undefined) {
      delete process.env.ADMIN_KEY;
      return;
    }
    process.env.ADMIN_KEY = originalAdminKey;
  });

  it('returns public operator auth diagnostics without credentials', async () => {
    const app = createSafetyApp();

    const response = await request(app).get('/status/safety/operator-auth');
    expect(response.status).toBe(200);
    expect(response.body?.status).toBe('ok');
    expect(response.body?.operatorAuth?.required).toBe(false);
    expect(response.body?.operatorAuth?.mode).toBe('disabled');
    expect(response.body?.operatorAuth?.configured).toBe(false);
    expect(response.body?.operatorAuth?.acceptedCredentials).toEqual([]);
  });

  it('allows release endpoint without credentials when deterministic confirmation is provided', async () => {
    const app = createSafetyApp();

    const response = await request(app)
      .post('/status/safety/quarantine/example/release')
      .send({ confirmation: 'release:example' });

    expect(response.status).toBe(404);
    expect(response.body?.error).toBe('QUARANTINE_NOT_FOUND');
  });

  it('remains disabled when ADMIN_KEY is not configured', async () => {
    delete process.env.ADMIN_KEY;
    const app = createSafetyApp();

    const diagnosticsResponse = await request(app).get('/status/safety/operator-auth');
    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsResponse.body?.operatorAuth?.required).toBe(false);
    expect(diagnosticsResponse.body?.operatorAuth?.mode).toBe('disabled');
    expect(diagnosticsResponse.body?.operatorAuth?.configured).toBe(false);

    const releaseResponse = await request(app)
      .post('/status/safety/quarantine/example/release')
      .send({ confirmation: 'release:example' });

    expect(releaseResponse.status).toBe(404);
    expect(releaseResponse.body?.error).toBe('QUARANTINE_NOT_FOUND');
  });
});

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
    expect(response.body?.operatorAuth?.required).toBe(true);
    expect(response.body?.operatorAuth?.mode).toBe('enforced');
    expect(response.body?.operatorAuth?.configured).toBe(true);
    expect(response.body?.operatorAuth?.acceptedCredentials).toContain('Authorization: Bearer <ADMIN_KEY>');
  });

  it('returns structured remediation when protected safety endpoint is called without credentials', async () => {
    const app = createSafetyApp();

    const response = await request(app).post('/status/safety/quarantine/example/release').send({
      confirmation: 'release:example'
    });
    expect(response.status).toBe(401);
    expect(response.body?.error).toBe('UNAUTHORIZED');
    expect(response.body?.details).toContain('Authorization Bearer token or x-api-key is required');
    expect(response.body?.remediation).toContain('Provide the ADMIN_KEY value in the Authorization Bearer header.');
    expect(response.body?.diagnosticEndpoints).toContain('GET /status/safety/operator-auth');
  });

  it('disables operator auth requirement when ADMIN_KEY is not configured', async () => {
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
    expect(releaseResponse.headers['x-operator-auth-mode']).toBe('disabled');
    expect(releaseResponse.body?.error).toBe('QUARANTINE_NOT_FOUND');
  });
});

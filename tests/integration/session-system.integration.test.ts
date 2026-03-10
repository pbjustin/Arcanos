import crypto from 'crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import apiSessionSystemRouter from '@routes/api-session-system.js';
import { close, initializeDatabaseWithSchema } from '@core/db/index.js';
import errorHandler from '@transport/http/middleware/errorHandler.js';

//audit Assumption: this DB-backed integration suite can legitimately exceed Jest's default 5s hook timeout during package build + schema bootstrap; failure risk: hook timeout aborts setup mid-flight and leaves the pool in a misleading half-closed state; expected invariant: the suite gets the same 60s budget for hooks and test bodies; handling strategy: raise the file-level Jest timeout before any hooks register.
jest.setTimeout(60_000);

/**
 * Build an isolated integration app with the canonical session system routes mounted.
 *
 * Purpose:
 * - Exercise the real DB-backed session API contract without unrelated application routers.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: Express app with the canonical router and API-style 404 fallback.
 *
 * Edge case behavior:
 * - Unknown `/api/*` routes return the canonical missing-route JSON contract.
 */
function createIntegrationTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/', apiSessionSystemRouter);
  app.use(errorHandler);
  app.use((req, res) => {
    res.status(404).json({
      error: 'Route Not Found',
      code: 404
    });
  });
  return app;
}

const databaseBackedSessionIntegrationSuite = (
  process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0
    ? describe
    : describe.skip
);

//audit Assumption: CI environments without DATABASE_URL should not fail unrelated suites while still allowing explicit DB-backed verification where configured; failure risk: deployment gates fail in environments that intentionally omit PostgreSQL; expected invariant: the canonical session integration suite only runs when durable storage is explicitly configured; handling strategy: gate the suite on DATABASE_URL presence and preserve the bootstrap failure once a DB-backed run is requested.
databaseBackedSessionIntegrationSuite('canonical session system integration', () => {
  let app: Express;

  beforeAll(async () => {
    const ready = await initializeDatabaseWithSchema('session-system-integration');

    //audit Assumption: this integration suite must exercise real durable storage, not a mock or memory fallback; failure risk: restart-survival checks pass without PostgreSQL; expected invariant: DB bootstrap succeeds before the suite runs; handling strategy: fail fast when durable storage is unavailable.
    if (!ready) {
      throw new Error('Database not configured for session system integration tests');
    }

    app = createIntegrationTestApp();
  });

  afterAll(async () => {
    await close();
  });

  it('saves, retrieves, lists, replays, and survives a restart with the exact stored token', async () => {
    const randomToken = `ARCANOS-PROBE-${crypto.randomUUID()}`;
    const uniqueTag = `session_diagnostic_${Date.now()}`;
    const createResponse = await request(app)
      .post('/api/sessions')
      .send({
        label: 'ARCANOS backend diagnostics session',
        tag: uniqueTag,
        memoryType: 'diagnostic',
        payload: {
          token: randomToken
        }
      });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.saved).toBe(true);
    expect(createResponse.body.storage).toBe('postgres');

    const sessionId = String(createResponse.body.id);

    const getResponse = await request(app).get(`/api/sessions/${sessionId}`);
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.payload).toEqual({
      token: randomToken
    });

    const listResponse = await request(app)
      .get('/api/sessions')
      .query({ q: uniqueTag, limit: 10 });
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.total).toBeGreaterThanOrEqual(1);
    expect(listResponse.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sessionId,
          tag: uniqueTag,
          memoryType: 'diagnostic'
        })
      ])
    );

    const replayResponse = await request(app)
      .post(`/api/sessions/${sessionId}/replay`)
      .send({});
    expect(replayResponse.status).toBe(200);
    expect(replayResponse.body.sessionId).toBe(sessionId);
    expect(replayResponse.body.replayedVersion).toBe(1);
    expect(replayResponse.body.mode).toBe('readonly');
    expect(replayResponse.body.payload).toEqual({
      token: randomToken
    });

    const healthRoutesResponse = await request(app).get('/api/health/routes');
    expect(healthRoutesResponse.status).toBe(200);
    expect(healthRoutesResponse.body.routes).toEqual(
      expect.arrayContaining([
        'POST /api/sessions',
        'GET /api/sessions',
        'GET /api/sessions/:id',
        'POST /api/sessions/:id/replay',
        'GET /api/health',
        'GET /api/health/routes'
      ])
    );

    const diagnosticsResponse = await request(app).get('/api/diagnostics/storage');
    expect(diagnosticsResponse.status).toBe(200);
    expect(typeof diagnosticsResponse.body).toBe('object');
    expect(Array.isArray(diagnosticsResponse.body)).toBe(false);
    expect(diagnosticsResponse.body.storage).toBe('postgres');

    await close();
    app = createIntegrationTestApp();

    const restartGetResponse = await request(app).get(`/api/sessions/${sessionId}`);
    expect(restartGetResponse.status).toBe(200);
    expect(restartGetResponse.body.payload).toEqual({
      token: randomToken
    });
  }, 60_000);
});

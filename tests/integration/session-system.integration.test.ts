import crypto from 'crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import errorHandler from '@transport/http/middleware/errorHandler.js';
import {
  assertDisposablePostgresTestDatabaseUrl,
  resolvePostgresTestDatabaseUrl
} from './postgresTestDatabase.js';

const TEST_DATABASE_ENV = 'SESSION_SYSTEM_TEST_DATABASE_URL';
const configuredDatabaseUrl = resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV);
if (configuredDatabaseUrl) {
  assertDisposablePostgresTestDatabaseUrl(configuredDatabaseUrl, TEST_DATABASE_ENV);
}

let apiSessionSystemRouter: typeof import('@routes/api-session-system.js').default;
let database: typeof import('@core/db/index.js') | undefined;

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
  configuredDatabaseUrl
    ? describe
    : describe.skip
);

//audit Assumption: ordinary unit jobs omit PostgreSQL; failure risk: a required SQL job silently skips or targets configured application storage; invariant: required mode rejects an absent dedicated URL and only the guarded disposable target reaches database imports.
databaseBackedSessionIntegrationSuite('canonical session system integration', () => {
  let app: Express;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = configuredDatabaseUrl;
    database = await import('@core/db/index.js');
    ({ default: apiSessionSystemRouter } = await import('@routes/api-session-system.js'));
    const ready = await database.initializeDatabaseWithSchema('session-system-integration');

    //audit Assumption: this integration suite must exercise real durable storage, not a mock or memory fallback; failure risk: restart-survival checks pass without PostgreSQL; expected invariant: DB bootstrap succeeds before the suite runs; handling strategy: fail fast when durable storage is unavailable.
    if (!ready) {
      throw new Error('Database not configured for session system integration tests');
    }

    app = createIntegrationTestApp();
  });

  afterAll(async () => {
    try {
      await database?.close();
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
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

    await database!.close();
    app = createIntegrationTestApp();

    const restartGetResponse = await request(app).get(`/api/sessions/${sessionId}`);
    expect(restartGetResponse.status).toBe(200);
    expect(restartGetResponse.body.payload).toEqual({
      token: randomToken
    });
  }, 60_000);
});

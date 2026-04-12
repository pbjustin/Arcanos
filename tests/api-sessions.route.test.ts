import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import errorHandler from '../src/transport/http/middleware/errorHandler.js';

const mockWriteSession = jest.fn();
const mockReadSession = jest.fn();
const mockListSessions = jest.fn();
const mockReplaySession = jest.fn();
const mockGetSessionSystemDiagnostics = jest.fn();
const mockGetQueueDiagnostics = jest.fn();
const mockGetStorageDiagnostics = jest.fn();

jest.unstable_mockModule('@services/sessionStorage.js', () => ({
  writeSession: mockWriteSession,
  readSession: mockReadSession,
  listSessions: mockListSessions,
  replaySession: mockReplaySession,
  getSessionStorageBackendType: () => 'postgres'
}));

jest.unstable_mockModule('@services/sessionSystemDiagnosticsService.js', () => ({
  getSessionSystemDiagnostics: mockGetSessionSystemDiagnostics,
  getQueueDiagnostics: mockGetQueueDiagnostics,
  getStorageDiagnostics: mockGetStorageDiagnostics
}));

jest.unstable_mockModule('@transport/http/middleware/auditTrace.js', () => ({
  auditTrace: (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.locals.auditTraceId = 'trace-api-session-system';
    next();
  }
}));

const { default: apiSessionSystemRouter } = await import('../src/routes/api-session-system.js');

/**
 * Build an isolated test app for the canonical session system routes.
 *
 * Purpose:
 * - Exercise the public route contract without unrelated app middleware.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: Express app with the canonical session system router mounted.
 *
 * Edge case behavior:
 * - `/api/*` misses return the same JSON contract as the main app fallback.
 */
function createCanonicalSessionApiTestApp(): Express {
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

describe('canonical /api session system routes', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createCanonicalSessionApiTestApp();
  });

  it('persists a session through POST /api/sessions', async () => {
    mockWriteSession.mockResolvedValue({
      id: '8e8349d6-42b0-43eb-b8f8-86845c498451',
      label: 'ARCANOS backend diagnostics session',
      tag: 'session_diagnostic_2026-03-08',
      memoryType: 'diagnostic',
      payload: {
        probeValue: 'ARCANOS-CHECK-VALUE'
      },
      transcriptSummary: null,
      auditTraceId: 'trace-api-session-system',
      createdAt: '2026-03-09T12:00:00.000Z',
      updatedAt: '2026-03-09T12:00:00.000Z'
    });

    const response = await request(app)
      .post('/api/sessions')
      .send({
        label: 'ARCANOS backend diagnostics session',
        tag: 'session_diagnostic_2026-03-08',
        memoryType: 'diagnostic',
        payload: {
          probeValue: 'ARCANOS-CHECK-VALUE'
        }
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: '8e8349d6-42b0-43eb-b8f8-86845c498451',
      saved: true,
      storage: 'postgres',
      createdAt: '2026-03-09T12:00:00.000Z'
    });
    expect(mockWriteSession).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'ARCANOS backend diagnostics session',
        tag: 'session_diagnostic_2026-03-08',
        memoryType: 'diagnostic',
        payload: {
          probeValue: 'ARCANOS-CHECK-VALUE'
        },
        auditTraceId: 'trace-api-session-system'
      })
    );
  });

  it('returns the exact stored payload from GET /api/sessions/:id', async () => {
    mockReadSession.mockResolvedValue({
      id: '8e8349d6-42b0-43eb-b8f8-86845c498451',
      label: 'ARCANOS backend diagnostics session',
      tag: 'session_diagnostic_2026-03-08',
      memoryType: 'diagnostic',
      payload: {
        probeValue: 'ARCANOS-CHECK-VALUE'
      },
      transcriptSummary: null,
      auditTraceId: 'trace-api-session-system',
      createdAt: '2026-03-09T12:00:00.000Z',
      updatedAt: '2026-03-09T12:00:00.000Z'
    });

    const response = await request(app).get('/api/sessions/8e8349d6-42b0-43eb-b8f8-86845c498451');

    expect(response.status).toBe(200);
    expect(response.body.payload).toEqual({
      probeValue: 'ARCANOS-CHECK-VALUE'
    });
    expect(mockReadSession).toHaveBeenCalledWith('8e8349d6-42b0-43eb-b8f8-86845c498451');
  });

  it('lists real session rows from GET /api/sessions', async () => {
    mockListSessions.mockResolvedValue({
      items: [
        {
          id: '8e8349d6-42b0-43eb-b8f8-86845c498451',
          label: 'ARCANOS backend diagnostics session',
          tag: 'session_diagnostic_2026-03-08',
          memoryType: 'diagnostic',
          createdAt: '2026-03-09T12:00:00.000Z',
          updatedAt: '2026-03-09T12:00:00.000Z'
        }
      ],
      total: 1
    });

    const response = await request(app)
      .get('/api/sessions')
      .query({ q: 'session_diagnostic_2026-03-08', limit: 10 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [
        {
          id: '8e8349d6-42b0-43eb-b8f8-86845c498451',
          label: 'ARCANOS backend diagnostics session',
          tag: 'session_diagnostic_2026-03-08',
          memoryType: 'diagnostic',
          createdAt: '2026-03-09T12:00:00.000Z',
          updatedAt: '2026-03-09T12:00:00.000Z'
        }
      ],
      total: 1
    });
    expect(mockListSessions).toHaveBeenCalledWith({
      limit: 10,
      search: 'session_diagnostic_2026-03-08'
    });
  });

  it('replays a stored version through POST /api/sessions/:id/replay', async () => {
    mockReplaySession.mockResolvedValue({
      sessionId: '8e8349d6-42b0-43eb-b8f8-86845c498451',
      replayedVersion: 3,
      mode: 'readonly',
      payload: {
        probeValue: 'ARCANOS-CHECK-VALUE'
      },
      auditTraceId: 'trace-api-session-system',
      replayedAt: '2026-03-09T12:00:01.000Z'
    });

    const response = await request(app)
      .post('/api/sessions/8e8349d6-42b0-43eb-b8f8-86845c498451/replay')
      .send({
        version_number: 3
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      sessionId: '8e8349d6-42b0-43eb-b8f8-86845c498451',
      replayedVersion: 3,
      mode: 'readonly',
      payload: {
        probeValue: 'ARCANOS-CHECK-VALUE'
      },
      auditTraceId: 'trace-api-session-system',
      replayedAt: '2026-03-09T12:00:01.000Z'
    });
    expect(mockReplaySession).toHaveBeenCalledWith('8e8349d6-42b0-43eb-b8f8-86845c498451', 3);
  });

  it('returns machine-verifiable diagnostics JSON only', async () => {
    mockGetSessionSystemDiagnostics.mockResolvedValue({
      status: 'live',
      storage: 'postgres',
      routes: [
        'GET /api/health',
        'GET /api/health/routes',
        'POST /api/sessions'
      ],
      queueConnected: true,
      buildId: 'abc123',
      timestamp: '2026-03-09T12:00:00.000Z'
    });
    mockGetQueueDiagnostics.mockResolvedValue({
      status: 'live',
      workerRunning: true,
      queueDepth: 0,
      failureRate: 0,
      historicalFailureRate: 0.25,
      failureRateWindowMs: 3600000,
      windowCompletedJobs: 3,
      windowFailedJobs: 0,
      windowTerminalJobs: 3,
      failureBreakdown: {
        retryable: 0,
        permanent: 0,
        retryScheduled: 0,
        retryExhausted: 0,
        deadLetter: 0,
        authentication: 0,
        network: 0,
        provider: 0,
        rateLimited: 0,
        timeout: 0,
        validation: 0,
        unknown: 0
      },
      recentFailureReasons: [],
      lastJobId: 'job-1',
      lastJobStatus: 'completed',
      lastJobFinishedAt: '2026-03-09T12:00:00.000Z',
      timestamp: '2026-03-09T12:00:00.000Z'
    });
    mockGetStorageDiagnostics.mockResolvedValue({
      status: 'live',
      storage: 'postgres',
      databaseConnected: true,
      sessionCount: 3,
      sessionVersionCount: 3,
      buildId: 'abc123',
      timestamp: '2026-03-09T12:00:00.000Z'
    });

    const [sessionSystemResponse, queueResponse, storageResponse] = await Promise.all([
      request(app).get('/api/diagnostics/session-system'),
      request(app).get('/api/diagnostics/queues'),
      request(app).get('/api/diagnostics/storage')
    ]);

    expect(sessionSystemResponse.status).toBe(200);
    expect(sessionSystemResponse.body).toEqual({
      status: 'live',
      storage: 'postgres',
      routes: [
        'GET /api/health',
        'GET /api/health/routes',
        'POST /api/sessions'
      ],
      queueConnected: true,
      buildId: 'abc123',
      timestamp: '2026-03-09T12:00:00.000Z'
    });
    expect(queueResponse.body.queueDepth).toBe(0);
    expect(queueResponse.body.failureRate).toBe(0);
    expect(queueResponse.body.historicalFailureRate).toBe(0.25);
    expect(queueResponse.body.failureRateWindowMs).toBe(3600000);
    expect(queueResponse.body.windowTerminalJobs).toBe(3);
    expect(queueResponse.body.failureBreakdown).toEqual(expect.objectContaining({
      retryable: 0,
      retryExhausted: 0
    }));
    expect(storageResponse.body.sessionCount).toBe(3);
  });

  it('returns the mounted canonical route table from GET /api/health/routes', async () => {
    const response = await request(app).get('/api/health/routes');

    expect(response.status).toBe(200);
    expect(response.body.routes).toEqual(
      expect.arrayContaining([
        'GET /api/diagnostics/queues',
        'GET /api/diagnostics/session-system',
        'GET /api/diagnostics/storage',
        'GET /api/health',
        'GET /api/health/routes',
        'GET /api/sessions',
        'GET /api/sessions/:id',
        'POST /api/sessions',
        'POST /api/sessions/:id/replay'
      ])
    );
    expect(response.body.routes).not.toEqual(
      expect.arrayContaining([
        'GET /api/sessions/replay',
        'GET /ask/replay',
        'POST /api/ask/replay',
        'POST /sessions/:id/replay'
      ])
    );
  });

  it('treats legacy alias paths as missing routes instead of valid session ids', async () => {
    const response = await request(app).get('/api/sessions/get').query({ sessionId: 'test123' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: 'Route Not Found',
      code: 404
    });
  });

  it('returns structured validation errors for invalid session create payloads', async () => {
    const response = await request(app)
      .post('/api/sessions')
      .send({
        label: '',
        memoryType: 'diagnostic'
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid Session Create Payload');
    expect(response.body.code).toBe(400);
    expect(Array.isArray(response.body.details)).toBe(true);
  });

  it('fails closed when a diagnostics payload violates the public schema', async () => {
    mockGetStorageDiagnostics.mockResolvedValue({
      status: 'live',
      storage: 'postgres',
      databaseConnected: true,
      sessionCount: 3,
      sessionVersionCount: 'invalid-count',
      buildId: 'abc123',
      timestamp: '2026-03-09T12:00:00.000Z'
    });

    const response = await request(app).get('/api/diagnostics/storage');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'Internal Server Error',
      code: 500
    });
  });
});

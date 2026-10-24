import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const writeSessionMock = jest.fn();
const readSessionMock = jest.fn();
const listSessionsMock = jest.fn();
const replaySessionMock = jest.fn();

jest.unstable_mockModule('@services/sessionStorage.js', () => ({
  getSessionStorageBackendType: () => 'postgres',
  listSessions: listSessionsMock,
  readSession: readSessionMock,
  replaySession: replaySessionMock,
  writeSession: writeSessionMock
}));
jest.unstable_mockModule('@services/sessionSystemDiagnosticsService.js', () => ({
  getQueueDiagnostics: jest.fn(),
  getSessionSystemDiagnostics: jest.fn(),
  getStorageDiagnostics: jest.fn()
}));
jest.unstable_mockModule('@services/runtimeRouteTableService.js', () => ({
  getCanonicalPublicRouteTable: () => [],
  getActiveRouteTable: () => []
}));
jest.unstable_mockModule('@transport/http/middleware/auditTrace.js', () => ({
  auditTrace: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
}));

const router = (await import('../src/routes/api-session-system.js')).default;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  readSessionMock.mockResolvedValue(null);
  writeSessionMock.mockResolvedValue({
    id: '11111111-1111-1111-1111-111111111111',
    createdAt: '2026-10-23T12:34:56Z'
  });
});

describe('session route validation compatibility', () => {
  it('preserves omitted unknown payload through the existing storage boundary', async () => {
    const response = await request(createApp()).post('/api/sessions').send({
      label: '  Session label  ',
      memoryType: 'conversation'
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: '11111111-1111-1111-1111-111111111111',
      saved: true,
      storage: 'postgres',
      createdAt: '2026-10-23T12:34:56Z'
    });
    expect(writeSessionMock).toHaveBeenCalledWith({
      label: 'Session label',
      tag: undefined,
      memoryType: 'conversation',
      payload: undefined,
      transcriptSummary: undefined,
      auditTraceId: null
    });
  });

  it.each([
    '11111111-1111-1111-1111-111111111111',
    'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
  ])('retains the existing UUID syntax for session lookup %s', async (id) => {
    const response = await request(createApp()).get(`/api/sessions/${id}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Session Not Found');
    expect(readSessionMock).toHaveBeenCalledWith(id);
  });

  it('rejects malformed session identifiers before storage', async () => {
    const response = await request(createApp()).get('/api/sessions/not-a-uuid');

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Route Not Found');
    expect(readSessionMock).not.toHaveBeenCalled();
  });

  it('retains the UTF-16 label bound and its public detail', async () => {
    const response = await request(createApp()).post('/api/sessions').send({
      label: '😀'.repeat(101),
      memoryType: 'conversation'
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Invalid Session Create Payload',
      code: 400,
      details: ['String must contain at most 200 character(s)']
    });
    expect(writeSessionMock).not.toHaveBeenCalled();
  });
});

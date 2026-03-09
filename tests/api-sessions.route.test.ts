import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockListUserSessions = jest.fn();
const mockGetUserSessionDetail = jest.fn();
const mockGetConversation = jest.fn();
const mockGetChannel = jest.fn();
const mockGetCachedSessions = jest.fn();
const mockSaveMessage = jest.fn();
const mockBuildSessionReplayRestoreState = jest.fn();
const mockRecordTraceEvent = jest.fn();

jest.unstable_mockModule('@services/sessionCatalogService.js', () => ({
  listUserSessions: mockListUserSessions,
  getUserSessionDetail: mockGetUserSessionDetail
}));

jest.unstable_mockModule('@services/sessionMemoryService.js', () => ({
  getConversation: mockGetConversation,
  getChannel: mockGetChannel,
  getCachedSessions: mockGetCachedSessions,
  saveMessage: mockSaveMessage
}));

jest.unstable_mockModule('@services/sessionReplayStateService.js', () => ({
  buildSessionReplayRestoreState: mockBuildSessionReplayRestoreState
}));

jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({
  recordTraceEvent: mockRecordTraceEvent,
  recordLogEvent: jest.fn(),
  markOperation: jest.fn(),
  getTelemetrySnapshot: jest.fn(),
  onTelemetry: jest.fn(),
  resetTelemetry: jest.fn()
}));

jest.unstable_mockModule('@transport/http/middleware/auditTrace.js', () => ({
  auditTrace: (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.locals.auditTraceId = 'trace-session-api';
    next();
  }
}));

const { default: apiSessionsRouter } = await import('../src/routes/api-sessions.js');

/**
 * Build an isolated test app for `/api/sessions` route coverage.
 * Inputs/outputs: none -> Express app with the API sessions router mounted.
 * Edge cases: mocked audit middleware injects a stable trace id for deterministic assertions.
 */
function createApiSessionsTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/', apiSessionsRouter);
  return app;
}

describe('/api/sessions routes', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApiSessionsTestApp();
  });

  it('returns the hydrated session catalog from GET /api/sessions', async () => {
    mockListUserSessions.mockResolvedValue([
      {
        sessionId: 'session-alpha',
        updatedAt: '2026-03-09T04:00:00.000Z',
        messageCount: 3,
        replayable: true,
        topic: 'Alpha session',
        summary: 'Alpha summary',
        tags: ['alpha'],
        latestRole: 'assistant',
        latestContentPreview: 'Latest alpha update'
      }
    ]);

    const response = await request(app).get('/api/sessions').query({ limit: 25, q: 'alpha' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.traceId).toBe('trace-session-api');
    expect(response.body.data.count).toBe(1);
    expect(response.body.data.sessions[0].sessionId).toBe('session-alpha');
    expect(mockListUserSessions).toHaveBeenCalledWith({
      limit: 25,
      search: 'alpha'
    });
    expect(mockRecordTraceEvent).toHaveBeenCalledWith(
      'sessions.api.list.succeeded',
      expect.objectContaining({
        traceId: 'trace-session-api',
        method: 'GET',
        path: '/api/sessions',
        count: 1,
        search: 'alpha'
      })
    );
  });

  it('returns normalized session detail from GET /api/sessions/:sessionId', async () => {
    mockGetUserSessionDetail.mockResolvedValue({
      sessionId: 'session-detail-1',
      updatedAt: '2026-03-09T04:00:00.000Z',
      messageCount: 2,
      replayable: true,
      topic: 'Replay candidate',
      summary: 'Replay summary',
      tags: ['replay'],
      latestRole: 'assistant',
      latestContentPreview: 'Assistant reply',
      versionId: 'session-v1',
      monotonicTimestampMs: 123456,
      droppedMessageCount: 0,
      metadata: {
        topic: 'Replay candidate',
        summary: 'Replay summary',
        tags: ['replay']
      },
      conversation: [
        {
          index: 0,
          role: 'user',
          content: 'Restore this',
          timestamp: 100,
          meta: { audit_tag: 'restore-user' }
        },
        {
          index: 1,
          role: 'assistant',
          content: 'Session restored',
          timestamp: 101,
          meta: { audit_tag: 'restore-assistant' }
        }
      ]
    });

    const response = await request(app).get('/api/sessions/session-detail-1');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.traceId).toBe('trace-session-api');
    expect(response.body.data.session.sessionId).toBe('session-detail-1');
    expect(response.body.data.session.conversation).toHaveLength(2);
    expect(mockGetUserSessionDetail).toHaveBeenCalledWith('session-detail-1');
    expect(mockRecordTraceEvent).toHaveBeenCalledWith(
      'sessions.api.detail.succeeded',
      expect.objectContaining({
        traceId: 'trace-session-api',
        method: 'GET',
        path: '/api/sessions/session-detail-1',
        sessionId: 'session-detail-1',
        messageCount: 2,
        replayable: true
      })
    );
  });

  it('replays a session transcript from GET /api/sessions/replay using query sessionId', async () => {
    mockGetConversation.mockResolvedValue([
      {
        role: 'user',
        content: 'Restore collection replay session',
        timestamp: 201,
        meta: { audit_tag: 'restore-user' }
      },
      {
        role: 'assistant',
        content: 'Collection replay restored',
        timestamp: 202,
        meta: { audit_tag: 'restore-assistant' }
      }
    ]);
    mockBuildSessionReplayRestoreState.mockResolvedValue({
      sessionId: 'session-replay-query-1',
      reconstructedAt: '2026-03-09T05:00:00.000Z',
      source: 'session-cache+memory-channels',
      session: {
        sessionId: 'session-replay-query-1',
        updatedAt: '2026-03-09T05:00:00.000Z',
        messageCount: 2,
        replayable: true,
        topic: 'Collection replay',
        summary: 'Replay restore state',
        tags: ['restore'],
        latestRole: 'assistant',
        latestContentPreview: 'Collection replay restored',
        versionId: 'session-v1',
        monotonicTimestampMs: 202,
        droppedMessageCount: 0,
        metadata: { topic: 'Collection replay' },
        conversation: []
      },
      channels: {
        conversations_core: [
          { role: 'user', content: 'Restore collection replay session', timestamp: 201 },
          { role: 'assistant', content: 'Collection replay restored', timestamp: 202 }
        ],
        system_meta: [
          { audit_tag: 'restore-user', timestamp: 201 },
          { audit_tag: 'restore-assistant', timestamp: 202 }
        ]
      },
      state: {
        sessionId: 'session-replay-query-1',
        updatedAt: '2026-03-09T05:00:00.000Z',
        versionId: 'session-v1',
        monotonicTimestampMs: 202,
        metadata: { topic: 'Collection replay' },
        replayable: true,
        messageCount: 2,
        droppedMessageCount: 0,
        conversation: [
          {
            index: 0,
            role: 'user',
            content: 'Restore collection replay session',
            timestamp: 201,
            meta: { audit_tag: 'restore-user' }
          },
          {
            index: 1,
            role: 'assistant',
            content: 'Collection replay restored',
            timestamp: 202,
            meta: { audit_tag: 'restore-assistant' }
          }
        ]
      },
      diagnostics: {
        conversationChannelCount: 2,
        systemMetaCount: 2,
        metadataSource: 'session-detail'
      }
    });

    const response = await request(app)
      .get('/api/sessions/replay')
      .query({ sessionId: 'session-replay-query-1', limit: 1 });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.traceId).toBe('trace-session-api');
    expect(response.body.data.sessionId).toBe('session-replay-query-1');
    expect(response.body.data.transcript).toEqual([
      { role: 'assistant', content: 'Collection replay restored' }
    ]);
    expect(response.body.data.restore.state.sessionId).toBe('session-replay-query-1');
    expect(response.body.data.restore.state.conversation).toHaveLength(2);
    expect(response.body.data.restore.channels.system_meta).toHaveLength(2);
    expect(mockGetConversation).toHaveBeenCalledWith('session-replay-query-1');
    expect(mockBuildSessionReplayRestoreState).toHaveBeenCalledWith('session-replay-query-1');
    expect(mockGetUserSessionDetail).not.toHaveBeenCalled();
    expect(mockRecordTraceEvent).toHaveBeenCalledWith(
      'sessions.replay.succeeded',
      expect.objectContaining({
        traceId: 'trace-session-api',
        method: 'GET',
        path: '/api/sessions/replay',
        sessionId: 'session-replay-query-1',
        returnedCount: 1,
        truncated: true
      })
    );
  });

  it('replays a session transcript from POST /api/sessions/replay using body sessionId', async () => {
    mockGetConversation.mockResolvedValue([
      {
        role: 'user',
        content: 'Restore collection replay session',
        timestamp: 301,
        meta: { audit_tag: 'restore-user' }
      },
      {
        role: 'assistant',
        content: 'Collection replay restored',
        timestamp: 302,
        meta: { audit_tag: 'restore-assistant' }
      }
    ]);
    mockBuildSessionReplayRestoreState.mockResolvedValue({
      sessionId: 'session-replay-body-1',
      reconstructedAt: '2026-03-09T05:01:00.000Z',
      source: 'memory-channels',
      session: null,
      channels: {
        conversations_core: [
          { role: 'user', content: 'Restore collection replay session', timestamp: 301 },
          { role: 'assistant', content: 'Collection replay restored', timestamp: 302 }
        ],
        system_meta: [
          { audit_tag: 'restore-user', timestamp: 301 },
          { audit_tag: 'restore-assistant', timestamp: 302 }
        ]
      },
      state: {
        sessionId: 'session-replay-body-1',
        updatedAt: '2026-03-09T05:01:00.000Z',
        versionId: null,
        monotonicTimestampMs: null,
        metadata: {},
        replayable: true,
        messageCount: 2,
        droppedMessageCount: 0,
        conversation: [
          {
            index: 0,
            role: 'user',
            content: 'Restore collection replay session',
            timestamp: 301,
            meta: { audit_tag: 'restore-user' }
          },
          {
            index: 1,
            role: 'assistant',
            content: 'Collection replay restored',
            timestamp: 302,
            meta: { audit_tag: 'restore-assistant' }
          }
        ]
      },
      diagnostics: {
        conversationChannelCount: 2,
        systemMetaCount: 2,
        metadataSource: 'empty'
      }
    });

    const response = await request(app)
      .post('/api/sessions/replay')
      .send({ sessionId: 'session-replay-body-1', limit: 2 });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.traceId).toBe('trace-session-api');
    expect(response.body.data.sessionId).toBe('session-replay-body-1');
    expect(response.body.data.transcript).toEqual([
      { role: 'user', content: 'Restore collection replay session' },
      { role: 'assistant', content: 'Collection replay restored' }
    ]);
    expect(response.body.data.restore.source).toBe('memory-channels');
    expect(response.body.data.restore.state.messageCount).toBe(2);
    expect(mockGetConversation).toHaveBeenCalledWith('session-replay-body-1');
    expect(mockBuildSessionReplayRestoreState).toHaveBeenCalledWith('session-replay-body-1');
    expect(mockGetUserSessionDetail).not.toHaveBeenCalled();
    expect(mockRecordTraceEvent).toHaveBeenCalledWith(
      'sessions.replay.succeeded',
      expect.objectContaining({
        traceId: 'trace-session-api',
        method: 'POST',
        path: '/api/sessions/replay',
        sessionId: 'session-replay-body-1',
        returnedCount: 2,
        truncated: false
      })
    );
  });

  it('replays a session transcript from POST /api/sessions/:sessionId/replay', async () => {
    mockGetConversation.mockResolvedValue([
      {
        role: 'user',
        content: 'Restore this session',
        timestamp: 101,
        meta: { audit_tag: 'restore-user' }
      },
      {
        role: 'assistant',
        content: 'Session restored',
        timestamp: 102,
        meta: { audit_tag: 'restore-assistant' }
      }
    ]);
    mockBuildSessionReplayRestoreState.mockResolvedValue({
      sessionId: 'session-replay-1',
      reconstructedAt: '2026-03-09T05:02:00.000Z',
      source: 'session-cache+memory-channels',
      session: null,
      channels: {
        conversations_core: [
          { role: 'user', content: 'Restore this session', timestamp: 101 },
          { role: 'assistant', content: 'Session restored', timestamp: 102 }
        ],
        system_meta: [
          { audit_tag: 'restore-user', timestamp: 101 },
          { audit_tag: 'restore-assistant', timestamp: 102 }
        ]
      },
      state: {
        sessionId: 'session-replay-1',
        updatedAt: '2026-03-09T05:02:00.000Z',
        versionId: null,
        monotonicTimestampMs: null,
        metadata: {},
        replayable: true,
        messageCount: 2,
        droppedMessageCount: 0,
        conversation: [
          {
            index: 0,
            role: 'user',
            content: 'Restore this session',
            timestamp: 101,
            meta: { audit_tag: 'restore-user' }
          },
          {
            index: 1,
            role: 'assistant',
            content: 'Session restored',
            timestamp: 102,
            meta: { audit_tag: 'restore-assistant' }
          }
        ]
      },
      diagnostics: {
        conversationChannelCount: 2,
        systemMetaCount: 2,
        metadataSource: 'empty'
      }
    });

    const response = await request(app)
      .post('/api/sessions/session-replay-1/replay')
      .send({ sessionId: 'ignored-body-session', limit: 1 });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.traceId).toBe('trace-session-api');
    expect(response.body.data.sessionId).toBe('session-replay-1');
    expect(response.body.data.transcript).toEqual([
      { role: 'assistant', content: 'Session restored' }
    ]);
    expect(response.body.data.restore.state.sessionId).toBe('session-replay-1');
    expect(response.body.data.restore.channels.conversations_core).toHaveLength(2);
    expect(mockGetConversation).toHaveBeenCalledWith('session-replay-1');
    expect(mockBuildSessionReplayRestoreState).toHaveBeenCalledWith('session-replay-1');
    expect(mockRecordTraceEvent).toHaveBeenCalledWith(
      'sessions.replay.succeeded',
      expect.objectContaining({
        traceId: 'trace-session-api',
        method: 'POST',
        path: '/api/sessions/session-replay-1/replay',
        sessionId: 'session-replay-1',
        returnedCount: 1,
        truncated: true
      })
    );
  });
});

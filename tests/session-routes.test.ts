import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockResolveSession = jest.fn();
const mockListUserSessions = jest.fn();
const mockGetConversation = jest.fn();
const mockGetChannel = jest.fn();
const mockGetCachedSessions = jest.fn();
const mockSaveMessage = jest.fn();
const mockBuildSessionReplayRestoreState = jest.fn();

jest.unstable_mockModule('../src/services/sessionResolver.js', () => ({
  resolveSession: mockResolveSession
}));

jest.unstable_mockModule('../src/services/sessionCatalogService.js', () => ({
  listUserSessions: mockListUserSessions
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

const { default: sessionRoutes } = await import('../src/routes/sessionRoutes.js');

/**
 * Build an isolated test app for session route coverage.
 * Inputs/outputs: none -> Express app with session routes mounted.
 * Edge cases: isolated router mounting keeps session API assertions deterministic.
 */
function createSessionRoutesTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/', sessionRoutes);
  return app;
}

describe('session routes', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createSessionRoutesTestApp();
  });

  it('returns the hydrated session catalog from GET /sessions', async () => {
    mockListUserSessions.mockResolvedValue([
      {
        sessionId: 'raw_vancouver_2026',
        updatedAt: '2026-03-09T04:00:00.000Z',
        messageCount: 2,
        replayable: true,
        topic: 'Vancouver recap',
        summary: 'Latest recap',
        tags: ['raw', 'vancouver'],
        latestRole: 'assistant',
        latestContentPreview: 'Vaquer closed the show'
      }
    ]);

    const response = await request(app).get('/sessions').query({ limit: 25, q: 'vancouver' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.data.count).toBe(1);
    expect(response.body.data.sessions[0].sessionId).toBe('raw_vancouver_2026');
    expect(mockListUserSessions).toHaveBeenCalledWith({
      limit: 25,
      search: 'vancouver'
    });
  });

  it('replays a session transcript from POST /sessions/:sessionId/replay', async () => {
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
      reconstructedAt: '2026-03-09T05:06:00.000Z',
      source: 'memory-channels',
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
        updatedAt: '2026-03-09T05:06:00.000Z',
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
      .post('/sessions/session-replay-1/replay')
      .send({ sessionId: 'ignored-body-session', limit: 1 });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.data.sessionId).toBe('session-replay-1');
    expect(response.body.data.replay.map((entry: { index: number }) => entry.index)).toEqual([1]);
    expect(response.body.data.transcript).toEqual([
      { role: 'assistant', content: 'Session restored' }
    ]);
    expect(response.body.data.restore.state.sessionId).toBe('session-replay-1');
    expect(response.body.data.restore.channels.system_meta).toHaveLength(2);
    expect(mockGetConversation).toHaveBeenCalledWith('session-replay-1');
  });

  it('returns 404 for replay requests without replayable turns', async () => {
    mockGetConversation.mockResolvedValue([]);
    mockBuildSessionReplayRestoreState.mockResolvedValue(null);

    const response = await request(app).post('/sessions/missing-session/replay').send({});

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Replay transcript not found');
    expect(response.body.data.sessionId).toBe('missing-session');
  });
});

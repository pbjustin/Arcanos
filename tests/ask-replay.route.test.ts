import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetConversation = jest.fn();
const mockGetChannel = jest.fn();
const mockGetCachedSessions = jest.fn();
const mockSaveMessage = jest.fn();
const mockBuildSessionReplayRestoreState = jest.fn();

jest.unstable_mockModule('@services/sessionMemoryService.js', () => ({
  getConversation: mockGetConversation,
  getChannel: mockGetChannel,
  getCachedSessions: mockGetCachedSessions,
  saveMessage: mockSaveMessage
}));

jest.unstable_mockModule('@services/sessionReplayStateService.js', () => ({
  buildSessionReplayRestoreState: mockBuildSessionReplayRestoreState
}));

const { default: askRouter } = await import('../src/routes/ask.js');

/**
 * Build an isolated test app for replay route coverage on the ask router.
 * Inputs/outputs: none -> Express app with ask routes mounted.
 * Edge cases: isolated mount keeps replay assertions independent from global app middleware.
 */
function createAskReplayTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/', askRouter);
  return app;
}

describe('ask replay routes', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createAskReplayTestApp();
  });

  it('returns a normalized replay transcript from /replay', async () => {
    mockGetConversation.mockResolvedValue([
      {
        role: 'user',
        content: 'Plan the DAG rerun',
        timestamp: 1,
        meta: { tokens: 11, audit_tag: 'user' }
      },
      {
        role: 'assistant',
        content: 'Rerun is ready.',
        timestamp: 2,
        meta: { tokens: 21, audit_tag: 'assistant' }
      },
      {
        role: 'assistant',
        content: '   ',
        timestamp: 3,
        meta: { tokens: 5, audit_tag: 'blank' }
      }
    ]);
    mockBuildSessionReplayRestoreState.mockResolvedValue({
      sessionId: 'session-replay-1',
      reconstructedAt: '2026-03-09T05:03:00.000Z',
      source: 'session-cache+memory-channels',
      session: null,
      channels: {
        conversations_core: [
          { role: 'user', content: 'Plan the DAG rerun', timestamp: 1 },
          { role: 'assistant', content: 'Rerun is ready.', timestamp: 2 }
        ],
        system_meta: [
          { tokens: 11, audit_tag: 'user', timestamp: 1 },
          { tokens: 21, audit_tag: 'assistant', timestamp: 2 }
        ]
      },
      state: {
        sessionId: 'session-replay-1',
        updatedAt: '2026-03-09T05:03:00.000Z',
        versionId: null,
        monotonicTimestampMs: null,
        metadata: {},
        replayable: true,
        messageCount: 2,
        droppedMessageCount: 1,
        conversation: [
          {
            index: 0,
            role: 'user',
            content: 'Plan the DAG rerun',
            timestamp: 1,
            meta: { tokens: 11, audit_tag: 'user' }
          },
          {
            index: 1,
            role: 'assistant',
            content: 'Rerun is ready.',
            timestamp: 2,
            meta: { tokens: 21, audit_tag: 'assistant' }
          }
        ]
      },
      diagnostics: {
        conversationChannelCount: 2,
        systemMetaCount: 2,
        metadataSource: 'empty'
      }
    });

    const response = await request(app).get('/replay').query({ sessionId: 'session-replay-1' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.data.sessionId).toBe('session-replay-1');
    expect(response.body.data.totalCount).toBe(3);
    expect(response.body.data.returnedCount).toBe(2);
    expect(response.body.data.droppedCount).toBe(1);
    expect(response.body.data.transcript).toEqual([
      { role: 'user', content: 'Plan the DAG rerun' },
      { role: 'assistant', content: 'Rerun is ready.' }
    ]);
    expect(response.body.data.replay[0]).toEqual(
      expect.objectContaining({
        index: 0,
        role: 'user',
        content: 'Plan the DAG rerun',
        timestamp: 1,
        meta: { tokens: 11, audit_tag: 'user' }
      })
    );
    expect(response.body.data.restore.state.sessionId).toBe('session-replay-1');
    expect(response.body.data.restore.state.conversation).toHaveLength(2);
    expect(response.body.data.restore.state.droppedMessageCount).toBe(1);
  });

  it('applies the limit on /ask/replay while preserving chronological order', async () => {
    mockGetConversation.mockResolvedValue([
      { role: 'user', content: 'turn-1', timestamp: 1, meta: {} },
      { role: 'assistant', content: 'turn-2', timestamp: 2, meta: {} },
      { role: 'user', content: 'turn-3', timestamp: 3, meta: {} }
    ]);
    mockBuildSessionReplayRestoreState.mockResolvedValue({
      sessionId: 'session-replay-2',
      reconstructedAt: '2026-03-09T05:04:00.000Z',
      source: 'memory-channels',
      session: null,
      channels: {
        conversations_core: [
          { role: 'user', content: 'turn-1', timestamp: 1 },
          { role: 'assistant', content: 'turn-2', timestamp: 2 },
          { role: 'user', content: 'turn-3', timestamp: 3 }
        ],
        system_meta: []
      },
      state: {
        sessionId: 'session-replay-2',
        updatedAt: '2026-03-09T05:04:00.000Z',
        versionId: null,
        monotonicTimestampMs: null,
        metadata: {},
        replayable: true,
        messageCount: 3,
        droppedMessageCount: 0,
        conversation: [
          { index: 0, role: 'user', content: 'turn-1', timestamp: 1, meta: {} },
          { index: 1, role: 'assistant', content: 'turn-2', timestamp: 2, meta: {} },
          { index: 2, role: 'user', content: 'turn-3', timestamp: 3, meta: {} }
        ]
      },
      diagnostics: {
        conversationChannelCount: 3,
        systemMetaCount: 0,
        metadataSource: 'empty'
      }
    });

    const response = await request(app).post('/ask/replay').send({
      sessionId: 'session-replay-2',
      limit: 2
    });

    expect(response.status).toBe(200);
    expect(response.body.data.truncated).toBe(true);
    expect(response.body.data.limit).toBe(2);
    expect(response.body.data.replay.map((turn: { index: number }) => turn.index)).toEqual([1, 2]);
    expect(response.body.data.transcript).toEqual([
      { role: 'assistant', content: 'turn-2' },
      { role: 'user', content: 'turn-3' }
    ]);
    expect(response.body.data.restore.state.messageCount).toBe(3);
  });

  it('rejects replay requests without a sessionId', async () => {
    const response = await request(app).get('/ask/replay');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('REPLAY_SESSION_ID_REQUIRED');
    expect(mockGetConversation).not.toHaveBeenCalled();
  });

  it('returns 404 when a session has no replayable conversation', async () => {
    mockGetConversation.mockResolvedValue([]);
    mockBuildSessionReplayRestoreState.mockResolvedValue(null);

    const response = await request(app).post('/replay').send({ sessionId: 'missing-session' });

    expect(response.status).toBe(404);
    expect(response.body.status).toBe('error');
    expect(response.body.message).toBe('Replay transcript not found');
    expect(response.body.data.sessionId).toBe('missing-session');
  });
});

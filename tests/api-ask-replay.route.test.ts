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

const { default: apiAskRouter } = await import('../src/routes/api-ask.js');

/**
 * Build an isolated test app for replay coverage on the legacy API ask router.
 * Inputs/outputs: none -> Express app with `/api/ask/replay` mounted.
 * Edge cases: isolated mount avoids unrelated global middleware and route side effects.
 */
function createApiAskReplayTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/', apiAskRouter);
  return app;
}

describe('/api/ask/replay', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApiAskReplayTestApp();
  });

  it('returns replay data for API ask clients', async () => {
    mockGetConversation.mockResolvedValue([
      {
        role: 'user',
        content: 'resume the Trinity run',
        timestamp: 10,
        meta: { audit_tag: 'resume', tokens: 8 }
      },
      {
        role: 'assistant',
        content: 'replay transcript ready',
        timestamp: 11,
        meta: { audit_tag: 'resume', tokens: 13 }
      }
    ]);
    mockBuildSessionReplayRestoreState.mockResolvedValue({
      sessionId: 'api-replay-1',
      reconstructedAt: '2026-03-09T05:05:00.000Z',
      source: 'session-cache+memory-channels',
      session: null,
      channels: {
        conversations_core: [
          { role: 'user', content: 'resume the Trinity run', timestamp: 10 },
          { role: 'assistant', content: 'replay transcript ready', timestamp: 11 }
        ],
        system_meta: [
          { audit_tag: 'resume', tokens: 8, timestamp: 10 },
          { audit_tag: 'resume', tokens: 13, timestamp: 11 }
        ]
      },
      state: {
        sessionId: 'api-replay-1',
        updatedAt: '2026-03-09T05:05:00.000Z',
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
            content: 'resume the Trinity run',
            timestamp: 10,
            meta: { audit_tag: 'resume', tokens: 8 }
          },
          {
            index: 1,
            role: 'assistant',
            content: 'replay transcript ready',
            timestamp: 11,
            meta: { audit_tag: 'resume', tokens: 13 }
          }
        ]
      },
      diagnostics: {
        conversationChannelCount: 2,
        systemMetaCount: 2,
        metadataSource: 'empty'
      }
    });

    const response = await request(app).get('/api/ask/replay').query({ sessionId: 'api-replay-1' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.data.sessionId).toBe('api-replay-1');
    expect(response.body.data.returnedCount).toBe(2);
    expect(response.body.data.transcript).toEqual([
      { role: 'user', content: 'resume the Trinity run' },
      { role: 'assistant', content: 'replay transcript ready' }
    ]);
    expect(response.body.data.restore.state.sessionId).toBe('api-replay-1');
    expect(response.body.data.restore.channels.system_meta).toHaveLength(2);
    expect(mockGetConversation).toHaveBeenCalledWith('api-replay-1');
  });
});

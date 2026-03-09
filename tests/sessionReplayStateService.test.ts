import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetUserSessionDetail = jest.fn();
const mockGetChannel = jest.fn();
const mockGetConversation = jest.fn();

jest.unstable_mockModule('../src/services/sessionCatalogService.js', () => ({
  getUserSessionDetail: mockGetUserSessionDetail
}));

jest.unstable_mockModule('../src/services/sessionMemoryService.js', () => ({
  getChannel: mockGetChannel,
  getConversation: mockGetConversation
}));

const { buildSessionReplayRestoreState } = await import('../src/services/sessionReplayStateService.js');

describe('sessionReplayStateService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reconstructs full restore state from session detail and channels', async () => {
    mockGetUserSessionDetail.mockResolvedValue({
      sessionId: 'restore-session-1',
      updatedAt: '2026-03-09T05:10:00.000Z',
      messageCount: 2,
      replayable: true,
      topic: 'Restore topic',
      summary: 'Restore summary',
      tags: ['restore'],
      latestRole: 'assistant',
      latestContentPreview: 'assistant turn',
      versionId: 'session-v1',
      monotonicTimestampMs: 456,
      droppedMessageCount: 0,
      metadata: {
        topic: 'Restore topic',
        summary: 'Restore summary',
        tags: ['restore']
      },
      conversation: []
    });
    mockGetChannel
      .mockResolvedValueOnce([
        { role: 'user', content: 'user turn', timestamp: 123 },
        { role: 'assistant', content: 'assistant turn', timestamp: 456 }
      ])
      .mockResolvedValueOnce([
        { audit_tag: 'user', timestamp: 123, tokens: 5 },
        { audit_tag: 'assistant', timestamp: 456, tokens: 7 }
      ]);
    mockGetConversation.mockResolvedValue([
      { role: 'user', content: 'user turn', timestamp: 123, meta: { audit_tag: 'user' } },
      { role: 'assistant', content: 'assistant turn', timestamp: 456, meta: { audit_tag: 'assistant' } }
    ]);

    const result = await buildSessionReplayRestoreState('restore-session-1');

    expect(result).not.toBeNull();
    expect(result?.source).toBe('session-cache+memory-channels');
    expect(result?.session?.versionId).toBe('session-v1');
    expect(result?.channels.conversations_core).toHaveLength(2);
    expect(result?.state.metadata).toEqual({
      topic: 'Restore topic',
      summary: 'Restore summary',
      tags: ['restore']
    });
    expect(result?.state.conversation).toEqual([
      {
        index: 0,
        role: 'user',
        content: 'user turn',
        timestamp: 123,
        meta: { audit_tag: 'user', timestamp: 123, tokens: 5 }
      },
      {
        index: 1,
        role: 'assistant',
        content: 'assistant turn',
        timestamp: 456,
        meta: { audit_tag: 'assistant', timestamp: 456, tokens: 7 }
      }
    ]);
    expect(result?.diagnostics.metadataSource).toBe('session-detail');
  });

  it('falls back to raw memory channels when session detail is unavailable', async () => {
    mockGetUserSessionDetail.mockResolvedValue(null);
    mockGetChannel
      .mockResolvedValueOnce([
        { role: 'user', content: 'fallback user', timestamp: 1000 },
        { role: 'assistant', content: 'fallback assistant', timestamp: 2000 }
      ])
      .mockResolvedValueOnce([
        {
          topic: 'Fallback topic',
          summary: 'Fallback summary',
          tags: ['fallback'],
          timestamp: 2000
        }
      ]);
    mockGetConversation.mockResolvedValue([
      { role: 'user', content: 'fallback user', timestamp: 1000, meta: {} },
      { role: 'assistant', content: 'fallback assistant', timestamp: 2000, meta: {} }
    ]);

    const result = await buildSessionReplayRestoreState('restore-session-2');

    expect(result).not.toBeNull();
    expect(result?.source).toBe('memory-channels');
    expect(result?.session).toBeNull();
    expect(result?.state.updatedAt).toBe('1970-01-01T00:00:02.000Z');
    expect(result?.state.metadata).toEqual({
      topic: 'Fallback topic',
      summary: 'Fallback summary',
      tags: ['fallback']
    });
    expect(result?.diagnostics.metadataSource).toBe('system-meta');
    expect(result?.state.messageCount).toBe(2);
  });
});

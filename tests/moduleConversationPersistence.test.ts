import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockLoadMemory = jest.fn();
const mockSaveMemory = jest.fn();
const mockSaveMessage = jest.fn();

jest.unstable_mockModule('@core/db/index.js', () => ({
  loadMemory: mockLoadMemory,
  saveMemory: mockSaveMemory
}));

jest.unstable_mockModule('@services/sessionMemoryService.js', () => ({
  saveMessage: mockSaveMessage
}));

const { persistModuleConversation } = await import('../src/services/moduleConversationPersistence.js');

describe('moduleConversationPersistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadMemory.mockResolvedValue(null);
    mockSaveMemory.mockResolvedValue(undefined);
    mockSaveMessage.mockResolvedValue(undefined);
  });

  it('skips anonymous conversation persistence', async () => {
    await persistModuleConversation({
      moduleName: 'ARCANOS:TUTOR',
      route: 'queryroute',
      action: 'query',
      gptId: 'tutor',
      requestPayload: { prompt: 'hello world' },
      responsePayload: { result: 'ok' }
    });

    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockSaveMemory).not.toHaveBeenCalled();
    expect(mockLoadMemory).not.toHaveBeenCalled();
  });

  it('persists conversation state when an explicit sessionId is present', async () => {
    await persistModuleConversation({
      moduleName: 'ARCANOS:TUTOR',
      route: 'queryroute',
      action: 'query',
      gptId: 'tutor',
      sessionId: 'session-123',
      requestPayload: { prompt: 'hello world' },
      responsePayload: { result: 'ok' }
    });

    expect(mockSaveMessage).toHaveBeenCalledTimes(2);
    expect(mockSaveMessage).toHaveBeenNthCalledWith(
      1,
      'session-123',
      'conversations_core',
      expect.objectContaining({
        role: 'user',
        module: 'ARCANOS:TUTOR',
        action: 'query'
      })
    );
    expect(mockSaveMessage).toHaveBeenNthCalledWith(
      2,
      'session-123',
      'conversations_core',
      expect.objectContaining({
        role: 'assistant',
        module: 'ARCANOS:TUTOR',
        action: 'query'
      })
    );
    expect(mockSaveMemory).toHaveBeenCalledWith(
      'module-last-session:queryroute',
      expect.objectContaining({
        sessionId: 'session-123'
      })
    );
  });
});

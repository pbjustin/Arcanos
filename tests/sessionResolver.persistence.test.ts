import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetCachedSessions = jest.fn();
const mockLoadMemory = jest.fn();
const mockQuery = jest.fn();
const mockDeleteMemory = jest.fn();
const mockGetStatus = jest.fn();
const mockCreateEmbedding = jest.fn();
const mockGetOpenAIClientOrAdapter = jest.fn();
const mockGetEnv = jest.fn();
const mockGetEnvNumber = jest.fn();
const mockGetEnvBoolean = jest.fn();
const mockExtractNaturalLanguageSessionId = jest.fn();

jest.unstable_mockModule('../src/services/sessionMemoryService.js', () => ({
  getCachedSessions: mockGetCachedSessions,
}));

jest.unstable_mockModule('@core/db/index.js', () => ({
  loadMemory: mockLoadMemory,
  query: mockQuery,
  deleteMemory: mockDeleteMemory,
  getStatus: mockGetStatus,
}));

jest.unstable_mockModule('../src/services/openai/embeddings.js', () => ({
  createEmbedding: mockCreateEmbedding,
}));

jest.unstable_mockModule('../src/services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: mockGetOpenAIClientOrAdapter,
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: mockGetEnv,
  getEnvNumber: mockGetEnvNumber,
  getEnvBoolean: mockGetEnvBoolean,
}));

jest.unstable_mockModule('../src/services/naturalLanguageMemory.js', () => ({
  extractNaturalLanguageSessionId: mockExtractNaturalLanguageSessionId,
}));

const { resolveSession } = await import('../src/services/sessionResolver.js');

describe('sessionResolver persisted recall', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCachedSessions.mockReturnValue([]);
    mockLoadMemory.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockDeleteMemory.mockResolvedValue(true);
    mockGetStatus.mockReturnValue({ connected: true, error: null });
    mockCreateEmbedding.mockResolvedValue([1, 0, 0]);
    mockGetOpenAIClientOrAdapter.mockReturnValue({ adapter: null });
    mockGetEnv.mockReturnValue(undefined);
    mockGetEnvNumber.mockReturnValue(0);
    mockGetEnvBoolean.mockReturnValue(false);
    mockExtractNaturalLanguageSessionId.mockImplementation((input: string) => {
      const match = input.match(/raw_vancouver_2026/i);
      return match ? 'raw_vancouver_2026' : null;
    });
  });

  it('returns an exact cached session before semantic matching', async () => {
    mockGetCachedSessions.mockReturnValue([
      {
        sessionId: 'raw_vancouver_2026',
        conversations_core: [{ role: 'assistant', content: 'Cached exact session recap' }]
      },
      {
        sessionId: 'other-session',
        conversations_core: [{ role: 'assistant', content: 'Other recap' }]
      }
    ]);

    const result = await resolveSession('Recall: raw_vancouver_2026');

    expect(result).toEqual({
      sessionId: 'raw_vancouver_2026',
      conversations_core: [{ role: 'assistant', content: 'Cached exact session recap' }]
    });
    expect(mockLoadMemory).not.toHaveBeenCalled();
  });

  it('falls back to persisted nl-memory rows when the cache does not contain the requested session', async () => {
    mockLoadMemory
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ key: 'nl-memory:raw_vancouver_2026:entry-20260308073000' })
      .mockResolvedValueOnce({
        sessionId: 'raw_vancouver_2026',
        text: 'Vaquer def. Natalya -> Raquel Rodriguez kendo attack'
      });

    const result = await resolveSession('Recall: raw_vancouver_2026');

    expect(result).toEqual({
      sessionId: 'raw_vancouver_2026',
      conversations_core: [{
        role: 'assistant',
        content: 'Vaquer def. Natalya -> Raquel Rodriguez kendo attack',
        memoryKey: 'nl-memory:raw_vancouver_2026:entry-20260308073000',
        savedAt: undefined
      }]
    });
    expect(mockLoadMemory).toHaveBeenNthCalledWith(1, 'session:raw_vancouver_2026:conversations_core');
    expect(mockLoadMemory).toHaveBeenNthCalledWith(2, 'nl-latest:raw_vancouver_2026');
    expect(mockLoadMemory).toHaveBeenNthCalledWith(3, 'nl-memory:raw_vancouver_2026:entry-20260308073000');
  });
});

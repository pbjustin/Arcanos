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
const mockResolveNaturalLanguageSessionAlias = jest.fn();

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
  resolveNaturalLanguageSessionAlias: mockResolveNaturalLanguageSessionAlias,
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
    mockResolveNaturalLanguageSessionAlias.mockResolvedValue(null);
    mockExtractNaturalLanguageSessionId.mockImplementation((input: string) => {
      if (/raw_vancouver_2026/i.test(input)) {
        return 'raw_vancouver_2026';
      }
      if (/raw_vancouver_session/i.test(input)) {
        return 'raw_vancouver_session';
      }
      return null;
    });
  });

  it('returns the latest persisted recap before an exact cached transcript match', async () => {
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

    mockLoadMemory
      .mockResolvedValueOnce({ key: 'nl-memory:raw_vancouver_2026:entry-20260308071500' })
      .mockResolvedValueOnce({
        sessionId: 'raw_vancouver_2026',
        text: 'Persisted Vancouver recap'
      });

    const result = await resolveSession('Recall: raw_vancouver_2026');

    expect(result).toEqual({
      sessionId: 'raw_vancouver_2026',
      conversations_core: [{
        role: 'assistant',
        content: 'Persisted Vancouver recap',
        memoryKey: 'nl-memory:raw_vancouver_2026:entry-20260308071500',
        savedAt: undefined
      }]
    });
    expect(mockLoadMemory).toHaveBeenNthCalledWith(1, 'nl-latest:raw_vancouver_2026');
    expect(mockLoadMemory).toHaveBeenNthCalledWith(2, 'nl-memory:raw_vancouver_2026:entry-20260308071500');
  });

  it('falls back to the exact cached session when no persisted recap exists yet', async () => {
    mockGetCachedSessions.mockReturnValue([
      {
        sessionId: 'raw_vancouver_2026',
        conversations_core: [{ role: 'assistant', content: 'Cached exact session recap' }]
      }
    ]);
    mockLoadMemory
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await resolveSession('Recall: raw_vancouver_2026');

    expect(result).toEqual({
      sessionId: 'raw_vancouver_2026',
      conversations_core: [{ role: 'assistant', content: 'Cached exact session recap' }]
    });
    expect(mockLoadMemory).toHaveBeenNthCalledWith(1, 'nl-latest:raw_vancouver_2026');
    expect(mockLoadMemory).toHaveBeenNthCalledWith(2, 'session:raw_vancouver_2026:conversations_core');
  });

  it('falls back to persisted nl-memory rows when the cache does not contain the requested session', async () => {
    mockLoadMemory.mockResolvedValueOnce(null);
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          key: 'nl-memory:raw_vancouver_2026:entry-20260308073000',
          value: {
            sessionId: 'raw_vancouver_2026',
            text: 'Vaquer def. Natalya -> Raquel Rodriguez kendo attack'
          }
        }
      ],
      rowCount: 1
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
    expect(mockLoadMemory).toHaveBeenNthCalledWith(1, 'nl-latest:raw_vancouver_2026');
  });

  it('returns an exact-session miss instead of drifting to semantic fallback sessions', async () => {
    mockGetCachedSessions.mockReturnValue([
      {
        sessionId: 'raw_vancouver_2026_probe2',
        conversations_core: [{ role: 'assistant', content: 'Probe session recap' }]
      }
    ]);
    mockLoadMemory.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await resolveSession('Recall: raw_vancouver_2026');

    expect(result).toEqual({
      sessionId: 'raw_vancouver_2026',
      conversations_core: null
    });
    expect(mockCreateEmbedding).not.toHaveBeenCalled();
  });

  it('resolves storage label aliases before looking up persisted sessions', async () => {
    mockResolveNaturalLanguageSessionAlias.mockResolvedValueOnce('raw_vancouver_2026');
    mockLoadMemory
      .mockResolvedValueOnce({ key: 'nl-memory:raw_vancouver_2026:entry-20260308090000' })
      .mockResolvedValueOnce({
        sessionId: 'raw_vancouver_2026',
        text: 'Alias recall landed on the canonical Vancouver session'
      });

    const result = await resolveSession('Recall: raw_vancouver_session');

    expect(result).toEqual({
      sessionId: 'raw_vancouver_2026',
      conversations_core: [{
        role: 'assistant',
        content: 'Alias recall landed on the canonical Vancouver session',
        memoryKey: 'nl-memory:raw_vancouver_2026:entry-20260308090000',
        savedAt: undefined
      }]
    });
    expect(mockResolveNaturalLanguageSessionAlias).toHaveBeenCalledWith('raw_vancouver_session');
    expect(mockLoadMemory).toHaveBeenNthCalledWith(1, 'nl-latest:raw_vancouver_2026');
    expect(mockLoadMemory).toHaveBeenNthCalledWith(2, 'nl-memory:raw_vancouver_2026:entry-20260308090000');
  });
});

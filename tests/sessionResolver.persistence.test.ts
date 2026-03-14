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
const mockBuildExactNaturalLanguageMemorySelectorLabel = jest.fn();
const mockExtractNaturalLanguageMemoryPointerKey = jest.fn();
const mockExtractNaturalLanguageExactMemorySelector = jest.fn();
const mockExtractNaturalLanguageStorageLabel = jest.fn();
const mockExtractNaturalLanguageSessionId = jest.fn();
const mockNormalizeNaturalLanguageSessionId = jest.fn();
const mockQueryExactNaturalLanguageMemoryEntries = jest.fn();
const mockResolveNaturalLanguageSessionAlias = jest.fn();
const mockSearchNaturalLanguageConversationSessions = jest.fn();

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
  buildExactNaturalLanguageMemorySelectorLabel: mockBuildExactNaturalLanguageMemorySelectorLabel,
  extractNaturalLanguageMemoryPointerKey: mockExtractNaturalLanguageMemoryPointerKey,
  extractNaturalLanguageExactMemorySelector: mockExtractNaturalLanguageExactMemorySelector,
  extractNaturalLanguageStorageLabel: mockExtractNaturalLanguageStorageLabel,
  extractNaturalLanguageSessionId: mockExtractNaturalLanguageSessionId,
  normalizeNaturalLanguageSessionId: mockNormalizeNaturalLanguageSessionId,
  queryExactNaturalLanguageMemoryEntries: mockQueryExactNaturalLanguageMemoryEntries,
  resolveNaturalLanguageSessionAlias: mockResolveNaturalLanguageSessionAlias,
}));

jest.unstable_mockModule('../src/services/naturalLanguageConversationSessionStore.js', () => ({
  searchNaturalLanguageConversationSessions: mockSearchNaturalLanguageConversationSessions,
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
    mockBuildExactNaturalLanguageMemorySelectorLabel.mockImplementation((selector: { recordId?: number; tag?: string }) =>
      selector.recordId ? `record-${selector.recordId}` : 'global'
    );
    mockExtractNaturalLanguageMemoryPointerKey.mockImplementation((payload: unknown) => {
      if (typeof payload === 'string' && payload.trim()) {
        return payload.trim();
      }
      if (payload && typeof payload === 'object' && typeof (payload as { key?: unknown }).key === 'string') {
        return ((payload as { key: string }).key).trim();
      }
      return null;
    });
    mockExtractNaturalLanguageExactMemorySelector.mockReturnValue(null);
    mockExtractNaturalLanguageStorageLabel.mockReturnValue(null);
    mockResolveNaturalLanguageSessionAlias.mockResolvedValue(null);
    mockNormalizeNaturalLanguageSessionId.mockImplementation((input: string) =>
      input.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    );
    mockQueryExactNaturalLanguageMemoryEntries.mockResolvedValue([]);
    mockSearchNaturalLanguageConversationSessions.mockResolvedValue([]);
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

  it('resolves durable stored conversation sessions before cache-only semantic matching', async () => {
    mockSearchNaturalLanguageConversationSessions.mockResolvedValueOnce([
      {
        id: 'session-123',
        label: 'ARCANOS pipeline tuning session',
        tag: 'pipeline',
        memoryType: 'conversation',
        payload: {
          text: 'Conversation log covering Trinity debugging and backend connectivity checks.',
          memoryKey: 'nl-memory:global:this-current-conversation-in-the-backend-database-as-20260314083403'
        },
        transcriptSummary: 'Conversation log covering Trinity debugging and backend connectivity checks.',
        auditTraceId: null,
        createdAt: '2026-03-14T08:34:03.351Z',
        updatedAt: '2026-03-14T08:34:03.351Z'
      }
    ]);

    const result = await resolveSession('find ARCANOS pipeline tuning session');

    expect(result).toEqual({
      sessionId: 'session-123',
      conversations_core: [{
        role: 'assistant',
        content: 'Conversation log covering Trinity debugging and backend connectivity checks.',
        memoryKey: 'session-record:session-123',
        savedAt: undefined
      }]
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

  it('resolves quoted session labels before looking up persisted sessions', async () => {
    mockExtractNaturalLanguageStorageLabel.mockReturnValueOnce('ARCANOS backend diagnostics session');
    mockResolveNaturalLanguageSessionAlias.mockResolvedValueOnce('raw_backend_diagnostics_session');
    mockLoadMemory
      .mockResolvedValueOnce({ key: 'nl-memory:raw_backend_diagnostics_session:entry-20260308184502' })
      .mockResolvedValueOnce({
        sessionId: 'raw_backend_diagnostics_session',
        text: 'Deterministic diagnostics recap'
      });

    const result = await resolveSession(
      'Look up the stored session labeled "ARCANOS backend diagnostics session"'
    );

    expect(result).toEqual({
      sessionId: 'raw_backend_diagnostics_session',
      conversations_core: [{
        role: 'assistant',
        content: 'Deterministic diagnostics recap',
        memoryKey: 'nl-memory:raw_backend_diagnostics_session:entry-20260308184502',
        savedAt: undefined
      }]
    });
    expect(mockResolveNaturalLanguageSessionAlias).toHaveBeenCalledWith('ARCANOS backend diagnostics session');
    expect(mockLoadMemory).toHaveBeenNthCalledWith(1, 'nl-latest:raw_backend_diagnostics_session');
    expect(mockLoadMemory).toHaveBeenNthCalledWith(2, 'nl-memory:raw_backend_diagnostics_session:entry-20260308184502');
  });

  it('returns an exact label miss instead of drifting to semantic fallback sessions', async () => {
    mockExtractNaturalLanguageStorageLabel.mockReturnValueOnce('ARCANOS backend diagnostics session');
    mockNormalizeNaturalLanguageSessionId.mockReturnValueOnce('arcanos-backend-diagnostics-session');
    mockGetCachedSessions.mockReturnValue([
      {
        sessionId: 'diagnostic-probe-session',
        conversations_core: [{ role: 'assistant', content: 'Probe diagnostics session recap' }]
      }
    ]);
    mockLoadMemory
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await resolveSession(
      'Look up the stored session labeled "ARCANOS backend diagnostics session"'
    );

    expect(result).toEqual({
      sessionId: 'arcanos-backend-diagnostics-session',
      conversations_core: null
    });
    expect(mockCreateEmbedding).not.toHaveBeenCalled();
  });

  it('returns an exact selector miss instead of drifting to cached sessions', async () => {
    mockExtractNaturalLanguageExactMemorySelector.mockReturnValueOnce({
      recordId: 18342,
      tag: 'session_diagnostic_2026-03-08'
    });
    mockBuildExactNaturalLanguageMemorySelectorLabel.mockReturnValueOnce(
      'record-18342-tag-session_diagnostic_2026-03-08'
    );
    mockGetCachedSessions.mockReturnValue([
      {
        sessionId: 'raw_vancouver_2026_probe2',
        conversations_core: [{ role: 'assistant', content: 'Probe recap' }]
      }
    ]);

    const result = await resolveSession(
      'Recall the saved payload for Record ID: 18342\nTag: session_diagnostic_2026-03-08'
    );

    expect(result).toEqual({
      sessionId: 'record-18342-tag-session_diagnostic_2026-03-08',
      conversations_core: null
    });
    expect(mockQueryExactNaturalLanguageMemoryEntries).toHaveBeenCalledWith(
      {
        recordId: 18342,
        tag: 'session_diagnostic_2026-03-08'
      },
      1
    );
    expect(mockCreateEmbedding).not.toHaveBeenCalled();
  });

  it('returns the exact persisted row for record-id and tag selectors when present', async () => {
    mockExtractNaturalLanguageExactMemorySelector.mockReturnValueOnce({
      recordId: 18342,
      tag: 'session_diagnostic_2026-03-08'
    });
    mockQueryExactNaturalLanguageMemoryEntries.mockResolvedValueOnce([
      {
        recordId: 18342,
        key: 'nl-memory:diagnostic:18342',
        value: {
          sessionId: 'session_diagnostic_2026-03-08',
          text: 'Exact diagnostic recap'
        },
        metadata: null,
        created_at: '2026-03-08T15:22:10.000Z',
        updated_at: '2026-03-08T18:45:02.000Z'
      }
    ]);

    const result = await resolveSession(
      'Recall the saved payload for Record ID: 18342\nTag: session_diagnostic_2026-03-08'
    );

    expect(result).toEqual({
      sessionId: 'session_diagnostic_2026-03-08',
      conversations_core: [{
        role: 'assistant',
        content: 'Exact diagnostic recap',
        memoryKey: 'nl-memory:diagnostic:18342',
        savedAt: undefined
      }]
    });
  });
});

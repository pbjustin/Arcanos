import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockLoadMemory = jest.fn();
const mockQuery = jest.fn();
const mockSaveMemory = jest.fn();
const mockQueryRagDocuments = jest.fn();
const mockRecordPersistentMemorySnippet = jest.fn();

jest.unstable_mockModule('@core/db/index.js', () => ({
  loadMemory: mockLoadMemory,
  query: mockQuery,
  saveMemory: mockSaveMemory,
}));

jest.unstable_mockModule('@services/webRag.js', () => ({
  queryRagDocuments: mockQueryRagDocuments,
  recordPersistentMemorySnippet: mockRecordPersistentMemorySnippet,
}));

const {
  extractNaturalLanguageSessionId,
  executeNaturalLanguageMemoryCommand,
  parseNaturalLanguageMemoryCommand
} = await import('../src/services/naturalLanguageMemory.js');

describe('naturalLanguageMemory session targeting', () => {
  const structuredSessionSavePrompt = `Session ID: RAW_20260308_VAN
Storage Label: RAW_Vancouver_Session

Persisted Summary (Stored)
Vaquer def. Natalya -> Raquel Rodriguez kendo attack
Main Event: Gunther def. AJ Styles clean`;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadMemory.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockSaveMemory.mockResolvedValue(undefined);
    mockQueryRagDocuments.mockResolvedValue({
      matches: [],
      diagnostics: {
        enabled: false,
        reason: 'disabled',
        candidateCount: 0,
        returnedCount: 0,
        sessionFilterApplied: true,
        sessionFallbackApplied: false,
        sourceTypeFilterApplied: true,
        minScore: 0.12,
        limit: 10
      }
    });
    mockRecordPersistentMemorySnippet.mockResolvedValue(false);
  });

  it('extracts explicit session ids from memory prompts', () => {
    expect(extractNaturalLanguageSessionId('Save this recap. Session ID: raw_vancouver_2026')).toBe('raw_vancouver_2026');
    expect(extractNaturalLanguageSessionId('Recall: raw_vancouver_2026')).toBe('raw_vancouver_2026');
    expect(extractNaturalLanguageSessionId('latest')).toBeNull();
  });

  it('parses recall <session> prompts as deterministic retrieval commands', () => {
    expect(parseNaturalLanguageMemoryCommand('Recall: raw_vancouver_2026')).toEqual({
      intent: 'retrieve',
      latest: true
    });
    expect(parseNaturalLanguageMemoryCommand('Recall vaquer recap summary')).toEqual({
      intent: 'lookup',
      queryText: 'vaquer recap summary'
    });
  });

  it('parses structured session payloads without an explicit save verb as save commands', () => {
    expect(parseNaturalLanguageMemoryCommand(structuredSessionSavePrompt)).toEqual({
      intent: 'save',
      content: structuredSessionSavePrompt
    });
  });

  it('uses the inline session id when loading the latest saved memory', async () => {
    mockLoadMemory
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ key: 'nl-memory:raw_vancouver_2026:entry-20260308070000' })
      .mockResolvedValueOnce({
        sessionId: 'raw_vancouver_2026',
        text: 'Persisted summary for Vancouver Raw'
      });

    const result = await executeNaturalLanguageMemoryCommand({
      input: 'Recall: raw_vancouver_2026'
    });

    expect(result).toEqual(
      expect.objectContaining({
        intent: 'retrieve',
        operation: 'retrieved',
        sessionId: 'raw_vancouver_2026',
        key: 'nl-memory:raw_vancouver_2026:entry-20260308070000',
        value: expect.objectContaining({
          text: 'Persisted summary for Vancouver Raw'
        })
      })
    );
    expect(mockLoadMemory).toHaveBeenNthCalledWith(1, 'nl-session-label:raw_vancouver_2026');
    expect(mockLoadMemory).toHaveBeenNthCalledWith(2, 'nl-latest:raw_vancouver_2026');
    expect(mockLoadMemory).toHaveBeenNthCalledWith(3, 'nl-memory:raw_vancouver_2026:entry-20260308070000');
  });

  it('resolves storage label aliases back to the canonical session id for recall', async () => {
    mockLoadMemory
      .mockResolvedValueOnce({
        sessionId: 'raw_20260308_van',
        storageLabel: 'RAW_Vancouver_Session'
      })
      .mockResolvedValueOnce({ key: 'nl-memory:raw_20260308_van:entry-20260308120000' })
      .mockResolvedValueOnce({
        sessionId: 'raw_20260308_van',
        text: 'Canonical Vancouver session recap'
      });

    const result = await executeNaturalLanguageMemoryCommand({
      input: 'Recall: RAW_Vancouver_Session'
    });

    expect(result).toEqual(
      expect.objectContaining({
        intent: 'retrieve',
        operation: 'retrieved',
        sessionId: 'raw_20260308_van',
        key: 'nl-memory:raw_20260308_van:entry-20260308120000',
        value: expect.objectContaining({
          text: 'Canonical Vancouver session recap'
        })
      })
    );
    expect(mockLoadMemory).toHaveBeenNthCalledWith(1, 'nl-session-label:raw_vancouver_session');
    expect(mockLoadMemory).toHaveBeenNthCalledWith(2, 'nl-latest:raw_20260308_van');
    expect(mockLoadMemory).toHaveBeenNthCalledWith(3, 'nl-memory:raw_20260308_van:entry-20260308120000');
  });

  it('does not semantically fallback across sessions for explicit session recall misses', async () => {
    mockLoadMemory
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockQueryRagDocuments.mockResolvedValue({
      matches: [{
        id: 'rag-1',
        content: 'Recall: raw_vancouver_2026_probe2',
        score: 0.91,
        url: 'session:raw_vancouver_2026_probe2',
        metadata: {
          sessionId: 'raw_vancouver_2026_probe2',
          sourceType: 'conversation'
        }
      }],
      diagnostics: {
        enabled: true,
        reason: 'ok',
        candidateCount: 1,
        returnedCount: 1,
        sessionFilterApplied: true,
        sessionFallbackApplied: true,
        sourceTypeFilterApplied: true,
        minScore: 0.12,
        limit: 10
      }
    });

    const result = await executeNaturalLanguageMemoryCommand({
      input: 'Recall: raw_vancouver_2026'
    });

    expect(result).toEqual(
      expect.objectContaining({
        intent: 'retrieve',
        operation: 'retrieved',
        sessionId: 'raw_vancouver_2026',
        message: 'No saved memory found yet for this session.',
        rag: expect.objectContaining({
          active: false,
          reason: 'exact_session_not_found'
        })
      })
    );
    expect(mockQueryRagDocuments).not.toHaveBeenCalled();
  });

  it('saves structured session payloads under the inline session id', async () => {
    const result = await executeNaturalLanguageMemoryCommand({
      input: structuredSessionSavePrompt
    });

    expect(result).toEqual(
      expect.objectContaining({
        intent: 'save',
        operation: 'saved',
        sessionId: 'raw_20260308_van',
        value: expect.objectContaining({
          sessionId: 'raw_20260308_van',
          text: structuredSessionSavePrompt
        })
      })
    );
    expect(mockSaveMemory).toHaveBeenCalledWith(
      expect.stringMatching(/^nl-memory:raw_20260308_van:/),
      expect.objectContaining({
        sessionId: 'raw_20260308_van',
        text: structuredSessionSavePrompt
      })
    );
    expect(mockSaveMemory).toHaveBeenCalledWith(
      'nl-session-label:raw_vancouver_session',
      expect.objectContaining({
        sessionId: 'raw_20260308_van',
        storageLabel: 'RAW_Vancouver_Session'
      })
    );
  });
});

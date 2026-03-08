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

  it('uses the inline session id when loading the latest saved memory', async () => {
    mockLoadMemory
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
    expect(mockLoadMemory).toHaveBeenNthCalledWith(1, 'nl-latest:raw_vancouver_2026');
    expect(mockLoadMemory).toHaveBeenNthCalledWith(2, 'nl-memory:raw_vancouver_2026:entry-20260308070000');
  });
});

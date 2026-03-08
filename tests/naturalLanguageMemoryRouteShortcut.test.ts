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
  renderNaturalLanguageMemoryRouteResult,
  tryExecuteNaturalLanguageMemoryRouteShortcut
} = await import('../src/services/naturalLanguageMemoryRouteShortcut.js');

describe('naturalLanguageMemoryRouteShortcut', () => {
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

  it('does not hijack generic tutoring prompts that only start with show/get verbs', async () => {
    await expect(
      tryExecuteNaturalLanguageMemoryRouteShortcut({
        prompt: 'Show me how closures work in JavaScript.'
      })
    ).resolves.toBeNull();
  });

  it('renders retrieved text directly for exact recall prompts', async () => {
    mockLoadMemory
      .mockResolvedValueOnce({ key: 'nl-memory:raw_vancouver_2026:entry-20260308070000' })
      .mockResolvedValueOnce({
        sessionId: 'raw_vancouver_2026',
        text: 'Persisted summary for Vancouver Raw'
      });

    const shortcut = await tryExecuteNaturalLanguageMemoryRouteShortcut({
      prompt: 'Recall: raw_vancouver_2026'
    });

    expect(shortcut).toEqual(
      expect.objectContaining({
        resultText: 'Persisted summary for Vancouver Raw',
        memory: expect.objectContaining({
          operation: 'retrieved',
          sessionId: 'raw_vancouver_2026'
        })
      })
    );
  });

  it('formats search results deterministically when multiple entries are returned', () => {
    const rendered = renderNaturalLanguageMemoryRouteResult({
      intent: 'lookup',
      operation: 'searched',
      sessionId: 'raw_vancouver_2026',
      message: 'Found 2 matching entries.',
      entries: [
        {
          key: 'nl-memory:raw_vancouver_2026:1',
          value: { text: 'Match one' },
          metadata: null,
          created_at: '2026-03-08T11:00:00.000Z',
          updated_at: '2026-03-08T11:00:00.000Z'
        },
        {
          key: 'nl-memory:raw_vancouver_2026:2',
          value: { note: 'fallback object' },
          metadata: null,
          created_at: '2026-03-08T11:01:00.000Z',
          updated_at: '2026-03-08T11:01:00.000Z'
        }
      ]
    });

    expect(rendered).toBe('Match one\n\n{\n  "note": "fallback object"\n}');
  });
});

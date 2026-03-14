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
      .mockResolvedValueOnce(null)
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

  it('short-circuits quoted session-label lookups into deterministic memory output', async () => {
    mockLoadMemory
      .mockResolvedValueOnce({
        sessionId: 'raw_20260308_van',
        storageLabel: 'ARCANOS backend diagnostics session'
      })
      .mockResolvedValueOnce({ key: 'nl-memory:raw_20260308_van:entry-20260308184502' })
      .mockResolvedValueOnce({
        sessionId: 'raw_20260308_van',
        text: 'Persisted diagnostic session recap'
      });

    const shortcut = await tryExecuteNaturalLanguageMemoryRouteShortcut({
      prompt: 'Look up the stored session labeled "ARCANOS backend diagnostics session"'
    });

    expect(shortcut).toEqual(
      expect.objectContaining({
        resultText: 'Persisted diagnostic session recap',
        memory: expect.objectContaining({
          operation: 'retrieved',
          sessionId: 'raw_20260308_van'
        })
      })
    );
  });

  it('short-circuits exact record-id and tag prompts into deterministic memory output', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 18342,
          key: 'session:diagnostic-2026:system_meta',
          value: [
            {
              audit_tag: 'session_diagnostic_2026-03-08',
              note: 'Exact diagnostic payload'
            }
          ],
          created_at: '2026-03-08T15:22:10.000Z',
          updated_at: '2026-03-08T18:45:02.000Z'
        }
      ],
      rowCount: 1
    });

    const shortcut = await tryExecuteNaturalLanguageMemoryRouteShortcut({
      prompt: 'Recall the saved payload for Record ID: 18342\nTag: session_diagnostic_2026-03-08'
    });

    expect(shortcut).toEqual(
      expect.objectContaining({
        resultText: expect.stringContaining('session_diagnostic_2026-03-08'),
        memory: expect.objectContaining({
          operation: 'searched',
          entries: [
            expect.objectContaining({
              recordId: 18342
            })
          ]
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

  it('renders inspection responses as structured exact rows instead of prose summaries', () => {
    const rendered = renderNaturalLanguageMemoryRouteResult({
      intent: 'inspect',
      operation: 'inspected',
      sessionId: 'raw_20260308_van',
      message: 'Retrieved 1 exact memory row for session raw_20260308_van.',
      entries: [
        {
          key: 'nl-memory:raw_20260308_van:entry-20260308152210',
          value: { text: 'Persisted Summary (Stored)' },
          metadata: null,
          created_at: '2026-03-08T15:22:10.000Z',
          updated_at: '2026-03-08T18:45:02.000Z'
        }
      ],
      inspection: {
        requestedArtifacts: ['raw_memory_rows'],
        unsupportedArtifacts: []
      }
    });

    expect(rendered).toContain('"operation": "inspected"');
    expect(rendered).toContain('"requestedArtifacts": [');
    expect(rendered).toContain('"nl-memory:raw_20260308_van:entry-20260308152210"');
  });

  it('renders save operations as explicit confirmation text instead of echoing stored content', () => {
    const rendered = renderNaturalLanguageMemoryRouteResult({
      intent: 'save',
      operation: 'saved',
      sessionId: 'raw_20260308_van',
      key: 'nl-memory:raw_20260308_van:entry-20260308152210',
      value: { text: 'Persisted Summary (Stored)' },
      message: 'Saved to memory successfully.'
    });

    expect(rendered).toContain('Memory save confirmed for session raw_20260308_van.');
    expect(rendered).toContain('Key: nl-memory:raw_20260308_van:entry-20260308152210.');
    expect(rendered).toContain('Use POST /api/save-conversation for strict persistence receipts.');
    expect(rendered).not.toContain('Persisted Summary (Stored)');
  });
});

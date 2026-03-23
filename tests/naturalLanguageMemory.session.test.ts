import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockLoadMemory = jest.fn();
const mockQuery = jest.fn();
const mockSaveMemory = jest.fn();
const mockGetMemoryRecordByKey = jest.fn();
const mockGetMemoryRecordByRecordId = jest.fn();
const mockGetMemoryRecordByLegacyRowId = jest.fn();
const mockQueryRagDocuments = jest.fn();
const mockRecordPersistentMemorySnippet = jest.fn();
const mockPersistNaturalLanguageConversationSession = jest.fn();
const mockSearchNaturalLanguageConversationSessions = jest.fn();

jest.unstable_mockModule('@core/db/index.js', () => ({
  loadMemory: mockLoadMemory,
  query: mockQuery,
  saveMemory: mockSaveMemory,
  getMemoryRecordByKey: mockGetMemoryRecordByKey,
  getMemoryRecordByRecordId: mockGetMemoryRecordByRecordId,
  getMemoryRecordByLegacyRowId: mockGetMemoryRecordByLegacyRowId,
}));

jest.unstable_mockModule('@services/webRag.js', () => ({
  queryRagDocuments: mockQueryRagDocuments,
  recordPersistentMemorySnippet: mockRecordPersistentMemorySnippet,
}));

jest.unstable_mockModule('@services/naturalLanguageConversationSessionStore.js', () => ({
  persistNaturalLanguageConversationSession: mockPersistNaturalLanguageConversationSession,
  searchNaturalLanguageConversationSessions: mockSearchNaturalLanguageConversationSessions
}));

const {
  extractNaturalLanguageExactMemorySelector,
  extractNaturalLanguageStorageLabel,
  extractNaturalLanguageSessionId,
  executeNaturalLanguageMemoryCommand,
  hasNaturalLanguageMemoryCue,
  queryExactNaturalLanguageMemoryEntries,
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
    mockGetMemoryRecordByKey.mockResolvedValue(null);
    mockGetMemoryRecordByRecordId.mockResolvedValue(null);
    mockGetMemoryRecordByLegacyRowId.mockResolvedValue(null);
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
    mockPersistNaturalLanguageConversationSession.mockResolvedValue(null);
    mockSearchNaturalLanguageConversationSessions.mockResolvedValue([]);
  });

  it('extracts explicit session ids from memory prompts', () => {
    expect(extractNaturalLanguageSessionId('Save this recap. Session ID: raw_vancouver_2026')).toBe('raw_vancouver_2026');
    expect(extractNaturalLanguageSessionId('Recall: raw_vancouver_2026')).toBe('raw_vancouver_2026');
    expect(extractNaturalLanguageSessionId('latest')).toBeNull();
  });

  it('extracts quoted session labels from lookup prompts', () => {
    expect(
      extractNaturalLanguageStorageLabel(
        'Look up the stored session labeled "ARCANOS backend diagnostics session"'
      )
    ).toBe('ARCANOS backend diagnostics session');
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
    expect(
      parseNaturalLanguageMemoryCommand(
        'Look up the stored session labeled "ARCANOS backend diagnostics session"'
      )
    ).toEqual({
      intent: 'retrieve',
      latest: true
    });
  });

  it('parses structured session payloads without an explicit save verb as save commands', () => {
    expect(parseNaturalLanguageMemoryCommand(structuredSessionSavePrompt)).toEqual({
      intent: 'save',
      content: structuredSessionSavePrompt
    });
  });

  it('keeps structured session payloads on the save path even when recap text mentions lookup wording', () => {
    const lookupHeavyStructuredPrompt = `Session ID: RAW_20260308_LOOKUP_GUARD
Storage Label: RAW_Lookup_Guard

Persisted Summary (Stored)
Lookup guard note line.
This recap mentions lookup text but should still save.`;

    expect(parseNaturalLanguageMemoryCommand(lookupHeavyStructuredPrompt)).toEqual({
      intent: 'save',
      content: lookupHeavyStructuredPrompt
    });
  });

  it('parses raw memory inspection prompts as deterministic inspection commands', () => {
    expect(parseNaturalLanguageMemoryCommand('Show the full raw memory table for RAW_20260308_VAN')).toEqual({
      intent: 'inspect'
    });
  });

  it('does not classify DAG trace prompts as memory commands', () => {
    const dagPrompt = 'Trace the DAG run lineage, nodes, metrics, and verification summary for the latest run.';

    expect(parseNaturalLanguageMemoryCommand(dagPrompt)).toEqual({
      intent: 'unknown'
    });
    expect(hasNaturalLanguageMemoryCue(dagPrompt)).toBe(false);
  });

  it('extracts exact record-id and tag selectors from diagnostic retrieval prompts', () => {
    expect(
      extractNaturalLanguageExactMemorySelector(
        'Recall the saved payload for Record ID: 18342\nTag: session_diagnostic_2026-03-08'
      )
    ).toEqual({
      recordId: 18342,
      tag: 'session_diagnostic_2026-03-08'
    });
    expect(
      parseNaturalLanguageMemoryCommand(
        'Recall the saved payload for Record ID: 18342\nTag: session_diagnostic_2026-03-08'
      )
    ).toEqual({
      intent: 'lookup',
      exactSelectors: {
        recordId: 18342,
        tag: 'session_diagnostic_2026-03-08'
      }
    });
    expect(
      parseNaturalLanguageMemoryCommand(
        'Recall the saved payload for Tag: session_diagnostic_e2e_210700'
      )
    ).toEqual({
      intent: 'lookup',
      exactSelectors: {
        tag: 'session_diagnostic_e2e_210700'
      }
    });
  });

  it('scopes exact selector queries to canonical nl-memory rows only', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 209,
        key: 'nl-memory:global:this-diagnostic-payload-tag-session-diagnostic-e2e-210700-20260308210554',
        value: {
          text: 'this diagnostic payload\nTag: session_diagnostic_e2e_210700',
          sessionId: 'global'
        },
        created_at: '2026-03-08T21:05:54.434Z',
        updated_at: '2026-03-08T21:05:54.434Z'
      }],
      rowCount: 1
    });

    const result = await queryExactNaturalLanguageMemoryEntries({
      tag: 'session_diagnostic_e2e_210700'
    }, 10);

    expect(result).toEqual([
      expect.objectContaining({
        recordId: 209,
        key: 'nl-memory:global:this-diagnostic-payload-tag-session-diagnostic-e2e-210700-20260308210554'
      })
    ]);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("WHERE key ILIKE 'nl-memory:%'"),
      [null, '%session\\_diagnostic\\_e2e\\_210700%', 10]
    );
  });

  it('uses the inline session id when loading the latest saved memory', async () => {
    mockLoadMemory
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ key: 'nl-memory:raw_vancouver_2026:entry-20260308070000' });
    mockGetMemoryRecordByKey.mockResolvedValueOnce({
      dbRowId: 101,
      recordId: 'db-memory-1773542617003-4-vancouverlatest',
      memoryKey: 'nl-memory:raw_vancouver_2026:entry-20260308070000',
      value: {
        sessionId: 'raw_vancouver_2026',
        text: 'Persisted summary for Vancouver Raw'
      },
      metadata: null,
      createdAt: '2026-03-08T07:00:00.000Z',
      updatedAt: '2026-03-08T07:00:00.000Z',
      expiresAt: null
    });

    const result = await executeNaturalLanguageMemoryCommand({
      input: 'Recall: raw_vancouver_2026'
    });

    expect(result).toEqual(
      expect.objectContaining({
        intent: 'retrieve',
        operation: 'retrieved',
        success: true,
        sessionId: 'raw_vancouver_2026',
        key: 'nl-memory:raw_vancouver_2026:entry-20260308070000',
        record_id: 'db-memory-1773542617003-4-vancouverlatest',
        value: expect.objectContaining({
          text: 'Persisted summary for Vancouver Raw'
        })
      })
    );
    expect(mockLoadMemory).toHaveBeenNthCalledWith(1, 'nl-session-label:raw_vancouver_2026');
    expect(mockLoadMemory).toHaveBeenNthCalledWith(2, 'nl-latest:raw_vancouver_2026');
    expect(mockGetMemoryRecordByKey).toHaveBeenCalledWith('nl-memory:raw_vancouver_2026:entry-20260308070000');
  });

  it('resolves storage label aliases back to the canonical session id for recall', async () => {
    mockLoadMemory
      .mockResolvedValueOnce({
        sessionId: 'raw_20260308_van',
        storageLabel: 'RAW_Vancouver_Session'
      })
      .mockResolvedValueOnce({ key: 'nl-memory:raw_20260308_van:entry-20260308120000' });
    mockGetMemoryRecordByKey.mockResolvedValueOnce({
      dbRowId: 102,
      recordId: 'db-memory-1773542617004-5-vancouveralias',
      memoryKey: 'nl-memory:raw_20260308_van:entry-20260308120000',
      value: {
        sessionId: 'raw_20260308_van',
        text: 'Canonical Vancouver session recap'
      },
      metadata: null,
      createdAt: '2026-03-08T12:00:00.000Z',
      updatedAt: '2026-03-08T12:00:00.000Z',
      expiresAt: null
    });

    const result = await executeNaturalLanguageMemoryCommand({
      input: 'Recall: RAW_Vancouver_Session'
    });

    expect(result).toEqual(
      expect.objectContaining({
        intent: 'retrieve',
        operation: 'retrieved',
        sessionId: 'raw_20260308_van',
        success: true,
        key: 'nl-memory:raw_20260308_van:entry-20260308120000',
        record_id: 'db-memory-1773542617004-5-vancouveralias',
        value: expect.objectContaining({
          text: 'Canonical Vancouver session recap'
        })
      })
    );
    expect(mockLoadMemory).toHaveBeenNthCalledWith(1, 'nl-session-label:raw_vancouver_session');
    expect(mockLoadMemory).toHaveBeenNthCalledWith(2, 'nl-latest:raw_20260308_van');
    expect(mockGetMemoryRecordByKey).toHaveBeenCalledWith('nl-memory:raw_20260308_van:entry-20260308120000');
  });

  it('treats explicit session-label misses as exact misses without semantic fallback', async () => {
    mockLoadMemory
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const result = await executeNaturalLanguageMemoryCommand({
      input: 'Look up the stored session labeled "ARCANOS backend diagnostics session"'
    });

    expect(result).toEqual(
      expect.objectContaining({
        intent: 'retrieve',
        operation: 'retrieved',
        success: false,
        error: 'RecordNotFound',
        sessionId: 'arcanos-backend-diagnostics-session',
        message: 'No saved memory found yet for this session.'
      })
    );
    expect(mockLoadMemory).toHaveBeenNthCalledWith(1, 'nl-session-label:arcanos-backend-diagnostics-session');
    expect(mockLoadMemory).toHaveBeenNthCalledWith(2, 'nl-latest:arcanos-backend-diagnostics-session');
    expect(mockQueryRagDocuments).not.toHaveBeenCalled();
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
        success: false,
        error: 'RecordNotFound',
        sessionId: 'raw_vancouver_2026',
        message: 'No saved memory found yet for this session.'
      })
    );
    expect(mockQueryRagDocuments).not.toHaveBeenCalled();
  });

  it('saves structured session payloads under the inline session id', async () => {
    mockGetMemoryRecordByKey.mockImplementationOnce(async (memoryKey: string) => ({
      dbRowId: 103,
      recordId: 'db-memory-1773542617005-6-structuredsave',
      memoryKey,
      value: {
        sessionId: 'raw_20260308_van',
        text: structuredSessionSavePrompt
      },
      metadata: null,
      createdAt: '2026-03-08T15:00:00.000Z',
      updatedAt: '2026-03-08T15:00:00.000Z',
      expiresAt: null
    }));

    const result = await executeNaturalLanguageMemoryCommand({
      input: structuredSessionSavePrompt
    });

    expect(result).toEqual(
      expect.objectContaining({
        intent: 'save',
        operation: 'saved',
        success: true,
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
    expect(mockPersistNaturalLanguageConversationSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'raw_20260308_van',
        content: structuredSessionSavePrompt
      })
    );
  });

  it('rejects anonymous lookup commands so they do not reuse shared memory state', async () => {
    mockSearchNaturalLanguageConversationSessions.mockResolvedValueOnce([
      {
        id: 'session-123',
        label: 'ARCANOS pipeline tuning session',
        tag: 'pipeline',
        memoryType: 'conversation',
        payload: {
          text: 'Conversation log covering Trinity debugging and honesty fixes.',
          memoryKey: 'nl-memory:global:this-current-conversation-in-the-backend-database-as-20260314083403'
        },
        transcriptSummary: 'Conversation log covering Trinity debugging and honesty fixes.',
        auditTraceId: null,
        createdAt: '2026-03-14T08:34:03.351Z',
        updatedAt: '2026-03-14T08:34:03.351Z'
      }
    ]);

    const result = await executeNaturalLanguageMemoryCommand({
      input: 'find ARCANOS pipeline tuning session'
    });

    expect(result).toEqual(
      expect.objectContaining({
        intent: 'lookup',
        operation: 'ignored',
        success: false,
        sessionId: 'stateless',
        message: 'Memory commands require an explicit sessionId or session label. Anonymous requests stay stateless.'
      })
    );
    expect(mockSearchNaturalLanguageConversationSessions).not.toHaveBeenCalled();
    expect(mockQueryRagDocuments).not.toHaveBeenCalled();
  });

  it('reuses the latest identical session save instead of writing a duplicate memory row', async () => {
    const retrySavePrompt = `Save this recap
Session ID: RAW_VANCOUVER_RETRY_2026

Main Event: Gunther def. AJ Styles clean`;

    mockLoadMemory.mockImplementation(async (key: string) => {
      if (key === 'nl-session-label:raw_vancouver_retry_2026') {
        return null;
      }

      if (key === 'nl-latest:raw_vancouver_retry_2026') {
        return { key: 'nl-memory:raw_vancouver_retry_2026:entry-20260308193000' };
      }

      if (key === 'nl-memory:raw_vancouver_retry_2026:entry-20260308193000') {
        return {
        sessionId: 'raw_vancouver_retry_2026',
        text: `this recap
Session ID: RAW_VANCOUVER_RETRY_2026

Main Event: Gunther def. AJ Styles clean`,
        savedAt: '2026-03-08T19:30:00.000Z'
        };
      }

      return null;
    });
    mockGetMemoryRecordByKey.mockResolvedValueOnce({
      dbRowId: 104,
      recordId: 'db-memory-1773542617006-7-retrysave',
      memoryKey: 'nl-memory:raw_vancouver_retry_2026:entry-20260308193000',
      value: {
        sessionId: 'raw_vancouver_retry_2026',
        text: `this recap
Session ID: RAW_VANCOUVER_RETRY_2026

Main Event: Gunther def. AJ Styles clean`,
        savedAt: '2026-03-08T19:30:00.000Z'
      },
      metadata: null,
      createdAt: '2026-03-08T19:30:00.000Z',
      updatedAt: '2026-03-08T19:30:00.000Z',
      expiresAt: null
    });

    const result = await executeNaturalLanguageMemoryCommand({
      input: retrySavePrompt
    });

    expect(result).toEqual(
      expect.objectContaining({
        intent: 'save',
        operation: 'saved',
        success: true,
        sessionId: 'raw_vancouver_retry_2026',
        key: 'nl-memory:raw_vancouver_retry_2026:entry-20260308193000',
        value: expect.objectContaining({
          sessionId: 'raw_vancouver_retry_2026',
          text: `this recap
Session ID: RAW_VANCOUVER_RETRY_2026

Main Event: Gunther def. AJ Styles clean`,
          savedAt: '2026-03-08T19:30:00.000Z'
        }),
        rag: expect.objectContaining({
          active: false,
          reason: 'already_indexed'
        })
      })
    );

    const memoryRowWrites = mockSaveMemory.mock.calls.filter(([key]) =>
      typeof key === 'string' && key.startsWith('nl-memory:raw_vancouver_retry_2026:')
    );
    expect(memoryRowWrites).toHaveLength(0);
    expect(mockRecordPersistentMemorySnippet).not.toHaveBeenCalled();
  });

  it('returns exact raw memory rows for inspection prompts without semantic fallback', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          key: 'nl-memory:raw_20260308_van:entry-20260308152210',
          value: {
            sessionId: 'raw_20260308_van',
            text: 'Persisted Summary (Stored)\nMain Event: Gunther def. AJ Styles clean'
          },
          created_at: '2026-03-08T15:22:10.000Z',
          updated_at: '2026-03-08T18:45:02.000Z'
        }
      ],
      rowCount: 1
    });

    const result = await executeNaturalLanguageMemoryCommand({
      input: 'Show the full raw memory table, audit log entries, and snapshot history for RAW_20260308_VAN'
    });

    expect(result).toEqual(
      expect.objectContaining({
        intent: 'inspect',
        operation: 'inspected',
        sessionId: 'raw_20260308_van',
        entries: [
          expect.objectContaining({
            key: 'nl-memory:raw_20260308_van:entry-20260308152210',
            value: expect.objectContaining({
              text: 'Persisted Summary (Stored)\nMain Event: Gunther def. AJ Styles clean'
            })
          })
        ],
        message: expect.stringContaining('audit log entries, snapshot history are not exposed by this route'),
        rag: expect.objectContaining({
          active: false,
          reason: 'inspection_exact_only'
        }),
        inspection: {
          requestedArtifacts: ['raw_memory_rows', 'audit_log_entries', 'snapshot_history'],
          unsupportedArtifacts: ['audit_log_entries', 'snapshot_history']
        }
      })
    );
    expect(mockQueryRagDocuments).not.toHaveBeenCalled();
  });

  it('returns exact selector matches without semantic fallback for record-id and tag prompts', async () => {
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

    const result = await executeNaturalLanguageMemoryCommand({
      input: 'Recall the saved payload for Record ID: 18342\nTag: session_diagnostic_2026-03-08'
    });

    expect(result).toEqual(
      expect.objectContaining({
        intent: 'lookup',
        operation: 'searched',
        sessionId: 'stateless',
        message: 'Found 1 exact persisted memory entry for record id 18342 and tag session_diagnostic_2026-03-08.',
        entries: [
          expect.objectContaining({
            recordId: 18342,
            key: 'session:diagnostic-2026:system_meta',
            value: [
              expect.objectContaining({
                audit_tag: 'session_diagnostic_2026-03-08'
              })
            ]
          })
        ],
        rag: expect.objectContaining({
          active: false,
          reason: 'exact_selector_hit'
        })
      })
    );
    expect(mockQueryRagDocuments).not.toHaveBeenCalled();
  });
});

import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSaveMemory = jest.fn();
const mockLoadMemory = jest.fn();
const mockDeleteMemory = jest.fn();
const mockGetStatus = jest.fn();
const mockQuery = jest.fn();
const mockGetMemoryRecordByKey = jest.fn();
const mockGetMemoryRecordByRecordId = jest.fn();
const mockGetMemoryRecordByLegacyRowId = jest.fn();
const mockQueryRagDocuments = jest.fn();
const mockRecordPersistentMemorySnippet = jest.fn();
const mockPersistNaturalLanguageConversationSession = jest.fn();
const mockSearchNaturalLanguageConversationSessions = jest.fn();

jest.unstable_mockModule('@core/db/index.js', () => ({
  saveMemory: mockSaveMemory,
  loadMemory: mockLoadMemory,
  deleteMemory: mockDeleteMemory,
  getStatus: mockGetStatus,
  query: mockQuery,
  getMemoryRecordByKey: mockGetMemoryRecordByKey,
  getMemoryRecordByRecordId: mockGetMemoryRecordByRecordId,
  getMemoryRecordByLegacyRowId: mockGetMemoryRecordByLegacyRowId
}));

jest.unstable_mockModule('@services/webRag.js', () => ({
  queryRagDocuments: mockQueryRagDocuments,
  recordPersistentMemorySnippet: mockRecordPersistentMemorySnippet
}));

jest.unstable_mockModule('@services/naturalLanguageConversationSessionStore.js', () => ({
  persistNaturalLanguageConversationSession: mockPersistNaturalLanguageConversationSession,
  searchNaturalLanguageConversationSessions: mockSearchNaturalLanguageConversationSessions
}));

const { default: apiMemoryRouter } = await import('../src/routes/api-memory.js');

/**
 * Build a test app with only the memory router mounted.
 * Inputs/outputs: none -> configured Express app.
 * Edge cases: isolated mount reduces side effects from global middleware.
 */
function createMemoryTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/memory', apiMemoryRouter);
  return app;
}

describe('/api/memory/nl', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createMemoryTestApp();
    mockGetStatus.mockReturnValue({ connected: true, error: null });
    mockSaveMemory.mockResolvedValue({ updated_at: '2026-03-06T00:00:00.000Z' });
    mockLoadMemory.mockResolvedValue(null);
    mockDeleteMemory.mockResolvedValue(true);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockGetMemoryRecordByKey.mockResolvedValue(null);
    mockGetMemoryRecordByRecordId.mockResolvedValue(null);
    mockGetMemoryRecordByLegacyRowId.mockResolvedValue(null);
    mockRecordPersistentMemorySnippet.mockResolvedValue(true);
    mockPersistNaturalLanguageConversationSession.mockResolvedValue(null);
    mockSearchNaturalLanguageConversationSessions.mockResolvedValue([]);
    mockQueryRagDocuments.mockResolvedValue({
      matches: [],
      diagnostics: {
        enabled: false,
        reason: 'api_key_missing',
        candidateCount: 0,
        returnedCount: 0,
        sessionFilterApplied: true,
        sessionFallbackApplied: false,
        sourceTypeFilterApplied: true,
        minScore: 0.12,
        limit: 5
      }
    });
  });

  it('saves natural-language text into a session-scoped key', async () => {
    mockGetMemoryRecordByKey.mockImplementationOnce(async (memoryKey: string) => ({
      dbRowId: 11,
      recordId: 'db-memory-1773542617000-1-savebooker',
      memoryKey,
      value: {
        sessionId: 'booker-thread-1',
        text: 'my summary of Monday night raw for backstage Booker'
      },
      metadata: null,
      createdAt: '2026-03-06T00:00:00.000Z',
      updatedAt: '2026-03-06T00:00:00.000Z',
      expiresAt: null
    }));

    const response = await request(app).post('/api/memory/nl').send({
      input: 'save my summary of Monday night raw for backstage Booker',
      sessionId: 'Booker-Thread-1'
    });

    expect(response.status).toBe(200);
    expect(response.body.intent).toBe('save');
    expect(response.body.operation).toBe('saved');
    expect(response.body.success).toBe(true);
    expect(response.body.sessionId).toBe('booker-thread-1');
    expect(response.body.key).toMatch(/^nl-memory:booker-thread-1:/);
    expect(response.body.memory_key).toBe(response.body.key);
    expect(response.body.record_id).toBe('db-memory-1773542617000-1-savebooker');
    expect(response.body.response_id).toMatch(/^memory_/);
    expect(mockSaveMemory).toHaveBeenCalledWith(
      expect.stringMatching(/^nl-memory:booker-thread-1:/),
      expect.objectContaining({
        sessionId: 'booker-thread-1',
        text: 'my summary of Monday night raw for backstage Booker'
      })
    );
    expect(mockSaveMemory).toHaveBeenCalledWith(
      'nl-latest:booker-thread-1',
      expect.objectContaining({ key: expect.stringMatching(/^nl-memory:booker-thread-1:/) })
    );
    expect(mockSaveMemory).toHaveBeenCalledWith(
      'nl-session-index:booker-thread-1',
      expect.any(Array)
    );
    expect(mockRecordPersistentMemorySnippet).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.stringMatching(/^nl-memory:booker-thread-1:/),
        sessionId: 'booker-thread-1',
        content: 'my summary of Monday night raw for backstage Booker'
      })
    );
  });

  it('searches session memory entries using lookup text', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          key: 'nl-memory:booker-thread-1:raw-recap-20260306010101',
          value: {
            metadata: {
              versionId: 'v1',
              monotonicTimestampMs: 1
            },
            payload: {
              sessionId: 'booker-thread-1',
              text: 'Raw recap summary for backstage booking'
            }
          },
          created_at: '2026-03-06T01:01:01.000Z',
          updated_at: '2026-03-06T01:01:01.000Z'
        }
      ],
      rowCount: 1
    });

    const response = await request(app).post('/api/memory/nl').send({
      input: 'lookup raw recap summary',
      sessionId: 'booker-thread-1',
      limit: 5
    });

    expect(response.status).toBe(200);
    expect(response.body.intent).toBe('lookup');
    expect(response.body.operation).toBe('searched');
    expect(response.body.success).toBe(true);
    expect(response.body.entries).toHaveLength(1);
    expect(response.body.entries[0].value).toEqual(
      expect.objectContaining({
        text: 'Raw recap summary for backstage booking'
      })
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('value::text ILIKE $2'),
      ['nl-memory:booker-thread-1:%', '%raw recap summary%', 5]
    );
  });

  it('retrieves the latest saved session memory when asked in natural language', async () => {
    mockLoadMemory
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ key: 'nl-memory:booker-thread-1:entry-20260306020202' });
    mockGetMemoryRecordByKey.mockResolvedValueOnce({
      dbRowId: 22,
      recordId: 'db-memory-1773542617001-2-latestbooker',
      memoryKey: 'nl-memory:booker-thread-1:entry-20260306020202',
      value: {
        sessionId: 'booker-thread-1',
        text: 'Latest stored recap'
      },
      metadata: null,
      createdAt: '2026-03-06T02:02:02.000Z',
      updatedAt: '2026-03-06T02:02:02.000Z',
      expiresAt: null
    });

    const response = await request(app).post('/api/memory/nl').send({
      input: 'show latest memory',
      sessionId: 'booker-thread-1'
    });

    expect(response.status).toBe(200);
    expect(response.body.intent).toBe('retrieve');
    expect(response.body.operation).toBe('retrieved');
    expect(response.body.success).toBe(true);
    expect(response.body.key).toBe('nl-memory:booker-thread-1:entry-20260306020202');
    expect(response.body.record_id).toBe('db-memory-1773542617001-2-latestbooker');
    expect(response.body.value).toEqual(
      expect.objectContaining({ text: 'Latest stored recap' })
    );
    expect(mockLoadMemory).toHaveBeenNthCalledWith(1, 'nl-session-label:booker-thread-1');
    expect(mockLoadMemory).toHaveBeenNthCalledWith(2, 'nl-latest:booker-thread-1');
    expect(mockGetMemoryRecordByKey).toHaveBeenCalledWith('nl-memory:booker-thread-1:entry-20260306020202');
  });

  it('supports conversational save phrasing with optional helper words', async () => {
    mockGetMemoryRecordByKey.mockImplementationOnce(async (memoryKey: string) => ({
      dbRowId: 12,
      recordId: 'db-memory-1773542617002-3-savehelper',
      memoryKey,
      value: {
        sessionId: 'booker-thread-2',
        text: 'this as my raw summary'
      },
      metadata: null,
      createdAt: '2026-03-06T00:00:00.000Z',
      updatedAt: '2026-03-06T00:00:00.000Z',
      expiresAt: null
    }));

    const response = await request(app).post('/api/memory/nl').send({
      input: 'can you please save this as my raw summary',
      sessionId: 'booker-thread-2'
    });

    expect(response.status).toBe(200);
    expect(response.body.intent).toBe('save');
    expect(response.body.operation).toBe('saved');
    expect(response.body.success).toBe(true);
    expect(response.body.sessionId).toBe('booker-thread-2');
    expect(mockSaveMemory).toHaveBeenCalledWith(
      expect.stringMatching(/^nl-memory:booker-thread-2:/),
      expect.objectContaining({
        text: 'this as my raw summary'
      })
    );
  });

  it('falls back to semantic RAG retrieval when lookup has no exact DB matches', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockQueryRagDocuments.mockResolvedValue({
      matches: [
        {
          id: 'memory:nl-memory:booker-thread-1:raw-recap-20260306030000',
          url: 'memory:booker-thread-1',
          content: 'Raw recap summary with title match context',
          score: 0.81234,
          metadata: {
            memoryKey: 'nl-memory:booker-thread-1:raw-recap-20260306030000',
            sessionId: 'booker-thread-1',
            sourceType: 'memory',
            savedAt: '2026-03-06T03:00:00.000Z'
          }
        }
      ],
      diagnostics: {
        enabled: true,
        reason: 'ok',
        candidateCount: 4,
        returnedCount: 1,
        sessionFilterApplied: true,
        sessionFallbackApplied: false,
        sourceTypeFilterApplied: true,
        minScore: 0.12,
        limit: 5
      }
    });

    const response = await request(app).post('/api/memory/nl').send({
      input: 'lookup raw recap title match',
      sessionId: 'booker-thread-1',
      limit: 5
    });

    expect(response.status).toBe(200);
    expect(response.body.intent).toBe('lookup');
    expect(response.body.operation).toBe('searched');
    expect(response.body.success).toBe(true);
    expect(response.body.entries).toHaveLength(1);
    expect(response.body.entries[0]).toEqual(
      expect.objectContaining({
        key: 'nl-memory:booker-thread-1:raw-recap-20260306030000',
        value: expect.objectContaining({
          text: 'Raw recap summary with title match context'
        })
      })
    );
    expect(response.body.rag).toEqual(
      expect.objectContaining({
        active: true,
        reason: 'ok'
      })
    );
    expect(mockQueryRagDocuments).toHaveBeenCalledWith(
      'raw recap title match',
      expect.objectContaining({
        sessionId: 'booker-thread-1',
        sourceTypes: ['memory', 'conversation'],
        allowSessionFallback: false
      })
    );
  });

  it('returns a structured exact miss when a canonical key is not found', async () => {
    const response = await request(app).post('/api/memory/nl').send({
      input: 'load memory key nl-memory:booker-thread-1:missing-entry',
      sessionId: 'booker-thread-1'
    });

    expect(response.status).toBe(404);
    expect(response.body.intent).toBe('retrieve');
    expect(response.body.operation).toBe('retrieved');
    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('RecordNotFound');
    expect(response.body.message).toBe('No memory found for that identifier.');
    expect(response.body.memory_key).toBe('nl-memory:booker-thread-1:missing-entry');
    expect(mockQueryRagDocuments).not.toHaveBeenCalled();
  });

  it('returns an exact selector miss for record-id and tag prompts without semantic fallback', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await request(app).post('/api/memory/nl').send({
      input: 'Recall the saved payload for Record ID: 18342\nTag: session_diagnostic_2026-03-08'
    });

    expect(response.status).toBe(200);
    expect(response.body.intent).toBe('lookup');
    expect(response.body.operation).toBe('searched');
    expect(response.body.success).toBe(true);
    expect(response.body.entries).toEqual([]);
    expect(response.body.message).toBe(
      'No exact persisted memory rows matched record id 18342 and tag session_diagnostic_2026-03-08.'
    );
    expect(response.body.rag).toEqual(
      expect.objectContaining({
        active: false,
        reason: 'exact_selector_not_found'
      })
    );
    expect(mockQueryRagDocuments).not.toHaveBeenCalled();
  });
});

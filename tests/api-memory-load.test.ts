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
 * Build a test app that only mounts the memory router.
 * Inputs/outputs: none -> isolated Express app.
 * Edge cases: isolated routing keeps retrieval assertions focused on API contract behavior.
 */
function createMemoryTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/memory', apiMemoryRouter);
  return app;
}

describe('/api/memory/load identifier semantics', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createMemoryTestApp();
    mockGetStatus.mockReturnValue({ connected: true, error: null });
    mockSaveMemory.mockResolvedValue({ updated_at: '2026-03-08T01:20:00.000Z', expires_at: null });
    mockLoadMemory.mockResolvedValue(null);
    mockDeleteMemory.mockResolvedValue(true);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockGetMemoryRecordByKey.mockResolvedValue(null);
    mockGetMemoryRecordByRecordId.mockResolvedValue(null);
    mockGetMemoryRecordByLegacyRowId.mockResolvedValue(null);
    mockRecordPersistentMemorySnippet.mockResolvedValue(false);
    mockPersistNaturalLanguageConversationSession.mockResolvedValue(null);
    mockSearchNaturalLanguageConversationSessions.mockResolvedValue([]);
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
        limit: 5
      }
    });
  });

  it('retrieves a valid durable record id without falling back', async () => {
    mockGetMemoryRecordByRecordId.mockResolvedValueOnce({
      dbRowId: 301,
      recordId: 'db-memory-1773542617999-9-durableid',
      memoryKey: 'nl-memory:global:booker-recap',
      value: { text: 'Durable record payload' },
      metadata: null,
      createdAt: '2026-03-08T01:20:00.000Z',
      updatedAt: '2026-03-08T01:20:00.000Z',
      expiresAt: null
    });

    const response = await request(app)
      .get('/api/memory/load')
      .query({ record_id: 'db-memory-1773542617999-9-durableid' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      record_id: 'db-memory-1773542617999-9-durableid',
      memory_key: 'nl-memory:global:booker-recap',
      value: { text: 'Durable record payload' }
    });
    expect(mockQueryRagDocuments).not.toHaveBeenCalled();
  });

  it('rejects transient memory_* identifiers at the API boundary', async () => {
    const response = await request(app)
      .get('/api/memory/load')
      .query({ key: 'memory_1773542617999_abcd1234' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: 'InvalidTransientId',
      message: 'memory_* identifiers are response envelopes and cannot be used for retrieval.'
    });
    expect(mockGetMemoryRecordByKey).not.toHaveBeenCalled();
    expect(mockGetMemoryRecordByRecordId).not.toHaveBeenCalled();
  });

  it('returns a clean structured miss for nonexistent durable identifiers', async () => {
    const response = await request(app)
      .get('/api/memory/load')
      .query({ key: 'nl-memory:global:missing-recap' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      error: 'RecordNotFound',
      message: 'No durable memory record matched the requested identifier.'
    });
    expect(mockQueryRagDocuments).not.toHaveBeenCalled();
  });

  it('uses fallback search only when explicitly requested', async () => {
    mockQueryRagDocuments.mockResolvedValueOnce({
      matches: [
        {
          id: 'memory:nl-memory:global:fallback-hit',
          url: 'memory:global',
          content: 'Recovered semantic fallback hit',
          score: 0.91,
          metadata: {
            memoryKey: 'nl-memory:global:fallback-hit',
            versionId: 'db-memory-1773542618000-10-fallback',
            sessionId: 'global',
            sourceType: 'memory',
            savedAt: '2026-03-08T01:21:00.000Z'
          }
        }
      ],
      diagnostics: {
        enabled: true,
        reason: 'ok',
        candidateCount: 1,
        returnedCount: 1,
        sessionFilterApplied: true,
        sessionFallbackApplied: false,
        sourceTypeFilterApplied: true,
        minScore: 0.12,
        limit: 5
      }
    });

    const response = await request(app)
      .get('/api/memory/load')
      .query({
        key: 'nl-memory:global:missing-recap',
        fallback: 'true',
        mode: 'search'
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        success: true,
        record_id: 'db-memory-1773542618000-10-fallback',
        memory_key: 'nl-memory:global:fallback-hit',
        fallback_used: true,
        value: expect.objectContaining({
          text: 'Recovered semantic fallback hit'
        })
      })
    );
    expect(mockQueryRagDocuments).toHaveBeenCalledWith(
      'nl-memory:global:missing-recap',
      expect.objectContaining({
        sessionId: 'global'
      })
    );
  });
});

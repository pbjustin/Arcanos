import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSaveMemory = jest.fn();
const mockLoadMemory = jest.fn();
const mockDeleteMemory = jest.fn();
const mockGetStatus = jest.fn();
const mockQuery = jest.fn();
const mockQueryRagDocuments = jest.fn();
const mockRecordPersistentMemorySnippet = jest.fn();

jest.unstable_mockModule('@core/db/index.js', () => ({
  saveMemory: mockSaveMemory,
  loadMemory: mockLoadMemory,
  deleteMemory: mockDeleteMemory,
  getStatus: mockGetStatus,
  query: mockQuery
}));

jest.unstable_mockModule('@services/webRag.js', () => ({
  queryRagDocuments: mockQueryRagDocuments,
  recordPersistentMemorySnippet: mockRecordPersistentMemorySnippet
}));

const { default: apiMemoryRouter } = await import('../src/routes/api-memory.js');

/**
 * Build an app instance with memory routes mounted.
 * Inputs/outputs: none -> configured Express application.
 * Edge cases: isolated mount avoids global middleware side effects.
 */
function createMemoryTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/memory', apiMemoryRouter);
  return app;
}

describe('/api/memory/search', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createMemoryTestApp();
    mockGetStatus.mockReturnValue({ connected: true, error: null });
    mockSaveMemory.mockResolvedValue({ updated_at: '2026-03-06T00:00:00.000Z' });
    mockLoadMemory.mockResolvedValue(null);
    mockDeleteMemory.mockResolvedValue(true);
    mockRecordPersistentMemorySnippet.mockResolvedValue(false);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockQueryRagDocuments.mockResolvedValue({
      matches: [],
      diagnostics: {
        enabled: false,
        reason: 'api_key_missing',
        candidateCount: 0,
        returnedCount: 0,
        sessionFilterApplied: false,
        sessionFallbackApplied: false,
        sourceTypeFilterApplied: true,
        minScore: 0.1,
        limit: 15
      }
    });
  });

  it('returns merged exact + semantic hits in one normalized schema with dedupe', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          key: 'nl-memory:booker-thread-1:raw-summary-1',
          value: {
            metadata: {
              versionId: 'v1',
              monotonicTimestampMs: 1
            },
            payload: {
              sessionId: 'booker-thread-1',
              text: 'Exact memory hit one'
            }
          },
          created_at: '2026-03-06T01:00:00.000Z',
          updated_at: '2026-03-06T01:10:00.000Z'
        },
        {
          key: 'nl-memory:booker-thread-1:raw-summary-2',
          value: {
            metadata: {
              versionId: 'v1',
              monotonicTimestampMs: 2
            },
            payload: {
              sessionId: 'booker-thread-1',
              text: 'Exact memory hit two'
            }
          },
          created_at: '2026-03-06T01:20:00.000Z',
          updated_at: '2026-03-06T01:30:00.000Z'
        }
      ],
      rowCount: 2
    });

    mockQueryRagDocuments.mockResolvedValue({
      matches: [
        {
          id: 'memory:nl-memory:booker-thread-1:raw-summary-1',
          url: 'memory:booker-thread-1',
          content: 'Semantic duplicate should dedupe',
          score: 0.91,
          metadata: {
            memoryKey: 'nl-memory:booker-thread-1:raw-summary-1',
            sessionId: 'booker-thread-1',
            sourceType: 'memory',
            savedAt: '2026-03-06T01:00:00.000Z'
          }
        },
        {
          id: 'memory:nl-memory:booker-thread-1:raw-summary-3',
          url: 'memory:booker-thread-1',
          content: 'Semantic unique hit',
          score: 0.73,
          metadata: {
            memoryKey: 'nl-memory:booker-thread-1:raw-summary-3',
            sessionId: 'booker-thread-1',
            sourceType: 'memory',
            savedAt: '2026-03-06T01:40:00.000Z'
          }
        }
      ],
      diagnostics: {
        enabled: true,
        reason: 'ok',
        candidateCount: 9,
        returnedCount: 2,
        sessionFilterApplied: true,
        sessionFallbackApplied: false,
        sourceTypeFilterApplied: true,
        minScore: 0.1,
        limit: 5
      }
    });

    const response = await request(app)
      .get('/api/memory/search')
      .query({ q: 'raw summary', sessionId: 'booker-thread-1', limit: 5 });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.data.counts).toEqual({
      exact: 2,
      semantic: 2,
      merged: 3
    });
    expect(response.body.data.hits).toHaveLength(3);
    expect(response.body.data.hits[0]).toEqual(
      expect.objectContaining({
        key: 'nl-memory:booker-thread-1:raw-summary-1',
        match_type: 'exact',
        score: null,
        source: 'database'
      })
    );
    expect(response.body.data.hits[2]).toEqual(
      expect.objectContaining({
        key: 'nl-memory:booker-thread-1:raw-summary-3',
        match_type: 'semantic',
        score: 0.73,
        source: 'memory:booker-thread-1'
      })
    );

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('(expires_at IS NULL OR expires_at > NOW())'),
      ['nl-memory:booker-thread-1:%', 'session:booker-thread-1:%', '%raw summary%', 5]
    );
    expect(mockQueryRagDocuments).toHaveBeenCalledWith(
      'raw summary',
      expect.objectContaining({
        sessionId: 'booker-thread-1',
        sourceTypes: ['memory', 'conversation'],
        minScore: 0.1,
        limit: 5
      })
    );
  });

  it('returns 400 when q is missing', async () => {
    const response = await request(app).get('/api/memory/search');

    expect(response.status).toBe(400);
    expect(response.body.status).toBe('error');
    expect(response.body.message).toContain('q is required');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockQueryRagDocuments).not.toHaveBeenCalled();
  });

  it('supports global search when sessionId is not provided', async () => {
    mockQuery.mockResolvedValue({
      rows: [],
      rowCount: 0
    });
    mockQueryRagDocuments.mockResolvedValue({
      matches: [],
      diagnostics: {
        enabled: true,
        reason: 'no_candidate_docs',
        candidateCount: 0,
        returnedCount: 0,
        sessionFilterApplied: false,
        sessionFallbackApplied: false,
        sourceTypeFilterApplied: true,
        minScore: 0.1,
        limit: 10
      }
    });

    const response = await request(app).get('/api/memory/search').query({ q: 'universal note', limit: 10 });

    expect(response.status).toBe(200);
    expect(response.body.data.sessionId).toBeNull();
    expect(response.body.data.hits).toEqual([]);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('(expires_at IS NULL OR expires_at > NOW())'),
      ['%universal note%', 10]
    );
  });
});


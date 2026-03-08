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
 * Build a minimal app instance with only the memory router mounted.
 * Inputs/outputs: none -> isolated Express app for request assertions.
 * Edge cases: uses JSON parsing to mirror the production save endpoint contract.
 */
function createMemoryTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/memory', apiMemoryRouter);
  return app;
}

describe('/api/memory/save TTL handling', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createMemoryTestApp();
    mockGetStatus.mockReturnValue({ connected: true, error: null });
    mockSaveMemory.mockResolvedValue({
      updated_at: '2026-03-08T01:20:00.000Z',
      expires_at: '2026-03-08T01:21:00.000Z'
    });
    mockLoadMemory.mockResolvedValue(null);
    mockDeleteMemory.mockResolvedValue(true);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockQueryRagDocuments.mockResolvedValue({
      matches: [],
      diagnostics: {
        enabled: false,
        reason: 'disabled',
        candidateCount: 0,
        returnedCount: 0,
        sessionFilterApplied: false,
        sessionFallbackApplied: false,
        sourceTypeFilterApplied: false,
        minScore: 0.1,
        limit: 10
      }
    });
  });

  it('passes ttlSeconds through the save route and returns expiresAt metadata', async () => {
    const response = await request(app)
      .post('/api/memory/save')
      .set('x-confirmed', 'yes')
      .send({
        key: 'memory:ttl-route',
        value: { note: 'save with ttl' },
        ttlSeconds: 60
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        status: 'success',
        data: expect.objectContaining({
          key: 'memory:ttl-route',
          timestamp: '2026-03-08T01:20:00.000Z',
          expiresAt: '2026-03-08T01:21:00.000Z'
        })
      })
    );
    expect(mockSaveMemory).toHaveBeenCalledWith(
      'memory:ttl-route',
      { note: 'save with ttl' },
      { ttlSeconds: 60 }
    );
  });

  it('rejects non-positive ttlSeconds at the route boundary', async () => {
    const response = await request(app)
      .post('/api/memory/save')
      .set('x-confirmed', 'yes')
      .send({
        key: 'memory:bad-ttl',
        value: { note: 'invalid ttl' },
        ttlSeconds: 0
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        status: 'error',
        message: 'ttlSeconds must be a positive integer when provided'
      })
    );
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });
});

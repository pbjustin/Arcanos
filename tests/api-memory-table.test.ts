import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockQuery = jest.fn();
const mockGetStatus = jest.fn();
const mockInitializeDatabaseWithSchema = jest.fn();
const mockSaveRagDoc = jest.fn();
const mockLoadAllRagDocs = jest.fn();
const mockLoadRagDocsByIds = jest.fn();
const mockGetMemoryRecordByKey = jest.fn();
const mockGetMemoryRecordByRecordId = jest.fn();
const mockGetMemoryRecordByLegacyRowId = jest.fn();

jest.unstable_mockModule('@core/db/index.js', () => ({
  saveMemory: jest.fn(),
  loadMemory: jest.fn(),
  deleteMemory: jest.fn(),
  getStatus: mockGetStatus,
  query: mockQuery,
  getMemoryRecordByKey: mockGetMemoryRecordByKey,
  getMemoryRecordByRecordId: mockGetMemoryRecordByRecordId,
  getMemoryRecordByLegacyRowId: mockGetMemoryRecordByLegacyRowId,
  initializeDatabaseWithSchema: mockInitializeDatabaseWithSchema,
  saveRagDoc: mockSaveRagDoc,
  loadAllRagDocs: mockLoadAllRagDocs,
  loadRagDocsByIds: mockLoadRagDocsByIds
}));

const { default: apiMemoryRouter } = await import('../src/routes/api-memory.js');

/**
 * Create a minimal app instance that mounts the memory router.
 * Inputs/outputs: no inputs, returns configured Express app.
 * Edge cases: middleware stack intentionally mirrors production route mount path.
 */
function createMemoryTestApp(): Express {
  const app = express();
  app.use('/api/memory', apiMemoryRouter);
  return app;
}

describe('/api/memory/table', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createMemoryTestApp();
    mockGetStatus.mockReturnValue({ connected: true, error: null });
    mockInitializeDatabaseWithSchema.mockResolvedValue(true);
    mockSaveRagDoc.mockResolvedValue(undefined);
    mockLoadAllRagDocs.mockResolvedValue([]);
    mockLoadRagDocsByIds.mockResolvedValue([]);
    mockGetMemoryRecordByKey.mockResolvedValue(null);
    mockGetMemoryRecordByRecordId.mockResolvedValue(null);
    mockGetMemoryRecordByLegacyRowId.mockResolvedValue(null);
  });

  it('renders a clean HTML table with escaped memory values', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          key: 'backstage-storyline:latest',
          value: '<script>alert("xss")</script>',
          created_at: '2026-03-06T18:30:00.000Z',
          updated_at: '2026-03-06T19:30:00.000Z'
        }
      ],
      rowCount: 1
    });

    const response = await request(app).get('/api/memory/table?prefix=backstage-&limit=25');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('Memory Table');
    expect(response.text).toContain('backstage-storyline:latest');
    expect(response.text).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(response.text).not.toContain('<script>alert("xss")</script>');
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE key ILIKE $2'), [25, 'backstage-%']);
  });

  it('clamps oversized limits to the configured max for table queries', async () => {
    mockQuery.mockResolvedValue({
      rows: [],
      rowCount: 0
    });

    const response = await request(app).get('/api/memory/table?limit=50000');

    expect(response.status).toBe(200);
    expect(response.text).toContain('No memory rows found for this filter.');
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('LIMIT $1'), [1000]);
  });
});

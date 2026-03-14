import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSaveMemory = jest.fn();
const mockLoadMemoryRecordById = jest.fn();

jest.unstable_mockModule('@core/db/index.js', () => ({
  saveMemory: mockSaveMemory,
  loadMemoryRecordById: mockLoadMemoryRecordById
}));

const { default: apiSaveConversationRouter } = await import('../src/routes/api-save-conversation.js');

/**
 * Build an isolated app for the dedicated save-conversation API contract.
 * Inputs/outputs: none -> Express app with JSON parsing and the target router.
 * Edge cases: isolation keeps contract failures attributable to this route only.
 */
function createSaveConversationTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/', apiSaveConversationRouter);
  return app;
}

describe('/api/save-conversation', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createSaveConversationTestApp();
    mockSaveMemory.mockResolvedValue({
      id: 18342,
      key: 'save-conversation:raw-20260308-van:backend-diagnostics:20260309120000000',
      created_at: '2026-03-09T12:00:00.000Z',
      updated_at: '2026-03-09T12:00:00.000Z'
    });
    mockLoadMemoryRecordById.mockResolvedValue({
      id: 18342,
      key: 'save-conversation:raw-20260308-van:backend-diagnostics:20260309120000000',
      value: {
        schemaVersion: 1,
        storageType: 'conversation',
        title: 'Backend diagnostics',
        tags: ['session_diagnostic_2026-03-08', 'backend'],
        contentMode: 'transcript',
        content: [
          { role: 'user', content: 'save this conversation' },
          { role: 'assistant', content: 'confirmed' }
        ],
        sessionId: 'raw_20260308_van',
        metadata: {
          source: 'integration-test'
        },
        storedAt: '2026-03-09T12:00:00.000Z'
      },
      expires_at: null,
      created_at: '2026-03-09T12:00:00.000Z',
      updated_at: '2026-03-09T12:00:00.000Z'
    });
  });

  it('returns a strict receipt and verifies the row by id immediately after save', async () => {
    const transcriptPayload = [
      { role: 'user', content: 'save this conversation' },
      { role: 'assistant', content: 'confirmed' }
    ];

    const response = await request(app)
      .post('/api/save-conversation')
      .send({
        title: 'Backend diagnostics',
        tags: ['session_diagnostic_2026-03-08', 'backend'],
        contentMode: 'transcript',
        content: transcriptPayload,
        sessionId: 'raw_20260308_van',
        metadata: {
          source: 'integration-test'
        }
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      success: true,
      record_id: 18342,
      storage_type: 'conversation',
      title: 'Backend diagnostics',
      tags: ['session_diagnostic_2026-03-08', 'backend'],
      content_mode: 'transcript',
      length_stored: JSON.stringify(transcriptPayload).length,
      bytes_stored: Buffer.byteLength(JSON.stringify(transcriptPayload), 'utf8'),
      created_at: '2026-03-09T12:00:00.000Z',
      error: null
    });
    expect(mockSaveMemory).toHaveBeenCalledWith(
      expect.stringMatching(/^save-conversation:raw-20260308-van:backend-diagnostics:/),
      expect.objectContaining({
        schemaVersion: 1,
        storageType: 'conversation',
        title: 'Backend diagnostics',
        tags: ['session_diagnostic_2026-03-08', 'backend'],
        contentMode: 'transcript',
        sessionId: 'raw_20260308_van'
      })
    );
    expect(mockLoadMemoryRecordById).toHaveBeenCalledWith(18342);
  });

  it('fetches the exact stored content by returned record id', async () => {
    const transcriptPayload = [
      { role: 'user', content: 'save this conversation' },
      { role: 'assistant', content: 'confirmed' }
    ];

    const response = await request(app).get('/api/save-conversation/18342');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      record_id: 18342,
      key: 'save-conversation:raw-20260308-van:backend-diagnostics:20260309120000000',
      storage_type: 'conversation',
      title: 'Backend diagnostics',
      tags: ['session_diagnostic_2026-03-08', 'backend'],
      content_mode: 'transcript',
      length_stored: JSON.stringify(transcriptPayload).length,
      bytes_stored: Buffer.byteLength(JSON.stringify(transcriptPayload), 'utf8'),
      created_at: '2026-03-09T12:00:00.000Z',
      updated_at: '2026-03-09T12:00:00.000Z',
      session_id: 'raw_20260308_van',
      content: transcriptPayload,
      metadata: {
        source: 'integration-test'
      },
      error: null
    });
    expect(mockLoadMemoryRecordById).toHaveBeenCalledWith(18342);
  });

  it('fails closed when read-after-write verification cannot reload the saved row', async () => {
    mockLoadMemoryRecordById.mockResolvedValueOnce(null);

    const response = await request(app)
      .post('/api/save-conversation')
      .send({
        title: 'Backend diagnostics',
        tags: ['session_diagnostic_2026-03-08'],
        contentMode: 'summary',
        content: 'summary text'
      });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      success: false,
      record_id: null,
      storage_type: 'conversation',
      title: 'Backend diagnostics',
      tags: [],
      content_mode: 'summary',
      length_stored: 0,
      bytes_stored: 0,
      created_at: null,
      error: 'Conversation record 18342 could not be reloaded after save.'
    });
  });
});

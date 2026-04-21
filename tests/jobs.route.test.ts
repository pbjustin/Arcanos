import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getJobByIdMock = jest.fn();
const requestJobCancellationMock = jest.fn();

jest.unstable_mockModule('../src/core/db/repositories/jobRepository.js', () => ({
  getJobById: getJobByIdMock,
  requestJobCancellation: requestJobCancellationMock
}));

const { default: jobsRouter } = await import('../src/routes/jobs.js');

const COMPLETED_JOB_ID = '11111111-1111-4111-8111-111111111111';
const MISSING_JOB_ID = '22222222-2222-4222-8222-222222222222';
const EXPIRED_JOB_ID = '33333333-3333-4333-8333-333333333333';
const RUNNING_JOB_ID = '44444444-4444-4444-8444-444444444444';
const QUEUED_JOB_ID = '55555555-5555-4555-8555-555555555555';
const CANCEL_REQUEST_JOB_ID = '66666666-6666-4666-8666-666666666666';
const TERMINAL_JOB_ID = '77777777-7777-4777-8777-777777777777';
const TRUNCATED_JOB_ID = '88888888-8888-4888-8888-888888888888';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', jobsRouter);
  return app;
}

function hashActorKey(actorKey: string): string {
  return crypto.createHash('sha256').update(actorKey).digest('hex');
}

describe('/jobs routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the canonical stored-result lookup payload without enqueueing work', async () => {
    getJobByIdMock.mockResolvedValue({
      id: COMPLETED_JOB_ID,
      job_type: 'gpt',
      status: 'completed',
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:01:00.000Z',
      completed_at: '2026-04-06T10:01:00.000Z',
      retention_until: '2026-04-07T10:01:00.000Z',
      idempotency_until: '2026-04-07T10:01:00.000Z',
      expires_at: null,
      error_message: null,
      output: {
        ok: true,
        result: {
          answer: 'stored output'
        }
      },
      cancel_requested_at: null,
      cancel_reason: null
    });

    const response = await request(buildApp()).get(`/jobs/${COMPLETED_JOB_ID}/result`);

    expect(response.status).toBe(200);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.headers['x-response-truncated']).toBeUndefined();
    expect(response.body).toEqual({
      jobId: COMPLETED_JOB_ID,
      status: 'completed',
      jobStatus: 'completed',
      lifecycleStatus: 'completed',
      createdAt: '2026-04-06T10:00:00.000Z',
      updatedAt: '2026-04-06T10:01:00.000Z',
      completedAt: '2026-04-06T10:01:00.000Z',
      retentionUntil: '2026-04-07T10:01:00.000Z',
      idempotencyUntil: '2026-04-07T10:01:00.000Z',
      expiresAt: null,
      poll: `/jobs/${COMPLETED_JOB_ID}`,
      stream: `/jobs/${COMPLETED_JOB_ID}/stream`,
      result: {
        ok: true,
        result: {
          answer: 'stored output'
        }
      },
      error: null
    });
  });

  it('returns an explicit not_found payload for the canonical result route', async () => {
    getJobByIdMock.mockResolvedValue(null);

    const response = await request(buildApp()).get(`/jobs/${MISSING_JOB_ID}/result`);

    expect(response.status).toBe(200);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toEqual({
      jobId: MISSING_JOB_ID,
      status: 'not_found',
      jobStatus: null,
      lifecycleStatus: 'not_found',
      createdAt: null,
      updatedAt: null,
      completedAt: null,
      retentionUntil: null,
      idempotencyUntil: null,
      expiresAt: null,
      poll: `/jobs/${MISSING_JOB_ID}`,
      stream: `/jobs/${MISSING_JOB_ID}/stream`,
      result: null,
      error: {
        code: 'JOB_NOT_FOUND',
        message: 'Async GPT job was not found.'
      }
    });
  });

  it('rejects whitespace-only job identifiers for the canonical result route', async () => {
    const response = await request(buildApp()).get('/jobs/%20/result');

    expect(response.status).toBe(400);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.headers['x-response-truncated']).toBeUndefined();
    expect(response.body).toEqual({
      error: 'JOB_ID_INVALID'
    });
    expect(getJobByIdMock).not.toHaveBeenCalled();
  });

  it('rejects malformed job identifiers before hitting the repository', async () => {
    const response = await request(buildApp()).get('/jobs/abc123/result');

    expect(response.status).toBe(400);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toEqual({
      error: 'JOB_ID_INVALID'
    });
    expect(getJobByIdMock).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only job identifiers for cancellation through the guarded response path', async () => {
    const response = await request(buildApp())
      .post('/jobs/%20/cancel')
      .set('x-confirmed', 'yes');

    expect(response.status).toBe(400);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.headers['x-response-truncated']).toBeUndefined();
    expect(response.body).toEqual({
      error: 'JOB_ID_INVALID'
    });
    expect(getJobByIdMock).not.toHaveBeenCalled();
    expect(requestJobCancellationMock).not.toHaveBeenCalled();
  });

  it('returns lifecycle metadata for job polling responses', async () => {
    getJobByIdMock.mockResolvedValue({
      id: EXPIRED_JOB_ID,
      job_type: 'gpt',
      status: 'expired',
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:05:00.000Z',
      completed_at: '2026-04-06T10:01:00.000Z',
      error_message: 'Expired after retention window.',
      output: null,
      retention_until: '2026-04-06T10:04:00.000Z',
      idempotency_until: '2026-04-06T10:03:00.000Z',
      expires_at: '2026-04-06T10:05:00.000Z',
      cancel_requested_at: null,
      cancel_reason: null
    });

    const response = await request(buildApp()).get(`/jobs/${EXPIRED_JOB_ID}`);

    expect(response.status).toBe(200);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      id: EXPIRED_JOB_ID,
      status: 'expired',
      lifecycle_status: 'expired',
      retention_until: '2026-04-06T10:04:00.000Z',
      idempotency_until: '2026-04-06T10:03:00.000Z',
      expires_at: '2026-04-06T10:05:00.000Z'
    });
  });

  it('rejects anonymous cancellation requests', async () => {
    const response = await request(buildApp())
      .post(`/jobs/${EXPIRED_JOB_ID}/cancel`)
      .set('x-confirmed', 'yes')
      .send({ reason: 'Stop this job' });

    expect(response.status).toBe(401);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'JOB_CANCELLATION_AUTH_REQUIRED',
        message: 'Job cancellation requires an authenticated session or internal actor.'
      }
    });
    expect(getJobByIdMock).not.toHaveBeenCalled();
    expect(requestJobCancellationMock).not.toHaveBeenCalled();
  });

  it('rejects cancellation for the wrong session owner', async () => {
    getJobByIdMock.mockResolvedValue({
      id: RUNNING_JOB_ID,
      job_type: 'gpt',
      status: 'running',
      idempotency_scope_hash: hashActorKey('session:owner-1'),
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:01:00.000Z',
      completed_at: null,
      error_message: null,
      output: null,
      cancel_requested_at: null,
      cancel_reason: null
    });

    const response = await request(buildApp())
      .post(`/jobs/${RUNNING_JOB_ID}/cancel`)
      .set('x-confirmed', 'yes')
      .set('x-session-id', 'owner-2')
      .send({ reason: 'Stop this job' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'JOB_CANCELLATION_FORBIDDEN',
        message: 'The current caller does not own this job.'
      }
    });
    expect(requestJobCancellationMock).not.toHaveBeenCalled();
  });

  it('cancels queued jobs immediately for the matching session owner', async () => {
    getJobByIdMock.mockResolvedValue({
      id: QUEUED_JOB_ID,
      job_type: 'gpt',
      status: 'pending',
      idempotency_scope_hash: hashActorKey('session:owner-1'),
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:00:00.000Z',
      completed_at: null,
      error_message: null,
      output: null,
      cancel_requested_at: null,
      cancel_reason: null
    });
    requestJobCancellationMock.mockResolvedValue({
      outcome: 'cancelled',
      job: {
        id: QUEUED_JOB_ID,
        job_type: 'gpt',
        status: 'cancelled',
        idempotency_scope_hash: hashActorKey('session:owner-1'),
        created_at: '2026-04-06T10:00:00.000Z',
        updated_at: '2026-04-06T10:01:00.000Z',
        completed_at: '2026-04-06T10:01:00.000Z',
        error_message: 'Job cancellation requested by client.',
        output: null,
        cancel_requested_at: '2026-04-06T10:01:00.000Z',
        cancel_reason: 'Stop this job'
      }
    });

    const response = await request(buildApp())
      .post(`/jobs/${QUEUED_JOB_ID}/cancel`)
      .set('x-confirmed', 'yes')
      .set('x-session-id', 'owner-1')
      .send({ reason: 'Stop this job' });

    expect(response.status).toBe(200);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      ok: true,
      id: QUEUED_JOB_ID,
      status: 'cancelled',
      lifecycle_status: 'cancelled',
      cancellationRequested: false
    });
  });

  it('returns 202 when cancellation is requested for a running job', async () => {
    getJobByIdMock.mockResolvedValue({
      id: CANCEL_REQUEST_JOB_ID,
      job_type: 'gpt',
      status: 'running',
      idempotency_scope_hash: hashActorKey('session:owner-2'),
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:01:00.000Z',
      completed_at: null,
      error_message: null,
      output: null,
      cancel_requested_at: null,
      cancel_reason: null
    });
    requestJobCancellationMock.mockResolvedValue({
      outcome: 'cancellation_requested',
      job: {
        id: CANCEL_REQUEST_JOB_ID,
        job_type: 'gpt',
        status: 'running',
        idempotency_scope_hash: hashActorKey('session:owner-2'),
        created_at: '2026-04-06T10:00:00.000Z',
        updated_at: '2026-04-06T10:01:00.000Z',
        completed_at: null,
        error_message: null,
        output: null,
        cancel_requested_at: '2026-04-06T10:01:00.000Z',
        cancel_reason: 'Stop this job'
      }
    });

    const response = await request(buildApp())
      .post(`/jobs/${CANCEL_REQUEST_JOB_ID}/cancel`)
      .set('x-confirmed', 'yes')
      .set('x-session-id', 'owner-2')
      .send({ reason: 'Stop this job' });

    expect(response.status).toBe(202);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      ok: true,
      id: CANCEL_REQUEST_JOB_ID,
      status: 'running',
      lifecycle_status: 'running',
      cancellationRequested: true
    });
  });

  it('preserves terminal cancellation conflicts for the owning caller', async () => {
    getJobByIdMock.mockResolvedValue({
      id: TERMINAL_JOB_ID,
      job_type: 'gpt',
      status: 'completed',
      idempotency_scope_hash: hashActorKey('session:owner-3'),
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:01:00.000Z',
      completed_at: '2026-04-06T10:01:00.000Z',
      error_message: null,
      output: { ok: true },
      cancel_requested_at: null,
      cancel_reason: null
    });
    requestJobCancellationMock.mockResolvedValue({
      outcome: 'already_terminal',
      job: {
        id: TERMINAL_JOB_ID,
        job_type: 'gpt',
        status: 'completed',
        idempotency_scope_hash: hashActorKey('session:owner-3'),
        created_at: '2026-04-06T10:00:00.000Z',
        updated_at: '2026-04-06T10:01:00.000Z',
        completed_at: '2026-04-06T10:01:00.000Z',
        error_message: null,
        output: { ok: true },
        cancel_requested_at: null,
        cancel_reason: null
      }
    });

    const response = await request(buildApp())
      .post(`/jobs/${TERMINAL_JOB_ID}/cancel`)
      .set('x-confirmed', 'yes')
      .set('x-session-id', 'owner-3');

    expect(response.status).toBe(409);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'JOB_ALREADY_TERMINAL',
        message: 'Terminal jobs cannot be cancelled.'
      }
    });
  });

  it('preserves job lookup metadata when bounded result payloads are truncated', async () => {
    const previousMaxBytes = process.env.CLIENT_RESPONSE_MAX_BYTES;
    process.env.CLIENT_RESPONSE_MAX_BYTES = '2048';
    getJobByIdMock.mockResolvedValue({
      id: TRUNCATED_JOB_ID,
      job_type: 'gpt',
      status: 'completed',
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:01:00.000Z',
      completed_at: '2026-04-06T10:01:00.000Z',
      retention_until: '2026-04-07T10:01:00.000Z',
      idempotency_until: '2026-04-07T10:01:00.000Z',
      expires_at: null,
      error_message: null,
      output: {
        ok: true,
        result: {
          answer: 'x'.repeat(16_000)
        }
      },
      cancel_requested_at: null,
      cancel_reason: null
    });

    try {
      const response = await request(buildApp()).get(`/jobs/${TRUNCATED_JOB_ID}/result`);

      expect(response.status).toBe(200);
      expect(response.headers['x-response-bytes']).toBeTruthy();
      expect(response.headers['x-response-truncated']).toBe('true');
      expect(Number(response.headers['x-response-bytes'])).toBeLessThanOrEqual(2048);
      expect(response.body).toMatchObject({
        jobId: TRUNCATED_JOB_ID,
        status: 'completed',
        jobStatus: 'completed',
        lifecycleStatus: 'completed',
        poll: `/jobs/${TRUNCATED_JOB_ID}`,
        stream: `/jobs/${TRUNCATED_JOB_ID}/stream`,
        truncated: true,
        result: expect.stringContaining('[truncated]')
      });
      expect(response.body.error).toBeNull();
    } finally {
      if (previousMaxBytes === undefined) {
        delete process.env.CLIENT_RESPONSE_MAX_BYTES;
      } else {
        process.env.CLIENT_RESPONSE_MAX_BYTES = previousMaxBytes;
      }
    }
  });
});

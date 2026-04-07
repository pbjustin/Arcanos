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

  it('returns lifecycle metadata for job polling responses', async () => {
    getJobByIdMock.mockResolvedValue({
      id: 'job-123',
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

    const response = await request(buildApp()).get('/jobs/job-123');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: 'job-123',
      status: 'expired',
      lifecycle_status: 'expired',
      retention_until: '2026-04-06T10:04:00.000Z',
      idempotency_until: '2026-04-06T10:03:00.000Z',
      expires_at: '2026-04-06T10:05:00.000Z'
    });
  });

  it('rejects anonymous cancellation requests', async () => {
    const response = await request(buildApp())
      .post('/jobs/job-123/cancel')
      .set('x-confirmed', 'yes')
      .send({ reason: 'Stop this job' });

    expect(response.status).toBe(401);
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
      id: 'job-123',
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
      .post('/jobs/job-123/cancel')
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
      id: 'job-123',
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
        id: 'job-123',
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
      .post('/jobs/job-123/cancel')
      .set('x-confirmed', 'yes')
      .set('x-session-id', 'owner-1')
      .send({ reason: 'Stop this job' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      id: 'job-123',
      status: 'cancelled',
      lifecycle_status: 'cancelled',
      cancellationRequested: false
    });
  });

  it('returns 202 when cancellation is requested for a running job', async () => {
    getJobByIdMock.mockResolvedValue({
      id: 'job-456',
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
        id: 'job-456',
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
      .post('/jobs/job-456/cancel')
      .set('x-confirmed', 'yes')
      .set('x-session-id', 'owner-2')
      .send({ reason: 'Stop this job' });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      ok: true,
      id: 'job-456',
      status: 'running',
      lifecycle_status: 'running',
      cancellationRequested: true
    });
  });

  it('preserves terminal cancellation conflicts for the owning caller', async () => {
    getJobByIdMock.mockResolvedValue({
      id: 'job-789',
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
        id: 'job-789',
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
      .post('/jobs/job-789/cancel')
      .set('x-confirmed', 'yes')
      .set('x-session-id', 'owner-3');

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'JOB_ALREADY_TERMINAL',
        message: 'Terminal jobs cannot be cancelled.'
      }
    });
  });
});

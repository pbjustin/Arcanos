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

  it('cancels queued jobs immediately', async () => {
    requestJobCancellationMock.mockResolvedValue({
      outcome: 'cancelled',
      job: {
        id: 'job-123',
        job_type: 'gpt',
        status: 'cancelled',
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
    requestJobCancellationMock.mockResolvedValue({
      outcome: 'cancellation_requested',
      job: {
        id: 'job-456',
        job_type: 'gpt',
        status: 'running',
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
});

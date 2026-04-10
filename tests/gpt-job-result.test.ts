import { describe, expect, it } from '@jest/globals';
import {
  buildStoredJobStatusPayload,
  parseGptJobResultRequest
} from '../src/shared/gpt/gptJobResult.js';

describe('gpt job result helpers', () => {
  it('normalizes get_result action values during request parsing', () => {
    const parsed = parseGptJobResultRequest({
      action: ' Get_Result ',
      payload: {
        jobId: 'job-123'
      }
    });

    expect(parsed).toEqual({
      ok: true,
      jobId: 'job-123'
    });
  });

  it('serializes stored job timestamps consistently', () => {
    const payload = buildStoredJobStatusPayload({
      id: 'job-123',
      job_type: 'gpt',
      status: 'completed',
      created_at: new Date('2026-04-06T10:00:00.000Z'),
      updated_at: new Date('2026-04-06T10:00:01.000Z'),
      completed_at: new Date('2026-04-06T10:00:02.000Z'),
      cancel_requested_at: null,
      cancel_reason: null,
      retention_until: new Date('2026-04-07T10:00:00.000Z'),
      idempotency_until: new Date('2026-04-06T11:00:00.000Z'),
      expires_at: new Date('2026-04-08T10:00:00.000Z'),
      error_message: null,
      output: {
        ok: true
      }
    } as any);

    expect(payload).toMatchObject({
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:00:01.000Z',
      completed_at: '2026-04-06T10:00:02.000Z',
      cancel_requested_at: null,
      retention_until: '2026-04-07T10:00:00.000Z',
      idempotency_until: '2026-04-06T11:00:00.000Z',
      expires_at: '2026-04-08T10:00:00.000Z'
    });
  });
});

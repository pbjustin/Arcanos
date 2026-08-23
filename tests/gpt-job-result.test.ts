import { afterAll, describe, expect, it } from '@jest/globals';
import {
  buildGptJobResultBridgePayload,
  buildGptJobResultLookupPayload,
  buildStoredJobStatusPayload,
  parseGptJobStatusRequest,
  parseGptJobResultRequest
} from '../src/shared/gpt/gptJobResult.js';
import { buildProtectedBackstageQueuedGptJobInput } from
  '../src/shared/gpt/asyncGptJob.js';
import {
  markProtectedBackstageQueuedGptJobResultMaterialized,
  protectBackstageQueuedGptJobOutput,
} from '../src/shared/backstage/backstageQueuedJobResultProtection.js';

describe('gpt job result helpers', () => {
  const originalPayloadKey = process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;

  afterAll(() => {
    if (originalPayloadKey === undefined) {
      delete process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;
    } else {
      process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY = originalPayloadKey;
    }
  });
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

  it('normalizes get_status action values during request parsing', () => {
    const parsed = parseGptJobStatusRequest({
      action: ' Get_Status ',
      payload: {
        jobId: 'job-456'
      }
    });

    expect(parsed).toEqual({
      ok: true,
      jobId: 'job-456'
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

  it.each(['completed', 'failed'])(
    'preserves a generic %s result that happens to share protected source fields',
    (status) => {
      const output = {
        source: 'backstage-booker-worker',
        version: 1,
        value: 'generic-result-sentinel',
      };
      const job = {
        id: `job-generic-${status}`,
        job_type: 'gpt',
        status,
        input: { gptId: 'arcanos-core', body: { prompt: 'safe prompt' } },
        output,
        error_message: status === 'failed' ? 'Generic failure.' : null,
        created_at: new Date('2026-08-23T10:00:00.000Z'),
        updated_at: new Date('2026-08-23T10:00:01.000Z'),
      } as any;

      expect(buildStoredJobStatusPayload(job)).toMatchObject({ output, result: output });
      expect(buildGptJobResultLookupPayload(job.id, job).result).toEqual(output);
      expect(buildGptJobResultBridgePayload(job.id, job).output).toEqual(output);
    }
  );

  it('never projects a genuine stored protected Booker result descriptor', () => {
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x71).toString('base64');
    const input = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBooking',
        payload: { universeId: 'my-universe-2k26', prompt: 'private prompt' },
      },
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
    });
    const output = protectBackstageQueuedGptJobOutput({
      jobId: 'job-protected-result',
      rawInput: input,
      output: { ok: true, result: 'private result sentinel' },
    });
    const job = {
      id: 'job-protected-result',
      job_type: 'gpt',
      status: 'completed',
      input,
      output,
      created_at: new Date('2026-08-23T10:00:00.000Z'),
      updated_at: new Date('2026-08-23T10:00:01.000Z'),
    } as any;

    expect(buildStoredJobStatusPayload(job)).toMatchObject({ output: null, result: null });
    expect(buildGptJobResultLookupPayload(job.id, job).result).toBeNull();
    expect(buildGptJobResultBridgePayload(job.id, job).output).toBeNull();

    for (const unsafeOutput of [
      { ok: true, result: 'private raw protected result' },
      {
        source: 'backstage-booker-worker',
        version: 1,
        sealedPayload: { ciphertext: 'private malformed ciphertext' },
      },
    ]) {
      const unsafeJob = { ...job, output: unsafeOutput };
      expect(buildStoredJobStatusPayload(unsafeJob).output).toBeNull();
      expect(buildGptJobResultLookupPayload(job.id, unsafeJob).result).toBeNull();
      expect(buildGptJobResultBridgePayload(job.id, unsafeJob).output).toBeNull();
    }

    const materializedOutput = {
      ok: true,
      result: 'capability-gated materialized result',
    };
    const materializedJob = markProtectedBackstageQueuedGptJobResultMaterialized({
      ...job,
      output: materializedOutput,
    });
    expect(buildStoredJobStatusPayload(materializedJob).output)
      .toEqual(materializedOutput);
    expect(buildGptJobResultLookupPayload(job.id, materializedJob).result)
      .toEqual(materializedOutput);
  });
});

import { describe, expect, it } from '@jest/globals';

import {
  buildAsyncJobResponseMetadata,
  buildDirectReturnTimeoutResponse,
  normalizeCompletedAsyncGptResponse,
} from '../src/routes/_core/gptAsyncJobResponses.js';
import type { QueuedGptPendingResponse } from '../src/shared/gpt/asyncGptJob.js';
import {
  GPT_QUERY_ACTION,
  GPT_QUERY_AND_WAIT_ACTION,
} from '../src/shared/gpt/gptJobResult.js';

describe('GPT async-job response helpers', () => {
  it('returns the same minimally valid completed envelope without tightening its route shape', () => {
    const envelope = {
      ok: true,
      result: { answer: 42 },
      _route: {},
      additionalField: 'preserved',
    };

    expect(normalizeCompletedAsyncGptResponse(envelope)).toBe(envelope);
  });

  it.each([
    null,
    [],
    { ok: false, _route: {} },
    { ok: true },
    { ok: true, _route: [] },
  ])('rejects an invalid completed envelope: %p', (output) => {
    expect(normalizeCompletedAsyncGptResponse(output)).toBeNull();
  });

  it('builds stable status, lifecycle, links, and dedupe metadata', () => {
    expect(buildAsyncJobResponseMetadata({
      action: GPT_QUERY_AND_WAIT_ACTION,
      jobId: 'job-123',
      jobStatus: 'expired',
      deduped: true,
      idempotencyKey: 'key-123',
      idempotencySource: 'explicit',
    })).toEqual({
      action: GPT_QUERY_AND_WAIT_ACTION,
      jobId: 'job-123',
      status: 'timeout',
      jobStatus: 'expired',
      lifecycleStatus: 'expired',
      poll: '/jobs/job-123/result',
      stream: '/jobs/job-123/stream',
      jobReadToken: expect.stringMatching(/^v1\.[A-Za-z0-9_-]{43}$/u),
      jobReadTokenHeader: 'x-arcanos-job-read-token',
      timedOut: false,
      deduped: true,
      idempotencyKey: 'key-123',
      idempotencySource: 'explicit',
    });

    const nonDeduped = buildAsyncJobResponseMetadata({
      action: GPT_QUERY_ACTION,
      jobId: 'job-456',
      jobStatus: 'pending',
      deduped: false,
      idempotencyKey: 'key-456',
      idempotencySource: 'derived',
    });
    expect(nonDeduped).not.toHaveProperty('deduped');
    expect(nonDeduped.status).toBe('queued');
    expect(nonDeduped.lifecycleStatus).toBe('queued');
  });

  it('overrides timeout fields while preserving pending response metadata', () => {
    const pendingResponse: QueuedGptPendingResponse = {
      ok: true,
      action: GPT_QUERY_AND_WAIT_ACTION,
      status: 'running',
      jobId: 'job-timeout',
      result: {},
      poll: '/jobs/job-timeout/result',
      stream: '/jobs/job-timeout/stream',
      jobReadToken: 'v1.test-token-placeholder',
      jobReadTokenHeader: 'x-arcanos-job-read-token',
      timedOut: false,
      jobStatus: 'running',
      lifecycleStatus: 'running',
      idempotencyKey: 'key-timeout',
      idempotencySource: 'explicit',
      _route: {
        requestId: 'request-timeout',
        gptId: 'arcanos-core',
        route: 'async',
        timestamp: '2026-07-26T00:00:00.000Z',
      },
    };

    expect(buildDirectReturnTimeoutResponse({
      pendingResponse,
      jobId: 'job-timeout',
      waitForResultMs: 1_250,
      pollIntervalMs: 75,
    })).toEqual({
      ...pendingResponse,
      status: 'timeout',
      result: {},
      poll: '/jobs/job-timeout/result',
      timedOut: true,
      instruction:
        'Direct wait timed out after 1250ms. Use GET /jobs/job-timeout/result to retrieve the final result.',
      directReturn: {
        requested: true,
        timedOut: true,
        waitForResultMs: 1_250,
        pollIntervalMs: 75,
        poll: '/jobs/job-timeout/result',
        result: '/jobs/job-timeout/result',
      },
    });
  });
});

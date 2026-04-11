import { describe, expect, it } from '@jest/globals';
import {
  DEFAULTS,
  PROBE_STATUS,
  enqueueAsyncProbe,
  parseArgs,
  pollAsyncProbe,
  runAsyncProbe
} from '../scripts/railway-async-job-probe.js';

describe('railway-async-job-probe', () => {
  it('parses explicit CLI overrides', () => {
    const parsed = parseArgs([
      '--base-url', 'https://example.com',
      '--gpt-id', 'custom-core',
      '--prompt', 'Return OK.',
      '--timeout-ms', '45000',
      '--poll-interval-ms', '900',
      '--request-timeout-ms', '5000'
    ]);

    expect(parsed).toEqual({
      ...DEFAULTS,
      baseUrl: 'https://example.com',
      gptId: 'custom-core',
      prompt: 'Return OK.',
      timeoutMs: 45000,
      pollIntervalMs: 900,
      requestTimeoutMs: 5000
    });
  });

  it('accepts queued async jobs and reports completion after polling', async () => {
    const responses = [
      {
        status: 202,
        ok: true,
        text: async () => JSON.stringify({
          ok: true,
          status: 'pending',
          jobId: 'job-123',
          poll: '/jobs/job-123'
        })
      },
      {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({
          jobId: 'job-123',
          status: 'pending'
        })
      },
      {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({
          jobId: 'job-123',
          status: 'completed',
          result: { ok: true }
        })
      }
    ];
    const fetchFn = async () => responses.shift();
    const sleepFn = async () => {};

    const result = await runAsyncProbe(
      {
        ...DEFAULTS,
        baseUrl: 'https://example.com',
        timeoutMs: 5_000,
        pollIntervalMs: 10
      },
      {
        fetchFn,
        sleepFn,
        nowFn: (() => {
          let now = 0;
          return () => {
            now += 5;
            return now;
          };
        })()
      }
    );

    expect(result.status).toBe(PROBE_STATUS.PASS);
    expect(result.detail).toMatch(/job-123/);
  });

  it('fails when the queued job reaches a terminal failed state', async () => {
    const result = await pollAsyncProbe(
      {
        ...DEFAULTS,
        timeoutMs: 1_000,
        pollIntervalMs: 10
      },
      {
        jobId: 'job-failed',
        resultUrl: 'https://example.com/jobs/job-failed/result'
      },
      {
        fetchFn: async () => ({
          status: 200,
          ok: true,
          text: async () => JSON.stringify({
            jobId: 'job-failed',
            status: 'failed',
            error: {
              message: 'worker execution failed'
            }
          })
        }),
        sleepFn: async () => {},
        nowFn: () => 0
      }
    );

    expect(result.status).toBe(PROBE_STATUS.FAIL);
    expect(result.detail).toMatch(/worker execution failed/);
  });

  it('returns queued probe metadata with a normalized result URL', async () => {
    const enqueueResult = await enqueueAsyncProbe(
      {
        ...DEFAULTS,
        baseUrl: 'example.com',
        gptId: 'arcanos-core'
      },
      {
        fetchFn: async () => ({
          status: 202,
          ok: true,
          text: async () => JSON.stringify({
            ok: true,
            status: 'pending',
            jobId: 'job-456',
            poll: '/jobs/job-456'
          })
        })
      }
    );

    expect(enqueueResult).toEqual({
      mode: 'queued',
      jobId: 'job-456',
      resultUrl: 'https://example.com/jobs/job-456/result'
    });
  });
});

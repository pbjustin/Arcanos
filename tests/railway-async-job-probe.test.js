import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  DEFAULTS,
  PROBE_STATUS,
  enqueueAsyncProbe,
  parseArgs,
  pollAsyncProbe,
  runAsyncProbe
} from '../scripts/railway-async-job-probe.js';
import {
  PROBE_RESPONSES,
  createProbeResponse,
  rejectOnRequestAbort,
} from './fixtures/railway-probe-responses.js';

afterEach(() => {
  jest.useRealTimers();
});

const queuedProbe = { jobId: 'job-fixture', resultUrl: 'https://example.com/jobs/job-fixture/result' };

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
          poll: '/jobs/job-123/result'
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

  it('redacts query parameters from successful probe output', async () => {
    const result = await pollAsyncProbe(
      {
        ...DEFAULTS,
        timeoutMs: 1_000,
        pollIntervalMs: 10
      },
      {
        jobId: 'job-secret',
        resultUrl: 'https://example.com/jobs/job-secret/result?trace=probe-secret'
      },
      {
        fetchFn: async () => ({
          status: 200,
          ok: true,
          text: async () => JSON.stringify({
            jobId: 'job-secret',
            status: 'completed',
            result: { ok: true }
          })
        }),
        sleepFn: async () => {},
        nowFn: () => 0
      }
    );

    expect(result.status).toBe(PROBE_STATUS.PASS);
    expect(result.detail).toContain('https://example.com/jobs/job-secret/result');
    expect(result.detail).not.toContain('trace=probe-secret');
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
            poll: '/jobs/job-456/result'
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

  it('preserves query parameters when the poll URL is already absolute', async () => {
    const enqueueResult = await enqueueAsyncProbe(
      {
        ...DEFAULTS,
        baseUrl: 'https://example.com',
        gptId: 'arcanos-core'
      },
      {
        fetchFn: async () => ({
          status: 202,
          ok: true,
          text: async () => JSON.stringify({
            ok: true,
            status: 'pending',
            jobId: 'job-789',
            poll: 'https://example.com/jobs/job-789/result?trace=abc123'
          })
        })
      }
    );

    expect(enqueueResult).toEqual({
      mode: 'queued',
      jobId: 'job-789',
      resultUrl: 'https://example.com/jobs/job-789/result?trace=abc123'
    });
  });

  it('keeps the inline result and request contract intact', async () => {
    const fetchFn = jest.fn(async () => createProbeResponse(PROBE_RESPONSES.inline));
    const config = { ...DEFAULTS, baseUrl: ' http://example.com/// ', gptId: 'core/name' };
    await expect(enqueueAsyncProbe(config, { fetchFn })).resolves.toEqual({
      mode: 'inline', body: JSON.parse(PROBE_RESPONSES.inline.bodyText),
    });
    expect(fetchFn.mock.calls[0]).toEqual([
      'http://example.com/gpt/core%2Fname',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'arcanos-railway-async-job-probe/1.0' },
        body: JSON.stringify({ message: DEFAULTS.prompt, async: true }),
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  it.each(['', ' \n', '{broken', '[]', 'null', 'true', '7', '"fixture"'])('fails closed on non-record enqueue and poll bodies %p', async (bodyText) => {
    jest.useFakeTimers();
    const fetchFn = async () => createProbeResponse({ bodyText });
    await expect(enqueueAsyncProbe(DEFAULTS, { fetchFn })).rejects.toThrow('Probe request returned non-JSON body (status=200).');
    await expect(pollAsyncProbe(DEFAULTS, queuedProbe, { fetchFn, nowFn: () => 0 })).resolves.toEqual({
      status: 'FAIL', detail: 'Queued probe job job-fixture lookup returned a non-JSON body.',
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves HTTP failure diagnostics and incomplete metadata errors', async () => {
    await expect(enqueueAsyncProbe(DEFAULTS, {
      fetchFn: async () => createProbeResponse({ status: 503, bodyText: '{"error":"fixture"}' }),
    })).rejects.toThrow('Probe request failed with status=503, body={"error":"fixture"}');
    await expect(enqueueAsyncProbe(DEFAULTS, {
      fetchFn: async () => createProbeResponse({ status: 202, bodyText: '{"jobId":" "}' }),
    })).rejects.toThrow('Probe request returned incomplete async metadata: {"jobId":" "}');
    await expect(pollAsyncProbe(DEFAULTS, queuedProbe, {
      fetchFn: async () => createProbeResponse({ status: 404, bodyText: '{broken' }), nowFn: () => 0,
    })).resolves.toEqual({ status: 'FAIL', detail: 'Queued probe job job-fixture lookup failed with status=404.' });
  });

  it.each(['failed', 'cancelled', 'expired', 'not_found'])('retains terminal %s state handling with an optional error message', async (status) => {
    for (const error of [undefined, { message: 'fixture worker failure' }, { message: 7 }]) {
      await expect(pollAsyncProbe(DEFAULTS, queuedProbe, {
        fetchFn: async () => createProbeResponse({ bodyText: JSON.stringify({ status: ` ${status.toUpperCase()} `, error }) }),
        nowFn: () => 0,
      })).resolves.toEqual({
        status: 'FAIL', detail: `Async probe job job-fixture ended in status=${status}: ${typeof error?.message === 'string' ? error.message : 'terminal failure'}`,
      });
    }
  });

  it('normalizes result suffixes while retaining capability query and fragment only in requests', async () => {
    const fetchFn = jest.fn()
      .mockResolvedValueOnce(createProbeResponse({ status: 202, bodyText: JSON.stringify({
        jobId: ' job-fixture ', poll: '/jobs/job-fixture///?fixture=test-capability#test-fragment',
      }) }))
      .mockResolvedValueOnce(createProbeResponse(PROBE_RESPONSES.completed));
    const result = await runAsyncProbe({ ...DEFAULTS, baseUrl: 'example.com/' }, { fetchFn, nowFn: () => 0 });
    expect(fetchFn.mock.calls[1][0]).toBe('https://example.com/jobs/job-fixture/result?fixture=test-capability#test-fragment');
    expect(result).toEqual({ status: 'PASS', detail: 'Async probe job job-fixture completed successfully via https://example.com/jobs/job-fixture/result.' });
  });

  it('caps sleeps at the remaining deadline and polls at the inclusive boundary', async () => {
    let now = 0;
    const sleepFn = jest.fn(async (delay) => { now += delay; });
    const signals = [];
    const fetchFn = jest.fn(async (_url, { signal }) => {
      signals.push(signal);
      return createProbeResponse(PROBE_RESPONSES.pending);
    });
    await expect(pollAsyncProbe({ ...DEFAULTS, timeoutMs: 25, pollIntervalMs: 20 }, queuedProbe, {
      fetchFn, sleepFn, nowFn: () => now,
    })).resolves.toEqual({ status: 'FAIL', detail: 'Async probe job job-fixture did not complete within 25ms.' });
    expect(sleepFn.mock.calls).toEqual([[20], [5]]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(new Set(signals).size).toBe(3);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
  });

  it('does not poll after the deadline has elapsed', async () => {
    const fetchFn = jest.fn();
    const nowFn = jest.fn().mockReturnValueOnce(0).mockReturnValue(26);
    await expect(pollAsyncProbe({ ...DEFAULTS, timeoutMs: 25 }, queuedProbe, { fetchFn, nowFn })).resolves.toEqual({
      status: 'FAIL', detail: 'Async probe job job-fixture did not complete within 25ms.',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each(['enqueue', 'poll'])('aborts stalled %s requests and releases timers', async (stage) => {
    jest.useFakeTimers();
    const config = { ...DEFAULTS, requestTimeoutMs: 25 };
    const dependencies = { fetchFn: rejectOnRequestAbort, nowFn: () => 0 };
    const promise = stage === 'enqueue'
      ? enqueueAsyncProbe(config, dependencies)
      : pollAsyncProbe(config, queuedProbe, dependencies);
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await jest.advanceTimersByTimeAsync(25);
    await rejection;
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['network', 'body'])('propagates %s failures from enqueue and polling and releases timers', async (stage) => {
    jest.useFakeTimers();
    const error = new Error(`fixture ${stage} failure`);
    const dependencies = {
      fetchFn: async () => {
        if (stage === 'network') throw error;
        return { text: async () => { throw error; } };
      },
      nowFn: () => 0,
    };
    await expect(enqueueAsyncProbe(DEFAULTS, dependencies)).rejects.toBe(error);
    await expect(pollAsyncProbe(DEFAULTS, queuedProbe, dependencies)).rejects.toBe(error);
    expect(jest.getTimerCount()).toBe(0);
  });
});

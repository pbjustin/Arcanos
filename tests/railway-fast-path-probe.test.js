import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  DEFAULTS,
  PROBE_STATUS,
  RAILWAY_PRODUCTION_BASE_URL,
  parseArgs,
  runFastPathProbe,
} from '../scripts/railway-fast-path-probe.js';
import {
  PROBE_RESPONSES,
  createProbeResponse,
  rejectOnRequestAbort,
} from './fixtures/railway-probe-responses.js';

afterEach(() => {
  jest.useRealTimers();
});

function buildHeaders(entries = {}) {
  return {
    get(name) {
      return entries[name.toLowerCase()] ?? null;
    },
  };
}

describe('railway-fast-path-probe', () => {
  it('documents the Railway-assigned production fallback host', () => {
    expect(RAILWAY_PRODUCTION_BASE_URL).toBe('https://acranos-production.up.railway.app');
  });

  it('parses explicit CLI overrides', () => {
    const parsed = parseArgs([
      '--base-url', 'https://example.com',
      '--gpt-id', 'custom-core',
      '--prompt', 'Generate a prompt.',
      '--request-timeout-ms', '5000',
    ]);

    expect(parsed).toEqual({
      ...DEFAULTS,
      baseUrl: 'https://example.com',
      gptId: 'custom-core',
      prompt: 'Generate a prompt.',
      requestTimeoutMs: 5000,
    });
  });

  it('passes when the GPT route returns fast-path metadata inline', async () => {
    const fetchCalls = [];
    const result = await runFastPathProbe(
      {
        ...DEFAULTS,
        baseUrl: 'example.com',
      },
      {
        fetchFn: async (url, init) => {
          fetchCalls.push({ url, init });
          return {
            status: 200,
            ok: true,
            headers: buildHeaders(),
            text: async () => JSON.stringify({
              ok: true,
              result: {
                result: 'Generated prompt',
              },
              routeDecision: {
                path: 'fast_path',
                reason: 'explicit_fast_mode',
                queueBypassed: true,
              },
              _route: {
                route: 'fast_path',
              },
            }),
          };
        },
      }
    );

    expect(result.status).toBe(PROBE_STATUS.PASS);
    expect(result.detail).toContain('/gpt/arcanos-core');
    expect(fetchCalls[0]).toMatchObject({
      url: 'https://example.com/gpt/arcanos-core',
      init: {
        method: 'POST',
        body: JSON.stringify({
          prompt: DEFAULTS.prompt,
          executionMode: 'fast',
        }),
      },
    });
  });

  it('fails when the response falls back to queued work', async () => {
    const result = await runFastPathProbe(
      {
        ...DEFAULTS,
        baseUrl: 'https://example.com',
      },
      {
        fetchFn: async () => ({
          status: 202,
          ok: true,
          headers: buildHeaders({
            'x-gpt-route-decision': 'orchestrated_path',
            'x-gpt-queue-bypassed': 'false',
          }),
          text: async () => JSON.stringify({
            ok: true,
            jobId: 'job-123',
            status: 'pending',
          }),
        }),
      }
    );

    expect(result.status).toBe(PROBE_STATUS.FAIL);
    expect(result.detail).toContain('expected HTTP 200');
  });

  it.each(['', ' \n', '{broken', '[]', 'null', 'true', '7', '"fixture"'])('rejects non-record response bodies %p and clears the timeout', async (bodyText) => {
    jest.useFakeTimers();
    await expect(runFastPathProbe(DEFAULTS, {
      fetchFn: async () => createProbeResponse({ bodyText }),
    })).resolves.toEqual({ status: 'FAIL', detail: 'Fast-path probe returned non-JSON body (status=200).' });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retains queued-job validation for an HTTP 200 response', async () => {
    await expect(runFastPathProbe(DEFAULTS, {
      fetchFn: async () => createProbeResponse({ ...PROBE_RESPONSES.queued, status: 200 }),
    })).resolves.toEqual({ status: 'FAIL', detail: 'Fast-path probe unexpectedly queued job job-fixture.' });
  });

  it('preserves route header fallback and URL escaping', async () => {
    const fetchFn = jest.fn(async () => createProbeResponse({
      bodyText: '{}',
      headers: { 'x-gpt-route-decision': 'fast_path', 'x-gpt-queue-bypassed': 'true' },
    }));
    await expect(runFastPathProbe({ ...DEFAULTS, baseUrl: ' http://example.com/// ', gptId: 'core/name' }, {
      fetchFn,
    })).resolves.toEqual({ status: 'PASS', detail: 'Fast-path probe completed inline for /gpt/core/name (no-reason).' });
    expect(fetchFn.mock.calls[0][0]).toBe('http://example.com/gpt/core%2Fname');
    expect(fetchFn.mock.calls[0][1].headers).toEqual({
      'content-type': 'application/json', 'user-agent': 'arcanos-railway-fast-path-probe/1.0',
    });
  });

  it('keeps body route metadata authoritative over header fallbacks', async () => {
    await expect(runFastPathProbe(DEFAULTS, {
      fetchFn: async () => createProbeResponse({
        bodyText: JSON.stringify({ routeDecision: { path: 'orchestrated_path', queueBypassed: false } }),
        headers: { 'x-gpt-route-decision': 'fast_path', 'x-gpt-queue-bypassed': 'true' },
      }),
    })).resolves.toEqual({ status: 'FAIL', detail: 'Fast-path probe did not return inline route metadata: path=orchestrated_path, queueBypassed=false.' });
  });

  it.each(['network', 'body'])('propagates %s failures and clears the timeout', async (stage) => {
    jest.useFakeTimers();
    const error = new Error(`fixture ${stage} failure`);
    await expect(runFastPathProbe(DEFAULTS, {
      fetchFn: async () => {
        if (stage === 'network') throw error;
        return { text: async () => { throw error; } };
      },
    })).rejects.toBe(error);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('aborts a stalled request at its configured timeout and releases the timer', async () => {
    jest.useFakeTimers();
    const promise = runFastPathProbe({ ...DEFAULTS, requestTimeoutMs: 25 }, { fetchFn: rejectOnRequestAbort });
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await jest.advanceTimersByTimeAsync(25);
    await rejection;
    expect(jest.getTimerCount()).toBe(0);
  });
});

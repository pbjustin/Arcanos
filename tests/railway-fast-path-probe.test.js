import { describe, expect, it } from '@jest/globals';
import {
  DEFAULTS,
  PROBE_STATUS,
  RAILWAY_PRODUCTION_BASE_URL,
  parseArgs,
  runFastPathProbe,
} from '../scripts/railway-fast-path-probe.js';

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
});

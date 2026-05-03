import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_MAX_BODY_CHARS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  PROTECTED_CHECKS,
  PUBLIC_CHECKS,
  SMOKE_STATUS,
  buildBodyForOutput,
  buildSmokeChecks,
  parseArgs,
  runLiveSmoke,
  sanitizeJsonValue,
} from '../scripts/gpt-access-live-smoke.js';

function buildHeaders(entries = {}) {
  return {
    get(name) {
      return entries[name.toLowerCase()] ?? null;
    },
  };
}

const SAMPLE_AUTH_VALUE = ['sample', 'auth', 'value'].join('-');

function jsonResponse(status, body, contentType = 'application/json; charset=utf-8') {
  return {
    status,
    headers: buildHeaders({ 'content-type': contentType }),
    text: async () => JSON.stringify(body),
  };
}

function openApiBody() {
  return {
    openapi: '3.1.0',
    paths: {
      '/gpt-access/openapi.json': { get: { operationId: 'getGptAccessOpenApi', security: [] } },
      '/gpt-access/status': { get: { operationId: 'getRuntimeStatus', security: [{ bearerAuth: [] }] } },
      '/gpt-access/workers/status': { get: { operationId: 'getWorkersStatus', security: [{ bearerAuth: [] }] } },
      '/gpt-access/queue/inspect': { get: { operationId: 'inspectQueue', security: [{ bearerAuth: [] }] } },
      '/gpt-access/self-heal/status': { get: { operationId: 'getSelfHealStatus', security: [{ bearerAuth: [] }] } },
    },
  };
}

describe('gpt-access-live-smoke', () => {
  it('parses base URL and bounded numeric flags without accepting token args', () => {
    const parsed = parseArgs(
      [
        '--base-url', 'https://gateway.example.test/',
        '--request-timeout-ms', '5000',
        '--max-body-chars', '1000',
        '--access-token', 'must-not-be-read',
      ],
      {}
    );

    expect(parsed).toEqual({
      baseUrl: 'https://gateway.example.test/',
      requestTimeoutMs: 5000,
      maxBodyChars: 1000,
    });
  });

  it('uses backend URL env fallbacks for defaults', () => {
    const parsed = parseArgs([], {
      ARCANOS_BACKEND_URL: 'https://backend.example.test',
    });

    expect(parsed).toEqual({
      baseUrl: 'https://backend.example.test',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      maxBodyChars: DEFAULT_MAX_BODY_CHARS,
    });
  });

  it('runs only the unauthenticated OpenAPI check when no token exists', async () => {
    const fetchCalls = [];
    const results = await runLiveSmoke(
      {
        baseUrl: 'gateway.example.test',
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        maxBodyChars: DEFAULT_MAX_BODY_CHARS,
      },
      {
        env: {},
        fetchFn: async (url, init) => {
          fetchCalls.push({ url, init });
          return jsonResponse(200, openApiBody());
        },
      }
    );

    expect(buildSmokeChecks('')).toEqual([...PUBLIC_CHECKS]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      path: '/gpt-access/openapi.json',
      httpStatus: 200,
      result: SMOKE_STATUS.PASS,
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://gateway.example.test/gpt-access/openapi.json');
    expect(fetchCalls[0].init.headers).not.toHaveProperty('authorization');
  });

  it('fails OpenAPI when the smoke target paths are not advertised', async () => {
    const results = await runLiveSmoke(
      {
        baseUrl: 'https://gateway.example.test',
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        maxBodyChars: DEFAULT_MAX_BODY_CHARS,
      },
      {
        env: {},
        fetchFn: async () => jsonResponse(200, {
          openapi: '3.1.0',
          paths: {
            '/gpt-access/openapi.json': { get: { operationId: 'getGptAccessOpenApi', security: [] } },
          },
        }),
      }
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      path: '/gpt-access/openapi.json',
      httpStatus: 200,
      result: SMOKE_STATUS.FAIL,
      body: {
        paths: {
          '/gpt-access/status': {
            present: false,
          },
        },
      },
    });
  });

  it('runs protected GET checks with env-only bearer auth when a token exists', async () => {
    const fetchCalls = [];
    const env = {
      ARCANOS_GPT_ACCESS_TOKEN: SAMPLE_AUTH_VALUE,
    };

    const results = await runLiveSmoke(
      {
        baseUrl: 'https://gateway.example.test',
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        maxBodyChars: DEFAULT_MAX_BODY_CHARS,
      },
      {
        env,
        fetchFn: async (url, init) => {
          fetchCalls.push({ url, init });
          if (new URL(url).pathname === '/gpt-access/openapi.json') {
            return jsonResponse(200, openApiBody());
          }
          return jsonResponse(200, { ok: true, path: new URL(url).pathname });
        },
      }
    );

    expect(buildSmokeChecks(env.ARCANOS_GPT_ACCESS_TOKEN)).toEqual([
      ...PUBLIC_CHECKS,
      ...PROTECTED_CHECKS,
    ]);
    expect(results.map((result) => result.path)).toEqual([
      '/gpt-access/openapi.json',
      '/gpt-access/status',
      '/gpt-access/workers/status',
      '/gpt-access/queue/inspect',
      '/gpt-access/self-heal/status',
    ]);
    expect(results.every((result) => result.result === SMOKE_STATUS.PASS)).toBe(true);
    expect(fetchCalls[0].init.headers).not.toHaveProperty('authorization');
    for (const call of fetchCalls.slice(1)) {
      expect(call.init).toMatchObject({
        method: 'GET',
        headers: {
          authorization: `Bearer ${SAMPLE_AUTH_VALUE}`,
        },
      });
    }
    expect(JSON.stringify(results)).not.toContain(SAMPLE_AUTH_VALUE);
    expect(JSON.stringify(results)).not.toContain(`Bearer ${SAMPLE_AUTH_VALUE}`);
  });

  it('sanitizes sensitive JSON keys and values before output', () => {
    const sanitized = sanitizeJsonValue(
      {
        headers: {
          authorization: `Bearer ${SAMPLE_AUTH_VALUE}`,
        },
        nested: {
          lastError: 'Authorization: Bearer abcdefghijklmnop DATABASE_URL=postgres://user:pass@host/db OPENAI_API_KEY=sk-test-placeholder-value',
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
          },
        },
        DATABASE_URL: 'postgres://user:pass@host/db',
        ['tok' + 'en']: SAMPLE_AUTH_VALUE,
      },
      {
        secretValues: [SAMPLE_AUTH_VALUE],
      }
    );
    const rendered = JSON.stringify(sanitized);

    expect(rendered).not.toContain(SAMPLE_AUTH_VALUE);
    expect(rendered).not.toContain('Bearer abcdefghijklmnop');
    expect(rendered).not.toContain('postgres://user:pass@host/db');
    expect(rendered).not.toContain('sk-test-placeholder-value');
    expect(rendered).toContain('[REDACTED');
    expect(rendered).toContain('bearerAuth');
  });

  it('outputs bounded OpenAPI path metadata instead of the full document', () => {
    const body = buildBodyForOutput(
      '/gpt-access/openapi.json',
      {
        openapi: '3.1.0',
        paths: {
          '/gpt-access/openapi.json': { get: { operationId: 'getGptAccessOpenApi', security: [] } },
          '/gpt-access/status': { get: { operationId: 'getRuntimeStatus', security: [{ bearerAuth: [] }] } },
          '/unrelated': { post: { operationId: 'unused' } },
        },
      },
      {
        secretValues: [],
        maxBodyChars: DEFAULT_MAX_BODY_CHARS,
      }
    );

    expect(body).toMatchObject({
      openapi: '3.1.0',
      paths: {
        '/gpt-access/openapi.json': {
          present: true,
          operationId: 'getGptAccessOpenApi',
          security: [],
        },
        '/gpt-access/status': {
          present: true,
          operationId: 'getRuntimeStatus',
          security: [{ bearerAuth: [] }],
        },
      },
    });
    expect(body.paths).not.toHaveProperty('/unrelated');
  });

  it('returns a short sanitized failure for non-JSON responses', async () => {
    const results = await runLiveSmoke(
      {
        baseUrl: 'https://gateway.example.test',
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        maxBodyChars: DEFAULT_MAX_BODY_CHARS,
      },
      {
        env: {},
        fetchFn: async () => ({
          status: 502,
          headers: buildHeaders({ 'content-type': 'text/html' }),
          text: async () => '<html>Authorization: Bearer abcdefghijklmnop</html>',
        }),
      }
    );

    expect(results).toHaveLength(1);
    expect(Object.keys(results[0])).toEqual([
      'path',
      'httpStatus',
      'contentType',
      'error',
      'result',
    ]);
    expect(results[0]).toMatchObject({
      path: '/gpt-access/openapi.json',
      httpStatus: 502,
      contentType: 'text/html',
      result: SMOKE_STATUS.FAIL,
    });
    expect(results[0].error).not.toContain('Bearer abcdefghijklmnop');
    expect(results[0].error.length).toBeLessThanOrEqual(300);
  });
});

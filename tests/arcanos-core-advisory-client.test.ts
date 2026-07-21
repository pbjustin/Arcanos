import { describe, expect, it, jest } from '@jest/globals';

import {
  ArcanosCoreAdvisoryError,
  createArcanosCoreAdvisoryClient,
  resolveArcanosCoreAdvisoryConfig
} from '../src/platform/operator/arcanosCoreAdvisoryClient.js';

const JOB_ID = '11111111-1111-4111-8111-111111111111';

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers
    }
  });
}

function buildClient(fetchFn: typeof fetch, overrides: Record<string, unknown> = {}) {
  return createArcanosCoreAdvisoryClient({
    baseUrl: 'https://advisory.example.test',
    credential: 'test-access-credential',
    fetchFn,
    pollIntervalMs: 1,
    pollDeadlineMs: 100,
    maxPolls: 4,
    sleepFn: async () => undefined,
    ...overrides
  });
}

describe('ArcanosCoreAdvisoryClient', () => {
  it('requires an exact HTTPS origin and configuration outside tool input', () => {
    const fetchFn = jest.fn() as unknown as typeof fetch;

    for (const baseUrl of [
      'http://advisory.example.test',
      'https://advisory.example.test/path',
      'https://advisory.example.test?target=other',
      'https://user:password@advisory.example.test'
    ]) {
      expect(() => createArcanosCoreAdvisoryClient({
        baseUrl,
        credential: 'configured-outside-tool',
        fetchFn
      })).toThrow(ArcanosCoreAdvisoryError);
    }

    expect(fetchFn).not.toHaveBeenCalled();
    expect(() => resolveArcanosCoreAdvisoryConfig({})).toThrow('Advisory bridge configuration is unavailable.');
  });

  it('creates one fixed arcanos-core job and polls only the fixed result endpoint', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined; body: Record<string, unknown> }> = [];
    const fetchFn = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      requests.push({ url: String(input), init, body });

      if (requests.length === 1) {
        return jsonResponse({
          ok: true,
          jobId: JOB_ID,
          traceId: 'trace-advisory',
          status: 'queued',
          deduped: false,
          resultEndpoint: '/gpt-access/jobs/result'
        }, 202);
      }

      return jsonResponse({
        ok: true,
        jobId: JOB_ID,
        traceId: 'trace-advisory',
        status: 'completed',
        result: {
          recommendation: 'Keep command and result operations separate.',
          authorization: 'Bearer test-placeholder-never-returned',
          echo: 'test-access-credential'
        }
      });
    }) as unknown as typeof fetch;

    const client = buildClient(fetchFn);
    const first = await client.consult({
      task: 'Review the execution ownership contract.',
      context: 'Use only the supplied sanitized findings.',
      maxOutputTokens: 1024
    });

    expect(first).toEqual({
      ok: true,
      gptId: 'arcanos-core',
      jobId: JOB_ID,
      traceId: 'trace-advisory',
      result: {
        recommendation: 'Keep command and result operations separate.',
        echo: '[REDACTED]'
      }
    });
    expect(requests.map((request) => request.url)).toEqual([
      'https://advisory.example.test/gpt-access/jobs/create',
      'https://advisory.example.test/gpt-access/jobs/result'
    ]);
    expect(requests[0]?.body).toEqual({
      gptId: 'arcanos-core',
      task: 'Review the execution ownership contract.',
      context: 'Use only the supplied sanitized findings.',
      maxOutputTokens: 1024,
      idempotencyKey: expect.stringMatching(/^arcanos-core-advisory:v1:[a-f0-9]{64}$/)
    });
    expect(requests[1]?.body).toEqual({ jobId: JOB_ID, traceId: 'trace-advisory' });
    expect(requests[0]?.init).toEqual(expect.objectContaining({
      method: 'POST',
      redirect: 'manual',
      headers: expect.objectContaining({
        accept: 'application/json',
        authorization: 'Bearer test-access-credential',
        'content-type': 'application/json'
      })
    }));

    const duplicateCreate = jest.fn(async () => jsonResponse({
      ok: true,
      jobId: JOB_ID,
      traceId: 'trace-advisory',
      status: 'queued',
      deduped: true,
      resultEndpoint: '/gpt-access/jobs/result'
    }, 202)) as unknown as typeof fetch;
    const duplicate = buildClient(duplicateCreate, { maxPolls: 0 });
    await expect(duplicate.consult({
      task: 'Review the execution ownership contract.',
      context: 'Use only the supplied sanitized findings.',
      maxOutputTokens: 1024
    })).rejects.toMatchObject({ code: 'ARCANOS_CORE_ADVISORY_POLL_LIMIT' });
    const duplicateBody = JSON.parse(String((duplicateCreate as unknown as jest.Mock).mock.calls[0]?.[1]?.body));
    expect(duplicateBody.idempotencyKey).toBe(requests[0]?.body.idempotencyKey);
  });

  it('handles pending completion deterministically', async () => {
    const responses = [
      jsonResponse({
        ok: true,
        jobId: JOB_ID,
        traceId: 'trace-advisory',
        status: 'queued',
        deduped: false,
        resultEndpoint: '/gpt-access/jobs/result'
      }, 202),
      jsonResponse({ ok: true, jobId: JOB_ID, status: 'pending', result: null }),
      jsonResponse({ ok: true, jobId: JOB_ID, status: 'completed', result: 'review complete' })
    ];
    const fetchFn = jest.fn(async () => responses.shift()!) as unknown as typeof fetch;

    await expect(buildClient(fetchFn).consult({ task: 'Review this sanitized ADR.' })).resolves.toMatchObject({
      ok: true,
      result: 'review complete'
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('omits credential-shaped result keys without disclosing the keys themselves', async () => {
    const secretKey = 'secret-sentinel-result-key';
    const configuredCredential = 'test-access-credential';
    const responses = [
      jsonResponse({
        ok: true,
        jobId: JOB_ID,
        traceId: 'trace-advisory',
        status: 'queued',
        deduped: false,
        resultEndpoint: '/gpt-access/jobs/result'
      }, 202),
      jsonResponse({
        ok: true,
        jobId: JOB_ID,
        status: 'completed',
        result: {
          safeFinding: 'retain this finding',
          [secretKey]: 'must be omitted with its key',
          [configuredCredential]: 'must also be omitted',
          nested: {
            'Authorization: Bearer test-placeholder-credential-value': 'must be omitted',
            safeDetail: 'retain this detail'
          }
        }
      })
    ];
    const fetchFn = jest.fn(async () => responses.shift()!) as unknown as typeof fetch;

    const result = await buildClient(fetchFn).consult({ task: 'Review sanitized findings.' });
    const serialized = JSON.stringify(result);

    expect(result.result).toEqual({
      safeFinding: 'retain this finding',
      nested: { safeDetail: 'retain this detail' }
    });
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain(configuredCredential);
    expect(serialized).not.toContain('Authorization');
  });

  it.each([
    'test-access-credential',
    'secret-sentinel-trace-id',
    'Bearer_credential_trace'
  ])('omits credential-shaped trace IDs before polling and output: %s', async (unsafeTraceId) => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchFn = jest.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        return jsonResponse({
          ok: true,
          jobId: JOB_ID,
          traceId: unsafeTraceId,
          status: 'queued',
          deduped: false,
          resultEndpoint: '/gpt-access/jobs/result'
        }, 202);
      }
      return jsonResponse({ ok: true, jobId: JOB_ID, status: 'completed', result: 'complete' });
    }) as unknown as typeof fetch;

    const result = await buildClient(fetchFn).consult({ task: 'Review sanitized findings.' });

    expect(result).not.toHaveProperty('traceId');
    expect(requestBodies[1]).toEqual({ jobId: JOB_ID });
    expect(JSON.stringify(result)).not.toContain(unsafeTraceId);
  });

  it.each([
    ['failed', 'ARCANOS_CORE_ADVISORY_JOB_FAILED'],
    ['expired', 'ARCANOS_CORE_ADVISORY_JOB_EXPIRED'],
    ['not_found', 'ARCANOS_CORE_ADVISORY_JOB_NOT_FOUND']
  ])('maps terminal %s status to a fixed non-sensitive error', async (status, expectedCode) => {
    const sentinel = 'secret-sentinel-value';
    const responses = [
      jsonResponse({
        ok: true,
        jobId: JOB_ID,
        traceId: 'trace-advisory',
        status: 'queued',
        deduped: false,
        resultEndpoint: '/gpt-access/jobs/result'
      }, 202),
      jsonResponse({
        ok: true,
        jobId: JOB_ID,
        status,
        error: { message: `dependency leaked ${sentinel}` }
      })
    ];
    const fetchFn = jest.fn(async () => responses.shift()!) as unknown as typeof fetch;

    let observed: unknown;
    try {
      await buildClient(fetchFn).consult({ task: 'Review this sanitized ADR.' });
    } catch (error) {
      observed = error;
    }

    expect(observed).toMatchObject({ code: expectedCode });
    expect(String(observed)).not.toContain(sentinel);
  });

  it('rejects credential-shaped prompt content before making a request', async () => {
    const fetchFn = jest.fn() as unknown as typeof fetch;
    const client = buildClient(fetchFn);

    await expect(client.consult({
      task: 'Review Authorization: Bearer test-placeholder-credential-value'
    })).rejects.toMatchObject({ code: 'ARCANOS_CORE_ADVISORY_REQUEST_REJECTED' });
    await expect(client.consult({
      task: 'Review postgresql://user:password@database.internal/db'
    })).rejects.toMatchObject({ code: 'ARCANOS_CORE_ADVISORY_REQUEST_REJECTED' });
    await expect(client.consult({
      task: 'Review test-access-credential without sending it.'
    })).rejects.toMatchObject({ code: 'ARCANOS_CORE_ADVISORY_REQUEST_REJECTED' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    [jsonResponse({ ok: true }, 302, { location: 'https://other.example.test' }), 'ARCANOS_CORE_ADVISORY_GATEWAY_REJECTED'],
    [new Response('not json', { status: 202, headers: { 'content-type': 'text/plain' } }), 'ARCANOS_CORE_ADVISORY_RESPONSE_INVALID'],
    [new Response('{broken', { status: 202, headers: { 'content-type': 'application/json' } }), 'ARCANOS_CORE_ADVISORY_RESPONSE_INVALID']
  ])('fails closed for redirects, non-JSON, and malformed JSON', async (response, expectedCode) => {
    const fetchFn = jest.fn(async () => response) as unknown as typeof fetch;
    await expect(buildClient(fetchFn).consult({ task: 'Review sanitized findings.' }))
      .rejects.toMatchObject({ code: expectedCode });
  });

  it('enforces the response byte cap', async () => {
    const fetchFn = jest.fn(async () => jsonResponse({ content: 'x'.repeat(4096) })) as unknown as typeof fetch;
    await expect(buildClient(fetchFn, { maxResponseBytes: 256 }).consult({ task: 'Review sanitized findings.' }))
      .rejects.toMatchObject({ code: 'ARCANOS_CORE_ADVISORY_RESPONSE_TOO_LARGE' });
  });

  it('maps response-stream failures to a fixed error without exposing their cause', async () => {
    const sentinel = 'secret-sentinel-stream-failure';
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(sentinel));
      }
    });
    const fetchFn = jest.fn(async () => new Response(body, {
      status: 202,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch;

    let observed: unknown;
    try {
      await buildClient(fetchFn).consult({ task: 'Review sanitized findings.' });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(ArcanosCoreAdvisoryError);
    expect(observed).toMatchObject({ code: 'ARCANOS_CORE_ADVISORY_RESPONSE_INVALID' });
    expect(String(observed)).not.toContain(sentinel);
  });

  it('aborts a stalled request without leaking its internal failure', async () => {
    const sentinel = 'secret-sentinel-timeout';
    const fetchFn = jest.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error(sentinel)), { once: true });
    })) as unknown as typeof fetch;

    let observed: unknown;
    try {
      await buildClient(fetchFn, { requestTimeoutMs: 5 }).consult({ task: 'Review sanitized findings.' });
    } catch (error) {
      observed = error;
    }

    expect(observed).toMatchObject({ code: 'ARCANOS_CORE_ADVISORY_GATEWAY_UNAVAILABLE' });
    expect(String(observed)).not.toContain(sentinel);
  });

  it('clears the request timeout after an immediate transport rejection', async () => {
    jest.useFakeTimers();
    try {
      const fetchFn = jest.fn(async () => {
        throw new Error('unobservable transport failure');
      }) as unknown as typeof fetch;

      await expect(buildClient(fetchFn, { requestTimeoutMs: 10_000 }).consult({
        task: 'Review sanitized findings.'
      })).rejects.toMatchObject({ code: 'ARCANOS_CORE_ADVISORY_GATEWAY_UNAVAILABLE' });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

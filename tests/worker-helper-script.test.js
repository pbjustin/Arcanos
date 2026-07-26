import { createServer } from 'node:http';

import { describe, expect, it, jest } from '@jest/globals';

import {
  MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH as SHARED_MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH as SHARED_MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';
import {
  WORKER_HELPER_TOKEN_ENV_NAME as SHARED_WORKER_HELPER_TOKEN_ENV_NAME,
  WORKER_HELPER_TOKEN_HEADER_NAME as SHARED_WORKER_HELPER_TOKEN_HEADER_NAME,
} from '../src/shared/security/workerHelperCredential.js';
import {
  buildHelperRequestHeaders,
  MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  runWorkerHelperCli,
  SCRIPT_PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
  sendHelperRequest,
  WORKER_HELPER_TOKEN_ENV_NAME,
  WORKER_HELPER_TOKEN_HEADER_NAME,
} from '../scripts/worker-helper.mjs';

const workerHelperToken = 'worker-helper-script-token-1234567890';

function jsonResponse(payload, options = {}) {
  const responseText = JSON.stringify(payload);
  return new Response(responseText, {
    status: options.status ?? 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(responseText, 'utf8')),
      ...options.headers,
    },
  });
}

async function listenOnLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a loopback port.');
  }
  return address.port;
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe('worker-helper script client', () => {
  it('keeps standalone credential constants synchronized with the TypeScript contract', () => {
    expect(WORKER_HELPER_TOKEN_ENV_NAME).toBe(SHARED_WORKER_HELPER_TOKEN_ENV_NAME);
    expect(WORKER_HELPER_TOKEN_HEADER_NAME).toBe(SHARED_WORKER_HELPER_TOKEN_HEADER_NAME);
    expect(MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH)
      .toBe(SHARED_MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH);
    expect(MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH)
      .toBe(SHARED_MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH);
    expect([...SCRIPT_PURPOSE_BOUND_CREDENTIAL_ENV_NAMES])
      .toEqual([...PURPOSE_BOUND_CREDENTIAL_ENV_NAMES]);
  });

  it('does not read or attach the credential for the public status request', async () => {
    const environment = {
      ARCANOS_BASE_URL: 'http://127.0.0.1:3000',
    };
    Object.defineProperty(environment, WORKER_HELPER_TOKEN_ENV_NAME, {
      enumerable: true,
      get() {
        throw new Error('public status must not read the privileged credential');
      },
    });
    const fetchFn = jest.fn(async () => jsonResponse({ ok: true }));

    await sendHelperRequest({
      method: 'GET',
      path: '/worker-helper/status',
      baseUrl: 'http://127.0.0.1:3000',
      environment,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:3000/worker-helper/status'),
      expect.objectContaining({
        headers: expect.not.objectContaining({
          [WORKER_HELPER_TOKEN_HEADER_NAME]: expect.anything(),
        }),
        redirect: 'follow',
      })
    );
  });

  it.each([
    {
      argv: ['latest-job'],
      expectedPath: '/worker-helper/jobs/latest',
    },
    {
      argv: ['job', 'job-123'],
      expectedPath: '/worker-helper/jobs/job-123',
    },
    {
      argv: ['queue-ask', 'test prompt'],
      expectedPath: '/worker-helper/queue/ask',
    },
    {
      argv: ['dispatch', 'test input'],
      expectedPath: '/worker-helper/dispatch',
    },
    {
      argv: ['heal'],
      expectedPath: '/worker-helper/heal',
    },
  ])(
    'forwards the exact env-only credential for $argv.0',
    async ({ argv, expectedPath }) => {
      const fetchFn = jest.fn(async () => jsonResponse({ ok: true }));
      const writeOutput = jest.fn();

      await runWorkerHelperCli({
        argv,
        environment: {
          ARCANOS_BASE_URL: 'https://worker.example.test',
          [WORKER_HELPER_TOKEN_ENV_NAME]: workerHelperToken,
        },
        fetchFn,
        writeOutput,
      });

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [requestUrl, requestOptions] = fetchFn.mock.calls[0];
      const headers = new Headers(requestOptions.headers);
      expect(requestUrl).toEqual(new URL(`https://worker.example.test${expectedPath}`));
      expect(headers.get(WORKER_HELPER_TOKEN_HEADER_NAME)).toBe(workerHelperToken);
      expect(headers.has('authorization')).toBe(false);
      expect(requestOptions.redirect).toBe('error');
      expect(String(requestUrl)).not.toContain(workerHelperToken);
      expect(requestOptions.body ?? '').not.toContain(workerHelperToken);
      expect(JSON.stringify(writeOutput.mock.calls)).not.toContain(workerHelperToken);
    }
  );

  it('fails before fetch when a protected command has no configured token', async () => {
    const fetchFn = jest.fn();

    await expect(sendHelperRequest({
      method: 'GET',
      path: '/worker-helper/jobs/latest',
      baseUrl: 'https://worker.example.test',
      privileged: true,
      environment: {},
      fetchFn,
    })).rejects.toThrow('Privileged worker-helper credential configuration is invalid.');

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ['short value', { [WORKER_HELPER_TOKEN_ENV_NAME]: 'too-short' }],
    [
      'outer whitespace',
      { [WORKER_HELPER_TOKEN_ENV_NAME]: ` ${workerHelperToken}` },
    ],
    [
      'embedded whitespace',
      { [WORKER_HELPER_TOKEN_ENV_NAME]: 'worker-helper-token-with-space-1234 5678' },
    ],
    [
      'placeholder',
      { [WORKER_HELPER_TOKEN_ENV_NAME]: 'change-me-worker-helper-token-1234567890' },
    ],
    [
      'oversized value',
      { [WORKER_HELPER_TOKEN_ENV_NAME]: 'x'.repeat(4_097) },
    ],
    [
      'cross-purpose collision',
      {
        [WORKER_HELPER_TOKEN_ENV_NAME]: workerHelperToken,
        ARCANOS_GPT_ACCESS_TOKEN: ` ${workerHelperToken} `,
      },
    ],
  ])('rejects %s before network access', async (_label, environment) => {
    const fetchFn = jest.fn();

    await expect(sendHelperRequest({
      method: 'POST',
      path: '/worker-helper/heal',
      baseUrl: 'https://worker.example.test',
      privileged: true,
      environment,
      fetchFn,
    })).rejects.toThrow('Privileged worker-helper credential configuration is invalid.');

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    'worker.example.test',
    'http://worker.example.test',
    'ftp://worker.example.test',
    'https://user:password@worker.example.test',
    'https://worker.example.test/base',
    'https://worker.example.test?target=other',
    'https://worker.example.test#fragment',
  ])('rejects non-exact or insecure privileged base URL %s', async (baseUrl) => {
    const fetchFn = jest.fn();

    await expect(sendHelperRequest({
      method: 'POST',
      path: '/worker-helper/heal',
      baseUrl,
      privileged: true,
      environment: {
        [WORKER_HELPER_TOKEN_ENV_NAME]: workerHelperToken,
      },
      fetchFn,
    })).rejects.toThrow(/exact HTTPS origin|exact HTTP\(S\) origin/u);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('accepts exact HTTP loopback origins for local protected use', async () => {
    const fetchFn = jest.fn(async () => jsonResponse({ ok: true }));

    await sendHelperRequest({
      method: 'POST',
      path: '/worker-helper/heal',
      baseUrl: 'http://localhost:3000/',
      privileged: true,
      environment: {
        [WORKER_HELPER_TOKEN_ENV_NAME]: workerHelperToken,
      },
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    '--token',
    '--worker-helper-token',
    '--Authorization',
  ])('rejects credential flag %s so the environment remains the only source', async (flag) => {
    const fetchFn = jest.fn();

    await expect(runWorkerHelperCli({
      argv: ['heal', flag, 'command-line-secret'],
      environment: {
        ARCANOS_BASE_URL: 'https://worker.example.test',
        [WORKER_HELPER_TOKEN_ENV_NAME]: workerHelperToken,
      },
      fetchFn,
      writeOutput: jest.fn(),
    })).rejects.toThrow(
      'Worker-helper credentials may only be supplied through the environment.'
    );

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('redacts exact credential reflections from bounded success output', async () => {
    const fetchFn = jest.fn(async () => jsonResponse({
      ok: true,
      message: `credential echo ${workerHelperToken}`,
      [workerHelperToken]: 'reflected key',
    }));

    const result = await sendHelperRequest({
      method: 'POST',
      path: '/worker-helper/heal',
      body: { force: true },
      baseUrl: 'https://worker.example.test',
      privileged: true,
      environment: {
        [WORKER_HELPER_TOKEN_ENV_NAME]: workerHelperToken,
      },
      fetchFn,
    });

    expect(result).toEqual({
      ok: true,
      message: 'credential echo [REDACTED]',
    });
    expect(JSON.stringify(result)).not.toContain(workerHelperToken);
  });

  it('does not read or propagate a non-success response body', async () => {
    const text = jest.fn(async () => JSON.stringify({
      error: `rejected ${workerHelperToken}`,
    }));
    const cancel = jest.fn(async () => undefined);
    const fetchFn = jest.fn(async () => ({
      ok: false,
      status: 401,
      body: { cancel },
      text,
    }));

    let observedError;
    try {
      await sendHelperRequest({
        method: 'POST',
        path: '/worker-helper/dispatch',
        body: { input: 'test' },
        baseUrl: 'https://worker.example.test',
        privileged: true,
        environment: {
          [WORKER_HELPER_TOKEN_ENV_NAME]: workerHelperToken,
        },
        fetchFn,
      });
    } catch (error) {
      observedError = error;
    }

    expect(observedError).toBeInstanceOf(Error);
    expect(observedError.message).toBe('Worker-helper request failed with HTTP 401.');
    expect(observedError).not.toHaveProperty('responseBody');
    expect(JSON.stringify(observedError)).not.toContain(workerHelperToken);
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not propagate a fetch exception that reflects the credential', async () => {
    const fetchFn = jest.fn(async () => {
      throw new Error(`transport reflected ${workerHelperToken}`);
    });

    await expect(sendHelperRequest({
      method: 'POST',
      path: '/worker-helper/heal',
      baseUrl: 'https://worker.example.test',
      privileged: true,
      environment: {
        [WORKER_HELPER_TOKEN_ENV_NAME]: workerHelperToken,
      },
      fetchFn,
    })).rejects.toThrow('Worker-helper request could not be completed.');
  });

  it('aborts a protected request when fetch does not complete within the timeout', async () => {
    let observedSignal;
    const fetchFn = jest.fn((_requestUrl, requestOptions) => new Promise((_resolve, reject) => {
      observedSignal = requestOptions.signal;
      observedSignal.addEventListener('abort', () => {
        reject(new Error(`aborted transport reflected ${workerHelperToken}`));
      }, { once: true });
    }));

    await expect(sendHelperRequest({
      method: 'POST',
      path: '/worker-helper/heal',
      baseUrl: 'https://worker.example.test',
      privileged: true,
      environment: {
        [WORKER_HELPER_TOKEN_ENV_NAME]: workerHelperToken,
      },
      fetchFn,
      timeoutMs: 10,
    })).rejects.toThrow('Worker-helper request could not be completed.');

    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal.aborted).toBe(true);
  });

  it('keeps the timeout active while reading a streamed response body', async () => {
    let observedSignal;
    const fetchFn = jest.fn(async (_requestUrl, requestOptions) => {
      observedSignal = requestOptions.signal;
      return new Response(new ReadableStream({
        start(controller) {
          observedSignal.addEventListener('abort', () => {
            controller.error(new Error(`body reflected ${workerHelperToken}`));
          }, { once: true });
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(sendHelperRequest({
      method: 'POST',
      path: '/worker-helper/heal',
      baseUrl: 'https://worker.example.test',
      privileged: true,
      environment: {
        [WORKER_HELPER_TOKEN_ENV_NAME]: workerHelperToken,
      },
      fetchFn,
      timeoutMs: 10,
    })).rejects.toThrow('Worker-helper response was invalid or exceeded the allowed size.');

    expect(observedSignal.aborted).toBe(true);
  });

  it('cancels a streamed response as soon as its body exceeds the byte limit', async () => {
    const cancel = jest.fn();
    const oversizedStream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(600_000));
      },
      cancel,
    });

    await expect(sendHelperRequest({
      method: 'POST',
      path: '/worker-helper/heal',
      baseUrl: 'https://worker.example.test',
      privileged: true,
      environment: {
        [WORKER_HELPER_TOKEN_ENV_NAME]: workerHelperToken,
      },
      fetchFn: jest.fn(async () => new Response(oversizedStream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    })).rejects.toThrow('Worker-helper response was invalid or exceeded the allowed size.');

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-stream success response without calling its unbounded text fallback', async () => {
    const text = jest.fn(async () => JSON.stringify({
      reflected: workerHelperToken,
    }));

    await expect(sendHelperRequest({
      method: 'POST',
      path: '/worker-helper/heal',
      baseUrl: 'https://worker.example.test',
      privileged: true,
      environment: {
        [WORKER_HELPER_TOKEN_ENV_NAME]: workerHelperToken,
      },
      fetchFn: jest.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        text,
      })),
    })).rejects.toThrow('Worker-helper response was invalid or exceeded the allowed size.');

    expect(text).not.toHaveBeenCalled();
  });

  it.each([
    [
      'invalid JSON',
      () => new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ],
    [
      'non-JSON content type',
      () => new Response('plain text', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    ],
    [
      'oversized declared body',
      () => new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': '1048577',
        },
      }),
    ],
  ])('rejects a bounded-response violation: %s', async (_label, createResponse) => {
    await expect(sendHelperRequest({
      method: 'POST',
      path: '/worker-helper/heal',
      baseUrl: 'https://worker.example.test',
      privileged: true,
      environment: {
        [WORKER_HELPER_TOKEN_ENV_NAME]: workerHelperToken,
      },
      fetchFn: jest.fn(async () => createResponse()),
    })).rejects.toThrow('Worker-helper response was invalid or exceeded the allowed size.');
  });

  it('rejects all redirect method variants without forwarding the custom credential', async () => {
    let destinationRequests = 0;
    const sourceHeaders = [];
    const destinationServer = createServer((_request, response) => {
      destinationRequests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const destinationPort = await listenOnLoopback(destinationServer);
    const sourceServer = createServer((request, response) => {
      sourceHeaders.push(request.headers);
      const requestUrl = new URL(request.url, 'http://127.0.0.1');
      const redirectStatus = Number(requestUrl.searchParams.get('status'));
      response.writeHead(redirectStatus, {
        location: `http://127.0.0.1:${destinationPort}/captured`,
      });
      response.end();
    });
    const sourcePort = await listenOnLoopback(sourceServer);

    try {
      for (const redirectStatus of [301, 302, 303, 307, 308]) {
        await expect(sendHelperRequest({
          method: 'POST',
          path: `/worker-helper/heal?status=${redirectStatus}`,
          baseUrl: `http://127.0.0.1:${sourcePort}`,
          privileged: true,
          environment: {
            [WORKER_HELPER_TOKEN_ENV_NAME]: workerHelperToken,
          },
        })).rejects.toThrow('Worker-helper request could not be completed.');
      }

      expect(sourceHeaders).toHaveLength(5);
      expect(sourceHeaders.every(
        headers => headers[WORKER_HELPER_TOKEN_HEADER_NAME] === workerHelperToken
      )).toBe(true);
      expect(destinationRequests).toBe(0);
    } finally {
      await closeServer(sourceServer);
      await closeServer(destinationServer);
    }
  });

  it('builds no alternate Authorization carrier', () => {
    expect(buildHelperRequestHeaders({
      privileged: true,
      environment: {
        [WORKER_HELPER_TOKEN_ENV_NAME]: workerHelperToken,
      },
    })).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      [WORKER_HELPER_TOKEN_HEADER_NAME]: workerHelperToken,
    });
  });
});

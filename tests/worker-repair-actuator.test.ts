import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const workerHelperTokenA = 'worker-repair-token-a-123456789012';
const workerHelperTokenB = 'worker-repair-token-b-123456789012';
const workerHelperTokenHeaderName = 'x-arcanos-worker-helper-token';

const environment = new Map<string, string>();
const getEnvMock = jest.fn((name: string) => environment.get(name));
const getConfigMock = jest.fn(() => ({
  runWorkers: false,
  workerApiTimeoutMs: 5_000,
}));
const getStableWorkerRuntimeModeMock = jest.fn(() => ({
  requestedRunWorkers: false,
  resolvedRunWorkers: false,
  processKind: 'unknown',
  railwayServiceName: null,
  reason: 'requested',
}));
const isWorkerRuntimeSuppressedForServiceRoleMock = jest.fn(() => false);
const getRailwayApiConfigMock = jest.fn(() => ({
  endpoint: 'https://backboard.railway.com/graphql/v2',
}));
const deployServiceMock = jest.fn(async (_input?: unknown) => ({
  accepted: true,
  status: 'accepted',
}));
const isRailwayApiConfiguredMock = jest.fn(() => false);
const listProjectsMock = jest.fn(async () => []);
const healWorkerRuntimeMock = jest.fn(async () => ({
  timestamp: '2026-07-25T12:00:00.000Z',
  requestedForce: true,
  restart: {
    started: true,
    message: 'Local workers restarted.',
  },
  runtime: {
    enabled: true,
  },
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: getEnvMock,
}));

jest.unstable_mockModule('@platform/runtime/railway.js', () => ({
  getRailwayApiConfig: getRailwayApiConfigMock,
}));

jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: getConfigMock,
  getStableWorkerRuntimeMode: getStableWorkerRuntimeModeMock,
  isWorkerRuntimeSuppressedForServiceRole: isWorkerRuntimeSuppressedForServiceRoleMock,
}));

jest.unstable_mockModule('@services/railwayClient.js', () => ({
  deployService: deployServiceMock,
  isRailwayApiConfigured: isRailwayApiConfiguredMock,
  listProjects: listProjectsMock,
}));

jest.unstable_mockModule('@services/workerControlService.js', () => ({
  healWorkerRuntime: healWorkerRuntimeMock,
}));

jest.unstable_mockModule('@core/lib/errors/index.js', () => ({
  resolveErrorMessage: (error: unknown) => (
    error instanceof Error ? error.message : String(error)
  ),
}));

const {
  buildWorkerRepairActuatorStatus,
  executeWorkerRepairActuator,
} = await import('../src/services/selfImprove/workerRepairActuator.js');

function configureRemoteWorker(baseUrl = 'https://worker.example.test'): void {
  environment.set('SELF_HEAL_WORKER_SERVICE_URL', baseUrl);
}

function validRemoteApproval() {
  return {
    approved: true,
    approvedBy: 'operator:test',
    reason: 'Focused worker-repair actuator test',
    action: 'worker repair actuator remote_worker_helper',
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
}

function fetchReturning(responseFactory: () => Response) {
  return jest.fn(
    async (
      _input: string | URL | Request,
      _init?: RequestInit
    ): Promise<Response> => responseFactory()
  );
}

async function captureError(operation: Promise<unknown>): Promise<Error> {
  let observedError: unknown;
  try {
    await operation;
  } catch (error) {
    observedError = error;
  }

  expect(observedError).toBeInstanceOf(Error);
  return observedError as Error;
}

function serializeError(error: Error): string {
  return JSON.stringify({
    name: error.name,
    message: error.message,
    ...Object.fromEntries(Object.entries(error)),
  });
}

beforeEach(() => {
  environment.clear();
  jest.resetAllMocks();

  getEnvMock.mockImplementation((name: string) => environment.get(name));
  getConfigMock.mockReturnValue({
    runWorkers: false,
    workerApiTimeoutMs: 5_000,
  });
  getStableWorkerRuntimeModeMock.mockReturnValue({
    requestedRunWorkers: false,
    resolvedRunWorkers: false,
    processKind: 'unknown',
    railwayServiceName: null,
    reason: 'requested',
  });
  isWorkerRuntimeSuppressedForServiceRoleMock.mockReturnValue(false);
  getRailwayApiConfigMock.mockReturnValue({
    endpoint: 'https://backboard.railway.com/graphql/v2',
  });
  deployServiceMock.mockResolvedValue({
    accepted: true,
    status: 'accepted',
  });
  isRailwayApiConfiguredMock.mockReturnValue(false);
  listProjectsMock.mockResolvedValue([]);
  healWorkerRuntimeMock.mockResolvedValue({
    timestamp: '2026-07-25T12:00:00.000Z',
    requestedForce: true,
    restart: {
      started: true,
      message: 'Local workers restarted.',
    },
    runtime: {
      enabled: true,
    },
  });
});

describe('worker repair actuator remote credential boundary', () => {
  it.each([
    null,
    '',
  ])('does not advertise remote repair without an injected credential: %p', (credential) => {
    configureRemoteWorker();

    const status = buildWorkerRepairActuatorStatus({
      resolveWorkerHelperToken: () => credential,
    });

    expect(status).toEqual(expect.objectContaining({
      mode: 'unavailable',
      available: false,
      baseUrl: null,
      path: null,
    }));
  });

  it.each([
    'too-short',
    ` ${workerHelperTokenA}`,
    'worker-repair-token-with-space-1234 5678',
    'change-me-worker-repair-token-1234567890',
    'x'.repeat(4_097),
  ])('does not advertise remote repair for an invalid injected credential', (credential) => {
    configureRemoteWorker();

    const status = buildWorkerRepairActuatorStatus({
      resolveWorkerHelperToken: () => credential,
    });

    expect(status).toEqual(expect.objectContaining({
      mode: 'unavailable',
      available: false,
      baseUrl: null,
      path: null,
    }));
  });

  it('does not advertise remote repair when the credential collides with another purpose', () => {
    configureRemoteWorker();
    environment.set('ARCANOS_GPT_ACCESS_TOKEN', ` ${workerHelperTokenA} `);

    const status = buildWorkerRepairActuatorStatus({
      resolveWorkerHelperToken: () => workerHelperTokenA,
    });

    expect(status).toEqual(expect.objectContaining({
      mode: 'unavailable',
      available: false,
      baseUrl: null,
      path: null,
    }));
  });

  it('advertises a valid remote repair without exposing the credential in status', () => {
    configureRemoteWorker();

    const status = buildWorkerRepairActuatorStatus({
      resolveWorkerHelperToken: () => workerHelperTokenA,
    });

    expect(status).toEqual(expect.objectContaining({
      mode: 'remote_worker_helper',
      available: true,
      baseUrl: 'https://worker.example.test',
      path: '/worker-helper/heal',
    }));
    expect(JSON.stringify(status)).not.toContain(workerHelperTokenA);
  });

  it.each([
    {
      label: 'an exact HTTPS origin',
      baseUrl: 'https://worker.example.test',
      available: true,
      normalizedBaseUrl: 'https://worker.example.test',
    },
    {
      label: 'an explicit IPv4 loopback HTTP origin',
      baseUrl: 'http://127.0.0.1:3030',
      available: true,
      normalizedBaseUrl: 'http://127.0.0.1:3030',
    },
    {
      label: 'an explicit localhost HTTP origin',
      baseUrl: 'http://localhost:3030',
      available: true,
      normalizedBaseUrl: 'http://localhost:3030',
    },
    {
      label: 'a remote plaintext HTTP origin',
      baseUrl: 'http://worker.example.test',
      available: false,
      normalizedBaseUrl: null,
    },
    {
      label: 'a hostname with an implicit scheme',
      baseUrl: 'worker.example.test',
      available: false,
      normalizedBaseUrl: null,
    },
    {
      label: 'an HTTPS URL with a path',
      baseUrl: 'https://worker.example.test/internal',
      available: false,
      normalizedBaseUrl: null,
    },
    {
      label: 'an HTTPS URL with credentials',
      baseUrl: 'https://user:password@worker.example.test',
      available: false,
      normalizedBaseUrl: null,
    },
    {
      label: 'an HTTPS URL with a query string',
      baseUrl: 'https://worker.example.test?target=other',
      available: false,
      normalizedBaseUrl: null,
    },
  ])('requires $label', ({ baseUrl, available, normalizedBaseUrl }) => {
    configureRemoteWorker(baseUrl);

    const status = buildWorkerRepairActuatorStatus({
      resolveWorkerHelperToken: () => workerHelperTokenA,
    });

    expect(status.available).toBe(available);
    expect(status.mode).toBe(available ? 'remote_worker_helper' : 'unavailable');
    expect(status.baseUrl).toBe(normalizedBaseUrl);
  });

  it('fails closed when worker-helper URL aliases conflict', () => {
    environment.set('SELF_HEAL_WORKER_SERVICE_URL', 'https://worker-a.example.test');
    environment.set('WORKER_HELPER_BASE_URL', 'https://worker-b.example.test');

    const status = buildWorkerRepairActuatorStatus({
      resolveWorkerHelperToken: () => workerHelperTokenA,
    });

    expect(status).toEqual(expect.objectContaining({
      mode: 'unavailable',
      available: false,
      baseUrl: null,
      path: null,
    }));
  });

  it('does not resolve a remote credential while local repair is selected', () => {
    configureRemoteWorker();
    getConfigMock.mockReturnValue({
      runWorkers: true,
      workerApiTimeoutMs: 5_000,
    });
    const resolveWorkerHelperToken = jest.fn(() => workerHelperTokenA);

    const status = buildWorkerRepairActuatorStatus({
      resolveWorkerHelperToken,
    });

    expect(status.mode).toBe('local_in_process');
    expect(status.available).toBe(true);
    expect(resolveWorkerHelperToken).not.toHaveBeenCalled();
  });

  it('does not fetch when operator approval is absent', async () => {
    configureRemoteWorker();
    const resolveWorkerHelperToken = jest.fn(() => workerHelperTokenA);
    const fetchMock = fetchReturning(() => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const error = await captureError(executeWorkerRepairActuator({
      source: 'focused-test',
    }, {
      resolveWorkerHelperToken,
      fetchFn: fetchMock as unknown as typeof fetch,
    }));

    expect(error.message).toMatch(/requires explicit operator approval/i);
    expect(serializeError(error)).not.toContain(workerHelperTokenA);
    expect(resolveWorkerHelperToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fetch when no credential is available during status resolution', async () => {
    configureRemoteWorker();
    const resolveWorkerHelperToken = jest.fn((): string | null => null);
    const fetchMock = fetchReturning(() => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const error = await captureError(executeWorkerRepairActuator({
      source: 'focused-test',
      approval: validRemoteApproval(),
    }, {
      resolveWorkerHelperToken,
      fetchFn: fetchMock as unknown as typeof fetch,
    }));

    expect(error.message).toMatch(/configuration is incomplete/i);
    expect(resolveWorkerHelperToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fetch when the credential disappears before execution', async () => {
    configureRemoteWorker();
    const resolveWorkerHelperToken = jest.fn((): string | null => workerHelperTokenA);
    resolveWorkerHelperToken
      .mockReturnValueOnce(workerHelperTokenA)
      .mockReturnValueOnce(null);
    const fetchMock = fetchReturning(() => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const error = await captureError(executeWorkerRepairActuator({
      source: 'focused-test',
      approval: validRemoteApproval(),
    }, {
      resolveWorkerHelperToken,
      fetchFn: fetchMock as unknown as typeof fetch,
    }));

    expect(error.message).toMatch(/configuration is incomplete/i);
    expect(serializeError(error)).not.toContain(workerHelperTokenA);
    expect(resolveWorkerHelperToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-resolves a rotated credential, uses only the custom carrier, and drops remote-controlled result text', async () => {
    configureRemoteWorker();
    const untrustedRemoteMessage = 'REMOTE-UNTRUSTED-MESSAGE';
    const unrelatedSecret = 'unrelated-secret-that-must-not-propagate';
    const resolveWorkerHelperToken = jest.fn((): string | null => workerHelperTokenA);
    resolveWorkerHelperToken
      .mockReturnValueOnce(workerHelperTokenA)
      .mockReturnValueOnce(workerHelperTokenB);
    const reflectedCredentialKey = `debug-${workerHelperTokenB}`;
    const fetchMock = fetchReturning(() => new Response(JSON.stringify({
      timestamp: '2026-07-25T12:00:00.000Z',
      requestedForce: true,
      restart: {
        started: true,
        alreadyRunning: false,
        runWorkers: true,
        workerCount: 2,
        message: `${untrustedRemoteMessage} ${workerHelperTokenB} ${unrelatedSecret}`,
        untrustedDetail: 'REMOTE-UNTRUSTED-RESTART-DETAIL',
      },
      runtime: {
        enabled: true,
        configuredCount: 2,
        activeListeners: 2,
        lastError: `reflected ${workerHelperTokenB}`,
      },
      message: `outer message ${workerHelperTokenB}`,
      untrustedDetail: 'REMOTE-UNTRUSTED-TOP-LEVEL-DETAIL',
      [reflectedCredentialKey]: 'reflected credential key',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }));

    const result = await executeWorkerRepairActuator({
      force: true,
      source: 'focused-test',
      approval: validRemoteApproval(),
    }, {
      resolveWorkerHelperToken,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(resolveWorkerHelperToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestOptions] = fetchMock.mock.calls[0]!;
    const requestHeaders = new Headers(requestOptions?.headers);
    expect(String(requestUrl)).toBe('https://worker.example.test/worker-helper/heal');
    expect(requestOptions).toEqual(expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify({
        mode: 'execute',
        execute: true,
        force: true,
      }),
      signal: expect.any(AbortSignal),
    }));
    expect(requestHeaders.get(workerHelperTokenHeaderName)).toBe(workerHelperTokenB);
    expect(requestHeaders.get('authorization')).toBeNull();
    expect(requestHeaders.get('content-type')).toBe('application/json');
    expect(JSON.stringify(requestOptions?.headers)).not.toContain(workerHelperTokenA);

    expect(result).toEqual({
      mode: 'remote_worker_helper',
      baseUrl: 'https://worker.example.test',
      path: '/worker-helper/heal',
      statusCode: 200,
      message: 'Remote worker runtime restart started.',
      payload: {
        requestedForce: true,
        restart: {
          started: true,
          alreadyRunning: false,
          runWorkers: true,
          message: 'Remote worker runtime restart started.',
        },
      },
    });
    expect(result.payload).not.toHaveProperty('untrustedDetail');
    expect(result.payload.restart).not.toEqual(expect.objectContaining({
      untrustedDetail: expect.anything(),
    }));
    expect(JSON.stringify(result)).not.toContain(workerHelperTokenA);
    expect(JSON.stringify(result)).not.toContain(workerHelperTokenB);
    expect(JSON.stringify(result)).not.toContain(reflectedCredentialKey);
    expect(JSON.stringify(result)).not.toContain(untrustedRemoteMessage);
    expect(JSON.stringify(result)).not.toContain(unrelatedSecret);
  });

  it('keeps the actuator timeout active while reading the remote body', async () => {
    configureRemoteWorker();
    jest.useFakeTimers();
    const resolveWorkerHelperToken = jest.fn((): string | null => workerHelperTokenA);
    resolveWorkerHelperToken
      .mockReturnValueOnce(workerHelperTokenA)
      .mockReturnValueOnce(workerHelperTokenB);
    let observedSignal: AbortSignal | undefined;
    const fetchMock = jest.fn(async (
      _input: string | URL | Request,
      requestOptions?: RequestInit
    ): Promise<Response> => {
      observedSignal = requestOptions?.signal as AbortSignal;
      return new Response(new ReadableStream({
        start(controller) {
          observedSignal?.addEventListener('abort', () => {
            controller.error(new Error(`body reflected ${workerHelperTokenB}`));
          }, { once: true });
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const errorPromise = captureError(executeWorkerRepairActuator({
        source: 'focused-test',
        approval: validRemoteApproval(),
      }, {
        resolveWorkerHelperToken,
        fetchFn: fetchMock as unknown as typeof fetch,
      }));

      await jest.advanceTimersByTimeAsync(5_000);
      const error = await errorPromise;

      expect(observedSignal).toBeInstanceOf(AbortSignal);
      expect(observedSignal?.aborted).toBe(true);
      expect(error.message).toBe(
        'Worker repair actuator failed: Remote worker-helper response was invalid.'
      );
      expect(serializeError(error)).not.toContain(workerHelperTokenA);
      expect(serializeError(error)).not.toContain(workerHelperTokenB);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    {
      label: 'redirect',
      status: 302,
      expectedMessage: 'Remote worker repair redirect response was rejected.',
    },
    {
      label: 'non-success',
      status: 502,
      expectedMessage: 'Remote worker repair failed with HTTP 502.',
    },
  ])('cancels $label bodies without reading them', async ({
    status,
    expectedMessage,
  }) => {
    configureRemoteWorker();
    const resolveWorkerHelperToken = jest.fn((): string | null => workerHelperTokenA);
    resolveWorkerHelperToken
      .mockReturnValueOnce(workerHelperTokenA)
      .mockReturnValueOnce(workerHelperTokenB);
    const cancel = jest.fn(async () => undefined);
    const text = jest.fn(async () => `untrusted ${workerHelperTokenB}`);
    const response = {
      ok: false,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { cancel },
      text,
    } as unknown as Response;
    const fetchMock = jest.fn(async (): Promise<Response> => response);

    const error = await captureError(executeWorkerRepairActuator({
      source: 'focused-test',
      approval: validRemoteApproval(),
    }, {
      resolveWorkerHelperToken,
      fetchFn: fetchMock as unknown as typeof fetch,
    }));

    expect(error.message).toBe(`Worker repair actuator failed: ${expectedMessage}`);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
    expect(serializeError(error)).not.toContain(workerHelperTokenB);
  });

  it('cancels a streamed remote response once it exceeds 64 KiB', async () => {
    configureRemoteWorker();
    const resolveWorkerHelperToken = jest.fn((): string | null => workerHelperTokenA);
    resolveWorkerHelperToken
      .mockReturnValueOnce(workerHelperTokenA)
      .mockReturnValueOnce(workerHelperTokenB);
    const cancel = jest.fn();
    const oversizedStream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(40_000));
      },
      cancel,
    });
    const fetchMock = fetchReturning(() => new Response(oversizedStream, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const error = await captureError(executeWorkerRepairActuator({
      source: 'focused-test',
      approval: validRemoteApproval(),
    }, {
      resolveWorkerHelperToken,
      fetchFn: fetchMock as unknown as typeof fetch,
    }));

    expect(error.message).toBe(
      'Worker repair actuator failed: Remote worker-helper response was invalid.'
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-stream success response without invoking an unbounded text fallback', async () => {
    configureRemoteWorker();
    const resolveWorkerHelperToken = jest.fn((): string | null => workerHelperTokenA);
    resolveWorkerHelperToken
      .mockReturnValueOnce(workerHelperTokenA)
      .mockReturnValueOnce(workerHelperTokenB);
    const text = jest.fn(async () => JSON.stringify({
      reflected: workerHelperTokenB,
    }));
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text,
    } as unknown as Response;
    const fetchMock = jest.fn(async (): Promise<Response> => response);

    const error = await captureError(executeWorkerRepairActuator({
      source: 'focused-test',
      approval: validRemoteApproval(),
    }, {
      resolveWorkerHelperToken,
      fetchFn: fetchMock as unknown as typeof fetch,
    }));

    expect(error.message).toBe(
      'Worker repair actuator failed: Remote worker-helper response was invalid.'
    );
    expect(text).not.toHaveBeenCalled();
    expect(serializeError(error)).not.toContain(workerHelperTokenB);
  });

  it.each([
    {
      label: 'a non-success response',
      sensitiveMarker: 'REMOTE-NON-2XX-SENSITIVE-BODY',
      responseFactory: () => new Response(JSON.stringify({
        error: `REMOTE-NON-2XX-SENSITIVE-BODY ${workerHelperTokenB}`,
      }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    },
    {
      label: 'a non-JSON success response',
      sensitiveMarker: 'REMOTE-NON-JSON-SENSITIVE-BODY',
      responseFactory: () => new Response(
        `REMOTE-NON-JSON-SENSITIVE-BODY ${workerHelperTokenB}`,
        {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }
      ),
    },
    {
      label: 'an oversized success response',
      sensitiveMarker: 'REMOTE-OVERSIZED-SENSITIVE-BODY',
      responseFactory: () => {
        const body = JSON.stringify({
          message: `REMOTE-OVERSIZED-SENSITIVE-BODY ${workerHelperTokenB}`,
          padding: 'x'.repeat(1024 * 1024),
        });
        return new Response(body, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(body, 'utf8')),
          },
        });
      },
    },
  ])('returns a generic error for $label', async ({
    sensitiveMarker,
    responseFactory,
  }) => {
    configureRemoteWorker();
    const resolveWorkerHelperToken = jest.fn((): string | null => workerHelperTokenA);
    resolveWorkerHelperToken
      .mockReturnValueOnce(workerHelperTokenA)
      .mockReturnValueOnce(workerHelperTokenB);
    const fetchMock = fetchReturning(responseFactory);

    const error = await captureError(executeWorkerRepairActuator({
      source: 'focused-test',
      approval: validRemoteApproval(),
    }, {
      resolveWorkerHelperToken,
      fetchFn: fetchMock as unknown as typeof fetch,
    }));
    const serializedError = serializeError(error);

    expect(error.message).toMatch(/^Worker repair actuator failed:/u);
    expect(error.message.length).toBeLessThan(256);
    expect(serializedError).not.toContain(sensitiveMarker);
    expect(serializedError).not.toContain(workerHelperTokenA);
    expect(serializedError).not.toContain(workerHelperTokenB);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R1_COMPATIBILITY_VALIDATOR_SERVICE_ID,
  GATE_R1_ENVIRONMENT_ID,
  GATE_R1_MIGRATION_VALIDATOR_SERVICE_ID,
  GATE_R1_POSTGRES_SERVICE_ID,
  GATE_R1_PROJECT_TOKEN_MAX_CHARACTERS,
  GATE_R1_PROJECT_ID,
  GATE_R1_RAILWAY_GRAPHQL_ENDPOINT,
  GATE_R1_RAILWAY_PROJECT_TOKEN_ENV,
  GATE_R1_REDIS_SERVICE_ID,
  GATE_R1_REPLACEMENT_PROFILES,
  GATE_R1_REPLACEMENT_TCP_PROXY_QUERY,
  GATE_R1_TCP_PROXY_QUERY,
  GATE_R1_TCP_PROXY_RESPONSE_LIMIT_BYTES,
  GATE_R1_TCP_PROXY_TIMEOUT_MS,
  parseGateR1TcpProxyArgs,
  projectGateR1ReplacementTcpProxyCount,
  projectGateR1TcpProxyCount,
  runGateR1TcpProxyProjectorCli
} from '../scripts/gate-r1-tcp-proxy-projector.js';

const FIXTURE_TOKEN = 'fixture-project-access-value';
const PROXY_ID_A = '11111111-2222-4333-8444-555555555555';
const PROXY_ID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const REPLACEMENT_SERVICE_ID = '22222222-3333-4444-8555-666666666666';
const REPLACEMENT_SERVICE_INSTANCE_ID = '33333333-4444-4555-8666-777777777777';
const OBSERVED_AT = '2026-07-19T12:34:56.789Z';

function envWithToken(overrides = {}) {
  return {
    [GATE_R1_RAILWAY_PROJECT_TOKEN_ENV]: FIXTURE_TOKEN,
    ...overrides
  };
}

function graphqlPayload({
  projectId = GATE_R1_PROJECT_ID,
  environmentId = GATE_R1_ENVIRONMENT_ID,
  proxies = []
} = {}) {
  return {
    data: {
      projectToken: { projectId, environmentId },
      tcpProxies: proxies
    }
  };
}

function jsonResponse(payload, init = {}) {
  return new Response(
    typeof payload === 'string' ? payload : JSON.stringify(payload),
    {
      status: init.status ?? 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        ...(init.headers ?? {})
      }
    }
  );
}

function successFetch(payload = graphqlPayload()) {
  return jest.fn(async () => jsonResponse(payload));
}

function replacementGraphqlPayload({
  replacementProfile = 'postgres',
  serviceId = REPLACEMENT_SERVICE_ID,
  serviceInstanceId = REPLACEMENT_SERVICE_INSTANCE_ID,
  serviceInstanceDeletedAt = null,
  proxies = []
} = {}) {
  const serviceName = GATE_R1_REPLACEMENT_PROFILES[replacementProfile];
  return {
    data: {
      projectToken: {
        projectId: GATE_R1_PROJECT_ID,
        environmentId: GATE_R1_ENVIRONMENT_ID
      },
      service: {
        id: serviceId,
        name: serviceName,
        projectId: GATE_R1_PROJECT_ID
      },
      serviceInstance: {
        id: serviceInstanceId,
        serviceId,
        serviceName,
        environmentId: GATE_R1_ENVIRONMENT_ID,
        deletedAt: serviceInstanceDeletedAt
      },
      tcpProxies: proxies
    }
  };
}

describe('Gate R1 TCP-proxy projector', () => {
  it.each([GATE_R1_POSTGRES_SERVICE_ID, GATE_R1_REDIS_SERVICE_ID])(
    'projects an exact zero count for approved service %s',
    async (serviceId) => {
      const fetchImpl = successFetch();

      const result = await projectGateR1TcpProxyCount({
        serviceId,
        env: envWithToken(),
        fetchImpl,
        clock: () => OBSERVED_AT
      });

      expect(result).toEqual({
        projectId: GATE_R1_PROJECT_ID,
        environmentId: GATE_R1_ENVIRONMENT_ID,
        serviceId,
        observedAt: OBSERVED_AT,
        tcpProxyCount: 0
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  );

  it('uses only the fixed endpoint, project-token header, query, variables, and safe fetch controls', async () => {
    expect(GATE_R1_RAILWAY_GRAPHQL_ENDPOINT).toBe('https://backboard.railway.com/graphql/v2');
    const fetchImpl = successFetch();

    await projectGateR1TcpProxyCount({
      serviceId: GATE_R1_POSTGRES_SERVICE_ID,
      env: envWithToken({
        RAILWAY_API_TOKEN: 'ignored-broad-account-value',
        RAILWAY_TOKEN: 'ignored-cli-value',
        RAILWAY_GRAPHQL_ENDPOINT: 'https://unapproved.invalid/graphql'
      }),
      fetchImpl,
      clock: () => OBSERVED_AT
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchImpl.mock.calls[0];
    expect(endpoint).toBe(GATE_R1_RAILWAY_GRAPHQL_ENDPOINT);
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      cache: 'no-store'
    });
    expect(init.headers).toEqual({
      Accept: 'application/json',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      Pragma: 'no-cache',
      'Project-Access-Token': FIXTURE_TOKEN
    });
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(init.body);
    expect(body).toEqual({
      query: GATE_R1_TCP_PROXY_QUERY,
      variables: {
        environmentId: GATE_R1_ENVIRONMENT_ID,
        serviceId: GATE_R1_POSTGRES_SERVICE_ID
      }
    });
    expect(body.query).toContain('query GateR1TcpProxyCount');
    expect(body.query).toContain('projectToken');
    expect(body.query).toContain('tcpProxies');
    expect(body.query).not.toMatch(/\bmutation\b|__schema|__type|environmentVariables|serviceDomains/i);
    expect(init.body).not.toContain(FIXTURE_TOKEN);
  });

  it('derives the count without emitting proxy identities or credential material', async () => {
    const fetchImpl = successFetch(graphqlPayload({
      proxies: [{ id: PROXY_ID_A }, { id: PROXY_ID_B }]
    }));

    const result = await projectGateR1TcpProxyCount({
      serviceId: GATE_R1_REDIS_SERVICE_ID,
      env: envWithToken(),
      fetchImpl,
      clock: () => OBSERVED_AT
    });
    const serialized = JSON.stringify(result);

    expect(result.tcpProxyCount).toBe(2);
    expect(Object.keys(result)).toEqual([
      'projectId',
      'environmentId',
      'serviceId',
      'observedAt',
      'tcpProxyCount'
    ]);
    expect(serialized).not.toContain(PROXY_ID_A);
    expect(serialized).not.toContain(PROXY_ID_B);
    expect(serialized).not.toContain(FIXTURE_TOKEN);
  });

  it('accepts exactly one approved service selector and rejects every other CLI shape', () => {
    expect(parseGateR1TcpProxyArgs(['--service-id', GATE_R1_POSTGRES_SERVICE_ID])).toEqual({
      serviceId: GATE_R1_POSTGRES_SERVICE_ID
    });
    expect(parseGateR1TcpProxyArgs(['--service-id', GATE_R1_REDIS_SERVICE_ID])).toEqual({
      serviceId: GATE_R1_REDIS_SERVICE_ID
    });

    for (const argv of [
      [],
      ['--service-id'],
      ['--service', GATE_R1_POSTGRES_SERVICE_ID],
      ['--service-id', GATE_R1_POSTGRES_SERVICE_ID, '--extra'],
      ['--project-id', GATE_R1_PROJECT_ID],
      ['--environment-id', GATE_R1_ENVIRONMENT_ID]
    ]) {
      expect(() => parseGateR1TcpProxyArgs(argv)).toThrow(
        'GATE_R1_TCP_PROXY_PROJECTOR_ARGUMENT_INVALID'
      );
    }
    expect(() => parseGateR1TcpProxyArgs([
      '--service-id',
      '00000000-0000-4000-8000-000000000000'
    ])).toThrow('GATE_R1_TCP_PROXY_PROJECTOR_TARGET_FORBIDDEN');
  });

  it('rejects missing, blank, padded, control-character, Unicode, and oversized tokens before network access', async () => {
    const fetchImpl = successFetch();

    for (const env of [
      {},
      { RAILWAY_TOKEN: FIXTURE_TOKEN },
      { RAILWAY_API_TOKEN: FIXTURE_TOKEN },
      { [GATE_R1_RAILWAY_PROJECT_TOKEN_ENV]: '' },
      { [GATE_R1_RAILWAY_PROJECT_TOKEN_ENV]: '   ' }
    ]) {
      await expect(projectGateR1TcpProxyCount({
        serviceId: GATE_R1_POSTGRES_SERVICE_ID,
        env,
        fetchImpl
      })).rejects.toThrow('GATE_R1_TCP_PROXY_PROJECTOR_TOKEN_MISSING');
    }

    for (const token of [
      ` ${FIXTURE_TOKEN}`,
      `${FIXTURE_TOKEN} `,
      `${FIXTURE_TOKEN}\n`,
      `${FIXTURE_TOKEN}\u00e9`,
      'x'.repeat(GATE_R1_PROJECT_TOKEN_MAX_CHARACTERS + 1)
    ]) {
      await expect(projectGateR1TcpProxyCount({
        serviceId: GATE_R1_POSTGRES_SERVICE_ID,
        env: { [GATE_R1_RAILWAY_PROJECT_TOKEN_ENV]: token },
        fetchImpl
      })).rejects.toThrow('GATE_R1_TCP_PROXY_PROJECTOR_TOKEN_INVALID');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an unapproved service before reading the token or making a request', async () => {
    const fetchImpl = successFetch();
    const env = new Proxy({}, {
      get() {
        throw new Error('environment must not be read');
      }
    });

    await expect(projectGateR1TcpProxyCount({
      serviceId: '00000000-0000-4000-8000-000000000000',
      env,
      fetchImpl
    })).rejects.toThrow('GATE_R1_TCP_PROXY_PROJECTOR_TARGET_FORBIDDEN');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps a throwing token source to a fixed error without making a request', async () => {
    const fetchImpl = successFetch();
    const env = new Proxy({}, {
      get() {
        throw new Error('credential-source-sentinel');
      }
    });

    let observed;
    try {
      await projectGateR1TcpProxyCount({
        serviceId: GATE_R1_POSTGRES_SERVICE_ID,
        env,
        fetchImpl
      });
    } catch (error) {
      observed = error;
    }

    expect(observed.message).toBe('GATE_R1_TCP_PROXY_PROJECTOR_TOKEN_INVALID');
    expect(observed.message).not.toContain('credential-source-sentinel');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('verifies the project-token project and environment scope exactly', async () => {
    for (const payload of [
      graphqlPayload({ projectId: '00000000-0000-4000-8000-000000000000' }),
      graphqlPayload({ environmentId: '00000000-0000-4000-8000-000000000000' })
    ]) {
      await expect(projectGateR1TcpProxyCount({
        serviceId: GATE_R1_POSTGRES_SERVICE_ID,
        env: envWithToken(),
        fetchImpl: successFetch(payload)
      })).rejects.toThrow('GATE_R1_TCP_PROXY_PROJECTOR_SCOPE_MISMATCH');
    }
  });

  it.each([
    ['top-level extra field', { ...graphqlPayload(), extensions: {} }],
    ['GraphQL errors', { ...graphqlPayload(), errors: [] }],
    ['missing data', {}],
    ['data extra field', { data: { ...graphqlPayload().data, service: {} } }],
    ['null token scope', { data: { projectToken: null, tcpProxies: [] } }],
    ['token-scope extra field', {
      data: {
        projectToken: {
          projectId: GATE_R1_PROJECT_ID,
          environmentId: GATE_R1_ENVIRONMENT_ID,
          name: 'unexpected'
        },
        tcpProxies: []
      }
    }],
    ['malformed project scope', {
      data: {
        projectToken: { projectId: 7, environmentId: GATE_R1_ENVIRONMENT_ID },
        tcpProxies: []
      }
    }],
    ['malformed environment scope', {
      data: {
        projectToken: { projectId: GATE_R1_PROJECT_ID, environmentId: 'not-a-uuid' },
        tcpProxies: []
      }
    }],
    ['non-array proxies', { data: { ...graphqlPayload().data, tcpProxies: {} } }],
    ['proxy extra field', graphqlPayload({ proxies: [{ id: PROXY_ID_A, port: 1234 }] })],
    ['proxy missing id', graphqlPayload({ proxies: [{}] })],
    ['proxy malformed id', graphqlPayload({ proxies: [{ id: 'not-a-uuid' }] })],
    ['duplicate proxy id', graphqlPayload({ proxies: [{ id: PROXY_ID_A }, { id: PROXY_ID_A }] })]
  ])('rejects schema drift: %s', async (_name, payload) => {
    await expect(projectGateR1TcpProxyCount({
      serviceId: GATE_R1_POSTGRES_SERVICE_ID,
      env: envWithToken(),
      fetchImpl: successFetch(payload)
    })).rejects.toThrow('GATE_R1_TCP_PROXY_PROJECTOR_RESPONSE_INVALID');
  });

  it.each([
    ['non-200 response', () => jsonResponse(graphqlPayload(), { status: 403 })],
    ['direct redirect response', () => jsonResponse(graphqlPayload(), {
      status: 302,
      headers: { location: 'https://redirect.invalid/' }
    })],
    ['wrong content type', () => jsonResponse(graphqlPayload(), { headers: { 'content-type': 'text/plain' } })],
    ['malformed JSON', () => jsonResponse('{')],
    ['missing body', () => new Response(null, { status: 200, headers: { 'content-type': 'application/json' } })],
    ['oversized declared body', () => jsonResponse(graphqlPayload(), {
      headers: { 'content-length': String(GATE_R1_TCP_PROXY_RESPONSE_LIMIT_BYTES + 1) }
    })],
    ['invalid declared length', () => jsonResponse(graphqlPayload(), {
      headers: { 'content-length': 'not-a-number' }
    })],
    ['oversized streamed body', () => jsonResponse('x'.repeat(GATE_R1_TCP_PROXY_RESPONSE_LIMIT_BYTES + 1))],
    ['invalid UTF-8', () => new Response(new Uint8Array([0xff]), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })],
    ['stream failure', () => new Response(new ReadableStream({
      pull(controller) {
        controller.error(new Error('stream-credential-sentinel'));
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })]
  ])('maps invalid transport data to a fixed response error: %s', async (_name, createResponse) => {
    await expect(projectGateR1TcpProxyCount({
      serviceId: GATE_R1_POSTGRES_SERVICE_ID,
      env: envWithToken(),
      fetchImpl: jest.fn(async () => createResponse())
    })).rejects.toThrow('GATE_R1_TCP_PROXY_PROJECTOR_RESPONSE_INVALID');
  });

  it('maps network diagnostics to one fixed error and does not retry', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('credential-sentinel provider-response filesystem-path SQL-detail');
    });

    let observed;
    try {
      await projectGateR1TcpProxyCount({
        serviceId: GATE_R1_POSTGRES_SERVICE_ID,
        env: envWithToken(),
        fetchImpl
      });
    } catch (error) {
      observed = error;
    }

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(observed).toBeInstanceOf(Error);
    expect(observed.message).toBe('GATE_R1_TCP_PROXY_PROJECTOR_REQUEST_FAILED');
    expect(observed.message).not.toMatch(/credential-sentinel|provider-response|filesystem-path|SQL-detail/);
  });

  it('maps a non-Error network throw to the same fixed error without retry', async () => {
    const fetchImpl = jest.fn(async () => {
      throw 'non-error-credential-sentinel';
    });

    let observed;
    try {
      await projectGateR1TcpProxyCount({
        serviceId: GATE_R1_POSTGRES_SERVICE_ID,
        env: envWithToken(),
        fetchImpl
      });
    } catch (error) {
      observed = error;
    }

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(observed.message).toBe('GATE_R1_TCP_PROXY_PROJECTOR_REQUEST_FAILED');
    expect(observed.message).not.toContain('non-error-credential-sentinel');
  });

  it('maps response accessor diagnostics to one fixed error', async () => {
    const fetchImpl = jest.fn(async () => ({
      status: 200,
      headers: {
        get() {
          throw new Error('response-accessor-credential-sentinel');
        }
      }
    }));

    let observed;
    try {
      await projectGateR1TcpProxyCount({
        serviceId: GATE_R1_POSTGRES_SERVICE_ID,
        env: envWithToken(),
        fetchImpl
      });
    } catch (error) {
      observed = error;
    }

    expect(observed.message).toBe('GATE_R1_TCP_PROXY_PROJECTOR_RESPONSE_INVALID');
    expect(observed.message).not.toContain('response-accessor-credential-sentinel');
  });

  it('aborts at the fixed timeout, clears the timer, and emits no raw diagnostics', async () => {
    let timeoutCallback;
    const timeoutHandle = { unref: jest.fn() };
    const setTimeoutImpl = jest.fn((callback, timeoutMs) => {
      timeoutCallback = callback;
      expect(timeoutMs).toBe(GATE_R1_TCP_PROXY_TIMEOUT_MS);
      return timeoutHandle;
    });
    const clearTimeoutImpl = jest.fn();
    const fetchImpl = jest.fn((_endpoint, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(new Error('timeout credential-sentinel'));
      }, { once: true });
      timeoutCallback();
    }));

    await expect(projectGateR1TcpProxyCount({
      serviceId: GATE_R1_POSTGRES_SERVICE_ID,
      env: envWithToken(),
      fetchImpl,
      setTimeoutImpl,
      clearTimeoutImpl
    })).rejects.toThrow('GATE_R1_TCP_PROXY_PROJECTOR_TIMEOUT');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(timeoutHandle.unref).toHaveBeenCalledTimes(1);
    expect(clearTimeoutImpl).toHaveBeenCalledWith(timeoutHandle);
  });

  it('keeps the timeout active through body streaming and cancels a stalled reader', async () => {
    let timeoutCallback;
    let cancelled = false;
    const timeoutHandle = { unref: jest.fn() };
    const setTimeoutImpl = jest.fn((callback, timeoutMs) => {
      timeoutCallback = callback;
      expect(timeoutMs).toBe(GATE_R1_TCP_PROXY_TIMEOUT_MS);
      return timeoutHandle;
    });
    const clearTimeoutImpl = jest.fn();
    const reader = {
      read: jest.fn(() => {
        timeoutCallback();
        return new Promise(() => {});
      }),
      cancel: jest.fn(async () => {
        cancelled = true;
      }),
      releaseLock: jest.fn()
    };
    const fetchImpl = jest.fn(async () => ({
      status: 200,
      headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
      body: { getReader: () => reader }
    }));

    await expect(projectGateR1TcpProxyCount({
      serviceId: GATE_R1_POSTGRES_SERVICE_ID,
      env: envWithToken(),
      fetchImpl,
      setTimeoutImpl,
      clearTimeoutImpl
    })).rejects.toThrow('GATE_R1_TCP_PROXY_PROJECTOR_TIMEOUT');

    expect(cancelled).toBe(true);
    expect(reader.cancel).toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(clearTimeoutImpl).toHaveBeenCalledWith(timeoutHandle);
  });

  it.each([
    ['never-settling cancellation', () => new Promise(() => {})],
    ['synchronously throwing cancellation', () => {
      throw new Error('cancel-credential-sentinel');
    }]
  ])('does not let %s block or disclose an aborted projection', async (_name, cancelImpl) => {
    let timeoutCallback;
    const timeoutHandle = { unref: jest.fn() };
    const setTimeoutImpl = jest.fn((callback) => {
      timeoutCallback = callback;
      return timeoutHandle;
    });
    const clearTimeoutImpl = jest.fn();
    const reader = {
      read: jest.fn(() => {
        timeoutCallback();
        return new Promise(() => {});
      }),
      cancel: jest.fn(cancelImpl),
      releaseLock: jest.fn()
    };
    const fetchImpl = jest.fn(async () => ({
      status: 200,
      headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
      body: { getReader: () => reader }
    }));

    let observed;
    try {
      await projectGateR1TcpProxyCount({
        serviceId: GATE_R1_POSTGRES_SERVICE_ID,
        env: envWithToken(),
        fetchImpl,
        setTimeoutImpl,
        clearTimeoutImpl
      });
    } catch (error) {
      observed = error;
    }

    expect(observed.message).toBe('GATE_R1_TCP_PROXY_PROJECTOR_TIMEOUT');
    expect(observed.message).not.toContain('cancel-credential-sentinel');
    expect(reader.cancel).toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(clearTimeoutImpl).toHaveBeenCalledWith(timeoutHandle);
  });

  it('does not await a never-settling cancellation after an oversized body', async () => {
    const reader = {
      read: jest.fn(async () => ({
        done: false,
        value: new Uint8Array(GATE_R1_TCP_PROXY_RESPONSE_LIMIT_BYTES + 1)
      })),
      cancel: jest.fn(() => new Promise(() => {})),
      releaseLock: jest.fn()
    };
    const fetchImpl = jest.fn(async () => ({
      status: 200,
      headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
      body: { getReader: () => reader }
    }));

    await expect(projectGateR1TcpProxyCount({
      serviceId: GATE_R1_POSTGRES_SERVICE_ID,
      env: envWithToken(),
      fetchImpl
    })).rejects.toThrow('GATE_R1_TCP_PROXY_PROJECTOR_RESPONSE_INVALID');

    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('keeps the timeout active through projection and observed-time validation', async () => {
    let timeoutCallback;
    const timeoutHandle = { unref: jest.fn() };
    const setTimeoutImpl = jest.fn((callback) => {
      timeoutCallback = callback;
      return timeoutHandle;
    });
    const clearTimeoutImpl = jest.fn();

    await expect(projectGateR1TcpProxyCount({
      serviceId: GATE_R1_POSTGRES_SERVICE_ID,
      env: envWithToken(),
      fetchImpl: successFetch(),
      setTimeoutImpl,
      clearTimeoutImpl,
      clock: () => {
        timeoutCallback();
        return OBSERVED_AT;
      }
    })).rejects.toThrow('GATE_R1_TCP_PROXY_PROJECTOR_TIMEOUT');

    expect(clearTimeoutImpl).toHaveBeenCalledWith(timeoutHandle);
  });

  it('clears the timeout after a successful request', async () => {
    const timeoutHandle = { unref: jest.fn() };
    const setTimeoutImpl = jest.fn(() => timeoutHandle);
    const clearTimeoutImpl = jest.fn();

    await projectGateR1TcpProxyCount({
      serviceId: GATE_R1_POSTGRES_SERVICE_ID,
      env: envWithToken(),
      fetchImpl: successFetch(),
      setTimeoutImpl,
      clearTimeoutImpl
    });

    expect(timeoutHandle.unref).toHaveBeenCalledTimes(1);
    expect(clearTimeoutImpl).toHaveBeenCalledWith(timeoutHandle);
  });

  it('does not expose a timer-cleanup diagnostic after a successful projection', async () => {
    const result = await projectGateR1TcpProxyCount({
      serviceId: GATE_R1_POSTGRES_SERVICE_ID,
      env: envWithToken(),
      fetchImpl: successFetch(),
      clearTimeoutImpl: () => {
        throw new Error('timer-cleanup-credential-sentinel');
      }
    });

    expect(result.tcpProxyCount).toBe(0);
    expect(JSON.stringify(result)).not.toContain('timer-cleanup-credential-sentinel');
  });

  it.each([
    ['non-string clock', () => new Date(OBSERVED_AT)],
    ['non-RFC3339 clock', () => '2026-07-19 12:34:56'],
    ['nonexistent date', () => '2026-02-31T12:34:56.789Z']
  ])('rejects an invalid injected clock: %s', async (_name, clock) => {
    await expect(projectGateR1TcpProxyCount({
      serviceId: GATE_R1_POSTGRES_SERVICE_ID,
      env: envWithToken(),
      fetchImpl: successFetch(),
      clock
    })).rejects.toThrow('GATE_R1_TCP_PROXY_PROJECTOR_CLOCK_INVALID');
  });

  it('sanitizes a throwing injected clock', async () => {
    let observed;
    try {
      await projectGateR1TcpProxyCount({
        serviceId: GATE_R1_POSTGRES_SERVICE_ID,
        env: envWithToken(),
        fetchImpl: successFetch(),
        clock: () => {
          throw new Error('clock-credential-sentinel');
        }
      });
    } catch (error) {
      observed = error;
    }
    expect(observed.message).toBe('GATE_R1_TCP_PROXY_PROJECTOR_CLOCK_INVALID');
    expect(observed.message).not.toContain('clock-credential-sentinel');
  });

  it('writes exactly the safe JSON contract through the injected CLI boundary', async () => {
    const stdout = { write: jest.fn() };
    const stderr = { write: jest.fn() };

    const exitCode = await runGateR1TcpProxyProjectorCli({
      argv: ['--service-id', GATE_R1_POSTGRES_SERVICE_ID],
      stdout,
      stderr,
      env: envWithToken(),
      fetchImpl: successFetch(),
      clock: () => OBSERVED_AT
    });

    expect(exitCode).toBe(0);
    expect(stderr.write).not.toHaveBeenCalled();
    expect(stdout.write).toHaveBeenCalledTimes(1);
    const line = stdout.write.mock.calls[0][0];
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      projectId: GATE_R1_PROJECT_ID,
      environmentId: GATE_R1_ENVIRONMENT_ID,
      serviceId: GATE_R1_POSTGRES_SERVICE_ID,
      observedAt: OBSERVED_AT,
      tcpProxyCount: 0
    });
    expect(line).not.toContain(FIXTURE_TOKEN);
  });

  it('writes only a fixed safe code through the injected CLI error boundary', async () => {
    const stdout = { write: jest.fn() };
    const stderr = { write: jest.fn() };
    const fetchImpl = jest.fn(async () => {
      throw new Error('cli-credential-sentinel');
    });

    const exitCode = await runGateR1TcpProxyProjectorCli({
      argv: ['--service-id', GATE_R1_POSTGRES_SERVICE_ID],
      stdout,
      stderr,
      env: envWithToken(),
      fetchImpl
    });

    expect(exitCode).toBe(1);
    expect(stdout.write).not.toHaveBeenCalled();
    expect(stderr.write).toHaveBeenCalledWith('GATE_R1_TCP_PROXY_PROJECTOR_REQUEST_FAILED\n');
    expect(stderr.write.mock.calls[0][0]).not.toContain('cli-credential-sentinel');
  });

  it('keeps concurrent projections independent and stateless', async () => {
    const postgresFetch = successFetch(graphqlPayload());
    const redisFetch = successFetch(graphqlPayload({ proxies: [{ id: PROXY_ID_A }] }));

    const [postgresResult, redisResult] = await Promise.all([
      projectGateR1TcpProxyCount({
        serviceId: GATE_R1_POSTGRES_SERVICE_ID,
        env: envWithToken(),
        fetchImpl: postgresFetch
      }),
      projectGateR1TcpProxyCount({
        serviceId: GATE_R1_REDIS_SERVICE_ID,
        env: envWithToken(),
        fetchImpl: redisFetch
      })
    ]);

    expect(postgresResult).toMatchObject({
      serviceId: GATE_R1_POSTGRES_SERVICE_ID,
      tcpProxyCount: 0
    });
    expect(redisResult).toMatchObject({
      serviceId: GATE_R1_REDIS_SERVICE_ID,
      tcpProxyCount: 1
    });
    expect(postgresFetch).toHaveBeenCalledTimes(1);
    expect(redisFetch).toHaveBeenCalledTimes(1);
  });
});

describe('Gate R1 replacement-service TCP-proxy projector', () => {
  it.each([
    ['postgres', 'phase2e-postgres-r2-20260718'],
    ['redis', 'phase2e-redis-r2-20260718']
  ])('binds the dynamic %s replacement to its derived exact service identity', async (
    replacementProfile,
    serviceName
  ) => {
    const fetchImpl = successFetch(replacementGraphqlPayload({ replacementProfile }));

    const result = await projectGateR1ReplacementTcpProxyCount({
      replacementProfile,
      serviceId: REPLACEMENT_SERVICE_ID,
      serviceInstanceId: REPLACEMENT_SERVICE_INSTANCE_ID,
      env: envWithToken(),
      fetchImpl,
      clock: () => OBSERVED_AT
    });

    expect(result).toEqual({
      projectId: GATE_R1_PROJECT_ID,
      environmentId: GATE_R1_ENVIRONMENT_ID,
      replacementProfile,
      serviceId: REPLACEMENT_SERVICE_ID,
      serviceName,
      serviceInstanceId: REPLACEMENT_SERVICE_INSTANCE_ID,
      observedAt: OBSERVED_AT,
      tcpProxyCount: 0
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses only the schema-locked replacement query and exact target variables', async () => {
    const fetchImpl = successFetch(replacementGraphqlPayload());

    await projectGateR1ReplacementTcpProxyCount({
      replacementProfile: 'postgres',
      serviceId: REPLACEMENT_SERVICE_ID,
      serviceInstanceId: REPLACEMENT_SERVICE_INSTANCE_ID,
      env: envWithToken({
        RAILWAY_API_TOKEN: 'ignored-broad-account-value',
        RAILWAY_TOKEN: 'ignored-cli-value'
      }),
      fetchImpl,
      clock: () => OBSERVED_AT
    });

    const [endpoint, init] = fetchImpl.mock.calls[0];
    expect(endpoint).toBe(GATE_R1_RAILWAY_GRAPHQL_ENDPOINT);
    expect(init.headers['Project-Access-Token']).toBe(FIXTURE_TOKEN);
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(init.body)).toEqual({
      query: GATE_R1_REPLACEMENT_TCP_PROXY_QUERY,
      variables: {
        environmentId: GATE_R1_ENVIRONMENT_ID,
        serviceId: REPLACEMENT_SERVICE_ID
      }
    });
    expect(init.body).not.toContain(FIXTURE_TOKEN);
    expect(GATE_R1_REPLACEMENT_TCP_PROXY_QUERY).toContain('query GateR1ReplacementTcpProxyCount');
    expect(GATE_R1_REPLACEMENT_TCP_PROXY_QUERY).toContain('serviceInstance');
    expect(GATE_R1_REPLACEMENT_TCP_PROXY_QUERY).toContain('tcpProxies');
    expect(GATE_R1_REPLACEMENT_TCP_PROXY_QUERY).not.toMatch(
      /\bmutation\b|__schema|__type|variables\s*\(|environmentVariables|environmentConfig|serviceDomains|customDomains|\bhost\b|\bport\b|\bvalue\b/i
    );
  });

  it('counts only current exact-target proxies without emitting proxy identities', async () => {
    const payload = replacementGraphqlPayload({
      replacementProfile: 'redis',
      proxies: [
        {
          id: PROXY_ID_A,
          serviceId: REPLACEMENT_SERVICE_ID,
          environmentId: GATE_R1_ENVIRONMENT_ID,
          deletedAt: null
        },
        {
          id: PROXY_ID_B,
          serviceId: REPLACEMENT_SERVICE_ID,
          environmentId: GATE_R1_ENVIRONMENT_ID,
          deletedAt: '2026-07-19T11:00:00.000Z'
        }
      ]
    });

    const result = await projectGateR1ReplacementTcpProxyCount({
      replacementProfile: 'redis',
      serviceId: REPLACEMENT_SERVICE_ID,
      serviceInstanceId: REPLACEMENT_SERVICE_INSTANCE_ID,
      env: envWithToken(),
      fetchImpl: successFetch(payload),
      clock: () => OBSERVED_AT
    });
    const serialized = JSON.stringify(result);

    expect(result.tcpProxyCount).toBe(1);
    expect(serialized).not.toContain(PROXY_ID_A);
    expect(serialized).not.toContain(PROXY_ID_B);
    expect(serialized).not.toContain(FIXTURE_TOKEN);
  });

  it.each([
    ['project', { projectId: '99999999-aaaa-4bbb-8ccc-dddddddddddd' }],
    ['environment', { environmentId: '99999999-aaaa-4bbb-8ccc-dddddddddddd' }]
  ])('rejects replacement-mode project-token %s scope mismatch', async (_name, scope) => {
    const payload = replacementGraphqlPayload();
    Object.assign(payload.data.projectToken, scope);

    await expect(projectGateR1ReplacementTcpProxyCount({
      replacementProfile: 'postgres',
      serviceId: REPLACEMENT_SERVICE_ID,
      serviceInstanceId: REPLACEMENT_SERVICE_INSTANCE_ID,
      env: envWithToken(),
      fetchImpl: successFetch(payload)
    })).rejects.toThrow('GATE_R1_TCP_PROXY_PROJECTOR_SCOPE_MISMATCH');
  });

  it.each([
    ['extra field', (value) => { value.data.projectToken.extra = true; }],
    ['malformed project ID', (value) => { value.data.projectToken.projectId = 'not-a-uuid'; }],
    ['null scope', (value) => { value.data.projectToken = null; }]
  ])('rejects replacement-mode project-token schema drift: %s', async (_name, mutate) => {
    const payload = replacementGraphqlPayload();
    mutate(payload);

    await expect(projectGateR1ReplacementTcpProxyCount({
      replacementProfile: 'postgres',
      serviceId: REPLACEMENT_SERVICE_ID,
      serviceInstanceId: REPLACEMENT_SERVICE_INSTANCE_ID,
      env: envWithToken(),
      fetchImpl: successFetch(payload)
    })).rejects.toThrow('GATE_R1_TCP_PROXY_PROJECTOR_RESPONSE_INVALID');
  });

  it('parses only the exact replacement CLI shape and preserves the legacy shape', () => {
    expect(parseGateR1TcpProxyArgs([
      '--replacement-profile',
      'postgres',
      '--service-id',
      REPLACEMENT_SERVICE_ID,
      '--service-instance-id',
      REPLACEMENT_SERVICE_INSTANCE_ID
    ])).toEqual({
      mode: 'replacement',
      replacementProfile: 'postgres',
      serviceId: REPLACEMENT_SERVICE_ID,
      serviceInstanceId: REPLACEMENT_SERVICE_INSTANCE_ID
    });
    expect(parseGateR1TcpProxyArgs(['--service-id', GATE_R1_POSTGRES_SERVICE_ID])).toEqual({
      serviceId: GATE_R1_POSTGRES_SERVICE_ID
    });

    for (const argv of [
      ['--replacement-profile', 'postgres', '--service-id', REPLACEMENT_SERVICE_ID],
      ['--replacement-profile', 'postgres', '--service-instance-id', REPLACEMENT_SERVICE_INSTANCE_ID],
      ['--service-id', REPLACEMENT_SERVICE_ID, '--replacement-profile', 'postgres', '--service-instance-id', REPLACEMENT_SERVICE_INSTANCE_ID],
      ['--replacement-profile', 'postgres', '--service-id', REPLACEMENT_SERVICE_ID, '--service-instance-id', REPLACEMENT_SERVICE_INSTANCE_ID, '--extra']
    ]) {
      expect(() => parseGateR1TcpProxyArgs(argv)).toThrow(
        'GATE_R1_TCP_PROXY_PROJECTOR_ARGUMENT_INVALID'
      );
    }
    for (const replacementProfile of ['POSTGRES', ' postgres', 'unknown']) {
      expect(() => parseGateR1TcpProxyArgs([
        '--replacement-profile',
        replacementProfile,
        '--service-id',
        REPLACEMENT_SERVICE_ID,
        '--service-instance-id',
        REPLACEMENT_SERVICE_INSTANCE_ID
      ])).toThrow('GATE_R1_TCP_PROXY_PROJECTOR_TARGET_FORBIDDEN');
    }
  });

  it('rejects reserved, malformed, and self-bound replacement identities before token access', async () => {
    const env = new Proxy({}, {
      get() {
        throw new Error('token-source-must-not-be-read');
      }
    });
    const fetchImpl = successFetch(replacementGraphqlPayload());
    const cases = [
      { replacementProfile: 'unknown', serviceId: REPLACEMENT_SERVICE_ID, serviceInstanceId: REPLACEMENT_SERVICE_INSTANCE_ID },
      { replacementProfile: 'postgres', serviceId: 'not-a-uuid', serviceInstanceId: REPLACEMENT_SERVICE_INSTANCE_ID },
      { replacementProfile: 'postgres', serviceId: GATE_R1_POSTGRES_SERVICE_ID, serviceInstanceId: REPLACEMENT_SERVICE_INSTANCE_ID },
      { replacementProfile: 'postgres', serviceId: GATE_R1_REDIS_SERVICE_ID, serviceInstanceId: REPLACEMENT_SERVICE_INSTANCE_ID },
      { replacementProfile: 'postgres', serviceId: GATE_R1_MIGRATION_VALIDATOR_SERVICE_ID, serviceInstanceId: REPLACEMENT_SERVICE_INSTANCE_ID },
      { replacementProfile: 'postgres', serviceId: GATE_R1_COMPATIBILITY_VALIDATOR_SERVICE_ID, serviceInstanceId: REPLACEMENT_SERVICE_INSTANCE_ID },
      { replacementProfile: 'postgres', serviceId: GATE_R1_PROJECT_ID, serviceInstanceId: REPLACEMENT_SERVICE_INSTANCE_ID },
      { replacementProfile: 'postgres', serviceId: GATE_R1_ENVIRONMENT_ID, serviceInstanceId: REPLACEMENT_SERVICE_INSTANCE_ID },
      { replacementProfile: 'postgres', serviceId: REPLACEMENT_SERVICE_ID, serviceInstanceId: 'not-a-uuid' },
      { replacementProfile: 'postgres', serviceId: REPLACEMENT_SERVICE_ID, serviceInstanceId: GATE_R1_PROJECT_ID },
      { replacementProfile: 'postgres', serviceId: REPLACEMENT_SERVICE_ID, serviceInstanceId: GATE_R1_ENVIRONMENT_ID },
      { replacementProfile: 'postgres', serviceId: REPLACEMENT_SERVICE_ID, serviceInstanceId: REPLACEMENT_SERVICE_ID }
    ];

    for (const value of cases) {
      await expect(projectGateR1ReplacementTcpProxyCount({
        ...value,
        env,
        fetchImpl
      })).rejects.toThrow('GATE_R1_TCP_PROXY_PROJECTOR_TARGET_FORBIDDEN');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a replacement profile inherited through Object.prototype before token access', async () => {
    const inheritedProfile = 'gateR1PollutedReplacementProfile';
    Object.defineProperty(Object.prototype, inheritedProfile, {
      configurable: true,
      value: GATE_R1_REPLACEMENT_PROFILES.postgres
    });
    const fetchImpl = successFetch(replacementGraphqlPayload());
    const env = new Proxy({}, {
      get() {
        throw new Error('token-source-must-not-be-read');
      }
    });

    try {
      await expect(projectGateR1ReplacementTcpProxyCount({
        replacementProfile: inheritedProfile,
        serviceId: REPLACEMENT_SERVICE_ID,
        serviceInstanceId: REPLACEMENT_SERVICE_INSTANCE_ID,
        env,
        fetchImpl
      })).rejects.toThrow('GATE_R1_TCP_PROXY_PROJECTOR_TARGET_FORBIDDEN');
    } finally {
      delete Object.prototype[inheritedProfile];
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['top-level extra', (value) => { value.extensions = {}; }],
    ['GraphQL errors', (value) => { value.errors = []; }],
    ['null service', (value) => { value.data.service = null; }],
    ['wrong service ID', (value) => { value.data.service.id = '99999999-aaaa-4bbb-8ccc-dddddddddddd'; }],
    ['wrong service name', (value) => { value.data.service.name = GATE_R1_REPLACEMENT_PROFILES.redis; }],
    ['wrong service project', (value) => { value.data.service.projectId = '99999999-aaaa-4bbb-8ccc-dddddddddddd'; }],
    ['service extra field', (value) => { value.data.service.description = 'unexpected'; }],
    ['null service instance', (value) => { value.data.serviceInstance = null; }],
    ['wrong instance ID', (value) => { value.data.serviceInstance.id = '99999999-aaaa-4bbb-8ccc-dddddddddddd'; }],
    ['wrong instance owner', (value) => { value.data.serviceInstance.serviceId = '99999999-aaaa-4bbb-8ccc-dddddddddddd'; }],
    ['wrong instance name', (value) => { value.data.serviceInstance.serviceName = GATE_R1_REPLACEMENT_PROFILES.redis; }],
    ['wrong instance environment', (value) => { value.data.serviceInstance.environmentId = '99999999-aaaa-4bbb-8ccc-dddddddddddd'; }],
    ['deleted instance', (value) => { value.data.serviceInstance.deletedAt = '2026-07-19T11:00:00.000Z'; }],
    ['instance extra field', (value) => { value.data.serviceInstance.source = 'unexpected'; }],
    ['non-array proxies', (value) => { value.data.tcpProxies = {}; }],
    ['proxy wrong owner', (value) => { value.data.tcpProxies = [{ id: PROXY_ID_A, serviceId: GATE_R1_POSTGRES_SERVICE_ID, environmentId: GATE_R1_ENVIRONMENT_ID, deletedAt: null }]; }],
    ['proxy wrong environment', (value) => { value.data.tcpProxies = [{ id: PROXY_ID_A, serviceId: REPLACEMENT_SERVICE_ID, environmentId: '99999999-aaaa-4bbb-8ccc-dddddddddddd', deletedAt: null }]; }],
    ['proxy malformed deletion time', (value) => { value.data.tcpProxies = [{ id: PROXY_ID_A, serviceId: REPLACEMENT_SERVICE_ID, environmentId: GATE_R1_ENVIRONMENT_ID, deletedAt: 'not-a-time' }]; }],
    ['proxy nonexistent deletion date', (value) => { value.data.tcpProxies = [{ id: PROXY_ID_A, serviceId: REPLACEMENT_SERVICE_ID, environmentId: GATE_R1_ENVIRONMENT_ID, deletedAt: '2026-02-31T11:00:00.000Z' }]; }],
    ['proxy extra field', (value) => { value.data.tcpProxies = [{ id: PROXY_ID_A, serviceId: REPLACEMENT_SERVICE_ID, environmentId: GATE_R1_ENVIRONMENT_ID, deletedAt: null, host: 'secret.invalid' }]; }],
    ['duplicate proxy ID', (value) => { value.data.tcpProxies = [
      { id: PROXY_ID_A, serviceId: REPLACEMENT_SERVICE_ID, environmentId: GATE_R1_ENVIRONMENT_ID, deletedAt: null },
      { id: PROXY_ID_A, serviceId: REPLACEMENT_SERVICE_ID, environmentId: GATE_R1_ENVIRONMENT_ID, deletedAt: null }
    ]; }]
  ])('fails closed on replacement identity or proxy schema drift: %s', async (_name, mutate) => {
    const payload = replacementGraphqlPayload();
    mutate(payload);
    await expect(projectGateR1ReplacementTcpProxyCount({
      replacementProfile: 'postgres',
      serviceId: REPLACEMENT_SERVICE_ID,
      serviceInstanceId: REPLACEMENT_SERVICE_INSTANCE_ID,
      env: envWithToken(),
      fetchImpl: successFetch(payload)
    })).rejects.toThrow('GATE_R1_TCP_PROXY_PROJECTOR_RESPONSE_INVALID');
  });

  it('writes only the fixed replacement JSON contract through the CLI boundary', async () => {
    const stdout = { write: jest.fn() };
    const stderr = { write: jest.fn() };
    const exitCode = await runGateR1TcpProxyProjectorCli({
      argv: [
        '--replacement-profile',
        'redis',
        '--service-id',
        REPLACEMENT_SERVICE_ID,
        '--service-instance-id',
        REPLACEMENT_SERVICE_INSTANCE_ID
      ],
      stdout,
      stderr,
      env: envWithToken(),
      fetchImpl: successFetch(replacementGraphqlPayload({ replacementProfile: 'redis' })),
      clock: () => OBSERVED_AT
    });

    expect(exitCode).toBe(0);
    expect(stderr.write).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.write.mock.calls[0][0])).toEqual({
      projectId: GATE_R1_PROJECT_ID,
      environmentId: GATE_R1_ENVIRONMENT_ID,
      replacementProfile: 'redis',
      serviceId: REPLACEMENT_SERVICE_ID,
      serviceName: GATE_R1_REPLACEMENT_PROFILES.redis,
      serviceInstanceId: REPLACEMENT_SERVICE_INSTANCE_ID,
      observedAt: OBSERVED_AT,
      tcpProxyCount: 0
    });
    expect(stdout.write.mock.calls[0][0]).not.toContain(FIXTURE_TOKEN);
  });
});

import { request as sendHttpRequest } from 'node:http';

import express, {
  type Request,
  type Response,
} from 'express';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

const loggerWarnMock = jest.fn();
const loggerErrorMock = jest.fn();
const unsafeGateMock = jest.fn();
const registerRoutesMock = jest.fn();
let unsafeGatePassThrough = false;

jest.unstable_mockModule('@core/init-openai.js', () => ({
  initOpenAI: jest.fn(),
}));
jest.unstable_mockModule('@core/diagnostics.js', () => ({
  setupDiagnostics: jest.fn(),
  writePublicHealthResponse: jest.fn(),
}));
jest.unstable_mockModule('@routes/register.js', () => ({
  registerRoutes: registerRoutesMock,
}));
jest.unstable_mockModule('@services/selfImprove/controlLoop.js', () => ({
  requestSelfHealingLoopEvaluation: jest.fn(async () => undefined),
  startSelfHealingControlLoop: jest.fn(),
  stopSelfHealingControlLoopForTests: jest.fn(),
  getSelfHealingLoopMitigation: jest.fn(() => ({
    active: false,
    reason: null,
  })),
  getSelfHealingControlLoopStatus: jest.fn(() => ({
    running: false,
  })),
}));
jest.unstable_mockModule('@services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: {
    logStartupSummary: jest.fn(async () => undefined),
    recordRequestCompletion: jest.fn(),
  },
}));
jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  workerSettings: {},
  WorkerTaskQueue: class WorkerTaskQueue {},
  workerTaskQueue: {},
  workerTask: jest.fn(async () => ({})),
  startWorkers: jest.fn(async () => ({})),
  startConfiguredWorkerRuntime: jest.fn(async () => null),
  dispatchArcanosTask: jest.fn(async () => ({})),
  getWorkerRuntimeStatus: jest.fn(() => ({
    enabled: false,
    started: false,
  })),
  scaleWorkersUp: jest.fn(async () => ({})),
  recycleWorker: jest.fn(async () => ({})),
}));
jest.unstable_mockModule('@services/arcanosCoreRuntimeProviders.js', () => ({
  configureDefaultArcanosCoreRuntimeProviders: jest.fn(),
}));
jest.unstable_mockModule('@services/arcanosMcp.js', () => ({
  arcanosMcpService: {},
}));
jest.unstable_mockModule(
  '@transport/http/middleware/unsafeExecutionGate.js',
  () => ({
    unsafeExecutionGate: (
      req: Request,
      res: Response,
      next: () => void
    ) => {
      unsafeGateMock(req.method, req.originalUrl);
      if (unsafeGatePassThrough) {
        next();
        return;
      }
      res.status(418).json({ sentinel: 'unsafe-gate-reached' });
    },
  })
);
jest.unstable_mockModule('@transport/http/middleware/fallbackHandler.js', () => ({
  createHealthCheckMiddleware: () => (
    _req: unknown,
    _res: unknown,
    next: () => void
  ) => next(),
  createFallbackMiddleware: () => (
    _req: unknown,
    _res: unknown,
    next: () => void
  ) => next(),
}));
jest.unstable_mockModule('@transport/http/gamingIngressAudit.js', () => ({
  gamingIngressAudit: (
    _req: unknown,
    _res: unknown,
    next: () => void
  ) => next(),
}));
jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => {
  const baseLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: loggerWarnMock,
    error: loggerErrorMock,
    child: () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: loggerWarnMock,
      error: loggerErrorMock,
    }),
  };
  return {
    LogLevel: {
      DEBUG: 'debug',
      INFO: 'info',
      WARN: 'warn',
      ERROR: 'error',
    },
    getConfiguredLogLevel: jest.fn(() => 'info'),
    sanitize: (value: unknown) => value,
    requestLoggingMiddleware: (
      _req: unknown,
      _res: unknown,
      next: () => void
    ) => next(),
    healthMetrics: {},
    default: baseLogger,
    logger: baseLogger,
    apiLogger: baseLogger,
    aiLogger: baseLogger,
    dbLogger: baseLogger,
    workerLogger: baseLogger,
  };
});

const { createApp } = await import('../src/app.js');
const {
  BACKSTAGE_BOOKER_BODY_LIMIT_BYTES,
  BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH,
  BACKSTAGE_BOOKER_UNIVERSE_READ_PATH_PREFIX,
  backstageBookerHttpBoundary,
  isBackstageBookerHttpBoundaryApplied,
} = await import('../src/services/backstageBookerHttpBoundary.js');
const {
  extractBackstageBookerAccessBearerToken,
  isBackstageBookerAccessAuthenticated,
} = await import('../src/services/backstageBookerAccessAuth.js');
const { gptAccessAuthMiddleware } = await import(
  '../src/services/gptAccessGateway.js'
);
const {
  GAMING_SOURCE_BODY_LIMIT_BYTES,
  gamingSourceBodyParser,
} = await import('../src/services/gamingSourceBodyParser.js');
const { createGamingSourceHttpBoundary } = await import(
  '../src/services/gamingSourceHttpBoundary.js'
);
const { extractGamingSourceAccessBearerToken } = await import(
  '../src/services/gamingSourceAccessAuth.js'
);
const { createGptAccessRateLimit } = await import(
  '../src/services/gptAccessRateLimit.js'
);
const {
  resolveGamingSourceHttpOperation,
  resolveGamingSourceHttpResolution,
  resolveGamingSourceHttpTarget,
} = await import('../src/services/gamingSourceHttpRoutes.js');

const TEST_TOKEN = 'gaming-source-http-boundary-token';
const BACKSTAGE_BOOKER_TEST_TOKEN =
  'backstage-booker-http-boundary-token-123456';
const GLOBAL_GPT_ACCESS_TOKEN = 'global-gpt-access-token-for-boundary-tests';
const BACKSTAGE_UNIVERSE_READ_PATH =
  `${BACKSTAGE_BOOKER_UNIVERSE_READ_PATH_PREFIX}/my-universe-2k26`;
const INGESTION_PATH = '/gpt-access/gaming/sources/ingestions';
const REFRESH_PATH = '/gpt-access/gaming/sources/refreshes';
const STATUS_ID = '019fe3cd-8c01-7f01-8d2d-caa951bc4b9b';
const STATUS_PATH = `/gpt-access/gaming/sources/ingestions/${STATUS_ID}`;
const ENCODED_STATUS_ID = [...STATUS_ID]
  .map(character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  .join('');
const ENCODED_STATUS_PATH =
  `/gpt-access/gaming/sources/ingestions/${ENCODED_STATUS_ID}`;
const NON_CANONICAL_STATUS_CASES = [
  ['encoded separator', `${STATUS_PATH}%2Fextra`],
  ['encoded backslash', `${STATUS_PATH}%5Cextra`],
  ['encoded control', `${STATUS_PATH}%00`],
  ['encoded delete control', `${STATUS_PATH}%7F`],
  ['double encoding', `${STATUS_PATH}%252Dextra`],
  ['malformed percent sequence', `${STATUS_PATH}%GG`],
] as const;
const previousToken = process.env.ARCANOS_GPT_ACCESS_TOKEN;
const previousBackstageBookerToken =
  process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN;
const previousGamingSourceToken = process.env.ARCANOS_GAMING_SOURCE_ACCESS_TOKEN;
const previousScopes = process.env.ARCANOS_GPT_ACCESS_SCOPES;
let consoleLogMock: ReturnType<typeof jest.spyOn>;

interface GamingHttpTestResponse {
  body: Record<string, unknown> & {
    error?: Record<string, unknown>;
  };
  headers: Record<string, string | string[] | undefined>;
  status: number;
}

function restoreEnvironmentVariable(
  name: string,
  previousValue: string | undefined
): void {
  if (previousValue === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previousValue;
}

function expectNoStoreSecurityHeaders(
  response: GamingHttpTestResponse
): void {
  expect(response.headers['cache-control']).toContain('no-store');
  expect(response.headers.pragma).toBe('no-cache');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['x-frame-options']).toBe('DENY');
}

function expectClosedGamingError(
  response: GamingHttpTestResponse,
  statusCode: number,
  errorCode: string
): void {
  expect(response.status).toBe(statusCode);
  expect(response.body).toEqual(expect.objectContaining({
    ok: false,
    error: expect.objectContaining({
      code: errorCode,
      message: expect.any(String),
    }),
  }));
  expect(Object.keys(response.body).every(key => (
    ['ok', 'error', 'requestId', 'traceId'].includes(key)
  ))).toBe(true);
  expect(Object.keys(response.body.error)).toEqual(['code', 'message']);
  expectNoStoreSecurityHeaders(response);
}

function authorized(testRequest: request.Test): request.Test {
  return testRequest.set('Authorization', `Bearer ${TEST_TOKEN}`);
}

function globallyAuthorized(testRequest: request.Test): request.Test {
  return testRequest.set(
    'Authorization',
    ['Bearer', GLOBAL_GPT_ACCESS_TOKEN].join(' ')
  );
}

function sourceAccessRequestWithAuthorization(
  authorization: string | undefined,
  rawHeaders: string[] = authorization === undefined
    ? []
    : ['Authorization', authorization]
): Request {
  return {
    rawHeaders,
    header: (name: string) => (
      name.toLowerCase() === 'authorization' ? authorization : undefined
    ),
  } as unknown as Request;
}

async function sendAbsoluteFormRequest(
  app: express.Express,
  options: {
    body?: Buffer | string;
    chunked?: boolean;
    headers?: Readonly<Record<string, string | string[]>>;
    method: string;
    path: string;
  }
): Promise<GamingHttpTestResponse> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Expected a TCP listener for absolute-form request test.');
  }

  const requestHeaders: Record<string, string | string[] | number> = {
    Host: 'example.test',
    ...(options.body !== undefined
      ? {
          'Content-Type': 'application/json',
          ...(options.chunked
            ? { 'Transfer-Encoding': 'chunked' }
            : { 'Content-Length': Buffer.byteLength(options.body) }),
        }
      : {}),
    ...options.headers,
  };
  try {
    return await new Promise((resolve, reject) => {
      const pendingRequest = sendHttpRequest({
        host: '127.0.0.1',
        port: address.port,
        method: options.method,
        path: `http://example.test${options.path}`,
        headers: requestHeaders,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const responseText = Buffer.concat(chunks).toString('utf8');
          resolve({
            body: responseText
              ? JSON.parse(responseText) as GamingHttpTestResponse['body']
              : {},
            headers: { ...response.headers },
            status: response.statusCode ?? 0,
          });
        });
      });
      pendingRequest.on('error', reject);
      pendingRequest.end(options.body);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('Gaming source production HTTP boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerRoutesMock.mockReset();
    unsafeGatePassThrough = false;
    consoleLogMock = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    process.env.ARCANOS_GPT_ACCESS_TOKEN = GLOBAL_GPT_ACCESS_TOKEN;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN =
      BACKSTAGE_BOOKER_TEST_TOKEN;
    process.env.ARCANOS_GAMING_SOURCE_ACCESS_TOKEN = TEST_TOKEN;
    delete process.env.ARCANOS_GPT_ACCESS_SCOPES;
  });

  afterEach(() => {
    consoleLogMock.mockRestore();
  });

  afterAll(() => {
    restoreEnvironmentVariable('ARCANOS_GPT_ACCESS_TOKEN', previousToken);
    restoreEnvironmentVariable(
      'ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN',
      previousBackstageBookerToken
    );
    restoreEnvironmentVariable(
      'ARCANOS_GAMING_SOURCE_ACCESS_TOKEN',
      previousGamingSourceToken
    );
    restoreEnvironmentVariable('ARCANOS_GPT_ACCESS_SCOPES', previousScopes);
  });

  it.each([
    ['wrong auth scheme', `Basic ${TEST_TOKEN}`],
    ['lowercase bearer scheme', `bearer ${TEST_TOKEN}`],
    ['extra separator whitespace', `Bearer  ${TEST_TOKEN}`],
    ['token whitespace', `Bearer gaming source token`],
    ['empty token', 'Bearer '],
  ])('does not parse a %s credential carrier', (_caseName, authorization) => {
    expect(extractGamingSourceAccessBearerToken(
      sourceAccessRequestWithAuthorization(authorization)
    )).toBeNull();
  });

  it('does not parse duplicate Authorization headers', () => {
    const authorization = `Bearer ${TEST_TOKEN}`;
    const requestWithDuplicateAuthorization = sourceAccessRequestWithAuthorization(
      authorization,
      ['Authorization', authorization, 'Authorization', authorization]
    );

    expect(extractGamingSourceAccessBearerToken(
      requestWithDuplicateAuthorization
    )).toBeNull();
  });

  it.each([
    [INGESTION_PATH, {
      action: 'ingest',
      payload: {
        game: 'Boundary fixture',
        sourceUrls: ['https://example.com/gaming-boundary-fixture'],
        idempotencyKey: 'boundary-ingest-valid',
      },
    }],
    [REFRESH_PATH, {
      action: 'refresh',
      payload: {
        sourceIds: ['019fe3cd-8c01-7f01-8d2d-caa951bc4b9b'],
        idempotencyKey: 'boundary-refresh-valid',
      },
    }],
  ])('authenticates a valid %s request before parsing or unsafe policy', async (
    path,
    body
  ) => {
    const response = await request(createApp()).post(path).send(body);

    expectClosedGamingError(response, 401, 'UNAUTHORIZED_GPT_ACCESS');
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it('authenticates malformed JSON before the route-specific parser', async () => {
    const sentinel = 'unauthenticated-malformed-body-sentinel';
    const response = await request(createApp())
      .post(INGESTION_PATH)
      .set('Content-Type', 'application/json')
      .send(`{"action":"ingest","payload":"${sentinel}"`);

    expectClosedGamingError(response, 401, 'UNAUTHORIZED_GPT_ACCESS');
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it('authenticates an oversized body before allocating through a broad parser', async () => {
    const sentinel = 'unauthenticated-oversized-body-sentinel';
    const response = await request(createApp())
      .post(INGESTION_PATH)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({
        action: 'ingest',
        payload: {
          value: `${sentinel}${'x'.repeat(GAMING_SOURCE_BODY_LIMIT_BYTES)}`,
        },
      }));

    expectClosedGamingError(response, 401, 'UNAUTHORIZED_GPT_ACCESS');
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it('returns the closed Gaming error for authenticated malformed JSON', async () => {
    const sentinel = 'authenticated-malformed-body-sentinel';
    const response = await authorized(
      request(createApp())
        .post(INGESTION_PATH)
        .set('Content-Type', 'application/json')
    ).send(`{"action":"ingest","payload":"${sentinel}"`);

    expectClosedGamingError(response, 400, 'GAMING_SOURCE_VALIDATION_ERROR');
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it('returns a closed 413 before the broad application parser', async () => {
    const sentinel = 'authenticated-oversized-body-sentinel';
    const response = await authorized(
      request(createApp())
        .post(REFRESH_PATH)
        .set('Content-Type', 'application/json')
    ).send(JSON.stringify({
      action: 'refresh',
      payload: {
        value: `${sentinel}${'x'.repeat(GAMING_SOURCE_BODY_LIMIT_BYTES)}`,
      },
    }));

    expectClosedGamingError(response, 413, 'GAMING_SOURCE_VALIDATION_ERROR');
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it('returns a closed 415 for an authenticated non-JSON body', async () => {
    const sentinel = 'authenticated-content-type-sentinel';
    const response = await authorized(
      request(createApp())
        .post(INGESTION_PATH)
        .set('Content-Type', 'text/plain')
    ).send(sentinel);

    expectClosedGamingError(response, 415, 'GAMING_SOURCE_VALIDATION_ERROR');
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it('rejects the global GPT Access bearer in the source-only namespace', async () => {
    const response = await globallyAuthorized(
      request(createApp()).post(INGESTION_PATH)
    ).send({ action: 'ingest', payload: {} });

    expectClosedGamingError(response, 401, 'UNAUTHORIZED_GPT_ACCESS');
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it('fails closed before parsing when the dedicated source credential is unavailable', async () => {
    const previousGamingSourceToken = process.env.ARCANOS_GAMING_SOURCE_ACCESS_TOKEN;
    delete process.env.ARCANOS_GAMING_SOURCE_ACCESS_TOKEN;

    try {
      const response = await authorized(
        request(createApp())
          .post(INGESTION_PATH)
          .set('Content-Type', 'application/json')
      ).send(`{"action":"ingest","payload":"${'x'.repeat(GAMING_SOURCE_BODY_LIMIT_BYTES)}"`);

      expectClosedGamingError(response, 503, 'GAMING_SOURCE_AUTH_UNAVAILABLE');
      expect(unsafeGateMock).not.toHaveBeenCalled();
    } finally {
      restoreEnvironmentVariable(
        'ARCANOS_GAMING_SOURCE_ACCESS_TOKEN',
        previousGamingSourceToken
      );
    }
  });

  it('fails closed when the dedicated source credential collides with global GPT Access', async () => {
    const previousGamingSourceToken = process.env.ARCANOS_GAMING_SOURCE_ACCESS_TOKEN;
    process.env.ARCANOS_GAMING_SOURCE_ACCESS_TOKEN = GLOBAL_GPT_ACCESS_TOKEN;

    try {
      const response = await globallyAuthorized(
        request(createApp()).get(STATUS_PATH)
      );

      expectClosedGamingError(response, 503, 'GAMING_SOURCE_AUTH_UNAVAILABLE');
      expect(unsafeGateMock).not.toHaveBeenCalled();
    } finally {
      restoreEnvironmentVariable(
        'ARCANOS_GAMING_SOURCE_ACCESS_TOKEN',
        previousGamingSourceToken
      );
    }
  });

  it('protects unsupported methods in the exact source namespace', async () => {
    const responses = await Promise.all([
      request(createApp()).put(INGESTION_PATH).send({ value: true }),
      request(createApp()).patch(REFRESH_PATH).send({ value: true }),
      request(createApp()).delete(STATUS_PATH).send({ value: true }),
    ]);

    for (const response of responses) {
      expectClosedGamingError(response, 401, 'UNAUTHORIZED_GPT_ACCESS');
    }
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it('authenticates preflight before global CORS can short-circuit', async () => {
    const response = await request(createApp())
      .options(INGESTION_PATH)
      .set('Origin', 'https://example.com')
      .set('Access-Control-Request-Method', 'POST');

    expectClosedGamingError(response, 401, 'UNAUTHORIZED_GPT_ACCESS');
    expect(response.headers).not.toHaveProperty('access-control-allow-origin');
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      'valid JSON',
      'POST',
      INGESTION_PATH,
      JSON.stringify({
        action: 'ingest',
        payload: {
          game: 'Absolute-form boundary fixture',
          sourceUrls: ['https://example.com/absolute-form-boundary'],
          idempotencyKey: 'absolute-form-valid',
        },
      }),
      {},
    ],
    [
      'malformed JSON',
      'POST',
      INGESTION_PATH,
      '{"action":"ingest","payload":"absolute-form-malformed"',
      {},
    ],
    [
      'oversized JSON',
      'POST',
      REFRESH_PATH,
      JSON.stringify({
        value: `absolute-form-oversized-${'x'.repeat(
          GAMING_SOURCE_BODY_LIMIT_BYTES
        )}`,
      }),
      {},
    ],
    [
      'canonically encoded status UUID',
      'GET',
      ENCODED_STATUS_PATH,
      undefined,
      {},
    ],
    [
      'non-canonical encoded status UUID',
      'GET',
      `${STATUS_PATH}%252Fextra`,
      undefined,
      {},
    ],
    [
      'CORS preflight',
      'OPTIONS',
      INGESTION_PATH,
      undefined,
      {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'POST',
      },
    ],
  ] as const)(
    'authenticates an absolute-form %s request before parsing or dispatch',
    async (_caseName, method, path, body, headers) => {
      const response = await sendAbsoluteFormRequest(createApp(), {
        body,
        headers,
        method,
        path,
      });

      expectClosedGamingError(
        response,
        401,
        'UNAUTHORIZED_GPT_ACCESS'
      );
      expect(response.headers).not.toHaveProperty(
        'access-control-allow-origin'
      );
      expect(unsafeGateMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      'malformed JSON',
      'POST',
      INGESTION_PATH,
      '{"action":"ingest","payload":"absolute-form-malformed"',
      400,
    ],
    [
      'oversized JSON',
      'POST',
      REFRESH_PATH,
      JSON.stringify({
        value: `absolute-form-oversized-${'x'.repeat(
          GAMING_SOURCE_BODY_LIMIT_BYTES
        )}`,
      }),
      413,
    ],
    [
      'non-canonical encoded status UUID',
      'GET',
      `${STATUS_PATH}%252Fextra`,
      undefined,
      400,
    ],
  ] as const)(
    'returns a closed %s response for an authenticated absolute-form request',
    async (_caseName, method, path, body, statusCode) => {
      const response = await sendAbsoluteFormRequest(createApp(), {
        body,
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        method,
        path,
      });

      expectClosedGamingError(
        response,
        statusCode,
        'GAMING_SOURCE_VALIDATION_ERROR'
      );
      expect(unsafeGateMock).not.toHaveBeenCalled();
    }
  );

  it('preserves no-store headers after an authenticated valid absolute-form request', async () => {
    const response = await sendAbsoluteFormRequest(createApp(), {
      body: JSON.stringify({
        action: 'ingest',
        payload: {
          game: 'Absolute-form boundary fixture',
          sourceUrls: ['https://example.com/absolute-form-boundary'],
          idempotencyKey: 'absolute-form-valid',
        },
      }),
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      method: 'POST',
      path: INGESTION_PATH,
    });

    expect(response.status).toBe(418);
    expect(response.body).toEqual({ sentinel: 'unsafe-gate-reached' });
    expectNoStoreSecurityHeaders(response);
    expect(unsafeGateMock).toHaveBeenCalledWith('POST', expect.any(String));
  });

  it('authenticates a valid encoded status UUID before route dispatch', async () => {
    const response = await request(createApp()).get(ENCODED_STATUS_PATH);

    expectClosedGamingError(response, 401, 'UNAUTHORIZED_GPT_ACCESS');
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it('classifies a status UUID after exactly one canonical decode', () => {
    const encodedRequest = {
      method: 'GET',
      originalUrl: ENCODED_STATUS_PATH,
    } as Request;

    expect(resolveGamingSourceHttpTarget(encodedRequest)).toEqual({
      kind: 'status',
    });
    expect(resolveGamingSourceHttpOperation(encodedRequest)).toEqual({
      kind: 'status',
      operationKind: 'read',
    });
  });

  it.each(NON_CANONICAL_STATUS_CASES)(
    'contains and rejects a non-canonical status path with %s',
    (_caseName, path) => {
      const nonCanonicalRequest = {
        method: 'GET',
        originalUrl: path,
      } as Request;

      expect(resolveGamingSourceHttpResolution(nonCanonicalRequest)).toEqual({
        target: {
          kind: 'status',
        },
        canonical: false,
      });
      expect(resolveGamingSourceHttpTarget(nonCanonicalRequest)).toEqual({
        kind: 'status',
      });
      expect(resolveGamingSourceHttpOperation(nonCanonicalRequest)).toBeNull();
    }
  );

  it.each(NON_CANONICAL_STATUS_CASES)(
    'authenticates a non-canonical status path with %s before rejection',
    async (_caseName, path) => {
      const unauthenticated = await request(createApp()).get(path);
      expectClosedGamingError(
        unauthenticated,
        401,
        'UNAUTHORIZED_GPT_ACCESS'
      );
      expect(unsafeGateMock).not.toHaveBeenCalled();

      const authenticated = await authorized(request(createApp()).get(path));
      expectClosedGamingError(
        authenticated,
        400,
        'GAMING_SOURCE_VALIDATION_ERROR'
      );
      expect(unsafeGateMock).not.toHaveBeenCalled();
    }
  );

  it('authenticates malformed JSON on an encoded status UUID before parsing', async () => {
    const sentinel = 'encoded-status-malformed-body-sentinel';
    const response = await request(createApp())
      .get(ENCODED_STATUS_PATH)
      .set('Content-Type', 'application/json')
      .send(`{"value":"${sentinel}"`);

    expectClosedGamingError(response, 401, 'UNAUTHORIZED_GPT_ACCESS');
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it('authenticates an oversized encoded status request before parsing', async () => {
    const sentinel = 'encoded-status-oversized-body-sentinel';
    const response = await request(createApp())
      .get(ENCODED_STATUS_PATH)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({
        value: `${sentinel}${'x'.repeat(GAMING_SOURCE_BODY_LIMIT_BYTES)}`,
      }));

    expectClosedGamingError(response, 401, 'UNAUTHORIZED_GPT_ACCESS');
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it('authenticates an unsupported encoded status mutation before unsafe policy', async () => {
    const response = await request(createApp())
      .delete(ENCODED_STATUS_PATH)
      .send({ value: true });

    expectClosedGamingError(response, 401, 'UNAUTHORIZED_GPT_ACCESS');
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it('bounds an authenticated unsupported encoded status mutation', async () => {
    const response = await authorized(
      request(createApp())
        .delete(ENCODED_STATUS_PATH)
        .set('Content-Type', 'application/json')
    ).send(JSON.stringify({
      value: 'x'.repeat(GAMING_SOURCE_BODY_LIMIT_BYTES),
    }));

    expectClosedGamingError(response, 413, 'GAMING_SOURCE_VALIDATION_ERROR');
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed', `{"value":"encoded-authenticated-malformed"`],
    ['oversized', JSON.stringify({
      value: 'x'.repeat(GAMING_SOURCE_BODY_LIMIT_BYTES),
    })],
  ])('returns a closed parser error for an authenticated %s encoded status body', async (
    _caseName,
    body
  ) => {
    const response = await authorized(
      request(createApp())
        .get(ENCODED_STATUS_PATH)
        .set('Content-Type', 'application/json')
    ).send(body);

    expectClosedGamingError(response, 400, 'GAMING_SOURCE_VALIDATION_ERROR');
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it('does not consume the shared rate budget twice', async () => {
    const app = express();
    const boundary = createGamingSourceHttpBoundary({
      rateLimit: createGptAccessRateLimit({
        maxRequests: 1,
        windowMs: 60_000,
      }),
    });
    app.use('/gpt-access/gaming/sources', boundary, gamingSourceBodyParser);
    app.use('/gpt-access/gaming/sources', boundary, gamingSourceBodyParser);
    app.post(INGESTION_PATH, (_req, res) => res.status(204).end());

    const body = {
      action: 'ingest',
      payload: {
        game: 'Boundary fixture',
        sourceUrls: ['https://example.com/gaming-boundary-fixture'],
        idempotencyKey: 'boundary-rate-limit',
      },
    };
    const first = await authorized(request(app).post(INGESTION_PATH)).send(body);
    const second = await authorized(request(app).post(INGESTION_PATH)).send(body);

    expect(first.status).toBe(204);
    expect(first.headers['x-ratelimit-remaining']).toBe('0');
    expectNoStoreSecurityHeaders(first);
    expect(second.status).toBe(429);
    expect(second.headers['cache-control']).toContain('no-store');
  });
});

describe('Backstage Booker production HTTP boundary', () => {
  function configureBackstageLeafRoute(): void {
    registerRoutesMock.mockImplementation((app: express.Express) => {
      // Mirror the leaf router's idempotent boundary and downstream generic
      // authentication seam without executing a real canon mutation.
      app.use('/gpt-access', backstageBookerHttpBoundary);
      app.use('/gpt-access', (req, res, next) => {
        if (isBackstageBookerHttpBoundaryApplied(req)) {
          next();
          return;
        }
        gptAccessAuthMiddleware(req, res, next);
      });
      app.post(BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH, (req, res) => {
        res.status(200).json({
          dedicated: isBackstageBookerAccessAuthenticated(req),
        });
      });
      app.get(BACKSTAGE_UNIVERSE_READ_PATH, (req, res) => {
        res.status(200).json({
          dedicated: isBackstageBookerAccessAuthenticated(req),
          universeId: req.params.universeId ?? 'my-universe-2k26',
        });
      });
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    registerRoutesMock.mockReset();
    unsafeGatePassThrough = false;
    consoleLogMock = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    process.env.ARCANOS_GPT_ACCESS_TOKEN = GLOBAL_GPT_ACCESS_TOKEN;
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN =
      BACKSTAGE_BOOKER_TEST_TOKEN;
    process.env.ARCANOS_GAMING_SOURCE_ACCESS_TOKEN = TEST_TOKEN;
    delete process.env.ARCANOS_GPT_ACCESS_SCOPES;
    configureBackstageLeafRoute();
  });

  afterEach(() => {
    consoleLogMock.mockRestore();
  });

  afterAll(() => {
    restoreEnvironmentVariable('ARCANOS_GPT_ACCESS_TOKEN', previousToken);
    restoreEnvironmentVariable(
      'ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN',
      previousBackstageBookerToken
    );
    restoreEnvironmentVariable(
      'ARCANOS_GAMING_SOURCE_ACCESS_TOKEN',
      previousGamingSourceToken
    );
    restoreEnvironmentVariable('ARCANOS_GPT_ACCESS_SCOPES', previousScopes);
  });

  it.each([
    ['wrong auth scheme', `Basic ${BACKSTAGE_BOOKER_TEST_TOKEN}`],
    ['lowercase bearer scheme', `bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`],
    ['extra separator whitespace', `Bearer  ${BACKSTAGE_BOOKER_TEST_TOKEN}`],
    ['token whitespace', 'Bearer backstage booker token'],
    ['empty token', 'Bearer '],
  ])('does not parse a %s dedicated credential carrier', (
    _caseName,
    authorization
  ) => {
    expect(extractBackstageBookerAccessBearerToken(
      sourceAccessRequestWithAuthorization(authorization)
    )).toBeNull();
  });

  it('does not parse duplicate dedicated Authorization headers', () => {
    const authorization = `Bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`;
    expect(extractBackstageBookerAccessBearerToken(
      sourceAccessRequestWithAuthorization(
        authorization,
        ['Authorization', authorization, 'Authorization', authorization]
      )
    )).toBeNull();
  });

  it('authenticates before CORS, broad parsing, and the unsafe execution gate', async () => {
    const sentinel = 'backstage-unauthenticated-malformed-body-sentinel';
    const response = await request(createApp())
      .post(BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH)
      .set('Authorization', `Basic ${BACKSTAGE_BOOKER_TEST_TOKEN}`)
      .set('Content-Type', 'application/json')
      .set('Origin', 'https://example.com')
      .send(`{"action":"upsertStoryline","payload":"${sentinel}"`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED_GPT_ACCESS');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers).not.toHaveProperty('access-control-allow-origin');
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it('keeps exact-ID universe reads on the dedicated boundary before generic auth', async () => {
    unsafeGatePassThrough = true;
    const dedicatedResponse = await request(createApp())
      .get(BACKSTAGE_UNIVERSE_READ_PATH)
      .set('Authorization', `Bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`);
    const genericResponse = await request(createApp())
      .get(BACKSTAGE_UNIVERSE_READ_PATH)
      .set('Authorization', `Bearer ${GLOBAL_GPT_ACCESS_TOKEN}`);

    expect(dedicatedResponse.status).toBe(200);
    expect(dedicatedResponse.body).toEqual({
      dedicated: true,
      universeId: 'my-universe-2k26',
    });
    expect(dedicatedResponse.headers['cache-control']).toContain('no-store');
    expect(genericResponse.status).toBe(401);
    expect(genericResponse.body.error.code).toBe('UNAUTHORIZED_GPT_ACCESS');
    expect(genericResponse.headers['cache-control']).toContain('no-store');
    expect(unsafeGateMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['malformed', '{"value":"backstage-read-malformed-sentinel"'],
    ['oversized', JSON.stringify({
      value: `backstage-read-oversized-sentinel-${'x'.repeat(300 * 1024)}`,
    })],
  ])('rejects an authenticated %s GET body before broad parsing', async (
    _caseName,
    body
  ) => {
    const response = await request(createApp())
      .get(BACKSTAGE_UNIVERSE_READ_PATH)
      .set('Authorization', `Bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: 'GPT_ACCESS_VALIDATION_ERROR',
      message: 'The Backstage universe read request is invalid.',
    });
    expect(response.headers['cache-control']).toContain('no-store');
    expect(JSON.stringify(response.body)).not.toContain('backstage-read-');
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it('protects malformed descendants of the universe-read namespace', async () => {
    const response = await request(createApp()).get(
      `${BACKSTAGE_BOOKER_UNIVERSE_READ_PATH_PREFIX}/bad%2Funiverse/extra`
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED_GPT_ACCESS');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers.pragma).toBe('no-cache');
  });

  it.each([
    ['duplicate dedicated values', [
      `Bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`,
      `Bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`,
    ]],
    ['generic then dedicated values', [
      `Bearer ${GLOBAL_GPT_ACCESS_TOKEN}`,
      `Bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`,
    ]],
    ['dedicated then generic values', [
      `Bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`,
      `Bearer ${GLOBAL_GPT_ACCESS_TOKEN}`,
    ]],
  ] as const)('rejects %s Authorization headers at the full application boundary', async (
    _caseName,
    authorization
  ) => {
    const response = await sendAbsoluteFormRequest(createApp(), {
      body: JSON.stringify({ action: 'upsertStoryline', payload: {} }),
      headers: {
        Authorization: [...authorization],
      },
      method: 'POST',
      path: BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH,
    });

    expect(response.status).toBe(401);
    expect(response.body.error?.code).toBe('UNAUTHORIZED_GPT_ACCESS');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{"action":"upsertStoryline","payload":'],
    ['a primitive JSON body', 'true'],
    ['an array JSON body', '[]'],
  ])('returns the fixed canon validation envelope for %s', async (
    _caseName,
    body
  ) => {
    const response = await sendAbsoluteFormRequest(createApp(), {
      body,
      headers: {
        Authorization: `Bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`,
      },
      method: 'POST',
      path: BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH,
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      error: {
        code: 'GPT_ACCESS_VALIDATION_ERROR',
        message: 'The Backstage Booker canon request is invalid.',
      },
    }));
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-JSON media type', { 'Content-Type': 'text/plain' }],
    ['an unsupported charset', {
      'Content-Type': 'application/json; charset=iso-8859-1',
    }],
    ['conflicting charsets with UTF-8 last', {
      'Content-Type': 'application/json; charset=iso-8859-1; charset=utf-8',
    }],
    ['conflicting charsets with UTF-8 first', {
      'Content-Type': 'application/json; charset=utf-8; charset=iso-8859-1',
    }],
    ['a comma-combined media representation', {
      'Content-Type': 'application/json; charset=utf-8, text/plain',
    }],
    ['an unsupported content encoding', { 'Content-Encoding': 'gzip' }],
    ['a gzip transfer-coding list', {
      'Transfer-Encoding': 'gzip, chunked',
    }],
    ['an identity transfer-coding list', {
      'Transfer-Encoding': 'identity, chunked',
    }],
    ['duplicate content types', {
      'Content-Type': ['application/json', 'application/json'],
    }],
  ] as const)('rejects %s with the documented media response', async (
    _caseName,
    representationHeaders
  ) => {
    const response = await sendAbsoluteFormRequest(createApp(), {
      body: JSON.stringify({ action: 'upsertStoryline', payload: {} }),
      chunked: Object.keys(representationHeaders).some(
        (headerName) => headerName.toLowerCase() === 'transfer-encoding'
      ),
      headers: {
        Authorization: `Bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`,
        ...representationHeaders,
      },
      method: 'POST',
      path: BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH,
    });

    expect(response.status).toBe(415);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      error: {
        code: 'GPT_ACCESS_VALIDATION_ERROR',
        message: 'The Backstage Booker canon request is invalid.',
      },
    }));
    expect(response.headers['cache-control']).toContain('no-store');
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-ASCII media subtype', 'application/jſon'],
    ['a non-ASCII charset parameter name', 'application/json; charſet=utf-8'],
  ])('rejects %s without Unicode case-folding the ASCII grammar', async (
    _caseName,
    contentType
  ) => {
    const app = express();
    app.use((req, _res, next) => {
      req.headers['content-type'] = contentType;
      next();
    });
    app.use('/gpt-access', backstageBookerHttpBoundary);
    app.post(BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH, (_req, res) => {
      res.status(200).json({ unexpected: true });
    });

    const response = await request(app)
      .post(BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH)
      .set('Authorization', `Bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`)
      .send({ action: 'upsertStoryline', payload: {} });

    expect(response.status).toBe(415);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      error: {
        code: 'GPT_ACCESS_VALIDATION_ERROR',
        message: 'The Backstage Booker canon request is invalid.',
      },
    }));
    expect(response.headers['cache-control']).toContain('no-store');
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a Unicode-case-folded transfer coding', 'chunKed', false],
    ['a non-ASCII-whitespace transfer coding', '\u00a0chunked\u00a0', false],
    ['coexisting Content-Length and Transfer-Encoding', 'chunked', true],
  ] as const)('rejects %s reconstructed by an adapter', async (
    _caseName,
    transferEncoding,
    retainContentLength
  ) => {
    const app = express();
    app.use((req, _res, next) => {
      req.headers['transfer-encoding'] = transferEncoding;
      if (!retainContentLength) {
        delete req.headers['content-length'];
        for (let index = req.rawHeaders.length - 2; index >= 0; index -= 2) {
          if (req.rawHeaders[index]?.toLowerCase() === 'content-length') {
            req.rawHeaders.splice(index, 2);
          }
        }
      }
      req.rawHeaders.push('Transfer-Encoding', transferEncoding);
      next();
    });
    app.use('/gpt-access', backstageBookerHttpBoundary);
    app.post(BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH, (_req, res) => {
      res.status(200).json({ unexpected: true });
    });

    const response = await request(app)
      .post(BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH)
      .set('Authorization', `Bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`)
      .send({ action: 'upsertStoryline', payload: {} });

    expect(response.status).toBe(415);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      error: {
        code: 'GPT_ACCESS_VALIDATION_ERROR',
        message: 'The Backstage Booker canon request is invalid.',
      },
    }));
    expect(response.headers['cache-control']).toContain('no-store');
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it('rejects invalid UTF-8 before JSON normalization or the leaf route', async () => {
    const body = Buffer.concat([
      Buffer.from('{"action":"upsertStoryline","payload":{"value":"'),
      Buffer.from([0xff]),
      Buffer.from('"}}'),
    ]);
    const response = await sendAbsoluteFormRequest(createApp(), {
      body,
      headers: {
        Authorization: `Bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`,
      },
      method: 'POST',
      path: BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH,
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      error: {
        code: 'GPT_ACCESS_VALIDATION_ERROR',
        message: 'The Backstage Booker canon request is invalid.',
      },
    }));
    expect(JSON.stringify(response.body)).not.toContain('\ufffd');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it('rejects a zero-byte chunked JSON body before the leaf route', async () => {
    const response = await sendAbsoluteFormRequest(createApp(), {
      body: '',
      chunked: true,
      headers: {
        Authorization: `Bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`,
      },
      method: 'POST',
      path: BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH,
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      error: {
        code: 'GPT_ACCESS_VALIDATION_ERROR',
        message: 'The Backstage Booker canon request is invalid.',
      },
    }));
    expect(response.headers['cache-control']).toContain('no-store');
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['declared-length', false],
    ['chunked', true],
  ] as const)('rejects a %s body above the dedicated byte limit', async (
    _caseName,
    chunked
  ) => {
    const sentinel = 'backstage-oversized-body-sentinel';
    const body = JSON.stringify({
      action: 'upsertStoryline',
      payload: {
        value: `${sentinel}${'x'.repeat(BACKSTAGE_BOOKER_BODY_LIMIT_BYTES)}`,
      },
    });
    const response = await sendAbsoluteFormRequest(createApp(), {
      body,
      chunked,
      headers: {
        Authorization: `Bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`,
      },
      method: 'POST',
      path: BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH,
    });

    expect(response.status).toBe(413);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      error: {
        code: 'GPT_ACCESS_VALIDATION_ERROR',
        message: 'The Backstage Booker canon request is invalid.',
      },
    }));
    expect(JSON.stringify(response.body)).not.toContain(sentinel);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(unsafeGateMock).not.toHaveBeenCalled();
  });

  it('admits a compact maximum-shape Unicode-escaped canon request', async () => {
    unsafeGatePassThrough = true;
    const escapedAstralCharacter = '\\uD83D\\uDE00';
    const participantNames = Array.from({ length: 50 }, (_value, index) => (
      `"${String(index).padStart(2, '0')}${escapedAstralCharacter.repeat(118)}"`
    )).join(',');
    const body = [
      '{"action":"upsertStoryline","payload":{',
      '"universeId":"phase-two",',
      '"mutationId":"8d64dad3-f080-4bac-88ec-994005dc7152",',
      '"expectedVersion":0,"storyline":{',
      `"key":"${escapedAstralCharacter.repeat(240)}",`,
      `"title":"${escapedAstralCharacter.repeat(240)}",`,
      `"summary":"${escapedAstralCharacter.repeat(10_000)}",`,
      '"status":"active",',
      `"participantNames":[${participantNames}]}}}`,
    ].join('');

    expect(Buffer.byteLength(body)).toBeGreaterThan(128 * 1024);
    expect(Buffer.byteLength(body)).toBeLessThan(BACKSTAGE_BOOKER_BODY_LIMIT_BYTES);
    const response = await sendAbsoluteFormRequest(createApp(), {
      body,
      headers: {
        Authorization: `Bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`,
      },
      method: 'POST',
      path: BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ dedicated: true });
  });

  it('mounts the exact boundary idempotently and counts the shared rate budget once', async () => {
    unsafeGatePassThrough = true;
    const app = createApp();
    const body = { action: 'upsertStoryline', payload: {} };

    const first = await request(app)
      .post(BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH)
      .set('Authorization', `Bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`)
      .send(body);
    const second = await request(app)
      .post(BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH)
      .set('Authorization', `Bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`)
      .send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toEqual({ dedicated: true });
    expect(second.body).toEqual({ dedicated: true });
    expect(Number(first.headers['x-ratelimit-remaining']))
      .toBe(Number(second.headers['x-ratelimit-remaining']) + 1);
    expect(first.headers['cache-control']).toContain('no-store');
    expect(unsafeGateMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    '/gpt-access/status',
    '/gpt-access/capabilities/v1/BACKSTAGE%3ABOOKER/run',
    '/gpt-access/capabilities/v1/backstage-booker/run/',
  ])('does not let the dedicated bearer authorize another GPT Access route: %s', async (
    path
  ) => {
    unsafeGatePassThrough = true;
    const pendingRequest = path === '/gpt-access/status'
      ? request(createApp()).get(path)
      : request(createApp()).post(path).send({
          action: 'upsertStoryline',
          payload: {},
        });
    const response = await pendingRequest.set(
      'Authorization',
      `Bearer ${BACKSTAGE_BOOKER_TEST_TOKEN}`
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED_GPT_ACCESS');
  });

  it('preserves generic GPT Access authentication on the exact route', async () => {
    unsafeGatePassThrough = true;
    const response = await globallyAuthorized(
      request(createApp()).post(BACKSTAGE_BOOKER_CAPABILITY_RUN_PATH)
    ).send({ action: 'upsertStoryline', payload: {} });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ dedicated: false });
  });
});

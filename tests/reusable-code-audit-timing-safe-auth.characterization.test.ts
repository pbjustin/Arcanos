import type {
  NextFunction,
  Request,
  Response,
} from 'express';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

const workerControlModuleMock = {
  dispatchWorkerInput: jest.fn(),
  getWorkerControlHealth: jest.fn(),
  getLatestWorkerJobDetail: jest.fn(),
  getWorkerControlStatus: jest.fn(),
  getWorkerJobDetailById: jest.fn(),
  healWorkerRuntime: jest.fn(),
  listRecentFailedWorkerJobs: jest.fn(),
  queueWorkerAsk: jest.fn(),
};

jest.unstable_mockModule('@core/db/index.js', () => ({
  getPool: jest.fn(),
  getStatus: jest.fn(),
  isDatabaseConnected: jest.fn(),
  query: jest.fn(),
  transaction: jest.fn(),
}));

jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  findOrCreateGptJob: jest.fn(),
  getJobById: jest.fn(),
  getJobQueueSummary: jest.fn(),
  recoverStaleJobs: jest.fn(),
  recoverStalledJobsForWorkers: jest.fn(),
  resolveJobWorkerStaleAfterMs: jest.fn(),
  IdempotencyKeyConflictError: class IdempotencyKeyConflictError extends Error {},
  JobRepositoryUnavailableError: class JobRepositoryUnavailableError extends Error {},
}));

jest.unstable_mockModule('@services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: {},
}));

jest.unstable_mockModule('@services/workerControlService.js', () => workerControlModuleMock);

jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({
  planAutonomousWorkerJob: jest.fn(),
}));

jest.unstable_mockModule('@services/selfHealRuntimeInspectionService.js', () => ({
  buildSafetySelfHealSnapshot: jest.fn(),
}));

jest.unstable_mockModule('@services/jobEventTimelineService.js', () => ({
  getJobEventTimeline: jest.fn(),
}));

jest.unstable_mockModule('@platform/runtime/workerConfig.js', () => ({
  getWorkerRuntimeStatus: jest.fn(),
}));

jest.unstable_mockModule('@dispatcher/naturalLanguage/planner.js', () => ({
  getNaturalLanguageDispatchRuntimeStatus: jest.fn(),
}));

jest.unstable_mockModule('@services/trinityStatusService.js', () => ({
  getTrinityStatus: jest.fn(),
}));

jest.unstable_mockModule('@services/arcanosDagRunService.js', () => ({
  arcanosDagRunService: {
    getFeatureFlags: jest.fn(),
    getExecutionLimits: jest.fn(),
    createRun: jest.fn(),
    waitForRunUpdate: jest.fn(),
    getRunTrace: jest.fn(),
  },
}));

jest.unstable_mockModule('@services/queuedGptCompletionService.js', () => ({
  resolveAsyncGptPollIntervalMs: jest.fn(),
  resolveAsyncGptWaitForResultMs: jest.fn(),
  waitForQueuedGptJobCompletion: jest.fn(),
}));

jest.unstable_mockModule('@services/selfImprove/selfHealTelemetry.js', () => ({
  recordSelfHealEvent: jest.fn(),
  inferSelfHealComponentFromAction: jest.fn(() => 'worker_runtime'),
  inferSelfHealComponentFromRequest: jest.fn(() => 'worker_runtime'),
  buildSelfHealTelemetrySnapshot: jest.fn(),
  buildCompactSelfHealSummary: jest.fn(),
}));

jest.unstable_mockModule('@platform/logging/auditLogger.js', () => ({
  auditLogger: {
    log: jest.fn(),
  },
}));

const { validateCustomGptBridgeSecret } = await import(
  '../src/services/customGptBridgeService.js'
);
const { evaluateControlPlaneApproval } = await import(
  '../src/services/controlPlane/approval.js'
);
const { gptAccessAuthMiddleware } = await import(
  '../src/services/gptAccessGateway.js'
);
const { assertGptCanUseDag } = await import(
  '../src/services/gptDagBridge.js'
);
const { authorizeRootDeepDiagnosticsRequest } = await import(
  '../src/services/rootDeepDiagnosticsBridge.js'
);
const workerHelperRouter = (await import('../src/routes/worker-helper.js')).default;

const originalEnv = { ...process.env };
const secret = ['audit', 'sécret', '7Qx9'].join('-');
const sameLengthWrongSecret = `${secret.slice(0, -1)}0`;

interface ResponseObservation {
  body: unknown;
  headers: Record<string, string>;
  statusCode: number;
}

function restoreEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
}

function buildResponseRecorder(): {
  observation: ResponseObservation;
  response: Response;
} {
  const observation: ResponseObservation = {
    body: undefined,
    headers: {},
    statusCode: 200,
  };
  const response = {
    status(code: number) {
      observation.statusCode = code;
      return response;
    },
    json(body: unknown) {
      observation.body = body;
      return response;
    },
    send(body: unknown) {
      observation.body = body;
      return response;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      observation.headers[name.toLowerCase()] = String(value);
      return response;
    },
    set(name: string, value: string) {
      observation.headers[name.toLowerCase()] = value;
      return response;
    },
  } as unknown as Response;
  return { observation, response };
}

function buildHeaderRequest(
  authorization: unknown,
  logger?: {
    error: ReturnType<typeof jest.fn>;
    info: ReturnType<typeof jest.fn>;
    warn: ReturnType<typeof jest.fn>;
  },
): Request {
  return {
    originalUrl: '/gpt-access/capabilities/v1?include=summary',
    header(name: string) {
      return name.toLowerCase() === 'authorization'
        ? authorization as string | undefined
        : undefined;
    },
    logger,
  } as unknown as Request;
}

function assertNoCredentialMaterial(value: unknown, ...credentials: string[]): void {
  const serialized = JSON.stringify(value);
  const containsCredential = credentials.some((credential) => serialized.includes(credential));
  expect(containsCredential).toBe(false);
}

async function observeMcpAuth(expectedToken: string, authorization: unknown) {
  process.env.MCP_BEARER_TOKEN = expectedToken;
  process.env.MCP_ALLOWED_ORIGINS = '';
  let observation: ResponseObservation | undefined;
  let nextCalls = 0;

  await jest.isolateModulesAsync(async () => {
    const { mcpAuthMiddleware } = await import('../src/mcp/auth.js');
    const recorder = buildResponseRecorder();
    observation = recorder.observation;
    mcpAuthMiddleware(
      buildHeaderRequest(authorization),
      recorder.response,
      (() => {
        nextCalls += 1;
      }) as NextFunction,
    );
  });

  return {
    allowed: nextCalls === 1,
    observation: observation!,
  };
}

function observeGptAccess(expectedToken: string | undefined, authorization: unknown) {
  if (expectedToken === undefined) {
    delete process.env.ARCANOS_GPT_ACCESS_TOKEN;
  } else {
    process.env.ARCANOS_GPT_ACCESS_TOKEN = expectedToken;
  }
  const logger = {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  };
  const recorder = buildResponseRecorder();
  let nextCalls = 0;

  gptAccessAuthMiddleware(
    buildHeaderRequest(authorization, logger),
    recorder.response,
    (() => {
      nextCalls += 1;
    }) as NextFunction,
  );

  return {
    allowed: nextCalls === 1,
    logs: logger,
    observation: recorder.observation,
  };
}

function observeDagAuth(
  expectedToken: string | undefined,
  authorization: unknown,
  fallbackToken?: string,
) {
  process.env.GPT_DAG_BRIDGE_ENABLED = 'true';
  process.env.GPT_DAG_BRIDGE_ALLOWED_GPTS = 'arcanos-core';
  process.env.GPT_DAG_BRIDGE_REQUIRE_AUTH = 'true';
  delete process.env.GPT_DAG_BRIDGE_REQUIRE_PERMISSIONS;
  if (fallbackToken === undefined) {
    delete process.env.OPENAI_ACTION_SHARED_SECRET;
  } else {
    process.env.OPENAI_ACTION_SHARED_SECRET = fallbackToken;
  }
  if (expectedToken === undefined) {
    delete process.env.GPT_DAG_BRIDGE_BEARER_TOKEN;
  } else {
    process.env.GPT_DAG_BRIDGE_BEARER_TOKEN = expectedToken;
  }
  const logger = {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  };
  const result = assertGptCanUseDag(
    {
      req: buildHeaderRequest(authorization),
      requestId: 'reusable-audit-dag-request',
      traceId: 'reusable-audit-dag-trace',
      gptId: 'arcanos-core',
      action: 'dag.capabilities',
      normalizedBody: {},
      promptText: null,
      logger,
    },
    'dag.capabilities',
  );

  return {
    allowed: result === null,
    logs: logger,
    result,
  };
}

function observeRootAuth(expectedToken: string | undefined, authorization: unknown) {
  process.env.ENABLE_ROOT_DEEP_DIAGNOSTICS = 'true';
  process.env.ARCANOS_ROOT_DIAGNOSTIC_GPTS = 'arcanos-core';
  if (expectedToken === undefined) {
    delete process.env.ARCANOS_ADMIN_TOKEN;
  } else {
    process.env.ARCANOS_ADMIN_TOKEN = expectedToken;
  }
  return authorizeRootDeepDiagnosticsRequest(
    buildHeaderRequest(authorization),
    'arcanos-core',
  );
}

type ExpressLayer = {
  route?: {
    path?: string;
    stack?: Array<{
      handle?: (req: Request, res: Response, next: NextFunction) => void;
      name?: string;
    }>;
  };
};

function getWorkerHelperAuthMiddleware() {
  const routerStack = (workerHelperRouter as unknown as { stack: ExpressLayer[] }).stack;
  const routeLayer = routerStack.find(
    (layer) => layer.route?.path === '/worker-helper/jobs/latest',
  );
  const authLayer = routeLayer?.route?.stack?.find(
    (layer) => layer.name === 'requireWorkerHelperPrivilegedAuth',
  );
  if (!authLayer?.handle) {
    throw new Error('Worker-helper privileged auth middleware was not found.');
  }
  return authLayer.handle;
}

function observeWorkerHelperAuth(
  expectedToken: string | undefined,
  headers: Record<string, unknown>,
) {
  if (expectedToken === undefined) {
    delete process.env.ARCANOS_WORKER_HELPER_TOKEN;
  } else {
    process.env.ARCANOS_WORKER_HELPER_TOKEN = expectedToken;
  }
  const recorder = buildResponseRecorder();
  let nextCalls = 0;
  getWorkerHelperAuthMiddleware()(
    { headers } as unknown as Request,
    recorder.response,
    (() => {
      nextCalls += 1;
    }) as NextFunction,
  );
  return {
    allowed: nextCalls === 1,
    observation: recorder.observation,
  };
}

describe('reusable-code audit: timing-safe credential comparison characterization', () => {
  beforeEach(() => {
    restoreEnvironment();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    restoreEnvironment();
  });

  it('characterizes MCP full-header comparison, length handling, Unicode, whitespace, and configuration failure', async () => {
    const exact = await observeMcpAuth(secret, `Bearer ${secret}`);
    const wrongSameLength = await observeMcpAuth(secret, `Bearer ${sameLengthWrongSecret}`);
    const wrongLength = await observeMcpAuth(secret, `Bearer ${secret}x`);
    const lowerScheme = await observeMcpAuth(secret, `bearer ${secret}`);
    const extraWhitespace = await observeMcpAuth(secret, `Bearer  ${secret}`);
    const missing = await observeMcpAuth(secret, undefined);
    const unconfigured = await observeMcpAuth('', 'Bearer anything');
    const longToken = 'm'.repeat(4_096);
    const longExact = await observeMcpAuth(longToken, `Bearer ${longToken}`);

    expect(exact.allowed).toBe(true);
    expect(longExact.allowed).toBe(true);
    for (const denied of [wrongSameLength, wrongLength, lowerScheme, extraWhitespace, missing]) {
      expect(denied.allowed).toBe(false);
      expect(denied.observation.statusCode).toBe(401);
    }
    expect(unconfigured.allowed).toBe(false);
    expect(unconfigured.observation.statusCode).toBe(500);
    assertNoCredentialMaterial(
      [wrongSameLength.observation, wrongLength.observation, unconfigured.observation],
      secret,
      sameLengthWrongSecret,
      longToken,
    );
  });

  it('characterizes custom bridge digest comparison and Bearer precedence over the action-secret header', () => {
    const env = { OPENAI_ACTION_SHARED_SECRET: `  ${secret}  ` } as NodeJS.ProcessEnv;
    const exact = validateCustomGptBridgeSecret({
      authorization: `Bearer ${secret}`,
      env,
    });
    const normalizedBearer = validateCustomGptBridgeSecret({
      authorization: `  bearer   ${secret}  `,
      env,
    });
    const actionSecret = validateCustomGptBridgeSecret({
      actionSecret: `  ${secret}  `,
      env,
    });
    const bearerPrecedence = validateCustomGptBridgeSecret({
      authorization: `Bearer ${sameLengthWrongSecret}`,
      actionSecret: secret,
      env,
    });
    const caseMismatch = validateCustomGptBridgeSecret({
      authorization: `Bearer ${secret.toUpperCase()}`,
      env,
    });
    const differentLength = validateCustomGptBridgeSecret({
      authorization: `Bearer ${secret}x`,
      env,
    });
    const unconfigured = validateCustomGptBridgeSecret({
      authorization: `Bearer ${secret}`,
      env: {},
    });
    const longToken = 'c'.repeat(5_000);
    const longExact = validateCustomGptBridgeSecret({
      authorization: `Bearer ${longToken}`,
      env: { OPENAI_ACTION_SHARED_SECRET: longToken },
    });

    expect(exact.ok).toBe(true);
    expect(normalizedBearer.ok).toBe(true);
    expect(actionSecret.ok).toBe(true);
    expect(longExact.ok).toBe(true);
    expect(bearerPrecedence).toMatchObject({ ok: false, statusCode: 401 });
    expect(caseMismatch).toMatchObject({ ok: false, statusCode: 401 });
    expect(differentLength).toMatchObject({ ok: false, statusCode: 401 });
    expect(unconfigured).toMatchObject({ ok: false, statusCode: 503 });
    expect(() => validateCustomGptBridgeSecret({
      actionSecret: 123 as unknown as string,
      env,
    })).toThrow(TypeError);
    assertNoCredentialMaterial(
      [bearerPrecedence.body, caseMismatch.body, differentLength.body, unconfigured.body],
      secret,
      sameLengthWrongSecret,
      longToken,
    );
  });

  it('characterizes control-plane approval trimming, exact token matching, and out-of-contract input errors', () => {
    const evaluate = (approvalToken: unknown, configuredToken = secret) =>
      evaluateControlPlaneApproval(
        { approvalToken } as never,
        true,
        () => configuredToken,
      );

    expect(evaluate(secret)).toEqual({ ok: true, status: 'approved' });
    expect(evaluate(`  ${secret}  `, `  ${secret}  `)).toEqual({
      ok: true,
      status: 'approved',
    });
    expect(evaluate(sameLengthWrongSecret)).toMatchObject({ ok: false, status: 'invalid' });
    expect(evaluate(`${secret}x`)).toMatchObject({ ok: false, status: 'invalid' });
    expect(evaluate(secret.toUpperCase())).toMatchObject({ ok: false, status: 'invalid' });
    expect(evaluate(undefined)).toMatchObject({ ok: false, status: 'missing' });
    expect(evaluate(secret, '   ')).toMatchObject({ ok: false, status: 'unconfigured' });
    expect(evaluateControlPlaneApproval({} as never, false, () => undefined)).toEqual({
      ok: true,
      status: 'not_required',
    });

    const longToken = 'p'.repeat(5_000);
    expect(evaluate(longToken, longToken)).toEqual({ ok: true, status: 'approved' });
    expect(() => evaluate(123)).toThrow(TypeError);
    assertNoCredentialMaterial(
      [evaluate(sameLengthWrongSecret), evaluate(undefined)],
      secret,
      sameLengthWrongSecret,
      longToken,
    );
  });

  it('characterizes GPT-access digest comparison, logging redaction, whitespace asymmetry, and the length cap', () => {
    const exact = observeGptAccess(secret, `Bearer ${secret}`);
    const lowerScheme = observeGptAccess(secret, `bearer ${secret}`);
    const trailingWhitespace = observeGptAccess(secret, `Bearer ${secret}   `);
    const leadingWhitespace = observeGptAccess(secret, `  Bearer ${secret}`);
    const wrongSameLength = observeGptAccess(secret, `Bearer ${sameLengthWrongSecret}`);
    const wrongLength = observeGptAccess(secret, `Bearer ${secret}x`);
    const caseMismatch = observeGptAccess(secret, `Bearer ${secret.toUpperCase()}`);
    const configuredWhitespace = observeGptAccess(` ${secret} `, `Bearer ${secret}`);
    const missing = observeGptAccess(secret, undefined);
    const unconfigured = observeGptAccess(undefined, `Bearer ${secret}`);
    const maxToken = 'g'.repeat(4_096);
    const overMaxToken = 'g'.repeat(4_097);
    const maxExact = observeGptAccess(maxToken, `Bearer ${maxToken}`);
    const overMax = observeGptAccess(overMaxToken, `Bearer ${overMaxToken}`);

    expect(exact.allowed).toBe(true);
    expect(lowerScheme.allowed).toBe(true);
    expect(trailingWhitespace.allowed).toBe(true);
    expect(maxExact.allowed).toBe(true);
    for (const denied of [
      leadingWhitespace,
      wrongSameLength,
      wrongLength,
      caseMismatch,
      configuredWhitespace,
      missing,
      overMax,
    ]) {
      expect(denied.allowed).toBe(false);
      expect(denied.observation.statusCode).toBe(401);
    }
    expect(unconfigured.allowed).toBe(false);
    expect(unconfigured.observation.statusCode).toBe(500);
    expect(() => observeGptAccess(secret, 123)).toThrow(TypeError);

    const observableData = [
      wrongSameLength.observation,
      wrongSameLength.logs.warn.mock.calls,
      configuredWhitespace.observation,
      configuredWhitespace.logs.warn.mock.calls,
      unconfigured.observation,
      unconfigured.logs.error.mock.calls,
    ];
    assertNoCredentialMaterial(
      observableData,
      secret,
      sameLengthWrongSecret,
      maxToken,
      overMaxToken,
    );
    expect(wrongSameLength.logs.warn).toHaveBeenCalledWith(
      'gpt_access.auth.failed',
      {
        route: '/gpt-access/capabilities/v1',
        reason: 'invalid_auth',
        statusCode: 401,
      },
    );
  });

  it('characterizes DAG bridge raw-buffer comparison, whitespace normalization, and fallback suppression', () => {
    const exact = observeDagAuth(secret, `Bearer ${secret}`);
    const normalizedBearer = observeDagAuth(`  ${secret}  `, `  bearer   ${secret}  `);
    const wrongSameLength = observeDagAuth(secret, `Bearer ${sameLengthWrongSecret}`);
    const wrongLength = observeDagAuth(secret, `Bearer ${secret}x`);
    const caseMismatch = observeDagAuth(secret, `Bearer ${secret.toUpperCase()}`);
    const missing = observeDagAuth(secret, undefined);
    const longToken = 'd'.repeat(5_000);
    const longExact = observeDagAuth(longToken, `Bearer ${longToken}`);

    const whitespacePrimarySuppressesFallback = observeDagAuth(
      '   ',
      `Bearer ${secret}`,
      secret,
    );

    expect(exact.allowed).toBe(true);
    expect(normalizedBearer.allowed).toBe(true);
    expect(longExact.allowed).toBe(true);
    for (const denied of [wrongSameLength, wrongLength, caseMismatch, missing]) {
      expect(denied.allowed).toBe(false);
      expect(denied.result?.statusCode).toBe(401);
    }
    expect(whitespacePrimarySuppressesFallback.allowed).toBe(false);
    expect(whitespacePrimarySuppressesFallback.result?.statusCode).toBe(503);
    expect(() => observeDagAuth(secret, 123)).toThrow(TypeError);
    expect(wrongSameLength.logs.warn).not.toHaveBeenCalled();
    assertNoCredentialMaterial(
      [
        wrongSameLength.result,
        caseMismatch.result,
        whitespacePrimarySuppressesFallback.result,
      ],
      secret,
      sameLengthWrongSecret,
      longToken,
    );
  });

  it('characterizes worker-helper header precedence, trimming, Unicode, and generic failure output', () => {
    const exactCustomHeader = observeWorkerHelperAuth(secret, {
      'x-arcanos-worker-helper-token': secret,
    });
    const exactBearer = observeWorkerHelperAuth(secret, {
      authorization: `bearer ${secret}`,
    });
    const trimmed = observeWorkerHelperAuth(`  ${secret}  `, {
      'x-arcanos-worker-helper-token': `  ${secret}  `,
    });
    const emptyCustomFallsBack = observeWorkerHelperAuth(secret, {
      'x-arcanos-worker-helper-token': '',
      authorization: `Bearer ${secret}`,
    });
    const whitespaceCustomBlocksFallback = observeWorkerHelperAuth(secret, {
      'x-arcanos-worker-helper-token': '   ',
      authorization: `Bearer ${secret}`,
    });
    const wrongSameLength = observeWorkerHelperAuth(secret, {
      'x-arcanos-worker-helper-token': sameLengthWrongSecret,
    });
    const wrongLength = observeWorkerHelperAuth(secret, {
      'x-arcanos-worker-helper-token': `${secret}x`,
    });
    const caseMismatch = observeWorkerHelperAuth(secret, {
      'x-arcanos-worker-helper-token': secret.toUpperCase(),
    });
    const missing = observeWorkerHelperAuth(secret, {});
    const longToken = 'w'.repeat(5_000);
    const longExact = observeWorkerHelperAuth(longToken, {
      'x-arcanos-worker-helper-token': longToken,
    });

    expect(exactCustomHeader.allowed).toBe(true);
    expect(exactBearer.allowed).toBe(true);
    expect(trimmed.allowed).toBe(true);
    expect(emptyCustomFallsBack.allowed).toBe(true);
    expect(longExact.allowed).toBe(true);
    for (const denied of [
      whitespaceCustomBlocksFallback,
      wrongSameLength,
      wrongLength,
      caseMismatch,
      missing,
    ]) {
      expect(denied.allowed).toBe(false);
      expect(denied.observation.statusCode).toBe(401);
      expect(denied.observation.body).toMatchObject({
        error: 'WORKER_HELPER_AUTH_REQUIRED',
      });
    }
    expect(() => observeWorkerHelperAuth(secret, {
      'x-arcanos-worker-helper-token': 123,
    })).toThrow(TypeError);
    assertNoCredentialMaterial(
      [
        whitespaceCustomBlocksFallback.observation,
        wrongSameLength.observation,
        caseMismatch.observation,
      ],
      secret,
      sameLengthWrongSecret,
      longToken,
    );
  });

  it('characterizes root diagnostics full-header comparison and non-string handling', () => {
    const exact = observeRootAuth(secret, `Bearer ${secret}`);
    const wrongSameLength = observeRootAuth(secret, `Bearer ${sameLengthWrongSecret}`);
    const wrongLength = observeRootAuth(secret, `Bearer ${secret}x`);
    const lowerScheme = observeRootAuth(secret, `bearer ${secret}`);
    const extraWhitespace = observeRootAuth(secret, `Bearer  ${secret}`);
    const missing = observeRootAuth(secret, undefined);
    const unconfigured = observeRootAuth(undefined, `Bearer ${secret}`);
    const configuredWhitespace = observeRootAuth(` ${secret} `, `Bearer  ${secret} `);
    const longToken = 'r'.repeat(5_000);
    const longExact = observeRootAuth(longToken, `Bearer ${longToken}`);
    const nonString = observeRootAuth(secret, 123);

    expect(exact).toEqual({ allowed: true });
    expect(configuredWhitespace).toEqual({ allowed: true });
    expect(longExact).toEqual({ allowed: true });
    expect(wrongSameLength).toEqual({ allowed: false, reason: 'authorization_mismatch' });
    expect(wrongLength).toEqual({ allowed: false, reason: 'authorization_mismatch' });
    expect(lowerScheme).toEqual({ allowed: false, reason: 'authorization_mismatch' });
    expect(extraWhitespace).toEqual({ allowed: false, reason: 'authorization_mismatch' });
    expect(missing).toEqual({ allowed: false, reason: 'authorization_missing' });
    expect(nonString).toEqual({ allowed: false, reason: 'authorization_missing' });
    expect(unconfigured).toEqual({ allowed: false, reason: 'admin_token_missing' });
    assertNoCredentialMaterial(
      [wrongSameLength, wrongLength, missing, unconfigured],
      secret,
      sameLengthWrongSecret,
      longToken,
    );
  });
});

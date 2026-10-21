import { jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  RAILWAY_PR_PREVIEW_CONTRACT,
  RailwayGraphqlApi,
  RailwayPrPreviewLifecycleError,
} from '../scripts/railway-pr-preview-lifecycle.mjs';

const CONTRACT = RAILWAY_PR_PREVIEW_CONTRACT;
const PRIVATE_SENTINEL = 'private-provider-body-prompt-canon-token-do-not-log';
const TOKEN = `test-workspace-token-${PRIVATE_SENTINEL}`;
const API_FAILURE = 'RAILWAY_PR_PREVIEW_API_FAILED';
const CATEGORY_PREFIX = 'RAILWAY_PREVIEW_';
const ENVIRONMENT_OPERATION = 'PreviewLifecycleEnvironments';
const DEPLOYMENT_OPERATION = 'PreviewLifecycleDeployment';
const DEPLOYMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ENVIRONMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const DEPLOYMENT_INPUT = Object.freeze({
  deploymentId: DEPLOYMENT_ID,
  environmentId: ENVIRONMENT_ID,
  serviceId: CONTRACT.services.worker.id,
  commitSha: 'a'.repeat(40),
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function providerError(code, message = PRIVATE_SENTINEL) {
  return {
    message,
    extensions: { code, traceId: PRIVATE_SENTINEL },
  };
}

function createApi(fetchImpl, sleepImpl = async () => undefined) {
  return new RailwayGraphqlApi({ token: TOKEN, fetchImpl, sleepImpl });
}

async function expectApiFailure(run, category, operation, httpStatus) {
  let failure;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(RailwayPrPreviewLifecycleError);
  expect(failure.code).toBe(API_FAILURE);
  expect(failure.message).toBe(API_FAILURE);
  expect(failure.diagnostic).toEqual({
    category: `${CATEGORY_PREFIX}${category}`,
    operation,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });
  expect(Object.isFrozen(failure.diagnostic)).toBe(true);
  for (const serialized of [JSON.stringify(failure), String(failure), failure.stack]) {
    expect(serialized).not.toContain(PRIVATE_SENTINEL);
    expect(serialized).not.toContain('authorization');
  }
  return failure;
}

describe('Railway preview API sanitized failure diagnostics', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    [401, 'AUTHENTICATION_FAILED'],
    [403, 'AUTHORIZATION_FAILED'],
    [429, 'RATE_LIMITED'],
    [500, 'API_UNEXPECTED_FAILURE'],
    [503, 'API_UNEXPECTED_FAILURE'],
    [418, 'API_UNEXPECTED_FAILURE'],
  ])('classifies HTTP %i without retaining its private response', async (status, category) => {
    const fetchImpl = jest.fn(async () => jsonResponse({
      errors: [providerError('PRIVATE_PROVIDER_CODE')],
      privateData: PRIVATE_SENTINEL,
    }, status));
    const api = createApi(fetchImpl);

    await expectApiFailure(
      () => api.listEnvironments(), category, ENVIRONMENT_OPERATION, status
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['UNAUTHENTICATED', 'AUTHENTICATION_FAILED'],
    ['UNAUTHORIZED', 'AUTHORIZATION_FAILED'],
    ['FORBIDDEN', 'AUTHORIZATION_FAILED'],
    ['GRAPHQL_PARSE_FAILED', 'GRAPHQL_VALIDATION_FAILED'],
    ['GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_VALIDATION_FAILED'],
    ['BAD_USER_INPUT', 'GRAPHQL_VALIDATION_FAILED'],
    ['INTERNAL_SERVER_ERROR', 'API_UNEXPECTED_FAILURE'],
    ['PRIVATE_PROVIDER_CODE', 'API_UNEXPECTED_FAILURE'],
  ])('classifies GraphQL %s without logging its code or message', async (code, category) => {
    const api = createApi(async () => jsonResponse({
      data: null,
      errors: [providerError(code)],
    }));

    await expectApiFailure(
      () => api.listEnvironments(), category, ENVIRONMENT_OPERATION, 200
    );
  });

  it('recognizes Railway exact authorization denial without echoing its text', async () => {
    const api = createApi(async () => jsonResponse({
      data: null,
      errors: [providerError('INTERNAL_SERVER_ERROR', 'Not Authorized')],
    }));

    const failure = await expectApiFailure(
      () => api.listEnvironments(), 'AUTHORIZATION_FAILED', ENVIRONMENT_OPERATION, 200
    );
    expect(JSON.stringify(failure)).not.toContain('Not Authorized');
  });

  it.each([null, {}, PRIVATE_SENTINEL, [null], [PRIVATE_SENTINEL]])(
    'rejects malformed GraphQL errors %p as an invalid response', async (errors) => {
      const api = createApi(async () => jsonResponse({ data: {}, errors }));

      await expectApiFailure(
        () => api.listEnvironments(), 'RESPONSE_INVALID', ENVIRONMENT_OPERATION, 200
      );
    }
  );

  it.each([null, [], PRIVATE_SENTINEL, 42])(
    'rejects a non-object GraphQL envelope %p', async (body) => {
      const api = createApi(async () => jsonResponse(body));

      await expectApiFailure(
        () => api.listEnvironments(), 'RESPONSE_INVALID', ENVIRONMENT_OPERATION, 200
      );
    }
  );

  it.each([undefined, null, [], PRIVATE_SENTINEL, 42])(
    'rejects missing or malformed GraphQL data %p', async (data) => {
      const api = createApi(async () => jsonResponse({ data }));

      await expectApiFailure(
        () => api.listEnvironments(), 'RESPONSE_INVALID', ENVIRONMENT_OPERATION, 200
      );
    }
  );

  it.each([
    ['malformed JSON', () => new Response(PRIVATE_SENTINEL)],
    ['invalid UTF-8', () => new Response(new Uint8Array([0xc3, 0x28]))],
    ['oversized body', () => new Response(JSON.stringify({
      data: { privateData: PRIVATE_SENTINEL, padding: 'x'.repeat(2 * 1024 * 1024) },
    }))],
    ['missing body', () => ({ ok: true, status: 200, body: null })],
  ])('classifies %s without retaining response bytes', async (_label, responseFactory) => {
    const api = createApi(async () => responseFactory());

    await expectApiFailure(
      () => api.listEnvironments(), 'RESPONSE_INVALID', ENVIRONMENT_OPERATION, 200
    );
  });

  it.each([
    ['network', () => new TypeError(PRIVATE_SENTINEL), 'NETWORK_FAILURE'],
    ['timeout', () => new DOMException(PRIVATE_SENTINEL, 'TimeoutError'), 'REQUEST_TIMEOUT'],
    ['abort', () => new DOMException(PRIVATE_SENTINEL, 'AbortError'), 'REQUEST_TIMEOUT'],
    ['unexpected', () => new Error(PRIVATE_SENTINEL), 'API_UNEXPECTED_FAILURE'],
  ])('classifies a fetch %s failure', async (_label, errorFactory, category) => {
    const api = createApi(async () => { throw errorFactory(); });

    await expectApiFailure(() => api.listEnvironments(), category, ENVIRONMENT_OPERATION);
  });

  it('uses the request signal to recognize a timeout with an opaque transport error', async () => {
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(
      AbortSignal.abort(new Error(PRIVATE_SENTINEL))
    );
    const api = createApi(async (_url, options) => {
      expect(options.signal.aborted).toBe(true);
      throw new Error(PRIVATE_SENTINEL);
    });

    await expectApiFailure(
      () => api.listEnvironments(), 'REQUEST_TIMEOUT', ENVIRONMENT_OPERATION
    );
  });

  it.each([
    ['network', () => new TypeError(PRIVATE_SENTINEL), 'NETWORK_FAILURE'],
    ['timeout', () => new DOMException(PRIVATE_SENTINEL, 'TimeoutError'), 'REQUEST_TIMEOUT'],
    ['abort', () => new DOMException(PRIVATE_SENTINEL, 'AbortError'), 'REQUEST_TIMEOUT'],
    ['unexpected', () => new Error(PRIVATE_SENTINEL), 'API_UNEXPECTED_FAILURE'],
  ])('classifies a response stream %s failure', async (_label, errorFactory, category) => {
    const api = createApi(async () => new Response(new ReadableStream({
      start(controller) { controller.error(errorFactory()); },
    })));

    await expectApiFailure(
      () => api.listEnvironments(), category, ENVIRONMENT_OPERATION, 200
    );
  });

  it('uses a static operation allowlist rather than reflecting arbitrary query names', async () => {
    const api = createApi(async () => jsonResponse({
      errors: [providerError('GRAPHQL_VALIDATION_FAILED')], data: null,
    }));

    await expectApiFailure(
      () => api.graphql(`query PreviewLifecycleAuthority { ${PRIVATE_SENTINEL} }`),
      'GRAPHQL_VALIDATION_FAILED', 'unknown', 200
    );
  });

  it('preserves the raw client response shape without adding diagnostic metadata', async () => {
    const body = { data: { safeFixture: true } };
    const api = createApi(async () => jsonResponse(body));
    await expect(api.requestRaw('query Fixture { safeFixture }')).resolves.toEqual(body);
  });

  it('prints only the sanitized CLI failure contract from an isolated mocked transport', () => {
    const preload = `globalThis.fetch = async () => new Response(${JSON.stringify(PRIVATE_SENTINEL)}, { status: 401 });`;
    const result = spawnSync(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      fileURLToPath(new URL('../scripts/railway-pr-preview-lifecycle.mjs', import.meta.url)),
      'discover',
    ], {
      encoding: 'utf8',
      timeout: 5_000,
      // Allowlist the child environment; no ambient credentials or real fetch.
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        GITHUB_REPOSITORY: CONTRACT.repository,
        GITHUB_TOKEN: 'synthetic-github-token-for-test-only',
        RAILWAY_API_TOKEN: TOKEN,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      schemaVersion: 1,
      kind: 'railway_pr_preview_lifecycle',
      summary: {
        status: 'FAIL',
        code: API_FAILURE,
        diagnostic: {
          category: `${CATEGORY_PREFIX}AUTHENTICATION_FAILED`,
          operation: 'PreviewLifecycleTokenType',
          httpStatus: 401,
        },
      },
    });
    expect(result.stderr).not.toContain(PRIVATE_SENTINEL);
    expect(result.stderr).not.toContain('synthetic-github-token');
  });

  it('accepts empty GraphQL errors on a valid environment inventory', async () => {
    const nodes = [
      { id: CONTRACT.baseEnvironmentId, name: CONTRACT.baseEnvironmentName },
      { id: CONTRACT.productionEnvironmentId, name: 'production' },
    ].map(node => ({ ...node, projectId: CONTRACT.projectId }));
    const api = createApi(async () => jsonResponse({
      errors: [],
      data: { environments: {
        edges: nodes.map(node => ({ node })),
        pageInfo: { hasNextPage: false, endCursor: null },
      } },
    }));

    await expect(api.listEnvironments()).resolves.toEqual(nodes);
  });

  it('keeps the expected workspace-token me denial and verifies pinned authority next', async () => {
    const operations = [];
    const authority = {
      apiToken: { workspaces: [{ id: CONTRACT.workspaceId }] },
      project: {
        id: CONTRACT.projectId,
        workspaceId: CONTRACT.workspaceId,
        primaryEnvironmentId: CONTRACT.productionEnvironmentId,
        baseEnvironmentId: null,
        prDeploys: false,
      },
    };
    const api = createApi(async (_url, options) => {
      const { query, variables } = JSON.parse(options.body);
      operations.push(query);
      if (query.includes('PreviewLifecycleTokenType')) {
        return jsonResponse({ data: { me: null }, errors: [
          providerError('INTERNAL_SERVER_ERROR', 'Not Authorized'),
        ] });
      }
      expect(variables).toEqual({ projectId: CONTRACT.projectId });
      return jsonResponse({ data: authority });
    });

    await expect(api.validateAuthority({ requireNativeDisabled: true }))
      .resolves.toEqual(authority.project);
    expect(operations).toHaveLength(2);
    expect(operations[0]).toContain('PreviewLifecycleTokenType');
    expect(operations[1]).toContain('PreviewLifecycleAuthority');
  });

  it('does not mistake an expired credential denial for proven workspace authority', async () => {
    const operations = [];
    const api = createApi(async (_url, options) => {
      const { query } = JSON.parse(options.body);
      operations.push(query);
      return jsonResponse({ data: null, errors: [providerError('UNAUTHENTICATED')] });
    });

    const failure = await expectApiFailure(
      () => api.validateAuthority({ requireNativeDisabled: true }),
      'AUTHENTICATION_FAILED', 'PreviewLifecycleTokenType', 200
    );
    expect(operations).toHaveLength(1);
    expect(Object.keys(failure.diagnostic).sort()).toEqual([
      'category', 'httpStatus', 'operation',
    ]);
  });

  it('does not let a workspace-shaped token probe bypass failed authority validation', async () => {
    const operations = [];
    const api = createApi(async (_url, options) => {
      const { query } = JSON.parse(options.body);
      operations.push(query);
      if (operations.length === 1) {
        return jsonResponse({ data: { me: null }, errors: [
          providerError('INTERNAL_SERVER_ERROR', 'Not Authorized'),
        ] });
      }
      return jsonResponse({ data: null, errors: [providerError('FORBIDDEN')] });
    });

    await expectApiFailure(
      () => api.validateAuthority({ requireNativeDisabled: true }),
      'AUTHORIZATION_FAILED', 'PreviewLifecycleAuthority', 200
    );
    expect(operations).toHaveLength(2);
    expect(operations.every(query => query.trimStart().startsWith('query '))).toBe(true);
  });

  it.each([
    [[providerError('INTERNAL_SERVER_ERROR')], 'API_UNEXPECTED_FAILURE'],
    [[providerError('FORBIDDEN'), providerError('INTERNAL_SERVER_ERROR')], 'API_UNEXPECTED_FAILURE'],
    [[providerError('FORBIDDEN'), providerError('GRAPHQL_VALIDATION_FAILED')], 'GRAPHQL_VALIDATION_FAILED'],
  ])('does not treat an ambiguous token probe as workspace proof (%#)', async (errors, category) => {
    const fetchImpl = jest.fn(async () => jsonResponse({ data: { me: null }, errors }));
    const api = createApi(fetchImpl);
    await expectApiFailure(
      () => api.validateAuthority({ requireNativeDisabled: true }),
      category, 'PreviewLifecycleTokenType', 200
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([42, PRIVATE_SENTINEL, [], true])(
    'rejects malformed token-probe data even with a known denial (%p)', async data => {
      const fetchImpl = jest.fn(async () => jsonResponse({ data, errors: [
        providerError('INTERNAL_SERVER_ERROR', 'Not Authorized'),
      ] }));
      const api = createApi(fetchImpl);
      await expectApiFailure(
        () => api.validateAuthority({ requireNativeDisabled: true }),
        'RESPONSE_INVALID', 'PreviewLifecycleTokenType', 200
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  );
});

describe('Railway preview deployment observation retry classification', () => {
  it.each([
    ['authentication', () => jsonResponse({ errors: [providerError('UNAUTHENTICATED')] }),
      'AUTHENTICATION_FAILED', 200],
    ['authorization', () => jsonResponse({ errors: [providerError('FORBIDDEN')] }),
      'AUTHORIZATION_FAILED', 200],
    ['HTTP authentication', () => jsonResponse({}, 401), 'AUTHENTICATION_FAILED', 401],
    ['HTTP authorization', () => jsonResponse({}, 403), 'AUTHORIZATION_FAILED', 403],
    ['schema', () => jsonResponse({ errors: [providerError('GRAPHQL_VALIDATION_FAILED')] }),
      'GRAPHQL_VALIDATION_FAILED', 200],
    ['response', () => jsonResponse({ data: null }), 'RESPONSE_INVALID', 200],
    ['unknown provider', () => jsonResponse({ errors: [providerError('INTERNAL_SERVER_ERROR')] }),
      'API_UNEXPECTED_FAILURE', 200],
  ])('does not retry permanent %s failures', async (_label, responseFactory, category, status) => {
    const fetchImpl = jest.fn(async () => responseFactory());
    const sleepImpl = jest.fn(async () => undefined);
    const api = createApi(fetchImpl, sleepImpl);

    await expectApiFailure(
      () => api.waitForDeployment(DEPLOYMENT_INPUT), category, DEPLOYMENT_OPERATION, status
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['network', async () => { throw new TypeError(PRIVATE_SENTINEL); }],
    ['timeout', async () => { throw new DOMException(PRIVATE_SENTINEL, 'TimeoutError'); }],
    ['rate limit', async () => jsonResponse({}, 429)],
    ['server', async () => jsonResponse({}, 503)],
  ])('retains a bounded retry for a transient %s read', async (_label, failFirst) => {
    const fetchImpl = jest.fn()
      .mockImplementationOnce(failFirst)
      .mockImplementation(async () => jsonResponse({ data: { deployment: {
        id: DEPLOYMENT_ID,
        projectId: CONTRACT.projectId,
        environmentId: ENVIRONMENT_ID,
        serviceId: CONTRACT.services.worker.id,
        status: 'FAILED',
      } } }));
    const sleepImpl = jest.fn(async () => undefined);
    const api = createApi(fetchImpl, sleepImpl);

    await expect(api.waitForDeployment(DEPLOYMENT_INPUT)).rejects.toThrow(
      'RAILWAY_PR_PREVIEW_DEPLOYMENT_FAILED'
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });

  it('stops after the existing five transient observation retries', async () => {
    const fetchImpl = jest.fn(async () => { throw new TypeError(PRIVATE_SENTINEL); });
    const sleepImpl = jest.fn(async () => undefined);
    const api = createApi(fetchImpl, sleepImpl);

    await expect(api.waitForDeployment(DEPLOYMENT_INPUT)).rejects.toThrow(
      'RAILWAY_PR_PREVIEW_DEPLOYMENT_OBSERVATION_FAILED'
    );
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(sleepImpl).toHaveBeenCalledTimes(5);
  });
});

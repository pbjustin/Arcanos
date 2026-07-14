import { describe, expect, it } from '@jest/globals';

import { RAILWAY_PRODUCTION_BASE_URL } from '../scripts/railway-fast-path-probe.js';
import {
  buildFailureReport,
  parseArgs,
  resolveExecutionPolicy,
  runValidation,
} from '../scripts/validate-gpt-job-hardening.js';

const PREVIEW_BASE_URL = 'https://arcanos-v2-arcanos-pr-1395.up.railway.app';
const PREVIEW_ENVIRONMENT = 'Arcanos-pr-1395';
const ACCESS_TOKEN = 'validator-test-access-token-123456789';

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map([['content-type', 'application/json']]),
    text: async () => JSON.stringify(body),
  };
}

function buildOpenApi(baseUrl) {
  return {
    openapi: '3.1.0',
    servers: [{ url: baseUrl }],
    paths: {
      '/gpt-access/jobs/create': {
        post: {
          operationId: 'createAiJob',
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateAiJobRequest' },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        CreateAiJobRequest: {
          type: 'object',
          additionalProperties: false,
          properties: {
            gptId: { type: 'string' },
            task: { type: 'string' },
            input: { type: 'object' },
          },
        },
      },
    },
  };
}

function buildLiveArgs({
  baseUrl = PREVIEW_BASE_URL,
  target = 'preview',
  environment = PREVIEW_ENVIRONMENT,
  allowProduction = false,
  includeServices = false,
} = {}) {
  return [
    '--execute',
    '--allow-network',
    ...(allowProduction ? ['--allow-production'] : []),
    '--base-url',
    baseUrl,
    '--target',
    target,
    '--environment',
    environment,
    ...(includeServices
      ? ['--service', 'ARCANOS V2', '--worker-service', 'ARCANOS Worker']
      : []),
    '--poll-attempts',
    '1',
  ];
}

function buildSuccessfulFetch(baseUrl, calls, healthBody = { ok: true }) {
  return async (url, options) => {
    const parsedUrl = new URL(String(url));
    calls.push({ url: parsedUrl.toString(), options });

    if (parsedUrl.pathname === '/gpt-access/health') {
      return jsonResponse(200, healthBody);
    }
    if (parsedUrl.pathname === '/gpt-access/openapi.json') {
      return jsonResponse(200, buildOpenApi(baseUrl));
    }
    if (parsedUrl.pathname === '/gpt-access/jobs/create') {
      return jsonResponse(202, {
        jobId: 'job-preview-1',
        traceId: 'trace-preview-1',
        status: 'queued',
      });
    }
    if (parsedUrl.pathname === '/gpt-access/jobs/result') {
      return jsonResponse(200, {
        jobId: 'job-preview-1',
        status: 'completed',
      });
    }

    throw new Error(`Unexpected mocked URL: ${parsedUrl.pathname}`);
  };
}

describe('validate-gpt-job-hardening execution policy', () => {
  it('is a truthful zero-network dry run even with ambient production URL and token variables', async () => {
    const fetchCalls = [];
    const railwayCalls = [];
    const config = parseArgs([], {
      BACKEND_URL: RAILWAY_PRODUCTION_BASE_URL,
      ARCANOS_GPT_ACCESS_BASE_URL: RAILWAY_PRODUCTION_BASE_URL,
      ARCANOS_GPT_ACCESS_TOKEN: ACCESS_TOKEN,
    });

    const report = await runValidation(config, {
      fetchFn: async (...args) => {
        fetchCalls.push(args);
        throw new Error('fetch must not run');
      },
      railwayExecutor: (...args) => {
        railwayCalls.push(args);
        throw new Error('Railway must not run');
      },
    });

    expect(config.baseUrl).toBe('');
    expect(report).toMatchObject({
      mode: 'DRY_RUN',
      executed: false,
      networkAttempted: false,
      summary: { overall: 'DRY_RUN', failedChecks: 0 },
    });
    expect(fetchCalls).toHaveLength(0);
    expect(railwayCalls).toHaveLength(0);
  });

  it.each([
    [['--execute'], 'both --execute and --allow-network'],
    [['--allow-network'], 'both --execute and --allow-network'],
    [['--execute', '--allow-network'], 'explicit --base-url, --target, and --environment'],
    [['--base-url', PREVIEW_BASE_URL], 'arguments together'],
  ])('rejects incomplete live configuration before network access: %j', async (args, message) => {
    const calls = [];
    const config = parseArgs(args, { ARCANOS_GPT_ACCESS_TOKEN: ACCESS_TOKEN });

    await expect(runValidation(config, {
      fetchFn: async (...fetchArgs) => {
        calls.push(fetchArgs);
        throw new Error('fetch must not run');
      },
      railwayExecutor: (...railwayArgs) => {
        calls.push(railwayArgs);
        throw new Error('Railway must not run');
      },
    })).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it.each([
    [['--unknown'], 'Unknown argument'],
    [['--base-url'], 'Missing value'],
    [['--target', 'preview', '--target', 'preview'], 'Duplicate argument'],
    [['--poll-attempts', '0'], 'positive integer'],
    [['--access-token', ACCESS_TOKEN], 'Do not pass GPT Access tokens'],
  ])('strictly rejects invalid arguments: %j', (args, message) => {
    expect(() => parseArgs(args, {})).toThrow(message);
  });

  it.each([
    [
      buildLiveArgs({
        baseUrl: RAILWAY_PRODUCTION_BASE_URL,
        target: 'production',
        environment: 'production',
      }),
      'repository-known production URL',
    ],
    [
      buildLiveArgs({
        baseUrl: 'https://untrusted-production.example.com',
        target: 'production',
        environment: 'production',
        allowProduction: true,
      }),
      'repository-known production URL',
    ],
    [
      buildLiveArgs({
        baseUrl: RAILWAY_PRODUCTION_BASE_URL,
        target: 'preview',
        environment: PREVIEW_ENVIRONMENT,
      }),
      'canonical HTTPS Railway PR hostname',
    ],
    [
      buildLiveArgs({
        baseUrl: 'https://arcanos-v2-arcanos-pr-13950.up.railway.app',
      }),
      'canonical HTTPS Railway PR hostname',
    ],
    [
      buildLiveArgs({
        baseUrl: 'https://arcanos-v2-arcanos-pr-1395.extra.up.railway.app',
      }),
      'canonical HTTPS Railway PR hostname',
    ],
    [
      buildLiveArgs({
        baseUrl: 'https://attacker-arcanos-pr-1395.up.railway.app',
      }),
      'canonical HTTPS Railway PR hostname',
    ],
    [
      buildLiveArgs({
        baseUrl: `${PREVIEW_BASE_URL}:8443`,
      }),
      'canonical HTTPS Railway PR hostname',
    ],
    [
      buildLiveArgs({
        baseUrl: `${PREVIEW_BASE_URL}/private`,
      }),
      'must not contain a path',
    ],
    [
      buildLiveArgs({
        baseUrl: `https://user:password@${new URL(PREVIEW_BASE_URL).hostname}`,
      }),
      'must not contain credentials',
    ],
    [
      buildLiveArgs({
        baseUrl: `${PREVIEW_BASE_URL}?token=value`,
      }),
      'query string or fragment',
    ],
  ])('rejects unsafe or mismatched targets before any outbound call', async (args, message) => {
    const calls = [];
    const config = parseArgs(args, { ARCANOS_GPT_ACCESS_TOKEN: ACCESS_TOKEN });

    await expect(runValidation(config, {
      fetchFn: async (...fetchArgs) => {
        calls.push(fetchArgs);
        throw new Error('fetch must not run');
      },
      railwayExecutor: (...railwayArgs) => {
        calls.push(railwayArgs);
        throw new Error('Railway must not run');
      },
    })).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it('allows only exact loopback hosts for a local target', () => {
    const allowed = parseArgs(buildLiveArgs({
      baseUrl: 'http://127.0.0.1:8080',
      target: 'local',
      environment: 'local',
    }), { ARCANOS_GPT_ACCESS_TOKEN: ACCESS_TOKEN });
    const rejected = parseArgs(buildLiveArgs({
      baseUrl: 'http://127.0.0.2:8080',
      target: 'local',
      environment: 'local',
    }), { ARCANOS_GPT_ACCESS_TOKEN: ACCESS_TOKEN });

    expect(resolveExecutionPolicy(allowed)).toMatchObject({
      mode: 'EXECUTE',
      baseUrl: 'http://127.0.0.1:8080',
      target: 'local',
    });
    expect(() => resolveExecutionPolicy(rejected)).toThrow('exact loopback hostname');
  });

  it('does not allow local validation to contact Railway for logs', () => {
    const config = parseArgs(buildLiveArgs({
      baseUrl: 'http://localhost:8080',
      target: 'local',
      environment: 'local',
      includeServices: true,
    }), { ARCANOS_GPT_ACCESS_TOKEN: ACCESS_TOKEN });

    expect(() => resolveExecutionPolicy(config)).toThrow('cannot request Railway service logs');
  });

  it('redacts an opaque configured credential embedded in an execution exception', () => {
    const report = buildFailureReport(
      new Error(`mock transport failed with ${ACCESS_TOKEN}`),
      {
        gatewayCredential: ACCESS_TOKEN,
        executionPolicy: { executed: true },
      }
    );
    const rendered = JSON.stringify(report);

    expect(report).toMatchObject({
      mode: 'EXECUTION_ERROR',
      executed: true,
      networkAttempted: true,
    });
    expect(rendered).not.toContain(ACCESS_TOKEN);
    expect(rendered).toContain('[REDACTED_SECRET_VALUE]');
  });

  it('keeps parse-time failure reports credential-safe', () => {
    let parseError;
    try {
      parseArgs(['--access-token', ACCESS_TOKEN], {
        ARCANOS_GPT_ACCESS_TOKEN: ACCESS_TOKEN,
      });
    } catch (error) {
      parseError = error;
    }

    const rendered = JSON.stringify(buildFailureReport(parseError, {
      gatewayCredential: ACCESS_TOKEN,
    }));
    expect(rendered).not.toContain(ACCESS_TOKEN);
    expect(rendered).toContain('Do not pass GPT Access tokens as CLI arguments.');
  });
});

describe('validate-gpt-job-hardening mocked execution', () => {
  it('completes the preview workflow through injected transports only', async () => {
    const fetchCalls = [];
    const railwayCalls = [];
    const config = parseArgs(buildLiveArgs({ includeServices: true }), {
      ARCANOS_GPT_ACCESS_TOKEN: ACCESS_TOKEN,
    });

    const report = await runValidation(config, {
      fetchFn: buildSuccessfulFetch(PREVIEW_BASE_URL, fetchCalls),
      railwayExecutor: (args) => {
        railwayCalls.push(args);
        return '';
      },
      sleepFn: async () => {},
      now: () => 1_784_017_791_319,
    });

    expect(report).toMatchObject({
      mode: 'EXECUTE',
      executed: true,
      networkAttempted: true,
      summary: { overall: 'PASS', failedChecks: 0 },
    });
    expect(fetchCalls.map(({ options }) => options.redirect)).toEqual([
      'manual',
      'manual',
      'manual',
      'manual',
    ]);
    expect(fetchCalls.map(({ options }) => options.method)).toEqual([
      'GET',
      'GET',
      'POST',
      'POST',
    ]);
    expect(railwayCalls).toHaveLength(4);
    expect(railwayCalls.every((args) => args.includes(PREVIEW_ENVIRONMENT))).toBe(true);
  });

  it('does not follow redirects or reach job creation', async () => {
    const fetchCalls = [];
    const config = parseArgs(buildLiveArgs(), {
      ARCANOS_GPT_ACCESS_TOKEN: ACCESS_TOKEN,
    });

    await expect(runValidation(config, {
      fetchFn: async (url, options) => {
        fetchCalls.push({ url, options });
        return jsonResponse(307, { redirect: true });
      },
    })).rejects.toThrow('Redirect responses are not allowed');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].options.redirect).toBe('manual');
    expect(fetchCalls[0].options.method).toBe('GET');
  });

  it('aborts before jobs/create when OpenAPI target attestation fails', async () => {
    const fetchCalls = [];
    const config = parseArgs(buildLiveArgs(), {
      ARCANOS_GPT_ACCESS_TOKEN: ACCESS_TOKEN,
    });
    const fetchFn = async (url, options) => {
      const parsedUrl = new URL(String(url));
      fetchCalls.push({ url: parsedUrl.toString(), options });
      if (parsedUrl.pathname === '/gpt-access/health') {
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(200, buildOpenApi('https://wrong-arcanos-pr-1395.up.railway.app'));
    };

    const report = await runValidation(config, { fetchFn });

    expect(report.summary.overall).toBe('FAIL');
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls.every(({ options }) => options.method === 'GET')).toBe(true);
  });

  it('aborts before OpenAPI and jobs/create when health attestation fails', async () => {
    const fetchCalls = [];
    const config = parseArgs(buildLiveArgs(), {
      ARCANOS_GPT_ACCESS_TOKEN: ACCESS_TOKEN,
    });
    const report = await runValidation(config, {
      fetchFn: async (url, options) => {
        fetchCalls.push({ url, options });
        return jsonResponse(503, { ok: false });
      },
    });

    expect(report.summary.overall).toBe('FAIL');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].options.method).toBe('GET');
  });

  it('keeps production compatibility behind the exact opt-in contract using mocks only', async () => {
    const fetchCalls = [];
    const config = parseArgs(buildLiveArgs({
      baseUrl: RAILWAY_PRODUCTION_BASE_URL,
      target: 'production',
      environment: 'production',
      allowProduction: true,
    }), { ARCANOS_GPT_ACCESS_TOKEN: ACCESS_TOKEN });

    const report = await runValidation(config, {
      fetchFn: buildSuccessfulFetch(RAILWAY_PRODUCTION_BASE_URL, fetchCalls),
      railwayExecutor: () => {
        throw new Error('Railway must remain skipped without service arguments');
      },
      sleepFn: async () => {},
      now: () => 1_784_017_791_320,
    });

    expect(report.summary.overall).toBe('PASS');
    expect(fetchCalls).toHaveLength(4);
    expect(fetchCalls.every(({ url }) => url.startsWith(RAILWAY_PRODUCTION_BASE_URL))).toBe(true);
  });

  it('omits secret-bearing health response bodies from deterministic output', async () => {
    const fetchCalls = [];
    const config = parseArgs(buildLiveArgs(), {
      ARCANOS_GPT_ACCESS_TOKEN: ACCESS_TOKEN,
    });
    const report = await runValidation(config, {
      fetchFn: buildSuccessfulFetch(PREVIEW_BASE_URL, fetchCalls, {
        ok: true,
        authorization: `Bearer ${ACCESS_TOKEN}`,
        nested: { opaqueValue: ACCESS_TOKEN },
      }),
      sleepFn: async () => {},
      now: () => 1_784_017_791_321,
    });

    const rendered = JSON.stringify(report);
    expect(rendered).not.toContain(ACCESS_TOKEN);
    expect(rendered).not.toContain('Bearer validator-test');
    expect(rendered).not.toContain('authorization');
    expect(rendered).not.toContain('nested');
  });
});

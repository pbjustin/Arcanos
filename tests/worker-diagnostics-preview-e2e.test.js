import { describe, expect, it, jest } from '@jest/globals';

import {
  CREDENTIAL_ENV_NAMES,
  FIXTURE_JSON_ENV_NAME,
  PINNED_RAILWAY_TARGET,
  WorkerDiagnosticsPreviewE2EError,
  buildFailureEvidence,
  issueJobReadCapability,
  parseArgs,
  readRailwayStatusJson,
  requestEndpoint,
  resolveExecutionPolicy,
  runProbe,
  sanitizeEvidence,
  validateFixtureMetadata,
  validateRailwayStatusAttestation,
  writeSanitizedEvidence,
} from '../scripts/worker-diagnostics-preview-e2e.mjs';

const TARGET = {
  baseUrl: 'https://worker-diagnostics-pr-1412-e2e.up.railway.app',
  projectId: PINNED_RAILWAY_TARGET.projectId,
  environment: 'worker-diagnostics-pr-1412-e2e',
  environmentId: '22222222-2222-4222-8222-222222222222',
  webServiceId: PINNED_RAILWAY_TARGET.webServiceId,
  webDeploymentId: '44444444-4444-4444-8444-444444444444',
  workerServiceId: PINNED_RAILWAY_TARGET.workerServiceId,
  workerDeploymentId: '55555555-5555-4555-8555-555555555555',
  repository: PINNED_RAILWAY_TARGET.repository,
  branch: PINNED_RAILWAY_TARGET.branch,
  commitSha: 'ade1388f8861c81944b666a03ad517e8553dc558',
};

const FIXTURE = {
  schemaVersion: 1,
  jobId: '523e4567-e89b-42d3-a456-426614174000',
  workerId: 'worker-diagnostics-e2e-sentinel',
  promptSentinel: 'WORKER_DIAGNOSTICS_PROMPT_SENTINEL',
  resultSentinel: 'WORKER_DIAGNOSTICS_RESULT_SENTINEL',
  errorSentinel: 'WORKER_DIAGNOSTICS_ERROR_SENTINEL',
  absolutePathSentinel: '/workspace/WORKER_DIAGNOSTICS_PATH_SENTINEL',
};

const TOKENS = {
  workerHelper: 'worker-helper-preview-token-1234567890',
  gptAccess: 'gpt-access-preview-token-123456789012',
  jobReadSecret: 'job-read-preview-secret-123456789012',
};

function targetArgs(extra = []) {
  return [
    '--base-url', TARGET.baseUrl,
    '--project-id', TARGET.projectId,
    '--environment', TARGET.environment,
    '--environment-id', TARGET.environmentId,
    '--web-service-id', TARGET.webServiceId,
    '--web-deployment-id', TARGET.webDeploymentId,
    '--worker-service-id', TARGET.workerServiceId,
    '--worker-deployment-id', TARGET.workerDeploymentId,
    '--branch', TARGET.branch,
    '--commit-sha', TARGET.commitSha,
    ...extra,
  ];
}

function railwayService({
  serviceId,
  deploymentId,
  domain = null,
  startCommand = PINNED_RAILWAY_TARGET.startCommand,
}) {
  return {
    environmentId: TARGET.environmentId,
    serviceId,
    serviceName: `service-${serviceId.slice(0, 8)}`,
    source: {
      image: null,
      repo: PINNED_RAILWAY_TARGET.repository,
    },
    startCommand,
    domains: {
      serviceDomains: domain ? [{ domain }] : [],
      customDomains: [],
    },
    latestDeployment: {
      id: deploymentId,
      status: 'SUCCESS',
      meta: {
        repo: PINNED_RAILWAY_TARGET.repository,
        branch: TARGET.branch,
        commitHash: TARGET.commitSha,
        serviceManifest: {
          deploy: {
            startCommand,
          },
        },
        fileServiceManifest: {
          deploy: {
            startCommand,
          },
        },
      },
    },
  };
}

function railwayStatus(overrides = {}) {
  const webService = railwayService({
    serviceId: TARGET.webServiceId,
    deploymentId: TARGET.webDeploymentId,
    domain: new URL(TARGET.baseUrl).hostname,
  });
  const workerService = railwayService({
    serviceId: TARGET.workerServiceId,
    deploymentId: TARGET.workerDeploymentId,
  });
  return {
    id: TARGET.projectId,
    name: 'Arcanos',
    environments: {
      edges: [{
        node: {
          id: TARGET.environmentId,
          name: TARGET.environment,
          canAccess: true,
          deletedAt: null,
          serviceInstances: {
            edges: [
              { node: webService },
              { node: workerService },
            ],
          },
          ...overrides.environment,
        },
      }],
    },
    ...overrides.root,
  };
}

function railwayStatusServices(status) {
  return status.environments.edges[0].node.serviceInstances.edges
    .map((edge) => edge.node);
}

function liveConfig(extra = []) {
  return parseArgs(targetArgs([
    '--execute',
    '--allow-network',
    ...extra,
  ]));
}

function probeEnvironment(overrides = {}) {
  return {
    [FIXTURE_JSON_ENV_NAME]: JSON.stringify(FIXTURE),
    [CREDENTIAL_ENV_NAMES.workerHelper]: TOKENS.workerHelper,
    [CREDENTIAL_ENV_NAMES.gptAccess]: TOKENS.gptAccess,
    [CREDENTIAL_ENV_NAMES.jobReadSecret]: TOKENS.jobReadSecret,
    ...overrides,
  };
}

function headers(values = {}) {
  const normalized = new Map(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    get(name) {
      return normalized.get(String(name).toLowerCase()) ?? null;
    },
  };
}

function jsonResponse(status, body, values = {}) {
  return {
    status,
    redirected: false,
    url: '',
    headers: headers({
      'content-type': 'application/json; charset=utf-8',
      ...values,
    }),
    text: async () => JSON.stringify(body),
  };
}

function textResponse(status, body, values = {}) {
  return {
    status,
    redirected: false,
    url: '',
    headers: headers(values),
    text: async () => body,
  };
}

function publicHealth(overrides = {}) {
  return {
    status: 'healthy',
    overallStatus: 'healthy',
    totalWorkers: 1,
    availableWorkers: 1,
    runtime: {
      status: 'disabled',
      totalDispatched: 1,
      startedAt: null,
      lastDispatchAt: '2026-07-30T12:00:00.000Z',
    },
    workers: {
      status: 'healthy',
      total: 1,
      available: 1,
      configured: 0,
      active: 0,
      observed: 1,
      stale: 0,
      degraded: 0,
      unhealthy: 0,
      lastHeartbeatAt: '2026-07-30T12:00:00.000Z',
    },
    queue: {
      status: 'idle',
      total: 1,
      pending: 0,
      running: 0,
      completed: 0,
      retainedFailed: 1,
      delayed: 0,
      stalledRunning: 0,
      lastUpdatedAt: '2026-07-30T12:00:00.000Z',
    },
    memory: {
      status: 'active',
      routes: 1,
      lastUpdatedAt: '2026-07-30T12:00:00.000Z',
    },
    timestamp: '2026-07-30T12:00:01.000Z',
    ...overrides,
  };
}

function failedJob() {
  return {
    id: FIXTURE.jobId,
    worker_id: FIXTURE.workerId,
    last_worker_id: FIXTURE.workerId,
    job_type: 'ask',
    status: 'failed',
    error_message: FIXTURE.errorSentinel,
    retry_count: 1,
    max_retries: 1,
    created_at: '2026-07-30T12:00:00.000Z',
    updated_at: '2026-07-30T12:00:00.000Z',
    completed_at: '2026-07-30T12:00:00.000Z',
  };
}

function workerDetail() {
  return {
    workerId: FIXTURE.workerId,
    workerType: 'async_queue',
    healthStatus: 'healthy',
    operationalStatus: 'healthy',
    activeJobs: [FIXTURE.jobId],
    dispatcherStarted: true,
    activeListeners: 1,
    lastClaimResult: FIXTURE.resultSentinel,
    disabledReason: FIXTURE.promptSentinel,
    currentJobId: FIXTURE.jobId,
    lastError: FIXTURE.errorSentinel,
  };
}

function buildSuccessfulFetch(calls) {
  const runtimeResult = {
    error: 'OpenAI adapter unavailable',
    workerId: 'arcanos-core-direct',
  };
  const noStore = { 'cache-control': 'no-store' };
  return async (url, options) => {
    const parsedUrl = new URL(String(url));
    const authorization = options.headers.authorization;
    const workerToken = options.headers['x-arcanos-worker-helper-token'];
    const jobToken = options.headers['x-arcanos-job-read-token'];
    calls.push({
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: options.method,
      redirect: options.redirect,
      authorization,
      workerToken,
      jobToken,
    });

    if (parsedUrl.pathname === '/gpt-access/health') {
      return jsonResponse(200, {
        ok: true,
        deployment: {
          provider: 'railway',
          projectId: TARGET.projectId,
          environmentId: TARGET.environmentId,
          environmentName: TARGET.environment,
          serviceId: TARGET.webServiceId,
          deploymentId: TARGET.webDeploymentId,
          gitCommitSha: TARGET.commitSha,
        },
      });
    }

    if (parsedUrl.pathname === '/worker-helper/dispatch') {
      const body = JSON.parse(options.body);
      expect(body).toEqual({
        input: FIXTURE.promptSentinel,
        attempts: 1,
        backoffMs: 0,
        sourceEndpoint: 'worker-diagnostics-preview-e2e',
      });
      return jsonResponse(200, {
        mode: 'direct-dispatch',
        input: FIXTURE.promptSentinel,
        primaryResult: runtimeResult,
        resultCount: 1,
        results: [runtimeResult],
      });
    }

    if ([
      '/worker-helper/status',
      '/worker-helper/health',
      '/workers/status',
      '/trinity/status',
    ].includes(parsedUrl.pathname)) {
      return jsonResponse(
        parsedUrl.pathname === '/trinity/status' ? 503 : 200,
        publicHealth(),
        noStore,
      );
    }

    if (parsedUrl.pathname === '/worker-helper/jobs/failed') {
      if (!workerToken) {
        return jsonResponse(401, {
          error: 'WORKER_HELPER_AUTH_REQUIRED',
          message: 'Worker helper privileged routes require authentication.',
        }, noStore);
      }
      return jsonResponse(200, {
        failedCountMode: 'retained_terminal_jobs',
        jobs: [failedJob()],
      }, noStore);
    }

    if (parsedUrl.pathname === '/gpt-access/workers/status') {
      if (!authorization) {
        return jsonResponse(401, {
          ok: false,
          error: { code: 'UNAUTHORIZED_GPT_ACCESS' },
        }, noStore);
      }
      return jsonResponse(200, {
        mainApp: {
          runtime: {
            lastInputPreview: FIXTURE.promptSentinel,
            lastResult: runtimeResult,
            lastError: runtimeResult.error,
          },
        },
        workerService: {
          latestJob: failedJob(),
          recentFailedJobs: [failedJob()],
          health: {
            workers: [workerDetail()],
          },
        },
      }, noStore);
    }

    if (parsedUrl.pathname === '/gpt-access/worker-helper/health') {
      return jsonResponse(200, {
        workers: [workerDetail()],
        recentFailedJobs: [failedJob()],
      }, noStore);
    }

    if (parsedUrl.pathname === `/jobs/${FIXTURE.jobId}`) {
      return jsonResponse(200, {
        id: FIXTURE.jobId,
        jobId: FIXTURE.jobId,
        job_type: 'ask',
        status: 'failed',
        error_message: FIXTURE.errorSentinel,
        output: {
          result: FIXTURE.resultSentinel,
          workersDirectory: FIXTURE.absolutePathSentinel,
        },
      }, noStore);
    }

    if (parsedUrl.pathname === `/jobs/${FIXTURE.jobId}/result`) {
      return jsonResponse(200, {
        jobId: FIXTURE.jobId,
        status: 'failed',
        result: {
          result: FIXTURE.resultSentinel,
          workersDirectory: FIXTURE.absolutePathSentinel,
        },
        error: {
          code: 'JOB_FAILED',
          message: FIXTURE.errorSentinel,
        },
      }, noStore);
    }

    if (parsedUrl.pathname === `/jobs/${FIXTURE.jobId}/stream`) {
      return textResponse(
        200,
        [
          'retry: 1000',
          '',
          'event: terminal',
          `data: ${JSON.stringify({
            id: FIXTURE.jobId,
            jobId: FIXTURE.jobId,
            status: 'failed',
            error_message: FIXTURE.errorSentinel,
            output: {
              result: FIXTURE.resultSentinel,
              workersDirectory: FIXTURE.absolutePathSentinel,
            },
          })}`,
          '',
        ].join('\n'),
        {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store, no-cache, no-transform',
          'x-accel-buffering': 'no',
        },
      );
    }

    throw new Error(`Unexpected test URL: ${parsedUrl.pathname}`);
  };
}

describe('worker diagnostics preview E2E target policy', () => {
  it('validates a complete explicit target without network access by default', async () => {
    const fetchFn = jest.fn(() => {
      throw new Error('network must not run');
    });
    const report = await runProbe(parseArgs(targetArgs()), {
      env: {
        [CREDENTIAL_ENV_NAMES.workerHelper]: TOKENS.workerHelper,
        [CREDENTIAL_ENV_NAMES.gptAccess]: TOKENS.gptAccess,
      },
      fetchFn,
    });

    expect(report).toMatchObject({
      mode: 'DRY_RUN',
      executed: false,
      networkAttempted: false,
      target: TARGET,
      summary: {
        status: 'DRY_RUN',
        code: 'EXPLICIT_TARGET_VALIDATED_NO_NETWORK',
      },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'partial identity',
      args: targetArgs().slice(0, -2),
      code: 'INCOMPLETE_EXPLICIT_TARGET',
    },
    {
      name: 'native PR environment',
      args: targetArgs().flatMap((value, index, values) =>
        values[index - 1] === '--environment' ? ['Arcanos-pr-1412'] : [value]),
      code: 'ENVIRONMENT_NOT_ISOLATED_PREVIEW',
    },
    {
      name: 'native PR host',
      args: targetArgs().flatMap((value, index, values) =>
        values[index - 1] === '--base-url'
          ? ['https://arcanos-v2-arcanos-pr-1412.up.railway.app']
          : [value]),
      code: 'TARGET_NOT_ISOLATED_PREVIEW',
    },
    {
      name: 'unrecognized preview environment',
      args: targetArgs().flatMap((value, index, values) =>
        values[index - 1] === '--environment'
          ? ['worker-diagnostics-preview-e2e']
          : [value]),
      code: 'ENVIRONMENT_NOT_ISOLATED_PREVIEW',
    },
    {
      name: 'production environment',
      args: targetArgs().flatMap((value, index, values) =>
        values[index - 1] === '--environment'
          ? ['worker-diagnostics-production-e2e']
          : [value]),
      code: 'ENVIRONMENT_NOT_ISOLATED_PREVIEW',
    },
    {
      name: 'production host',
      args: targetArgs().flatMap((value, index, values) =>
        values[index - 1] === '--base-url'
          ? ['https://arcanos-production-e2e.up.railway.app']
          : [value]),
      code: 'TARGET_NOT_ISOLATED_PREVIEW',
    },
    {
      name: 'malformed service id',
      args: targetArgs().flatMap((value, index, values) =>
        values[index - 1] === '--web-service-id'
          ? ['not-a-uuid']
          : [value]),
      code: 'RAILWAY_RESOURCE_ID_INVALID',
    },
    {
      name: 'malformed commit',
      args: targetArgs().flatMap((value, index, values) =>
        values[index - 1] === '--commit-sha' ? ['ade1388f'] : [value]),
      code: 'COMMIT_SHA_INVALID',
    },
    {
      name: 'unpinned project',
      args: targetArgs().flatMap((value, index, values) =>
        values[index - 1] === '--project-id'
          ? ['11111111-1111-4111-8111-111111111111']
          : [value]),
      code: 'PINNED_RAILWAY_TARGET_MISMATCH',
    },
    {
      name: 'unpinned branch',
      args: targetArgs().flatMap((value, index, values) =>
        values[index - 1] === '--branch' ? ['main'] : [value]),
      code: 'PINNED_RAILWAY_TARGET_MISMATCH',
    },
  ])('rejects $name', ({ args, code }) => {
    expect(() => resolveExecutionPolicy(parseArgs(args))).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it('requires the two live-network flags together and enforces hard limits', () => {
    expect(() => resolveExecutionPolicy(
      parseArgs(targetArgs(['--execute'])),
    )).toThrow(expect.objectContaining({
      code: 'NETWORK_AUTHORIZATION_FLAGS_MUST_MATCH',
    }));
    expect(() => resolveExecutionPolicy(
      parseArgs(targetArgs(['--request-timeout-ms', '10001'])),
    )).toThrow(expect.objectContaining({ code: 'PROBE_LIMIT_EXCEEDED' }));
  });

  it('has no CLI credential carrier', () => {
    expect(() => parseArgs(targetArgs([
      '--token',
      TOKENS.gptAccess,
    ]))).toThrow(expect.objectContaining({ code: 'UNKNOWN_ARGUMENT' }));
  });
});

describe('worker diagnostics preview E2E fixture and request safety', () => {
  it('accepts only the exact non-secret fixture schema', () => {
    expect(validateFixtureMetadata(FIXTURE)).toEqual(FIXTURE);
    expect(() => validateFixtureMetadata({
      ...FIXTURE,
      accessToken: TOKENS.gptAccess,
    })).toThrow(expect.objectContaining({ code: 'FIXTURE_KEYS_INVALID' }));
    expect(() => validateFixtureMetadata({
      ...FIXTURE,
      absolutePathSentinel: 'relative/path',
    })).toThrow(expect.objectContaining({
      code: 'FIXTURE_ABSOLUTE_PATH_INVALID',
    }));
  });

  it('issues the exact job-bound capability shape without returning its secret', () => {
    const capability = issueJobReadCapability(
      FIXTURE.jobId,
      TOKENS.jobReadSecret,
    );
    expect(capability).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/u);
    expect(capability).not.toContain(TOKENS.jobReadSecret);
  });

  it('refuses redirects and oversized bodies', async () => {
    const policy = resolveExecutionPolicy(parseArgs(targetArgs()));
    await expect(requestEndpoint(policy, { path: '/health' }, {
      fetchFn: async () => ({
        status: 302,
        redirected: false,
        url: '',
        headers: headers({ location: 'https://example.com/' }),
        text: async () => '',
      }),
    })).rejects.toMatchObject({ code: 'REDIRECT_REFUSED' });

    await expect(requestEndpoint({
      ...policy,
      maxResponseBytes: 8,
    }, { path: '/health' }, {
      fetchFn: async () => textResponse(200, '123456789', {
        'content-type': 'application/json',
      }),
    })).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });
});

describe('worker diagnostics preview E2E Railway attestation', () => {
  it('invokes only the fixed bounded Railway status command', async () => {
    const status = railwayStatus();
    const execFileFn = jest.fn(async () => ({
      stdout: JSON.stringify(status),
      stderr: `Authorization: Bearer ${TOKENS.gptAccess}`,
    }));

    await expect(readRailwayStatusJson({
      execFileFn,
      platform: 'linux',
    })).resolves.toEqual(status);
    expect(execFileFn).toHaveBeenCalledWith(
      'railway',
      ['status', '--json'],
      expect.objectContaining({
        encoding: 'utf8',
        windowsHide: true,
      }),
    );
  });

  it('accepts the exact pinned two-service deployment provenance', () => {
    expect(validateRailwayStatusAttestation(
      railwayStatus(),
      resolveExecutionPolicy(parseArgs(targetArgs())).target,
    )).toMatchObject({
      projectId: PINNED_RAILWAY_TARGET.projectId,
      webServiceId: PINNED_RAILWAY_TARGET.webServiceId,
      workerServiceId: PINNED_RAILWAY_TARGET.workerServiceId,
      repository: PINNED_RAILWAY_TARGET.repository,
      branch: PINNED_RAILWAY_TARGET.branch,
      deploymentStatus: 'SUCCESS',
      startCommand: PINNED_RAILWAY_TARGET.startCommand,
    });
  });

  it.each([
    {
      name: 'project id',
      code: 'RAILWAY_PROJECT_ATTESTATION_FAILED',
      mutate(status) {
        status.id = '11111111-1111-4111-8111-111111111111';
      },
    },
    {
      name: 'environment identity',
      code: 'RAILWAY_ENVIRONMENT_ATTESTATION_FAILED',
      mutate(status) {
        status.environments.edges[0].node.name = 'production';
      },
    },
    {
      name: 'web service id',
      code: 'RAILWAY_SERVICE_ATTESTATION_FAILED',
      mutate(status) {
        railwayStatusServices(status)[0].serviceId =
          '11111111-1111-4111-8111-111111111111';
      },
    },
    {
      name: 'worker service id',
      code: 'RAILWAY_SERVICE_ATTESTATION_FAILED',
      mutate(status) {
        railwayStatusServices(status)[1].serviceId =
          '11111111-1111-4111-8111-111111111111';
      },
    },
    {
      name: 'web domain',
      code: 'RAILWAY_WEB_DOMAIN_ATTESTATION_FAILED',
      mutate(status) {
        railwayStatusServices(status)[0].domains.serviceDomains[0].domain =
          'wrong-preview.up.railway.app';
      },
    },
    {
      name: 'web deployment id',
      code: 'RAILWAY_DEPLOYMENT_ATTESTATION_FAILED',
      mutate(status) {
        railwayStatusServices(status)[0].latestDeployment.id =
          '11111111-1111-4111-8111-111111111111';
      },
    },
    {
      name: 'worker deployment status',
      code: 'RAILWAY_DEPLOYMENT_ATTESTATION_FAILED',
      mutate(status) {
        railwayStatusServices(status)[1].latestDeployment.status = 'BUILDING';
      },
    },
    {
      name: 'source repository',
      code: 'RAILWAY_SERVICE_ATTESTATION_FAILED',
      mutate(status) {
        railwayStatusServices(status)[0].source.repo = 'attacker/fork';
      },
    },
    {
      name: 'deployment repository',
      code: 'RAILWAY_DEPLOYMENT_ATTESTATION_FAILED',
      mutate(status) {
        railwayStatusServices(status)[1].latestDeployment.meta.repo =
          'attacker/fork';
      },
    },
    {
      name: 'deployment branch',
      code: 'RAILWAY_DEPLOYMENT_ATTESTATION_FAILED',
      mutate(status) {
        railwayStatusServices(status)[0].latestDeployment.meta.branch = 'main';
      },
    },
    {
      name: 'deployment commit',
      code: 'RAILWAY_DEPLOYMENT_ATTESTATION_FAILED',
      mutate(status) {
        railwayStatusServices(status)[1].latestDeployment.meta.commitHash =
          '0000000000000000000000000000000000000000';
      },
    },
    {
      name: 'passive PR start command',
      code: 'RAILWAY_START_COMMAND_ATTESTATION_FAILED',
      mutate(status) {
        railwayStatusServices(status)[0].startCommand =
          'node scripts/start-railway-service.mjs --pr-preview-safe';
      },
    },
  ])('fails closed before HTTP on $name mismatch', async ({
    mutate,
    code,
  }) => {
    const status = railwayStatus();
    mutate(status);
    const fetchFn = jest.fn();

    await expect(runProbe(liveConfig(), {
      env: probeEnvironment(),
      railwayStatusFn: async () => status,
      fetchFn,
    })).rejects.toMatchObject({ code });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('worker diagnostics preview E2E live acceptance', () => {
  it('exercises exact auth carriers, public containment, operator detail, JSON jobs, and terminal SSE', async () => {
    const calls = [];
    const report = await runProbe(liveConfig(), {
      env: probeEnvironment(),
      railwayStatusFn: async () => railwayStatus(),
      fetchFn: buildSuccessfulFetch(calls),
    });

    expect(report).toMatchObject({
      mode: 'EXECUTE',
      executed: true,
      networkAttempted: true,
      summary: {
        status: 'PASS',
        code: 'WORKER_DIAGNOSTICS_PREVIEW_E2E_PASS',
        checksPassed: 15,
        requestsMade: 14,
      },
    });
    expect(report.fixture.jobIdSha256).toHaveLength(64);
    expect(report.fixture.workerIdSha256).toHaveLength(64);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        caseId: 'generic-job-status',
        cacheDirectivesChecked: ['no-store'],
      }),
      expect.objectContaining({
        caseId: 'generic-job-result',
        cacheDirectivesChecked: ['no-store'],
      }),
    ]));
    expect(JSON.stringify(report)).not.toContain(FIXTURE.jobId);
    for (const value of [
      ...Object.values(TOKENS),
      FIXTURE.promptSentinel,
      FIXTURE.resultSentinel,
      FIXTURE.errorSentinel,
      FIXTURE.absolutePathSentinel,
    ]) {
      expect(JSON.stringify(report)).not.toContain(value);
    }

    expect(calls).toHaveLength(14);
    expect(calls.every((call) => call.redirect === 'error')).toBe(true);

    const dispatch = calls.find((call) =>
      call.path === '/worker-helper/dispatch');
    expect(dispatch).toMatchObject({
      method: 'POST',
      authorization: undefined,
      workerToken: TOKENS.workerHelper,
    });

    const anonymousFailed = calls.find((call) =>
      call.path === '/worker-helper/jobs/failed?limit=not-a-number');
    expect(anonymousFailed).toMatchObject({
      authorization: undefined,
      workerToken: undefined,
    });
    const authenticatedFailed = calls.find((call) =>
      call.path === '/worker-helper/jobs/failed?limit=100');
    expect(authenticatedFailed.workerToken).toBe(TOKENS.workerHelper);

    const operatorCalls = calls.filter((call) =>
      call.path === '/gpt-access/workers/status');
    expect(operatorCalls).toHaveLength(2);
    expect(operatorCalls[0].authorization).toBeUndefined();
    expect(operatorCalls[1].authorization)
      .toBe(`Bearer ${TOKENS.gptAccess}`);

    const jobCalls = calls.filter((call) => call.path.startsWith('/jobs/'));
    expect(jobCalls).toHaveLength(3);
    expect(jobCalls.every((call) =>
      /^v1\.[A-Za-z0-9_-]{43}$/u.test(call.jobToken))).toBe(true);
    expect(jobCalls.every((call) => call.authorization === undefined)).toBe(true);
  });

  it.each([
    {
      name: 'status',
      path: `/jobs/${FIXTURE.jobId}`,
      code: 'JOB_STATUS_CACHE_POLICY_INVALID',
    },
    {
      name: 'result',
      path: `/jobs/${FIXTURE.jobId}/result`,
      code: 'JOB_RESULT_CACHE_POLICY_INVALID',
    },
  ])('fails when the generic job $name JSON response is cacheable', async ({
    path: targetPath,
    code,
  }) => {
    const successfulFetch = buildSuccessfulFetch([]);
    const fetchFn = async (url, options) => {
      const result = await successfulFetch(url, options);
      const parsedUrl = new URL(String(url));
      if (parsedUrl.pathname !== targetPath) {
        return result;
      }
      return {
        ...result,
        headers: headers({
          'content-type': 'application/json; charset=utf-8',
        }),
      };
    };

    await expect(runProbe(liveConfig(), {
      env: probeEnvironment(),
      railwayStatusFn: async () => railwayStatus(),
      fetchFn,
    })).rejects.toMatchObject({ code });
  });

  it('fails when a public response adds a forbidden diagnostic key', async () => {
    const successfulFetch = buildSuccessfulFetch([]);
    const fetchFn = async (url, options) => {
      const parsedUrl = new URL(String(url));
      if (parsedUrl.pathname === '/worker-helper/status') {
        return jsonResponse(200, publicHealth({
          latestJob: { id: FIXTURE.jobId },
        }), { 'cache-control': 'no-store' });
      }
      return successfulFetch(url, options);
    };

    await expect(runProbe(liveConfig(), {
      env: probeEnvironment(),
      railwayStatusFn: async () => railwayStatus(),
      fetchFn,
    })).rejects.toMatchObject({ code: 'PUBLIC_ALLOWLIST_MISMATCH' });
  });

  it('fails if direct dispatch does not prove the adapter-unavailable provider-free path', async () => {
    const successfulFetch = buildSuccessfulFetch([]);
    const fetchFn = async (url, options) => {
      const parsedUrl = new URL(String(url));
      if (parsedUrl.pathname === '/worker-helper/dispatch') {
        return jsonResponse(200, {
          mode: 'direct-dispatch',
          input: FIXTURE.promptSentinel,
          primaryResult: { result: 'provider-backed-response' },
        });
      }
      return successfulFetch(url, options);
    };

    await expect(runProbe(liveConfig(), {
      env: probeEnvironment(),
      railwayStatusFn: async () => railwayStatus(),
      fetchFn,
    })).rejects.toMatchObject({ code: 'PROVIDER_FREE_DISPATCH_FAILED' });
  });

  it('requires the absolute-path sentinel in capability-protected job output', async () => {
    const successfulFetch = buildSuccessfulFetch([]);
    const fetchFn = async (url, options) => {
      const parsedUrl = new URL(String(url));
      if (parsedUrl.pathname === `/jobs/${FIXTURE.jobId}`) {
        return jsonResponse(200, {
          id: FIXTURE.jobId,
          jobId: FIXTURE.jobId,
          job_type: 'ask',
          status: 'failed',
          error_message: FIXTURE.errorSentinel,
          output: { result: FIXTURE.resultSentinel },
        });
      }
      return successfulFetch(url, options);
    };

    await expect(runProbe(liveConfig(), {
      env: probeEnvironment(),
      railwayStatusFn: async () => railwayStatus(),
      fetchFn,
    })).rejects.toMatchObject({
      code: 'JOB_STATUS_ABSOLUTE_PATH_MISSING',
    });
  });

  it('never emits credentials or raw failure details in evidence', () => {
    const raw = {
      message: `Authorization: Bearer ${TOKENS.gptAccess}`,
      nested: {
        token: TOKENS.workerHelper,
        database:
          'postgresql://fixture-user:fixture-password@private.railway.internal:5432/fixture',
      },
    };
    const sanitized = sanitizeEvidence(raw, Object.values(TOKENS));
    const rendered = JSON.stringify(sanitized);
    for (const token of Object.values(TOKENS)) {
      expect(rendered).not.toContain(token);
    }
    expect(rendered).not.toContain('fixture-password');

    let output = '';
    writeSanitizedEvidence(
      buildFailureEvidence(
        new WorkerDiagnosticsPreviewE2EError('STABLE_FAILURE'),
      ),
      Object.values(TOKENS),
      {
        write(chunk) {
          output += String(chunk);
          return true;
        },
      },
    );
    expect(JSON.parse(output)).toMatchObject({
      summary: {
        status: 'FAIL',
        code: 'STABLE_FAILURE',
      },
    });
    for (const token of Object.values(TOKENS)) {
      expect(output).not.toContain(token);
    }
  });
});

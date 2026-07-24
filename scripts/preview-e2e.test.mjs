import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  executeRailwayCliJson,
  PreviewE2EError,
  parseArgs,
  railwayInvocationForPlatform,
  runPreviewE2E,
  validatePreviewTarget
} from './preview-e2e.mjs';

const PREVIEW_CREDENTIAL = 'preview-test-credential-value';
const RAILWAY_SECRET_MARKER = 'railway-sensitive-value';
const PRODUCTIVITY_ACTIONS = [
  'intent.catalog',
  'intent.resolve',
  'state.current',
  'context.summary',
  'reference.resolve',
  'inbox.list',
  'task.list',
  'project.list',
  'project.health',
  'focus.today',
  'knowledge.find',
  'review.daily',
  'review.weekly',
  'capture.add',
  'inbox.process',
  'task.create',
  'task.complete',
  'task.defer',
  'task.transition',
  'project.create',
  'project.advance',
  'project.transition',
  'knowledge.store',
  'review.record'
];
const LOCAL_AGENT_ACTIONS = [
  'local_agent.status',
  'repo.search',
  'git.status',
  'git.diff',
  'tests.run',
  'patch.preview',
  'patch.apply'
];
const LOCAL_AGENT_TIMEOUTS = {
  'local_agent.status': 10_000,
  'repo.search': 30_000,
  'git.status': 15_000,
  'git.diff': 30_000,
  'tests.run': 900_000,
  'patch.preview': 30_000,
  'patch.apply': 60_000
};
const TARGET = Object.freeze({
  baseUrl: 'https://arcanos-preview-e2e.example.test',
  projectId: 'project-preview',
  environmentId: 'environment-e2e',
  environmentName: 'arcanos-preview-e2e',
  apiServiceId: 'service-api',
  apiServiceName: 'arcanos-api-preview-e2e',
  apiDeploymentId: 'deployment-api-preview',
  workerServiceId: 'service-worker',
  workerServiceName: 'arcanos-worker-preview-e2e',
  workerDeploymentId: 'deployment-worker-preview',
  postgresServiceId: 'service-postgres',
  postgresServiceName: 'arcanos-postgres-preview-e2e',
  redisServiceId: 'service-redis',
  redisServiceName: 'arcanos-redis-preview-e2e',
  commitSha: 'abcdef1234567890abcdef1234567890abcdef12'
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function capabilityList() {
  return {
    ok: true,
    capabilities: [
      {
        id: 'ARCANOS:PRODUCTIVITY',
        actions: PRODUCTIVITY_ACTIONS
      },
      {
        id: 'ARCANOS:LOCAL_AGENT',
        actions: LOCAL_AGENT_ACTIONS
      }
    ]
  };
}

function localAgentActionMetadata() {
  return Object.fromEntries(LOCAL_AGENT_ACTIONS.map((action) => {
    const privileged = action === 'tests.run' || action === 'patch.apply';
    return [action, {
      description: `Contract for ${action}.`,
      risk: privileged ? 'privileged' : 'readonly',
      requiresConfirmation: privileged,
      inputSchema: { type: 'object', title: `${action} input` },
      outputSchema: { type: 'object', title: `${action} output` },
      idempotent: true,
      executionTarget: 'python-daemon',
      timeoutMs: LOCAL_AGENT_TIMEOUTS[action],
      requiredDeviceScopes: [action],
      readOnly: !privileged,
      mayModifyFiles: privileged
    }];
  }));
}

function openApi() {
  const actionMetadata = localAgentActionMetadata();
  return {
    openapi: '3.1.0',
    servers: [{ url: TARGET.baseUrl }],
    'x-arcanos-capability-catalogs': {
      'ARCANOS:PRODUCTIVITY': {
        actions: PRODUCTIVITY_ACTIONS
      },
      'ARCANOS:LOCAL_AGENT': {
        actions: LOCAL_AGENT_ACTIONS,
        contracts: LOCAL_AGENT_ACTIONS.map((action) => ({
          id: action,
          ...actionMetadata[action]
        }))
      }
    },
    paths: {
      '/gpt-access/capabilities/v1/{id}/run': { post: {} }
    }
  };
}

function railwayVariables(serviceId, serviceName, extra = {}) {
  return {
    RAILWAY_PROJECT_ID: TARGET.projectId,
    RAILWAY_ENVIRONMENT_ID: TARGET.environmentId,
    RAILWAY_ENVIRONMENT_NAME: TARGET.environmentName,
    RAILWAY_SERVICE_ID: serviceId,
    RAILWAY_SERVICE_NAME: serviceName,
    RAILWAY_PRIVATE_DOMAIN: `${serviceName}.railway.internal`,
    PREVIEW_ONLY_SECRET: RAILWAY_SECRET_MARKER,
    ...extra
  };
}

function createMockRailway(overrides = {}) {
  const services = [
    {
      role: 'api',
      id: TARGET.apiServiceId,
      name: TARGET.apiServiceName,
      deploymentId: TARGET.apiDeploymentId
    },
    {
      role: 'worker',
      id: TARGET.workerServiceId,
      name: TARGET.workerServiceName,
      deploymentId: TARGET.workerDeploymentId
    },
    {
      role: 'postgres',
      id: TARGET.postgresServiceId,
      name: TARGET.postgresServiceName,
      deploymentId: 'deployment-postgres-preview'
    },
    {
      role: 'redis',
      id: TARGET.redisServiceId,
      name: TARGET.redisServiceName,
      deploymentId: 'deployment-redis-preview'
    }
  ];
  const variables = {
    [TARGET.apiServiceId]: railwayVariables(TARGET.apiServiceId, TARGET.apiServiceName, {
      NODE_ENV: 'production',
      DATABASE_URL: `postgresql://preview:${RAILWAY_SECRET_MARKER}@${TARGET.postgresServiceName}.railway.internal:5432/railway`,
      REDIS_URL: `redis://default:${RAILWAY_SECRET_MARKER}@${TARGET.redisServiceName}.railway.internal:6379`
    }),
    [TARGET.workerServiceId]: railwayVariables(TARGET.workerServiceId, TARGET.workerServiceName, {
      DATABASE_URL: `postgresql://preview:${RAILWAY_SECRET_MARKER}@${TARGET.postgresServiceName}.railway.internal:5432/railway`,
      REDIS_URL: `redis://default:${RAILWAY_SECRET_MARKER}@${TARGET.redisServiceName}.railway.internal:6379`
    }),
    [TARGET.postgresServiceId]: railwayVariables(
      TARGET.postgresServiceId,
      TARGET.postgresServiceName,
      {
        PGPORT: '5432',
        RAILWAY_TCP_PROXY_DOMAIN: 'postgres-preview.proxy.rlwy.net',
        RAILWAY_TCP_PROXY_PORT: '15432',
        DATABASE_PUBLIC_URL:
          `postgresql://preview:${RAILWAY_SECRET_MARKER}@postgres-preview.proxy.rlwy.net:15432/railway`
      }
    ),
    [TARGET.redisServiceId]: railwayVariables(
      TARGET.redisServiceId,
      TARGET.redisServiceName,
      {
        REDISPORT: '6379',
        RAILWAY_TCP_PROXY_DOMAIN: 'redis-preview.proxy.rlwy.net',
        RAILWAY_TCP_PROXY_PORT: '16379',
        REDIS_PUBLIC_URL:
          `redis://default:${RAILWAY_SECRET_MARKER}@redis-preview.proxy.rlwy.net:16379`
      }
    )
  };
  const status = {
    id: TARGET.projectId,
    environments: {
      edges: [{
        node: {
          id: TARGET.environmentId,
          name: TARGET.environmentName,
          canAccess: true,
          deletedAt: null,
          serviceInstances: {
            edges: services.map((service) => ({
              node: {
                serviceId: service.id,
                serviceName: service.name,
                domains: {
                  serviceDomains: service.role === 'api'
                    ? [{ domain: new URL(TARGET.baseUrl).hostname }]
                    : [],
                  customDomains: []
                }
              }
            }))
          }
        }
      }]
    }
  };
  const calls = [];
  const execRailway = async (args) => {
    calls.push([...args]);
    const command = args.join(' ');
    if (command === 'status --json') {
      return overrides.status ?? status;
    }
    if (command.startsWith('environment config ')) {
      return overrides.environmentConfig ?? {
        services: Object.fromEntries(services.map((service) => [service.id, {}]))
      };
    }
    if (command.startsWith('service status ')) {
      const serviceId = args[args.indexOf('--service') + 1];
      const statuses = overrides.serviceStatus ?? services.map((service) => ({
        id: service.id,
        name: service.name,
        deploymentId: service.deploymentId,
        status: 'SUCCESS',
        stopped: false
      }));
      return Array.isArray(statuses)
        ? statuses.find((service) => service.id === serviceId)
        : statuses[serviceId];
    }
    if (command.startsWith('deployment list ')) {
      const serviceId = args[args.indexOf('--service') + 1];
      const service = services.find((candidate) => candidate.id === serviceId);
      return [{
        id: service.deploymentId,
        status: 'SUCCESS',
        meta: {
          commitHash: TARGET.commitSha,
          secretLikeMetadata: RAILWAY_SECRET_MARKER
        }
      }];
    }
    if (command.startsWith('variable list ')) {
      const serviceId = args[args.indexOf('--service') + 1];
      return overrides.variables?.[serviceId] ?? variables[serviceId];
    }
    throw new Error(`Unexpected Railway command: ${command}`);
  };
  return { calls, execRailway };
}

function createMockFetch({ challenge = false, healthDeployment } = {}) {
  const calls = [];
  let jobSequence = 0;
  const fetchImpl = async (url, init) => {
    const parsedBody = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: url.toString(), init, parsedBody });
    const path = url.pathname;
    if (path === '/gpt-access/openapi.json') {
      return jsonResponse(openApi());
    }
    if (path === '/gpt-access/capabilities/v1' && !init.headers.has('Authorization')) {
      return jsonResponse({ error: { code: 'UNAUTHORIZED_GPT_ACCESS' } }, 401);
    }
    if (path === '/gpt-access/capabilities/v1') {
      return jsonResponse(capabilityList());
    }
    if (path === '/gpt-access/health') {
      return jsonResponse({
        ok: true,
        status: 'healthy',
        startup: {
          phase: 'READY',
          ready: true
        },
        dependencies: {
          redis: {
            configured: true,
            ready: true,
            status: 'ready',
            code: null,
            retryScheduled: false
          }
        },
        deployment: healthDeployment ?? {
          provider: 'railway',
          projectId: TARGET.projectId,
          environmentId: TARGET.environmentId,
          environmentName: TARGET.environmentName,
          serviceId: TARGET.apiServiceId,
          serviceName: TARGET.apiServiceName,
          deploymentId: TARGET.apiDeploymentId,
          gitCommitSha: TARGET.commitSha,
          workerServiceId: TARGET.workerServiceId,
          workerServiceName: TARGET.workerServiceName,
          workerDeploymentId: TARGET.workerDeploymentId,
          workerGitCommitSha: TARGET.commitSha
        }
      });
    }
    if (path === '/gpt-access/status') {
      return jsonResponse({
        status: 'ok',
        startup: {
          phase: 'READY',
          ready: true,
          listener_bound: true,
          runtime_initialized: true,
          shutting_down: false
        },
        dependencies: {
          redis: {
            configured: true,
            ready: true,
            status: 'ready',
            code: null,
            retry_scheduled: false
          }
        }
      });
    }
    if (path === '/gpt-access/workers/status') {
      return jsonResponse({ error: { code: 'GPT_ACCESS_SCOPE_DENIED' } }, 403);
    }
    if (path === '/gpt-access/capabilities/v1/__preview_e2e_missing__') {
      return jsonResponse({ ok: true, exists: false, capability: null });
    }
    if (
      init.method === 'GET'
      && path.startsWith('/gpt-access/capabilities/v1/ARCANOS%3A')
    ) {
      const id = decodeURIComponent(path.split('/').at(-1));
      return jsonResponse({
        ok: true,
        exists: true,
        capability: {
          id,
          actions: id === 'ARCANOS:PRODUCTIVITY'
            ? PRODUCTIVITY_ACTIONS
            : LOCAL_AGENT_ACTIONS,
          ...(id === 'ARCANOS:LOCAL_AGENT'
            ? { actionMetadata: localAgentActionMetadata() }
            : {})
        }
      });
    }
    if (path.endsWith('/ARCANOS%3APRODUCTIVITY/run')) {
      if (parsedBody.action === '__preview_e2e_unknown__') {
        return jsonResponse({
          code: 'CONFIRMATION_REQUIRED',
          confirmationChallenge: { id: 'unknown-action-challenge' }
        }, 403);
      }
      return jsonResponse({
        ok: true,
        result: {
          ok: true,
          action: parsedBody.action,
          persisted: false,
          data: {}
        }
      });
    }
    if (path.endsWith('/ARCANOS%3ALOCAL_AGENT/run')) {
      if (parsedBody.action === 'patch.apply' && challenge) {
        return jsonResponse({
          code: 'CONFIRMATION_REQUIRED',
          confirmationChallenge: { id: 'raw-confirmation-challenge' }
        }, 403);
      }
      const idempotencyKey = init.headers.get('Idempotency-Key');
      const prior = idempotencyKey
        ? calls
            .slice(0, -1)
            .find((call) => call.init.headers.get('Idempotency-Key') === idempotencyKey)
        : undefined;
      if (prior) {
        const samePayload = JSON.stringify(prior.parsedBody) === JSON.stringify(parsedBody);
        if (!samePayload) {
          return jsonResponse({
            ok: true,
            result: {
              ok: false,
              error: { code: 'LOCAL_AGENT_IDEMPOTENCY_CONFLICT' }
            }
          });
        }
        return jsonResponse({
          ok: true,
          result: {
            ok: true,
            accepted: true,
            action: parsedBody.action,
            jobId: prior.jobId,
            status: 'pending',
            traceId: init.headers.get('X-Trace-ID'),
            requestId: init.headers.get('X-Request-ID'),
            deduped: true
          }
        });
      }
      jobSequence += 1;
      calls.at(-1).jobId = `job-${jobSequence}`;
      calls.at(-1).traceId = init.headers.get('X-Trace-ID');
      calls.at(-1).requestId = init.headers.get('X-Request-ID');
      return jsonResponse({
        ok: true,
        result: {
          ok: true,
          accepted: true,
          action: parsedBody.action,
          jobId: `job-${jobSequence}`,
          status: 'pending',
          traceId: calls.at(-1).traceId,
          requestId: calls.at(-1).requestId
        }
      });
    }
    if (path === '/gpt-access/jobs/result') {
      const submitted = calls.find((call) => call.jobId === parsedBody.jobId);
      const action = submitted?.parsedBody?.action;
      let output = { action };
      if (action === 'local_agent.status') {
        output = {
          status: 'ready',
          daemonVersion: '1.1.2',
          capabilities: LOCAL_AGENT_ACTIONS,
          workspaceRegistered: true,
          testExecutionMode: 'disabled',
          testSandboxAvailable: false,
          testSandboxRuntime: null,
          observedAt: '2026-07-24T12:00:00.000Z'
        };
      } else if (action === 'git.status') {
        output = {
          branch: 'preview-fixture',
          head: TARGET.commitSha,
          clean: true,
          changes: [],
          gitAvailable: true,
          workspaceType: 'git'
        };
      } else if (action === 'patch.preview') {
        const patch = submitted.parsedBody.payload.patch;
        output = {
          patchSha256: createHash('sha256').update(patch).digest('hex'),
          files: ['fixture.txt'],
          applicable: true,
          check: {
            exitCode: 0,
            stdout: '',
            stderr: '',
            truncated: false
          }
        };
      }
      return jsonResponse({
        ok: true,
        jobId: parsedBody.jobId,
        status: 'completed',
        result: { outcome: 'succeeded', output }
      });
    }
    if (path === '/gpt-access/jobs/timeline') {
      const submitted = calls.find((call) => call.jobId === parsedBody.job_id);
      const metadata = {
        action: submitted.parsedBody.action,
        principal: 'preview-principal',
        workspace: 'preview-workspace',
        deviceId: 'preview-device',
        requestId: submitted.requestId,
        authorizationDecision: 'allow'
      };
      const events = ['job.created', 'job.queued', 'job.completed'].map(
        (eventType, index) => ({
          id: `event-${parsedBody.job_id}-${index}`,
          jobId: parsedBody.job_id,
          traceId: submitted.traceId,
          eventType,
          workerId: 'preview-device',
          occurredAt: `2026-07-24T12:00:0${index}.000Z`,
          durationMs: null,
          metadata,
          offsetMs: index * 1_000
        })
      );
      return jsonResponse({
        ok: true,
        count: events.length,
        summary: {
          eventCount: events.length,
          terminalState: 'completed',
          traceIds: [submitted.traceId]
        },
        events
      });
    }
    throw new Error('Unexpected mock route');
  };
  return { calls, fetchImpl };
}

test('rejects non-preview, production, Phase 2E, and non-HTTPS targets', () => {
  for (const candidate of [
    { ...TARGET, baseUrl: 'http://arcanos-preview.example.test' },
    { ...TARGET, baseUrl: 'https://api.example.test', environmentId: 'production' },
    { ...TARGET, baseUrl: 'https://phase-2e-preview.example.test' },
    {
      ...TARGET,
      baseUrl: 'https://api.example.test',
      projectId: 'project',
      environmentId: 'environment',
      environmentName: 'environment'
    }
  ]) {
    assert.throws(() => validatePreviewTarget(candidate), PreviewE2EError);
  }
});

test('rejects all credential and confirmation-token CLI arguments', () => {
  assert.throws(
    () => parseArgs(['--confirmation-token', 'do-not-accept']),
    (error) => error.code === 'TOKEN_ARGUMENT_DENIED'
  );
  assert.throws(
    () => parseArgs(['--bearer', 'do-not-accept']),
    (error) => error.code === 'TOKEN_ARGUMENT_DENIED'
  );
});

test('parses the complete explicit preview resource identity', () => {
  const parsed = parseArgs([
    '--base-url', TARGET.baseUrl,
    '--project-id', TARGET.projectId,
    '--environment-id', TARGET.environmentId,
    '--environment-name', TARGET.environmentName,
    '--api-service-id', TARGET.apiServiceId,
    '--api-service-name', TARGET.apiServiceName,
    '--api-deployment-id', TARGET.apiDeploymentId,
    '--worker-service-id', TARGET.workerServiceId,
    '--worker-service-name', TARGET.workerServiceName,
    '--worker-deployment-id', TARGET.workerDeploymentId,
    '--postgres-service-id', TARGET.postgresServiceId,
    '--postgres-service-name', TARGET.postgresServiceName,
    '--redis-service-id', TARGET.redisServiceId,
    '--redis-service-name', TARGET.redisServiceName,
    '--commit-sha', TARGET.commitSha
  ]);
  assert.deepEqual(parsed, {
    ...TARGET,
    mode: 'discovery',
    patchFile: undefined,
    expectedTestMode: 'disabled',
    pollTimeoutMs: 60_000,
    pollIntervalMs: 1_000
  });
});

test('the live Railway executor rejects mutating commands before process execution', async () => {
  await assert.rejects(
    executeRailwayCliJson([
      'variable',
      'set',
      '--service',
      TARGET.apiServiceId,
      'UNSAFE=value'
    ]),
    (error) => error.code === 'UNSAFE_RAILWAY_COMMAND'
  );
});

test('the live Railway executor selects a shell-free platform-native invocation', () => {
  assert.deepEqual(
    railwayInvocationForPlatform('win32', 'C:\\Users\\preview\\AppData\\Roaming', 'C:\\node.exe'),
    {
      executable: 'C:\\node.exe',
      argsPrefix: [
        'C:\\Users\\preview\\AppData\\Roaming\\npm\\node_modules\\@railway\\cli\\bin\\railway.js'
      ]
    }
  );
  assert.deepEqual(railwayInvocationForPlatform('linux'), {
    executable: 'railway',
    argsPrefix: []
  });
});

test('discovery checks use only GPT Access and emit sanitized evidence', async () => {
  const mock = createMockFetch();
  const railway = createMockRailway();
  const evidence = [];
  await runPreviewE2E(
    {
      ...TARGET,
      mode: 'discovery',
      accessCredential: PREVIEW_CREDENTIAL
    },
    {
      fetchImpl: mock.fetchImpl,
      execRailway: railway.execRailway,
      emit: (record) => evidence.push(record),
      id: () => 'fixed',
      now: () => new Date('2026-07-24T12:00:00.000Z')
    }
  );
  assert.equal(mock.calls.length, 9);
  assert.equal(railway.calls.length, 13);
  assert.ok(railway.calls.every((args) => (
    args[0] === 'status'
      || (args[0] === 'environment' && args[1] === 'config')
      || (
        args[0] === 'service'
        && args[1] === 'status'
        && args.includes('--service')
      )
      || (args[0] === 'deployment' && args[1] === 'list')
      || (args[0] === 'variable' && args[1] === 'list')
  )));
  assert.ok(railway.calls
    .filter((args) => args.includes('--environment'))
    .every((args) => args.includes(TARGET.environmentId)));
  assert.ok(mock.calls.every((call) => new URL(call.url).pathname.startsWith('/gpt-access/')));
  assert.ok(mock.calls.every((call) => !new URL(call.url).pathname.startsWith('/gpt/')));
  const serialized = JSON.stringify(evidence);
  assert.ok(!serialized.includes(PREVIEW_CREDENTIAL));
  assert.ok(!serialized.includes('Authorization'));
  assert.ok(!serialized.includes('"payload":'));
  assert.ok(!serialized.includes(RAILWAY_SECRET_MARKER));
  assert.ok(evidence.some((record) => record.caseId === 'railway-preview-isolation'));
  assert.ok(evidence.some((record) => record.caseId === 'unauthorized-capabilities'));
  assert.ok(evidence.some((record) => record.caseId === 'scope-denied-workers'));
  assert.ok(evidence.some((record) => record.caseId === 'invalid-capability'));
  assert.ok(!evidence.some((record) => record.response?.code === 'CONFIRMATION_REQUIRED'));
});

test('discovery fails closed on OpenAPI catalog drift', async () => {
  const mock = createMockFetch();
  const railway = createMockRailway();
  const drifted = openApi();
  drifted['x-arcanos-capability-catalogs']['ARCANOS:LOCAL_AGENT'].actions =
    LOCAL_AGENT_ACTIONS.slice(0, -1);

  await assert.rejects(
    runPreviewE2E(
      {
        ...TARGET,
        mode: 'discovery',
        accessCredential: PREVIEW_CREDENTIAL
      },
      {
        execRailway: railway.execRailway,
        fetchImpl: async (url, init) => (
          url.pathname === '/gpt-access/openapi.json'
            ? jsonResponse(drifted)
            : mock.fetchImpl(url, init)
        ),
        emit: () => {},
        id: () => 'fixed'
      }
    ),
    (error) => error.code === 'OPENAPI_CATALOG_MISMATCH'
  );
});

test('discovery rejects a degraded GPT Access runtime', async () => {
  const mock = createMockFetch();
  const railway = createMockRailway();

  await assert.rejects(
    runPreviewE2E(
      {
        ...TARGET,
        mode: 'discovery',
        accessCredential: PREVIEW_CREDENTIAL
      },
      {
        execRailway: railway.execRailway,
        fetchImpl: async (url, init) => (
          url.pathname === '/gpt-access/health'
            ? jsonResponse({
                ok: true,
                status: 'degraded',
                startup: { phase: 'READY', ready: true },
                dependencies: {
                  redis: {
                    configured: true,
                    ready: false,
                    status: 'degraded',
                    code: 'REDIS_DEPENDENCY_UNAVAILABLE',
                    retryScheduled: true
                  }
                }
              })
            : mock.fetchImpl(url, init)
        ),
        emit: () => {},
        id: () => 'fixed'
      }
    ),
    (error) => error.code === 'GPT_ACCESS_HEALTH_FAILED'
  );
});

test('readonly mode requires a non-empty patch fixture before Railway inspection', async () => {
  let railwayCalled = false;
  await assert.rejects(
    runPreviewE2E(
      {
        ...TARGET,
        mode: 'readonly',
        accessCredential: PREVIEW_CREDENTIAL
      },
      {
        execRailway: async () => {
          railwayCalled = true;
          throw new Error('Railway inspection must not start.');
        },
        emit: () => {}
      }
    ),
    (error) => error.code === 'PATCH_FIXTURE_REQUIRED'
  );
  assert.equal(railwayCalled, false);
});

test('fails before HTTP when read-only Railway inspection cannot prove isolation', async () => {
  const railway = createMockRailway({
    status: {
      id: 'different-project-preview',
      environments: { edges: [] }
    }
  });
  let fetchCalled = false;
  await assert.rejects(
    runPreviewE2E(
      {
        ...TARGET,
        mode: 'discovery',
        accessCredential: PREVIEW_CREDENTIAL
      },
      {
        execRailway: railway.execRailway,
        fetchImpl: async () => {
          fetchCalled = true;
          throw new Error('HTTP must not run');
        },
        emit: () => {}
      }
    ),
    (error) => error.code === 'RAILWAY_PROJECT_MISMATCH'
  );
  assert.equal(fetchCalled, false);
});

test('rejects a public origin not owned by the selected Railway API service', async () => {
  const baseline = createMockRailway();
  const status = structuredClone(await baseline.execRailway(['status', '--json']));
  const api = status.environments.edges[0].node.serviceInstances.edges
    .find((edge) => edge.node.serviceId === TARGET.apiServiceId);
  api.node.domains.serviceDomains = [{ domain: 'different-preview.up.railway.app' }];
  const railway = createMockRailway({ status });
  await assert.rejects(
    runPreviewE2E(
      {
        ...TARGET,
        mode: 'discovery',
        accessCredential: PREVIEW_CREDENTIAL
      },
      {
        execRailway: railway.execRailway,
        fetchImpl: async () => {
          throw new Error('HTTP must not run');
        },
        emit: () => {}
      }
    ),
    (error) => error.code === 'RAILWAY_PUBLIC_DOMAIN_MISMATCH'
  );
});

test('fails closed when served deployment metadata differs from Railway inspection', async () => {
  const railway = createMockRailway();
  const mock = createMockFetch({
    healthDeployment: {
      provider: 'railway',
      projectId: TARGET.projectId,
      environmentId: TARGET.environmentId,
      environmentName: TARGET.environmentName,
      serviceId: TARGET.apiServiceId,
      serviceName: TARGET.apiServiceName,
      deploymentId: 'different-deployment-preview',
      gitCommitSha: TARGET.commitSha,
      workerServiceId: TARGET.workerServiceId,
      workerServiceName: TARGET.workerServiceName,
      workerDeploymentId: TARGET.workerDeploymentId,
      workerGitCommitSha: TARGET.commitSha
    }
  });
  await assert.rejects(
    runPreviewE2E(
      {
        ...TARGET,
        mode: 'discovery',
        accessCredential: PREVIEW_CREDENTIAL
      },
      {
        execRailway: railway.execRailway,
        fetchImpl: mock.fetchImpl,
        emit: () => {},
        id: () => 'fixed'
      }
    ),
    (error) => error.code === 'SERVED_DEPLOYMENT_MISMATCH'
  );
});

test('rejects a preview API dependency URL that resolves outside selected services', async () => {
  const baseline = createMockRailway();
  const unsafeVariables = {};
  for (const serviceId of [
    TARGET.apiServiceId,
    TARGET.workerServiceId,
    TARGET.postgresServiceId,
    TARGET.redisServiceId
  ]) {
    const response = await baseline.execRailway([
      'variable',
      'list',
      '--service',
      serviceId,
      '--environment',
      TARGET.environmentId,
      '--json'
    ]);
    unsafeVariables[serviceId] = { ...response };
  }
  unsafeVariables[TARGET.apiServiceId].DATABASE_URL =
    'postgresql://preview:redacted@production-postgres.railway.internal:5432/railway';
  const railway = createMockRailway({ variables: unsafeVariables });
  await assert.rejects(
    runPreviewE2E(
      {
        ...TARGET,
        mode: 'discovery',
        accessCredential: PREVIEW_CREDENTIAL
      },
      {
        execRailway: railway.execRailway,
        fetchImpl: async () => {
          throw new Error('HTTP must not run');
        },
        emit: () => {}
      }
    ),
    (error) => error.code === 'RAILWAY_DEPENDENCY_IDENTITY_MISMATCH'
  );
});

test('rejects a foreign Railway TCP proxy and non-NODE_ENV production markers', async () => {
  const baseline = createMockRailway();
  const unsafeVariables = {};
  for (const serviceId of [
    TARGET.apiServiceId,
    TARGET.workerServiceId,
    TARGET.postgresServiceId,
    TARGET.redisServiceId
  ]) {
    unsafeVariables[serviceId] = {
      ...(await baseline.execRailway([
        'variable',
        'list',
        '--service',
        serviceId,
        '--environment',
        TARGET.environmentId,
        '--json'
      ]))
    };
  }
  unsafeVariables[TARGET.postgresServiceId].DATABASE_PUBLIC_URL =
    `postgresql://preview:${RAILWAY_SECRET_MARKER}@foreign.proxy.rlwy.net:15432/railway`;
  let railway = createMockRailway({ variables: unsafeVariables });
  await assert.rejects(
    runPreviewE2E(
      {
        ...TARGET,
        mode: 'discovery',
        accessCredential: PREVIEW_CREDENTIAL
      },
      {
        execRailway: railway.execRailway,
        fetchImpl: async () => {
          throw new Error('HTTP must not run');
        },
        emit: () => {}
      }
    ),
    (error) => error.code === 'RAILWAY_DEPENDENCY_IDENTITY_MISMATCH'
  );

  unsafeVariables[TARGET.postgresServiceId].DATABASE_PUBLIC_URL =
    `postgresql://preview:${RAILWAY_SECRET_MARKER}@postgres-preview.proxy.rlwy.net:15432/railway`;
  unsafeVariables[TARGET.workerServiceId].TARGET_ENV = 'production';
  railway = createMockRailway({ variables: unsafeVariables });
  await assert.rejects(
    runPreviewE2E(
      {
        ...TARGET,
        mode: 'discovery',
        accessCredential: PREVIEW_CREDENTIAL
      },
      {
        execRailway: railway.execRailway,
        fetchImpl: async () => {
          throw new Error('HTTP must not run');
        },
        emit: () => {}
      }
    ),
    (error) => error.code === 'RAILWAY_UNSAFE_REFERENCE'
  );
});

test('rejects connection query overrides and local certificate file parameters', async () => {
  const baseline = createMockRailway();
  const baselineVariables = {};
  for (const serviceId of [
    TARGET.apiServiceId,
    TARGET.workerServiceId,
    TARGET.postgresServiceId,
    TARGET.redisServiceId
  ]) {
    baselineVariables[serviceId] = {
      ...(await baseline.execRailway([
        'variable',
        'list',
        '--service',
        serviceId,
        '--environment',
        TARGET.environmentId,
        '--json'
      ]))
    };
  }
  for (const query of [
    'host=foreign.proxy.rlwy.net&port=6543',
    'user=other-user',
    'password=other-test-password',
    'sslcert=outside.crt',
    'sslkey=outside.key',
    'sslrootcert=outside-ca.crt'
  ]) {
    const variables = structuredClone(baselineVariables);
    variables[TARGET.postgresServiceId].DATABASE_PUBLIC_URL += `?${query}`;
    const railway = createMockRailway({ variables });
    await assert.rejects(
      runPreviewE2E(
        {
          ...TARGET,
          mode: 'discovery',
          accessCredential: PREVIEW_CREDENTIAL
        },
        {
          execRailway: railway.execRailway,
          fetchImpl: async () => {
            throw new Error('HTTP must not run');
          },
          emit: () => {}
        }
      ),
      (error) => error.code === 'RAILWAY_DEPENDENCY_URL_PARAMETERS_DENIED'
    );
  }
});

test('readonly mode executes productivity reads and bounded local-agent polling without leaking payloads', async () => {
  const mock = createMockFetch();
  const railway = createMockRailway();
  const evidence = [];
  const patch = 'diff --git a/fixture.txt b/fixture.txt\n-sensitive-before\n+sensitive-after\n';
  const query = 'SENSITIVE_SEARCH_MARKER';
  await runPreviewE2E(
    {
      ...TARGET,
      mode: 'readonly',
      accessCredential: PREVIEW_CREDENTIAL,
      patchText: patch,
      searchQuery: query,
      pollTimeoutMs: 2_000,
      pollIntervalMs: 100
    },
    {
      fetchImpl: mock.fetchImpl,
      execRailway: railway.execRailway,
      emit: (record) => evidence.push(record),
      sleep: async () => {},
      id: () => 'fixed'
    }
  );
  const submittedActions = mock.calls
    .map((call) => call.parsedBody?.action)
    .filter(Boolean);
  assert.ok(submittedActions.includes('state.current'));
  assert.ok(submittedActions.includes('local_agent.status'));
  assert.ok(submittedActions.includes('repo.search'));
  assert.ok(submittedActions.includes('patch.preview'));
  assert.ok(!submittedActions.includes('patch.apply'));
  assert.ok(!submittedActions.includes('tests.run'));
  const serialized = JSON.stringify(evidence);
  assert.ok(!serialized.includes(PREVIEW_CREDENTIAL));
  assert.ok(!serialized.includes(query));
  assert.ok(!serialized.includes('sensitive-before'));
  assert.ok(!serialized.includes('sensitive-after'));
  assert.ok(evidence.some((record) => record.response.jobStatus === 'completed'));
  assert.ok(evidence.some((record) => record.caseId === 'local-agent-idempotency-conflict'));
  assert.ok(evidence.some((record) => record.caseId.endsWith('-timeline')));
});

test('confirmation-challenge mode never sends approval, never polls, and records only a challenge hash', async () => {
  const mock = createMockFetch({ challenge: true });
  const railway = createMockRailway();
  const evidence = [];
  const patch = 'diff --git a/fixture.txt b/fixture.txt\n-before\n+after\n';
  await runPreviewE2E(
    {
      ...TARGET,
      mode: 'confirmation-challenge',
      accessCredential: PREVIEW_CREDENTIAL,
      patchText: patch
    },
    {
      fetchImpl: mock.fetchImpl,
      execRailway: railway.execRailway,
      emit: (record) => evidence.push(record),
      id: () => 'fixed'
    }
  );
  const patchCalls = mock.calls.filter(
    (call) => call.parsedBody?.action === 'patch.apply'
  );
  assert.equal(patchCalls.length, 1);
  assert.ok(!Object.hasOwn(patchCalls[0].parsedBody, 'confirmation_token'));
  assert.ok(!mock.calls.some((call) => new URL(call.url).pathname === '/gpt-access/jobs/result'));
  const serialized = JSON.stringify(evidence);
  assert.ok(!serialized.includes(PREVIEW_CREDENTIAL));
  assert.ok(!serialized.includes(patch));
  assert.ok(!serialized.includes('raw-confirmation-challenge'));
  assert.match(serialized, /confirmationChallengeSha256/);
});

test('confirmation-challenge mode fails closed if patch.apply is accepted', async () => {
  const mock = createMockFetch();
  const railway = createMockRailway();
  await assert.rejects(
    runPreviewE2E(
      {
        ...TARGET,
        mode: 'confirmation-challenge',
        accessCredential: PREVIEW_CREDENTIAL,
        patchText: 'diff --git a/fixture.txt b/fixture.txt\n-before\n+after\n'
      },
      {
        fetchImpl: mock.fetchImpl,
        execRailway: railway.execRailway,
        emit: () => {},
        id: () => 'fixed'
      }
    ),
    (error) => error.code === 'CONFIRMATION_FAIL_OPEN'
  );
  assert.ok(!mock.calls.some((call) => new URL(call.url).pathname === '/gpt-access/jobs/result'));
});

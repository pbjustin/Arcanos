import { describe, expect, it, jest } from '@jest/globals';

import {
  attestBackstageHeavyRailwayControlPlane,
  buildBackstageHeavyProbePrompt,
  buildBackstageHeavyRailwayCliEnvironment,
  railwayInvocationForBackstageHeavyProbe,
  readRailwayControlPlaneAttestation,
  resolveBackstageHeavyProbeConfig,
  runBackstageHeavyProbe,
} from '../scripts/railway-backstage-heavy-e2e-probe.mjs';
import { shouldPreferDirectAnswerMode } from '../src/services/directAnswerMode.js';
import { classifyBackstageBookerWorkload } from '../src/shared/backstage/backstageActionPolicy.js';
import { resolveBackstageOutputBudget } from '../src/shared/backstage/backstageOutputBudget.js';
import {
  isBackstageBookerCompactRetryOutputValid,
  resolveBackstageCompactOutputContract,
} from '../src/shared/backstage/backstageCompactOutputContract.js';
import { BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT } from '../scripts/railway-backstage-heavy-openai-fixture.mjs';

const ID = {
  project: '11111111-1111-4111-8111-111111111111',
  environment: '22222222-2222-4222-8222-222222222222',
  web: '33333333-3333-4333-8333-333333333333',
  webDeployment: '44444444-4444-4444-8444-444444444444',
  worker: '55555555-5555-4555-8555-555555555555',
  workerDeployment: '66666666-6666-4666-8666-666666666666',
  postgres: '77777777-7777-4777-8777-777777777777',
  redis: '88888888-8888-4888-8888-888888888888',
  webDomain: '99999999-9999-4999-8999-999999999998',
  webPreDeployInstance: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  webRuntimeInstance: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  workerPreDeployInstance: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  workerRuntimeInstance: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
};
const SOURCE_SHA = 'a'.repeat(40);
const WEB_DOMAIN = 'arcanos-web-pr1460-heavy.up.railway.app';
const DATABASE_URL =
  'postgresql://proof-user:proof-password@postgres.railway.internal:5432/railway';
const REDIS_URL =
  'redis://default:proof-password@redis.railway.internal:6379';
const TEST_PROOF_WEB_CREDENTIAL = 'test-proof-web-credential-value-0001';
const JOB_READ_SECRET = 'proof-only-fictional-job-read-secret-0001';
const PAYLOAD_KEY = `${'A'.repeat(43)}=`;
const WORKER_PREDEPLOY_COMMAND =
  'node scripts/railway-backstage-heavy-db-preflight.mjs --mode empty';
const WEB_PREDEPLOY_COMMAND =
  'node scripts/railway-backstage-heavy-db-preflight.mjs --mode schema';

function configArgs(execute = false) {
  return [
    ...(execute ? ['--execute', '--allow-network'] : []),
    '--target', 'dedicated-backstage-heavy-preview',
    '--base-url', `https://${WEB_DOMAIN}`,
    '--project-id', ID.project,
    '--environment-id', ID.environment,
    '--environment-name', 'backstage-heavy-pr-1460-e2e',
    '--web-service-id', ID.web,
    '--web-deployment-id', ID.webDeployment,
    '--worker-service-id', ID.worker,
    '--worker-deployment-id', ID.workerDeployment,
    '--postgres-service-id', ID.postgres,
    '--postgres-service-name', 'Postgres',
    '--postgres-internal-host', 'postgres.railway.internal',
    '--redis-service-id', ID.redis,
    '--redis-service-name', 'Redis',
    '--redis-internal-host', 'redis.railway.internal',
    '--source-sha', SOURCE_SHA,
    '--run-id', 'proof-run-1460',
  ];
}

function deployment(id, processKind = null) {
  const applicationInstanceIds = processKind === 'web'
    ? [ID.webPreDeployInstance, ID.webRuntimeInstance]
    : [ID.workerPreDeployInstance, ID.workerRuntimeInstance];
  return {
    id,
    status: 'SUCCESS',
    deploymentStopped: false,
    instances: processKind === null
      ? [{ id, status: 'RUNNING' }]
      : [
          { id: applicationInstanceIds[0], status: 'EXITED' },
          { id: applicationInstanceIds[1], status: 'RUNNING' },
        ],
    meta: {
      commitHash: SOURCE_SHA,
      serviceManifest: {
        deploy: {
          numReplicas: 1,
          restartPolicyMaxRetries: null,
          restartPolicyType: 'NEVER',
          ...(processKind === null
            ? {}
            : {
                startCommand:
                  'node scripts/railway-backstage-heavy-proof-supervisor.mjs',
                preDeployCommand: [
                  processKind === 'worker'
                    ? WORKER_PREDEPLOY_COMMAND
                    : WEB_PREDEPLOY_COMMAND,
                ],
              }),
        },
      },
    },
  };
}

function appService(
  serviceId,
  serviceName,
  deploymentId,
  processKind,
  domains = []
) {
  const latestDeployment = deployment(deploymentId, processKind);
  return {
    serviceId,
    serviceName,
    latestDeployment,
    activeDeployments: [{ ...latestDeployment }],
    domains: { customDomains: [], serviceDomains: domains },
  };
}

function dataService(serviceId, serviceName, deploymentId) {
  const latestDeployment = deployment(deploymentId);
  return {
    serviceId,
    serviceName,
    latestDeployment,
    activeDeployments: [{ ...latestDeployment }],
    domains: { customDomains: [], serviceDomains: [] },
  };
}

function variables(config, serviceId, serviceName, processKind) {
  return {
    RAILWAY_PROJECT_ID: config.projectId,
    RAILWAY_ENVIRONMENT_ID: config.environmentId,
    RAILWAY_ENVIRONMENT_NAME: config.environmentName,
    RAILWAY_SERVICE_ID: serviceId,
    RAILWAY_SERVICE_NAME: serviceName,
    ...(processKind
      ? {
          ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA: config.sourceSha,
          RAILWAY_GIT_COMMIT_SHA: config.sourceSha,
        }
      : {}),
    ...(serviceName === 'Postgres'
      ? { RAILWAY_PRIVATE_DOMAIN: config.postgresInternalHost }
      : {}),
    ...(serviceName === 'Redis'
      ? { RAILWAY_PRIVATE_DOMAIN: config.redisInternalHost }
      : {}),
    DATABASE_URL,
    REDIS_URL,
    ...(processKind
      ? {
          ARCANOS_BACKSTAGE_HEAVY_PROOF_TARGET:
            'dedicated-backstage-heavy-preview-v1',
          ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID: config.runId,
          ARCANOS_PROCESS_KIND: processKind,
          ARCANOS_PREVIEW_ISOLATION: 'true',
          FORCE_MOCK: 'true',
          ALLOW_MOCK_OPENAI: 'true',
          OPENAI_API_KEY_REQUIRED: 'false',
          ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_ID: config.postgresServiceId,
          ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_NAME: 'Postgres',
          ARCANOS_BACKSTAGE_HEAVY_POSTGRES_INTERNAL_HOST:
            config.postgresInternalHost,
          ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_ID: config.redisServiceId,
          ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_NAME: 'Redis',
          ARCANOS_BACKSTAGE_HEAVY_REDIS_INTERNAL_HOST:
            config.redisInternalHost,
          ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY: PAYLOAD_KEY,
          OPENAI_BASE_URL: processKind === 'worker'
            ? 'http://127.0.0.1:8766/v1'
            : 'http://127.0.0.1:9/v1',
          ...(processKind === 'worker'
            ? {
                ARCANOS_PREVIEW_OPENAI_FIXTURE:
                  'backstage-heavy-compact-retry-v1',
              }
            : {
                ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED: 'true',
                ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN: TEST_PROOF_WEB_CREDENTIAL,
                ARCANOS_JOB_READ_CAPABILITY_SECRET: JOB_READ_SECRET,
              }),
        }
      : {}),
  };
}

function controlPlanePayloads(config) {
  const web = appService(
    config.webServiceId,
    config.webServiceName,
    config.webDeploymentId,
    'web',
    [{ domain: WEB_DOMAIN }]
  );
  const worker = appService(
    config.workerServiceId,
    config.workerServiceName,
    config.workerDeploymentId,
    'worker'
  );
  const postgres = dataService(
    config.postgresServiceId,
    config.postgresServiceName,
    '99999999-9999-4999-8999-999999999999'
  );
  const redis = dataService(
    config.redisServiceId,
    config.redisServiceName,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  return {
    status: {
      id: config.projectId,
      name: 'arc-pr1460-heavy-test',
      workspaceId: '1c9265a3-986f-4304-ad3e-5a874caab039',
      deletedAt: null,
      services: {
        edges: [
          { node: { id: config.webServiceId, name: config.webServiceName } },
          { node: { id: config.workerServiceId, name: config.workerServiceName } },
          { node: { id: config.postgresServiceId, name: 'Postgres' } },
          { node: { id: config.redisServiceId, name: 'Redis' } },
        ],
      },
      environments: {
        edges: [{
          node: {
            id: config.environmentId,
            name: config.environmentName,
            deletedAt: null,
            serviceInstances: {
              edges: [web, worker, postgres, redis].map(node => ({ node })),
            },
            volumeInstances: {
              edges: [
                {
                  node: {
                    id: '12121212-1212-4212-8212-121212121212',
                    serviceId: config.postgresServiceId,
                    mountPath: '/var/lib/postgresql/data',
                    deletedAt: null,
                    isPendingDeletion: false,
                    state: 'READY',
                  },
                },
                {
                  node: {
                    id: '13131313-1313-4313-8313-131313131313',
                    serviceId: config.redisServiceId,
                    mountPath: '/data',
                    deletedAt: null,
                    isPendingDeletion: false,
                    state: 'READY',
                  },
                },
              ],
            },
          },
        }],
      },
    },
    webDomains: {
      domains: [{ id: ID.webDomain, domain: WEB_DOMAIN, type: 'service' }],
    },
    workerDomains: { domains: [] },
    postgresDomains: { domains: [] },
    redisDomains: { domains: [] },
    postgresTcpProxies: { proxies: [] },
    redisTcpProxies: { proxies: [] },
    webDeployments: [deployment(config.webDeploymentId, 'web')],
    workerDeployments: [deployment(config.workerDeploymentId, 'worker')],
    webVariables: variables(
      config,
      config.webServiceId,
      config.webServiceName,
      'web'
    ),
    workerVariables: variables(
      config,
      config.workerServiceId,
      config.workerServiceName,
      'worker'
    ),
    postgresVariables: variables(
      config,
      config.postgresServiceId,
      'Postgres'
    ),
    redisVariables: variables(config, config.redisServiceId, 'Redis'),
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function executedFetchHarness(options = {}) {
  const calls = [];
  const jobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const jobReadToken = `v1.${'C'.repeat(43)}`;
  const idempotencyKey = `derived:${'D'.repeat(16)}`;
  let submissionsStarted = 0;
  let releaseSubmissions;
  const bothSubmissionsStarted = new Promise(resolve => {
    releaseSubmissions = resolve;
  });
  let authorizedPolls = 0;
  const fetchImpl = jest.fn(async (url, requestOptions = {}) => {
    calls.push({ url, options: requestOptions });
    if (requestOptions.method === 'POST') {
      submissionsStarted += 1;
      if (submissionsStarted === 2) releaseSubmissions();
      await bothSubmissionsStarted;
      const requestId = requestOptions.headers['x-request-id'];
      const traceId = requestOptions.headers['x-trace-id'];
      const created = requestId.endsWith('-a');
      return jsonResponse({
        jobId,
        jobReadToken,
        jobReadTokenHeader: 'x-arcanos-job-read-token',
        poll: `/jobs/${jobId}/result`,
        idempotencySource: 'derived',
        idempotencyKey,
        deduped: !created,
      }, 202, {
        'x-gpt-queue-bypassed': 'false',
        'x-gpt-route-decision-reason':
          options.routeReason ?? 'backstage_prompt_size',
        'x-request-id': requestId,
        'x-trace-id': traceId,
      });
    }
    const readToken = requestOptions.headers?.['x-arcanos-job-read-token'];
    if (!readToken) {
      return jsonResponse({ status: 'not_found', result: null });
    }
    authorizedPolls += 1;
    if (authorizedPolls === 1) {
      return jsonResponse({ status: 'pending' });
    }
    const finalOutput = options.finalOutput
      ?? BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT;
    return jsonResponse({
      status: 'completed',
      jobStatus: 'completed',
      lifecycleStatus: 'completed',
      error: null,
      result: {
        ok: true,
        result: finalOutput,
        _route: {
          gptId: 'backstage-booker',
          action: 'generateBooking',
          requestId: 'bh-proof-run-1460-a',
          traceId: 'bht-proof-run-1460-a',
        },
      },
    });
  });
  return { calls, fetchImpl, jobId };
}

describe('Backstage heavy network proof', () => {
  it('is dry-run by default and builds a queued structured six-item 6000-token request', async () => {
    const config = resolveBackstageHeavyProbeConfig(configArgs());
    await expect(runBackstageHeavyProbe(config, {
      fetchImpl: () => {
        throw new Error('network should not run');
      },
    })).resolves.toMatchObject({ mode: 'dry-run', networkRequests: 0 });

    const prompt = buildBackstageHeavyProbePrompt(config.runId);
    expect(prompt).toContain('Generate exactly six numbered booking items');
    expect(prompt.length).toBeGreaterThanOrEqual(1_200);
    expect(shouldPreferDirectAnswerMode(prompt)).toBe(false);
    expect(classifyBackstageBookerWorkload({
      action: 'generateBooking',
      authorizationEstablished: true,
      requestedExecutionMode: 'sync',
      promptCodeUnits: prompt.length,
      contextCodeUnits: 0,
      expectedItemCount: 6,
      expectedOutputWords: 600,
      notionAuthorityContext: false,
      completeBookingContainerComponentCount: false,
      providerInvocationRequired: true,
    })).toMatchObject({
      workloadClass: 'production_generation',
      queueRequired: true,
      reason: 'prompt_size',
    });
    const budget = resolveBackstageOutputBudget({
      action: 'generateBooking',
      profile: 'queued_generation',
      requestedFormat: 'structured_booking',
      requestedTokenLimit: 2_400,
      configuredWorkerTokenLimit: 6_000,
      promptCodeUnits: prompt.length,
      retrievedContextCodeUnits: 0,
      expectedOutputWords: 600,
      model: 'gpt-5.1',
      modelStageTimeoutMs: 80_000,
    });
    expect(budget).toMatchObject({
      budgetClass: 'queued_extended',
      tokenLimit: 6_000,
      tokenCap: 6_000,
    });
    const compactContract = resolveBackstageCompactOutputContract(prompt, 6_000);
    expect(compactContract.itemPolicy).toMatchObject({ mode: 'exact', count: 6 });
    expect(isBackstageBookerCompactRetryOutputValid(
      BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT,
      compactContract
    )).toBe(true);
    expect(isBackstageBookerCompactRetryOutputValid(
      BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT.split('\n').slice(0, 5).join('\n'),
      compactContract
    )).toBe(false);
    expect(isBackstageBookerCompactRetryOutputValid(
      `${BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT}\n7. A seventh fictional item is forbidden.`,
      compactContract
    )).toBe(false);
  });

  it('attests exact four-service, two-volume, secret-isolated topology', () => {
    const config = resolveBackstageHeavyProbeConfig(configArgs(true));
    const payloads = controlPlanePayloads(config);
    expect(attestBackstageHeavyRailwayControlPlane(payloads, config)).toMatchObject({
      projectId: ID.project,
      environmentId: ID.environment,
    });
    const withoutRailwayGitSha = structuredClone(payloads);
    delete withoutRailwayGitSha.webVariables.RAILWAY_GIT_COMMIT_SHA;
    delete withoutRailwayGitSha.workerVariables.RAILWAY_GIT_COMMIT_SHA;
    expect(attestBackstageHeavyRailwayControlPlane(
      withoutRailwayGitSha,
      config
    )).toMatchObject({ projectId: ID.project });
    const wrongMarkerWithoutRailwayGit = structuredClone(
      withoutRailwayGitSha
    );
    wrongMarkerWithoutRailwayGit.workerVariables
      .ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA = 'b'.repeat(40);
    expect(() => attestBackstageHeavyRailwayControlPlane(
      wrongMarkerWithoutRailwayGit,
      config
    )).toThrow('BACKSTAGE_HEAVY_PROBE_RAILWAY_VARIABLE_IDENTITY_MISMATCH');

    const wrongManifestWithoutRailwayGit = structuredClone(
      withoutRailwayGitSha
    );
    wrongManifestWithoutRailwayGit.status.environments.edges[0].node
      .serviceInstances.edges.find(
        edge => edge.node.serviceId === config.workerServiceId
      ).node.latestDeployment.meta.commitHash = 'b'.repeat(40);
    expect(() => attestBackstageHeavyRailwayControlPlane(
      wrongManifestWithoutRailwayGit,
      config
    )).toThrow('BACKSTAGE_HEAVY_PROBE_RAILWAY_DEPLOYMENT_MISMATCH');
    const missingProofSource = structuredClone(payloads);
    delete missingProofSource.workerVariables
      .ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA;
    expect(() => attestBackstageHeavyRailwayControlPlane(
      missingProofSource,
      config
    )).toThrow('BACKSTAGE_HEAVY_PROBE_RAILWAY_VARIABLE_IDENTITY_MISMATCH');
    for (const [name, value] of [
      ['ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA', 'b'.repeat(40)],
      ['ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA', 'A'.repeat(40)],
      ['ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA', ` ${'a'.repeat(40)}`],
      ['RAILWAY_GIT_COMMIT_SHA', 'b'.repeat(40)],
      ['RAILWAY_GIT_COMMIT_SHA', ''],
      ['RAILWAY_GIT_COMMIT_SHA', 'A'.repeat(40)],
      ['RAILWAY_GIT_COMMIT_SHA', `${'a'.repeat(40)} `],
    ]) {
      const mismatchedSource = structuredClone(payloads);
      mismatchedSource.workerVariables[name] = value;
      expect(() => attestBackstageHeavyRailwayControlPlane(
        mismatchedSource,
        config
      )).toThrow('BACKSTAGE_HEAVY_PROBE_RAILWAY_VARIABLE_IDENTITY_MISMATCH');
    }
    const maxProjectSuffix = structuredClone(payloads);
    maxProjectSuffix.status.name = `arc-pr1460-heavy-${'a'.repeat(14)}`;
    expect(attestBackstageHeavyRailwayControlPlane(
      maxProjectSuffix,
      config
    )).toMatchObject({ projectId: ID.project });
    for (const projectName of [
      `arc-pr1460-heavy-${'a'.repeat(15)}`,
      'arc-pr1460-heavy-MixedCase',
      'arcanos-pr-1460-heavy-e2e-test',
    ]) {
      const invalidProject = structuredClone(payloads);
      invalidProject.status.name = projectName;
      expect(() => attestBackstageHeavyRailwayControlPlane(
        invalidProject,
        config
      )).toThrow('BACKSTAGE_HEAVY_PROBE_RAILWAY_PROJECT_NAME_INVALID');
    }
    const overTotalLength = structuredClone(payloads);
    overTotalLength.status.name = `arc-pr146000-heavy-${'a'.repeat(14)}`;
    expect(() => attestBackstageHeavyRailwayControlPlane(
      overTotalLength,
      {
        ...config,
        environmentName: 'backstage-heavy-pr-146000-e2e',
      }
    )).toThrow('BACKSTAGE_HEAVY_PROBE_RAILWAY_PROJECT_NAME_INVALID');
    const slashRedisPath = structuredClone(payloads);
    const slashRedisUrl = `${REDIS_URL}/`;
    slashRedisPath.webVariables.REDIS_URL = slashRedisUrl;
    slashRedisPath.workerVariables.REDIS_URL = slashRedisUrl;
    slashRedisPath.redisVariables.REDIS_URL = slashRedisUrl;
    expect(attestBackstageHeavyRailwayControlPlane(
      slashRedisPath,
      config
    )).toMatchObject({ projectId: ID.project });

    for (const domains of [
      [WEB_DOMAIN],
      [{ id: ID.webDomain, domain: `https://${WEB_DOMAIN}`, type: 'service' }],
      [{ id: ID.webDomain, domain: WEB_DOMAIN.toUpperCase(), type: 'service' }],
      [{ id: ID.webDomain, domain: WEB_DOMAIN, type: 'custom' }],
      [{ id: 'not-a-uuid', domain: WEB_DOMAIN, type: 'service' }],
    ]) {
      const invalidDomainList = structuredClone(payloads);
      invalidDomainList.webDomains = { domains };
      expect(() => attestBackstageHeavyRailwayControlPlane(
        invalidDomainList,
        config
      )).toThrow('BACKSTAGE_HEAVY_PROBE_RAILWAY_DOMAIN_LIST_MISMATCH');
    }

    expect(() => attestBackstageHeavyRailwayControlPlane({
      ...payloads,
      workerVariables: {
        ...payloads.workerVariables,
        DATABASE_PRIVATE_URL: 'postgresql://hostile.invalid/db',
      },
    }, config)).toThrow('BACKSTAGE_HEAVY_PROBE_DATA_ALIAS_FORBIDDEN');
    expect(() => attestBackstageHeavyRailwayControlPlane({
      ...payloads,
      webVariables: {
        ...payloads.webVariables,
        OPENAI_API_KEY: 'forbidden',
      },
    }, config)).toThrow('BACKSTAGE_HEAVY_PROBE_PROVIDER_ENV_FORBIDDEN');
    expect(() => attestBackstageHeavyRailwayControlPlane({
      ...payloads,
      workerVariables: {
        ...payloads.workerVariables,
        AZURE_OPENAI_API_KEY: 'forbidden',
      },
    }, config)).toThrow('BACKSTAGE_HEAVY_PROBE_PROVIDER_ENV_FORBIDDEN');
    expect(() => attestBackstageHeavyRailwayControlPlane({
      ...payloads,
      postgresTcpProxies: { proxies: [{ domain: 'public.invalid' }] },
    }, config)).toThrow('BACKSTAGE_HEAVY_PROBE_RAILWAY_TCP_PROXY_MISMATCH');
    const duplicateVolumeService = structuredClone(payloads);
    const volumeEdges = duplicateVolumeService.status.environments.edges[0]
      .node.volumeInstances.edges;
    volumeEdges[1].node.serviceId = volumeEdges[0].node.serviceId;
    expect(() => attestBackstageHeavyRailwayControlPlane(
      duplicateVolumeService,
      config
    )).toThrow('BACKSTAGE_HEAVY_PROBE_RAILWAY_VOLUME_TOPOLOGY_MISMATCH');
    const duplicateVolumeId = structuredClone(payloads);
    const duplicateIdEdges = duplicateVolumeId.status.environments.edges[0]
      .node.volumeInstances.edges;
    duplicateIdEdges[1].node.id = duplicateIdEdges[0].node.id;
    expect(() => attestBackstageHeavyRailwayControlPlane(
      duplicateVolumeId,
      config
    )).toThrow('BACKSTAGE_HEAVY_PROBE_RAILWAY_VOLUME_TOPOLOGY_MISMATCH');
    const overlapping = structuredClone(payloads);
    overlapping.status.environments.edges[0].node.serviceInstances.edges[0]
      .node.latestDeployment.instances.push({ status: 'RUNNING' });
    expect(() => attestBackstageHeavyRailwayControlPlane(
      overlapping,
      config
    )).toThrow('BACKSTAGE_HEAVY_PROBE_RAILWAY_DEPLOYMENT_MISMATCH');
    const restartable = structuredClone(payloads);
    restartable.status.environments.edges[0].node.serviceInstances.edges[0]
      .node.latestDeployment.meta.serviceManifest.deploy.restartPolicyType =
        'ON_FAILURE';
    expect(() => attestBackstageHeavyRailwayControlPlane(
      restartable,
      config
    )).toThrow('BACKSTAGE_HEAVY_PROBE_RAILWAY_DEPLOYMENT_MISMATCH');
    for (const restartPolicyMaxRetries of [0, 1]) {
      const retryCountConfigured = structuredClone(payloads);
      retryCountConfigured.status.environments.edges[0]
        .node.serviceInstances.edges[0].node.latestDeployment
        .meta.serviceManifest.deploy.restartPolicyMaxRetries =
          restartPolicyMaxRetries;
      expect(() => attestBackstageHeavyRailwayControlPlane(
        retryCountConfigured,
        config
      )).toThrow('BACKSTAGE_HEAVY_PROBE_RAILWAY_DEPLOYMENT_MISMATCH');
    }
  });

  it('counts one running app replica independently of pre-deploy history', () => {
    const config = resolveBackstageHeavyProbeConfig(configArgs(true));
    const readApp = (payloads, serviceId) => (
      payloads.status.environments.edges[0].node.serviceInstances.edges
        .find(edge => edge.node.serviceId === serviceId).node
    );
    const setInstances = (service, latestInstances, activeInstances) => {
      service.latestDeployment.instances = latestInstances;
      service.activeDeployments[0].instances =
        activeInstances ?? structuredClone(latestInstances);
    };

    const compacted = controlPlanePayloads(config);
    for (const serviceId of [config.webServiceId, config.workerServiceId]) {
      const service = readApp(compacted, serviceId);
      const running = service.latestDeployment.instances.find(
        instance => instance.status === 'RUNNING'
      );
      setInstances(service, [running]);
    }
    expect(attestBackstageHeavyRailwayControlPlane(
      compacted,
      config
    )).toMatchObject({ projectId: ID.project });

    const removedTerminalHistory = controlPlanePayloads(config);
    for (const serviceId of [config.webServiceId, config.workerServiceId]) {
      const service = readApp(removedTerminalHistory, serviceId);
      const instances = structuredClone(service.latestDeployment.instances);
      instances[0].status = 'REMOVED';
      setInstances(service, instances.reverse());
    }
    expect(attestBackstageHeavyRailwayControlPlane(
      removedTerminalHistory,
      config
    )).toMatchObject({ projectId: ID.project });

    for (const status of [
      'RUNNING',
      'CREATED',
      'INITIALIZING',
      'RESTARTING',
      'CRASHED',
      'STOPPED',
      'SKIPPED',
    ]) {
      const invalid = controlPlanePayloads(config);
      const service = readApp(invalid, config.workerServiceId);
      const instances = structuredClone(service.latestDeployment.instances);
      instances[0].status = status;
      setInstances(service, instances);
      expect(() => attestBackstageHeavyRailwayControlPlane(
        invalid,
        config
      )).toThrow('BACKSTAGE_HEAVY_PROBE_RAILWAY_DEPLOYMENT_MISMATCH');
    }

    const duplicateId = controlPlanePayloads(config);
    const duplicateService = readApp(duplicateId, config.workerServiceId);
    const duplicateInstances = structuredClone(
      duplicateService.latestDeployment.instances
    );
    duplicateInstances[0].id = duplicateInstances[1].id;
    setInstances(duplicateService, duplicateInstances);
    expect(() => attestBackstageHeavyRailwayControlPlane(
      duplicateId,
      config
    )).toThrow('BACKSTAGE_HEAVY_PROBE_RAILWAY_DEPLOYMENT_MISMATCH');

    const noRunning = controlPlanePayloads(config);
    const stoppedService = readApp(noRunning, config.workerServiceId);
    const stoppedInstances = structuredClone(
      stoppedService.latestDeployment.instances
    );
    stoppedInstances[1].status = 'REMOVED';
    setInstances(stoppedService, stoppedInstances);
    expect(() => attestBackstageHeavyRailwayControlPlane(
      noRunning,
      config
    )).toThrow('BACKSTAGE_HEAVY_PROBE_RAILWAY_DEPLOYMENT_MISMATCH');

    const mismatchedView = controlPlanePayloads(config);
    const mismatchedService = readApp(
      mismatchedView,
      config.workerServiceId
    );
    const activeInstances = structuredClone(
      mismatchedService.activeDeployments[0].instances
    );
    activeInstances.find(instance => instance.status === 'RUNNING').id =
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    setInstances(
      mismatchedService,
      mismatchedService.latestDeployment.instances,
      activeInstances
    );
    expect(() => attestBackstageHeavyRailwayControlPlane(
      mismatchedView,
      config
    )).toThrow('BACKSTAGE_HEAVY_PROBE_RAILWAY_DEPLOYMENT_MISMATCH');
  });

  it('attests exact role-specific pre-deploy commands in every app manifest', () => {
    const config = resolveBackstageHeavyProbeConfig(configArgs(true));
    const payloads = controlPlanePayloads(config);
    const statusDeployment = (candidatePayloads, serviceId) => (
      candidatePayloads.status.environments.edges[0].node
        .serviceInstances.edges.find(
          edge => edge.node.serviceId === serviceId
        ).node.latestDeployment
    );
    const manifestCases = [
      {
        expected: WEB_PREDEPLOY_COMMAND,
        failure: 'BACKSTAGE_HEAVY_PROBE_RAILWAY_DEPLOYMENT_MISMATCH',
        opposite: WORKER_PREDEPLOY_COMMAND,
        readDeployment: candidatePayloads => statusDeployment(
          candidatePayloads,
          config.webServiceId
        ),
      },
      {
        expected: WORKER_PREDEPLOY_COMMAND,
        failure: 'BACKSTAGE_HEAVY_PROBE_RAILWAY_DEPLOYMENT_MISMATCH',
        opposite: WEB_PREDEPLOY_COMMAND,
        readDeployment: candidatePayloads => statusDeployment(
          candidatePayloads,
          config.workerServiceId
        ),
      },
      {
        expected: WEB_PREDEPLOY_COMMAND,
        failure: 'BACKSTAGE_HEAVY_PROBE_RAILWAY_DEPLOYMENT_LIST_MISMATCH',
        opposite: WORKER_PREDEPLOY_COMMAND,
        readDeployment: candidatePayloads => candidatePayloads.webDeployments[0],
      },
      {
        expected: WORKER_PREDEPLOY_COMMAND,
        failure: 'BACKSTAGE_HEAVY_PROBE_RAILWAY_DEPLOYMENT_LIST_MISMATCH',
        opposite: WEB_PREDEPLOY_COMMAND,
        readDeployment: candidatePayloads => candidatePayloads.workerDeployments[0],
      },
    ];

    expect(attestBackstageHeavyRailwayControlPlane(
      payloads,
      config
    )).toMatchObject({ projectId: ID.project });
    for (const manifestCase of manifestCases) {
      expect(
        manifestCase.readDeployment(payloads)
          .meta.serviceManifest.deploy.preDeployCommand
      ).toEqual([manifestCase.expected]);
      for (const invalidCommand of [
        undefined,
        null,
        manifestCase.expected,
        [],
        [null],
        [42],
        [manifestCase.expected, manifestCase.opposite],
        [manifestCase.opposite],
      ]) {
        const invalidPayloads = structuredClone(payloads);
        const deploy = manifestCase.readDeployment(invalidPayloads)
          .meta.serviceManifest.deploy;
        if (invalidCommand === undefined) {
          delete deploy.preDeployCommand;
        } else {
          deploy.preDeployCommand = invalidCommand;
        }
        expect(() => attestBackstageHeavyRailwayControlPlane(
          invalidPayloads,
          config
        )).toThrow(manifestCase.failure);
      }
    }
  });

  it('executes the concurrent derived-dedupe submission and protected result path', async () => {
    const config = resolveBackstageHeavyProbeConfig(configArgs(true));
    const harness = executedFetchHarness();
    await expect(runBackstageHeavyProbe(config, {
      env: {
        ARCANOS_BACKSTAGE_HEAVY_PROBE_BEARER: TEST_PROOF_WEB_CREDENTIAL,
      },
      fetchImpl: harness.fetchImpl,
      railwayPayloads: controlPlanePayloads(config),
      sleep: async () => undefined,
      now: () => 0,
    })).resolves.toMatchObject({
      mode: 'executed',
      runId: 'proof-run-1460',
      jobId: harness.jobId,
      requestId: 'bh-proof-run-1460-a',
      traceId: 'bht-proof-run-1460-a',
      duplicatePrevented: true,
      pendingObserved: true,
      compactRetryResultObserved: true,
      unauthorizedResultConcealed: true,
    });

    const submissions = harness.calls.filter(call => (
      call.options.method === 'POST'
    ));
    expect(submissions).toHaveLength(2);
    expect(submissions[0].options.body).toBe(submissions[1].options.body);
    expect(submissions.every(call => (
      !Object.keys(call.options.headers).some(
        name => name.toLowerCase() === 'idempotency-key'
      )
    ))).toBe(true);
    expect(JSON.parse(submissions[0].options.body)).toMatchObject({
      action: 'generateBooking',
      executionMode: 'sync',
      payload: { universeId: 'fixture-proof-run-1460' },
    });
    expect(harness.calls.filter(call => (
      call.options.method === 'GET'
      && !call.options.headers?.['x-arcanos-job-read-token']
    ))).toHaveLength(1);
  });

  it('fails closed on a mismatched heavy-route response header', async () => {
    const config = resolveBackstageHeavyProbeConfig(configArgs(true));
    const harness = executedFetchHarness({ routeReason: 'unexpected_reason' });
    await expect(runBackstageHeavyProbe(config, {
      env: {
        ARCANOS_BACKSTAGE_HEAVY_PROBE_BEARER: TEST_PROOF_WEB_CREDENTIAL,
      },
      fetchImpl: harness.fetchImpl,
      railwayPayloads: controlPlanePayloads(config),
    })).rejects.toThrow('BACKSTAGE_HEAVY_PROBE_SUBMISSION_STATUS_INVALID');
  });

  it('coarsens secret-bearing response and transport error prefixes', async () => {
    const config = resolveBackstageHeavyProbeConfig(configArgs(true));
    const sensitiveMarker = 'probe-response-secret-must-not-reflect';
    for (const fetchImpl of [
      async () => new Response(
        `BACKSTAGE_HEAVY_PROBE_TERMINAL_RESULT_INVALID:${sensitiveMarker}`
      ),
      async () => {
        throw new Error(
          `BACKSTAGE_HEAVY_PROBE_RESPONSE_TOO_LARGE:${sensitiveMarker}`
        );
      },
    ]) {
      const error = await runBackstageHeavyProbe(config, {
        env: {
          ARCANOS_BACKSTAGE_HEAVY_PROBE_BEARER:
            TEST_PROOF_WEB_CREDENTIAL,
        },
        fetchImpl,
        railwayPayloads: controlPlanePayloads(config),
      }).catch(caught => caught);
      expect(error).toEqual(
        new Error('BACKSTAGE_HEAVY_PROBE_RESPONSE_INVALID')
      );
      expect(error.message).not.toContain(sensitiveMarker);
    }
  });

  it('uses a shell-free Windows CLI invocation, bounded array JSON, and a credential-minimal child env', async () => {
    expect(railwayInvocationForBackstageHeavyProbe(
      'win32',
      'C:\\Users\\proof\\AppData\\Roaming',
      'C:\\node.exe'
    )).toEqual({
      executable: 'C:\\node.exe',
      argsPrefix: [
        'C:\\Users\\proof\\AppData\\Roaming\\npm\\node_modules\\@railway\\cli\\bin\\railway.js',
      ],
    });
    expect(buildBackstageHeavyRailwayCliEnvironment({
      PATH: 'safe-path',
      APPDATA: 'safe-appdata',
      RAILWAY_TOKEN: 'railway-token',
      ARCANOS_BACKSTAGE_HEAVY_PROBE_BEARER: 'must-not-cross',
      DATABASE_URL: DATABASE_URL,
      OPENAI_API_KEY: 'test-must-not-cross',
      HTTP_PROXY: 'must-not-cross',
      NODE_OPTIONS: '--import=must-not-cross',
    })).toEqual({
      CI: 'true',
      NO_COLOR: '1',
      PATH: 'safe-path',
      APPDATA: 'safe-appdata',
      RAILWAY_TOKEN: 'railway-token',
    });

    const config = resolveBackstageHeavyProbeConfig(configArgs(true));
    const calls = [];
    const fakeExec = async (executable, args, options) => {
      calls.push({ executable, args, options });
      const command = args.join(' ');
      return {
        stdout: command.includes('deployment list') ? '[]' : '{}',
      };
    };
    const payloads = await readRailwayControlPlaneAttestation(
      config,
      fakeExec,
      {
        PATH: 'safe-path',
        APPDATA: 'safe-appdata',
        RAILWAY_TOKEN: 'railway-token',
        ARCANOS_BACKSTAGE_HEAVY_PROBE_BEARER: 'must-not-cross',
        DATABASE_URL,
      },
      { executable: 'C:\\node.exe', argsPrefix: ['railway.js'] }
    );
    expect(calls).toHaveLength(13);
    expect(calls.every(call => call.executable === 'C:\\node.exe')).toBe(true);
    expect(calls.every(call => call.args[0] === 'railway.js')).toBe(true);
    expect(calls.every(call => !('DATABASE_URL' in call.options.env))).toBe(true);
    expect(calls.map(call => call.args.join(' ')).join('\n')).toContain(
      `tcp-proxy list --project ${ID.project}`
    );
    expect(calls.map(call => call.args.join(' ')).join('\n')).toContain(
      `variable list --project ${ID.project}`
    );
    expect(payloads.webDeployments).toEqual([]);
    expect(payloads.workerDeployments).toEqual([]);
    expect(payloads).toHaveProperty('postgresVariables');
    expect(payloads).toHaveProperty('redisVariables');

    const railwaySecret = 'railway-cli-secret-must-not-reflect';
    for (const injectedMessage of [
      'BACKSTAGE_HEAVY_PROBE_RAILWAY_DEPLOYMENT_MISMATCH',
      `BACKSTAGE_HEAVY_PROBE_RAILWAY_STATUS_UNAVAILABLE:${railwaySecret}`,
    ]) {
      const error = await readRailwayControlPlaneAttestation(
        config,
        async () => {
          throw new Error(injectedMessage);
        },
        { PATH: 'safe-path', APPDATA: 'safe-appdata' },
        { executable: 'C:\\node.exe', argsPrefix: ['railway.js'] }
      ).catch(caught => caught);
      expect(error).toEqual(
        new Error('BACKSTAGE_HEAVY_PROBE_RAILWAY_STATUS_UNAVAILABLE')
      );
      expect(error.message).not.toContain(railwaySecret);
    }
  });
});

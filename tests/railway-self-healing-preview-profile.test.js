import {
  SELF_HEALING_PREVIEW_PROFILE,
  SelfHealingPreviewProfileError,
  attestSelfHealingPreview,
  createSelfHealingPreviewOwnershipReceipt,
  planSelfHealingPreview,
  validateSelfHealingPreviewOwnershipReceipt,
} from '../scripts/railway-self-healing-preview-profile.mjs';

const PROJECT_ID = SELF_HEALING_PREVIEW_PROFILE.projectId;
const WORKSPACE_ID = SELF_HEALING_PREVIEW_PROFILE.workspaceId;
const PRODUCTION_ENVIRONMENT_ID = 'fb583147-6c39-4343-9267-500f357d25ab';
const PRODUCTION_WEB_ID = 'c4ade025-3f13-4fca-9309-5d0dd81396fe';
const HEAD_SHA = 'a'.repeat(40);
const BRANCH = 'codex/targeted-security-healing-20261012';
const PR_NUMBER = 1539;
const PLANNED_AT = '2026-10-12T14:00:00.000Z';
const CREATED_AT = '2026-10-12T14:00:01.000Z';
const OBSERVED_AT = '2026-10-12T14:00:02.000Z';
const NOW = '2026-10-12T14:00:03.000Z';
const id = number => `aaaaaaaa-aaaa-4aaa-8aaa-${String(number).padStart(12, '0')}`;
const SERVICE_IDS = { web: id(2), worker: id(3), postgres: id(4), redis: id(5) };
const VOLUME_IDS = { postgres: id(6), redis: id(7) };
const REDIS_AUTH_START_COMMAND = "sh -c 'exec redis-server --appendonly yes --requirepass \"$REDIS_PASSWORD\"'";
const APP_VARIABLE_NAMES = [
  'ARCANOS_PROCESS_KIND', 'NODE_ENV', 'ARCANOS_PREVIEW_ISOLATION', 'FORCE_MOCK',
  'ALLOW_MOCK_OPENAI', 'OPENAI_API_KEY_REQUIRED', 'OPENAI_BASE_URL',
  'DATABASE_URL', 'REDIS_URL', 'RUN_WORKERS',
];

function planningInput() {
  return {
    pullRequest: {
      number: PR_NUMBER, state: 'open', draft: false, labels: [],
      base: { ref: 'main', repo: { full_name: 'pbjustin/Arcanos' } },
      head: { ref: BRANCH, sha: HEAD_SHA, repo: { full_name: 'pbjustin/Arcanos' } },
    },
    prNumber: PR_NUMBER,
    expectedHeadSha: HEAD_SHA,
    now: PLANNED_AT,
    inventory: {
      projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, complete: true,
      observedAt: '2026-10-12T13:59:59.000Z',
      environments: [{ id: PRODUCTION_ENVIRONMENT_ID, name: 'production' }],
      serviceIds: [PRODUCTION_WEB_ID, id(90)], volumeIds: [id(91)],
    },
  };
}

function receiptFor(plan) {
  return createSelfHealingPreviewOwnershipReceipt({
    plan, environmentId: id(1), serviceIds: SERVICE_IDS, volumeIds: VOLUME_IDS,
    createdAt: CREATED_AT, now: NOW,
  });
}

function deployment(role) {
  const app = role === 'web' || role === 'worker';
  return {
    id: id(20 + Object.keys(SERVICE_IDS).indexOf(role)),
    projectId: PROJECT_ID, environmentId: id(1), serviceId: SERVICE_IDS[role],
    status: 'SUCCESS', repository: app ? 'pbjustin/Arcanos' : null,
    branch: app ? BRANCH : null, sourceCommit: app ? HEAD_SHA : null,
    image: app ? null : `${role === 'postgres' ? 'postgres:18' : 'redis:7.4-alpine'}@sha256:${'b'.repeat(64)}`,
  };
}

function app(role) {
  return {
    id: SERVICE_IDS[role], name: `self-healing-pr${PR_NUMBER}-${role}`,
    role, environmentIds: [id(1)], replicas: 1, startCommand: SELF_HEALING_PREVIEW_PROFILE.startCommand,
    source: { repository: 'pbjustin/Arcanos', branch: BRANCH, sourceCommit: HEAD_SHA },
    activeDeployments: [deployment(role)],
    publicDomains: role === 'web' ? [{
      hostname: `self-healing-pr${PR_NUMBER}-web-proof.up.railway.app`,
      environmentId: id(1), serviceId: SERVICE_IDS.web,
    }] : [],
    tcpProxies: [], variableNames: [...APP_VARIABLE_NAMES],
    configuration: {
      nodeEnv: 'production', processKind: role, previewIsolation: true,
      forceMock: true, allowMockOpenAI: true, openAIKeyRequired: false,
      openAIBaseUrl: 'http://127.0.0.1:4050/v1', runWorkers: role === 'worker',
    },
    dependencies: {
      postgres: { serviceId: SERVICE_IDS.postgres,
        host: `self-healing-pr${PR_NUMBER}-postgres.railway.internal`, port: 5432 },
      redis: { serviceId: SERVICE_IDS.redis,
        host: `self-healing-pr${PR_NUMBER}-redis.railway.internal`, port: 6379 },
    },
    credentials: [], controlPlane: null,
  };
}

function data(role) {
  return {
    id: SERVICE_IDS[role], name: `self-healing-pr${PR_NUMBER}-${role}`,
    role, environmentIds: [id(1)], replicas: 1, activeDeployments: [deployment(role)],
    publicDomains: [], tcpProxies: [],
    variableNames: role === 'postgres'
      ? ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB'] : ['REDIS_PASSWORD'],
    privateHost: `self-healing-pr${PR_NUMBER}-${role}.railway.internal`,
    port: role === 'postgres' ? 5432 : 6379,
    volume: { id: VOLUME_IDS[role],
      mountPath: role === 'postgres' ? '/var/lib/postgresql' : '/data' },
    credential: { name: role === 'postgres' ? 'POSTGRES_PASSWORD' : 'REDIS_PASSWORD',
      provenance: 'preview-created', createdAt: CREATED_AT,
      fingerprint: (role === 'postgres' ? 'd' : 'e').repeat(64) },
    startCommand: role === 'postgres' ? null : REDIS_AUTH_START_COMMAND,
  };
}

function fixture() {
  const plan = planSelfHealingPreview(planningInput());
  const receipt = receiptFor(plan);
  return {
    plan, receipt, now: NOW,
    observation: {
      complete: true, observedAt: OBSERVED_AT, projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID, externalPreviewWebhookCount: 0, pendingChanges: false,
      environment: {
        id: id(1), name: `self-healing-pr-${PR_NUMBER}-e2e`,
        sourceEnvironmentId: null, isEphemeral: true,
        sharedVariableNames: [], deploymentTriggers: [],
        serviceIds: Object.values(SERVICE_IDS), volumeIds: Object.values(VOLUME_IDS), bucketIds: [],
      },
      services: [app('web'), app('worker'), data('postgres'), data('redis')],
    },
  };
}

function expectCode(action, code) {
  try {
    action();
    throw new Error('The profile accepted an unsafe fixture.');
  } catch (error) {
    expect(error).toBeInstanceOf(SelfHealingPreviewProfileError);
    expect(error.code).toBe(code);
  }
}

test('plans only a separate, empty normal namespace and returns no mutation or live proof', () => {
  const result = fixture();
  expect(result.plan.environmentName).toBe('self-healing-pr-1539-e2e');
  expect(result.plan.sourceEnvironmentId).toBeNull();
  expect(result.plan.startCommand).not.toContain('--pr-preview');
  expect(Object.isFrozen(result.plan.preexistingServiceIds)).toBe(true);
  const evidence = attestSelfHealingPreview(result);
  expect(evidence).toMatchObject({
    evidenceKind: 'credential-free-profile-contract', profileValidated: true,
    deploymentExecutionPerformed: false, liveRuntimeAcceptance: 'NOT_RUN', sourceCommit: HEAD_SHA,
    supportedRuntime: 'mock-baseline-only', selfHealingRuntimeAcceptanceSupported: false,
    authenticatedRuntimeExecutionVerified: false,
    storageAuthenticationVerified: false, storageDurabilityVerified: false,
  });
  expect(evidence.deploymentIds).toHaveProperty('worker', id(21));
});

test.each([
  ['closed', input => { input.pullRequest.state = 'closed'; }],
  ['draft', input => { input.pullRequest.draft = true; }],
  ['wrong base', input => { input.pullRequest.base.ref = 'develop'; }],
  ['moved head', input => { input.expectedHeadSha = 'b'.repeat(40); }],
])('rejects %s before a creation receipt can be produced', (_name, change) => {
  const input = planningInput(); change(input);
  expectCode(() => planSelfHealingPreview(input), 'SELF_HEALING_PREVIEW_PR_HEAD_MISMATCH');
});

test.each([
  ['fork', input => { input.pullRequest.head.repo.full_name = 'other/Arcanos'; }],
  ['invalid branch', input => { input.pullRequest.head.ref = 'branch~1'; }],
])('rejects %s PR metadata', (_name, change) => {
  const input = planningInput(); change(input);
  expectCode(() => planSelfHealingPreview(input), 'SELF_HEALING_PREVIEW_PR_INVALID');
});

test.each([
  ['other project', input => { input.inventory.projectId = id(80); }],
  ['other workspace', input => { input.inventory.workspaceId = id(81); }],
  ['truncated inventory', input => { input.inventory.complete = false; }],
  ['credential field', input => { input.inventory.token = 'test-only-rejected-token'; }],
])('rejects %s inventory', (_name, change) => {
  const input = planningInput(); change(input);
  expectCode(() => planSelfHealingPreview(input), 'SELF_HEALING_PREVIEW_INVENTORY_INVALID');
});

test.each([
  ['old', '2026-10-12T13:58:00.000Z'],
  ['future', '2026-10-12T14:00:01.000Z'],
])('rejects %s pre-creation inventory', (_name, observedAt) => {
  const input = planningInput(); input.inventory.observedAt = observedAt;
  expectCode(() => planSelfHealingPreview(input), 'SELF_HEALING_PREVIEW_INVENTORY_STALE');
});

test('requires complete production identity visibility without reading its variables', () => {
  const input = planningInput(); input.inventory.environments = [];
  expectCode(() => planSelfHealingPreview(input), 'SELF_HEALING_PREVIEW_INVENTORY_INCOMPLETE');
});

test('does not adopt an existing unmanaged environment by matching its name', () => {
  const input = planningInput();
  input.inventory.environments.push({ id: id(80), name: 'self-healing-pr-1539-e2e' });
  expectCode(() => planSelfHealingPreview(input), 'SELF_HEALING_PREVIEW_ALREADY_EXISTS');
});

test.each([
  ['production service', PRODUCTION_WEB_ID],
  ['preexisting unrelated service', id(90)],
  ['preexisting volume', id(91)],
  ['production environment', PRODUCTION_ENVIRONMENT_ID],
])('rejects %s as a newly owned service', (_name, unsafeId) => {
  const plan = planSelfHealingPreview(planningInput());
  expectCode(() => createSelfHealingPreviewOwnershipReceipt({
    plan, environmentId: id(1), serviceIds: { ...SERVICE_IDS, web: unsafeId },
    volumeIds: VOLUME_IDS, createdAt: CREATED_AT, now: NOW,
  }), 'SELF_HEALING_PREVIEW_RESOURCE_NOT_FRESH');
});

test('rejects reused service identities and partially created topology', () => {
  const result = fixture();
  const duplicate = structuredClone(result.receipt);
  duplicate.serviceIds.worker = duplicate.serviceIds.web;
  expectCode(() => validateSelfHealingPreviewOwnershipReceipt({ ...result, receipt: duplicate }),
    'SELF_HEALING_PREVIEW_RESOURCE_ID_INVALID');
  const partial = structuredClone(result.receipt); delete partial.volumeIds.redis;
  expectCode(() => validateSelfHealingPreviewOwnershipReceipt({ ...result, receipt: partial }),
    'SELF_HEALING_PREVIEW_OWNERSHIP_INVALID');
});

test('serialized ownership survives restart without making a new creation claim', () => {
  const result = fixture();
  const restored = JSON.parse(JSON.stringify({ plan: result.plan, receipt: result.receipt }));
  expect(validateSelfHealingPreviewOwnershipReceipt({
    ...restored, now: '2026-10-13T14:00:00.000Z',
  })).toEqual(result.receipt);
  restored.plan.sourceCommit = 'b'.repeat(40);
  expectCode(() => validateSelfHealingPreviewOwnershipReceipt({ ...restored, now: NOW }),
    'SELF_HEALING_PREVIEW_OWNERSHIP_INVALID');
});

test.each([
  ['before plan', '2026-10-12T13:59:58.000Z'],
  ['future', '2026-10-12T14:00:04.000Z'],
])('rejects creation timestamps %s', (_name, createdAt) => {
  const result = fixture();
  expectCode(() => validateSelfHealingPreviewOwnershipReceipt({
    ...result, receipt: { ...result.receipt, createdAt },
  }), 'SELF_HEALING_PREVIEW_CREATION_TIME_INVALID');
});

test('requires creation-time inventory freshness but retains valid historical ownership after restart', () => {
  const result = fixture();
  expectCode(() => validateSelfHealingPreviewOwnershipReceipt({
    ...result, now: '2026-10-13T14:00:00.000Z',
    receipt: { ...result.receipt, createdAt: '2026-10-13T13:00:00.000Z' },
  }), 'SELF_HEALING_PREVIEW_CREATION_TIME_INVALID');
});

test.each([
  ['clone', environment => { environment.sourceEnvironmentId = PRODUCTION_ENVIRONMENT_ID; }],
  ['shared variables', environment => { environment.sharedVariableNames.push('OPENAI_API_KEY'); }],
  ['automatic trigger', environment => { environment.deploymentTriggers.push({ id: id(70) }); }],
  ['bucket', environment => { environment.bucketIds.push(id(70)); }],
  ['wrong environment', environment => { environment.id = PRODUCTION_ENVIRONMENT_ID; }],
])('rejects %s environment contamination', (_name, change) => {
  const result = fixture(); change(result.observation.environment);
  expectCode(() => attestSelfHealingPreview(result), 'SELF_HEALING_PREVIEW_ENVIRONMENT_UNSAFE');
});

test.each([
  ['incomplete', observation => { observation.complete = false; }],
  ['preview webhook', observation => { observation.externalPreviewWebhookCount = 1; }],
  ['pending changes', observation => { observation.pendingChanges = true; }],
  ['secret value', observation => { observation.secret = 'test-only-rejected-secret'; }],
])('rejects %s observation', (_name, change) => {
  const result = fixture(); change(result.observation);
  expectCode(() => attestSelfHealingPreview(result), 'SELF_HEALING_PREVIEW_OBSERVATION_INVALID');
});

test('requires fresh observation after restart instead of trusting a saved healthy state', () => {
  const result = fixture(); result.now = '2026-10-13T14:00:00.000Z';
  expectCode(() => attestSelfHealingPreview(result), 'SELF_HEALING_PREVIEW_OBSERVATION_STALE');
});

test.each([
  ['missing worker', result => { result.observation.services.splice(1, 1); }],
  ['extra instance', result => { result.observation.services.push(app('worker')); }],
  ['extra volume', result => { result.observation.environment.volumeIds.push(id(80)); }],
  ['replaced role', result => { result.observation.services[1].role = 'web'; }],
])('rejects %s topology', (_name, change) => {
  const result = fixture(); change(result);
  expectCode(() => attestSelfHealingPreview(result), 'SELF_HEALING_PREVIEW_TOPOLOGY_INVALID');
});

test.each([
  ['web', 0], ['worker', 1],
])('requires exact-head successful %s deployment independently of readiness', (_role, index) => {
  const result = fixture(); result.observation.services[index].activeDeployments[0].sourceCommit = 'b'.repeat(40);
  expectCode(() => attestSelfHealingPreview(result), 'SELF_HEALING_PREVIEW_DEPLOYMENT_HEAD_MISMATCH');
});

test.each([
  ['building', service => { service.activeDeployments[0].status = 'BUILDING'; }],
  ['wrong target', service => { service.activeDeployments[0].environmentId = PRODUCTION_ENVIRONMENT_ID; }],
])('rejects %s deployment', (_name, change) => {
  const result = fixture(); change(result.observation.services[0]);
  expectCode(() => attestSelfHealingPreview(result), 'SELF_HEALING_PREVIEW_DEPLOYMENT_INVALID');
});

test.each([
  ['two replicas', service => { service.replicas = 2; }],
  ['duplicate active deployment', service => { service.activeDeployments.push(deployment('web')); }],
  ['production instance of fresh global ID', service => { service.environmentIds.push(PRODUCTION_ENVIRONMENT_ID); }],
])('rejects %s before accepting controller ownership', (_name, change) => {
  const result = fixture(); change(result.observation.services[0]);
  expectCode(() => attestSelfHealingPreview(result), 'SELF_HEALING_PREVIEW_SERVICE_UNSAFE');
});

test.each([
  'OPENAI_API_KEY', 'RAILWAY_API_TOKEN', 'DATABASE_PRIVATE_URL', 'NOTION_API_KEY', 'HTTPS_PROXY',
])('rejects %s configuration instead of exposing its value', variableName => {
  const result = fixture(); result.observation.services[0].variableNames.push(variableName);
  expectCode(() => attestSelfHealingPreview(result), 'SELF_HEALING_PREVIEW_VARIABLES_UNSAFE');
});

test.each([
  ['provider', 'https://api.openai.com/v1'],
  ['embedded credentials', 'http://user:password@127.0.0.1:4050/v1'],
  ['query', 'http://127.0.0.1:4050/v1?token=fixture'],
])('rejects %s provider path', (_name, baseUrl) => {
  const result = fixture(); result.observation.services[0].configuration.openAIBaseUrl = baseUrl;
  expectCode(() => attestSelfHealingPreview(result), 'SELF_HEALING_PREVIEW_PROVIDER_NOT_LOOPBACK');
});

test.each([
  ['database', dependencies => { dependencies.postgres.host = 'production.railway.internal'; }],
  ['queue', dependencies => { dependencies.redis.serviceId = id(90); }],
  ['port', dependencies => { dependencies.redis.port = 5432; }],
])('rejects shared %s dependency', (_name, change) => {
  const result = fixture(); change(result.observation.services[0].dependencies);
  expectCode(() => attestSelfHealingPreview(result), 'SELF_HEALING_PREVIEW_DEPENDENCY_UNSAFE');
});

test.each([
  ['public domain', service => { service.publicDomains.push({ hostname: 'redis.up.railway.app' }); }],
  ['wrong volume', service => { service.volume.id = id(91); }],
  ['external host', service => { service.privateHost = 'external.example.com'; }],
])('rejects %s storage', (_name, change) => {
  const result = fixture(); change(result.observation.services[3]);
  expectCode(() => attestSelfHealingPreview(result), 'SELF_HEALING_PREVIEW_STORAGE_UNSAFE');
});

test('rejects public data TCP exposure and mutable data image tags', () => {
  const exposed = fixture(); exposed.observation.services[2].tcpProxies.push({ port: 5432 });
  expectCode(() => attestSelfHealingPreview(exposed), 'SELF_HEALING_PREVIEW_SERVICE_UNSAFE');
  const mutable = fixture(); mutable.observation.services[2].activeDeployments[0].image = 'postgres:latest';
  expectCode(() => attestSelfHealingPreview(mutable), 'SELF_HEALING_PREVIEW_DATA_IMAGE_INVALID');
});

test('requires fresh storage credentials and rejects cross-purpose credential reuse', () => {
  const copied = fixture(); copied.observation.services[2].credential.provenance = 'production-copied';
  expectCode(() => attestSelfHealingPreview(copied), 'SELF_HEALING_PREVIEW_CREDENTIAL_UNSAFE');
  const reused = fixture();
  reused.observation.services[3].credential.fingerprint = reused.observation.services[2].credential.fingerprint;
  expectCode(() => attestSelfHealingPreview(reused), 'SELF_HEALING_PREVIEW_CREDENTIAL_PURPOSE_REUSED');
});

test('accepts official PostgreSQL 18 persistence root', () => {
  const result = fixture(); const postgres = result.observation.services[2];
  postgres.volume.mountPath = '/var/lib/postgresql';
  expect({ image: postgres.activeDeployments[0].image, mountPath: postgres.volume.mountPath })
    .toEqual({ image: `postgres:18@sha256:${'b'.repeat(64)}`, mountPath: '/var/lib/postgresql' });
  expect(attestSelfHealingPreview(result)).toMatchObject({
    profileValidated: true, deploymentExecutionPerformed: false,
    selfHealingRuntimeAcceptanceSupported: false,
  });
});

test('rejects obsolete PostgreSQL persistence root', () => {
  const result = fixture(); const postgres = result.observation.services[2];
  postgres.volume.mountPath = '/var/lib/postgresql/data';
  expect({ image: postgres.activeDeployments[0].image, mountPath: postgres.volume.mountPath })
    .toEqual({ image: `postgres:18@sha256:${'b'.repeat(64)}`, mountPath: '/var/lib/postgresql/data' });
  expectCode(() => attestSelfHealingPreview(result), 'SELF_HEALING_PREVIEW_STORAGE_UNSAFE');
});

test('rejects Redis environment-only password without AUTH startup', () => {
  const result = fixture(); const redis = result.observation.services[3];
  delete redis.startCommand;
  expect({ variableNames: redis.variableNames, startCommand: redis.startCommand ?? null })
    .toEqual({ variableNames: ['REDIS_PASSWORD'], startCommand: null });
  expectCode(() => attestSelfHealingPreview(result), 'SELF_HEALING_PREVIEW_STORAGE_UNSAFE');
});

test('accepts explicit Redis AUTH startup contract', () => {
  const result = fixture(); const redis = result.observation.services[3];
  redis.startCommand = REDIS_AUTH_START_COMMAND;
  expect(redis.startCommand).toBe("sh -c 'exec redis-server --appendonly yes --requirepass \"$REDIS_PASSWORD\"'");
  expect(SELF_HEALING_PREVIEW_PROFILE.redisStartCommand).toBe(REDIS_AUTH_START_COMMAND);
  expect(attestSelfHealingPreview(result)).toMatchObject({
    profileValidated: true, deploymentExecutionPerformed: false,
    selfHealingRuntimeAcceptanceSupported: false,
    storageAuthenticationVerified: false, storageDurabilityVerified: false,
  });
});

test('rejects a domain belonging to another service or an unrelated Railway host', () => {
  const result = fixture(); result.observation.services[0].publicDomains[0].serviceId = id(90);
  expectCode(() => attestSelfHealingPreview(result), 'SELF_HEALING_PREVIEW_DOMAIN_UNSAFE');
  result.observation.services[0].publicDomains[0].serviceId = SERVICE_IDS.web;
  result.observation.services[0].publicDomains[0].hostname = 'production.up.railway.app';
  expectCode(() => attestSelfHealingPreview(result), 'SELF_HEALING_PREVIEW_DOMAIN_UNSAFE');
});

test('accepts preview-created purpose credentials while omitting fingerprints from public output', () => {
  const result = fixture(); const web = result.observation.services[0];
  web.variableNames.push('ARCANOS_CONTROL_PLANE_ACCESS_TOKEN',
    'ARCANOS_CONTROL_PLANE_PRINCIPAL_ID', 'ARCANOS_CONTROL_PLANE_SCOPES');
  web.controlPlane = { principalId: 'self-healing-pr1539-operator',
    scopes: ['arcanos:read', 'self-heal:probe', 'self-heal:decide', 'self-heal:execute'] };
  web.credentials.push({ name: 'ARCANOS_CONTROL_PLANE_ACCESS_TOKEN', provenance: 'preview-created',
    createdAt: CREATED_AT, fingerprint: 'c'.repeat(64) });
  const evidence = attestSelfHealingPreview(result);
  expect(JSON.stringify(evidence)).not.toContain('c'.repeat(64));
  expect(JSON.stringify(evidence)).not.toContain('ARCANOS_CONTROL_PLANE_ACCESS_TOKEN');
  expect(evidence.liveRuntimeAcceptance).toBe('NOT_RUN');
});

test.each([
  ['unknown provenance', credential => { credential.provenance = 'production-copied'; }],
  ['older credential', credential => { credential.createdAt = PLANNED_AT; }],
  ['secret value', credential => { credential.value = 'fixture-secret-never-export'; }],
  ['zero fingerprint', credential => { credential.fingerprint = '0'.repeat(64); }],
])('rejects %s credential', (_name, change) => {
  const result = fixture(); const web = result.observation.services[0];
  web.variableNames.push('ARCANOS_CONTROL_PLANE_ACCESS_TOKEN',
    'ARCANOS_CONTROL_PLANE_PRINCIPAL_ID', 'ARCANOS_CONTROL_PLANE_SCOPES');
  web.controlPlane = { principalId: 'self-healing-pr1539-operator',
    scopes: ['arcanos:read', 'self-heal:probe', 'self-heal:decide', 'self-heal:execute'] };
  const credential = { name: 'ARCANOS_CONTROL_PLANE_ACCESS_TOKEN', provenance: 'preview-created',
    createdAt: CREATED_AT, fingerprint: 'c'.repeat(64) };
  change(credential); web.credentials.push(credential);
  expectCode(() => attestSelfHealingPreview(result), 'SELF_HEALING_PREVIEW_CREDENTIAL_UNSAFE');
});

test('requires declared control-plane principal and least scopes with the purpose credential', () => {
  const result = fixture(); const web = result.observation.services[0];
  web.variableNames.push('ARCANOS_CONTROL_PLANE_ACCESS_TOKEN');
  web.credentials.push({ name: 'ARCANOS_CONTROL_PLANE_ACCESS_TOKEN', provenance: 'preview-created',
    createdAt: CREATED_AT, fingerprint: 'c'.repeat(64) });
  expectCode(() => attestSelfHealingPreview(result), 'SELF_HEALING_PREVIEW_CONTROL_PLANE_METADATA_INVALID');
  web.variableNames.push('ARCANOS_CONTROL_PLANE_PRINCIPAL_ID', 'ARCANOS_CONTROL_PLANE_SCOPES');
  web.controlPlane = { principalId: 'self-healing-pr1539-operator',
    scopes: ['arcanos:read', 'self-heal:probe', 'self-heal:decide', 'self-heal:execute', 'mcp:invoke'] };
  expectCode(() => attestSelfHealingPreview(result), 'SELF_HEALING_PREVIEW_CONTROL_PLANE_METADATA_INVALID');
});

test('never returns unsafe input text in an error', () => {
  const result = fixture(); result.observation.services[0].source.repository = 'secret-token-fixture';
  try { attestSelfHealingPreview(result); } catch (error) {
    expect(error.message).toBe('SELF_HEALING_PREVIEW_APP_SOURCE_INVALID');
    expect(error.stack).not.toContain('secret-token-fixture');
  }
});

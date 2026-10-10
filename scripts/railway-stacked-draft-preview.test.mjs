import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DEFAULT_POLICY, validateAuthorization } from './stacked-draft-preview-contract.mjs';
import {
  StackedDraftRailwayApi, validateImageReceipt, validateIsolatedEnvironment,
  deployStackedDraftPreview, cleanupStackedDraftPreview, sweepExpiredStackedDraftPreviews,
} from './railway-stacked-draft-preview.mjs';

const uuid = number => `${String(number).padStart(8, '0')}-1111-4111-8111-111111111111`;
const sha = character => character.repeat(40);
const digest = character => character.repeat(64);
const conn = nodes => ({ edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage: false } });
const image = `ghcr.io/pbjustin/arcanos-stacked-preview@sha256:${digest('f')}`;
function fixture({ registryCredentials = null } = {}) {
  let clock = Date.now();
  const policy = structuredClone(DEFAULT_POLICY);
  policy.enabled = true;
  policy.target = { workspaceId: uuid(1), projectId: uuid(2), baseEnvironmentId: uuid(3), workerServiceId: uuid(4), webServiceId: uuid(5), region: 'us-east4-eqdc4a', cpuLimit: 1, memoryLimitGb: 1, imageRepository: policy.imageRepository };
  if (registryCredentials) policy.target.registryPullCredentialSha256 = createHash('sha256').update(JSON.stringify({ username: registryCredentials.username, password: registryCredentials.password })).digest('hex');
  const raw = { version: 1, controllerSha: sha('1'), mainSha: sha('2'), expiresAt: new Date(clock + 7_200_000).toISOString(), stack: [1533, 1534, 1535].map((prNumber, index) => ({ prNumber, headSha: sha(String(index + 3)), treeSha: sha(String(index + 6)) })), sourceArchiveSha256: digest('a') };
  const authorization = validateAuthorization({ authorization: raw, policy, actor: 'pbjustin', repository: 'pbjustin/Arcanos', controllerSha: raw.controllerSha, now: clock });
  const buildReceipt = { schemaVersion: 1, controllerSha: raw.controllerSha, candidateSha: raw.stack[2].headSha, treeSha: raw.stack[2].treeSha, sourceArchiveSha256: digest('a'), compiledSha256: digest('b'), compiledFiles: 20, compiledBytes: 1024, runtimeDependencyInventorySha256: digest('c'), expiresAt: raw.expiresAt, imageArchiveSha256: digest('d'), imageId: `sha256:${digest('e')}`, runtimeDevDependenciesPruned: true };
  const bytes = JSON.stringify(buildReceipt);
  const publishedImage = { image, imageId: buildReceipt.imageId, buildReceiptSha256: createHash('sha256').update(bytes).digest('hex') };
  const imageReceipt = validateImageReceipt({ authorization, buildReceipt, buildReceiptBytes: bytes, publishedImage });
  return { policy, raw, authorization, imageReceipt, buildReceipt, bytes, publishedImage, registryCredentials, now: () => clock, advance: milliseconds => { clock += milliseconds; } };
}
function config(target, sourceImage = `ghcr.io/pbjustin/arcanos-stacked-preview@sha256:${digest('0')}`) {
  return { privateNetworkDisabled: true, sharedVariables: {}, volumes: {}, buckets: {}, services: Object.fromEntries(['worker', 'web'].map(role => [target[`${role}ServiceId`], { source: { image: sourceImage }, variables: { ARCANOS_PROCESS_KIND: { value: role } }, networking: { serviceDomains: {}, customDomains: {}, tcpProxies: {} }, deploy: { numReplicas: 1, restartPolicyType: 'NEVER', multiRegionConfig: { [target.region]: { numReplicas: 1 } }, healthcheckPath: '/readyz', healthcheckTimeout: 300, limitOverride: { containers: { cpu: target.cpuLimit, memoryBytes: target.memoryLimitGb * 1024 ** 3 } } } }])) };
}
class MockRailway {
  constructor(f) { this.f = f; this.target = f.policy.target; this.environments = new Map(); this.environments.set(this.target.baseEnvironmentId, this.makeEnvironment(this.target.baseEnvironmentId, true)); this.events = []; this.patch = null; this.staged = null; this.pending = false; }
  makeEnvironment(id, base = false) { const environment = { id, projectId: this.target.projectId, name: base ? 'isolated-base' : 'pr-1532aa-1535', isEphemeral: !base, deletedAt: null, sourceEnvironment: base ? null : { id: this.target.baseEnvironmentId }, config: config(this.target), deploymentTriggers: conn([]), volumeInstances: conn([]), serviceInstances: conn(['worker', 'web'].map(role => ({ serviceId: this.target[`${role}ServiceId`], environmentId: id, deletedAt: null, source: { repo: null, image: config(this.target).services[this.target[`${role}ServiceId`]].source.image }, numReplicas: 1, restartPolicyType: 'NEVER', restartPolicyMaxRetries: 0, preDeployCommand: null, cronSchedule: null, startCommand: null, healthcheckPath: '/readyz', healthcheckTimeout: 300, region: this.target.region, activeDeployments: [], domains: { serviceDomains: [{ domain: `${role}-pr-1532aa-1535.up.railway.app`, environmentId: id, serviceId: this.target[`${role}ServiceId`], deletedAt: null }], customDomains: [] } }))) }; if (this.f.registryCredentials) for (const role of ['worker', 'web']) environment.config.services[this.target[`${role}ServiceId`]].deploy.registryCredentials = structuredClone(this.f.registryCredentials); return environment; }
  async validateAuthority() { this.events.push('authority'); }
  async listEnvironments() { return [...this.environments.values()].map(environment => structuredClone(environment)); }
  async readEnvironment(_target, id) { this.events.push('read'); return structuredClone(this.environments.get(id)); }
  async stagedEmpty() { return this.staged === null; }
  async createEnvironment() { this.events.push('create'); const environment = this.makeEnvironment(uuid(6)); this.environments.set(environment.id, environment); return structuredClone(environment); }
  async stageConfig(environmentId, value) { this.events.push('stage'); this.staged = value; this.patch = { id: uuid(7), environmentId, status: 'STAGED', message: null, appliedAt: null }; return this.patch; }
  async commitConfig(environmentId, message) { this.events.push('commit'); const environment = this.environments.get(environmentId); environment.config = this.staged; for (const edge of environment.serviceInstances.edges) edge.node.source.image = environment.config.services[edge.node.serviceId].source.image; this.staged = null; Object.assign(this.patch, { status: 'COMMITTED', message, appliedAt: new Date(this.f.now()).toISOString() }); return this.patch.id; }
  async readPatch() { return structuredClone(this.patch); }
  async listPatches() { return [structuredClone(this.patch)]; }
  async deployService(environmentId, serviceId) { const role = serviceId === this.target.workerServiceId ? 'worker' : 'web'; this.events.push(`deploy-${role}`); const id = uuid(role === 'worker' ? 8 : 9); const node = this.environments.get(environmentId).serviceInstances.edges.find(edge => edge.node.serviceId === serviceId).node; node.activeDeployments = this.pending ? [] : [{ id, status: 'SUCCESS', deploymentStopped: false, meta: { serviceManifest: { source: { image: node.source.image } } } }]; return id; }
  async readDeployment(id) { return { id, projectId: this.target.projectId, environmentId: uuid(6), serviceId: id === uuid(8) ? this.target.workerServiceId : this.target.webServiceId, status: this.pending ? 'INITIALIZING' : 'SUCCESS' }; }
  async readReadiness(host) { const role = host.includes('worker-') ? 'worker' : 'web'; this.events.push(`ready-${role}`); return { ready: true, processKind: role, prNumber: 1535, sourceCommit: this.f.imageReceipt.candidateSha, mode: role === 'worker' ? 'passive-pr-preview' : 'native-pr-application-e2e-v1', applicationImported: true, fixturesSealed: true, protectedEffectsEnabled: false, protectsMaliciousPr: false, requiresPlatformSecretIsolationForUntrustedCode: true }; }
  async deleteEnvironment(id) { this.events.push('delete'); this.environments.delete(id); }
  async pause(milliseconds) { this.f.advance(milliseconds); }
}
async function deploy(f, railway, extra = {}) { return deployStackedDraftPreview({ authorization: f.authorization, imageReceipt: f.imageReceipt, railway, revalidate: async () => { railway.events.push('fresh'); }, runId: '123456', now: f.now, ...extra }); }

test('policy is disabled and unconfigured until an owner-reviewed activation', () => {
  assert.equal(DEFAULT_POLICY.enabled, false); assert.equal(DEFAULT_POLICY.target, null);
});
test('immutable build and publication receipts bind all authorized source identities', () => {
  const f = fixture(); assert.equal(f.imageReceipt.image, image);
  for (const key of ['controllerSha', 'candidateSha', 'treeSha', 'sourceArchiveSha256', 'runtimeDevDependenciesPruned']) {
    const value = { ...f.buildReceipt, [key]: key === 'runtimeDevDependenciesPruned' ? false : digest('0') };
    assert.throws(() => validateImageReceipt({ authorization: f.authorization, buildReceipt: value, buildReceiptBytes: f.bytes, publishedImage: f.publishedImage }), /BUILD_RECEIPT_INVALID/u);
  }
  for (const value of [{ ...f.publishedImage, image: 'ghcr.io/pbjustin/arcanos-stacked-preview:latest' }, { ...f.publishedImage, image: image.replace('pbjustin', 'attacker') }, { ...f.publishedImage, imageId: `sha256:${digest('0')}` }, { ...f.publishedImage, buildReceiptSha256: digest('0') }])
    assert.throws(() => validateImageReceipt({ authorization: f.authorization, buildReceipt: f.buildReceipt, buildReceiptBytes: f.bytes, publishedImage: value }), /PUBLISHED_IMAGE_INVALID/u);
});
test('worker becomes ready before web starts, every mutation requires fresh authorization, and success preserves an owned lease', async () => {
  const f = fixture(); const railway = new MockRailway(f); const receipt = await deploy(f, railway);
  assert.equal(receipt.status, 'VERIFIED'); assert.ok(railway.events.indexOf('ready-worker') < railway.events.indexOf('deploy-web'));
  let previous = -1;
  for (const action of ['create', 'stage', 'commit', 'deploy-worker', 'deploy-web']) {
    const actionIndex = railway.events.indexOf(action);
    assert.ok(railway.events.slice(previous + 1, actionIndex).includes('fresh'));
    previous = actionIndex;
  }
  assert.equal(railway.environments.size, 2); assert.equal(receipt.ownership.runId, '123456'); assert.equal(receipt.hosts.web, 'https://web-pr-1532aa-1535.up.railway.app');
  assert.equal(receipt.ownership.expiresAt, f.raw.expiresAt);
  assert.ok(Date.parse(receipt.ownership.expiresAt) - f.now() <= 2 * 60 * 60 * 1000);
  const cleanup = await cleanupStackedDraftPreview({ policy: f.policy, railway, receipt, now: f.now });
  assert.equal(cleanup.status, 'VERIFIED'); assert.equal(railway.environments.size, 1);
  assert.equal((await cleanupStackedDraftPreview({ policy: f.policy, railway, receipt, now: f.now })).alreadyAbsent, true);
});
test('private image pull uses only the exact owner-pinned platform credential and excludes its values from receipts', async () => {
  const credentials = { username: 'dedicated-preview-pull', password: 'mock-never-output-dedicated-read-only-registry-token' };
  const f = fixture({ registryCredentials: credentials }); const railway = new MockRailway(f); const receipt = await deploy(f, railway);
  assert.equal(receipt.status, 'VERIFIED'); assert.ok(!JSON.stringify(receipt).includes(credentials.password)); assert.ok(!JSON.stringify(receipt).includes(credentials.username));
  await cleanupStackedDraftPreview({ policy: f.policy, railway, receipt, now: f.now });
  for (const defect of ['missing', 'changed', 'reference', 'extra-key']) {
    const negative = fixture({ registryCredentials: credentials }); const api = new MockRailway(negative); const configService = api.environments.get(negative.policy.target.baseEnvironmentId).config.services[negative.policy.target.workerServiceId];
    if (defect === 'missing') delete configService.deploy.registryCredentials;
    if (defect === 'changed') configService.deploy.registryCredentials.password = 'mock-production-token-must-not-be-used';
    if (defect === 'reference') configService.deploy.registryCredentials.password = '${{ production.TOKEN }}';
    if (defect === 'extra-key') configService.deploy.registryCredentials.token = 'unsupported';
    await assert.rejects(deploy(negative, api), error => error.code === 'STACKED_PREVIEW_REGISTRY_CREDENTIAL_UNPROVEN' && !error.message.includes('TOKEN'));
    assert.ok(!api.events.includes('create'));
  }
});
test('head drift after clone fails closed and removes the idle clone', async () => {
  const f = fixture(); const railway = new MockRailway(f); let checks = 0;
  await assert.rejects(deploy(f, railway, { revalidate: async () => { checks += 1; if (checks === 3) throw Object.assign(new Error('drift'), { code: 'STACKED_PREVIEW_HEAD_DRIFT' }); } }), /drift/u);
  assert.equal(railway.environments.size, 1); assert.ok(!railway.events.includes('deploy-worker'));
});
test('commit failure after staging still removes the locally bound idle clone', async () => {
  const f = fixture(); const railway = new MockRailway(f);
  railway.commitConfig = async () => { throw Object.assign(new Error('commit rejected'), { code: 'STACKED_PREVIEW_API_FAILED' }); };
  let last; await assert.rejects(deploy(f, railway, { onReceipt: receipt => { last = structuredClone(receipt); } }), /commit rejected/u);
  assert.equal(last.cleanup.status, 'VERIFIED'); assert.equal(railway.environments.size, 1); assert.ok(!railway.events.includes('deploy-worker'));
});
test('unbranded or substituted image receipt cannot authorize a deployment', async () => {
  const f = fixture(); const railway = new MockRailway(f);
  await assert.rejects(deploy(f, railway, { imageReceipt: structuredClone(f.imageReceipt) }), /BUILD_RECEIPT_INVALID/u);
  assert.deepEqual(railway.events, []);
});
test('failed web readiness triggers cleanup and persists a sanitized failure receipt', async () => {
  const f = fixture(); const railway = new MockRailway(f); const readiness = railway.readReadiness.bind(railway);
  railway.readReadiness = async host => ({ ...await readiness(host), protectedEffectsEnabled: host.includes('web-') });
  let last; await assert.rejects(deploy(f, railway, { onReceipt: receipt => { last = structuredClone(receipt); } }), /READINESS_MISMATCH/u);
  assert.equal(last.cleanup.status, 'VERIFIED'); assert.equal(last.status, 'NOT VERIFIED'); assert.equal(railway.environments.size, 1);
});
test('separate active-deployment projection and readiness publication converge within the existing startup bound', async () => {
  const f = fixture(); const railway = new MockRailway(f); const read = railway.readEnvironment.bind(railway); const readiness = railway.readReadiness.bind(railway);
  let emptyProjection = true; let transientReadiness = true;
  railway.readEnvironment = async (...args) => { const environment = await read(...args); if (environment?.id === uuid(6) && environment.serviceInstances.edges[0].node.activeDeployments.length > 0 && emptyProjection) { emptyProjection = false; environment.serviceInstances.edges[0].node.activeDeployments = []; } return environment; };
  railway.readReadiness = async (...args) => { if (transientReadiness) { transientReadiness = false; throw Object.assign(new Error('not published yet'), { code: 'STACKED_PREVIEW_READINESS_FAILED' }); } return readiness(...args); };
  const receipt = await deploy(f, railway); assert.equal(receipt.status, 'VERIFIED'); assert.ok(railway.events.indexOf('ready-worker') < railway.events.indexOf('deploy-web'));
});
test('startup polling is bounded at twenty minutes and timed-out deployment is cleaned', async () => {
  const f = fixture(); const started = f.now(); const railway = new MockRailway(f); railway.pending = true;
  await assert.rejects(deploy(f, railway), /STARTUP_TIMEOUT/u);
  assert.equal(f.now() - started, 20 * 60 * 1000); assert.equal(railway.environments.size, 1);
});
test('unknown deployment image bytes and multiple active deployments are rejected', async () => {
  for (const defect of ['missing-image', 'extra-active']) {
    const f = fixture(); const railway = new MockRailway(f); const serviceDeploy = railway.deployService.bind(railway);
    railway.deployService = async (...args) => { const id = await serviceDeploy(...args); const node = railway.environments.get(uuid(6)).serviceInstances.edges[0].node; if (defect === 'missing-image') delete node.activeDeployments[0].meta.serviceManifest.source.image; else node.activeDeployments.push(structuredClone(node.activeDeployments[0])); return id; };
    await assert.rejects(deploy(f, railway), /IMMUTABLE_DEPLOYMENT_UNPROVEN/u); assert.equal(railway.environments.size, 1);
  }
});
test('owned environment readback rejects fork, namespace, source projection, and runtime configuration drift', () => {
  const f = fixture(); const railway = new MockRailway(f);
  for (const defect of ['wrong-project', 'wrong-base', 'not-ephemeral', 'wrong-name', 'image-projection', 'replica-projection', 'restart-projection', 'predeploy-projection', 'region-projection']) {
    const environment = railway.makeEnvironment(uuid(6)); const worker = environment.serviceInstances.edges[0].node;
    if (defect === 'wrong-project') environment.projectId = uuid(999);
    if (defect === 'wrong-base') environment.sourceEnvironment.id = uuid(999);
    if (defect === 'not-ephemeral') environment.isEphemeral = false;
    if (defect === 'wrong-name') environment.name = 'production';
    if (defect === 'image-projection') worker.source.image = image;
    if (defect === 'replica-projection') worker.numReplicas = 2;
    if (defect === 'restart-projection') worker.restartPolicyType = 'ALWAYS';
    if (defect === 'predeploy-projection') worker.preDeployCommand = ['unexpected-effect'];
    if (defect === 'region-projection') worker.region = 'unexpected-region';
    assert.throws(() => validateIsolatedEnvironment({ environment, target: f.policy.target }));
  }
});
for (const defect of ['secret', 'reference', 'repo', 'network', 'volume', 'bucket', 'trigger', 'cron', 'predeploy', 'replicas', 'cpu', 'memory', 'registry-secret', 'custom-domain', 'active-base', 'third-service', 'incomplete-inventory']) {
  test(`sealed base rejects ${defect} before any mutation`, async () => {
    const f = fixture(); const railway = new MockRailway(f); const base = railway.environments.get(f.policy.target.baseEnvironmentId); const worker = base.config.services[f.policy.target.workerServiceId];
    if (defect === 'secret') worker.variables.OPENAI_API_KEY = { value: 'mock-never-disclosed' };
    if (defect === 'reference') worker.variables.ARCANOS_PROCESS_KIND.value = '${{ production.ROLE }}';
    if (defect === 'repo') worker.source.repo = 'pbjustin/Arcanos';
    if (defect === 'network') base.config.privateNetworkDisabled = false;
    if (defect === 'volume') base.volumeInstances = conn([{ id: uuid(10) }]);
    if (defect === 'bucket') base.config.buckets = { [uuid(10)]: {} };
    if (defect === 'trigger') base.deploymentTriggers = conn([{ id: uuid(10) }]);
    if (defect === 'cron') worker.deploy.cronSchedule = '* * * * *';
    if (defect === 'predeploy') worker.deploy.preDeployCommand = ['npm run paid-test'];
    if (defect === 'replicas') worker.deploy.numReplicas = 2;
    if (defect === 'cpu') worker.deploy.limitOverride.containers.cpu = 2;
    if (defect === 'memory') worker.deploy.limitOverride.containers.memoryBytes = 2 * 1024 ** 3;
    if (defect === 'registry-secret') worker.deploy.registryCredentials = { username: 'production', password: 'mock-never-disclosed' };
    if (defect === 'custom-domain') worker.networking.customDomains = { 'production.example': {} };
    if (defect === 'active-base') base.serviceInstances.edges[0].node.activeDeployments = [{ id: uuid(10) }];
    if (defect === 'third-service') base.serviceInstances.edges.push({ node: { serviceId: uuid(10) } });
    if (defect === 'incomplete-inventory') base.serviceInstances.pageInfo.hasNextPage = true;
    await assert.rejects(deploy(f, railway)); assert.ok(!railway.events.includes('create')); assert.equal(railway.environments.size, 1);
  });
}
test('cleanup rejects an unowned UUID, reused name, changed digest and uncommitted patch', async () => {
  for (const defect of ['uuid', 'name-collision', 'digest', 'patch']) {
    const f = fixture(); const railway = new MockRailway(f); const receipt = await deploy(f, railway);
    if (defect === 'uuid') receipt.ownership.environmentId = f.policy.target.baseEnvironmentId;
    if (defect === 'name-collision') { const extra = railway.makeEnvironment(uuid(10)); railway.environments.set(extra.id, extra); }
    if (defect === 'digest') receipt.ownership.image = image.replace(digest('f'), digest('0'));
    if (defect === 'patch') railway.patch.status = 'STAGED';
    await assert.rejects(cleanupStackedDraftPreview({ policy: f.policy, railway, receipt, now: f.now })); assert.ok(!railway.events.includes('delete'));
  }
});
test('expired authorization and head drift do not strand a provably owned environment', async () => {
  const f = fixture(); const railway = new MockRailway(f); const receipt = await deploy(f, railway); f.advance(8_000_000);
  const result = await cleanupStackedDraftPreview({ policy: f.policy, railway, receipt, now: f.now, revalidate: async () => { throw new Error('expired'); } });
  assert.equal(result.authorizationCurrent, false); assert.equal(result.deleted, true);
});
test('trusted partial run receipt recovers only an idle clone before ownership commit', async () => {
  const f = fixture(); const railway = new MockRailway(f); const receipt = await deploy(f, railway);
  for (const edge of railway.environments.get(uuid(6)).serviceInstances.edges) edge.node.activeDeployments = [];
  receipt.status = 'NOT VERIFIED'; receipt.patchId = null; railway.patch = null;
  await assert.rejects(cleanupStackedDraftPreview({ policy: f.policy, railway, receipt, now: f.now }), /DELETE_TARGET_INVALID/u);
  assert.equal((await cleanupStackedDraftPreview({ policy: f.policy, railway, receipt, now: f.now, allowCreatedReceipt: true })).deleted, true);
  const active = fixture(); const api = new MockRailway(active); const activeReceipt = await deploy(active, api);
  activeReceipt.status = 'NOT VERIFIED'; activeReceipt.patchId = null; api.patch = null;
  await assert.rejects(cleanupStackedDraftPreview({ policy: active.policy, railway: api, receipt: activeReceipt, now: active.now, allowCreatedReceipt: true }), /ACTIVE_BASE/u);
  assert.ok(!api.events.includes('delete'));
});
test('sweeper leaves active lease intact and deletes only expired committed ownership', async () => {
  const f = fixture(); const railway = new MockRailway(f); await deploy(f, railway);
  assert.deepEqual((await sweepExpiredStackedDraftPreviews({ policy: f.policy, railway, now: f.now })).results, []);
  f.advance(2 * 60 * 60 * 1000 + 1);
  assert.equal((await sweepExpiredStackedDraftPreviews({ policy: f.policy, railway, now: f.now })).results[0].deleted, true);
});
test('sweeper rejects forged far-future or foreign-target leases before retaining them', async () => {
  for (const defect of ['future', 'project']) {
    const f = fixture(); const railway = new MockRailway(f); const receipt = await deploy(f, railway);
    if (defect === 'future') receipt.ownership.expiresAt = new Date(f.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    else receipt.ownership.projectId = uuid(999);
    railway.patch.message = `stacked-draft-preview/v1:${Buffer.from(JSON.stringify(receipt.ownership)).toString('base64url')}`;
    await assert.rejects(sweepExpiredStackedDraftPreviews({ policy: f.policy, railway, now: f.now })); assert.ok(!railway.events.includes('delete'));
  }
});
test('cleanup deletion must be confirmed by complete inventory', async () => {
  const f = fixture(); const railway = new MockRailway(f); const receipt = await deploy(f, railway); railway.deleteEnvironment = async () => {};
  await assert.rejects(cleanupStackedDraftPreview({ policy: f.policy, railway, receipt, now: f.now }), /DELETE_READBACK_FAILED/u);
});
test('API adapter uses official clone flags, config stage/commit, image deployment, and UUID deletion', async () => {
  const f = fixture(); const calls = []; const api = new StackedDraftRailwayApi({ token: 'nonsecret-test-token', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://backboard.railway.com/graphql/v2'); assert.equal(options.redirect, 'error'); const body = JSON.parse(options.body); calls.push(body);
    assert.equal(options.headers.authorization, 'Bearer nonsecret-test-token'); assert.equal(options.headers['Project-Access-Token'], undefined);
    const data = body.query.includes('StackedCreate') ? { environmentCreate: { id: uuid(6) } } : body.query.includes('StackedStage') ? { environmentStageChanges: { id: uuid(7) } } : body.query.includes('StackedCommit') ? { environmentPatchCommitStaged: uuid(7) } : body.query.includes('StackedDeploy') ? { serviceInstanceDeployV2: uuid(8) } : { environmentDelete: true };
    return Response.json({ data });
  } });
  await api.createEnvironment(f.policy.target, 'pr-1532aa-1535'); await api.stageConfig(uuid(6), config(f.policy.target, image)); await api.commitConfig(uuid(6), 'owned'); await api.deployService(uuid(6), uuid(4)); await api.deleteEnvironment(uuid(6));
  assert.deepEqual(calls[0].variables.input, { projectId: uuid(2), name: 'pr-1532aa-1535', sourceEnvironmentId: uuid(3), ephemeral: true, skipInitialDeploys: true, stageInitialChanges: false, applyChangesInBackground: false });
  assert.match(calls[1].query, /merge:false/u); assert.match(calls[2].query, /skipDeploys:true/u); assert.ok(!calls[3].query.includes('commitSha')); assert.deepEqual(calls[4].variables, { id: uuid(6) });
});
test('GraphQL errors never expose token, raw response, or configured secret values', async () => {
  const api = new StackedDraftRailwayApi({ token: 'mock-do-not-log-token', fetchImpl: async () => Response.json({ errors: [{ message: 'do-not-log-secret' }] }) });
  await assert.rejects(api.listEnvironments(uuid(2)), error => error.message === 'STACKED_PREVIEW_API_FAILED' && !JSON.stringify(error).includes('do-not-log'));
  assert.ok(!JSON.stringify(api).includes('mock-do-not-log-token'));
});
test('API authority rejects account/multiple-workspace tokens and shared or production-connected workspaces', async () => {
  for (const defect of ['account-token', 'multiple-workspaces', 'production-workspace', 'shared-workspace', 'incomplete-projects', 'production-project', 'third-service', 'bucket', 'automatic-deploy']) {
    const f = fixture(); const target = f.policy.target;
    const project = { id: target.projectId, workspaceId: target.workspaceId, baseEnvironmentId: null, primaryEnvironmentId: target.baseEnvironmentId, prDeploys: false, botPrEnvironments: false, focusedPrEnvironments: false, services: conn([{ id: target.workerServiceId }, { id: target.webServiceId }]), buckets: conn([]) };
    if (defect === 'production-project') project.id = DEFAULT_POLICY.forbiddenProjectIds[0];
    if (defect === 'third-service') project.services.edges.push({ node: { id: uuid(10) } });
    if (defect === 'bucket') project.buckets.edges.push({ node: { id: uuid(10), projectId: target.projectId } });
    if (defect === 'automatic-deploy') project.prDeploys = true;
    const api = new StackedDraftRailwayApi({ token: 'nonsecret', fetchImpl: async (_url, options) => {
      assert.equal(options.headers.authorization, 'Bearer nonsecret');
      if (JSON.parse(options.body).query.includes('StackedTokenType')) return defect === 'account-token' ? Response.json({ data: { me: { id: uuid(11) } } }) : Response.json({ errors: [{ message: 'workspace token' }] });
      const projects = conn([{ id: target.projectId, workspaceId: target.workspaceId }]);
      if (defect === 'shared-workspace') projects.edges.push({ node: { id: uuid(12), workspaceId: target.workspaceId } });
      if (defect === 'incomplete-projects') projects.pageInfo.hasNextPage = true;
      return Response.json({ data: { apiToken: { workspaces: defect === 'multiple-workspaces' ? [{ id: target.workspaceId }, { id: uuid(11) }] : [{ id: target.workspaceId }] }, workspace: { id: target.workspaceId, projects }, project } });
    } });
    await assert.rejects(api.validateAuthority(defect === 'production-workspace' ? { ...target, workspaceId: '1c9265a3-986f-4304-ad3e-5a874caab039' } : target));
  }
});
test('readiness adapter rejects production/custom origins before HTTP', async () => {
  let calls = 0; const api = new StackedDraftRailwayApi({ token: 'nonsecret', fetchImpl: async () => { calls += 1; return Response.json({}); } });
  for (const url of ['https://production.up.railway.app', 'https://attacker.example', 'http://worker-pr-1532aa-1535.up.railway.app', 'https://x@y-pr-1532aa-1535.up.railway.app', 'https://worker-pr-1532aa-1535.up.railway.app/other']) await assert.rejects(api.readReadiness(url));
  assert.equal(calls, 0);
});

#!/usr/bin/env node
// Protected-main orchestration only. Candidate modules are never imported here.
// The historical stack's transport is reused without changing its admission.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitHubReadAdapter, GitReadAdapter } from './stacked-draft-preview-contract.mjs';
import { StackedDraftRailwayApi } from './railway-stacked-draft-preview.mjs';

const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const RUN = /^[1-9][0-9]{0,19}$/u;
const REPOSITORY = 'pbjustin/Arcanos';
const IMAGE_REPOSITORY = 'ghcr.io/pbjustin/arcanos-gaming-preview';
const IMAGE = /^ghcr\.io\/pbjustin\/arcanos-gaming-preview@sha256:[0-9a-f]{64}$/u;
const PREFIX = 'gaming-preview/v1:';
const FORBIDDEN_PROJECTS = ['7faf44e5-519c-4e73-8d7a-da9f389e6187', '8e4cb1eb-1441-4e83-b434-15c06c676a5f'];
const FORBIDDEN_WORKSPACE = '1c9265a3-986f-4304-ad3e-5a874caab039';
const snapshots = new WeakSet();
const images = new WeakSet();
const executions = new WeakSet();
const createdReceipts = new WeakSet();
const hash = value => createHash('sha256').update(value).digest('hex');
export const TRUSTED_GAMING_KERNEL_POLICY_SHA256 = hash(readFileSync(new URL('./gaming-preview-network.c', import.meta.url)));
export const gamingPreviewEnvironmentName = runId => `pr-${hash(runId).slice(0, 6)}-1558`;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Reflect.ownKeys(value).sort().join('\0') === [...keys].sort().join('\0');
const empty = value => exact(value, []);
const freeze = value => { if (record(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export class GamingPreviewError extends Error {
  constructor(code) { super(code); this.name = 'GamingPreviewError'; this.code = code; }
}
const requireCondition = (condition, code) => { if (!condition) throw new GamingPreviewError(`GAMING_PREVIEW_${code}`); };
const connection = value => {
  requireCondition(record(value) && Array.isArray(value.edges) && value.pageInfo?.hasNextPage === false
    && value.edges.every(edge => record(edge.node)), 'INCOMPLETE_INVENTORY');
  return value.edges.map(edge => edge.node);
};
const environmentInventory = (value, projectId) => {
  const nodes = connection(value);
  requireCondition(nodes.every(node => UUID.test(node.id) && node.projectId === projectId
    && typeof node.name === 'string' && node.name.length > 0 && node.name.length <= 128)
    && new Set(nodes.map(node => node.id)).size === nodes.length
    && new Set(nodes.map(node => node.name)).size === nodes.length, 'ENVIRONMENT_INVENTORY_INVALID');
  return nodes;
};
const readJson = path => { const bytes = readFileSync(path, 'utf8'); requireCondition(Buffer.byteLength(bytes) <= 128 * 1024, 'INPUT_TOO_LARGE'); return { bytes, value: JSON.parse(bytes) }; };
const writeReceipt = (path, value) => { mkdirSync(dirname(resolve(path)), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); };
export const DEFAULT_GAMING_POLICY = freeze(readJson(new URL('../config/railway-gaming-preview-control.json', import.meta.url)).value);

export function validateGamingPolicy(policy = DEFAULT_GAMING_POLICY) {
  requireCondition(exact(policy, ['version', 'enabled', 'repository', 'owner', 'prNumber', 'headSha', 'treeSha',
    'maxAuthorizationSeconds', 'imageRepository', 'target']) && policy.version === 1 && typeof policy.enabled === 'boolean'
    && policy.repository === REPOSITORY && policy.owner === 'pbjustin' && policy.prNumber === 1558
    && policy.headSha === '1c1e7d0f4c8f4e62fd7117e28efd0d8d7c415262'
    && policy.treeSha === '89f1eb0b988514d92ef9f82dd2f77bc356735b8b'
    && policy.imageRepository === IMAGE_REPOSITORY && Number.isSafeInteger(policy.maxAuthorizationSeconds)
    && policy.maxAuthorizationSeconds > 0 && policy.maxAuthorizationSeconds <= 7200, 'POLICY_INVALID');
  if (policy.target === null) return policy;
  const t = policy.target;
  requireCondition(exact(t, ['workspaceId', 'projectId', 'baseEnvironmentId', 'workerServiceId', 'webServiceId',
    'region', 'cpuLimit', 'memoryLimitGb', 'imageRepository', 'registryPullCredentialSha256'])
    && ['workspaceId', 'projectId', 'baseEnvironmentId', 'workerServiceId', 'webServiceId'].every(key => UUID.test(t[key]))
    && t.workerServiceId !== t.webServiceId && t.workspaceId !== FORBIDDEN_WORKSPACE
    && !FORBIDDEN_PROJECTS.includes(t.projectId) && t.imageRepository === IMAGE_REPOSITORY
    && /^[a-z][a-z0-9-]{1,62}$/u.test(t.region) && typeof t.cpuLimit === 'number' && t.cpuLimit > 0 && t.cpuLimit <= 1
    && typeof t.memoryLimitGb === 'number' && t.memoryLimitGb > 0 && t.memoryLimitGb <= 1
    && DIGEST.test(t.registryPullCredentialSha256), 'TARGET_BLOCKED');
  return policy;
}

export function validateGamingAuthorization({ authorization, policy = DEFAULT_GAMING_POLICY, actor, repository,
  controllerSha, runId, now = Date.now(), requireActivation = true }) {
  validateGamingPolicy(policy);
  requireCondition(actor === 'pbjustin' && repository === REPOSITORY && RUN.test(runId), 'OWNER_AUTHORIZATION_REQUIRED');
  requireCondition(exact(authorization, ['version', 'controllerSha', 'mainSha', 'baseSha', 'headSha', 'treeSha',
    'sourceArchiveSha256', 'expiresAt', 'targetSha256']) && authorization.version === 1, 'AUTHORIZATION_INVALID');
  requireCondition(SHA.test(controllerSha) && authorization.controllerSha === controllerSha
    && authorization.mainSha === controllerSha && SHA.test(authorization.baseSha)
    && authorization.baseSha === authorization.mainSha, 'CONTROLLER_OR_BASE_DRIFT');
  requireCondition(authorization.headSha === policy.headSha && authorization.treeSha === policy.treeSha
    && DIGEST.test(authorization.sourceArchiveSha256) && DIGEST.test(authorization.targetSha256)
    && authorization.targetSha256 === hash(JSON.stringify(policy.target)), 'SOURCE_OR_TARGET_DRIFT');
  requireCondition(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(authorization.expiresAt)
    && new Date(authorization.expiresAt).toISOString() === authorization.expiresAt
    && Date.parse(authorization.expiresAt) > now
    && Date.parse(authorization.expiresAt) - now <= policy.maxAuthorizationSeconds * 1000, 'AUTHORIZATION_EXPIRED');
  const snapshot = freeze({ ...structuredClone(authorization), actor, repository, runId, policy: structuredClone(policy) });
  snapshots.add(snapshot);
  if (requireActivation) requireGamingActivation(snapshot, now);
  return snapshot;
}
export function requireGamingActivation(authorization, now = Date.now()) {
  requireCondition(snapshots.has(authorization), 'AUTHORIZATION_SNAPSHOT_REQUIRED');
  requireCondition(Date.parse(authorization.expiresAt) > now, 'AUTHORIZATION_EXPIRED');
  requireCondition(authorization.policy.enabled === true && authorization.policy.target !== null, 'ACTIVATION_BLOCKED');
  return authorization.policy.target;
}

export async function verifyGamingCandidate({ authorization, main, pullRequest, git, now = Date.now }) {
  requireCondition(snapshots.has(authorization), 'AUTHORIZATION_SNAPSHOT_REQUIRED');
  requireCondition(Date.parse(authorization.expiresAt) > now(), 'AUTHORIZATION_EXPIRED');
  requireCondition(main?.protected === true && main.sha === authorization.controllerSha, 'PROTECTED_MAIN_DRIFT');
  // PR1558 is deliberately admitted only as the frozen, open, non-draft PR.
  // Neither labels nor ready_for_review events are admission inputs.
  requireCondition(pullRequest?.number === 1558 && pullRequest.state === 'open' && pullRequest.draft === false,
    'OPEN_NON_DRAFT_REQUIRED');
  requireCondition(pullRequest.head?.repo?.full_name === REPOSITORY && pullRequest.base?.repo?.full_name === REPOSITORY
    && pullRequest.base.ref === 'main' && pullRequest.base.sha === authorization.baseSha
    && pullRequest.head.sha === authorization.headSha, 'PR_IDENTITY_DRIFT');
  requireCondition(await git.treeSha(authorization.headSha) === authorization.treeSha, 'TREE_DRIFT');
  requireCondition(await git.archiveSha256(authorization.headSha) === authorization.sourceArchiveSha256, 'ARCHIVE_DRIFT');
  requireCondition(Date.parse(authorization.expiresAt) > now(), 'AUTHORIZATION_EXPIRED');
  return freeze({ repository: REPOSITORY, prNumber: 1558, controllerSha: authorization.controllerSha,
    candidateSha: authorization.headSha, treeSha: authorization.treeSha, baseSha: authorization.baseSha,
    sourceArchiveSha256: authorization.sourceArchiveSha256, runId: authorization.runId });
}

export function validateGamingImageReceipt({ authorization, buildReceipt, buildReceiptBytes, publishedImage }) {
  requireCondition(snapshots.has(authorization), 'AUTHORIZATION_SNAPSHOT_REQUIRED');
  const keys = ['schemaVersion', 'controllerSha', 'candidateSha', 'treeSha', 'sourceArchiveSha256', 'compiledSha256',
    'compiledFiles', 'compiledBytes', 'runtimeDependencyInventorySha256', 'runtimeDevDependenciesPruned',
    'expiresAt', 'imageId', 'imageArchiveSha256', 'previewLane', 'runtimeEgressPolicy', 'targetSha256', 'runId',
    'kernelPolicySha256', 'kernelLauncherSha256', 'runtimeEnvironmentName', 'runtimeTarget'];
  requireCondition(exact(buildReceipt, keys) && buildReceipt.schemaVersion === 1 && buildReceipt.runtimeDevDependenciesPruned === true
    && buildReceipt.controllerSha === authorization.controllerSha && buildReceipt.candidateSha === authorization.headSha
    && buildReceipt.treeSha === authorization.treeSha && buildReceipt.sourceArchiveSha256 === authorization.sourceArchiveSha256
    && buildReceipt.expiresAt === authorization.expiresAt && /^sha256:[0-9a-f]{64}$/u.test(buildReceipt.imageId)
    && buildReceipt.previewLane === 'gaming-synthetic-v1' && buildReceipt.runtimeEgressPolicy === 'linux-seccomp-no-outbound-v1'
    && buildReceipt.kernelPolicySha256 === TRUSTED_GAMING_KERNEL_POLICY_SHA256
    && buildReceipt.runId === authorization.runId && buildReceipt.targetSha256 === authorization.targetSha256
    && buildReceipt.runtimeEnvironmentName === gamingPreviewEnvironmentName(authorization.runId)
    && exact(buildReceipt.runtimeTarget, ['projectId', 'baseEnvironmentId', 'workerServiceId', 'webServiceId'])
    && ['projectId', 'baseEnvironmentId', 'workerServiceId', 'webServiceId'].every(key => buildReceipt.runtimeTarget[key] === authorization.policy.target?.[key])
    && ['compiledSha256', 'imageArchiveSha256', 'runtimeDependencyInventorySha256', 'kernelPolicySha256', 'kernelLauncherSha256'].every(key => DIGEST.test(buildReceipt[key]))
    && Number.isSafeInteger(buildReceipt.compiledFiles) && buildReceipt.compiledFiles > 0
    && Number.isSafeInteger(buildReceipt.compiledBytes) && buildReceipt.compiledBytes > 0, 'BUILD_RECEIPT_INVALID');
  requireCondition(exact(publishedImage, ['image', 'imageId', 'buildReceiptSha256']) && IMAGE.test(publishedImage.image)
    && publishedImage.imageId === buildReceipt.imageId && typeof buildReceiptBytes === 'string'
    && publishedImage.buildReceiptSha256 === hash(buildReceiptBytes), 'PUBLISHED_IMAGE_INVALID');
  const receipt = freeze({ ...structuredClone(buildReceipt), ...structuredClone(publishedImage) });
  images.add(receipt); return receipt;
}

const serviceId = (target, role) => target[`${role}ServiceId`];
function roleNode(environment, target, role) {
  const nodes = connection(environment.serviceInstances);
  requireCondition(nodes.length === 2 && nodes.every(node => [target.workerServiceId, target.webServiceId].includes(node.serviceId)), 'SERVICE_SCOPE_INVALID');
  const matches = nodes.filter(node => node.serviceId === serviceId(target, role));
  requireCondition(matches.length === 1, 'SERVICE_SCOPE_INVALID'); return matches[0];
}
export function validateGamingEnvironment({ environment: e, target: t, base = false, ownership = null, image = null, idle = false }) {
  requireCondition(record(e) && UUID.test(e.id) && e.projectId === t.projectId && e.deletedAt == null
    && (base ? e.id === t.baseEnvironmentId : e.id !== t.baseEnvironmentId && e.isEphemeral === true
      && /^pr-[0-9a-f]{6}-1558$/u.test(e.name) && e.sourceEnvironment?.id === t.baseEnvironmentId), 'ENVIRONMENT_SCOPE_INVALID');
  if (ownership) requireCondition(e.id === ownership.environmentId && e.name === ownership.environmentName, 'OWNERSHIP_MISMATCH');
  const c = e.config;
  requireCondition(record(c) && Object.keys(c).every(key => ['services', 'sharedVariables', 'volumes', 'buckets', 'privateNetworkDisabled', 'groups'].includes(key))
    && c.privateNetworkDisabled === true && empty(c.sharedVariables)
    && ['volumes', 'buckets', 'groups'].every(key => c[key] === undefined || empty(c[key]))
    && exact(c.services, [t.workerServiceId, t.webServiceId]), 'UNSAFE_CONFIG');
  requireCondition(connection(e.deploymentTriggers).length === 0 && connection(e.volumeInstances).length === 0, 'UNSAFE_RESOURCES');
  for (const role of ['worker', 'web']) {
    const s = c.services[serviceId(t, role)], n = roleNode(e, t, role), d = s.deploy;
    requireCondition(record(s) && Object.keys(s).every(key => ['source', 'variables', 'deploy', 'build', 'networking', 'configFile', 'volumeMounts'].includes(key))
      && (s.configFile == null) && (s.build === undefined || empty(s.build)) && (s.volumeMounts === undefined || empty(s.volumeMounts))
      && exact(s.source, ['image']) && IMAGE.test(s.source.image) && (image === null || s.source.image === image)
      && exact(s.variables, ['ARCANOS_PROCESS_KIND']) && exact(s.variables.ARCANOS_PROCESS_KIND, ['value'])
      && s.variables.ARCANOS_PROCESS_KIND.value === role, 'UNSAFE_SERVICE');
    requireCondition(record(d) && Object.keys(d).every(key => ['numReplicas', 'multiRegionConfig', 'restartPolicyType', 'restartPolicyMaxRetries',
      'healthcheckPath', 'healthcheckTimeout', 'drainingSeconds', 'startCommand', 'cronSchedule', 'preDeployCommand', 'limitOverride',
      'runtime', 'sleepApplication', 'ipv6EgressEnabled', 'registryCredentials'].includes(key)) && d.numReplicas === 1 && d.restartPolicyType === 'NEVER'
      && (d.restartPolicyMaxRetries == null || d.restartPolicyMaxRetries === 0) && d.cronSchedule == null && d.preDeployCommand == null && d.startCommand == null
      && d.healthcheckPath === '/readyz' && Number.isSafeInteger(d.healthcheckTimeout) && d.healthcheckTimeout > 0 && d.healthcheckTimeout <= 300
      && exact(d.multiRegionConfig, [t.region]) && exact(d.multiRegionConfig[t.region], ['numReplicas']) && d.multiRegionConfig[t.region].numReplicas === 1
      && exact(d.limitOverride, ['containers']) && exact(d.limitOverride.containers, ['cpu', 'memoryBytes'])
      && d.limitOverride.containers.cpu === t.cpuLimit && d.limitOverride.containers.memoryBytes === t.memoryLimitGb * 1024 ** 3, 'UNSAFE_DEPLOY_CONFIG');
    requireCondition(exact(d.registryCredentials, ['username', 'password'])
      && ['username', 'password'].every(key => typeof d.registryCredentials[key] === 'string'
        && d.registryCredentials[key].length > 0 && d.registryCredentials[key].length <= 8192
        && !/[\r\n\0]/u.test(d.registryCredentials[key]) && !d.registryCredentials[key].includes('${{'))
      && hash(JSON.stringify({ username: d.registryCredentials.username, password: d.registryCredentials.password })) === t.registryPullCredentialSha256,
    'REGISTRY_PULL_CREDENTIAL_UNPROVEN');
    requireCondition(record(s.networking) && Object.keys(s.networking).every(key => ['serviceDomains', 'customDomains', 'tcpProxies'].includes(key))
      && (s.networking.customDomains === undefined || empty(s.networking.customDomains))
      && (s.networking.tcpProxies === undefined || empty(s.networking.tcpProxies)), 'UNSAFE_NETWORKING');
    requireCondition(n.environmentId === e.id && n.deletedAt == null && n.source?.repo == null && n.source.image === s.source.image
      && n.numReplicas === 1 && n.restartPolicyType === 'NEVER' && n.restartPolicyMaxRetries === 0
      && n.preDeployCommand == null && n.cronSchedule == null && n.startCommand == null && n.healthcheckPath === '/readyz'
      && n.healthcheckTimeout > 0 && n.healthcheckTimeout <= 300 && n.region === t.region && Array.isArray(n.activeDeployments)
      && (!idle || n.activeDeployments.length === 0), 'UNSAFE_SERVICE');
  }
  return e;
}

function validateOwnership(o, target) {
  requireCondition(exact(o, ['version', 'repository', 'projectId', 'baseEnvironmentId', 'environmentId', 'environmentName', 'runId',
    'controllerSha', 'candidateSha', 'treeSha', 'image', 'imageId', 'buildReceiptSha256', 'kernelPolicySha256', 'expiresAt'])
    && o.version === 1 && o.repository === REPOSITORY && o.projectId === target.projectId && o.baseEnvironmentId === target.baseEnvironmentId
    && UUID.test(o.environmentId) && o.environmentId !== target.baseEnvironmentId && RUN.test(o.runId)
    && o.environmentName === gamingPreviewEnvironmentName(o.runId) && SHA.test(o.controllerSha)
    && o.candidateSha === DEFAULT_GAMING_POLICY.headSha && o.treeSha === DEFAULT_GAMING_POLICY.treeSha
    && IMAGE.test(o.image) && /^sha256:[0-9a-f]{64}$/u.test(o.imageId) && DIGEST.test(o.buildReceiptSha256)
    && DIGEST.test(o.kernelPolicySha256) && Number.isFinite(Date.parse(o.expiresAt)), 'OWNERSHIP_MISMATCH');
}
const ownershipMessage = ownership => `${PREFIX}${Buffer.from(JSON.stringify(ownership)).toString('base64url')}`;
function validatePatch(patch, receipt) {
  requireCondition(patch?.id === receipt.patchId && patch.environmentId === receipt.ownership.environmentId
    && patch.status === 'COMMITTED' && patch.message === ownershipMessage(receipt.ownership)
    && Number.isFinite(Date.parse(patch.appliedAt)) && Date.parse(receipt.ownership.expiresAt) <= Date.parse(patch.appliedAt) + 7200_000, 'OWNERSHIP_PATCH_MISMATCH');
}

async function recoverCreation({ policy, railway, receipt, onReceipt = () => {} }) {
  const target = policy.target, intent = receipt.createIntent;
  requireCondition(record(intent) && !Object.hasOwn(intent, 'environmentId'), 'CREATE_INTENT_INVALID');
  // validateOwnership checks every intent field and rejects extra keys.
  validateOwnership({ ...intent, environmentId: '00000000-0000-0000-0000-000000000000' }, target);
  await railway.validateAuthority(target);
  const matches = (await railway.listEnvironments(target.projectId)).filter(e => e.name === intent.environmentName);
  requireCondition(matches.length <= 1, 'CREATE_RECOVERY_AMBIGUOUS');
  if (matches.length === 0) {
    requireCondition(await railway.environmentAbsent(target, null, intent.environmentName), 'DELETE_READBACK_FAILED');
    receipt.cleanup = { status: 'VERIFIED', created: false,
      absenceProof: 'railway-control-plane-complete-root-and-project-inventories' };
    onReceipt(receipt); return false;
  }
  const environment = await railway.readEnvironment(target, matches[0].id);
  const ownership = { ...structuredClone(intent), environmentId: environment?.id };
  validateOwnership(ownership, target);
  validateGamingEnvironment({ environment, target, ownership, idle: true });
  requireCondition(await railway.stagedEmpty(environment.id), 'CREATE_RECOVERY_STAGED_CHANGES');
  receipt.ownership = ownership; createdReceipts.add(receipt); onReceipt(receipt); return true;
}

export async function cleanupGamingPreview({ policy = DEFAULT_GAMING_POLICY, railway, receipt, now = Date.now, allowCreatedReceipt = false }) {
  validateGamingPolicy(policy);
  requireCondition(policy.enabled === true && policy.target !== null, 'ACTIVATION_BLOCKED');
  if (!receipt.ownership && receipt.createIntent) {
    requireCondition(createdReceipts.has(receipt) || allowCreatedReceipt === true, 'CREATE_INTENT_UNTRUSTED');
    if (!await recoverCreation({ policy, railway, receipt })) return receipt.cleanup;
  }
  const target = policy.target, ownership = receipt.ownership;
  validateOwnership(ownership, target);
  await railway.validateAuthority(target);
  const matches = (await railway.listEnvironments(target.projectId)).filter(e => e.id === ownership.environmentId || e.name === ownership.environmentName);
  if (matches.length === 0) {
    requireCondition(await railway.environmentAbsent(target, ownership.environmentId, ownership.environmentName), 'DELETE_READBACK_FAILED');
    return { status: 'VERIFIED', deleted: true, alreadyAbsent: true, environmentId: ownership.environmentId,
      absenceProof: 'railway-control-plane-complete-root-and-project-inventories' };
  }
  requireCondition(matches.length === 1 && matches[0].id === ownership.environmentId, 'DELETE_TARGET_INVALID');
  const environment = await railway.readEnvironment(target, ownership.environmentId);
  const patch = receipt.patchId ? await railway.readPatch(receipt.patchId) : null;
  if (patch?.status === 'COMMITTED') {
    validatePatch(patch, receipt);
    // Effects may have begun; immutable identity/ownership remains mandatory.
    validateGamingEnvironment({ environment, target, ownership, image: ownership.image });
  } else {
    // Only this invocation's in-memory create receipt, or the authenticated
    // workflow's exact same-run persisted create receipt, permits idle recovery.
    requireCondition(createdReceipts.has(receipt) || allowCreatedReceipt === true, 'OWNERSHIP_PATCH_MISMATCH');
    requireCondition(patch === null || patch.status === 'STAGED' && patch.environmentId === ownership.environmentId, 'OWNERSHIP_PATCH_MISMATCH');
    validateGamingEnvironment({ environment, target, ownership, idle: true });
  }
  await railway.deleteEnvironment(ownership.environmentId);
  const deadline = now() + 60_000;
  for (let attempt = 0; attempt < 13 && now() <= deadline; attempt += 1) {
    const remaining = await railway.listEnvironments(target.projectId);
    if (!remaining.some(e => e.id === ownership.environmentId || e.name === ownership.environmentName)
      && await railway.environmentAbsent(target, ownership.environmentId, ownership.environmentName))
      return { status: 'VERIFIED', deleted: true, environmentId: ownership.environmentId,
        absenceProof: 'railway-control-plane-complete-root-and-project-inventories' };
    if (attempt < 12) await railway.pause(5000);
  }
  throw new GamingPreviewError('GAMING_PREVIEW_DELETE_READBACK_FAILED');
}

function validateActive(environment, target, role, deploymentId, image) {
  const active = roleNode(environment, target, role).activeDeployments;
  requireCondition(active.length === 1 && active[0].id === deploymentId && active[0].status === 'SUCCESS'
    && active[0].deploymentStopped === false && active[0].meta?.serviceManifest?.source?.image === image, 'IMMUTABLE_DEPLOYMENT_UNPROVEN');
}
function serviceHost(node, ownership) {
  const domains = node.domains;
  requireCondition(Array.isArray(domains?.serviceDomains) && domains.serviceDomains.length === 1
    && Array.isArray(domains.customDomains) && domains.customDomains.length === 0, 'HOST_SCOPE_INVALID');
  const d = domains.serviceDomains[0];
  requireCondition(d.environmentId === ownership.environmentId && d.serviceId === node.serviceId && d.deletedAt == null
    && typeof d.domain === 'string' && d.domain.includes(ownership.environmentName)
    && /^[a-z0-9][a-z0-9-]*\.up\.railway\.app$/u.test(d.domain), 'HOST_SCOPE_INVALID');
  return `https://${d.domain}`;
}
export function assertTrustedGamingPreviewExecutionReceipt(receipt, expected) {
  requireCondition(executions.has(receipt), 'HOSTED_RECEIPT_REQUIRED');
  for (const key of ['repository', 'prNumber', 'commitSha', 'sourceTreeSha', 'webBaseUrl', 'workerBaseUrl'])
    requireCondition(expected[key] === receipt[key], 'HOSTED_RECEIPT_MISMATCH');
  requireCondition(receipt.expiresAt > Date.now(), 'HOSTED_RECEIPT_EXPIRED');
  return receipt;
}
export function gamingPreviewVerifierArguments({ authorization, hostedReceipt, gitEvidenceRoot }) {
  requireCondition(snapshots.has(authorization) && executions.has(hostedReceipt) && typeof gitEvidenceRoot === 'string'
    && gitEvidenceRoot.length > 0, 'VERIFIER_ARGUMENT_IDENTITY_INVALID');
  return ['--execute', '--allow-network', '--pr-number', '1558', '--commit-sha', authorization.headSha,
    '--web-base-url', hostedReceipt.webBaseUrl, '--worker-base-url', hostedReceipt.workerBaseUrl,
    '--git-evidence-root', gitEvidenceRoot];
}

// This transfer is accepted only after the credential-free protected-main job
// obtains the digest directly from the trusted deploy job's output. The digest
// must never be read from the downloaded artifact it authenticates.
export function restoreGamingExecutionReceipt({ authorization, imageReceipt, deploymentReceiptBytes, expectedSha256, now = Date.now() }) {
  const target = requireGamingActivation(authorization, now);
  requireCondition(images.has(imageReceipt) && DIGEST.test(expectedSha256) && typeof deploymentReceiptBytes === 'string'
    && Buffer.byteLength(deploymentReceiptBytes) <= 128 * 1024 && hash(deploymentReceiptBytes) === expectedSha256,
  'DEPLOYMENT_ARTIFACT_UNTRUSTED');
  const d = JSON.parse(deploymentReceiptBytes);
  requireCondition(exact(d, ['schemaVersion', 'status', 'createIntent', 'ownership', 'patchId', 'deployments', 'hosts', 'cleanup'])
    && d.schemaVersion === 1 && d.status === 'VERIFIED' && UUID.test(d.patchId) && d.cleanup === null
    && exact(d.deployments, ['worker', 'web']) && UUID.test(d.deployments.worker) && UUID.test(d.deployments.web)
    && d.deployments.worker !== d.deployments.web && exact(d.hosts, ['worker', 'web']) && d.hosts.worker !== d.hosts.web,
  'DEPLOYMENT_ARTIFACT_INVALID');
  const o = d.ownership; validateOwnership(o, target);
  requireCondition(o.controllerSha === authorization.controllerSha && o.runId === authorization.runId
    && o.candidateSha === authorization.headSha && o.treeSha === authorization.treeSha && o.expiresAt === authorization.expiresAt
    && o.image === imageReceipt.image && o.imageId === imageReceipt.imageId && o.buildReceiptSha256 === imageReceipt.buildReceiptSha256
    && o.kernelPolicySha256 === imageReceipt.kernelPolicySha256, 'DEPLOYMENT_ARTIFACT_IDENTITY_MISMATCH');
  for (const role of ['worker', 'web']) {
    const url = new URL(d.hosts[role]);
    requireCondition(url.protocol === 'https:' && url.origin === d.hosts[role] && !url.username && !url.password && !url.port
      && /^[a-z0-9][a-z0-9-]*\.up\.railway\.app$/u.test(url.hostname) && url.hostname.includes(o.environmentName), 'HOST_SCOPE_INVALID');
  }
  const receipt = freeze({ repository: REPOSITORY, prNumber: 1558, commitSha: authorization.headSha,
    sourceTreeSha: authorization.treeSha, webBaseUrl: d.hosts.web, workerBaseUrl: d.hosts.worker,
    controllerSha: authorization.controllerSha, runId: authorization.runId, projectId: target.projectId,
    environmentId: o.environmentId, image: imageReceipt.image, deployments: structuredClone(d.deployments),
    kernelPolicySha256: imageReceipt.kernelPolicySha256, expiresAt: Date.parse(authorization.expiresAt),
    deploymentReceiptSha256: expectedSha256 });
  executions.add(receipt); return receipt;
}

export async function attestGamingPreview({ authorization, imageReceipt, deploymentReceiptBytes, expectedSha256, railway, revalidate }) {
  const execution = restoreGamingExecutionReceipt({ authorization, imageReceipt, deploymentReceiptBytes, expectedSha256 });
  const receipt = JSON.parse(deploymentReceiptBytes), target = requireGamingActivation(authorization);
  await revalidate(); await railway.validateAuthority(target);
  const environment = await railway.readEnvironment(target, execution.environmentId);
  validateGamingEnvironment({ environment, target, ownership: receipt.ownership, image: imageReceipt.image });
  validatePatch(await railway.readPatch(receipt.patchId), receipt);
  requireCondition(await railway.stagedEmpty(execution.environmentId), 'UNEXPECTED_STAGED_CHANGES');
  for (const role of ['worker', 'web']) {
    validateActive(environment, target, role, receipt.deployments[role], imageReceipt.image);
    requireCondition(serviceHost(roleNode(environment, target, role), receipt.ownership) === receipt.hosts[role], 'HOST_SCOPE_INVALID');
    const d = await railway.readDeployment(receipt.deployments[role]);
    requireCondition(d?.id === receipt.deployments[role] && d.projectId === target.projectId && d.environmentId === execution.environmentId
      && d.serviceId === serviceId(target, role) && d.status === 'SUCCESS' && d.deploymentStopped === false, 'DEPLOYMENT_SCOPE_INVALID');
    const r = await railway.readGamingReadiness(receipt.hosts[role]);
    requireCondition(r?.ready === true && r.sourceCommit === authorization.headSha && r.prNumber === 1558 && r.processKind === role
      && (role === 'worker' ? r.mode === 'passive-pr-preview' : r.mode === 'native-pr-application-e2e-v1'
        && r.applicationImported === true && r.fixturesSealed === true && r.protectedEffectsEnabled === false
        && r.protectsMaliciousPr === false && r.requiresPlatformSecretIsolationForUntrustedCode === true), 'READINESS_MISMATCH');
  }
  await revalidate(); requireGamingActivation(authorization);
  return freeze({ schemaVersion: 1, status: 'VERIFIED', observation: 'post-verification-control-plane-and-readiness',
    ...execution, observedAt: new Date().toISOString() });
}

export async function deployGamingPreview({ authorization, imageReceipt, railway, revalidate, now = Date.now, onReceipt = () => {} }) {
  const target = requireGamingActivation(authorization, now());
  requireCondition(images.has(imageReceipt) && imageReceipt.controllerSha === authorization.controllerSha
    && imageReceipt.candidateSha === authorization.headSha && typeof revalidate === 'function', 'BUILD_RECEIPT_INVALID');
  const deadline = now() + 20 * 60_000;
  const receipt = { schemaVersion: 1, status: 'NOT VERIFIED', createIntent: null, ownership: null, patchId: null, deployments: {}, hosts: {}, cleanup: null };
  const effect = async action => {
    requireCondition(now() < deadline, 'STARTUP_TIMEOUT'); requireGamingActivation(authorization, now());
    await revalidate(); await railway.validateAuthority(target);
    requireCondition(now() < deadline, 'STARTUP_TIMEOUT'); requireGamingActivation(authorization, now()); return action();
  };
  try {
    await revalidate(); await railway.validateAuthority(target);
    const environments = await railway.listEnvironments(target.projectId);
    requireCondition(environments.length === 1 && environments[0].id === target.baseEnvironmentId, 'EXISTING_ENVIRONMENT');
    validateGamingEnvironment({ environment: await railway.readEnvironment(target, target.baseEnvironmentId), target, base: true, idle: true });
    requireCondition(await railway.stagedEmpty(target.baseEnvironmentId), 'BASE_STAGED_CHANGES');
    const name = gamingPreviewEnvironmentName(authorization.runId);
    receipt.createIntent = { version: 1, repository: REPOSITORY, projectId: target.projectId, baseEnvironmentId: target.baseEnvironmentId,
      environmentName: name, runId: authorization.runId, controllerSha: authorization.controllerSha,
      candidateSha: authorization.headSha, treeSha: authorization.treeSha, image: imageReceipt.image, imageId: imageReceipt.imageId,
      buildReceiptSha256: imageReceipt.buildReceiptSha256, kernelPolicySha256: imageReceipt.kernelPolicySha256, expiresAt: authorization.expiresAt };
    createdReceipts.add(receipt); onReceipt(receipt);
    const created = await effect(async () => {
      validateGamingEnvironment({ environment: await railway.readEnvironment(target, target.baseEnvironmentId), target, base: true, idle: true });
      const fresh = await railway.listEnvironments(target.projectId);
      requireCondition(fresh.length === 1 && fresh[0].id === target.baseEnvironmentId
        && await railway.stagedEmpty(target.baseEnvironmentId), 'BASE_DRIFT');
      requireCondition(now() < deadline, 'STARTUP_TIMEOUT'); requireGamingActivation(authorization, now());
      return railway.createEnvironment(target, name);
    });
    requireCondition(UUID.test(created?.id) && created.projectId === target.projectId && created.name === name
      && created.isEphemeral === true && created.sourceEnvironment?.id === target.baseEnvironmentId, 'CREATE_READBACK_FAILED');
    receipt.ownership = { ...structuredClone(receipt.createIntent), environmentId: created.id };
    createdReceipts.add(receipt); onReceipt(receipt);
    let environment = await railway.readEnvironment(target, created.id);
    validateGamingEnvironment({ environment, target, ownership: receipt.ownership, idle: true });
    requireCondition(await railway.stagedEmpty(created.id), 'UNEXPECTED_STAGED_CHANGES');
    const config = structuredClone(environment.config);
    for (const role of ['worker', 'web']) config.services[serviceId(target, role)].source = { image: imageReceipt.image };
    const staged = await effect(() => railway.stageConfig(created.id, config));
    requireCondition(UUID.test(staged?.id) && staged.environmentId === created.id && staged.status === 'STAGED', 'STAGE_READBACK_FAILED');
    receipt.patchId = staged.id; onReceipt(receipt);
    requireCondition(await effect(() => railway.commitConfig(created.id, ownershipMessage(receipt.ownership))) === receipt.patchId, 'COMMIT_READBACK_FAILED');
    validatePatch(await railway.readPatch(receipt.patchId), receipt);
    for (const role of ['worker', 'web']) {
      environment = await railway.readEnvironment(target, created.id);
      validateGamingEnvironment({ environment, target, ownership: receipt.ownership, image: imageReceipt.image });
      requireCondition(await railway.stagedEmpty(created.id), 'UNEXPECTED_STAGED_CHANGES');
      if (role === 'worker') requireCondition(roleNode(environment, target, 'web').activeDeployments.length === 0, 'WORKER_FIRST_FAILED');
      else validateActive(environment, target, 'worker', receipt.deployments.worker, imageReceipt.image);
      const id = await effect(() => railway.deployService(created.id, serviceId(target, role)));
      requireCondition(UUID.test(id), 'DEPLOYMENT_ID_INVALID'); receipt.deployments[role] = id; onReceipt(receipt);
      let ready = false;
      for (let attempt = 0; attempt < 120 && now() < deadline; attempt += 1) {
        await revalidate();
        const deployment = await railway.readDeployment(id);
        requireCondition(deployment?.id === id && deployment.projectId === target.projectId && deployment.environmentId === created.id
          && deployment.serviceId === serviceId(target, role), 'DEPLOYMENT_SCOPE_INVALID');
        requireCondition(!['FAILED', 'CRASHED', 'REMOVED', 'REMOVING', 'SKIPPED', 'SLEEPING'].includes(deployment.status), 'DEPLOYMENT_FAILED');
        if (deployment.status === 'SUCCESS') {
          environment = await railway.readEnvironment(target, created.id);
          validateGamingEnvironment({ environment, target, ownership: receipt.ownership, image: imageReceipt.image });
          if (roleNode(environment, target, role).activeDeployments.length > 0) {
            validateActive(environment, target, role, id, imageReceipt.image);
            const host = serviceHost(roleNode(environment, target, role), receipt.ownership);
            const r = await railway.readGamingReadiness(host);
            requireCondition(r?.ready === true && r.prNumber === 1558 && r.sourceCommit === authorization.headSha && r.processKind === role
              && (role === 'worker' ? r.mode === 'passive-pr-preview' : r.mode === 'native-pr-application-e2e-v1'
                && r.applicationImported === true && r.fixturesSealed === true && r.protectedEffectsEnabled === false
                && r.protectsMaliciousPr === false && r.requiresPlatformSecretIsolationForUntrustedCode === true), 'READINESS_MISMATCH');
            receipt.hosts[role] = host; ready = true; break;
          }
        }
        await railway.pause(Math.min(10_000, Math.max(0, deadline - now())));
      }
      requireCondition(ready, 'STARTUP_TIMEOUT');
    }
    await revalidate(); requireGamingActivation(authorization, now());
    environment = await railway.readEnvironment(target, created.id);
    validateGamingEnvironment({ environment, target, ownership: receipt.ownership, image: imageReceipt.image });
    requireCondition(await railway.stagedEmpty(created.id), 'UNEXPECTED_STAGED_CHANGES');
    for (const role of ['worker', 'web']) {
      validateActive(environment, target, role, receipt.deployments[role], imageReceipt.image);
      requireCondition(serviceHost(roleNode(environment, target, role), receipt.ownership) === receipt.hosts[role], 'HOST_SCOPE_INVALID');
    }
    requireCondition(now() < deadline, 'STARTUP_TIMEOUT'); requireGamingActivation(authorization, now());
    receipt.status = 'VERIFIED'; onReceipt(receipt);
    const executionReceipt = freeze({ repository: REPOSITORY, prNumber: 1558, commitSha: authorization.headSha,
      sourceTreeSha: authorization.treeSha, webBaseUrl: receipt.hosts.web, workerBaseUrl: receipt.hosts.worker,
      controllerSha: authorization.controllerSha, runId: authorization.runId, projectId: target.projectId,
      environmentId: created.id, image: imageReceipt.image, deployments: structuredClone(receipt.deployments),
      kernelPolicySha256: imageReceipt.kernelPolicySha256, expiresAt: Math.min(deadline, Date.parse(authorization.expiresAt)) });
    executions.add(executionReceipt); return { receipt, executionReceipt };
  } catch (error) {
    receipt.errorCode = /^[A-Z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'GAMING_PREVIEW_DEPLOY_FAILED';
    if (receipt.ownership || receipt.createIntent) {
      try { receipt.cleanup = await cleanupGamingPreview({ policy: authorization.policy, railway, receipt, now }); }
      catch (cleanupError) { receipt.cleanup = { status: 'BLOCKED', errorCode: cleanupError.code ?? 'GAMING_PREVIEW_CLEANUP_FAILED' }; }
    }
    onReceipt(receipt); throw error;
  }
}

// Only this small override adds the Gaming PR to the GitHub read surface. The
// historical stack adapter retains its exact allowlist and behavior.
export class GamingGitHubReadAdapter extends GitHubReadAdapter {
  #token; #fetch;
  constructor({ token, fetchImpl = fetch }) { super({ token, fetchImpl }); this.#token = token; this.#fetch = fetchImpl; }
  async request(resource) {
    if (resource !== '/pulls/1558') return super.request(resource);
    return deadlineJson(this.#fetch, `https://api.github.com/repos/${REPOSITORY}${resource}`, {
      headers: { authorization: `Bearer ${this.#token}`, accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28', 'user-agent': 'arcanos-gaming-preview/1' } },
    15_000, 1024 * 1024, response => response.ok && !response.redirected);
  }
  async readGamingPullRequest() { return this.request('/pulls/1558'); }
  async readRequiredCI(headSha) {
    const evidence = await super.readRequiredCI(headSha);
    // Gaming admission also requires protected main's documentation context.
    // The historical aggregate reader remains unchanged for its original lane.
    const docs = evidence.checks.filter(check => check.name === 'docs:check' && check.appId === 15368);
    requireCondition(docs.length === 1 && docs[0].status === 'completed' && docs[0].conclusion === 'success',
      'REQUIRED_DOCS_CI_NOT_VERIFIED');
    return evidence;
  }
}
export class GamingRailwayApi extends StackedDraftRailwayApi {
  #readFetch; #readinessTimeoutMs;
  constructor({ token, fetchImpl = fetch, pause, readinessTimeoutMs = 5000 }) {
    super({ token, fetchImpl, pause });
    requireCondition(Number.isSafeInteger(readinessTimeoutMs) && readinessTimeoutMs > 0 && readinessTimeoutMs <= 5000,
      'READINESS_TIMEOUT_INVALID');
    this.#readFetch = fetchImpl; this.#readinessTimeoutMs = readinessTimeoutMs;
  }
  async listEnvironments(projectId) {
    const data = await this.graphql('query GamingEnvironments($id:String!) { environments(projectId:$id,first:100) { edges { node { id name projectId isEphemeral deletedAt sourceEnvironment { id } } } pageInfo { hasNextPage } } }', { id: projectId });
    // Queued/soft-deleted rows remain visible evidence of incomplete cleanup.
    return environmentInventory(data.environments, projectId);
  }
  async environmentAbsent(target, environmentId, environmentName) {
    // Official Railway CLI schema dc804165e0cc976036d0f4f328cd564033bdc3b5
    // src/gql/schema.json declares Query.environment: Environment!, so a null
    // response cannot prove absence. Independently query the complete unfiltered
    // Project.environments projection; errors, missing pages and tombstones fail.
    const data = await this.graphql('query GamingAbsence($projectId:String!) { project(id:$projectId) { id workspaceId environments(first:100) { edges { node { id name projectId deletedAt } } pageInfo { hasNextPage } } } }', { projectId: target.projectId });
    requireCondition(data.project?.id === target.projectId && data.project.workspaceId === target.workspaceId, 'ABSENCE_PROJECT_MISMATCH');
    return !environmentInventory(data.project.environments, target.projectId)
      .some(node => node.id === environmentId || node.name === environmentName);
  }
  async readGamingReadiness(baseUrl) {
    const url = new URL(baseUrl);
    requireCondition(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash
      && url.pathname === '/' && /^[a-z0-9][a-z0-9-]*pr-[0-9a-f]{6}-1558[a-z0-9-]*\.up\.railway\.app$/u.test(url.hostname), 'HOST_SCOPE_INVALID');
    return deadlineJson(this.#readFetch, `${url.origin}/readyz`, { headers: { accept: 'application/json' } },
      this.#readinessTimeoutMs, 64 * 1024, response => response.status === 200 && !response.redirected
        && response.headers.get('cache-control') === 'no-store' && response.headers.get('content-type')?.startsWith('application/json'));
  }
}
async function deadlineJson(fetchImpl, url, options, timeoutMs, limit, validate) {
  const abort = new AbortController(); let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    abort.abort(); reject(new GamingPreviewError('GAMING_PREVIEW_REQUEST_TIMEOUT'));
  }, timeoutMs); });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: abort.signal });
      requireCondition(validate(response), 'RESPONSE_INVALID'); return boundedJson(response, limit);
    })()]);
  } finally { clearTimeout(timer); abort.abort(); }
}
async function boundedJson(response, limit) {
  requireCondition(response?.body?.getReader, 'RESPONSE_INVALID');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length;
    requireCondition(size <= limit, 'RESPONSE_TOO_LARGE'); chunks.push(Buffer.from(part.value)); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export function assertGamingPreviewWorkflowContext(command, env) {
  const validAttempt = command === 'cleanup'
    ? RUN.test(env.GITHUB_RUN_ATTEMPT) && (env.GITHUB_TRIGGERING_ACTOR ?? env.GITHUB_ACTOR) === 'pbjustin'
    : env.GITHUB_RUN_ATTEMPT === '1';
  requireCondition(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_ACTOR === 'pbjustin'
    && env.EVENT_SENDER === 'pbjustin' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/.github/workflows/railway-gaming-preview.yml@refs/heads/main`
    && validAttempt && env.GITHUB_SHA === env.CONTROLLER_SHA, 'TRUSTED_WORKFLOW_REQUIRED');
}

async function cli() {
  const [command, ...args] = process.argv.slice(2), options = {};
  requireCondition(['audit', 'authorize', 'deploy', 'verify', 'attest', 'cleanup'].includes(command) && args.length % 2 === 0, 'CLI_INVALID');
  for (let i = 0; i < args.length; i += 2) {
    requireCondition(['--authorization', '--build-receipt', '--image', '--deployment', '--output', '--git-evidence-root', '--verification-output'].includes(args[i])
      && !options[args[i]], 'CLI_INVALID'); options[args[i]] = args[i + 1];
  }
  const env = process.env;
  requireCondition(options['--output'], 'CLI_INVALID'); assertGamingPreviewWorkflowContext(command, env);
  const raw = readJson(options['--authorization']).value;
  const railway = ['deploy', 'attest', 'cleanup'].includes(command) ? new GamingRailwayApi({ token: env.RAILWAY_API_TOKEN }) : null;
  if (command === 'cleanup') {
    let receipt;
    try { receipt = readJson(options['--deployment']).value; }
    catch {
      writeReceipt(options['--output'], { status: 'BLOCKED', code: 'GAMING_PREVIEW_CLEANUP_OWNERSHIP_RECEIPT_UNAVAILABLE',
        runId: env.GITHUB_RUN_ID, controllerSha: env.CONTROLLER_SHA });
      throw new GamingPreviewError('GAMING_PREVIEW_CLEANUP_OWNERSHIP_RECEIPT_UNAVAILABLE');
    }
    const identity = receipt.ownership ?? receipt.createIntent;
    requireCondition(raw.controllerSha === env.CONTROLLER_SHA && raw.headSha === identity?.candidateSha
      && identity?.controllerSha === env.CONTROLLER_SHA && identity?.runId === env.GITHUB_RUN_ID, 'CLEANUP_RECEIPT_INVALID');
    writeReceipt(options['--output'], await cleanupGamingPreview({ railway, receipt, allowCreatedReceipt: true })); return;
  }
  const authorization = validateGamingAuthorization({ authorization: raw, actor: env.GITHUB_ACTOR, repository: env.GITHUB_REPOSITORY,
    controllerSha: env.CONTROLLER_SHA, runId: env.GITHUB_RUN_ID, requireActivation: command !== 'audit' });
  if (command === 'verify') {
    requireCondition(!['GITHUB_TOKEN', 'GH_TOKEN', 'RAILWAY_API_TOKEN', 'RAILWAY_TOKEN', 'OPENAI_API_KEY', 'NOTION_API_KEY',
      'NOTION_TOKEN', 'DATABASE_URL', 'REDIS_URL'].some(key => typeof env[key] === 'string' && env[key].length > 0), 'VERIFIER_CREDENTIALS_FORBIDDEN');
    const build = readJson(options['--build-receipt']), image = readJson(options['--image']);
    const imageReceipt = validateGamingImageReceipt({ authorization, buildReceipt: build.value, buildReceiptBytes: build.bytes, publishedImage: image.value });
    const hostedReceipt = restoreGamingExecutionReceipt({ authorization, imageReceipt,
      deploymentReceiptBytes: readJson(options['--deployment']).bytes, expectedSha256: env.DEPLOYMENT_RECEIPT_SHA256 });
    const { runGamingScopedPreviewE2e } = await import('./gaming-scoped-preview-e2e.mjs');
    const verification = await runGamingScopedPreviewE2e({ hostedReceipt,
      args: gamingPreviewVerifierArguments({ authorization, hostedReceipt, gitEvidenceRoot: options['--git-evidence-root'] }) });
    writeReceipt(options['--output'], verification);
    requireCondition(verification.GAMING_SCOPED_PREVIEW === 'PASS', 'VERIFICATION_FAILED'); return;
  }
  const github = new GamingGitHubReadAdapter({ token: env.GITHUB_TOKEN }), git = new GitReadAdapter({ cwd: process.cwd(), canonicalArchive: true });
  const revalidate = async () => {
    await github.readOwnerPermission();
    const [main, pullRequest] = await Promise.all([github.readMain(), github.readGamingPullRequest()]);
    const evidence = await verifyGamingCandidate({ authorization, main, pullRequest, git });
    await github.readRequiredCI(authorization.headSha); return evidence;
  };
  const evidence = await revalidate();
  if (command === 'attest') {
    const build = readJson(options['--build-receipt']), image = readJson(options['--image']);
    const imageReceipt = validateGamingImageReceipt({ authorization, buildReceipt: build.value, buildReceiptBytes: build.bytes, publishedImage: image.value });
    writeReceipt(options['--output'], await attestGamingPreview({ authorization, imageReceipt,
      deploymentReceiptBytes: readJson(options['--deployment']).bytes, expectedSha256: env.DEPLOYMENT_RECEIPT_SHA256,
      railway, revalidate })); return;
  }
  if (command !== 'deploy') {
    const target = authorization.policy.target;
    writeReceipt(options['--output'], { status: 'VERIFIED', ...evidence,
      deploymentActivation: authorization.policy.enabled ? 'VERIFIED' : 'BLOCKED',
      buildAuthorization: { ...raw, runId: authorization.runId, target: target === null ? null : Object.fromEntries(
        ['projectId', 'baseEnvironmentId', 'workerServiceId', 'webServiceId'].map(key => [key, target[key]])) } }); return;
  }
  const build = readJson(options['--build-receipt']), image = readJson(options['--image']);
  const imageReceipt = validateGamingImageReceipt({ authorization, buildReceipt: build.value, buildReceiptBytes: build.bytes, publishedImage: image.value });
  await deployGamingPreview({ authorization, imageReceipt, railway, revalidate,
    onReceipt: value => writeReceipt(options['--output'], value) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli().catch(error => { process.stderr.write(`${/^[A-Z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'GAMING_PREVIEW_FAILED'}\n`); process.exitCode = 1; });
}

#!/usr/bin/env node

// This is a separate, disabled-by-default image lane. It never calls the legacy
// source-deployment controller and never checks out or executes candidate code.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_POLICY, GitHubReadAdapter, GitReadAdapter, validateAuthorization,
  requireDeploymentActivation, verifyStack,
} from './stacked-draft-preview-contract.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const RUN = /^[1-9][0-9]{0,19}$/u;
const API = 'https://backboard.railway.com/graphql/v2';
const PREFIX = 'stacked-draft-preview/v1:';
const MAX_STARTUP_MS = 20 * 60 * 1000;
const MAX_LEASE_MS = 2 * 60 * 60 * 1000;
const FORBIDDEN_PROJECTS = ['7faf44e5-519c-4e73-8d7a-da9f389e6187', '8e4cb1eb-1441-4e83-b434-15c06c676a5f'];
const FORBIDDEN_WORKSPACE = '1c9265a3-986f-4304-ad3e-5a874caab039';
const TARGET_KEYS = ['workspaceId', 'projectId', 'baseEnvironmentId', 'workerServiceId', 'webServiceId', 'region', 'cpuLimit', 'memoryLimitGb', 'imageRepository'];
const RECEIPT_KEYS = ['schemaVersion', 'controllerSha', 'candidateSha', 'treeSha', 'sourceArchiveSha256', 'compiledSha256', 'compiledFiles', 'compiledBytes', 'runtimeDependencyInventorySha256', 'runtimeDevDependenciesPruned', 'expiresAt', 'imageId', 'imageArchiveSha256'];
const imageReceipts = new WeakSet();
const sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));
const hash = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const empty = value => record(value) && Object.keys(value).length === 0;

export class StackedDraftPreviewLifecycleError extends Error {
  constructor(code) { super(code); this.name = 'StackedDraftPreviewLifecycleError'; this.code = code; }
}
function requireCondition(condition, code) { if (!condition) throw new StackedDraftPreviewLifecycleError(code); }
function connection(value) {
  requireCondition(record(value) && Array.isArray(value.edges) && value.pageInfo?.hasNextPage === false,
    'STACKED_PREVIEW_INCOMPLETE_INVENTORY');
  return value.edges.map(edge => { requireCondition(record(edge.node), 'STACKED_PREVIEW_INCOMPLETE_INVENTORY'); return edge.node; });
}
function activatedTarget(policy) {
  requireCondition(policy?.enabled === true && policy.repository === 'pbjustin/Arcanos'
    && policy.owner === 'pbjustin' && policy.environmentPrefix === 'pr-1532aa-'
    && policy.imageRepository === 'ghcr.io/pbjustin/arcanos-stacked-preview', 'STACKED_PREVIEW_ACTIVATION_BLOCKED');
  const target = policy.target;
  requireCondition(exact(target, target?.registryPullCredentialSha256 === undefined ? TARGET_KEYS : [...TARGET_KEYS, 'registryPullCredentialSha256'])
    && ['workspaceId', 'projectId', 'baseEnvironmentId', 'workerServiceId', 'webServiceId'].every(key => UUID.test(target[key]))
    && target.workerServiceId !== target.webServiceId
    && target.workspaceId !== FORBIDDEN_WORKSPACE
    && !FORBIDDEN_PROJECTS.includes(target.projectId) && !policy.forbiddenProjectIds?.includes(target.projectId)
    && target.imageRepository === 'ghcr.io/pbjustin/arcanos-stacked-preview'
    && /^[a-z][a-z0-9-]{1,62}$/u.test(target.region)
    && typeof target.cpuLimit === 'number' && target.cpuLimit > 0 && target.cpuLimit <= 1
    && typeof target.memoryLimitGb === 'number' && target.memoryLimitGb > 0 && target.memoryLimitGb <= 1
    && (target.registryPullCredentialSha256 === undefined || DIGEST.test(target.registryPullCredentialSha256)),
  'STACKED_PREVIEW_TARGET_BLOCKED');
  return target;
}

export function validateImageReceipt({ authorization, buildReceipt, buildReceiptBytes, publishedImage }) {
  const candidate = authorization.stack.at(-1);
  requireCondition(exact(buildReceipt, RECEIPT_KEYS) && buildReceipt.schemaVersion === 1
    && buildReceipt.runtimeDevDependenciesPruned === true
    && ['controllerSha', 'candidateSha', 'treeSha'].every(key => SHA.test(buildReceipt[key]))
    && ['sourceArchiveSha256', 'compiledSha256', 'imageArchiveSha256', 'runtimeDependencyInventorySha256'].every(key => DIGEST.test(buildReceipt[key]))
    && Number.isSafeInteger(buildReceipt.compiledFiles) && buildReceipt.compiledFiles > 0
    && Number.isSafeInteger(buildReceipt.compiledBytes) && buildReceipt.compiledBytes > 0
    && buildReceipt.expiresAt === authorization.expiresAt
    && /^sha256:[0-9a-f]{64}$/u.test(buildReceipt.imageId)
    && buildReceipt.controllerSha === authorization.controllerSha
    && buildReceipt.candidateSha === candidate.headSha && buildReceipt.treeSha === candidate.treeSha
    && buildReceipt.sourceArchiveSha256 === authorization.sourceArchiveSha256,
  'STACKED_PREVIEW_BUILD_RECEIPT_INVALID');
  requireCondition(exact(publishedImage, ['image', 'imageId', 'buildReceiptSha256'])
    && publishedImage.imageId === buildReceipt.imageId
    && typeof publishedImage.image === 'string'
    && /^ghcr\.io\/pbjustin\/arcanos-stacked-preview@sha256:[0-9a-f]{64}$/u.test(publishedImage.image)
    && typeof buildReceiptBytes === 'string' && publishedImage.buildReceiptSha256 === hash(buildReceiptBytes),
  'STACKED_PREVIEW_PUBLISHED_IMAGE_INVALID');
  const receipt = Object.freeze({ ...buildReceipt, image: publishedImage.image, buildReceiptSha256: publishedImage.buildReceiptSha256 });
  imageReceipts.add(receipt);
  return receipt;
}

function serviceId(target, role) { return target[`${role}ServiceId`]; }
function roleNode(environment, target, role) {
  const nodes = connection(environment.serviceInstances);
  requireCondition(nodes.length === 2 && nodes.every(node => [target.workerServiceId, target.webServiceId].includes(node.serviceId)),
    'STACKED_PREVIEW_SERVICE_SCOPE_INVALID');
  const matches = nodes.filter(node => node.serviceId === serviceId(target, role));
  requireCondition(matches.length === 1, 'STACKED_PREVIEW_SERVICE_SCOPE_INVALID');
  return matches[0];
}
function validateConfig(config, target, image = null) {
  requireCondition(record(config) && Object.keys(config).every(key => ['services', 'sharedVariables', 'volumes', 'buckets', 'privateNetworkDisabled', 'groups'].includes(key))
    && config.privateNetworkDisabled === true && empty(config.sharedVariables)
    && (config.volumes === undefined || empty(config.volumes)) && (config.buckets === undefined || empty(config.buckets))
    && (config.groups === undefined || empty(config.groups))
    && exact(config.services, [target.workerServiceId, target.webServiceId]), 'STACKED_PREVIEW_UNSAFE_CONFIG');
  for (const role of ['worker', 'web']) {
    const configService = config.services[serviceId(target, role)];
    requireCondition(record(configService) && Object.keys(configService).every(key => ['source', 'variables', 'deploy', 'build', 'networking', 'configFile', 'volumeMounts'].includes(key))
      && (configService.configFile === undefined || configService.configFile === null)
      && (configService.build === undefined || empty(configService.build))
      && (configService.volumeMounts === undefined || empty(configService.volumeMounts))
      && exact(configService.source, ['image'])
      && new RegExp(`^ghcr\\.io/pbjustin/arcanos-stacked-preview@sha256:[0-9a-f]{64}$`, 'u').test(configService.source.image)
      && (image === null || configService.source.image === image)
      && exact(configService.variables, ['ARCANOS_PROCESS_KIND'])
      && record(configService.variables.ARCANOS_PROCESS_KIND)
      && Object.keys(configService.variables.ARCANOS_PROCESS_KIND).every(key => ['value', 'description', 'isSealed'].includes(key))
      && configService.variables.ARCANOS_PROCESS_KIND.value === role
      && configService.variables.ARCANOS_PROCESS_KIND.isSealed !== true,
    'STACKED_PREVIEW_UNSAFE_SERVICE');
    const deploy = configService.deploy;
    requireCondition(record(deploy) && Object.keys(deploy).every(key => ['numReplicas', 'multiRegionConfig', 'restartPolicyType', 'restartPolicyMaxRetries', 'healthcheckPath', 'healthcheckTimeout', 'drainingSeconds', 'startCommand', 'cronSchedule', 'preDeployCommand', 'registryCredentials', 'limitOverride', 'runtime', 'sleepApplication', 'ipv6EgressEnabled'].includes(key))
      && deploy.numReplicas === 1 && deploy.restartPolicyType === 'NEVER'
      && (deploy.restartPolicyMaxRetries === undefined || deploy.restartPolicyMaxRetries === null || deploy.restartPolicyMaxRetries === 0)
      && (deploy.cronSchedule === undefined || deploy.cronSchedule === null)
      && (deploy.preDeployCommand === undefined || deploy.preDeployCommand === null)
      && deploy.healthcheckPath === '/readyz' && Number.isSafeInteger(deploy.healthcheckTimeout) && deploy.healthcheckTimeout > 0 && deploy.healthcheckTimeout <= 300
      && (deploy.startCommand === undefined || deploy.startCommand === null)
      && exact(deploy.multiRegionConfig, [target.region]) && exact(deploy.multiRegionConfig[target.region], ['numReplicas']) && deploy.multiRegionConfig[target.region].numReplicas === 1
      && exact(deploy.limitOverride, ['containers'])
      && exact(deploy.limitOverride.containers, ['cpu', 'memoryBytes'])
      && deploy.limitOverride.containers.cpu === target.cpuLimit
      && deploy.limitOverride.containers.memoryBytes === target.memoryLimitGb * 1024 ** 3,
    'STACKED_PREVIEW_UNSAFE_DEPLOY_CONFIG');
    validateRegistryCredential(deploy.registryCredentials, target.registryPullCredentialSha256);
    const networking = configService.networking;
    requireCondition(record(networking) && Object.keys(networking).every(key => ['serviceDomains', 'customDomains', 'tcpProxies'].includes(key))
      && (networking.customDomains === undefined || empty(networking.customDomains))
      && (networking.tcpProxies === undefined || empty(networking.tcpProxies)), 'STACKED_PREVIEW_UNSAFE_NETWORKING');
  }
}

function validateRegistryCredential(credentials, expectedFingerprint) {
  if (expectedFingerprint === undefined) {
    requireCondition(credentials === undefined || credentials === null, 'STACKED_PREVIEW_UNAPPROVED_REGISTRY_CREDENTIAL');
    return;
  }
  // This binds the owner-reviewed pull credential, not its provider privileges.
  // Pull-only scope, expiry and absence of production grants require a separate
  // owner audit before activation. Values never enter receipts/runtime variables.
  requireCondition(exact(credentials, ['username', 'password'])
    && ['username', 'password'].every(key => typeof credentials[key] === 'string' && credentials[key].length > 0
      && credentials[key].length <= 8192 && !/[\r\n\0]/u.test(credentials[key]) && !credentials[key].includes('${{'))
    && hash(JSON.stringify({ username: credentials.username, password: credentials.password })) === expectedFingerprint,
  'STACKED_PREVIEW_REGISTRY_CREDENTIAL_UNPROVEN');
}

export function validateIsolatedEnvironment({ environment, target, base = false, ownership = null, image = null, idle = false }) {
  requireCondition(record(environment) && UUID.test(environment.id) && environment.projectId === target.projectId
    && environment.deletedAt == null && (base ? environment.id === target.baseEnvironmentId
      : environment.id !== target.baseEnvironmentId && environment.isEphemeral === true
        && environment.name === 'pr-1532aa-1535' && environment.sourceEnvironment?.id === target.baseEnvironmentId),
  'STACKED_PREVIEW_ENVIRONMENT_SCOPE_INVALID');
  if (ownership) requireCondition(environment.id === ownership.environmentId && environment.name === ownership.environmentName,
    'STACKED_PREVIEW_OWNERSHIP_MISMATCH');
  validateConfig(environment.config, target, image);
  requireCondition(connection(environment.deploymentTriggers).length === 0 && connection(environment.volumeInstances).length === 0,
    'STACKED_PREVIEW_UNSAFE_RESOURCES');
  for (const role of ['worker', 'web']) {
    const node = roleNode(environment, target, role);
    requireCondition(node.environmentId === environment.id && node.deletedAt == null
      && record(node.source) && node.source.repo == null
      && node.source.image === environment.config.services[node.serviceId].source.image
      && (image === null || node.source.image === image)
      && node.numReplicas === 1 && node.restartPolicyType === 'NEVER' && node.restartPolicyMaxRetries === 0
      && node.preDeployCommand == null && node.cronSchedule == null && node.startCommand == null
      && node.healthcheckPath === '/readyz' && node.healthcheckTimeout > 0 && node.healthcheckTimeout <= 300
      && node.region === target.region && Array.isArray(node.activeDeployments), 'STACKED_PREVIEW_UNSAFE_SERVICE');
    if (idle) requireCondition(node.activeDeployments.length === 0, 'STACKED_PREVIEW_ACTIVE_BASE');
  }
  return environment;
}

function ownershipMessage(ownership) { return `${PREFIX}${Buffer.from(JSON.stringify(ownership)).toString('base64url')}`; }
function parseOwnership(message) {
  requireCondition(typeof message === 'string' && message.startsWith(PREFIX) && message.length <= 8192,
    'STACKED_PREVIEW_OWNERSHIP_MISMATCH');
  let ownership;
  try { ownership = JSON.parse(Buffer.from(message.slice(PREFIX.length), 'base64url').toString('utf8')); } catch { requireCondition(false, 'STACKED_PREVIEW_OWNERSHIP_MISMATCH'); }
  requireCondition(exact(ownership, ['version', 'repository', 'projectId', 'baseEnvironmentId', 'environmentId', 'environmentName', 'runId', 'controllerSha', 'candidateSha', 'image', 'imageId', 'buildReceiptSha256', 'expiresAt'])
    && ownership.version === 1 && ownership.repository === 'pbjustin/Arcanos'
    && ['projectId', 'baseEnvironmentId', 'environmentId'].every(key => UUID.test(ownership[key]))
    && RUN.test(ownership.runId) && ownership.environmentName === 'pr-1532aa-1535'
    && SHA.test(ownership.controllerSha) && SHA.test(ownership.candidateSha)
    && /^ghcr\.io\/pbjustin\/arcanos-stacked-preview@sha256:[0-9a-f]{64}$/u.test(ownership.image)
    && /^sha256:[0-9a-f]{64}$/u.test(ownership.imageId) && DIGEST.test(ownership.buildReceiptSha256)
    && Number.isFinite(Date.parse(ownership.expiresAt)), 'STACKED_PREVIEW_OWNERSHIP_MISMATCH');
  return ownership;
}

function validatePatch(patch, ownership, patchId) {
  requireCondition(record(patch) && patch.id === patchId && patch.environmentId === ownership.environmentId
    && patch.status === 'COMMITTED' && patch.message === ownershipMessage(ownership)
    && Number.isFinite(Date.parse(patch.appliedAt))
    && Date.parse(ownership.expiresAt) <= Date.parse(patch.appliedAt) + MAX_LEASE_MS, 'STACKED_PREVIEW_OWNERSHIP_PATCH_MISMATCH');
}

export async function cleanupStackedDraftPreview({ policy = DEFAULT_POLICY, railway, receipt, now = Date.now, revalidate = null, allowCreatedReceipt = false }) {
  const target = activatedTarget(policy);
  const ownership = parseOwnership(ownershipMessage(receipt.ownership));
  requireCondition(ownership.projectId === target.projectId && ownership.baseEnvironmentId === target.baseEnvironmentId
    && ownership.environmentId !== target.baseEnvironmentId
    && (UUID.test(receipt.patchId) || allowCreatedReceipt && receipt.patchId === null), 'STACKED_PREVIEW_DELETE_TARGET_INVALID');
  await railway.validateAuthority(target);
  const environments = await railway.listEnvironments(target.projectId);
  const matches = environments.filter(environment => environment.id === ownership.environmentId || environment.name === ownership.environmentName);
  if (matches.length === 0) return { status: 'VERIFIED', deleted: true, alreadyAbsent: true, environmentId: ownership.environmentId };
  requireCondition(matches.length === 1 && matches[0].id === ownership.environmentId, 'STACKED_PREVIEW_DELETE_TARGET_INVALID');
  const environment = await railway.readEnvironment(target, ownership.environmentId);
  const patch = receipt.patchId === null ? null : await railway.readPatch(receipt.patchId);
  if (patch?.status === 'COMMITTED') {
    validateIsolatedEnvironment({ environment, target, ownership, image: ownership.image });
    validatePatch(patch, ownership, receipt.patchId);
  } else {
    // Only the same trusted run's uploaded create receipt may recover the gap
    // before ownership commit. Sweep never enables this exception. The clone
    // must remain idle; there is no name-only or active-workload deletion.
    requireCondition(allowCreatedReceipt === true && receipt.status === 'NOT VERIFIED'
      && (patch === null || patch.id === receipt.patchId && patch.environmentId === ownership.environmentId
        && patch.status === 'STAGED'), 'STACKED_PREVIEW_OWNERSHIP_PATCH_MISMATCH');
    validateIsolatedEnvironment({ environment, target, ownership, idle: true });
  }
  // Drift/expiry cannot strand an already-owned environment. Cleanup records the
  // fresh authorization result, then deletes only the UUID and committed receipt.
  let authorizationCurrent = null;
  if (revalidate) { try { await revalidate(); authorizationCurrent = true; } catch { authorizationCurrent = false; } }
  await railway.deleteEnvironment(ownership.environmentId);
  const deadline = now() + 60_000;
  for (let attempt = 0; attempt < 13 && now() <= deadline; attempt += 1) {
    const remaining = await railway.listEnvironments(target.projectId);
    if (!remaining.some(node => node.id === ownership.environmentId || node.name === ownership.environmentName))
      return { status: 'VERIFIED', deleted: true, alreadyAbsent: false, environmentId: ownership.environmentId, authorizationCurrent };
    if (attempt < 12) await railway.pause(5000);
  }
  throw new StackedDraftPreviewLifecycleError('STACKED_PREVIEW_DELETE_READBACK_FAILED');
}

export async function deployStackedDraftPreview({ authorization, imageReceipt, railway, revalidate, runId, now = Date.now, onReceipt = () => {} }) {
  const target = requireDeploymentActivation(authorization, { now: now() });
  requireCondition(imageReceipts.has(imageReceipt) && imageReceipt.controllerSha === authorization.controllerSha
    && imageReceipt.candidateSha === authorization.stack.at(-1).headSha && imageReceipt.treeSha === authorization.stack.at(-1).treeSha
    && imageReceipt.sourceArchiveSha256 === authorization.sourceArchiveSha256, 'STACKED_PREVIEW_BUILD_RECEIPT_INVALID');
  requireCondition(typeof revalidate === 'function' && RUN.test(runId), 'STACKED_PREVIEW_FRESH_AUTHORIZATION_REQUIRED');
  const deadline = now() + MAX_STARTUP_MS;
  const receipt = { schemaVersion: 1, status: 'NOT VERIFIED', ownership: null, patchId: null, deployments: {}, hosts: {}, cleanup: null };
  let ownershipCommitted = false;
  const effect = async action => { requireCondition(now() < deadline, 'STACKED_PREVIEW_STARTUP_TIMEOUT'); await revalidate(); requireCondition(now() < deadline, 'STACKED_PREVIEW_STARTUP_TIMEOUT'); return action(); };
  try {
    await revalidate();
    await railway.validateAuthority(target);
    const environments = await railway.listEnvironments(target.projectId);
    requireCondition(environments.length === 1 && environments[0].id === target.baseEnvironmentId,
      'STACKED_PREVIEW_EXISTING_ENVIRONMENT');
    const base = await railway.readEnvironment(target, target.baseEnvironmentId);
    validateIsolatedEnvironment({ environment: base, target, base: true, idle: true });
    requireCondition(await railway.stagedEmpty(target.baseEnvironmentId), 'STACKED_PREVIEW_BASE_STAGED_CHANGES');
    const created = await effect(async () => {
      await railway.validateAuthority(target);
      validateIsolatedEnvironment({ environment: await railway.readEnvironment(target, target.baseEnvironmentId), target, base: true, idle: true });
      requireCondition(await railway.stagedEmpty(target.baseEnvironmentId), 'STACKED_PREVIEW_BASE_STAGED_CHANGES');
      const current = await railway.listEnvironments(target.projectId);
      requireCondition(current.length === 1 && current[0].id === target.baseEnvironmentId, 'STACKED_PREVIEW_EXISTING_ENVIRONMENT');
      return railway.createEnvironment(target, 'pr-1532aa-1535');
    });
    requireCondition(UUID.test(created?.id) && created.projectId === target.projectId && created.isEphemeral === true
      && created.name === 'pr-1532aa-1535' && created.sourceEnvironment?.id === target.baseEnvironmentId,
    'STACKED_PREVIEW_CREATE_READBACK_FAILED');
    receipt.ownership = { version: 1, repository: authorization.repository, projectId: target.projectId,
      baseEnvironmentId: target.baseEnvironmentId, environmentId: created.id, environmentName: created.name, runId,
      controllerSha: authorization.controllerSha, candidateSha: imageReceipt.candidateSha,
      image: imageReceipt.image, imageId: imageReceipt.imageId, buildReceiptSha256: imageReceipt.buildReceiptSha256,
      expiresAt: authorization.expiresAt };
    onReceipt(receipt);
    let environment = await railway.readEnvironment(target, created.id);
    validateIsolatedEnvironment({ environment, target, idle: true });
    requireCondition(await railway.stagedEmpty(created.id), 'STACKED_PREVIEW_UNEXPECTED_STAGED_CHANGES');
    const config = structuredClone(environment.config);
    for (const role of ['worker', 'web']) config.services[serviceId(target, role)].source = { image: imageReceipt.image };
    const staged = await effect(() => railway.stageConfig(created.id, config));
    requireCondition(UUID.test(staged?.id) && staged.environmentId === created.id && staged.status === 'STAGED', 'STACKED_PREVIEW_STAGE_READBACK_FAILED');
    receipt.patchId = staged.id;
    onReceipt(receipt);
    const committed = await effect(() => railway.commitConfig(created.id, ownershipMessage(receipt.ownership)));
    requireCondition(committed === receipt.patchId, 'STACKED_PREVIEW_COMMIT_READBACK_FAILED');
    validatePatch(await railway.readPatch(receipt.patchId), receipt.ownership, receipt.patchId);
    ownershipCommitted = true;
    for (const role of ['worker', 'web']) {
      environment = await railway.readEnvironment(target, created.id);
      validateIsolatedEnvironment({ environment, target, ownership: receipt.ownership, image: imageReceipt.image });
      requireCondition(await railway.stagedEmpty(created.id), 'STACKED_PREVIEW_UNEXPECTED_STAGED_CHANGES');
      if (role === 'worker') requireCondition(roleNode(environment, target, 'web').activeDeployments.length === 0, 'STACKED_PREVIEW_WORKER_FIRST_FAILED');
      else validateActiveDeployment(environment, target, 'worker', receipt.deployments.worker, imageReceipt.image);
      const deploymentId = await effect(() => railway.deployService(created.id, serviceId(target, role)));
      requireCondition(UUID.test(deploymentId), 'STACKED_PREVIEW_DEPLOYMENT_ID_INVALID');
      receipt.deployments[role] = deploymentId;
      onReceipt(receipt);
      let ready = false;
      for (let attempt = 0; attempt < 120 && now() < deadline; attempt += 1) {
        await revalidate();
        environment = await railway.readEnvironment(target, created.id);
        validateIsolatedEnvironment({ environment, target, ownership: receipt.ownership, image: imageReceipt.image });
        const deployment = await railway.readDeployment(deploymentId);
        requireCondition(deployment?.id === deploymentId && deployment.projectId === target.projectId
          && deployment.environmentId === created.id && deployment.serviceId === serviceId(target, role), 'STACKED_PREVIEW_DEPLOYMENT_SCOPE_INVALID');
        requireCondition(!['FAILED', 'CRASHED', 'REMOVED', 'REMOVING', 'SKIPPED', 'SLEEPING'].includes(deployment.status), 'STACKED_PREVIEW_DEPLOYMENT_FAILED');
        if (deployment.status === 'SUCCESS') {
          // Deployment and environment projections are separate API reads.
          // Re-read after success and permit only the empty-to-owned transition;
          // a different active ID, extra replica or wrong digest still fails.
          environment = await railway.readEnvironment(target, created.id);
          validateIsolatedEnvironment({ environment, target, ownership: receipt.ownership, image: imageReceipt.image });
          if (roleNode(environment, target, role).activeDeployments.length === 0) {
            await railway.pause(Math.min(10_000, Math.max(0, deadline - now())));
            continue;
          }
          validateActiveDeployment(environment, target, role, deploymentId, imageReceipt.image);
          const host = serviceHost(roleNode(environment, target, role), created.id);
          let readiness;
          try { readiness = await railway.readReadiness(host); }
          catch (error) {
            if (error.code !== 'STACKED_PREVIEW_READINESS_FAILED') throw error;
            await railway.pause(Math.min(10_000, Math.max(0, deadline - now())));
            continue;
          }
          validateReadiness(readiness, role, imageReceipt.candidateSha);
          requireCondition(now() <= deadline, 'STACKED_PREVIEW_STARTUP_TIMEOUT');
          receipt.hosts[role] = host;
          ready = true; break;
        }
        await railway.pause(Math.min(10_000, Math.max(0, deadline - now())));
      }
      requireCondition(ready, 'STACKED_PREVIEW_STARTUP_TIMEOUT');
    }
    await revalidate();
    requireCondition(now() <= deadline, 'STACKED_PREVIEW_STARTUP_TIMEOUT');
    receipt.status = 'VERIFIED'; onReceipt(receipt);
    // The trusted workflow verifies the credential-free hosted lane next and
    // invokes cleanup in an always() job. The committed lease also supports sweep.
    return receipt;
  } catch (error) {
    receipt.errorCode = /^[A-Z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'STACKED_PREVIEW_DEPLOY_FAILED';
    if (receipt.ownership && ownershipCommitted) {
      try { receipt.cleanup = await cleanupStackedDraftPreview({ policy: authorization.policy, railway, receipt, now, revalidate }); }
      catch (cleanupError) { receipt.cleanup = { status: 'BLOCKED', errorCode: cleanupError.code ?? 'STACKED_PREVIEW_CLEANUP_FAILED' }; }
    } else if (receipt.ownership) {
      // A clone created before the first ownership patch is bound to this in-
      // process create response; do not let unrelated UUIDs enter this fallback.
      try {
        await railway.validateAuthority(target);
        const environment = await railway.readEnvironment(target, receipt.ownership.environmentId);
        validateIsolatedEnvironment({ environment, target, ownership: receipt.ownership, idle: true });
        await railway.deleteEnvironment(environment.id);
        requireCondition(!(await railway.listEnvironments(target.projectId)).some(node => node.id === environment.id || node.name === environment.name), 'STACKED_PREVIEW_DELETE_READBACK_FAILED');
        receipt.cleanup = { status: 'VERIFIED', deleted: true, environmentId: environment.id };
      } catch (cleanupError) { receipt.cleanup = { status: 'BLOCKED', errorCode: cleanupError.code ?? 'STACKED_PREVIEW_CLEANUP_FAILED' }; }
    }
    onReceipt(receipt); throw error;
  }
}

function validateActiveDeployment(environment, target, role, deploymentId, image) {
  const active = roleNode(environment, target, role).activeDeployments;
  requireCondition(active.length === 1 && active[0].id === deploymentId && active[0].status === 'SUCCESS'
    && active[0].deploymentStopped === false && active[0].meta?.serviceManifest?.source?.image === image,
  'STACKED_PREVIEW_IMMUTABLE_DEPLOYMENT_UNPROVEN');
}
function serviceHost(node, environmentId) {
  const domains = node.domains;
  requireCondition(Array.isArray(domains?.serviceDomains) && Array.isArray(domains?.customDomains)
    && domains.customDomains.length === 0 && domains.serviceDomains.length === 1, 'STACKED_PREVIEW_HOST_SCOPE_INVALID');
  const domain = domains.serviceDomains[0];
  requireCondition(domain.environmentId === environmentId && domain.serviceId === node.serviceId && domain.deletedAt == null
    && /^[a-z0-9][a-z0-9-]*pr-1532aa-1535[a-z0-9-]*\.up\.railway\.app$/u.test(domain.domain), 'STACKED_PREVIEW_HOST_SCOPE_INVALID');
  return `https://${domain.domain}`;
}
function validateReadiness(value, role, commitSha) {
  requireCondition(value?.ready === true && value.processKind === role && value.prNumber === 1535 && value.sourceCommit === commitSha
    && (role === 'worker' ? value.mode === 'passive-pr-preview' : value.mode === 'native-pr-application-e2e-v1'
      && value.applicationImported === true && value.fixturesSealed === true && value.protectedEffectsEnabled === false
      && value.protectsMaliciousPr === false && value.requiresPlatformSecretIsolationForUntrustedCode === true),
  'STACKED_PREVIEW_READINESS_MISMATCH');
}

export async function sweepExpiredStackedDraftPreviews({ policy = DEFAULT_POLICY, railway, now = Date.now }) {
  const target = activatedTarget(policy);
  await railway.validateAuthority(target);
  const environments = await railway.listEnvironments(target.projectId);
  const matches = environments.filter(environment => environment.name === 'pr-1532aa-1535');
  requireCondition(matches.length <= 1, 'STACKED_PREVIEW_OWNERSHIP_AMBIGUOUS');
  const results = [];
  for (const environment of matches) {
    const patches = await railway.listPatches(environment.id);
    const owners = patches.filter(patch => patch.status === 'COMMITTED' && patch.message?.startsWith(PREFIX));
    requireCondition(owners.length === 1, 'STACKED_PREVIEW_OWNERSHIP_AMBIGUOUS');
    const ownership = parseOwnership(owners[0].message);
    requireCondition(ownership.environmentId === environment.id && ownership.projectId === target.projectId
      && ownership.baseEnvironmentId === target.baseEnvironmentId, 'STACKED_PREVIEW_OWNERSHIP_MISMATCH');
    validatePatch(owners[0], ownership, owners[0].id);
    if (Date.parse(ownership.expiresAt) <= now()) results.push(await cleanupStackedDraftPreview({ policy, railway, receipt: { ownership, patchId: owners[0].id }, now }));
  }
  return { status: 'VERIFIED', results };
}

// Operations and config fields below are pinned to the official Railway CLI
// schema dc804165e0cc976036d0f4f328cd564033bdc3b5. Hosted acceptance remains a gate.
export class StackedDraftRailwayApi {
  #token;
  #fetchImpl;
  constructor({ token, fetchImpl = fetch, pause = sleep }) { requireCondition(typeof token === 'string' && token.length > 0, 'STACKED_PREVIEW_TOKEN_REQUIRED'); this.#token = token; this.#fetchImpl = fetchImpl; this.pause = pause; }
  async graphql(query, variables = {}) {
    let response;
    try { response = await withTimeout(this.#fetchImpl(API, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) })); }
    catch { throw new StackedDraftPreviewLifecycleError('STACKED_PREVIEW_API_FAILED'); }
    const data = await withTimeout(boundedJson(response));
    requireCondition(response.ok && record(data.data) && !data.errors, 'STACKED_PREVIEW_API_FAILED');
    return data.data;
  }
  async validateAuthority(target) {
    // Environment-scoped project tokens cannot be assumed to create/manage
    // siblings. This lifecycle therefore requires a NEW isolated workspace with
    // only the reviewed preview project. The existing production workspace is
    // forbidden; account tokens and multiple-workspace authority are rejected.
    requireCondition(target.workspaceId !== FORBIDDEN_WORKSPACE, 'STACKED_PREVIEW_WORKSPACE_FORBIDDEN');
    let accountToken = false;
    try { accountToken = Boolean((await this.graphql('query StackedTokenType { me { id } }')).me?.id); }
    catch (error) { if (error.code !== 'STACKED_PREVIEW_API_FAILED') throw error; }
    requireCondition(!accountToken, 'STACKED_PREVIEW_WORKSPACE_TOKEN_REQUIRED');
    const data = await this.graphql('query StackedAuthority($id:String!,$workspaceId:String!) { apiToken { workspaces { id } } workspace(workspaceId:$workspaceId) { id projects(first:100) { edges { node { id workspaceId } } pageInfo { hasNextPage } } } project(id:$id) { id workspaceId baseEnvironmentId primaryEnvironmentId prDeploys botPrEnvironments focusedPrEnvironments services(first:100) { edges { node { id } } pageInfo { hasNextPage } } buckets(first:100) { edges { node { id projectId } } pageInfo { hasNextPage } } } }', { id: target.projectId, workspaceId: target.workspaceId });
    requireCondition(Array.isArray(data.apiToken?.workspaces) && data.apiToken.workspaces.length === 1
      && data.apiToken.workspaces[0].id === target.workspaceId && data.workspace?.id === target.workspaceId
      && connection(data.workspace.projects).length === 1 && connection(data.workspace.projects)[0].id === target.projectId
      && connection(data.workspace.projects)[0].workspaceId === target.workspaceId
      && data.project?.id === target.projectId && data.project.workspaceId === target.workspaceId
      && data.project.baseEnvironmentId === null && data.project.primaryEnvironmentId === target.baseEnvironmentId
      && data.project.prDeploys === false && data.project.botPrEnvironments === false && data.project.focusedPrEnvironments === false
      && connection(data.project.buckets).length === 0 && connection(data.project.services).length === 2
      && connection(data.project.services).every(node => [target.workerServiceId, target.webServiceId].includes(node.id)), 'STACKED_PREVIEW_ISOLATED_AUTHORITY_UNPROVEN');
  }
  async listEnvironments(projectId) {
    const data = await this.graphql('query StackedEnvironments($id:String!) { environments(projectId:$id,first:100) { edges { node { id name projectId isEphemeral deletedAt sourceEnvironment { id } } } pageInfo { hasNextPage } } }', { id: projectId });
    return connection(data.environments).filter(node => node.deletedAt == null);
  }
  async readEnvironment(target, environmentId) {
    const data = await this.graphql('query StackedEnvironment($projectId:String!,$id:String!) { environment(id:$id,projectId:$projectId) { id name projectId isEphemeral deletedAt sourceEnvironment { id } config(decryptVariables:false) deploymentTriggers(first:100) { edges { node { id } } pageInfo { hasNextPage } } volumeInstances(first:100) { edges { node { id } } pageInfo { hasNextPage } } serviceInstances(first:100) { edges { node { serviceId environmentId deletedAt source { repo image } numReplicas restartPolicyType restartPolicyMaxRetries preDeployCommand cronSchedule startCommand healthcheckPath healthcheckTimeout region activeDeployments { id status deploymentStopped meta } domains { serviceDomains { domain environmentId serviceId deletedAt } customDomains { id } } } } pageInfo { hasNextPage } } } }', { projectId: target.projectId, id: environmentId });
    return data.environment;
  }
  async stagedEmpty(environmentId) {
    const data = await this.graphql('query StackedStaged($id:String!) { environmentStagedChanges(environmentId:$id) { status patch(decryptVariables:false) } }', { id: environmentId });
    return empty(data.environmentStagedChanges?.patch) && data.environmentStagedChanges.status !== 'APPLYING';
  }
  async createEnvironment(target, name) {
    const data = await this.graphql('mutation StackedCreate($input:EnvironmentCreateInput!) { environmentCreate(input:$input) { id name projectId isEphemeral sourceEnvironment { id } } }', { input: { projectId: target.projectId, name, sourceEnvironmentId: target.baseEnvironmentId, ephemeral: true, skipInitialDeploys: true, stageInitialChanges: false, applyChangesInBackground: false } });
    return data.environmentCreate;
  }
  async stageConfig(environmentId, config) {
    const data = await this.graphql('mutation StackedStage($id:String!,$input:EnvironmentConfig!) { environmentStageChanges(environmentId:$id,input:$input,merge:false) { id environmentId status } }', { id: environmentId, input: config });
    return data.environmentStageChanges;
  }
  async commitConfig(environmentId, message) {
    return (await this.graphql('mutation StackedCommit($id:String!,$message:String!) { environmentPatchCommitStaged(environmentId:$id,skipDeploys:true,commitMessage:$message) }', { id: environmentId, message })).environmentPatchCommitStaged;
  }
  async readPatch(patchId) { return (await this.graphql('query StackedPatch($id:String!) { environmentPatch(id:$id) { id environmentId status message appliedAt } }', { id: patchId })).environmentPatch; }
  async listPatches(environmentId) { return connection((await this.graphql('query StackedPatches($id:String!) { environmentPatches(environmentId:$id,first:100) { edges { node { id environmentId status message appliedAt } } pageInfo { hasNextPage } } }', { id: environmentId })).environmentPatches); }
  async deployService(environmentId, id) { return (await this.graphql('mutation StackedDeploy($environmentId:String!,$serviceId:String!) { serviceInstanceDeployV2(environmentId:$environmentId,serviceId:$serviceId) }', { environmentId, serviceId: id })).serviceInstanceDeployV2; }
  async readDeployment(id) { return (await this.graphql('query StackedDeployment($id:String!) { deployment(id:$id) { id projectId environmentId serviceId status deploymentStopped meta } }', { id })).deployment; }
  async deleteEnvironment(id) { requireCondition((await this.graphql('mutation StackedDelete($id:String!) { environmentDelete(id:$id) }', { id })).environmentDelete === true, 'STACKED_PREVIEW_DELETE_FAILED'); }
  async readReadiness(baseUrl) {
    const url = new URL(baseUrl);
    requireCondition(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash
      && url.pathname === '/' && /^[a-z0-9][a-z0-9-]*pr-1532aa-1535[a-z0-9-]*\.up\.railway\.app$/u.test(url.hostname), 'STACKED_PREVIEW_HOST_SCOPE_INVALID');
    let response;
    try { response = await withTimeout(this.#fetchImpl(`${url.origin}/readyz`, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } })); }
    catch { throw new StackedDraftPreviewLifecycleError('STACKED_PREVIEW_READINESS_FAILED'); }
    requireCondition(response.status === 200 && response.headers.get('cache-control') === 'no-store' && response.headers.get('content-type')?.startsWith('application/json'), 'STACKED_PREVIEW_READINESS_FAILED');
    return withTimeout(boundedJson(response, 64 * 1024));
  }
}
async function boundedJson(response, limit = 2 * 1024 * 1024) {
  requireCondition(response?.body?.getReader, 'STACKED_PREVIEW_API_FAILED');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; requireCondition(size <= limit, 'STACKED_PREVIEW_RESPONSE_TOO_LARGE'); chunks.push(Buffer.from(part.value)); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { await reader.cancel().catch(() => {}); if (error instanceof StackedDraftPreviewLifecycleError) throw error; throw new StackedDraftPreviewLifecycleError('STACKED_PREVIEW_API_FAILED'); }
}
async function withTimeout(operation) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new StackedDraftPreviewLifecycleError('STACKED_PREVIEW_API_TIMEOUT')), 10_000); });
  try { return await Promise.race([operation, timeout]); } finally { clearTimeout(timer); }
}

function readJsonFile(path) { const bytes = readFileSync(path, 'utf8'); requireCondition(Buffer.byteLength(bytes) <= 128 * 1024, 'STACKED_PREVIEW_INPUT_TOO_LARGE'); return { value: JSON.parse(bytes), bytes }; }
function writeReceipt(path, value) { mkdirSync(dirname(resolve(path)), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
async function cli() {
  const [command, ...args] = process.argv.slice(2); const options = {};
  requireCondition(['audit', 'authorize', 'deploy', 'cleanup', 'sweep'].includes(command) && args.length % 2 === 0, 'STACKED_PREVIEW_CLI_INVALID');
  for (let index = 0; index < args.length; index += 2) { requireCondition(['--authorization', '--build-receipt', '--image', '--deployment', '--output'].includes(args[index]) && !options[args[index]], 'STACKED_PREVIEW_CLI_INVALID'); options[args[index]] = args[index + 1]; }
  requireCondition(options['--output'], 'STACKED_PREVIEW_CLI_INVALID');
  if (command === 'sweep') {
    requireCondition(process.env.GITHUB_REPOSITORY === DEFAULT_POLICY.repository && process.env.GITHUB_REF === 'refs/heads/main', 'STACKED_PREVIEW_TRUSTED_SWEEPER_REQUIRED');
    writeReceipt(options['--output'], await sweepExpiredStackedDraftPreviews({ railway: new StackedDraftRailwayApi({ token: process.env.RAILWAY_API_TOKEN }) })); return;
  }
  const raw = readJsonFile(options['--authorization']).value;
  if (command === 'cleanup') {
    // Cleanup authority is the exact checked-in target and durable ownership
    // patch, independent of the PRs or expired build authorization.
    const receipt = readJsonFile(options['--deployment']).value;
    requireCondition(receipt.ownership?.controllerSha === raw.controllerSha && receipt.ownership?.candidateSha === raw.stack?.at(-1)?.headSha
      && receipt.ownership?.runId === process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY === DEFAULT_POLICY.repository,
    'STACKED_PREVIEW_CLEANUP_RECEIPT_INVALID');
    requireCondition(raw.controllerSha === (process.env.CONTROLLER_SHA ?? process.env.GITHUB_SHA)
      && raw.controllerSha === process.env.GITHUB_SHA, 'STACKED_PREVIEW_CONTROLLER_DRIFT');
    let allowCreatedReceipt = false;
    if (options['--build-receipt'] && options['--image']) {
      const build = readJsonFile(options['--build-receipt']); const image = readJsonFile(options['--image']);
      const bound = validateImageReceipt({ authorization: { ...raw, policy: DEFAULT_POLICY }, buildReceipt: build.value, buildReceiptBytes: build.bytes, publishedImage: image.value });
      requireCondition(bound.image === receipt.ownership.image && bound.imageId === receipt.ownership.imageId
        && bound.buildReceiptSha256 === receipt.ownership.buildReceiptSha256, 'STACKED_PREVIEW_CLEANUP_RECEIPT_INVALID');
      allowCreatedReceipt = true;
    }
    writeReceipt(options['--output'], await cleanupStackedDraftPreview({ railway: new StackedDraftRailwayApi({ token: process.env.RAILWAY_API_TOKEN }), receipt, allowCreatedReceipt })); return;
  }
  const controllerSha = process.env.CONTROLLER_SHA ?? process.env.GITHUB_SHA;
  requireCondition(controllerSha === process.env.GITHUB_SHA, 'STACKED_PREVIEW_CONTROLLER_DRIFT');
  const authorization = validateAuthorization({ authorization: raw, actor: process.env.GITHUB_ACTOR, repository: process.env.GITHUB_REPOSITORY, controllerSha, requireActivation: command !== 'audit' });
  const github = new GitHubReadAdapter({ token: process.env.GITHUB_TOKEN });
  const git = new GitReadAdapter({ cwd: process.cwd() });
  const revalidate = async () => {
    const permission = await github.readOwnerPermission();
    requireCondition(permission.actor === authorization.actor && permission.permission === 'admin', 'STACKED_PREVIEW_OWNER_AUTHORIZATION_REQUIRED');
    const current = await github.readStack();
    requireCondition(current.mainProtected === true, 'STACKED_PREVIEW_MAIN_PROTECTION_REQUIRED');
    const requiredCI = [];
    for (const entry of authorization.stack) requiredCI.push(await github.readRequiredCI(entry.headSha));
    const evidence = await verifyStack({ authorization, ...current, controllerSha, git });
    return { ...evidence, requiredCI };
  };
  const evidence = await revalidate();
  if (command === 'authorize' || command === 'audit') {
    let deploymentActivation = 'VERIFIED';
    try { requireDeploymentActivation(authorization); } catch { deploymentActivation = 'BLOCKED'; }
    writeReceipt(options['--output'], { status: 'VERIFIED', deploymentActivation, ...evidence, expiresAt: authorization.expiresAt }); return;
  }
  const build = readJsonFile(options['--build-receipt']); const image = readJsonFile(options['--image']);
  const imageReceipt = validateImageReceipt({ authorization, buildReceipt: build.value, buildReceiptBytes: build.bytes, publishedImage: image.value });
  await deployStackedDraftPreview({ authorization, imageReceipt, railway: new StackedDraftRailwayApi({ token: process.env.RAILWAY_API_TOKEN }), revalidate, runId: process.env.GITHUB_RUN_ID, onReceipt: receipt => writeReceipt(options['--output'], receipt) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli().catch(error => { process.stderr.write(`${/^[A-Z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'STACKED_PREVIEW_FAILED'}\n`); process.exitCode = 1; });
}

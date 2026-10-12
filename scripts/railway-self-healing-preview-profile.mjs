/**
 * Credential-free contract for a separately managed, normal-runtime preview.
 *
 * These functions validate explicit DTOs; they never read process.env, create
 * Railway resources, start application code, or make a network request. An
 * eventual trusted executor must obtain the observations from Railway itself
 * and retain its actual creation responses. A receipt hash binds an inventory
 * snapshot across restarts; it does not authenticate that snapshot or prove a
 * deployment occurred. This profile does not change the existing sealed lane.
 */

import { createHash } from 'node:crypto';
import {
  RAILWAY_PR_PREVIEW_CONTRACT,
  validateLifecyclePullRequest,
} from './railway-pr-preview-lifecycle.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const FRESHNESS_MS = 60_000;
const ROLES = Object.freeze(['web', 'worker', 'postgres', 'redis']);
const APP_ROLES = Object.freeze(['web', 'worker']);
const DATA_ROLES = Object.freeze(['postgres', 'redis']);
// This is configuration data only. The profile never executes this command or
// expands the environment reference. Official Redis does not consume the
// REDIS_PASSWORD variable unless its startup command explicitly enables AUTH.
const REDIS_START_COMMAND = "sh -c 'exec redis-server --appendonly yes --requirepass \"$REDIS_PASSWORD\"'";
const FORBIDDEN_IDS = new Set([
  RAILWAY_PR_PREVIEW_CONTRACT.projectId,
  RAILWAY_PR_PREVIEW_CONTRACT.workspaceId,
  RAILWAY_PR_PREVIEW_CONTRACT.productionEnvironmentId,
  RAILWAY_PR_PREVIEW_CONTRACT.baseEnvironmentId,
  RAILWAY_PR_PREVIEW_CONTRACT.baseSourceEnvironmentId,
  RAILWAY_PR_PREVIEW_CONTRACT.services.web.id,
  RAILWAY_PR_PREVIEW_CONTRACT.services.worker.id,
  '6647b5b1-d796-4783-b5f0-b8e356019ca6',
  '81e4a1cf-7ae4-48bf-8321-23641bb23c0e',
]);
const PURPOSE_CREDENTIAL_NAMES = new Set([
  'ARCANOS_CONTROL_PLANE_ACCESS_TOKEN',
  'ARCANOS_GPT_ACCESS_TOKEN',
  'ARCANOS_WORKER_HELPER_TOKEN',
  'ARCANOS_JOB_READ_CAPABILITY_SECRET',
]);
const APP_VARIABLE_NAMES = new Set([
  'ARCANOS_PROCESS_KIND',
  'NODE_ENV',
  'ARCANOS_PREVIEW_ISOLATION',
  'FORCE_MOCK',
  'ALLOW_MOCK_OPENAI',
  'OPENAI_API_KEY_REQUIRED',
  'OPENAI_BASE_URL',
  'DATABASE_URL',
  'REDIS_URL',
  'RUN_WORKERS',
  'ARCANOS_CONTROL_PLANE_PRINCIPAL_ID',
  'ARCANOS_CONTROL_PLANE_SCOPES',
  ...PURPOSE_CREDENTIAL_NAMES,
]);
const REQUIRED_APP_VARIABLE_NAMES = [...APP_VARIABLE_NAMES].filter(
  name => !PURPOSE_CREDENTIAL_NAMES.has(name)
    && name !== 'ARCANOS_CONTROL_PLANE_SCOPES'
    && name !== 'ARCANOS_CONTROL_PLANE_PRINCIPAL_ID'
);
const CONTROL_PLANE_SCOPES = Object.freeze([
  'arcanos:read', 'self-heal:probe', 'self-heal:decide', 'self-heal:execute',
]);
const DATA_VARIABLE_NAMES = Object.freeze({
  postgres: new Set(['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB']),
  redis: new Set(['REDIS_PASSWORD']),
});
const PLAN_KEYS = [
  'schemaVersion', 'profile', 'repository', 'prNumber', 'branch', 'sourceCommit',
  'projectId', 'workspaceId', 'environmentName', 'plannedAt',
  'inventoryObservedAt', 'preexistingEnvironmentIds', 'preexistingServiceIds',
  'preexistingVolumeIds', 'sourceEnvironmentId', 'startCommand',
];
const RECEIPT_KEYS = [
  'schemaVersion', 'profile', 'planSha256', 'projectId', 'workspaceId',
  'environmentId', 'environmentName', 'sourceCommit', 'createdAt',
  'serviceIds', 'volumeIds',
];

export const SELF_HEALING_PREVIEW_PROFILE = Object.freeze({
  schemaVersion: 1,
  name: 'railway-self-healing-preview/v1',
  repository: RAILWAY_PR_PREVIEW_CONTRACT.repository,
  projectId: RAILWAY_PR_PREVIEW_CONTRACT.projectId,
  workspaceId: RAILWAY_PR_PREVIEW_CONTRACT.workspaceId,
  environmentPrefix: 'self-healing-pr-',
  startCommand: 'node scripts/start-railway-service-with-integrity.mjs',
  redisStartCommand: REDIS_START_COMMAND,
  roles: ROLES,
});

export class SelfHealingPreviewProfileError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SelfHealingPreviewProfileError';
    this.code = code;
  }
}

function requireCondition(condition, code) {
  if (!condition) throw new SelfHealingPreviewProfileError(code);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, keys) {
  return record(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function timestamp(value, code) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  requireCondition(Number.isFinite(parsed)
    && new Date(parsed).toISOString() === value, code);
  return parsed;
}

function identifiers(values, code) {
  requireCondition(Array.isArray(values)
    && values.every(value => typeof value === 'string' && UUID.test(value))
    && new Set(values).size === values.length, code);
  return values;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(
      key => [key, canonical(value[key])]
    ));
  }
  return value;
}

function fingerprint(plan) {
  return createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex');
}

function frozenCopy(value) {
  const result = structuredClone(value);
  const freeze = entry => {
    if (record(entry) || Array.isArray(entry)) {
      Object.values(entry).forEach(freeze);
      Object.freeze(entry);
    }
  };
  freeze(result);
  return result;
}

function validatePlan(plan) {
  requireCondition(exact(plan, PLAN_KEYS)
    && plan.schemaVersion === 1
    && plan.profile === SELF_HEALING_PREVIEW_PROFILE.name
    && plan.repository === SELF_HEALING_PREVIEW_PROFILE.repository
    && plan.projectId === SELF_HEALING_PREVIEW_PROFILE.projectId
    && plan.workspaceId === SELF_HEALING_PREVIEW_PROFILE.workspaceId
    && Number.isSafeInteger(plan.prNumber) && plan.prNumber > 0
    && typeof plan.branch === 'string' && plan.branch.length > 0
    && typeof plan.sourceCommit === 'string' && SHA.test(plan.sourceCommit)
    && plan.environmentName === `self-healing-pr-${plan.prNumber}-e2e`
    && plan.sourceEnvironmentId === null
    && plan.startCommand === SELF_HEALING_PREVIEW_PROFILE.startCommand,
  'SELF_HEALING_PREVIEW_PLAN_INVALID');
  const plannedAt = timestamp(plan.plannedAt, 'SELF_HEALING_PREVIEW_PLAN_INVALID');
  const observedAt = timestamp(plan.inventoryObservedAt, 'SELF_HEALING_PREVIEW_PLAN_INVALID');
  requireCondition(observedAt <= plannedAt && plannedAt - observedAt <= FRESHNESS_MS,
    'SELF_HEALING_PREVIEW_INVENTORY_STALE');
  identifiers(plan.preexistingEnvironmentIds, 'SELF_HEALING_PREVIEW_PLAN_INVALID');
  identifiers(plan.preexistingServiceIds, 'SELF_HEALING_PREVIEW_PLAN_INVALID');
  identifiers(plan.preexistingVolumeIds, 'SELF_HEALING_PREVIEW_PLAN_INVALID');
  requireCondition(plan.preexistingEnvironmentIds.includes(
    RAILWAY_PR_PREVIEW_CONTRACT.productionEnvironmentId
  ), 'SELF_HEALING_PREVIEW_INVENTORY_INCOMPLETE');
  return plan;
}

/** Build a no-effect plan from a current PR and complete pre-creation inventory. */
export function planSelfHealingPreview({
  pullRequest, prNumber, expectedHeadSha, inventory, now,
}) {
  const plannedAt = timestamp(now, 'SELF_HEALING_PREVIEW_TIME_INVALID');
  let pr;
  try {
    pr = validateLifecyclePullRequest(pullRequest, prNumber);
  } catch {
    throw new SelfHealingPreviewProfileError('SELF_HEALING_PREVIEW_PR_INVALID');
  }
  requireCondition(pr.state === 'open' && !pr.draft && pr.baseRef === 'main'
    && typeof expectedHeadSha === 'string' && SHA.test(expectedHeadSha)
    && pr.headSha === expectedHeadSha, 'SELF_HEALING_PREVIEW_PR_HEAD_MISMATCH');
  requireCondition(exact(inventory, [
    'projectId', 'workspaceId', 'complete', 'observedAt',
    'environments', 'serviceIds', 'volumeIds',
  ]) && inventory.complete === true
    && inventory.projectId === SELF_HEALING_PREVIEW_PROFILE.projectId
    && inventory.workspaceId === SELF_HEALING_PREVIEW_PROFILE.workspaceId
    && Array.isArray(inventory.environments), 'SELF_HEALING_PREVIEW_INVENTORY_INVALID');
  const observedAt = timestamp(inventory.observedAt, 'SELF_HEALING_PREVIEW_INVENTORY_INVALID');
  requireCondition(observedAt <= plannedAt && plannedAt - observedAt <= FRESHNESS_MS,
    'SELF_HEALING_PREVIEW_INVENTORY_STALE');
  requireCondition(inventory.environments.every(environment =>
    exact(environment, ['id', 'name']) && typeof environment.name === 'string'
      && environment.name.length > 0), 'SELF_HEALING_PREVIEW_INVENTORY_INVALID');
  const environmentName = `self-healing-pr-${prNumber}-e2e`;
  requireCondition(!inventory.environments.some(environment => environment.name === environmentName),
    'SELF_HEALING_PREVIEW_ALREADY_EXISTS');
  const plan = {
    schemaVersion: 1,
    profile: SELF_HEALING_PREVIEW_PROFILE.name,
    repository: pr.repository,
    prNumber,
    branch: pr.headRef,
    sourceCommit: expectedHeadSha,
    projectId: inventory.projectId,
    workspaceId: inventory.workspaceId,
    environmentName,
    plannedAt: now,
    inventoryObservedAt: inventory.observedAt,
    preexistingEnvironmentIds: inventory.environments.map(environment => environment.id).sort(),
    preexistingServiceIds: [...identifiers(inventory.serviceIds, 'SELF_HEALING_PREVIEW_INVENTORY_INVALID')].sort(),
    preexistingVolumeIds: [...identifiers(inventory.volumeIds, 'SELF_HEALING_PREVIEW_INVENTORY_INVALID')].sort(),
    sourceEnvironmentId: null,
    startCommand: SELF_HEALING_PREVIEW_PROFILE.startCommand,
  };
  validatePlan(plan);
  return frozenCopy(plan);
}

/** Validate persisted ownership against the original inventory, including restart. */
export function validateSelfHealingPreviewOwnershipReceipt({ plan, receipt, now }) {
  validatePlan(plan);
  const currentAt = timestamp(now, 'SELF_HEALING_PREVIEW_TIME_INVALID');
  requireCondition(exact(receipt, RECEIPT_KEYS)
    && receipt.schemaVersion === 1
    && receipt.profile === SELF_HEALING_PREVIEW_PROFILE.name
    && typeof receipt.planSha256 === 'string' && HASH.test(receipt.planSha256)
    && receipt.planSha256 === fingerprint(plan)
    && receipt.projectId === plan.projectId && receipt.workspaceId === plan.workspaceId
    && receipt.environmentName === plan.environmentName
    && receipt.sourceCommit === plan.sourceCommit
    && exact(receipt.serviceIds, ROLES) && exact(receipt.volumeIds, DATA_ROLES),
  'SELF_HEALING_PREVIEW_OWNERSHIP_INVALID');
  const createdAt = timestamp(receipt.createdAt, 'SELF_HEALING_PREVIEW_OWNERSHIP_INVALID');
  requireCondition(createdAt >= timestamp(plan.plannedAt, 'SELF_HEALING_PREVIEW_PLAN_INVALID')
    && createdAt - timestamp(plan.inventoryObservedAt, 'SELF_HEALING_PREVIEW_PLAN_INVALID') <= FRESHNESS_MS
    && createdAt <= currentAt, 'SELF_HEALING_PREVIEW_CREATION_TIME_INVALID');
  const resourceIds = [receipt.environmentId, ...Object.values(receipt.serviceIds),
    ...Object.values(receipt.volumeIds)];
  identifiers(resourceIds, 'SELF_HEALING_PREVIEW_RESOURCE_ID_INVALID');
  const preexistingIds = new Set([
    ...plan.preexistingEnvironmentIds, ...plan.preexistingServiceIds,
    ...plan.preexistingVolumeIds,
  ]);
  requireCondition(resourceIds.every(id => !FORBIDDEN_IDS.has(id) && !preexistingIds.has(id)),
    'SELF_HEALING_PREVIEW_RESOURCE_NOT_FRESH');
  return frozenCopy(receipt);
}

/** Retain exact creation identities; the eventual executor must persist this DTO. */
export function createSelfHealingPreviewOwnershipReceipt({
  plan, environmentId, serviceIds, volumeIds, createdAt, now,
}) {
  validatePlan(plan);
  return validateSelfHealingPreviewOwnershipReceipt({ plan, now, receipt: {
    schemaVersion: 1,
    profile: SELF_HEALING_PREVIEW_PROFILE.name,
    planSha256: fingerprint(plan),
    projectId: plan.projectId,
    workspaceId: plan.workspaceId,
    environmentId,
    environmentName: plan.environmentName,
    sourceCommit: plan.sourceCommit,
    createdAt,
    serviceIds,
    volumeIds,
  } });
}

function validateNames(names, allowed, required = []) {
  requireCondition(Array.isArray(names) && new Set(names).size === names.length
    && names.every(name => typeof name === 'string' && allowed.has(name))
    && required.every(name => names.includes(name)),
  'SELF_HEALING_PREVIEW_VARIABLES_UNSAFE');
}

function validateDeployment(deployment, serviceId, plan, receipt, role) {
  requireCondition(exact(deployment, [
    'id', 'projectId', 'environmentId', 'serviceId', 'status',
    'repository', 'branch', 'sourceCommit', 'image',
  ]) && typeof deployment.id === 'string' && UUID.test(deployment.id)
    && !FORBIDDEN_IDS.has(deployment.id)
    && deployment.projectId === plan.projectId
    && deployment.environmentId === receipt.environmentId
    && deployment.serviceId === serviceId && deployment.status === 'SUCCESS',
  'SELF_HEALING_PREVIEW_DEPLOYMENT_INVALID');
  if (APP_ROLES.includes(role)) {
    requireCondition(deployment.repository === plan.repository
      && deployment.branch === plan.branch && deployment.sourceCommit === plan.sourceCommit
      && deployment.image === null, 'SELF_HEALING_PREVIEW_DEPLOYMENT_HEAD_MISMATCH');
  } else {
    const imagePattern = role === 'postgres'
      ? /^postgres:18(?:-alpine)?@sha256:[0-9a-f]{64}$/u
      : /^redis:7\.4(?:-alpine)?@sha256:[0-9a-f]{64}$/u;
    requireCondition(deployment.repository === null && deployment.branch === null
      && deployment.sourceCommit === null && typeof deployment.image === 'string'
      && imagePattern.test(deployment.image), 'SELF_HEALING_PREVIEW_DATA_IMAGE_INVALID');
  }
}

function validateApp(service, plan, receipt, observedAt) {
  const role = service.role;
  requireCondition(exact(service, [
    'id', 'name', 'role', 'environmentIds', 'replicas', 'startCommand', 'source',
    'activeDeployments', 'publicDomains', 'tcpProxies', 'variableNames',
    'configuration', 'dependencies', 'credentials', 'controlPlane',
  ]) && service.startCommand === plan.startCommand
    && exact(service.source, ['repository', 'branch', 'sourceCommit'])
    && service.source.repository === plan.repository
    && service.source.branch === plan.branch && service.source.sourceCommit === plan.sourceCommit,
  'SELF_HEALING_PREVIEW_APP_SOURCE_INVALID');
  validateNames(service.variableNames, APP_VARIABLE_NAMES, REQUIRED_APP_VARIABLE_NAMES);
  const hasControlToken = service.variableNames.includes('ARCANOS_CONTROL_PLANE_ACCESS_TOKEN');
  requireCondition(hasControlToken
    ? exact(service.controlPlane, ['principalId', 'scopes'])
      && service.controlPlane.principalId === `self-healing-pr${plan.prNumber}-operator`
      && Array.isArray(service.controlPlane.scopes)
      && service.controlPlane.scopes.length === CONTROL_PLANE_SCOPES.length
      && new Set(service.controlPlane.scopes).size === CONTROL_PLANE_SCOPES.length
      && CONTROL_PLANE_SCOPES.every(scope => service.controlPlane.scopes.includes(scope))
      && service.variableNames.includes('ARCANOS_CONTROL_PLANE_PRINCIPAL_ID')
      && service.variableNames.includes('ARCANOS_CONTROL_PLANE_SCOPES')
    : service.controlPlane === null
      && !service.variableNames.includes('ARCANOS_CONTROL_PLANE_PRINCIPAL_ID')
      && !service.variableNames.includes('ARCANOS_CONTROL_PLANE_SCOPES'),
  'SELF_HEALING_PREVIEW_CONTROL_PLANE_METADATA_INVALID');
  const configuration = service.configuration;
  requireCondition(exact(configuration, [
    'nodeEnv', 'processKind', 'previewIsolation', 'forceMock', 'allowMockOpenAI',
    'openAIKeyRequired', 'openAIBaseUrl', 'runWorkers',
  ]) && configuration.nodeEnv === 'production' && configuration.processKind === role
    && configuration.previewIsolation === true && configuration.forceMock === true
    && configuration.allowMockOpenAI === true && configuration.openAIKeyRequired === false
    && configuration.runWorkers === (role === 'worker'),
  'SELF_HEALING_PREVIEW_APP_CONFIGURATION_UNSAFE');
  let baseUrl;
  try { baseUrl = new URL(configuration.openAIBaseUrl); } catch {
    throw new SelfHealingPreviewProfileError('SELF_HEALING_PREVIEW_PROVIDER_NOT_LOOPBACK');
  }
  requireCondition(baseUrl.protocol === 'http:' && baseUrl.hostname === '127.0.0.1'
    && baseUrl.port !== '' && baseUrl.pathname === '/v1'
    && !baseUrl.username && !baseUrl.password && !baseUrl.search && !baseUrl.hash,
  'SELF_HEALING_PREVIEW_PROVIDER_NOT_LOOPBACK');
  requireCondition(exact(service.dependencies, ['postgres', 'redis'])
    && DATA_ROLES.every(dataRole => {
      const dependency = service.dependencies[dataRole];
      return exact(dependency, ['serviceId', 'host', 'port'])
        && dependency.serviceId === receipt.serviceIds[dataRole]
        && dependency.host === `self-healing-pr${plan.prNumber}-${dataRole}.railway.internal`
        && dependency.port === (dataRole === 'postgres' ? 5432 : 6379);
    }), 'SELF_HEALING_PREVIEW_DEPENDENCY_UNSAFE');
  requireCondition(Array.isArray(service.credentials), 'SELF_HEALING_PREVIEW_CREDENTIAL_UNSAFE');
  const names = [];
  for (const credential of service.credentials) {
    requireCondition(exact(credential, ['name', 'provenance', 'createdAt', 'fingerprint'])
      && PURPOSE_CREDENTIAL_NAMES.has(credential.name)
      && service.variableNames.includes(credential.name)
      && credential.provenance === 'preview-created'
      && typeof credential.fingerprint === 'string' && HASH.test(credential.fingerprint)
      && credential.fingerprint !== '0'.repeat(64),
    'SELF_HEALING_PREVIEW_CREDENTIAL_UNSAFE');
    const credentialAt = timestamp(credential.createdAt, 'SELF_HEALING_PREVIEW_CREDENTIAL_UNSAFE');
    requireCondition(credentialAt >= timestamp(receipt.createdAt, 'SELF_HEALING_PREVIEW_OWNERSHIP_INVALID')
      && credentialAt <= observedAt, 'SELF_HEALING_PREVIEW_CREDENTIAL_UNSAFE');
    names.push(credential.name);
  }
  requireCondition(new Set(names).size === names.length
    && service.variableNames.filter(name => PURPOSE_CREDENTIAL_NAMES.has(name)).every(name => names.includes(name))
    && new Set(service.credentials.map(credential => credential.fingerprint)).size === service.credentials.length,
  'SELF_HEALING_PREVIEW_CREDENTIAL_UNSAFE');
}

function validateData(service, plan, receipt) {
  const role = service.role;
  requireCondition(exact(service, [
    'id', 'name', 'role', 'environmentIds', 'replicas', 'activeDeployments', 'publicDomains',
    'tcpProxies', 'variableNames', 'privateHost', 'port', 'volume', 'credential', 'startCommand',
  ]) && service.privateHost === `self-healing-pr${plan.prNumber}-${role}.railway.internal`
    && service.port === (role === 'postgres' ? 5432 : 6379)
    && service.startCommand === (role === 'postgres' ? null : REDIS_START_COMMAND)
    && service.publicDomains.length === 0 && service.tcpProxies.length === 0
    && exact(service.volume, ['id', 'mountPath'])
    && service.volume.id === receipt.volumeIds[role]
    // Official PostgreSQL 18 images store PGDATA below this parent. The older
    // /var/lib/postgresql/data mount does not contain their default PGDATA.
    && service.volume.mountPath === (role === 'postgres' ? '/var/lib/postgresql' : '/data'),
  'SELF_HEALING_PREVIEW_STORAGE_UNSAFE');
  validateNames(service.variableNames, DATA_VARIABLE_NAMES[role], [...DATA_VARIABLE_NAMES[role]]);
  requireCondition(exact(service.credential, ['name', 'provenance', 'createdAt', 'fingerprint'])
    && service.credential.name === (role === 'postgres' ? 'POSTGRES_PASSWORD' : 'REDIS_PASSWORD')
    && service.credential.provenance === 'preview-created'
    && typeof service.credential.fingerprint === 'string' && HASH.test(service.credential.fingerprint)
    && service.credential.fingerprint !== '0'.repeat(64)
    && timestamp(service.credential.createdAt, 'SELF_HEALING_PREVIEW_CREDENTIAL_UNSAFE')
      >= timestamp(receipt.createdAt, 'SELF_HEALING_PREVIEW_OWNERSHIP_INVALID'),
  'SELF_HEALING_PREVIEW_CREDENTIAL_UNSAFE');
}

/**
 * Validate a complete, fresh DTO supplied by a future independent attestor.
 * A successful return is contract validation, never a live acceptance receipt.
 * Variable values, connection URLs, payloads and secret values are not accepted.
 */
export function attestSelfHealingPreview({ plan, receipt, observation, now }) {
  validateSelfHealingPreviewOwnershipReceipt({ plan, receipt, now });
  const currentAt = timestamp(now, 'SELF_HEALING_PREVIEW_TIME_INVALID');
  requireCondition(exact(observation, [
    'complete', 'observedAt', 'projectId', 'workspaceId', 'environment',
    'services', 'externalPreviewWebhookCount', 'pendingChanges',
  ]) && observation.complete === true && observation.projectId === plan.projectId
    && observation.workspaceId === plan.workspaceId
    && observation.externalPreviewWebhookCount === 0 && observation.pendingChanges === false,
  'SELF_HEALING_PREVIEW_OBSERVATION_INVALID');
  const observedAt = timestamp(observation.observedAt, 'SELF_HEALING_PREVIEW_OBSERVATION_INVALID');
  requireCondition(observedAt >= timestamp(receipt.createdAt, 'SELF_HEALING_PREVIEW_OWNERSHIP_INVALID')
    && observedAt <= currentAt && currentAt - observedAt <= FRESHNESS_MS,
  'SELF_HEALING_PREVIEW_OBSERVATION_STALE');
  const environment = observation.environment;
  requireCondition(exact(environment, [
    'id', 'name', 'sourceEnvironmentId', 'isEphemeral', 'sharedVariableNames',
    'deploymentTriggers', 'serviceIds', 'volumeIds', 'bucketIds',
  ]) && environment.id === receipt.environmentId && environment.name === plan.environmentName
    && environment.sourceEnvironmentId === null && environment.isEphemeral === true
    && Array.isArray(environment.sharedVariableNames) && environment.sharedVariableNames.length === 0
    && Array.isArray(environment.deploymentTriggers) && environment.deploymentTriggers.length === 0
    && Array.isArray(environment.bucketIds) && environment.bucketIds.length === 0,
  'SELF_HEALING_PREVIEW_ENVIRONMENT_UNSAFE');
  const serviceIds = identifiers(environment.serviceIds, 'SELF_HEALING_PREVIEW_TOPOLOGY_INVALID');
  const volumeIds = identifiers(environment.volumeIds, 'SELF_HEALING_PREVIEW_TOPOLOGY_INVALID');
  requireCondition(serviceIds.length === ROLES.length
    && ROLES.every(role => serviceIds.includes(receipt.serviceIds[role]))
    && volumeIds.length === DATA_ROLES.length
    && DATA_ROLES.every(role => volumeIds.includes(receipt.volumeIds[role]))
    && Array.isArray(observation.services) && observation.services.length === ROLES.length,
  'SELF_HEALING_PREVIEW_TOPOLOGY_INVALID');
  const deploymentIds = {};
  const credentials = [];
  for (const role of ROLES) {
    const matches = observation.services.filter(service => service?.role === role);
    requireCondition(matches.length === 1, 'SELF_HEALING_PREVIEW_TOPOLOGY_INVALID');
    const service = matches[0];
    requireCondition(service.id === receipt.serviceIds[role]
      && service.name === `self-healing-pr${plan.prNumber}-${role}` && service.replicas === 1
      && Array.isArray(service.environmentIds) && service.environmentIds.length === 1
      && service.environmentIds[0] === receipt.environmentId
      && Array.isArray(service.activeDeployments) && service.activeDeployments.length === 1
      && Array.isArray(service.publicDomains) && Array.isArray(service.tcpProxies)
      && service.tcpProxies.length === 0, 'SELF_HEALING_PREVIEW_SERVICE_UNSAFE');
    validateDeployment(service.activeDeployments[0], service.id, plan, receipt, role);
    deploymentIds[role] = service.activeDeployments[0].id;
    if (APP_ROLES.includes(role)) {
      requireCondition(service.publicDomains.length === (role === 'web' ? 1 : 0),
        'SELF_HEALING_PREVIEW_DOMAIN_UNSAFE');
      for (const domain of service.publicDomains) {
        requireCondition(exact(domain, ['hostname', 'environmentId', 'serviceId'])
          && domain.environmentId === receipt.environmentId && domain.serviceId === service.id
          && typeof domain.hostname === 'string'
          && /^self-healing-pr[1-9][0-9]*-web(?:-[a-z0-9]+)?\.up\.railway\.app$/u.test(domain.hostname)
          && domain.hostname.startsWith(`self-healing-pr${plan.prNumber}-web`),
        'SELF_HEALING_PREVIEW_DOMAIN_UNSAFE');
      }
      validateApp(service, plan, receipt, observedAt);
      credentials.push(...service.credentials);
    } else {
      validateData(service, plan, receipt);
      requireCondition(timestamp(service.credential.createdAt, 'SELF_HEALING_PREVIEW_CREDENTIAL_UNSAFE')
        <= observedAt, 'SELF_HEALING_PREVIEW_CREDENTIAL_UNSAFE');
      credentials.push(service.credential);
    }
  }
  identifiers(Object.values(deploymentIds), 'SELF_HEALING_PREVIEW_DEPLOYMENT_INVALID');
  const fingerprintNames = new Map();
  for (const credential of credentials) {
    requireCondition(!fingerprintNames.has(credential.fingerprint)
      || fingerprintNames.get(credential.fingerprint) === credential.name,
    'SELF_HEALING_PREVIEW_CREDENTIAL_PURPOSE_REUSED');
    fingerprintNames.set(credential.fingerprint, credential.name);
  }
  return frozenCopy({
    schemaVersion: 1,
    profile: SELF_HEALING_PREVIEW_PROFILE.name,
    evidenceKind: 'credential-free-profile-contract',
    profileValidated: true,
    supportedRuntime: 'mock-baseline-only',
    selfHealingRuntimeAcceptanceSupported: false,
    authenticatedRuntimeExecutionVerified: false,
    storageAuthenticationVerified: false,
    storageDurabilityVerified: false,
    deploymentExecutionPerformed: false,
    liveRuntimeAcceptance: 'NOT_RUN',
    projectId: plan.projectId,
    environmentId: receipt.environmentId,
    environmentName: plan.environmentName,
    sourceCommit: plan.sourceCommit,
    attestedAt: observation.observedAt,
    serviceIds: receipt.serviceIds,
    volumeIds: receipt.volumeIds,
    deploymentIds,
  });
}

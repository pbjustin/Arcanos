/** Protected persistent target profile; the ephemeral PR-preview policy is unchanged. */
export const LIVE_VALIDATION_TARGET_VERSION = 'arcanos-live-validation-target/v1';
export const LIVE_VALIDATION_REPOSITORY = 'pbjustin/Arcanos';
export const LIVE_VALIDATION_PROJECT_ID = '7faf44e5-519c-4e73-8d7a-da9f389e6187';
export const LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID = 'fb583147-6c39-4343-9267-500f357d25ab';
export const LIVE_VALIDATION_PROTECTED_RESOURCE_IDS = Object.freeze([
  'c4ade025-3f13-4fca-9309-5d0dd81396fe', // Production web.
  '1765befb-b805-4051-9af9-28634e986886', // Production worker.
  '6647b5b1-d796-4783-b5f0-b8e356019ca6', // Production PostgreSQL.
  '81e4a1cf-7ae4-48bf-8321-23641bb23c0e', // Production Redis.
  '12780efb-f40b-4625-9ec6-d26f2170dbd4', // Unattached production Redis volume.
  '6cabb50f-cb69-4938-98b7-73edc06a29b5', // Production Redis volume.
  '5be976c8-e700-4d10-8528-4f0263ff98a0', // Production PostgreSQL volume.
  '398546f6-fe53-4e94-b375-66366b8a1a5a', // Production web data volume.
  'dcf7e127-fa4f-42b1-acf0-c8030789d321' // Unattached production PostgreSQL volume.
]);
export const LIVE_VALIDATION_QUOTA_LEDGER_MOUNT = '/var/lib/arcanos-live-validation';
// These are the existing fixed helper roles in APPLICATION_CONSTANTS, not configurable roles.
export const LIVE_VALIDATION_HELPER_MODEL_IDS = Object.freeze(['gpt-6-luna', 'gpt-6.1-sol']);
export const LIVE_VALIDATION_HARD_LIMITS = Object.freeze({
  maxSpendMicroUsd: 2_000_000, maxRequests: 32, maxWorkflows: 2, durationMs: 600_000
});

const COMMON_VARIABLE_NAMES = [
  'NODE_ENV', 'TZ', 'PORT',
  'RAILWAY_PROJECT_ID', 'RAILWAY_PROJECT_NAME', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_ENVIRONMENT_NAME',
  'RAILWAY_SERVICE_ID', 'RAILWAY_SERVICE_NAME', 'RAILWAY_DEPLOYMENT_ID', 'RAILWAY_PRIVATE_DOMAIN',
  'RAILWAY_REPLICA_ID', 'RAILWAY_REPLICA_REGION', 'RAILWAY_GIT_COMMIT_SHA', 'RAILWAY_GIT_BRANCH',
  'RAILWAY_GIT_REPO_NAME', 'RAILWAY_GIT_REPO_OWNER', 'RAILWAY_GIT_AUTHOR', 'RAILWAY_GIT_COMMIT_MESSAGE',
  'RAILWAY_DEPLOYMENT_OVERLAP_SECONDS', 'RAILWAY_DEPLOYMENT_DRAINING_SECONDS',
  'ARCANOS_LIVE_VALIDATION_TARGET_JSON', 'ARCANOS_LIVE_VALIDATION_TLS_CA_PEM',
  'ARCANOS_LIVE_VALIDATION_TLS_CERT_PEM', 'ARCANOS_LIVE_VALIDATION_TLS_KEY_PEM'
];
/** Configured/injected Railway variable names only; never pass values to the inventory adapter. */
export const LIVE_VALIDATION_RUNTIME_VARIABLE_NAMES = Object.freeze([...COMMON_VARIABLE_NAMES]);
export const LIVE_VALIDATION_SUPERVISOR_VARIABLE_NAMES = Object.freeze([
  ...COMMON_VARIABLE_NAMES, 'ARCANOS_LIVE_VALIDATION_CONTROLLER_PUBLIC_KEY_PEM',
  'ARCANOS_LIVE_PREVIEW_OPENAI_API_KEY', 'RAILWAY_VOLUME_MOUNT_PATH', 'RAILWAY_VOLUME_NAME'
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const PRIVATE_DNS = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.railway\.internal$/u;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const PROTECTED_IDS = new Set([LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID, ...LIVE_VALIDATION_PROTECTED_RESOURCE_IDS]);

export class LiveValidationTargetError extends Error {
  constructor(code) { super(code); this.name = 'LiveValidationTargetError'; this.code = code; }
}
function requireTarget(condition, code) { if (!condition) throw new LiveValidationTargetError(code); }

// Take an independent JSON snapshot without executing accessors, toJSON or inherited properties.
function jsonCopy(value, code, depth = 0, budget = { nodes: 0 }) {
  requireTarget(depth <= 12 && ++budget.nodes <= 4_096, code);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { requireTarget(Number.isFinite(value), code); return value; }
  requireTarget(value && typeof value === 'object'
    && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype), code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  requireTarget(keys.length <= 1_025 && keys.every(key => typeof key === 'string'), code);
  if (Array.isArray(value)) {
    const length = descriptors.length?.value;
    requireTarget(Number.isSafeInteger(length) && length <= 1_024 && keys.length === length + 1, code);
    return Array.from({ length }, (_, index) => {
      const descriptor = descriptors[index];
      requireTarget(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'), code);
      return jsonCopy(descriptor.value, code, depth + 1, budget);
    });
  }
  const output = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    requireTarget(!['__proto__', 'constructor', 'prototype'].includes(key)
      && descriptor.enumerable && Object.hasOwn(descriptor, 'value'), code);
    output[key] = jsonCopy(descriptor.value, code, depth + 1, budget);
  }
  return output;
}
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function safeId(value) { return typeof value === 'string' && UUID.test(value) && !PROTECTED_IDS.has(value); }
function sourceSha(value) { return typeof value === 'string' && SHA.test(value) && value !== '0'.repeat(40); }
function privateOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return value === parsed.origin && parsed.protocol === 'https:' && PRIVATE_DNS.test(parsed.hostname)
      && parsed.port === '8443' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
      && parsed.pathname === '/' ? parsed : null;
  } catch { return null; }
}

/** Syntax and protected-target validation only. TLS handshakes and admission remain separate gates. */
export function validateLiveValidationTarget(input) {
  const target = jsonCopy(input, 'LIVE_VALIDATION_TARGET_INVALID');
  requireTarget(exactKeys(target, ['version', 'repository', 'projectId', 'environmentId', 'environmentName',
    'runtimeServiceId', 'supervisorServiceId', 'privateOrigins', 'mtlsPeers', 'trustedSupervisorSha',
    'limits', 'models', 'writes']) && target.version === LIVE_VALIDATION_TARGET_VERSION
    && target.repository === LIVE_VALIDATION_REPOSITORY && target.projectId === LIVE_VALIDATION_PROJECT_ID
    && target.environmentName === 'live-validation' && target.writes === false, 'LIVE_VALIDATION_TARGET_INVALID');
  requireTarget(['environmentId', 'runtimeServiceId', 'supervisorServiceId'].every(key => safeId(target[key]))
    && new Set([target.environmentId, target.runtimeServiceId, target.supervisorServiceId]).size === 3,
  'LIVE_VALIDATION_TARGET_PROTECTED');
  requireTarget(sourceSha(target.trustedSupervisorSha), 'LIVE_VALIDATION_SUPERVISOR_SHA_INVALID');
  requireTarget(exactKeys(target.privateOrigins, ['runtime', 'supervisor'])
    && exactKeys(target.mtlsPeers, ['runtime', 'supervisor', 'verifier']), 'LIVE_VALIDATION_PRIVATE_TARGET_INVALID');
  const fingerprints = []; const dnsNames = [];
  for (const role of ['runtime', 'supervisor', 'verifier']) {
    const peer = target.mtlsPeers[role];
    requireTarget(exactKeys(peer, ['dns', 'sha256']) && typeof peer.dns === 'string' && PRIVATE_DNS.test(peer.dns)
      && typeof peer.sha256 === 'string' && FINGERPRINT.test(peer.sha256) && peer.sha256 !== '0'.repeat(64),
    'LIVE_VALIDATION_MTLS_PEER_INVALID');
    fingerprints.push(peer.sha256); dnsNames.push(peer.dns);
    if (role !== 'verifier') {
      const origin = privateOrigin(target.privateOrigins[role]);
      requireTarget(origin && origin.hostname === peer.dns, 'LIVE_VALIDATION_PRIVATE_TARGET_INVALID');
    }
  }
  requireTarget(new Set(fingerprints).size === 3 && new Set(dnsNames).size === 3,
    'LIVE_VALIDATION_MTLS_PEER_INVALID');
  requireTarget(exactKeys(target.limits, Object.keys(LIVE_VALIDATION_HARD_LIMITS))
    && Object.entries(LIVE_VALIDATION_HARD_LIMITS).every(([key, cap]) => Number.isSafeInteger(target.limits[key])
      && target.limits[key] > 0 && target.limits[key] <= cap), 'LIVE_VALIDATION_TARGET_LIMITS_INVALID');
  requireTarget(Array.isArray(target.models) && target.models.length === 3
    && target.models.every(model => exactKeys(model, ['id', 'inputMicroUsdPerToken', 'outputMicroUsdPerToken'])
      && typeof model.id === 'string' && MODEL_ID.test(model.id)
      && [model.inputMicroUsdPerToken, model.outputMicroUsdPerToken].every(rate => typeof rate === 'number'
        && Number.isFinite(rate) && rate > 0 && rate <= 100_000)), 'LIVE_VALIDATION_TARGET_MODELS_INVALID');
  const modelIds = target.models.map(model => model.id);
  requireTarget(new Set(modelIds).size === 3 && modelIds.filter(id => id.startsWith('ft:') && id.length > 3).length === 1
    && LIVE_VALIDATION_HELPER_MODEL_IDS.every(id => modelIds.includes(id)), 'LIVE_VALIDATION_TARGET_MODELS_INVALID');
  return freeze(target);
}

function variableNames(names, allowed) {
  return Array.isArray(names) && names.length <= allowed.length && new Set(names).size === names.length
    && names.every(name => typeof name === 'string' && allowed.includes(name));
}
function quotaVolume(volume, supervisorServiceId, includeServiceId) {
  return exactKeys(volume, includeServiceId ? ['id', 'serviceId', 'mountPath', 'purpose'] : ['id', 'mountPath', 'purpose'])
    && safeId(volume.id) && (!includeServiceId || volume.serviceId === supervisorServiceId)
    && volume.mountPath === LIVE_VALIDATION_QUOTA_LEDGER_MOUNT && volume.purpose === 'quota_ledger';
}

/**
 * A trusted Railway metadata adapter must include the full environment inventory, never values.
 * Schema: {projectId,environmentId,environmentName,sharedVariableNames,privateNetworkEnabled,volumes,
 * services:[{id,role,variableNames,publicDomains,tcpProxyDomains,volumeMounts,
 * source:{repository,commitSha,autoDeploy}}]}.
 * commitSha is the observed deployment.meta.commitHash, or null when no revision has deployed.
 * A trusted controller may use the explicit predeploy phase to inspect fresh services; the default
 * paid phase still requires deployment revisions, including the exact trusted supervisor SHA.
 * Private networking metadata is necessary isolation evidence, not certificate/admission attestation.
 */
export function assertLiveValidationInventory(input, actualEnv, options = {}) {
  const target = validateLiveValidationTarget(input);
  const configuration = jsonCopy(options, 'LIVE_VALIDATION_INVENTORY_PHASE_INVALID');
  requireTarget(exactKeys(configuration, []) || exactKeys(configuration, ['phase']),
    'LIVE_VALIDATION_INVENTORY_PHASE_INVALID');
  const phase = Object.hasOwn(configuration, 'phase') ? configuration.phase : 'paid';
  requireTarget(['predeploy', 'paid'].includes(phase), 'LIVE_VALIDATION_INVENTORY_PHASE_INVALID');
  const inventory = jsonCopy(actualEnv, 'LIVE_VALIDATION_INVENTORY_INVALID');
  requireTarget(exactKeys(inventory, ['projectId', 'environmentId', 'environmentName', 'sharedVariableNames',
    'privateNetworkEnabled', 'volumes', 'services']) && inventory.projectId === target.projectId
    && inventory.environmentId === target.environmentId && inventory.environmentName === target.environmentName,
  'LIVE_VALIDATION_INVENTORY_TARGET_MISMATCH');
  requireTarget(Array.isArray(inventory.sharedVariableNames) && inventory.sharedVariableNames.length === 0
    && inventory.privateNetworkEnabled === true, 'LIVE_VALIDATION_INVENTORY_ISOLATION_INVALID');
  requireTarget(Array.isArray(inventory.services) && inventory.services.length === 2
    && new Set(inventory.services.map(service => service?.id)).size === 2, 'LIVE_VALIDATION_INVENTORY_SERVICES_INVALID');
  for (const role of ['runtime', 'supervisor']) {
    const service = inventory.services.find(item => item?.role === role);
    requireTarget(exactKeys(service, ['id', 'role', 'variableNames', 'publicDomains', 'tcpProxyDomains',
      'volumeMounts', 'source']) && service.id === target[`${role}ServiceId`] && safeId(service.id),
    'LIVE_VALIDATION_INVENTORY_SERVICES_INVALID');
    requireTarget(variableNames(service.variableNames, role === 'runtime'
      ? LIVE_VALIDATION_RUNTIME_VARIABLE_NAMES : LIVE_VALIDATION_SUPERVISOR_VARIABLE_NAMES),
    'LIVE_VALIDATION_INVENTORY_VARIABLE_FORBIDDEN');
    requireTarget(Array.isArray(service.publicDomains) && service.publicDomains.length === 0
      && Array.isArray(service.tcpProxyDomains) && service.tcpProxyDomains.length === 0,
    'LIVE_VALIDATION_INVENTORY_PUBLIC_ROUTE_FORBIDDEN');
    requireTarget(exactKeys(service.source, ['repository', 'commitSha', 'autoDeploy'])
      && service.source.repository === target.repository
      && (sourceSha(service.source.commitSha) || phase === 'predeploy' && service.source.commitSha === null)
      && service.source.autoDeploy === false
      && (phase === 'predeploy' || role !== 'supervisor' || service.source.commitSha === target.trustedSupervisorSha),
    'LIVE_VALIDATION_INVENTORY_SOURCE_INVALID');
    requireTarget(Array.isArray(service.volumeMounts) && (role === 'runtime' ? service.volumeMounts.length === 0
      : service.volumeMounts.length <= 1 && service.volumeMounts.every(volume => quotaVolume(volume, service.id, false))),
    'LIVE_VALIDATION_INVENTORY_VOLUME_FORBIDDEN');
  }
  const supervisor = inventory.services.find(service => service.role === 'supervisor');
  requireTarget(Array.isArray(inventory.volumes) && inventory.volumes.length === supervisor.volumeMounts.length
    && inventory.volumes.every(volume => quotaVolume(volume, supervisor.id, true))
    && inventory.volumes.every(volume => supervisor.volumeMounts.some(mount => mount.id === volume.id
      && mount.mountPath === volume.mountPath && mount.purpose === volume.purpose)),
  'LIVE_VALIDATION_INVENTORY_VOLUME_FORBIDDEN');
  return freeze(inventory);
}

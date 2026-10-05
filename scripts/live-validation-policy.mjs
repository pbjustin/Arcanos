import { KeyObject, createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID, LIVE_VALIDATION_PROTECTED_RESOURCE_IDS,
  LIVE_VALIDATION_REPOSITORY, validateLiveValidationTarget } from './live-validation-target.mjs';

export const LIVE_VALIDATION_PLAN_VERSION = 'arcanos-live-validation-run/v1';
const SHA = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PLAN_KEYS = ['version', 'runId', 'repository', 'prNumber', 'commitSha', 'profile', 'profileHash',
  'artifactAttestationSha256', 'issuedAtMs', 'expiresAtMs', 'projectId', 'environmentId', 'runtimeServiceId',
  'runtimeDeploymentId', 'supervisorServiceId', 'supervisorDeploymentId', 'trustedSupervisorSha', 'targetHash',
  'paidAuthorized', 'offlineGateHash', 'runtimeBuildManifestSha256', 'supervisorBuildManifestSha256'];
const IDENTITY_KEYS = ['sourceCommit', 'projectId', 'environmentId', 'serviceId', 'deploymentId', 'buildManifestSha256'];
const PROTECTED_IDS = new Set([LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID, ...LIVE_VALIDATION_PROTECTED_RESOURCE_IDS]);
const admissions = new WeakSet();

export class LiveValidationPolicyError extends Error {
  constructor(code) { super(code); this.name = 'LiveValidationPolicyError'; this.code = code; }
}
function requirePolicy(condition, code) { if (!condition) throw new LiveValidationPolicyError(code); }
function integer(value, min, max = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function hash(value) { return typeof value === 'string' && HASH.test(value) && value !== '0'.repeat(64); }
function sha(value) { return typeof value === 'string' && SHA.test(value) && value !== '0'.repeat(40); }
function uuid(value) { return typeof value === 'string' && UUID.test(value); }
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

// Canonicalize JSON data without executing accessors/custom serializers from an input object.
function copyJson(value, depth = 0, budget = { nodes: 0 }) {
  requirePolicy(depth <= 16 && ++budget.nodes <= 4_096, 'LIVE_VALIDATION_PLAN_INVALID');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') { requirePolicy(Number.isFinite(value), 'LIVE_VALIDATION_PLAN_INVALID'); return value; }
  requirePolicy(value && typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype),
    'LIVE_VALIDATION_PLAN_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  requirePolicy(keys.length <= 1_025 && keys.every(key => typeof key === 'string'), 'LIVE_VALIDATION_PLAN_INVALID');
  if (Array.isArray(value)) {
    const length = descriptors.length?.value;
    requirePolicy(integer(length, 0, 1_024) && keys.length === length + 1, 'LIVE_VALIDATION_PLAN_INVALID');
    return Array.from({ length }, (_, index) => {
      const descriptor = descriptors[index];
      requirePolicy(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'), 'LIVE_VALIDATION_PLAN_INVALID');
      return copyJson(descriptor.value, depth + 1, budget);
    });
  }
  const output = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    requirePolicy(!['__proto__', 'constructor', 'prototype'].includes(key) && descriptor.enumerable
      && Object.hasOwn(descriptor, 'value'), 'LIVE_VALIDATION_PLAN_INVALID');
    output[key] = copyJson(descriptor.value, depth + 1, budget);
  }
  return output;
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
export function canonicalLiveValidationJson(value) { return canonical(copyJson(value)); }
export function liveValidationTargetSha256(target) {
  return createHash('sha256').update(canonicalLiveValidationJson(validateLiveValidationTarget(target))).digest('hex');
}

/** Offline signing belongs to the trusted controller, never a candidate runtime or supervisor. */
export function signLiveValidationPlan(plan, privateKey) {
  let key;
  try { key = privateKey instanceof KeyObject && privateKey.type === 'private' ? privateKey : createPrivateKey(privateKey); }
  catch { throw new LiveValidationPolicyError('LIVE_VALIDATION_PLAN_KEY_INVALID'); }
  requirePolicy(key.asymmetricKeyType === 'ed25519', 'LIVE_VALIDATION_PLAN_KEY_INVALID');
  const snapshot = copyJson(plan);
  return { plan: snapshot, signature: sign(null, Buffer.from(canonical(snapshot)), key).toString('base64url') };
}

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function validateObservedIdentity(input, role, plan) {
  const value = copyJson(input);
  requirePolicy(value && typeof value === 'object' && !Array.isArray(value)
    && IDENTITY_KEYS.every(key => Object.hasOwn(value, key)) && (value.role === undefined || value.role === role),
  'LIVE_VALIDATION_DEPLOYMENT_IDENTITY_INVALID');
  const expected = { sourceCommit: role === 'runtime' ? plan.commitSha : plan.trustedSupervisorSha,
    projectId: plan.projectId, environmentId: plan.environmentId, serviceId: plan[role + 'ServiceId'],
    deploymentId: plan[role + 'DeploymentId'], buildManifestSha256: plan[role + 'BuildManifestSha256'] };
  requirePolicy(IDENTITY_KEYS.every(key => value[key] === expected[key]), 'LIVE_VALIDATION_DEPLOYMENT_IDENTITY_MISMATCH');
  return expected;
}

/** Distinct persistent admission leaves the old PR-preview production-project prohibition intact. */
export function validateLiveValidationPlan({ signedPlan, trustedPublicKey, target, runtimeIdentity,
  supervisorIdentity, trustedProfileHash, nowMs = Date.now() } = {}) {
  requirePolicy(signedPlan !== undefined, 'LIVE_VALIDATION_SIGNED_PLAN_REQUIRED');
  const envelope = copyJson(signedPlan);
  requirePolicy(exactKeys(envelope, ['plan', 'signature']) && typeof envelope.signature === 'string'
    && /^[A-Za-z0-9_-]{86}$/u.test(envelope.signature)
    && Buffer.from(envelope.signature, 'base64url').toString('base64url') === envelope.signature,
  'LIVE_VALIDATION_SIGNED_PLAN_REQUIRED');
  let key;
  try { key = trustedPublicKey instanceof KeyObject && trustedPublicKey.type === 'public' ? trustedPublicKey : createPublicKey(trustedPublicKey); }
  catch { throw new LiveValidationPolicyError('LIVE_VALIDATION_PLAN_KEY_INVALID'); }
  requirePolicy(key.asymmetricKeyType === 'ed25519', 'LIVE_VALIDATION_PLAN_KEY_INVALID');
  requirePolicy(verify(null, Buffer.from(canonical(envelope.plan)), key, Buffer.from(envelope.signature, 'base64url')),
    'LIVE_VALIDATION_PLAN_SIGNATURE_INVALID');
  const plan = envelope.plan;
  requirePolicy(exactKeys(plan, PLAN_KEYS) && plan.version === LIVE_VALIDATION_PLAN_VERSION
    && /^[0-9a-f]{32}$/u.test(plan.runId) && plan.runId !== '0'.repeat(32)
    && plan.repository === LIVE_VALIDATION_REPOSITORY && integer(plan.prNumber, 1, 1_000_000_000)
    && plan.profile === 'gaming-guide' && sha(plan.commitSha) && sha(plan.trustedSupervisorSha)
    && ['profileHash', 'artifactAttestationSha256', 'targetHash', 'offlineGateHash',
      'runtimeBuildManifestSha256', 'supervisorBuildManifestSha256'].every(field => hash(plan[field]))
    && ['projectId', 'environmentId', 'runtimeServiceId', 'runtimeDeploymentId', 'supervisorServiceId',
      'supervisorDeploymentId'].every(field => uuid(plan[field])), 'LIVE_VALIDATION_PLAN_INVALID');
  requirePolicy(plan.paidAuthorized === true, 'LIVE_VALIDATION_PAID_AUTHORIZATION_REQUIRED');
  // Protected IDs are denied before any allowlist/target comparison, even with an operator signature.
  requirePolicy(!['environmentId', 'runtimeServiceId', 'supervisorServiceId', 'runtimeDeploymentId',
    'supervisorDeploymentId'].some(field => PROTECTED_IDS.has(plan[field])), 'LIVE_VALIDATION_PRODUCTION_FORBIDDEN');
  const protectedTarget = validateLiveValidationTarget(target);
  requirePolicy(['projectId', 'environmentId', 'runtimeServiceId', 'supervisorServiceId', 'trustedSupervisorSha']
    .every(field => plan[field] === protectedTarget[field]) && plan.targetHash === liveValidationTargetSha256(protectedTarget),
  'LIVE_VALIDATION_TARGET_MISMATCH');
  requirePolicy(hash(trustedProfileHash) && plan.profileHash === trustedProfileHash, 'LIVE_VALIDATION_PROFILE_MISMATCH');
  requirePolicy(integer(nowMs, 1) && integer(plan.issuedAtMs, 1, nowMs) && integer(plan.expiresAtMs, nowMs + 1)
    && plan.expiresAtMs - plan.issuedAtMs <= protectedTarget.limits.durationMs, 'LIVE_VALIDATION_PLAN_EXPIRED');
  const observedRuntime = validateObservedIdentity(runtimeIdentity, 'runtime', plan);
  const observedSupervisor = validateObservedIdentity(supervisorIdentity, 'supervisor', plan);
  const admission = freeze({ plan, target: protectedTarget, runtimeIdentity: observedRuntime, supervisorIdentity: observedSupervisor,
    admittedAtMs: nowMs, expiresAtMs: plan.expiresAtMs, mode: 'persistent-live-validation' });
  admissions.add(admission);
  return admission;
}

/** Branding prevents caller-created objects from bypassing signed admission before budget registration. */
export function assertLiveValidationAdmission(admission, nowMs = Date.now()) {
  requirePolicy(Boolean(admission && admissions.has(admission)), 'LIVE_VALIDATION_ADMISSION_UNTRUSTED');
  requirePolicy(integer(nowMs, admission.admittedAtMs, admission.expiresAtMs - 1), 'LIVE_VALIDATION_PLAN_EXPIRED');
  return admission;
}

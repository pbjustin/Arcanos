import { createHash, createPublicKey, sign, verify } from 'node:crypto';

export const LIVE_PREVIEW_APPROVAL_VERSION = 'arcanos-live-pr-preview/v1';
export const LIVE_PREVIEW_REPOSITORY = 'pbjustin/Arcanos';
export const KNOWN_PRODUCTION_ENVIRONMENT_ID = 'fb583147-6c39-4343-9267-500f357d25ab';
export const KNOWN_PRODUCTION_PROJECT_ID = '7faf44e5-519c-4e73-8d7a-da9f389e6187';
const SHA = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const admissions = new WeakSet();

export class LivePreviewPolicyError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function requirePolicy(condition, code) {
  if (!condition) throw new LivePreviewPolicyError(code);
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function canonicalLivePreviewJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    requirePolicy(Number.isFinite(value), 'LIVE_PREVIEW_APPROVAL_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalLivePreviewJson).join(',') + ']';
  requirePolicy(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype,
    'LIVE_PREVIEW_APPROVAL_INVALID');
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalLivePreviewJson(value[key])).join(',') + '}';
}

export function livePreviewAttestationSha256(attestation) {
  return createHash('sha256').update(canonicalLivePreviewJson(attestation)).digest('hex');
}

/** Offline helper: signing authority and key must remain outside PR execution. */
export function signLivePreviewApproval(approval, privateKey) {
  requirePolicy(privateKey?.asymmetricKeyType === 'ed25519', 'LIVE_PREVIEW_APPROVAL_KEY_INVALID');
  return { approval, signature: sign(null, Buffer.from(canonicalLivePreviewJson(approval)), privateKey).toString('base64url') };
}

function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
export function readLivePreviewHttpsOrigin(value) {
  if (typeof value !== 'string' || value.length > 2_048 || value !== value.trim()) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password
      && !parsed.search && !parsed.hash && parsed.pathname === '/' && value === parsed.origin ? value : null;
  } catch { return null; }
}
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

function validateApproval(approval, nowMs) {
  requirePolicy(exactKeys(approval, ['version', 'approvalId', 'repository', 'prNumber', 'commitSha', 'issuedAtMs',
    'expiresAtMs', 'attestationSha256', 'deployment', 'limits', 'models', 'moduleIds']), 'LIVE_PREVIEW_APPROVAL_INVALID');
  requirePolicy(approval.version === LIVE_PREVIEW_APPROVAL_VERSION && approval.repository === LIVE_PREVIEW_REPOSITORY
    && /^[a-zA-Z0-9_-]{16,128}$/u.test(approval.approvalId) && integer(approval.prNumber, 1, 1_000_000_000)
    && SHA.test(approval.commitSha) && /^[0-9a-f]{64}$/u.test(approval.attestationSha256), 'LIVE_PREVIEW_APPROVAL_INVALID');
  requirePolicy(integer(nowMs, 1, Number.MAX_SAFE_INTEGER) && integer(approval.issuedAtMs, 1, nowMs)
    && integer(approval.expiresAtMs, nowMs + 1, Number.MAX_SAFE_INTEGER)
    && approval.expiresAtMs - approval.issuedAtMs <= 3_600_000, 'LIVE_PREVIEW_APPROVAL_EXPIRED');
  const deployment = approval.deployment;
  requirePolicy(exactKeys(deployment, ['projectId', 'environmentId', 'environmentName', 'serviceId', 'deploymentId'])
    && ['projectId', 'environmentId', 'serviceId', 'deploymentId'].every(key => UUID.test(deployment[key]))
    && deployment.environmentName === `live-pr-${approval.prNumber}`, 'LIVE_PREVIEW_DEPLOYMENT_INVALID');
  const limits = approval.limits;
  requirePolicy(exactKeys(limits, ['maxRequests', 'maxInputTokensPerRequest', 'maxOutputTokensPerRequest',
    'maxTotalTokens', 'durationMs', 'maxSpendMicroUsd'])
    && integer(limits.maxRequests, 1, 64) && integer(limits.maxInputTokensPerRequest, 1, 1_000_000)
    && integer(limits.maxOutputTokensPerRequest, 1, 100_000) && integer(limits.maxTotalTokens, 2, 4_000_000)
    && integer(limits.durationMs, 1, 1_800_000) && limits.durationMs <= approval.expiresAtMs - nowMs
    && integer(limits.maxSpendMicroUsd, 1, 100_000_000), 'LIVE_PREVIEW_LIMITS_INVALID');
  requirePolicy(Array.isArray(approval.models) && approval.models.length >= 1 && approval.models.length <= 8
    && new Set(approval.models.map(model => model?.id)).size === approval.models.length
    && approval.models.every(model => exactKeys(model, ['id', 'inputMicroUsdPerToken', 'outputMicroUsdPerToken'])
      && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(model.id)
      && [model.inputMicroUsdPerToken, model.outputMicroUsdPerToken].every(rate => typeof rate === 'number'
        && Number.isFinite(rate) && rate > 0 && rate <= 100_000)), 'LIVE_PREVIEW_MODELS_INVALID');
  requirePolicy(Array.isArray(approval.moduleIds) && approval.moduleIds.length >= 1 && approval.moduleIds.length <= 16
    && new Set(approval.moduleIds).size === approval.moduleIds.length
    && approval.moduleIds.every(id => typeof id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/u.test(id)),
  'LIVE_PREVIEW_MODULES_INVALID');
}

function validateAttestation(approval, attestation, isolation) {
  requirePolicy(exactKeys(attestation, ['repository', 'headRepository', 'prNumber', 'commitSha', 'projectId',
    'environmentId', 'environmentName', 'serviceId', 'deploymentId', 'production', 'isolated', 'dataIsolated',
    'credentialIsolated', 'egressRestricted', 'controllerRevision', 'backendOrigin', 'brokerOrigin'])
    && readLivePreviewHttpsOrigin(attestation.backendOrigin) && readLivePreviewHttpsOrigin(attestation.brokerOrigin)
    && attestation.backendOrigin !== attestation.brokerOrigin, 'LIVE_PREVIEW_ATTESTATION_INVALID');
  requirePolicy(attestation.repository === LIVE_PREVIEW_REPOSITORY && attestation.headRepository === LIVE_PREVIEW_REPOSITORY,
    'LIVE_PREVIEW_FORK_FORBIDDEN');
  requirePolicy(attestation.prNumber === approval.prNumber && attestation.commitSha === approval.commitSha
    && SHA.test(attestation.controllerRevision)
    && Object.entries(approval.deployment).every(([key, value]) => attestation[key] === value)
    && livePreviewAttestationSha256(attestation) === approval.attestationSha256, 'LIVE_PREVIEW_ATTESTATION_MISMATCH');
  requirePolicy(attestation.production === false && attestation.environmentId !== KNOWN_PRODUCTION_ENVIRONMENT_ID
    && attestation.projectId !== KNOWN_PRODUCTION_PROJECT_ID
    && !isolation?.productionEnvironmentIds?.includes(attestation.environmentId)
    && !isolation?.productionProjectIds?.includes(attestation.projectId), 'LIVE_PREVIEW_PRODUCTION_FORBIDDEN');
  requirePolicy(isolation && ['projectIds', 'environmentIds'].every(key => Array.isArray(isolation[key])
    && isolation[key].length > 0 && isolation[key].every(value => UUID.test(value)))
    && ['productionProjectIds', 'productionEnvironmentIds'].every(key => isolation[key] === undefined
      || (Array.isArray(isolation[key]) && isolation[key].every(value => UUID.test(value))))
    && isolation.projectIds.includes(attestation.projectId) && isolation.environmentIds.includes(attestation.environmentId)
    && attestation.isolated === true && attestation.dataIsolated === true && attestation.credentialIsolated === true
    && attestation.egressRestricted === true, 'LIVE_PREVIEW_ISOLATION_REQUIRED');
}

/** Trusted supervisor only: trust roots and allowlists are never PR-owned inputs. */
export function validateLivePreviewAdmission({ enabled = false, signedApproval, trustedApprovalPublicKey,
  attestation, trustedIsolation, nowMs = Date.now() } = {}) {
  requirePolicy(enabled === true, 'LIVE_PREVIEW_DISABLED');
  requirePolicy(exactKeys(signedApproval, ['approval', 'signature']) && typeof signedApproval.signature === 'string'
    && /^[A-Za-z0-9_-]{86}$/u.test(signedApproval.signature), 'LIVE_PREVIEW_APPROVAL_REQUIRED');
  let publicKey;
  try {
    publicKey = trustedApprovalPublicKey?.type === 'public' ? trustedApprovalPublicKey : createPublicKey(trustedApprovalPublicKey);
  } catch { throw new LivePreviewPolicyError('LIVE_PREVIEW_APPROVAL_KEY_INVALID'); }
  requirePolicy(publicKey.asymmetricKeyType === 'ed25519', 'LIVE_PREVIEW_APPROVAL_KEY_INVALID');
  let verified = false;
  try { verified = verify(null, Buffer.from(canonicalLivePreviewJson(signedApproval.approval)), publicKey,
    Buffer.from(signedApproval.signature, 'base64url')); } catch { /* Stable error; never include key material. */ }
  requirePolicy(verified, 'LIVE_PREVIEW_APPROVAL_SIGNATURE_INVALID');
  validateApproval(signedApproval.approval, nowMs);
  validateAttestation(signedApproval.approval, attestation, trustedIsolation);
  const admission = deepFreeze({ approval: structuredClone(signedApproval.approval), attestation: structuredClone(attestation),
    admittedAtMs: nowMs, expiresAtMs: Math.min(signedApproval.approval.expiresAtMs,
      nowMs + signedApproval.approval.limits.durationMs), mode: 'live-backend' });
  admissions.add(admission);
  return admission;
}

export function assertLivePreviewAdmission(admission, nowMs = Date.now()) {
  requirePolicy(Boolean(admission && admissions.has(admission)), 'LIVE_PREVIEW_ADMISSION_UNTRUSTED');
  requirePolicy(integer(nowMs, admission.admittedAtMs, admission.expiresAtMs - 1), 'LIVE_PREVIEW_APPROVAL_EXPIRED');
  return admission;
}

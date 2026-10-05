import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { assertLivePreviewAdmission } from './live-pr-preview-policy.mjs';
import { LIVE_VALIDATION_PLAN_VERSION, assertLiveValidationAdmission, canonicalLiveValidationJson,
  liveValidationTargetSha256, signLiveValidationPlan, validateLiveValidationPlan } from './live-validation-policy.mjs';
import { LIVE_VALIDATION_PROJECT_ID, LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID,
  LIVE_VALIDATION_PROTECTED_RESOURCE_IDS } from './live-validation-target.mjs';

const keys = generateKeyPairSync('ed25519');
const nowMs = 1_000_000;
const id = suffix => '10000000-0000-4000-8000-' + suffix.toString().padStart(12, '0');
function fixture(change = () => {}) {
  const target = { version: 'arcanos-live-validation-target/v1', repository: 'pbjustin/Arcanos',
    projectId: LIVE_VALIDATION_PROJECT_ID, environmentId: id(1), environmentName: 'live-validation',
    runtimeServiceId: id(2), supervisorServiceId: id(3), privateOrigins: {
      runtime: 'https://runtime.railway.internal:8443', supervisor: 'https://supervisor.railway.internal:8443' },
    mtlsPeers: { runtime: { dns: 'runtime.railway.internal', sha256: '1'.repeat(64) },
      supervisor: { dns: 'supervisor.railway.internal', sha256: '2'.repeat(64) },
      verifier: { dns: 'verifier.railway.internal', sha256: '3'.repeat(64) } },
    trustedSupervisorSha: 'b'.repeat(40), limits: { maxSpendMicroUsd: 2_000_000, maxRequests: 32, maxWorkflows: 2, durationMs: 600_000 },
    models: [{ id: 'ft:gpt-6-luna:arcanos:gaming:offline', inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 2 },
      { id: 'gpt-6-luna', inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 2 },
      { id: 'gpt-6.1-sol', inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 2 }], writes: false };
  const plan = { version: LIVE_VALIDATION_PLAN_VERSION, runId: 'a'.repeat(32), repository: target.repository, prNumber: 1527,
    commitSha: 'a'.repeat(40), profile: 'gaming-guide', profileHash: '4'.repeat(64), artifactAttestationSha256: '5'.repeat(64),
    issuedAtMs: nowMs - 1, expiresAtMs: nowMs + 599_999, projectId: target.projectId, environmentId: target.environmentId,
    runtimeServiceId: target.runtimeServiceId, runtimeDeploymentId: id(4), supervisorServiceId: target.supervisorServiceId,
    supervisorDeploymentId: id(5), trustedSupervisorSha: target.trustedSupervisorSha,
    targetHash: liveValidationTargetSha256(target), paidAuthorized: true, offlineGateHash: '6'.repeat(64),
    runtimeBuildManifestSha256: '7'.repeat(64), supervisorBuildManifestSha256: '8'.repeat(64) };
  const observed = role => ({ sourceCommit: role === 'runtime' ? plan.commitSha : plan.trustedSupervisorSha,
    projectId: plan.projectId, environmentId: plan.environmentId, serviceId: plan[role + 'ServiceId'],
    deploymentId: plan[role + 'DeploymentId'], buildManifestSha256: plan[role + 'BuildManifestSha256'], role });
  const input = { plan, target, trustedPublicKey: keys.publicKey, trustedProfileHash: plan.profileHash, nowMs,
    runtimeIdentity: observed('runtime'), supervisorIdentity: observed('supervisor') };
  change(input);
  input.signedPlan = signLiveValidationPlan(input.plan, keys.privateKey);
  delete input.plan;
  return input;
}
function rejects(input, code) { assert.throws(() => validateLiveValidationPlan(input), { code }); }

test('operator signed plan admits only the exact protected new environment in the existing project', () => {
  const input = fixture(); const admission = validateLiveValidationPlan(input);
  assert.equal(admission.mode, 'persistent-live-validation');
  assert.equal(admission.target.projectId, LIVE_VALIDATION_PROJECT_ID);
  assert.equal(assertLiveValidationAdmission(admission, nowMs), admission);
  assert.equal(assertLiveValidationAdmission(admission, admission.expiresAtMs - 1), admission);
  assert.ok(Object.isFrozen(admission) && Object.isFrozen(admission.target.models[0]) && Object.isFrozen(admission.plan));
  input.target.mtlsPeers.runtime.sha256 = '9'.repeat(64);
  input.signedPlan.plan.runId = 'c'.repeat(32);
  assert.equal(admission.target.mtlsPeers.runtime.sha256, '1'.repeat(64));
  assert.equal(admission.plan.runId, 'a'.repeat(32));
});

test('persistent and legacy admission brands cannot be forged or cross-used', () => {
  const admission = validateLiveValidationPlan(fixture());
  assert.throws(() => assertLiveValidationAdmission({ ...admission }, nowMs), { code: 'LIVE_VALIDATION_ADMISSION_UNTRUSTED' });
  assert.throws(() => assertLiveValidationAdmission(structuredClone(admission), nowMs), { code: 'LIVE_VALIDATION_ADMISSION_UNTRUSTED' });
  assert.throws(() => assertLivePreviewAdmission(admission, nowMs), { code: 'LIVE_PREVIEW_ADMISSION_UNTRUSTED' });
  assert.throws(() => assertLiveValidationAdmission(admission, admission.expiresAtMs), { code: 'LIVE_VALIDATION_PLAN_EXPIRED' });
  assert.throws(() => assertLiveValidationAdmission(admission, nowMs - 1), { code: 'LIVE_VALIDATION_PLAN_EXPIRED' });
});

test('unsigned plans, wrong keys, modified paid permission and altered build digests fail closed', () => {
  rejects(undefined, 'LIVE_VALIDATION_SIGNED_PLAN_REQUIRED');
  rejects({ ...fixture(), signedPlan: undefined }, 'LIVE_VALIDATION_SIGNED_PLAN_REQUIRED');
  rejects({ ...fixture(), trustedPublicKey: generateKeyPairSync('ed25519').publicKey }, 'LIVE_VALIDATION_PLAN_SIGNATURE_INVALID');
  for (const field of ['runId', 'commitSha', 'profileHash', 'artifactAttestationSha256', 'offlineGateHash', 'targetHash',
    'runtimeBuildManifestSha256', 'supervisorBuildManifestSha256', 'runtimeDeploymentId', 'supervisorDeploymentId', 'paidAuthorized']) {
    const input = fixture(); input.signedPlan.plan[field] = field === 'paidAuthorized' ? false : 'modified';
    rejects(input, 'LIVE_VALIDATION_PLAN_SIGNATURE_INVALID');
  }
  rejects(fixture(input => { input.plan.paidAuthorized = false; }), 'LIVE_VALIDATION_PAID_AUTHORIZATION_REQUIRED');
});

test('every production service and environment ID is denied before allowlist comparisons', () => {
  for (const protectedId of [LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID, ...LIVE_VALIDATION_PROTECTED_RESOURCE_IDS]) {
    for (const field of ['environmentId', 'runtimeServiceId', 'supervisorServiceId', 'runtimeDeploymentId', 'supervisorDeploymentId']) {
      rejects(fixture(input => { input.plan[field] = protectedId; }), 'LIVE_VALIDATION_PRODUCTION_FORBIDDEN');
    }
  }
  const input = fixture(); input.target.environmentId = LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID;
  rejects(input, 'LIVE_VALIDATION_TARGET_PROTECTED');
});

test('target tuples, TLS identities, model prices and aggregate limits are covered by the target hash', () => {
  for (const field of ['environmentId', 'runtimeServiceId', 'supervisorServiceId', 'trustedSupervisorSha']) {
    rejects(fixture(input => { input.plan[field] = field === 'trustedSupervisorSha' ? 'c'.repeat(40) : id(99); }),
      'LIVE_VALIDATION_TARGET_MISMATCH');
  }
  for (const mutate of [target => { target.mtlsPeers.runtime.sha256 = '9'.repeat(64); },
    target => { target.models[0].inputMicroUsdPerToken = 3; }, target => { target.limits.maxRequests = 31; },
    target => { target.privateOrigins.runtime = 'https://other.railway.internal:8443'; target.mtlsPeers.runtime.dns = 'other.railway.internal'; }]) {
    const input = fixture(); mutate(input.target); rejects(input, 'LIVE_VALIDATION_TARGET_MISMATCH');
  }
});

test('fixed trusted profile hash is required in addition to the controller signature', () => {
  for (const trustedProfileHash of [undefined, null, '', '0'.repeat(64), 'f'.repeat(64)]) {
    rejects({ ...fixture(), trustedProfileHash }, 'LIVE_VALIDATION_PROFILE_MISMATCH');
  }
  rejects(fixture(input => { input.plan.profileHash = 'f'.repeat(64); }), 'LIVE_VALIDATION_PROFILE_MISMATCH');
});

test('actual runtime and supervisor deployment, source and build identities must match the signed plan', () => {
  for (const role of ['runtime', 'supervisor']) {
    for (const field of ['sourceCommit', 'projectId', 'environmentId', 'serviceId', 'deploymentId', 'buildManifestSha256']) {
      const input = fixture(); input[role + 'Identity'][field] = 'modified';
      rejects(input, 'LIVE_VALIDATION_DEPLOYMENT_IDENTITY_MISMATCH');
    }
    const missing = fixture(); delete missing[role + 'Identity'].buildManifestSha256;
    rejects(missing, 'LIVE_VALIDATION_DEPLOYMENT_IDENTITY_INVALID');
    const wrongRole = fixture(); wrongRole[role + 'Identity'].role = role === 'runtime' ? 'supervisor' : 'runtime';
    rejects(wrongRole, 'LIVE_VALIDATION_DEPLOYMENT_IDENTITY_INVALID');
  }
  const input = fixture(); input.runtimeIdentity.ready = true; input.supervisorIdentity.targetHash = input.signedPlan.plan.targetHash;
  assert.ok(validateLiveValidationPlan(input));
});

test('future, expired and longer-than-target run plans cannot mint admission', () => {
  for (const mutate of [plan => { plan.issuedAtMs = nowMs + 1; }, plan => { plan.expiresAtMs = nowMs; },
    plan => { plan.expiresAtMs = nowMs + 600_000; }, plan => { plan.issuedAtMs = 0; }]) {
    rejects(fixture(input => mutate(input.plan)), 'LIVE_VALIDATION_PLAN_EXPIRED');
  }
  assert.ok(validateLiveValidationPlan({ ...fixture(), nowMs: nowMs + 100_000 }));
});

test('exact plan schema rejects forks, wrong profiles, missing proofs and zero placeholder identities', () => {
  for (const mutate of [plan => { plan.repository = 'attacker/fork'; }, plan => { plan.profile = 'research'; },
    plan => { plan.extra = true; }, plan => { delete plan.offlineGateHash; }, plan => { plan.commitSha = '0'.repeat(40); },
    plan => { plan.runtimeBuildManifestSha256 = '0'.repeat(64); }, plan => { plan.runId = '0'.repeat(32); },
    plan => { plan.prNumber = 0; }]) {
    rejects(fixture(input => mutate(input.plan)), 'LIVE_VALIDATION_PLAN_INVALID');
  }
});

test('canonical signatures and target hashes are independent of object key order', () => {
  assert.equal(canonicalLiveValidationJson({ z: [2, 1], a: 'test' }), canonicalLiveValidationJson({ a: 'test', z: [2, 1] }));
  const input = fixture();
  input.signedPlan.plan = Object.fromEntries(Object.entries(input.signedPlan.plan).reverse());
  input.target = Object.fromEntries(Object.entries(input.target).reverse());
  assert.equal(liveValidationTargetSha256(input.target), input.signedPlan.plan.targetHash);
  assert.ok(validateLiveValidationPlan(input));
});

test('canonicalization and signature parsing never execute getters, custom serialization or accept signature aliases', () => {
  let invoked = false;
  const value = {}; Object.defineProperty(value, 'plan', { enumerable: true, get() { invoked = true; return {}; } });
  assert.throws(() => canonicalLiveValidationJson(value), { code: 'LIVE_VALIDATION_PLAN_INVALID' });
  assert.throws(() => signLiveValidationPlan(value, keys.privateKey), { code: 'LIVE_VALIDATION_PLAN_INVALID' });
  rejects({ ...fixture(), signedPlan: value }, 'LIVE_VALIDATION_PLAN_INVALID');
  assert.equal(invoked, false);
  for (const malformed of [NaN, undefined, [1, , 2], { toJSON() { invoked = true; return {}; } }]) {
    assert.throws(() => canonicalLiveValidationJson(malformed), { code: 'LIVE_VALIDATION_PLAN_INVALID' });
  }
  const input = fixture(); input.signedPlan.signature += '=';
  rejects(input, 'LIVE_VALIDATION_SIGNED_PLAN_REQUIRED');
  assert.equal(invoked, false);
});

test('only Ed25519 key material can sign or verify run plans', () => {
  const wrong = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.throws(() => signLiveValidationPlan(fixture().signedPlan.plan, wrong.privateKey), { code: 'LIVE_VALIDATION_PLAN_KEY_INVALID' });
  rejects({ ...fixture(), trustedPublicKey: wrong.publicKey }, 'LIVE_VALIDATION_PLAN_KEY_INVALID');
  rejects({ ...fixture(), trustedPublicKey: 'not-a-key' }, 'LIVE_VALIDATION_PLAN_KEY_INVALID');
  rejects({ ...fixture(), trustedPublicKey: { type: 'public', asymmetricKeyType: 'ed25519' } }, 'LIVE_VALIDATION_PLAN_KEY_INVALID');
});

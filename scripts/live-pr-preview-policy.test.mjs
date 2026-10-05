import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { LIVE_PREVIEW_APPROVAL_VERSION, KNOWN_PRODUCTION_ENVIRONMENT_ID, KNOWN_PRODUCTION_PROJECT_ID,
  canonicalLivePreviewJson, livePreviewAttestationSha256, signLivePreviewApproval,
  validateLivePreviewAdmission, assertLivePreviewAdmission } from './live-pr-preview-policy.mjs';

const keys = generateKeyPairSync('ed25519');
const nowMs = 1_000_000;
function fixture(change = () => {}) {
  const attestation = { repository: 'pbjustin/Arcanos', headRepository: 'pbjustin/Arcanos', prNumber: 17,
    commitSha: 'a'.repeat(40), projectId: '10000000-0000-4000-8000-000000000001',
    environmentId: '10000000-0000-4000-8000-000000000002', environmentName: 'live-pr-17',
    serviceId: '10000000-0000-4000-8000-000000000003', deploymentId: '10000000-0000-4000-8000-000000000004',
    production: false, isolated: true, dataIsolated: true, credentialIsolated: true, egressRestricted: true,
    controllerRevision: 'b'.repeat(40), backendOrigin: 'https://backend-preview.invalid', brokerOrigin: 'https://broker-preview.invalid' };
  const approval = { version: LIVE_PREVIEW_APPROVAL_VERSION, approvalId: 'approved-run-00000001', repository: 'pbjustin/Arcanos',
    prNumber: 17, commitSha: 'a'.repeat(40), issuedAtMs: nowMs - 1, expiresAtMs: nowMs + 60_000,
    attestationSha256: '', deployment: Object.fromEntries(['projectId', 'environmentId', 'environmentName', 'serviceId', 'deploymentId']
      .map(key => [key, attestation[key]])), limits: { maxRequests: 4, maxInputTokensPerRequest: 10_000,
      maxOutputTokensPerRequest: 100, maxTotalTokens: 40_000, durationMs: 60_000, maxSpendMicroUsd: 100_000 },
    models: [{ id: 'reviewed-model-2026-10-01', inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 2 }], moduleIds: ['gaming'] };
  const input = { enabled: true, approval, attestation, trustedApprovalPublicKey: keys.publicKey, nowMs,
    trustedIsolation: { projectIds: [attestation.projectId], environmentIds: [attestation.environmentId] } };
  change(input);
  approval.attestationSha256 = livePreviewAttestationSha256(attestation);
  input.signedApproval = signLivePreviewApproval(approval, keys.privateKey);
  delete input.approval;
  return input;
}
function rejects(input, code) { assert.throws(() => validateLivePreviewAdmission(input), error => error.code === code); }

test('live admission defaults disabled before parsing keys or approval', () => {
  rejects(undefined, 'LIVE_PREVIEW_DISABLED');
  for (const enabled of [false, 'true', 1]) rejects({ ...fixture(), enabled }, 'LIVE_PREVIEW_DISABLED');
});

test('exact signed approval and external isolation allowlist mint immutable branded admission', () => {
  const admission = validateLivePreviewAdmission(fixture());
  assert.equal(assertLivePreviewAdmission(admission, nowMs), admission);
  assert.equal(admission.mode, 'live-backend');
  assert.equal(admission.expiresAtMs, nowMs + 60_000);
  assert.ok(Object.isFrozen(admission.approval.limits));
  assert.throws(() => assertLivePreviewAdmission({ ...admission }, nowMs), /LIVE_PREVIEW_ADMISSION_UNTRUSTED/u);
  assert.throws(() => assertLivePreviewAdmission(admission, nowMs + 60_000), /LIVE_PREVIEW_APPROVAL_EXPIRED/u);
});

test('canonical signatures do not depend on property ordering', () => {
  assert.equal(canonicalLivePreviewJson({ b: [2, 1], a: 'test' }), canonicalLivePreviewJson({ a: 'test', b: [2, 1] }));
  const input = fixture();
  input.signedApproval.approval = Object.fromEntries(Object.entries(input.signedApproval.approval).reverse());
  assert.ok(validateLivePreviewAdmission(input));
});

test('unsigned, wrong-key, modified SHA and modified spending approvals fail closed', () => {
  rejects({ ...fixture(), signedApproval: undefined }, 'LIVE_PREVIEW_APPROVAL_REQUIRED');
  rejects({ ...fixture(), trustedApprovalPublicKey: generateKeyPairSync('ed25519').publicKey }, 'LIVE_PREVIEW_APPROVAL_SIGNATURE_INVALID');
  for (const mutate of [approval => { approval.commitSha = 'c'.repeat(40); }, approval => { approval.limits.maxSpendMicroUsd += 1; }]) {
    const input = fixture(); mutate(input.signedApproval.approval);
    rejects(input, 'LIVE_PREVIEW_APPROVAL_SIGNATURE_INVALID');
  }
});

test('production is rejected even with live mode enabled and an operator signature', () => {
  rejects(fixture(input => { input.attestation.production = true; }), 'LIVE_PREVIEW_PRODUCTION_FORBIDDEN');
  rejects(fixture(input => {
    input.attestation.environmentId = KNOWN_PRODUCTION_ENVIRONMENT_ID;
    input.approval.deployment.environmentId = KNOWN_PRODUCTION_ENVIRONMENT_ID;
    input.trustedIsolation.environmentIds = [KNOWN_PRODUCTION_ENVIRONMENT_ID];
  }), 'LIVE_PREVIEW_PRODUCTION_FORBIDDEN');
  rejects(fixture(input => { input.trustedIsolation.productionProjectIds = [input.attestation.projectId]; }), 'LIVE_PREVIEW_PRODUCTION_FORBIDDEN');
  rejects(fixture(input => {
    input.attestation.projectId = KNOWN_PRODUCTION_PROJECT_ID;
    input.approval.deployment.projectId = KNOWN_PRODUCTION_PROJECT_ID;
    input.trustedIsolation.projectIds = [KNOWN_PRODUCTION_PROJECT_ID];
  }), 'LIVE_PREVIEW_PRODUCTION_FORBIDDEN');
});

test('forks, SHA drift and unsigned platform-attestation drift are rejected', () => {
  rejects(fixture(input => { input.attestation.headRepository = 'attacker/fork'; }), 'LIVE_PREVIEW_FORK_FORBIDDEN');
  rejects(fixture(input => { input.attestation.commitSha = 'c'.repeat(40); }), 'LIVE_PREVIEW_ATTESTATION_MISMATCH');
  const input = fixture(); input.attestation.controllerRevision = 'd'.repeat(40);
  rejects(input, 'LIVE_PREVIEW_ATTESTATION_MISMATCH');
});

test('missing or incomplete platform isolation cannot be substituted by signed PR data', () => {
  for (const key of ['isolated', 'dataIsolated', 'credentialIsolated', 'egressRestricted']) {
    rejects(fixture(input => { input.attestation[key] = false; }), 'LIVE_PREVIEW_ISOLATION_REQUIRED');
  }
  for (const trustedIsolation of [undefined, {}, { projectIds: [], environmentIds: [] },
    { projectIds: ['10000000-0000-4000-8000-000000000099'], environmentIds: ['10000000-0000-4000-8000-000000000099'] }]) {
    rejects({ ...fixture(), trustedIsolation }, 'LIVE_PREVIEW_ISOLATION_REQUIRED');
  }
});

test('expired or future approvals and every omitted or invalid limit fail closed', () => {
  rejects(fixture(input => { input.approval.expiresAtMs = nowMs; }), 'LIVE_PREVIEW_APPROVAL_EXPIRED');
  rejects(fixture(input => { input.approval.issuedAtMs = nowMs + 1; }), 'LIVE_PREVIEW_APPROVAL_EXPIRED');
  for (const key of Object.keys(fixture().signedApproval.approval.limits)) {
    for (const value of [undefined, 0, -1, NaN, 0.5]) {
      if (Number.isNaN(value)) continue; // Non-JSON approvals cannot be signed at all.
      rejects(fixture(input => { if (value === undefined) delete input.approval.limits[key]; else input.approval.limits[key] = value; }),
        'LIVE_PREVIEW_LIMITS_INVALID');
    }
  }
  assert.throws(() => fixture(input => { input.approval.limits.maxRequests = NaN; }), /LIVE_PREVIEW_APPROVAL_INVALID/u);
});

test('missing, duplicated or non-conservative model prices are rejected', () => {
  for (const models of [[], [{ id: 'model', inputMicroUsdPerToken: 0, outputMicroUsdPerToken: 1 }],
    [{ id: 'model', inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 1 }, { id: 'model', inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 1 }]]) {
    rejects(fixture(input => { input.approval.models = models; }), 'LIVE_PREVIEW_MODELS_INVALID');
  }
});

test('bearer destination origins are approved canonically and cannot drift after signing', () => {
  for (const value of ['http://backend.invalid', 'https://user:secret@backend.invalid', 'https://backend.invalid/path',
    'https://backend.invalid?token=x', 'https://backend.invalid#fragment', 'https://backend.invalid/',
    'https://BACKEND.invalid', 'https://backend.invalid\\path']) {
    rejects(fixture(input => { input.attestation.backendOrigin = value; }), 'LIVE_PREVIEW_ATTESTATION_INVALID');
  }
  rejects(fixture(input => { input.attestation.brokerOrigin = input.attestation.backendOrigin; }), 'LIVE_PREVIEW_ATTESTATION_INVALID');
  const input = fixture(); input.attestation.brokerOrigin = 'https://other.invalid';
  rejects(input, 'LIVE_PREVIEW_ATTESTATION_MISMATCH');
});

test('module scope is explicit, signed, bounded and restricted to distinct catalog slugs', () => {
  for (const moduleIds of [undefined, [], ['gaming', 'gaming'], ['../gaming'], ['GAMING'], ['gaming/live'],
    Array.from({ length: 17 }, (_, index) => `module-${index}`)]) {
    rejects(fixture(input => { if (moduleIds === undefined) delete input.approval.moduleIds;
      else input.approval.moduleIds = moduleIds; }), moduleIds === undefined ? 'LIVE_PREVIEW_APPROVAL_INVALID' : 'LIVE_PREVIEW_MODULES_INVALID');
  }
  const input = fixture(input => { input.approval.moduleIds = ['gaming', 'research']; });
  assert.deepEqual(validateLivePreviewAdmission(input).approval.moduleIds, ['gaming', 'research']);
  input.signedApproval.approval.moduleIds.push('backstage');
  rejects(input, 'LIVE_PREVIEW_APPROVAL_SIGNATURE_INVALID');
});

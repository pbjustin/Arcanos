import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_GAMING_POLICY, TRUSTED_GAMING_KERNEL_POLICY_SHA256, GamingGitHubReadAdapter, GamingRailwayApi,
  assertGamingPreviewWorkflowContext, assertTrustedGamingPreviewExecutionReceipt, attestGamingPreview, cleanupGamingPreview,
  deployGamingPreview, gamingPreviewEnvironmentName, gamingPreviewVerifierArguments, restoreGamingExecutionReceipt, validateGamingAuthorization,
  validateGamingEnvironment, validateGamingImageReceipt, verifyGamingCandidate,
} from './railway-gaming-preview.mjs';
import { parseNativePrPreviewE2eArguments } from './native-pr-preview-e2e.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const id = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const controllerSha = 'a'.repeat(40), image = `ghcr.io/pbjustin/arcanos-gaming-preview@sha256:${'b'.repeat(64)}`;
const credentials = { username: 'synthetic-pull-only', password: 'mock-private-image-pull' };
const target = { workspaceId: id('1'), projectId: id('2'), baseEnvironmentId: id('3'), workerServiceId: id('4'),
  webServiceId: id('5'), region: 'us-east4-eqdc4a', cpuLimit: 1, memoryLimitGb: 1,
  imageRepository: 'ghcr.io/pbjustin/arcanos-gaming-preview', registryPullCredentialSha256: hash(JSON.stringify(credentials)) };
const policy = { ...DEFAULT_GAMING_POLICY, enabled: true, target };
const now = Date.now();
const raw = () => ({ version: 1, controllerSha, mainSha: controllerSha, baseSha: controllerSha,
  headSha: policy.headSha, treeSha: policy.treeSha, sourceArchiveSha256: 'c'.repeat(64),
  expiresAt: new Date(now + 3600_000).toISOString(), targetSha256: hash(JSON.stringify(target)) });
const authorize = (changes = {}, other = {}) => validateGamingAuthorization({ authorization: { ...raw(), ...changes },
  policy, actor: 'pbjustin', repository: 'pbjustin/Arcanos', controllerSha, runId: '42', now, ...other });
function build(a) {
  return { schemaVersion: 1, controllerSha, candidateSha: a.headSha, treeSha: a.treeSha, sourceArchiveSha256: a.sourceArchiveSha256,
    compiledSha256: 'd'.repeat(64), compiledFiles: 1, compiledBytes: 1, runtimeDependencyInventorySha256: 'e'.repeat(64),
    runtimeDevDependenciesPruned: true, expiresAt: a.expiresAt, imageId: `sha256:${'f'.repeat(64)}`,
    imageArchiveSha256: '0'.repeat(64), previewLane: 'gaming-synthetic-v1', runtimeEgressPolicy: 'linux-seccomp-no-outbound-v1',
    targetSha256: a.targetSha256, runId: a.runId, kernelPolicySha256: TRUSTED_GAMING_KERNEL_POLICY_SHA256, kernelLauncherSha256: '2'.repeat(64),
    runtimeEnvironmentName: gamingPreviewEnvironmentName(a.runId),
    runtimeTarget: Object.fromEntries(['projectId', 'baseEnvironmentId', 'workerServiceId', 'webServiceId'].map(key => [key, target[key]])) };
}
function imageReceipt(a, changes = {}) {
  const receipt = { ...build(a), ...changes }, bytes = JSON.stringify(receipt);
  return validateGamingImageReceipt({ authorization: a, buildReceipt: receipt, buildReceiptBytes: bytes,
    publishedImage: { image, imageId: receipt.imageId, buildReceiptSha256: hash(bytes) } });
}
const connection = nodes => ({ edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage: false } });
function baseEnvironment() {
  const config = { privateNetworkDisabled: true, sharedVariables: {}, services: {} }, nodes = [];
  for (const role of ['worker', 'web']) {
    const serviceId = target[`${role}ServiceId`];
    config.services[serviceId] = { source: { image }, variables: { ARCANOS_PROCESS_KIND: { value: role } },
      deploy: { numReplicas: 1, restartPolicyType: 'NEVER', restartPolicyMaxRetries: 0, healthcheckPath: '/readyz', healthcheckTimeout: 300,
        multiRegionConfig: { [target.region]: { numReplicas: 1 } }, limitOverride: { containers: { cpu: 1, memoryBytes: 1024 ** 3 } },
        registryCredentials: credentials }, networking: {} };
    nodes.push({ serviceId, environmentId: target.baseEnvironmentId, deletedAt: null, source: { image, repo: null },
      numReplicas: 1, restartPolicyType: 'NEVER', restartPolicyMaxRetries: 0, preDeployCommand: null, cronSchedule: null,
      startCommand: null, healthcheckPath: '/readyz', healthcheckTimeout: 300, region: target.region, activeDeployments: [],
      domains: { serviceDomains: [], customDomains: [] } });
  }
  return { id: target.baseEnvironmentId, name: 'production', projectId: target.projectId, deletedAt: null,
    config, deploymentTriggers: connection([]), volumeInstances: connection([]), serviceInstances: connection(nodes) };
}
function railwayMock({ failRole = null, deletionStuck = false, startupStuck = false, failPhase = null } = {}) {
  const state = { environments: [baseEnvironment()], patch: null, config: null, calls: [], deleted: false };
  const read = environmentId => state.environments.find(e => e.id === environmentId);
  return { state,
    validateAuthority: async () => {},
    listEnvironments: async () => structuredClone(state.environments),
    environmentAbsent: async (_t, environmentId, environmentName) => !state.environments.some(e => e.id === environmentId || e.name === environmentName),
    readEnvironment: async (_t, environmentId) => structuredClone(read(environmentId)),
    stagedEmpty: async () => true,
    createEnvironment: async (_t, name) => {
      const e = structuredClone(state.environments[0]);
      Object.assign(e, { id: id('6'), name, isEphemeral: true, sourceEnvironment: { id: target.baseEnvironmentId } });
      for (const { node } of e.serviceInstances.edges) {
        node.environmentId = e.id; node.domains.serviceDomains = [{ domain: `${node.serviceId === target.workerServiceId ? 'worker' : 'web'}-${name}.up.railway.app`,
          environmentId: e.id, serviceId: node.serviceId, deletedAt: null }];
      }
      state.environments.push(e); state.calls.push('create');
      if (failPhase === 'create-lost-response') throw new Error('lost create response');
      if (failPhase === 'create-invalid-response') return { id: e.id };
      return structuredClone(e);
    },
    stageConfig: async (environmentId, config) => { if (failPhase === 'stage') throw new Error('stage failed'); state.config = config;
      state.patch = { id: id('7'), environmentId, status: 'STAGED' }; return structuredClone(state.patch); },
    commitConfig: async (environmentId, message) => {
      if (failPhase === 'commit') throw new Error('commit failed');
      read(environmentId).config = state.config;
      for (const { node } of read(environmentId).serviceInstances.edges) node.source.image = state.config.services[node.serviceId].source.image;
      Object.assign(state.patch, { status: 'COMMITTED', message, appliedAt: new Date(now).toISOString() }); return state.patch.id;
    },
    readPatch: async () => structuredClone(state.patch),
    deployService: async (environmentId, serviceId) => {
      const role = serviceId === target.workerServiceId ? 'worker' : 'web'; state.calls.push(role);
      const deploymentId = role === 'worker' ? id('8') : id('9');
      read(environmentId).serviceInstances.edges.find(edge => edge.node.serviceId === serviceId).node.activeDeployments = [
        { id: deploymentId, status: 'SUCCESS', deploymentStopped: false, meta: { serviceManifest: { source: { image } } } }];
      return deploymentId;
    },
    readDeployment: async deploymentId => ({ id: deploymentId, projectId: target.projectId, environmentId: id('6'),
      serviceId: deploymentId === id('8') ? target.workerServiceId : target.webServiceId,
      status: failRole === (deploymentId === id('8') ? 'worker' : 'web') ? 'FAILED' : startupStuck ? 'BUILDING' : 'SUCCESS', deploymentStopped: false }),
    readGamingReadiness: async host => {
      if (failPhase === 'readiness') throw new Error('readiness failed');
      if (failPhase === 'worker-drift-during-web' && host.includes('web')) {
        read(id('6')).serviceInstances.edges.find(edge => edge.node.serviceId === target.workerServiceId).node.activeDeployments = [];
      }
      return { ready: true, prNumber: 1558, sourceCommit: policy.headSha,
      processKind: host.includes('worker') ? 'worker' : 'web', mode: host.includes('worker') ? 'passive-pr-preview' : 'native-pr-application-e2e-v1',
      applicationImported: true, fixturesSealed: true, protectedEffectsEnabled: false, protectsMaliciousPr: false,
      requiresPlatformSecretIsolationForUntrustedCode: true }; },
    deleteEnvironment: async environmentId => { state.deleted = true; state.calls.push('delete');
      if (!deletionStuck) state.environments = state.environments.filter(e => e.id !== environmentId); },
    pause: async () => {},
  };
}

test('Gaming lane is checked in disabled with no target', () => {
  assert.equal(DEFAULT_GAMING_POLICY.enabled, false); assert.equal(DEFAULT_GAMING_POLICY.target, null);
  assert.throws(() => authorize({}, { policy: DEFAULT_GAMING_POLICY }), /SOURCE_OR_TARGET_DRIFT/u);
});
test('authorization binds frozen source, base, owner, controller, target, run and expiry', () => {
  const a = authorize(); assert.equal(a.runId, '42'); assert.equal(Object.isFrozen(a.policy.target), true);
  for (const changes of [{ headSha: 'f'.repeat(40) }, { treeSha: 'f'.repeat(40) }, { baseSha: 'b'.repeat(40) },
    { controllerSha: 'b'.repeat(40) }, { targetSha256: '0'.repeat(64) }, { expiresAt: new Date(now - 1).toISOString() },
    { expiresAt: new Date(now + 7200_001).toISOString() }, { extra: true }]) assert.throws(() => authorize(changes));
  assert.throws(() => authorize({}, { actor: 'other' }), /OWNER_AUTHORIZATION_REQUIRED/u);
  assert.throws(() => authorize({}, { runId: '0' }), /OWNER_AUTHORIZATION_REQUIRED/u);
});
test('production or ambiguous target cannot be authorized', () => {
  for (const changes of [{ workspaceId: '1c9265a3-986f-4304-ad3e-5a874caab039' },
    { projectId: '7faf44e5-519c-4e73-8d7a-da9f389e6187' }, { workerServiceId: target.webServiceId },
    { extra: 'unknown' }, { registryPullCredentialSha256: 'unproven' }]) {
    assert.throws(() => authorize({}, { policy: { ...policy, target: { ...target, ...changes } } }), /TARGET_BLOCKED/u);
  }
});
test('exact non-draft PR admission rejects labels, unapproved PRs, forks and source drift', async () => {
  const authorization = authorize(), main = { protected: true, sha: controllerSha };
  const pr = { number: 1558, state: 'open', draft: false, head: { sha: policy.headSha, repo: { full_name: 'pbjustin/Arcanos' } },
    base: { ref: 'main', sha: controllerSha, repo: { full_name: 'pbjustin/Arcanos' } } };
  const git = { treeSha: async () => policy.treeSha, archiveSha256: async () => authorization.sourceArchiveSha256 };
  await verifyGamingCandidate({ authorization, main, pullRequest: pr, git });
  for (const patch of [{ number: 1535 }, { draft: true }, { state: 'closed' }, { head: { ...pr.head, sha: 'b'.repeat(40) } },
    { head: { ...pr.head, repo: { full_name: 'fork/Arcanos' } } }, { base: { ...pr.base, ref: 'other' } }]) {
    await assert.rejects(verifyGamingCandidate({ authorization, main, pullRequest: { ...pr, ...patch }, git }));
  }
  await assert.rejects(verifyGamingCandidate({ authorization, main: { ...main, protected: false }, pullRequest: pr, git }), /PROTECTED_MAIN_DRIFT/u);
  await assert.rejects(verifyGamingCandidate({ authorization, main, pullRequest: pr,
    git: { ...git, treeSha: async () => 'f'.repeat(40) } }), /TREE_DRIFT/u);
  await assert.rejects(verifyGamingCandidate({ authorization, main, pullRequest: pr,
    git: { ...git, archiveSha256: async () => 'f'.repeat(64) } }), /ARCHIVE_DRIFT/u);
});
test('refrozen Gaming admission accepts its exact new identity and rejects the historical source', async () => {
  const headSha = '848d6be5fc7d73936bb7921bd496d3051e30752d', treeSha = 'd78ffd0a423e9755008784b6c244cafc131d1acf';
  const sourceArchiveSha256 = '5bc4713eb4842f5927354bebc9ae82f43f9c32516dd7f32b61a8c446db684123';
  assert.equal(DEFAULT_GAMING_POLICY.headSha, headSha); assert.equal(DEFAULT_GAMING_POLICY.treeSha, treeSha);
  const authorization = authorize({ sourceArchiveSha256 }), main = { protected: true, sha: controllerSha };
  const pullRequest = { number: 1558, state: 'open', draft: false,
    head: { sha: headSha, repo: { full_name: 'pbjustin/Arcanos' } },
    base: { ref: 'main', sha: controllerSha, repo: { full_name: 'pbjustin/Arcanos' } } };
  const git = { treeSha: async () => treeSha, archiveSha256: async () => sourceArchiveSha256 };
  assert.equal((await verifyGamingCandidate({ authorization, main, pullRequest, git })).candidateSha, headSha);
  await assert.rejects(verifyGamingCandidate({ authorization, main, git,
    pullRequest: { ...pullRequest, head: { ...pullRequest.head, sha: '1c1e7d0f4c8f4e62fd7117e28efd0d8d7c415262' } } }),
  /PR_IDENTITY_DRIFT/u);
  assert.throws(() => authorize({ headSha: '1c1e7d0f4c8f4e62fd7117e28efd0d8d7c415262',
    treeSha: '89f1eb0b988514d92ef9f82dd2f77bc356735b8b' }), /SOURCE_OR_TARGET_DRIFT/u);
});

test('image receipt rejects wrong artifacts, mutable image, kernel policy, run and target', () => {
  const a = authorize(); imageReceipt(a);
  for (const changes of [{ candidateSha: 'f'.repeat(40) }, { runtimeDevDependenciesPruned: false },
    { runtimeEgressPolicy: 'application-mock-only' }, { kernelLauncherSha256: '' }, { kernelPolicySha256: '1'.repeat(64) }, { runId: '43' },
    { targetSha256: 'f'.repeat(64) }, { runtimeTarget: { ...build(a).runtimeTarget, projectId: id('0') } }]) {
    assert.throws(() => imageReceipt(a, changes), /BUILD_RECEIPT_INVALID/u);
  }
  const b = build(a), bytes = JSON.stringify(b);
  assert.throws(() => validateGamingImageReceipt({ authorization: a, buildReceipt: b, buildReceiptBytes: bytes,
    publishedImage: { image: 'ghcr.io/pbjustin/arcanos-gaming-preview:latest', imageId: b.imageId, buildReceiptSha256: hash(bytes) } }), /PUBLISHED_IMAGE_INVALID/u);
});
test('unsafe inherited resources and credentials are rejected before any creation', () => {
  for (const mutate of [e => { e.config.sharedVariables.OPENAI_API_KEY = { value: 'synthetic' }; },
    e => { e.config.privateNetworkDisabled = false; }, e => { e.deploymentTriggers = connection([{ id: id('0') }]); },
    e => { e.volumeInstances = connection([{ id: id('0') }]); }, e => { e.config.services[target.webServiceId].source.repo = 'pbjustin/Arcanos'; },
    e => { e.config.services[target.webServiceId].deploy.registryCredentials = { username: 'changed', password: 'synthetic' }; },
    e => { e.serviceInstances.pageInfo.hasNextPage = true; }]) {
    const environment = baseEnvironment(); mutate(environment);
    assert.throws(() => validateGamingEnvironment({ environment, target, base: true, idle: true }));
  }
});
test('mocked deployment is worker-first with sole immutable deployments and bounded receipt transfer', async () => {
  const authorization = authorize(), railway = railwayMock(), imageReceiptValue = imageReceipt(authorization);
  const { receipt, executionReceipt } = await deployGamingPreview({ authorization, imageReceipt: imageReceiptValue, railway,
    revalidate: async () => {}, now: () => now });
  assert.deepEqual(railway.state.calls, ['create', 'worker', 'web']);
  assert.equal(receipt.status, 'VERIFIED');
  const expected = { repository: 'pbjustin/Arcanos', prNumber: 1558, commitSha: policy.headSha, sourceTreeSha: policy.treeSha,
    webBaseUrl: receipt.hosts.web, workerBaseUrl: receipt.hosts.worker };
  assert.equal(assertTrustedGamingPreviewExecutionReceipt(executionReceipt, expected), executionReceipt);
  const parsed = parseNativePrPreviewE2eArguments(gamingPreviewVerifierArguments({ authorization, hostedReceipt: executionReceipt,
    gitEvidenceRoot: process.cwd() }), { includeSourceTree: true, localGitState: { repository: expected.repository,
      head: expected.commitSha, clean: true, sourceTreeSha: expected.sourceTreeSha } });
  assert.equal(parsed.commitSha, authorization.headSha); assert.equal(parsed.sourceTreeSha, authorization.treeSha);
  assert.throws(() => assertTrustedGamingPreviewExecutionReceipt({ ...executionReceipt }, expected), /HOSTED_RECEIPT_REQUIRED/u);
  const bytes = JSON.stringify(receipt), digest = hash(bytes);
  const restored = restoreGamingExecutionReceipt({ authorization, imageReceipt: imageReceiptValue,
    deploymentReceiptBytes: bytes, expectedSha256: digest, now });
  assert.equal(assertTrustedGamingPreviewExecutionReceipt(restored, expected).deploymentReceiptSha256, digest);
  assert.throws(() => restoreGamingExecutionReceipt({ authorization, imageReceipt: imageReceiptValue,
    deploymentReceiptBytes: bytes.replace('VERIFIED', 'UNVERIFIED'), expectedSha256: digest, now }), /DEPLOYMENT_ARTIFACT_UNTRUSTED/u);
  const cleanup = await cleanupGamingPreview({ policy, railway, receipt, now: () => now });
  assert.equal(cleanup.status, 'VERIFIED'); assert.equal(cleanup.absenceProof, 'railway-control-plane-complete-root-and-project-inventories');
});
test('worker failure and startup timeout always attempt owned control-plane cleanup', async () => {
  for (const config of [{ failRole: 'worker' }, { startupStuck: true }]) {
    const railway = railwayMock(config), authorization = authorize(); let last;
    await assert.rejects(deployGamingPreview({ authorization, imageReceipt: imageReceipt(authorization), railway,
      revalidate: async () => {}, now: () => now, onReceipt: value => { last = value; } }));
    assert.equal(railway.state.deleted, true); assert.equal(last.cleanup.status, 'VERIFIED');
    assert.equal(railway.state.calls.includes('web'), false);
  }
});
test('cleanup requires ownership and actual resource absence, never HTTP 404', async () => {
  const railway = railwayMock({ deletionStuck: true }), authorization = authorize();
  const { receipt } = await deployGamingPreview({ authorization, imageReceipt: imageReceipt(authorization), railway,
    revalidate: async () => {}, now: () => now });
  await assert.rejects(cleanupGamingPreview({ policy, railway, receipt, now: () => now }), /DELETE_READBACK_FAILED/u);
  const forged = structuredClone(receipt); forged.ownership.environmentId = target.baseEnvironmentId;
  await assert.rejects(cleanupGamingPreview({ policy, railway, receipt: forged, now: () => now }), /OWNERSHIP_MISMATCH/u);
  railway.state.patch.message = 'unowned';
  await assert.rejects(cleanupGamingPreview({ policy, railway, receipt, now: () => now }), /OWNERSHIP_PATCH_MISMATCH/u);
});
test('authorization failure immediately before mutation prevents preview creation', async () => {
  const railway = railwayMock(), authorization = authorize(); let calls = 0;
  await assert.rejects(deployGamingPreview({ authorization, imageReceipt: imageReceipt(authorization), railway,
    revalidate: async () => { if (++calls > 1) throw new Error('authorization drift'); }, now: () => now }));
  assert.deepEqual(railway.state.calls, []);
});
function trackDeploymentMutations(railway) {
  const mutations = [];
  for (const [method, label] of [['createEnvironment', 'create'], ['stageConfig', 'stage'], ['commitConfig', 'commit'],
    ['deployService', (_environmentId, serviceId) => serviceId === target.workerServiceId ? 'worker' : 'web']]) {
    const original = railway[method];
    railway[method] = async (...args) => {
      mutations.push(typeof label === 'function' ? label(...args) : label);
      return original(...args);
    };
  }
  return mutations;
}

const mutationOrder = ['create', 'stage', 'commit', 'worker', 'web'];
for (const boundary of ['revalidate', 'validateAuthority']) {
  // Revalidation also runs while polling worker readiness before the web effect.
  const effectReads = boundary === 'revalidate' ? [2, 3, 4, 5, 7] : [2, 3, 4, 5, 6];
  for (const [index, mutation] of mutationOrder.entries()) {
    test(`expiry during awaited ${boundary} prevents the ${mutation} mutation`, async () => {
      const expiresAt = now + 1000, authorization = authorize({ expiresAt: new Date(expiresAt).toISOString() });
      const railway = railwayMock(), mutations = trackDeploymentMutations(railway);
      let clock = now, reads = 0, crossedExpiry = false, last;
      const advanceAfterRead = async () => {
        await Promise.resolve();
        if (++reads === effectReads[index]) { clock = expiresAt; crossedExpiry = true; }
      };
      if (boundary === 'validateAuthority') railway.validateAuthority = advanceAfterRead;
      await assert.rejects(deployGamingPreview({ authorization, imageReceipt: imageReceipt(authorization), railway,
        revalidate: boundary === 'revalidate' ? advanceAfterRead : async () => {}, now: () => clock,
        onReceipt: value => { last = value; } }), /AUTHORIZATION_EXPIRED/u);
      assert.equal(crossedExpiry, true);
      assert.deepEqual(mutations, mutationOrder.slice(0, index));
      assert.equal(last.cleanup.status, 'VERIFIED');
      assert.equal(railway.state.environments.length, 1);
      assert.equal(railway.state.deleted, index > 0);
    });
  }
}

for (const limit of ['authorization', 'startup']) {
  for (const boundary of ['readEnvironment', 'listEnvironments', 'stagedEmpty']) {
    test(`${limit} expiry during the creation callback's awaited ${boundary} prevents environment creation`, async () => {
      const expiresAt = now + (limit === 'authorization' ? 1000 : 3600_000);
      const authorization = authorize({ expiresAt: new Date(expiresAt).toISOString() });
      const railway = railwayMock(), mutations = trackDeploymentMutations(railway), original = railway[boundary];
      let clock = now, reads = 0, crossedExpiry = false, last;
      railway[boundary] = async (...args) => {
        const result = await original(...args);
        // The first read is preflight; the second is inside the create callback.
        if (++reads === 2) { clock = limit === 'authorization' ? expiresAt : now + 20 * 60_000; crossedExpiry = true; }
        return result;
      };
      await assert.rejects(deployGamingPreview({ authorization, imageReceipt: imageReceipt(authorization), railway,
        revalidate: async () => {}, now: () => clock, onReceipt: value => { last = value; } }),
      limit === 'authorization' ? /AUTHORIZATION_EXPIRED/u : /STARTUP_TIMEOUT/u);
      assert.equal(crossedExpiry, true);
      assert.deepEqual(mutations, []);
      assert.equal(last.cleanup.status, 'VERIFIED');
      assert.equal(last.cleanup.created, false);
      assert.equal(railway.state.deleted, false);
      assert.equal(railway.state.environments.length, 1);
    });
  }
}

for (const limit of ['authorization', 'startup']) {
  for (const boundary of ['readEnvironment', 'stagedEmpty']) {
    test(`${limit} expiry during final awaited ${boundary} cannot publish a verified deployment`, async () => {
      const expiresAt = now + (limit === 'authorization' ? 1000 : 3600_000);
      const authorization = authorize({ expiresAt: new Date(expiresAt).toISOString() }), railway = railwayMock();
      const original = railway[boundary];
      let clock = now, revalidations = 0, finalReads = false, crossedExpiry = false, last;
      railway[boundary] = async (...args) => {
        const result = await original(...args);
        if (finalReads) { clock = limit === 'authorization' ? expiresAt : now + 20 * 60_000; crossedExpiry = true; }
        return result;
      };
      await assert.rejects(deployGamingPreview({ authorization, imageReceipt: imageReceipt(authorization), railway,
        revalidate: async () => { await Promise.resolve(); if (++revalidations === 9) finalReads = true; },
        now: () => clock, onReceipt: value => { last = value; } }),
      limit === 'authorization' ? /AUTHORIZATION_EXPIRED/u : /STARTUP_TIMEOUT/u);
      assert.equal(crossedExpiry, true);
      assert.equal(last.status, 'NOT VERIFIED');
      assert.equal(last.cleanup.status, 'VERIFIED');
      assert.equal(railway.state.deleted, true);
      assert.equal(railway.state.environments.length, 1);
    });
  }
}

test('owned cleanup remains permitted after deployment authorization expires', async () => {
  const expiresAt = now + 1000, authorization = authorize({ expiresAt: new Date(expiresAt).toISOString() });
  const railway = railwayMock();
  const { receipt } = await deployGamingPreview({ authorization, imageReceipt: imageReceipt(authorization), railway,
    revalidate: async () => {}, now: () => now });
  const cleanup = await cleanupGamingPreview({ policy, railway, receipt, now: () => expiresAt });
  assert.equal(cleanup.status, 'VERIFIED');
  assert.equal(railway.state.deleted, true);
  assert.equal(railway.state.environments.length, 1);
});

test('missing list entry and soft-deleted control-plane object are not cleanup proof', async () => {
  const railway = railwayMock(), authorization = authorize();
  const { receipt } = await deployGamingPreview({ authorization, imageReceipt: imageReceipt(authorization), railway,
    revalidate: async () => {}, now: () => now });
  railway.environmentAbsent = async () => false;
  await assert.rejects(cleanupGamingPreview({ policy, railway, receipt, now: () => now }), /DELETE_READBACK_FAILED/u);
  await assert.rejects(cleanupGamingPreview({ policy, railway, receipt, now: () => now }), /DELETE_READBACK_FAILED/u);
});
test('lost or invalid create response, staging, commit, readiness and worker drift failures clean up', async () => {
  for (const failPhase of ['create-lost-response', 'create-invalid-response', 'stage', 'commit', 'readiness', 'worker-drift-during-web']) {
    const railway = railwayMock({ failPhase }), authorization = authorize(); let last;
    await assert.rejects(deployGamingPreview({ authorization, imageReceipt: imageReceipt(authorization), railway,
      revalidate: async () => {}, now: () => now, onReceipt: value => { last = value; } }));
    assert.equal(railway.state.deleted, true, failPhase); assert.equal(last.cleanup.status, 'VERIFIED', failPhase);
    assert.equal(railway.state.environments.length, 1, failPhase);
    assert.equal(last.createIntent.runId, '42');
  }
});
test('readiness enforces total fetch/body deadlines, byte budgets and approved targets', async () => {
  const host = `https://web-${gamingPreviewEnvironmentName('42')}.up.railway.app`;
  const hang = new GamingRailwayApi({ token: 'mock-token', fetchImpl: async () => new Promise(() => {}), readinessTimeoutMs: 5 });
  await assert.rejects(hang.readGamingReadiness(host), /REQUEST_TIMEOUT/u);
  const hangBody = new GamingRailwayApi({ token: 'mock-token', fetchImpl: async () => new Response(new ReadableStream({ start() {} }),
    { headers: { 'cache-control': 'no-store', 'content-type': 'application/json' } }), readinessTimeoutMs: 5 });
  await assert.rejects(hangBody.readGamingReadiness(host), /REQUEST_TIMEOUT/u);
  const tooLarge = new GamingRailwayApi({ token: 'mock-token', fetchImpl: async () => new Response('x'.repeat(65537),
    { headers: { 'cache-control': 'no-store', 'content-type': 'application/json' } }) });
  await assert.rejects(tooLarge.readGamingReadiness(host), /RESPONSE_TOO_LARGE/u);
  for (const url of ['https://api.notion.com', 'https://api.openai.com', `${host}/path`, `${host}?secret=value`, 'http://localhost'])
    await assert.rejects(hang.readGamingReadiness(url), /HOST_SCOPE_INVALID/u);
});
test('post-verification attestation rejects a changed worker and does not strand cleanup', async () => {
  const railway = railwayMock(), authorization = authorize(), built = imageReceipt(authorization);
  const { receipt } = await deployGamingPreview({ authorization, imageReceipt: built, railway,
    revalidate: async () => {}, now: () => now });
  const bytes = JSON.stringify(receipt);
  const args = { authorization, imageReceipt: built, deploymentReceiptBytes: bytes, expectedSha256: hash(bytes), railway, revalidate: async () => {} };
  assert.equal((await attestGamingPreview(args)).status, 'VERIFIED');
  railway.state.environments[1].serviceInstances.edges[0].node.activeDeployments[0].deploymentStopped = true;
  await assert.rejects(attestGamingPreview(args), /IMMUTABLE_DEPLOYMENT_UNPROVEN/u);
  assert.equal((await cleanupGamingPreview({ policy, railway, receipt })).status, 'VERIFIED');
});
test('post-verification attestation rejects expiry during its final awaited revalidation', async () => {
  const expiresAt = now + 1000, authorization = authorize({ expiresAt: new Date(expiresAt).toISOString() });
  const railway = railwayMock(), built = imageReceipt(authorization);
  const { receipt } = await deployGamingPreview({ authorization, imageReceipt: built, railway,
    revalidate: async () => {}, now: () => now });
  const bytes = JSON.stringify(receipt), originalNow = Date.now;
  let clock = now, revalidations = 0;
  try {
    Date.now = () => clock;
    await assert.rejects(attestGamingPreview({ authorization, imageReceipt: built, deploymentReceiptBytes: bytes,
      expectedSha256: hash(bytes), railway,
      revalidate: async () => { await Promise.resolve(); if (++revalidations === 2) clock = expiresAt; } }),
    /AUTHORIZATION_EXPIRED/u);
    assert.equal(revalidations, 2);
  } finally {
    Date.now = originalNow;
  }
  assert.equal((await cleanupGamingPreview({ policy, railway, receipt, now: () => expiresAt })).status, 'VERIFIED');
});

test('owner may retry cleanup only in the original workflow without replaying deployment', () => {
  const env = { GITHUB_REPOSITORY: 'pbjustin/Arcanos', GITHUB_ACTOR: 'pbjustin', EVENT_SENDER: 'pbjustin',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: 'pbjustin/Arcanos/.github/workflows/railway-gaming-preview.yml@refs/heads/main',
    GITHUB_SHA: controllerSha, CONTROLLER_SHA: controllerSha, GITHUB_RUN_ATTEMPT: '1' };
  assertGamingPreviewWorkflowContext('deploy', env); assertGamingPreviewWorkflowContext('cleanup', env);
  const retry = { ...env, GITHUB_RUN_ATTEMPT: '2', GITHUB_TRIGGERING_ACTOR: 'pbjustin' };
  assertGamingPreviewWorkflowContext('cleanup', retry);
  for (const command of ['audit', 'authorize', 'deploy', 'verify', 'attest'])
    assert.throws(() => assertGamingPreviewWorkflowContext(command, retry), /TRUSTED_WORKFLOW_REQUIRED/u);
  for (const patch of [{ GITHUB_TRIGGERING_ACTOR: 'other' }, { GITHUB_ACTOR: 'other' }, { EVENT_SENDER: 'other' },
    { GITHUB_RUN_ATTEMPT: '0' }, { GITHUB_REF: 'refs/heads/other' }, { GITHUB_SHA: 'b'.repeat(40) }])
    assert.throws(() => assertGamingPreviewWorkflowContext('cleanup', { ...retry, ...patch }), /TRUSTED_WORKFLOW_REQUIRED/u);
});
test('cleanup CLI missing ownership receipt reports BLOCKED before any Railway API request', () => {
  const folder = mkdtempSync(join(tmpdir(), 'gaming-preview-cleanup-test-'));
  const authorization = join(folder, 'authorization.json'), output = join(folder, 'cleanup.json');
  try {
    writeFileSync(authorization, JSON.stringify(raw()));
    const result = spawnSync(process.execPath, ['scripts/railway-gaming-preview.mjs', 'cleanup', '--authorization', authorization,
      '--deployment', join(folder, 'missing.json'), '--output', output], { encoding: 'utf8', timeout: 5000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GITHUB_REPOSITORY: 'pbjustin/Arcanos',
        GITHUB_ACTOR: 'pbjustin', GITHUB_TRIGGERING_ACTOR: 'pbjustin', EVENT_SENDER: 'pbjustin',
        GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
        GITHUB_WORKFLOW_REF: 'pbjustin/Arcanos/.github/workflows/railway-gaming-preview.yml@refs/heads/main',
        GITHUB_SHA: controllerSha, CONTROLLER_SHA: controllerSha, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2',
        RAILWAY_API_TOKEN: 'mock-token-no-real-authority' } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /GAMING_PREVIEW_CLEANUP_OWNERSHIP_RECEIPT_UNAVAILABLE/u);
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).status, 'BLOCKED');
  } finally {
    assert.equal(resolve(dirname(folder)), resolve(tmpdir()));
    assert.equal(folder.startsWith(join(tmpdir(), 'gaming-preview-cleanup-test-')), true);
    rmSync(folder, { recursive: true });
  }
});
test('independent project inventory rejects tombstones, incomplete results and uncertain ownership', async () => {
  let rows = [{ id: id('6'), name: gamingPreviewEnvironmentName('42'), projectId: target.projectId, deletedAt: new Date().toISOString() }];
  let complete = true, projectId = target.projectId;
  const railway = new GamingRailwayApi({ token: 'mock-token', fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.match(body.query, /project\(id:\$projectId\)/u);
    const environments = connection(rows); environments.pageInfo.hasNextPage = !complete;
    return new Response(JSON.stringify({ data: { project: { id: projectId, workspaceId: target.workspaceId, environments } } }),
      { headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(await railway.environmentAbsent(target, id('6'), gamingPreviewEnvironmentName('42')), false);
  rows = []; assert.equal(await railway.environmentAbsent(target, id('6'), gamingPreviewEnvironmentName('42')), true);
  complete = false; await assert.rejects(railway.environmentAbsent(target, id('6'), gamingPreviewEnvironmentName('42')), /INCOMPLETE_INVENTORY/u);
  complete = true; projectId = id('0');
  await assert.rejects(railway.environmentAbsent(target, id('6'), gamingPreviewEnvironmentName('42')), /ABSENCE_PROJECT_MISMATCH/u);
});
test('Gaming CI requires successful official docs context without duplicating GitHub requests', async () => {
  const officialApp = { id: 15368, slug: 'github-actions', owner: { login: 'github' } };
  const check = (name, id, app = officialApp, conclusion = 'success') => ({ id, name, app, head_sha: policy.headSha,
    status: 'completed', conclusion, details_url: `https://github.com/pbjustin/Arcanos/actions/runs/1/job/${id}` });
  const aggregate = check('All Checks Complete', 1), docs = check('docs:check', 2);
  for (const [checks, accepted] of [
    [[aggregate, docs], true], [[aggregate], false],
    [[aggregate, check('docs:check', 2, { ...officialApp, id: 999 })], false],
    [[aggregate, check('docs:check', 2, officialApp, 'failure')], false],
    [[aggregate, check('docs:check', 2, officialApp, 'skipped')], false],
  ]) {
    let requests = 0, effects = 0;
    const github = new GamingGitHubReadAdapter({ token: 'mock-github-read-token-no-authority', fetchImpl: async (url, options) => {
      requests += 1;
      assert.equal(url, `https://api.github.com/repos/pbjustin/Arcanos/commits/${policy.headSha}/check-runs?per_page=100&page=1&filter=all`);
      assert.equal(options.method, 'GET');
      return new Response(JSON.stringify({ total_count: checks.length, check_runs: checks }), { headers: { 'content-type': 'application/json' } });
    } });
    const admittedEffect = async () => { await github.readRequiredCI(policy.headSha); effects += 1; };
    if (accepted) await admittedEffect(); else await assert.rejects(admittedEffect());
    assert.equal(effects, accepted ? 1 : 0); assert.equal(requests, 1);
  }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SELF_HEAL_ACCEPTANCE_CASES, SelfHealAcceptanceError, attestSelfHealAcceptanceStatus, createSelfHealAcceptanceTransport,
  attestSelfHealShutdownReceipt, attestSelfHealStartupFailureReceipt, publishSelfHealAcceptanceReceipt,
  runSelfHealAcceptanceCase, validateSelfHealAcceptanceManifest } from './self-heal-preview-acceptance.mjs';

const NOW = Date.parse('2026-10-15T01:00:00.000Z');
const id = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const names = { web: 'arcanos-web-pr1544-heavy', worker: 'arcanos-worker-pr1544-heavy', postgres: 'Postgres', redis: 'Redis' };
function manifest() {
  const services = Object.keys(names).map((role, i) => ({ role, serviceId: id(i + 3), deploymentId: id(i + 7),
    imageDigest: `sha256:${'d'.repeat(64)}`, compiledSha256: ['web', 'worker'].includes(role) ? 'c'.repeat(64) : null }));
  return { version: 1, budgetUsd: 3, controllerSha: 'b'.repeat(40), cleanupArmedUntil: '2026-10-15T03:00:00.000Z', services,
    receipt: { version: 1, owner: 'pbjustin', repository: 'pbjustin/Arcanos', prNumber: 1544, sourceSha: 'a'.repeat(40),
      runId: 'self-heal-run-1544', projectId: id(1), projectName: 'arc-pr1544-heavy-test',
      workspaceId: '1c9265a3-986f-4304-ad3e-5a874caab039', environmentId: id(2), environmentName: 'backstage-heavy-pr-1544-e2e',
      issuedAt: new Date(NOW).toISOString(), expiresAt: '2026-10-15T03:00:00.000Z',
      resources: { services: services.map(service => ({ id: service.serviceId, name: names[service.role] })), volumes: [
        { id: id(11), name: 'pg-test', serviceId: id(5), mountPath: '/var/lib/postgresql/data' },
        { id: id(12), name: 'redis-test', serviceId: id(6), mountPath: '/data' },
      ] } } };
}
const connection = nodes => ({ edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage: false } });
function status(m = manifest()) {
  return { id: m.receipt.projectId, name: m.receipt.projectName, workspaceId: m.receipt.workspaceId, deletedAt: null,
    services: connection(m.receipt.resources.services), environments: connection([{ id: m.receipt.environmentId,
      name: m.receipt.environmentName, deletedAt: null, volumeInstances: connection(m.receipt.resources.volumes.map(volume => ({
        volumeId: volume.id, serviceId: volume.serviceId, mountPath: volume.mountPath,
      }))), serviceInstances: connection(m.services.map((service, i) => {
        const deployment = { id: service.deploymentId, status: 'SUCCESS', deploymentStopped: false, instances: [{ id: id(20 + i), status: 'RUNNING' }],
          meta: { commitHash: m.receipt.sourceSha, imageDigest: service.imageDigest, serviceManifest: { deploy: { numReplicas: 1, healthcheckPath: '/readyz', restartPolicyType: 'NEVER',
            limitOverride: { containers: [{ cpu: 1, memoryBytes: 1073741824 }, { cpu: 1, memoryBytes: 2147483648 },
              { cpu: 0.5, memoryBytes: 536870912 }, { cpu: 0.25, memoryBytes: 268435456 }][i] },
            startCommand: 'node scripts/railway-backstage-heavy-proof-supervisor.mjs --self-heal-preview-v1' } } } };
        return { serviceId: service.serviceId, serviceName: names[service.role], latestDeployment: deployment, activeDeployments: [structuredClone(deployment)],
          domains: { serviceDomains: [], customDomains: [] }, tcpProxies: [] };
      })) }]) };
}
function snapshot(patch = {}) {
  return { ready: true, processInstanceId: id(30), coordinator: { loopRunning: true, processKind: 'worker', coordinatorState: 'RUNNING',
    inFlight: false, lastActionAt: null, tickCount: 2 }, scheduler: { installations: 1, installationAttempts: 1, installationFailures: 0 },
    runtime: { nodeVersion: '24.18.1' }, policy: { selfImproveEnabled: false }, observation: { holding: false, injectedFailures: 0 },
    claimBoundary: { injectedFailures: 0 }, claimFailurePending: false, tickPending: false, trinity: { snapshot: { final: { activeAction: null } } }, ...patch };
}
function fakeTransport(state = snapshot()) {
  const calls = [];
  return { calls, remote: async (role, args) => {
    calls.push([role, args]);
    if (args[0] === 'artifact') return { artifact: { compiledSha256: 'c'.repeat(64) } };
    if (args[0] === 'fenced-job') return { fencedJob: { job: { completionVerified: true, literalObserved: true,
      matchingClaimEvents: 1, matchingCompletionEvents: 1 } } };
    return { observation: state };
  }, restart: async role => { calls.push(['restart', role]); return { restartRequested: true }; } };
}

test('matrix has exactly the32ownedcaseidentities', () => {
  assert.equal(SELF_HEAL_ACCEPTANCE_CASES.length, 32); assert.equal(new Set(SELF_HEAL_ACCEPTANCE_CASES).size, 32);
});
test('dryrunneveropensCLI,SSH,providerorjobtransports', async () => {
  let calls = 0;
  const result = await runSelfHealAcceptanceCase('A01', manifest(), { now: () => NOW, transport: { remote: () => { calls += 1; } } });
  assert.equal(result.classification, 'NOT_RUN'); assert.equal(result.executed, false); assert.equal(calls, 0);
});
for (const [name, mutate] of Object.entries({
  productionProject: value => { value.receipt.projectId = '7faf44e5-519c-4e73-8d7a-da9f389e6187'; },
  extraPaidService: value => { value.services.push(value.services[0]); },
  budgetIncrease: value => { value.budgetUsd = 4; },
  leaseRenewal: value => { value.receipt.expiresAt = '2026-10-15T03:00:00.001Z'; },
  noCleanup: value => { value.cleanupArmedUntil = '2026-10-15T02:00:00.000Z'; },
  secretInput: value => { value.token = 'test-sensitive-marker'; },
  missingArtifact: value => { value.services[0].compiledSha256 = null; },
  mutableImage: value => { value.services[0].imageDigest = 'latest'; },
  wrongRoleBinding: value => { value.services[0].serviceId = value.services[1].serviceId; },
})) test(`manifestrejects${name}beforeanyeffects`, () => {
  const value = manifest(); mutate(value); assert.throws(() => validateSelfHealAcceptanceManifest(value, { now: () => NOW }), /SELF_HEAL_/u);
});
test('expiredmanifestcannotstartorrenewthepaidrun', () => {
  assert.throws(() => validateSelfHealAcceptanceManifest(manifest(), { now: () => NOW + 7_200_000 }), /LEASE_INVALID/u);
});
test('completeownedsole-instanceinventoryproducesexactSSHtargets', () => {
  const targets = attestSelfHealAcceptanceStatus(status(), manifest(), { now: () => NOW });
  assert.equal(targets.worker.instanceId, id(21)); assert.equal(targets.redis.deploymentId, id(10));
});
for (const [name, mutate] of Object.entries({
  incompletePage: value => { value.services.pageInfo.hasNextPage = true; },
  foreignService: value => { value.services.edges[0].node.id = id(100); },
  extraEnvironment: value => { value.environments.edges.push(value.environments.edges[0]); },
  wrongVolume: value => { value.environments.edges[0].node.volumeInstances.edges[0].node.serviceId = id(3); },
  secondWorker: value => { const item = value.environments.edges[0].node.serviceInstances.edges[1].node; item.activeDeployments.push(item.latestDeployment); },
  secondInstance: value => { const dep = value.environments.edges[0].node.serviceInstances.edges[1].node.latestDeployment; dep.instances.push({ id: id(90), status: 'RUNNING' }); },
  sourceDrift: value => { value.environments.edges[0].node.serviceInstances.edges[1].node.latestDeployment.meta.commitHash = 'b'.repeat(40); },
  wrongEntrypoint: value => { value.environments.edges[0].node.serviceInstances.edges[1].node.latestDeployment.meta.serviceManifest.deploy.startCommand = 'node arbitrary.mjs'; },
  publicRedis: value => { value.environments.edges[0].node.serviceInstances.edges[3].node.tcpProxies.push({ id: id(91) }); },
  largerCpu: value => { value.environments.edges[0].node.serviceInstances.edges[1].node.latestDeployment.meta.serviceManifest.deploy.limitOverride.containers.cpu = 2; },
  largerRam: value => { value.environments.edges[0].node.serviceInstances.edges[1].node.latestDeployment.meta.serviceManifest.deploy.limitOverride.containers.memoryBytes = 4294967296; },
  latestImageDrift: value => { value.environments.edges[0].node.serviceInstances.edges[1].node.latestDeployment.meta.imageDigest = `sha256:${'e'.repeat(64)}`; },
  activeImageDrift: value => { value.environments.edges[0].node.serviceInstances.edges[1].node.activeDeployments[0].meta.imageDigest = `sha256:${'e'.repeat(64)}`; },
})) test(`inventoryrejects${name}`, () => {
  const value = status(); mutate(value); assert.throws(() => attestSelfHealAcceptanceStatus(value, manifest(), { now: () => NOW }), /SELF_HEAL_ACCEPTANCE_/u);
});

test('replacing a manifest image pin cannot pass unchanged independent deployment metadata', () => {
  const original = manifest(); const changed = structuredClone(original);
  changed.services[1].imageDigest = `sha256:${'e'.repeat(64)}`;
  assert.throws(() => attestSelfHealAcceptanceStatus(status(original), changed, { now: () => NOW }), /IMAGE_DRIFT/u);
});
test('headchangeblocksallSSHandrestartoperations', async () => {
  let calls = 0;
  const transport = createSelfHealAcceptanceTransport(manifest(), { now: () => NOW, execute: true, allowNetwork: true,
    readHead: async () => 'f'.repeat(40), command: async () => { calls += 1; } });
  await assert.rejects(transport.remote('worker', ['command', 'tick']), /PR_HEAD_CHANGED/u);
  await assert.rejects(transport.restart('redis'), /PR_HEAD_CHANGED/u); assert.equal(calls, 0);
});
test('arbitrarySQL,shell,URL,synthetic-successandproductionrestartareinexpressible', async () => {
  let calls = 0;
  const transport = createSelfHealAcceptanceTransport(manifest(), { now: () => NOW, execute: true, allowNetwork: true,
    readHead: async () => 'a'.repeat(40), command: async () => { calls += 1; } });
  for (const args of [['command', 'trinity_fresh_success'], ['shell', 'rm'], ['command', 'https://example.invalid'], ['fenced-job', 'create', 'E02', '3'],
    ['env', '-u', 'ARCANOS_SELF_HEAL_PREVIEW_PROFILE', 'inspect'], ['inspect', 'RAILWAY_API_TOKEN=fixture-token'],
    ['inspect', 'GH_TOKEN=fixture-token']]) {
    await assert.rejects(transport.remote('worker', args), /OPERATION_INVALID/u);
  }
  await assert.rejects(transport.restart('postgres'), /RESTART_TARGET_INVALID/u); assert.equal(calls, 0);
});
test('partialnetworkauthorizationhaszeroeffects', () => {
  for (const value of [{ execute: true }, { allowNetwork: true }]) assert.throws(() => createSelfHealAcceptanceTransport(manifest(), { now: () => NOW, ...value }), /NETWORK_GATES_REQUIRED/u);
});
test('cleanupreserveblocksnewfaultsinsteadofextendinglease', async () => {
  let calls = 0;
  const transport = createSelfHealAcceptanceTransport(manifest(), { now: () => NOW + 110 * 60_000, execute: true, allowNetwork: true,
    readHead: async () => { calls += 1; return 'a'.repeat(40); } });
  await assert.rejects(transport.restart('worker'), /CLEANUP_RESERVE_REACHED/u); assert.equal(calls, 0);
});
test('synthetictransportpassesarealwaysclassifiedsynthetic-only', async () => {
  const transport = fakeTransport();
  const result = await runSelfHealAcceptanceCase('A01', manifest(), { now: () => NOW, execute: true, allowNetwork: true,
    syntheticTransport: true, transport });
  assert.equal(result.classification, 'SYNTHETIC_ONLY'); assert.equal(result.cleanupResult, 'SYNTHETIC_ONLY');
  assert.equal(result.realExternalProviderRecoveryProven, false); assert(transport.calls.some(call => call[1]?.[0] === 'fenced-job'));
});
test('healthylogwithoutactualschedulerorjobeffectcannotpass', async () => {
  const transport = fakeTransport(snapshot({ scheduler: { installations: 0 } }));
  const result = await runSelfHealAcceptanceCase('A01', manifest(), { now: () => NOW, execute: true, allowNetwork: true, syntheticTransport: true, transport });
  assert.equal(result.classification, 'FAILED'); assert.equal(result.errorCode, 'SELF_HEAL_ACCEPTANCE_BOOTSTRAP_NOT_PROVEN');
});
test('lostrestorationblocksacceptanceandpreservesoriginalfailure', async () => {
  const transport = fakeTransport(); const original = transport.remote;
  transport.remote = async (role, args) => { if (args[1] === 'policy_restore') throw new Error('secret-transport-marker'); return original(role, args); };
  const result = await runSelfHealAcceptanceCase('A01', manifest(), { now: () => NOW, execute: true, allowNetwork: true, syntheticTransport: true, transport });
  assert.equal(result.classification, 'BLOCKED'); assert.equal(result.cleanupResult, 'FAILED'); assert(!JSON.stringify(result).includes('secret-transport-marker'));
});

test('long-case final receipt references durable events without repeating their large bodies', async () => {
  const published = []; let final;
  const result = await runSelfHealAcceptanceCase('A01', manifest(), {
    now: () => NOW, execute: true, allowNetwork: true,
    transport: fakeTransport(snapshot({ diagnosticPadding: 'x'.repeat(350_000) })),
    onReceipt: event => { published.push(event); }, onResult: value => { final = value; },
  });
  assert.equal(result.classification, 'SYNTHETIC_ONLY'); assert.equal(final.cleanupResult, 'SYNTHETIC_ONLY');
  assert(published.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0) > 2 * 1024 * 1024);
  assert(Buffer.byteLength(JSON.stringify(final)) < 2 * 1024 * 1024);
  assert.equal(final.eventCount, published.length); assert.equal(final.eventReceipts.length, published.length);
  assert.equal(Object.hasOwn(final, 'events'), false);
  final.eventReceipts.forEach((reference, index) => {
    assert.equal(reference.receiptSha256, createHash('sha256').update(JSON.stringify(published[index])).digest('hex'));
    assert.equal(reference.sequence, published[index].sequence);
  });
});
test('compact receipt admission preserves nested baseline, all restorations and the durable final result', async () => {
  const state = snapshot({ diagnostics: Array.from({ length: 25_000 }, () => ({ nested: { value: 'synthetic' } })) });
  const shape = { scenario: 'A01', sequence: 1, observedAt: new Date(NOW).toISOString(), kind: 'restoration',
    value: { args: ['command', 'policy_restore'], receipt: { observation: state } } };
  const limit = 2 * 1024 * 1024;
  assert(Buffer.byteLength(JSON.stringify(shape)) < limit);
  assert(Buffer.byteLength(JSON.stringify(shape, null, 2)) > limit);
  const directory = mkdtempSync(join(tmpdir(), 'arcanos-acceptance-compact-')); const paths = [];
  const publish = receipt => { paths.push(publishSelfHealAcceptanceReceipt(directory, paths.length + 1, receipt)); };
  try {
    const result = await runSelfHealAcceptanceCase('A01', manifest(), {
      now: () => NOW, execute: true, allowNetwork: true, transport: fakeTransport(state),
      onReceipt: publish, onResult: publish,
    });
    assert.equal(result.classification, 'SYNTHETIC_ONLY');
    assert.equal(result.cleanupResult, 'SYNTHETIC_ONLY');
    const receipts = paths.map(path => {
      const text = readFileSync(path, 'utf8'); const receipt = JSON.parse(text);
      assert(Buffer.byteLength(text) <= limit);
      assert.equal(text, `${JSON.stringify(receipt)}\n`);
      const { receiptSha256, ...body } = receipt;
      assert.equal(receiptSha256, createHash('sha256').update(JSON.stringify(body)).digest('hex'));
      return body;
    });
    assert.equal(receipts.filter(receipt => receipt.kind === 'baseline').length, 1);
    assert.equal(receipts.filter(receipt => receipt.kind === 'restoration').length, 6);
    assert.deepEqual(receipts.at(-1), JSON.parse(JSON.stringify(result)));
  } finally {
    for (const path of paths) unlinkSync(path);
    rmdirSync(directory);
  }
});

test('durablereceiptsareexclusiveandcannotoverwritefailureevidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'arcanos-acceptance-')); let path;
  try {
    path = publishSelfHealAcceptanceReceipt(directory, 1, { scenario: 'E02', classification: 'FAILED' });
    const value = JSON.parse(readFileSync(path)); assert.equal(value.classification, 'FAILED'); assert.match(value.receiptSha256, /^[a-f0-9]{64}$/u);
    assert.throws(() => publishSelfHealAcceptanceReceipt(directory, 1, { scenario: 'E02', classification: 'VERIFIED' }), /EEXIST/u);
  } finally { if (path) unlinkSync(path); rmdirSync(directory); }
});

test('an injected transport remains synthetic when its caller omits the synthetic flag', async () => {
  const result = await runSelfHealAcceptanceCase('A01', manifest(), {
    now: () => NOW, execute: true, allowNetwork: true, transport: fakeTransport(),
  });
  assert.equal(result.classification, 'SYNTHETIC_ONLY');
  assert.equal(result.cleanupResult, 'SYNTHETIC_ONLY');
});

function cliFixture() {
  const m = manifest(); const current = { clock: NOW, head: m.receipt.sourceSha, status: status(m), calls: [] };
  const options = { execute: true, allowNetwork: true, now: () => current.clock,
    readHead: async () => current.head, invocation: { executable: 'fixture-only-no-process', argsPrefix: [] },
    command: async (_executable, args) => {
      current.calls.push(args);
      if (args[0] === 'api') return { stdout: JSON.stringify({ data: { project: current.status,
        workerTcpProxies: [], postgresTcpProxies: [], redisTcpProxies: [] } }) };
      if (args[0] === 'restart') return { stdout: JSON.stringify({ restarted: true }) };
      assert.equal(args[0], 'ssh');
      const pin = m.services.find(value => value.serviceId === args[args.indexOf('--service') + 1]);
      return { stdout: JSON.stringify({ target: { role: pin.role, sourceSha: m.receipt.sourceSha, runId: m.receipt.runId,
        projectId: m.receipt.projectId, environmentId: m.receipt.environmentId,
        serviceId: pin.serviceId, deploymentId: pin.deploymentId }, observation: snapshot() }) };
    } };
  return { current, options, transport: createSelfHealAcceptanceTransport(m, options) };
}

test('remote receipts cannot overwrite the independently attested platform target', async () => {
  const { current, options, transport } = cliFixture(); const command = options.command;
  options.command = async (...args) => {
    const result = await command(...args);
    if (args[1][0] !== 'ssh') return result;
    return { stdout: JSON.stringify({ ...JSON.parse(result.stdout), platformTarget: {
      serviceId: id(99), deploymentId: id(98), instanceId: id(97),
    } }) };
  };
  const expected = attestSelfHealAcceptanceStatus(current.status, manifest(), { now: () => NOW });
  for (const role of ['worker', 'web']) {
    const receipt = await transport.remote(role, ['inspect']);
    assert.deepEqual(receipt.platformTarget, expected[role]);
  }
  const restored = await transport.restore(['command', 'policy_restore']);
  assert.deepEqual(restored.platformTarget, expected.worker);
});

test('Worker, Web and restoration SSH commands discard only fixed session context before the control client', async () => {
  const { current, transport } = cliFixture();
  await transport.remote('worker', ['inspect']);
  await transport.remote('web', ['inspect']);
  await transport.restore(['command', 'policy_restore']);
  const calls = current.calls.filter(args => args[0] === 'ssh');
  assert.equal(calls.length, 3);
  for (const [index, args] of calls.entries()) {
    assert.deepEqual(args.slice(args.indexOf('--') + 1), [
      'env', '-u', 'RAILWAY_API_TOKEN', '-u', 'RAILWAY_ENV', '-u', 'GH_TOKEN', 'node', 'scripts/self-heal-preview-control.mjs',
      ...(index === 2 ? ['command', 'policy_restore'] : ['inspect']),
    ]);
    assert.equal(args[args.indexOf('--service') + 1], id(index === 1 ? 3 : 4));
    assert.equal(args[args.indexOf('--deployment-instance') + 1], id(index === 1 ? 20 : 21));
  }
});

function diagnosticCliFixture(diagnostic) {
  const fixture = cliFixture(); const original = fixture.options.command;
  fixture.options.command = async (...args) => {
    const result = await original(...args);
    if (args[1][0] !== 'ssh') return result;
    const receipt = JSON.parse(result.stdout);
    receipt.observation.diagnostic = diagnostic;
    return { stdout: JSON.stringify(receipt) };
  };
  return fixture;
}

test('receipt size includes hash and newline at the exact UTF-8 publication boundary', async () => {
  const diagnostic = { padding: '' }; const { transport } = diagnosticCliFixture(diagnostic);
  const empty = await transport.remote('worker', ['inspect']);
  const limit = 2 * 1024 * 1024;
  const remaining = limit - Buffer.byteLength(`${JSON.stringify({ ...empty, receiptSha256: '0'.repeat(64) })}\n`);
  diagnostic.padding = 'é'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2);
  const directory = mkdtempSync(join(tmpdir(), 'arcanos-acceptance-boundary-')); let path;
  try {
    const admitted = await transport.remote('worker', ['inspect']);
    path = publishSelfHealAcceptanceReceipt(directory, 1, admitted);
    const saved = readFileSync(path, 'utf8');
    assert.equal(Buffer.byteLength(saved), limit);
    assert.equal(JSON.parse(saved).receiptSha256, createHash('sha256').update(JSON.stringify(admitted)).digest('hex'));
    diagnostic.padding += 'x';
    await assert.rejects(transport.remote('worker', ['inspect']), /UNSAFE_DIAGNOSTIC/u);
    assert.throws(() => publishSelfHealAcceptanceReceipt(directory, 2, {
      ...admitted, observation: { ...admitted.observation, diagnostic },
    }), /EVIDENCE_TOO_LARGE/u);
    assert.throws(() => readFileSync(join(directory, '00002-run.json')), /ENOENT/u);
  } finally { if (path) unlinkSync(path); rmdirSync(directory); }
});

for (const [name, diagnostic] of Object.entries({
  redis: 'redis://fixture-user:fixture-secret@example.invalid:6379',
  tlsRedis: 'rediss://fixture-user:fixture-secret@example.invalid:6379',
  tlsRedisWithoutCredentials: 'ReDiSs://example.invalid:6379',
  mongoSrv: 'mongodb+srv://fixture-user:fixture-secret@example.invalid/database',
  httpsUserInfo: 'https://fixture-user:fixture-secret@example.invalid/path',
  customScheme: 'Example+v1.2-test://fixture-user:fixture-secret@example.invalid/path',
  emptyPassword: 'https://fixture-user:@example.invalid/path',
  emptyUsername: 'https://:fixture-secret@example.invalid/path',
  tokenUserInfo: 'https://fixture-secret@example.invalid/path',
  encodedUserInfo: 'https://fixture%40user:fixture%3Asecret@example.invalid/path',
  postgres: 'postgres://fixture-user:fixture-secret@example.invalid/database',
  postgresql: 'postgresql://fixture-user:fixture-secret@example.invalid/database',
  bearer: 'Bearer fixture-secret',
  privateKey: '-----BEGIN PRIVATE KEY----- fixture-secret',
  projectKey: 'sk-proj-fixture-secret',
})) test(`diagnostic safety rejects ${name} before returning a remote receipt`, async () => {
  const { current, transport } = diagnosticCliFixture({ nested: [diagnostic] });
  await assert.rejects(transport.remote('worker', ['inspect']), error => {
    assert.equal(error.message, 'SELF_HEAL_ACCEPTANCE_UNSAFE_DIAGNOSTIC');
    assert.equal(error.classification, 'BLOCKED');
    assert(!String(error).includes(diagnostic));
    return true;
  });
  assert.deepEqual(current.calls.map(args => args[0]), ['api', 'ssh']);
});

for (const diagnostic of [
  'https://example.invalid:443/path?attempt=1',
  'mongodb+srv://example.invalid/database',
  'https://example.invalid/path/fixture-user:fixture-value@example.invalid',
  'https://example.invalid?contact=fixture-user:fixture-value@example.invalid',
  'https://example.invalid#fixture-user:fixture-value@example.invalid',
]) test(`diagnostic safety preserves credential-free URI ${diagnostic}`, async () => {
  const { transport } = diagnosticCliFixture({ nested: [diagnostic] });
  const receipt = await transport.remote('worker', ['inspect']);
  assert.deepEqual(receipt.observation.diagnostic, { nested: [diagnostic] });
});

test('diagnostic safety never publishes a rejected TLS Redis credential in durable case evidence', async () => {
  const secretMarker = 'fixture-secret-durable-rejection';
  const { transport } = diagnosticCliFixture(`rediss://fixture-user:${secretMarker}@example.invalid:6379`);
  const directory = mkdtempSync(join(tmpdir(), 'arcanos-acceptance-redaction-')); const paths = [];
  const publish = receipt => { paths.push(publishSelfHealAcceptanceReceipt(directory, paths.length + 1, receipt)); };
  try {
    const result = await runSelfHealAcceptanceCase('A01', manifest(), {
      now: () => NOW, execute: true, allowNetwork: true, transport, onReceipt: publish, onResult: publish,
    });
    for (const path of paths) assert(!readFileSync(path, 'utf8').includes(secretMarker), 'credential-containing receipt reached durable evidence');
    assert.equal(result.classification, 'BLOCKED');
    assert.equal(result.errorCode, 'SELF_HEAL_ACCEPTANCE_UNSAFE_DIAGNOSTIC');
    assert.equal(result.cleanupResult, 'FAILED');
    assert.equal(paths.length, 2);
    assert(!JSON.stringify(result).includes(secretMarker));
  } finally {
    for (const path of paths) unlinkSync(path);
    rmdirSync(directory);
  }
});

test('held shutdown is one exact Worker operation and cannot target other scenarios or bypass a changed head', async () => {
  const { current, transport } = cliFixture();
  await assert.rejects(transport.shutdownHeld('A01'), /SHUTDOWN_SCENARIO_INVALID/u);
  assert.equal(current.calls.length, 0);
  current.head = 'f'.repeat(40);
  await assert.rejects(transport.shutdownHeld('A06'), /PR_HEAD_CHANGED/u);
  assert.equal(current.calls.length, 0);
  current.head = manifest().receipt.sourceSha;
  const result = await transport.shutdownHeld('A06');
  assert.equal(result.effectEvidence, 'independent_shutdown_receipt_required');
  const calls = current.calls.filter(args => args[0] === 'ssh');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(calls[0].indexOf('--') + 1), [
    'env', '-u', 'RAILWAY_API_TOKEN', '-u', 'RAILWAY_ENV', '-u', 'GH_TOKEN', 'node', 'scripts/self-heal-preview-control.mjs', 'shutdown-held', 'A06',
  ]);
  assert.equal(calls[0][calls[0].indexOf('--service') + 1], id(4));
  assert.equal(calls[0][calls[0].indexOf('--deployment-instance') + 1], id(21));
  await assert.rejects(transport.shutdownHeld('E06'), /SHUTDOWN_BUDGET_EXHAUSTED/u);
  assert.equal(current.calls.filter(args => args[0] === 'ssh').length, 1);
});

test('Web-side shutdown receipt tolerates only the owned Worker disappearance and retains source and lease fences', async () => {
  const { current, transport } = cliFixture(); await transport.shutdownHeld('E06');
  const worker = current.status.environments.edges[0].node.serviceInstances.edges[1].node;
  worker.latestDeployment.instances = []; worker.latestDeployment.status = 'REMOVED'; worker.activeDeployments = [];
  await transport.remote('web', ['shutdown-receipt', 'E06']);
  await assert.rejects(transport.remote('worker', ['shutdown-receipt', 'E06']), /OPERATION_INVALID/u);
  await assert.rejects(transport.remote('web', ['shutdown-held', 'E06']), /OPERATION_INVALID/u);
  worker.latestDeployment.meta.commitHash = 'f'.repeat(40);
  await assert.rejects(transport.remote('web', ['shutdown-receipt', 'E06']), /SOURCE_OR_LAUNCH_DRIFT/u);
  worker.latestDeployment.meta.commitHash = manifest().receipt.sourceSha; current.clock += 120_001;
  await assert.rejects(transport.remote('web', ['shutdown-receipt', 'E06']), /DEPLOYMENT_DRIFT/u);
});

test('shutdown SSH termination cannot consume the entire independent readback transition window', async () => {
  const { current, options, transport } = cliFixture(); const original = options.command;
  options.command = async (executable, args, execOptions) => {
    if (args[0] === 'ssh' && args.includes('shutdown-held')) {
      assert.equal(execOptions.timeout, 30_000); current.clock += execOptions.timeout;
      throw new Error('fixture pod connection ended');
    }
    return original(executable, args, execOptions);
  };
  assert.equal((await transport.shutdownHeld('A06')).transportClosed, true);
  const worker = current.status.environments.edges[0].node.serviceInstances.edges[1].node;
  worker.latestDeployment.instances = []; worker.latestDeployment.status = 'REMOVED'; worker.activeDeployments = [];
  await transport.remote('web', ['shutdown-receipt', 'A06']);
  assert.equal(current.clock - NOW, 30_000);
  assert.equal(current.calls.filter(args => args.includes('shutdown-receipt')).length, 1);
});

function shutdownEvidence() {
  const m = manifest(); const baseline = snapshot({ pid: 1234 });
  const recovered = snapshot({ processInstanceId: id(31), pid: 1234 });
  const before = { worker: { instanceId: id(21) } }; const after = { worker: { instanceId: id(22) } };
  const phases = [
    ['prepared', { redisClientId: '91' }], ['evaluation_held', { inFlight: true }], ['shutdown_seen', { signalSeen: true }],
    ['independent_held_probe', { processAlive: true, redisClientPresent: true, providerHealthy: true, drainAbsent: true,
      readinessWithheld: true, redisServerRunId: '1'.repeat(40) }],
    ['independent_barrier_releasing', {}], ['barrier_released', { signalSeen: true, elapsedMs: 100 }],
    ['coordinator_drained', { inFlight: false, redisConnected: true }], ['redis_stop_begin', {}],
    ['redis_stopped', { inFlight: false, redisConnected: false }],
    ['independent_redis_closed', { redisClientPresent: false, redisServerRunId: '1'.repeat(40) }],
  ];
  const value = { evidence: 'independent_postgres_readback', receipt: { scenario: 'A06', sourceSha: m.receipt.sourceSha,
    processInstanceId: baseline.processInstanceId, deploymentId: m.services[1].deploymentId, pid: baseline.pid, redisClientId: '91',
    events: phases.map(([phase, data], i) => ({ phase, data, at: new Date(NOW + i + 1).toISOString() })) } };
  return { m, baseline, recovered, before, after, value };
}

test('shutdown acceptance correlates a held evaluation, independent clients, actual drain order and a replacement instance', () => {
  const f = shutdownEvidence();
  const result = attestSelfHealShutdownReceipt(f.value, 'A06', f.baseline, f.recovered, f.m, f.before, f.after);
  assert.equal(result.activeEvaluationDrained, true); assert.equal(result.redisClosureIndependentlyObserved, true);
  assert.equal(result.oldProcessInstanceId, f.baseline.processInstanceId); assert.notEqual(result.oldInstanceId, result.newInstanceId);
});
for (const [name, change] of Object.entries({
  staleProcess: f => { f.value.receipt.processInstanceId = id(99); },
  stalePid: f => { f.value.receipt.pid += 1; },
  staleDeployment: f => { f.value.receipt.deploymentId = id(99); },
  staleSource: f => { f.value.receipt.sourceSha = 'f'.repeat(40); },
  logOnly: f => { f.value.evidence = 'shutdown_log'; },
  missingIndependentProbe: f => { f.value.receipt.events.splice(3, 1); },
  outOfOrder: f => { [f.value.receipt.events[6], f.value.receipt.events[8]] = [f.value.receipt.events[8], f.value.receipt.events[6]]; },
  disconnectedDuringEvaluation: f => { f.value.receipt.events[3].data.redisClientPresent = false; },
  providerClosedEarly: f => { f.value.receipt.events[3].data.providerHealthy = false; },
  prematureReadiness: f => { f.value.receipt.events[3].data.readinessWithheld = false; },
  evaluationStillRunning: f => { f.value.receipt.events[6].data.inFlight = true; },
  dependencyClosedBeforeDrain: f => { f.value.receipt.events[6].data.redisConnected = false; },
  redisStillConnected: f => { f.value.receipt.events[9].data.redisClientPresent = true; },
  redisServerReplacement: f => { f.value.receipt.events[9].data.redisServerRunId = '2'.repeat(40); },
  barrierExpired: f => { f.value.receipt.events.push({ phase: 'barrier_expired', at: new Date(NOW + 20).toISOString(), data: {} }); },
  automaticExpiryOnly: f => { f.value.receipt.events[5].data.elapsedMs = 5000; },
  reusedInstance: f => { f.after.worker.instanceId = f.before.worker.instanceId; },
  reusedProcess: f => { f.recovered.processInstanceId = f.baseline.processInstanceId; },
  retainedAuthority: f => { f.recovered.policy.selfImproveEnabled = true; },
})) test(`shutdown acceptance rejects ${name}`, () => {
  const f = shutdownEvidence(); change(f);
  assert.throws(() => attestSelfHealShutdownReceipt(f.value, 'A06', f.baseline, f.recovered, f.m, f.before, f.after), /SELF_HEAL_ACCEPTANCE_SHUTDOWN_/u);
});

function startupEvidence() {
  const m = manifest(); const worker = m.services[1]; const live = attestSelfHealAcceptanceStatus(status(m), m, { now: () => NOW });
  const envelope = (role, index) => { const pin = m.services.find(item => item.role === role); return {
    target: { role, projectId: m.receipt.projectId, environmentId: m.receipt.environmentId, serviceId: pin.serviceId,
      deploymentId: pin.deploymentId, sourceSha: m.receipt.sourceSha, runId: m.receipt.runId },
    platformTarget: live[role], observedAt: new Date(NOW + 10 + index).toISOString() }; };
  const recovered = { before: { ...envelope('worker', 1), observation: snapshot({ processInstanceId: id(31) }) },
    after: { ...envelope('worker', 5), observation: snapshot({ processInstanceId: id(31) }) } };
  const failed = { id: id(50), projectId: m.receipt.projectId, environmentId: m.receipt.environmentId, serviceId: worker.serviceId,
    status: 'CRASHED', deploymentStopped: true, instances: [], meta: { commitHash: m.receipt.sourceSha, imageDigest: worker.imageDigest } };
  const value = { ...envelope('web', 0), startup: { evidence: 'independent_postgres_startup_readback', receipt: { scenario: 'A04', sourceSha: m.receipt.sourceSha,
    compiledSha256: worker.compiledSha256, processInstanceId: id(30), deploymentId: failed.id, pid: 1234,
    initialReadiness: { statusCode: 503, ready: false, child: 'starting', observedAt: new Date(NOW + 1).toISOString() },
    finishedAt: new Date(NOW + 2).toISOString(), outcome: { readinessCommitted: false,
      scheduler: { installationAttempts: 1, installations: 0, installationFailures: 1, callbacks: 0 },
      coordinator: { state: 'FAILED', inFlight: false } } } } };
  const probe = job => ({ scenario: 'A04', attempt: 2, correlationId: `self-heal-preview:${m.receipt.runId}:fenced:A04:2`, job });
  const fenced = { absent: { ...envelope('worker', 2), fencedJob: probe(null) },
    created: { ...envelope('worker', 3), fencedJob: probe({ id: id(60), status: 'pending', completionVerified: false, claimEvents: 0, completionEvents: 0 }) },
    completed: { ...envelope('worker', 4), fencedJob: probe({ id: id(60), completionVerified: true, literalObserved: true, matchingClaimEvents: 1, matchingCompletionEvents: 1 }) } };
  return { m, failed, value, recovered, fenced, inventory: status(m) };
}
test('A04 supplement requires the failed generation actual503, real scheduler failure and independently recovered job', () => {
  const f = startupEvidence();
  const result = attestSelfHealStartupFailureReceipt(f.value, f.failed, f.recovered, f.m, f.inventory, f.fenced, { now: () => NOW + 100 });
  assert.equal(result.readinessWithheldBeforeInitialization, true); assert.equal(result.ordinaryJobContinuityVerified, true);
  assert.notEqual(result.failedDeploymentId, result.recoveredDeploymentId);
});
for (const [name, change] of Object.entries({
  absentStartup: f => { delete f.value.startup; },
  absentEvidence: f => { delete f.value.startup.evidence; },
  syntheticEvidence: f => { f.value.startup.evidence = 'synthetic_startup_readback'; },
})) test(`A04 missing independent inspection is blocked: ${name}`, () => {
  const f = startupEvidence(); change(f);
  assert.throws(() => attestSelfHealStartupFailureReceipt(f.value, f.failed, f.recovered, f.m, f.inventory, f.fenced, { now: () => NOW + 100 }), {
    message: 'SELF_HEAL_ACCEPTANCE_STARTUP_FAILURE_INSPECTION_UNAVAILABLE', classification: 'BLOCKED',
  });
});
for (const [name, change] of Object.entries({
  failedStatusAlone: f => { delete f.value.startup.receipt.initialReadiness; },
  reusedGeneration: f => { f.failed.id = f.m.services[1].deploymentId; f.value.startup.receipt.deploymentId = f.failed.id; },
  differentSource: f => { f.failed.meta.commitHash = 'f'.repeat(40); },
  differentImage: f => { f.failed.meta.imageDigest = `sha256:${'e'.repeat(64)}`; },
  differentArtifact: f => { f.value.startup.receipt.compiledSha256 = 'e'.repeat(64); },
  foreignEnvironment: f => { f.failed.environmentId = id(99); },
  stillRunning: f => { f.failed.instances.push({ id: id(99), status: 'RUNNING' }); },
  healthyStoppedDeployment: f => { f.failed.status = 'SUCCESS'; },
  prematureReadiness: f => { f.value.startup.receipt.outcome.readinessCommitted = true; },
  noSchedulerFailure: f => { f.value.startup.receipt.outcome.scheduler.installationFailures = 0; },
  successfulScheduler: f => { f.value.startup.receipt.outcome.scheduler.installations = 1; },
  staleProcess: f => { f.recovered.before.observation.processInstanceId = f.value.startup.receipt.processInstanceId; },
  missingProcess: f => { delete f.recovered.before.observation.processInstanceId; },
  changedProcess: f => { f.recovered.after.observation.processInstanceId = id(99); },
  foreignRecovery: f => { f.recovered.before.target.environmentId = id(99); },
  foreignStartupReader: f => { f.value.target.projectId = id(99); },
  foreignFencedRole: f => { f.fenced.completed.target.role = 'web'; },
  foreignFencedInstance: f => { f.fenced.completed.platformTarget = { ...f.fenced.completed.platformTarget, instanceId: id(99) }; },
  duplicateCompletion: f => { f.fenced.completed.fencedJob.job.matchingCompletionEvents = 2; },
  unrelatedJob: f => { f.fenced.completed.fencedJob.scenario = 'A01'; },
  oldCompletedJob: f => { f.fenced.absent.fencedJob.job = f.fenced.completed.fencedJob.job; },
  completionBeforeCreate: f => { f.fenced.completed.observedAt = new Date(NOW).toISOString(); },
  differentCompletedJob: f => { f.fenced.completed.fencedJob.job.id = id(99); },
  failureAfterJob: f => { f.value.startup.receipt.initialReadiness.observedAt = new Date(NOW + 1000).toISOString(); f.value.startup.receipt.finishedAt = new Date(NOW + 2000).toISOString(); },
  futureObservation: f => { f.recovered.after.observedAt = new Date(NOW + 200).toISOString(); },
})) test(`A04 supplement rejects ${name}`, () => {
  const f = startupEvidence(); change(f);
  assert.throws(() => attestSelfHealStartupFailureReceipt(f.value, f.failed, f.recovered, f.m, f.inventory, f.fenced, { now: () => NOW + 100 }), error => {
    assert.match(error.message, /SELF_HEAL_ACCEPTANCE_STARTUP_/u);
    assert.equal(error.classification, 'FAILED');
    return true;
  });
});

test('closed restoration survives a changed PR head and cleanup reserve but never lease expiry', async () => {
  const { current, transport } = cliFixture(); current.head = 'f'.repeat(40);
  await assert.rejects(transport.remote('worker', ['command', 'tick']), /PR_HEAD_CHANGED/u);
  assert.equal(current.calls.length, 0);
  await transport.restore(['command', 'policy_restore']);
  current.clock = NOW + 111 * 60_000;
  await assert.rejects(transport.remote('worker', ['inspect']), /CLEANUP_RESERVE_REACHED/u);
  await transport.restore(['provider', 'release']);
  for (const args of [['command', 'policy_allowed'], ['provider', 'timeout_next'], ['inspect']]) {
    await assert.rejects(transport.restore(args), /RESTORATION_INVALID/u);
  }
  const before = current.calls.length; current.clock = NOW + 120 * 60_000;
  await assert.rejects(transport.restore(['command', 'policy_restore']), /LEASE_EXPIRED/u);
  assert.equal(current.calls.length, before);
});

test('restoration still rejects source drift after a PR-head change', async () => {
  const { current, transport } = cliFixture(); current.head = 'f'.repeat(40);
  current.status.environments.edges[0].node.serviceInstances.edges[1].node.latestDeployment.meta.commitHash = 'f'.repeat(40);
  await assert.rejects(transport.restore(['command', 'policy_restore']), /SOURCE_OR_LAUNCH_DRIFT/u);
  assert.equal(current.calls.filter(args => args[0] === 'ssh').length, 0);
});

test('restoration attempts every closed action after the first release fails', async () => {
  const transport = fakeTransport(); const attempted = [];
  transport.restore = async args => {
    attempted.push(args.join(':'));
    if (args.join(':') === 'provider:release') throw new Error('fixture failure');
    return transport.remote('worker', args);
  };
  const result = await runSelfHealAcceptanceCase('A01', manifest(), { now: () => NOW, execute: true, allowNetwork: true, transport });
  assert.deepEqual(attempted, ['provider:release', 'provider:set_healthy', 'command:release_observation',
    'command:trinity_rollback', 'command:policy_restore', 'command:coordinator_start']);
  assert.equal(result.classification, 'BLOCKED'); assert.equal(result.cleanupResult, 'FAILED');
});

test('an owned restart permits only its bounded zero-instance transition and never source or topology drift', async () => {
  const { current, transport } = cliFixture(); await transport.restart('worker');
  const worker = current.status.environments.edges[0].node.serviceInstances.edges[1].node;
  worker.latestDeployment.instances = []; worker.latestDeployment.status = 'DEPLOYING'; worker.activeDeployments = [];
  await assert.rejects(transport.remote('worker', ['inspect']), /TARGET_NOT_RUNNING/u);
  assert.equal(current.calls.filter(args => args[0] === 'ssh').length, 0);
  worker.latestDeployment.meta.commitHash = 'f'.repeat(40);
  await assert.rejects(transport.remote('worker', ['inspect']), /SOURCE_OR_LAUNCH_DRIFT/u);
  worker.latestDeployment.meta.commitHash = 'a'.repeat(40);
  worker.activeDeployments = [{ id: id(99), deploymentStopped: false }];
  await assert.rejects(transport.remote('worker', ['inspect']), /DEPLOYMENT_DRIFT/u);
  worker.activeDeployments = []; current.clock += 120_001;
  await assert.rejects(transport.remote('worker', ['inspect']), /DEPLOYMENT_DRIFT/u);
  await assert.rejects(transport.restart('worker'), /RESTART_BUDGET_EXHAUSTED/u);
});

test('restart polling retries an expected unavailable instance but not an identity failure', async () => {
  for (const failure of ['TARGET_NOT_RUNNING', 'REMOTE_IDENTITY_DRIFT']) {
    let clock = NOW; let restarted = false; let failed = false;
    const state = snapshot(); const transport = fakeTransport(state); const original = transport.remote;
    transport.restart = async () => { restarted = true; return { restartRequested: true }; };
    transport.remote = async (role, args) => {
      if (restarted && args[0] === 'inspect' && !failed) { failed = true; throw new SelfHealAcceptanceError(failure); }
      if (restarted) state.processInstanceId = id(31);
      return structuredClone(await original(role, args));
    };
    const result = await runSelfHealAcceptanceCase('A05', manifest(), { now: () => clock,
      sleep: async ms => { clock += ms; }, execute: true, allowNetwork: true, transport });
    assert.equal(result.classification, failure === 'TARGET_NOT_RUNNING' ? 'SYNTHETIC_ONLY' : 'BLOCKED');
    if (failure === 'REMOTE_IDENTITY_DRIFT') assert.equal(result.errorCode, 'SELF_HEAL_ACCEPTANCE_REMOTE_IDENTITY_DRIFT');
  }
});

function scenarioFixture(scenario, fault = null) {
  let clock = NOW; let sequence = 0; let armed = false;
  const stage = () => ({ activeAction: null, mitigationId: null, verificationSuccesses: 0, verificationFailures: 0 });
  const state = snapshot({ provider: { reloadCount: 0 }, coordinatorEvents: [],
    trinity: { snapshot: { intake: stage(), reasoning: stage(), final: stage() } },
    predictiveRun: { status: 'completed', startedAt: new Date(NOW - 1).toISOString(), audit: { auditId: 'predictive_heal_audit_1' } } });
  const calls = []; const providerReceipts = [];
  const response = () => { state.policy.observedAt = new Date(++clock).toISOString(); return { observation: structuredClone(state) }; };
  const transport = {
    restart: async () => { state.processInstanceId = id(31); return { restartRequested: true }; },
    remote: async (role, args) => {
      calls.push([role, args]); clock += 1;
      if (args[0] === 'artifact') return { artifact: { compiledSha256: 'c'.repeat(64) } };
      if (args[0] === 'inspect') return response();
      if (args[0] === 'provider') {
        if (args[1] === 'timeout_next') armed = true;
        if (['release', 'set_healthy'].includes(args[1])) armed = false;
        return { observation: { receipts: structuredClone(providerReceipts) } };
      }
      if (args[0] === 'replacement-race') {
        const original = { ...stage(), activeAction: 'bypass_final_stage', mitigationId: 1 };
        const replacement = { ...stage(), activeAction: 'enable_degraded_mode', mitigationId: 2 };
        const consumer = { processInstanceId: state.processInstanceId, requestId: 'consumer-race-1',
          status: 'completed', dryRun: false, diagnostics: { statusCode: 200 },
          mitigationBefore: { mitigationId: 1 }, mitigationAfter: structuredClone(replacement) };
        const baseline = structuredClone(state); baseline.trinity.snapshot.final = original;
        const held = structuredClone(baseline); held.consumerRun = { ...consumer, status: 'running' };
        const replaced = structuredClone(state); replaced.trinity.snapshot.final = replacement;
        const finalState = structuredClone(replaced); finalState.consumerRun = consumer;
        if (fault === 'replacement-removed') finalState.trinity.snapshot.final = stage();
        if (fault === 'failure-contamination') finalState.trinity.snapshot.final.verificationFailures += 1;
        if (fault === 'success-contamination') finalState.trinity.snapshot.final.verificationSuccesses += 1;
        if (fault === 'failed-consumer') finalState.consumerRun.status = 'failed';
        if (fault === 'foreign-process') finalState.processInstanceId = id(99);
        if (fault === 'foreign-request') finalState.consumerRun.requestId = 'other-request';
        if (fault === 'wrong-replacement-action') finalState.trinity.snapshot.final.activeAction = 'bypass_final_stage';
        return { overlap: { status: 'completed', requestId: 'consumer-race-1', baseline, held: { consumer: held },
          replacement: replaced, finalState, cleanup: { provider: 'released' } } };
      }
      assert.equal(args[0], 'command'); const command = args[1];
      if (command.startsWith('policy_')) {
        state.policy = { selfImproveEnabled: command !== 'policy_disabled' && command !== 'policy_restore',
          autonomyLevel: command === 'policy_insufficient_autonomy' ? 2 : 3,
          frozen: command === 'policy_freeze', killSwitch: { frozen: command === 'policy_kill_switch' } };
      }
      if (command === 'trinity_run') {
        const actualFault = armed && fault !== 'no-fault'; const requestId = `consumer-${++sequence}`;
        if (actualFault) providerReceipts.push({ requestId, fault: 'timeout', outcome: 'client_closed' });
        armed = false;
        state.consumerRun = { requestId, processInstanceId: state.processInstanceId, status: 'completed', dryRun: false,
          diagnostics: { statusCode: actualFault ? 504 : 200 },
          recoveryPath: { reasoningTimeoutDirectAnswerFallback: actualFault } };
      }
      if (command === 'tick') {
        state.coordinator.tickCount += 1; state.coordinator.lastDecision = fault === 'healthy-no-action' ? 'observe' : 'heal';
        const reasonCode = scenario === 'D01' ? 'self_improve_execution_disabled'
          : scenario === 'D02' ? 'insufficient_autonomy' : 'self_improve_frozen';
        if (!['no-denial', 'healthy-no-action'].includes(fault)) state.coordinatorEvents.push({ id: 'self_heal_event_1',
          timestamp: new Date(clock).toISOString(), kind: 'noop', trigger: 'action', reasonCode, action: 'reinitializeOpenAIProvider' });
        if (fault === 'unauthorized-provider-effect') state.provider.reloadCount += 1;
      }
      if (command === 'predictive_evaluate_live') {
        const dryRun = scenario === 'D05';
        state.predictiveRun = { status: 'completed', processInstanceId: state.processInstanceId,
          evidence: 'measured_runtime_observation', startedAt: new Date(clock).toISOString(),
          audit: { auditId: fault === 'stale-audit' ? 'predictive_heal_audit_1' : 'predictive_heal_audit_2',
            timestamp: new Date(clock).toISOString(), source: 'self-heal.preview.measured-runtime',
            selectedAction: fault === 'no-candidate' ? 'none' : 'activate_trinity_mitigation',
            safeToExecute: fault !== 'unsafe-candidate', attempted: fault === 'attempted-effect',
            mode: fault === 'wrong-mode' ? 'auto_execute' : dryRun ? 'dry_run' : 'recommend_only',
            status: dryRun ? 'dry_run' : 'skipped', featureFlags: { enabled: true, dryRun, autoExecute: dryRun } } };
        if (fault === 'foreign-audit-process') state.predictiveRun.processInstanceId = id(99);
        if (fault === 'wrong-feature-flag') state.predictiveRun.audit.featureFlags.autoExecute = !dryRun;
      }
      return response();
    },
  };
  return { calls, options: { now: () => clock, sleep: async ms => { clock += ms; }, execute: true, allowNetwork: true, transport } };
}

test('C05 requires a successful same-request consumer and unchanged exact replacement counters', async () => {
  const { options } = scenarioFixture('C05');
  const result = await runSelfHealAcceptanceCase('C05', manifest(), options);
  assert.equal(result.classification, 'SYNTHETIC_ONLY');
});
for (const fault of ['replacement-removed', 'failure-contamination', 'success-contamination', 'failed-consumer',
  'foreign-process', 'foreign-request', 'wrong-replacement-action']) test(`C05 rejects ${fault}`, async () => {
  const { options } = scenarioFixture('C05', fault);
  const result = await runSelfHealAcceptanceCase('C05', manifest(), options);
  assert.equal(result.classification, 'FAILED'); assert.equal(result.errorCode, 'SELF_HEAL_ACCEPTANCE_REPLACEMENT_RACE_CONTAMINATED_EVIDENCE');
});

for (const scenario of ['D01', 'D02', 'D03', 'D04']) {
  test(`${scenario} requires measured faults and its canonical denial`, async () => {
    const { calls, options } = scenarioFixture(scenario); const result = await runSelfHealAcceptanceCase(scenario, manifest(), options);
    assert.equal(result.classification, 'SYNTHETIC_ONLY');
    assert.equal(calls.filter(call => call[1][0] === 'provider' && call[1][1] === 'timeout_next').length, 3);
    assert(!calls.some(call => call[1][1] === 'trinity_activate'));
  });
  for (const fault of ['no-fault', 'no-denial', 'healthy-no-action']) test(`${scenario} blocks ${fault}`, async () => {
    const { options } = scenarioFixture(scenario, fault); const result = await runSelfHealAcceptanceCase(scenario, manifest(), options);
    assert.equal(result.classification, 'BLOCKED');
    assert.match(result.errorCode, /AUTHORIZATION_FAULT_PREREQUISITE|CANONICAL_POLICY_DENIAL_REQUIRED/u);
  });
}
test('a canonical authorization case fails when a provider effect occurs despite denial', async () => {
  const { options } = scenarioFixture('D01', 'unauthorized-provider-effect');
  const result = await runSelfHealAcceptanceCase('D01', manifest(), options);
  assert.equal(result.classification, 'FAILED'); assert.equal(result.errorCode, 'SELF_HEAL_ACCEPTANCE_AUTHORIZATION_SIDE_EFFECT');
});

for (const scenario of ['D05', 'D06']) {
  test(`${scenario} requires exactly two measured faults and the fresh intended audit mode`, async () => {
    const { calls, options } = scenarioFixture(scenario); const result = await runSelfHealAcceptanceCase(scenario, manifest(), options);
    assert.equal(result.classification, 'SYNTHETIC_ONLY');
    assert.equal(calls.filter(call => call[1][0] === 'provider' && call[1][1] === 'timeout_next').length, 2);
  });
  for (const fault of ['no-fault', 'no-candidate', 'unsafe-candidate', 'stale-audit', 'wrong-mode',
    'wrong-feature-flag', 'foreign-audit-process']) test(`${scenario} blocks ${fault}`, async () => {
    const { options } = scenarioFixture(scenario, fault); const result = await runSelfHealAcceptanceCase(scenario, manifest(), options);
    assert.equal(result.classification, 'BLOCKED'); assert.match(result.errorCode, /PREDICTIVE_/u);
  });
  test(`${scenario} fails an attempted action`, async () => {
    const { options } = scenarioFixture(scenario, 'attempted-effect'); const result = await runSelfHealAcceptanceCase(scenario, manifest(), options);
    assert.equal(result.classification, 'FAILED'); assert.equal(result.errorCode, 'SELF_HEAL_ACCEPTANCE_PREDICTIVE_EXECUTION_ESCAPE');
  });
}

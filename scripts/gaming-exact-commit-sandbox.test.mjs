import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { dockerCreateArgs, validateSandbox, validateMockEnvironment, initializeOfflineDependencies,
  installCancellationHandler, generateOwnedContainerName, createOwnedContainer, cleanupOwnedContainer,
  assertOwnedContainer, finalizeSandboxReceipt, CREATION_TIMEOUT_MS, LIMITS, GAMING_TESTS } from './gaming-exact-commit-sandbox.mjs';

const expected = { imageId: `sha256:${'a'.repeat(64)}`, sourceArchive: '/inputs/source.tar',
  dependenciesArchive: '/inputs/dependencies.tar', helperPath: '/controller/scripts/gaming-exact-commit-sandbox.mjs',
  sourceSha: 'dc7e7fdd34fd3563653ecb224102c73c1696239e',
  sourceTree: 'c68776bbe9566851bb06196215df566773b36ae8', prNumber: 1534 };

function inspection() {
  const args = dockerCreateArgs(expected);
  return { Image: expected.imageId,
    Config: { User: '65532:65532', Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_VERSION=24.18.1', 'YARN_VERSION=1.22.22'],
      Entrypoint: ['/usr/bin/env'], Cmd: args.slice(args.indexOf(expected.imageId) + 1) },
    HostConfig: { NetworkMode: 'none', Dns: ['127.0.0.1'], Privileged: false, ReadonlyRootfs: true,
      CapAdd: null, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Memory: LIMITS.memory,
      MemorySwap: LIMITS.memory, NanoCpus: LIMITS.cpus * 1e9, PidsLimit: LIMITS.pids,
      RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'none' }, PidMode: '', IpcMode: 'private',
      Devices: [], DeviceRequests: null, VolumesFrom: null, DeviceCgroupRules: null, PortBindings: {},
      Tmpfs: { '/work': `rw,exec,nosuid,nodev,size=${LIMITS.workBytes},uid=65532,gid=65532,mode=0700`,
        '/tmp': `rw,nosuid,nodev,noexec,size=${LIMITS.tempBytes},uid=65532,gid=65532,mode=0700` } },
    NetworkSettings: { Networks: { none: {} } },
    Mounts: [
      { Type: 'bind', Source: expected.sourceArchive, Destination: '/inputs/source.tar', RW: false },
      { Type: 'bind', Source: expected.dependenciesArchive, Destination: '/inputs/dependencies.tar', RW: false },
      { Type: 'bind', Source: expected.helperPath, Destination: '/trusted/runner.mjs', RW: false }
    ] };
}

function environment() {
  const args = dockerCreateArgs(expected);
  const start = args.indexOf('-i') + 1;
  const end = args.indexOf('node', start);
  return Object.fromEntries(args.slice(start, end).map((value) => {
    const index = value.indexOf('=');
    return [value.slice(0, index), value.slice(index + 1)];
  }));
}

test('immutable sandbox command accepts authorized-shaped source identities and explicit mock isolation', () => {
  const args = dockerCreateArgs(expected);
  assert.equal(args[0], 'create');
  assert(args.includes(expected.imageId));
  assert(args.includes('-i'));
  assert(!args.some((arg) => arg.includes('docker.sock') || arg.includes('GITHUB_TOKEN') || arg.includes('RAILWAY_TOKEN')));
  assert.equal(args.filter((arg) => arg === '--mount').length, 3);
  assert.equal(validateSandbox(inspection(), expected).network, 'none');
  assert.equal(validateMockEnvironment(environment()), true);
  assert.equal(GAMING_TESTS.length, 10);
});

for (const [name, change] of [
  ['branch name', { sourceSha: 'codex/gaming-claim-corroboration-1532' }],
  ['abbreviated SHA', { sourceSha: 'dc7e7fd' }],
  ['uppercase SHA', { sourceSha: 'DC7E7FDD34FD3563653ECB224102C73C1696239E' }],
  ['shell substitution', { sourceSha: '$(echo malicious)' }],
  ['invalid tree', { sourceTree: 'HEAD^{tree}' }],
  ['mutable image tag', { imageId: 'node:24' }],
  ['unsupported PR', { prNumber: 1533 }],
  ['mount-option injection', { sourceArchive: '/tmp/source,bind-propagation=rshared' }],
  ['relative mount', { dependenciesArchive: 'dependencies.tar' }]
]) test(`rejects ${name} before container creation`, () => assert.throws(() => dockerCreateArgs({ ...expected, ...change })));

const weakeningCases = [
  ['wrong image', (r) => { r.Image = `sha256:${'b'.repeat(64)}`; }],
  ['external network', (r) => { r.HostConfig.NetworkMode = 'bridge'; }],
  ['nonloopback resolver', (r) => { r.HostConfig.Dns = ['8.8.8.8']; }],
  ['privileged container', (r) => { r.HostConfig.Privileged = true; }],
  ['writable root filesystem', (r) => { r.HostConfig.ReadonlyRootfs = false; }],
  ['root UID', (r) => { r.Config.User = '0:0'; }],
  ['added capability', (r) => { r.HostConfig.CapAdd = ['SYS_ADMIN']; }],
  ['missing capability drop', (r) => { r.HostConfig.CapDrop = []; }],
  ['missing privilege assertion', (r) => { r.HostConfig.SecurityOpt = []; }],
  ['unbounded memory', (r) => { r.HostConfig.Memory = 0; }],
  ['unbounded swap', (r) => { r.HostConfig.MemorySwap = -1; }],
  ['unbounded CPU', (r) => { r.HostConfig.NanoCpus = 0; }],
  ['unbounded process count', (r) => { r.HostConfig.PidsLimit = -1; }],
  ['automatic restart', (r) => { r.HostConfig.RestartPolicy.Name = 'always'; }],
  ['unbounded daemon log', (r) => { r.HostConfig.LogConfig.Type = 'json-file'; }],
  ['host process namespace', (r) => { r.HostConfig.PidMode = 'host'; }],
  ['host IPC namespace', (r) => { r.HostConfig.IpcMode = 'host'; }],
  ['host device', (r) => { r.HostConfig.Devices = [{ PathOnHost: '/dev/sda' }]; }],
  ['GPU request', (r) => { r.HostConfig.DeviceRequests = [{ Count: -1 }]; }],
  ['inherited volume', (r) => { r.HostConfig.VolumesFrom = ['production-volume']; }],
  ['device allow rule', (r) => { r.HostConfig.DeviceCgroupRules = ['a *:* rwm']; }],
  ['published port', (r) => { r.HostConfig.PortBindings = { '3000/tcp': [{ HostPort: '3000' }] }; }],
  ['additional network attachment', (r) => { r.NetworkSettings.Networks.bridge = {}; }],
  ['provider key in image environment', (r) => { r.Config.Env.push('OPENAI_API_KEY=live'); }],
  ['Railway credential in image environment', (r) => { r.Config.Env.push('RAILWAY_TOKEN=live'); }],
  ['GitHub credential in image environment', (r) => { r.Config.Env.push('GITHUB_TOKEN=live'); }],
  ['proxy in image environment', (r) => { r.Config.Env.push('HTTPS_PROXY=http://proxy:8080'); }],
  ['duplicate image environment', (r) => { r.Config.Env.push('NODE_VERSION=24.18.1'); }],
  ['candidate entrypoint', (r) => { r.Config.Entrypoint = ['node', '/work/source/deploy.mjs']; }],
  ['changed command', (r) => { r.Config.Cmd.push('production'); }],
  ['Docker socket mount', (r) => { r.Mounts.push({ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true }); }],
  ['writable source archive', (r) => { r.Mounts[0].RW = true; }],
  ['changed controller mount', (r) => { r.Mounts[2].Source = '/candidate/runner.mjs'; }],
  ['missing scratch limit', (r) => { r.HostConfig.Tmpfs['/work'] = 'rw'; }],
  ['nonexecutable work mount', (r) => { r.HostConfig.Tmpfs['/work'] = r.HostConfig.Tmpfs['/work'].replace(',exec', ',noexec'); }],
  ['extra scratch mount', (r) => { r.HostConfig.Tmpfs['/secrets'] = 'rw'; }],
  ['executable temporary mount', (r) => { r.HostConfig.Tmpfs['/tmp'] = r.HostConfig.Tmpfs['/tmp'].replace(',noexec', ''); }]
];
for (const [name, weaken] of weakeningCases) test(`fails closed on ${name}`, () => {
  const r = inspection();
  weaken(r);
  assert.throws(() => validateSandbox(r, expected));
});

for (const [name, mutate] of [
  ['false mock flag', (env) => { env.FORCE_MOCK = 'false'; }],
  ['live provider key', (env) => { env.OPENAI_API_KEY = 'live-provider-key'; }],
  ['public provider URL', (env) => { env.OPENAI_BASE_URL = 'https://api.openai.com/v1'; }],
  ['production mode', (env) => { env.NODE_ENV = 'production'; }],
  ['GitHub token', (env) => { env.GITHUB_TOKEN = 'not-allowed'; }],
  ['Railway token', (env) => { env.RAILWAY_TOKEN = 'not-allowed'; }],
  ['production database', (env) => { env.DATABASE_URL = 'not-allowed'; }],
  ['host proxy', (env) => { env.HTTPS_PROXY = 'not-allowed'; }],
  ['unbounded or nonexecutable temporary directory', (env) => { env.TMPDIR = '/tmp'; }],
  ['Actions command file', (env) => { env.GITHUB_ENV = '/host/commands'; }],
  ['workers enabled', (env) => { env.RUN_WORKERS = 'true'; }]
]) test(`rejects runtime environment with ${name}`, () => {
  const env = environment();
  mutate(env);
  assert.throws(() => validateMockEnvironment(env));
});

async function prismaFixture() {
  const root = await mkdtemp(join(tmpdir(), 'gaming-offline-prisma-'));
  await mkdir(join(root, 'node_modules/@prisma/client/scripts'), { recursive: true });
  await mkdir(join(root, 'node_modules/.prisma/client'), { recursive: true });
  for (const [extension, provided] of [['js', 'default-index.js'], ['d.ts', 'default-index.d.ts']]) {
    await writeFile(join(root, 'node_modules/@prisma/client/scripts', provided), `published-${extension}`);
    for (const name of ['index', 'default']) {
      await writeFile(join(root, 'node_modules/.prisma/client', `${name}.${extension}`), `published-${extension}`);
    }
  }
  return root;
}

test('offline initialization retains only the two reviewed hooks and verifies actual Prisma stub bytes', async () => {
  const root = await prismaFixture();
  try {
    const calls = [];
    await initializeOfflineDependencies(root, (...args) => calls.push(args));
    assert.deepEqual(calls, [
      ['node', ['scripts/postinstall.cjs'], root],
      ['node', ['node_modules/@prisma/client/scripts/postinstall.js'], root]
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a swallowed Prisma hook error cannot pass without generated types', async () => {
  const root = await prismaFixture();
  try {
    await rm(join(root, 'node_modules/.prisma/client/default.d.ts'));
    await assert.rejects(initializeOfflineDependencies(root, () => {}), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unexpected generated Prisma client code or types fail closed', async () => {
  const root = await prismaFixture();
  try {
    for (const filename of ['index.js', 'default.js', 'index.d.ts', 'default.d.ts']) {
      const destination = join(root, 'node_modules/.prisma/client', filename);
      const original = await readFile(destination);
      await writeFile(destination, 'unexpected-client');
      await assert.rejects(initializeOfflineDependencies(root, () => {}), /PRISMA_INITIALIZATION_INVALID/);
      await writeFile(destination, original);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} stops only its owned container and preserves cleanup until disposal`, () => {
  const target = new EventEmitter();
  const calls = [];
  const cancellation = installCancellationHandler(() => calls.push('owned-container'), target);
  assert.equal(cancellation.signal, undefined);
  target.emit(signal);
  assert.equal(cancellation.signal, signal);
  assert.deepEqual(calls, ['owned-container']);
  target.emit('SIGINT'); target.emit('SIGTERM');
  assert.deepEqual(calls, ['owned-container']);
  assert.equal(target.listenerCount('SIGINT'), 1);
  assert.equal(target.listenerCount('SIGTERM'), 1);
  cancellation.dispose();
  assert.equal(target.listenerCount('SIGINT'), 0);
  assert.equal(target.listenerCount('SIGTERM'), 0);
});

function ownerFixture() {
  return { ...expected, containerName: generateOwnedContainerName(), cidFile: '/trusted/receipts/owned-container.cid' };
}
function ownedInspect(owner) {
  return { Name: `/${owner.containerName}`, Image: owner.imageId, Id: 'a'.repeat(64),
    Config: { Labels: { 'arcanos.gaming-ci.owner': owner.containerName,
      'arcanos.gaming-ci.source-sha': owner.sourceSha } } };
}
test('ownership uses unique host-generated names and a fixed explicit CID-file mechanism', () => {
  const names = new Set(Array.from({ length: 30 }, () => generateOwnedContainerName()));
  assert.equal(names.size, 30);
  for (const name of names) assert.match(name, /^arcanos-gaming-ci-[0-9a-f]{32}$/);
  const owner = ownerFixture();
  const args = dockerCreateArgs(owner);
  assert.equal(args[args.indexOf('--name') + 1], owner.containerName);
  assert.equal(args[args.indexOf('--cidfile') + 1], owner.cidFile);
  assert(args.includes(`arcanos.gaming-ci.owner=${owner.containerName}`));
  assert.throws(() => dockerCreateArgs({ ...owner, containerName: 'production' }), /OWNER_NAME_INVALID/);
  assert.throws(() => dockerCreateArgs({ ...owner, cidFile: 'candidate.cid' }), /CID_PATH_INVALID/);
});
test('successful bounded creation returns only an immutable container ID', async () => {
  const owner = ownerFixture();
  const id = await createOwnedContainer(owner, async (args, options) => {
    assert.equal(args[0], 'create'); assert.equal(options.timeoutMs, CREATION_TIMEOUT_MS);
    return { status: 0, stdout: `${'a'.repeat(64)}\n`, stderr: '' };
  });
  assert.equal(id, 'a'.repeat(64));
  await assert.rejects(createOwnedContainer(owner, () => ({ status: 0, stdout: 'not-an-id', stderr: '' })), /CONTAINER_ID_INVALID/);
});
test('creation failure retains bounded command evidence for exact-name orphan recovery', async () => {
  const owner = ownerFixture();
  await assert.rejects(createOwnedContainer(owner, () => ({ status: null, stdout: '', stderr: 'create interrupted',
    error: new Error('timeout') })), (error) => {
    assert.equal(error.message, 'SANDBOX_CONTAINER_CREATION_FAILED');
    assert.equal(error.creationEvidence.errorMessage, 'timeout');
    assert.equal(error.creationEvidence.stderr, 'create interrupted');
    return true;
  });
});
test('cleanup after ambiguous creation removes only the exact verified owned container', () => {
  const owner = ownerFixture(); const calls = [];
  const result = cleanupOwnedContainer(owner, false, (args) => {
    calls.push(args);
    if (args[0] === 'inspect') return { status: 0, stdout: JSON.stringify([ownedInspect(owner)]) };
    return { status: 0 };
  });
  assert.equal(result.containerRemoved, true);
  assert.deepEqual(calls, [['inspect', owner.containerName], ['rm', '--force', owner.containerName]]);
});
test('absent object after failed create is not proof that a pending daemon create cannot materialize', () => {
  const owner = ownerFixture();
  const client = () => ({ status: 1, stderr: `Error: No such object: ${owner.containerName}` });
  assert.equal(cleanupOwnedContainer(owner, false, client).containerRemoved, false);
  assert.equal(cleanupOwnedContainer(owner, false, client).state, 'creation-result-unknown');
  assert.equal(cleanupOwnedContainer(owner, true, client).containerRemoved, true);
});
for (const [name, change] of [
  ['foreign name', (r) => { r.Name = '/production'; }],
  ['foreign image', (r) => { r.Image = `sha256:${'b'.repeat(64)}`; }],
  ['foreign owner label', (r) => { r.Config.Labels['arcanos.gaming-ci.owner'] = 'someone-else'; }],
  ['foreign source label', (r) => { r.Config.Labels['arcanos.gaming-ci.source-sha'] = 'b'.repeat(40); }]
]) test(`cleanup refuses ${name}`, () => {
  const owner = ownerFixture(); const inspected = ownedInspect(owner); change(inspected);
  assert.throws(() => assertOwnedContainer(inspected, owner));
  let removals = 0;
  const result = cleanupOwnedContainer(owner, false, (args) => {
    if (args[0] === 'rm') removals++;
    return { status: 0, stdout: JSON.stringify([inspected]) };
  });
  assert.equal(result.containerRemoved, false); assert.equal(removals, 0);
});
test('unavailable daemon and failed removal remain explicit cleanup failures', () => {
  const owner = ownerFixture();
  assert.equal(cleanupOwnedContainer(owner, false, () => ({ status: 1, stderr: 'cannot connect' })).containerRemoved, false);
  assert.equal(cleanupOwnedContainer(owner, true, (args) => args[0] === 'inspect'
    ? { status: 0, stdout: JSON.stringify([ownedInspect(owner)]) }
    : { status: 1, stderr: 'remove failed' }).containerRemoved, false);
});

test('cancellation observed during final receipt write replaces passed receipt and rejects success', async () => {
  const receipt = { status: 'passed', containerRemoved: true };
  const cancellation = {};
  const writes = [];
  await assert.rejects(finalizeSandboxReceipt(receipt, cancellation, async () => {
    writes.push(structuredClone(receipt));
    if (writes.length === 1) cancellation.signal = 'SIGTERM';
  }), /SANDBOX_CANCELLED/);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].status, 'passed');
  assert.equal(writes[1].status, 'failed');
  assert.equal(writes[1].cancelledSignal, 'SIGTERM');
  assert.equal(receipt.status, 'failed');
});

test('already observed cancellation never writes a passed final receipt', async () => {
  const receipt = { status: 'passed', containerRemoved: true };
  const writes = [];
  await assert.rejects(finalizeSandboxReceipt(receipt, { signal: 'SIGINT' }, async () => {
    writes.push(structuredClone(receipt));
  }), /SANDBOX_CANCELLED/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 'failed');
  assert.equal(writes[0].cancelledSignal, 'SIGINT');
});

test('uncancelled successful finalization persists its receipt once', async () => {
  const receipt = { status: 'passed', containerRemoved: true };
  let writes = 0;
  await finalizeSandboxReceipt(receipt, {}, async () => { writes++; });
  assert.equal(writes, 1); assert.equal(receipt.status, 'passed');
});

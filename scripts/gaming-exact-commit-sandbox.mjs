import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { Resolver } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

export const LIMITS = Object.freeze({ cpus: 2, memory: 8589934592, pids: 256,
  workBytes: 4294967296, tempBytes: 536870912, timeoutMs: 1800000, logBytes: 8388608 });
const SHA = /^[0-9a-f]{40}$/;
const IMAGE = /^sha256:[0-9a-f]{64}$/;
const HELPER = fileURLToPath(import.meta.url);
const BASE_ENV = Object.freeze({ HOME: '/tmp', TMPDIR: '/work/tmp', PATH: '/usr/local/bin:/usr/bin:/bin',
  NODE_ENV: 'test', FORCE_MOCK: 'true', ALLOW_MOCK_OPENAI: 'true',
  DISABLE_EXTERNAL_CALLS: 'true', USE_MOCK_SERVICES: 'true', RUN_WORKERS: 'false',
  OPENAI_API_KEY: 'mock-api-key', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
  AI_MODEL: 'ft:gpt-4.1-2025-04-14:arcanos-test:authority:offline',
  NPM_CONFIG_USERCONFIG: '/tmp/user.npmrc', NPM_CONFIG_GLOBALCONFIG: '/tmp/global.npmrc',
  NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_OFFLINE: 'true',
  NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', CI: 'true' });

export const GAMING_TESTS = Object.freeze([
  'tests/gaming-generic-source-scope.test.ts',
  'tests/gaming-generic-stored-source-scope.test.ts',
  'tests/gaming-generic-late-source-scope.test.ts',
  'tests/gaming-generic-late-applicability.test.ts',
  'tests/gaming-body-identity.test.ts',
  'tests/gaming-currentness-registry.test.ts',
  'tests/gaming-platform-aliases.test.ts',
  'tests/gaming-minecraft-edition-scope.test.ts',
  'tests/gaming-claim-corroboration.test.ts',
  'tests/gaming-hybrid-corroboration.test.ts'
]);
const PROXY_KEYS = Object.freeze(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy']);
const DOCKER_ENV = Object.freeze({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' });
const DOCKER_CLIENT = Object.freeze(['--host', 'unix:///var/run/docker.sock']);
const OWNED_NAME = /^arcanos-gaming-ci-[0-9a-f]{32}$/;
export const CREATION_TIMEOUT_MS = 120000;

export function generateOwnedContainerName() {
  return `arcanos-gaming-ci-${randomBytes(16).toString('hex')}`;
}

function requireOwnership({ containerName, cidFile }) {
  assert(OWNED_NAME.test(containerName), 'SANDBOX_OWNER_NAME_INVALID');
  assert(isAbsolute(cidFile) && !/[\r\n,]/.test(cidFile), 'SANDBOX_CID_PATH_INVALID');
}

export function assertOwnedContainer(inspect, expected) {
  requireOwnership(expected);
  assert.equal(inspect.Name, `/${expected.containerName}`, 'SANDBOX_OWNER_NAME_MISMATCH');
  assert.equal(inspect.Image, expected.imageId, 'SANDBOX_OWNER_IMAGE_MISMATCH');
  assert.equal(inspect.Config?.Labels?.['arcanos.gaming-ci.owner'], expected.containerName,
    'SANDBOX_OWNER_LABEL_MISMATCH');
  assert.equal(inspect.Config?.Labels?.['arcanos.gaming-ci.source-sha'], expected.sourceSha,
    'SANDBOX_OWNER_SOURCE_MISMATCH');
}

function requireIdentity({ sourceSha, sourceTree, prNumber, imageId }) {
  assert(SHA.test(sourceSha), 'SANDBOX_SOURCE_SHA_INVALID');
  assert(SHA.test(sourceTree), 'SANDBOX_SOURCE_TREE_INVALID');
  assert([1534, 1535].includes(prNumber), 'SANDBOX_PR_UNSUPPORTED');
  if (imageId !== undefined) assert(IMAGE.test(imageId), 'SANDBOX_IMAGE_NOT_IMMUTABLE');
}

function mount(source, target) {
  assert(isAbsolute(source) && !/[\r\n,]/.test(source), 'SANDBOX_MOUNT_PATH_INVALID');
  return `type=bind,src=${source},dst=${target},readonly`;
}

/** The only mounts contain two trusted archives and this controller script. */
export function dockerCreateArgs({ imageId, sourceArchive, dependenciesArchive, helperPath = HELPER,
  sourceSha, sourceTree, prNumber, containerName, cidFile }) {
  requireIdentity({ imageId, sourceSha, sourceTree, prNumber });
  if (containerName !== undefined || cidFile !== undefined) requireOwnership({ containerName, cidFile });
  const ownerArgs = containerName === undefined ? [] : ['--name', containerName, '--cidfile', cidFile,
    '--label', `arcanos.gaming-ci.owner=${containerName}`, '--label', `arcanos.gaming-ci.source-sha=${sourceSha}`];
  return ['create', ...ownerArgs, '--network', 'none', '--dns', '127.0.0.1', '--ipc', 'private', '--read-only',
    '--user', '65532:65532', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--cpus', String(LIMITS.cpus), '--memory', String(LIMITS.memory),
    '--memory-swap', String(LIMITS.memory), '--pids-limit', String(LIMITS.pids),
    '--restart', 'no', '--log-driver', 'none',
    '--tmpfs', `/work:rw,exec,nosuid,nodev,size=${LIMITS.workBytes},uid=65532,gid=65532,mode=0700`,
    '--tmpfs', `/tmp:rw,nosuid,nodev,noexec,size=${LIMITS.tempBytes},uid=65532,gid=65532,mode=0700`,
    ...PROXY_KEYS.flatMap((key) => ['--env', `${key}=`]),
    '--mount', mount(sourceArchive, '/inputs/source.tar'),
    '--mount', mount(dependenciesArchive, '/inputs/dependencies.tar'),
    '--mount', mount(helperPath, '/trusted/runner.mjs'),
    '--entrypoint', '/usr/bin/env', imageId, '-i',
    ...Object.entries(BASE_ENV).map(([key, value]) => `${key}=${value}`),
    'node', '/trusted/runner.mjs', '--inside',
    JSON.stringify({ sourceSha, sourceTree, prNumber })];
}

/** Assert runtime-enforced containment before any candidate code starts. */
export function validateSandbox(inspect, expected) {
  requireIdentity(expected);
  if (expected.containerName !== undefined) assertOwnedContainer(inspect, expected);
  assert.equal(inspect.Image, expected.imageId, 'SANDBOX_IMAGE_MISMATCH');
  const h = inspect.HostConfig;
  const c = inspect.Config;
  assert(h && c, 'SANDBOX_INSPECT_INVALID');
  assert.equal(h.NetworkMode, 'none', 'SANDBOX_NETWORK_NOT_NONE');
  assert.deepEqual(h.Dns, ['127.0.0.1'], 'SANDBOX_DNS_NOT_LOOPBACK');
  assert.equal(h.Privileged, false, 'SANDBOX_PRIVILEGED');
  assert.equal(h.ReadonlyRootfs, true, 'SANDBOX_ROOT_WRITABLE');
  assert.equal(c.User, '65532:65532', 'SANDBOX_USER_NOT_NONROOT');
  assert.deepEqual(h.CapAdd ?? [], [], 'SANDBOX_CAPABILITIES_ADDED');
  assert.deepEqual(h.CapDrop, ['ALL'], 'SANDBOX_CAPABILITIES_NOT_DROPPED');
  assert.deepEqual(h.SecurityOpt, ['no-new-privileges'], 'SANDBOX_PRIVILEGE_ESCALATION');
  assert.equal(h.Memory, LIMITS.memory, 'SANDBOX_MEMORY_UNBOUNDED');
  assert.equal(h.MemorySwap, LIMITS.memory, 'SANDBOX_SWAP_UNBOUNDED');
  assert.equal(h.NanoCpus, LIMITS.cpus * 1e9, 'SANDBOX_CPU_UNBOUNDED');
  assert.equal(h.PidsLimit, LIMITS.pids, 'SANDBOX_PIDS_UNBOUNDED');
  assert.equal(h.RestartPolicy?.Name, 'no', 'SANDBOX_RESTART_ENABLED');
  assert.equal(h.LogConfig?.Type, 'none', 'SANDBOX_DAEMON_LOG_UNBOUNDED');
  assert.equal(h.PidMode ?? '', '', 'SANDBOX_HOST_PID');
  assert.equal(h.IpcMode, 'private', 'SANDBOX_SHARED_IPC');
  assert.deepEqual(h.Devices ?? [], [], 'SANDBOX_HOST_DEVICES');
  assert.deepEqual(h.DeviceRequests ?? [], [], 'SANDBOX_DEVICE_REQUESTS');
  assert.deepEqual(h.VolumesFrom ?? [], [], 'SANDBOX_INHERITED_VOLUMES');
  assert.deepEqual(h.DeviceCgroupRules ?? [], [], 'SANDBOX_DEVICE_CGROUP_RULES');
  assert.equal(Object.keys(h.PortBindings ?? {}).length, 0, 'SANDBOX_PUBLISHED_PORTS');
  assert.deepEqual(Object.keys(inspect.NetworkSettings?.Networks ?? {}).sort(), ['none'], 'SANDBOX_NETWORK_ATTACHMENT');
  const imageEnv = c.Env ?? [];
  assert(imageEnv.every((value) => /^(PATH|NODE_VERSION|YARN_VERSION)=/.test(value)
    || PROXY_KEYS.some((key) => value === `${key}=`)), 'SANDBOX_IMAGE_ENV_UNEXPECTED');
  assert.equal(new Set(imageEnv.map((value) => value.split('=', 1)[0])).size, imageEnv.length, 'SANDBOX_IMAGE_ENV_DUPLICATED');
  assert.deepEqual(c.Entrypoint, ['/usr/bin/env'], 'SANDBOX_ENTRYPOINT_UNTRUSTED');
  const args = dockerCreateArgs(expected);
  const entry = args.indexOf(expected.imageId);
  assert.deepEqual(c.Cmd, args.slice(entry + 1), 'SANDBOX_COMMAND_MISMATCH');
  const mounts = inspect.Mounts;
  assert.equal(mounts?.length, 3, 'SANDBOX_MOUNT_COUNT');
  for (const [target, source] of [['/inputs/source.tar', expected.sourceArchive],
    ['/inputs/dependencies.tar', expected.dependenciesArchive],
    ['/trusted/runner.mjs', expected.helperPath ?? HELPER]]) {
    const found = mounts.find((item) => item.Destination === target);
    assert(found && found.Type === 'bind' && found.RW === false && found.Source === source,
      'SANDBOX_MOUNT_UNSAFE');
  }
  assert.deepEqual(Object.keys(h.Tmpfs ?? {}).sort(), ['/tmp', '/work'], 'SANDBOX_TMPFS_MISSING');
  for (const [target, size] of [['/work', LIMITS.workBytes], ['/tmp', LIMITS.tempBytes]]) {
    const options = new Set(h.Tmpfs[target].split(','));
    for (const flag of ['rw', 'nosuid', 'nodev', `size=${size}`, 'uid=65532', 'gid=65532', 'mode=0700']) {
      assert(options.has(flag), 'SANDBOX_TMPFS_UNSAFE');
    }
    if (target === '/work') assert(options.has('exec') && !options.has('noexec'), 'SANDBOX_WORK_NOT_EXECUTABLE');
    if (target === '/tmp') assert(options.has('noexec'), 'SANDBOX_TMP_EXECUTABLE');
  }
  return { network: 'none', dns: 'loopback-only', user: c.User, imageId: inspect.Image,
    caps: 'none', rootFilesystem: 'readonly', limits: LIMITS, mountCount: 3 };
}

async function regularFile(path) {
  assert(isAbsolute(path), 'SANDBOX_INPUT_NOT_ABSOLUTE');
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink(), 'SANDBOX_INPUT_NOT_REGULAR');
  assert((info.mode & 0o004) !== 0, 'SANDBOX_INPUT_NOT_READABLE_BY_RUNTIME_UID');
  assert.equal(await realpath(path), path, 'SANDBOX_INPUT_SYMLINK_PARENT');
  return path;
}

function docker(args, { allowFailure = false, timeoutMs = 30000 } = {}) {
  const result = spawnSync('docker', [...DOCKER_CLIENT, ...args], { env: { ...DOCKER_ENV }, encoding: 'utf8', timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024 });
  if (!allowFailure) assert(result.status === 0 && !result.error,
    `SANDBOX_DOCKER_FAILED: ${args[0]} ${result.stderr?.slice(0, 500) ?? ''}`);
  return result;
}

async function dockerCreate(args, { timeoutMs, signal }) {
  if (signal?.aborted) return { status: null, stdout: '', stderr: '', error: new Error('SANDBOX_CREATE_CANCELLED') };
  const child = spawn('docker', [...DOCKER_CLIENT, ...args],
    { env: { ...DOCKER_ENV }, signal, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: [], stderr: [] };
  let bytes = 0;
  let error;
  for (const key of ['stdout', 'stderr']) child[key].on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes <= 8 * 1024 * 1024) output[key].push(chunk);
    else { error = new Error('SANDBOX_CREATE_RESPONSE_LIMIT'); child.kill('SIGKILL'); }
  });
  child.on('error', (failure) => { error = failure; });
  const timer = setTimeout(() => { error = new Error('SANDBOX_CREATE_TIMEOUT'); child.kill('SIGKILL'); }, timeoutMs);
  const status = await new Promise((accept) => child.once('close', (code) => accept(code)));
  clearTimeout(timer);
  return { status, stdout: Buffer.concat(output.stdout).toString(), stderr: Buffer.concat(output.stderr).toString(), error };
}

export async function createOwnedContainer(expected, dockerCommand = dockerCreate, signal) {
  requireOwnership(expected);
  const result = await dockerCommand(dockerCreateArgs(expected),
    { allowFailure: true, timeoutMs: CREATION_TIMEOUT_MS, signal });
  if (result.status !== 0 || result.error) {
    const failure = new Error('SANDBOX_CONTAINER_CREATION_FAILED');
    failure.creationEvidence = { status: result.status, stdout: result.stdout, stderr: result.stderr,
      errorCode: result.error?.code, errorMessage: result.error?.message };
    throw failure;
  }
  const id = result.stdout.trim();
  assert(/^[0-9a-f]{64}$/.test(id), 'SANDBOX_CONTAINER_ID_INVALID');
  return id;
}

/** Never search by prefix, delete by candidate-provided name, or adopt a foreign object. */
export function cleanupOwnedContainer(expected, creationConfirmed, dockerCommand = docker) {
  requireOwnership(expected);
  const result = dockerCommand(['inspect', expected.containerName], { allowFailure: true });
  if (result.status !== 0 || result.error) {
    const explicitlyAbsent = !result.error && /No such (object|container):/.test(result.stderr ?? '');
    return { containerRemoved: explicitlyAbsent && creationConfirmed,
      state: explicitlyAbsent ? (creationConfirmed ? 'absent' : 'creation-result-unknown') : 'inspection-unavailable',
      orphanRecoveryTarget: expected.containerName };
  }
  let inspect;
  try {
    inspect = JSON.parse(result.stdout)[0];
    assertOwnedContainer(inspect, expected);
  } catch {
    return { containerRemoved: false, state: 'ownership-not-verified', orphanRecoveryTarget: expected.containerName };
  }
  const removed = dockerCommand(['rm', '--force', expected.containerName],
    { allowFailure: true, timeoutMs: CREATION_TIMEOUT_MS });
  return { containerRemoved: removed.status === 0 && !removed.error,
    state: removed.status === 0 && !removed.error ? 'owned-container-removed' : 'removal-unavailable',
    containerId: inspect.Id, orphanRecoveryTarget: expected.containerName };
}

async function boundedContainerLog(containerId, logPath) {
  const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
  const child = spawn('docker', [...DOCKER_CLIENT, 'start', '--attach', containerId],
    { env: { ...DOCKER_ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
  let bytes = 0;
  let stopReason = null;
  const stop = (reason) => {
    if (stopReason) return;
    stopReason = reason;
    docker(['kill', containerId], { allowFailure: true });
    child.kill('SIGKILL');
  };
  const timer = setTimeout(() => stop('SANDBOX_WALL_LIMIT_EXCEEDED'), LIMITS.timeoutMs);
  let logError;
  log.on('error', (error) => { logError = error; stop('SANDBOX_LOG_WRITE_FAILED'); });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      const allowed = Math.min(chunk.length, Math.max(0, LIMITS.logBytes - bytes));
      bytes += chunk.length;
      if (allowed && !log.write(chunk.subarray(0, allowed))) {
        stream.pause();
        log.once('drain', () => stream.resume());
      }
      if (bytes > LIMITS.logBytes) stop('SANDBOX_LOG_LIMIT_EXCEEDED');
    });
  }
  let processError;
  child.on('error', (error) => { processError = error; stop('SANDBOX_START_FAILED'); });
  const exit = await new Promise((accept) => child.once('close', (code, signal) => accept({ code, signal })));
  clearTimeout(timer);
  await new Promise((accept) => log.end(accept));
  assert(!processError && !logError, 'SANDBOX_CAPTURE_FAILED');
  return { ...exit, stopReason, bytesRetained: Math.min(bytes, LIMITS.logBytes),
    candidateLogTrusted: false, workflowCommandsForwarded: false };
}

export function installCancellationHandler(stopContainer, signalTarget = process) {
  let signal;
  const handlers = new Map(['SIGINT', 'SIGTERM'].map((name) => [name, () => {
    if (signal) return;
    signal = name;
    stopContainer();
  }]));
  for (const [name, handler] of handlers) signalTarget.on(name, handler);
  return { get signal() { return signal; }, dispose() {
    for (const [name, handler] of handlers) signalTarget.off(name, handler);
  } };
}

export async function finalizeSandboxReceipt(receipt, cancellation, persistReceipt) {
  const markCancelled = () => {
    if (!cancellation.signal) return;
    receipt.cancelledSignal = cancellation.signal;
    receipt.status = 'failed';
    receipt.failure ??= 'SANDBOX_CANCELLED';
  };
  const signalBeforeWrite = cancellation.signal;
  markCancelled();
  await persistReceipt();
  // A signal can arrive while the asynchronous receipt write is in flight.
  if (cancellation.signal && cancellation.signal !== signalBeforeWrite) {
    markCancelled();
    await persistReceipt();
  }
  assert(!cancellation.signal, 'SANDBOX_CANCELLED');
}

export async function runSandbox({ imageId, sourceArchive, dependenciesArchive, controllerRoot,
  receiptDirectory, sourceSha, sourceTree, prNumber }) {
  requireIdentity({ imageId, sourceSha, sourceTree, prNumber });
  const helperPath = resolve(controllerRoot, 'scripts/gaming-exact-commit-sandbox.mjs');
  assert.equal(await regularFile(helperPath), HELPER, 'SANDBOX_CONTROLLER_HELPER_MISMATCH');
  await regularFile(sourceArchive);
  await regularFile(dependenciesArchive);
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await chmod(receiptDirectory, 0o700);
  const image = JSON.parse(docker(['image', 'inspect', imageId]).stdout)[0];
  assert.equal(image.Id, imageId, 'SANDBOX_LOCAL_IMAGE_MISMATCH');
  const containerName = generateOwnedContainerName();
  const cidFile = join(receiptDirectory, 'owned-container.cid');
  try { await lstat(cidFile); throw new Error('SANDBOX_CID_FILE_ALREADY_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const expected = { imageId, sourceArchive, dependenciesArchive, helperPath, sourceSha, sourceTree, prNumber,
    containerName, cidFile };
  const receipt = { version: 1, sourceSha, sourceTree, prNumber, imageId,
    sourceArchiveSha256: createHash('sha256').update(await readFile(sourceArchive)).digest('hex'),
    dependenciesArchiveSha256: createHash('sha256').update(await readFile(dependenciesArchive)).digest('hex'),
    status: 'failed', semanticResultsAreCandidateAuthored: true,
    hostedVerification: false, existingFullCIGateSatisfied: false,
    ownedContainerName: containerName, cidFile, creationStarted: false, creationConfirmed: false };
  const persistReceipt = () => writeFile(join(receiptDirectory, 'sandbox-receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  // This survives an interrupted or ambiguous create response without relying on stdout.
  await writeFile(join(receiptDirectory, 'container-ownership.json'), `${JSON.stringify({ version: 1,
    containerName, cidFile, sourceSha, sourceTree, imageId, creationTimeoutMs: CREATION_TIMEOUT_MS,
    labels: { 'arcanos.gaming-ci.owner': containerName, 'arcanos.gaming-ci.source-sha': sourceSha } }, null, 2)}\n`,
  { mode: 0o600, flag: 'wx' });
  await persistReceipt();
  const creationAbort = new AbortController();
  const cancellation = installCancellationHandler(() => {
    creationAbort.abort();
    // Generated host-owned name is known even when create returns no ID.
    docker(['kill', containerName], { allowFailure: true });
  });
  try {
    assert(!cancellation.signal, 'SANDBOX_CANCELLED_BEFORE_CREATION');
    receipt.creationStarted = true;
    await persistReceipt();
    assert(!cancellation.signal, 'SANDBOX_CANCELLED_BEFORE_CREATION');
    const created = await createOwnedContainer(expected, dockerCreate, creationAbort.signal);
    receipt.creationConfirmed = true;
    receipt.containerId = created;
    const inspected = JSON.parse(docker(['inspect', created]).stdout)[0];
    receipt.containment = validateSandbox(inspected, expected);
    assert(!cancellation.signal, 'SANDBOX_CANCELLED_BEFORE_EXECUTION');
    const execution = await boundedContainerLog(created, join(receiptDirectory, 'candidate-output.untrusted.log'));
    const completed = JSON.parse(docker(['inspect', created]).stdout)[0];
    validateSandbox(completed, expected);
    receipt.execution = { ...execution, exitCode: completed.State?.ExitCode,
      oomKilled: completed.State?.OOMKilled, effectiveProbeRequiredBeforeCandidate: true };
    assert(!cancellation.signal && execution.code === 0 && !execution.stopReason && completed.State?.ExitCode === 0
      && completed.State?.OOMKilled === false && completed.State?.Running === false,
    'SANDBOX_VERIFICATION_FAILED');
    receipt.status = 'passed';
    return receipt;
  } catch (error) {
    receipt.failure = error.message;
    if (error.creationEvidence) receipt.creationFailure = error.creationEvidence;
    throw error;
  } finally {
    try {
      receipt.cleanup = cleanupOwnedContainer(expected, receipt.creationConfirmed || !receipt.creationStarted);
      receipt.containerRemoved = receipt.cleanup.containerRemoved;
      if (!receipt.containerRemoved) {
        receipt.status = 'failed';
        receipt.failure ??= 'SANDBOX_CLEANUP_FAILED';
      }
      await finalizeSandboxReceipt(receipt, cancellation, persistReceipt);
      assert(receipt.containerRemoved, 'SANDBOX_CLEANUP_FAILED');
    } finally { cancellation.dispose(); }
  }
}

export function validateMockEnvironment(env) {
  assert.deepEqual(Object.keys(env).sort(), Object.keys(BASE_ENV).sort(), 'SANDBOX_ENV_UNEXPECTED');
  for (const [key, value] of Object.entries(BASE_ENV)) assert.equal(env[key], value, 'SANDBOX_ENV_NOT_MOCKED');
  return true;
}

async function effectiveProbe() {
  validateMockEnvironment(process.env);
  assert.equal(process.getuid(), 65532, 'SANDBOX_EFFECTIVE_UID');
  assert.equal(process.version, 'v24.18.1', 'SANDBOX_NODE_VERSION');
  assert.equal(spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim(), '11.16.0', 'SANDBOX_NPM_VERSION');
  const temporary = await lstat('/work/tmp');
  assert(temporary.isDirectory() && !temporary.isSymbolicLink()
    && (temporary.mode & 0o777) === 0o700 && temporary.uid === 65532
    && temporary.gid === 65532 && await realpath('/work/tmp') === '/work/tmp',
  'SANDBOX_EFFECTIVE_TMPDIR');
  const mounts = (await readFile('/proc/mounts', 'utf8')).split('\n').map((line) => line.split(' '));
  for (const target of ['/work', '/tmp']) {
    const entry = mounts.find((fields) => fields[1] === target);
    assert(entry && entry[2] === 'tmpfs', 'SANDBOX_EFFECTIVE_SCRATCH');
    const flags = new Set(entry[3].split(','));
    assert(['rw', 'nosuid', 'nodev'].every((flag) => flags.has(flag)), 'SANDBOX_EFFECTIVE_SCRATCH_FLAGS');
    assert(target === '/work' ? !flags.has('noexec') : flags.has('noexec'), 'SANDBOX_EFFECTIVE_SCRATCH_EXEC');
  }
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    assert(name === 'lo' && addresses.every((address) => address.internal), 'SANDBOX_EFFECTIVE_NETWORK');
  }
  const resolvers = (await readFile('/etc/resolv.conf', 'utf8')).split('\n')
    .filter((line) => /^nameserver\s/.test(line)).map((line) => line.trim().split(/\s+/)[1]);
  assert(resolvers.length > 0 && resolvers.every((address) => address === '127.0.0.1'), 'SANDBOX_EFFECTIVE_DNS');
  await new Promise((accept, reject) => {
    const socket = createConnection({ host: '198.18.0.1', port: 443 });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('SANDBOX_NETWORK_PROBE_INCONCLUSIVE')); }, 2000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); reject(new Error('SANDBOX_NETWORK_AVAILABLE')); });
    socket.once('error', (error) => {
      clearTimeout(timer);
      if (['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EACCES', 'EPERM'].includes(error.code)) accept();
      else reject(new Error(`SANDBOX_NETWORK_PROBE_UNEXPECTED: ${error.code}`));
    });
  });
  const resolver = new Resolver({ timeout: 500, tries: 1 });
  resolver.setServers(['127.0.0.1']);
  try { await resolver.resolve4('isolation.invalid'); throw new Error('SANDBOX_DNS_AVAILABLE'); }
  catch (error) { assert(['ECONNREFUSED', 'ETIMEOUT', 'ENETUNREACH'].includes(error.code), 'SANDBOX_DNS_PROBE_INCONCLUSIVE'); }
  await new Promise((accept, reject) => {
    const server = createServer((socket) => socket.end('local-only'));
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const socket = createConnection({ host: '127.0.0.1', port: server.address().port });
      socket.once('error', (error) => { server.close(); reject(error); });
      socket.once('data', (data) => { socket.destroy(); server.close();
        if (data.toString() === 'local-only') accept(); else reject(new Error('SANDBOX_LOOPBACK_FAILED')); });
    });
  });
  return { uid: 65532, externalTCP: 'no-route', resolver: 'loopback-only-unavailable',
    localLoopback: 'passed', mockedEnvironment: 'exact', scratchFilesystem: 'work-exec-tmp-noexec',
    temporaryDirectory: 'bounded-private-work-tmp', node: process.version, npm: '11.16.0' };
}

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, env: { ...BASE_ENV }, stdio: 'inherit' });
  assert(result.status === 0 && !result.error, `SANDBOX_PROFILE_COMMAND_FAILED: ${program} ${args.join(' ')}`);
}

/** Only audited existing hooks run, after physical egress containment. */
export async function initializeOfflineDependencies(cwd, runCommand = command) {
  runCommand('node', ['scripts/postinstall.cjs'], cwd);
  runCommand('node', ['node_modules/@prisma/client/scripts/postinstall.js'], cwd);
  // The audited hook suppresses several errors. Require its actual stub output.
  for (const [extension, provided] of [['js', 'default-index.js'], ['d.ts', 'default-index.d.ts']]) {
    const reference = await readFile(join(cwd, 'node_modules/@prisma/client/scripts', provided));
    for (const name of ['index', 'default']) {
      const generated = await readFile(join(cwd, 'node_modules/.prisma/client', `${name}.${extension}`));
      assert(reference.equals(generated), 'SANDBOX_PRISMA_INITIALIZATION_INVALID');
    }
  }
}

async function inside(identity) {
  requireIdentity(identity);
  await mkdir('/work/tmp', { mode: 0o700 });
  await writeFile('/tmp/user.npmrc', '', { mode: 0o600 });
  await writeFile('/tmp/global.npmrc', '', { mode: 0o600 });
  const probe = await effectiveProbe();
  console.log(JSON.stringify({ kind: 'effective-isolation-probe', ...probe }));
  const cwd = '/work/source';
  await mkdir(cwd, { mode: 0o700 });
  command('tar', ['--extract', '--file', '/inputs/source.tar', '--directory', cwd, '--no-same-owner', '--no-same-permissions'], '/work');
  command('tar', ['--extract', '--file', '/inputs/dependencies.tar', '--directory', cwd, '--no-same-owner', '--no-same-permissions'], '/work');
  for (const filename of GAMING_TESTS) assert((await lstat(join(cwd, filename))).isFile(), 'SANDBOX_TEST_MISSING');
  await initializeOfflineDependencies(cwd);
  command('npm', ['run', 'type-check'], cwd);
  command('npm', ['run', 'lint'], cwd);
  command('npm', ['run', 'build'], cwd);
  const testFiles = [...GAMING_TESTS];
  if (identity.prNumber === 1535) testFiles.push('tests/gaming-generic-benchmark.test.ts');
  command('node', ['scripts/run-jest.mjs', '--runTestsByPath', ...testFiles, '--runInBand', '--coverage=false'], cwd);
  command('npm', ['run', 'test:stacked-draft-preview'], cwd);
  command('npm', ['run', 'test:native-pr-preview-e2e'], cwd);
  command('npm', ['run', 'validate:railway'], cwd);
  console.log(JSON.stringify({ kind: 'candidate-profile-completed', sourceSha: identity.sourceSha,
    sourceTree: identity.sourceTree, gamingSuiteCount: testFiles.length,
    profile: 'focused-mocked-offline', authoritativeFullCI: false }));
}

if (process.argv[2] === '--inside') {
  inside(JSON.parse(process.argv[3])).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
// Local containment validation only. This mode is not exposed by dispatch inputs.
if (process.argv[2] === '--probe') {
  Promise.all([mkdir('/work/tmp', { mode: 0o700 }),
    writeFile('/tmp/user.npmrc', '', { mode: 0o600 }), writeFile('/tmp/global.npmrc', '', { mode: 0o600 })])
    .then(effectiveProbe).then((probe) => console.log(JSON.stringify(probe)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

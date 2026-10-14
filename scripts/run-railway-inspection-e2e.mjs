#!/usr/bin/env node
/** Run the unchanged inspection CLI against disposable, network-isolated fixtures. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureCaseWritesReceipt, requiredFixtureCases } from '../tests/fixtures/railway-production-inspection/cases.mjs';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = 'tests/fixtures/railway-production-inspection';
const SOURCES = ['scripts/railway-production-readonly-inspection.mjs', 'scripts/railway-auto-deploy-observer.mjs',
  'scripts/run-railway-inspection-e2e.mjs'];
const SHA = /^[0-9a-f]{40}$/u;
const IMAGE = /^sha256:[0-9a-f]{64}$/u;
const OWNER_LABEL = 'arcanos.inspection-e2e.owner';
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
const COMMAND_BYTES = 8 * 1024 * 1024;
const RUN_TIMEOUT_MS = 15 * 60_000;

export function parseOptions(argv) {
  const options = { postgresMajors: [17, 18] };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    assert(!seen.has(flag) && value !== undefined, 'FIXTURE_ARGUMENT_INVALID');
    seen.add(flag);
    if (flag === '--postgres-major') {
      assert(['17', '18'].includes(value), 'FIXTURE_POSTGRES_MAJOR_INVALID');
      options.postgresMajors = [Number(value)];
    } else if (flag === '--output-directory') {
      assert(isAbsolute(value) && !/[\r\n,]/u.test(value), 'FIXTURE_OUTPUT_DIRECTORY_INVALID');
      options.outputDirectory = resolve(value);
    } else {
      assert.fail('FIXTURE_ARGUMENT_INVALID');
    }
  }
  return options;
}

function command(binary, args, { cwd = REPOSITORY, env = process.env, input, timeoutMs = 30_000, allowFailure = false } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0;
    let failure;
    const stop = code => { failure ??= code; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('FIXTURE_COMMAND_TIMEOUT'), timeoutMs);
    for (const key of ['stdout', 'stderr']) {
      child[key].on('data', chunk => {
        bytes += chunk.length;
        if (bytes <= COMMAND_BYTES) chunks[key].push(chunk);
        else stop('FIXTURE_COMMAND_OUTPUT_LIMIT');
      });
    }
    child.on('error', () => { failure ??= 'FIXTURE_COMMAND_START_FAILED'; });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      const result = { status, signal, failure, stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr) };
      if (!allowFailure && (status !== 0 || failure)) reject(new Error(failure ?? 'FIXTURE_COMMAND_FAILED'));
      else accept(result);
    });
  });
}

function dockerEnvironment() {
  const env = { ...process.env };
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key];
  return env;
}

function docker(args, options = {}) {
  const env = dockerEnvironment();
  // Source provenance is recorded explicitly; this intentionally incomplete Git
  // object set is unsuitable for BuildKit's automatic history discovery.
  if (args[0] === 'build') env.BUILDX_GIT_INFO = 'false';
  return command('docker', ['--host=unix:///var/run/docker.sock', ...args], { ...options, env });
}

function git(args, options = {}) {
  return command('git', args, { ...options, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
}

function regularFiles(directory, prefix = '') {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name);
    const info = lstatSync(path);
    assert(!info.isSymbolicLink(), 'FIXTURE_INPUT_SYMLINK');
    const item = join(prefix, name);
    if (info.isDirectory()) return regularFiles(path, item);
    assert(info.isFile(), 'FIXTURE_INPUT_NOT_REGULAR');
    return [item];
  });
}

function copyInput(source, destination) {
  assert(lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink(), 'FIXTURE_INPUT_NOT_REGULAR');
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function packageDirectory(name, resolver) {
  let directory = dirname(realpathSync(resolver.resolve(name)));
  while (directory !== dirname(directory)) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return directory;
    directory = dirname(directory);
  }
  assert.fail('FIXTURE_DEPENDENCY_MANIFEST_MISSING');
}

/** Copy only installed pg's transitive JavaScript dependency graph, without install hooks. */
function copyPostgresDependencies(repository, context) {
  const modules = realpathSync(join(repository, 'node_modules'));
  const pending = [{ name: 'pg', resolver: createRequire(join(repository, 'package.json')) }];
  const visited = new Set();
  const packages = [];
  let bytes = 0;
  while (pending.length) {
    const { name, resolver } = pending.pop();
    const directory = packageDirectory(name, resolver);
    if (visited.has(directory)) continue;
    visited.add(directory);
    assert(visited.size <= 32 && directory.startsWith(`${modules}${sep}`), 'FIXTURE_DEPENDENCY_BOUNDARY_INVALID');
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    packages.push({ name: manifest.name, version: manifest.version });
    const target = join(context, 'node_modules', relative(modules, directory));
    for (const path of regularFiles(directory)) {
      if (path.split(sep).some(part => ['node_modules', 'test', 'tests', '.git', '.github', 'examples'].includes(part))) continue;
      if (!/\.(?:c?js|mjs|json)$/u.test(path)) continue;
      bytes += lstatSync(join(directory, path)).size;
      assert(bytes <= 16 * 1024 * 1024, 'FIXTURE_DEPENDENCY_BYTES_EXCEEDED');
      copyInput(join(directory, path), join(target, path));
    }
    const localResolver = createRequire(join(directory, 'package.json'));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) pending.push({ name: dependency, resolver: localResolver });
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      try { localResolver.resolve(dependency); pending.push({ name: dependency, resolver: localResolver }); }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

export async function prepareBuildContext(repository, context) {
  const sourceSha = (await git(['rev-parse', 'HEAD'], { cwd: repository })).stdout.toString().trim();
  assert(SHA.test(sourceSha), 'FIXTURE_SOURCE_SHA_INVALID');
  const paths = [...SOURCES, ...regularFiles(join(repository, FIXTURES)).map(path => join(FIXTURES, path))];
  assert(paths.includes(join(FIXTURES, 'run-fixtures.mjs')), 'FIXTURE_HARNESS_MISSING');
  const files = await Promise.all(paths.sort().map(async path => {
    const input = join(repository, path);
    copyInput(input, join(context, path));
    const head = await git(['cat-file', 'blob', `${sourceSha}:${path}`], { cwd: repository, allowFailure: true });
    return { path, sha256: createHash('sha256').update(readFileSync(join(context, path))).digest('hex'),
      headSha256: head.status === 0 && !head.failure ? createHash('sha256').update(head.stdout).digest('hex') : null };
  }));
  writeFileSync(join(context, 'package.json'), '{"private":true,"type":"module"}\n');
  const pgPackages = copyPostgresDependencies(repository, context);
  const dirty = await git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...SOURCES, FIXTURES, 'scripts/run-railway-inspection-e2e.mjs'], { cwd: repository });
  const relevantWorktreeDirty = dirty.stdout.length > 0 || files.some(file => file.sha256 !== file.headSha256);
  // Preserve the real source commit object and detached HEAD, without copying
  // repository configuration, hooks, historical blobs, or ignored local files.
  const commit = (await git(['cat-file', 'commit', sourceSha], { cwd: repository })).stdout;
  await git(['init', '--template=', '--initial-branch=fixture', context]);
  const copiedSha = (await git(['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: context, input: commit })).stdout.toString().trim();
  assert(copiedSha === sourceSha, 'FIXTURE_GIT_OBJECT_MISMATCH');
  writeFileSync(join(context, '.git', 'HEAD'), `${sourceSha}\n`);
  assert((await git(['rev-parse', 'HEAD'], { cwd: context })).stdout.toString().trim() === sourceSha, 'FIXTURE_GIT_HEAD_MISMATCH');
  const proof = { sourceSha, relevantWorktreeDirty, files, pgPackages,
    sourceProvenance: { gitMetadata: 'actual-HEAD-commit-object-only', worktreeSnapshot: 'selected-current-files',
      completeGitCheckout: false, syntheticGithubAuthority: true } };
  writeFileSync(join(context, 'source-context.json'), `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  return proof;
}

export function containerArguments({ name, imageId, proofDirectory, sourceSha, postgresMajor, relevantWorktreeDirty }) {
  assert(/^arcanos-inspection-e2e-[0-9a-f]{24}-pg(?:17|18)$/u.test(name), 'FIXTURE_CONTAINER_NAME_INVALID');
  assert(IMAGE.test(imageId) && SHA.test(sourceSha), 'FIXTURE_IMAGE_SOURCE_INVALID');
  assert([17, 18].includes(postgresMajor), 'FIXTURE_POSTGRES_MAJOR_INVALID');
  assert(isAbsolute(proofDirectory) && !/[\r\n,]/u.test(proofDirectory), 'FIXTURE_PROOF_DIRECTORY_INVALID');
  return ['create', '--name', name, '--label', `${OWNER_LABEL}=${name}`, '--label', `arcanos.inspection-e2e.source=${sourceSha}`,
    '--network', 'none', '--dns', '127.0.0.1', '--add-host', 'backboard.railway.com:127.0.0.1',
    '--add-host', 'shortline.proxy.rlwy.net:127.0.0.1', '--ipc', 'private', '--read-only',
    '--security-opt', 'no-new-privileges', '--cpus', '2', '--memory', '1g', '--memory-swap', '1g',
    '--pids-limit', '128', '--restart', 'no', '--log-driver', 'none',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=512m,mode=1777',
    ...PROXY_KEYS.flatMap(key => ['--env', `${key}=`]),
    '--mount', `type=bind,src=${proofDirectory},dst=/proof`, '--entrypoint', '/usr/bin/env', imageId,
    '-i', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG=C.UTF-8', 'TMPDIR=/tmp',
    `FIXTURE_POSTGRES_MAJOR=${postgresMajor}`, `FIXTURE_SOURCE_SHA=${sourceSha}`,
    `FIXTURE_SOURCE_DIRTY=${relevantWorktreeDirty}`, 'node', `/app/${FIXTURES}/run-fixtures.mjs`];
}

async function inspectOwnedContainer(name, imageId, sourceSha) {
  const inspected = JSON.parse((await docker(['inspect', name])).stdout.toString())[0];
  assert(inspected.Name === `/${name}` && inspected.Image === imageId
    && inspected.Config?.Labels?.[OWNER_LABEL] === name
    && inspected.Config.Labels['arcanos.inspection-e2e.source'] === sourceSha, 'FIXTURE_CONTAINER_OWNERSHIP_MISMATCH');
  return inspected;
}

/** Validate source-bound complete case evidence, including real PostgreSQL setup and teardown. */
export function validateFixtureProof(proof, expected) {
  assert(proof?.schema === 'arcanos-production-inspection-e2e/v1' && ['PASS', 'FAIL'].includes(proof.status)
    && proof.sourceSha === expected.sourceSha && proof.postgresMajor === expected.postgresMajor
    && proof.relevantWorktreeDirty === expected.relevantWorktreeDirty && proof.nodeVersion === 'v24.18.1', 'FIXTURE_PROOF_IDENTITY_MISMATCH');
  assert(proof.syntheticGithubAuthority === true && /^[0-9a-f]{64}$/u.test(proof.sourceContextSha256)
    && (expected.sourceContextSha256 === undefined || proof.sourceContextSha256 === expected.sourceContextSha256), 'FIXTURE_PROOF_PROVENANCE_INVALID');
  assert(Array.isArray(proof.cases) && (proof.status === 'FAIL' || proof.cases.length > 0) && proof.cases.length <= 64
    && proof.cases.every(item => typeof item?.name === 'string' && item.name.length <= 128
      && ['PASS', 'FAIL'].includes(item.status)), 'FIXTURE_PROOF_CASES_INVALID');
  const requiredCases = requiredFixtureCases(expected.postgresMajor);
  if (proof.status === 'PASS') {
    assert(typeof proof.postgresVersion === 'string' && proof.postgresVersion.length <= 128
      && proof.postgresVersion.startsWith(`${expected.postgresMajor}.`), 'FIXTURE_PROOF_POSTGRES_VERSION_INVALID');
    assert.deepEqual(proof.setupChecks, [{ name: 'database-server-key-mismatch', status: 'PASS',
      postgresStartupRejected: true, collectorExecuted: false }], 'FIXTURE_PROOF_SETUP_CHECKS_INVALID');
    assert.deepEqual(proof.teardown, { postgresStopped: true, fixtureDirectoryRemoved: true,
      pausedBackendsRemaining: 0 }, 'FIXTURE_PROOF_TEARDOWN_INVALID');
  }
  const observedCases = proof.cases.map(item => item.name);
  assert(proof.status !== 'PASS' || observedCases.length === requiredCases.length, 'FIXTURE_PROOF_CASES_INCOMPLETE');
  assert(observedCases.length <= requiredCases.length
    && observedCases.every((name, index) => name === requiredCases[index]), 'FIXTURE_PROOF_CASE_ORDER_INVALID');
  assert(proof.status !== 'PASS' || proof.cases.every(item => item.status === 'PASS'), 'FIXTURE_PROOF_VERDICT_INVALID');
  assert(proof.cases.every(item => item.status !== 'PASS'
    || (item.databaseFingerprintUnchanged === true && item.collectorSessionsRemaining === 0)), 'FIXTURE_PROOF_DATABASE_EFFECT_INVALID');
  assert(proof.cases.every(item => item.status !== 'PASS' || !fixtureCaseWritesReceipt(item.name)
    || (/^[0-9a-f]{64}$/u.test(item.receiptSha256) && ['COLLECTION_COMPLETE', 'BLOCKED'].includes(item.receiptStatus))),
  'FIXTURE_PROOF_RECEIPT_IDENTITY_INVALID');
  return proof;
}

/** Retain bounded proof only after independently hashing each reported collector receipt. */
export function retainProof(directory, destination, expected) {
  const paths = regularFiles(directory);
  assert(paths.length <= 64 && paths.includes('proof.json'), 'FIXTURE_PROOF_FILES_INVALID');
  let bytes = 0;
  for (const path of paths) {
    assert(path.endsWith('.json'), 'FIXTURE_PROOF_FILE_TYPE_INVALID');
    const size = lstatSync(join(directory, path)).size;
    assert(size <= 256 * 1024, 'FIXTURE_PROOF_FILE_TOO_LARGE');
    bytes += size;
  }
  assert(bytes <= 2 * 1024 * 1024, 'FIXTURE_PROOF_BYTES_EXCEEDED');
  const proof = validateFixtureProof(JSON.parse(readFileSync(join(directory, 'proof.json'), 'utf8')), expected);
  for (const item of proof.cases.filter(entry => entry.status === 'PASS' && fixtureCaseWritesReceipt(entry.name))) {
    const receipt = readFileSync(join(directory, `${item.name}.json`));
    assert(createHash('sha256').update(receipt).digest('hex') === item.receiptSha256
      && JSON.parse(receipt.toString('utf8')).status === item.receiptStatus, 'FIXTURE_PROOF_RECEIPT_HASH_MISMATCH');
  }
  mkdirSync(destination, { mode: 0o700 });
  for (const path of paths) copyInput(join(directory, path), join(destination, path));
  return proof;
}

export async function runFixtures(options) {
  const outputDirectory = options.outputDirectory ?? mkdtempSync(join(tmpdir(), 'arcanos-inspection-e2e-proof-'));
  if (options.outputDirectory) {
    assert(!existsSync(outputDirectory), 'FIXTURE_OUTPUT_DIRECTORY_EXISTS');
    assert(realpathSync(dirname(outputDirectory)) === dirname(outputDirectory), 'FIXTURE_OUTPUT_DIRECTORY_SYMLINK');
    mkdirSync(outputDirectory, { mode: 0o700 });
    assert(realpathSync(outputDirectory) === outputDirectory, 'FIXTURE_OUTPUT_DIRECTORY_SYMLINK');
  }
  const temporary = mkdtempSync(join(tmpdir(), 'arcanos-inspection-e2e-work-'));
  const context = join(temporary, 'context');
  const results = [];
  try {
    await docker(['info', '--format', '{{.ServerVersion}}']);
    mkdirSync(context);
    const source = await prepareBuildContext(REPOSITORY, context);
    writeFileSync(join(outputDirectory, 'source-context.json'), `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 });
    for (const postgresMajor of options.postgresMajors) {
      const name = `arcanos-inspection-e2e-${randomBytes(12).toString('hex')}-pg${postgresMajor}`;
      const proofDirectory = join(temporary, `proof-pg${postgresMajor}`);
      mkdirSync(proofDirectory, { mode: 0o700 });
      const iidfile = join(temporary, `pg${postgresMajor}.iid`);
      assert(existsSync('/etc/ssl/certs/ca-certificates.crt'), 'FIXTURE_SYSTEM_TRUST_MISSING');
      const buildArgs = ['build', '--file', join(context, FIXTURES, 'Dockerfile'), '--build-arg', `POSTGRES_MAJOR=${postgresMajor}`, '--iidfile', iidfile,
        '--secret', 'id=system_ca,src=/etc/ssl/certs/ca-certificates.crt'];
      if (process.env.CODEX_PROXY_CERT && existsSync(process.env.CODEX_PROXY_CERT)) buildArgs.push('--secret', `id=proxy_ca,src=${process.env.CODEX_PROXY_CERT}`);
      buildArgs.push(context);
      console.log(JSON.stringify({ stage: 'build', postgresMajor, sourceSha: source.sourceSha, relevantWorktreeDirty: source.relevantWorktreeDirty }));
      await docker(buildArgs, { timeoutMs: RUN_TIMEOUT_MS });
      const imageId = readFileSync(iidfile, 'utf8').trim();
      assert(IMAGE.test(imageId), 'FIXTURE_BUILD_IMAGE_INVALID');
      try {
        const args = containerArguments({ name, imageId, proofDirectory, postgresMajor, ...source });
        await docker(args, { timeoutMs: 120_000 });
        const inspected = await inspectOwnedContainer(name, imageId, source.sourceSha);
        assert(inspected.HostConfig.NetworkMode === 'none' && inspected.HostConfig.ReadonlyRootfs === true
          && Object.keys(inspected.HostConfig.PortBindings ?? {}).length === 0, 'FIXTURE_CONTAINER_ISOLATION_MISMATCH');
        assert(inspected.Mounts.filter(mount => mount.Type === 'bind').length === 1
          && inspected.Mounts.some(mount => mount.Type === 'bind' && mount.Source === proofDirectory && mount.Destination === '/proof'), 'FIXTURE_CONTAINER_MOUNT_MISMATCH');
        console.log(JSON.stringify({ stage: 'execute', postgresMajor, network: 'none', imageId }));
        const execution = await docker(['start', '--attach', name], { timeoutMs: RUN_TIMEOUT_MS, allowFailure: true });
        if (execution.status !== 0 || execution.failure) {
          const code = execution.stderr.toString().trim();
          console.error(JSON.stringify({ stage: 'fixture-error', postgresMajor,
            errorCode: /^(?:FIXTURE_[A-Z0-9_]+|[a-z][a-z0-9-]*_[A-Z0-9_]+)$/u.test(code) ? code : 'FIXTURE_CONTAINER_EXECUTION_FAILED' }));
        }
        // Container root writes private 0600 artifacts. Docker's default copy
        // assigns the copied files to the invoking host user without relaxing
        // the receipt's permissions or passing host ownership into the fixture.
        const extractedDirectory = join(temporary, `extracted-pg${postgresMajor}`);
        mkdirSync(extractedDirectory, { mode: 0o700 });
        await docker(['cp', `${name}:/proof/.`, extractedDirectory]);
        const proof = retainProof(extractedDirectory, join(outputDirectory, `pg${postgresMajor}`), { postgresMajor, ...source,
          sourceContextSha256: createHash('sha256').update(readFileSync(join(context, 'source-context.json'))).digest('hex') });
        results.push({ postgresMajor, status: proof.status, caseCount: proof.cases.length, imageId,
          network: 'none', publishedPorts: 0, credentialEnvironment: 'empty' });
        console.log(JSON.stringify({ stage: 'result', ...results.at(-1) }));
        assert(!execution.failure && execution.status === 0 && proof.status === 'PASS', 'FIXTURE_E2E_FAILED');
      } finally {
        const found = await docker(['inspect', name], { allowFailure: true });
        if (found.status === 0 && !found.failure) {
          await inspectOwnedContainer(name, imageId, source.sourceSha);
          await docker(['rm', '--force', '--volumes', name], { timeoutMs: 120_000 });
        } else {
          assert(!found.failure && /No such (?:object|container):/u.test(found.stderr.toString()), 'FIXTURE_CONTAINER_CLEANUP_UNVERIFIED');
        }
      }
      results.at(-1).containerRemoved = true;
    }
    const summary = { schema: 'arcanos-production-inspection-e2e-matrix/v1', status: 'PASS', ...source, results };
    writeFileSync(join(outputDirectory, 'matrix.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { outputDirectory, ...summary };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve().then(() => runFixtures(parseOptions(process.argv.slice(2)))).then(result => {
    console.log(JSON.stringify({ status: result.status, sourceSha: result.sourceSha, outputDirectory: result.outputDirectory, results: result.results }));
  }).catch(error => {
    // Docker/Git output can contain infrastructure credentials. Report only
    // controlled error codes; the fixtures retain bounded sanitized evidence.
    const code = /^FIXTURE_[A-Z0-9_]+$/u.test(error.message) ? error.message : 'FIXTURE_RUN_FAILED';
    console.error(code);
    process.exitCode = 1;
  });
}

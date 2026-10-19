#!/usr/bin/env node
// Trusted artifact plumbing. Candidate code runs only inside the secretless
// Docker build; only independently digest-pinned checkers may be imported.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { devNull, homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const COMPILED_DIRECTORIES = ['dist', 'workers/dist', ...['protocol', 'cli', 'arcanos-runtime', 'arcanos-openai'].map(name => `packages/${name}/dist`)];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const gamingRuntimeEnvironmentName = runId => `pr-${sha256(runId).slice(0, 6)}-1558`;
const TOOL_PATHS = ['scripts/check-native-pr-preview-imports.mjs', 'scripts/check-native-pr-preview-dist-imports.mjs',
  'scripts/native-pr-preview-imports-tsconfig.json', 'package-lock.json'];
const BUILD_PROFILES = Object.freeze({
  'stacked-draft': Object.freeze({ directory: 'stacked-preview', tag: 'arcanos-stacked-preview',
    runtime: 'stacked-draft-preview-runtime.mjs', dockerfile: 'stacked-draft-preview.Dockerfile',
    toolingPolicy: 'railway-stacked-draft-preview-tools.json' }),
  gaming: Object.freeze({ directory: 'gaming-preview', tag: 'arcanos-gaming-preview',
    runtime: 'gaming-preview-runtime.mjs', dockerfile: 'gaming-preview.Dockerfile',
    toolingPolicy: 'railway-gaming-preview-tools.json' }),
});

function buildProfile(name) {
  requireCondition(Object.hasOwn(BUILD_PROFILES, name), 'PREVIEW_BUILD_PROFILE_INVALID');
  return BUILD_PROFILES[name];
}

export function previewSourceArchiveArguments(candidate, profile = 'stacked-draft') {
  buildProfile(profile);
  requireCondition(SHA.test(candidate), 'STACKED_BUILD_IDENTITY_INVALID');
  return [...(profile === 'gaming' ? ['-c', 'core.autocrlf=false'] : []), 'archive', '--format=tar', candidate];
}

export async function materializeGamingSourceArchive({ candidate, file, spawnArchive = spawn,
  maxBytes = 512 * 1024 * 1024, timeoutMs = 60_000 }) {
  requireCondition(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 512 * 1024 * 1024
    && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000, 'GAMING_BUILD_SOURCE_ARCHIVE_BOUND_INVALID');
  const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(gitEnvironment, { GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull, GIT_TERMINAL_PROMPT: '0' });
  const child = spawnArchive('git', previewSourceArchiveArguments(candidate, 'gaming'),
    { env: gitEnvironment, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const hash = createHash('sha256'); let bytes = 0;
  const output = createWriteStream(file, { flags: 'wx', mode: 0o600 });
  const bounded = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxBytes) callback(new Error('GAMING_BUILD_SOURCE_ARCHIVE_LIMIT'));
    else { hash.update(chunk); callback(null, chunk); }
  } });
  const exited = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('GAMING_BUILD_SOURCE_ARCHIVE_READ_FAILED')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error('GAMING_BUILD_SOURCE_ARCHIVE_READ_FAILED')));
  });
  child.stderr.resume();
  const timer = setTimeout(() => {
    bounded.destroy(new Error('GAMING_BUILD_SOURCE_ARCHIVE_TIMEOUT'));
    child.kill('SIGKILL');
  }, timeoutMs);
  try {
    await Promise.all([pipeline(child.stdout, bounded, output), exited]);
    requireCondition(bytes > 0, 'GAMING_BUILD_SOURCE_ARCHIVE_READ_FAILED');
    return { sha256: hash.digest('hex'), bytes };
  } catch (error) {
    child.kill('SIGKILL');
    throw /^(?:GAMING_BUILD_SOURCE_ARCHIVE_)[A-Z_]+$/u.test(error?.message ?? '')
      ? error : new Error('GAMING_BUILD_SOURCE_ARCHIVE_READ_FAILED');
  } finally { clearTimeout(timer); }
}

function candidateBinding(authorization) {
  if (Object.hasOwn(authorization, 'stack')) {
    requireCondition(Array.isArray(authorization.stack) && authorization.stack.length > 0,
      'STACKED_BUILD_IDENTITY_INVALID');
    return authorization.stack.at(-1);
  }
  // Direct ordinary-PR fields are accepted only through the fixed Gaming
  // schema; this does not relax historical stack admission or its defaults.
  validateGamingBuildAuthorization(authorization);
  return { headSha: authorization.headSha, treeSha: authorization.treeSha };
}

function requireCondition(value, code) { if (!value) throw new Error(code); }
function readJson(file) {
  requireCondition(lstatSync(file).isFile() && lstatSync(file).size <= 128 * 1024, 'STACKED_BUILD_JSON_INVALID');
  return JSON.parse(readFileSync(file, 'utf8'));
}
export function hashCompiledArtifacts(root) {
  const rows = [];
  let bytes = 0;
  const visit = relative => {
    const absolute = path.join(root, relative);
    const stat = lstatSync(absolute);
    requireCondition(!stat.isSymbolicLink(), 'STACKED_BUILD_ARTIFACT_SYMLINK');
    if (stat.isDirectory()) {
      for (const child of readdirSync(absolute).sort()) visit(`${relative}/${child}`);
    } else {
      requireCondition(stat.isFile(), 'STACKED_BUILD_ARTIFACT_TYPE');
      bytes += stat.size;
      requireCondition(bytes <= MAX_ARTIFACT_BYTES && rows.length < 100_000, 'STACKED_BUILD_ARTIFACT_LIMIT');
      rows.push({ path: relative, sha256: sha256(readFileSync(absolute)), bytes: stat.size });
    }
  };
  for (const directory of COMPILED_DIRECTORIES) {
    requireCondition(existsSync(path.join(root, directory)), 'STACKED_BUILD_ARTIFACT_MISSING');
    visit(directory);
  }
  requireCondition(rows.length > 0, 'STACKED_BUILD_ARTIFACT_EMPTY');
  return { compiledSha256: sha256(JSON.stringify(rows)), compiledFiles: rows.length, compiledBytes: bytes };
}

export function validateBuildReceipt(receipt, authorization) {
  const final = candidateBinding(authorization);
  requireCondition(receipt?.schemaVersion === 1
    && receipt.controllerSha === authorization.controllerSha
    && receipt.candidateSha === final.headSha && SHA.test(receipt.candidateSha)
    && receipt.treeSha === final.treeSha && SHA.test(receipt.treeSha)
    && receipt.sourceArchiveSha256 === authorization.sourceArchiveSha256
    && DIGEST.test(receipt.compiledSha256) && DIGEST.test(receipt.imageArchiveSha256)
    && IMAGE_ID.test(receipt.imageId)
    && receipt.runtimeDevDependenciesPruned === true
    && Number.isSafeInteger(receipt.compiledFiles) && receipt.compiledFiles > 0
    && Number.isSafeInteger(receipt.compiledBytes) && receipt.compiledBytes > 0,
  'STACKED_BUILD_RECEIPT_MISMATCH');
  return receipt;
}

export function verifyImageArchive(file, receipt, authorization) {
  validateBuildReceipt(receipt, authorization);
  const stat = lstatSync(file);
  requireCondition(stat.isFile() && stat.size > 0 && stat.size <= MAX_ARTIFACT_BYTES,
    'STACKED_BUILD_IMAGE_ARCHIVE_INVALID');
  requireCondition(sha256(readFileSync(file)) === receipt.imageArchiveSha256,
    'STACKED_BUILD_IMAGE_ARCHIVE_MISMATCH');
  return receipt;
}

function command(program, args, options = {}) {
  const { diagnosticsFile, ...spawnOptions } = options;
  if (program === 'docker') {
    // The build must use this runner's disposable daemon, never an ambient
    // remote Docker context or a production-connected DOCKER_HOST.
    args = ['--host=unix:///var/run/docker.sock', ...args];
    const environment = { ...process.env };
    for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete environment[key];
    spawnOptions.env = environment;
  }
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 20 * 60_000,
    maxBuffer: 8 * 1024 * 1024, ...spawnOptions });
  if (diagnosticsFile) writeFileSync(diagnosticsFile, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  // Do not echo candidate output or command arguments from a credentialed job.
  requireCondition(result.status === 0 && !result.error, 'STACKED_BUILD_COMMAND_FAILED');
  return result.stdout.trim();
}

export function createCompiledManifest({ root, authorization, productionDependencies }) {
  const final = candidateBinding(authorization);
  requireCondition(SHA.test(authorization.controllerSha) && SHA.test(final.headSha)
    && SHA.test(final.treeSha) && DIGEST.test(authorization.sourceArchiveSha256),
  'STACKED_BUILD_IDENTITY_INVALID');
  // npm ls --omit=dev --all --json must have succeeded before this read.
  const inspect = node => {
    requireCondition(!node?.dev && !node?.missing && !node?.invalid && !node?.extraneous,
      'STACKED_BUILD_RUNTIME_DEPENDENCY_INVALID');
    for (const dependency of Object.values(node?.dependencies ?? {})) inspect(dependency);
  };
  inspect(productionDependencies);
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assertNoInstalledDevDependencies(root, lock);
  return { schemaVersion: 1, controllerSha: authorization.controllerSha,
    candidateSha: final.headSha, treeSha: final.treeSha,
    sourceArchiveSha256: authorization.sourceArchiveSha256, expiresAt: authorization.expiresAt,
    ...hashCompiledArtifacts(root), runtimeDevDependenciesPruned: true,
    runtimeDependencyInventorySha256: sha256(JSON.stringify(productionDependencies)) };
}

export function assertNoInstalledDevDependencies(root, lock) {
  requireCondition(lock?.lockfileVersion === 3 && typeof lock.packages === 'object',
    'STACKED_BUILD_LOCK_INVALID');
  for (const [relative, entry] of Object.entries(lock.packages)) {
    requireCondition(!path.isAbsolute(relative) && !relative.split('/').includes('..'),
      'STACKED_BUILD_LOCK_INVALID');
    if (entry.dev === true && relative.split('/').includes('node_modules')) {
      requireCondition(!existsSync(path.join(root, relative)), 'STACKED_BUILD_RETAINED_DEV_DEPENDENCY');
    }
  }
}

export function validateReviewedTooling(root, policy) {
  requireCondition(policy?.version === 1 && SHA.test(policy.reviewedCandidateSha)
    && Array.isArray(policy.files) && policy.files.length === TOOL_PATHS.length
    && policy.files.every((entry, index) => entry.path === TOOL_PATHS[index] && DIGEST.test(entry.sha256)),
  'STACKED_BUILD_TOOL_POLICY_INVALID');
  for (const entry of policy.files) {
    const file = path.join(root, entry.path);
    requireCondition(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink()
      && sha256(readFileSync(file)) === entry.sha256, 'STACKED_BUILD_REVIEWED_TOOL_DRIFT');
  }
  return sha256(JSON.stringify(policy));
}

export async function verifyReviewedPreviewTooling(root, policy, toolsRoot) {
  const digest = validateReviewedTooling(root, policy);
  // The copies are digest-pinned before import. Their dependency resolution is
  // rooted in a pristine, trusted lockfile install rather than candidate output.
  mkdirSync(path.join(toolsRoot, 'scripts'), { recursive: true });
  for (const file of TOOL_PATHS.slice(0, 2)) copyFileSync(path.join(root, file), path.join(toolsRoot, file));
  const source = await import(pathToFileURL(path.join(toolsRoot, TOOL_PATHS[0])).href);
  const compiled = await import(pathToFileURL(path.join(toolsRoot, TOOL_PATHS[1])).href);
  const sourceViolations = await source.findNativePrPreviewImportViolations({ repositoryRoot: root });
  const compiledViolations = await compiled.findNativePrPreviewDistImportViolations({ repositoryRoot: root });
  requireCondition(sourceViolations.length === 0 && compiledViolations.length === 0,
    'STACKED_BUILD_REVIEWED_IMPORTS_FAILED');
  return digest;
}

export function productionInventoryArguments(globalConfig) {
  requireCondition(path.isAbsolute(globalConfig) && globalConfig !== '/dev/null',
    'STACKED_BUILD_NPM_CONFIGURATION_INVALID');
  // npm 11 rejects loading the same pathname as both user and global config.
  return ['/usr/local/lib/node_modules/npm/bin/npm-cli.js', 'ls', '--omit=dev', '--all', '--json',
    '--ignore-scripts', '--userconfig=/dev/null', `--globalconfig=${globalConfig}`];
}

export async function buildPreviewArtifact({ authorization, outputDirectory, profile = 'stacked-draft' }) {
  const selected = buildProfile(profile);
  const candidate = candidateBinding(authorization).headSha;
  requireCondition(SHA.test(candidate), 'STACKED_BUILD_IDENTITY_INVALID');
  if (profile === 'gaming') validateGamingBuildAuthorization(authorization);
  const context = path.resolve(outputDirectory, 'context');
  requireCondition(!existsSync(context), 'STACKED_BUILD_CONTEXT_ALREADY_EXISTS');
  mkdirSync(path.join(context, 'candidate'), { recursive: true });
  const sourceFile = profile === 'gaming' ? path.resolve(outputDirectory, 'source.tar') : null;
  let archive;
  if (sourceFile) {
    const materialized = await materializeGamingSourceArchive({ candidate, file: sourceFile });
    requireCondition(materialized.sha256 === authorization.sourceArchiveSha256, 'GAMING_BUILD_SOURCE_ARCHIVE_MISMATCH');
  } else {
    archive = spawnSync('git', previewSourceArchiveArguments(candidate, profile),
      { encoding: null, maxBuffer: 128 * 1024 * 1024, timeout: 30_000 });
    requireCondition(archive.status === 0 && sha256(archive.stdout) === authorization.sourceArchiveSha256,
      'STACKED_BUILD_SOURCE_ARCHIVE_MISMATCH');
  }
  // Check Git tree entries before extraction: reject symlinks, submodules and
  // path traversal before they can escape the disposable build context.
  const entries = command('git', ['ls-tree', '-r', '-z', candidate]).split('\0').filter(Boolean);
  for (const entry of entries) {
    const match = /^(100644|100755) blob [0-9a-f]{40}\t(.+)$/su.exec(entry);
    requireCondition(match && !match[2].split('/').includes('..') && !path.isAbsolute(match[2]),
      'STACKED_BUILD_SOURCE_ENTRY_UNSAFE');
  }
  // The Gaming archive is streamed to the retained file, then extracted from
  // those exact bytes rather than truncated by a child-process stdout buffer.
  const extracted = spawnSync('tar', ['-xf', sourceFile ?? '-', '-C', path.join(context, 'candidate')],
    { ...(sourceFile ? {} : { input: archive.stdout }), timeout: sourceFile ? 60_000 : 30_000 });
  requireCondition(extracted.status === 0, 'STACKED_BUILD_SOURCE_EXTRACTION_FAILED');
  writeFileSync(path.join(context, 'authorization.json'), `${JSON.stringify(authorization)}\n`);
  writeFileSync(path.join(context, 'build-tools.mjs'), readFileSync(new URL('./stacked-draft-preview-build.mjs', import.meta.url)));
  writeFileSync(path.join(context, 'runtime.mjs'), readFileSync(new URL(`./${selected.runtime}`, import.meta.url)));
  if (profile === 'gaming') copyFileSync(new URL('./gaming-preview-network.c', import.meta.url), path.join(context, 'network.c'));
  const tooling = path.join(context, 'tooling');
  mkdirSync(tooling, { recursive: true });
  for (const relative of ['package.json', 'package-lock.json',
    ...['protocol', 'cli', 'arcanos-runtime', 'arcanos-openai'].map(name => `packages/${name}/package.json`),
    'workers/package.json', 'arcanos-ai-runtime/package.json']) {
    const destination = path.join(tooling, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(new URL(`../${relative}`, import.meta.url), destination);
  }
  // The reviewed local graph dependency includes checked-in JavaScript.
  cpSync(new URL('../vendor/minimatch-9.0.7/', import.meta.url),
    path.join(tooling, 'vendor/minimatch-9.0.7'), { recursive: true,
      filter: source => !source.split(path.sep).some(part => ['node_modules', '.git'].includes(part)) });
  copyFileSync(new URL(`../config/${selected.toolingPolicy}`, import.meta.url), path.join(tooling, 'trust.json'));
  writeFileSync(path.join(context, 'Dockerfile'), readFileSync(new URL(`./${selected.dockerfile}`, import.meta.url)));
  const tag = `${selected.tag}:${candidate}`;
  // The container driver enforces limits that BuildKit's docker driver ignores.
  const builder = `${selected.directory}-${candidate.slice(0, 12)}-${process.pid}`;
  const createArgs = ['buildx', 'create', '--name', builder, '--driver', 'docker-container',
    '--driver-opt', 'memory=2g,cpu-period=100000,cpu-quota=200000'];
  // Read proxy configuration only; registry credentials never enter the build.
  const dockerConfig = path.join(process.env.DOCKER_CONFIG ?? path.join(homedir(), '.docker'), 'config.json');
  const defaults = existsSync(dockerConfig) ? JSON.parse(readFileSync(dockerConfig, 'utf8')).proxies?.default ?? {} : {};
  for (const [key, name] of [['httpProxy', 'HTTP_PROXY'], ['httpsProxy', 'HTTPS_PROXY'], ['noProxy', 'NO_PROXY']]) {
    const value = defaults[key] ?? process.env[name];
    if (value) createArgs.push('--driver-opt', `"env.${name}=${value.replaceAll('"', '""')}"`);
  }
  if (process.env.CODEX_PROXY_CERT && existsSync(process.env.CODEX_PROXY_CERT)) {
    const configuration = path.resolve(outputDirectory, 'buildkitd.toml');
    writeFileSync(configuration, `[registry."docker.io"]\n  ca = [${JSON.stringify(process.env.CODEX_PROXY_CERT)}]\n`);
    createArgs.push('--buildkitd-config', configuration);
  }
  command('docker', createArgs, { diagnosticsFile: path.resolve(outputDirectory, 'builder-create.log') });
  try {
    const buildArgs = ['buildx', 'build', '--builder', builder, '--load', '--platform', 'linux/amd64',
      '--build-arg', `CANDIDATE_SHA=${candidate}`, '--tag', tag];
    if (process.env.CODEX_PROXY_CERT && existsSync(process.env.CODEX_PROXY_CERT)) {
      buildArgs.push('--secret', `id=proxy_ca,src=${process.env.CODEX_PROXY_CERT}`);
    }
    buildArgs.push(context);
    command('docker', buildArgs, { stdio: ['ignore', 'pipe', 'pipe'], diagnosticsFile: path.resolve(outputDirectory, 'build.log') });
  } finally { command('docker', ['buildx', 'rm', '--force', builder]); }
  const imageId = command('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]);
  requireCondition(IMAGE_ID.test(imageId), 'STACKED_BUILD_IMAGE_ID_INVALID');
  const containerId = command('docker', ['create', imageId]);
  try {
    command('docker', ['cp', `${containerId}:/opt/${selected.directory}/compiled.json`, path.resolve(outputDirectory, 'compiled.json')]);
  } finally { command('docker', ['rm', containerId]); }
  const imageFile = path.resolve(outputDirectory, 'image.tar');
  command('docker', ['save', '--output', imageFile, imageId]);
  const receipt = { ...readJson(path.resolve(outputDirectory, 'compiled.json')), imageId,
    imageArchiveSha256: sha256(readFileSync(imageFile)) };
  validateBuildReceipt(receipt, authorization);
  if (profile === 'gaming') validateGamingBuildReceipt(receipt, authorization);
  writeFileSync(path.resolve(outputDirectory, 'build.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function validateGamingBuildAuthorization(authorization) {
  requireCondition(authorization?.version === 1
    && Object.keys(authorization).sort().join('|') === ['version', 'controllerSha', 'mainSha', 'baseSha',
      'headSha', 'treeSha', 'sourceArchiveSha256', 'expiresAt', 'targetSha256', 'runId', 'target'].sort().join('|')
    && SHA.test(authorization.controllerSha) && authorization.mainSha === authorization.controllerSha
    && authorization.baseSha === authorization.controllerSha
    && authorization.headSha === '1c1e7d0f4c8f4e62fd7117e28efd0d8d7c415262'
    && authorization.treeSha === '89f1eb0b988514d92ef9f82dd2f77bc356735b8b'
    && DIGEST.test(authorization.sourceArchiveSha256) && DIGEST.test(authorization.targetSha256)
    && /^[1-9][0-9]{0,19}$/u.test(authorization.runId ?? '')
    && Number.isFinite(Date.parse(authorization.expiresAt))
    && authorization.target && Object.keys(authorization.target).sort().join('|')
      === ['projectId', 'baseEnvironmentId', 'workerServiceId', 'webServiceId'].sort().join('|')
    && Object.values(authorization.target).every(value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value))
    && authorization.target.workerServiceId !== authorization.target.webServiceId,
  'GAMING_BUILD_AUTHORIZATION_INVALID');
  return authorization;
}

export function validateGamingBuildReceipt(receipt, authorization) {
  validateGamingBuildAuthorization(authorization);
  validateBuildReceipt(receipt, authorization);
  requireCondition(receipt.previewLane === 'gaming-synthetic-v1'
    && receipt.runtimeEgressPolicy === 'linux-seccomp-no-outbound-v1'
    && receipt.targetSha256 === authorization.targetSha256 && receipt.runId === authorization.runId
    && receipt.expiresAt === authorization.expiresAt
    && receipt.runtimeEnvironmentName === gamingRuntimeEnvironmentName(authorization.runId)
    && JSON.stringify(receipt.runtimeTarget) === JSON.stringify(authorization.target)
    && DIGEST.test(receipt.kernelPolicySha256) && DIGEST.test(receipt.kernelLauncherSha256),
  'GAMING_BUILD_RECEIPT_MISMATCH');
  return receipt;
}

export function createGamingCompiledManifest({ root, authorization, productionDependencies, kernelSource, kernelLauncher }) {
  validateGamingBuildAuthorization(authorization);
  requireCondition(Buffer.isBuffer(kernelSource) && kernelSource.length > 0
    && Buffer.isBuffer(kernelLauncher) && kernelLauncher.length > 0, 'GAMING_BUILD_KERNEL_ARTIFACT_INVALID');
  return { ...createCompiledManifest({ root, authorization, productionDependencies }),
    previewLane: 'gaming-synthetic-v1', runtimeEgressPolicy: 'linux-seccomp-no-outbound-v1',
    targetSha256: authorization.targetSha256, runId: authorization.runId,
    runtimeTarget: authorization.target,
    runtimeEnvironmentName: gamingRuntimeEnvironmentName(authorization.runId),
    kernelPolicySha256: sha256(kernelSource), kernelLauncherSha256: sha256(kernelLauncher) };
}

async function main() {
  const [mode, authorizationFile, outputDirectory, inputFile] = process.argv.slice(2);
  if (mode === 'compiled-manifest' || mode === 'compiled-manifest-gaming') {
    const authorization = readJson(authorizationFile);
    const globalConfig = '/opt/verification-tools/empty-global.npmrc';
    writeFileSync(globalConfig, '', { mode: 0o600, flag: 'wx' });
    const dependencies = JSON.parse(command('/usr/local/bin/node',
      productionInventoryArguments(globalConfig),
      { env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', NODE_ENV: 'production' } }));
    const tools = readJson('/opt/verification-tools/trust.json');
    await verifyReviewedPreviewTooling(process.cwd(), tools, '/opt/verification-tools');
    const receipt = mode === 'compiled-manifest-gaming'
      ? createGamingCompiledManifest({ root: process.cwd(), authorization, productionDependencies: dependencies,
        kernelSource: readFileSync('/opt/gaming-preview/network.c'),
        kernelLauncher: readFileSync('/opt/gaming-preview/network-deny') })
      : createCompiledManifest({ root: process.cwd(), authorization, productionDependencies: dependencies });
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(path.join(outputDirectory, 'compiled.json'), `${JSON.stringify(receipt)}\n`);
    return;
  }
  if (mode === 'build') {
    await buildPreviewArtifact({ authorization: readJson(authorizationFile), outputDirectory });
    return;
  }
  if (mode === 'verify') {
    verifyImageArchive(inputFile, readJson(outputDirectory), readJson(authorizationFile));
    return;
  }
  throw new Error('STACKED_BUILD_MODE_INVALID');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) {
    console.error(error.message.startsWith('STACKED_BUILD_') ? error.message : 'STACKED_BUILD_FAILED');
    process.exitCode = 1;
  }
}

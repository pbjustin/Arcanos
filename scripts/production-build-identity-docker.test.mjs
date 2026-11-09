// Explicit local integration command: node --test scripts/production-build-identity-docker.test.mjs
// Builds disposable images; does not start the app, use credentials, or access Railway.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { isProductionSourcePath } from './production-build-identity.mjs';
import { writeGitSourceProofFromRepository } from './production-git-source-proof.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const context = mkdtempSync(join(tmpdir(), 'arcanos-identity-docker-'));
const prefix = `arcanos-identity-e2e-${process.pid}`;
const images = [];
const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const env = { ...process.env };
for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[name];
function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', ['--host=unix:///var/run/docker.sock', ...args], {
    env, encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  if (!allowFailure) assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}
function build(name, target, reference) {
  const image = `${prefix}:${name}`;
  const args = ['build', '--no-cache', '--network=none', '--target', target, '-t', image];
  if (reference !== undefined) args.push('--build-arg', `RAILWAY_GIT_COMMIT_SHA=${reference}`);
  args.push(context);
  const result = docker(args, { allowFailure: true });
  if (result.status === 0) images.push(image);
  return { image, result };
}
function read(image, reference, processKind = 'web', mutation = '') {
  const code = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { readProductionBuildIdentity } from './scripts/production-build-identity.mjs';
    if (existsSync('.git')) throw new Error('unexpected Git metadata');
    ${mutation}
    console.log(JSON.stringify(readProductionBuildIdentity()));`;
  const args = ['run', '--rm', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '-e', `ARCANOS_PROCESS_KIND=${processKind}`];
  if (reference !== undefined) args.push('-e', `RAILWAY_GIT_COMMIT_SHA=${reference}`);
  args.push(image, 'node', '--input-type=module', '-e', code);
  return JSON.parse(docker(args).stdout.trim());
}
let missing;
let current;
let legacy;
let proven;
let fixtureSha;
before(() => {
  docker(['info', '--format', '{{.ServerVersion}}']);
  for (const path of ['src', 'scripts', 'packages']) mkdirSync(join(context, path));
  for (const name of readdirSync(join(root, 'scripts')).filter(name => /^production-.*\.mjs$/u.test(name) && !name.endsWith('.test.mjs'))) {
    cpSync(join(root, 'scripts', name), join(context, 'scripts', name));
  }
  writeFileSync(join(context, 'src', 'start-server.ts'), 'export const version = 1;\n');
  writeFileSync(join(context, '.dockerignore'), '.git\n');
  writeFileSync(join(context, '.gitignore'), 'dist/\n');
  writeFileSync(join(context, 'Dockerfile'), `FROM node:24.18.1-alpine AS source
WORKDIR /app
COPY . .
RUN mkdir -p dist && cp src/start-server.ts dist/start-server.js
FROM source AS legacy
RUN node scripts/production-build-identity.mjs --write
FROM source AS current
ARG RAILWAY_GIT_COMMIT_SHA
RUN node scripts/production-build-identity.mjs --write
`);
  const git = args => {
    const result = spawnSync('git', args, { cwd: context, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init']);
  git(['config', 'core.hooksPath', '/dev/null']);
  git(['config', 'core.autocrlf', 'false']);
  git(['add', '.']);
  git(['-c', 'user.name=Offline Docker fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'controlled Docker source']);
  fixtureSha = git(['rev-parse', 'HEAD']);
  const sourceFiles = ['Dockerfile', 'src/start-server.ts',
    ...readdirSync(join(context, 'scripts')).map(name => `scripts/${name}`)].sort().map(path => ({
      path, sha256: createHash('sha256').update(readFileSync(join(context, path))).digest('hex'),
    }));
  mkdirSync(join(context, 'dist'));
  assert.equal(writeGitSourceProofFromRepository({ rootPath: context, gitDirectory: join(context, '.git'),
    gitSha: fixtureSha, sourceFiles, isSourcePath: isProductionSourcePath }), true);
  const first = build('missing', 'current');
  assert.equal(first.result.status, 0, first.result.stderr);
  missing = first.image;
  const second = build('current', 'current', sha);
  assert.equal(second.result.status, 0, second.result.stderr);
  current = second.image;
  const third = build('legacy', 'legacy', sha);
  assert.equal(third.result.status, 0, third.result.stderr);
  legacy = third.image;
  const fourth = build('provenance', 'current', fixtureSha);
  assert.equal(fourth.result.status, 0, fourth.result.stderr);
  proven = fourth.image;
});
after(() => {
  for (const image of images) docker(['image', 'rm', image]);
  rmSync(context, { recursive: true, force: true });
});

test('reproduces an undeclared build argument despite a valid runtime SHA', () => {
  const identity = read(legacy, sha);
  assert.equal(identity.buildConfiguredGitSha, null);
  assert.equal(identity.configuredGitSha, sha);
  assert.equal(identity.status, 'unverified');
  assert.equal(identity.artifactStatus, 'matches_build_receipt');
});
test('captures a declared full SHA without Git metadata and keeps platform evidence unverified', () => {
  const identity = read(current, sha);
  assert.equal(identity.buildConfiguredGitSha, sha);
  assert.equal(identity.configuredGitSha, sha);
  assert.equal(identity.referenceStatus, 'matches_build_reference');
  assert.equal(identity.gitSha, null);
  assert.equal(identity.status, 'unverified');
  assert.equal(identity.artifactStatus, 'matches_build_receipt');
});
test('missing build SHA stays unverified', () => {
  const identity = read(missing, sha);
  assert.equal(identity.buildConfiguredGitSha, null);
  assert.equal(identity.status, 'unverified');
});
test('malformed build SHA fails the real Docker build without reflecting input', () => {
  const invalid = build('invalid', 'current', 'private-invalid-reference');
  assert.notEqual(invalid.result.status, 0);
  assert.match(invalid.result.stderr, /identity unavailable/u);
  assert.doesNotMatch(invalid.result.stdout, /private-invalid-reference/u);
});
test('different runtime and build references report mismatch with intact artifact evidence', () => {
  const identity = read(current, otherSha);
  assert.equal(identity.status, 'mismatch');
  assert.equal(identity.referenceStatus, 'mismatch');
  assert.equal(identity.artifactStatus, 'matches_build_receipt');
});
test('malformed runtime SHA cannot produce verification success', () => {
  const identity = read(current, 'private-invalid-reference');
  assert.equal(identity.referenceStatus, 'invalid');
  assert.notEqual(identity.status, 'verified_checkout');
  assert.equal(identity.configuredGitSha, null);
  assert.doesNotMatch(JSON.stringify(identity), /private-invalid-reference/u);
});
test('receipt and generated artifact tampering are independently detected', () => {
  for (const mutation of [
    `writeFileSync('dist/start-server.js', 'tampered artifact');`,
    `const receipt = JSON.parse(readFileSync('dist/build-identity.json')); receipt.configuredGitSha = '${otherSha}'; writeFileSync('dist/build-identity.json', JSON.stringify(receipt));`,
  ]) {
    const identity = read(current, sha, 'web', mutation);
    assert.equal(identity.status, 'mismatch');
    assert.equal(identity.artifactStatus, 'mismatch');
    assert.equal(identity.gitSha, null);
  }
});
test('web and worker consume the same image identity contract', () => {
  assert.deepEqual(read(current, sha, 'web'), read(current, sha, 'worker'));
  assert.deepEqual(read(current, otherSha, 'web'), read(current, otherSha, 'worker'));
});
test('production Dockerfile declares Railway SHA before the application build', () => {
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  const argument = dockerfile.indexOf('ARG RAILWAY_GIT_COMMIT_SHA');
  assert.ok(argument >= 0);
  assert.ok(argument < dockerfile.indexOf('npm run build\n'));
});

test('verifies real Git commit/tree proof against generated output without a .git directory', () => {
  const identity = read(proven, fixtureSha);
  assert.equal(identity.status, 'verified_git_source');
  assert.equal(identity.gitSha, fixtureSha);
  assert.equal(identity.referenceStatus, 'matches_verified_git_source');
  assert.equal(identity.artifactStatus, 'matches_build_receipt');
  assert.deepEqual(identity, read(proven, fixtureSha, 'worker'));
});
test('tampered portable proof cannot preserve independent verification', () => {
  const identity = read(proven, fixtureSha, 'web',
    `const proof = JSON.parse(readFileSync('dist/git-source-proof.json')); proof.commit = Buffer.from('forged commit').toString('base64'); writeFileSync('dist/git-source-proof.json', JSON.stringify(proof));`);
  assert.equal(identity.status, 'mismatch');
  assert.equal(identity.gitSha, null);
  assert.equal(identity.artifactStatus, 'mismatch');
});
test('missing runtime SHA does not turn a proven build reference into runtime acceptance', () => {
  const identity = read(proven, undefined);
  assert.equal(identity.status, 'unverified');
  assert.equal(identity.configuredGitSha, null);
  assert.equal(identity.buildConfiguredGitSha, fixtureSha);
  assert.equal(identity.artifactStatus, 'matches_build_receipt');
});

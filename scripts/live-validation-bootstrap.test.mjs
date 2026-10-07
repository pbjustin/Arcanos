import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { assertValidationRoleCredentials, canonicalLiveValidationJson, createValidationBuildManifest,
  readValidationJson, validationDirectoryHash, validationHash, validationIdentity,
  validationOpaqueEqual } from './live-validation-bootstrap.mjs';
import { startValidationRuntime } from './start-live-validation-runtime.mjs';

function target() {
  return { version: 'arcanos-live-validation-target/v2', repository: 'pbjustin/Arcanos',
    projectId: '7faf44e5-519c-4e73-8d7a-da9f389e6187', environmentId: '11111111-1111-4111-8111-111111111111',
    environmentName: 'live-validation', runtimeServiceId: '22222222-2222-4222-8222-222222222222',
    publicOrigin: 'https://arcanos-v2-validation.up.railway.app', writes: false,
    limits: { maxRequests: 32, maxWorkflows: 2, maxSpendMicroUsd: 2_000_000, durationMs: 600_000 },
    models: ['ft:test-approved-authority', 'gpt-6-luna', 'gpt-6.1-sol'].map(id => ({ id, inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 2 })) };
}
const dockerfileNames = ['runtime.Dockerfile', 'runtime.railway.Dockerfile'];
const dockerfile = (name = 'runtime.Dockerfile') => readFileSync(new URL(`../infra/live-validation/${name}`, import.meta.url), 'utf8');
function checkoutBlock(name) {
  const checkout = /(test "\$\{#RAILWAY_GIT_COMMIT_SHA\}"[\s\S]*?)\nWORKDIR \/app/u.exec(dockerfile(name))?.[1];
  assert.ok(checkout, 'Expected exact-SHA checkout block'); return checkout;
}

test('runtime receives only the validation provider key and test token without production or lifecycle credentials', () => {
  assert.doesNotThrow(() => assertValidationRoleCredentials('runtime', {
    ARCANOS_LIVE_PREVIEW_OPENAI_API_KEY: 'test-placeholder',
    ARCANOS_LIVE_VALIDATION_TEST_TOKEN: 'test-placeholder',
    NODE_ENV: 'production', PORT: '8080', RAILWAY_ENVIRONMENT_NAME: 'live-validation'
  }));
  for (const name of ['OPENAI_API_KEY', 'DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGPASSWORD',
    'PGSSLMODE', 'REDIS_URL', 'NOTION_API_KEY', 'OAUTH_CLIENT_SECRET', 'RAILWAY_API_TOKEN', 'RAILWAY_TOKEN',
    'ARCANOS_REGISTER_KEY', 'ARCANOS_LIVE_VALIDATION_CONTROLLER_PRIVATE_KEY_PEM']) {
    assert.throws(() => assertValidationRoleCredentials('runtime', { [name]: 'test-placeholder' }), {
      code: 'LIVE_VALIDATION_UNRELATED_CREDENTIAL_FORBIDDEN'
    });
  }
});

test('runtime rejects ambient provider, TLS and Node execution overrides even when their values are empty', () => {
  for (const name of ['OPENAI_BASE_URL', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS']) {
    assert.throws(() => assertValidationRoleCredentials('runtime', { [name]: '' }), {
      code: 'EGRESS_POLICY_AMBIENT_OVERRIDE_FORBIDDEN'
    });
  }
});

test('opaque identities reject unequal lengths and types without coercion', () => {
  assert.equal(validationOpaqueEqual('test-placeholder', 'test-placeholder'), true);
  assert.equal(validationOpaqueEqual('test-placeholder', 'wrong'), false);
  assert.equal(validationOpaqueEqual(null, ''), false);
  assert.equal(validationOpaqueEqual({}, 'test-placeholder'), false);
});

test('canonical JSON and hashes are independent of record ordering but bind values and array ordering', () => {
  const left = { z: [true, null, 2], a: { y: 'fixture', x: 1 } };
  const right = { a: { x: 1, y: 'fixture' }, z: [true, null, 2] };
  assert.equal(canonicalLiveValidationJson(left), '{"a":{"x":1,"y":"fixture"},"z":[true,null,2]}');
  assert.equal(validationHash(left), validationHash(right));
  assert.notEqual(validationHash(left), validationHash({ ...right, z: [2, null, true] }));
  assert.notEqual(validationHash(left), validationHash({ ...right, a: { x: 2, y: 'fixture' } }));
});

test('canonical JSON rejects prototypes, getters, serialization hooks, symbols, sparse arrays, cycles and nonfinite numbers', () => {
  let called = false; const getter = {};
  Object.defineProperty(getter, 'x', { enumerable: true, get() { called = true; return 'fixture'; } });
  const serializer = { toJSON() { called = true; return 'fixture'; } };
  const sparse = ['fixture', 'fixture']; delete sparse[1];
  const cyclic = {}; cyclic.self = cyclic;
  const poisoned = {}; Object.defineProperty(poisoned, '__proto__', { enumerable: true, value: {} });
  for (const value of [Object.create({ x: 1 }), getter, serializer, { [Symbol('hidden')]: 1 }, sparse,
    cyclic, poisoned, Infinity, NaN, undefined, () => 'fixture']) {
    assert.throws(() => canonicalLiveValidationJson(value), { code: 'LIVE_VALIDATION_JSON_INVALID' });
  }
  assert.equal(called, false);
  assert.throws(() => canonicalLiveValidationJson(Array(1025).fill(null)), { code: 'LIVE_VALIDATION_JSON_INVALID' });
});

test('build proof binds a clean exact Git SHA, public origin and compiled artifact bytes', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-validation-build-'));
  try {
    const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init']); git(['remote', 'add', 'origin', 'https://github.com/pbjustin/Arcanos.git']);
    mkdirSync(path.join(directory, 'dist')); writeFileSync(path.join(directory, 'dist', 'app.js'), 'export const x=1;');
    writeFileSync(path.join(directory, '.gitignore'), 'dist/\n'); writeFileSync(path.join(directory, 'source.ts'), 'export const x=1;');
    git(['add', '.']); git(['-c', 'user.name=Validation fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'test fixture']);
    const sha = git(['rev-parse', 'HEAD']); const manifest = createValidationBuildManifest(directory, sha, 'runtime');
    const profile = target(); const environment = { RAILWAY_PROJECT_ID: profile.projectId, RAILWAY_ENVIRONMENT_ID: profile.environmentId,
      RAILWAY_ENVIRONMENT_NAME: 'live-validation', RAILWAY_SERVICE_ID: profile.runtimeServiceId,
      RAILWAY_DEPLOYMENT_ID: '44444444-4444-4444-8444-444444444444', RAILWAY_GIT_COMMIT_SHA: sha };
    const identity = validationIdentity({ target: profile, role: 'runtime', environment, manifest, repositoryRoot: directory });
    assert.equal(identity.sourceCommit, sha); assert.equal(identity.role, 'runtime');
    assert.match(identity.buildManifestSha256, /^[a-f0-9]{64}$/u); assert.ok(Object.isFrozen(identity));
    assert.throws(() => createValidationBuildManifest(directory, 'f'.repeat(40), 'runtime'), { code: 'DEPLOYMENT_BUILD_SOURCE_MISMATCH' });
    for (const [badSha, role] of [['main', 'runtime'], ['A'.repeat(40), 'runtime'], [sha, 'supervisor']]) {
      assert.throws(() => createValidationBuildManifest(directory, badSha, role), { code: 'DEPLOYMENT_BUILD_SHA_INVALID' });
    }
    git(['remote', 'set-url', 'origin', 'https://github.com/other/Arcanos.git']);
    assert.throws(() => createValidationBuildManifest(directory, sha, 'runtime'), { code: 'DEPLOYMENT_BUILD_SOURCE_MISMATCH' });
    git(['remote', 'set-url', 'origin', 'https://github.com/pbjustin/Arcanos.git']);
    writeFileSync(path.join(directory, 'untracked.txt'), 'fixture');
    assert.throws(() => createValidationBuildManifest(directory, sha, 'runtime'), { code: 'DEPLOYMENT_BUILD_SOURCE_MISMATCH' });
    rmSync(path.join(directory, 'untracked.txt'));
    for (const mismatch of [{ RAILWAY_ENVIRONMENT_ID: 'fb583147-6c39-4343-9267-500f357d25ab' },
      { RAILWAY_SERVICE_ID: 'c4ade025-3f13-4fca-9309-5d0dd81396fe' }, { RAILWAY_GIT_COMMIT_SHA: 'b'.repeat(40) },
      { RAILWAY_PROJECT_ID: profile.environmentId }, { RAILWAY_ENVIRONMENT_NAME: 'production' }]) {
      assert.throws(() => validationIdentity({ target: profile, role: 'runtime', environment: { ...environment, ...mismatch },
        manifest, repositoryRoot: directory }), { code: 'DEPLOYMENT_IDENTITY_MISMATCH' });
    }
    for (const field of ['version', 'repository', 'sourceCommit', 'treeSha', 'compiledSha256', 'role']) {
      assert.throws(() => validationIdentity({ target: profile, role: 'runtime', environment,
        manifest: { ...manifest, [field]: null }, repositoryRoot: directory }), { code: 'DEPLOYMENT_BUILD_MANIFEST_INVALID' });
    }
    assert.throws(() => validationIdentity({ target: profile, role: 'supervisor', environment,
      manifest: { ...manifest, role: 'supervisor' }, repositoryRoot: directory }), { code: 'DEPLOYMENT_IDENTITY_MISMATCH' });
    let called = false; const getter = { ...manifest };
    Object.defineProperty(getter, 'sourceCommit', { enumerable: true, get() { called = true; return sha; } });
    assert.throws(() => validationIdentity({ target: profile, role: 'runtime', environment,
      manifest: getter, repositoryRoot: directory }), { code: 'LIVE_VALIDATION_JSON_INVALID' });
    assert.equal(called, false);
    writeFileSync(path.join(directory, 'dist', 'app.js'), 'changed');
    assert.throws(() => validationIdentity({ target: profile, role: 'runtime', environment, manifest, repositoryRoot: directory }), { code: 'DEPLOYMENT_COMPILED_CONTENT_MISMATCH' });
    writeFileSync(path.join(directory, 'source.ts'), 'changed');
    assert.throws(() => createValidationBuildManifest(directory, sha, 'runtime'), { code: 'DEPLOYMENT_BUILD_SOURCE_MISMATCH' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production or mismatched Railway identity rejects before filesystem mutation or application import', async () => {
  const cwd = process.cwd(); const empty = mkdtempSync(path.join(tmpdir(), 'arcanos-validation-startup-order-'));
  const methods = ['mkdirSync', 'chmodSync', 'chownSync', 'openSync', 'writeFileSync'];
  const originals = Object.fromEntries([...methods, 'readFileSync'].map(name => [name, fs[name]]));
  let mutations = 0;
  try {
    process.chdir(empty);
    for (const name of methods) fs[name] = () => { mutations++; throw new Error('UNEXPECTED_BOOTSTRAP_MUTATION'); };
    fs.readFileSync = (file, ...args) => file === '/opt/validation/build.json'
      ? JSON.stringify({ version: 1, repository: 'pbjustin/Arcanos', role: 'runtime', sourceCommit: 'a'.repeat(40),
        treeSha: 'b'.repeat(40), compiledSha256: 'c'.repeat(64) }) : originals.readFileSync(file, ...args);
    syncBuiltinESMExports();
    const profile = target();
    const environment = { ARCANOS_LIVE_VALIDATION_TARGET_JSON: JSON.stringify(profile),
      RAILWAY_PROJECT_ID: profile.projectId, RAILWAY_ENVIRONMENT_ID: profile.environmentId,
      RAILWAY_ENVIRONMENT_NAME: profile.environmentName, RAILWAY_SERVICE_ID: profile.runtimeServiceId,
      RAILWAY_DEPLOYMENT_ID: '44444444-4444-4444-8444-444444444444', RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40) };
    for (const mismatch of [{ RAILWAY_ENVIRONMENT_ID: 'fb583147-6c39-4343-9267-500f357d25ab' },
      { RAILWAY_PROJECT_ID: '55555555-5555-4555-8555-555555555555' },
      { RAILWAY_SERVICE_ID: 'c4ade025-3f13-4fca-9309-5d0dd81396fe' }]) {
      await assert.rejects(startValidationRuntime({ ...environment, ...mismatch }), { code: 'DEPLOYMENT_IDENTITY_MISMATCH' });
    }
    assert.equal(mutations, 0);
  } finally {
    for (const [name, value] of Object.entries(originals)) fs[name] = value;
    syncBuiltinESMExports(); process.chdir(cwd); rmSync(empty, { recursive: true, force: true });
  }
});

test('runtime requires an empty writable working directory and rejects credentials before startup', async () => {
  const cwd = process.cwd(); const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-validation-startup-empty-'));
  try {
    process.chdir(directory); writeFileSync(path.join(directory, 'unexpected.json'), '{}');
    await assert.rejects(startValidationRuntime({}), { code: 'LIVE_VALIDATION_EMPTY_RUNTIME_DIRECTORY_REQUIRED' });
    await assert.rejects(startValidationRuntime({ DATABASE_URL: 'test-placeholder' }), { code: 'LIVE_VALIDATION_UNRELATED_CREDENTIAL_FORBIDDEN' });
  } finally { process.chdir(cwd); rmSync(directory, { recursive: true, force: true }); }
});

for (const name of dockerfileNames) {
  test(`${name} rejects malformed build SHAs before the first Git invocation`, () => {
    const validation = checkoutBlock(name).split('git init')[0].replace(/\\\n/gu, '').trim().replace(/&&\s*$/u, '');
    for (const [sha, expected] of [['a'.repeat(40), 0], ['a'.repeat(39), 1], ['a'.repeat(41), 1],
      ['A'.repeat(40), 1], ['g'.repeat(40), 1], [' '.repeat(40), 1], ['--upload-pack=' + 'x'.repeat(26), 1]]) {
      const result = spawnSync('sh', ['-c', validation], { encoding: 'utf8', timeout: 5_000,
        env: { PATH: process.env.PATH, RAILWAY_GIT_COMMIT_SHA: sha } });
      assert.equal(result.status, expected, result.stderr);
    }
  });

  test(`${name} build checkout fetches only the exact shallow SHA without tags or historical objects`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-validation-shallow-build-'));
    const source = path.join(directory, 'origin'); mkdirSync(source);
    const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      git(source, ['init']); writeFileSync(path.join(source, '.gitignore'), 'dist/\n');
      writeFileSync(path.join(source, 'historical-fixture.txt'), 'Benign historical fixture, never a credential.\n');
      git(source, ['add', '.']);
      const commit = () => git(source, ['-c', 'user.name=Validation fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'test fixture']);
      commit(); const ancestor = git(source, ['rev-parse', 'HEAD']); git(source, ['tag', 'historical-fixture']);
      const historicalBlob = git(source, ['rev-parse', 'HEAD:historical-fixture.txt']);
      rmSync(path.join(source, 'historical-fixture.txt')); writeFileSync(path.join(source, 'source.ts'), 'export const x=1;');
      git(source, ['add', '-A']); commit(); const sha = git(source, ['rev-parse', 'HEAD']); git(source, ['tag', 'current-fixture']);
      const checkout = checkoutBlock(name);
      assert.match(checkout, /git init \/app/u);
      assert.match(checkout, /git -C \/app remote add origin https:\/\/github\.com\/pbjustin\/Arcanos\.git/u);
      assert.match(checkout, /git -C \/app fetch --depth=1 --no-tags origin "\$RAILWAY_GIT_COMMIT_SHA"/u);
      assert.equal((checkout.match(/\bgit\b[^\n]*\bfetch\b/gu) ?? []).length, 1);
      assert.doesNotMatch(dockerfile(name), /\bgit clone\b/u);
      const worktree = path.join(directory, 'runtime');
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      const localCheckout = checkout.replaceAll('https://github.com/pbjustin/Arcanos.git', quote(pathToFileURL(source).href))
        .replaceAll('/app', quote(worktree));
      const result = spawnSync('sh', ['-c', localCheckout], { encoding: 'utf8', timeout: 5_000,
        env: { PATH: process.env.PATH, RAILWAY_GIT_COMMIT_SHA: sha } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(git(worktree, ['rev-parse', 'HEAD']), sha);
      assert.equal(git(worktree, ['rev-list', '--all', '--count']), '1');
      assert.equal(readFileSync(path.join(worktree, '.git', 'shallow'), 'utf8').trim(), sha);
      assert.ok(spawnSync('git', ['cat-file', '-e', ancestor + '^{commit}'], { cwd: worktree, stdio: 'ignore' }).status > 0);
      assert.ok(spawnSync('git', ['cat-file', '-e', historicalBlob], { cwd: worktree, stdio: 'ignore' }).status > 0);
      assert.equal(spawnSync('git', ['show-ref', '--tags'], { cwd: worktree, stdio: 'ignore' }).status, 1);
      git(worktree, ['remote', 'set-url', 'origin', 'https://github.com/pbjustin/Arcanos.git']);
      mkdirSync(path.join(worktree, 'dist')); writeFileSync(path.join(worktree, 'dist', 'app.js'), 'export const x=1;');
      assert.equal(createValidationBuildManifest(worktree, sha, 'runtime').sourceCommit, sha);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test(`${name} final image copies a read-only checked-out tree after build proof and excludes Git history and custom TLS tooling`, () => {
    const stages = dockerfile(name).split(/^FROM /gmu).slice(1); assert.equal(stages.length, 2);
    const [build, final] = stages;
    assert.match(build, /^node:24\.18\.1-alpine AS build\n/u);
    const manifest = build.indexOf('node scripts/live-validation-build.mjs "$RAILWAY_GIT_COMMIT_SHA" runtime /opt/validation/build.json');
    assert.ok(manifest >= 0 && build.indexOf('rm -rf /app/.git') > manifest);
    assert.match(final, /^node:24\.18\.1-alpine\n/u);
    assert.match(final, /COPY --from=build --chown=root:root \/app \/app/u);
    assert.match(final, /COPY --from=build --chown=root:root \/opt\/validation\/build.json \/opt\/validation\/build.json/u);
    assert.match(final, /test ! -e \/app\/\.git && chmod -R a-w \/app \/opt\/validation/u);
    assert.match(final, /mkdir -p \/run\/arcanos-live-validation-empty/u);
    assert.match(final, /chown node:node \/run\/arcanos-live-validation-empty/u);
    assert.match(final, /chmod 700 \/run\/arcanos-live-validation-empty/u);
    assert.match(final, /\nUSER node\n/u);
    assert.match(final, /\nWORKDIR \/run\/arcanos-live-validation-empty\n/u);
    assert.match(final, /\nEXPOSE 8080\n/u);
    assert.match(final, /\nCMD \["node", "\/app\/scripts\/start-live-validation-runtime\.mjs"\]\n/u);
    assert.doesNotMatch(final, /\b(?:git (?:clone|fetch|checkout)|apk add[^\n]*\s(?:git|openssl)(?:\s|$))/u);
    assert.doesNotMatch(final, /COPY[^\n]*\.git/u);
    assert.doesNotMatch(final, /(?:8443|supervisor|TLS_(?:CA|CERT|KEY))/u);
  });
}

test('Railway V3 Dockerfile uses public CA trust without unsupported BuildKit secret mounts or proxy trust overrides', () => {
  const railway = dockerfile('runtime.railway.Dockerfile');
  assert.doesNotMatch(railway, /--mount=(?:[^\s\\]+,)?type=secret\b/u);
  assert.doesNotMatch(railway, /proxy_ca|\/run\/secrets\/|validation-public-ca\.pem/u);
  assert.doesNotMatch(railway, /GIT_SSL_CAINFO|NODE_EXTRA_CA_CERTS|SSL_CERT_(?:FILE|DIR)|NODE_TLS_REJECT_UNAUTHORIZED|NODE_OPTIONS/u);
});

test('build proxy trust is removed from both Alpine CA paths without replacing their symlink', () => {
  const blocks = dockerfile().match(/RUN --mount=type=secret,id=proxy_ca \\\n\s+cp [\s\S]*?rm \/tmp\/validation-public-ca\.pem/gu);
  assert.equal(blocks?.length, 2);
  for (const block of blocks) {
    const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-validation-ca-'));
    try {
      const bundle = path.join(directory, 'ca-certificates.crt');
      const link = path.join(directory, 'cert.pem');
      const backup = path.join(directory, 'public-ca.pem');
      const proxy = path.join(directory, 'proxy-ca.pem');
      writeFileSync(bundle, 'public-root-fixture\n'); symlinkSync(bundle, link);
      writeFileSync(proxy, 'session-proxy-test-fixture\n');
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      const script = block.replace(/^RUN[^\n]*\n/u, '')
        .replaceAll('/etc/ssl/cert.pem', quote(link))
        .replaceAll('/tmp/validation-public-ca.pem', quote(backup))
        .replaceAll('/run/secrets/proxy_ca', quote(proxy))
        .replace(/apk add --no-cache [a-z0-9 -]+/u, 'true');
      const result = spawnSync('sh', ['-c', script], { encoding: 'utf8', timeout: 5_000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      assert.equal(readFileSync(link, 'utf8'), 'public-root-fixture\n');
      assert.equal(readFileSync(bundle, 'utf8'), 'public-root-fixture\n');
      assert.equal(fs.existsSync(backup), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('compiled digest binds file paths and bytes and cannot traverse symbolic links', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-validation-hash-'));
  try {
    writeFileSync(path.join(directory, 'app.js'), 'fixture'); const original = validationDirectoryHash(directory);
    writeFileSync(path.join(directory, 'app.js'), 'changed'); assert.notEqual(validationDirectoryHash(directory), original);
    writeFileSync(path.join(directory, 'app.js'), 'fixture');
    fs.renameSync(path.join(directory, 'app.js'), path.join(directory, 'renamed.js'));
    assert.notEqual(validationDirectoryHash(directory), original);
    symlinkSync('/etc/passwd', path.join(directory, 'escape'));
    assert.throws(() => validationDirectoryHash(directory), { code: 'DEPLOYMENT_BUILD_SYMLINK_FORBIDDEN' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('request bodies reject compression, non-JSON, malformed JSON and oversized content', async () => {
  const request = (body, headers) => Object.assign(Readable.from([Buffer.from(body)]), { headers });
  assert.deepEqual(await readValidationJson(request('{"x":1}', { 'content-type': 'application/json' })), { x: 1 });
  await assert.rejects(readValidationJson(request('{}', { 'content-type': 'text/plain' })), { code: 'LIVE_VALIDATION_REQUEST_INVALID' });
  await assert.rejects(readValidationJson(request('{}', { 'content-type': 'application/json', 'content-encoding': 'gzip' })), { code: 'LIVE_VALIDATION_REQUEST_INVALID' });
  await assert.rejects(readValidationJson(request('{', { 'content-type': 'application/json' })), { code: 'LIVE_VALIDATION_REQUEST_INVALID' });
  await assert.rejects(readValidationJson(request('{"x":111}', { 'content-type': 'application/json' }), 4), { code: 'LIVE_VALIDATION_REQUEST_LIMIT' });
});

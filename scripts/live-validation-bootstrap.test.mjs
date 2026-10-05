import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { assertValidationRoleCredentials, createValidationBuildManifest, materializeValidationTls,
  readValidationJson, startValidationHealth, validationDirectoryHash, validationIdentity, validationOpaqueEqual } from './live-validation-bootstrap.mjs';
import { startValidationRuntime } from './start-live-validation-runtime.mjs';
import { startValidationSupervisor } from './start-live-validation-supervisor.mjs';

function target() {
  return { version: 'arcanos-live-validation-target/v1', repository: 'pbjustin/Arcanos',
    projectId: '7faf44e5-519c-4e73-8d7a-da9f389e6187', environmentId: '11111111-1111-4111-8111-111111111111',
    environmentName: 'live-validation', runtimeServiceId: '22222222-2222-4222-8222-222222222222',
    supervisorServiceId: '33333333-3333-4333-8333-333333333333', trustedSupervisorSha: 'a'.repeat(40), writes: false,
    privateOrigins: { runtime: 'https://runtime-validation.railway.internal:8443', supervisor: 'https://supervisor-validation.railway.internal:8443' },
    mtlsPeers: Object.fromEntries(['runtime', 'supervisor', 'verifier'].map((role, i) => [role,
      { dns: role + '-validation.railway.internal', sha256: String(i + 1).repeat(64) }])),
    limits: { maxRequests: 32, maxWorkflows: 2, maxSpendMicroUsd: 2_000_000, durationMs: 600_000 },
    models: ['ft:test-approved-authority', 'gpt-6-luna', 'gpt-6.1-sol'].map(id => ({ id, inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 2 })) };
}

test('provider, production data and lifecycle credentials never enter runtime bootstrap', () => {
  for (const name of ['OPENAI_API_KEY', 'ARCANOS_LIVE_PREVIEW_OPENAI_API_KEY', 'DATABASE_URL', 'PGPASSWORD',
    'REDIS_URL', 'NOTION_API_KEY', 'RAILWAY_API_TOKEN', 'RAILWAY_TOKEN', 'OPENAI_BASE_URL', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
    assert.throws(() => assertValidationRoleCredentials('runtime', { [name]: 'test-placeholder' }));
  }
  assert.doesNotThrow(() => assertValidationRoleCredentials('supervisor', { ARCANOS_LIVE_PREVIEW_OPENAI_API_KEY: 'test-placeholder' }));
  assert.throws(() => assertValidationRoleCredentials('supervisor', { OPENAI_API_KEY: 'test-placeholder' }));
});

test('opaque identities reject unequal lengths and types without coercion', () => {
  assert.equal(validationOpaqueEqual('test-placeholder', 'test-placeholder'), true);
  assert.equal(validationOpaqueEqual('test-placeholder', 'wrong'), false);
  assert.equal(validationOpaqueEqual(null, ''), false);
});

test('build proof binds an actual clean Git SHA and detects changed compiled bytes', () => {
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
    assert.equal(identity.sourceCommit, sha); assert.match(identity.buildManifestSha256, /^[a-f0-9]{64}$/u);
    assert.throws(() => createValidationBuildManifest(directory, 'f'.repeat(40), 'runtime'), { code: 'DEPLOYMENT_BUILD_SOURCE_MISMATCH' });
    assert.throws(() => validationIdentity({ target: profile, role: 'runtime', environment: { ...environment,
      RAILWAY_ENVIRONMENT_ID: 'fb583147-6c39-4343-9267-500f357d25ab' }, manifest, repositoryRoot: directory }), { code: 'DEPLOYMENT_IDENTITY_MISMATCH' });
    writeFileSync(path.join(directory, 'dist', 'app.js'), 'changed');
    assert.throws(() => validationIdentity({ target: profile, role: 'runtime', environment, manifest, repositoryRoot: directory }), { code: 'DEPLOYMENT_COMPILED_CONTENT_MISMATCH' });
    writeFileSync(path.join(directory, 'source.ts'), 'changed');
    assert.throws(() => createValidationBuildManifest(directory, sha, 'runtime'), { code: 'DEPLOYMENT_BUILD_SOURCE_MISMATCH' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('actual production or mismatched Railway identity rejects before any ledger or TLS filesystem mutation', async () => {
  const cwd = process.cwd();
  const empty = mkdtempSync(path.join(tmpdir(), 'arcanos-validation-startup-order-'));
  const methods = ['mkdirSync', 'chmodSync', 'chownSync', 'openSync', 'writeFileSync'];
  const originals = Object.fromEntries([...methods, 'readFileSync'].map(name => [name, fs[name]]));
  let mutations = 0; let role;
  try {
    process.chdir(empty);
    for (const name of methods) fs[name] = () => { mutations++; throw new Error('UNEXPECTED_BOOTSTRAP_MUTATION'); };
    fs.readFileSync = (file, ...args) => file === '/opt/validation/build.json'
      ? JSON.stringify({ version: 1, repository: 'pbjustin/Arcanos', role, sourceCommit: 'a'.repeat(40),
        treeSha: 'b'.repeat(40), compiledSha256: 'c'.repeat(64) }) : originals.readFileSync(file, ...args);
    syncBuiltinESMExports();
    for (const [candidateRole, start] of [['runtime', startValidationRuntime], ['supervisor', startValidationSupervisor]]) {
      role = candidateRole;
      const profile = target();
      const environment = { ARCANOS_LIVE_VALIDATION_TARGET_JSON: JSON.stringify(profile),
        RAILWAY_PROJECT_ID: profile.projectId, RAILWAY_ENVIRONMENT_ID: profile.environmentId,
        RAILWAY_ENVIRONMENT_NAME: profile.environmentName, RAILWAY_SERVICE_ID: profile[role + 'ServiceId'],
        RAILWAY_DEPLOYMENT_ID: '44444444-4444-4444-8444-444444444444', RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
        RAILWAY_VOLUME_MOUNT_PATH: '/var/lib/arcanos-live-validation' };
      for (const mismatch of [{ RAILWAY_ENVIRONMENT_ID: 'fb583147-6c39-4343-9267-500f357d25ab' },
        { RAILWAY_PROJECT_ID: '55555555-5555-4555-8555-555555555555' },
        { RAILWAY_SERVICE_ID: 'c4ade025-3f13-4fca-9309-5d0dd81396fe' }]) {
        await assert.rejects(start({ ...environment, ...mismatch }), { code: 'DEPLOYMENT_IDENTITY_MISMATCH' });
      }
    }
    assert.equal(mutations, 0);
  } finally {
    for (const [name, value] of Object.entries(originals)) fs[name] = value;
    syncBuiltinESMExports();
    process.chdir(cwd); rmSync(empty, { recursive: true, force: true });
  }
});

test('both Dockerfiles reject malformed build SHAs before their first Git invocation', () => {
  for (const role of ['runtime', 'supervisor']) {
    const dockerfile = readFileSync(new URL(`../infra/live-validation/${role}.Dockerfile`, import.meta.url), 'utf8');
    const validation = /RUN (test "\$\{#RAILWAY_GIT_COMMIT_SHA\}"[\s\S]*?)git clone/u.exec(dockerfile)?.[1]
      .replace(/\\\n/gu, '').trim().replace(/&&\s*$/u, '');
    assert.ok(validation, 'Expected SHA validation before Git checkout');
    for (const [sha, expected] of [['a'.repeat(40), 0], ['a'.repeat(39), 1], ['a'.repeat(41), 1],
      ['A'.repeat(40), 1], ['g'.repeat(40), 1], [' '.repeat(40), 1], ['--upload-pack=' + 'x'.repeat(26), 1]]) {
      const result = spawnSync('sh', ['-c', validation], { encoding: 'utf8', timeout: 5_000,
        env: { PATH: process.env.PATH, RAILWAY_GIT_COMMIT_SHA: sha } });
      assert.equal(result.status, expected, result.stderr);
    }
  }
});

test('final image stages copy a read-only checked-out tree only after manifest creation and Git history removal', () => {
  for (const role of ['runtime', 'supervisor']) {
    const dockerfile = readFileSync(new URL(`../infra/live-validation/${role}.Dockerfile`, import.meta.url), 'utf8');
    const stages = dockerfile.split(/^FROM /gmu).slice(1);
    assert.equal(stages.length, 2);
    const [build, final] = stages;
    assert.match(build, /^node:24\.18\.1-alpine AS build\n/u);
    const manifest = build.indexOf(`node scripts/live-validation-build.mjs "$RAILWAY_GIT_COMMIT_SHA" ${role} /opt/validation/build.json`);
    assert.ok(manifest >= 0 && build.indexOf('rm -rf /app/.git') > manifest);
    assert.match(final, /^node:24\.18\.1-alpine\n/u);
    assert.match(final, /COPY --from=build --chown=root:root \/app \/app/u);
    assert.match(final, /COPY --from=build --chown=root:root \/opt\/validation\/build.json \/opt\/validation\/build.json/u);
    assert.match(final, /test ! -e \/app\/\.git && chmod -R a-w \/app \/opt\/validation/u);
    assert.match(final, /RUN apk add --no-cache openssl python3 py3-jsonschema\n/u);
    assert.doesNotMatch(final, /\b(?:git (?:clone|fetch|checkout)|apk add[^\n]*\sgit(?:\s|$))/u);
    assert.doesNotMatch(final, /COPY[^\n]*\.git/u);
    assert.match(final, role === 'runtime' ? /\nUSER node\n/u : /\nUSER root\n/u);
  }
});

test('compiled digest cannot traverse symbolic links', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-validation-hash-'));
  try { symlinkSync('/etc/passwd', path.join(directory, 'escape')); assert.throws(() => validationDirectoryHash(directory), { code: 'DEPLOYMENT_BUILD_SYMLINK_FORBIDDEN' }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test('TLS binding materializes only protected external files and consumes PEM variables', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-validation-tls-binding-'));
  try {
    const env = Object.fromEntries(['CA', 'CERT', 'KEY'].map(name => [`ARCANOS_LIVE_VALIDATION_TLS_${name}_PEM`, 'test-only-placeholder-pem']));
    const files = materializeValidationTls(env, directory, process.cwd());
    assert.deepEqual(env, {}); assert.equal(readFileSync(files.keyFile, 'utf8'), 'test-only-placeholder-pem');
    assert.throws(() => materializeValidationTls(env, directory, process.cwd()), { code: 'TLS_IDENTITY_BINDING_BLOCKED' });
    assert.throws(() => materializeValidationTls({}, process.cwd(), process.cwd()), { code: 'TLS_IDENTITY_FILE_PATH_INVALID' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('private request bodies reject compression, non-JSON and oversized content', async () => {
  const request = (body, headers) => Object.assign(Readable.from([Buffer.from(body)]), { headers });
  assert.deepEqual(await readValidationJson(request('{"x":1}', { 'content-type': 'application/json' })), { x: 1 });
  await assert.rejects(readValidationJson(request('{}', { 'content-type': 'text/plain' })), { code: 'LIVE_VALIDATION_REQUEST_INVALID' });
  await assert.rejects(readValidationJson(request('{}', { 'content-type': 'application/json', 'content-encoding': 'gzip' })), { code: 'LIVE_VALIDATION_REQUEST_INVALID' });
  await assert.rejects(readValidationJson(request('{"x":111}', { 'content-type': 'application/json' }), 4), { code: 'LIVE_VALIDATION_REQUEST_LIMIT' });
});

test('health listener has no provider or application execution routes', async () => {
  // Production health port validation is independent of the mTLS listener.
  await assert.rejects(startValidationHealth(8443, 'runtime'), { code: 'LIVE_VALIDATION_HEALTH_PORT_INVALID' });
  await assert.rejects(startValidationHealth(0, 'runtime'), { code: 'LIVE_VALIDATION_HEALTH_PORT_INVALID' });
});

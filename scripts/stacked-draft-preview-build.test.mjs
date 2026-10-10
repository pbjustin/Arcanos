import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { assertNoInstalledDevDependencies, createCompiledManifest, hashCompiledArtifacts, productionInventoryArguments, sha256, validateBuildReceipt, validateReviewedTooling, verifyImageArchive } from './stacked-draft-preview-build.mjs';

const authorization = { controllerSha: 'a'.repeat(40), sourceArchiveSha256: 'b'.repeat(64),
  stack: [{ headSha: 'c'.repeat(40), treeSha: 'd'.repeat(40) }] };
const directories = ['dist', 'workers/dist', ...['protocol', 'cli', 'arcanos-runtime', 'arcanos-openai'].map(name => `packages/${name}/dist`)];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'stacked-build-'));
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  for (const directory of directories) {
    mkdirSync(path.join(root, directory), { recursive: true });
    writeFileSync(path.join(root, directory, 'index.js'), 'export const proof = true;\n');
  }
  return root;
}
test('artifact digests bind path and bytes and detect a changed compiled production file', () => {
  const root = fixture();
  try {
    const first = hashCompiledArtifacts(root);
    assert.equal(first.compiledFiles, 6);
    assert.deepEqual(hashCompiledArtifacts(root), first);
    writeFileSync(path.join(root, 'dist/index.js'), 'export const proof = false;\n');
    assert.notEqual(hashCompiledArtifacts(root).compiledSha256, first.compiledSha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('artifact digest refuses missing production output and symlink escapes', () => {
  const root = fixture();
  try {
    symlinkSync('/etc/passwd', path.join(root, 'dist/escape'));
    assert.throws(() => hashCompiledArtifacts(root), /ARTIFACT_SYMLINK/u);
    rmSync(path.join(root, 'dist/escape'));
    rmSync(path.join(root, 'workers/dist'), { recursive: true });
    assert.throws(() => hashCompiledArtifacts(root), /ARTIFACT_MISSING/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('compiled manifest rejects retained development, missing and extraneous dependency inventory', () => {
  const root = fixture();
  try {
    const input = { root, authorization, productionDependencies: { dependencies: { express: { version: '5.1.0' } } } };
    assert.equal(createCompiledManifest(input).runtimeDevDependenciesPruned, true);
    for (const flag of ['dev', 'missing', 'invalid', 'extraneous']) {
      assert.throws(() => createCompiledManifest({ ...input,
        productionDependencies: { dependencies: { unsafe: { [flag]: true } } } }), /RUNTIME_DEPENDENCY_INVALID/u);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('image transport verification rejects substitution and identity drift', () => {
  const root = fixture();
  try {
    const file = path.join(root, 'image.tar');
    const bytes = Buffer.from('fixture image archive');
    writeFileSync(file, bytes);
    const receipt = { ...createCompiledManifest({ root, authorization, productionDependencies: {} }),
      imageId: `sha256:${'e'.repeat(64)}`, imageArchiveSha256: sha256(bytes) };
    assert.equal(verifyImageArchive(file, receipt, authorization), receipt);
    for (const field of ['controllerSha', 'candidateSha', 'treeSha', 'sourceArchiveSha256', 'imageId']) {
      assert.throws(() => validateBuildReceipt({ ...receipt, [field]: 'substituted' }, authorization), /RECEIPT_MISMATCH/u);
    }
    assert.throws(() => validateBuildReceipt({ ...receipt, runtimeDevDependenciesPruned: false }, authorization), /RECEIPT_MISMATCH/u);
    writeFileSync(file, 'substituted image');
    assert.throws(() => verifyImageArchive(file, receipt, authorization), /ARCHIVE_MISMATCH/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pruned dependency proof checks installed paths rather than trusting omit-dev listing', () => {
  const root = fixture();
  try {
    const lock = { lockfileVersion: 3, packages: { 'node_modules/handlebars': { dev: true } } };
    assert.doesNotThrow(() => assertNoInstalledDevDependencies(root, lock));
    mkdirSync(path.join(root, 'node_modules/handlebars'), { recursive: true });
    assert.throws(() => assertNoInstalledDevDependencies(root, lock), /RETAINED_DEV_DEPENDENCY/u);
    assert.throws(() => assertNoInstalledDevDependencies(root,
      { lockfileVersion: 3, packages: { '../escape': {} } }), /LOCK_INVALID/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reviewed tool policy rejects modified checker bytes, extra paths and dependency lock drift', () => {
  const root = fixture();
  try {
    const files = ['scripts/check-native-pr-preview-imports.mjs', 'scripts/check-native-pr-preview-dist-imports.mjs',
      'scripts/native-pr-preview-imports-tsconfig.json', 'package-lock.json'].map(file => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), 'reviewed fixture bytes');
      return { path: file, sha256: sha256('reviewed fixture bytes') };
    });
    const policy = { version: 1, reviewedCandidateSha: 'a'.repeat(40), files };
    assert.match(validateReviewedTooling(root, policy), /^[0-9a-f]{64}$/u);
    writeFileSync(path.join(root, files[0].path), 'return no violations;');
    assert.throws(() => validateReviewedTooling(root, policy), /REVIEWED_TOOL_DRIFT/u);
    assert.throws(() => validateReviewedTooling(root, { ...policy, files: [...files, files[0]] }), /TOOL_POLICY_INVALID/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('production inventory works with distinct empty configs under pinned npm without running lifecycle scripts', () => {
  const root = fixture();
  try {
    const globalConfig = path.join(root, 'empty-global.npmrc');
    writeFileSync(globalConfig, '');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'inventory-regression-fixture',
      version: '1.0.0', scripts: { preinstall: 'exit 99' } }));
    const result = spawnSync('npm', productionInventoryArguments(globalConfig).slice(1),
      { cwd: root, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).name, 'inventory-regression-fixture');
    assert.throws(() => productionInventoryArguments('/dev/null'), /NPM_CONFIGURATION_INVALID/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restrictive host umask cannot remove nonroot read access to root-owned runtime scaffolding', () => {
  const root = fixture();
  try {
    const git = args => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, GIT_AUTHOR_NAME: 'Preview regression', GIT_AUTHOR_EMAIL: 'preview@example.invalid',
          GIT_COMMITTER_NAME: 'Preview regression', GIT_COMMITTER_EMAIL: 'preview@example.invalid' } });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Fixture source']);
    const candidateSha = git(['rev-parse', 'HEAD']);
    const archive = spawnSync('git', ['archive', '--format=tar', candidateSha], { cwd: root, timeout: 10_000 });
    assert.equal(archive.status, 0);
    const authorizationFile = path.join(root, 'authorization.json');
    writeFileSync(authorizationFile, JSON.stringify({ ...authorization, sourceArchiveSha256: sha256(archive.stdout),
      stack: [{ headSha: candidateSha, treeSha: git(['rev-parse', 'HEAD^{tree}']) }] }));
    const commands = path.join(root, 'commands');
    mkdirSync(commands);
    const docker = path.join(commands, 'docker');
    writeFileSync(docker, '#!/bin/sh\nexit 1\n');
    chmodSync(docker, 0o700);
    const output = path.join(root, 'output');
    const helper = new URL('./stacked-draft-preview-build.mjs', import.meta.url);
    const program = 'process.umask(0o077); process.argv = [process.execPath, ' + JSON.stringify(helper.pathname) + ', "build", ' +
      JSON.stringify(authorizationFile) + ', ' + JSON.stringify(output) + ']; await import(' + JSON.stringify(helper.href) + ');';
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], { cwd: root,
      encoding: 'utf8', timeout: 10_000, env: { ...process.env, PATH: `${commands}:${process.env.PATH}`, GITHUB_TOKEN: '' } });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /STACKED_BUILD_COMMAND_FAILED/u);
    // The real context helper reproduces the original 0600 source; Docker must
    // normalize final metadata, rather than relying on an ambient runner umask.
    assert.equal(statSync(path.join(output, 'context/runtime.mjs')).mode & 0o777, 0o600);
    const finalStage = readFileSync(path.join(output, 'context/Dockerfile'), 'utf8').split(/^FROM /mu).at(-1);
    assert.match(finalStage, /^RUN install -d -o root -g root -m 0755 \/opt\/stacked-preview$/mu);
    assert.match(finalStage, /^COPY --from=attest --chmod=0444 \/opt\/stacked-preview\/compiled\.json \/opt\/stacked-preview\/compiled\.json$/mu);
    assert.match(finalStage, /^COPY --chmod=0444 runtime\.mjs \/opt\/stacked-preview\/runtime\.mjs$/mu);
    assert.doesNotMatch(finalStage, /(?:COPY[^\n]*--chown|chown|chmod[^\n]*[67][0-7][0-7])[^\n]*\/opt\/stacked-preview/u);
    assert.match(finalStage, /^USER node\nEXPOSE 8080\nCMD \["node", "\/opt\/stacked-preview\/runtime\.mjs"\]$/mu);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createGamingCompiledManifest, sha256, validateGamingBuildAuthorization,
  validateGamingBuildReceipt, verifyImageArchive, previewSourceArchiveArguments, materializeGamingSourceArchive } from './stacked-draft-preview-build.mjs';
import { runGamingPreviewBuild } from './gaming-preview-build.mjs';

const uuid = digit => `${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}`;
const authorization = { version: 1, controllerSha: 'a'.repeat(40),
  mainSha: 'a'.repeat(40), baseSha: 'a'.repeat(40),
  headSha: '1c1e7d0f4c8f4e62fd7117e28efd0d8d7c415262',
  treeSha: '89f1eb0b988514d92ef9f82dd2f77bc356735b8b', sourceArchiveSha256: 'b'.repeat(64),
  targetSha256: 'c'.repeat(64), expiresAt: '2026-10-19T23:00:00.000Z', runId: '1234',
  target: { projectId: uuid('1'), baseEnvironmentId: uuid('2'), workerServiceId: uuid('3'), webServiceId: uuid('4') } };
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'gaming-build-'));
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  for (const directory of ['dist', 'workers/dist', ...['protocol', 'cli', 'arcanos-runtime', 'arcanos-openai'].map(name => `packages/${name}/dist`)]) {
    mkdirSync(path.join(root, directory), { recursive: true });
    writeFileSync(path.join(root, directory, 'index.js'), 'export const proof = true;\n');
  }
  return root;
}
function manifest(root) {
  return createGamingCompiledManifest({ root, authorization, productionDependencies: {},
    kernelSource: Buffer.from('fixed trusted C'), kernelLauncher: Buffer.from('compiled trusted launcher') });
}

test('Gaming artifact authorization fixes frozen candidate, target and exact run identity', () => {
  assert.equal(validateGamingBuildAuthorization(authorization), authorization);
  for (const field of ['headSha', 'treeSha', 'mainSha', 'baseSha', 'targetSha256', 'runId']) {
    assert.throws(() => validateGamingBuildAuthorization({ ...authorization, [field]: 'other' }), /AUTHORIZATION_INVALID/u);
  }
  assert.throws(() => validateGamingBuildAuthorization({ ...authorization, target: { ...authorization.target,
    providerKey: 'forbidden' } }), /AUTHORIZATION_INVALID/u);
  assert.throws(() => validateGamingBuildAuthorization({ ...authorization,
    stack: [{ headSha: 'e'.repeat(40), treeSha: 'f'.repeat(40) }] }), /AUTHORIZATION_INVALID/u);
});

test('Gaming compiled manifest binds source, outputs, kernel source, executable, target and lease', () => {
  const root = fixture();
  try {
    const first = manifest(root);
    assert.equal(first.candidateSha, authorization.headSha);
    assert.equal(first.runtimeEgressPolicy, 'linux-seccomp-no-outbound-v1');
    assert.equal(first.runtimeEnvironmentName, 'pr-03ac67-1558');
    assert.equal(first.kernelPolicySha256, sha256('fixed trusted C'));
    assert.equal(first.kernelLauncherSha256, sha256('compiled trusted launcher'));
    assert.deepEqual(first.runtimeTarget, authorization.target);
    assert.throws(() => createGamingCompiledManifest({ root, authorization, productionDependencies: {},
      kernelSource: Buffer.alloc(0), kernelLauncher: Buffer.from('binary') }), /KERNEL_ARTIFACT_INVALID/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Gaming archive and receipt validation reject source, image, network-policy and target substitution', () => {
  const root = fixture();
  try {
    const file = path.join(root, 'image.tar'); writeFileSync(file, 'immutable image');
    const receipt = { ...manifest(root), imageId: `sha256:${'d'.repeat(64)}`, imageArchiveSha256: sha256('immutable image') };
    assert.equal(validateGamingBuildReceipt(receipt, authorization), receipt);
    assert.equal(verifyImageArchive(file, receipt, authorization), receipt);
    for (const field of ['candidateSha', 'treeSha', 'sourceArchiveSha256', 'controllerSha', 'imageId']) {
      assert.throws(() => validateGamingBuildReceipt({ ...receipt, [field]: 'other' }, authorization), /RECEIPT_MISMATCH/u);
    }
    for (const field of ['previewLane', 'runtimeEgressPolicy', 'targetSha256', 'runId', 'runtimeEnvironmentName', 'kernelPolicySha256', 'kernelLauncherSha256']) {
      assert.throws(() => validateGamingBuildReceipt({ ...receipt, [field]: 'other' }, authorization), /RECEIPT_MISMATCH/u);
    }
    assert.throws(() => validateGamingBuildReceipt({ ...receipt, runtimeTarget: { ...receipt.runtimeTarget,
      projectId: uuid('5') } }, authorization), /RECEIPT_MISMATCH/u);
    writeFileSync(file, 'substituted');
    assert.throws(() => verifyImageArchive(file, receipt, authorization), /ARCHIVE_MISMATCH/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Gaming artifact wrapper cannot accept a caller-selected Dockerfile or build profile', async () => {
  await assert.rejects(runGamingPreviewBuild(['build', 'authorization.json', 'output', '--profile', 'other']), /ARGUMENT_INVALID/u);
});

test('Gaming source archive fixes autocrlf independently of owner operating system while preserving historical arguments', () => {
  assert.deepEqual(previewSourceArchiveArguments(authorization.headSha, 'gaming'),
    ['-c', 'core.autocrlf=false', 'archive', '--format=tar', authorization.headSha]);
  assert.deepEqual(previewSourceArchiveArguments(authorization.headSha), ['archive', '--format=tar', authorization.headSha]);
  assert.throws(() => previewSourceArchiveArguments(authorization.headSha, '../caller-selected-profile'), /PROFILE_INVALID/u);
});

function archiveProcess(stream, close = true) {
  const child = new EventEmitter(); child.stdout = stream; child.stderr = new PassThrough();
  child.kill = () => { stream.destroy(); setImmediate(() => child.emit('close', 1)); };
  if (close) setImmediate(() => child.emit('close', 0));
  return child;
}

test('Gaming archive streams beyond the historical 128 MiB stdout cliff without truncating source or digest', async () => {
  const root = fixture();
  try {
    const chunk = Buffer.alloc(1024 * 1024, 0x61), expected = createHash('sha256');
    for (let index = 0; index < 129; index++) expected.update(chunk);
    const file = path.join(root, 'source.tar');
    const result = await materializeGamingSourceArchive({ candidate: authorization.headSha, file,
      spawnArchive: (program, args) => {
        assert.equal(program, 'git'); assert.deepEqual(args, previewSourceArchiveArguments(authorization.headSha, 'gaming'));
        return archiveProcess(Readable.from((function* () { for (let index = 0; index < 129; index++) yield chunk; })()));
      } });
    assert.equal(result.bytes, 129 * 1024 * 1024); assert.equal(statSync(file).size, result.bytes);
    assert.equal(result.sha256, expected.digest('hex'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Gaming source materialization fails closed on byte cap, deadline and failed Git process', async () => {
  const root = fixture();
  try {
    await assert.rejects(materializeGamingSourceArchive({ candidate: authorization.headSha, file: path.join(root, 'over.tar'),
      maxBytes: 2, spawnArchive: () => archiveProcess(Readable.from([Buffer.from('over')])) }), /SOURCE_ARCHIVE_LIMIT/u);
    await assert.rejects(materializeGamingSourceArchive({ candidate: authorization.headSha, file: path.join(root, 'timeout.tar'),
      timeoutMs: 5, spawnArchive: () => archiveProcess(new PassThrough(), false) }), /SOURCE_ARCHIVE_TIMEOUT/u);
    await assert.rejects(materializeGamingSourceArchive({ candidate: authorization.headSha, file: path.join(root, 'failed.tar'),
      spawnArchive: () => {
        const child = archiveProcess(Readable.from([Buffer.from('partial')]), false);
        setImmediate(() => child.emit('close', 1)); return child;
      } }), /SOURCE_ARCHIVE_READ_FAILED/u);
    await assert.rejects(materializeGamingSourceArchive({ candidate: authorization.headSha, file: path.join(root, 'raised.tar'),
      maxBytes: 512 * 1024 * 1024 + 1 }), /SOURCE_ARCHIVE_BOUND_INVALID/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Gaming Docker profile isolates dependency fetching from candidate execution and pins root-owned launch', () => {
  const dockerfile = readFileSync(new URL('./gaming-preview.Dockerfile', import.meta.url), 'utf8');
  const dependencies = dockerfile.split('AS dependencies')[1].split('FROM dependencies AS build')[0];
  assert.match(dependencies, /npm ci --include=dev --ignore-scripts/u);
  assert.doesNotMatch(dependencies, /COPY[^\n]+candidate\/\s/u);
  const build = dockerfile.split('FROM dependencies AS build')[1].split('FROM scratch')[0];
  assert.match(build, /RUN --network=none CI=true node scripts\/postinstall\.cjs/u);
  assert.match(build, /npm prune --offline --omit=dev --ignore-scripts/u);
  assert.match(dockerfile, /RUN --network=none rm -f \/app\/\.npmrc/u);
  assert.match(dockerfile, /gcc -O2 -Wall -Wextra -Werror -static/u);
  const final = dockerfile.split(/^FROM /mu).at(-1);
  assert.match(final, /COPY --from=tooling --chmod=0555 \/opt\/gaming-preview\/network-deny/u);
  assert.match(final, /USER node\nEXPOSE 8080\nENTRYPOINT \["\/opt\/gaming-preview\/network-deny", "\/usr\/local\/bin\/node", "\/opt\/gaming-preview\/runtime\.mjs"\]/u);
  assert.doesNotMatch(final, /(?:--chown|chown).*\/opt\/gaming-preview/u);
});

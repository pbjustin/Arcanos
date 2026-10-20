import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { sha256 } from './stacked-draft-preview-build.mjs';
import { publishGamingImage } from './gaming-preview-publish.mjs';

const repository = 'ghcr.io/pbjustin/arcanos-gaming-preview';
const imageId = `sha256:${'d'.repeat(64)}`;
const image = `${repository}@sha256:${'e'.repeat(64)}`;
const now = Date.parse('2026-10-19T22:00:00.000Z');
const uuid = digit => `${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}`;
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'gaming-publish-'));
  const authorization = { version: 1, controllerSha: 'a'.repeat(40), mainSha: 'a'.repeat(40), baseSha: 'a'.repeat(40),
    headSha: '1c1e7d0f4c8f4e62fd7117e28efd0d8d7c415262', treeSha: '89f1eb0b988514d92ef9f82dd2f77bc356735b8b',
    sourceArchiveSha256: sha256('immutable source archive'), targetSha256: 'f'.repeat(64),
    expiresAt: new Date(now + 60_000).toISOString(), runId: '1234',
    target: { projectId: uuid('1'), baseEnvironmentId: uuid('2'), workerServiceId: uuid('3'), webServiceId: uuid('4') } };
  const receipt = { schemaVersion: 1, controllerSha: authorization.controllerSha,
    candidateSha: authorization.headSha, treeSha: authorization.treeSha, sourceArchiveSha256: authorization.sourceArchiveSha256,
    expiresAt: authorization.expiresAt, compiledSha256: '0'.repeat(64), compiledFiles: 6, compiledBytes: 100,
    runtimeDevDependenciesPruned: true, runtimeDependencyInventorySha256: '1'.repeat(64),
    imageId, imageArchiveSha256: sha256('immutable image archive'), previewLane: 'gaming-synthetic-v1',
    runtimeEgressPolicy: 'linux-seccomp-no-outbound-v1', targetSha256: authorization.targetSha256,
    runId: '1234', runtimeEnvironmentName: 'pr-03ac67-1558', runtimeTarget: authorization.target,
    kernelPolicySha256: '2'.repeat(64), kernelLauncherSha256: '3'.repeat(64) };
  const files = Object.fromEntries(['authorization', 'build', 'image', 'source', 'output'].map(name => [`${name}File`, path.join(root, `${name}.json`)]));
  writeFileSync(files.authorizationFile, JSON.stringify(authorization)); writeFileSync(files.buildFile, JSON.stringify(receipt));
  writeFileSync(files.imageFile, 'immutable image archive'); writeFileSync(files.sourceFile, 'immutable source archive');
  const commands = [], requests = [];
  const environment = { GITHUB_REPOSITORY: 'pbjustin/Arcanos', GITHUB_ACTOR: 'pbjustin', EVENT_SENDER: 'pbjustin',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: 'pbjustin/Arcanos/.github/workflows/railway-gaming-preview.yml@refs/heads/main',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '1234', GITHUB_SHA: authorization.controllerSha,
    CONTROLLER_SHA: authorization.controllerSha, GHCR_TOKEN: 'test-only-token', PATH: '/usr/bin', HOME: '/tmp',
    RAILWAY_API_TOKEN: 'mock-must-not-pass', OPENAI_API_KEY: 'mock-must-not-pass', NODE_OPTIONS: 'mock-must-not-pass' };
  const execute = (program, args, options) => {
    assert.equal(program, 'docker'); assert.equal(args[0], '--host=unix:///var/run/docker.sock');
    assert.equal(options.env.GHCR_TOKEN, undefined); assert.equal(options.env.RAILWAY_API_TOKEN, undefined);
    assert.equal(options.env.OPENAI_API_KEY, undefined); assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.ok(!args.includes('run') && !args.includes('start') && !args.includes('exec'));
    commands.push(args.slice(1));
    if (args.includes('{{.Id}}')) return imageId;
    if (args.includes('{{json .RepoDigests}}')) return JSON.stringify([image]);
    if (args.includes('login')) assert.equal(options.input, 'test-only-token');
    return '';
  };
  const fetchImpl = async (url, init) => {
    requests.push(url); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.equal(url, 'https://api.github.com/user/packages/container/arcanos-gaming-preview');
    assert.equal(init.headers.authorization, 'Bearer test-only-token');
    return new Response(JSON.stringify({ id: 123, name: 'arcanos-gaming-preview', package_type: 'container',
      visibility: 'private', owner: { login: 'pbjustin' } }), { headers: { 'content-type': 'application/json' } });
  };
  return { root, authorization, receipt, files, commands, requests,
    options: { ...files, environment, fetchImpl, execute, now: () => now } };
}

test('Gaming publisher verifies immutable inputs and private package, loads data then publishes digest without candidate execution', async () => {
  const f = fixture();
  try {
    const published = await publishGamingImage(f.options);
    assert.equal(published.image, image); assert.equal(published.imageId, imageId);
    assert.equal(f.requests.length, 1); assert.equal(f.commands.filter(args => args[0] === 'push').length, 1);
    assert.ok(f.commands.findIndex(args => args[0] === 'load') < f.commands.findIndex(args => args[0] === 'login'));
    assert.equal(f.commands.at(-1)[0], 'logout'); assert.equal(existsSync(f.files.outputFile), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Gaming publisher refuses archive and image drift before network or Docker authority', async () => {
  for (const field of ['sourceFile', 'imageFile']) {
    const f = fixture();
    try {
      writeFileSync(f.files[field], 'substituted');
      await assert.rejects(publishGamingImage(f.options), /(?:SOURCE_ARCHIVE_DRIFT|IMAGE_ARCHIVE_MISMATCH)/u);
      assert.equal(f.commands.length, 0); assert.equal(f.requests.length, 0); assert.equal(existsSync(f.files.outputFile), false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('Gaming publisher refuses unauthorized context, target drift and expired authorization before network or Docker', async () => {
  for (const mode of ['owner', 'branch', 'expiry', 'target']) {
    const f = fixture();
    try {
      const options = { ...f.options, environment: { ...f.options.environment } };
      if (mode === 'owner') options.environment.GITHUB_ACTOR = 'other';
      if (mode === 'branch') options.environment.GITHUB_REF = 'refs/heads/feature';
      if (mode === 'expiry') options.now = () => now + 60_001;
      if (mode === 'target') writeFileSync(f.files.buildFile, JSON.stringify({ ...f.receipt, targetSha256: '9'.repeat(64) }));
      await assert.rejects(publishGamingImage(options), /(?:AUTHORITY_INVALID|RECEIPT_MISMATCH)/u);
      assert.equal(f.commands.length, 0); assert.equal(f.requests.length, 0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('Gaming publisher requires existing exact private owner package before loading or logging in', async () => {
  for (const value of [{ visibility: 'public' }, { owner: { login: 'other' } },
    { name: 'other-package' }, { package_type: 'npm' }]) {
    const f = fixture();
    try {
      await assert.rejects(publishGamingImage({ ...f.options, fetchImpl: async () => new Response(JSON.stringify({
        id: 123, name: 'arcanos-gaming-preview', package_type: 'container', visibility: 'private',
        owner: { login: 'pbjustin' }, ...value }), { status: value.status ?? 200, headers: { 'content-type': 'application/json' } }) }), /PRIVATE_PACKAGE_REQUIRED/u);
      assert.equal(f.commands.length, 0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('authenticated-owner metadata access denial fails before Docker without a public or anonymous fallback', async () => {
  for (const status of [401, 403, 404]) {
    const f = fixture(); const requests = [];
    try {
      await assert.rejects(publishGamingImage({ ...f.options, fetchImpl: async (url, init) => {
        requests.push(url); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
        assert.equal(init.headers.authorization, 'Bearer test-only-token');
        return new Response('{}', { status, headers: { 'content-type': 'application/json' } });
      } }), /PRIVATE_PACKAGE_REQUIRED/u);
      assert.deepEqual(requests, ['https://api.github.com/user/packages/container/arcanos-gaming-preview']);
      assert.equal(f.commands.length, 0); assert.equal(existsSync(f.files.outputFile), false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('Gaming publisher has no alternate ambient credential fallback for metadata or publication', async () => {
  const f = fixture();
  try {
    await assert.rejects(publishGamingImage({ ...f.options,
      environment: { ...f.options.environment, GHCR_TOKEN: '', GITHUB_TOKEN: 'mock-alternate-token', GH_TOKEN: 'mock-alternate-token' } }), /TOKEN_REQUIRED/u);
    assert.equal(f.commands.length, 0); assert.equal(f.requests.length, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Gaming publisher rejects loaded image substitution before authentication and expires before push with logout', async () => {
  const first = fixture();
  try {
    await assert.rejects(publishGamingImage({ ...first.options, execute: (program, args, options) =>
      args.includes('{{.Id}}') ? `sha256:${'9'.repeat(64)}` : first.options.execute(program, args, options) }), /IMAGE_ID_DRIFT/u);
    assert.equal(first.commands.some(args => args[0] === 'login'), false);
  } finally { rmSync(first.root, { recursive: true, force: true }); }
  const second = fixture(); let checks = 0;
  try {
    await assert.rejects(publishGamingImage({ ...second.options, now: () => ++checks === 1 ? now : now + 60_001 }), /AUTHORIZATION_EXPIRED/u);
    assert.equal(second.commands.some(args => args[0] === 'push'), false);
    assert.equal(second.commands.at(-1)[0], 'logout'); assert.equal(existsSync(second.files.outputFile), false);
  } finally { rmSync(second.root, { recursive: true, force: true }); }
});

test('Gaming publisher binds protected main and approved base to the exact controller before any authority', async () => {
  for (const field of ['mainSha', 'baseSha']) {
    const f = fixture();
    try {
      writeFileSync(f.files.authorizationFile, JSON.stringify({ ...f.authorization, [field]: '9'.repeat(40) }));
      await assert.rejects(publishGamingImage(f.options), /GAMING_BUILD_AUTHORIZATION_INVALID/u);
      assert.equal(f.commands.length, 0); assert.equal(f.requests.length, 0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('Gaming publisher cannot raise its package request deadline above fifteen seconds', async () => {
  for (const packageTimeoutMs of [0, -1, 15_001, Infinity]) {
    const f = fixture();
    try {
      await assert.rejects(publishGamingImage({ ...f.options, packageTimeoutMs }), /PACKAGE_TIMEOUT_INVALID/u);
      assert.equal(f.commands.length, 0); assert.equal(f.requests.length, 0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('Gaming publisher deadline rejects noncooperative fetch and streamed reads without awaiting cancellation', async () => {
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    for (const mode of ['fetch', 'body']) {
      const f = fixture(); let cancellations = 0;
      try {
        const fetchImpl = mode === 'fetch' ? () => new Promise(() => {}) : async () => ({
          status: 200, redirected: false, headers: new Headers({ 'content-type': 'application/json' }),
          body: { getReader: () => ({ read: () => new Promise(() => {}),
            cancel: () => { cancellations++; return new Promise(() => {}); }, releaseLock: () => {} }) },
        });
        await assert.rejects(publishGamingImage({ ...f.options, fetchImpl, packageTimeoutMs: 10 }), /PACKAGE_DEADLINE/u);
        assert.equal(f.commands.length, 0); assert.equal(existsSync(f.files.outputFile), false);
        if (mode === 'body') assert.equal(cancellations, 1);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }
  } finally { clearTimeout(keepAlive); }
});

test('Gaming publisher cancels a late response after deadline and never publishes it', async () => {
  const f = fixture(); let cancellations = 0;
  try {
    const fetchImpl = () => new Promise(resolve => setTimeout(() => resolve({
      body: { cancel: () => { cancellations++; return new Promise(() => {}); } },
    }), 25));
    await assert.rejects(publishGamingImage({ ...f.options, fetchImpl, packageTimeoutMs: 5 }), /PACKAGE_DEADLINE/u);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(cancellations, 1); assert.equal(f.commands.length, 0); assert.equal(existsSync(f.files.outputFile), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

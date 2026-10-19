import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runGamingImageSmoke } from './gaming-preview-image-smoke.mjs';
import { buildGamingScopedPreviewAssertionInventory } from './gaming-scoped-preview-e2e.mjs';
import { sha256 } from './stacked-draft-preview-build.mjs';

const uuid = digit => `${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}`;
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'gaming-image-smoke-'));
  const auth = { version: 1, controllerSha: 'a'.repeat(40), mainSha: 'a'.repeat(40), baseSha: 'a'.repeat(40),
    headSha: '1c1e7d0f4c8f4e62fd7117e28efd0d8d7c415262', treeSha: '89f1eb0b988514d92ef9f82dd2f77bc356735b8b',
    sourceArchiveSha256: 'b'.repeat(64), targetSha256: 'c'.repeat(64), runId: '1234',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    target: { projectId: uuid('1'), baseEnvironmentId: uuid('2'), workerServiceId: uuid('3'), webServiceId: uuid('4') } };
  const build = { schemaVersion: 1, controllerSha: auth.controllerSha, candidateSha: auth.headSha, treeSha: auth.treeSha,
    sourceArchiveSha256: auth.sourceArchiveSha256, expiresAt: auth.expiresAt, compiledSha256: 'd'.repeat(64),
    compiledFiles: 6, compiledBytes: 100, runtimeDevDependenciesPruned: true, runtimeDependencyInventorySha256: 'e'.repeat(64),
    imageId: `sha256:${'f'.repeat(64)}`, imageArchiveSha256: sha256('mock image'), previewLane: 'gaming-synthetic-v1',
    runtimeEgressPolicy: 'linux-seccomp-no-outbound-v1', targetSha256: auth.targetSha256, runId: auth.runId,
    runtimeEnvironmentName: 'pr-03ac67-1558', runtimeTarget: auth.target,
    kernelPolicySha256: '0'.repeat(64), kernelLauncherSha256: '1'.repeat(64) };
  const files = Object.fromEntries(['authorization', 'build', 'image', 'output'].map(name => [`${name}File`, path.join(root, name)]));
  writeFileSync(files.authorizationFile, JSON.stringify(auth)); writeFileSync(files.buildFile, JSON.stringify(build));
  writeFileSync(files.imageFile, 'mock image');
  const commands = [], containers = new Map(), requests = [];
  const execute = (program, all, options) => {
    assert.equal(program, 'docker'); assert.equal(all[0], '--host=unix:///var/run/docker.sock');
    assert.equal(options.env.OPENAI_API_KEY, undefined); assert.equal(options.env.GITHUB_TOKEN, undefined);
    const args = all.slice(1); commands.push(args);
    if (args[0] === 'run') {
      assert.ok(args.includes('--pull=never') && args.includes('--cap-drop=ALL') && args.includes('--read-only'));
      assert.equal(args.includes('--entrypoint'), false); assert.equal(args.at(-1), build.imageId);
      assert.ok(args.includes('127.0.0.1::8080'));
      const name = args[args.indexOf('--name') + 1], id = String(containers.size + 1).repeat(64), labels = {};
      for (let index = 0; index < args.length; index++) if (args[index] === '--label') {
        const [key, value] = args[++index].split('='); labels[key] = value;
      }
      containers.set(name, { Id: id, Name: `/${name}`, Image: build.imageId, Config: { Labels: labels } }); return id;
    }
    if (args[0] === 'port') return args[1].includes('-worker-') ? '127.0.0.1:18081' : '127.0.0.1:18082';
    if (args[0] === 'logs') return 'GAMING_PREVIEW_KERNEL_NETWORK_BOUNDARY=ENFORCED';
    if (args[0] === 'inspect') return JSON.stringify(containers.get(args.at(-1)));
    if (args[0] === 'rm') {
      const entry = [...containers.entries()].find(([, value]) => value.Id === args[2]);
      if (entry) containers.delete(entry[0]); return args[2];
    }
    if (args[0] === 'ps') {
      const filter = args[args.indexOf('--filter') + 1];
      if (filter.startsWith('id=')) return [...containers.values()].some(value => value.Id === filter.slice(3)) ? 'container-still-present' : '';
      const name = filter.replace(/^name=\^\//u, '').replace(/\$$/u, '');
      return containers.has(name) ? 'container-still-present' : '';
    }
    throw new Error('UNEXPECTED_DOCKER_COMMAND');
  };
  const fetchLocal = async (url, init) => {
    const parsed = new URL(url); assert.equal(parsed.hostname, '127.0.0.1'); assert.equal(parsed.protocol, 'http:');
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); requests.push(parsed.href);
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  };
  const verify = async ({ fetchImpl, args }) => {
    const origin = args[args.indexOf('--web-base-url') + 1];
    for (let index = 0; index < 84; index++) await fetchImpl(`${origin}/readyz`, {});
    const plannedCaseIds = buildGamingScopedPreviewAssertionInventory();
    return { GAMING_SCOPED_PREVIEW: 'NOT_RUN', hostedExecuted: null, summary: { requestsMade: 84 },
      assertionInventory: { plannedCaseIds, executedCaseIds: [...plannedCaseIds], skippedCaseIds: [] } };
  };
  return { root, files, commands, containers, requests, options: { ...files, environment: { PATH: '/usr/bin' }, execute, fetchLocal, verify } };
}

test('local image smoke preserves kernel entrypoint, uses two contained roles and maps only loopback requests', async () => {
  const f = fixture();
  try {
    const result = await runGamingImageSmoke(f.options);
    assert.equal(result.status, 'PASS'); assert.equal(result.executedAssertions, 84);
    assert.equal(result.GAMING_SCOPED_PREVIEW, 'NOT_RUN'); assert.equal(result.hostedExecuted, false);
    assert.deepEqual(result.kernelEntrypointVerified, { worker: true, web: true });
    assert.equal(result.cleanup.verifiedAbsent, true); assert.equal(f.containers.size, 0); assert.equal(f.requests.length, 86);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('local image smoke refuses any outbound-origin substitution and always removes owned containers', async () => {
  const f = fixture();
  try {
    await assert.rejects(runGamingImageSmoke({ ...f.options, verify: async ({ fetchImpl }) => fetchImpl('https://api.notion.com/v1/users', {}) }), /OUTBOUND_ORIGIN_FORBIDDEN/u);
    assert.equal(f.containers.size, 0); assert.equal(f.requests.length, 2);
    const evidence = JSON.parse(readFileSync(f.files.outputFile, 'utf8'));
    assert.equal(evidence.status, 'FAIL'); assert.equal(evidence.cleanup.verifiedAbsent, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('local image smoke refuses credentials and immutable-image substitution before container creation', async () => {
  for (const mode of ['credentials', 'image']) {
    const f = fixture();
    try {
      if (mode === 'image') writeFileSync(f.files.imageFile, 'substituted');
      await assert.rejects(runGamingImageSmoke({ ...f.options,
        environment: mode === 'credentials' ? { OPENAI_API_KEY: 'mock-must-not-pass' } : {} }), /(?:CREDENTIALS_FORBIDDEN|IMAGE_ARCHIVE_MISMATCH)/u);
      assert.equal(f.commands.length, 0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('local image smoke fails when actual container absence cannot be verified', async () => {
  const f = fixture();
  try {
    await assert.rejects(runGamingImageSmoke({ ...f.options, execute: (program, args, options) =>
      args[1] === 'ps' && args.some(value => value.startsWith('id=')) ? 'still-present' : f.options.execute(program, args, options) }), /CLEANUP_UNVERIFIED/u);
    assert.equal(JSON.parse(readFileSync(f.files.outputFile, 'utf8')).cleanup.verifiedAbsent, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('local image smoke preserves a preexisting name collision without running or removing any container', async () => {
  const f = fixture(); let removals = 0, runs = 0;
  try {
    await assert.rejects(runGamingImageSmoke({ ...f.options, execute: (_program, args) => {
      if (args[1] === 'run') runs++;
      if (args[1] === 'rm') removals++;
      return 'preexisting-container';
    } }), /CONTAINER_NAME_COLLISION/u);
    assert.equal(runs, 0); assert.equal(removals, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('local image smoke recovers only exact labeled partial creation and refuses substituted ownership', async () => {
  for (const substitute of [false, true]) {
    const f = fixture(); let removals = 0;
    try {
      await assert.rejects(runGamingImageSmoke({ ...f.options, execute: (program, args, options) => {
        if (args[1] === 'rm') removals++;
        const value = f.options.execute(program, args, options);
        if (args[1] === 'run') throw new Error('MOCK_RUN_RESPONSE_LOST');
        if (substitute && args[1] === 'inspect') {
          const changed = JSON.parse(value); changed.Config.Labels['io.arcanos.gaming-smoke.owner'] = 'mock-other-owner';
          return JSON.stringify(changed);
        }
        return value;
      } }), substitute ? /CLEANUP_UNVERIFIED/u : /MOCK_RUN_RESPONSE_LOST/u);
      assert.equal(removals, substitute ? 0 : 1); assert.equal(f.containers.size, substitute ? 1 : 0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

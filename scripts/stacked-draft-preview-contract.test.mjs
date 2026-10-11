import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import {
  DEFAULT_POLICY, REVIEWED_STACK_ANCHORS, GitHubReadAdapter, GitReadAdapter, requireDeploymentActivation,
  validateAuthorization, verifyStack,
} from './stacked-draft-preview-contract.mjs';

const execute = promisify(execFile);
const NOW = Date.UTC(2040, 0, 1);
const CONTROLLER = 'c'.repeat(40);
const DIGEST = 'd'.repeat(64);
const copy = value => structuredClone(value);
const errorCode = code => error => error?.code === code;
let directory;
let heads;
let trees;
let archiveDigest;
let git;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'arcanos-stacked-contract-'));
  const run = args => execute('git', args, { cwd: directory });
  await run(['init', '--initial-branch=main']);
  heads = [];
  trees = [];
  for (let index = 0; index < 4; index += 1) {
    await writeFile(join(directory, 'fixture.txt'), `reviewed fixture ${index}\n`);
    await run(['add', 'fixture.txt']);
    await run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', `fixture ${index}`]);
    heads.push((await run(['rev-parse', 'HEAD'])).stdout.trim());
    trees.push((await run(['rev-parse', 'HEAD^{tree}'])).stdout.trim());
  }
  const archive = await execute('git', ['archive', '--format=tar', heads[3]], { cwd: directory, encoding: 'buffer' });
  archiveDigest = createHash('sha256').update(archive.stdout).digest('hex');
  git = new GitReadAdapter({ cwd: directory });
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function policy() {
  return { ...copy(DEFAULT_POLICY), enabled: true, target: {
    workspaceId: '00000001-0000-0000-0000-000000000001',
    projectId: '00000002-0000-0000-0000-000000000002',
    baseEnvironmentId: '00000003-0000-0000-0000-000000000003',
    workerServiceId: '00000004-0000-0000-0000-000000000004',
    webServiceId: '00000005-0000-0000-0000-000000000005',
    region: 'us-west2', cpuLimit: 0.5, memoryLimitGb: 0.5,
    imageRepository: DEFAULT_POLICY.imageRepository,
  } };
}

function rawAuthorization() {
  return { version: 1, controllerSha: CONTROLLER, mainSha: heads[0],
    expiresAt: new Date(NOW + 60 * 60 * 1000).toISOString(),
    stack: DEFAULT_POLICY.stack.map((entry, index) => ({ prNumber: entry.prNumber,
      headSha: heads[index + 1], treeSha: trees[index + 1] })), sourceArchiveSha256: archiveDigest };
}

function authorizationArguments() {
  return { authorization: rawAuthorization(), policy: policy(), actor: 'pbjustin',
    repository: 'pbjustin/Arcanos', controllerSha: CONTROLLER, now: NOW };
}

function pullRequests() {
  return DEFAULT_POLICY.stack.map((entry, index) => ({ number: entry.prNumber, state: 'open', draft: true,
    head: { ref: entry.headRef, sha: heads[index + 1], repo: { full_name: 'pbjustin/Arcanos' } },
    base: { ref: entry.baseRef, sha: heads[index], repo: { full_name: 'pbjustin/Arcanos' } } }));
}

function stackArguments() {
  return { authorization: validateAuthorization(authorizationArguments()), pullRequests: pullRequests(),
    mainSha: heads[0], controllerSha: CONTROLLER, git: gitFunctions(), now: NOW };
}

test('closed checked-in policy permits authorization audit while deployment remains blocked', () => {
  assert.equal(DEFAULT_POLICY.enabled, false);
  assert.equal(DEFAULT_POLICY.target, null);
  const args = { ...authorizationArguments(), policy: DEFAULT_POLICY, requireActivation: false };
  const snapshot = validateAuthorization(args);
  assert.equal(snapshot.policy.enabled, false);
  assert.throws(() => requireDeploymentActivation(snapshot), errorCode('STACKED_PREVIEW_ACTIVATION_BLOCKED'));
  assert.throws(() => validateAuthorization({ ...args, requireActivation: true }), errorCode('STACKED_PREVIEW_ACTIVATION_BLOCKED'));
});

test('authorization isolates owner-approved content and policy from subsequent mutations', () => {
  const args = authorizationArguments();
  const snapshot = validateAuthorization(args);
  args.authorization.stack[0].headSha = CONTROLLER;
  args.policy.target.projectId = DEFAULT_POLICY.forbiddenProjectIds[0];
  assert.equal(snapshot.stack[0].headSha, heads[1]);
  assert.equal(snapshot.policy.target.projectId, '00000002-0000-0000-0000-000000000002');
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.stack) && Object.isFrozen(snapshot.stack[0]));
  assert.throws(() => { snapshot.stack[0].headSha = CONTROLLER; }, TypeError);
  assert.equal(requireDeploymentActivation(snapshot).imageRepository, DEFAULT_POLICY.imageRepository);
});

test('optional pull credential fingerprint stays bound to the owner-reviewed target', () => {
  const args = authorizationArguments();
  args.policy.target.registryPullCredentialSha256 = DIGEST;
  const snapshot = validateAuthorization(args);
  args.policy.target.registryPullCredentialSha256 = 'e'.repeat(64);
  assert.equal(requireDeploymentActivation(snapshot).registryPullCredentialSha256, DIGEST);
});

const authorizationRejections = [
  ['non-owner actor', args => { args.actor = 'collaborator'; }, 'STACKED_PREVIEW_OWNER_AUTHORIZATION_REQUIRED'],
  ['lookalike owner', args => { args.actor = 'PBJustin'; }, 'STACKED_PREVIEW_OWNER_AUTHORIZATION_REQUIRED'],
  ['different repository', args => { args.repository = 'pbjustin/Other'; }, 'STACKED_PREVIEW_OWNER_AUTHORIZATION_REQUIRED'],
  ['controller drift', args => { args.controllerSha = 'e'.repeat(40); }, 'STACKED_PREVIEW_CONTROLLER_DRIFT'],
  ['upper-case SHA', args => { args.authorization.controllerSha = 'C'.repeat(40); }, 'STACKED_PREVIEW_CONTROLLER_INVALID'],
  ['short SHA', args => { args.authorization.mainSha = '1234'; }, 'STACKED_PREVIEW_MAIN_INVALID'],
  ['extra authorization key', args => { args.authorization.permitProduction = true; }, 'STACKED_PREVIEW_AUTHORIZATION_INVALID'],
  ['unsupported schema', args => { args.authorization.version = 2; }, 'STACKED_PREVIEW_AUTHORIZATION_INVALID'],
  ['missing PR', args => { args.authorization.stack.pop(); }, 'STACKED_PREVIEW_AUTHORIZED_STACK_INVALID'],
  ['duplicate PR', args => { args.authorization.stack[1].prNumber = 1533; }, 'STACKED_PREVIEW_AUTHORIZED_STACK_INVALID'],
  ['different PR', args => { args.authorization.stack[2].prNumber = 9999; }, 'STACKED_PREVIEW_AUTHORIZED_STACK_INVALID'],
  ['different order', args => { args.authorization.stack.reverse(); }, 'STACKED_PREVIEW_AUTHORIZED_STACK_INVALID'],
  ['invalid tree', args => { args.authorization.stack[2].treeSha = 'a'.repeat(39); }, 'STACKED_PREVIEW_AUTHORIZED_STACK_INVALID'],
  ['invalid archive digest', args => { args.authorization.sourceArchiveSha256 = 'D'.repeat(64); }, 'STACKED_PREVIEW_ARCHIVE_DIGEST_INVALID'],
  ['expired', args => { args.authorization.expiresAt = new Date(NOW).toISOString(); }, 'STACKED_PREVIEW_AUTHORIZATION_EXPIRED'],
  ['long TTL', args => { args.authorization.expiresAt = new Date(NOW + 7200_001).toISOString(); }, 'STACKED_PREVIEW_AUTHORIZATION_TTL_EXCEEDED'],
  ['timezone ambiguity', args => { args.authorization.expiresAt = '2040-01-01T01:00:00'; }, 'STACKED_PREVIEW_EXPIRY_INVALID'],
  ['invalid calendar date', args => { args.authorization.expiresAt = '2040-02-30T01:00:00.000Z'; }, 'STACKED_PREVIEW_EXPIRY_INVALID'],
  ['policy widens TTL', args => { args.policy.maxAuthorizationSeconds = 7201; }, 'STACKED_PREVIEW_POLICY_INVALID'],
  ['policy changes refs', args => { args.policy.stack[0].baseRef = 'production'; }, 'STACKED_PREVIEW_POLICY_INVALID'],
  ['policy removes production exclusion', args => { args.policy.forbiddenProjectIds = []; }, 'STACKED_PREVIEW_POLICY_INVALID'],
  ['policy changes image namespace', args => { args.policy.imageRepository = 'ghcr.io/attacker/image'; }, 'STACKED_PREVIEW_POLICY_INVALID'],
  ['forbidden target', args => { args.policy.target.projectId = DEFAULT_POLICY.forbiddenProjectIds[0]; }, 'STACKED_PREVIEW_TARGET_BLOCKED'],
  ['production workspace', args => { args.policy.target.workspaceId = '1c9265a3-986f-4304-ad3e-5a874caab039'; }, 'STACKED_PREVIEW_TARGET_BLOCKED'],
  ['uppercase pull credential fingerprint', args => { args.policy.target.registryPullCredentialSha256 = 'D'.repeat(64); }, 'STACKED_PREVIEW_TARGET_BLOCKED'],
  ['short pull credential fingerprint', args => { args.policy.target.registryPullCredentialSha256 = 'd'.repeat(63); }, 'STACKED_PREVIEW_TARGET_BLOCKED'],
  ['non-string pull credential fingerprint', args => { args.policy.target.registryPullCredentialSha256 = 123; }, 'STACKED_PREVIEW_TARGET_BLOCKED'],
  ['shared service', args => { args.policy.target.workerServiceId = args.policy.target.webServiceId; }, 'STACKED_PREVIEW_TARGET_BLOCKED'],
  ['excessive CPU', args => { args.policy.target.cpuLimit = 2; }, 'STACKED_PREVIEW_TARGET_BLOCKED'],
  ['excessive memory', args => { args.policy.target.memoryLimitGb = Infinity; }, 'STACKED_PREVIEW_TARGET_BLOCKED'],
  ['target image drift', args => { args.policy.target.imageRepository = 'ghcr.io/pbjustin/other'; }, 'STACKED_PREVIEW_TARGET_BLOCKED'],
  ['extra target field', args => { args.policy.target.production = false; }, 'STACKED_PREVIEW_TARGET_BLOCKED'],
];
for (const [name, mutate, code] of authorizationRejections) {
  test(`authorization rejects ${name}`, () => {
    const args = authorizationArguments();
    mutate(args);
    assert.throws(() => validateAuthorization(args), errorCode(code));
  });
}

test('exact approved integrated stack binds real git trees, ancestry, and independently hashed archive', async () => {
  const evidence = await verifyStack(stackArguments());
  assert.equal(evidence.candidateSha, heads[3]);
  assert.equal(evidence.mainSha, heads[0]);
  assert.equal(evidence.treeSha, trees[3]);
  assert.equal(evidence.sourceArchiveSha256, archiveDigest);
  assert.deepEqual(evidence.stack.map(entry => entry.baseSha), heads.slice(0, 3));
  assert.ok(Object.isFrozen(evidence.stack[2]));
});

const stackRejections = [
  ['main drift', args => { args.mainSha = heads[1]; }, 'STACKED_PREVIEW_MAIN_DRIFT'],
  ['controller drift', args => { args.controllerSha = heads[0]; }, 'STACKED_PREVIEW_CONTROLLER_DRIFT'],
  ['closed PR', args => { args.pullRequests[0].state = 'closed'; }, 'STACKED_PREVIEW_OPEN_DRAFT_REQUIRED'],
  ['ready-for-review PR', args => { args.pullRequests[1].draft = false; }, 'STACKED_PREVIEW_OPEN_DRAFT_REQUIRED'],
  ['missing PR', args => { args.pullRequests.pop(); }, 'STACKED_PREVIEW_PR_SNAPSHOTS_INVALID'],
  ['reordered PR', args => { args.pullRequests.reverse(); }, 'STACKED_PREVIEW_OPEN_DRAFT_REQUIRED'],
  ['fork head', args => { args.pullRequests[2].head.repo.full_name = 'fork/Arcanos'; }, 'STACKED_PREVIEW_REPOSITORY_DRIFT'],
  ['fork base', args => { args.pullRequests[0].base.repo.full_name = 'fork/Arcanos'; }, 'STACKED_PREVIEW_REPOSITORY_DRIFT'],
  ['head branch drift', args => { args.pullRequests[2].head.ref = 'other'; }, 'STACKED_PREVIEW_BRANCH_DRIFT'],
  ['base branch drift', args => { args.pullRequests[1].base.ref = 'main'; }, 'STACKED_PREVIEW_BRANCH_DRIFT'],
  ['head commit drift', args => { args.pullRequests[2].head.sha = heads[2]; }, 'STACKED_PREVIEW_HEAD_DRIFT'],
  ['base commit drift', args => { args.pullRequests[1].base.sha = heads[0]; }, 'STACKED_PREVIEW_BASE_DRIFT'],
  ['tree drift', args => { args.git = { ...gitFunctions(), treeSha: async () => trees[0] }; }, 'STACKED_PREVIEW_TREE_DRIFT'],
  ['missing ancestor', args => { args.git = { ...gitFunctions(), isAncestor: async () => false }; }, 'STACKED_PREVIEW_ANCESTRY_INVALID'],
  ['missing reviewed foundation', args => { args.git = { ...gitFunctions(),
    isAncestor: async (base, head) => base === REVIEWED_STACK_ANCHORS[0].headShas[0] ? false : gitFunctions().isAncestor(base, head) };
  }, 'STACKED_PREVIEW_REVIEWED_HISTORY_MISSING'],
  ['missing repaired corroboration', args => { args.git = { ...gitFunctions(),
    isAncestor: async (base, head) => base === REVIEWED_STACK_ANCHORS[1].headShas[1] ? false : gitFunctions().isAncestor(base, head) };
  }, 'STACKED_PREVIEW_REVIEWED_HISTORY_MISSING'],
  ['missing reviewed benchmark', args => { args.git = { ...gitFunctions(),
    isAncestor: async (base, head) => base === REVIEWED_STACK_ANCHORS[2].headShas[0] ? false : gitFunctions().isAncestor(base, head) };
  }, 'STACKED_PREVIEW_REVIEWED_HISTORY_MISSING'],
  ['archive drift', args => { args.git = { ...gitFunctions(), archiveSha256: async () => DIGEST }; }, 'STACKED_PREVIEW_ARCHIVE_DRIFT'],
  ['serialized authorization bypass', args => { args.authorization = copy(args.authorization); }, 'STACKED_PREVIEW_AUTHORIZATION_SNAPSHOT_REQUIRED'],
];
function gitFunctions() {
  // The synthetic repository exercises actual git objects; reviewed production ancestor IDs are mocked explicitly.
  const reviewed = new Set(REVIEWED_STACK_ANCHORS.flatMap(entry => entry.headShas));
  return { treeSha: sha => git.treeSha(sha), isAncestor: (base, head) => reviewed.has(base) ? Promise.resolve(true) : git.isAncestor(base, head),
    archiveSha256: sha => git.archiveSha256(sha) };
}
for (const [name, mutate, code] of stackRejections) {
  test(`stack rejects ${name}`, async () => {
    const args = stackArguments();
    mutate(args);
    await assert.rejects(verifyStack(args), errorCode(code));
  });
}

test('authorization expiring during object verification cannot produce deployable evidence', async () => {
  let calls = 0;
  await assert.rejects(verifyStack({ ...stackArguments(), now: () => calls++ === 0 ? NOW : NOW + 3600_000 }),
    errorCode('STACKED_PREVIEW_AUTHORIZATION_EXPIRED'));
});

test('deployment activation independently refuses an expired previously validated snapshot', () => {
  const snapshot = validateAuthorization(authorizationArguments());
  assert.throws(() => requireDeploymentActivation(snapshot, { now: NOW + 3600_000 }),
    errorCode('STACKED_PREVIEW_AUTHORIZATION_EXPIRED'));
});

test('admitted PR snapshots cannot mutate across asynchronous git reads', async () => {
  const args = stackArguments();
  const original = gitFunctions();
  args.git = { ...original, treeSha: async sha => {
    args.pullRequests[2].head.sha = heads[0];
    args.pullRequests[2].base.sha = heads[0];
    return original.treeSha(sha);
  } };
  const evidence = await verifyStack(args);
  assert.equal(evidence.candidateSha, heads[3]);
  assert.equal(evidence.stack[2].baseSha, heads[2]);
});

test('git adapter uses exact object IDs and distinguishes reverse or missing ancestry', async () => {
  assert.equal(await git.isAncestor(heads[0], heads[3]), true);
  assert.equal(await git.isAncestor(heads[3], heads[0]), false);
  await assert.rejects(git.treeSha('--help'), errorCode('STACKED_PREVIEW_SHA_INVALID'));
  await assert.rejects(git.archiveSha256(`${heads[3]}; touch forbidden`), errorCode('STACKED_PREVIEW_SHA_INVALID'));
  await assert.rejects(git.treeSha('0'.repeat(40)), errorCode('STACKED_PREVIEW_GIT_READ_FAILED'));
  assert.equal(typeof git.readObject, 'undefined');
});

function github(fetchImpl) {
  return new GitHubReadAdapter({ token: 'mock-synthetic-offline-token-123456', fetchImpl });
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('GitHub reads only allowlisted canonical resources with GET, no redirects, and bounded deadline', async () => {
  const requests = [];
  const adapter = github(async (url, options) => {
    requests.push({ url, method: options.method, redirect: options.redirect, signal: options.signal });
    if (url.endsWith('/branches/main')) return json({ name: 'main', protected: true, commit: { sha: heads[0] } });
    if (url.endsWith('/permission')) return json({ permission: 'admin', user: { login: 'pbjustin' } });
    return json(pullRequests().find(pr => url.endsWith(`/pulls/${pr.number}`)));
  });
  const snapshot = await adapter.readStack();
  assert.equal(snapshot.mainSha, heads[0]);
  assert.equal(snapshot.mainProtected, true);
  assert.equal((await adapter.readOwnerPermission()).permission, 'admin');
  for (const request of requests) {
    assert.match(request.url, /^https:\/\/api\.github\.com\/repos\/pbjustin\/Arcanos\//u);
    assert.equal(request.method, 'GET');
    assert.equal(request.redirect, 'error');
    assert.ok(request.signal instanceof AbortSignal);
  }
  await assert.rejects(adapter.readPullRequest(9999), errorCode('STACKED_PREVIEW_PR_NOT_ALLOWLISTED'));
  await assert.rejects(adapter.request('/../secrets'), errorCode('STACKED_PREVIEW_GITHUB_RESOURCE_INVALID'));
  assert.equal(requests.length, 5);
});

test('GitHub refuses unprotected main and non-owner admin proof', async () => {
  await assert.rejects(github(async () => json({ name: 'main', protected: false, commit: { sha: heads[0] } })).readMain(),
    errorCode('STACKED_PREVIEW_PROTECTED_MAIN_REQUIRED'));
  for (const receipt of [{ permission: 'write', user: { login: 'pbjustin' } },
    { permission: 'admin', user: { login: 'collaborator' } }]) {
    await assert.rejects(github(async () => json(receipt)).readOwnerPermission(),
      errorCode('STACKED_PREVIEW_OWNER_PERMISSION_REQUIRED'));
  }
});

test('GitHub rejects oversized responses, errors, malformed JSON, and followed redirects without retry', async () => {
  const cases = [
    [() => new Response(' '.repeat(1024 * 1024 + 1)), 'STACKED_PREVIEW_GITHUB_RESPONSE_LIMIT'],
    [() => json({ message: 'denied' }, 403), 'STACKED_PREVIEW_GITHUB_READ_FAILED'],
    [() => new Response('{bad'), 'STACKED_PREVIEW_GITHUB_READ_FAILED'],
    [() => { const response = json({}); Object.defineProperty(response, 'redirected', { value: true }); return response; },
      'STACKED_PREVIEW_GITHUB_READ_FAILED'],
    [() => { throw new Error('sensitive network detail'); }, 'STACKED_PREVIEW_GITHUB_READ_FAILED'],
  ];
  for (const [response, code] of cases) {
    let calls = 0;
    await assert.rejects(github(async () => { calls += 1; return response(); }).readPullRequest(1533), errorCode(code));
    assert.equal(calls, 1);
  }
});

test('GitHub deadline also bounds fetch implementations and body streams that ignore abort', async () => {
  // AbortSignal.timeout is unref'ed; keep this offline test alive while its synthetic network promise hangs.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const hungFetch = new GitHubReadAdapter({ token: 'mock-synthetic-offline-token-123456', timeoutMs: 5,
      fetchImpl: () => new Promise(() => {}) });
    await assert.rejects(hungFetch.readPullRequest(1533), errorCode('STACKED_PREVIEW_GITHUB_READ_FAILED'));
    let canceled = false;
    const hungBody = new GitHubReadAdapter({ token: 'mock-synthetic-offline-token-123456', timeoutMs: 5,
      fetchImpl: async () => new Response(new ReadableStream({ cancel() { canceled = true; } })) });
    await assert.rejects(hungBody.readPullRequest(1533), errorCode('STACKED_PREVIEW_GITHUB_READ_FAILED'));
    assert.equal(canceled, true);
    assert.equal(JSON.stringify(hungBody), '{}');
  } finally {
    clearTimeout(keepAlive);
  }
});

function ciCheck({ id = 10, name = 'All Checks Complete', status = 'completed', conclusion = 'success',
  headSha = heads[3], appId = 15368 } = {}) {
  return { id, name, status, conclusion, head_sha: headSha,
    app: { id: appId, slug: 'github-actions', owner: { login: 'github' } },
    details_url: 'https://github.com/pbjustin/Arcanos/actions/runs/123/job/456' };
}

test('required CI uses latest exact-head contexts and distinguishes a superseded failure from the successful retry', async () => {
  const checks = [ciCheck({ id: 20 }), ciCheck({ id: 10, conclusion: 'failure' }),
    ciCheck({ id: 30, name: 'Hosted legacy preview', conclusion: 'skipped' })];
  const adapter = github(async () => json({ total_count: checks.length, check_runs: checks }));
  const receipt = await adapter.readRequiredCI(heads[3]);
  assert.equal(receipt.headSha, heads[3]);
  assert.equal(receipt.aggregate.id, 20);
  assert.equal(receipt.checks.length, 2);
  assert.ok(Object.isFrozen(receipt.aggregate));
});

test('required CI cannot substitute skipped aggregate, active run, failed context, or another commit', async () => {
  const cases = [
    [[ciCheck({ conclusion: 'skipped' })], 'STACKED_PREVIEW_REQUIRED_CI_NOT_VERIFIED'],
    [[ciCheck(), ciCheck({ id: 11, name: 'Test Suite (unit)', status: 'in_progress', conclusion: null })],
      'STACKED_PREVIEW_CI_NOT_COMPLETE'],
    [[ciCheck(), ciCheck({ id: 11, name: 'Security Audit', conclusion: 'failure' })], 'STACKED_PREVIEW_CI_NOT_GREEN'],
    [[ciCheck(), ciCheck({ id: 11, name: 'Test Suite (unit)', conclusion: 'cancelled' })], 'STACKED_PREVIEW_CI_NOT_GREEN'],
    [[ciCheck({ headSha: heads[2] })], 'STACKED_PREVIEW_CI_RESPONSE_INVALID'],
    [[ciCheck({ appId: 123 })], 'STACKED_PREVIEW_REQUIRED_CI_NOT_VERIFIED'],
    [[], 'STACKED_PREVIEW_REQUIRED_CI_NOT_VERIFIED'],
  ];
  for (const [checks, code] of cases) {
    await assert.rejects(github(async () => json({ total_count: checks.length, check_runs: checks })).readRequiredCI(heads[3]),
      errorCode(code));
  }
});

test('required CI reads every bounded page and rejects pagination drift or incomplete proof', async () => {
  const checks = Array.from({ length: 100 }, (_, index) => ciCheck({ id: index + 1, name: `Auxiliary ${index}` }));
  checks.push(ciCheck({ id: 101 }));
  const calls = [];
  const receipt = await github(async url => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    return json({ total_count: 101, check_runs: checks.slice((page - 1) * 100, page * 100) });
  }).readRequiredCI(heads[3]);
  assert.equal(receipt.checks.length, 101);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => new URL(url).searchParams.get('filter') === 'all'));
  await assert.rejects(github(async url => json({ total_count: new URL(url).searchParams.get('page') === '1' ? 101 : 102,
    check_runs: new URL(url).searchParams.get('page') === '1' ? checks.slice(0, 100) : checks.slice(100) })).readRequiredCI(heads[3]),
  errorCode('STACKED_PREVIEW_CI_SNAPSHOT_DRIFT'));
  await assert.rejects(github(async () => json({ total_count: 2, check_runs: [ciCheck()] })).readRequiredCI(heads[3]),
    errorCode('STACKED_PREVIEW_CI_SNAPSHOT_INCOMPLETE'));
});

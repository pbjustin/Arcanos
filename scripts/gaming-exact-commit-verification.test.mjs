import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { admit, assertCheckout, assertManifests, clientEnvironment, dependencyClientEnvironment, MANIFESTS,
  NODE_IMAGE, TARGETS, validateDispatch, validateTreeEntries } from './gaming-exact-commit-verification.mjs';

const SOURCE = 'dc7e7fdd34fd3563653ecb224102c73c1696239e';
const TREE = 'c68776bbe9566851bb06196215df566773b36ae8';
const CONTROLLER = '906de34d4717592ed905af6da272166d9146cc30';
function fixture(sourceSha = SOURCE) {
  return { event: { sender: { login: 'pbjustin', id: 220257666 }, repository: {
    full_name: 'pbjustin/Arcanos', id: 1017714023, default_branch: 'main' },
  inputs: { source_sha: sourceSha, mocked: 'true' } }, environment: {
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'pbjustin/Arcanos',
    GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF:
      'pbjustin/Arcanos/.github/workflows/gaming-exact-commit-verification.yml@refs/heads/main',
    GITHUB_SHA: CONTROLLER, CONTROLLER_SHA: CONTROLLER, GITHUB_ACTOR: 'pbjustin',
    GITHUB_TRIGGERING_ACTOR: 'pbjustin', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '123456',
    GITHUB_TOKEN: 'synthetic-read-only-test-token' } };
}
function responses(sourceSha = SOURCE) {
  const target = TARGETS[sourceSha];
  return { '/branches/main': { name: 'main', protected: true, commit: { sha: CONTROLLER } },
    [`/pulls/${target.prNumber}`]: { number: target.prNumber, state: 'open', draft: true,
      merged: false, merged_at: null, head: { sha: sourceSha, ref: target.branch,
        repo: { full_name: 'pbjustin/Arcanos', id: 1017714023 } },
      base: { ref: target.base, repo: { full_name: 'pbjustin/Arcanos' } } },
    [`/git/commits/${sourceSha}`]: { sha: sourceSha, tree: { sha: TREE } } };
}
function fakeFetch(records, requests = []) {
  return async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-read-only-test-token');
    const key = new URL(url).pathname.replace('/repos/pbjustin/Arcanos', '');
    assert(Object.hasOwn(records, key));
    return { status: 200, redirected: false, url, text: async () => JSON.stringify(records[key]) };
  };
}

for (const sourceSha of Object.keys(TARGETS)) {
  test(`accept authorized immutable SHA ${sourceSha}`, async () => {
    const { event, environment } = fixture(sourceSha);
    const calls = [];
    const result = await admit({ event, environment, fetchImpl: fakeFetch(responses(sourceSha), calls) });
    assert.equal(result.sourceSha, sourceSha);
    assert.equal(result.sourceTree, TREE);
    assert.equal(result.prNumber, TARGETS[sourceSha].prNumber);
    assert.equal(result.mocked, true); assert.equal(result.hosted, false); assert.equal(result.deployment, false);
    assert.equal(calls.length, 3);
  });
}
test('accept the typed boolean while requiring its true value', () => {
  const { event, environment } = fixture(); event.inputs.mocked = true;
  assert.equal(validateDispatch(event, environment).sourceSha, SOURCE);
});

for (const value of ['', 'main', 'a'.repeat(39), 'a'.repeat(41), SOURCE.toUpperCase(),
  '0'.repeat(40), `${SOURCE}\n`, `${SOURCE};echo unsafe`]) {
  test(`reject malformed SHA ${JSON.stringify(value)}`, () => {
    const { event, environment } = fixture(value);
    assert.throws(() => validateDispatch(event, environment), /SOURCE_SHA_INVALID/);
  });
}
test('reject a well-formed commit outside the fixed owner authorization', () => {
  const { event, environment } = fixture('a'.repeat(40));
  assert.throws(() => validateDispatch(event, environment), /SOURCE_NOT_AUTHORIZED/);
});
for (const mocked of [false, 'false', 'TRUE', '1', '', null]) {
  test(`reject unsupported mock value ${JSON.stringify(mocked)}`, async () => {
    const { event, environment } = fixture(); event.inputs.mocked = mocked;
    let calls = 0;
    await assert.rejects(admit({ event, environment, fetchImpl: async () => { calls++; } }), /MOCK_REQUIRED/);
    assert.equal(calls, 0);
  });
}
for (const key of ['deploy', 'production', 'environment', 'live', 'publish_image', 'unknown']) {
  test(`reject unsupported dispatch input ${key}`, () => {
    const { event, environment } = fixture(); event.inputs[key] = 'true';
    assert.throws(() => validateDispatch(event, environment), /INPUTS_INVALID/);
  });
}
test('reject missing required input', () => {
  const { event, environment } = fixture(); delete event.inputs.mocked;
  assert.throws(() => validateDispatch(event, environment), /INPUTS_INVALID/);
});
for (const [key, value] of [['GITHUB_EVENT_NAME', 'pull_request'], ['GITHUB_REPOSITORY', 'attacker/Arcanos'],
  ['GITHUB_REF', 'refs/heads/candidate'], ['GITHUB_RUN_ATTEMPT', '2'],
  ['GITHUB_WORKFLOW_REF', 'pbjustin/Arcanos/.github/workflows/gaming-exact-commit-verification.yml@refs/tags/main'],
  ['GITHUB_ACTOR', 'attacker'], ['GITHUB_TRIGGERING_ACTOR', 'attacker'], ['CONTROLLER_SHA', SOURCE]]) {
  test(`reject untrusted event context ${key}`, () => {
    const { event, environment } = fixture(); environment[key] = value;
    assert.throws(() => validateDispatch(event, environment));
  });
}
test('reject forged actor ID or repository identity', () => {
  const data = fixture(); data.event.sender.id = 1;
  assert.throws(() => validateDispatch(data.event, data.environment), /OWNER_REQUIRED/);
  const other = fixture(); other.event.repository.id = 1;
  assert.throws(() => validateDispatch(other.event, other.environment), /REPOSITORY_INVALID/);
});
for (const [name, mutate] of [
  ['unprotected main', r => { r['/branches/main'].protected = false; }],
  ['controller drift', r => { r['/branches/main'].commit.sha = SOURCE; }],
  ['head drift', r => { r['/pulls/1534'].head.sha = CONTROLLER; }],
  ['ready PR', r => { r['/pulls/1534'].draft = false; }],
  ['closed PR', r => { r['/pulls/1534'].state = 'closed'; }],
  ['merged PR', r => { r['/pulls/1534'].merged = true; }],
  ['fork PR', r => { r['/pulls/1534'].head.repo.full_name = 'attacker/Arcanos'; }],
  ['base drift', r => { r['/pulls/1534'].base.ref = 'main'; }],
  ['commit mismatch', r => { r[`/git/commits/${SOURCE}`].sha = CONTROLLER; }],
  ['invalid tree', r => { r[`/git/commits/${SOURCE}`].tree.sha = 'main'; }],
]) {
  test(`reject repository/source admission failure: ${name}`, async () => {
    const data = fixture(); const records = responses(); mutate(records);
    await assert.rejects(admit({ ...data, fetchImpl: fakeFetch(records) }));
  });
}
test('fail closed on API failure or redirect', async () => {
  for (const response of [{ status: 403, redirected: false }, { status: 200, redirected: true }]) {
    await assert.rejects(admit({ ...fixture(), fetchImpl: async url => ({ ...response, url }) }), /READ_FAILED/);
  }
});
test('require read token only for trusted API admission', async () => {
  const data = fixture(); delete data.environment.GITHUB_TOKEN;
  await assert.rejects(admit(data), /READ_TOKEN_REQUIRED/);
});
test('accept exact checkout and reject a different SHA or tree before source execution', () => {
  assertCheckout(SOURCE, TREE, SOURCE, TREE);
  assert.throws(() => assertCheckout(SOURCE, TREE, CONTROLLER, TREE), /CHECKOUT_MISMATCH/);
  assert.throws(() => assertCheckout(SOURCE, TREE, SOURCE, CONTROLLER), /CHECKOUT_MISMATCH/);
});
test('reject symlink/submodule/traversal/control-path sources', () => {
  const blob = 'a'.repeat(40);
  validateTreeEntries(`100644 blob ${blob}\tpackage.json\0`);
  for (const entry of [`120000 blob ${blob}\tlink`, `160000 commit ${blob}\tsubmodule`,
    `100644 blob ${blob}\t../escape`, `100644 blob ${blob}\t.git/config`,
    `100644 blob ${blob}\tnode_modules/evil`, `100644 blob ${blob}\tbad\nname`]) {
    assert.throws(() => validateTreeEntries(`${entry}\0`), /TREE_ENTRY_UNSAFE/);
  }
});
test('networked dependency acquisition rejects every changed candidate manifest', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gaming-ci-manifests-'));
  try {
    const controller = path.join(root, 'controller'); const candidate = path.join(root, 'candidate');
    for (const relative of MANIFESTS) for (const base of [controller, candidate]) {
      mkdirSync(path.dirname(path.join(base, relative)), { recursive: true });
      writeFileSync(path.join(base, relative), '{}');
    }
    assertManifests(controller, candidate);
    for (const relative of MANIFESTS) {
      writeFileSync(path.join(candidate, relative), '{"scripts":{"postinstall":"untrusted"}}');
      assert.throws(() => assertManifests(controller, candidate), /MANIFEST_DRIFT/);
      writeFileSync(path.join(candidate, relative), '{}');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('trusted child clients inherit no provider/GitHub/Railway/Docker or npm credential', () => {
  const result = clientEnvironment({ PATH: '/trusted/bin', GITHUB_TOKEN: 'sentinel', OPENAI_API_KEY: 'sentinel',
    RAILWAY_TOKEN: 'sentinel', NPM_TOKEN: 'sentinel', DOCKER_HOST: 'sentinel',
    NODE_OPTIONS: '--import=untrusted', HTTPS_PROXY: 'sentinel' }, '/empty-home');
  assert.equal(result.PATH, '/trusted/bin'); assert.equal(result.HOME, '/empty-home');
  assert(Object.values(result).every(value => !value.includes('sentinel') && !value.includes('untrusted')));
});
test('only trusted dependency acquisition preserves required proxy/CA transport', () => {
  const result = dependencyClientEnvironment({ PATH: '/trusted/bin', HTTPS_PROXY: 'http://proxy:8080',
    NODE_EXTRA_CA_CERTS: '/trusted/public-ca.pem', GITHUB_TOKEN: 'sentinel', OPENAI_API_KEY: 'sentinel',
    RAILWAY_TOKEN: 'sentinel', NPM_TOKEN: 'sentinel', NODE_OPTIONS: '--import=untrusted' }, '/empty-home');
  assert.equal(result.HTTPS_PROXY, 'http://proxy:8080');
  assert.equal(result.NODE_EXTRA_CA_CERTS, '/trusted/public-ca.pem');
  assert(Object.values(result).every(value => !value.includes('sentinel') && !value.includes('untrusted')));
});
test('workflow has only the explicit mocked/SHA dispatch contract and immutable checkouts', () => {
  const text = readFileSync(new URL('../.github/workflows/gaming-exact-commit-verification.yml', import.meta.url), 'utf8');
  assert.match(text, /name: Gaming Exact Commit Mocked Verification/);
  assert.match(text, /workflow_dispatch:\n    inputs:\n      source_sha:/);
  assert.match(text, /mocked:[\s\S]*default: false\n        type: boolean/);
  assert.match(text, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(text, /ref: \$\{\{ steps\.admission\.outputs\.source_sha \}\}/);
  assert(text.includes(NODE_IMAGE));
  assert(!/\n  (push|pull_request|pull_request_target|workflow_run|schedule|workflow_call):/u.test(text));
  assert(!/secrets\.|environment:|id-token:|packages:|contents: write|pull-requests: write/u.test(text));
  assert(!/docker (push|login)|railway (up|deploy)|gh (workflow|release)/u.test(text));
  assert.equal((text.match(/persist-credentials: false/gu) ?? []).length, 2);
});

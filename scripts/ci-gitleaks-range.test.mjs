import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runCiGitleaksRange } from './ci-gitleaks-range.mjs';

const repository = 'pbjustin/Arcanos';
const origin = 'https://github.com/pbjustin/Arcanos.git';

function fixture({ longHistory = false, scannerVersion = '8.24.3' } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ci-gitleaks-range-'));
  const cwd = path.join(directory, 'checkout');
  mkdirSync(cwd);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  const commit = () => git('-c', 'user.name=CI fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', 'offline fixture');
  git('init', '--initial-branch=main');
  git('remote', 'add', 'origin', origin);
  writeFileSync(path.join(cwd, 'baseline.txt'), 'BASELINE_ONLY_FIXTURE\n');
  git('add', 'baseline.txt'); commit();
  const base = git('rev-parse', 'HEAD');
  git('switch', '-c', 'feature');
  const linearCommits = [];
  for (let index = 0; index < (longHistory ? 35 : 1); index++) {
    writeFileSync(path.join(cwd, 'candidate.txt'), `candidate fixture ${index}\n`);
    git('add', 'candidate.txt'); commit();
    linearCommits.push(git('rev-parse', 'HEAD'));
  }
  let sideCommit;
  if (longHistory) {
    git('switch', '-c', 'side', linearCommits[9]);
    writeFileSync(path.join(cwd, 'side.txt'), 'SIDE_BRANCH_FIXTURE\n');
    git('add', 'side.txt'); commit();
    sideCommit = git('rev-parse', 'HEAD');
    git('switch', 'feature');
    git('merge', '--no-ff', '--no-commit', 'side');
    writeFileSync(path.join(cwd, 'merge-only.txt'), 'MERGE_ONLY_FIXTURE\n');
    git('add', 'merge-only.txt'); commit();
  }
  const head = git('rev-parse', 'HEAD');
  const token = randomBytes(32).toString('hex');
  const privateFinding = randomBytes(32).toString('hex');
  const capture = path.join(directory, 'scanner-capture.json');
  const scanner = path.join(directory, 'gitleaks');
  writeFileSync(scanner, '#!' + process.execPath + '\n'
    + "const fs = require('node:fs'); const cp = require('node:child_process');\n"
    + `if (process.argv[2] === 'version') { console.log(${JSON.stringify(scannerVersion)}); process.exit(0); }\n`
    + 'const args = process.argv.slice(2);\n'
    + "const option = args.find(arg => arg.startsWith('--log-opts='));\n"
    + "if (!option) process.exit(9);\n"
    + "const options = option.slice('--log-opts='.length).split(/\\s+/u);\n"
    + "const result = cp.spawnSync('git', ['log', '--format=scan-commit:%H', '-p', ...options], { cwd: process.cwd(), encoding: 'utf8' });\n"
    + 'if (result.status !== 0) process.exit(9);\n'
    + "const markerDetected = result.stdout.includes('MERGE_ONLY_FIXTURE');\n"
    + `fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args,\n`
    + "  commits: [...new Set([...result.stdout.matchAll(/^scan-commit:([a-f0-9]{40})$/gmu)].map(match => match[1]))],\n"
    + "  markerDetected, sideMarkerDetected: result.stdout.includes('SIDE_BRANCH_FIXTURE'),\n"
    + "  baselineMarkerDetected: result.stdout.includes('BASELINE_ONLY_FIXTURE'),\n"
    + "  credentialNamesPresent: ['GITHUB_TOKEN', 'GH_TOKEN', 'AUTHORIZATION', 'OPENAI_API_KEY'].filter(name => Object.hasOwn(process.env, name)),\n"
    + "  gitConfiguration: { noSystem: process.env.GIT_CONFIG_NOSYSTEM, global: process.env.GIT_CONFIG_GLOBAL }\n"
    + '}));\n'
    + `if (markerDetected) { process.stderr.write(${JSON.stringify('private scanner finding: ' + privateFinding + '\n')}); process.exit(2); }\n`,
  { mode: 0o700 });
  return { directory, cwd, git, commit, base, head, sideCommit, linearCommits, token, privateFinding,
    capture, scanner, environment: { PATH: process.env.PATH, GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REPOSITORY: repository, GITHUB_REF: 'refs/heads/feature', GITHUB_SHA: head,
      DEFAULT_BRANCH: 'main', GITLEAKS_BIN: scanner, GITHUB_TOKEN: token },
    dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

function github(f, alter = () => {}) {
  const requests = [];
  const fetchImpl = async (requestedUrl, options = {}) => {
    const url = new URL(String(requestedUrl));
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(url.username, ''); assert.equal(url.password, '');
    assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${f.token}`);
    requests.push(url.pathname);
    let object;
    if (url.pathname === `/repos/${repository}`)
      object = { id: 4242, full_name: repository, default_branch: 'main' };
    else if (url.pathname === `/repos/${repository}/branches/main`)
      object = { name: 'main', protected: true, commit: { sha: f.base } };
    else if (url.pathname === `/repos/${repository}/branches/feature`)
      object = { name: 'feature', protected: false, commit: { sha: f.head } };
    else assert.fail('Unexpected API route');
    const response = { status: 200, redirected: false, url: url.href };
    const context = { path: url.pathname, number: requests.length, object, response };
    alter(context);
    return { ...response, text: async () => context.rawBody ?? JSON.stringify(context.object) };
  };
  return { fetchImpl, requests };
}

function failureIsSafe(error, f) {
  assert.match(error.code, /^CI_GITLEAKS_/u);
  const publicError = JSON.stringify({ ...error, message: error.message });
  assert.equal(publicError.includes(f.token), false);
  assert.equal(publicError.includes(f.privateFinding), false);
  return true;
}

async function invoke(f, { environment = {}, fetchImpl, cwd = f.cwd } = {}) {
  return runCiGitleaksRange({ environment: { ...f.environment, ...environment }, cwd,
    fetchImpl: fetchImpl ?? github(f).fetchImpl });
}

test('manual range binds authenticated protected base and exact head without forwarding tokens', async () => {
  const f = fixture();
  try {
    const api = github(f);
    const proof = await invoke(f, { fetchImpl: api.fetchImpl });
    const serialized = JSON.stringify(proof);
    assert.ok(serialized.includes(f.base)); assert.ok(serialized.includes(f.head));
    assert.equal(serialized.includes(f.token), false);
    assert.equal(api.requests.length, 6);
    const scan = JSON.parse(readFileSync(f.capture, 'utf8'));
    assert.deepEqual(scan.credentialNamesPresent, []);
    assert.deepEqual(scan.gitConfiguration, { noSystem: '1', global: '/dev/null' });
    assert.deepEqual(scan.commits, [f.head]);
    assert.ok(scan.args.includes(`--log-opts=--full-history --diff-merges=first-parent ${f.base}..${f.head}`));
    assert.ok(scan.args.some(arg => arg === '--redact' || arg.startsWith('--redact=')));
    assert.equal(scan.args.includes('--no-banner'), true);
    assert.equal(scan.baselineMarkerDetected, false);
  } finally { f.dispose(); }
});

test('complete range includes over 30 commits, side history and merge-only additions and blocks findings', async () => {
  const f = fixture({ longHistory: true });
  try {
    await assert.rejects(invoke(f), error => {
      failureIsSafe(error, f);
      assert.equal(error.code, 'CI_GITLEAKS_SCAN_FAILED'); assert.equal(error.exitCode, 2);
      return true;
    });
    const scan = JSON.parse(readFileSync(f.capture, 'utf8'));
    assert.equal(scan.commits.length, 37);
    for (const sha of [...f.linearCommits, f.sideCommit, f.head]) assert.ok(scan.commits.includes(sha));
    assert.equal(scan.commits.includes(f.base), false);
    assert.equal(scan.markerDetected, true); assert.equal(scan.sideMarkerDetected, true);
    assert.equal(scan.baselineMarkerDetected, false);
    assert.deepEqual(scan.credentialNamesPresent, []);
  } finally { f.dispose(); }
});

test('normal detached Actions checkout remains bound to event ref and exact SHA', async () => {
  const f = fixture();
  try {
    f.git('switch', '--detach', f.head);
    await invoke(f);
    assert.equal(existsSync(f.capture), true);
  } finally { f.dispose(); }
});

test('event identity and checkout failures reject before scanning', async () => {
  const f = fixture();
  try {
    for (const environment of [
      { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REPOSITORY: 'other/Arcanos' },
      { GITHUB_REF: 'refs/tags/release' }, { GITHUB_REF: 'feature' },
      { GITHUB_SHA: f.base }, { GITHUB_SHA: 'A'.repeat(40) }, { GITHUB_SHA: '0'.repeat(40) },
      { GITHUB_SHA: '$(false)' }, { GITHUB_TOKEN: '' }, { DEFAULT_BRANCH: 'other' },
      { GITLEAKS_BIN: './gitleaks' }, { GITLEAKS_CONFIG: '/tmp/unreviewed-config.toml' },
      { GITLEAKS_CONFIG_TOML: 'unreviewed inline configuration' }
    ]) {
      await assert.rejects(invoke(f, { environment }), error => failureIsSafe(error, f));
      assert.equal(existsSync(f.capture), false);
    }
    f.git('switch', '-c', 'other');
    await assert.rejects(invoke(f), error => failureIsSafe(error, f));
    assert.equal(existsSync(f.capture), false);
  } finally { f.dispose(); }
});

test('wrong origin and dirty tracked or untracked content fail closed', async () => {
  const f = fixture();
  try {
    f.git('remote', 'set-url', 'origin', 'https://github.com/other/Arcanos.git');
    await assert.rejects(invoke(f), error => failureIsSafe(error, f));
    f.git('remote', 'set-url', 'origin', origin);
    writeFileSync(path.join(f.cwd, 'candidate.txt'), 'modified fixture\n');
    await assert.rejects(invoke(f), error => failureIsSafe(error, f));
    f.git('restore', 'candidate.txt');
    writeFileSync(path.join(f.cwd, 'untracked.txt'), 'untracked fixture\n');
    await assert.rejects(invoke(f), error => failureIsSafe(error, f));
    assert.equal(existsSync(f.capture), false);
  } finally { f.dispose(); }
});

test('a shallow checkout cannot claim complete candidate history', async () => {
  const f = fixture();
  try {
    const shallow = path.join(f.directory, 'shallow');
    execFileSync('git', ['clone', '--quiet', '--depth=1', '--branch=feature', pathToFileURL(f.cwd).href, shallow],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['remote', 'set-url', 'origin', origin], { cwd: shallow });
    await assert.rejects(invoke(f, { cwd: shallow }), error => failureIsSafe(error, f));
    assert.equal(existsSync(f.capture), false);
  } finally { f.dispose(); }
});

test('API errors, redirects, unrelated identities and absent branch protection block scanning', async () => {
  const f = fixture();
  try {
    const cases = [
      context => { context.response.status = 403; context.rawBody = f.privateFinding; },
      context => { context.response.redirected = true; },
      context => { context.response.url = 'https://unrelated.example.invalid/'; },
      context => { context.rawBody = f.privateFinding; },
      context => { if (context.path.endsWith('/Arcanos')) context.object.full_name = 'other/Arcanos'; },
      context => { if (context.path.endsWith('/Arcanos')) context.object.default_branch = 'other'; },
      context => { if (context.path.endsWith('/branches/main')) delete context.object.protected; },
      context => { if (context.path.endsWith('/branches/main')) context.object.protected = false; },
      context => { if (context.path.endsWith('/branches/main')) context.object.name = 'other'; },
      context => { if (context.path.endsWith('/branches/feature')) context.object.commit.sha = f.base; }
    ];
    for (const alter of cases) {
      await assert.rejects(invoke(f, { fetchImpl: github(f, alter).fetchImpl }), error => failureIsSafe(error, f));
      assert.equal(existsSync(f.capture), false);
    }
  } finally { f.dispose(); }
});

test('base identities must be nonzero lowercase commit objects', async () => {
  const f = fixture();
  try {
    const blob = f.git('rev-parse', 'HEAD:candidate.txt');
    for (const base of ['A'.repeat(40), '0'.repeat(40), 'f'.repeat(40), '$(false)', blob]) {
      const api = github(f, context => {
        if (context.path.endsWith('/branches/main')) context.object.commit.sha = base;
      });
      await assert.rejects(invoke(f, { fetchImpl: api.fetchImpl }), error => failureIsSafe(error, f));
      assert.equal(existsSync(f.capture), false);
    }
  } finally { f.dispose(); }
});

test('protected base must be a strict ancestor and cannot produce an empty successful scan', async () => {
  const f = fixture();
  try {
    f.git('switch', '--orphan', 'unrelated');
    writeFileSync(path.join(f.cwd, 'unrelated.txt'), 'unrelated fixture\n');
    f.git('add', 'unrelated.txt'); f.commit();
    const unrelated = f.git('rev-parse', 'HEAD'); f.git('switch', 'feature');
    for (const base of [unrelated, f.head]) {
      const api = github(f, context => {
        if (context.path.endsWith('/branches/main')) context.object.commit.sha = base;
      });
      await assert.rejects(invoke(f, { fetchImpl: api.fetchImpl }), error => failureIsSafe(error, f));
      assert.equal(existsSync(f.capture), false);
    }
  } finally { f.dispose(); }
});

test('default-branch dispatch cannot use an empty incremental range', async () => {
  const f = fixture();
  try {
    f.git('switch', 'main');
    await assert.rejects(invoke(f, { environment: { GITHUB_REF: 'refs/heads/main', GITHUB_SHA: f.base } }),
      error => failureIsSafe(error, f));
    assert.equal(existsSync(f.capture), false);
  } finally { f.dispose(); }
});

test('scanner must report the exact reviewed 8.24.3 version', async () => {
  const f = fixture({ scannerVersion: '8.30.1' });
  try {
    await assert.rejects(invoke(f), error => failureIsSafe(error, f));
    assert.equal(existsSync(f.capture), false);
  } finally { f.dispose(); }
});

test('default branch, protection, base and candidate drift after scanning invalidate success', async () => {
  const f = fixture();
  try {
    const changes = [
      context => { if (context.path.endsWith('/Arcanos')) context.object.default_branch = 'other'; },
      context => { if (context.path.endsWith('/branches/main')) context.object.protected = false; },
      context => { if (context.path.endsWith('/branches/main')) context.object.commit.sha = f.head; },
      context => { if (context.path.endsWith('/branches/feature')) context.object.commit.sha = f.base; }
    ];
    for (const change of changes) {
      const api = github(f, context => { if (context.number > 3) change(context); });
      await assert.rejects(invoke(f, { fetchImpl: api.fetchImpl }), error => failureIsSafe(error, f));
      assert.equal(existsSync(f.capture), true);
      rmSync(f.capture);
    }
  } finally { f.dispose(); }
});

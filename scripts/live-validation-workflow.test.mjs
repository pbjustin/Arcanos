import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { parseLiveValidationControllerArguments } from './live-validation-controller.mjs';

const workflow = yaml.load(readFileSync(new URL('../.github/workflows/live-pr-acceptance.yml', import.meta.url), 'utf8'));
const SHA = 'a'.repeat(40);
const CONTROLLER_SHA = 'b'.repeat(40);
const actions = new Set([
  'actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955',
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
]);
const offline = workflow.jobs['candidate-offline'];
const live = workflow.jobs['live-acceptance'];
const named = (job, name) => {
  const step = job.steps.find(value => value.name === name);
  assert.ok(step, `Missing reviewed step: ${name}`);
  return step;
};
const inputStep = named(offline, 'Validate dispatch inputs before candidate checkout');
const bootstrap = named(live, 'Materialize protected operator configuration');
const binding = named(live, 'Bind reviewed SHA to independently hashed candidate artifacts');
const extractNode = step => {
  const match = /<<'NODE'\n([\s\S]+)\nNODE\s*$/u.exec(step.run);
  assert.ok(match, 'Expected inline reviewed Node program');
  return match[1];
};
const baseEnvironment = () => ({ PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', PR_NUMBER: '42',
  EXPECTED_SHA: SHA, ACCEPTANCE_PROFILE: 'gaming-guide', CONTROLLER_REVISION: CONTROLLER_SHA,
  WORKFLOW_RUN_ID: '1234', WORKFLOW_RUN_ATTEMPT: '1' });
const runInline = (step, env) => spawnSync(process.execPath, ['--input-type=module'], {
  input: extractNode(step), encoding: 'utf8', timeout: 5_000, env: { ...baseEnvironment(), ...env },
});
function targetFixture() {
  return { version: 'arcanos-live-validation-target/v2', repository: 'pbjustin/Arcanos',
    projectId: '7faf44e5-519c-4e73-8d7a-da9f389e6187',
    environmentId: '11111111-1111-4111-8111-111111111111', environmentName: 'live-validation',
    runtimeServiceId: '22222222-2222-4222-8222-222222222222',
    publicOrigin: 'https://private-target-sentinel.up.railway.app',
    limits: { maxSpendMicroUsd: 2_000_000, maxRequests: 32, maxWorkflows: 2, durationMs: 600_000 },
    models: ['ft:private-target-sentinel', 'gpt-6-luna', 'gpt-6.1-sol'].map(id => ({
      id, inputMicroUsdPerToken: 1.25, outputMicroUsdPerToken: 5 })), writes: false };
}
const readEnvironment = file => Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').map(line => line.split('=')));

test('manual paid admission uses default-branch trust and one Railway HTTPS validation service', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ['pr_number', 'expected_sha', 'profile', 'paid_authorized']);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.equal(inputs.pr_number.required, false);
  assert.equal(inputs.expected_sha.required, false);
  assert.deepEqual(inputs.profile.options, ['gaming-guide']);
  assert.equal(inputs.paid_authorized.type, 'boolean');
  assert.equal(inputs.paid_authorized.required, true);
  assert.equal(inputs.paid_authorized.default, false);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.concurrency, { group: 'persistent-live-validation-facility', 'cancel-in-progress': false });
  for (const job of [offline, live]) {
    assert.match(job.if, /github\.event_name == 'workflow_dispatch'/u);
    assert.match(job.if, /github\.repository == 'pbjustin\/Arcanos'/u);
    assert.match(job.if, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/u);
    assert.equal(job['timeout-minutes'], 30);
  }
  assert.match(live.if, /needs\.candidate-offline\.result == 'success'/u);
  assert.match(live.if, /inputs\.paid_authorized == true/u);
  assert.equal(live.environment, 'live-pr-acceptance');
  assert.equal(offline['runs-on'], 'ubuntu-latest');
  assert.equal(live['runs-on'], 'ubuntu-latest');
  assert.doesNotMatch(JSON.stringify(live), /self-hosted|MTLS_|APPROVAL_SIGNING|supervisor/);
  assert.deepEqual(offline.permissions, { contents: 'read' });
  assert.deepEqual(live.permissions, { actions: 'read', checks: 'read', contents: 'read', 'pull-requests': 'read' });
});

test('dispatch validation rejects shell-shaped inputs, unknown profiles and workflow reruns before checkout', () => {
  assert.equal(runInline(inputStep).status, 0);
  assert.equal(runInline(inputStep, { EXPECTED_SHA: '' }).status, 0);
  assert.equal(runInline(inputStep, { PR_NUMBER: '' }).status, 0);
  assert.equal(runInline(inputStep, { PR_NUMBER: '', EXPECTED_SHA: '' }).status, 1);
  for (const env of [{ PR_NUMBER: '42;false' }, { PR_NUMBER: '0' }, { EXPECTED_SHA: '`id`' },
    { EXPECTED_SHA: 'A'.repeat(40) }, { ACCEPTANCE_PROFILE: 'research' }, { WORKFLOW_RUN_ATTEMPT: '2' },
    { CONTROLLER_REVISION: '${{ secrets.OPENAI_API_KEY }}' }, { WORKFLOW_RUN_ID: 'not-a-run' }]) {
    const result = runInline(inputStep, env);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), 'LIVE_VALIDATION_DISPATCH_INVALID');
  }
  assert.ok(offline.steps.indexOf(inputStep) < offline.steps.findIndex(step => step.uses?.startsWith('actions/checkout@')));
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps)
    if (step.run) assert.doesNotMatch(step.run, /\$\{\{\s*(?:inputs|github\.event)/u);
});


test('authoritative dispatch selection resolves PR-only and SHA-only requests and rejects moved or ambiguous heads', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'live-workflow-selection-'));
  const selection = named(offline, 'Resolve unambiguous current PR head');
  const pr = { number: 42, state: 'open', draft: true, head: { sha: SHA, repo: { full_name: 'pbjustin/Arcanos' } },
    base: { ref: 'main', sha: CONTROLLER_SHA, repo: { full_name: 'pbjustin/Arcanos' } } };
  try {
    for (const [index, input] of [{ PR_NUMBER: '42', EXPECTED_SHA: '' }, { PR_NUMBER: '', EXPECTED_SHA: SHA },
      { PR_NUMBER: '42', EXPECTED_SHA: 'd'.repeat(40) }, { PR_NUMBER: '', EXPECTED_SHA: SHA, ambiguous: true }].entries()) {
      const result = spawnSync(process.execPath, ['--input-type=module'], { encoding: 'utf8', timeout: 5000,
        input: `globalThis.fetch = async url => ({ok:true, json:async() => String(url).includes('/commits/') ? ${JSON.stringify(input.ambiguous ? [pr, pr] : [pr])} : ${JSON.stringify(pr)}});\n` + extractNode(selection),
        env: { ...baseEnvironment(), ...input, GITHUB_TOKEN: 'test-only-fixture', GITHUB_ENV: path.join(directory, 'env-' + index), GITHUB_OUTPUT: path.join(directory, 'out-' + index) } });
      assert.equal(result.status, index < 2 ? 0 : 1, result.stderr);
      if (index < 2) assert.match(readFileSync(path.join(directory, 'out-' + index), 'utf8'), new RegExp('commit_sha=' + SHA));
      else assert.equal(result.stderr.trim(), 'LIVE_VALIDATION_PR_HEAD_GATE_FAILED');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('candidate code stays isolated from control-plane, signing and provider credentials', () => {
  assert.doesNotMatch(JSON.stringify({ env: workflow.env, offline }), /secrets\.|vars\.|RAILWAY.*TOKEN|OPENAI.*KEY|LIVE_VALIDATION_TARGET_JSON|LIVE_VALIDATION_(?:MAX_|DURATION_MS)|APPROVAL_SIGNING|MTLS_/u);
  const checkout = offline.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.deepEqual(checkout.with, { repository: 'pbjustin/Arcanos', ref: '${{ steps.selection.outputs.commit_sha }}',
    'fetch-depth': 0, 'persist-credentials': false });
  for (const command of ['npm ci', 'npm run type-check', 'npm run lint', 'npm run build',
    'npm run validate:railway', 'node --test scripts/live-pr-preview-verifier.test.mjs', 'npm run test:live-validation:offline'])
    assert.ok(offline.steps.some(step => step.run?.includes(command)), `Missing offline check ${command}`);
  const trustedCheckouts = live.steps.filter(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(trustedCheckouts.length, 1);
  assert.deepEqual(trustedCheckouts[0].with, { ref: '${{ github.workflow_sha }}', 'persist-credentials': false });
  for (const step of live.steps) if (step.run)
    assert.doesNotMatch(step.run, /npm (?:ci|install)|tar -x|(?:import|require).*candidate|start-live-pr-preview/u);
  assert.doesNotMatch(JSON.stringify(live), /secrets\.(?:OPENAI_API_KEY|ARCANOS_LIVE_PREVIEW_OPENAI_API_KEY|RAILWAY_PRODUCTION)/u);
});

test('actions and scanner stay pinned; candidate scans block while historical triage stays independent', () => {
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps)
    if (step.uses) assert.ok(actions.has(step.uses), `Unreviewed action ${step.uses}`);
  const scanner = named(offline, 'Install verified secret scanner');
  assert.deepEqual(scanner.env, { GITLEAKS_VERSION: '8.24.3',
    GITLEAKS_ARCHIVE_SHA256: '9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c' });
  assert.ok(scanner.run.indexOf('sha256sum --check --strict') < scanner.run.indexOf('tar -xzf'));
  assert.match(scanner.run, /--proto '=https' --tlsv1\.2/u);
  const scan = named(offline, 'Triage historical findings without blocking unrelated simplification');
  assert.equal(scan['continue-on-error'], true);
  const candidateScan = named(offline, 'Scan candidate changes before installation');
  assert.match(candidateScan.run, /--log-opts="\$\{BASE_SHA\}\.\.\$\{EXPECTED_SHA\}" --redact/);
  assert.equal(candidateScan['continue-on-error'], undefined);
  assert.match(scan.run, /--log-opts='--all' --redact --no-banner/u);
  assert.ok(offline.steps.indexOf(scan) < offline.steps.findIndex(step => step.run === 'npm ci'));
  assert.match(named(offline, 'Scan built output before artifact retention').run, /gitleaks" dir dist --redact/u);
});

test('required CI scans every exact PR commit beyond the first API page and blocks invalid refs or findings', () => {
  const ci = yaml.load(readFileSync(new URL('../.github/workflows/ci-cd.yml', import.meta.url), 'utf8'));
  const security = ci.jobs['security-audit'];
  const action = named(security, '🔍 Run gitleaks secret scan');
  const scan = named(security, 'Scan complete exact PR commit range');
  assert.equal(action.uses, 'gitleaks/gitleaks-action@v2');
  assert.deepEqual(action.env, { GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' });
  assert.equal(scan.if, "github.event_name == 'pull_request'");
  assert.equal(scan.shell, 'bash');
  assert.equal(scan['continue-on-error'], undefined);
  assert.deepEqual(scan.env, { PR_BASE_SHA: '${{ github.event.pull_request.base.sha }}',
    PR_HEAD_SHA: '${{ github.event.pull_request.head.sha }}' });
  assert.ok(security.steps.indexOf(action) < security.steps.indexOf(scan));
  assert.equal(security.steps.find(step => step.uses?.startsWith('actions/checkout@')).with['fetch-depth'], 0);

  const directory = mkdtempSync(path.join(tmpdir(), 'full-pr-secret-range-'));
  const binaryDirectory = path.join(directory, 'bin');
  const argsFile = path.join(directory, 'scan-args.json');
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = () => git(['-c', 'user.name=Workflow fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  try {
    git(['init']);
    writeFileSync(path.join(directory, 'source.txt'), 'base fixture\n'); git(['add', 'source.txt']); commit();
    const base = git(['rev-parse', 'HEAD']);
    for (let index = 1; index <= 34; index++) {
      writeFileSync(path.join(directory, 'source.txt'), `PR fixture ${index}\n`); git(['add', 'source.txt']); commit();
    }
    const head = git(['rev-parse', 'HEAD']);
    mkdirSync(binaryDirectory);
    writeFileSync(path.join(binaryDirectory, 'gitleaks'), '#!/usr/bin/env node\n'
      + "require('node:fs').writeFileSync(process.env.SCAN_ARGS_FILE, JSON.stringify(process.argv.slice(2)));\n"
      + 'process.exit(Number(process.env.SCAN_EXIT_CODE || 0));\n', { mode: 0o700 });
    const run = env => spawnSync('bash', ['-c', scan.run], { cwd: directory, encoding: 'utf8', timeout: 5_000,
      env: { PATH: binaryDirectory + path.delimiter + process.env.PATH, PR_BASE_SHA: base, PR_HEAD_SHA: head,
        SCAN_ARGS_FILE: argsFile, ...env } });
    const successful = run({});
    assert.equal(successful.status, 0, successful.stderr);
    const args = JSON.parse(readFileSync(argsFile, 'utf8'));
    assert.deepEqual(args, ['git', '.', `--log-opts=${base}..${head}`, '--redact', '--no-banner']);
    const scanned = git(['rev-list', args[2].slice('--log-opts='.length)]).split('\n');
    assert.equal(scanned.length, 34); assert.ok(scanned.includes(head)); assert.ok(!scanned.includes(base));
    rmSync(argsFile);
    for (const env of [{ PR_HEAD_SHA: 'A'.repeat(40) }, { PR_BASE_SHA: 'not-a-sha' },
      { PR_HEAD_SHA: '0'.repeat(40) }, { PR_HEAD_SHA: '$(false)' }]) {
      assert.notEqual(run(env).status, 0); assert.equal(existsSync(argsFile), false);
    }
    assert.equal(run({ SCAN_EXIT_CODE: '2' }).status, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('protected bootstrap validates target configuration and exposes only bounded numeric limits', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'live-workflow-bootstrap-'));
  const env = { RUNNER_TEMP: directory, GITHUB_ENV: path.join(directory, 'environment'),
    GITHUB_OUTPUT: path.join(directory, 'outputs'), LIVE_VALIDATION_TARGET_JSON: JSON.stringify(targetFixture()) };
  try {
    const missing = runInline(bootstrap, { ...env, LIVE_VALIDATION_TARGET_JSON: '' });
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr.trim(), 'LIVE_VALIDATION_PROTECTED_BOOTSTRAP_MISSING');
    assert.deepEqual(readdirSync(directory), []);
    const valid = runInline(bootstrap, env);
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout, '');
    assert.equal(valid.stderr, '');
    const outputs = readEnvironment(env.GITHUB_OUTPUT);
    assert.equal(statSync(outputs.operator_dir).mode & 0o777, 0o700);
    for (const name of ['target.json'])
      assert.equal(statSync(path.join(outputs.operator_dir, name)).mode & 0o777, 0o600);
    assert.deepEqual(readEnvironment(env.GITHUB_ENV), { LIVE_VALIDATION_MAX_SPEND_MICRO_USD: '2000000',
      LIVE_VALIDATION_MAX_PROVIDER_REQUESTS: '32', LIVE_VALIDATION_MAX_WORKFLOWS: '2',
      LIVE_VALIDATION_DURATION_MS: '600000' });
    assert.deepEqual(JSON.parse(readFileSync(outputs.target_file, 'utf8')), targetFixture());
    assert.deepEqual(bootstrap.env, { LIVE_VALIDATION_TARGET_JSON: '${{ vars.LIVE_VALIDATION_TARGET_JSON }}' });
    assert.doesNotMatch(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /private-target-sentinel/);
    assert.doesNotMatch(readFileSync(env.GITHUB_ENV, 'utf8'), /private-target-sentinel/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('malformed protected targets cannot create operator files or inject workflow environment outputs', () => {
  const invalid = [{ value: 'private-target-sentinel' }, null, [], ...[
    target => { target.limits.maxRequests = '31\nRAILWAY_LIVE_VALIDATION_TOKEN=private-target-sentinel'; },
    target => { target.limits.maxRequests = 33; },
    target => { target.limits.maxSpendMicroUsd = 2_000_001; },
    target => { target.limits.maxWorkflows = 3; },
    target => { target.limits.durationMs = 600_001; },
    target => { target.limits.maxRequests = 0; },
    target => { target.limits.maxRequests = 1.5; },
    target => { target.limits.maxRequests = true; },
    target => { delete target.limits.durationMs; },
    target => { target.environmentName = 'production'; },
    target => { target.environmentId = 'fb583147-6c39-4343-9267-500f357d25ab'; },
    target => { target.extra = 'private-target-sentinel'; },
    target => { target.publicOrigin = 'https://private-target-sentinel.up.railway.app/path'; },
  ].map(mutate => { const target = targetFixture(); mutate(target); return target; })];
  for (const target of invalid) {
    const directory = mkdtempSync(path.join(tmpdir(), 'live-workflow-bootstrap-invalid-'));
    try {
      const result = runInline(bootstrap, { RUNNER_TEMP: directory, GITHUB_ENV: path.join(directory, 'environment'),
        GITHUB_OUTPUT: path.join(directory, 'outputs'), LIVE_VALIDATION_TARGET_JSON: JSON.stringify(target) });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr.trim(), 'LIVE_VALIDATION_PROTECTED_BOOTSTRAP_MISSING');
      assert.deepEqual(readdirSync(directory), []);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('validated tightened target limits reach preflight, paid execution and cleanup without defaulting', () => {
  const target = targetFixture();
  target.limits = { maxSpendMicroUsd: 1_000_000, maxRequests: 31, maxWorkflows: 1, durationMs: 300_000 };
  const directory = mkdtempSync(path.join(tmpdir(), 'live-workflow-tightened-limits-'));
  const envFile = path.join(directory, 'environment'); const outputsFile = path.join(directory, 'outputs');
  const argsFile = path.join(directory, 'args.json'); const bin = path.join(directory, 'bin');
  try {
    const result = runInline(bootstrap, { RUNNER_TEMP: directory, GITHUB_ENV: envFile, GITHUB_OUTPUT: outputsFile,
      LIVE_VALIDATION_TARGET_JSON: JSON.stringify(target) });
    assert.equal(result.status, 0, result.stderr);
    const limits = readEnvironment(envFile); const outputs = readEnvironment(outputsFile);
    assert.deepEqual(limits, { LIVE_VALIDATION_MAX_SPEND_MICRO_USD: '1000000',
      LIVE_VALIDATION_MAX_PROVIDER_REQUESTS: '31', LIVE_VALIDATION_MAX_WORKFLOWS: '1',
      LIVE_VALIDATION_DURATION_MS: '300000' });
    mkdirSync(bin);
    // Capture the actual shell arguments without invoking a controller or provider.
    writeFileSync(path.join(bin, 'node'), '#!' + process.execPath + '\n'
      + "require('node:fs').writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));\n", { mode: 0o700 });
    for (const name of ['Validate protected controller inputs offline',
      'Execute bounded live acceptance through trusted controller',
      'Close the paid run and verify cleanup while retaining facility']) {
      const step = named(live, name);
      const run = spawnSync('bash', ['-c', step.run], { encoding: 'utf8', timeout: 5_000,
        env: { ...baseEnvironment(), ...limits, PATH: bin + path.delimiter + process.env.PATH,
          RUNNER_TEMP: directory, TARGET_FILE: outputs.target_file, ARTIFACT_FILE: path.join(directory, 'artifact.json'), ARGS_FILE: argsFile } });
      assert.equal(run.status, 0, run.stderr);
      const args = JSON.parse(readFileSync(argsFile, 'utf8'));
      assert.equal(args[0], 'scripts/live-validation-controller.mjs');
      const parsed = parseLiveValidationControllerArguments(args.slice(1));
      assert.deepEqual(parsed.limits, target.limits, name);
      assert.equal(parsed.command, name.startsWith('Close') ? 'cleanup' : 'run');
      assert.equal(parsed.execute, name.startsWith('Execute'));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function candidateFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'live-workflow-artifact-'));
  const directory = path.join(root, 'live-validation-candidate');
  // This subprocess creates only fixture data, never executes artifact content.
  const result = spawnSync(process.execPath, ['--input-type=module'], { encoding: 'utf8',
    input: "import {mkdirSync} from 'node:fs'; mkdirSync(process.env.FIXTURE_DIRECTORY, {mode:0o700});",
    env: { FIXTURE_DIRECTORY: directory } });
  assert.equal(result.status, 0);
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  const files = { 'source.tar': Buffer.from('opaque source data'), 'build.tar': Buffer.from('opaque build data') };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(directory, name), bytes);
  const manifest = { version: 1, repository: 'pbjustin/Arcanos', sourceCommit: SHA, prNumber: 42,
    profile: 'gaming-guide', workflowRunId: '1234', workflowRunAttempt: 1, controllerRevision: CONTROLLER_SHA, treeSha: 'd'.repeat(40), compiledSha256: 'e'.repeat(64),
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)])) };
  const manifestPath = path.join(directory, 'candidate-attestation.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, directory, manifest, manifestPath, env: { RUNNER_TEMP: root, OPERATOR_DIR: root,
    GITHUB_OUTPUT: path.join(root, 'outputs'), ARTIFACT_ID: '7654', ARTIFACT_DIGEST: 'c'.repeat(64) } };
}

test('trusted artifact binding recomputes opaque bytes and pins source, controller, run and transport digest', () => {
  const fixture = candidateFixture();
  try {
    const result = runInline(binding, fixture.env);
    assert.equal(result.status, 0, result.stderr);
    const recordPath = path.join(fixture.root, 'artifact-attestation.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.equal(record.sourceCommit, SHA);
    assert.equal(record.controllerRevision, CONTROLLER_SHA);
    assert.equal(record.workflowRunId, '1234');
    assert.equal(record.artifactId, '7654');
    assert.equal(record.artifactDigest, 'sha256:' + 'c'.repeat(64));
    assert.deepEqual(record.files, fixture.manifest.files);
    assert.equal(record.attestationSha256, createHash('sha256').update(readFileSync(fixture.manifestPath)).digest('hex'));
    assert.equal(statSync(recordPath).mode & 0o777, 0o600);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('artifact drift, unexpected files, symlinks, reruns and malformed transport hashes fail before admission', () => {
  for (const mutate of [
    f => { f.manifest.sourceCommit = 'd'.repeat(40); },
    f => { f.manifest.controllerRevision = 'd'.repeat(40); },
    f => { f.manifest.workflowRunId = '9999'; },
    f => { f.manifest.extra = 'private-sentinel'; },
    f => { writeFileSync(path.join(f.directory, 'source.tar'), 'changed source bytes'); },
    f => { writeFileSync(path.join(f.directory, 'untrusted.mjs'), "throw new Error('must not execute')"); },
    f => { rmSync(path.join(f.directory, 'build.tar')); symlinkSync(f.manifestPath, path.join(f.directory, 'build.tar')); },
    f => { f.env.WORKFLOW_RUN_ATTEMPT = '2'; },
    f => { f.env.ARTIFACT_DIGEST = 'untrusted-digest'; },
  ]) {
    const fixture = candidateFixture();
    try {
      mutate(fixture); writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest));
      const result = runInline(binding, fixture.env);
      assert.equal(result.status, 1);
      assert.equal(result.stderr.trim(), 'LIVE_VALIDATION_CANDIDATE_ARTIFACT_INVALID');
      assert.equal(existsSync(path.join(fixture.root, 'artifact-attestation.json')), false);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test('paid command follows artifact/offline gates, applies validated target caps and always performs scoped cleanup', () => {
  const preflight = named(live, 'Validate protected controller inputs offline');
  const execute = named(live, 'Execute bounded live acceptance through trusted controller');
  const cleanup = named(live, 'Close the paid run and verify cleanup while retaining facility');
  assert.ok(live.steps.indexOf(binding) < live.steps.indexOf(preflight));
  assert.ok(live.steps.indexOf(preflight) < live.steps.indexOf(execute));
  assert.doesNotMatch(preflight.run, /--execute|--allow-paid-provider/u);
  assert.equal(preflight.env.GITHUB_TOKEN, undefined);
  assert.equal(preflight.env.RAILWAY_LIVE_VALIDATION_TOKEN, undefined);
  assert.equal(execute.env.RAILWAY_LIVE_VALIDATION_TOKEN, '${{ secrets.RAILWAY_LIVE_VALIDATION_TOKEN }}');
  assert.match(execute.run, /--execute --allow-paid-provider/u);
  for (const step of [preflight, execute]) {
    assert.equal(step.env.LIVE_VALIDATION_ARTIFACT_DIRECTORY, '${{ runner.temp }}/live-validation-candidate');
    assert.match(step.run, /--artifact-attestation-file "\$\{ARTIFACT_FILE\}"/u);
  }
  for (const step of [preflight, execute, cleanup]) {
    assert.match(step.run, /--max-spend-micro-usd "\$\{LIVE_VALIDATION_MAX_SPEND_MICRO_USD\}"/u);
    assert.match(step.run, /--max-provider-requests "\$\{LIVE_VALIDATION_MAX_PROVIDER_REQUESTS\}"/u);
    assert.match(step.run, /--max-workflows "\$\{LIVE_VALIDATION_MAX_WORKFLOWS\}"/u);
    assert.match(step.run, /--duration-ms "\$\{LIVE_VALIDATION_DURATION_MS\}"/u);
  }
  assert.match(named(offline, 'Validate Gaming acceptance adapter offline').run,
    /--runTestsByPath.*tests\/live-validation-gaming-adapter\.test\.ts.*tests\/trinity-gaming-intake\.test\.ts --coverage=false/u);
  assert.equal(cleanup.if, "always() && steps.bootstrap.outcome == 'success'");
  assert.equal(cleanup['timeout-minutes'], 5);
  assert.match(cleanup.run, /live-validation-controller\.mjs cleanup/u);
  assert.doesNotMatch(cleanup.run, /environmentDelete|serviceDelete|railway.*production/u);
  const evidence = named(live, 'Retain sanitized acceptance and cleanup evidence');
  assert.deepEqual(evidence.with.path.trim().split('\n'), [
    '${{ runner.temp }}/live-validation-evidence/acceptance-summary.json',
    '${{ runner.temp }}/live-validation-evidence/cleanup-summary.json',
  ]);
  assert.equal(evidence.with['retention-days'], 14);
  assert.equal(named(live, 'Remove temporary operator credentials').if, "always() && steps.bootstrap.outcome == 'success'");
});

test('temporary-secret cleanup removes only its owned files outside the checkout', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'live-validation-operator-'));
  const step = named(live, 'Remove temporary operator credentials');
  try {
    chmodSync(directory, 0o700);
    for (const name of ['target.json'])
      writeFileSync(path.join(directory, name), 'temporary-private-fixture', { mode: 0o600 });
    const result = runInline(step, { RUNNER_TEMP: path.dirname(directory), OPERATOR_DIR: directory });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(directory), false);
    const invalid = runInline(step, { RUNNER_TEMP: tmpdir(), OPERATOR_DIR: path.dirname(tmpdir()) });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /LIVE_VALIDATION_OPERATOR_CLEANUP_INVALID/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

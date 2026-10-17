import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { validateWindowsMetadata, summarizeJest, windowsStopAckPassed,
  expectedYamlVersions, validateWindowsSource, validateWindowsJest, windowsSelections,
  runCommand } from './ci-windows-verification.mjs';

const validMetadata = () => ({ platform: 'win32', runnerOS: 'Windows', node: 'v24.18.1', npm: '11.16.0',
  nodePath: process.execPath, nodeSha256: 'd'.repeat(64), npmPath: path.resolve('npm-cli.js'),
  powershell: { IsWindows: true, Path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
  trackedSourceClean: true, headSha: 'a'.repeat(40), testedSha: 'a'.repeat(40),
  headTree: 'c'.repeat(40), testedTree: 'c'.repeat(40) });

test('native receipts require the exact PR commit even when a different commit has the same tree', () => {
  assert.deepEqual(validateWindowsMetadata(validMetadata()), []);
  assert.deepEqual(validateWindowsMetadata({ ...validMetadata(), testedSha: 'b'.repeat(40) }),
    ['EXACT_HEAD_SHA_REQUIRED']);
  assert.deepEqual(validateWindowsMetadata({ ...validMetadata(), testedTree: 'd'.repeat(40) }),
    ['EXACT_HEAD_TREE_REQUIRED']);
  assert.deepEqual(validateWindowsMetadata({ ...validMetadata(), headSha: 'branch-name' }),
    ['EXACT_HEAD_SHA_REQUIRED']);
  assert.deepEqual(validateWindowsMetadata({ ...validMetadata(), trackedSourceClean: false }),
    ['CLEAN_SOURCE_REQUIRED']);
});

test('Linux PowerShell and a floating toolchain cannot satisfy native Windows evidence', () => {
  assert.deepEqual(validateWindowsMetadata({ ...validMetadata(), platform: 'linux', runnerOS: 'Linux',
    powershell: { ...validMetadata().powershell, IsWindows: false }, node: 'v24.19.0', npm: '11.9.0' }),
  ['NATIVE_WINDOWS_REQUIRED', 'PINNED_TOOLCHAIN_REQUIRED', 'WINDOWS_POWERSHELL_REQUIRED']);
});

test('Jest receipts preserve failures and skips without retaining raw failure payloads', () => {
  const result = summarizeJest({ success: false, numTotalTests: 3, numPassedTests: 1,
    numFailedTests: 1, numPendingTests: 1, testResults: [{ name: '/repo/tests/fixture.test.js', status: 'failed',
      failureMessage: 'raw provider-shaped data must not enter receipt', assertionResults: [
        { fullName: 'passed case', status: 'passed' }, { fullName: 'failed case', status: 'failed' },
        { fullName: 'skipped case', status: 'pending' },
      ] }] }, '/repo');
  assert.equal(result.success, false);
  assert.equal(result.numFailedTests, 1);
  assert.equal(result.numPendingTests, 1);
  assert.equal(result.suites[0].file, 'tests/fixture.test.js');
  assert.deepEqual(result.suites[0].assertions.map(item => item.status), ['passed', 'failed', 'pending']);
  assert.ok(!JSON.stringify(result).includes('raw provider'));
});

test('both Windows-only stop/ack cases must execute and pass; missing or skipped is not success', () => {
  const summary = { suites: [1, 2].map(number => ({ file: `tests/gate-r${number}-projector-session.test.js`,
    assertions: [{ title: 'session completes a no-network stop/ack session and removes its session directory',
      status: 'passed' }] })) };
  assert.equal(windowsStopAckPassed(summary), true);
  summary.suites[1].assertions[0].status = 'pending';
  assert.equal(windowsStopAckPassed(summary), false);
  assert.equal(windowsStopAckPassed(undefined), false);
});

test('both actual consumer versions must match the YAML remediation', () => {
  const installed = [{ consumer: '@eslint/eslintrc', version: '4.3.2' },
    { consumer: '@istanbuljs/load-nyc-config', version: '3.15.2' }];
  assert.equal(expectedYamlVersions(installed), true);
  installed[1].version = '3.15.0';
  assert.equal(expectedYamlVersions(installed), false);
  assert.equal(expectedYamlVersions([]), false);
});

test('native metadata requires executable paths and a SHA-256 identity', () => {
  for (const field of ['nodePath', 'npmPath', 'nodeSha256']) {
    assert.deepEqual(validateWindowsMetadata({ ...validMetadata(), [field]: '' }), ['EXECUTABLE_IDENTITY_REQUIRED']);
  }
  assert.deepEqual(validateWindowsMetadata({ ...validMetadata(), powershell: { IsWindows: true } }),
    ['EXECUTABLE_IDENTITY_REQUIRED']);
});

function passingJest(name = 'yaml') {
  const files = windowsSelections[name];
  const counts = name === 'yaml' ? [102, 17] : files.map(() => 1);
  const numTests = counts.reduce((total, count) => total + count, 0);
  return { success: true, wasInterrupted: false, numTotalTests: numTests, numPassedTests: numTests,
    numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numRuntimeErrorTestSuites: 0,
    numTotalTestSuites: files.length, numPassedTestSuites: files.length, numFailedTestSuites: 0,
    numPendingTestSuites: 0, testResults: files.map((file, index) => ({ name: path.resolve(file), status: 'passed',
      assertionResults: Array.from({ length: counts[index] }, (_, number) => ({
        fullName: `${file} synthetic case ${number}`, status: 'passed' })) })) };
}

test('every selection requires all expected suites and YAML requires its complete 119 cases', () => {
  for (const name of Object.keys(windowsSelections)) {
    assert.deepEqual(validateWindowsJest(name, summarizeJest(passingJest(name))), []);
  }
  const summary = summarizeJest(passingJest());
  summary.suites[0].assertions.pop();
  summary.numTotalTests -= 1;
  summary.numPassedTests -= 1;
  assert.deepEqual(validateWindowsJest('yaml', summary), ['YAML_REQUIRED_CASES_MISSING']);
});

for (const [name, mutate] of [
  ['interruption', summary => { summary.wasInterrupted = true; }],
  ['failed run', summary => { summary.success = false; }],
  ...['numFailedTests', 'numPendingTests', 'numTodoTests', 'numRuntimeErrorTestSuites',
    'numFailedTestSuites', 'numPendingTestSuites'].map(key => [key, summary => { summary[key] = 1; }]),
  ['missing counter', summary => { delete summary.numPendingTests; }],
  ['missing suite', summary => { summary.suites.pop(); }],
  ['extra suite', summary => { summary.suites.push(summary.suites[0]); }],
  ['unexpected suite', summary => { summary.suites[0].file = 'tests/unrelated.test.js'; }],
  ['skipped assertion', summary => { summary.suites[0].assertions[0].status = 'pending'; }],
  ['failed assertion', summary => { summary.suites[0].assertions[0].status = 'failed'; }],
  ['failed suite', summary => { summary.suites[0].status = 'failed'; }],
  ['wrong total', summary => { summary.numTotalTests += 1; }],
  ['wrong passed count', summary => { summary.numPassedTests -= 1; }],
  ['wrong suite count', summary => { summary.numTotalTestSuites += 1; }],
  ['wrong passed suite count', summary => { summary.numPassedTestSuites -= 1; }],
  ['malformed assertions', summary => { summary.suites[0].assertions = null; }],
]) {
  test(`native Jest validation rejects ${name} despite a success flag`, () => {
    const summary = summarizeJest(passingJest());
    mutate(summary);
    assert.notDeepEqual(validateWindowsJest('yaml', summary), []);
  });
}

// The real command runner executes only this owned synthetic child and Git repository.
// No mocked production validator or installed application is involved.
function runCommandFixture(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'arcanos-native-command-'));
  const previousDirectory = process.cwd();
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    process.chdir(root);
    mkdirSync('scripts');
    mkdirSync('evidence');
    writeFileSync('tracked.txt', 'owned fixture\n');
    writeFileSync('scripts/run-jest.mjs', `
      import { appendFileSync, writeFileSync } from 'node:fs';
      import { execFileSync } from 'node:child_process';
      const result = process.argv.find(arg => arg.startsWith('--outputFile=')).slice('--outputFile='.length);
      ${options.missingReport ? '' : `writeFileSync(result, ${JSON.stringify(options.reportText ?? JSON.stringify(passingJest()))});`}
      ${options.sourceChange === 'dirty' ? "appendFileSync('tracked.txt', 'changed\\n');" : ''}
      ${options.sourceChange === 'commit' ? "execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'same tree different commit']);" : ''}
      ${options.sourceChange === 'tree' ? "appendFileSync('tracked.txt', 'changed\\n'); execFileSync('git', ['commit', '--quiet', '-am', 'different tree']);" : ''}
      process.exitCode = ${options.exitCode ?? 0};
    `);
    git(['init', '--quiet']);
    git(['config', 'user.name', 'Native receipt fixture']);
    git(['config', 'user.email', 'native-receipt-fixture@example.invalid']);
    git(['config', 'core.hooksPath', path.join(root, 'no-hooks')]);
    git(['add', 'scripts/run-jest.mjs', 'tracked.txt']);
    git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'owned fixture']);
    git(['config', 'commit.gpgsign', 'false']);
    const record = { ...validMetadata(), headSha: git(['rev-parse', 'HEAD']), testedSha: git(['rev-parse', 'HEAD']),
      headTree: git(['rev-parse', 'HEAD^{tree}']), testedTree: git(['rev-parse', 'HEAD^{tree}']),
      nodeSha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') };
    writeFileSync('evidence/metadata.json', JSON.stringify(record));
    if (options.changeBefore) git(['commit', '--quiet', '--allow-empty', '-m', 'changed before command']);
    let exitCode;
    let error;
    try { exitCode = runCommand(path.join(root, 'evidence'), 'yaml'); } catch (failure) { error = failure; }
    return { exitCode, error, record, receipt: existsSync('evidence/yaml-receipt.json')
      ? JSON.parse(readFileSync('evidence/yaml-receipt.json', 'utf8')) : null };
  } finally {
    process.chdir(previousDirectory);
    rmSync(root, { recursive: true, force: true });
  }
}

test('real command receipts bind successful execution to exact source before and after', () => {
  const result = runCommandFixture();
  assert.equal(result.error, undefined);
  assert.equal(result.exitCode, 0);
  assert.equal(result.receipt.command[0], process.execPath);
  assert.equal(result.receipt.processExitCode, 0);
  assert.deepEqual(validateWindowsSource(result.record, result.receipt.sourceBefore), []);
  assert.deepEqual(validateWindowsSource(result.record, result.receipt.sourceAfter), []);
});

test('a different commit before execution is rejected even with an unchanged tree', () => {
  const result = runCommandFixture({ changeBefore: true });
  assert.match(result.error.message, /EXACT_SOURCE_NOT_VERIFIED/u);
  assert.equal(result.receipt, null);
});

for (const sourceChange of ['dirty', 'commit', 'tree']) {
  test(`a command producing ${sourceChange} source retains its successful exit but fails verification`, () => {
    const result = runCommandFixture({ sourceChange });
    assert.equal(result.error, undefined);
    assert.equal(result.exitCode, 1);
    assert.equal(result.receipt.processExitCode, 0);
    assert.notDeepEqual(validateWindowsSource(result.record, result.receipt.sourceAfter), []);
  });
}

for (const [name, options] of [
  ['malformed JSON', { reportText: '{ sensitive-payload-must-not-enter-receipt' }],
  ['malformed report', { reportText: '{"testResults":[{}]}' }],
  ['missing report', { missingReport: true }],
  ['nonzero child exit', { exitCode: 7 }],
]) {
  test(`a ${name} retains the actual process exit and fails closed`, () => {
    const result = runCommandFixture(options);
    assert.equal(result.error, undefined);
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.receipt.processExitCode, options.exitCode ?? 0);
    assert.equal(result.receipt.signal, null);
    assert.equal(result.receipt.errorCode, null);
    assert.ok(!JSON.stringify(result.receipt).includes('sensitive-payload'));
  });
}

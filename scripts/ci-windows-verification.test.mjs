import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateWindowsMetadata, summarizeJest, windowsStopAckPassed,
  expectedYamlVersions } from './ci-windows-verification.mjs';

const validMetadata = () => ({ platform: 'win32', runnerOS: 'Windows', node: 'v24.18.1', npm: '11.16.0',
  powershell: { IsWindows: true }, trackedSourceClean: true, headSha: 'a'.repeat(40), testedSha: 'b'.repeat(40),
  headTree: 'c'.repeat(40), testedTree: 'c'.repeat(40) });

test('native receipts accept a synthetic merge only when its tree equals the exact PR head', () => {
  assert.deepEqual(validateWindowsMetadata(validMetadata()), []);
  assert.deepEqual(validateWindowsMetadata({ ...validMetadata(), testedTree: 'd'.repeat(40) }),
    ['EXACT_HEAD_TREE_REQUIRED']);
  assert.deepEqual(validateWindowsMetadata({ ...validMetadata(), headSha: 'branch-name' }),
    ['EXACT_HEAD_TREE_REQUIRED']);
  assert.deepEqual(validateWindowsMetadata({ ...validMetadata(), trackedSourceClean: false }),
    ['CLEAN_SOURCE_REQUIRED']);
});

test('Linux PowerShell and a floating toolchain cannot satisfy native Windows evidence', () => {
  assert.deepEqual(validateWindowsMetadata({ ...validMetadata(), platform: 'linux', runnerOS: 'Linux',
    powershell: { IsWindows: false }, node: 'v24.19.0', npm: '11.9.0' }),
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

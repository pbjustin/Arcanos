import { describe, expect, it } from '@jest/globals';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import yaml from 'js-yaml';

const workflow = yaml.load(readFileSync('.github/workflows/ci-cd.yml', 'utf8'));
const windowsJob = workflow.jobs['python-cli-windows'];
const fixtureStep = windowsJob.steps.find(step => step.name === 'Verify native Windows projector identity and stop-ack fixtures');
const embeddedProgram = /^@'\r?\n([\s\S]+?)\r?\n'@ \| node --input-type=module\r?\nexit \$LASTEXITCODE\s*$/u.exec(fixtureStep.run)?.[1];
assert.ok(embeddedProgram, 'Expected the executable native Windows receipt verifier');
// Execute the workflow itself. Only imports are supplied by the isolated receipt harness.
const receiptProgram = embeddedProgram.replace(/^import .+ from 'node:[^']+';\r?\n/gmu, '');
const headSha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const suiteFiles = ['tests/gate-r1-projector-session.test.js', 'tests/gate-r2-projector-session.test.js'];
const suitePrefixes = ['Gate R1 projector session', 'Gate R2 bounded masked projector session'];
const requiredTitles = [
  'completes a no-network stop/ack session and removes its session directory',
  'accepts the fixture Node identity and rejects a mismatched hash',
  'rejects a missing fixture Node executable without creating a session directory',
  'rejects an unreadable fixture Node executable without creating a session directory',
  'reproduces the original unbound Node identity initialization failure',
  'propagates guarded cleanup failure after stop/ack without removing its session directory',
];
const secretCanary = 'synthetic-secret-that-must-not-enter-receipts';
const executableBytes = Buffer.from('Synthetic Node executable for receipt hashing only.');

function passingReport() {
  return {
    success: true,
    wasInterrupted: false,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numRuntimeErrorTestSuites: 0,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numPassedTestSuites: 2,
    numTotalTestSuites: 2,
    numTotalTests: requiredTitles.length * suiteFiles.length,
    numPassedTests: requiredTitles.length * suiteFiles.length,
    testResults: suiteFiles.map((file, index) => ({
      name: path.resolve(file),
      status: 'passed',
      assertionResults: requiredTitles.map(title => ({
        title,
        fullName: `${suitePrefixes[index]} ${title}`,
        status: 'passed',
      })),
    })),
  };
}

function runReceipt(overrides = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-windows-receipt-'));
  const artifactDirectory = path.join(directory, 'arcanos-projector-fixtures');
  const nodePath = path.join(directory, 'node.exe');
  const npmPath = path.join(directory, 'node_modules/npm/bin/npm-cli.js');
  const report = passingReport();
  overrides.mutateReport?.(report);
  const state = {
    platform: 'win32', runnerOS: 'Windows', node: 'v24.18.1', npm: '11.16.0',
    powershell: { Version: '7.4.0', IsWindows: true, Path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
    headSha, testedSha: headSha, testedTree: treeSha, headTree: treeSha, gitStatus: '',
    ...overrides.metadata,
  };
  const spawned = [];
  const queried = [];
  let failure;
  try {
    writeFileSync(nodePath, executableBytes);
    runInNewContext(receiptProgram, {
      assert, createHash, mkdirSync, readFileSync, writeFileSync, path,
      process: {
        platform: state.platform, arch: 'x64', version: state.node, execPath: nodePath,
        cwd: () => process.cwd(),
        env: { RUNNER_TEMP: directory, RUNNER_OS: state.runnerOS, PROJECTOR_PR_HEAD_SHA: state.headSha,
          GITHUB_TOKEN: secretCanary, OPENAI_API_KEY: secretCanary, RAILWAY_TOKEN: secretCanary },
      },
      os: { release: () => '10.0.20348', version: () => 'Synthetic Windows receipt fixture' },
      execFileSync(file, args) {
        queried.push([file, ...args]);
        if (file === nodePath && args[0] === npmPath && args[1] === '--version') return state.npm;
        if (file === 'pwsh') return JSON.stringify(state.powershell);
        if (file === 'git') {
          if (args[0] === 'status') return state.gitStatus;
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') return state.testedSha;
          if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') return state.testedTree;
          if (args[0] === 'rev-parse' && args[1] === `${state.headSha}^{tree}`) return state.headTree;
        }
        throw new Error(`Unexpected receipt subprocess: ${file}`);
      },
      spawnSync(file, args, options) {
        spawned.push({ file, args: Array.from(args), options });
        if (!overrides.missingReport) {
          writeFileSync(path.join(artifactDirectory, 'jest.json'), overrides.reportText ?? JSON.stringify(report));
        }
        Object.assign(state, overrides.after);
        return { status: 0, signal: null, ...overrides.result };
      },
    }, { filename: 'ci-cd.yml:windows-projector-receipt', timeout: 5_000 });
  } catch (error) {
    failure = error;
  }
  try {
    const artifacts = {};
    for (const name of ['metadata.json', 'command.json', 'jest.json', 'source-after.json']) {
      const file = path.join(artifactDirectory, name);
      if (existsSync(file)) artifacts[name] = readFileSync(file, 'utf8');
    }
    return { failure, artifacts, spawned, queried, nodePath };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function expectRejected(result) {
  expect(result.failure).toBeDefined();
  expect(result.failure.code).toBe('ERR_ASSERTION');
}

describe('Native Windows projector workflow receipt contract', () => {
  it('accepts an exact-head complete receipt and records executable identity and command outcome', () => {
    const result = runReceipt();
    expect(result.failure).toBeUndefined();
    expect(Object.keys(result.artifacts).sort()).toEqual(['command.json', 'jest.json', 'metadata.json', 'source-after.json']);
    expect(JSON.parse(result.artifacts['metadata.json'])).toMatchObject({
      platform: 'win32', runnerOS: 'Windows', architecture: 'x64', node: 'v24.18.1', npm: '11.16.0',
      nodePath: result.nodePath,
      nodeSha256: createHash('sha256').update(executableBytes).digest('hex').toUpperCase(),
      headSha, testedSha: headSha, testedTree: treeSha, headTree: treeSha, clean: true,
      powershell: { IsWindows: true },
    });
    expect(JSON.parse(result.artifacts['source-after.json'])).toEqual({ testedSha: headSha, testedTree: treeSha, clean: true });
    const command = JSON.parse(result.artifacts['command.json']);
    expect(command).toMatchObject({ exitCode: 0, signal: null, errorCode: null });
    expect(command.command.slice(0, 5)).toEqual([result.nodePath, 'scripts/run-jest.mjs', '--runTestsByPath', ...suiteFiles]);
    expect(command.command).toEqual(expect.arrayContaining(['--coverage=false', '--runInBand', '--json']));
    expect(command.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(command.finishedAt)).toBeGreaterThanOrEqual(Date.parse(command.startedAt));
    expect(result.spawned).toHaveLength(1);
    expect(result.spawned[0].options).toMatchObject({ stdio: 'inherit', windowsHide: true });
    expect(result.queried.every(([file]) => ['git', 'pwsh', result.nodePath].includes(file))).toBe(true);
  });

  it.each([
    ['another commit with an identical tree', { testedSha: 'c'.repeat(40) }],
    ['another tree', { testedTree: 'c'.repeat(40) }],
    ['a dirty checkout', { gitStatus: ' M tests/gate-r1-projector-session.test.js' }],
    ['a non-Windows platform', { platform: 'linux' }],
    ['a non-Windows runner', { runnerOS: 'Linux' }],
    ['a non-Windows PowerShell', { powershell: { IsWindows: false } }],
    ['an unpinned Node runtime', { node: 'v22.0.0' }],
    ['an unpinned npm runtime', { npm: '10.0.0' }],
    ['a malformed head SHA', { headSha: 'not-a-commit' }],
  ])('rejects %s before running projector tests', (_name, metadata) => {
    const result = runReceipt({ metadata });
    expectRejected(result);
    expect(result.spawned).toHaveLength(0);
    expect(result.artifacts['command.json']).toBeUndefined();
  });

  it.each([
    ['the commit', { testedSha: 'c'.repeat(40) }],
    ['the tree', { testedTree: 'c'.repeat(40) }],
    ['a tracked file', { gitStatus: ' M scripts/gate-r1-projector-session-20260719.ps1' }],
  ])('rejects a passing test run that changes %s', (_name, after) => {
    const result = runReceipt({ after });
    expectRejected(result);
    expect(JSON.parse(result.artifacts['command.json']).exitCode).toBe(0);
    expect(result.artifacts['source-after.json']).toBeDefined();
  });

  it.each([
    ['failed process', { status: 1, signal: null }],
    ['terminated process', { status: null, signal: 'SIGTERM' }],
    ['failed process launch', { status: null, error: { code: 'ENOENT', message: secretCanary } }],
  ])('rejects a %s and retains its command receipt', (_name, processResult) => {
    const result = runReceipt({ result: processResult });
    expectRejected(result);
    expect(JSON.parse(result.artifacts['command.json'])).toMatchObject({
      exitCode: processResult.status,
      signal: processResult.signal ?? null,
      errorCode: processResult.error?.code ?? null,
    });
    expect(result.artifacts['metadata.json']).toBeDefined();
    expect(JSON.stringify(result.artifacts)).not.toContain(secretCanary);
  });

  it.each([
    ['an unsuccessful run', report => { report.success = false; }],
    ['an interrupted run', report => { report.wasInterrupted = true; }],
    ...['numFailedTests', 'numPendingTests', 'numTodoTests', 'numRuntimeErrorTestSuites', 'numFailedTestSuites', 'numPendingTestSuites'].map(key =>
      [`a nonzero ${key}`, report => { report[key] = 1; }]),
    ['a missing required counter', report => { delete report.numPendingTests; }],
    ['an incorrect total test count', report => { report.numTotalTests += 1; }],
    ['an incorrect passed test count', report => { report.numPassedTests -= 1; }],
    ['an incorrect total suite count', report => { report.numTotalTestSuites += 1; }],
    ['an incorrect passed suite count', report => { report.numPassedTestSuites -= 1; }],
    ['a failed suite hidden by aggregate counters', report => { report.testResults[0].status = 'failed'; }],
    ['a skipped assertion hidden by aggregate counters', report => { report.testResults[0].assertionResults[0].status = 'pending'; }],
    ['a failed assertion hidden by aggregate counters', report => { report.testResults[1].assertionResults[0].status = 'failed'; }],
    ['a missing suite', report => { report.testResults.pop(); }],
    ['an unrelated suite', report => { report.testResults[0].name = path.resolve('tests/unrelated.test.js'); }],
    ['a duplicate required case', report => { report.testResults[0].assertionResults[1].fullName = report.testResults[0].assertionResults[0].fullName; }],
  ])('rejects %s in the actual Jest report validator', (_name, mutateReport) => {
    expectRejected(runReceipt({ mutateReport }));
  });

  it.each(suitePrefixes.flatMap((prefix, suiteIndex) => requiredTitles.map((title, titleIndex) =>
    [`${prefix} ${title}`, suiteIndex, titleIndex])))('rejects the omitted required case %s even with consistent totals', (_name, suiteIndex, titleIndex) => {
    expectRejected(runReceipt({ mutateReport(report) {
      report.testResults[suiteIndex].assertionResults.splice(titleIndex, 1);
      report.numTotalTests -= 1;
      report.numPassedTests -= 1;
    } }));
  });

  it.each([
    ['malformed JSON', { reportText: '{' }],
    ['a null report', { reportText: 'null' }],
    ['missing suite assertions', { mutateReport(report) { delete report.testResults[0].assertionResults; } }],
    ['a missing report artifact', { missingReport: true }],
  ])('fails closed on %s', (_name, overrides) => {
    const result = runReceipt(overrides);
    expect(result.failure).toBeDefined();
    expect(result.artifacts['metadata.json']).toBeDefined();
    expect(JSON.parse(result.artifacts['command.json']).exitCode).toBe(0);
  });

  it('retains failure evidence and isolates the upload to the exact-head artifact directory', () => {
    const upload = windowsJob.steps.find(step => step.name === 'Upload native Windows projector fixture evidence');
    expect(windowsJob['runs-on']).toBe('windows-latest');
    expect(windowsJob.steps.find(step => step.uses?.startsWith('actions/checkout@')).with).toMatchObject({
      ref: '${{ github.event.pull_request.head.sha || github.sha }}',
      'fetch-depth': 0,
      'persist-credentials': false,
    });
    expect(fixtureStep.env.PROJECTOR_PR_HEAD_SHA).toBe('${{ github.event.pull_request.head.sha || github.sha }}');
    expect(fixtureStep['continue-on-error']).toBeUndefined();
    expect(upload).toMatchObject({
      if: 'always()', uses: 'actions/upload-artifact@v4',
      with: {
        name: 'windows-projector-fixtures-${{ github.event.pull_request.head.sha || github.sha }}-${{ github.run_attempt }}',
        path: '${{ runner.temp }}/arcanos-projector-fixtures/',
        'if-no-files-found': 'error',
      },
    });
    expect(upload.with['include-hidden-files']).not.toBe(true);
    expect(windowsJob.steps.indexOf(upload)).toBeGreaterThan(windowsJob.steps.indexOf(fixtureStep));
  });

  it('keeps receipt artifacts and the Windows job free from credential material', () => {
    expect(JSON.stringify({ permissions: workflow.permissions, env: workflow.env, job: windowsJob })).not.toMatch(/secrets\./u);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(windowsJob.permissions).toBeUndefined();
    const result = runReceipt();
    expect(result.failure).toBeUndefined();
    expect(JSON.stringify(result.artifacts)).not.toContain(secretCanary);
    expect(JSON.parse(result.artifacts['metadata.json']).env).toBeUndefined();
  });

  it('preserves the full Python validation alongside the projector suites', () => {
    const commands = windowsJob.steps.map(step => step.run ?? '').join('\n');
    expect(commands).toContain('python daemon-python/validate_backend_cli_offline.py');
    expect(commands).toContain('pytest daemon-python/tests/ -q --cov=daemon-python/arcanos --cov-report=xml:coverage-python.xml');
  });
});

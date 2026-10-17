import { accessSync, appendFileSync, chmodSync, constants, existsSync, lstatSync, mkdirSync,
  mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const windowsSelections = {
  yaml: ['tests/yaml-dependency-security.test.js', 'tests/yaml-consumer-compatibility.test.js'],
  windows: ['tests/gate-r1-projector-session.test.js', 'tests/gate-r2-projector-session.test.js',
    'tests/self-heal-preview-artifact.test.js'],
  workflows: ['tests/pr-preview-workflow-safety.test.js', 'tests/railway-auto-deploy-supply-chain.test.js',
    'tests/railway-coordinated-rollout-guard.test.js'],
  gaming: ['tests/gaming-generic-late-source-scope.test.ts', 'tests/gaming-hybrid-lifecycle.integration.test.ts',
    'tests/gaming-mission-acquisition.integration.test.ts', 'tests/gaming-resolved-source-ingestion.integration.test.ts'],
};
const commandNames = ['install', 'type-check', 'build', ...Object.keys(windowsSelections)];
const countNames = ['success', 'numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests',
  'numTodoTests', 'numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites'];
const stopAckTitle = 'completes a no-network stop/ack session and removes its session directory';

export function validateWindowsMetadata(record) {
  const errors = [];
  if (record.platform !== 'win32' || record.runnerOS !== 'Windows') errors.push('NATIVE_WINDOWS_REQUIRED');
  if (record.node !== 'v24.18.1' || record.npm !== '11.16.0') errors.push('PINNED_TOOLCHAIN_REQUIRED');
  if (record.powershell?.IsWindows !== true) errors.push('WINDOWS_POWERSHELL_REQUIRED');
  if (record.trackedSourceClean !== true) errors.push('CLEAN_SOURCE_REQUIRED');
  if (!/^[0-9a-f]{40}$/u.test(record.headSha ?? '') || !/^[0-9a-f]{40}$/u.test(record.testedSha ?? '')
    || !/^[0-9a-f]{40}$/u.test(record.headTree ?? '') || record.headTree !== record.testedTree) {
    errors.push('EXACT_HEAD_TREE_REQUIRED');
  }
  return errors;
}

export function summarizeJest(result, root = process.cwd()) {
  return {
    ...Object.fromEntries(countNames.map(name => [name, result[name]])),
    suites: result.testResults.map(suite => ({
      file: path.relative(root, suite.name).replaceAll('\\', '/'),
      status: suite.status,
      assertions: suite.assertionResults.map(assertion => ({
        title: assertion.fullName, status: assertion.status,
      })),
    })),
  };
}

export function windowsStopAckPassed(summary) {
  return ['gate-r1-projector-session.test.js', 'gate-r2-projector-session.test.js'].every(file =>
    summary?.suites?.some(suite => suite.file.endsWith(`/${file}`)
      && suite.assertions.some(assertion => assertion.title.endsWith(stopAckTitle)
        && assertion.status === 'passed')));
}

function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function writeJson(directory, name, value) {
  writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
}
function query(executable, args) {
  return execFileSync(executable, args, { encoding: 'utf8', timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function npmCli() {
  const file = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!existsSync(file)) throw new Error('BUNDLED_NPM_CLI_REQUIRED');
  return file;
}

function installedYaml() {
  const rootRequire = createRequire(path.resolve('package.json'));
  return ['@eslint/eslintrc', '@istanbuljs/load-nyc-config'].map(consumer => {
    const consumerEntry = rootRequire.resolve(consumer);
    const consumerRequire = createRequire(consumerEntry);
    const entry = consumerRequire.resolve('js-yaml');
    return { consumer, entry: path.relative(process.cwd(), entry).replaceAll('\\', '/'),
      version: consumerRequire('js-yaml/package.json').version };
  });
}

export function expectedYamlVersions(installed) {
  return installed?.length === 2 && installed.some(item => item.consumer === '@eslint/eslintrc'
    && item.version === '4.3.2') && installed.some(item => item.consumer === '@istanbuljs/load-nyc-config'
    && item.version === '3.15.2');
}

async function capabilities(directory) {
  if (process.platform !== 'win32') throw new Error('NATIVE_WINDOWS_REQUIRED');
  const root = mkdtempSync(path.join(directory, 'capability-'));
  const modulePath = path.join(root, 'module with spaces # fixture.mjs');
  const record = { platform: process.platform, errors: [], cleanup: false };
  try {
    writeFileSync(modulePath, 'export default { synthetic: true, value: 42 };\n');
    const moduleUrl = pathToFileURL(modulePath);
    const imported = await import(moduleUrl.href);
    record.esm = { fileUrlRoundtrip: fileURLToPath(moduleUrl) === modulePath,
      importedSyntheticValue: imported.default.synthetic === true && imported.default.value === 42 };
    if (!record.esm.fileUrlRoundtrip || !record.esm.importedSyntheticValue) record.errors.push('ESM_FILE_URL_FAILED');
    const target = path.join(root, 'target');
    const junction = path.join(root, 'junction');
    mkdirSync(target);
    writeFileSync(path.join(target, 'value.txt'), 'synthetic');
    symlinkSync(target, junction, 'junction');
    record.junction = { recognizedAsLink: lstatSync(junction).isSymbolicLink(),
      resolvesToOwnedTarget: realpathSync(junction) === realpathSync(target),
      readsExpectedBytes: readFileSync(path.join(junction, 'value.txt'), 'utf8') === 'synthetic' };
    if (!Object.values(record.junction).every(Boolean)) record.errors.push('WINDOWS_JUNCTION_FAILED');
    accessSync(modulePath, constants.R_OK | constants.W_OK);
    chmodSync(modulePath, 0o444);
    accessSync(modulePath, constants.R_OK);
    let writable = true;
    try { accessSync(modulePath, constants.W_OK); } catch { writable = false; }
    record.permissions = { ownedFileInitiallyReadableWritable: true, readonlyFileReadable: true,
      readonlyFileWritable: writable, observedMode: (statSync(modulePath).mode & 0o777).toString(8),
      scope: 'Owned temporary file and Windows read-only attribute; not a POSIX ACL equivalence claim' };
    if (writable) record.errors.push('WINDOWS_READONLY_ATTRIBUTE_NOT_ENFORCED');
  } catch (error) {
    record.errors.push(error?.code ?? 'WINDOWS_CAPABILITY_FAILED');
  } finally {
    try {
      if (path.dirname(root) !== directory || !path.basename(root).startsWith('capability-')) {
        throw new Error('CAPABILITY_CLEANUP_PATH_INVALID');
      }
      if (existsSync(modulePath)) chmodSync(modulePath, 0o666);
      rmSync(root, { recursive: true, force: true });
      record.cleanup = !existsSync(root);
    } catch (error) {
      record.errors.push(error?.code ?? 'CAPABILITY_CLEANUP_FAILED');
    }
    if (!record.cleanup) record.errors.push('CAPABILITY_CLEANUP_FAILED');
    writeJson(directory, 'capabilities.json', record);
  }
  return record.errors.length === 0 ? 0 : 1;
}

function metadata(directory) {
  const revision = ref => query('git', ['rev-parse', '--verify', ref]);
  const headSha = process.env.EVIDENCE_HEAD_SHA;
  const record = { platform: process.platform, runnerOS: process.env.RUNNER_OS,
    osRelease: os.release(), architecture: process.arch, node: process.version,
    npm: query(process.execPath, [npmCli(), '--version']), headSha,
    testedSha: revision('HEAD'), testedTree: revision('HEAD^{tree}'),
    trackedSourceClean: query('git', ['status', '--porcelain', '--untracked-files=no']) === '',
    headTree: /^[0-9a-f]{40}$/u.test(headSha ?? '') ? revision(`${headSha}^{tree}`) : null,
    powershell: JSON.parse(query('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[ordered]@{Version=$PSVersionTable.PSVersion.ToString();Platform=$PSVersionTable.Platform;IsWindows=$IsWindows} | ConvertTo-Json -Compress'])),
    lockfileSha256: createHash('sha256').update(readFileSync('package-lock.json')).digest('hex'),
    workflowCount: readdirSync('.github/workflows').filter(file => /\.ya?ml$/u.test(file)).length,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    selectionScope: 'Focused native Windows contracts and serial Gaming diagnostics; not full-root Windows Jest',
  };
  record.errors = validateWindowsMetadata(record);
  writeJson(directory, 'metadata.json', record);
  console.log(JSON.stringify(record));
  return record.errors.length === 0 ? 0 : 1;
}

function runCommand(directory, name) {
  if (!commandNames.includes(name)) throw new Error('UNKNOWN_WINDOWS_SELECTION');
  if (validateWindowsMetadata(readJson(path.join(directory, 'metadata.json'))).length) {
    throw new Error('WINDOWS_METADATA_NOT_VERIFIED');
  }
  if (query('git', ['status', '--porcelain', '--untracked-files=no']) !== '') {
    throw new Error('TRACKED_SOURCE_CHANGED');
  }
  const selected = windowsSelections[name];
  const resultPath = path.join(directory, `${name}-jest.json`);
  const args = selected ? ['scripts/run-jest.mjs', '--runTestsByPath', ...selected,
    '--coverage=false', ...(name === 'gaming' ? ['--runInBand']
      : ['--maxWorkers=2', '--workerIdleMemoryLimit=768MB']), '--json', `--outputFile=${resultPath}`]
    : [npmCli(), ...(name === 'install' ? ['ci'] : ['run', name])];
  const startedAt = new Date().toISOString();
  const child = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  const receipt = { name, command: ['node', ...args], startedAt, finishedAt: new Date().toISOString(),
    processExitCode: child.status, exitCode: child.status, validationErrors: [],
    signal: child.signal, errorCode: child.error?.code ?? null,
    execution: name === 'gaming' ? 'serial focused diagnostic' : selected ? 'two Jest workers' : 'canonical npm script',
    resultAvailable: selected ? existsSync(resultPath) : null };
  if (selected && receipt.resultAvailable) receipt.jest = summarizeJest(readJson(resultPath));
  if (name === 'install' && child.status === 0) {
    receipt.installedYaml = installedYaml();
    receipt.patchedYamlVersionsVerified = expectedYamlVersions(receipt.installedYaml);
    if (!receipt.patchedYamlVersionsVerified) {
      receipt.validationErrors.push('PATCHED_YAML_VERSIONS_NOT_VERIFIED');
      receipt.exitCode = 1;
    }
  }
  writeJson(directory, `${name}-receipt.json`, receipt);
  return receipt.exitCode ?? 1;
}

function report(directory) {
  const metadataPath = path.join(directory, 'metadata.json');
  const record = existsSync(metadataPath) ? readJson(metadataPath) : null;
  const capabilityPath = path.join(directory, 'capabilities.json');
  const capability = existsSync(capabilityPath) ? readJson(capabilityPath) : null;
  const receipts = Object.fromEntries(commandNames.map(name => {
    const file = path.join(directory, `${name}-receipt.json`);
    return [name, existsSync(file) ? readJson(file) : { name, status: 'NOT_RUN' }];
  }));
  const errors = record ? validateWindowsMetadata(record) : ['METADATA_MISSING'];
  if (!capability || capability.errors.length || !capability.cleanup) errors.push('WINDOWS_CAPABILITIES_NOT_PASSED');
  for (const [name, receipt] of Object.entries(receipts)) {
    if (receipt.exitCode !== 0) errors.push(`${name}:COMMAND_NOT_PASSED`);
    if (windowsSelections[name] && receipt.jest?.success !== true) errors.push(`${name}:JEST_NOT_PASSED`);
  }
  if (!windowsStopAckPassed(receipts.windows.jest)) errors.push('WINDOWS_STOP_ACK_CASES_NOT_PASSED');
  if (!expectedYamlVersions(receipts.install.installedYaml)) errors.push('PATCHED_YAML_VERSIONS_NOT_VERIFIED');
  const summary = { metadata: record, capabilities: capability, receipts, errors, success: errors.length === 0 };
  writeJson(directory, 'summary.json', summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Native Windows verification: ${summary.success ? 'PASS' : 'FAIL'}\n\n`
      + `Exact source tree: ${record?.testedTree ?? 'unavailable'}\n\n`
      + 'Focused fixtures only; full-root Windows Jest was not executed.\n');
  console.log(JSON.stringify({ success: summary.success, errors }));
  return summary.success ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.env.RUNNER_TEMP) throw new Error('RUNNER_TEMP_REQUIRED');
    const directory = path.join(process.env.RUNNER_TEMP, 'arcanos-windows-verification');
    mkdirSync(directory, { recursive: true });
    const command = process.argv[2];
    process.exitCode = command === 'metadata' ? metadata(directory)
      : command === 'capabilities' ? await capabilities(directory)
      : command === 'run' ? runCommand(directory, process.argv[3])
        : command === 'report' ? report(directory) : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'WINDOWS_VERIFICATION_FAILED');
    process.exitCode = 1;
  }
}

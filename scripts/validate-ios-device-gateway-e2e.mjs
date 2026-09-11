import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REQUIRED_ASSERTIONS = Object.freeze([
  'swift_client_flow',
  'pairing_persisted_hashed_only',
  'ai_job_persisted_with_device_owner',
  'ai_worker_claim_executed_and_fenced',
  'provider_fixture_called',
  'local_agent_confirmation_single_enqueue',
  'local_agent_executor_result_persisted',
  'device_rotation_and_revocation_persisted',
  'cross_device_job_reads_denied',
  'secret_free_report',
  'local_agent_device_idempotency_isolated',
]);

/** Reject configured/remote databases before importing any application code. */
export function validateDatabaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('E2E_DATABASE_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || !url.username || url.search || url.hash
    || !/^\/(?:arcanos_audit_pg18_20260727|arcanos_ios_e2e_[a-z0-9_]+)$/.test(url.pathname)) {
    throw new Error('E2E_DATABASE_NOT_DISPOSABLE');
  }
  return url.toString();
}

export function validateSwiftBinary(value) {
  try {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error();
    const resolved = realpathSync(value);
    if (!statSync(resolved).isFile()) throw new Error();
    accessSync(resolved, constants.X_OK);
    return resolved;
  } catch { throw new Error('E2E_SWIFT_BINARY_INVALID'); }
}

export function validateSwiftArguments(value) {
  if (value === undefined || value === '') return [];
  let args;
  try { args = JSON.parse(value); } catch { throw new Error('E2E_SWIFT_ARGUMENTS_INVALID'); }
  if (!Array.isArray(args) || args.length > 16
    || args.some(arg => typeof arg !== 'string' || arg.length > 4096 || /[\0\r\n]/.test(arg))) {
    throw new Error('E2E_SWIFT_ARGUMENTS_INVALID');
  }
  return args;
}

/** Only OS/toolchain plumbing crosses the subprocess boundary, never app credentials. */
export function buildChildEnvironment(parentEnv, options) {
  const environment = {};
  for (const key of [
    'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC',
    'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA',
    'APPDATA', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH',
  ]) {
    if (typeof parentEnv[key] === 'string') environment[key] = parentEnv[key];
  }
  return {
    ...environment,
    CI: 'true', NODE_ENV: 'test', LOG_LEVEL: 'error',
    DISABLE_EXTERNAL_CALLS: 'true', USE_MOCK_SERVICES: 'true', RUN_WORKERS: 'false',
    OPENAI_API_KEY: 'test-ios-e2e-provider-placeholder',
    IOS_DEVICE_E2E: '1',
    IOS_DEVICE_E2E_DATABASE_URL: options.databaseUrl,
    IOS_DEVICE_E2E_SWIFT_BINARY: options.swiftBinary,
    IOS_DEVICE_E2E_SWIFT_ARGS: JSON.stringify(options.swiftArguments ?? []),
    IOS_DEVICE_E2E_REPORT_PATH: options.reportPath,
    IOS_DEVICE_E2E_RUN_ID: options.runId,
    IOS_DEVICE_E2E_SOURCE_SHA: options.sourceSha,
  };
}

export function validateProofReport(report, binding) {
  const assertions = report?.assertions;
  if (report?.proof !== 'ios-device-e2e/v1' || report.passed !== true
    || report.runId !== binding.runId || report.sourceSha !== binding.sourceSha
    || report.transport !== 'urlsession-loopback-http-test-adapter'
    || report.schemaRemoved !== true || report.serverClosed !== true
    || !Array.isArray(assertions) || assertions.length !== REQUIRED_ASSERTIONS.length
    || assertions.some(assertion => assertion?.passed !== true)
    || new Set(assertions.map(assertion => assertion?.name)).size !== REQUIRED_ASSERTIONS.length
    || REQUIRED_ASSERTIONS.some(name => !assertions.some(assertion => assertion.name === name))) {
    throw new Error('E2E_PROOF_INCOMPLETE');
  }
  return report;
}

export async function runBounded(args, environment, options = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      cwd: root, env: environment, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bytes = 0;
    let failed = false;
    const terminate = () => {
      failed = true;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000, stdio: 'ignore' });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
    };
    const timeout = setTimeout(terminate, options.timeoutMs ?? 180_000);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', chunk => { bytes += chunk.length; if (bytes > (options.maxOutputBytes ?? 8 * 1024 * 1024)) terminate(); });
    }
    child.once('error', () => { failed = true; });
    child.once('close', code => { clearTimeout(timeout); resolve({ status: code, failed }); });
  });
}

export async function main() {
  let directory;
  let databaseUrl;
  let runId;
  try {
    databaseUrl = validateDatabaseUrl(process.env.IOS_DEVICE_E2E_DATABASE_URL);
    const swiftBinary = validateSwiftBinary(process.env.IOS_DEVICE_E2E_SWIFT_BINARY);
    const swiftArguments = validateSwiftArguments(process.env.IOS_DEVICE_E2E_SWIFT_ARGS);
    const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    const sourceSha = git.stdout?.trim();
    if (git.status !== 0 || !/^[a-f0-9]{40}$/.test(sourceSha ?? '')) throw new Error('E2E_SOURCE_UNKNOWN');
    const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    if (dirty.status !== 0) throw new Error('E2E_SOURCE_UNKNOWN');
    directory = mkdtempSync(path.join(tmpdir(), 'arcanos-ios-device-e2e-'));
    const reportPath = path.join(directory, 'proof.json');
    const jestPath = path.join(directory, 'jest.json');
    runId = randomUUID();
    const run = await runBounded([
      // Dedicated opt-in fixture supplies its own closed environment; the ordinary
      // wrapper loads .env.test and could overwrite the validated target/bindings.
      '--experimental-vm-modules', 'node_modules/jest/bin/jest.js',
      '--runTestsByPath', 'tests/integration/ios-device-gateway.e2e.integration.test.ts',
      '--coverage=false', '--runInBand', '--json', `--outputFile=${jestPath}`,
    ], buildChildEnvironment(process.env, { databaseUrl, swiftBinary, swiftArguments, reportPath, runId, sourceSha }));
    if (run.status !== 0 || run.failed) throw new Error('E2E_PROCESS_FAILED');
    const jest = JSON.parse(readFileSync(jestPath, 'utf8'));
    if (jest.success !== true || jest.numPassedTests < 1 || jest.numPendingTests !== 0 || jest.numFailedTests !== 0) {
      throw new Error('E2E_TESTS_INCOMPLETE');
    }
    const report = validateProofReport(JSON.parse(readFileSync(reportPath, 'utf8')), { runId, sourceSha });
    removeOwnedDirectory(directory);
    directory = undefined;
    // Only the closed, server-verified projection is published; no raw child logs or tokens.
    console.log(JSON.stringify({
      proof: report.proof, passed: true, executed: true, sourceSha,
      workingTreeModified: Boolean(dirty.stdout.trim()), runId, transport: report.transport,
      assertions: report.assertions.map(({ name, passed }) => ({ name, passed })),
      schemaRemoved: true, serverClosed: true,
      synthetic: ['Keychain item storage', 'local inference', 'provider response', 'Local Agent executor registration and output'],
      productionCredentialsUsed: false, physicalDeviceValidated: false, productionTlsValidated: false,
    }, null, 2));
    return 0;
  } catch (error) {
    const code = error instanceof Error && /^E2E_[A-Z_]+$/.test(error.message) ? error.message : 'E2E_PROOF_FAILED';
    console.error(JSON.stringify({ proof: 'ios-device-e2e/v1', passed: false, error: code }));
    return 1;
  } finally {
    // A killed test cannot run afterAll. Drop only this run's deterministic schema.
    if (directory && databaseUrl && runId) {
      const { Client } = await import('pg');
      const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000,
        query_timeout: 5_000, statement_timeout: 5_000 });
      try {
        await client.connect();
        const schema = `ios_device_e2e_${runId.replaceAll('-', '')}`;
        if (!/^ios_device_e2e_[a-f0-9]{32}$/.test(schema)) throw new Error('E2E_CLEANUP_TARGET_INVALID');
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } catch { console.error(JSON.stringify({ proof: 'ios-device-e2e/v1', passed: false, error: 'E2E_DATABASE_CLEANUP_UNCONFIRMED' })); }
      finally { await client.end().catch(() => {}); }
    }
    if (directory) {
      removeOwnedDirectory(directory);
    }
  }
}

function removeOwnedDirectory(directory) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(tmpdir())
    || !path.basename(resolved).startsWith('arcanos-ios-device-e2e-')) throw new Error('E2E_CLEANUP_TARGET_INVALID');
  rmSync(resolved, { recursive: true, force: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

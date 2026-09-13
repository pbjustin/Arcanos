import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  buildChildEnvironment,
  REQUIRED_ASSERTIONS,
  SHIPPING_PHASES,
  runBounded,
  validateDatabaseUrl,
  validateProofReport,
  validateSwiftArguments,
  validateSwiftBinary,
} from '../scripts/validate-ios-device-gateway-e2e.mjs';

const databaseUrl = 'postgresql://fixture:fixture-only@127.0.0.1:5432/arcanos_ios_e2e_contract';
const sourceSha = 'a'.repeat(40);

describe('durable Swift device E2E runner admission', () => {
  it.each([
    databaseUrl,
    'postgresql://fixture:fixture-only@localhost:5432/arcanos_audit_pg18_20260727',
    'postgresql://fixture:fixture-only@[::1]:5432/arcanos_ios_e2e_contract',
  ])('accepts only an explicitly named loopback fixture database: %s', value => {
    expect(validateDatabaseUrl(value)).toBe(value);
  });

  it.each([
    undefined, '', 'not-a-url',
    'https://fixture:fixture-only@127.0.0.1:5432/arcanos_ios_e2e_contract',
    'postgresql://fixture:fixture-only@database.example:5432/arcanos_ios_e2e_contract',
    'postgresql://fixture:fixture-only@127.0.0.1:5432/production',
    'postgresql://fixture:fixture-only@127.0.0.1/arcanos_ios_e2e_contract',
    'postgresql://127.0.0.1:5432/arcanos_ios_e2e_contract',
    `${databaseUrl}?options=-csearch_path%3Dpublic`,
    `${databaseUrl}#ignored`,
  ])('rejects missing, remote, ambiguous or shared database targets', value => {
    expect(() => validateDatabaseUrl(value)).toThrow();
  });

  it('does not reflect rejected database credentials', () => {
    const secret = 'private-test-database-password-marker';
    let rejection;
    try {
      validateDatabaseUrl(`postgresql://fixture:${secret}@database.example:5432/production`);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect(String(rejection)).not.toContain(secret);
    expect(String(rejection)).not.toContain('database.example');
  });

  it('requires an existing absolute executable file before enabling the proof', () => {
    expect(validateSwiftBinary(process.execPath)).toBe(process.execPath);
    for (const value of [undefined, '', 'ArcanosDeviceE2E', path.dirname(process.execPath),
      path.resolve('missing-ios-device-e2e-binary')]) {
      expect(() => validateSwiftBinary(value)).toThrow();
    }
  });

  it('bounds optional executable arguments without accepting shell text as a command', () => {
    expect(validateSwiftArguments(undefined)).toEqual([]);
    expect(validateSwiftArguments('[]')).toEqual([]);
    expect(validateSwiftArguments('["--fixture"]')).toEqual(['--fixture']);
    for (const value of ['not-json', '{}', '[null]', '[42]', JSON.stringify(['x\ncommand']),
      JSON.stringify(['x\0command']), JSON.stringify(['x'.repeat(4097)]), JSON.stringify(Array(17).fill('x'))]) {
      expect(() => validateSwiftArguments(value)).toThrow();
    }
  });

  it('constructs the child environment from an allowlist and validated fixture inputs', () => {
    const options = {
      databaseUrl,
      swiftBinary: process.execPath,
      reportPath: path.resolve('fixture-report.json'),
      runId: 'fixture-run-123',
      sourceSha,
    };
    const environment = buildChildEnvironment({
      PATH: '/fixture/tools',
      SystemRoot: 'C:\\Windows',
      OPENAI_API_KEY: 'private-test-provider-marker',
      DATABASE_URL: 'private-production-database-marker',
      PGOPTIONS: '-c search_path=public',
      REDIS_URL: 'private-cache-marker',
      ARCANOS_GPT_ACCESS_TOKEN: 'private-operator-marker',
      RAILWAY_TOKEN: 'private-railway-marker',
      NODE_OPTIONS: '--import=untrusted-preload.mjs',
      IOS_DEVICE_E2E: '0',
      IOS_DEVICE_E2E_DATABASE_URL: 'unvalidated-target',
      UNRELATED_ENVIRONMENT: 'private-unrelated-marker',
    }, options);
    expect(environment.PATH).toBe('/fixture/tools');
    expect(environment.CI).toBe('true');
    expect(environment.IOS_DEVICE_E2E).toBe('1');
    expect(environment.IOS_DEVICE_E2E_DATABASE_URL).toBe(databaseUrl);
    expect(environment.IOS_DEVICE_E2E_SWIFT_BINARY).toBe(process.execPath);
    expect(JSON.stringify(environment)).not.toMatch(/private-|untrusted-preload|unvalidated-target|search_path=public/);
    for (const name of ['DATABASE_URL', 'PGOPTIONS', 'REDIS_URL', 'ARCANOS_GPT_ACCESS_TOKEN',
      'RAILWAY_TOKEN', 'NODE_OPTIONS', 'UNRELATED_ENVIRONMENT']) {
      expect(environment[name]).toBeUndefined();
    }
  });

  it('fails without an explicit database before launching a test and prints no success marker', () => {
    const environment = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']
      .filter(name => typeof process.env[name] === 'string').map(name => [name, process.env[name]]));
    const result = spawnSync(process.execPath, ['scripts/validate-ios-device-gateway-e2e.mjs'], {
      cwd: process.cwd(), env: environment, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ proof: 'ios-device-e2e/v1', passed: false, error: 'E2E_DATABASE_INVALID' });
  });
});

describe('durable Swift device E2E evidence admission', () => {
  const binding = { runId: 'fixture-run-123', sourceSha };
  const requiredNames = [
    'swift_client_flow',
    'pairing_persisted_hashed_only',
    'ai_job_persisted_with_device_owner',
    'ai_worker_claim_executed_and_fenced',
    'provider_fixture_called',
    'local_agent_confirmation_single_enqueue',
    'local_agent_device_idempotency_isolated',
    'local_agent_executor_result_persisted',
    'device_rotation_and_revocation_persisted',
    'cross_device_job_reads_denied',
    'secret_free_report',
    'shipping_ai_receipt_survives_process_exit',
    'shipping_ai_worker_completion_recovered',
    'shipping_confirmation_receipt_survives_process_exit',
    'shipping_confirmation_completion_recovered',
    'shipping_recovery_no_duplicate_jobs_or_executions',
    'shipping_recovery_credential_partition_isolated',
    'shipping_recovery_revoked_device_denied',
    'shipping_recovery_index_secret_free',
  ];
  function completeReport() {
    return {
      proof: 'ios-device-e2e/v1', ...binding, passed: true,
      transport: 'urlsession-loopback-http-test-adapter',
      schemaRemoved: true, serverClosed: true,
      shipping: { shippingDirectoryRemoved: true, phases: SHIPPING_PHASES.map(([phase, creates, capabilities, results]) => ({
        version: 'ios-shipping-device-e2e/v1', phase, creates, capabilities, results, ...binding, ok: true, processSucceeded: true,
      })) },
      sql: { shippingAIExecutions: 1, shippingExecutorExecutions: 1 },
      assertions: requiredNames.map(name => ({ name, passed: true })),
    };
  }

  it('requires every durable boundary rather than accepting only a minimum assertion count', () => {
    expect([...REQUIRED_ASSERTIONS].sort()).toEqual([...requiredNames].sort());
    const report = completeReport();
    expect(validateProofReport(report, binding)).toBe(report);
    report.assertions.reverse();
    expect(validateProofReport(report, binding)).toBe(report);
  });

  it.each([
    ['missing assertion', report => report.assertions.pop()],
    ['duplicate assertion', report => { report.assertions[1] = report.assertions[0]; }],
    ['unknown assertion', report => { report.assertions[0].name = 'unverified_provider_success'; }],
    ['failed assertion', report => { report.assertions[0].passed = false; }],
    ['truthy assertion', report => { report.assertions[0].passed = 'true'; }],
    ['null assertion', report => { report.assertions[0] = null; }],
    ['missing assertions', report => { delete report.assertions; }],
    ['skipped overall result', report => { report.passed = false; }],
    ['different run', report => { report.runId = 'previous-run'; }],
    ['different commit', report => { report.sourceSha = 'b'.repeat(40); }],
    ['wrong proof', report => { report.proof = 'ios-device-gateway-v1'; }],
    ['overclaimed transport', report => { report.transport = 'shipping-https'; }],
    ['schema cleanup failure', report => { report.schemaRemoved = false; }],
    ['server still running', report => { report.serverClosed = false; }],
    ['shipping state cleanup failure', report => { report.shipping.shippingDirectoryRemoved = false; }],
    ['shipping process skipped', report => { report.shipping.phases.pop(); }],
    ['shipping process failure', report => { report.shipping.phases[0].processSucceeded = false; }],
    ['shipping process from another commit', report => { report.shipping.phases[0].sourceSha = 'b'.repeat(40); }],
    ['shipping process from another run', report => { report.shipping.phases[0].runId = 'other-run'; }],
    ['shipping restoration duplicate creation', report => { report.shipping.phases[1].creates = 1; }],
    ['shipping duplicate worker execution', report => { report.sql.shippingAIExecutions = 2; }],
    ['shipping missing executor execution', report => { report.sql.shippingExecutorExecutions = 0; }],
  ])('rejects %s before publishing success', (_name, mutate) => {
    const report = completeReport();
    mutate(report);
    expect(() => validateProofReport(report, binding)).toThrow('E2E_PROOF_INCOMPLETE');
  });

  it.each([null, undefined, {}, [], true])('rejects absent or invalid report objects', report => {
    expect(() => validateProofReport(report, binding)).toThrow('E2E_PROOF_INCOMPLETE');
  });
});

describe('bounded real proof subprocesses', () => {
  const environment = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']
    .filter(name => typeof process.env[name] === 'string').map(name => [name, process.env[name]]));

  it('returns success only for a completed process within its bounds', async () => {
    await expect(runBounded(['-e', 'process.stdout.write("fixture")'], environment,
      { timeoutMs: 3000, maxOutputBytes: 64 })).resolves.toEqual({ status: 0, failed: false });
  });

  it('terminates an idle child at the timeout', async () => {
    const result = await runBounded(['-e', 'setInterval(() => {}, 1000)'], environment,
      { timeoutMs: 100, maxOutputBytes: 64 });
    expect(result.failed).toBe(true);
    expect(result.status).not.toBe(0);
  });

  it.each(['stdout', 'stderr'])('rejects %s overflow even when the child tries to finish successfully', async stream => {
    const result = await runBounded(['-e', `process.${stream}.write("x".repeat(4096)); setInterval(() => {}, 1000)`], environment,
      { timeoutMs: 3000, maxOutputBytes: 64 });
    expect(result.failed).toBe(true);
    expect(result.status).not.toBe(0);
  });

  it('terminates a grandchild in the owned process tree too', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-ios-e2e-process-test-'));
    const pidPath = path.join(directory, 'grandchild.pid');
    let grandchildPid;
    let needsTermination = false;
    try {
      const childSource = 'const { spawn } = require("node:child_process"); '
        + 'const { writeFileSync } = require("node:fs"); '
        + 'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true }); '
        + 'writeFileSync(process.env.FIXTURE_PID_PATH, String(child.pid)); setInterval(() => {}, 1000);';
      const result = await runBounded(['-e', childSource], { ...environment, FIXTURE_PID_PATH: pidPath },
        { timeoutMs: 1500, maxOutputBytes: 64 });
      expect(result.failed).toBe(true);
      expect(existsSync(pidPath)).toBe(true);
      grandchildPid = Number(readFileSync(pidPath, 'utf8'));
      expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);
      needsTermination = true;
      const isRunning = () => {
        try { process.kill(grandchildPid, 0); } catch { return false; }
        // Linux may briefly retain a killed, non-running child as an init-owned zombie.
        if (process.platform === 'linux') {
          try { return !/^\d+ \(.*\) Z /u.test(readFileSync(`/proc/${grandchildPid}/stat`, 'utf8')); }
          catch { return false; }
        }
        return true;
      };
      for (let attempt = 0; attempt < 20 && isRunning(); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      needsTermination = isRunning();
      expect(needsTermination).toBe(false);
    } finally {
      if (needsTermination && Number.isInteger(grandchildPid) && grandchildPid > 0) {
        try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* Owned fixture process already exited. */ }
      }
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== path.resolve(tmpdir())
        || !path.basename(resolved).startsWith('arcanos-ios-e2e-process-test-')) throw new Error('Invalid fixture cleanup target');
      rmSync(resolved, { recursive: true, force: true });
    }
  }, 5000);
});

describe('required durable Swift device E2E CI coverage', () => {
  const workflow = yaml.load(readFileSync('.github/workflows/ci-cd.yml', 'utf8'));
  const job = workflow.jobs['local-agent-postgres-concurrency'];
  const step = job.steps.find(value => value.run?.includes('node scripts/validate-ios-device-gateway-e2e.mjs'));

  it('executes the proof inside the existing required PostgreSQL job', () => {
    expect(workflow.jobs['all-checks-complete'].needs).toContain('local-agent-postgres-concurrency');
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job.services.postgres.image).toBe('postgres:18-alpine');
    expect(job.env.ARCANOS_POSTGRES_TESTS_REQUIRE_DATABASE).toBe('1');
    expect(step).toBeDefined();
    expect(step.env.IOS_DEVICE_E2E_DATABASE_URL).toBe('${{ env.GPT_ACCESS_DEVICE_TEST_DATABASE_URL }}');
    expect(step.if).toBeUndefined();
    expect(step['continue-on-error']).toBeUndefined();
    expect(step['timeout-minutes']).toBeLessThanOrEqual(10);
    expect(job.steps.indexOf(step)).toBeGreaterThan(job.steps.findIndex(value => value.run === 'npm run test:postgres-fencing'));
  });

  it('builds the real Swift executable before resolving its path and fails on errors', () => {
    const packageBuild = job.steps.find(value => value.run === 'npm run build:packages');
    expect(packageBuild).toBeDefined();
    expect(packageBuild.if).toBeUndefined();
    expect(packageBuild['continue-on-error']).toBeUndefined();
    expect(job.steps.indexOf(packageBuild)).toBeLessThan(job.steps.indexOf(step));
    expect(step.run).toContain('set -euo pipefail');
    expect(step.run).toContain('swift --version');
    const build = 'swift build --package-path clients/ios/ArcanosKit --product ArcanosDeviceE2E';
    const locate = 'swift build --package-path clients/ios/ArcanosKit --show-bin-path';
    expect(step.run).toContain(build);
    expect(step.run.indexOf(locate)).toBeGreaterThan(step.run.indexOf(build));
    expect(step.run).toContain('IOS_DEVICE_E2E_SWIFT_BINARY="$ios_device_e2e_bin_dir/ArcanosDeviceE2E"');
    expect(step.run).not.toContain('|| true');
  });

  it('retains only the sanitized proof after success without weakening the pipeline exit status', () => {
    const upload = job.steps.find(value => value.uses === 'actions/upload-artifact@v4');
    expect(step.run).toContain('set -euo pipefail');
    expect(step.run).toContain('node scripts/validate-ios-device-gateway-e2e.mjs | tee local_artifacts/ios-device-e2e-proof.json');
    expect(upload.if).toBe('success()');
    expect(upload.with.path).toBe('local_artifacts/ios-device-e2e-proof.json');
    expect(upload.with['if-no-files-found']).toBe('error');
    expect(job.steps.indexOf(upload)).toBeGreaterThan(job.steps.indexOf(step));
  });
});

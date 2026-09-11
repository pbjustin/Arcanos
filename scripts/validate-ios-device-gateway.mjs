import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs the real Express/auth/confirmation composition with synthetic persistence,
// jobs and capability execution. No server startup, production credential or provider.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-device-proof-'));
const reportPath = path.join(directory, 'jest.json');
try {
  const run = spawnSync(process.execPath, [
    'scripts/run-jest.mjs', '--runTestsByPath', 'tests/gpt-access-gateway.test.ts',
    '--testNamePattern=Phase 2 paired-device synthetic Gateway proof', '--coverage=false',
    '--runInBand', '--json', `--outputFile=${reportPath}`,
  ], { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  let report;
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { report = null; }
  const assertions = report?.testResults?.flatMap(result => result.assertionResults ?? [])
    .filter(result => result.fullName.includes('Phase 2 paired-device synthetic Gateway proof')) ?? [];
  const passed = run.status === 0 && report?.success === true && assertions.length >= 10
    && assertions.every(result => result.status === 'passed');
  console.log(JSON.stringify({
    proof: 'ios-device-gateway-v1', passed, executed: true,
    transport: 'loopback HTTP through real Express router',
    synthetic: ['device repository', 'job repository', 'job execution', 'capability execution'],
    assertions: assertions.map(result => ({ name: result.title, passed: result.status === 'passed' })),
    productionCredentialsUsed: false, physicalDeviceValidated: false,
  }, null, 2));
  process.exitCode = passed ? 0 : 1;
} finally {
  // Verify the resolved task-owned target before recursive cleanup on every OS.
  if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir())
    || !path.basename(directory).startsWith('arcanos-device-proof-')) throw new Error('Invalid proof cleanup target');
  rmSync(directory, { recursive: true, force: true });
}

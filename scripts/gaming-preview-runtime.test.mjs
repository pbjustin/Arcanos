import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { containedGamingRuntimeEnvironment, runGamingPreviewRuntime, verifyGamingRuntimeKernelPolicy } from './gaming-preview-runtime.mjs';

const now = Date.parse('2026-10-19T22:00:00.000Z');
const uuid = digit => `${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}`;
const launcher = Buffer.from('trusted static binary');
const kernelEvidence = () => ({ status: 'NoNewPrivs:\t1\nSeccomp:\t2\n', launcher });
const manifest = { expiresAt: new Date(now + 60_000).toISOString(), candidateSha: 'a'.repeat(40),
  previewLane: 'gaming-synthetic-v1', runtimeEgressPolicy: 'linux-seccomp-no-outbound-v1',
  runId: '1234', runtimeEnvironmentName: 'pr-03ac67-1558', targetSha256: 'b'.repeat(64),
  kernelPolicySha256: 'c'.repeat(64), kernelLauncherSha256: createHash('sha256').update(launcher).digest('hex'),
  runtimeTarget: { projectId: uuid('1'), workerServiceId: uuid('3'), webServiceId: uuid('4') } };
const environment = { PATH: '/usr/local/bin:/usr/bin', PORT: '8080', NODE_ENV: 'production',
  ARCANOS_PROCESS_KIND: 'web', RAILWAY_ENVIRONMENT_NAME: 'pr-03ac67-1558',
  RAILWAY_PROJECT_ID: uuid('1'), RAILWAY_ENVIRONMENT_ID: uuid('2'), RAILWAY_SERVICE_ID: uuid('4'),
  RAILWAY_DEPLOYMENT_ID: uuid('5'), OPENAI_API_KEY: 'mock-must-not-pass', NOTION_TOKEN: 'mock-must-not-pass',
  DATABASE_URL: 'mock-must-not-pass', NODE_OPTIONS: '--import=untrusted.mjs', HTTPS_PROXY: 'mock-must-not-pass' };

test('Gaming runtime forwards only credential-empty bounded role environment', () => {
  const result = containedGamingRuntimeEnvironment(manifest, environment, now);
  for (const key of ['OPENAI_API_KEY', 'NOTION_TOKEN', 'DATABASE_URL', 'NODE_OPTIONS', 'HTTPS_PROXY']) {
    assert.equal(Object.hasOwn(result.environment, key), false);
  }
  assert.equal(result.remainingMs, 60_000);
  assert.equal(result.environment.RAILWAY_GIT_COMMIT_SHA, manifest.candidateSha);
});

test('Gaming runtime rejects expired leases, wrong environment, role and target identity', () => {
  for (const other of [{ ...manifest, expiresAt: new Date(now).toISOString() },
    { ...manifest, expiresAt: new Date(now + 7200_001).toISOString() },
    { ...manifest, runtimeEgressPolicy: 'application-mocks-only' }]) {
    assert.throws(() => containedGamingRuntimeEnvironment(other, environment, now), /LEASE_INVALID/u);
  }
  for (const [key, value] of [['RAILWAY_ENVIRONMENT_NAME', 'production'], ['RAILWAY_PROJECT_ID', uuid('6')],
    ['RAILWAY_SERVICE_ID', uuid('3')], ['ARCANOS_PROCESS_KIND', 'operator']]) {
    assert.throws(() => containedGamingRuntimeEnvironment(manifest, { ...environment, [key]: value }, now), /LEASE_INVALID/u);
  }
});

test('Gaming runtime fails closed without kernel seccomp, no-new-privileges and exact launcher bytes', () => {
  assert.doesNotThrow(() => verifyGamingRuntimeKernelPolicy(manifest, kernelEvidence()));
  for (const evidence of [{ ...kernelEvidence(), status: 'NoNewPrivs:\t0\nSeccomp:\t2\n' },
    { ...kernelEvidence(), status: 'NoNewPrivs:\t1\nSeccomp:\t0\n' },
    { ...kernelEvidence(), launcher: Buffer.from('substituted') }]) {
    assert.throws(() => verifyGamingRuntimeKernelPolicy(manifest, evidence), /POLICY_UNVERIFIED/u);
  }
});

test('Gaming runtime verifies kernel boundary before starting any candidate and kills an expired lease', async () => {
  let calls = 0;
  await assert.rejects(runGamingPreviewRuntime({ manifest, environment, now: () => now,
    kernelEvidence: () => ({ ...kernelEvidence(), status: '' }), spawnChild: () => { calls++; } }), /POLICY_UNVERIFIED/u);
  assert.equal(calls, 0);
  const child = new EventEmitter(); const signals = []; child.kill = signal => signals.push(signal);
  const timers = []; const cleared = [];
  const run = runGamingPreviewRuntime({ manifest, environment, now: () => now, kernelEvidence,
    signalTarget: new EventEmitter(), setTimer: (fn, delay) => { const value = { fn, delay }; timers.push(value); return value; },
    clearTimer: timer => cleared.push(timer), spawnChild: (_program, args, options) => {
      calls++; assert.deepEqual(args, ['scripts/start-railway-service-with-integrity.mjs', '--pr-preview-app-safe-v1']);
      assert.equal(options.cwd, '/app'); assert.equal(options.env.OPENAI_API_KEY, undefined); return child;
    } });
  assert.equal(calls, 1); assert.equal(timers[0].delay, 60_000);
  timers[0].fn(); assert.deepEqual(signals, ['SIGTERM']); assert.equal(timers[1].delay, 5000);
  timers[1].fn(); assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  child.emit('exit', null, 'SIGKILL'); assert.equal(await run, 1); assert.equal(cleared.length, 2);
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { containedRuntimeEnvironment, runStackedPreviewRuntime } from './stacked-draft-preview-runtime.mjs';
const now = 100000;
const manifest = { candidateSha: 'a'.repeat(40), expiresAt: new Date(now + 60000).toISOString() };
const environment = { RAILWAY_ENVIRONMENT_NAME: 'pr-1532aa-1535', ARCANOS_PROCESS_KIND: 'web',
  OPENAI_API_KEY: 'secret', DATABASE_URL: 'secret', REDIS_URL: 'secret', GITHUB_TOKEN: 'secret',
  NODE_OPTIONS: '--import=/app/untrusted.mjs', PATH: '/usr/local/bin:/usr/bin', PORT: '8080' };
test('runtime lease strips credentials and injected Node loaders before the maintained sealed launcher', () => {
  const result = containedRuntimeEnvironment(manifest, environment, now);
  assert.equal(result.remainingMs, 60000);
  for (const key of ['OPENAI_API_KEY', 'DATABASE_URL', 'REDIS_URL', 'GITHUB_TOKEN', 'NODE_OPTIONS']) {
    assert.equal(result.environment[key], undefined);
  }
  assert.equal(result.environment.RAILWAY_GIT_COMMIT_SHA, manifest.candidateSha);
});
test('runtime refuses expired, excessive and non-preview leases', () => {
  for (const expiry of [now - 1, now, now + 7200001, NaN]) {
    assert.throws(() => containedRuntimeEnvironment({ ...manifest,
      expiresAt: Number.isNaN(expiry) ? 'invalid' : new Date(expiry).toISOString() }, environment, now), /LEASE_INVALID/u);
  }
  assert.throws(() => containedRuntimeEnvironment(manifest,
    { ...environment, RAILWAY_ENVIRONMENT_NAME: 'production' }, now), /LEASE_INVALID/u);
});
test('lease expiration terminates the child with a bounded forced-stop fallback and removes lifecycle handles', async () => {
  const child = new EventEmitter();
  const signals = [];
  child.kill = signal => { signals.push(signal); };
  const timers = [];
  const removed = [];
  const signalTarget = new EventEmitter();
  const done = runStackedPreviewRuntime({ manifest, environment, now: () => now, signalTarget,
    spawnChild(program, args, options) {
      assert.deepEqual(args, ['scripts/start-railway-service-with-integrity.mjs', '--pr-preview-app-safe-v1']);
      assert.equal(options.env.DATABASE_URL, undefined);
      return child;
    }, setTimer(callback, ms) { const timer = { callback, ms }; timers.push(timer); return timer; },
    clearTimer(timer) { removed.push(timer); } });
  assert.equal(timers[0].ms, 60000);
  timers[0].callback();
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(timers[1].ms, 5000);
  timers[1].callback();
  child.emit('exit', null, 'SIGKILL');
  assert.equal(await done, 1);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(signalTarget.listenerCount('SIGTERM'), 0);
  assert.equal(removed.length, 2);
});

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const ENVIRONMENT_KEYS = ['PATH', 'PORT', 'NODE_ENV', 'ARCANOS_PROCESS_KIND',
  'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_ENVIRONMENT_NAME',
  'RAILWAY_SERVICE_ID', 'RAILWAY_DEPLOYMENT_ID', 'RAILWAY_PUBLIC_DOMAIN'];
export function containedRuntimeEnvironment(manifest, environment, now = Date.now()) {
  const expiry = Date.parse(manifest?.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now || expiry - now > 7200_000
    || !/^[0-9a-f]{40}$/u.test(manifest?.candidateSha ?? '')
    || environment.RAILWAY_ENVIRONMENT_NAME !== 'pr-1532aa-1535'
    || !['web', 'worker'].includes(environment.ARCANOS_PROCESS_KIND)) {
    throw new Error('STACKED_PREVIEW_RUNTIME_LEASE_INVALID');
  }
  const result = Object.fromEntries(ENVIRONMENT_KEYS.filter(key => typeof environment[key] === 'string')
    .map(key => [key, environment[key]]));
  result.NODE_ENV = 'production';
  result.RAILWAY_GIT_COMMIT_SHA = manifest.candidateSha;
  return { environment: result, remainingMs: expiry - now };
}

export async function runStackedPreviewRuntime({ manifest, environment = process.env,
  spawnChild = spawn, now = Date.now, signalTarget = process,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const lease = containedRuntimeEnvironment(manifest, environment, now());
  const child = spawnChild(process.execPath,
    ['scripts/start-railway-service-with-integrity.mjs', '--pr-preview-app-safe-v1'],
    { cwd: '/app', env: lease.environment, stdio: 'inherit' });
  let forcedStop;
  const stop = signal => {
    child.kill(signal);
    forcedStop ??= setTimer(() => child.kill('SIGKILL'), 5000);
  };
  const expired = setTimer(() => stop('SIGTERM'), lease.remainingMs);
  const terminate = () => stop('SIGTERM');
  const interrupt = () => stop('SIGINT');
  signalTarget.on('SIGTERM', terminate);
  signalTarget.on('SIGINT', interrupt);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('STACKED_PREVIEW_RUNTIME_CHILD_FAILED')));
      child.once('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    });
  } finally {
    clearTimer(expired);
    if (forcedStop) clearTimer(forcedStop);
    signalTarget.removeListener('SIGTERM', terminate);
    signalTarget.removeListener('SIGINT', interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const manifest = JSON.parse(readFileSync('/opt/stacked-preview/compiled.json', 'utf8'));
    process.exitCode = await runStackedPreviewRuntime({ manifest });
  } catch { console.error('STACKED_PREVIEW_RUNTIME_BLOCKED'); process.exitCode = 1; }
}

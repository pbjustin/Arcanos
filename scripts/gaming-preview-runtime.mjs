#!/usr/bin/env node
// Runs only after the root-owned kernel egress launcher has installed seccomp.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const ENVIRONMENT_KEYS = ['PATH', 'PORT', 'NODE_ENV', 'ARCANOS_PROCESS_KIND',
  'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_ENVIRONMENT_NAME',
  'RAILWAY_SERVICE_ID', 'RAILWAY_DEPLOYMENT_ID', 'RAILWAY_PUBLIC_DOMAIN'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;

export function containedGamingRuntimeEnvironment(manifest, environment, now = Date.now()) {
  const expiry = Date.parse(manifest?.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now || expiry - now > 7200_000
    || manifest?.previewLane !== 'gaming-synthetic-v1'
    || manifest?.runtimeEgressPolicy !== 'linux-seccomp-no-outbound-v1'
    || !/^[0-9a-f]{40}$/u.test(manifest?.candidateSha ?? '')
    || !HASH.test(manifest?.targetSha256 ?? '') || !HASH.test(manifest?.kernelPolicySha256 ?? '')
    || !HASH.test(manifest?.kernelLauncherSha256 ?? '')
    || !/^[1-9][0-9]{0,19}$/u.test(manifest?.runId ?? '')
    || manifest.runtimeEnvironmentName !== `pr-${createHash('sha256').update(manifest.runId).digest('hex').slice(0, 6)}-1558`
    || environment.RAILWAY_ENVIRONMENT_NAME !== manifest.runtimeEnvironmentName
    || !['web', 'worker'].includes(environment.ARCANOS_PROCESS_KIND)
    || environment.RAILWAY_PROJECT_ID !== manifest.runtimeTarget?.projectId
    || environment.RAILWAY_SERVICE_ID !== manifest.runtimeTarget?.[`${environment.ARCANOS_PROCESS_KIND}ServiceId`]
    || !['RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID', 'RAILWAY_DEPLOYMENT_ID']
      .every(key => UUID.test(environment[key] ?? ''))) {
    throw new Error('GAMING_PREVIEW_RUNTIME_LEASE_INVALID');
  }
  const result = Object.fromEntries(ENVIRONMENT_KEYS.filter(key => typeof environment[key] === 'string')
    .map(key => [key, environment[key]]));
  result.NODE_ENV = 'production';
  result.RAILWAY_GIT_COMMIT_SHA = manifest.candidateSha;
  return { environment: result, remainingMs: expiry - now };
}

export function verifyGamingRuntimeKernelPolicy(manifest, { status, launcher }) {
  if (typeof status !== 'string' || !/^NoNewPrivs:\s+1$/mu.test(status)
    || !/^Seccomp:\s+2$/mu.test(status)
    || createHash('sha256').update(launcher).digest('hex') !== manifest.kernelLauncherSha256) {
    throw new Error('GAMING_PREVIEW_RUNTIME_KERNEL_POLICY_UNVERIFIED');
  }
}

export async function runGamingPreviewRuntime({ manifest, environment = process.env,
  spawnChild = spawn, now = Date.now, signalTarget = process,
  setTimer = setTimeout, clearTimer = clearTimeout,
  kernelEvidence = () => ({ status: readFileSync('/proc/self/status', 'utf8'),
    launcher: readFileSync('/opt/gaming-preview/network-deny') }) } = {}) {
  const lease = containedGamingRuntimeEnvironment(manifest, environment, now());
  verifyGamingRuntimeKernelPolicy(manifest, kernelEvidence());
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
      child.once('error', () => reject(new Error('GAMING_PREVIEW_RUNTIME_CHILD_FAILED')));
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
    const manifest = JSON.parse(readFileSync('/opt/gaming-preview/compiled.json', 'utf8'));
    process.exitCode = await runGamingPreviewRuntime({ manifest });
  } catch { console.error('GAMING_PREVIEW_RUNTIME_BLOCKED'); process.exitCode = 1; }
}

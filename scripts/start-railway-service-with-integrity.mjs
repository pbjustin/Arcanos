#!/usr/bin/env node

import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'];

export const PROTECTED_DIGEST_GATE_ARGUMENTS = Object.freeze([
  '--import',
  './scripts/register-esm-loader.mjs',
  'dist/core/commands/protectedDigest.js',
  '--precutover'
]);

export function waitForStartupChild(childProcess) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      childProcess.removeListener('error', handleError);
      childProcess.removeListener('exit', handleExit);
      callback(value);
    };
    const handleError = error => finish(reject, error);
    const handleExit = (code, signal) => finish(
      resolve,
      signal ? 1 : typeof code === 'number' ? code : 1
    );

    childProcess.once('error', handleError);
    childProcess.once('exit', handleExit);
    if (
      typeof childProcess.exitCode === 'number'
      || typeof childProcess.signalCode === 'string'
    ) {
      handleExit(childProcess.exitCode, childProcess.signalCode);
    }
  });
}

export async function runRailwayServiceWithIntegrity(options = {}) {
  const spawnChild = options.spawnChild ?? ((args) => spawn(
    process.execPath,
    args,
    {
      cwd: REPOSITORY_ROOT,
      env: process.env,
      stdio: 'inherit'
    }
  ));
  const signalTarget = options.signalTarget ?? process;
  let activeChild = null;
  let shutdownRequested = false;
  const forwardSignal = signal => {
    shutdownRequested = true;
    activeChild?.kill(signal);
  };
  const signalHandlers = new Map(
    SHUTDOWN_SIGNALS.map(signal => [signal, () => forwardSignal(signal)])
  );
  for (const [signal, handler] of signalHandlers) {
    signalTarget.on(signal, handler);
  }

  try {
    activeChild = spawnChild([...PROTECTED_DIGEST_GATE_ARGUMENTS]);
    const gateExitCode = await waitForStartupChild(activeChild);
    if (shutdownRequested) {
      console.error('[railway-integrity-gate] startup interrupted');
      return 1;
    }
    if (gateExitCode !== 0) {
      console.error('[railway-integrity-gate] protected digest comparison failed');
      return 1;
    }

    activeChild = spawnChild([
      'scripts/start-railway-service.mjs',
      ...(options.argv ?? process.argv.slice(2))
    ]);
    return await waitForStartupChild(activeChild);
  } catch {
    console.error('[railway-integrity-gate] startup child failed');
    return 1;
  } finally {
    activeChild = null;
    for (const [signal, handler] of signalHandlers) {
      signalTarget.removeListener(signal, handler);
    }
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await runRailwayServiceWithIntegrity();
}

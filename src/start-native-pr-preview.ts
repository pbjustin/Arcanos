import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';

import type { NativePrPreviewIdentity } from './nativePrPreviewContract.js';

const CHILD_ENVIRONMENT_NAMES = new Set([
  'ARCANOS_NATIVE_PR_APPLICATION_PREVIEW',
  'ARCANOS_PREVIEW_PR_NUMBER',
  'ARCANOS_PREVIEW_SOURCE_COMMIT',
  'ARCANOS_PROCESS_KIND',
  'HOST',
  'NODE_ENV',
  'PORT',
  'RUN_WORKERS',
  'TZ',
]);
const WINDOWS_RUNTIME_ENVIRONMENT_NAMES = new Set([
  'HOMEDRIVE',
  'HOMEPATH',
  'LOGONSERVER',
  'PATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
]);
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

function requireExactEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  expected: string
): void {
  if (env[name] !== expected) {
    throw new Error('PREVIEW_APPLICATION_ENVIRONMENT_INVALID');
  }
}

export function resolveNativePrPreviewChildEnvironment(
  env: NodeJS.ProcessEnv
): NativePrPreviewIdentity & { host: string; port: number } {
  if (
    Object.keys(env).some((environmentName) =>
      !CHILD_ENVIRONMENT_NAMES.has(environmentName)
      && (
        process.platform !== 'win32'
        || !WINDOWS_RUNTIME_ENVIRONMENT_NAMES.has(environmentName)
      )
    )
  ) {
    throw new Error('PREVIEW_APPLICATION_ENVIRONMENT_INVALID');
  }

  requireExactEnvironmentValue(
    env,
    'ARCANOS_NATIVE_PR_APPLICATION_PREVIEW',
    'v1'
  );
  requireExactEnvironmentValue(env, 'ARCANOS_PROCESS_KIND', 'web');
  requireExactEnvironmentValue(env, 'HOST', '0.0.0.0');
  requireExactEnvironmentValue(env, 'NODE_ENV', 'production');
  requireExactEnvironmentValue(env, 'RUN_WORKERS', 'false');
  requireExactEnvironmentValue(env, 'TZ', 'UTC');

  const rawPrNumber = env.ARCANOS_PREVIEW_PR_NUMBER ?? '';
  const prNumber = Number.parseInt(rawPrNumber, 10);
  const sourceCommit = env.ARCANOS_PREVIEW_SOURCE_COMMIT ?? '';
  const rawPort = env.PORT ?? '';
  const port = Number.parseInt(rawPort, 10);
  if (
    !Number.isSafeInteger(prNumber)
    || prNumber < 1
    || String(prNumber) !== rawPrNumber
    || !COMMIT_PATTERN.test(sourceCommit)
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
    || String(port) !== rawPort
  ) {
    throw new Error('PREVIEW_APPLICATION_ENVIRONMENT_INVALID');
  }

  return {
    host: '0.0.0.0',
    port,
    prNumber,
    sourceCommit,
  };
}

async function listen(server: Server, port: number, host: string):
Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleError = () => {
      server.off('listening', handleListening);
      reject(new Error('PREVIEW_APPLICATION_LISTENER_FAILED'));
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolve();
    };
    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(port, host);
  });
}

async function main(): Promise<void> {
  const identity = resolveNativePrPreviewChildEnvironment(process.env);
  const {
    createNativePrPreviewApplication,
    createNativePrPreviewReadinessState,
  } = await import('./nativePrPreviewApplication.js');
  const readinessState = createNativePrPreviewReadinessState();
  const application = createNativePrPreviewApplication({
    identity,
    readinessState,
  });
  readinessState.applicationImported = true;
  readinessState.fixturesSealed = true;

  const server = createServer(application);
  await listen(server, identity.port, identity.host);
  readinessState.ready = true;

  console.log('[native-pr-preview] ready', JSON.stringify({
    mode: 'native-pr-application-e2e-v1',
    prNumber: identity.prNumber,
    protectedEffectsEnabled: false,
    sourceCommit: identity.sourceCommit,
  }));

  await new Promise<void>((resolve, reject) => {
    let shutdownStarted = false;
    const cleanup = () => {
      process.off('SIGINT', handleSignal);
      process.off('SIGTERM', handleSignal);
      server.off('error', handleError);
    };
    const handleError = () => {
      cleanup();
      reject(new Error('PREVIEW_APPLICATION_LISTENER_FAILED'));
    };
    const handleSignal = () => {
      if (shutdownStarted) {
        return;
      }
      shutdownStarted = true;
      readinessState.draining = true;
      readinessState.ready = false;
      server.close(() => {
        cleanup();
        resolve();
      });
    };

    server.once('error', handleError);
    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);
  });
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    const failureCode =
      error instanceof Error
      && error.message.startsWith('PREVIEW_APPLICATION_')
        ? error.message
        : 'PREVIEW_APPLICATION_START_FAILED';
    console.error(`[native-pr-preview] fatal ${failureCode}`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
/**
 * Railway-aware process launcher.
 *
 * Service-name inference was removed because coupling runtime role selection to
 * Railway service naming allowed misnamed or missing worker services to accept
 * async jobs without ever consuming them.
 *
 * `ARCANOS_PROCESS_KIND` is now the explicit runtime contract:
 * - `ARCANOS_PROCESS_KIND=web` starts the API server.
 * - `ARCANOS_PROCESS_KIND=worker` starts the async worker runtime.
 *
 * Configure Railway services explicitly:
 * - Web service: `ARCANOS_PROCESS_KIND=web`
 * - Worker service: `ARCANOS_PROCESS_KIND=worker`
 *
 * Inputs/outputs:
 * - Input: Railway environment variables (`ARCANOS_PROCESS_KIND`, `PORT`).
 * - Output: Spawns either web server runtime or worker runtime, exits with the
 *   spawned process exit code.
 *
 * Edge cases:
 * - Missing or invalid `ARCANOS_PROCESS_KIND` is a hard startup failure.
 * - If `PORT` is missing in worker mode, falls back to `8080`; invalid ports fail fast.
 * - If worker process exits, health server is shut down and this launcher exits.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const PROCESS_KIND_ENV = 'ARCANOS_PROCESS_KIND';
const VALID_PROCESS_KINDS = new Set(['web', 'worker']);
const LIVENESS_PATHS = new Set(['/health', '/healthz']);
const READINESS_PATH = '/readyz';
const HEALTH_OK_BODY = 'ok';
const HEALTH_NOT_FOUND_BODY = 'not found';
const DEFAULT_HEALTH_PORT = 8080;
const DEFAULT_HEALTH_HOST = '0.0.0.0';
const SHUTDOWN_SIGNALS = new Set(['SIGTERM', 'SIGINT']);
const WORKER_BOOTSTRAP_READY_MARKER = 'worker.bootstrap.completed';

/**
 * Resolve the explicit runtime process kind from environment.
 *
 * Inputs/outputs:
 * - Input: `ARCANOS_PROCESS_KIND` from environment.
 * - Output: normalized process kind (`web` or `worker`).
 *
 * Edge case behavior:
 * - Missing or invalid values throw to prevent ambiguous service boot.
 */
export function resolveProcessKindOrThrow() {
  const rawProcessKind = process.env[PROCESS_KIND_ENV];
  const normalizedProcessKind = String(rawProcessKind ?? '').trim().toLowerCase();

  if (normalizedProcessKind.length === 0) {
    console.warn(
      `[ARCANOS] Missing ${PROCESS_KIND_ENV}. Set ${PROCESS_KIND_ENV}=web on the web service and ${PROCESS_KIND_ENV}=worker on the worker service.`
    );
    throw new Error(`${PROCESS_KIND_ENV} is required and must be "web" or "worker".`);
  }

  if (!VALID_PROCESS_KINDS.has(normalizedProcessKind)) {
    throw new Error(
      `${PROCESS_KIND_ENV} must be "web" or "worker", received "${String(rawProcessKind)}".`
    );
  }

  return normalizedProcessKind;
}

/**
 * Emit a stable startup log for operator visibility.
 *
 * Inputs/outputs:
 * - Input: resolved process kind.
 * - Output: writes a startup log line to stdout.
 *
 * Edge case behavior:
 * - Missing service name is omitted from the log line.
 */
function logStartup(processKind) {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const railwayServiceName = process.env.RAILWAY_SERVICE_NAME?.trim();
  const serviceSegment = railwayServiceName ? `, service: ${railwayServiceName}` : '';

  console.log(`[ARCANOS] Starting process: ${processKind} (env: ${nodeEnv}${serviceSegment})`);
}

/**
 * Resolve the health server listener for worker mode.
 *
 * Inputs/outputs:
 * - Input: `PORT` and `HOST` from environment.
 * - Output: validated TCP port and host.
 *
 * Edge case behavior:
 * - Missing PORT falls back to `DEFAULT_HEALTH_PORT`; invalid PORT throws.
 */
export function resolveHealthListenerConfig(env = process.env) {
  const rawPort = env.PORT?.trim();
  const port = rawPort ? Number.parseInt(rawPort, 10) : DEFAULT_HEALTH_PORT;

  //audit Assumption: Railway injects a valid PORT for service health checks; risk: malformed PORT binds an unexpected port and masks deployment drift; invariant: health server binds one validated address; handling: use a reviewed fallback only when PORT is absent, otherwise fail fast.
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== String(rawPort ?? DEFAULT_HEALTH_PORT)) {
    throw new Error(`PORT must be an integer between 1 and 65535, received "${String(env.PORT ?? '')}".`);
  }

  const host = env.HOST?.trim() || DEFAULT_HEALTH_HOST;
  if (host.length === 0) {
    throw new Error('HOST must be a non-empty string when provided.');
  }

  return { port, host };
}

/**
 * Spawn a child process inheriting stdio.
 *
 * Inputs/outputs:
 * - Input: command and argument list.
 * - Output: spawned `ChildProcess`.
 *
 * Edge case behavior:
 * - `error` event is handled by caller to prevent silent startup failures.
 */
function buildChildEnvironment(processKind) {
  return {
    ...process.env,
    RUN_WORKERS: processKind === 'worker' ? 'true' : 'false',
    [PROCESS_KIND_ENV]: processKind
  };
}

function spawnProcess(command, args, processKind, options = {}) {
  return spawn(command, args, {
    stdio: options.stdio ?? 'inherit',
    env: buildChildEnvironment(processKind)
  });
}

/**
 * Wait for child process termination and return an exit code.
 *
 * Inputs/outputs:
 * - Input: spawned child process.
 * - Output: process exit code integer.
 *
 * Edge case behavior:
 * - Expected shutdown signals can be mapped to success.
 * - Unexpected signal terminations return `1` as conservative failure code.
 */
function waitForExit(childProcess, options = {}) {
  const isExpectedShutdownSignal = options.isExpectedShutdownSignal ?? (() => false);

  return new Promise((resolve, reject) => {
    childProcess.once('error', reject);
    childProcess.once('exit', (code, signal) => {
      if (signal) {
        if (isExpectedShutdownSignal(signal)) {
          resolve(0);
          return;
        }

        //audit Assumption: unexpected signal-terminated child should propagate as failure for Railway restart policy; risk: reporting success on crash loops; invariant: numeric non-zero code on abnormal termination; handling: map unexpected signaled exit to code 1.
        resolve(1);
        return;
      }

      resolve(typeof code === 'number' ? code : 1);
    });
  });
}

async function repairDistAliases(processKind) {
  const repairProcess = spawnProcess('node', ['scripts/repair-dist-aliases.js', '--rewrite'], processKind);
  const exitCode = await waitForExit(repairProcess);
  if (exitCode !== 0) {
    throw new Error(`dist alias repair failed with exit code ${exitCode}`);
  }
}

/**
 * Start the web API runtime.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: exits current process with child runtime exit code.
 *
 * Edge case behavior:
 * - Child startup errors surface and terminate launcher with failure.
 */
async function runWebRuntime() {
  console.log(`[railway-launcher] starting web runtime ${PROCESS_KIND_ENV}=web RUN_WORKERS=false`);
  console.log('[worker-runtime] enabled/disabled reason', JSON.stringify({
    module: 'railway-launcher',
    enabled: false,
    disabledReason: 'ARCANOS_PROCESS_KIND=web disables in-process workers; dedicated async workers must run in a separate worker service.'
  }));
  const webProcess = spawnProcess('node', [
    '--max-old-space-size=7168',
    '--import',
    './scripts/register-esm-loader.mjs',
    'dist/start-server.js',
  ], 'web');
  let shutdownRequested = false;
  const shutdownWeb = (signal) => {
    if (shutdownRequested) {
      return;
    }

    shutdownRequested = true;
    console.log(`[railway-launcher] received ${signal}; forwarding shutdown to web runtime`);
    webProcess.kill(signal);
  };

  process.once('SIGTERM', () => shutdownWeb('SIGTERM'));
  process.once('SIGINT', () => shutdownWeb('SIGINT'));

  const exitCode = await waitForExit(webProcess, {
    isExpectedShutdownSignal: (signal) => shutdownRequested && SHUTDOWN_SIGNALS.has(signal)
  });
  process.exit(exitCode);
}

export function createWorkerReadinessState(env = process.env) {
  const providerConfigured = Boolean(env.OPENAI_API_KEY?.trim());

  return {
    child: 'starting',
    bootstrap: 'unknown',
    database: 'unknown',
    provider: providerConfigured ? 'configured' : 'missing',
    ready: false,
    reason: providerConfigured ? 'worker_bootstrap_pending' : 'openai_api_key_missing'
  };
}

export function recordWorkerOutput(readinessState, chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  if (!text.includes(WORKER_BOOTSTRAP_READY_MARKER)) {
    return readinessState;
  }

  readinessState.child = 'running';
  readinessState.bootstrap = 'ready';
  readinessState.database = 'ready';
  readinessState.ready = readinessState.provider === 'configured';
  readinessState.reason = readinessState.ready ? null : 'openai_api_key_missing';
  return readinessState;
}

export function recordWorkerExit(readinessState, exitCode, signal) {
  readinessState.child = 'exited';
  readinessState.ready = false;
  readinessState.reason = signal
    ? `worker_exited_signal_${signal}`
    : `worker_exited_code_${typeof exitCode === 'number' ? exitCode : 'unknown'}`;
  return readinessState;
}

export function buildWorkerReadinessResponse(readinessState) {
  const statusCode = readinessState.ready ? 200 : 503;
  return {
    statusCode,
    body: {
      ready: readinessState.ready,
      status: readinessState.ready ? 'ready' : 'not_ready',
      child: readinessState.child,
      checks: {
        bootstrap: readinessState.bootstrap,
        database: readinessState.database,
        provider: readinessState.provider
      },
      reason: readinessState.reason,
      timestamp: new Date().toISOString()
    }
  };
}

function mirrorAndObserveWorkerOutput(stream, destination, readinessState) {
  stream?.on('data', chunk => {
    recordWorkerOutput(readinessState, chunk);
    destination.write(chunk);
  });
}

/**
 * Start worker runtime with an in-process health endpoint for Railway checks.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: exits current process when worker exits or fails.
 *
 * Edge case behavior:
 * - Unknown request paths return 404.
 * - Shutdown signals are forwarded to worker for graceful termination.
 */
async function runWorkerRuntimeWithHealthServer() {
  console.log(`[railway-launcher] starting worker runtime ${PROCESS_KIND_ENV}=worker RUN_WORKERS=true`);
  console.log('[worker-runtime] start requested', JSON.stringify({
    module: 'railway-launcher',
    enabled: true,
    disabledReason: null,
    entrypoint: 'dist/workers/jobRunner.js'
  }));
  await repairDistAliases('worker');
  const readinessState = createWorkerReadinessState();
  const workerProcess = spawnProcess('node', [
    '--import',
    './scripts/register-esm-loader.mjs',
    'dist/workers/jobRunner.js'
  ], 'worker', {
    stdio: ['inherit', 'pipe', 'pipe']
  });
  const healthListenerConfig = resolveHealthListenerConfig();
  let shutdownRequested = false;

  mirrorAndObserveWorkerOutput(workerProcess.stdout, process.stdout, readinessState);
  mirrorAndObserveWorkerOutput(workerProcess.stderr, process.stderr, readinessState);
  workerProcess.once('exit', (code, signal) => {
    recordWorkerExit(readinessState, code, signal);
  });

  const healthServer = createServer((request, response) => {
    const requestPath = request.url ?? '';

    //audit Assumption: Railway probes the liveness path for process supervision; risk: strict dependency readiness causes restarts during worker bootstrap; invariant: /health and /healthz only prove the launcher is alive; handling: keep liveness independent from readiness.
    if (LIVENESS_PATHS.has(requestPath)) {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end(HEALTH_OK_BODY);
      return;
    }

    if (requestPath === READINESS_PATH) {
      const readiness = buildWorkerReadinessResponse(readinessState);
      response.statusCode = readiness.statusCode;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(readiness.body));
      return;
    }

    response.statusCode = 404;
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end(HEALTH_NOT_FOUND_BODY);
  });

  const shutdownWorker = (signal) => {
    if (shutdownRequested) {
      return;
    }

    shutdownRequested = true;
    console.log(`[railway-launcher] received ${signal}; forwarding shutdown to worker runtime`);
    //audit Assumption: forwarding platform signals avoids orphan worker process; risk: stuck shutdown/redeploy hangs; invariant: worker receives termination signal before launcher exits; handling: forward SIGTERM/SIGINT directly.
    workerProcess.kill(signal);
  };

  process.once('SIGTERM', () => shutdownWorker('SIGTERM'));
  process.once('SIGINT', () => shutdownWorker('SIGINT'));

  await new Promise((resolve, reject) => {
    healthServer.once('error', reject);
    healthServer.listen(healthListenerConfig.port, healthListenerConfig.host, resolve);
  });

  const exitCode = await waitForExit(workerProcess, {
    isExpectedShutdownSignal: (signal) => shutdownRequested && SHUTDOWN_SIGNALS.has(signal)
  });

  await new Promise((resolve) => {
    healthServer.close(() => resolve());
  });

  process.exit(exitCode);
}

/**
 * Entrypoint that selects web or worker runtime.
 *
 * Inputs/outputs:
 * - Input: Railway service name.
 * - Output: starts selected runtime and terminates with its exit code.
 *
 * Edge case behavior:
 * - Any startup error is logged and exits with code `1`.
 */
async function main() {
  try {
    const processKind = resolveProcessKindOrThrow();
    logStartup(processKind);

    //audit Assumption: runtime role must be selected from an explicit env contract, not infrastructure naming; risk: wrong process type launched; invariant: only validated `web`/`worker` values are accepted; handling: strict env validation before branch selection.
    if (processKind === 'worker') {
      await runWorkerRuntimeWithHealthServer();
      return;
    }

    await runWebRuntime();
  } catch (error) {
    //audit Assumption: launcher failures must be visible for incident triage; risk: silent boot failure with endless restart loops; invariant: fatal errors are logged and non-zero exit code returned; handling: structured stderr logging + exit(1).
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[railway-launcher] fatal startup error: ${message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

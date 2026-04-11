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
 * - If `PORT` is missing/invalid in worker mode, falls back to `8080`.
 * - If worker process exits, health server is shut down and this launcher exits.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import process from 'node:process';

const PROCESS_KIND_ENV = 'ARCANOS_PROCESS_KIND';
const VALID_PROCESS_KINDS = new Set(['web', 'worker']);
const HEALTH_PATHS = new Set(['/health', '/healthz', '/readyz']);
const HEALTH_OK_BODY = 'ok';
const HEALTH_NOT_FOUND_BODY = 'not found';
const DEFAULT_HEALTH_PORT = 8080;

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
function resolveProcessKindOrThrow() {
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
 * Resolve the health server port for worker mode.
 *
 * Inputs/outputs:
 * - Input: `PORT` from environment.
 * - Output: numeric TCP port.
 *
 * Edge case behavior:
 * - Invalid values fall back to `DEFAULT_HEALTH_PORT`.
 */
function resolveHealthPort() {
  const rawPort = process.env.PORT;
  const parsedPort = Number.parseInt(String(rawPort ?? ''), 10);

  //audit Assumption: Railway injects a valid PORT for service health checks; risk: malformed or missing PORT causes bind failures; invariant: health server binds a positive integer port; handling: fallback to DEFAULT_HEALTH_PORT.
  if (!Number.isFinite(parsedPort) || parsedPort <= 0) {
    return DEFAULT_HEALTH_PORT;
  }

  return parsedPort;
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

function spawnProcess(command, args, processKind) {
  return spawn(command, args, {
    stdio: 'inherit',
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
 * - Signal terminations return `1` as conservative failure code.
 */
function waitForExit(childProcess) {
  return new Promise((resolve, reject) => {
    childProcess.once('error', reject);
    childProcess.once('exit', (code, signal) => {
      //audit Assumption: signal-terminated child should propagate as failure for Railway restart policy; risk: reporting success on crash loops; invariant: numeric non-zero code on abnormal termination; handling: map signaled exit to code 1.
      if (signal) {
        resolve(1);
        return;
      }

      resolve(typeof code === 'number' ? code : 1);
    });
  });
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
  const webProcess = spawnProcess('node', [
    '--max-old-space-size=7168',
    '--import',
    './scripts/register-esm-loader.mjs',
    'dist/start-server.js',
  ], 'web');
  const exitCode = await waitForExit(webProcess);
  process.exit(exitCode);
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
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log(`[railway-launcher] starting worker runtime ${PROCESS_KIND_ENV}=worker RUN_WORKERS=true`);
  const workerProcess = spawnProcess(npmCommand, ['run', 'start:worker'], 'worker');
  const healthPort = resolveHealthPort();

  const healthServer = createServer((request, response) => {
    const requestPath = request.url ?? '';

    //audit Assumption: Railway probes configured liveness paths only; risk: non-health paths masking app state; invariant: health paths return 200, all others return 404; handling: explicit route allowlist.
    if (HEALTH_PATHS.has(requestPath)) {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end(HEALTH_OK_BODY);
      return;
    }

    response.statusCode = 404;
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end(HEALTH_NOT_FOUND_BODY);
  });

  const shutdownWorker = (signal) => {
    //audit Assumption: forwarding platform signals avoids orphan worker process; risk: stuck shutdown/redeploy hangs; invariant: worker receives termination signal before launcher exits; handling: forward SIGTERM/SIGINT directly.
    workerProcess.kill(signal);
  };

  process.once('SIGTERM', () => shutdownWorker('SIGTERM'));
  process.once('SIGINT', () => shutdownWorker('SIGINT'));

  await new Promise((resolve, reject) => {
    healthServer.once('error', reject);
    healthServer.listen(healthPort, '0.0.0.0', resolve);
  });

  const exitCode = await waitForExit(workerProcess);

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

await main();

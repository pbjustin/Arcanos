import 'dotenv/config';

import type { Server } from 'node:http';
import { app } from './app.js';
import { performStartup } from './core/startup.js';
import { startSelfHealingLoop } from '@services/selfImprove/selfHealingLoop.js';
import { primeSelfHealTelemetryPersistence } from '@services/selfImprove/selfHealTelemetry.js';
import { close as closeDatabase } from '@core/db/index.js';

const DEFAULT_PORT = 3000;
const DEFAULT_LOCAL_HOST = '127.0.0.1';
const DEFAULT_RAILWAY_HOST = '0.0.0.0';
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

let httpServer: Server | null = null;
let shutdownStarted = false;

interface StartupDeploymentSummary {
  serviceName: string;
  deploymentId: string;
  gitCommit: string;
  gitBranch: string;
}

interface ListenerConfig {
  port: number;
  host: string;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveDefaultHost(): string {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  const railwayEnvironment = process.env.RAILWAY_ENVIRONMENT?.trim();
  const railwayProjectId = process.env.RAILWAY_PROJECT_ID?.trim();

  return nodeEnv === 'production' || Boolean(railwayEnvironment) || Boolean(railwayProjectId)
    ? DEFAULT_RAILWAY_HOST
    : DEFAULT_LOCAL_HOST;
}

/**
 * Resolve and validate the single listener address used by the web process.
 *
 * Purpose:
 * - Keep Railway/prod binding deterministic and fail fast on malformed ports.
 *
 * Inputs/outputs:
 * - Input: PORT and HOST from the environment.
 * - Output: validated TCP port and concrete host.
 *
 * Edge case behavior:
 * - Missing PORT uses the historical local default.
 * - Invalid PORT throws before startup side effects continue.
 */
function resolveListenerConfig(): ListenerConfig {
  const rawPort = process.env.PORT?.trim();
  const port = rawPort ? Number.parseInt(rawPort, 10) : DEFAULT_PORT;

  if (!Number.isInteger(port) || port < 1 || port > 65_535 || String(port) !== String(rawPort ?? DEFAULT_PORT)) {
    throw new Error(`PORT must be an integer between 1 and 65535, received "${String(process.env.PORT ?? '')}".`);
  }

  const host = process.env.HOST?.trim() || resolveDefaultHost();
  if (host.length === 0) {
    throw new Error('HOST must be a non-empty string when provided.');
  }

  return { port, host };
}

function resolveShutdownTimeoutMs(): number {
  return parsePositiveInteger(process.env.ARCANOS_SHUTDOWN_TIMEOUT_MS, DEFAULT_SHUTDOWN_TIMEOUT_MS);
}

/**
 * Resolve deployment metadata for startup logging.
 *
 * Purpose:
 * - Emit enough Railway context to confirm which artifact is serving traffic.
 *
 * Inputs/outputs:
 * - Input: Railway and git-related environment variables.
 * - Output: normalized deployment summary strings for startup logs.
 *
 * Edge case behavior:
 * - Missing metadata degrades to `unknown` so startup logging still succeeds.
 */
function resolveStartupDeploymentSummary(): StartupDeploymentSummary {
  const serviceName = process.env.RAILWAY_SERVICE_NAME?.trim();
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID?.trim();
  const gitCommit = process.env.RAILWAY_GIT_COMMIT_SHA?.trim();
  const gitBranch = process.env.RAILWAY_GIT_BRANCH?.trim();

  //audit Assumption: Railway deployment metadata may be absent in local development or manual runtime contexts; failure risk: startup logs throw or hide service identity; expected invariant: startup logging always emits a stable summary; handling strategy: normalize missing metadata to `unknown`.
  return {
    serviceName: serviceName || 'unknown',
    deploymentId: deploymentId || 'unknown',
    gitCommit: gitCommit || 'unknown',
    gitBranch: gitBranch || 'unknown'
  };
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function closeResources(): Promise<void> {
  await closeDatabase();
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) {
    return;
  }

  shutdownStarted = true;
  const shutdownTimeoutMs = resolveShutdownTimeoutMs();
  console.log(`[SHUTDOWN] Received ${signal}; closing HTTP server and resources.`);

  const timeoutHandle = setTimeout(() => {
    console.error(`[SHUTDOWN] Timed out after ${shutdownTimeoutMs}ms; forcing process exit.`);
    httpServer?.closeAllConnections?.();
    process.exit(1);
  }, shutdownTimeoutMs);
  timeoutHandle.unref?.();

  try {
    if (httpServer) {
      httpServer.closeIdleConnections?.();
      await closeHttpServer(httpServer);
    }

    await closeResources();
    clearTimeout(timeoutHandle);
    console.log('[SHUTDOWN] Completed graceful shutdown.');
    process.exit(0);
  } catch (error) {
    clearTimeout(timeoutHandle);
    console.error('[SHUTDOWN] Graceful shutdown failed:', error);
    process.exit(1);
  }
}

/**
 * Starts the ARCANOS HTTP server after startup preflight.
 *
 * Purpose: Ensure startup initialization (including DB init) runs before serving traffic.
 * Inputs/Outputs: Uses process environment; starts Express listener on configured port.
 * Edge cases: Throws if startup preflight fails unexpectedly.
 */
async function startServer(): Promise<void> {
  const listenerConfig = resolveListenerConfig();
  await performStartup();
  await primeSelfHealTelemetryPersistence();

  httpServer = app.listen(listenerConfig.port, listenerConfig.host, () => {
    const selfHealLoopStatus = startSelfHealingLoop();
    const startupDeploymentSummary = resolveStartupDeploymentSummary();
    console.log(
      `ARCANOS running on ${listenerConfig.host}:${listenerConfig.port} | service=${startupDeploymentSummary.serviceName} | deployment=${startupDeploymentSummary.deploymentId} | git=${startupDeploymentSummary.gitCommit} | branch=${startupDeploymentSummary.gitBranch} | workerHelperRoutes=enabled | askWorkerTools=enabled | selfHealLoop=${selfHealLoopStatus.loopRunning ? 'enabled' : 'disabled'} | selfHealIntervalMs=${selfHealLoopStatus.intervalMs}`
    );
  });

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

startServer().catch((error) => {
  //audit assumption: startup failures should fail fast; risk: serving partially initialized state; invariant: process exits on unrecoverable startup error; handling: log and terminate.
  console.error('[STARTUP] Fatal startup failure:', error);
  process.exit(1);
});

import 'dotenv/config';

import type { Server } from 'node:http';
import type { Express } from 'express';
import {
  initializeRuntimeDependencies,
  performStartupPreflight,
} from './core/startup.js';
import { startSelfHealingLoop } from '@services/selfImprove/selfHealingLoop.js';
import {
  primeSelfHealTelemetryPersistence,
  stopSelfHealTelemetryPersistence,
} from '@services/selfImprove/selfHealTelemetry.js';
import { close as closeDatabase } from '@core/db/index.js';
import {
  getRedisLifecycleSnapshot,
  startRedisLifecycle,
  stopRedisLifecycle,
  subscribeRedisLifecycle,
  type RedisLifecycleSnapshot,
} from '@platform/runtime/redisLifecycle.js';
import {
  getStartupLifecycleSnapshot,
  markStartupListenerBound,
  markStartupRuntimeFailed,
  markStartupRuntimeInitialized,
  markStartupRuntimeInitializing,
  markStartupShutdown,
  updateStartupRedisLifecycle,
} from '@platform/runtime/startupLifecycle.js';

const DEFAULT_PORT = 3000;
const DEFAULT_LOCAL_HOST = '127.0.0.1';
const DEFAULT_RAILWAY_HOST = '0.0.0.0';
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

let httpServer: Server | null = null;
let shutdownStarted = false;
let fullRuntimeStarted = false;
let unsubscribeRedisLifecycle: (() => void) | null = null;
let runtimeInitializationPromise: Promise<void> | null = null;
let activeStopTelemetryPersistence: () => Promise<void> = stopSelfHealTelemetryPersistence;
let activeStopRedisLifecycle: () => Promise<void> = stopRedisLifecycle;
let activeCloseDatabase: () => Promise<void> = closeDatabase;

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

interface AppRuntimeModule {
  app: Express;
  startAppRuntimeOnce: (app: Express) => boolean;
}

export interface StartServerOptions {
  app?: Express;
  startAppRuntimeOnce?: (app: Express) => boolean;
  performPreflight?: () => Promise<void>;
  initializeDependencies?: () => Promise<void>;
  startRedis?: () => void;
  stopRedis?: () => Promise<void>;
  primeTelemetry?: () => Promise<void>;
  stopTelemetry?: () => Promise<void>;
  getRedisSnapshot?: () => RedisLifecycleSnapshot;
  subscribeRedis?: (listener: (snapshot: RedisLifecycleSnapshot) => void) => () => void;
  startSelfHealing?: typeof startSelfHealingLoop;
  closeDatabase?: () => Promise<void>;
  registerSignalHandlers?: boolean;
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
  unsubscribeRedisLifecycle?.();
  unsubscribeRedisLifecycle = null;
  await activeStopTelemetryPersistence();
  await activeStopRedisLifecycle();
  await runtimeInitializationPromise?.catch(() => undefined);
  await activeCloseDatabase();
}

/** Gracefully stop the listener and its dependency lifecycle exactly once. */
export async function shutdownServer(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) {
    return;
  }

  shutdownStarted = true;
  markStartupShutdown();
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

function projectRedisLifecycle(snapshot: RedisLifecycleSnapshot): void {
  const status = snapshot.state === 'READY'
    ? 'ready'
    : snapshot.state === 'DEGRADED'
      ? 'unavailable'
      : snapshot.configured
        ? 'connecting'
        : 'not_started';

  updateStartupRedisLifecycle({
    configured: snapshot.configured,
    status,
    attempt: snapshot.attempt,
    lastErrorCode: snapshot.lastErrorCode,
  });
}

function listenForReady(app: Express, listenerConfig: ListenerConfig): Promise<Server> {
  return new Promise((resolve, reject) => {
    let server: Server;
    try {
      server = app.listen(listenerConfig.port, listenerConfig.host);
      httpServer = server;
    } catch (error) {
      reject(error);
      return;
    }

    const onError = (error: Error) => {
      server.removeListener('listening', onListening);
      if (httpServer === server) {
        httpServer = null;
      }
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server);
    };

    server.once('error', onError);
    server.once('listening', onListening);
  });
}

async function loadAppRuntime(options: StartServerOptions): Promise<AppRuntimeModule> {
  if (options.app && options.startAppRuntimeOnce) {
    return {
      app: options.app,
      startAppRuntimeOnce: options.startAppRuntimeOnce,
    };
  }

  const appRuntime = await import('./app.js');
  return {
    app: options.app ?? appRuntime.app,
    startAppRuntimeOnce: options.startAppRuntimeOnce ?? appRuntime.startAppRuntimeOnce,
  };
}

/**
 * Start the ARCANOS HTTP listener before fallible dependency initialization.
 *
 * Purpose: keep liveness and readiness observable while Redis or another
 * external dependency recovers.
 * Inputs/Outputs: uses process environment by default; accepts injectable
 * lifecycle seams for deterministic tests; resolves once the listener binds.
 * Edge cases: deterministic preflight or listener failures still reject and
 * remain fatal to the production entrypoint.
 */
export async function startServer(options: StartServerOptions = {}): Promise<Server> {
  if (httpServer) {
    throw new Error('SERVER_ALREADY_STARTED');
  }

  const listenerConfig = resolveListenerConfig();
  const runPreflight = options.performPreflight ?? performStartupPreflight;
  const initializeDependencies = options.initializeDependencies ?? initializeRuntimeDependencies;
  const startRedis = options.startRedis ?? startRedisLifecycle;
  const getRedisSnapshot = options.getRedisSnapshot ?? getRedisLifecycleSnapshot;
  const subscribeRedis = options.subscribeRedis ?? subscribeRedisLifecycle;
  const startSelfHealing = options.startSelfHealing ?? startSelfHealingLoop;

  await runPreflight();
  const appRuntime = await loadAppRuntime(options);
  activeStopRedisLifecycle = options.stopRedis ?? stopRedisLifecycle;
  activeStopTelemetryPersistence = options.stopTelemetry ?? stopSelfHealTelemetryPersistence;
  activeCloseDatabase = options.closeDatabase ?? closeDatabase;

  if (options.registerSignalHandlers !== false) {
    process.once('SIGTERM', () => void shutdownServer('SIGTERM'));
    process.once('SIGINT', () => void shutdownServer('SIGINT'));
  }

  const server = await listenForReady(appRuntime.app, listenerConfig);
  markStartupListenerBound();
  const startupDeploymentSummary = resolveStartupDeploymentSummary();
  console.log(
    `[STARTUP] HTTP listener bound on ${listenerConfig.host}:${listenerConfig.port} | service=${startupDeploymentSummary.serviceName} | deployment=${startupDeploymentSummary.deploymentId} | git=${startupDeploymentSummary.gitCommit} | branch=${startupDeploymentSummary.gitBranch}`
  );

  const startFullRuntimeIfReady = () => {
    const lifecycle = getStartupLifecycleSnapshot();
    if (!lifecycle.ready || lifecycle.shuttingDown || fullRuntimeStarted) {
      return;
    }

    // Set the guard before any side effect so a partial failure can never
    // duplicate background loops on a later Redis transition.
    fullRuntimeStarted = true;
    try {
      appRuntime.startAppRuntimeOnce(appRuntime.app);
      const selfHealLoopStatus = startSelfHealing();
      console.log(
        `ARCANOS running on ${listenerConfig.host}:${listenerConfig.port} | service=${startupDeploymentSummary.serviceName} | deployment=${startupDeploymentSummary.deploymentId} | git=${startupDeploymentSummary.gitCommit} | branch=${startupDeploymentSummary.gitBranch} | workerHelperRoutes=enabled | askWorkerTools=enabled | selfHealLoop=${selfHealLoopStatus.loopRunning ? 'enabled' : 'disabled'} | selfHealIntervalMs=${selfHealLoopStatus.intervalMs}`
      );
    } catch (error) {
      markStartupRuntimeFailed('FULL_RUNTIME_START_FAILED');
      console.error('[STARTUP] Full runtime initialization failed', {
        errorType: error instanceof Error ? error.name : 'Error',
      });
    }
  };

  unsubscribeRedisLifecycle = subscribeRedis((snapshot) => {
    projectRedisLifecycle(snapshot);
    startFullRuntimeIfReady();
  });

  // Project once even when a test double does not immediately invoke its
  // subscriber, then begin Redis recovery without awaiting it.
  projectRedisLifecycle(getRedisSnapshot());
  startRedis();
  void (options.primeTelemetry ?? primeSelfHealTelemetryPersistence)().catch((error: unknown) => {
    console.warn('[STARTUP] Self-heal telemetry priming deferred', {
      errorType: error instanceof Error ? error.name : 'Error',
    });
  });
  markStartupRuntimeInitializing();

  runtimeInitializationPromise = initializeDependencies()
    .then(() => {
      markStartupRuntimeInitialized();
      startFullRuntimeIfReady();
    })
    .catch((error: unknown) => {
      markStartupRuntimeFailed();
      console.error('[STARTUP] Runtime dependency initialization failed', {
        errorType: error instanceof Error ? error.name : 'Error',
      });
    });
  void runtimeInitializationPromise;

  return server;
}

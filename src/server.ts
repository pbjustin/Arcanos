import type { Server } from 'http';
import type { Express } from 'express';
import config from './config/index.js';
import './config/workerConfig.js';
import './logic/aiCron.js';
import './logic/assistantSyncCron.js';
import { initializeWorkers } from './utils/workerBoot.js';
import { getAvailablePort } from './utils/portUtils.js';
import { runSystemDiagnostic } from './services/gptSync.js';
import { updateState } from './services/stateManager.js';
import { getDefaultModel } from './services/openai.js';
import { createApp } from './app.js';
import { performStartup } from './startup.js';
import type { WorkerInitResult } from './utils/workerBoot.js';
import { logServerInfo, logAIConfig, logCompleteBootSummary, formatBootMessage, logShutdownEvent } from './utils/bootLogger.js';
import { logger } from './utils/structuredLogging.js';
import { SERVER_MESSAGES, SERVER_CONSTANTS, SERVER_TEXT } from './config/serverMessages.js';

const serverLogger = logger.child({ module: 'server' });

export interface ServerFactoryOptions {
  port?: number;
  host?: string;
}

export interface ServerLifecycle {
  app: Express;
  preferredPort: number;
  actualPort: number;
  workerResults: WorkerInitResult;
  start: () => Promise<ServerStartResult>;
}

export interface ServerStartResult {
  app: Express;
  server: Server;
  port: number;
  workerResults: WorkerInitResult;
}

function logBootSummary(actualPort: number, workerResults: WorkerInitResult): void {
  logServerInfo(actualPort, config.server.port, config.server.environment, process.pid);
  logAIConfig(getDefaultModel(), config.ai.fallbackModel);
  logCompleteBootSummary(actualPort, config.server.port, config.server.environment, getDefaultModel(), workerResults);
}

function createShutdownHandler(server: Server): (signal: string) => void {
  return (signal: string) => {
    const mem = process.memoryUsage();
    const uptimeSeconds = process.uptime().toFixed(1);
    logShutdownEvent(signal, mem, Number(uptimeSeconds), {
      release: process.env.RAILWAY_RELEASE_ID,
      deployment: process.env.RAILWAY_DEPLOYMENT_ID
    });
    server.close(() => {
      process.exit(0);
    });
  };
}

function logPortAvailabilityWarnings(portResult: { isPreferred: boolean; message?: string }, preferredPort: number, host: string): void {
  if (!portResult.isPreferred) {
    serverLogger.warn(
      formatBootMessage(SERVER_MESSAGES.BOOT.PORT_WARNING, portResult.message || 'Port unavailable'),
      { preferredPort, host }
    );
    serverLogger.warn(
      formatBootMessage(SERVER_MESSAGES.BOOT.PORT_SWITCH, SERVER_TEXT.PORT_CONFLICT_TIP),
      { preferredPort, host }
    );
  }
}

function initializeSystemState(actualPort: number): void {
  try {
    updateState({
      status: 'running',
      version: process.env.npm_package_version || '1.0.0',
      startTime: new Date().toISOString(),
      port: actualPort,
      environment: config.server.environment
    });
    serverLogger.info(formatBootMessage(SERVER_MESSAGES.BOOT.BACKEND_SYNC, SERVER_TEXT.STATE_INIT_SUCCESS));
  } catch (error) {
    serverLogger.error(
      formatBootMessage(
        SERVER_MESSAGES.BOOT.BACKEND_SYNC_ERROR,
        `${SERVER_TEXT.STATE_INIT_FAILURE_PREFIX}${error}`
      ),
      undefined,
      undefined,
      error as Error
    );
  }
}

function scheduleSystemDiagnostic(actualPort: number): void {
  setTimeout(async () => {
    try {
      serverLogger.info(formatBootMessage(SERVER_MESSAGES.BOOT.GPT_SYNC_START, SERVER_TEXT.DIAGNOSTIC_START));
      await runSystemDiagnostic(actualPort);
    } catch (error) {
      serverLogger.error(
        formatBootMessage(
          SERVER_MESSAGES.BOOT.GPT_SYNC_ERROR,
          `${SERVER_TEXT.DIAGNOSTIC_FAILURE_PREFIX}${error}`
        ),
        undefined,
        undefined,
        error as Error
      );
    }
  }, SERVER_CONSTANTS.DIAGNOSTIC_DELAY_MS);
}

function registerProcessHandlers(server: Server, actualPort: number): void {
  server.on('error', (err: Error) => {
    serverLogger.error('Server error', undefined, undefined, err);
    process.exit(1);
  });

  const logAndShutdown = createShutdownHandler(server);

  process.on('SIGTERM', () => logAndShutdown('SIGTERM'));
  process.on('SIGINT', () => logAndShutdown('SIGINT'));

  process.on('beforeExit', (code) => {
    const handles = (process as any)._getActiveHandles?.() || [];
    serverLogger.info('beforeExit event', { code, openHandles: handles.length });
  });

  process.on('unhandledRejection', (err) => {
    serverLogger.error('unhandledRejection', undefined, undefined, err as Error);
  });

  process.on('uncaughtException', (err) => {
    serverLogger.error('uncaughtException', undefined, undefined, err);
  });

  scheduleSystemDiagnostic(actualPort);
}

export async function createServer(options: ServerFactoryOptions = {}): Promise<ServerLifecycle> {
  await performStartup();
  const app = createApp();

  serverLogger.info(formatBootMessage(SERVER_MESSAGES.BOOT.PORT_CHECK, SERVER_TEXT.PORT_CHECK_PROGRESS));
  const host = options.host ?? config.server.host;
  const preferredPort = options.port ?? config.server.port;

  const portResult = await getAvailablePort(preferredPort, host);

  logPortAvailabilityWarnings(portResult, preferredPort, host);

  const workerResults = await initializeWorkers();

  const start = async (): Promise<ServerStartResult> => {
    const actualPort = portResult.port;

    const server = await new Promise<Server>((resolve, reject) => {
      const instance = app.listen(actualPort, host, () => resolve(instance));
      instance.on('error', reject);
    });

    logBootSummary(actualPort, workerResults);

    initializeSystemState(actualPort);

    registerProcessHandlers(server, actualPort);

    return {
      app,
      server,
      port: actualPort,
      workerResults
    };
  };

  return {
    app,
    preferredPort,
    actualPort: portResult.port,
    workerResults,
    start
  };
}

export async function startServer(options: ServerFactoryOptions = {}): Promise<ServerStartResult> {
  const lifecycle = await createServer(options);
  return lifecycle.start();
}

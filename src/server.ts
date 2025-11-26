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
import { logServerInfo, logAIConfig, logCompleteBootSummary, formatBootMessage } from './utils/bootLogger.js';
import { SERVER_MESSAGES, SERVER_CONSTANTS } from './config/serverMessages.js';

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
    const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
    const rssMB = (mem.rss / 1024 / 1024).toFixed(1);
    console.log(`${signal} received. uptime=${uptimeSeconds}s heapMB=${heapMB} rssMB=${rssMB}`);
    console.log('railway vars', {
      release: process.env.RAILWAY_RELEASE_ID,
      deployment: process.env.RAILWAY_DEPLOYMENT_ID
    });
    server.close(() => {
      process.exit(0);
    });
  };
}

function scheduleSystemDiagnostic(actualPort: number): void {
  setTimeout(async () => {
    try {
      console.log(formatBootMessage(SERVER_MESSAGES.BOOT.GPT_SYNC_START, 'Running system diagnostic...'));
      await runSystemDiagnostic(actualPort);
    } catch (error) {
      console.error(formatBootMessage(SERVER_MESSAGES.BOOT.GPT_SYNC_ERROR, `System diagnostic failed: ${error}`));
    }
  }, SERVER_CONSTANTS.DIAGNOSTIC_DELAY_MS);
}

function registerProcessHandlers(server: Server, actualPort: number): void {
  server.on('error', (err: Error) => {
    console.error('Server error:', err);
    process.exit(1);
  });

  const logAndShutdown = createShutdownHandler(server);

  process.on('SIGTERM', () => logAndShutdown('SIGTERM'));
  process.on('SIGINT', () => logAndShutdown('SIGINT'));

  process.on('beforeExit', (code) => {
    const handles = (process as any)._getActiveHandles?.() || [];
    console.log('beforeExit', code, 'open handles', handles.length);
  });

  process.on('unhandledRejection', (err) => {
    console.error('unhandledRejection', err);
  });

  process.on('uncaughtException', (err) => {
    console.error('uncaughtException', err);
  });

  scheduleSystemDiagnostic(actualPort);
}

export async function createServer(options: ServerFactoryOptions = {}): Promise<ServerLifecycle> {
  await performStartup();
  const app = createApp();

  console.log(formatBootMessage(SERVER_MESSAGES.BOOT.PORT_CHECK, 'Checking port availability...'));
  const host = options.host ?? config.server.host;
  const preferredPort = options.port ?? config.server.port;

  const portResult = await getAvailablePort(preferredPort, host);

  if (!portResult.isPreferred) {
    console.log(formatBootMessage(SERVER_MESSAGES.BOOT.PORT_WARNING, portResult.message || 'Port unavailable'));
    console.log(formatBootMessage(SERVER_MESSAGES.BOOT.PORT_SWITCH, 'Consider stopping other services or setting a different PORT in .env'));
  }

  const workerResults = await initializeWorkers();

  const start = async (): Promise<ServerStartResult> => {
    const actualPort = portResult.port;

    const server = await new Promise<Server>((resolve, reject) => {
      const instance = app.listen(actualPort, host, () => resolve(instance));
      instance.on('error', reject);
    });

    logBootSummary(actualPort, workerResults);

    try {
      updateState({
        status: 'running',
        version: process.env.npm_package_version || '1.0.0',
        startTime: new Date().toISOString(),
        port: actualPort,
        environment: config.server.environment
      });
      console.log(formatBootMessage(SERVER_MESSAGES.BOOT.BACKEND_SYNC, 'System state initialized'));
    } catch (error) {
      console.error(formatBootMessage(SERVER_MESSAGES.BOOT.BACKEND_SYNC_ERROR, `Failed to initialize system state: ${error}`));
    }

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

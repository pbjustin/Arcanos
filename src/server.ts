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
  console.log(`[🚀 ARCANOS CORE] Server running on port ${actualPort}`);
  if (actualPort !== config.server.port) {
    console.log(`[🔀 ARCANOS PORT] Originally configured for port ${config.server.port}, using ${actualPort} instead`);
  }
  console.log(`[🌍 ARCANOS ENV] Environment: ${config.server.environment}`);
  console.log(`[⚙️  ARCANOS PID] Process ID: ${process.pid}`);
  console.log(`[🧠 ARCANOS AI] Model: ${getDefaultModel()}`);
  console.log(`[🔄 ARCANOS AI] Fallback: ${config.ai.fallbackModel}`);

  console.log('\n=== 🧠 ARCANOS BOOT SUMMARY ===');
  console.log(`🤖 Active Model: ${getDefaultModel()}`);
  console.log(`🔌 Database: ${workerResults.database.connected ? 'Connected' : 'Disconnected'}`);
  console.log('📁 Workers Directory: ./workers');
  console.log(`🔧 Workers Initialized: ${workerResults.initialized.length}`);
  console.log(`📅 Workers Scheduled: ${workerResults.scheduled.length}`);
  if (workerResults.failed.length > 0) {
    console.log(`❌ Workers Failed: ${workerResults.failed.length}`);
  }
  console.log('🔧 Core Routes:');
  console.log('   🔌 /ask - AI query endpoint');
  console.log('   🔌 /arcanos - Main AI interface');
  console.log('   🔌 /ai-endpoints - AI processing endpoints');
  console.log('   🔌 /memory - Memory management');
  console.log('   🔌 /workers/* - Worker management');
  console.log('   🔌 /orchestration/* - GPT-5 Orchestration Shell');
  console.log('   🔌 /sdk/* - OpenAI SDK interface');
  console.log('   🔌 /status - System state (Backend Sync)');
  console.log('   🔌 /siri - Siri query endpoint');
  console.log('   🔌 /health - System health');
  console.log('===============================\n');

  console.log('✅ ARCANOS backend fully operational');
}

function registerProcessHandlers(server: Server, actualPort: number): void {
  server.on('error', (err: Error) => {
    console.error('Server error:', err);
    process.exit(1);
  });

  function logAndShutdown(signal: string) {
    const mem = process.memoryUsage();
    console.log(
      `${signal} received. uptime=${process.uptime().toFixed(1)}s heapMB=${(mem.heapUsed / 1024 / 1024).toFixed(1)} rssMB=${(mem.rss /
 1024 / 1024).toFixed(1)}`
    );
    console.log('railway vars', {
      release: process.env.RAILWAY_RELEASE_ID,
      deployment: process.env.RAILWAY_DEPLOYMENT_ID
    });
    server.close(() => {
      process.exit(0);
    });
  }

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

  setTimeout(async () => {
    try {
      console.log('[🤖 GPT-SYNC] Running system diagnostic...');
      await runSystemDiagnostic(actualPort);
    } catch (error) {
      console.error('[❌ GPT-SYNC] System diagnostic failed:', error);
    }
  }, 2000);
}

export async function createServer(options: ServerFactoryOptions = {}): Promise<ServerLifecycle> {
  await performStartup();
  const app = createApp();

  console.log(`[🔌 ARCANOS PORT] Checking port availability...`);
  const host = options.host ?? config.server.host;
  const preferredPort = options.port ?? config.server.port;

  const portResult = await getAvailablePort(preferredPort, host);

  if (!portResult.isPreferred) {
    console.log(`[⚠️  ARCANOS PORT] ${portResult.message}`);
    console.log(`[🔀 ARCANOS PORT] Consider stopping other services or setting a different PORT in .env`);
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
      console.log('[🔄 BACKEND-SYNC] System state initialized');
    } catch (error) {
      console.error('[❌ BACKEND-SYNC] Failed to initialize system state:', error);
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

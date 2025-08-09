import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cron from 'node-cron';
import config from './config/index.js';
import './config/workerConfig.js'; // Import worker configuration to start workers
import { runHealthCheck } from './utils/diagnostics.js';
import { validateAPIKeyAtStartup, getDefaultModel } from './services/openai.js';
import './logic/aiCron.js';
import { initializeWorkers } from './utils/workerBoot.js';
import { getAvailablePort } from './utils/portUtils.js';
import askRouter from './routes/ask.js';
import arcanosRouter from './routes/arcanos.js';
import aiEndpointsRouter from './routes/ai-endpoints.js';
import memoryRouter from './routes/memory.js';
import workersRouter from './routes/workers.js';

// Validate required environment variables at startup
console.log("[🔥 ARCANOS STARTUP] Server boot sequence triggered.");
console.log("[🔧 ARCANOS CONFIG] Validating configuration...");

validateAPIKeyAtStartup(); // Always continue, but log warnings

console.log(`[🧠 ARCANOS AI] Default Model: ${getDefaultModel()}`);
console.log(`[🔄 ARCANOS AI] Fallback Model: ${config.ai.fallbackModel}`);
console.log("[✅ ARCANOS CONFIG] Configuration validation complete");

const app = express();

// Middleware
app.use(cors(config.cors));
app.use(express.json({ limit: config.limits.jsonLimit }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req: Request, _: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Setup health monitoring cron job
cron.schedule("*/5 * * * *", async () => {
  const report = await runHealthCheck();
  console.log(`[📡 ARCANOS:HEALTH] ${report.summary}`);
});

// Health check endpoint
app.get('/health', async (_: Request, res: Response) => {
  const healthReport = await runHealthCheck();
  const defaultModel = getDefaultModel();
  
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'ARCANOS',
    version: process.env.npm_package_version || '1.0.0',
    ai: {
      defaultModel: defaultModel,
      fallbackModel: config.ai.fallbackModel
    },
    system: {
      memory: healthReport.summary,
      uptime: `${process.uptime().toFixed(1)}s`,
      nodeVersion: process.version,
      environment: config.server.environment
    }
  });
});

// Root endpoint
app.get('/', (_: Request, res: Response) => {
  res.send('ARCANOS is live');
});

// Core API routes
app.use('/', askRouter);
app.use('/', arcanosRouter);
app.use('/', aiEndpointsRouter);
app.use('/', memoryRouter);
app.use('/', workersRouter);

// Initialize the server
async function initializeServer() {
  // Check port availability and get an available port
  console.log(`[🔌 ARCANOS PORT] Checking port availability...`);
  
  try {
    const portResult = await getAvailablePort(config.server.port, config.server.host);
    
    if (!portResult.isPreferred) {
      console.log(`[⚠️  ARCANOS PORT] ${portResult.message}`);
      console.log(`[🔀 ARCANOS PORT] Consider stopping other services or setting a different PORT in .env`);
    }
    
    // Update the actual port to use
    const actualPort = portResult.port;
    
    // Initialize workers first
    const workerResults = await initializeWorkers();
  
  // Global error handler
  app.use((err: Error, req: Request, res: Response, _: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
      error: 'Internal server error',
      message: config.server.environment === 'development' ? err.message : 'Something went wrong'
    });
  });

  // 404 handler
  app.use((_: Request, res: Response) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  // Start server with enhanced logging
  const server = app.listen(actualPort, config.server.host, () => {
    console.log(`[🚀 ARCANOS CORE] Server running on port ${actualPort}`);
    if (actualPort !== config.server.port) {
      console.log(`[🔀 ARCANOS PORT] Originally configured for port ${config.server.port}, using ${actualPort} instead`);
    }
    console.log(`[🌍 ARCANOS ENV] Environment: ${config.server.environment}`);
    console.log(`[⚙️  ARCANOS PID] Process ID: ${process.pid}`);
    console.log(`[🧠 ARCANOS AI] Model: ${getDefaultModel()}`);
    console.log(`[🔄 ARCANOS AI] Fallback: ${config.ai.fallbackModel}`);
    
    // Boot summary
    console.log('\n=== 🧠 ARCANOS BOOT SUMMARY ===');
    console.log(`🤖 Active Model: ${getDefaultModel()}`);
    console.log(`📁 Workers Directory: ./workers`);
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
    console.log('   🔌 /health - System health');
    console.log('===============================\n');

    console.log('✅ ARCANOS backend fully operational');
  });

  // Handle server errors
  server.on('error', (err: Error) => {
    console.error('Server error:', err);
    process.exit(1);
  });

  return server;
  
  } catch (error) {
    console.error('[❌ ARCANOS PORT] Failed to find available port:', error);
    process.exit(1);
  }
}

const server = await initializeServer();

function logAndShutdown(signal: string) {
  const mem = process.memoryUsage();
  console.log(
    `${signal} received. uptime=${process.uptime().toFixed(1)}s heapMB=${(mem.heapUsed / 1024 / 1024).toFixed(1)} rssMB=${(mem.rss / 1024 / 1024).toFixed(1)}`
  );
  console.log('railway vars', {
    release: process.env.RAILWAY_RELEASE_ID,
    deployment: process.env.RAILWAY_DEPLOYMENT_ID
  });
  server.close(() => {
    process.exit(0);
  });
}

// Graceful shutdown handling
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

export default app;

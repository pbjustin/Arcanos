import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cron from 'node-cron';
import config from './config/index.js';
import { runHealthCheck } from './utils/diagnostics.js';
import { validateAPIKeyAtStartup, getDefaultModel } from './services/openai.js';
import './logic/aiCron.js';
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
  const server = app.listen(config.server.port, config.server.host, () => {
    console.log(`[🚀 ARCANOS CORE] Server running on port ${config.server.port}`);
    console.log(`[🌍 ARCANOS ENV] Environment: ${config.server.environment}`);
    console.log(`[⚙️  ARCANOS PID] Process ID: ${process.pid}`);
    console.log(`[🧠 ARCANOS AI] Model: ${getDefaultModel()}`);
    console.log(`[🔄 ARCANOS AI] Fallback: ${config.ai.fallbackModel}`);
    
    // Boot summary
    console.log('\n=== 🧠 ARCANOS BOOT SUMMARY ===');
    console.log(`🤖 Active Model: ${getDefaultModel()}`);
    console.log(`📁 Workers Directory: ./workers`);
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
}

const server = await initializeServer();

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    process.exit(0);
  });
});

export default app;

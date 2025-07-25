// ARCANOS:BACKEND AI-CONTROLLED - Optimized Architecture
// Refactored: Modular route structure with centralized error handling

import express from 'express';
import path from 'path';
import bodyParser from 'body-parser';
import cors from 'cors';

// Centralized configuration
import { config, validateConfig, getEnvironmentStatus } from './config';

// Core route modules (extracted for better modularity)
import router from './routes/index';
import mainRoutes from './routes/main';
import aiRoutes from './routes/ai';
import memoryRouter from './routes/memory';
import systemRouter from './routes/system';

// Middleware
import { requireApiToken } from './middleware/api-token';
import { chatGPTUserMiddleware } from './middleware/chatgpt-user';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { performanceMiddleware } from './utils/performance';

// Services
import { databaseService } from './services/database';
import { serverService } from './services/server';
import { chatGPTUserWhitelist } from './services/chatgpt-user-whitelist';

// Handlers (for initialization)
import { memoryHandler } from './handlers/memory-handler';
import { routeRecovery } from './handlers/route-recovery';

// Import system modules
import './services/database-connection';
import './services/cron-worker';
import './worker-init';

// Import sleep manager
import { sleepManager } from './services/sleep-manager';

// Import token validator
import { EnvTokenValidator } from './utils/env-token-validator';

// Async startup function
async function startServer() {
  // Validate configuration on startup
  const configValidation = validateConfig();
  if (!configValidation.valid) {
    console.error('❌ Configuration validation failed:');
    configValidation.errors.forEach(error => console.error(`  - ${error}`));
    process.exit(1);
  }

  // Validate ARCANOS_API_TOKEN for Railway environment
  const tokenValidation = await EnvTokenValidator.validateAndPromptIfNeeded();
  if (!tokenValidation) {
    console.error('❌ ARCANOS_API_TOKEN validation failed');
    process.exit(1);
  }

  // Environment status
  const envStatus = getEnvironmentStatus();
  console.log("Configuration Status:", envStatus);

  const app = express();
  const PORT = config.server.port;

// Middleware stack
app.use(cors());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.use(performanceMiddleware); // Add performance tracking

// Sleep window activity reduction middleware
app.use((req, res, next) => {
  if (sleepManager.shouldReduceActivity()) {
    // During sleep window, add response headers to indicate reduced activity mode
    res.setHeader('X-Sleep-Mode', 'active');
    res.setHeader('X-Sleep-Window', '7AM-2PM-ET');
    
    // Add small delay for non-essential endpoints during sleep
    const isEssential = req.path === '/health' || 
                       req.path === '/performance' || 
                       req.path.startsWith('/api/system') ||
                       req.method === 'GET' && req.path === '/';
    
    if (!isEssential) {
      // Add 100ms delay for non-essential requests during sleep
      setTimeout(() => next(), 100);
      return;
    }
  }
  next();
});

// ChatGPT-User middleware (applied globally if enabled)
app.use(chatGPTUserMiddleware(config.chatgpt));

// Serve static files
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir));

// Basic healthcheck
app.get('/health', (_, res) => res.send('✅ OK'));

// Performance monitoring endpoint
app.get('/performance', (req, res) => {
  const { performanceMonitor } = require('./utils/performance');
  const metrics = performanceMonitor.getMetrics();
  const memoryStatus = performanceMonitor.getMemoryPressureStatus();
  const sleepStatus = sleepManager.getSleepStatus();
  
  res.json({
    ...metrics,
    memoryStatus,
    sleepStatus,
    sleepMode: sleepManager.shouldReduceActivity(),
    timestamp: new Date().toISOString(),
    environment: config.server.nodeEnv
  });
});

// Initialize route recovery system
routeRecovery.setApp(app);

// Mount extracted route modules
app.use('/', mainRoutes);  // Core ARCANOS routes (/memory, /audit, etc.)
app.use('/', aiRoutes);    // AI-controlled endpoints (/ask, /query-finetune, etc.)

// Mount specific API routes first
app.use('/api/memory', requireApiToken, memoryRouter);
app.use('/system', systemRouter);

// Mount general API routes with catch-all last
app.use('/api', router);

// Error handling middleware (must be last)
app.use(errorHandler.handleError);
app.use(notFoundHandler);

// Keep process alive with HTTP server
serverService.setupSignalHandlers();

// Global process monitors
process.on("exit", (code) => {
  console.log(`[EXIT] Process is exiting with code ${code}`);
});
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] Unhandled Rejection at:", promise, "reason:", reason);
});

// Server startup with optimized initialization
await serverService.start(app, PORT);
console.log(`[SERVER] Running on port ${PORT}`);
console.log(`[INFO] ENV:`, {
  NODE_ENV: config.server.nodeEnv,
  PORT: config.server.port,
  MODEL: config.ai.fineTunedModel,
  DATABASE: !!config.database.url
});

// Optimized startup logs
console.log('\n[ROUTES] 🚀 ARCANOS Modular Route Architecture:');
console.log('✅ Core routes extracted to /routes/main.ts');
console.log('✅ AI routes extracted to /routes/ai.ts');
console.log('✅ Centralized error handling implemented');
console.log('✅ Route recovery system active');

// Start periodic memory snapshots
memoryHandler.startPeriodicMemorySnapshots();

// Initialize database schema
try {
  await databaseService.initialize();
  console.log('✅ Database initialized');
} catch (error) {
  console.error('❌ Failed to initialize database:', error);
  console.warn('⚠️ Service will run in degraded mode with fallback handlers');
}

// Initialize sleep manager
try {
  await sleepManager.initialize();
  console.log('✅ Sleep manager initialized');
} catch (error) {
  console.error('❌ Failed to initialize sleep manager:', error);
  console.warn('⚠️ Sleep and maintenance features will be disabled');
}

// Initialize ChatGPT-User whitelist service
try {
  await chatGPTUserWhitelist.initialize();
  console.log('✅ ChatGPT-User whitelist service initialized');
} catch (error) {
  console.error('❌ Failed to initialize ChatGPT-User whitelist:', error);
  console.warn('⚠️ ChatGPT-User middleware will work in degraded mode');
}

// Memory usage monitoring
const memStats = process.memoryUsage();
console.log('🧠 [MEMORY] Initial RSS:', (memStats.rss / 1024 / 1024).toFixed(2), 'MB');

// Railway-specific logging
if (config.railway.environment) {
  console.log(`🚂 Railway Environment: ${config.railway.environment}`);
}

console.log('\n[OPTIMIZATION] ⚡ Backend optimization completed:');
console.log('✅ Modular route architecture');
console.log('✅ Centralized error handling');
console.log('✅ Centralized configuration management');
console.log('✅ Improved separation of concerns');
console.log('✅ ARCANOS_API_TOKEN validation for Railway environment');

if (!config.features.runWorkers) {
  console.log('[SERVER] RUN_WORKERS not enabled - keeping process alive');
  setInterval(() => {}, 1 << 30);
}

return app;
}

// Start the server
startServer().catch((error) => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});

// Export the ARCANOS V1 Safe Interface for direct usage
export { askArcanosV1_Safe, getActiveModel, ArcanosModel } from './services/arcanos-v1-interface';

// Export sleep schedule functions for copilot integration
export { getCoreSleepWindow } from './services/sleep-config';

// Export email service functions for global access
export { sendEmail, verifyEmailConnection, getEmailSender, getEmailTransportType } from './services/email';

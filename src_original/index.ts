// ARCANOS:BACKEND AI-CONTROLLED - Optimized Architecture
// Refactored: Modular route structure with centralized error handling

import express from 'express';
import path from 'path';
import bodyParser from 'body-parser';
import cors from 'cors';
import { fileURLToPath } from 'url';

// Centralized configuration
import { config, validateConfig, getEnvironmentStatus } from './config/index.js';
import { applyCLEAROverlay } from './modules/clear-overlay.js';

// Core route modules (extracted for better modularity)
import router from './routes/index.js';
import mainRoutes from './routes/main.js';
import aiRoutes from './routes/ai.js';
import memoryRouter from './routes/memory.js';
import guidesRouter from './routes/guides.js';
import systemRouter from './routes/system.js';
import codexRouter from './routes/codex.js';
import logsRouter from './routes/logs.js';
import webFallbackRouter from './routes/web-fallback.js';
import webLookupAndSummarizeRouter from './modules/webLookupAndSummarize.js';
import researchRouter from './modules/research.js';
import openaiWebhookRouter from './webhooks/openai.js';
import githubWebhookRouter from './webhooks/github.js';
import { enableAdminControl, getAdminRouter } from './system/auth.js';

// Middleware
import { requireApiToken } from './middleware/api-token.js';
import { chatGPTUserMiddleware } from './middleware/chatgpt-user.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { performanceMiddleware } from './utils/performance.js';

// Services
import { databaseService } from './services/database.js';
import { serverService } from './services/server.js';
import { chatGPTUserWhitelist } from './services/chatgpt-user-whitelist.js';
import { diagnosticsService } from './services/diagnostics.js';
import { memoryMonitor } from './services/memory-monitor.js';
import { recordUptime, getLastUptime } from './utils/uptime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Handlers (for initialization)
import { memoryHandler } from './handlers/memory-handler.js';
import { routeRecovery } from './handlers/route-recovery.js';

// Import system modules
import './services/database-connection.js';
import './services/cron-worker.js';
import './worker-init.js';

// Import AI reflection handler (initializes 8:30 AM daily schedule)
import './services/backend-ai-reflection-handler.js';

// Trigger self-reflection when entering sleep mode
import './sleep-self-reflection.js';

// Import sleep manager
import { sleepManager } from './services/sleep-manager.js';
// Schedule pre-sleep preparation tasks
import './services/sleep-prep.js';

// Validate configuration on startup
const configValidation = validateConfig();
if (!configValidation.valid) {
  console.error('❌ Configuration validation failed:');
  configValidation.errors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}

// Environment status
const envStatus = getEnvironmentStatus();
console.log("Configuration Status:", envStatus);

// Initialize CLEAR overlay with strict settings
applyCLEAROverlay({
  enforceContextBoundaries: true,
  hallucinationControl: { enabled: true, fallback: 'diagnostic-fail' },
  logicMemorySync: true,
});

const app = express();
const PORT = config.server.port;

if (process.env.ADMIN_KEY) {
  enableAdminControl(process.env.ADMIN_KEY);
  const adminRouter = getAdminRouter();
  if (adminRouter) {
    app.use('/admin', adminRouter);
  }
  console.log('🛡 Admin access enabled');
}

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
app.get('/performance', async (_req, res) => {
  const { performanceMonitor } = await import('./utils/performance.js');
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

// Mount additional API routes (before general API router to avoid catch-all)
app.use('/api/memory', requireApiToken, memoryRouter);
app.use('/api/guides', requireApiToken, guidesRouter);
app.use('/api/web-fallback', webFallbackRouter);
app.use('/', webLookupAndSummarizeRouter);
app.use('/', researchRouter);
app.use('/api', router);
app.use('/system', systemRouter);
app.use('/codex', codexRouter);
app.use('/logs', logsRouter);
app.use('/webhooks', openaiWebhookRouter);
app.use('/webhooks', githubWebhookRouter);

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
  diagnosticsService.executeDiagnosticCommand(`uncaught exception: ${err.message}`).catch(() => {});
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] Unhandled Rejection at:", promise, "reason:", reason);
  const msg = reason instanceof Error ? reason.message : String(reason);
  diagnosticsService.executeDiagnosticCommand(`unhandled rejection: ${msg}`).catch(() => {});
});

// Server startup with optimized initialization
serverService.start(app, PORT).then(async () => {
  console.log(`[SERVER] Running on port ${PORT}`);
  const lastBoot = getLastUptime();
  recordUptime();
  if (lastBoot) {
    console.log(`[UPTIME] Previous boot at ${lastBoot}`);
  }
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
  memoryMonitor.start(undefined, 0.83);
  
  // Railway-specific logging
  if (config.railway.environment) {
    console.log(`🚂 Railway Environment: ${config.railway.environment}`);
  }

  
  if (!config.features.runWorkers) {
    console.log('[SERVER] RUN_WORKERS not enabled - keeping process alive');
    setInterval(() => {}, 1 << 30);
  }
});

export default app;

// Export the ARCANOS V1 Safe Interface for direct usage
export { askArcanosV1_Safe, getActiveModel, ArcanosModel } from './services/arcanos-v1-interface.js';

// Export sleep schedule functions for copilot integration
export { getCoreSleepWindow } from './services/sleep-config.js';

// Export email service functions for global access
export { sendEmail, verifyEmailConnection, getEmailSender, getEmailTransportType } from './services/email.js';
export { selfReflectionService } from './services/self-reflection.js';

// Export backend AI reflection handler
export { reflectIfScheduled } from './services/backend-ai-reflection-handler.js';

// Export game guide storage functionality
export { saveGameGuide } from './services/game-guides.js';

// Export AI patch system for external usage
export { aiPatchSystem, createAIPatch } from './services/ai-patch-system.js';
export { initializeBackend } from './initializeBackend.js';

import express from "express";
import rateLimit from "express-rate-limit";
import { createServer } from "http";
import { registerRoutes } from "./routes/index.js";
import { MemoryStorage } from "./storage/memory-storage.js";
import { ArcanosRAG } from "./modules/rag.js";
import { HRCCore } from "./modules/hrc.js";
import { ArcanosConfig } from "./config/arcanos-config.js";
import { errorHandler, requestLogger, securityHeaders } from "./middleware/index.js";

const app = express();
const server = createServer(app);

const memoryStorage = new MemoryStorage();
const arcanosConfig = new ArcanosConfig();
const ragModule = new ArcanosRAG();
const hrcCore = new HRCCore();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(securityHeaders);
app.use(requestLogger);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

async function initializeModules() {
  console.log('[ARCANOS] Initializing server modules...');
  await arcanosConfig.initialize();
  await ragModule.initialize(arcanosConfig.getConfig());
  await hrcCore.initialize();
  console.log('[ARCANOS] All modules initialized successfully');
}

registerRoutes(app, {
  memoryStorage,
  arcanosConfig,
  ragModule,
  hrcCore
});

app.use(errorHandler);

app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: '1.0.0'
  });
});

const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    await initializeModules();
    server.listen(PORT, () => {
      console.log(`[ARCANOS] Server running on port ${PORT}`);
      console.log(`[ARCANOS] Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`[ARCANOS] Single-user mode for: pbjustin`);
      console.log(`[ARCANOS] Memory storage initialized`);
      console.log(`[ARCANOS] RAG module ready`);
      console.log(`[ARCANOS] HRC module active`);
    });
  } catch (error) {
    console.error('[ARCANOS] Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[ARCANOS] Received SIGINT, shutting down gracefully...');
  server.close(() => {
    console.log('[ARCANOS] Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n[ARCANOS] Received SIGTERM, shutting down gracefully...');
  server.close(() => {
    console.log('[ARCANOS] Server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (error) => {
  console.error('[ARCANOS] Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ARCANOS] Unhandled Rejection at:', promise, 'reason:', reason);
});

startServer();

export { app, server, memoryStorage, arcanosConfig, ragModule, hrcCore };
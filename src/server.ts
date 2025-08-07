import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import cron from 'node-cron';
import { runHealthCheck } from './utils/diagnostics.js';
import { validateAPIKeyAtStartup, getDefaultModel } from './services/openai.js';
import './logic/aiCron.js';
import askRouter from './routes/ask.js';
import arcanosRouter from './routes/arcanos.js';
import aiEndpointsRouter from './routes/ai-endpoints.js';
import memoryRouter from './routes/memory.js';

// Load environment variables
dotenv.config();

// Validate required environment variables at startup
console.log("[🔥 ARCANOS STARTUP] Server boot sequence triggered.");
console.log("[🔧 ARCANOS CONFIG] Validating configuration...");

validateAPIKeyAtStartup(); // Always continue, but log warnings

console.log(`[🧠 ARCANOS AI] Default Model: ${getDefaultModel()}`);
console.log(`[🔄 ARCANOS AI] Fallback Model: gpt-4`);
console.log("[✅ ARCANOS CONFIG] Configuration validation complete");

const app = express();
const port = Number(process.env.PORT) || 3000;

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'development' ? true : process.env.ALLOWED_ORIGINS?.split(','),
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req: Request, _: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// API routes

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
      fallbackModel: 'gpt-4'
    },
    system: {
      memory: healthReport.summary,
      uptime: `${process.uptime().toFixed(1)}s`,
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || 'development'
    }
  });
});

// Root endpoint
app.get('/', (_: Request, res: Response) => {
  res.send('ARCANOS is live');
});

// API routes
app.use('/', askRouter);
app.use('/', arcanosRouter);
app.use('/', aiEndpointsRouter);
app.use('/', memoryRouter);

// Global error handler
app.use((err: Error, req: Request, res: Response, _: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use((_: Request, res: Response) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

// Start server with enhanced logging
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`[🚀 ARCANOS CORE] Server running on port ${port}`);
  console.log(`[🌍 ARCANOS ENV] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[⚙️  ARCANOS PID] Process ID: ${process.pid}`);
  console.log(`[🧠 ARCANOS AI] Model: ${getDefaultModel()}`);
  console.log(`[🔄 ARCANOS AI] Fallback: gpt-4`);
  console.log("[✅ ARCANOS READY] All systems operational");
});

// Handle server errors
server.on('error', (err: Error) => {
  console.error('Server error:', err);
  process.exit(1);
});

export default app;

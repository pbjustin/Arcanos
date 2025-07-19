import express, { Request, Response, NextFunction } from 'express';
import * as dotenv from 'dotenv';
import router from './routes/index';

// Load environment variables
dotenv.config();

// Check for fine-tuned model but allow startup without it
if (!process.env.FINE_TUNED_MODEL || process.env.FINE_TUNED_MODEL.trim() === '') {
  console.info("ℹ️ No fine-tuned model configured.");
} else {
  console.log("✅ Fine-tuned model loaded:", process.env.FINE_TUNED_MODEL);
}
if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️ Warning: OPENAI_API_KEY not found. OpenAI features will be disabled.");
}

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/', (req, res) => {
  res.send('Arcanos backend running');
});

app.use('/api', router);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Add fallback error handler middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error("🔥 Fatal Error:", err);
  res.status(500).json({ error: err.message });
});

// Start server
const port = process.env.PORT || 8080;
console.log(`🚀 Starting server on port ${port} in ${process.env.NODE_ENV || 'development'} mode...`);

const server = app.listen(port, () => {
  console.log(`✅ Server successfully running on port ${port}`);
  console.log(`🔗 Health check: http://localhost:${port}/health`);
  console.log(`🔗 API info: http://localhost:${port}/api/`);
  
  // Log process info to help with debugging
  console.log(`📊 Process PID: ${process.pid}`);
  console.log(`📊 Node version: ${process.version}`);
  console.log(`📊 Memory usage:`, process.memoryUsage());
});

// Handle server startup errors
server.on('error', (error: any) => {
  console.error('❌ Server failed to start:', error);
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ Port ${port} is already in use`);
  }
  // In production, we might want to try a different port or exit gracefully
  if (process.env.NODE_ENV === 'production') {
    console.error('💀 Exiting due to server startup failure in production');
    process.exit(1);
  }
});

// Graceful shutdown
const gracefulShutdown = (signal: string) => {
  console.log(`\n🛑 Received ${signal}. Gracefully shutting down...`);
  server.close((err) => {
    if (err) {
      console.error('❌ Error during server shutdown:', err);
      process.exit(1);
    }
    console.log('✅ Server closed successfully');
    process.exit(0);
  });
};

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle unhandled promise rejections to prevent unexpected exits
process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
  // Keep the process alive - log but don't exit
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('🚨 Uncaught Exception thrown:', error);
  // In production, try to keep the server running unless it's a critical error
  if (process.env.NODE_ENV === 'production') {
    console.error('⚠️ Keeping server alive despite uncaught exception');
  } else {
    console.error('💀 Exiting in development mode due to uncaught exception');
    process.exit(1);
  }
});

export default app;
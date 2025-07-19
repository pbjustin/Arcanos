import express, { Request, Response, NextFunction } from 'express';
import * as dotenv from 'dotenv';
import router from './routes/index';

// Load environment variables
dotenv.config();

// Check for fine-tuned model but allow startup without it
if (!process.env.FINE_TUNE_MODEL || process.env.FINE_TUNE_MODEL.trim() === '') {
  console.info("ℹ️ No fine-tuned model configured.");
} else {
  console.log("✅ Fine-tuned model loaded:", process.env.FINE_TUNE_MODEL);
}
if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️ Warning: OPENAI_API_KEY not found. OpenAI features will be disabled.");
}

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic heartbeat endpoint to keep the container alive
app.get('/', (_req, res) => {
  res.send('Arcanos backend is running 🚀');
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
const port = Number(process.env.PORT) || 8080;
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Fine-tuned model loaded: ${process.env.FINE_TUNE_MODEL}`);
  console.log(`🌐 Server running on port ${port}`);
});

// Dummy `setInterval` to prevent silent exit
setInterval(() => {
  // keep event loop busy, no-op
}, 60_000);

// Handle shutdown signals gracefully
process.on('SIGTERM', () => {
  console.log('📦 SIGTERM received, shutting down gracefully…');
  server.close(() => process.exit(0));
});

// Add global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
  console.error('🚨 Uncaught Exception:', error);
  // Log the error but don't exit - let the server continue running
  // Only exit if it's a fatal error that prevents server operation
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
  // Log the error but don't exit - let the server continue running
});

export default app;
import express, { Request, Response, NextFunction } from 'express';
import * as dotenv from 'dotenv';
import router from './routes/index';

// Load environment variables
dotenv.config();

// Railway-specific environment handling
if (process.env.RAILWAY_ENVIRONMENT) {
  console.log(`🚂 Running on Railway environment: ${process.env.RAILWAY_ENVIRONMENT}`);
}

// Ensure NODE_ENV is set for Railway
if (!process.env.NODE_ENV && process.env.RAILWAY_ENVIRONMENT) {
  process.env.NODE_ENV = 'production';
}

// Instead of blindly assigning or defaulting to "undefined", guard the load:
const fineTunedModel = process.env.OPENAI_FINE_TUNED_MODEL;

if (!fineTunedModel) {
  console.warn("No fine-tuned model configured.");
} else {
  console.log(`✅ Fine-tuned model loaded: ${fineTunedModel}`);
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
  res.send('Arcanos backend running');
});

// POST endpoint for natural language inputs
app.post('/', async (req, res) => {
  const { message } = req.body;
  
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    // Import OpenAI service dynamically to avoid startup dependency
    const { OpenAIService } = await import('./services/openai');
    const openaiService = new OpenAIService();
    
    // Simple chat request using the fine-tuned model
    const response = await openaiService.chat([
      { role: 'user', content: message }
    ]);
    
    // Return the response - if successful, just the message; if error, structured response
    if (response.error || response.fallbackRequested) {
      res.json({ 
        error: response.error,
        response: response.message 
      });
    } else {
      // Success case - return just the message content
      res.send(response.message);
    }
    
  } catch (error: any) {
    console.error('Error processing message:', error);
    
    // Handle case where OpenAI is not configured
    if (error.message.includes('OPENAI_API_KEY')) {
      return res.status(500).json({ 
        error: 'OpenAI service not configured',
        response: `Echo: ${message}` // Fallback response
      });
    }
    
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

app.use('/api', router);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: '1.0.0',
    port: port
  });
});

// Basic readiness check for Railway
app.get('/ready', (req, res) => {
  res.status(200).send('OK');
});

// Add fallback error handler middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error("🔥 Fatal Error:", err);
  res.status(500).json({ error: err.message });
});

// Start server
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

const server = app.listen(port, host, () => {
  console.log(`✅ Server running on ${host}:${port}`);
  console.log(`🔗 Health check: http://${host}:${port}/health`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Railway-specific logging
  if (process.env.RAILWAY_ENVIRONMENT) {
    console.log(`🚂 Railway Environment: ${process.env.RAILWAY_ENVIRONMENT}`);
    console.log(`🔧 Railway Service: ${process.env.RAILWAY_SERVICE_NAME || 'Unknown'}`);
  }
});

// Prevent premature exit
process.stdin.resume();

// Handle shutdown signals gracefully
let isShuttingDown = false;

const gracefulShutdown = (signal: string) => {
  if (isShuttingDown) {
    console.log(`📦 ${signal} received again, forcing exit...`);
    process.exit(1);
  }
  
  isShuttingDown = true;
  console.log(`📦 ${signal} received, shutting down gracefully...`);
  
  server.close((err) => {
    if (err) {
      console.error('❌ Error during graceful shutdown:', err);
      process.exit(1);
    }
    console.log('✅ Server closed successfully');
    process.exit(0);
  });
  
  // Force exit after 10 seconds if graceful shutdown doesn't complete
  setTimeout(() => {
    console.error('⚠️ Graceful shutdown timeout, forcing exit...');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

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
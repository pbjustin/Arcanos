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
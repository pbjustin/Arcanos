// ARCANOS:INITIATE FULL AUDIT - BACKEND ENTRY POINT
// Target: Detect lingering exit logic, missing persistence, or fine-tune misconfig

// --- ENTRY POINT REWRITE IMPLEMENTATION ---
import express from 'express';
import * as http from 'http';
import * as dotenv from 'dotenv';
import router from './routes/index';

// Load environment variables
dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 8080;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic Healthcheck
app.get('/health', (_, res) => res.send('✅ OK'));

// Mount core logic or routes here
app.use('/api', router);

// Basic heartbeat endpoint to keep the container alive
app.get('/', (_req, res) => {
  res.send('Arcanos backend running');
});

// POST endpoint for natural language inputs with improved error handling
app.post('/', async (req, res) => {
  const { message } = req.body;
  
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    // --- FINE-TUNE FALLBACK BLOCK ---
    // Example for integrating OpenAI fine-tune safely
    // (Wrap in try/catch and validate keys/models explicitly)
    
    if (!process.env.OPENAI_API_KEY) {
      console.warn("⚠️ No fine-tuned model configured or available.");
      return res.status(500).json({ 
        error: 'OpenAI service not configured',
        response: `Echo: ${message}` // Fallback response
      });
    }

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
    console.warn("⚠️ No fine-tuned model configured or available.");
    
    res.status(500).json({ 
      error: 'Internal server error',
      response: `Echo: ${message}` // Fallback response
    });
  }
});

// Keep process alive with HTTP server
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  
  // Railway-specific logging
  if (process.env.RAILWAY_ENVIRONMENT) {
    console.log(`🚂 Railway Environment: ${process.env.RAILWAY_ENVIRONMENT}`);
    console.log(`🔧 Railway Service: ${process.env.RAILWAY_SERVICE_NAME || 'Unknown'}`);
  }
  
  // Fine-tuned model validation
  const fineTunedModel = process.env.OPENAI_FINE_TUNED_MODEL;
  if (!fineTunedModel) {
    console.warn("⚠️ No fine-tuned model configured or available.");
  } else {
    console.log(`✅ Fine-tuned model loaded: ${fineTunedModel}`);
  }
});

// Graceful Shutdown Logic
process.on('SIGTERM', () => {
  console.log('📦 SIGTERM received, shutting down...');
  server.close(() => {
    console.log('✅ Server closed successfully');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('📦 SIGINT received, shutting down...');
  server.close(() => {
    console.log('✅ Server closed successfully');
    process.exit(0);
  });
});

// --- TODO: Validate Railway Service Config ---
// ✅ Ensure `.railway/config.json` exists and binds to PORT
// ✅ Confirm `alwaysOn` is true in Railway GUI (manual verification needed)
// ✅ Confirm no conflicting default script paths in `package.json`

export default app;

// 🔧 End of Audit Block
// integration-test.js
import { safeChat } from './memorySafeAI.js';
import express from 'express';

const app = express();
app.use(express.json());

// Example integration endpoint using memorySafeAI
app.post('/api/safe-chat', async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    
    console.log(`[API] Received chat request: ${message.substring(0, 50)}...`);
    
    const response = await safeChat(message);
    
    if (response.error) {
      return res.status(503).json({ 
        error: response.error,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({ 
      response,
      timestamp: new Date().toISOString(),
      memoryStatus: 'normal'
    });
    
  } catch (error) {
    console.error('[API ERROR]', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Memory status endpoint
app.get('/api/memory-status', (req, res) => {
  const mem = process.memoryUsage();
  const HEAP_THRESHOLD = 512 * 0.8 * 1024 * 1024;
  
  res.json({
    heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(1) + ' MB',
    heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(1) + ' MB',
    rss: (mem.rss / 1024 / 1024).toFixed(1) + ' MB',
    external: (mem.external / 1024 / 1024).toFixed(1) + ' MB',
    threshold: (HEAP_THRESHOLD / 1024 / 1024).toFixed(1) + ' MB',
    isAboveThreshold: mem.heapUsed > HEAP_THRESHOLD,
    timestamp: new Date().toISOString()
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    memorySafeAI: 'enabled',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;

console.log(`🚀 Starting integration test server on port ${PORT}`);
console.log('📊 Memory monitoring enabled with 30-second GC cycle');
console.log('🧠 memorySafeAI module integrated');
console.log('\nTest endpoints:');
console.log(`- POST http://localhost:${PORT}/api/safe-chat`);
console.log(`- GET  http://localhost:${PORT}/api/memory-status`);
console.log(`- GET  http://localhost:${PORT}/health`);

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen(PORT, () => {
    console.log(`\n✅ Server running on http://localhost:${PORT}`);
  });
}
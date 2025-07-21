/*
  ARCANOS ROUTER — FINE-TUNE ONLY (NO FALLBACK)

  PURPOSE:
  This Node.js + Express app is designed to act as a query gateway that only routes to 
  a personalized fine-tuned OpenAI model (gpt-3.5-turbo-0125:personal:arcanos-v1-1106).

  DEPLOYMENT:
  • Must be deployable on Railway (PORT comes from process.env)
  • Uses axios for HTTP calls
  • Only accepts POST requests to /query
  • Routes all input to POST https://arcanos-production-426d.up.railway.app/query-finetune
  • If user attempts fallback behavior (--fallback or ::default), reject the request

  MODULES:
  - index.js        → Main express app, uses queryRouter
  - routes/query.js → Handles POST /query, applies fallback rejection
  - services/send.js → Axios logic for hitting fine-tune endpoint
*/

const express = require('express');
const cors = require('cors');
const os = require('os');
const queryRouter = require('./routes/query');

const app = express();
const PORT = process.env.PORT || 3000;

// Diagnostics module logic
let errorLogs = [];

function logError(err) {
  errorLogs.push({
    message: err.message || 'Unknown error',
    timestamp: new Date().toISOString(),
  });
  if (errorLogs.length > 100) errorLogs.shift();
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check endpoint for Railway
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'ARCANOS Router',
    model: 'gpt-3.5-turbo-0125:personal:arcanos-v1-1106',
    timestamp: new Date().toISOString()
  });
});

// System diagnostics endpoint
app.get('/status', (req, res) => {
  const memory = process.memoryUsage();
  const uptime = process.uptime();

  const diagnostics = {
    system: {
      cpuLoad: os.loadavg(),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      uptime: `${Math.floor(uptime)}s`,
      platform: os.platform(),
      arch: os.arch(),
    },
    api: {
      status: 'online',
      endpoints: ['/query', '/health', '/status'],
    },
    errors: {
      count: errorLogs.length,
      recent: errorLogs.slice(-5),
    },
    timestamp: new Date().toISOString(),
  };

  res.status(200).json(diagnostics);
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'ARCANOS Router',
    description: 'Fine-tune only query gateway (no fallback)',
    endpoints: {
      'POST /query': 'Submit queries to fine-tuned model',
      'GET /health': 'Health check for Railway deployment',
      'GET /status': 'System diagnostics and error monitoring'
    },
    model: 'gpt-3.5-turbo-0125:personal:arcanos-v1-1106',
    fallback: false
  });
});

// Mount query router
app.use('/', queryRouter);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    message: 'This router only supports POST /query for fine-tuned model queries',
    available_endpoints: ['POST /query', 'GET /health', 'GET /status', 'GET /']
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  logError(err);
  res.status(500).json({
    error: 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 ARCANOS Router is running on port ${PORT}`);
  console.log(`🎯 Target model: gpt-3.5-turbo-0125:personal:arcanos-v1-1106`);
  console.log(`📡 Fine-tune endpoint: https://arcanos-production-426d.up.railway.app/query-finetune`);
  console.log(`🚫 Fallback behavior: DISABLED`);
  
  if (process.env.RAILWAY_ENVIRONMENT) {
    console.log(`🚂 Railway Environment: ${process.env.RAILWAY_ENVIRONMENT}`);
  }
});
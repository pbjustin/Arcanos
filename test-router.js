#!/usr/bin/env node

/*
  ARCANOS Router Test Suite
  
  Tests the fine-tune only router implementation:
  - Valid query routing
  - Fallback detection and rejection
  - Error handling
  - Health endpoints
*/

const http = require('http');

const TEST_PORT = 3002;
let server;

// Simple test framework
class TestRunner {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
  }

  test(name, testFn) {
    this.tests.push({ name, testFn });
  }

  async run() {
    console.log('🧪 Starting ARCANOS Router Tests\n');
    
    for (const { name, testFn } of this.tests) {
      try {
        console.log(`  Testing: ${name}`);
        await testFn();
        console.log(`  ✅ PASS: ${name}\n`);
        this.passed++;
      } catch (error) {
        console.log(`  ❌ FAIL: ${name}`);
        console.log(`     Error: ${error.message}\n`);
        this.failed++;
      }
    }

    console.log(`\n📊 Test Results:`);
    console.log(`   ✅ Passed: ${this.passed}`);
    console.log(`   ❌ Failed: ${this.failed}`);
    console.log(`   📋 Total:  ${this.tests.length}`);

    return this.failed === 0;
  }
}

// HTTP request helper
function makeRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ status: res.statusCode, data: parsed });
        } catch {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', reject);
    
    if (data) {
      req.write(JSON.stringify(data));
    }
    
    req.end();
  });
}

// Start test server
function startTestServer() {
  return new Promise((resolve) => {
    // Create express app directly for testing
    const express = require('express');
    const cors = require('cors');
    const queryRouter = require('./routes/query');

    const app = express();

    // Middleware
    app.use(cors());
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true }));

    // Health check endpoint for Railway
    app.get('/health', (req, res) => {
      res.json({ 
        status: 'healthy',
        service: 'ARCANOS Router',
        model: 'gpt-3.5-turbo-0125:personal:arcanos-v3',
        timestamp: new Date().toISOString()
      });
    });

    // Root endpoint
    app.get('/', (req, res) => {
      res.json({
        service: 'ARCANOS Router',
        description: 'Fine-tune only query gateway (no fallback)',
        endpoints: {
          'POST /query': 'Submit queries to fine-tuned model',
          'GET /health': 'Health check for Railway deployment'
        },
        model: 'gpt-3.5-turbo-0125:personal:arcanos-v3',
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
        available_endpoints: ['POST /query', 'GET /health', 'GET /']
      });
    });

    server = app.listen(TEST_PORT, () => {
      console.log(`🚀 Test server started on port ${TEST_PORT}\n`);
      resolve();
    });
  });
}

// Stop test server
function stopTestServer() {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        console.log('\n🛑 Test server stopped');
        resolve();
      });
    } else {
      resolve();
    }
  });
}

// Test cases
const runner = new TestRunner();

runner.test('Health endpoint should return healthy status', async () => {
  const response = await makeRequest('GET', '/health');
  
  if (response.status !== 200) {
    throw new Error(`Expected status 200, got ${response.status}`);
  }
  
  if (response.data.status !== 'healthy') {
    throw new Error(`Expected status 'healthy', got '${response.data.status}'`);
  }

  if (!response.data.model) {
    throw new Error('Missing model information in health response');
  }
});

runner.test('Root endpoint should return service info', async () => {
  const response = await makeRequest('GET', '/');
  
  if (response.status !== 200) {
    throw new Error(`Expected status 200, got ${response.status}`);
  }
  
  if (response.data.service !== 'ARCANOS Router') {
    throw new Error(`Expected service 'ARCANOS Router', got '${response.data.service}'`);
  }

  if (response.data.fallback !== false) {
    throw new Error('Fallback should be disabled');
  }
});

runner.test('Query endpoint should reject missing query', async () => {
  const response = await makeRequest('POST', '/query', {});
  
  if (response.status !== 400) {
    throw new Error(`Expected status 400, got ${response.status}`);
  }
  
  if (!response.data.error.includes('required')) {
    throw new Error('Should indicate query is required');
  }
});

runner.test('Query endpoint should reject --fallback pattern', async () => {
  const response = await makeRequest('POST', '/query', {
    query: 'Please use --fallback model'
  });
  
  if (response.status !== 403) {
    throw new Error(`Expected status 403, got ${response.status}`);
  }
  
  if (!response.data.error.includes('Fallback behavior is not allowed')) {
    throw new Error('Should reject fallback behavior');
  }
});

runner.test('Query endpoint should reject ::default pattern', async () => {
  const response = await makeRequest('POST', '/query', {
    query: 'Switch to ::default please'
  });
  
  if (response.status !== 403) {
    throw new Error(`Expected status 403, got ${response.status}`);
  }
  
  if (!response.data.rejected_patterns) {
    throw new Error('Should include rejected patterns in response');
  }
});

runner.test('Query endpoint should reject fallback model pattern', async () => {
  const response = await makeRequest('POST', '/query', {
    query: 'Can you use the fallback model instead?'
  });
  
  if (response.status !== 403) {
    throw new Error(`Expected status 403, got ${response.status}`);
  }
});

runner.test('Valid query should attempt to call fine-tune endpoint', async () => {
  const response = await makeRequest('POST', '/query', {
    query: 'What is artificial intelligence?'
  });
  
  // Should get 502 because fine-tune endpoint doesn't exist in test
  // but this proves the query was accepted and routing was attempted
  if (response.status !== 502) {
    throw new Error(`Expected status 502 (endpoint error), got ${response.status}`);
  }
  
  if (!response.data.error.includes('Fine-tune endpoint error')) {
    throw new Error('Should indicate fine-tune endpoint error');
  }
});

runner.test('Non-existent endpoints should return 404', async () => {
  const response = await makeRequest('GET', '/nonexistent');
  
  if (response.status !== 404) {
    throw new Error(`Expected status 404, got ${response.status}`);
  }
  
  if (!response.data.available_endpoints) {
    throw new Error('Should list available endpoints');
  }
});

// Run tests
async function runTests() {
  try {
    await startTestServer();
    const success = await runner.run();
    await stopTestServer();
    
    process.exit(success ? 0 : 1);
  } catch (error) {
    console.error('❌ Test runner error:', error);
    await stopTestServer();
    process.exit(1);
  }
}

// Only run tests if this file is executed directly
if (require.main === module) {
  runTests();
}

module.exports = { TestRunner, makeRequest };
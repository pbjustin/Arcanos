#!/usr/bin/env node

// Simple API endpoint test for ARCANOS backend
import { runEndpointTests } from '../test-utils/common.js';
import axios from 'axios';

const BASE_URL = 'http://localhost:3000';

async function testEndpoints() {
  const tests = [
    { name: 'Health Check', method: 'GET', endpoint: '/health' },
    { name: 'Root Endpoint', method: 'GET', endpoint: '/' },
    { name: 'Ask Endpoint (no API key)', method: 'POST', endpoint: '/ask', data: { prompt: 'test question' } },
  ];

  let failed = 0;
  
  try {
    await runEndpointTests(tests, { verbose: true, baseUrl: BASE_URL });
  } catch (error) {
    console.error('Test suite failed:', error.message);
    failed = 1;
  }
  
  if (failed === 0) {
    console.log('🎉 All tests passed!');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed!');
    process.exit(1);
  }
}

// Check if server is running
async function checkServer() {
  try {
    await axios.get(`${BASE_URL}/health`, { timeout: 5000 });
    return true;
  } catch (error) {
    return false;
  }
}

async function main() {
  const isRunning = await checkServer();
  
  if (!isRunning) {
    console.log('❌ Server is not running on localhost:3000');
    console.log('Please start the server first:');
    console.log('  npm run dev  (or)  npm start');
    process.exit(1);
  }
  
  await testEndpoints();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { testEndpoints, checkServer };
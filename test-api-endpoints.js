#!/usr/bin/env node

// Simple API endpoint test for ARCANOS backend
const { runEndpointTests } = require('./test-utils/common');

async function testEndpoints() {
  const tests = [
    { name: 'Health Check', method: 'GET', endpoint: '/health' },
    { name: 'Fine-tune Status', method: 'GET', endpoint: '/finetune-status' },
    { name: 'Main Endpoint', method: 'POST', endpoint: '/', data: { message: 'test' } },
    { name: 'Query Fine-tune', method: 'POST', endpoint: '/query-finetune', data: { query: 'test query' } },
    { name: 'Ask Endpoint', method: 'POST', endpoint: '/ask', data: { message: 'test question' } },
    { name: 'Diagnostics', method: 'GET', endpoint: '/sync/diagnostics', includeAuth: true }
  ];

  await runEndpointTests(tests, { verbose: true });
  
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
    console.log('❌ Server is not running on localhost:8080');
    console.log('Please start the server first:');
    console.log('  npm run dev  (or)  npm start');
    process.exit(1);
  }
  
  await testEndpoints();
}

if (require.main === module) {
  main();
}

module.exports = { testEndpoints, checkServer };
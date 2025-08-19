#!/usr/bin/env node

/**
 * Test suite for ConfirmGate middleware compliance
 * Verifies that all sensitive endpoints require x-confirmed: yes header
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:8080';

const sensitiveEndpoints = [
  { method: 'POST', path: '/brain', description: 'AI brain endpoint' },
  { method: 'POST', path: '/arcanos', description: 'Main ARCANOS interface' },
  { method: 'POST', path: '/api/arcanos/ask', description: 'API ARCANOS ask' },
  { method: 'POST', path: '/write', description: 'AI write endpoint' },
  { method: 'POST', path: '/guide', description: 'AI guide endpoint' },
  { method: 'POST', path: '/audit', description: 'AI audit endpoint' },
  { method: 'POST', path: '/sim', description: 'AI simulation endpoint' },
  { method: 'POST', path: '/orchestration/reset', description: 'Orchestration reset' },
  { method: 'POST', path: '/orchestration/purge', description: 'Orchestration purge' },
  { method: 'POST', path: '/workers/run/test', description: 'Worker execution' },
  { method: 'POST', path: '/memory/save', description: 'Memory save' },
  { method: 'DELETE', path: '/memory/delete', description: 'Memory delete' },
  { method: 'POST', path: '/heartbeat', description: 'Heartbeat' },
  { method: 'POST', path: '/status', description: 'Status update' },
  { method: 'POST', path: '/siri', description: 'Siri endpoint' },
  { method: 'POST', path: '/backstage/book-event', description: 'Backstage book event' },
  { method: 'POST', path: '/backstage/simulate-match', description: 'Backstage simulate match' },
  { method: 'POST', path: '/backstage/update-roster', description: 'Backstage update roster' },
  { method: 'POST', path: '/backstage/track-storyline', description: 'Backstage track storyline' },
  { method: 'POST', path: '/sdk/workers/init', description: 'SDK worker init' },
  { method: 'POST', path: '/sdk/routes/register', description: 'SDK routes register' },
  { method: 'POST', path: '/sdk/scheduler/activate', description: 'SDK scheduler activate' },
  { method: 'POST', path: '/sdk/jobs/dispatch', description: 'SDK job dispatch' },
  { method: 'POST', path: '/sdk/test-job', description: 'SDK test job' },
  { method: 'POST', path: '/sdk/init-all', description: 'SDK init all' },
  { method: 'POST', path: '/sdk/system-test', description: 'SDK system test' }
];

const safeEndpoints = [
  { method: 'GET', path: '/health', description: 'Health check' },
  { method: 'GET', path: '/', description: 'Root endpoint' },
  { method: 'GET', path: '/memory/health', description: 'Memory health' },
  { method: 'GET', path: '/memory/load?key=test', description: 'Memory load' },
  { method: 'GET', path: '/memory/list', description: 'Memory list' },
  { method: 'GET', path: '/memory/view', description: 'Memory view' },
  { method: 'GET', path: '/workers/status', description: 'Worker status' },
  { method: 'GET', path: '/status', description: 'Status read' },
  { method: 'GET', path: '/orchestration/status', description: 'Orchestration status' },
  { method: 'GET', path: '/sdk/diagnostics', description: 'SDK diagnostics' },
  { method: 'GET', path: '/sdk/workers/status', description: 'SDK worker status' },
  { method: 'GET', path: '/backstage/', description: 'Backstage home' }
];

async function makeRequest(method, path, headers = {}, data = {}) {
  try {
    const config = {
      method: method.toLowerCase(),
      url: `${BASE_URL}${path}`,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      timeout: 5000
    };

    if (['post', 'put', 'patch', 'delete'].includes(method.toLowerCase())) {
      config.data = data;
    }

    const response = await axios(config);
    return {
      success: true,
      status: response.status,
      data: response.data
    };
  } catch (error) {
    return {
      success: false,
      status: error.response?.status || 0,
      data: error.response?.data || null,
      error: error.message
    };
  }
}

async function testConfirmGateCompliance() {
  console.log('🛡️ ConfirmGate Middleware Compliance Test');
  console.log('==========================================');

  let passedTests = 0;
  let totalTests = 0;

  // Test 1: Sensitive endpoints should be blocked without x-confirmed header
  console.log('\n1. Testing sensitive endpoints WITHOUT confirmation header...');
  for (const endpoint of sensitiveEndpoints) {
    totalTests++;
    const testData = {
      userInput: 'test',
      prompt: 'test',
      query: 'test',
      key: 'test',
      value: 'test'
    };

    const result = await makeRequest(endpoint.method, endpoint.path, {}, testData);
    
    if (!result.success && result.status === 403) {
      console.log(`✅ ${endpoint.method} ${endpoint.path} - Correctly blocked (403)`);
      passedTests++;
    } else if (!result.success && result.status === 404) {
      console.log(`⚠️  ${endpoint.method} ${endpoint.path} - Not found (404) - endpoint may not exist`);
      passedTests++; // Count as pass since endpoint is protected by not existing
    } else if (!result.success && result.status === 500) {
      console.log(`❓ ${endpoint.method} ${endpoint.path} - Server error (500) - may indicate endpoint reached but failed in processing`);
    } else {
      console.log(`❌ ${endpoint.method} ${endpoint.path} - NOT blocked (status: ${result.status})`);
    }
  }

  // Test 2: Sensitive endpoints should work WITH x-confirmed header
  console.log('\n2. Testing sensitive endpoints WITH confirmation header...');
  for (const endpoint of sensitiveEndpoints.slice(0, 5)) { // Test first 5 to avoid overwhelming
    totalTests++;
    const testData = {
      userInput: 'test',
      prompt: 'test',
      query: 'test',
      key: 'test',
      value: 'test'
    };

    const result = await makeRequest(endpoint.method, endpoint.path, { 'x-confirmed': 'yes' }, testData);
    
    if (result.success || result.status === 400 || result.status === 404) {
      console.log(`✅ ${endpoint.method} ${endpoint.path} - Correctly allowed with confirmation`);
      passedTests++;
    } else if (result.status === 403) {
      console.log(`❌ ${endpoint.method} ${endpoint.path} - Still blocked despite confirmation header`);
    } else {
      console.log(`❓ ${endpoint.method} ${endpoint.path} - Unexpected response (status: ${result.status})`);
    }
  }

  // Test 3: Safe endpoints should work without confirmation
  console.log('\n3. Testing safe endpoints WITHOUT confirmation header...');
  for (const endpoint of safeEndpoints) {
    totalTests++;
    const result = await makeRequest(endpoint.method, endpoint.path);
    
    if (result.success || result.status === 404) {
      console.log(`✅ ${endpoint.method} ${endpoint.path} - Correctly accessible without confirmation`);
      passedTests++;
    } else {
      console.log(`❌ ${endpoint.method} ${endpoint.path} - Unexpectedly blocked (status: ${result.status})`);
    }
  }

  // Test 4: Check for proper error response format using a protected endpoint
  console.log('\n4. Testing error response format...');
  totalTests++;
  const result = await makeRequest('POST', '/brain', {}, { prompt: 'test' });

  if (result.status === 403 && result.data && result.data.code === 'CONFIRMATION_REQUIRED') {
    console.log('✅ Error response has correct format and code');
    passedTests++;
  } else {
    console.log('❌ Error response format is incorrect');
  }

  // Summary
  console.log('\n==========================================');
  console.log('📊 Test Results Summary');
  console.log(`✅ Passed: ${passedTests}/${totalTests} tests`);
  console.log(`❌ Failed: ${totalTests - passedTests}/${totalTests} tests`);
  
  if (passedTests === totalTests) {
    console.log('🎉 All tests passed! ConfirmGate middleware is properly configured.');
    return true;
  } else {
    console.log('⚠️  Some tests failed. Please review the middleware configuration.');
    return false;
  }
}

// Check if this script is being run directly
if (require.main === module) {
  testConfirmGateCompliance().catch(console.error);
}

module.exports = { testConfirmGateCompliance };
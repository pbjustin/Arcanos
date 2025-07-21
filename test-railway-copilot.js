#!/usr/bin/env node

// Test script for /query-finetune endpoint
// Tests the new Railway + GitHub Copilot compatible endpoint

const axios = require('axios');

const BASE_URL = 'http://localhost:8080';

async function testEndpoint(url, method, data = null, description) {
  console.log(`\nTesting: ${description}`);
  console.log(`Endpoint: ${method} ${url}`);
  
  try {
    const config = {
      method,
      url,
      timeout: 10000
    };
    
    if (data) {
      config.data = data;
      config.headers = { 'Content-Type': 'application/json' };
    }
    
    const response = await axios(config);
    console.log(`✅ Success (HTTP ${response.status})`);
    console.log('Response:', JSON.stringify(response.data, null, 2));
    return true;
  } catch (error) {
    if (error.response) {
      console.log(`❌ Failed (HTTP ${error.response.status})`);
      console.log('Response:', JSON.stringify(error.response.data, null, 2));
    } else if (error.code === 'ECONNREFUSED') {
      console.log(`❌ Failed (Connection refused - server not running)`);
    } else {
      console.log(`❌ Failed (${error.message})`);
    }
    return false;
  }
}

async function runTests() {
  console.log('==================================================');
  console.log('     ARCANOS Railway + Copilot Integration Tests');
  console.log('==================================================');

  // Test health check
  await testEndpoint(`${BASE_URL}/health`, 'GET', null, 'Health Check');

  // Test new /query-finetune endpoint
  await testEndpoint(
    `${BASE_URL}/query-finetune`, 
    'POST', 
    { 
      query: "What is ARCANOS?",
      metadata: { source: "test-script" }
    },
    'Query Fine-tuned Model (Primary Endpoint)'
  );

  // Test fallback /ask endpoint
  await testEndpoint(
    `${BASE_URL}/ask`, 
    'POST', 
    { 
      query: "Test fallback logic",
      mode: "logic"
    },
    'Ask Endpoint (Fallback Route)'
  );

  // Test API info
  await testEndpoint(`${BASE_URL}/api`, 'GET', null, 'API Information');

  // Test error handling
  await testEndpoint(
    `${BASE_URL}/query-finetune`, 
    'POST', 
    { /* missing query field */ },
    'Error Handling - Missing Query'
  );

  console.log('\n==================================================');
  console.log('                 Test Summary');
  console.log('==================================================');
  console.log('');
  console.log('✅ Green tests: Passed successfully');
  console.log('❌ Red tests: Failed (server not running or missing API key)');
  console.log('');
  console.log('Note: /query-finetune endpoint requires OPENAI_API_KEY');
  console.log('and FINE_TUNED_MODEL to be configured in .env');
  console.log('');
  console.log('To run the server:');
  console.log('1. Copy .env.example to .env');
  console.log('2. Add your OpenAI API key');
  console.log('3. npm run build && npm start');
  console.log('==================================================');
}

runTests().catch(console.error);
// Test script for AI-controlled backend
// Tests that all requests are routed through the AI dispatcher

const axios = require('axios');

const BASE_URL = 'http://localhost:8080';

async function testAIControlledBackend() {
  console.log('🧪 Testing AI-controlled backend...\n');

  // Test 1: Main POST endpoint
  try {
    console.log('1. Testing main POST endpoint...');
    const response = await axios.post(`${BASE_URL}/`, {
      message: 'Hello, test the AI dispatcher system'
    });
    console.log('✅ Main endpoint response:', response.data);
  } catch (error) {
    console.log('❌ Main endpoint error:', error.response?.data || error.message);
  }

  console.log('\n');

  // Test 2: /ask endpoint
  try {
    console.log('2. Testing /ask endpoint...');
    const response = await axios.post(`${BASE_URL}/ask`, {
      query: 'Test AI control for ask endpoint',
      mode: 'logic'
    });
    console.log('✅ Ask endpoint response:', response.data);
  } catch (error) {
    console.log('❌ Ask endpoint error:', error.response?.data || error.message);
  }

  console.log('\n');

  // Test 3: /query-finetune endpoint
  try {
    console.log('3. Testing /query-finetune endpoint...');
    const response = await axios.post(`${BASE_URL}/query-finetune`, {
      query: 'Test AI dispatcher for query-finetune',
      metadata: { test: true }
    });
    console.log('✅ Query-finetune endpoint response:', response.data);
  } catch (error) {
    console.log('❌ Query-finetune endpoint error:', error.response?.data || error.message);
  }

  console.log('\n');

  // Test 4: Health check
  try {
    console.log('4. Testing health endpoint...');
    const response = await axios.get(`${BASE_URL}/health`);
    console.log('✅ Health endpoint response:', response.data);
  } catch (error) {
    console.log('❌ Health endpoint error:', error.response?.data || error.message);
  }

  console.log('\n');

  // Test 5: API endpoints through main router
  try {
    console.log('5. Testing API endpoint through AI router...');
    const response = await axios.post(`${BASE_URL}/api/ask`, {
      message: 'Test API routing through AI dispatcher'
    });
    console.log('✅ API endpoint response:', response.data);
  } catch (error) {
    console.log('❌ API endpoint error:', error.response?.data || error.message);
  }

  console.log('\n🧪 AI-controlled backend testing completed!');
}

// Run if called directly
if (require.main === module) {
  testAIControlledBackend().catch(console.error);
}

module.exports = { testAIControlledBackend };
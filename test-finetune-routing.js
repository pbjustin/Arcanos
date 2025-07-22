#!/usr/bin/env node

// Test script for Fine-Tuned Model Routing Override functionality
// Tests the ARCANOS Shell command: "Force all prompts through my fine-tuned model until I say otherwise"

const axios = require('axios');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';
const TEST_USER_ID = 'test-user-' + Date.now();
const TEST_SESSION_ID = 'test-session-' + Date.now();

console.log('🧪 Testing Fine-Tuned Model Routing Override');
console.log('📍 Server URL:', SERVER_URL);
console.log('👤 Test User ID:', TEST_USER_ID);
console.log('📱 Test Session ID:', TEST_SESSION_ID);
console.log('');

async function makeRequest(message, expectStatus = 200) {
  try {
    const response = await axios.post(`${SERVER_URL}/`, 
      { message },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-User-ID': TEST_USER_ID,
          'X-Session-ID': TEST_SESSION_ID
        }
      }
    );
    
    console.log(`✅ Request successful (${response.status}):`, response.data.substring ? response.data.substring(0, 100) + '...' : response.data);
    return { success: true, data: response.data, status: response.status };
  } catch (error) {
    if (error.response) {
      console.log(`❌ Request failed (${error.response.status}):`, error.response.data);
      return { success: false, data: error.response.data, status: error.response.status };
    } else {
      console.log(`❌ Network error:`, error.message);
      return { success: false, error: error.message };
    }
  }
}

async function checkStatus() {
  try {
    const response = await axios.get(`${SERVER_URL}/finetune-status`, {
      headers: {
        'X-User-ID': TEST_USER_ID,
        'X-Session-ID': TEST_SESSION_ID
      }
    });
    
    console.log('📊 Current Status:', response.data);
    return response.data;
  } catch (error) {
    console.log('❌ Failed to get status:', error.response?.data || error.message);
    return null;
  }
}

async function runTests() {
  console.log('🔍 Step 1: Check initial routing status');
  await checkStatus();
  console.log('');
  
  console.log('🔍 Step 2: Send normal message (should use intent-based routing)');
  await makeRequest('Hello, how are you?');
  console.log('');
  
  console.log('🔍 Step 3: Activate fine-tune routing override');
  await makeRequest('Force all prompts through my fine-tuned model until I say otherwise');
  console.log('');
  
  console.log('🔍 Step 4: Check status after activation');
  await checkStatus();
  console.log('');
  
  console.log('🔍 Step 5: Send message while override is active (should use fine-tuned model)');
  await makeRequest('Tell me a story about a robot');
  console.log('');
  
  console.log('🔍 Step 6: Send another message while override is active');
  await makeRequest('What is the weather like?');
  console.log('');
  
  console.log('🔍 Step 7: Deactivate fine-tune routing override');
  await makeRequest('Stop using fine-tuned model');
  console.log('');
  
  console.log('🔍 Step 8: Check status after deactivation');
  await checkStatus();
  console.log('');
  
  console.log('🔍 Step 9: Send message after deactivation (should use intent-based routing again)');
  await makeRequest('Hello again, how are you?');
  console.log('');
  
  console.log('✅ All tests completed!');
}

// Run the tests
runTests().catch(error => {
  console.error('❌ Test execution failed:', error);
  process.exit(1);
});
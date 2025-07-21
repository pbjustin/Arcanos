// Test for copilot router functionality
const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

async function testCopilotRouter() {
  console.log('🧪 Testing Copilot Router Functionality...\n');

  try {
    // Test 1: Normal query (should go to finetune)
    console.log('Test 1: Normal query (finetune route)');
    const normalQuery = {
      query: 'What is the meaning of life?',
      mode: 'logic'
    };
    
    const response1 = await axios.post(`${BASE_URL}/copilot/query`, normalQuery);
    console.log('✅ Normal query response:', response1.data);
    console.log('');

    // Test 2: Fallback query with --fallback (should go to core)
    console.log('Test 2: Fallback query with --fallback (core route)');
    const fallbackQuery1 = {
      query: 'What is the meaning of life? --fallback',
      mode: 'logic'
    };
    
    const response2 = await axios.post(`${BASE_URL}/copilot/query`, fallbackQuery1);
    console.log('✅ Fallback query response:', response2.data);
    console.log('');

    // Test 3: Fallback query with ::default (should go to core)
    console.log('Test 3: Fallback query with ::default (core route)');
    const fallbackQuery2 = {
      query: 'What is the meaning of life? ::default',
      mode: 'logic'
    };
    
    const response3 = await axios.post(`${BASE_URL}/copilot/query`, fallbackQuery2);
    console.log('✅ Fallback query response:', response3.data);
    console.log('');

    // Test 4: Missing query field (should return error)
    console.log('Test 4: Missing query field (should return error)');
    try {
      const response4 = await axios.post(`${BASE_URL}/copilot/query`, { mode: 'logic' });
      console.log('❌ Should have failed, but got:', response4.data);
    } catch (error) {
      if (error.response && error.response.status === 400) {
        console.log('✅ Correctly returned 400 error:', error.response.data);
      } else {
        console.log('❌ Unexpected error:', error.message);
      }
    }

    console.log('\n🎉 All copilot router tests completed!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
  }
}

// Check if server is running, if not start it first
async function checkServerAndTest() {
  try {
    await axios.get(`${BASE_URL}/health`);
    console.log('✅ Server is running, proceeding with tests...\n');
    await testCopilotRouter();
  } catch (error) {
    console.log('❌ Server not running. Please start the server first with: npm start');
    console.log('Then run this test again.');
  }
}

checkServerAndTest();
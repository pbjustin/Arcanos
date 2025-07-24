#!/usr/bin/env node

// Test for ChatGPT-User middleware functionality
const axios = require('axios');

const BASE_URL = 'http://localhost:8080';
const CHATGPT_USER_AGENT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot';

async function testChatGPTUserMiddleware() {
  console.log('==================================================');
  console.log('     ARCANOS ChatGPT-User Middleware Test');
  console.log('==================================================');

  try {
    console.log('\n1. Testing health endpoint...');
    const healthResponse = await axios.get(`${BASE_URL}/health`);
    console.log('✅ Health check passed:', healthResponse.data);

    console.log('\n2. Testing normal user agent request...');
    const normalResponse = await axios.get(`${BASE_URL}/health`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    console.log('✅ Normal user agent request succeeded');

    console.log('\n3. Testing ChatGPT-User agent GET request...');
    const chatgptGetResponse = await axios.get(`${BASE_URL}/health`, {
      headers: {
        'User-Agent': CHATGPT_USER_AGENT
      }
    });
    console.log('✅ ChatGPT-User GET request succeeded');
    console.log('Verification header:', chatgptGetResponse.headers['x-verification-status'] || 'None');

    console.log('\n4. Testing ChatGPT-User agent POST request (should be denied by default)...');
    try {
      await axios.post(`${BASE_URL}/`, {
        message: 'Test from ChatGPT-User'
      }, {
        headers: {
          'User-Agent': CHATGPT_USER_AGENT,
          'Content-Type': 'application/json'
        }
      });
      console.log('⚠️ ChatGPT-User POST request was allowed (middleware may not be active)');
    } catch (error) {
      if (error.response && error.response.status === 405) {
        console.log('✅ ChatGPT-User POST request properly denied with 405');
      } else {
        console.log('❓ ChatGPT-User POST request failed with status:', error.response?.status || 'Network error');
      }
    }

    console.log('\n5. Testing diagnostics endpoint...');
    try {
      // Try to access a diagnostic endpoint that might show middleware status
      const diagnosticsResponse = await axios.get(`${BASE_URL}/diagnostic`);
      console.log('✅ Diagnostics endpoint accessible');
    } catch (error) {
      console.log('❓ Diagnostics endpoint not accessible or requires auth');
    }

    console.log('\n6. Testing rate limiting with multiple requests...');
    const promises = [];
    for (let i = 0; i < 15; i++) {
      promises.push(
        axios.get(`${BASE_URL}/health`, {
          headers: { 'User-Agent': CHATGPT_USER_AGENT }
        }).catch(err => ({ error: err.response?.status }))
      );
    }
    
    const results = await Promise.all(promises);
    const rateLimited = results.filter(r => r.error === 429).length;
    
    if (rateLimited > 0) {
      console.log(`✅ Rate limiting working: ${rateLimited} requests rate limited`);
    } else {
      console.log('❓ No rate limiting detected (may be disabled or not active)');
    }

    console.log('\n==================================================');
    console.log('     ChatGPT-User Middleware Test Complete');
    console.log('==================================================');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.error('Make sure the server is running on', BASE_URL);
    }
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Test interrupted');
  process.exit(0);
});

if (require.main === module) {
  testChatGPTUserMiddleware().catch(console.error);
}

module.exports = { testChatGPTUserMiddleware };
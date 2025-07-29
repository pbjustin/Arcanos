#!/usr/bin/env node

// Extended test for ChatGPT-User middleware with POST method validation
const axios = require('axios');

const BASE_URL = 'http://localhost:8080';
const CHATGPT_USER_AGENT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot';

async function testPostDenial() {
  console.log('==================================================');
  console.log('   ChatGPT-User POST Method Denial Test');
  console.log('==================================================');

  try {
    console.log('\n1. Testing POST request with ChatGPT-User agent (should be denied)...');
    
    try {
      const response = await axios.post(`${BASE_URL}/`, {
        message: 'Test message from ChatGPT-User'
      }, {
        headers: {
          'User-Agent': CHATGPT_USER_AGENT,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      });
      
      console.log('❌ POST request was unexpectedly allowed');
      console.log('Response status:', response.status);
      console.log('Response data:', response.data);
      
    } catch (error) {
      if (error.response) {
        if (error.response.status === 405) {
          console.log('✅ POST request properly denied with status 405');
          console.log('Response data:', error.response.data);
        } else {
          console.log(`❓ POST request failed with unexpected status: ${error.response.status}`);
          console.log('Response data:', error.response.data);
        }
      } else {
        console.log('❌ Network or other error:', error.message);
      }
    }

    console.log('\n2. Testing PUT request with ChatGPT-User agent (should be denied)...');
    
    try {
      await axios.put(`${BASE_URL}/test`, {
        data: 'test'
      }, {
        headers: {
          'User-Agent': CHATGPT_USER_AGENT,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      });
      
      console.log('❌ PUT request was unexpectedly allowed');
      
    } catch (error) {
      if (error.response && error.response.status === 405) {
        console.log('✅ PUT request properly denied with status 405');
      } else {
        console.log(`❓ PUT request failed with status: ${error.response?.status || 'Network error'}`);
      }
    }

    console.log('\n3. Testing POST request with normal user agent (should be allowed)...');
    
    try {
      const response = await axios.post(`${BASE_URL}/`, {
        message: 'Test message from normal user'
      }, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Content-Type': 'application/json'
        },
        timeout: 5000
      });
      
      console.log('✅ Normal user agent POST request allowed');
      console.log('Response status:', response.status);
      
    } catch (error) {
      console.log('❓ Normal user agent POST failed:', error.response?.status || error.message);
    }

    console.log('\n4. Checking middleware diagnostics...');
    
    try {
      const diagnostics = await axios.get(`${BASE_URL}/chatgpt-user-status`);
      console.log('✅ Middleware diagnostics:');
      console.log('  - Enabled:', diagnostics.data.enabled);
      console.log('  - IP Prefixes:', diagnostics.data.whitelist.prefixCount);
      console.log('  - Cache Fresh:', !diagnostics.data.whitelist.isStale);
      console.log('  - Rate Limited IPs:', diagnostics.data.rateLimit.activeIPs);
      
    } catch (error) {
      console.log('❌ Failed to get diagnostics:', error.message);
    }

    console.log('\n==================================================');
    console.log('   ChatGPT-User POST Denial Test Complete');
    console.log('==================================================');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  testPostDenial().catch(console.error);
}

module.exports = { testPostDenial };
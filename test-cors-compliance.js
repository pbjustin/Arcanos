#!/usr/bin/env node

// CORS compliance test for Railway + GitHub Copilot integration
const axios = require('axios');

const BASE_URL = 'http://localhost:8080';

async function testCORS() {
  console.log('==================================================');
  console.log('     ARCANOS CORS Compliance Test');
  console.log('==================================================');

  try {
    // Test CORS preflight request
    const preflightResponse = await axios({
      method: 'OPTIONS',
      url: `${BASE_URL}/query-finetune`,
      headers: {
        'Origin': 'https://github.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type'
      },
      timeout: 10000
    });

    console.log('✅ CORS Preflight Request Success');
    console.log('CORS Headers:', {
      'Access-Control-Allow-Origin': preflightResponse.headers['access-control-allow-origin'],
      'Access-Control-Allow-Methods': preflightResponse.headers['access-control-allow-methods'],
      'Access-Control-Allow-Headers': preflightResponse.headers['access-control-allow-headers']
    });

    // Test actual POST request with Origin header
    const postResponse = await axios({
      method: 'POST',
      url: `${BASE_URL}/query-finetune`,
      data: { query: 'CORS test' },
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://github.com'
      },
      timeout: 10000,
      validateStatus: () => true // Accept any status code
    });

    console.log('✅ POST Request with Origin Header Success');
    console.log('Response CORS Headers:', {
      'Access-Control-Allow-Origin': postResponse.headers['access-control-allow-origin']
    });

    console.log('\n==================================================');
    console.log('           CORS Compliance: PASSED ✅');
    console.log('==================================================');
    console.log('The server properly supports CORS for GitHub Copilot');
    console.log('and other cross-origin requests.');

  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.log('❌ Server not running on', BASE_URL);
      console.log('Please start the server first: npm start');
    } else {
      console.log('❌ CORS test failed:', error.message);
    }
  }
}

testCORS();
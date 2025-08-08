#!/usr/bin/env node
/**
 * Test script for memory viewer endpoint
 */

import http from 'http';
import fs from 'fs';

const PORT = process.env.PORT || 8080;

/**
 * Get environment-appropriate log path
 */
function getEnvironmentLogPath() {
  const logDir = process.env.ARC_LOG_PATH || '/tmp/arc/log';
  if (process.env.NODE_ENV === 'production') {
    return `${logDir}/session.log`;
  } else {
    return './memory/session.log';
  }
}

const MEMORY_PATH = getEnvironmentLogPath();

async function testMemoryEndpoint() {
  console.log('🧪 Testing ARCANOS Memory Viewer');
  console.log('=====================================');

  // Test 1: Check if memory endpoint returns log content when file exists
  console.log('📝 Test 1: Memory endpoint with existing log file');
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: '/memory/view',
      method: 'GET'
    };

    const req = http.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('✅ Status: 200 OK');
          console.log('✅ Content-Type:', res.headers['content-type']);
          console.log('✅ Response received:');
          console.log(data);
          console.log('✅ Test 1 PASSED');
          resolve();
        } else {
          console.log('❌ Unexpected status:', res.statusCode);
          console.log('❌ Response:', data);
          reject(new Error(`Test failed with status ${res.statusCode}`));
        }
      });
    });

    req.on('error', (err) => {
      console.log('❌ Request error:', err.message);
      reject(err);
    });

    req.end();
  });
}

// Run the test
testMemoryEndpoint()
  .then(() => {
    console.log('\n🎉 All tests passed!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n💥 Test failed:', err.message);
    process.exit(1);
  });
#!/usr/bin/env node

// Test script for the askArcanosV1_Safe function
// This tests the exact functionality specified in the problem statement

const http = require('http');

const PORT = process.env.PORT || 8080;
const BASE_URL = `http://localhost:${PORT}`;

// Test cases for the askArcanosV1_Safe function
const testCases = [
  {
    name: "Test V1 Safe with missing model (should return fallback blocked)",
    method: "POST",
    path: "/api/ask-v1-safe",
    body: JSON.stringify({
      message: "Hello world",
      domain: "general",
      useRAG: true,
      useHRC: true
    }),
    headers: {
      "Content-Type": "application/json"
    },
    expectedStatus: 200,
    expectedResponseContains: "❌ Error: No active model found. Fallback blocked."
  },
  {
    name: "Test V1 Safe with missing message (should return 400)",
    method: "POST",
    path: "/api/ask-v1-safe",
    body: JSON.stringify({
      domain: "general"
    }),
    headers: {
      "Content-Type": "application/json"
    },
    expectedStatus: 400,
    expectedErrorContains: "Message is required"
  }
];

async function runTest(testCase) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: testCase.path,
      method: testCase.method,
      headers: testCase.headers
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          const result = {
            name: testCase.name,
            status: res.statusCode,
            response,
            passed: res.statusCode === testCase.expectedStatus &&
                   (testCase.expectedResponseContains ? 
                    response.response?.includes(testCase.expectedResponseContains) : true) &&
                   (testCase.expectedErrorContains ? 
                    response.error?.includes(testCase.expectedErrorContains) : true)
          };
          resolve(result);
        } catch (error) {
          reject({ name: testCase.name, error: error.message, data });
        }
      });
    });

    req.on('error', (error) => {
      reject({ name: testCase.name, error: error.message });
    });

    if (testCase.body) {
      req.write(testCase.body);
    }
    req.end();
  });
}

async function waitForServer() {
  const maxRetries = 10;
  const retryDelay = 1000;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`${BASE_URL}/health`, (res) => {
          resolve(res);
        });
        req.on('error', reject);
        req.setTimeout(1000, () => reject(new Error('Timeout')));
      });
      console.log('✅ Server is ready');
      return true;
    } catch (error) {
      console.log(`⏳ Waiting for server... (attempt ${i + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
  
  throw new Error('Server did not start within the expected time');
}

async function main() {
  console.log('🧪 Testing askArcanosV1_Safe implementation...\n');

  try {
    await waitForServer();
  } catch (error) {
    console.error('❌ Server is not running. Please start the server first.');
    process.exit(1);
  }

  for (const testCase of testCases) {
    try {
      console.log(`Running: ${testCase.name}`);
      const result = await runTest(testCase);
      
      if (result.passed) {
        console.log(`✅ PASSED: ${result.name}`);
        console.log(`   Status: ${result.status}, Response: ${JSON.stringify(result.response)}\n`);
      } else {
        console.log(`❌ FAILED: ${result.name}`);
        console.log(`   Expected status: ${testCase.expectedStatus}, Got: ${result.status}`);
        console.log(`   Response: ${JSON.stringify(result.response)}\n`);
      }
    } catch (error) {
      console.log(`❌ ERROR: ${error.name || 'Unknown test'}`);
      console.log(`   ${error.error}\n`);
    }
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { runTest, testCases };
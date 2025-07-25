#!/usr/bin/env node

/**
 * Test script for ARCANOS API endpoints with token authentication
 */

const axios = require('axios');

const BASE_URL = process.env.TEST_URL || 'http://localhost:8080';
const TEST_TOKEN = process.env.ARCANOS_API_TOKEN || 'test-token-123';

// Define ARCANOS routing endpoints that should require authentication
const ARCANOS_ENDPOINTS = [
  { path: '/memory', method: 'POST', body: { action: 'test' } },
  { path: '/audit', method: 'POST', body: { action: 'test' } },
  { path: '/diagnostic', method: 'GET' },
  { path: '/write', method: 'POST', body: { content: 'test' } },
  { path: '/ask', method: 'POST', body: { message: 'test' } },
  { path: '/query-finetune', method: 'POST', body: { query: 'test' } },
  { path: '/audit-logs', method: 'GET' },
  { path: '/api/memory/save', method: 'POST', body: { memory_key: 'test', memory_value: 'test' } },
  { path: '/api/memory/load', method: 'GET', params: '?key=test' },
];

// Define public endpoints that should NOT require authentication
const PUBLIC_ENDPOINTS = [
  { path: '/health', method: 'GET' },
  { path: '/performance', method: 'GET' },
  { path: '/route-status', method: 'GET' },
];

async function testEndpoint(endpoint, withAuth = false) {
  const url = `${BASE_URL}${endpoint.path}${endpoint.params || ''}`;
  const config = {
    method: endpoint.method,
    url,
    timeout: 5000,
    validateStatus: () => true, // Don't throw on error status codes
  };

  if (endpoint.body) {
    config.data = endpoint.body;
  }

  if (withAuth) {
    config.headers = {
      'Authorization': `Bearer ${TEST_TOKEN}`,
      'Content-Type': 'application/json'
    };
  }

  try {
    const response = await axios(config);
    return {
      success: true,
      status: response.status,
      url,
      auth: withAuth,
      data: response.data
    };
  } catch (error) {
    return {
      success: false,
      status: error.response?.status || 0,
      url,
      auth: withAuth,
      error: error.message,
      data: error.response?.data
    };
  }
}

async function testTokenAuthentication() {
  console.log('🔐 Testing ARCANOS API Token Authentication');
  console.log('━'.repeat(50));
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Test Token: ${TEST_TOKEN.substring(0, 8)}...`);

  // Test 1: Public endpoints (should work without auth)
  console.log('\n1️⃣ Testing public endpoints (no auth required)...');
  for (const endpoint of PUBLIC_ENDPOINTS) {
    const result = await testEndpoint(endpoint, false);
    const status = result.status === 200 ? '✅' : '❌';
    console.log(`${status} ${endpoint.method} ${endpoint.path} - Status: ${result.status}`);
  }

  // Test 2: Protected endpoints without auth (should fail)
  console.log('\n2️⃣ Testing ARCANOS endpoints without auth (should fail)...');
  for (const endpoint of ARCANOS_ENDPOINTS) {
    const result = await testEndpoint(endpoint, false);
    const status = result.status === 403 || result.status === 500 ? '✅' : '❌';
    console.log(`${status} ${endpoint.method} ${endpoint.path} - Status: ${result.status}`);
    
    if (result.data && (result.status === 403 || result.status === 500)) {
      if (result.data.error && result.data.error.includes('ARCANOS_API_TOKEN')) {
        console.log('    📋 Correctly requiring ARCANOS_API_TOKEN');
      }
    }
  }

  // Test 3: Protected endpoints with invalid auth (should fail)
  console.log('\n3️⃣ Testing ARCANOS endpoints with invalid auth (should fail)...');
  const invalidConfig = {
    method: 'POST',
    url: `${BASE_URL}/api/memory/save`,
    headers: {
      'Authorization': 'Bearer invalid-token',
      'Content-Type': 'application/json'
    },
    data: { memory_key: 'test', memory_value: 'test' },
    timeout: 5000,
    validateStatus: () => true
  };

  try {
    const response = await axios(invalidConfig);
    const status = response.status === 403 ? '✅' : '❌';
    console.log(`${status} POST /api/memory/save with invalid token - Status: ${response.status}`);
    if (response.data) {
      console.log(`    📋 Response: ${JSON.stringify(response.data).substring(0, 100)}...`);
    }
  } catch (error) {
    console.log(`❌ Request failed: ${error.message}`);
  }

  // Test 4: Mock Railway environment behavior
  console.log('\n4️⃣ Testing Railway environment detection...');
  const originalEnv = process.env.RAILWAY_ENVIRONMENT;
  process.env.RAILWAY_ENVIRONMENT = 'production';
  
  // Import and test the validator
  try {
    const { EnvTokenValidator } = require('./dist/utils/env-token-validator');
    const isRailway = EnvTokenValidator.isRailwayEnvironment();
    console.log(`✅ Railway environment detected: ${isRailway}`);
  } catch (error) {
    console.log(`❌ Could not test Railway detection: ${error.message}`);
  }

  // Restore environment
  if (originalEnv) {
    process.env.RAILWAY_ENVIRONMENT = originalEnv;
  } else {
    delete process.env.RAILWAY_ENVIRONMENT;
  }

  console.log('\n✅ Authentication tests completed!');
  console.log('\n📋 Summary:');
  console.log('  - Public endpoints should be accessible without authentication');
  console.log('  - ARCANOS routing endpoints should require valid token');
  console.log('  - Railway environment detection should work correctly');
  console.log('  - Invalid tokens should be rejected with 403 status');
}

testTokenAuthentication().catch(console.error);
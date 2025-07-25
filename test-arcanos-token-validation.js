#!/usr/bin/env node

/**
 * Test script for ARCANOS_API_TOKEN validation on Railway environment
 */

const { EnvTokenValidator } = require('./dist/utils/env-token-validator');

async function testTokenValidation() {
  console.log('🧪 Testing ARCANOS_API_TOKEN Validation for Railway Environment');
  console.log('━'.repeat(60));

  // Test 1: Check Railway environment detection
  console.log('\n1️⃣ Testing Railway environment detection...');
  const isRailway = EnvTokenValidator.isRailwayEnvironment();
  console.log(`Railway Environment Detected: ${isRailway}`);
  
  if (process.env.RAILWAY_ENVIRONMENT) {
    console.log(`✅ RAILWAY_ENVIRONMENT: ${process.env.RAILWAY_ENVIRONMENT}`);
  }
  if (process.env.RAILWAY_PROJECT) {
    console.log(`✅ RAILWAY_PROJECT: ${process.env.RAILWAY_PROJECT}`);
  }

  // Test 2: Token validation
  console.log('\n2️⃣ Testing token validation...');
  const validation = await EnvTokenValidator.validateToken();
  console.log('Validation Result:', {
    isValid: validation.isValid,
    isRailway: validation.isRailway,
    tokenExists: validation.tokenExists,
    requiresUpdate: validation.requiresUpdate
  });
  console.log(`Message: ${validation.message}`);

  // Test 3: Token generation
  console.log('\n3️⃣ Testing secure token generation...');
  const token1 = EnvTokenValidator.generateSecureToken();
  const token2 = EnvTokenValidator.generateSecureToken();
  console.log(`Generated Token 1: ${token1}`);
  console.log(`Generated Token 2: ${token2}`);
  console.log(`Tokens are different: ${token1 !== token2}`);
  console.log(`Token length: ${token1.length} characters`);

  // Test 4: Configuration status
  console.log('\n4️⃣ Current environment status...');
  const currentToken = process.env.ARCANOS_API_TOKEN;
  console.log(`Current ARCANOS_API_TOKEN exists: ${!!currentToken}`);
  if (currentToken) {
    console.log(`Current token length: ${currentToken.length} characters`);
    console.log(`Token starts with: ${currentToken.substring(0, 8)}...`);
  }

  // Test 5: Mock Railway environment test
  console.log('\n5️⃣ Testing with mocked Railway environment...');
  const originalEnv = process.env.RAILWAY_ENVIRONMENT;
  const originalToken = process.env.ARCANOS_API_TOKEN;
  
  // Mock Railway without token
  process.env.RAILWAY_ENVIRONMENT = 'production';
  delete process.env.ARCANOS_API_TOKEN;
  
  const mockValidation = await EnvTokenValidator.validateToken();
  console.log('Mock Railway Validation:', {
    isValid: mockValidation.isValid,
    requiresUpdate: mockValidation.requiresUpdate,
    message: mockValidation.message
  });

  // Restore environment
  if (originalEnv) {
    process.env.RAILWAY_ENVIRONMENT = originalEnv;
  } else {
    delete process.env.RAILWAY_ENVIRONMENT;
  }
  if (originalToken) {
    process.env.ARCANOS_API_TOKEN = originalToken;
  }

  console.log('\n✅ Token validation tests completed!');
  console.log('\n💡 Next steps:');
  console.log('  - Deploy to Railway to test the full prompt flow');
  console.log('  - Verify that protected endpoints require the token');
  console.log('  - Test server reload functionality');
}

testTokenValidation().catch(console.error);
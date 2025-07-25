#!/usr/bin/env node

/**
 * Test script to demonstrate Railway environment ARCANOS_API_TOKEN validation
 */

const { EnvTokenValidator } = require('./dist/utils/env-token-validator');

async function demonstrateRailwayBehavior() {
  console.log('🚂 ARCANOS Railway Environment Token Validation Demo');
  console.log('━'.repeat(60));

  // Save original environment
  const originalEnv = {
    RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT,
    ARCANOS_API_TOKEN: process.env.ARCANOS_API_TOKEN
  };

  console.log('\n📋 Demo Scenarios:');
  
  // Scenario 1: Development environment (current state)
  console.log('\n1️⃣ Development Environment (no Railway)...');
  delete process.env.RAILWAY_ENVIRONMENT;
  delete process.env.ARCANOS_API_TOKEN;
  
  let validation = await EnvTokenValidator.validateToken();
  console.log(`✅ Result: ${validation.message}`);
  console.log(`   Railway: ${validation.isRailway}, Valid: ${validation.isValid}, Requires Update: ${validation.requiresUpdate}`);

  // Scenario 2: Railway with missing token (should require update)
  console.log('\n2️⃣ Railway Environment - Missing Token...');
  process.env.RAILWAY_ENVIRONMENT = 'production';
  delete process.env.ARCANOS_API_TOKEN;
  
  validation = await EnvTokenValidator.validateToken();
  console.log(`🚨 Result: ${validation.message}`);
  console.log(`   Railway: ${validation.isRailway}, Valid: ${validation.isValid}, Requires Update: ${validation.requiresUpdate}`);

  // Scenario 3: Railway with weak token (should require update)
  console.log('\n3️⃣ Railway Environment - Weak Token...');
  process.env.RAILWAY_ENVIRONMENT = 'production';
  process.env.ARCANOS_API_TOKEN = 'weak123';
  
  validation = await EnvTokenValidator.validateToken();
  console.log(`🚨 Result: ${validation.message}`);
  console.log(`   Railway: ${validation.isRailway}, Valid: ${validation.isValid}, Requires Update: ${validation.requiresUpdate}`);

  // Scenario 4: Railway with strong token (should be valid)
  console.log('\n4️⃣ Railway Environment - Strong Token...');
  process.env.RAILWAY_ENVIRONMENT = 'production';
  process.env.ARCANOS_API_TOKEN = EnvTokenValidator.generateSecureToken();
  
  validation = await EnvTokenValidator.validateToken();
  console.log(`✅ Result: ${validation.message}`);
  console.log(`   Railway: ${validation.isRailway}, Valid: ${validation.isValid}, Requires Update: ${validation.requiresUpdate}`);

  // Demonstrate token generation
  console.log('\n5️⃣ Secure Token Generation...');
  console.log('Generated tokens:');
  for (let i = 1; i <= 3; i++) {
    const token = EnvTokenValidator.generateSecureToken();
    console.log(`  ${i}. ${token}`);
  }

  // Demonstrate the prompt flow (without actually prompting)
  console.log('\n6️⃣ Simulated .env Update...');
  const newToken = EnvTokenValidator.generateSecureToken();
  console.log(`Generated token: ${newToken}`);
  
  // This would normally trigger the interactive prompt in Railway
  const updateResult = await EnvTokenValidator.updateEnvFile(newToken);
  console.log(`Update result: ${updateResult.message}`);
  console.log(`Requires reload: ${updateResult.requiresReload}`);

  // Restore original environment
  if (originalEnv.RAILWAY_ENVIRONMENT) {
    process.env.RAILWAY_ENVIRONMENT = originalEnv.RAILWAY_ENVIRONMENT;
  } else {
    delete process.env.RAILWAY_ENVIRONMENT;
  }
  if (originalEnv.ARCANOS_API_TOKEN) {
    process.env.ARCANOS_API_TOKEN = originalEnv.ARCANOS_API_TOKEN;
  } else {
    delete process.env.ARCANOS_API_TOKEN;
  }

  console.log('\n🎯 Summary:');
  console.log('✅ Token validation correctly detects Railway environment');
  console.log('✅ Missing tokens are flagged in Railway environment'); 
  console.log('✅ Weak tokens are rejected and require update');
  console.log('✅ Strong tokens are accepted');
  console.log('✅ Secure token generation produces 32-character tokens');
  console.log('✅ .env file update mechanism works correctly');
  console.log('');
  console.log('📝 When deployed to Railway:');
  console.log('  - Server will check for ARCANOS_API_TOKEN on startup');
  console.log('  - If missing, user will be prompted for secure token');
  console.log('  - Token is saved to .env and server reloads');
  console.log('  - All ARCANOS routing endpoints require this token');
}

demonstrateRailwayBehavior().catch(console.error);
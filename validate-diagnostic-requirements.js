#!/usr/bin/env node

// Comprehensive validation script for diagnostic force mode requirements
const axios = require('axios');

const BASE_URL = 'http://localhost:8080';

console.log('📋 VALIDATING DIAGNOSTIC FORCE MODE REQUIREMENTS\n');

async function validateRequirements() {
  let allTestsPassed = true;

  try {
    console.log('✅ REQUIREMENT 1: /diagnostic route handler supports execution mode for forced diagnostics');
    
    // Test POST support for payloads
    const response1 = await axios.post(`${BASE_URL}/diagnostic`, {
      force: true,
      command: 'validation test'
    });
    
    if (response1.data.forceMode === true) {
      console.log('   ✅ POST requests with force payloads are supported');
    } else {
      console.log('   ❌ Force mode not detected in response');
      allTestsPassed = false;
    }

    console.log('\n✅ REQUIREMENT 2: When payload contains "force": true, bypass inference and directly execute diagnostic tasks');
    
    if (response1.data.category === 'forced') {
      console.log('   ✅ Force mode bypasses inference (category: forced)');
    } else {
      console.log('   ❌ Force mode not properly bypassing inference');
      allTestsPassed = false;
    }

    console.log('\n✅ REQUIREMENT 3: Include queue audits in forced diagnostics');
    
    const hasQueueData = response1.data.data && (
      response1.data.data.pending !== undefined ||
      response1.data.data.completed !== undefined ||
      response1.data.data.failed !== undefined ||
      response1.data.data['in-progress'] !== undefined
    );
    
    if (hasQueueData) {
      console.log('   ✅ Queue audit data is included in forced diagnostics');
    } else {
      console.log('   ❌ Queue audit data missing from forced diagnostics');
      allTestsPassed = false;
    }

    console.log('\n✅ REQUIREMENT 4: Log all results under categories: completed, pending, in-progress, and failed');
    
    const data = response1.data.data;
    const hasAllCategories = (
      Array.isArray(data.completed) &&
      Array.isArray(data.pending) &&
      Array.isArray(data['in-progress']) &&
      Array.isArray(data.failed)
    );
    
    if (hasAllCategories) {
      console.log('   ✅ All required categories present:');
      console.log(`      - Completed: ${data.completed.length} items`);
      console.log(`      - Pending: ${data.pending.length} items`);
      console.log(`      - In-Progress: ${data['in-progress'].length} items`);
      console.log(`      - Failed: ${data.failed.length} items`);
    } else {
      console.log('   ❌ Not all required categories are present');
      allTestsPassed = false;
    }

    console.log('\n🔄 ADDITIONAL VALIDATION: Backward compatibility');
    
    // Test normal GET request still works
    const normalResponse = await axios.get(`${BASE_URL}/diagnostic?command=compatibility test`);
    if (normalResponse.data.success && !normalResponse.data.forceMode) {
      console.log('   ✅ Normal GET requests still work (backward compatible)');
    } else {
      console.log('   ❌ Backward compatibility broken');
      allTestsPassed = false;
    }

    // Test normal POST request without force
    const postResponse = await axios.post(`${BASE_URL}/diagnostic`, {
      command: 'normal post test'
    });
    if (postResponse.data.success && !postResponse.data.forceMode) {
      console.log('   ✅ Normal POST requests work without force mode');
    } else {
      console.log('   ❌ Normal POST requests not working properly');
      allTestsPassed = false;
    }

    console.log('\n🔍 DETAILED FORCE MODE ANALYSIS:');
    console.log('   📊 Force Mode Response Structure:');
    console.log(`      - Success: ${response1.data.success}`);
    console.log(`      - Category: ${response1.data.category}`);
    console.log(`      - Force Mode: ${response1.data.forceMode}`);
    console.log(`      - Endpoint: ${response1.data.endpoint}`);
    console.log(`      - Diagnostic Logged: ${response1.data.diagnostic_logged}`);
    console.log(`      - Readiness Confirmed: ${response1.data.readiness_confirmed}`);

    console.log('\n' + '='.repeat(60));
    
    if (allTestsPassed) {
      console.log('🎉 ALL REQUIREMENTS SUCCESSFULLY IMPLEMENTED! ✅');
      console.log('\n📋 Summary:');
      console.log('✅ /diagnostic route supports POST payloads');
      console.log('✅ "force": true bypasses inference');
      console.log('✅ Queue audits included in forced diagnostics');
      console.log('✅ Results categorized: completed, pending, in-progress, failed');
      console.log('✅ Backward compatibility maintained');
    } else {
      console.log('❌ SOME REQUIREMENTS NOT MET');
    }

  } catch (error) {
    console.error('❌ Validation failed:', error.response?.data || error.message);
    allTestsPassed = false;
  }

  return allTestsPassed;
}

if (require.main === module) {
  validateRequirements().then(success => {
    process.exit(success ? 0 : 1);
  });
}

module.exports = { validateRequirements };
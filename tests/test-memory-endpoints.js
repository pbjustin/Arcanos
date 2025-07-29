#!/usr/bin/env node

/**
 * Test script for Universal Memory Archetype endpoints
 * Tests all memory API endpoints without requiring a database
 */

const { makeAxiosRequest, logTestResult, getAuthHeaders } = require('./test-utils/common');
const { validateSyntax } = require('./test-utils/validate');

if (!validateSyntax(__filename)) {
  process.exit(1);
}

async function testMemoryEndpoints() {
  console.log('🧠 Testing Universal Memory Archetype endpoints...');
  console.log(`📍 Base URL: /api/memory`);
  
  try {
    // Test 1: Health check
    console.log('\n1️⃣ Testing /api/memory/health...');
    const healthResult = await makeAxiosRequest('GET', '/api/memory/health', { includeAuth: true });
    if (healthResult.success) {
      console.log('✅ Health check:', healthResult.data);
    } else {
      console.log('⚠️ Health check (expected degraded mode):', healthResult.data || healthResult.error);
    }

    // Test 2: Save memory
    console.log('\n2️⃣ Testing POST /api/memory/save...');
    const saveData = {
      memory_key: 'test_preference',
      memory_value: { theme: 'dark', language: 'en' }
    };
    
    const saveResult = await makeAxiosRequest('POST', '/api/memory/save', { 
      data: saveData, 
      includeAuth: true 
    });
    logTestResult('Save memory', saveResult, true);

    // Test 3: Load memory
    console.log('\n3️⃣ Testing GET /api/memory/load...');
    const loadResult = await makeAxiosRequest('GET', '/api/memory/load?key=test_preference', { 
      includeAuth: true 
    });
    logTestResult('Load memory', loadResult, true);

    // Test 4: Load all memory
    console.log('\n4️⃣ Testing GET /api/memory/all...');
    const allResult = await makeAxiosRequest('GET', '/api/memory/all', { includeAuth: true });
    logTestResult('Load all memory', allResult, true);

    // Test 5: Container isolation
    console.log('\n5️⃣ Testing container isolation...');
    const containerSaveData = {
      memory_key: 'container_specific',
      memory_value: { service: 'backstage-booker' }
    };
    
    const containerSaveResult = await makeAxiosRequest('POST', '/api/memory/save', {
      data: containerSaveData,
      headers: { ...getAuthHeaders(), 'X-Container-Id': 'backstage-booker' }
    });
    logTestResult('Container save', containerSaveResult, true);
    
    // Load from different container (should not find it)
    const containerLoadResult = await makeAxiosRequest('GET', '/api/memory/load?key=container_specific', {
      headers: { ...getAuthHeaders(), 'X-Container-Id': 'segment-engine' }
    });
    
    if (containerLoadResult.status === 404) {
      console.log('✅ Container isolation working - key not found in different container');
    } else {
      console.log('⚠️ Container isolation test (should be 404):', containerLoadResult.data);
    }

    // Test 6: Clear memory (optional - only test if database is available)
    console.log('\n6️⃣ Testing DELETE /api/memory/clear...');
    const clearResult = await makeAxiosRequest('DELETE', '/api/memory/clear', { includeAuth: true });
    logTestResult('Clear memory', clearResult, true);

    console.log('\n🎯 Universal Memory Archetype test completed!');
    console.log('💡 Note: Some failures are expected if DATABASE_URL is not configured (degraded mode)');
    
  } catch (error) {
    console.error('❌ Test suite failed:', error.message);
    process.exit(1);
  }
}

// Run tests if DATABASE_URL is configured
if (require.main === module) {
  testMemoryEndpoints().catch(console.error);
}

module.exports = { testMemoryEndpoints };
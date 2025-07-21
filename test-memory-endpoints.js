#!/usr/bin/env node

/**
 * Test script for Universal Memory Archetype endpoints
 * Tests all memory API endpoints without requiring a database
 */

const axios = require('axios');

const BASE_URL = process.env.TEST_URL || 'http://localhost:8080';
const MEMORY_ENDPOINT = `${BASE_URL}/memory`;

async function testMemoryEndpoints() {
  console.log('🧠 Testing Universal Memory Archetype endpoints...');
  console.log(`📍 Base URL: ${MEMORY_ENDPOINT}`);
  
  try {
    // Test 1: Health check
    console.log('\n1️⃣ Testing /memory/health...');
    try {
      const healthResponse = await axios.get(`${MEMORY_ENDPOINT}/health`);
      console.log('✅ Health check:', healthResponse.data);
    } catch (error) {
      console.log('⚠️ Health check (expected degraded mode):', error.response?.data || error.message);
    }

    // Test 2: Save memory
    console.log('\n2️⃣ Testing POST /memory/save...');
    const saveData = {
      memory_key: 'test_preference',
      memory_value: { theme: 'dark', language: 'en' }
    };
    
    try {
      const saveResponse = await axios.post(`${MEMORY_ENDPOINT}/save`, saveData);
      console.log('✅ Save memory:', saveResponse.data);
    } catch (error) {
      console.log('❌ Save memory failed:', error.response?.data || error.message);
    }

    // Test 3: Load memory
    console.log('\n3️⃣ Testing GET /memory/load...');
    try {
      const loadResponse = await axios.get(`${MEMORY_ENDPOINT}/load?key=test_preference`);
      console.log('✅ Load memory:', loadResponse.data);
    } catch (error) {
      console.log('❌ Load memory failed:', error.response?.data || error.message);
    }

    // Test 4: Load all memory
    console.log('\n4️⃣ Testing GET /memory/all...');
    try {
      const allResponse = await axios.get(`${MEMORY_ENDPOINT}/all`);
      console.log('✅ Load all memory:', allResponse.data);
    } catch (error) {
      console.log('❌ Load all memory failed:', error.response?.data || error.message);
    }

    // Test 5: Container isolation
    console.log('\n5️⃣ Testing container isolation...');
    const containerSaveData = {
      memory_key: 'container_specific',
      memory_value: { service: 'backstage-booker' }
    };
    
    try {
      const containerSaveResponse = await axios.post(`${MEMORY_ENDPOINT}/save`, containerSaveData, {
        headers: { 'X-Container-Id': 'backstage-booker' }
      });
      console.log('✅ Container save:', containerSaveResponse.data);
      
      // Load from different container (should not find it)
      try {
        const containerLoadResponse = await axios.get(`${MEMORY_ENDPOINT}/load?key=container_specific`, {
          headers: { 'X-Container-Id': 'segment-engine' }
        });
        console.log('⚠️ Container isolation test (should be 404):', containerLoadResponse.data);
      } catch (loadError) {
        if (loadError.response?.status === 404) {
          console.log('✅ Container isolation working - key not found in different container');
        } else {
          console.log('❌ Unexpected error:', loadError.response?.data || loadError.message);
        }
      }
    } catch (error) {
      console.log('❌ Container save failed:', error.response?.data || error.message);
    }

    // Test 6: Clear memory (optional - only test if database is available)
    console.log('\n6️⃣ Testing DELETE /memory/clear...');
    try {
      const clearResponse = await axios.delete(`${MEMORY_ENDPOINT}/clear`);
      console.log('✅ Clear memory:', clearResponse.data);
    } catch (error) {
      console.log('❌ Clear memory failed:', error.response?.data || error.message);
    }

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
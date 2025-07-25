#!/usr/bin/env node

// Test script for diagnostic force mode functionality
const axios = require('axios');

const BASE_URL = 'http://localhost:8080';

async function testDiagnosticEndpoints() {
  console.log('🧪 Testing diagnostic endpoints...\n');

  try {
    // Test 1: Normal GET diagnostic request
    console.log('1. Testing normal GET diagnostic request:');
    try {
      const response1 = await axios.get(`${BASE_URL}/diagnostic?command=system health`);
      console.log('✅ Normal diagnostic:', {
        success: response1.data.success,
        category: response1.data.category,
        forceMode: response1.data.forceMode || false
      });
    } catch (error) {
      console.log('❌ Normal diagnostic failed:', error.response?.data || error.message);
    }

    console.log('');

    // Test 2: POST diagnostic request without force
    console.log('2. Testing POST diagnostic request without force:');
    try {
      const response2 = await axios.post(`${BASE_URL}/diagnostic`, {
        command: 'memory check'
      });
      console.log('✅ POST diagnostic:', {
        success: response2.data.success,
        category: response2.data.category,
        forceMode: response2.data.forceMode || false
      });
    } catch (error) {
      console.log('❌ POST diagnostic failed:', error.response?.data || error.message);
    }

    console.log('');

    // Test 3: POST diagnostic request with force mode
    console.log('3. Testing POST diagnostic request with force mode:');
    try {
      const response3 = await axios.post(`${BASE_URL}/diagnostic`, {
        command: 'comprehensive system check',
        force: true
      });
      console.log('✅ Force mode diagnostic:', {
        success: response3.data.success,
        category: response3.data.category,
        forceMode: response3.data.forceMode || false,
        dataKeys: Object.keys(response3.data.data || {}),
        hasCategories: !!(response3.data.data?.completed || response3.data.data?.pending || response3.data.data?.failed)
      });

      // Display categorized results if available
      if (response3.data.data) {
        const data = response3.data.data;
        console.log('   📊 Results summary:');
        console.log(`     - Completed: ${(data.completed || []).length} items`);
        console.log(`     - Pending: ${(data.pending || []).length} items`);
        console.log(`     - In-Progress: ${(data['in-progress'] || []).length} items`);
        console.log(`     - Failed: ${(data.failed || []).length} items`);
      }
    } catch (error) {
      console.log('❌ Force mode diagnostic failed:', error.response?.data || error.message);
    }

    console.log('');

    // Test 4: Queue audit specific test
    console.log('4. Testing queue audit diagnostic:');
    try {
      const response4 = await axios.post(`${BASE_URL}/diagnostic`, {
        command: 'queue audit',
        force: false
      });
      console.log('✅ Queue audit:', {
        success: response4.data.success,
        category: response4.data.category,
        hasQueueData: !!(response4.data.data?.stats || response4.data.data?.pending)
      });
    } catch (error) {
      console.log('❌ Queue audit failed:', error.response?.data || error.message);
    }

  } catch (error) {
    console.error('❌ Test execution failed:', error.message);
  }
}

if (require.main === module) {
  testDiagnosticEndpoints();
}

module.exports = { testDiagnosticEndpoints };
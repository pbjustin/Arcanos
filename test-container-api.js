// Test file for ARCANOS Container Manager API
// Tests the unified backend API block for monitoring and controlling containers

const axios = require('axios');

// Base URL for the container API
const BASE_URL = 'http://localhost:8080/api/containers';

// ✅ TEST FUNCTION: Get container status
async function testContainerStatus() {
  try {
    console.log('🔍 Testing container status endpoint...');
    const response = await axios.get(`${BASE_URL}/status`);
    
    if (response.status !== 200) {
      throw new Error(`Expected status 200, got ${response.status}`);
    }
    
    const containers = response.data;
    console.log('✅ Container status retrieved successfully');
    console.log(`📦 Found ${containers.length} tracked containers`);
    
    // Validate response structure
    if (!Array.isArray(containers)) {
      throw new Error('Expected containers to be an array');
    }
    
    // Log container details if any are found
    containers.forEach((container, index) => {
      console.log(`   ${index + 1}. ${container.Names || 'Unknown'} - ${container.State || 'Unknown state'}`);
    });
    
    return { success: true, containers };
  } catch (err) {
    console.error('❌ Container status test failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ✅ TEST FUNCTION: Invalid action validation
async function testInvalidAction() {
  try {
    console.log('🚫 Testing invalid action validation...');
    const response = await axios.post(`${BASE_URL}/test-container/invalid-action`);
    
    // This should fail with 400
    throw new Error('Expected 400 error for invalid action, but request succeeded');
  } catch (err) {
    if (err.response && err.response.status === 400) {
      const errorData = err.response.data;
      if (errorData.error === 'Invalid action') {
        console.log('✅ Invalid action validation working correctly');
        return { success: true };
      } else {
        throw new Error(`Expected 'Invalid action' error, got: ${errorData.error}`);
      }
    } else {
      throw new Error(`Expected 400 status, got: ${err.response?.status || 'network error'}`);
    }
  }
}

// ✅ TEST FUNCTION: Valid action with non-existent container
async function testNonExistentContainer() {
  try {
    console.log('🔧 Testing valid action on non-existent container...');
    const response = await axios.post(`${BASE_URL}/non-existent-container/start`);
    
    // This should fail with 500 (Docker error)
    throw new Error('Expected 500 error for non-existent container, but request succeeded');
  } catch (err) {
    if (err.response && err.response.status === 500) {
      const errorData = err.response.data;
      if (errorData.error.includes('start failed on non-existent-container')) {
        console.log('✅ Docker error handling working correctly');
        return { success: true };
      } else {
        throw new Error(`Expected Docker error message, got: ${errorData.error}`);
      }
    } else {
      throw new Error(`Expected 500 status, got: ${err.response?.status || 'network error'}`);
    }
  }
}

// ✅ MAIN TEST RUNNER
async function runContainerTests() {
  console.log('📦 Starting ARCANOS Container Manager API Tests...');
  console.log('================================================');
  
  let totalTests = 0;
  let passedTests = 0;
  
  // Test 1: Container status
  const statusTest = await testContainerStatus();
  totalTests++;
  if (statusTest.success) passedTests++;
  
  // Test 2: Invalid action validation
  const invalidActionTest = await testInvalidAction();
  totalTests++;
  if (invalidActionTest.success) passedTests++;
  
  // Test 3: Non-existent container handling
  const nonExistentTest = await testNonExistentContainer();
  totalTests++;
  if (nonExistentTest.success) passedTests++;
  
  console.log('================================================');
  console.log(`📊 Test Results: ${passedTests}/${totalTests} tests passed`);
  
  if (passedTests === totalTests) {
    console.log('🎉 All container API tests passed!');
    return true;
  } else {
    console.log('❌ Some tests failed');
    return false;
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  runContainerTests().then(success => {
    process.exit(success ? 0 : 1);
  }).catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
  });
}

module.exports = {
  testContainerStatus,
  testInvalidAction,
  testNonExistentContainer,
  runContainerTests
};
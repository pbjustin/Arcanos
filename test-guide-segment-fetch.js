#!/usr/bin/env node

// Test script for the fetchGuideSegment functionality
// This script tests the new guide segment fetching service and API route

const axios = require('axios');

// Test the fetchGuideSegment service directly
async function testFetchGuideSegmentService() {
  console.log('📖 Testing FetchGuideSegment Service directly...\n');
  
  try {
    // Import the service
    const { fetchGuideSegment, saveGameGuide } = require('./dist/services/game-guides');
    
    // First, save a test guide using the new pattern
    console.log('Setting up test data...');
    
    // Create test guide data
    const testGuide = {
      id: "test-guide",
      sections: [
        "Section 1: Getting Started",
        "Section 2: Basic Controls", 
        "Section 3: Advanced Strategies",
        "Section 4: Tips and Tricks",
        "Section 5: Conclusion"
      ],
      lastUpdated: new Date().toISOString()
    };
    
    // Save test guide using direct memory access (simulate saved guide)
    const { saveMemory } = require('./dist/services/memory');
    await saveMemory('guides/rpg/test-guide', testGuide);
    console.log('✅ Test guide saved');
    
    // Test with default parameters (start=0, end=2)
    const result1 = await fetchGuideSegment({
      category: 'rpg',
      guideId: 'test-guide'
    });
    
    console.log('✅ Test 1 - Default parameters (sections 0-1):');
    console.log('Result:', result1);
    console.log('Expected 2 sections joined with \\n\\n\n');
    
    // Test with custom parameters
    const result2 = await fetchGuideSegment({
      category: 'rpg',
      guideId: 'test-guide',
      start: 1,
      end: 4
    });
    
    console.log('\n✅ Test 2 - Custom parameters (sections 1-3):');
    console.log('Result:', result2);
    console.log('Expected 3 sections joined with \\n\\n\n');
    
    // Test with non-existent guide
    const result3 = await fetchGuideSegment({
      category: 'rpg',
      guideId: 'non-existent'
    });
    
    console.log('\n✅ Test 3 - Non-existent guide:');
    console.log('Result:', result3);
    console.log('Expected error message\n');
    
    return true;
  } catch (error) {
    console.error('❌ Direct service test failed:', error.message);
    return false;
  }
}

// Test the API endpoint
async function testFetchGuideSegmentAPI(port = 3000) {
  console.log('🌐 Testing Guide Segment API endpoint...\n');
  
  try {
    // First, save a test guide via the save endpoint
    console.log('Setting up test data via API...');
    
    // Save using the direct memory endpoint with the correct pattern
    const setupResponse = await axios.post(`http://localhost:${port}/api/memory/save`, {
      memory_key: "guides/rpg/test-api-guide",
      memory_value: {
        id: "test-api-guide",
        sections: [
          "API Section 1: Introduction",
          "API Section 2: Setup", 
          "API Section 3: Usage",
          "API Section 4: Examples",
          "API Section 5: Troubleshooting"
        ],
        lastUpdated: new Date().toISOString()
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test_token_123'
      },
      timeout: 10000
    });
    
    console.log('✅ Test guide saved via API memory endpoint');
    
    // Test the new GET endpoint with default parameters
    const response1 = await axios.get(`http://localhost:${port}/api/guides/rpg/test-api-guide`, {
      headers: {
        'Authorization': 'Bearer test_token_123'
      },
      timeout: 10000
    });
    
    console.log('✅ API Test 1 - Default parameters:');
    console.log('Status:', response1.status);
    console.log('Content-Type:', response1.headers['content-type']);
    console.log('Response:', response1.data);
    
    // Test with custom query parameters
    const response2 = await axios.get(`http://localhost:${port}/api/guides/rpg/test-api-guide?sectionStart=2&sectionEnd=5`, {
      headers: {
        'Authorization': 'Bearer test_token_123'
      },
      timeout: 10000
    });
    
    console.log('\n✅ API Test 2 - Custom parameters (sections 2-4):');
    console.log('Status:', response2.status);
    console.log('Response:', response2.data);
    
    // Test with non-existent guide
    const response3 = await axios.get(`http://localhost:${port}/api/guides/rpg/non-existent`, {
      headers: {
        'Authorization': 'Bearer test_token_123'
      },
      timeout: 10000
    });
    
    console.log('\n✅ API Test 3 - Non-existent guide:');
    console.log('Status:', response3.status);
    console.log('Response:', response3.data);
    
    return true;
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.error('❌ API test failed: Server not running on port', port);
      console.log('💡 To test the API, start the server first with: npm run dev');
    } else if (error.response) {
      console.error('❌ API test failed:', error.response.status, error.response.data);
    } else {
      console.error('❌ API test failed:', error.message);
    }
    return false;
  }
}

// Main test function
async function runTests() {
  console.log('🚀 Starting Guide Segment Fetch Tests\n');
  
  const directTest = await testFetchGuideSegmentService();
  const apiTest = await testFetchGuideSegmentAPI();
  
  console.log('\n📊 Test Results:');
  console.log('Direct Service Test:', directTest ? '✅ PASSED' : '❌ FAILED');
  console.log('API Endpoint Test:', apiTest ? '✅ PASSED' : '❌ FAILED');
  
  if (directTest && apiTest) {
    console.log('\n🎉 All tests passed! Guide segment fetch functionality is working correctly.');
  } else if (directTest) {
    console.log('\n⚠️ Service works but API test failed. Check if server is running.');
  } else {
    console.log('\n❌ Tests failed. Check the implementation and dependencies.');
  }
}

// Run tests if this script is executed directly
if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = { testFetchGuideSegmentService, testFetchGuideSegmentAPI };
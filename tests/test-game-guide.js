#!/usr/bin/env node

// Test script for the game guide functionality
// This script tests the game guide service directly and via API

const axios = require('axios');
const path = require('path');

// Test the game guide service directly
async function testGameGuideService() {
  console.log('🎮 Testing Game Guide Service directly...\n');
  
  try {
    // Import the service (we'll use require since this is a JS file)
    const { gameGuideService } = require('../dist/services/game-guide');
    
    // Test with a popular game
    const result = await gameGuideService.simulateGameGuide("The Legend of Zelda: Breath of the Wild", "Focus on combat tips");
    
    console.log('✅ Direct service test successful:');
    console.log('Game Title:', result.gameTitle);
    console.log('Model:', result.model);
    console.log('Timestamp:', result.timestamp);
    console.log('Guide Length:', result.guide.length);
    console.log('Error:', result.error || 'None');
    console.log('Guide Preview (first 200 chars):', result.guide.substring(0, 200) + '...');
    
    return true;
  } catch (error) {
    console.error('❌ Direct service test failed:', error.message);
    return false;
  }
}

// Test the API endpoint
async function testGameGuideAPI(port = 3000) {
  console.log('\n🌐 Testing Game Guide API endpoint...\n');
  
  try {
    const response = await axios.post(`http://localhost:${port}/game-guide`, {
      gameTitle: "Minecraft",
      notes: "Focus on survival mode strategies"
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 second timeout
    });
    
    console.log('✅ API test successful:');
    console.log('Status:', response.status);
    console.log('Success:', response.data.success);
    console.log('Message:', response.data.message);
    
    if (response.data.data) {
      const data = response.data.data;
      console.log('Game Title:', data.gameTitle);
      console.log('Model:', data.model);
      console.log('Timestamp:', data.timestamp);
      console.log('Guide Length:', data.guide.length);
      console.log('Guide Preview (first 200 chars):', data.guide.substring(0, 200) + '...');
    }
    
    return true;
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.error('❌ API test failed: Server not running on port', port);
      console.log('💡 To test the API, start the server first with: npm run dev');
    } else {
      console.error('❌ API test failed:', error.response?.data || error.message);
    }
    return false;
  }
}

// Main test function
async function runTests() {
  console.log('🚀 Starting Game Guide Tests\n');
  
  const directTest = await testGameGuideService();
  const apiTest = await testGameGuideAPI();
  
  console.log('\n📊 Test Results:');
  console.log('Direct Service Test:', directTest ? '✅ PASSED' : '❌ FAILED');
  console.log('API Endpoint Test:', apiTest ? '✅ PASSED' : '❌ FAILED');
  
  if (directTest && apiTest) {
    console.log('\n🎉 All tests passed! Game guide functionality is working correctly.');
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

module.exports = { testGameGuideService, testGameGuideAPI };
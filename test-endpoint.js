// Test the ARCANOS endpoint
const axios = require('axios');

async function testArcanosEndpoint() {
  const baseURL = 'http://localhost:8080';
  
  const testCases = [
    {
      name: "Narrative Intent Test",
      data: {
        message: "Write a short story about a robot learning to love",
        domain: "creative",
        useRAG: false,
        useHRC: false
      }
    },
    {
      name: "Validation Intent Test", 
      data: {
        message: "Check if this JSON is valid: {'name': 'test', 'value': 123}",
        domain: "technical",
        useRAG: false,
        useHRC: false
      }
    },
    {
      name: "Unclear Intent Test",
      data: {
        message: "Hello there",
        domain: "general",
        useRAG: false,
        useHRC: false
      }
    }
  ];

  console.log('🧪 Testing ARCANOS Intent-Based Routing API...\n');

  for (const test of testCases) {
    console.log(`\n📝 ${test.name}`);
    console.log(`Input: "${test.data.message}"`);
    
    try {
      const response = await axios.post(`${baseURL}/api/arcanos`, test.data);
      
      console.log(`✅ Success: ${response.data.success}`);
      console.log(`🎯 Intent: ${response.data.intent} (${(response.data.confidence * 100).toFixed(1)}%)`);
      console.log(`🤖 Service: ${response.data.metadata?.service}`);
      console.log(`📄 Response: ${response.data.response?.substring(0, 200)}${response.data.response?.length > 200 ? '...' : ''}`);
      
      if (response.data.error) {
        console.log(`❌ Error: ${response.data.error}`);
      }
      
    } catch (error) {
      console.log(`❌ Request failed: ${error.response?.data || error.message}`);
    }
    
    console.log('---');
  }
}

testArcanosEndpoint().catch(console.error);
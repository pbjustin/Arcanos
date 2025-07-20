const axios = require('axios');

async function testRootEndpoint() {
  const baseURL = 'http://localhost:8080';
  
  const testCases = [
    "Write a story about a dragon",
    "Validate this email format: test@example.com", 
    "How are you today?"
  ];

  console.log('🧪 Testing Root Endpoint Intent Routing...\n');

  for (const message of testCases) {
    console.log(`Input: "${message}"`);
    
    try {
      const response = await axios.post(baseURL, { message });
      console.log(`Response: ${response.data}`);
      
    } catch (error) {
      if (error.response) {
        console.log(`Error Response: ${JSON.stringify(error.response.data)}`);
      } else {
        console.log(`Request failed: ${error.message}`);
      }
    }
    
    console.log('---');
  }
}

testRootEndpoint().catch(console.error);
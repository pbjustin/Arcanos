import fetch from 'node-fetch';

/**
 * Test the /ask endpoint with our model validation functionality
 * Note: This test requires a valid OpenAI API key or it will demonstrate the error handling
 */

async function testAskEndpoint() {
  const serverUrl = 'http://localhost:8080';
  
  console.log('🧪 Testing /ask endpoint with model validation...');
  
  try {
    const response = await fetch(`${serverUrl}/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: 'Hello, this is a test message for model validation'
      })
    });

    const result = await response.json();
    
    console.log('📝 Response status:', response.status);
    console.log('📝 Response body:', JSON.stringify(result, null, 2));

    if (response.status === 503) {
      console.log('✅ Expected behavior: AI service unavailable due to missing API key');
    } else if (response.status === 200) {
      console.log('✅ Request successful with API key configured');
      
      // Check if result contains our expected structure
      if (result.result && result.module && result.meta) {
        console.log('✅ Response has expected Trinity structure');
        console.log(`📝 Used model: ${result.module}`);
      } else {
        console.log('❌ Response missing expected Trinity structure');
      }
    } else {
      console.log('❌ Unexpected response status:', response.status);
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Run the test
testAskEndpoint().catch(console.error);
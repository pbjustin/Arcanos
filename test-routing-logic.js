// Enhanced test to verify routing logic
const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

async function detailedRoutingTest() {
  console.log('🔍 Detailed Routing Logic Test...\n');

  try {
    // Test the fallback detection function by adding some logging
    console.log('Testing fallback detection logic:');
    
    const testQueries = [
      { query: 'Normal query', expected: 'finetune' },
      { query: 'Query with --fallback', expected: 'core' },
      { query: 'Query with ::default', expected: 'core' },
      { query: 'Query with --fallback and ::default', expected: 'core' },
      { query: '  Query with ::default  ', expected: 'core' }
    ];

    for (const test of testQueries) {
      console.log(`\nTesting: "${test.query}"`);
      console.log(`Expected route: ${test.expected}`);
      
      const response = await axios.post(`${BASE_URL}/copilot/query`, {
        query: test.query,
        mode: 'logic'
      });
      
      console.log(`Response: ${response.data.response}`);
      
      // Check if the cleaned query is correct
      const hasFallbackMarkers = test.query.includes('--fallback') || test.query.includes('::default');
      if (hasFallbackMarkers) {
        const cleanedQuery = test.query.replace('--fallback', '').replace('::default', '').trim();
        console.log(`Cleaned query should be: "${cleanedQuery}"`);
      }
    }

    console.log('\n✅ Detailed routing test completed!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
  }
}

detailedRoutingTest();
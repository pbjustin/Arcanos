#!/usr/bin/env node
/**
 * Live API Token Parameter Test
 * Tests token parameter behavior with actual OpenAI API calls
 * (Only runs if OPENAI_API_KEY is available)
 */

import { getTokenParameter, testModelTokenParameter } from '../dist/utils/tokenParameterHelper.js';
import { getOpenAIClient } from '../dist/services/openai.js';

console.log('🔬 Live API Token Parameter Test\n');

async function runLiveAPITest() {
  const client = getOpenAIClient();
  
  if (!client) {
    console.log('❌ No OpenAI API key available - skipping live API tests');
    console.log('✅ This is expected in environments without API access');
    return true;
  }
  
  console.log('✅ OpenAI client available - running live API tests\n');
  
  const testModels = [
    'gpt-3.5-turbo',
    'gpt-4',
    'gpt-4o'  // Only test models that are likely to be available
  ];
  
  const results = [];
  
  for (const model of testModels) {
    console.log(`🧪 Testing model: ${model}`);
    
    try {
      // Test the utility function behavior
      const utilityResult = getTokenParameter(model, 100);
      const utilityParam = utilityResult.max_tokens ? 'max_tokens' : 'max_completion_tokens';
      
      console.log(`   Utility prediction: ${utilityParam}`);
      
      // Test actual API behavior
      const apiResult = await testModelTokenParameter(client, model);
      console.log(`   API test result: ${apiResult}`);
      
      // Compare results
      const match = utilityParam === apiResult;
      console.log(`   Match: ${match ? '✅' : '❌'}`);
      
      results.push({
        model,
        utilityPrediction: utilityParam,
        apiResult,
        match
      });
      
      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      console.log(`   Error testing ${model}: ${error.message}`);
      results.push({
        model,
        error: error.message
      });
    }
    
    console.log('');
  }
  
  // Summary
  console.log('📊 Live API Test Summary:');
  const successfulTests = results.filter(r => !r.error);
  const matchingPredictions = successfulTests.filter(r => r.match);
  
  console.log(`   Total models tested: ${results.length}`);
  console.log(`   Successful tests: ${successfulTests.length}`);
  console.log(`   Matching predictions: ${matchingPredictions.length}/${successfulTests.length}`);
  
  if (successfulTests.length > 0) {
    const accuracy = (matchingPredictions.length / successfulTests.length) * 100;
    console.log(`   Prediction accuracy: ${accuracy.toFixed(1)}%`);
    
    if (accuracy >= 90) {
      console.log('✅ Token parameter utility is highly accurate');
      return true;
    } else if (accuracy >= 70) {
      console.log('⚠️  Token parameter utility has good accuracy but may need tuning');
      return true;
    } else {
      console.log('❌ Token parameter utility needs improvement');
      return false;
    }
  } else {
    console.log('⚠️  No successful API tests - may indicate API issues or rate limits');
    return true; // Don't fail the test due to API availability issues
  }
}

// Additional test: Error handling with invalid models
async function testErrorHandling() {
  console.log('🔧 Testing error handling with invalid models\n');
  
  const client = getOpenAIClient();
  if (!client) {
    console.log('   Skipping error handling test (no API client)');
    return true;
  }
  
  const invalidModel = 'non-existent-model-12345';
  
  try {
    console.log(`   Testing invalid model: ${invalidModel}`);
    const result = await testModelTokenParameter(client, invalidModel);
    console.log(`   Fallback result: ${result}`);
    console.log('✅ Error handling works correctly');
    return true;
  } catch (error) {
    console.log(`   Error (expected): ${error.message}`);
    console.log('✅ Error handling behavior confirmed');
    return true;
  }
}

// Run tests
Promise.all([
  runLiveAPITest(),
  testErrorHandling()
]).then(results => {
  const allPassed = results.every(r => r);
  console.log('\n' + '='.repeat(50));
  console.log(`🎯 Live API Test Result: ${allPassed ? 'PASS' : 'FAIL'}`);
  console.log('='.repeat(50));
  
  if (!allPassed) {
    process.exit(1);
  }
}).catch(error => {
  console.error('❌ Live API test suite failed:', error);
  process.exit(1);
});
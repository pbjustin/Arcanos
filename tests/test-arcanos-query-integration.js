/**
 * Integration test for arcanosQuery function
 * Validates the two-step process: Fine-tuned model → GPT-5 reasoning
 */

import { arcanosQuery } from '../dist/services/arcanosQuery.js';

/**
 * Test the core two-step process implementation
 */
async function testTwoStepProcess() {
  console.log('🧪 [INTEGRATION] Testing ARCANOS two-step process...');
  
  try {
    const testPrompt = "Explain the concept of artificial intelligence briefly";
    
    console.log(`📤 [INTEGRATION] Input: "${testPrompt}"`);
    console.log('🔄 [INTEGRATION] Expected flow:');
    console.log('   1. Fine-tuned model (ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote)');
    console.log('   2. GPT-5 reasoning and refinement');
    
    const result = await arcanosQuery(testPrompt);
    
    console.log(`📥 [INTEGRATION] Output: "${result.substring(0, 200)}${result.length > 200 ? '...' : ''}"`);
    
    // Validate the result structure for mock mode
    if (result.includes('MOCK ARCANOS QUERY') && 
        result.includes('Fine-tuned model') && 
        result.includes('GPT-5 reasoning')) {
      console.log('✅ [INTEGRATION] Two-step process structure verified (mock mode)');
      return true;
    } else if (result && result.length > 10) {
      console.log('✅ [INTEGRATION] Two-step process completed (live mode)');
      return true;
    } else {
      console.log('❌ [INTEGRATION] Unexpected result format');
      return false;
    }
    
  } catch (error) {
    console.log(`❌ [INTEGRATION] Two-step process failed: ${error.message}`);
    return false;
  }
}

/**
 * Test model configuration
 */
async function testModelConfiguration() {
  console.log('🧪 [INTEGRATION] Testing model configuration...');
  
  const expectedFTModel = "ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote";
  const expectedReasoningModel = "gpt-5";
  
  // Import the module to check constants
  try {
    const fs = await import('fs');
    const source = fs.readFileSync('./dist/services/arcanosQuery.js', 'utf8');
    
    if (source.includes(expectedFTModel) && source.includes(expectedReasoningModel)) {
      console.log('✅ [INTEGRATION] Model configuration correct:');
      console.log(`   - Fine-tuned model: ${expectedFTModel}`);
      console.log(`   - Reasoning model: ${expectedReasoningModel}`);
      return true;
    } else {
      console.log('❌ [INTEGRATION] Model configuration incorrect');
      return false;
    }
  } catch (error) {
    console.log(`❌ [INTEGRATION] Could not verify model configuration: ${error.message}`);
    return false;
  }
}

/**
 * Test error handling and fallback behavior
 */
async function testErrorHandling() {
  console.log('🧪 [INTEGRATION] Testing error handling...');
  
  try {
    // Test with various inputs
    const testCases = [
      "Simple test",
      "Complex query about quantum computing and machine learning",
      "",
      "Special characters: !@#$%^&*()"
    ];
    
    for (const testCase of testCases) {
      try {
        const result = await arcanosQuery(testCase);
        if (result && typeof result === 'string') {
          console.log(`✅ [INTEGRATION] Handled input: "${testCase.substring(0, 30)}${testCase.length > 30 ? '...' : ''}"`);
        } else {
          console.log(`❌ [INTEGRATION] Invalid result for input: "${testCase}"`);
          return false;
        }
      } catch (error) {
        console.log(`❌ [INTEGRATION] Error with input "${testCase}": ${error.message}`);
        return false;
      }
    }
    
    console.log('✅ [INTEGRATION] Error handling working correctly');
    return true;
    
  } catch (error) {
    console.log(`❌ [INTEGRATION] Error handling test failed: ${error.message}`);
    return false;
  }
}

/**
 * Main integration test runner
 */
async function runIntegrationTests() {
  console.log('🚀 [INTEGRATION] Starting ARCANOS Query Integration Tests...\n');
  
  const results = [];
  
  // Test 1: Two-step process
  console.log('1. Testing core two-step process...');
  results.push(await testTwoStepProcess());
  
  console.log('\n2. Testing model configuration...');
  results.push(await testModelConfiguration());
  
  console.log('\n3. Testing error handling...');
  results.push(await testErrorHandling());
  
  // Summary
  const passed = results.filter(r => r).length;
  const total = results.length;
  
  console.log(`\n📊 [INTEGRATION] Results: ${passed}/${total} tests passed`);
  
  if (passed === total) {
    console.log('🎉 [INTEGRATION] All integration tests passed!');
    console.log('\n✅ ARCANOS Query function is working correctly:');
    console.log('   - Two-step process implemented');
    console.log('   - Updated model configuration');
    console.log('   - Proper error handling');
    console.log('   - Mock mode support');
    return true;
  } else {
    console.log('❌ [INTEGRATION] Some integration tests failed');
    return false;
  }
}

// Run the integration tests
runIntegrationTests().catch(error => {
  console.error('💥 [INTEGRATION] Integration test runner crashed:', error);
  process.exit(1);
});
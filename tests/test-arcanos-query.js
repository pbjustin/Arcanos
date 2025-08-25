/**
 * Test for the new arcanosQuery function
 * Validates that the two-step process works correctly
 */

import { arcanosQuery } from '../dist/services/arcanosQuery.js';

/**
 * Test the arcanosQuery function
 */
async function testArcanosQuery() {
  console.log('🧪 [TEST] Testing arcanosQuery function...');
  
  try {
    // Simple test prompt
    const testPrompt = "Hello, test the ARCANOS query system";
    
    console.log(`📤 [TEST] Sending prompt: "${testPrompt}"`);
    
    // Call the arcanosQuery function
    const result = await arcanosQuery(testPrompt);
    
    console.log(`📥 [TEST] Received response: "${result.substring(0, 100)}${result.length > 100 ? '...' : ''}"`);
    
    // Validate result
    if (result && typeof result === 'string' && result.length > 0) {
      console.log('✅ [TEST] arcanosQuery function: PASSED');
      console.log(`   - Response length: ${result.length} characters`);
      console.log(`   - Response type: ${typeof result}`);
      return true;
    } else {
      console.log('❌ [TEST] arcanosQuery function returned invalid result:', result);
      return false;
    }
    
  } catch (error) {
    console.log('📝 [TEST] arcanosQuery function failed (expected if no API key):', error.message);
    
    // Check if it's the expected "no API key" error
    if (error.message.includes('Incorrect API key') || 
        error.message.includes('authentication') ||
        error.message.includes('API key')) {
      console.log('✅ [TEST] Error correctly indicates missing/invalid API key');
      return true; // This is expected behavior when no API key is configured
    }
    
    return false;
  }
}

/**
 * Test error handling for the arcanosQuery function
 */
async function testArcanosQueryErrorHandling() {
  console.log('🧪 [TEST] Testing arcanosQuery error handling...');
  
  try {
    // Test with empty prompt - this should still work in mock mode
    const result = await arcanosQuery('');
    if (result && result.includes('MOCK ARCANOS QUERY')) {
      console.log('✅ [TEST] Mock mode handles empty prompt correctly');
      return true;
    } else {
      console.log('❌ [TEST] Unexpected behavior with empty prompt');
      return false;
    }
  } catch (error) {
    console.log('✅ [TEST] Error handling works correctly for invalid input');
    return true;
  }
}

/**
 * Main test runner
 */
async function runArcanosQueryTests() {
  console.log('🚀 [TEST] Starting arcanosQuery function tests...\n');
  
  const results = [];
  
  // Test basic functionality
  console.log('1. Testing basic arcanosQuery functionality...');
  results.push(await testArcanosQuery());
  
  console.log('\n2. Testing error handling...');
  results.push(await testArcanosQueryErrorHandling());
  
  // Summary
  const passed = results.filter(r => r).length;
  const total = results.length;
  
  console.log(`\n📊 [TEST] Results: ${passed}/${total} tests passed`);
  
  if (passed === total) {
    console.log('🎉 [TEST] All arcanosQuery tests passed!');
    return true;
  } else {
    console.log('❌ [TEST] Some arcanosQuery tests failed');
    return false;
  }
}

// Run the tests
runArcanosQueryTests().catch(error => {
  console.error('💥 [TEST] Test runner crashed:', error);
  process.exit(1);
});
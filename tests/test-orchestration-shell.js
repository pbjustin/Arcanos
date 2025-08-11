/**
 * Test for GPT-5 Orchestration Shell functionality
 * Validates the orchestration shell reset and status endpoints
 */

import { resetOrchestrationShell, getOrchestrationShellStatus } from '../dist/services/orchestrationShell.js';

/**
 * Test orchestration shell status endpoint
 */
async function testOrchestrationStatus() {
  console.log('🧪 [TEST] Testing orchestration shell status...');
  
  try {
    const status = await getOrchestrationShellStatus();
    
    console.log('✅ [TEST] Status retrieved successfully:', {
      active: status.active,
      model: status.model,
      memoryEntries: status.memoryEntries
    });
    
    // Validate response structure
    if (typeof status.active !== 'boolean') {
      throw new Error('status.active should be boolean');
    }
    if (typeof status.model !== 'string') {
      throw new Error('status.model should be string');
    }
    if (typeof status.memoryEntries !== 'number') {
      throw new Error('status.memoryEntries should be number');
    }
    
    return true;
  } catch (error) {
    console.error('❌ [TEST] Status test failed:', error);
    return false;
  }
}

/**
 * Test orchestration shell reset functionality
 */
async function testOrchestrationReset() {
  console.log('🧪 [TEST] Testing orchestration shell reset...');
  
  try {
    const result = await resetOrchestrationShell();
    
    console.log('✅ [TEST] Reset completed:', {
      success: result.success,
      message: result.message,
      stages: result.meta.stages,
      gpt5Model: result.meta.gpt5Model
    });
    
    // Validate response structure
    if (typeof result.success !== 'boolean') {
      throw new Error('result.success should be boolean');
    }
    if (typeof result.message !== 'string') {
      throw new Error('result.message should be string');
    }
    if (!Array.isArray(result.meta.stages)) {
      throw new Error('result.meta.stages should be array');
    }
    if (!Array.isArray(result.logs)) {
      throw new Error('result.logs should be array');
    }
    
    // Check that expected stages were executed
    const expectedStages = ['ISOLATE_MODULE', 'PURGE_MEMORY', 'REDEPLOY_SAFEGUARDS', 'VERIFY_DEPLOYMENT'];
    for (const stage of expectedStages) {
      if (!result.meta.stages.includes(stage)) {
        console.warn(`⚠️ [TEST] Expected stage ${stage} not found in results`);
      }
    }
    
    return result.success;
  } catch (error) {
    console.error('❌ [TEST] Reset test failed:', error);
    return false;
  }
}

/**
 * Test the orchestration shell module compatibility
 */
async function testOrchestrationCompatibility() {
  console.log('🧪 [TEST] Testing OpenAI SDK compatibility...');
  
  try {
    // Test that we can import and use the orchestration shell
    const { resetOrchestrationShell: resetFunc } = await import('../dist/services/orchestrationShell.js');
    
    if (typeof resetFunc !== 'function') {
      throw new Error('resetOrchestrationShell should be a function');
    }
    
    console.log('✅ [TEST] SDK compatibility verified');
    return true;
  } catch (error) {
    console.error('❌ [TEST] Compatibility test failed:', error);
    return false;
  }
}

/**
 * Main test runner
 */
async function runOrchestrationTests() {
  console.log('🚀 [TEST] Starting GPT-5 Orchestration Shell tests...\n');
  
  const tests = [
    { name: 'Compatibility', fn: testOrchestrationCompatibility },
    { name: 'Status', fn: testOrchestrationStatus },
    { name: 'Reset', fn: testOrchestrationReset }
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    console.log(`\n--- Running ${test.name} Test ---`);
    try {
      const result = await test.fn();
      if (result) {
        passed++;
        console.log(`✅ [TEST] ${test.name} test PASSED`);
      } else {
        failed++;
        console.log(`❌ [TEST] ${test.name} test FAILED`);
      }
    } catch (error) {
      failed++;
      console.error(`❌ [TEST] ${test.name} test ERROR:`, error);
    }
  }
  
  console.log('\n=== TEST SUMMARY ===');
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📊 Total: ${passed + failed}`);
  
  if (failed === 0) {
    console.log('🎉 All orchestration shell tests passed!');
    process.exit(0);
  } else {
    console.log('⚠️ Some tests failed. Check the logs above.');
    process.exit(1);
  }
}

// Run the tests
runOrchestrationTests().catch(error => {
  console.error('💥 [TEST] Test runner crashed:', error);
  process.exit(1);
});
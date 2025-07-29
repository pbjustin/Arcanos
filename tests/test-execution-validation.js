// Test Execution Engine Worker Validation
console.log('🔧 Testing Execution Engine Worker Validation');
console.log('=============================================');

const { executionEngine } = require('./dist/services/execution-engine');

async function testExecutionEngineValidation() {
  try {
    console.log('\n🎯 Test 1: Schedule instruction with valid worker');
    const validScheduleInstruction = {
      action: 'schedule',
      worker: 'memorySync',
      schedule: '0 */6 * * *',
      service: 'worker',
      parameters: { test: true },
      priority: 5
    };
    
    const result1 = await executionEngine.executeInstruction(validScheduleInstruction);
    console.log('Valid worker result:', {
      success: result1.success,
      error: result1.error,
      response: result1.response
    });

    console.log('\n❌ Test 2: Schedule instruction with unregistered worker');
    const invalidScheduleInstruction = {
      action: 'schedule',
      worker: 'nonExistentWorker',
      schedule: '0 */6 * * *',
      service: 'worker',
      parameters: { test: true },
      priority: 5
    };
    
    const result2 = await executionEngine.executeInstruction(invalidScheduleInstruction);
    console.log('Unregistered worker result:', {
      success: result2.success,
      error: result2.error,
      response: result2.response
    });

    console.log('\n🚫 Test 3: Schedule instruction without worker (no fallback)');
    const noWorkerInstruction = {
      action: 'schedule',
      schedule: '0 */6 * * *',
      service: 'worker',
      parameters: { test: true },
      priority: 5
    };
    
    const result3 = await executionEngine.executeInstruction(noWorkerInstruction);
    console.log('No worker result:', {
      success: result3.success,
      error: result3.error,
      response: result3.response
    });

    console.log('\n🔄 Test 4: Delegate to valid worker');
    const validDelegateInstruction = {
      action: 'delegate',
      worker: 'memorySync',
      service: 'worker',
      parameters: { test: true },
      priority: 5
    };
    
    const result4 = await executionEngine.executeInstruction(validDelegateInstruction);
    console.log('Valid delegation result:', {
      success: result4.success,
      error: result4.error,
      response: result4.response
    });

    console.log('\n❌ Test 5: Delegate to unregistered worker');
    const invalidDelegateInstruction = {
      action: 'delegate',
      worker: 'invalidWorker',
      service: 'worker', 
      parameters: { test: true },
      priority: 5
    };
    
    const result5 = await executionEngine.executeInstruction(invalidDelegateInstruction);
    console.log('Invalid delegation result:', {
      success: result5.success,
      error: result5.error,
      response: result5.response
    });

    console.log('\n📊 Test 6: Multiple instructions with mixed validity');
    const mixedInstructions = [
      {
        action: 'schedule',
        worker: 'memorySync',
        schedule: '0 */6 * * *',
        service: 'worker',
        priority: 5
      },
      {
        action: 'schedule',
        worker: 'invalidWorker',
        schedule: '0 */6 * * *',
        service: 'worker',
        priority: 4
      },
      {
        action: 'schedule',
        schedule: '0 */6 * * *',
        service: 'worker',
        priority: 3
      }
    ];
    
    const results6 = await executionEngine.executeInstructions(mixedInstructions);
    console.log('Mixed instructions results:');
    results6.forEach((result, index) => {
      console.log(`  Instruction ${index + 1}:`, {
        success: result.success,
        error: result.error,
        response: result.response
      });
    });

    console.log('\n✨ All execution engine validation tests completed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error);
  }
}

testExecutionEngineValidation();
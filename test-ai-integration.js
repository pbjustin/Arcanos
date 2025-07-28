// Integration Test: AI Control + Worker Validation System
console.log('🤖 Testing AI Control + Worker Validation Integration');
console.log('===================================================');

const { aiDispatcher } = require('./dist/services/ai-dispatcher');
const { modelControlHooks } = require('./dist/services/model-control-hooks');
const { 
  validateWorker, 
  registerWorker, 
  scheduleJob, 
  aiController 
} = require('./workers/workerRegistry');

async function testAIControlIntegration() {
  try {
    console.log('\n🎯 Test 1: AI dispatcher processes worker request');
    const workerRequest = {
      type: 'worker',
      payload: {
        worker: 'memorySync',
        action: 'sync',
        parameters: { test: true }
      },
      context: {
        userId: 'test-user',
        sessionId: 'test-session',
        source: 'api'
      }
    };
    
    const dispatchResult = await aiDispatcher.dispatch(workerRequest);
    console.log('AI Dispatcher Result:', {
      success: dispatchResult.success,
      instructionCount: dispatchResult.instructions?.length || 0,
      error: dispatchResult.error,
      directResponse: dispatchResult.directResponse?.substring(0, 100) + '...'
    });

    console.log('\n🔧 Test 2: Model control hooks orchestrate valid worker');
    const orchestrateResult = await modelControlHooks.orchestrateWorker(
      'memorySync',
      'background',
      { test: true },
      {
        userId: 'test-user',
        sessionId: 'test-session',
        source: 'worker'
      }
    );
    console.log('Orchestration Result:', {
      success: orchestrateResult.success,
      response: orchestrateResult.response?.substring(0, 100) + '...',
      resultCount: orchestrateResult.results?.length || 0,
      error: orchestrateResult.error
    });

    console.log('\n❌ Test 3: Model control hooks reject unregistered worker');
    const invalidOrchestrationResult = await modelControlHooks.orchestrateWorker(
      'nonExistentWorker',
      'background',
      { test: true },
      {
        userId: 'test-user',
        sessionId: 'test-session',
        source: 'worker'
      }
    );
    console.log('Invalid Worker Orchestration Result:', {
      success: invalidOrchestrationResult.success,
      response: invalidOrchestrationResult.response,
      error: invalidOrchestrationResult.error
    });

    console.log('\n🎭 Test 4: AI Controller event-based registration');
    console.log('Registered workers before:', Object.keys(require('./workers/workerRegistry').registeredWorkers()).length);
    
    // Simulate AI controller registering a new worker
    aiController.emit('registerWorker', 'aiRegisteredWorker');
    
    // Give it a moment to process
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const isNewWorkerValid = validateWorker('aiRegisteredWorker');
    console.log('AI-registered worker validation:', isNewWorkerValid ? '✅ PASS' : '❌ FAIL');
    console.log('Registered workers after:', Object.keys(require('./workers/workerRegistry').registeredWorkers()).length);

    console.log('\n📅 Test 5: Schedule job with validation');
    console.log('Testing valid job scheduling...');
    scheduleJob({ worker: 'memorySync', schedule: '0 */6 * * *', action: 'sync' });
    
    console.log('Testing invalid job scheduling...');
    scheduleJob({ worker: 'invalidWorker', schedule: '0 */6 * * *', action: 'sync' });

    console.log('\n✨ All AI Control + Worker Validation integration tests completed!');
    
    console.log('\n📊 Final System State:');
    console.log('- Registered Workers:', require('./workers/workerRegistry').registeredWorkers().length);
    console.log('- Scheduled Jobs:', require('./workers/workerRegistry').scheduleRegistry().length);
    console.log('- Fallback Scheduler:', require('./workers/workerRegistry').fallbackScheduler);
    
  } catch (error) {
    console.error('❌ Integration test failed:', error.message);
    console.error(error);
  }
}

testAIControlIntegration();
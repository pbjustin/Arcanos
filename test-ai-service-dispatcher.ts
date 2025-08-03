/**
 * Test AI Service Dispatcher 
 * Validates the new AI-enhanced service dispatcher functionality
 */

import dispatchService, { createManualOverrideTask, requiresAIRouting } from './src/services/ai-service-dispatcher.js';

async function testAIServiceDispatcher() {
  console.log('🧪 Testing AI Service Dispatcher...\n');

  // Test 1: Memory service routing
  console.log('Test 1: Memory service routing');
  try {
    const memoryTask = {
      service: 'memory' as const,
      action: 'store',
      data: { key: 'test-key', value: 'test-value' }
    };
    
    const result = await dispatchService(memoryTask);
    console.log('✅ Memory service test passed:', result.success);
    console.log('   Route:', result.route);
  } catch (error: any) {
    console.log('❌ Memory service test failed:', error.message);
  }

  // Test 2: API service routing
  console.log('\nTest 2: API service routing');
  try {
    const apiTask = {
      service: 'api' as const,
      action: 'monitor',
      data: {}
    };
    
    const result = await dispatchService(apiTask);
    console.log('✅ API service test passed:', result.success);
    console.log('   Route:', result.route);
  } catch (error: any) {
    console.log('❌ API service test failed:', error.message);
  }

  // Test 3: Default worker fallback prevention
  console.log('\nTest 3: Default worker fallback prevention');
  try {
    const fallbackTask = {
      service: 'memory' as const,
      worker: 'defaultWorker',
      action: 'store',
      data: { key: 'test-key', value: 'test-value' }
    };
    
    const result = await dispatchService(fallbackTask);
    console.log('❌ Fallback prevention test failed - should have thrown error');
  } catch (error: any) {
    if (error.message.includes('Fallback to defaultWorker is disabled')) {
      console.log('✅ Fallback prevention test passed');
    } else {
      console.log('❌ Fallback prevention test failed with unexpected error:', error.message);
    }
  }

  // Test 4: Manual override for default worker
  console.log('\nTest 4: Manual override for default worker');
  try {
    const overrideTask = createManualOverrideTask('memory', { key: 'test-key', value: 'test-value' });
    const result = await dispatchService(overrideTask);
    console.log('✅ Manual override test passed:', result.success);
    console.log('   Route:', result.route);
  } catch (error: any) {
    console.log('❌ Manual override test failed:', error.message);
  }

  // Test 5: Service routing requirements
  console.log('\nTest 5: Service routing requirements');
  console.log('Memory requires AI routing:', requiresAIRouting('memory'));
  console.log('API requires AI routing:', requiresAIRouting('api'));
  console.log('Other service requires AI routing:', requiresAIRouting('other'));

  // Test 6: Unrecognized service handling
  console.log('\nTest 6: Unrecognized service handling');
  try {
    const unknownTask = {
      service: 'unknown-service',
      action: 'test',
      data: {}
    };
    
    const result = await dispatchService(unknownTask);
    console.log('❌ Unknown service test failed - should have thrown error');
  } catch (error: any) {
    if (error.message.includes('Unrecognized service')) {
      console.log('✅ Unknown service test passed');
    } else {
      console.log('❌ Unknown service test failed with unexpected error:', error.message);
    }
  }

  console.log('\n🧪 AI Service Dispatcher tests completed');
}

// Run tests
testAIServiceDispatcher().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
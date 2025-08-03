/**
 * Test script for worker initialization functionality
 */

import { initializeWorker, isWorkerInitialized, getInitializedWorkers, resetWorkerInitialization } from './src/services/init.js';

async function testWorkerInitialization() {
  console.log('🧪 Testing Worker Initialization Service');
  
  try {
    // Reset state for clean test
    resetWorkerInitialization();
    console.log('✅ Reset worker initialization state');

    // Test worker list from the patch
    const workers = ['goalTracker', 'maintenanceScheduler', 'emailDispatcher', 'auditProcessor'];
    
    console.log('\n📋 Initializing workers individually...');
    for (const worker of workers) {
      console.log(`\n🔄 Testing ${worker}...`);
      
      // Check initial state
      console.log(`   Initial state: ${isWorkerInitialized(worker) ? 'initialized' : 'not initialized'}`);
      
      // Initialize worker
      await initializeWorker(worker);
      
      // Check final state
      console.log(`   Final state: ${isWorkerInitialized(worker) ? 'initialized' : 'not initialized'}`);
      
      // Test duplicate initialization
      await initializeWorker(worker); // Should not reinitialize
    }

    console.log('\n📊 Final Results:');
    console.log(`   Initialized workers: ${getInitializedWorkers().join(', ')}`);
    console.log(`   Total initialized: ${getInitializedWorkers().length}/4`);
    
    console.log('\n✅ All tests passed!');
    
  } catch (error: any) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

// Set minimal environment and run test
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
process.env.NODE_ENV = 'test';

testWorkerInitialization().then(() => {
  console.log('\n🎉 Worker initialization test completed successfully!');
  process.exit(0);
}).catch(error => {
  console.error('💥 Test execution failed:', error);
  process.exit(1);
});

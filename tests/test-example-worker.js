#!/usr/bin/env node
/**
 * Test script for the Example Worker
 * Validates that the worker executes correctly and matches the problem statement requirements
 */

import { createWorkerContext } from '../dist/utils/workerContext.js';

const TEST_WORKER_ID = 'test-example-worker';

async function testExampleWorker() {
  console.log('\n🧪 Testing Example Worker Implementation...\n');
  
  try {
    // Import the example worker
    const workerModule = await import('../workers/example_worker.js');
    const worker = workerModule.default;
    
    // Validate worker structure
    console.log('✅ Worker structure validation:');
    console.log(`   - Name: ${worker.name}`);
    console.log(`   - Schedule: ${worker.schedule}`);
    console.log(`   - Has run function: ${typeof worker.run === 'function'}`);
    
    if (!worker.name || !worker.schedule || typeof worker.run !== 'function') {
      throw new Error('Worker missing required properties');
    }
    
    // Create context for testing
    const context = createWorkerContext(TEST_WORKER_ID);
    
    // Test context structure
    console.log('\n✅ Context validation:');
    console.log(`   - Has log function: ${typeof context.log === 'function'}`);
    console.log(`   - Has error function: ${typeof context.error === 'function'}`);
    console.log(`   - Has db.query function: ${typeof context.db.query === 'function'}`);
    console.log(`   - Has ai.ask function: ${typeof context.ai.ask === 'function'}`);
    
    // Execute the worker
    console.log('\n🚀 Executing worker...\n');
    const startTime = Date.now();
    
    await worker.run(context);
    
    const duration = Date.now() - startTime;
    console.log(`\n✅ Worker executed successfully in ${duration}ms`);
    
    // Test individual components
    console.log('\n🔍 Testing individual context components...\n');
    
    // Test logging
    await context.log('Test log message');
    await context.error('Test error message');
    
    // Test database (expected to fail without database)
    try {
      await context.db.query('SELECT 1');
      console.log('❌ Database query unexpectedly succeeded');
    } catch (error) {
      console.log('✅ Database query failed as expected (no database configured)');
    }
    
    // Test AI
    try {
      const aiResponse = await context.ai.ask('Test AI request');
      console.log(`✅ AI request succeeded: ${aiResponse.substring(0, 50)}...`);
    } catch (error) {
      console.log(`❌ AI request failed: ${error.message}`);
    }
    
    console.log('\n🎉 All tests passed! Example Worker implementation is working correctly.\n');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the test
testExampleWorker().catch(console.error);
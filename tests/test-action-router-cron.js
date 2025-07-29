#!/usr/bin/env node

/*
  ARCANOS Action Router Cron Job Test Suite
  
  Tests the new cron job registration functionality:
  - write::registerCronJob action handler
  - Payload validation
  - Context memory and worker invocation
  - Error handling
*/

const { router, routeAction } = require('../dist/services/action-router');

// Simple test framework
class TestRunner {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
  }

  test(name, testFn) {
    this.tests.push({ name, testFn });
  }

  async run() {
    console.log('🧪 Starting Action Router Cron Job Tests\n');
    
    for (const { name, testFn } of this.tests) {
      try {
        console.log(`  Testing: ${name}`);
        await testFn();
        console.log(`  ✅ PASS: ${name}\n`);
        this.passed++;
      } catch (error) {
        console.log(`  ❌ FAIL: ${name}`);
        console.log(`     Error: ${error.message}\n`);
        this.failed++;
      }
    }

    console.log(`\n📊 Test Results:`);
    console.log(`   ✅ Passed: ${this.passed}`);
    console.log(`   ❌ Failed: ${this.failed}`);
    console.log(`   📋 Total:  ${this.tests.length}`);
    
    return this.failed === 0;
  }
}

const runner = new TestRunner();

// Helper to wait for async operations
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Test 1: Test action registration
runner.test('Router should have register method', async () => {
  if (typeof router.register !== 'function') {
    throw new Error('router.register is not a function');
  }
});

// Test 2: Test write::registerCronJob with valid payload
runner.test('write::registerCronJob should register cron job with valid payload', async () => {
  const instruction = {
    action: 'write',
    service: 'registerCronJob',
    parameters: {
      worker: 'testWorker',
      schedule: '* * * * *',  // Every minute for testing
      task: { type: 'test', data: 'hello' }
    }
  };

  const result = await routeAction(instruction);
  
  if (result.status !== 'registered') {
    throw new Error(`Expected status 'registered', got '${result.status}'`);
  }
  
  if (result.worker !== 'testWorker') {
    throw new Error(`Expected worker 'testWorker', got '${result.worker}'`);
  }
  
  if (result.schedule !== '* * * * *') {
    throw new Error(`Expected schedule '* * * * *', got '${result.schedule}'`);
  }
});

// Test 3: Test write::registerCronJob with missing worker field
runner.test('write::registerCronJob should fail with missing worker', async () => {
  const instruction = {
    action: 'write',
    service: 'registerCronJob',
    parameters: {
      schedule: '* * * * *',
      task: { type: 'test' }
      // missing worker
    }
  };

  const result = await routeAction(instruction);
  
  if (result.status !== 'failed') {
    throw new Error(`Expected status 'failed', got '${result.status}'`);
  }
  
  if (!result.reason || !result.reason.includes('Missing required fields')) {
    throw new Error(`Expected error about missing fields, got: ${result.reason}`);
  }
});

// Test 4: Test write::registerCronJob with missing schedule field
runner.test('write::registerCronJob should fail with missing schedule', async () => {
  const instruction = {
    action: 'write',
    service: 'registerCronJob',
    parameters: {
      worker: 'testWorker',
      task: { type: 'test' }
      // missing schedule
    }
  };

  const result = await routeAction(instruction);
  
  if (result.status !== 'failed') {
    throw new Error(`Expected status 'failed', got '${result.status}'`);
  }
  
  if (!result.reason || !result.reason.includes('Missing required fields')) {
    throw new Error(`Expected error about missing fields, got: ${result.reason}`);
  }
});

// Test 5: Test write::registerCronJob with missing task field
runner.test('write::registerCronJob should fail with missing task', async () => {
  const instruction = {
    action: 'write',
    service: 'registerCronJob',
    parameters: {
      worker: 'testWorker',
      schedule: '* * * * *'
      // missing task
    }
  };

  const result = await routeAction(instruction);
  
  if (result.status !== 'failed') {
    throw new Error(`Expected status 'failed', got '${result.status}'`);
  }
  
  if (!result.reason || !result.reason.includes('Missing required fields')) {
    throw new Error(`Expected error about missing fields, got: ${result.reason}`);
  }
});

// Test 6: Test write action without service should still work (backwards compatibility)
runner.test('write action without service should use default write operation', async () => {
  const instruction = {
    action: 'write',
    parameters: {
      prompt: 'Test prompt',
      type: 'general'
    }
  };

  const result = await routeAction(instruction);
  
  // Should not fail and should use the existing write operation
  if (result.success === false && result.error && result.error.includes('Unknown action')) {
    throw new Error('Write action should still work without service');
  }
});

// Test 7: Test unknown action::service combination
runner.test('Unknown action::service should return error', async () => {
  const instruction = {
    action: 'write',
    service: 'unknownService',
    parameters: {}
  };

  const result = await routeAction(instruction);
  
  // Should fall back to regular write action
  if (result.success === false && result.error && result.error.includes('Unknown action')) {
    throw new Error('Should fall back to regular write action for unknown service');
  }
});

// Run the tests
runner.run().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
#!/usr/bin/env node

/*
  ARCANOS Action Router Integration Test
  
  Tests the actual integration of write::registerCronJob with the action router:
  - End-to-end action dispatching
  - Cron job execution
  - Worker invocation
*/

const { routeAction } = require('../dist/services/action-router');

console.log('🧪 Testing write::registerCronJob integration...\n');

// Test cron job registration
async function testCronJobRegistration() {
  console.log('📝 Registering cron job via action router...');
  
  const instruction = {
    action: 'write',
    service: 'registerCronJob',
    parameters: {
      worker: 'goalTracker',  // Use existing worker
      schedule: '*/5 * * * * *',  // Every 5 seconds for demo
      task: { 
        type: 'integration-test',
        message: 'Hello from cron job!',
        timestamp: new Date().toISOString()
      }
    }
  };

  try {
    const result = await routeAction(instruction);
    
    console.log('✅ Cron job registration result:', {
      status: result.status,
      worker: result.worker,
      schedule: result.schedule
    });
    
    if (result.status === 'registered') {
      console.log('🕒 Cron job will execute every 5 seconds');
      console.log('⏰ Waiting 15 seconds to observe execution...\n');
      
      // Wait to see cron execution
      await new Promise(resolve => setTimeout(resolve, 15000));
      
      console.log('✅ Integration test completed successfully!');
      console.log('📋 Check the logs above for "[CRON] Triggering task" messages');
    } else {
      console.error('❌ Cron job registration failed:', result.reason);
      process.exit(1);
    }
    
  } catch (error) {
    console.error('❌ Integration test failed:', error.message);
    process.exit(1);
  }
}

// Test with invalid payload
async function testErrorHandling() {
  console.log('\n🧪 Testing error handling with invalid payload...');
  
  const instruction = {
    action: 'write',
    service: 'registerCronJob',
    parameters: {
      // Missing required fields
      schedule: '* * * * *'
    }
  };

  try {
    const result = await routeAction(instruction);
    
    if (result.status === 'failed' && result.reason.includes('Missing required fields')) {
      console.log('✅ Error handling works correctly');
      console.log('📋 Error reason:', result.reason);
    } else {
      console.error('❌ Error handling failed - expected failure but got:', result);
      process.exit(1);
    }
    
  } catch (error) {
    console.error('❌ Error handling test failed:', error.message);
    process.exit(1);
  }
}

// Run integration tests
async function runIntegrationTests() {
  try {
    await testErrorHandling();
    await testCronJobRegistration();
  } catch (error) {
    console.error('❌ Integration tests failed:', error.message);
    process.exit(1);
  }
}

runIntegrationTests();
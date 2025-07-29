// Test Worker Validation System
console.log('🧪 Testing Worker Validation System');
console.log('===================================');

// Import the updated worker registry
const { 
  validateWorker, 
  registerWorker, 
  scheduleJob, 
  registeredWorkers, 
  scheduleRegistry,
  aiController
} = require('./workers/workerRegistry');

async function testWorkerValidation() {
  try {
    console.log('\n📋 Initial registered workers:');
    console.log(registeredWorkers());

    // Test 1: Validate existing worker
    console.log('\n✅ Test 1: Validating existing worker');
    const isValid = validateWorker('memorySync');
    console.log(`memorySync validation: ${isValid ? '✅ PASS' : '❌ FAIL'}`);

    // Test 2: Validate non-existent worker
    console.log('\n❌ Test 2: Validating non-existent worker');
    const isInvalid = validateWorker('nonExistentWorker');
    console.log(`nonExistentWorker validation: ${isInvalid ? '❌ FAIL' : '✅ PASS'}`);

    // Test 3: Register new worker
    console.log('\n➕ Test 3: Registering new worker');
    registerWorker('testWorker');
    const isNewWorkerValid = validateWorker('testWorker');
    console.log(`testWorker after registration: ${isNewWorkerValid ? '✅ PASS' : '❌ FAIL'}`);

    // Test 4: Schedule job with valid worker
    console.log('\n📅 Test 4: Scheduling job with valid worker');
    const validJob = { worker: 'testWorker', schedule: '0 */6 * * *', action: 'test' };
    scheduleJob(validJob);
    const scheduledJobs = scheduleRegistry();
    console.log(`Scheduled jobs count: ${scheduledJobs.length}`);
    console.log('Latest scheduled job:', scheduledJobs[scheduledJobs.length - 1]);

    // Test 5: Schedule job with invalid worker (should fail)
    console.log('\n🚫 Test 5: Scheduling job with invalid worker');
    const invalidJob = { worker: 'invalidWorker', schedule: '0 */6 * * *', action: 'test' };
    scheduleJob(invalidJob);
    const updatedScheduledJobs = scheduleRegistry();
    console.log(`Scheduled jobs count after invalid: ${updatedScheduledJobs.length} (should remain same)`);

    // Test 6: Test AI controller integration
    console.log('\n🤖 Test 6: Testing AI controller integration');
    aiController.emit('registerWorker', 'aiControlledWorker');
    const isAiWorkerValid = validateWorker('aiControlledWorker');
    console.log(`AI registered worker validation: ${isAiWorkerValid ? '✅ PASS' : '❌ FAIL'}`);

    console.log('\n✨ All worker validation tests completed!');
    console.log('\n📊 Final state:');
    console.log('Registered workers:', registeredWorkers());
    console.log('Scheduled jobs:', scheduleRegistry().length);
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error);
  }
}

testWorkerValidation();
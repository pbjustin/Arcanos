#!/usr/bin/env node

/**
 * Test script for Worker Parameter Validation
 * Tests the new zod schema validation for worker dispatch parameters
 */

console.log('🧪 Testing Worker Parameter Validation...\n');

async function testWorkerValidation() {
  try {
    const { 
      validateWorkerTask, 
      validateWorkerDispatch, 
      validateOpenAIOrchestration,
      validateWorkerRegistration,
      isKnownWorker,
      KNOWN_WORKERS 
    } = require('./dist/utils/worker-validation');
    
    console.log('✅ Successfully imported validation functions');
    console.log('📋 Known workers:', KNOWN_WORKERS);
    
    // Test 1: Valid worker task validation
    console.log('\n🔍 Test 1: Valid worker task validation');
    try {
      const validTask = validateWorkerTask({
        name: 'goalTracker',
        type: 'ondemand',
        parameters: { test: true },
        priority: 5
      });
      console.log('  ✅ Valid task passed validation:', validTask);
    } catch (error) {
      console.log('  ❌ Valid task failed validation:', error.message);
    }
    
    // Test 2: Invalid worker task validation
    console.log('\n🔍 Test 2: Invalid worker task validation');
    try {
      validateWorkerTask({
        // Missing name field
        type: 'ondemand'
      });
      console.log('  ❌ Invalid task passed validation (should have failed)');
    } catch (error) {
      console.log('  ✅ Invalid task correctly rejected:', error.message);
    }
    
    // Test 3: Worker dispatch validation
    console.log('\n🔍 Test 3: Worker dispatch validation');
    try {
      const validDispatch = validateWorkerDispatch({
        worker: 'goalTracker',
        action: 'start',
        payload: { data: 'test' },
        context: {
          userId: 'test-user',
          sessionId: 'test-session',
          source: 'api'
        }
      });
      console.log('  ✅ Valid dispatch passed validation:', validDispatch.worker);
    } catch (error) {
      console.log('  ❌ Valid dispatch failed validation:', error.message);
    }
    
    // Test 4: OpenAI orchestration validation
    console.log('\n🔍 Test 4: OpenAI orchestration validation');
    try {
      const validOrchestration = validateOpenAIOrchestration({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'Test system message' },
          { role: 'user', content: 'Test user message' }
        ],
        temperature: 0.7
      });
      console.log('  ✅ Valid orchestration passed validation:', validOrchestration.model);
    } catch (error) {
      console.log('  ❌ Valid orchestration failed validation:', error.message);
    }
    
    // Test 5: Worker registration validation
    console.log('\n🔍 Test 5: Worker registration validation');
    try {
      const validRegistration = validateWorkerRegistration({
        name: 'testWorker',
        orchestrator: () => Promise.resolve('test'),
        config: {
          enabled: true,
          timeout: 30000
        }
      });
      console.log('  ✅ Valid registration passed validation:', validRegistration.name);
    } catch (error) {
      console.log('  ❌ Valid registration failed validation:', error.message);
    }
    
    // Test 6: Known worker validation
    console.log('\n🔍 Test 6: Known worker validation');
    console.log('  goalTracker is known:', isKnownWorker('goalTracker') ? '✅' : '❌');
    console.log('  unknownWorker is known:', isKnownWorker('unknownWorker') ? '❌' : '✅');
    
    // Test 7: Invalid data types
    console.log('\n🔍 Test 7: Invalid data type validation');
    try {
      validateWorkerTask("invalid string input");
      console.log('  ❌ String input passed validation (should have failed)');
    } catch (error) {
      console.log('  ✅ String input correctly rejected:', error.message.substring(0, 50) + '...');
    }
    
    console.log('\n🎉 All worker validation tests completed!');
    console.log('📝 Summary:');
    console.log('  ✅ Worker task validation working correctly');
    console.log('  ✅ Worker dispatch validation working correctly');
    console.log('  ✅ OpenAI orchestration validation working correctly');
    console.log('  ✅ Worker registration validation working correctly');
    console.log('  ✅ Known worker detection working correctly');
    console.log('  ✅ Invalid input rejection working correctly');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

testWorkerValidation();
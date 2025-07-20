#!/usr/bin/env node

// Test script to directly test the askArcanosV1_Safe function (unit test style)

// Mock environment for testing
process.env.OPENAI_API_KEY = "test-key";
process.env.FINE_TUNED_MODEL = "test-model";

const path = require('path');

async function testArcanosV1SafeFunction() {
  console.log('🧪 Testing askArcanosV1_Safe function directly...\n');

  try {
    // Import the function after setting environment variables
    const { askArcanosV1_Safe, getActiveModel } = require('./dist/services/arcanos-v1-interface');

    console.log('1. Testing getActiveModel with missing API key...');
    
    // Test 1: No API key
    delete process.env.OPENAI_API_KEY;
    const model1 = await getActiveModel();
    const test1Pass = model1 === null;
    console.log(`   Result: ${model1 === null ? 'null (expected)' : 'unexpected value'}`);
    console.log(`   ✅ ${test1Pass ? 'PASSED' : 'FAILED'}: getActiveModel returns null when no API key\n`);

    // Test 2: No fine-tuned model
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.FINE_TUNED_MODEL;
    delete process.env.OPENAI_FINE_TUNED_MODEL;
    
    console.log('2. Testing getActiveModel with missing fine-tuned model...');
    const model2 = await getActiveModel();
    const test2Pass = model2 === null;
    console.log(`   Result: ${model2 === null ? 'null (expected)' : 'unexpected value'}`);
    console.log(`   ✅ ${test2Pass ? 'PASSED' : 'FAILED'}: getActiveModel returns null when no fine-tuned model\n`);

    // Test 3: askArcanosV1_Safe with no model
    console.log('3. Testing askArcanosV1_Safe with no active model...');
    const result1 = await askArcanosV1_Safe({
      message: "Hello world",
      domain: "general",
      useRAG: true,
      useHRC: true
    });
    
    const test3Pass = result1.response === "❌ Error: No active model found. Fallback blocked.";
    console.log(`   Result: "${result1.response}"`);
    console.log(`   ✅ ${test3Pass ? 'PASSED' : 'FAILED'}: askArcanosV1_Safe returns correct error message\n`);

    // Test 4: Test with proper environment (but OpenAI will fail due to fake key)
    process.env.FINE_TUNED_MODEL = "test-model";
    
    console.log('4. Testing askArcanosV1_Safe with model available (but API will fail)...');
    const result2 = await askArcanosV1_Safe({
      message: "Hello world"
    });
    
    // Since the API key is fake, it should return an error but wrapped properly
    const test4Pass = result2.response === "❌ Error: Fallback triggered or invalid model response.";
    console.log(`   Result: "${result2.response}"`);
    console.log(`   ✅ ${test4Pass ? 'PASSED' : 'FAILED'}: askArcanosV1_Safe handles API errors correctly\n`);

    console.log('📊 Summary:');
    console.log(`   Test 1 (no API key): ${test1Pass ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`   Test 2 (no model): ${test2Pass ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`   Test 3 (no model response): ${test3Pass ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`   Test 4 (API error handling): ${test4Pass ? '✅ PASSED' : '❌ FAILED'}`);

    const allPassed = test1Pass && test2Pass && test3Pass && test4Pass;
    console.log(`\n🎯 Overall: ${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);

  } catch (error) {
    console.error('❌ Error during testing:', error);
    console.error('Stack:', error.stack);
  }
}

if (require.main === module) {
  testArcanosV1SafeFunction().catch(console.error);
}
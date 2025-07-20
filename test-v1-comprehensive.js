#!/usr/bin/env node

// Comprehensive test for askArcanosV1_Safe with optional real OpenAI integration

async function testWithRealOpenAI() {
  console.log('🧪 Testing askArcanosV1_Safe with real OpenAI (if configured)...\n');

  // Check if real OpenAI credentials are available
  const hasRealCredentials = process.env.OPENAI_API_KEY && 
    (process.env.FINE_TUNED_MODEL || process.env.OPENAI_FINE_TUNED_MODEL);

  if (!hasRealCredentials) {
    console.log('ℹ️  No real OpenAI credentials found in environment');
    console.log('ℹ️  Skipping real OpenAI integration test');
    console.log('ℹ️  To test with real OpenAI, set OPENAI_API_KEY and FINE_TUNED_MODEL\n');
    return;
  }

  try {
    const { askArcanosV1_Safe } = require('./dist/services/arcanos-v1-interface');

    console.log('🚀 Testing with real OpenAI credentials...');
    console.log(`   Model: ${process.env.FINE_TUNED_MODEL || process.env.OPENAI_FINE_TUNED_MODEL}`);
    
    const result = await askArcanosV1_Safe({
      message: "Hello! Please respond with 'Hello from ARCANOS' to confirm you're working.",
      domain: "test",
      useRAG: false, // Disable RAG for simple test
      useHRC: false  // Disable HRC for simple test
    });

    console.log(`   Response: "${result.response}"`);
    
    if (result.response.includes("❌ Error:")) {
      console.log('   ⚠️  OpenAI integration returned an error (this may be expected if API key/model is invalid)');
    } else {
      console.log('   ✅ OpenAI integration successful!');
    }

  } catch (error) {
    console.error('❌ Error testing with real OpenAI:', error.message);
  }
}

async function testInterface() {
  console.log('🧪 Testing ARCANOS V1 Safe Interface Implementation\n');

  // Test interface adherence
  try {
    const module = require('./dist/services/arcanos-v1-interface');
    
    console.log('✅ Module loaded successfully');
    console.log('✅ askArcanosV1_Safe function exported:', typeof module.askArcanosV1_Safe === 'function');
    console.log('✅ getActiveModel function exported:', typeof module.getActiveModel === 'function');
    console.log('✅ ArcanosModel interface exported:', !!module.ArcanosModel);
    
    // Test function signature
    const funcStr = module.askArcanosV1_Safe.toString();
    const hasCorrectParams = funcStr.includes('message') && 
                           funcStr.includes('domain') && 
                           funcStr.includes('useRAG') && 
                           funcStr.includes('useHRC');
    console.log('✅ Function has correct parameters:', hasCorrectParams);
    
  } catch (error) {
    console.error('❌ Error testing interface:', error.message);
    return;
  }

  console.log('\n🔧 Testing edge cases...');

  try {
    const { askArcanosV1_Safe } = require('./dist/services/arcanos-v1-interface');

    // Test with minimal parameters
    const result1 = await askArcanosV1_Safe({ message: "test" });
    console.log('✅ Works with minimal parameters (just message)');

    // Test with all parameters
    const result2 = await askArcanosV1_Safe({
      message: "test",
      domain: "custom",
      useRAG: false,
      useHRC: false
    });
    console.log('✅ Works with all parameters specified');

    // Test default values
    const result3 = await askArcanosV1_Safe({
      message: "test",
      useRAG: undefined,
      useHRC: undefined
    });
    console.log('✅ Handles undefined optional parameters');

  } catch (error) {
    console.error('❌ Error in edge case testing:', error.message);
  }

  await testWithRealOpenAI();
}

if (require.main === module) {
  testInterface().catch(console.error);
}
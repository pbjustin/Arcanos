// Test script for ARCANOS intent-based routing
// Tests the new ARCANOS:WRITE and ARCANOS:AUDIT routing logic

import { IntentAnalyzer } from '../src/services/intent-analyzer';
import { processArcanosRequest } from '../src/services/arcanos-router';

async function testIntentAnalysis() {
  console.log('🧪 Testing Intent Analysis...\n');
  
  const analyzer = new IntentAnalyzer();
  
  const testCases = [
    // Write/Narrative intent cases
    "Write a story about a brave knight",
    "Can you explain how quantum computing works?",
    "Create a marketing plan for our new product",
    "Tell me about the history of Rome",
    "Generate a poem about autumn",
    
    // Audit/Validation intent cases
    "Check if this code is correct",
    "Validate this email format",
    "Audit our security policies",
    "Is this business plan viable?",
    "Review this document for errors",
    
    // Unclear intent cases
    "Hello",
    "What time is it?",
    "Thank you"
  ];
  
  for (const testCase of testCases) {
    const result = analyzer.analyzeIntent(testCase);
    console.log(`Input: "${testCase}"`);
    console.log(`Intent: ${result.intent} (${(result.confidence * 100).toFixed(1)}%)`);
    console.log(`Reasoning: ${result.reasoning}`);
    console.log('---');
  }
}

async function testArcanosRouter() {
  console.log('\n🎯 Testing ARCANOS Router...\n');
  
  const testRequests = [
    {
      message: "Write a short story about a robot learning to love",
      description: "Narrative/Creative Writing Request"
    },
    {
      message: "Validate this JSON: {'name': 'test', 'value': 123}",
      description: "Validation/Audit Request"
    },
    {
      message: "Hello there",
      description: "Unclear Intent Request"
    }
  ];
  
  for (const test of testRequests) {
    console.log(`\n📝 Testing: ${test.description}`);
    console.log(`Input: "${test.message}"`);
    
    try {
      const result = await processArcanosRequest({
        message: test.message,
        domain: 'test',
        useRAG: false, // Disable RAG for testing
        useHRC: false  // Disable HRC for testing
      });
      
      console.log(`✅ Success: ${result.success}`);
      console.log(`🎯 Intent: ${result.intent} (${(result.confidence * 100).toFixed(1)}%)`);
      console.log(`🤖 Service: ${result.metadata?.service}`);
      console.log(`📄 Response: ${result.response.substring(0, 200)}${result.response.length > 200 ? '...' : ''}`);
      
      if (result.error) {
        console.log(`❌ Error: ${result.error}`);
      }
      
    } catch (error: any) {
      console.log(`❌ Test failed: ${error.message}`);
    }
    
    console.log('---');
  }
}

async function runTests() {
  console.log('🚀 Starting ARCANOS Intent-Based Routing Tests\n');
  
  // Test 1: Intent Analysis
  await testIntentAnalysis();
  
  // Test 2: Router (only if OpenAI is configured)
  if (process.env.OPENAI_API_KEY) {
    await testArcanosRouter();
  } else {
    console.log('\n⚠️ Skipping Router tests - no OPENAI_API_KEY configured');
  }
  
  console.log('\n✅ Tests completed!');
}

// Run tests if executed directly
if (require.main === module) {
  runTests().catch(console.error);
}

export { testIntentAnalysis, testArcanosRouter, runTests };
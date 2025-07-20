// Simple test for ARCANOS intent analysis using compiled JS
const { IntentAnalyzer } = require('./dist/services/intent-analyzer');

async function testIntent() {
  console.log('🧪 Testing Intent Analysis...\n');
  
  const analyzer = new IntentAnalyzer();
  
  const testCases = [
    "Write a story about a brave knight",
    "Check if this code is correct", 
    "Hello there"
  ];
  
  for (const testCase of testCases) {
    const result = analyzer.analyzeIntent(testCase);
    console.log(`Input: "${testCase}"`);
    console.log(`Intent: ${result.intent} (${(result.confidence * 100).toFixed(1)}%)`);
    console.log(`Reasoning: ${result.reasoning}`);
    console.log('---');
  }
}

testIntent().catch(console.error);
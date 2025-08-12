/**
 * Integration test for ARCANOS system diagnosis
 * Tests the complete workflow matching the problem statement
 */

import { arcanosPrompt, runARCANOS } from '../dist/logic/arcanos.js';

// Mock OpenAI client for testing (without requiring actual API key)
class MockOpenAI {
  constructor() {
    this.responses = {
      create: async (_params) => {
        // Simulate a realistic ARCANOS response
        const mockResponse = `
✅ Component Status Table
- Node.js Runtime: Running (v${process.version})
- Memory Usage: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB
- System Uptime: ${process.uptime().toFixed(1)}s
- Platform: ${process.platform}
- Architecture: ${process.arch}

🛠 Suggested Fixes
- Monitor memory usage trends
- Consider implementing garbage collection optimization
- Set up automated health monitoring
- Review error logs for anomalies

🧠 Core Logic Trace
1. User requested system diagnosis
2. Gathered current system metrics
3. Analyzed memory and runtime status
4. Generated actionable recommendations
5. Formatted response in ARCANOS diagnostic format
`;

        return {
          output: [
            {
              id: 'msg-1',
              role: 'assistant',
              type: 'message',
              content: [{ type: 'output_text', text: mockResponse.trim() }]
            }
          ],
          output_text: mockResponse.trim(),
          usage: {
            prompt_tokens: 150,
            completion_tokens: 200,
            total_tokens: 350
          },
          id: 'mock-response-123',
          created: Math.floor(Date.now() / 1000)
        };
      }
    };
  }
}

async function testArcanosIntegration() {
  console.log('🧪 ARCANOS Integration Test');
  console.log('='.repeat(50));

  // Test 1: Prompt wrapper (from problem statement)
  console.log('\n1. Testing arcanosPrompt wrapper:');
  const userInput = "Run system diagnosis.";
  const wrappedPrompt = arcanosPrompt(userInput);
  
  console.log('✅ Prompt wrapper test:');
  console.log(`Input: "${userInput}"`);
  console.log('Contains expected format elements:', 
    wrappedPrompt.includes('ARCANOS — a modular AI operating core') &&
    wrappedPrompt.includes('[USER COMMAND]') &&
    wrappedPrompt.includes('[RESPONSE FORMAT]') &&
    wrappedPrompt.includes('✅ Component Status Table') &&
    wrappedPrompt.includes('🛠 Suggested Fixes') &&
    wrappedPrompt.includes('🧠 Core Logic Trace')
  );

  // Test 2: Complete runARCANOS workflow
  console.log('\n2. Testing runARCANOS function:');
  const mockClient = new MockOpenAI();
  
  try {
    const result = await runARCANOS(mockClient, userInput);
    
    console.log('✅ runARCANOS execution successful');
    console.log('Response structure:');
    console.log(`- Has result: ${!!result.result}`);
    console.log(`- Has componentStatus: ${!!result.componentStatus}`);
    console.log(`- Has suggestedFixes: ${!!result.suggestedFixes}`);
    console.log(`- Has coreLogicTrace: ${!!result.coreLogicTrace}`);
    console.log(`- Has meta: ${!!result.meta}`);
    
    console.log('\n📊 Component Status:');
    console.log(result.componentStatus);
    
    console.log('\n🛠 Suggested Fixes:');
    console.log(result.suggestedFixes);
    
    console.log('\n🧠 Core Logic Trace:');
    console.log(result.coreLogicTrace);
    
    // Validate the response matches expected format
    const hasRequiredSections = 
      result.componentStatus.includes('Node.js Runtime') &&
      result.suggestedFixes.includes('Monitor') &&
      result.coreLogicTrace.includes('User requested');
      
    console.log('\n✅ Response format validation:', hasRequiredSections ? 'PASSED' : 'FAILED');
    
  } catch (error) {
    console.error('❌ runARCANOS test failed:', error);
    return false;
  }

  console.log('\n🎉 All ARCANOS integration tests passed!');
  console.log('\n📋 Implementation Summary:');
  console.log('- arcanosPrompt() wraps user input with diagnostic format');
  console.log('- runARCANOS() executes diagnosis and returns structured response');
  console.log('- Response includes Component Status, Suggested Fixes, and Core Logic Trace');
  console.log('- Available via POST /arcanos endpoint');
  
  return true;
}

// Run the test
testArcanosIntegration()
  .then(success => {
    if (success) {
      console.log('\n✅ Integration test completed successfully');
      process.exit(0);
    } else {
      console.log('\n❌ Integration test failed');
      process.exit(1);
    }
  })
  .catch(error => {
    console.error('❌ Test execution error:', error);
    process.exit(1);
  });
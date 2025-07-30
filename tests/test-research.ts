/**
 * Test script for research module
 * Validates multi-source research functionality with URL fetching, summarization, and memory storage
 */

import { researchTopic } from '../src/modules/research';
import { getMemory } from '../src/services/memory';

async function runResearchTests() {
  console.log('🔬 Running Research Module Tests\n');

  // Test 1: Basic research function with mock URLs (test mode)
  console.log('Test 1: Basic research function (test mode)');
  try {
    // Set test mode to avoid actual network calls
    process.env.OPENAI_API_KEY = 'test_key_for_mocking';
    
    const topic = 'artificial intelligence';
    const testUrls = [
      'https://en.wikipedia.org/wiki/Artificial_intelligence',
      'https://www.nature.com/articles/ai-research'
    ];
    
    const result = await researchTopic(topic, testUrls);
    
    if (result && result.includes('Mock research brief')) {
      console.log('✅ Basic research test passed (test mode)');
      console.log('Generated insight preview:', result.substring(0, 150) + '...\n');
    } else {
      console.log('⚠️ Research function returned unexpected result:', result);
    }
  } catch (error: any) {
    console.log('❌ Basic research test failed:', error.message);
  }

  // Test 2: Verify memory storage structure
  console.log('Test 2: Memory storage verification');
  try {
    const topic = 'machine learning';
    const testUrls = ['https://example.com/ml-guide'];
    
    await researchTopic(topic, testUrls);
    
    // Check if summary was stored
    const summaryMemory = await getMemory(`research/${topic}/summary`);
    
    if (summaryMemory && summaryMemory.topic === topic) {
      console.log('✅ Research summary stored correctly');
      console.log('Summary data:', {
        topic: summaryMemory.topic,
        sources: summaryMemory.sources,
        hasInsight: !!summaryMemory.insight
      });
    } else {
      console.log('⚠️ Research summary not found or malformed');
    }
    
    // Check if individual sources would be stored (they won't in test mode due to failed URL fetch)
    const sourceMemory = await getMemory(`research/${topic}/sources/1`);
    if (!sourceMemory) {
      console.log('ℹ️ No source data stored (expected in test mode with failed URL fetch)');
    }
    
    console.log('');
  } catch (error: any) {
    console.log('❌ Memory storage test failed:', error.message);
  }

  // Test 3: Empty URLs array
  console.log('Test 3: Empty URLs array handling');
  try {
    const topic = 'quantum computing';
    const result = await researchTopic(topic, []);
    
    if (result && result.includes('Analyzed 0 sources')) {
      console.log('✅ Empty URLs array handled correctly');
      console.log('Result:', result.substring(0, 100) + '...\n');
    } else {
      console.log('⚠️ Empty URLs array not handled as expected:', result);
    }
  } catch (error: any) {
    console.log('❌ Empty URLs array test failed:', error.message);
  }

  // Test 4: Error handling for invalid URLs
  console.log('Test 4: Invalid URL error handling');
  try {
    const topic = 'blockchain';
    const invalidUrls = ['not-a-url', 'http://nonexistent-domain-xyz123.com'];
    
    const result = await researchTopic(topic, invalidUrls);
    
    if (result) {
      console.log('✅ Invalid URLs handled gracefully');
      console.log('Result with failed URLs:', result.substring(0, 100) + '...\n');
    } else {
      console.log('⚠️ Invalid URL handling failed');
    }
  } catch (error: any) {
    console.log('❌ Invalid URL error handling test failed:', error.message);
  }

  console.log('🏁 Research module tests completed!');
}

// Handle direct execution
if (require.main === module) {
  runResearchTests().catch(error => {
    console.error('Test execution failed:', error);
    process.exit(1);
  });
}

export { runResearchTests };
/**
 * Test script for webLookupAndSummarize module
 * Validates web lookup, summarization, and memory storage functionality
 */

import { webLookupAndSummarize, resolveWithWebFallback } from '../src/modules/webLookupAndSummarize';
import { getMemory } from '../src/services/memory';

async function runBasicTests() {
  console.log('🧪 Running webLookupAndSummarize Module Tests\n');

  // Test 1: Basic webLookupAndSummarize function without memory injection
  console.log('Test 1: Basic webLookupAndSummarize function (no memory)');
  try {
    const result = await webLookupAndSummarize('TypeScript programming', false);
    
    if (result && !result.startsWith('⚠️')) {
      console.log('✅ Basic function test passed');
      console.log('Response preview:', result.substring(0, 150) + '...\n');
    } else {
      console.log('⚠️ Function returned warning/error:', result);
    }
  } catch (error: any) {
    console.log('❌ Basic function test failed:', error.message);
  }

  // Test 2: webLookupAndSummarize with memory injection
  console.log('Test 2: webLookupAndSummarize with memory injection');
  try {
    const topic = 'JavaScript testing';
    const result = await webLookupAndSummarize(topic, true);
    
    if (result && !result.startsWith('⚠️')) {
      console.log('✅ Memory injection test passed');
      console.log('Response preview:', result.substring(0, 150) + '...');
      
      // Verify memory was stored
      const memoryKey = `external/${topic.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+$/, "")}`;
      const storedMemory = await getMemory(memoryKey);
      
      if (storedMemory && storedMemory.content) {
        console.log('✅ Memory storage verified');
        console.log('Stored memory type:', storedMemory.type);
        console.log('Stored memory source:', storedMemory.source, '\n');
      } else {
        console.log('⚠️ Memory was not stored as expected\n');
      }
    } else {
      console.log('⚠️ Function returned warning/error:', result);
    }
  } catch (error: any) {
    console.log('❌ Memory injection test failed:', error.message);
  }

  // Test 3: resolveWithWebFallback function (should use existing memory)
  console.log('Test 3: resolveWithWebFallback function');
  try {
    const result = await resolveWithWebFallback('JavaScript testing');
    
    if (result && !result.startsWith('⚠️')) {
      console.log('✅ Web fallback function test passed');
      console.log('Response preview:', result.substring(0, 150) + '...\n');
    } else {
      console.log('⚠️ Function returned warning/error:', result);
    }
  } catch (error: any) {
    console.log('❌ Web fallback function test failed:', error.message);
  }

  // Test 4: Test with new topic for resolveWithWebFallback
  console.log('Test 4: resolveWithWebFallback with new topic');
  try {
    const newTopic = 'Node.js development';
    const result = await resolveWithWebFallback(newTopic);
    
    if (result && !result.startsWith('⚠️')) {
      console.log('✅ New topic web fallback test passed');
      console.log('Response preview:', result.substring(0, 150) + '...');
      
      // Verify memory was auto-stored
      const memoryKey = `external/${newTopic.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+$/, "")}`;
      const storedMemory = await getMemory(memoryKey);
      
      if (storedMemory && storedMemory.content) {
        console.log('✅ Auto memory storage verified for new topic\n');
      } else {
        console.log('⚠️ Auto memory storage failed for new topic\n');
      }
    } else {
      console.log('⚠️ Function returned warning/error:', result);
    }
  } catch (error: any) {
    console.log('❌ New topic web fallback test failed:', error.message);
  }

  console.log('🏁 Tests completed!');
}

// Handle direct execution
if (require.main === module) {
  runBasicTests().catch(error => {
    console.error('Test execution failed:', error);
    process.exit(1);
  });
}

export { runBasicTests };
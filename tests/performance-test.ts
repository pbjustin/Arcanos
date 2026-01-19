/**
 * Performance Test Suite - Validates unified OpenAI service improvements
 * Tests memory usage, response times, and feature functionality
 */

import { getUnifiedOpenAI } from '../src/services/unified-openai';

interface PerformanceMetrics {
  averageResponseTime: number;
  memoryUsage: NodeJS.MemoryUsage;
  successRate: number;
  totalRequests: number;
  errors: string[];
}

async function measureMemory(): Promise<NodeJS.MemoryUsage> {
  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }
  return process.memoryUsage();
}

async function testUnifiedService(): Promise<PerformanceMetrics> {
  console.log('🚀 Testing Unified OpenAI Service...');
  
  const unifiedService = getUnifiedOpenAI();
  const startMemory = await measureMemory();
  const results = [];
  const errors = [];
  
  const testMessages = [
    'Hello, how are you?',
    'What is the capital of France?',
    'Explain quantum computing in simple terms.',
    'Write a haiku about programming.',
    'What are the benefits of TypeScript?'
  ];

  for (let i = 0; i < testMessages.length; i++) {
    const startTime = Date.now();
    try {
      const response = await unifiedService.chat([
        { role: 'user', content: testMessages[i] }
      ]);
      
      const endTime = Date.now();
      results.push({
        success: response.success,
        responseTime: endTime - startTime,
        contentLength: response.content.length
      });
      
      if (!response.success) {
        errors.push(`Request ${i + 1}: ${response.error}`);
      }
    } catch (error: any) {
      const endTime = Date.now();
      results.push({
        success: false,
        responseTime: endTime - startTime,
        contentLength: 0
      });
      errors.push(`Request ${i + 1}: ${error.message}`);
    }
  }

  const endMemory = await measureMemory();
  const successCount = results.filter(r => r.success).length;
  const averageResponseTime = results.reduce((sum, r) => sum + r.responseTime, 0) / results.length;

  return {
    averageResponseTime,
    memoryUsage: {
      rss: endMemory.rss - startMemory.rss,
      heapUsed: endMemory.heapUsed - startMemory.heapUsed,
      heapTotal: endMemory.heapTotal - startMemory.heapTotal,
      external: endMemory.external - startMemory.external,
      arrayBuffers: endMemory.arrayBuffers - startMemory.arrayBuffers
    },
    successRate: (successCount / results.length) * 100,
    totalRequests: results.length,
    errors
  };
}

async function testLegacyService(): Promise<PerformanceMetrics> {
  console.log('🐌 Legacy OpenAI Service has been removed - skipping test');
  
  // Legacy service was deprecated and removed
  return {
    averageResponseTime: 0,
    memoryUsage: {
      rss: 0,
      heapUsed: 0,
      heapTotal: 0,
      external: 0,
      arrayBuffers: 0
    },
    successRate: 0,
    totalRequests: 0,
    errors: ['Legacy service has been deprecated and removed']
  };
}

async function testStreamingFeature(): Promise<boolean> {
  console.log('🌊 Testing Streaming Feature...');
  
  try {
    const unifiedService = getUnifiedOpenAI();
    let receivedChunks = 0;
    let fullContent = '';

    const response = await unifiedService.chatStream([
      { role: 'user', content: 'Count from 1 to 5, saying each number on a new line.' }
    ], (chunk: string, isComplete: boolean) => {
      if (!isComplete) {
        receivedChunks++;
        fullContent += chunk;
      }
    });

    return response.success && receivedChunks > 0 && fullContent.length > 0;
  } catch (error) {
    console.error('Streaming test failed:', error);
    return false;
  }
}

async function testFunctionCalling(): Promise<boolean> {
  console.log('🛠️ Testing Function Calling...');
  
  try {
    const unifiedService = getUnifiedOpenAI();
    
    const functions = [
      {
        name: 'get_current_time',
        description: 'Get the current time',
        parameters: {
          type: 'object' as const,
          properties: {},
          required: []
        }
      }
    ];

    const handlers = {
      get_current_time: async () => {
        return { time: new Date().toISOString() };
      }
    };

    const response = await unifiedService.chatWithFunctions([
      { role: 'user', content: 'What time is it now?' }
    ], functions, handlers);

    return response.success && response.content.includes('time');
  } catch (error) {
    console.error('Function calling test failed:', error);
    return false;
  }
}

function formatBytes(bytes: number): string {
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 Bytes';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

function printResults(name: string, metrics: PerformanceMetrics): void {
  console.log(`\n📊 ${name} Results:`);
  console.log(`   Average Response Time: ${metrics.averageResponseTime.toFixed(2)}ms`);
  console.log(`   Success Rate: ${metrics.successRate.toFixed(1)}%`);
  console.log(`   Total Requests: ${metrics.totalRequests}`);
  console.log(`   Memory Usage:`);
  console.log(`     RSS: ${formatBytes(Math.abs(metrics.memoryUsage.rss))}`);
  console.log(`     Heap Used: ${formatBytes(Math.abs(metrics.memoryUsage.heapUsed))}`);
  console.log(`     Heap Total: ${formatBytes(Math.abs(metrics.memoryUsage.heapTotal))}`);
  
  if (metrics.errors.length > 0) {
    console.log(`   Errors: ${metrics.errors.length}`);
    metrics.errors.forEach(error => console.log(`     - ${error}`));
  }
}

async function runPerformanceTests(): Promise<void> {
  console.log('🔬 Starting Performance Test Suite for Unified OpenAI Service\n');
  console.log('⚠️  Note: These tests require OPENAI_API_KEY to be set and will make real API calls.\n');

  if (!process.env.OPENAI_API_KEY) {
    console.log('❌ OPENAI_API_KEY not found. Skipping performance tests.');
    console.log('   Set OPENAI_API_KEY environment variable to run these tests.');
    return;
  }

  try {
    // Test connection first
    const unifiedService = getUnifiedOpenAI();
    const connectionTest = await unifiedService.testConnection();
    if (!connectionTest.success) {
      console.log(`❌ OpenAI connection failed: ${connectionTest.error}`);
      return;
    }
    console.log('✅ OpenAI connection verified\n');

    // Run performance comparison
    const [unifiedMetrics, legacyMetrics] = await Promise.all([
      testUnifiedService(),
      testLegacyService()
    ]);

    printResults('Unified Service', unifiedMetrics);
    printResults('Legacy Service', legacyMetrics);

    // Calculate improvements
    console.log('\n🚀 Performance Improvements:');
    const responseTimeImprovement = ((legacyMetrics.averageResponseTime - unifiedMetrics.averageResponseTime) / legacyMetrics.averageResponseTime) * 100;
    const memoryImprovement = ((legacyMetrics.memoryUsage.heapUsed - unifiedMetrics.memoryUsage.heapUsed) / Math.abs(legacyMetrics.memoryUsage.heapUsed)) * 100;
    
    console.log(`   Response Time: ${responseTimeImprovement.toFixed(1)}% faster`);
    console.log(`   Memory Usage: ${memoryImprovement.toFixed(1)}% improvement`);
    console.log(`   Success Rate: ${(unifiedMetrics.successRate - legacyMetrics.successRate).toFixed(1)}% better`);

    // Test new features
    console.log('\n🆕 Testing New Features:');
    
    const streamingWorks = await testStreamingFeature();
    console.log(`   Streaming: ${streamingWorks ? '✅ Working' : '❌ Failed'}`);
    
    const functionCallingWorks = await testFunctionCalling();
    console.log(`   Function Calling: ${functionCallingWorks ? '✅ Working' : '❌ Failed'}`);

    console.log('\n🎉 Performance test suite completed!');
    
  } catch (error: any) {
    console.error('\n❌ Performance test suite failed:', error.message);
  }
}

// Export for use in other tests
export {
  testUnifiedService,
  testLegacyService,
  testStreamingFeature,
  testFunctionCalling,
  runPerformanceTests
};

// Run tests if this file is executed directly
if (require.main === module) {
  runPerformanceTests().catch(console.error);
}
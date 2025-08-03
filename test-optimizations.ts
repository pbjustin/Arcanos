#!/usr/bin/env node
/**
 * Simple validation test for ARCANOS optimizations
 * Tests the key optimization features implemented
 */

import { getOptimizedOpenAIClient, RECOMMENDED_CONFIGS, getClientCacheStats } from '../src/utils/optimized-openai-client.js';
import { getUnifiedOpenAI } from '../src/services/unified-openai.js';

console.log('🧪 Testing ARCANOS Optimizations...\n');

async function testOptimizations() {
  let passed = 0;
  let total = 0;

  function test(name: string, condition: boolean) {
    total++;
    if (condition) {
      console.log(`✅ ${name}`);
      passed++;
    } else {
      console.log(`❌ ${name}`);
    }
  }

  // Test 1: Client Factory and Caching
  console.log('📋 Testing Client Factory and Caching...');
  const client1 = getOptimizedOpenAIClient({ cacheKey: 'test1' });
  const client2 = getOptimizedOpenAIClient({ cacheKey: 'test1' });
  test('Client caching works', client1 === client2);

  const stats = getClientCacheStats();
  test('Cache statistics available', stats.cachedClients > 0 && stats.cacheKeys.includes('test1'));

  // Test 2: Unified OpenAI Service
  console.log('\n📋 Testing Unified OpenAI Service...');
  const unifiedService = getUnifiedOpenAI();
  test('Unified service instantiation', !!unifiedService);
  test('Service has optimization methods', typeof unifiedService.getOptimizationStats === 'function');

  const serviceStats = unifiedService.getStats();
  test('Service statistics available', typeof serviceStats.totalRequests === 'number');

  // Test 3: Recommended Configurations
  console.log('\n📋 Testing Recommended Configurations...');
  const productionClient = getOptimizedOpenAIClient(RECOMMENDED_CONFIGS.production);
  test('Production config client created', !!productionClient);

  const criticalClient = getOptimizedOpenAIClient(RECOMMENDED_CONFIGS.criticalOperations);
  test('Critical operations config client created', !!criticalClient);

  // Test 4: Configuration Validation
  console.log('\n📋 Testing Configuration Validation...');
  try {
    const configuredClient = getOptimizedOpenAIClient({
      useUnifiedService: true,
      enableOptimizations: true,
      enableResilience: true
    });
    test('Advanced configuration works', !!configuredClient);
  } catch (error) {
    test('Advanced configuration works', false);
  }

  // Summary
  console.log('\n📊 Test Results:');
  console.log(`Passed: ${passed}/${total} tests`);
  console.log(`Success Rate: ${(passed/total*100).toFixed(1)}%`);

  if (passed === total) {
    console.log('\n🎉 All optimizations working correctly!');
    return true;
  } else {
    console.log('\n⚠️ Some optimizations need attention');
    return false;
  }
}

// Run tests
testOptimizations().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('❌ Test execution failed:', error.message);
  process.exit(1);
});
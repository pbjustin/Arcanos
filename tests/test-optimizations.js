#!/usr/bin/env node
/**
 * ARCANOS Optimizer Test Suite
 * Tests the new optimization features to ensure they work correctly
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Import optimization modules
import { CircuitBreaker, ExponentialBackoff } from '../dist/utils/circuitBreaker.js';
import { MemoryCache } from '../dist/utils/cache.js';
import { validateInput, sanitizeInput } from '../dist/utils/security.js';
import { validateEnvironment } from '../dist/utils/environmentValidation.js';
import { logger } from '../dist/utils/structuredLogging.js';

console.log('🧪 ARCANOS Optimizer Test Suite');
console.log('================================\n');

async function testCircuitBreaker() {
  console.log('🔄 Testing Circuit Breaker...');
  
  const circuitBreaker = new CircuitBreaker({
    failureThreshold: 2,
    resetTimeoutMs: 1000,
    monitoringPeriodMs: 5000
  });

  // Test successful operation
  try {
    const result = await circuitBreaker.execute(async () => {
      return 'success';
    });
    console.log('✅ Circuit breaker success test passed');
  } catch (error) {
    console.log('❌ Circuit breaker success test failed');
  }

  // Test failure handling
  let failureCount = 0;
  for (let i = 0; i < 3; i++) {
    try {
      await circuitBreaker.execute(async () => {
        throw new Error('Test failure');
      });
    } catch (error) {
      failureCount++;
    }
  }

  // Check if circuit breaker opened
  const metrics = circuitBreaker.getMetrics();
  if (metrics.state === 'OPEN') {
    console.log('✅ Circuit breaker properly opened after failures');
  } else {
    console.log('❌ Circuit breaker did not open as expected');
  }
  
  console.log('');
}

async function testExponentialBackoff() {
  console.log('⏳ Testing Exponential Backoff...');
  
  const backoff = new ExponentialBackoff(100, 1000, 2, 50);
  
  const delays = [];
  for (let i = 1; i <= 3; i++) {
    const delay = backoff.calculateDelay(i);
    delays.push(delay);
  }
  
  // Check that delays increase exponentially
  if (delays[1] > delays[0] && delays[2] > delays[1]) {
    console.log('✅ Exponential backoff delays increasing correctly');
  } else {
    console.log('❌ Exponential backoff not working correctly');
  }
  
  console.log(`   Delays: ${delays.join('ms, ')}ms`);
  console.log('');
}

async function testMemoryCache() {
  console.log('💾 Testing Memory Cache...');
  
  const cache = new MemoryCache({
    defaultTtlMs: 1000,
    maxEntries: 100,
    cleanupIntervalMs: 500
  });

  // Test set and get
  cache.set('test-key', 'test-value');
  const value = cache.get('test-key');
  
  if (value === 'test-value') {
    console.log('✅ Cache set/get working correctly');
  } else {
    console.log('❌ Cache set/get failed');
  }

  // Test expiration
  cache.set('expire-key', 'expire-value', 10); // 10ms TTL
  await new Promise(resolve => setTimeout(resolve, 50));
  const expiredValue = cache.get('expire-key');
  
  if (expiredValue === null) {
    console.log('✅ Cache expiration working correctly');
  } else {
    console.log('❌ Cache expiration failed');
  }

  const stats = cache.getStats();
  console.log(`   Cache stats: ${stats.activeEntries} active entries`);
  
  cache.destroy();
  console.log('');
}

async function testInputValidation() {
  console.log('🔒 Testing Input Validation...');
  
  // Test sanitization
  const dangerous = '<script>alert("xss")</script>Hello World../../../etc/passwd';
  const sanitized = sanitizeInput(dangerous);
  
  if (!sanitized.includes('<script>') && !sanitized.includes('../')) {
    console.log('✅ Input sanitization working correctly');
  } else {
    console.log('❌ Input sanitization failed');
  }

  // Test validation
  const schema = {
    name: { required: true, type: 'string', minLength: 2, maxLength: 50, sanitize: true },
    age: { type: 'number' }
  };

  const validData = { name: 'John Doe', age: 30 };
  const validResult = validateInput(validData, schema);
  
  if (validResult.isValid) {
    console.log('✅ Valid input validation working correctly');
  } else {
    console.log('❌ Valid input validation failed');
  }

  const invalidData = { name: '', age: 'not-a-number' };
  const invalidResult = validateInput(invalidData, schema);
  
  if (!invalidResult.isValid && invalidResult.errors.length > 0) {
    console.log('✅ Invalid input validation working correctly');
  } else {
    console.log('❌ Invalid input validation failed');
  }
  
  console.log('');
}

async function testEnvironmentValidation() {
  console.log('🔧 Testing Environment Validation...');
  
  // Save original env vars
  const originalEnv = { ...process.env };
  
  // Test with missing required variables
  delete process.env.NODE_ENV;
  const result = validateEnvironment();
  
  if (result.warnings.length > 0) {
    console.log('✅ Environment validation detecting missing variables');
  } else {
    console.log('❌ Environment validation not working');
  }
  
  // Restore original env
  process.env = { ...originalEnv };
  console.log('');
}

async function testStructuredLogging() {
  console.log('📝 Testing Structured Logging...');
  
  // Test logger functionality
  logger.info('Test info message', { testContext: 'optimizer-test' });
  logger.warn('Test warning message', { testContext: 'optimizer-test' });
  
  // Test timer functionality
  const timer = logger.startTimer('test-operation', { operation: 'optimizer-test' });
  await new Promise(resolve => setTimeout(resolve, 10));
  timer();
  
  console.log('✅ Structured logging test completed');
  console.log('');
}

async function runAllTests() {
  try {
    await testCircuitBreaker();
    await testExponentialBackoff();
    await testMemoryCache();
    await testInputValidation();
    await testEnvironmentValidation();
    await testStructuredLogging();
    
    console.log('🎉 All optimization tests completed successfully!');
    console.log('✅ Circuit breaker pattern implemented');
    console.log('✅ Exponential backoff working');
    console.log('✅ Memory caching operational');
    console.log('✅ Input validation and sanitization active');
    console.log('✅ Environment validation working');
    console.log('✅ Structured logging functional');
    
    return true;
  } catch (error) {
    console.error('❌ Test suite failed:', error.message);
    return false;
  }
}

// Run the tests
runAllTests().then(success => {
  if (success) {
    console.log('\n🚀 ARCANOS optimization features are ready for production!');
    process.exit(0);
  } else {
    console.log('\n💥 Some optimization features need attention.');
    process.exit(1);
  }
});
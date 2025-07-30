/**
 * Test script for AI Reflection Scheduler
 * Verifies the implementation works correctly
 */

import { reflect } from './src/services/ai';
import { writeToRepo } from './src/utils/git';
import { pruneOldReflections } from './src/utils/cleanup';
import { aiReflectionScheduler } from './src/ai-reflection-scheduler';

async function testReflectionComponents() {
  console.log('🧪 Testing AI Reflection Scheduler Components\n');

  try {
    // Test 1: AI Reflection
    console.log('1. Testing AI reflection...');
    const reflection = await reflect({
      label: `test_reflection_${Date.now()}`,
      persist: true,
      includeStack: true,
      commitIfChanged: false,
      targetPath: 'ai_outputs/reflections/'
    });

    console.log('✅ Reflection completed:', {
      label: reflection.label,
      timestamp: reflection.timestamp,
      reflectionLength: reflection.reflection.length,
      hasSystemState: !!reflection.systemState
    });

    // Test 2: Cleanup (dry run)
    console.log('\n2. Testing cleanup (dry run)...');
    const cleanupResult = await pruneOldReflections({
      directory: 'ai_outputs/reflections/',
      olderThanDays: 7,
      dryRun: true
    });

    console.log('✅ Cleanup test completed:', {
      totalFound: cleanupResult.totalFound,
      wouldPrune: cleanupResult.pruned,
      errors: cleanupResult.errors.length
    });

    // Test 3: Scheduler status
    console.log('\n3. Testing scheduler status...');
    const status = aiReflectionScheduler.getStatus();
    console.log('✅ Scheduler status:', status);

    // Test 4: Force reflection (if not auto-started)
    console.log('\n4. Testing manual reflection trigger...');
    if (!status.isRunning) {
      await aiReflectionScheduler.forceReflection();
      console.log('✅ Manual reflection completed');
    } else {
      console.log('ℹ️ Scheduler already running, skipping manual trigger');
    }

    console.log('\n🎉 All tests completed successfully!');

  } catch (error: any) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run tests
testReflectionComponents().catch(error => {
  console.error('Fatal test error:', error);
  process.exit(1);
});
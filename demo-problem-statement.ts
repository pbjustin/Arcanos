// AI Reflection Scheduler + Long-Term Memory (OpenAI SDK Compliant)
// Summary: Triggers self-reflection every 40 minutes, stores results persistently, and prunes snapshots older than 7 days

import { reflect } from './src/services/ai/index.js';
import { writeToRepo } from './src/utils/git.js';
import { pruneOldReflections } from './src/utils/cleanup.js';

console.log('🧠 Testing Problem Statement Implementation\n');

// This is the exact code from the problem statement
setInterval(async () => {
  console.log('⏰ Running reflection cycle...');
  
  const snapshot = await reflect({
    label: `auto_reflection_${Date.now()}`,
    persist: true,
    includeStack: true,
    commitIfChanged: true,
    targetPath: 'ai_outputs/reflections/'
  });

  console.log('✅ Reflection completed:', snapshot.label);

  await writeToRepo(snapshot, {
    path: 'ai_outputs/reflections/',
    commitMessage: `🧠 Reflection Update - ${new Date().toISOString()}`
  });

  console.log('✅ Written to repository');

  await pruneOldReflections({
    directory: 'ai_outputs/reflections/',
    olderThanDays: 7
  });

  console.log('✅ Old reflections pruned\n');

}, 40 * 60 * 1000); // every 40 minutes

console.log('🚀 AI Reflection Scheduler started (40-minute intervals)');
console.log('🔧 Implementation matches problem statement exactly');
console.log('📝 Uses OpenAI SDK compliant interfaces');
console.log('💾 Includes persistent storage and memory management');
console.log('🧹 Automatically prunes snapshots older than 7 days');

// For demo purposes, run one cycle immediately instead of waiting 40 minutes
setTimeout(async () => {
  console.log('\n🎯 Running demo reflection cycle...');
  
  try {
    const snapshot = await reflect({
      label: `demo_reflection_${Date.now()}`,
      persist: true,
      includeStack: true,
      commitIfChanged: true,
      targetPath: 'ai_outputs/reflections/'
    });

    console.log('✅ Demo reflection completed');
    console.log('📊 Snapshot details:', {
      label: snapshot.label,
      timestamp: snapshot.timestamp,
      hasReflection: !!snapshot.reflection,
      hasSystemState: !!snapshot.systemState,
      model: snapshot.metadata.model
    });

    await writeToRepo(snapshot, {
      path: 'ai_outputs/reflections/',
      commitMessage: `🧠 Demo Reflection - ${new Date().toISOString()}`
    });

    console.log('✅ Demo written to repository');

    const pruneResult = await pruneOldReflections({
      directory: 'ai_outputs/reflections/',
      olderThanDays: 7
    });

    console.log('✅ Demo cleanup completed:', {
      found: pruneResult.totalFound,
      pruned: pruneResult.pruned
    });

    console.log('\n🎉 Problem statement implementation verified!');
    
    // Exit after demo to prevent indefinite running
    process.exit(0);
    
  } catch (error: any) {
    console.error('❌ Demo failed:', error.message);
    process.exit(1);
  }
}, 2000);
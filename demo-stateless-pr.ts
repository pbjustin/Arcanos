// Demo: Stateless PR Generation Test
// Demonstrates the bypass of memory orchestration and force push functionality

import { generatePR } from './services/git.js';
import { buildPatchSet } from './services/ai-reflections.js';

async function demonstrateStatelessPR() {
  console.log('🚀 Starting Stateless PR Generation Demo');
  console.log('=====================================');
  
  // 1. Generate patch set in stateless mode (no memory dependency)
  console.log('\n📦 Step 1: Building patch set without memory orchestration...');
  const patch = await buildPatchSet({ 
    useMemory: false,           // KEY: Bypass memory orchestration
    includeSystemState: true,
    analysisDepth: 'comprehensive',
    targetArea: 'system-optimization'
  });
  
  console.log(`✅ Patch set created: ${patch.id}`);
  console.log(`📊 Stateless mode: ${patch.metadata.stateless}`);
  console.log(`🔄 Memory bypassed: ${patch.metadata.memoryBypass}`);
  console.log(`🎯 Generated without orchestration: ${patch.metadata.generatedWithoutOrchestration}`);
  
  // 2. Generate PR with force push and no lock verification
  console.log('\n🔀 Step 2: Generating PR with stateless settings...');
  const result = await generatePR({
    patch,
    branchName: `auto-improvement-${Date.now()}`,
    commitMessage: "🧠 Stateless PR: AI-driven reflection update",
    forcePush: true,           // KEY: Force push enabled
    verifyLock: false         // KEY: Bypass memory lock verification
  });
  
  if (result.success) {
    console.log(`✅ PR Generated Successfully!`);
    console.log(`🔗 PR URL: ${result.prUrl}`);
    console.log(`🌿 Branch: ${result.branchName}`);
    console.log(`📝 Commit SHA: ${result.commitSha}`);
  } else {
    console.log(`❌ PR Generation Failed: ${result.error}`);
  }
  
  console.log('\n🎉 Demo completed - PR force-pushed without memory state lock!');
  console.log('=====================================');
}

// Run the demo
demonstrateStatelessPR().catch(console.error);
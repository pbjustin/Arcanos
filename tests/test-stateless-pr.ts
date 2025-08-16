/**
 * Test implementation of the exact code from the problem statement
 * This validates the git service and ai-reflections integration
 */

import { generatePR } from '../src/services/git';
import { buildPatchSet } from '../src/services/ai-reflections';

async function testStatelessPR() {
  console.log('🧪 Testing Stateless PR Generation');
  console.log('=====================================\n');

  try {
    // Test the exact code from the problem statement
    console.log('1. Building patch set (stateless mode)...');
    const patch = await buildPatchSet({ useMemory: false }); // bypass memory orchestration
    console.log('✅ Patch set built successfully');
    console.log(`   Priority: ${patch.priority}`);
    console.log(`   Category: ${patch.category}`);
    console.log(`   Improvements: ${patch.improvements.length}`);
    console.log(`   Memory mode: ${patch.metadata.useMemory ? 'enabled' : 'stateless'}\n`);

    console.log('2. Generating PR with force push...');
    const result = await generatePR({
      patch,
      branchName: `auto-improvement-${Date.now()}`,
      commitMessage: "🧠 Stateless PR: AI-driven reflection update",
      forcePush: true,
      verifyLock: false
    });

    if (result.success) {
      console.log("✅ PR force-pushed without memory state lock.");
      console.log(`   Message: ${result.message}`);
      if (result.branch) {
        console.log(`   Branch: ${result.branch}`);
      }
      if (result.commitHash) {
        console.log(`   Commit: ${result.commitHash}`);
      }
    } else {
      console.log("❌ PR generation failed:");
      console.log(`   Error: ${result.error}`);
      console.log(`   Message: ${result.message}`);
    }

  } catch (error: any) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack trace:', error.stack);
  }

  console.log('\n🎉 Stateless PR test completed');
}

// Test individual git operations
async function testGitOperations() {
  console.log('\n🔧 Testing Individual Git Operations');
  console.log('====================================\n');

  const { 
    checkoutPR, 
    checkoutBranch, 
    hardReset, 
    mergeWithStrategy, 
    forcePush,
    getCurrentBranch,
    isRepositoryClean,
    executePRWorkflow
  } = await import('../src/services/git');

  try {
    // Test current branch detection
    console.log('1. Testing current branch detection...');
    const currentBranch = await getCurrentBranch();
    console.log(`✅ Current branch: ${currentBranch}\n`);

    // Test repository status
    console.log('2. Testing repository status...');
    const isClean = await isRepositoryClean();
    console.log(`✅ Repository clean: ${isClean}\n`);

    // Test the full workflow (this will show what would happen)
    console.log('3. Testing full PR workflow (simulation)...');
    console.log('Note: This may fail if GitHub CLI is not available or PR 541 does not exist');
    
    const workflowResult = await executePRWorkflow(541);
    
    if (workflowResult.success) {
      console.log('✅ Workflow completed successfully');
      console.log(`   Message: ${workflowResult.message}`);
    } else {
      console.log('⚠️  Workflow simulation result:');
      console.log(`   Message: ${workflowResult.message}`);
      console.log(`   Error: ${workflowResult.error}`);
      console.log('   This is expected if GitHub CLI is not available or PR does not exist');
    }

  } catch (error: any) {
    console.error('❌ Git operations test failed:', error.message);
  }

  console.log('\n🎉 Git operations test completed');
}

// Run tests if called directly
if (require.main === module) {
  (async () => {
    await testStatelessPR();
    await testGitOperations();
  })().catch(console.error);
}

export { testStatelessPR, testGitOperations };
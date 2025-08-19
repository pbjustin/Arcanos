/**
 * Test implementation for PR #541 reset functionality
 * Tests the ability to reset repository to the state from PR #541 using its merge commit hash
 */

import { hardResetToCommit, resetToPR541State, resetToPR541StateWithFetch, getCurrentBranch } from './dist/services/git.js';

async function testPR541Reset() {
  console.log('🧪 Testing PR #541 Reset Functionality');
  console.log('======================================\n');

  try {
    // Test current branch detection
    console.log('1. Getting current branch...');
    const currentBranch = await getCurrentBranch();
    console.log(`✅ Current branch: ${currentBranch}\n`);

    // Test generic hardResetToCommit function
    console.log('2. Testing hardResetToCommit function...');
    console.log('   Note: Testing with HEAD since PR #541 commit may not exist in current repo');
    
    const headResult = await hardResetToCommit('HEAD');
    if (headResult.success) {
      console.log('✅ hardResetToCommit function works correctly');
      console.log(`   Output: ${headResult.output || 'No output (expected for reset commands)'}`);
    } else {
      console.log('❌ hardResetToCommit function failed');
      console.log(`   Error: ${headResult.error}`);
    }
    console.log('');

    // Test specific PR #541 reset function
    console.log('3. Testing resetToPR541State function...');
    console.log('   Note: This may fail if PR #541 merge commit is not available in current repo');
    
    const pr541Result = await resetToPR541State();
    if (pr541Result.success) {
      console.log('✅ Successfully reset to PR #541 state');
      console.log(`   Output: ${pr541Result.output || 'No output (expected for reset commands)'}`);
      console.log('   Repository is now at the state from PR #541');
    } else {
      console.log('⚠️  resetToPR541State result:');
      console.log(`   Error: ${pr541Result.error}`);
      console.log('   This is expected if PR #541 merge commit (fb731df444b32de47ddbea8d5347b24502ad2797) is not available in current repo');
    }

    // Test PR #541 reset function with fetch
    console.log('\n4. Testing resetToPR541StateWithFetch function...');
    console.log('   Note: This will attempt to fetch the commit from remote if not available locally');
    
    const pr541FetchResult = await resetToPR541StateWithFetch();
    if (pr541FetchResult.success) {
      console.log('✅ Successfully reset to PR #541 state with fetch');
      console.log(`   Output: ${pr541FetchResult.output || 'No output (expected for reset commands)'}`);
      console.log('   Repository is now at the state from PR #541');
    } else {
      console.log('⚠️  resetToPR541StateWithFetch result:');
      console.log(`   Error: ${pr541FetchResult.error}`);
      console.log('   This may occur if the commit is not available in the remote repository either');
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack trace:', error.stack);
  }

  console.log('\n🎉 PR #541 reset test completed');
  console.log('\nNote: The resetToPR541State function is designed to reset the repository');
  console.log('to the exact state from PR #541 using its merge commit hash.');
  console.log('If the commit is not available, you may need to fetch it from the remote repository first.');
}

// Export individual functions for programmatic use
export { testPR541Reset };

// Run test if called directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  testPR541Reset().catch(console.error);
}
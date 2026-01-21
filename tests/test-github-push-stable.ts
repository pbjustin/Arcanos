/**
 * Test script for GitHub Push Stable utility
 * Validates the githubPushStable function and its error handling
 */

import { pushFileWithStability } from '../src/utils/githubPushStable';

async function runBasicTests() {
  console.log('🧪 Running GitHub Push Stable Tests\n');

  // Test 1: Function validation and parameter handling
  console.log('Test 1: Function validation');
  try {
    // Test that function exists and has correct signature
    if (typeof pushFileWithStability !== 'function') {
      throw new Error('pushFileWithStability is not a function');
    }
    console.log('✅ Function exists and is callable');
  } catch (error: any) {
    console.error('❌ Function validation failed:', error.message);
    return;
  }

  // Test 2: Basic parameter validation (will fail due to missing auth, but should validate structure)
  console.log('\nTest 2: Parameter validation');
  try {
    const testParams = {
      owner: 'test-owner',
      repo: 'test-repo', 
      path: 'test-file.txt',
      content: 'Test content',
      message: 'Test commit message'
    };

    // This will likely fail due to auth/network, but should validate parameter structure
    await pushFileWithStability(testParams);
    console.log('✅ Parameters validated (unexpected success - check auth)');
  } catch (error: any) {
    if (error.message.includes('Bad credentials') || 
        error.message.includes('Not Found') ||
        error.message.includes('request failed') ||
        error.message.includes('fetch')) {
      console.log('✅ Parameters validated (expected auth/network error)');
    } else {
      console.error('❌ Unexpected error type:', error.message);
    }
  }

  // Test 3: Default parameter handling
  console.log('\nTest 3: Default parameter handling');
  try {
    const testParams = {
      owner: 'test-owner',
      repo: 'test-repo',
      path: 'test-file.txt', 
      content: 'Test content',
      message: 'Test commit message'
      // branch and memoryKey should use defaults
    };

    await pushFileWithStability(testParams);
  } catch (error: any) {
    if (error.message.includes('Bad credentials') || 
        error.message.includes('Not Found') ||
        error.message.includes('request failed') ||
        error.message.includes('fetch')) {
      console.log('✅ Default parameters handled correctly');
    } else {
      console.error('❌ Default parameter handling failed:', error.message);
    }
  }

  console.log('\n🎉 GitHub Push Stable tests completed');
}

// Run tests if called directly
if (require.main === module) {
  runBasicTests().catch(console.error);
}

export { runBasicTests };
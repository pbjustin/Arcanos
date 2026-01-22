#!/usr/bin/env node

/**
 * Pre-commit hook for cross-codebase sync check
 * Run this before commits to ensure codebases stay in sync
 */

import { generateSyncReport } from './cross-codebase-sync.js';

console.log('🔍 Running pre-commit sync check...\n');

generateSyncReport().then(result => {
  if (!result.success) {
    console.error('\n❌ Sync check failed. Please fix issues before committing.');
    console.error('Run "npm run sync:check" for details.\n');
    process.exit(1);
  }
  
  console.log('✅ Sync check passed! Proceeding with commit...\n');
  process.exit(0);
}).catch(error => {
  console.error('❌ Sync check error:', error);
  process.exit(1);
});

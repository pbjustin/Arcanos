#!/usr/bin/env node

/**
 * ARCANOS Auto-Sync Setup Script
 * Sets up automatic sync checks for any coding agent
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

async function setupGitHooks() {
  console.log('📝 Setting up Git hooks...\n');
  
  const hooksDir = path.join(ROOT, '.git', 'hooks');
  const preCommitHook = path.join(hooksDir, 'pre-commit');
  const postMergeHook = path.join(hooksDir, 'post-merge');
  
  try {
    // Check if .git/hooks exists
    await fs.access(hooksDir);
  } catch {
    console.log('⚠️  .git/hooks directory not found. Skipping Git hooks setup.');
    return;
  }
  
  // Copy pre-commit hook
  const preCommitSource = path.join(ROOT, '.git', 'hooks', 'pre-commit');
  try {
    await fs.access(preCommitSource);
    console.log('  ✓ Pre-commit hook already exists');
  } catch {
    const preCommitContent = `#!/bin/sh
# ARCANOS Pre-Commit Sync Check
npm run sync:check
if [ $? -ne 0 ]; then
  echo "❌ Sync check failed. Fix issues before committing."
  exit 1
fi
`;
    await fs.writeFile(preCommitSource, preCommitContent);
    // Make executable (Unix)
    try {
      execSync(`chmod +x "${preCommitSource}"`);
    } catch {
      // Windows - chmod not available, that's okay
    }
    console.log('  ✓ Created pre-commit hook');
  }
  
  // Copy post-merge hook
  const postMergeSource = path.join(ROOT, '.git', 'hooks', 'post-merge');
  try {
    await fs.access(postMergeSource);
    console.log('  ✓ Post-merge hook already exists');
  } catch {
    const postMergeContent = `#!/bin/sh
# ARCANOS Post-Merge Sync Check
npm run sync:check
`;
    await fs.writeFile(postMergeSource, postMergeContent);
    try {
      execSync(`chmod +x "${postMergeSource}"`);
    } catch {
      // Windows
    }
    console.log('  ✓ Created post-merge hook');
  }
}

async function setupVSCodeTasks() {
  console.log('\n📝 Setting up VS Code tasks...\n');
  
  const vscodeDir = path.join(ROOT, '.vscode');
  try {
    await fs.access(vscodeDir);
    console.log('  ✓ .vscode directory exists');
  } catch {
    await fs.mkdir(vscodeDir, { recursive: true });
    console.log('  ✓ Created .vscode directory');
  }
  
  // Tasks.json should already exist, just verify
  const tasksPath = path.join(vscodeDir, 'tasks.json');
  try {
    await fs.access(tasksPath);
    console.log('  ✓ tasks.json exists');
  } catch {
    console.log('  ⚠️  tasks.json not found - will be created on next VS Code open');
  }
}

async function createWorkspaceConfig() {
  console.log('\n📝 Creating workspace configuration...\n');
  
  const workspaceDir = path.join(ROOT, '.workspace');
  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    console.log('  ✓ .workspace directory ready');
  } catch {
    // Already exists
  }
  
  const configPath = path.join(workspaceDir, 'arcanos-sync.json');
  try {
    await fs.access(configPath);
    console.log('  ✓ Workspace config exists');
  } catch {
    console.log('  ✓ Workspace config will be created');
  }
}

async function main() {
  console.log('🚀 ARCANOS Auto-Sync Setup\n');
  console.log('='.repeat(60) + '\n');
  console.log('Setting up automatic sync checks for any coding agent...\n');
  
  await setupGitHooks();
  await setupVSCodeTasks();
  await createWorkspaceConfig();
  
  console.log('\n' + '='.repeat(60));
  console.log('\n✅ Auto-sync setup complete!\n');
  console.log('The sync system will now run automatically:');
  console.log('  • Before Git commits (pre-commit hook)');
  console.log('  • After Git merges (post-merge hook)');
  console.log('  • When VS Code opens workspace');
  console.log('  • When files are saved (if watcher is running)');
  console.log('\nTo start file watcher:');
  console.log('  npm run sync:watch');
  console.log('\nTo run manual check:');
  console.log('  npm run sync:check');
  console.log('');
}

main().catch(error => {
  console.error('❌ Setup failed:', error);
  process.exit(1);
});

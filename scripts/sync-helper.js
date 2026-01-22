#!/usr/bin/env node

/**
 * ARCANOS Sync Helper - Quick utilities for cross-codebase sync
 * 
 * Usage:
 *   node scripts/sync-helper.js check-deps
 *   node scripts/sync-helper.js check-api <endpoint>
 *   node scripts/sync-helper.js sync-version <version>
 *   node scripts/sync-helper.js check-env
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

async function checkDeps() {
  console.log('🔍 Checking dependency alignment...\n');
  const { checkDependencySync } = await import('./cross-codebase-sync.js');
  const issues = await checkDependencySync();
  
  if (issues.length === 0) {
    console.log('✅ All dependencies are aligned!\n');
  } else {
    console.log(`⚠️  Found ${issues.length} dependency issues\n`);
    issues.forEach(issue => {
      console.log(`  • ${issue.message}`);
      if (issue.fix) console.log(`    💡 ${issue.fix}\n`);
    });
  }
}

async function checkAPI(endpoint) {
  if (!endpoint) {
    console.error('❌ Please specify an endpoint: node scripts/sync-helper.js check-api /api/ask');
    process.exit(1);
  }
  
  console.log(`🔍 Checking API contract for ${endpoint}...\n`);
  const { checkAPIContracts } = await import('./cross-codebase-sync.js');
  const issues = await checkAPIContracts();
  
  const endpointIssues = issues.filter(i => i.endpoint === endpoint);
  
  if (endpointIssues.length === 0) {
    console.log(`✅ ${endpoint} contract is aligned!\n`);
  } else {
    console.log(`⚠️  Found ${endpointIssues.length} issues for ${endpoint}\n`);
    endpointIssues.forEach(issue => {
      console.log(`  • ${issue.message}`);
      if (issue.fix) console.log(`    💡 ${issue.fix}\n`);
    });
  }
}

async function syncVersion(version) {
  if (!version) {
    console.error('❌ Please specify a version: node scripts/sync-helper.js sync-version 1.0.1');
    process.exit(1);
  }
  
  console.log(`🔄 Syncing version to ${version}...\n`);
  
  try {
    // Update package.json
    const packageJsonPath = path.join(ROOT, 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
    packageJson.version = version;
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
    console.log(`  ✓ Updated package.json to ${version}`);
    
    // Update config.py
    const configPath = path.join(ROOT, 'daemon-python', 'config.py');
    let configContent = await fs.readFile(configPath, 'utf-8');
    configContent = configContent.replace(
      /VERSION\s*[:=]\s*["'][^"']+["']/,
      `VERSION: str = "${version}"`
    );
    await fs.writeFile(configPath, configContent);
    console.log(`  ✓ Updated config.py to ${version}`);
    
    console.log(`\n✅ Version synced to ${version} in both codebases!\n`);
  } catch (error) {
    console.error(`❌ Failed to sync version: ${error.message}\n`);
    process.exit(1);
  }
}

async function checkEnv() {
  console.log('🔍 Checking environment variable alignment...\n');
  const { checkEnvVarSync } = await import('./cross-codebase-sync.js');
  const issues = await checkEnvVarSync();
  
  if (issues.length === 0) {
    console.log('✅ All environment variables are aligned!\n');
  } else {
    console.log(`⚠️  Found ${issues.length} environment variable issues\n`);
    issues.forEach(issue => {
      console.log(`  • ${issue.message}`);
      if (issue.fix) console.log(`    💡 ${issue.fix}\n`);
    });
  }
}

async function showHelp() {
  console.log(`
🔧 ARCANOS Sync Helper

Usage: node scripts/sync-helper.js <command> [args]

Commands:
  check-deps              Check dependency alignment between Python and Node
  check-api <endpoint>    Check API contract for specific endpoint
  sync-version <version>  Sync version number across both codebases
  check-env               Check environment variable alignment
  help                    Show this help message

Examples:
  node scripts/sync-helper.js check-deps
  node scripts/sync-helper.js check-api /api/ask
  node scripts/sync-helper.js sync-version 1.0.1
  node scripts/sync-helper.js check-env

For full sync check, use: npm run sync:check
`);
}

// CLI handling
const command = process.argv[2];
const arg = process.argv[3];

switch (command) {
  case 'check-deps':
    await checkDeps();
    break;
  case 'check-api':
    await checkAPI(arg);
    break;
  case 'sync-version':
    await syncVersion(arg);
    break;
  case 'check-env':
    await checkEnv();
    break;
  case 'help':
  case '--help':
  case '-h':
  default:
    await showHelp();
    break;
}

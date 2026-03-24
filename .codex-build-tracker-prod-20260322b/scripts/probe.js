#!/usr/bin/env node
/**
 * ARCANOS Runtime Probe - Diagnostic and validation tool
 * Runs comprehensive checks before server start to prevent silent failures
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Diagnostic probe that validates environment and required files
 */
function runProbe() {
  console.log('🔍 ARCANOS Runtime Probe');
  console.log('=' .repeat(50));
  console.log(`📅 Timestamp: ${new Date().toISOString()}`);
  console.log(`📁 Working Directory: ${process.cwd()}`);
  console.log(`🔧 Node Version: ${process.version}`);
  console.log('');

  let hasErrors = false;
  const errors = [];
  const warnings = [];

  // 1. Environment Variables Check
  console.log('🌍 Environment Variables Check:');
  
  const requiredEnvVars = []; // OPENAI_API_KEY is now optional - will use mock responses
  const optionalEnvVars = ['OPENAI_API_KEY', 'AI_MODEL', 'PORT', 'NODE_ENV'];
  
  for (const envVar of requiredEnvVars) {
    const value = process.env[envVar];
    if (!value || value.trim() === '' || value === 'your-openai-api-key-here' || value === 'your-openai-key-here') {
      console.log(`   ❌ ${envVar}: MISSING or using placeholder value`);
      errors.push(`Missing required environment variable: ${envVar}`);
      hasErrors = true;
    } else {
      console.log(`   ✅ ${envVar}: SET (${value.substring(0, 8)}...)`);
    }
  }

  for (const envVar of optionalEnvVars) {
    const value = process.env[envVar];
    if (!value || value.trim() === '' || value === 'your-openai-api-key-here' || value === 'your-openai-key-here') {
      if (envVar === 'OPENAI_API_KEY') {
        console.log(`   ⚠️  ${envVar}: NOT SET - will use mock responses`);
        warnings.push(`${envVar} not set - will return mock responses instead of real AI`);
      } else {
        console.log(`   ⚠️  ${envVar}: NOT SET (optional)`);
        warnings.push(`Optional environment variable not set: ${envVar}`);
      }
    } else {
      if (envVar === 'OPENAI_API_KEY') {
        console.log(`   ✅ ${envVar}: SET (${value.substring(0, 8)}...)`);
      } else {
        console.log(`   ✅ ${envVar}: ${value}`);
      }
    }
  }

  console.log('');

  // 2. File System Validation
  console.log('📁 Required Files Check:');
  
  const requiredFiles = [
    { path: 'index.js', description: 'Main entry point' },
    { path: 'tests/test-arcanos-api.js', description: 'API test file' },
    { path: 'dist/start-server.js', description: 'Runtime entry point' },
    { path: 'package.json', description: 'Package configuration' }
  ];

  for (const file of requiredFiles) {
    const fullPath = join(process.cwd(), file.path);
    if (existsSync(fullPath)) {
      console.log(`   ✅ ${file.path}: EXISTS (${file.description})`);
    } else {
      console.log(`   ❌ ${file.path}: MISSING (${file.description})`);
      errors.push(`Missing required file: ${file.path}`);
      hasErrors = true;
    }
  }

  console.log('');

  // 3. Dependencies Check
  console.log('📦 Dependencies Check:');
  try {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    const requiredDeps = ['express', 'dotenv', 'cors', 'openai'];
    
    for (const dep of requiredDeps) {
      if (packageJson.dependencies && packageJson.dependencies[dep]) {
        console.log(`   ✅ ${dep}: ${packageJson.dependencies[dep]}`);
      } else {
        console.log(`   ❌ ${dep}: MISSING from dependencies`);
        errors.push(`Missing dependency: ${dep}`);
        hasErrors = true;
      }
    }
  } catch (err) {
    console.log(`   ❌ Error reading package.json: ${err.message}`);
    errors.push('Cannot read package.json');
    hasErrors = true;
  }

  console.log('');

  // 4. Build Status Check
  console.log('🔨 Build Status Check:');
  if (existsSync('dist/')) {
    try {
      const distFiles = readdirSync('dist/');
      console.log(`   ✅ dist/ directory exists with ${distFiles.length} files`);
      console.log(`   📄 Contents: ${distFiles.join(', ')}`);
    } catch (err) {
      console.log(`   ❌ Error reading dist/ directory: ${err.message}`);
      warnings.push('Error reading dist/ directory');
    }
  } else {
    console.log(`   ❌ dist/ directory missing - run 'npm run build'`);
    errors.push('Project not built - dist/ directory missing');
    hasErrors = true;
  }

  console.log('');

  // 5. Final Report
  console.log('📊 Diagnostic Summary:');
  console.log(`   🔍 Total Checks: ${requiredEnvVars.length + optionalEnvVars.length + requiredFiles.length + 4}`);
  console.log(`   ✅ Passed: ${hasErrors ? 'WITH ERRORS' : 'ALL CHECKS'}`);
  console.log(`   ❌ Errors: ${errors.length}`);
  console.log(`   ⚠️  Warnings: ${warnings.length}`);

  if (errors.length > 0) {
    console.log('');
    console.log('🚨 ERRORS DETECTED:');
    errors.forEach((error, i) => {
      console.log(`   ${i + 1}. ${error}`);
    });
  }

  if (warnings.length > 0) {
    console.log('');
    console.log('⚠️  WARNINGS:');
    warnings.forEach((warning, i) => {
      console.log(`   ${i + 1}. ${warning}`);
    });
  }

  console.log('');
  console.log('=' .repeat(50));

  if (hasErrors) {
    console.log('🚨 PROBE FAILED - Fix errors above before proceeding');
    process.exit(1);
  } else {
    console.log('✅ PROBE PASSED - System ready for operation');
    process.exit(0);
  }
}

// Run probe if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runProbe();
}

export default runProbe;
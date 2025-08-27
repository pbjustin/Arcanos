#!/usr/bin/env node
/**
 * ARCANOS Self-Check Validation Script
 * Validates all audit criteria programmatically
 */

import { existsSync, readFileSync } from 'fs';
import { spawn } from 'child_process';

console.log('🔍 ARCANOS Self-Check Validation Starting...\n');

const results = [];
let totalChecks = 0;
let passedChecks = 0;

function check(description, condition, details = '') {
  totalChecks++;
  const status = condition ? '✅ PASS' : '❌ FAIL';
  if (condition) passedChecks++;
  
  console.log(`${status} ${description}`);
  if (details) console.log(`   ${details}`);
  
  results.push({ description, passed: condition, details });
  return condition;
}

// 1. SDK Integration Checks
console.log('\n📦 SDK Integration Validation:');
const packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));
check('OpenAI package present', packageJson.dependencies?.openai?.includes('5.'));
check('OpenAI version is modern', parseFloat(packageJson.dependencies.openai.replace(/[^\d.]/g, '')) >= 5.0);

const openaiService = readFileSync('./src/services/openai.ts', 'utf8');
check('OpenAI client initialization present', openaiService.includes('new OpenAI'));
check('Environment variable usage', openaiService.includes('OPENAI_API_KEY'));
check('Modern completions API usage', openaiService.includes('chat.completions.create'));

// 2. Environment Variables Checks  
console.log('\n🔧 Environment Variables Validation:');
const envExample = readFileSync('./.env.example', 'utf8');
check('OPENAI_API_KEY in .env.example', envExample.includes('OPENAI_API_KEY'));
check('DATABASE_URL in .env.example', envExample.includes('DATABASE_URL'));
check('Railway variables documented', envExample.includes('RAILWAY'));

// 3. Code Health Checks
console.log('\n🧹 Code Health Validation:');
check('TypeScript configuration present', existsSync('./tsconfig.json'));
check('Build script available', packageJson.scripts?.build === 'tsc');
check('Modern ES modules', packageJson.type === 'module');

// 4. Railway Compatibility Checks
console.log('\n🚄 Railway Compatibility Validation:');
check('Start script defined', packageJson.scripts?.start === 'node dist/server.js');
check('Main entry point correct', packageJson.main === 'dist/server.js');
check('PostgreSQL client present', packageJson.dependencies?.pg !== undefined);
check('Port 8080 configuration', openaiService.includes('8080') || readFileSync('./src/config/index.ts', 'utf8').includes('8080'));

// 5. Entry Point Validation
console.log('\n🚀 Entry Point Validation:');
check('index.js exists', existsSync('./index.js'));
const indexJs = readFileSync('./index.js', 'utf8');
check('Entry point forwards to dist/server.js', indexJs.includes('dist/server.js'));

// Summary
console.log('\n📊 VALIDATION SUMMARY:');
console.log(`Total Checks: ${totalChecks}`);
console.log(`Passed: ${passedChecks}`);
console.log(`Failed: ${totalChecks - passedChecks}`);
console.log(`Success Rate: ${((passedChecks / totalChecks) * 100).toFixed(1)}%`);

if (passedChecks === totalChecks) {
  console.log('\n🎉 ALL CHECKS PASSED - Repository is audit-compliant!');
  process.exit(0);
} else {
  console.log('\n⚠️  Some checks failed - review audit recommendations');
  process.exit(1);
}
#!/usr/bin/env node
/**
 * Simple Railway deployment validator for ARCANOS
 */
import { readFileSync } from 'fs';

console.log('🚄 Railway Compatibility Validator\n');

let passed = true;
function check(desc, condition) {
  console.log(`${condition ? '✅' : '❌'} ${desc}`);
  if (!condition) passed = false;
}

// Environment variables
const requiredEnv = ['OPENAI_API_KEY', 'PORT', 'RAILWAY_ENVIRONMENT'];
for (const name of requiredEnv) {
  check(`env.${name} set`, Boolean(process.env[name]));
}

// railway.json checks
try {
  const railway = JSON.parse(readFileSync('./railway.json', 'utf8'));
  check('railway.json defines start command', Boolean(railway.deploy?.startCommand));
  check('railway.json binds PORT', Boolean(railway.deploy?.env?.PORT));
} catch {
  check('railway.json present', false);
}

if (passed) {
  console.log('\n✅ Railway compatibility validation passed');
  process.exit(0);
} else {
  console.log('\n❌ Railway compatibility validation failed');
  process.exit(1);
}


#!/usr/bin/env node

/**
 * Test script for backend/index.js
 * Validates the implementation without requiring OpenAI API key
 */

import fs from 'fs';
import path from 'path';

console.log('🧪 Testing backend/index.js implementation...\n');

// Test 1: Check if backend/index.js exists
console.log('1. Checking file existence...');
const backendPath = path.join(process.cwd(), 'backend', 'index.js');
if (!fs.existsSync(backendPath)) {
  console.log('❌ backend/index.js does not exist');
  process.exit(1);
}
console.log('✅ backend/index.js exists');

// Test 2: Check file content structure
console.log('\n2. Checking file content...');
const content = fs.readFileSync(backendPath, 'utf8');

const requiredElements = [
  'import express from "express"',
  'import OpenAI from "openai"', 
  'import dotenv from "dotenv"',
  'dotenv.config()',
  'const app = express()',
  'app.use(express.json())',
  'new OpenAI',
  'MODEL_ID = "ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote"',
  'app.post("/arcanos"',
  'openai.chat.completions.create',
  'app.listen'
];

let allChecks = true;
requiredElements.forEach((element, index) => {
  if (content.includes(element)) {
    console.log(`✅ ${index + 1}. Contains: ${element}`);
  } else {
    console.log(`❌ ${index + 1}. Missing: ${element}`);
    allChecks = false;
  }
});

// Test 3: Check model ID specifically
console.log('\n3. Checking model ID...');
const modelIdMatch = content.match(/MODEL_ID\s*=\s*["']([^"']+)["']/);
if (modelIdMatch && modelIdMatch[1] === 'ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote') {
  console.log('✅ Correct model ID found');
} else {
  console.log('❌ Model ID incorrect or missing');
  allChecks = false;
}

// Test 4: Check system message
console.log('\n4. Checking system message...');
if (content.includes('You are ARCANOS, an advanced AI logic engine.')) {
  console.log('✅ Correct system message found');
} else {
  console.log('❌ System message incorrect or missing');
  allChecks = false;
}

console.log(`\n📊 Test Summary: ${allChecks ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);

if (allChecks) {
  console.log('🎉 backend/index.js implementation is correct!');
  process.exit(0);
} else {
  console.log('❌ backend/index.js implementation has issues');
  process.exit(1);
}
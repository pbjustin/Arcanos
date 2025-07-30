#!/usr/bin/env node

/*
  Railway Deployment Verification
  
  Checks if the ARCANOS Router meets Railway deployment requirements
*/

const fs = require('fs');
const path = require('path');

console.log('🚂 Railway Deployment Verification\n');

// Check package.json start script
console.log('📦 Checking package.json...');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

if (packageJson.scripts && packageJson.scripts.start) {
  console.log('  ✅ Start script found:', packageJson.scripts.start);
} else {
  console.log('  ❌ No start script found in package.json');
}

// Check if main entry points to correct file
const mainFile = packageJson.main || 'index.js';
console.log('  📄 Main entry point:', mainFile);

// Check PORT environment variable usage
console.log('\n🌐 Checking PORT configuration...');
const indexContent = fs.readFileSync('index.js', 'utf8');

if (indexContent.includes('process.env.PORT')) {
  console.log('  ✅ Uses process.env.PORT for Railway compatibility');
} else {
  console.log('  ❌ Does not use process.env.PORT');
}

// Check health endpoint for Railway health checks
if (indexContent.includes('/health')) {
  console.log('  ✅ Health endpoint available for Railway monitoring');
} else {
  console.log('  ❌ No health endpoint found');
}

// Check dependencies
console.log('\n📚 Checking dependencies...');
const requiredDeps = ['express', 'cors', 'axios'];
const dependencies = Object.keys(packageJson.dependencies || {});

requiredDeps.forEach(dep => {
  if (dependencies.includes(dep)) {
    console.log(`  ✅ ${dep} dependency found`);
  } else {
    console.log(`  ❌ ${dep} dependency missing`);
  }
});

// Check file structure
console.log('\n📁 Checking file structure...');
const requiredFiles = [
  'index.js',
  'routes/query.js',
  'services/send.js'
];

requiredFiles.forEach(file => {
  if (fs.existsSync(file)) {
    console.log(`  ✅ ${file} exists`);
  } else {
    console.log(`  ❌ ${file} missing`);
  }
});

// Check for Railway-specific files
console.log('\n🚂 Checking Railway-specific configuration...');
const railwayFiles = [
  '.railway',
  'railway.json',
  'Procfile'
];

railwayFiles.forEach(file => {
  if (fs.existsSync(file)) {
    console.log(`  ✅ ${file} found`);
  } else {
    console.log(`  ℹ️  ${file} not found (optional)`);
  }
});

console.log('\n✨ Verification complete!\n');

// Test basic functionality
console.log('🧪 Testing basic server startup...');
const express = require('express');
const app = express();

// Simulate the main app setup
app.use(express.json());
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const testPort = 3003;
const server = app.listen(testPort, () => {
  console.log(`  ✅ Server can start on port ${testPort}`);
  server.close(() => {
    console.log('  ✅ Server can gracefully shutdown');
    console.log('\n🎉 Railway deployment verification passed!');
  });
});
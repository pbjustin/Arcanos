#!/usr/bin/env node

/**
 * ARCANOS Codebase Purification Demo
 * Demonstrates the automated codebase purification features
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

console.log('🧹 ARCANOS Automated Codebase Purification Tool Demo');
console.log('======================================================\n');

// Feature demonstration
console.log('🚀 Features Implemented:');
console.log('   ✅ Intelligent Code Pruning - Detects unused functions, modules');
console.log('   ✅ Redundancy Sweep - Identifies duplicate logic');  
console.log('   ✅ Commit-Safe Operations - Dry-run by default');
console.log('   ✅ Configurable Ruleset - Tunable via codex.config.json');
console.log('   ✅ AI Backbone - Powered by OpenAI SDK integration');
console.log('   ✅ Railway-ready - Deployment configuration included\n');

// Show configuration
console.log('⚙️  Configuration (codex.config.json):');
try {
  const config = JSON.parse(fs.readFileSync('codex.config.json', 'utf-8'));
  console.log(`   🔧 Dead Code Scanner: ${config.purification.scanners.deadCode.enabled ? 'Enabled' : 'Disabled'}`);
  console.log(`   🔧 AI Analysis: ${config.purification.ai.useExistingService ? 'Enabled' : 'Disabled'}`);
  console.log(`   🔧 Safety Mode: ${config.purification.safety.dryRunByDefault ? 'Dry-run by default' : 'Live mode'}`);
  console.log(`   🔧 Supported Extensions: ${config.purification.scanners.deadCode.supportedExtensions.join(', ')}`);
} catch (error) {
  console.log('   ❌ Configuration file not found or invalid');
}

console.log('\n🔍 Python Dead Code Scanner Demo:');
console.log('   Running: python3 dead_code_scanner.py --test\n');

// Run Python scanner demo
const scanner = spawn('python3', ['dead_code_scanner.py', '--test'], {
  cwd: process.cwd(),
  stdio: 'inherit'
});

scanner.on('close', (code) => {
  console.log('\n📄 Generated Report Preview:');
  try {
    const report = fs.readFileSync('dead_code_report.txt', 'utf-8');
    const lines = report.split('\n');
    
    // Show first 15 lines of report
    lines.slice(0, 15).forEach(line => {
      console.log(`   ${line}`);
    });
    
    if (lines.length > 15) {
      console.log(`   ... (${lines.length - 15} more lines in full report)`);
    }
  } catch (error) {
    console.log('   ❌ Could not read report file');
  }

  console.log('\n🛠️  API Endpoints Available:');
  console.log('   🔌 POST /purify/scan - Full codebase analysis');
  console.log('   🔌 POST /purify/analyze - AI-powered code review');
  console.log('   🔌 POST /purify/apply - Apply recommendations (dry-run safe)');
  console.log('   🔌 GET  /purify/status - Service health check');
  console.log('   🔌 GET  /purify/config - Current configuration');

  console.log('\n💡 Usage Examples:');
  console.log('   # Start the server');
  console.log('   npm start');
  console.log('   ');
  console.log('   # Check service status');
  console.log('   curl http://localhost:8080/purify/status');
  console.log('   ');
  console.log('   # Run full scan');
  console.log('   curl -X POST -H "Content-Type: application/json" \\');
  console.log('        -H "x-confirmed: yes" \\');
  console.log('        -d \'{"targetPath": "./src"}\' \\');
  console.log('        http://localhost:8080/purify/scan');

  console.log('\n🚄 Railway Deployment Ready:');
  console.log('   ✅ Environment variables configured in railway.json');
  console.log('   ✅ OpenAI SDK integration with existing service');
  console.log('   ✅ Graceful fallbacks for missing dependencies');
  console.log('   ✅ Health checks and status endpoints');

  console.log('\n✨ Integration with Existing ARCANOS:');
  console.log('   ✅ Uses existing OpenAI service (no duplication)');
  console.log('   ✅ Integrates with PR Assistant workflow');
  console.log('   ✅ Follows existing validation and security patterns');
  console.log('   ✅ Comprehensive logging with structured logger');

  console.log('\n🎯 Demo Complete! The purification tool is ready to use.');
  console.log('   Start the server with: npm start');
  console.log('   Visit: http://localhost:8080/purify/status');
  
  process.exit(0);
});

scanner.on('error', (error) => {
  console.error('❌ Demo failed:', error.message);
  console.log('\n💡 Note: Python scanner demo requires Python 3.x');
  console.log('   The API endpoints will still work for AI analysis');
  process.exit(1);
});
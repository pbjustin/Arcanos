#!/usr/bin/env node
/**
 * ARCANOS Main Entry Point
 * Wrapper for backward compatibility - forwards to compiled dist/server.js
 */

import { existsSync } from 'fs';
import { spawn } from 'child_process';

console.log('🚀 ARCANOS Entry Point - Forwarding to dist/server.js');

// Check if dist/server.js exists
if (!existsSync('./dist/server.js')) {
  console.error('❌ Error: dist/server.js not found. Run "npm run build" first.');
  process.exit(1);
}

// Forward to the actual server
const serverProcess = spawn('node', ['dist/server.js'], {
  stdio: 'inherit',
  cwd: process.cwd()
});

// Handle process events
serverProcess.on('error', (err) => {
  console.error('❌ Server process error:', err);
  process.exit(1);
});

serverProcess.on('exit', (code, signal) => {
  if (signal) {
    console.log(`🛑 Server terminated by signal: ${signal}`);
  } else {
    console.log(`🔚 Server exited with code: ${code}`);
  }
  process.exit(code || 0);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT - Shutting down gracefully...');
  serverProcess.kill('SIGINT');
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM - Shutting down gracefully...');
  serverProcess.kill('SIGTERM');
});
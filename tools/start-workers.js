#!/usr/bin/env node
/**
 * Start Workers Boot Script
 * Optional standalone script to start all OpenAI SDK workers
 */

import WorkerManager from '../dist/services/workerManager.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

console.log('🚀 ARCANOS Worker Boot Script');
console.log('==============================');

// Validate environment
if (!process.env.OPENAI_API_KEY) {
  console.warn('⚠️  OPENAI_API_KEY not set - workers may not function properly');
}

/**
 * Get environment-appropriate log path
 */
function getEnvironmentLogPath() {
  const logDir = process.env.ARC_LOG_PATH || '/tmp/arc/log';
  if (process.env.NODE_ENV === 'production') {
    return `${logDir}/session.log`;
  } else {
    return './memory/session.log';
  }
}

console.log(`🤖 AI Model: ${process.env.AI_MODEL || 'ft:gpt-3.5-turbo-0125:personal:arcanos-v2'}`);
console.log(`💾 Memory Path: ${getEnvironmentLogPath()}`);
console.log('');

// Initialize worker manager
const workerManager = new WorkerManager();

// Launch all workers
console.log('🔍 Scanning for OpenAI SDK workers...');
workerManager.launchAllWorkers();

// Status update every 30 seconds
setInterval(() => {
  const status = workerManager.getWorkerStatus();
  console.log(`📊 Status Update: ${status.activeWorkers.length} active workers`);
  
  if (status.activeWorkers.length > 0) {
    console.log(`   Active: ${status.activeWorkers.join(', ')}`);
  }
  
  if (Object.keys(status.errors).length > 0) {
    console.log(`   Errors: ${Object.keys(status.errors).join(', ')}`);
  }
}, 30000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down workers...');
  workerManager.stopAllWorkers();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Terminating workers...');
  workerManager.stopAllWorkers();
  process.exit(0);
});

console.log('✅ Worker management system initialized');
console.log('📡 Use Ctrl+C to stop all workers');
console.log('');

// Keep the process alive
setInterval(() => {}, 1000);
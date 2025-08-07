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

console.log(`🤖 AI Model: ${process.env.AI_MODEL || 'gpt-3.5-turbo'}`);
console.log(`💾 Memory Path: ${process.env.NODE_ENV === 'production' ? '/var/arc/log/session.log' : './memory/session.log'}`);
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
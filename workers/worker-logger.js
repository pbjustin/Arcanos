#!/usr/bin/env node
/**
 * ARCANOS Worker Logger
 * 
 * Centralized logging worker that stores logs in database when available
 */

import { logExecution, getStatus } from '../dist/db.js';

export const id = 'worker-logger';

const logs = [];
const maxMemoryLogs = 1000;

/**
 * Log a message with database storage
 */
export async function log(workerId, level, message, metadata = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, workerId, level, message, metadata };
  
  try {
    // Try to store in database
    await logExecution(workerId, level, message, metadata);
  } catch (error) {
    // Fallback to memory storage
    logs.push(logEntry);
    
    // Keep memory logs under limit
    if (logs.length > maxMemoryLogs) {
      logs.shift();
    }
    
    console.log(`[${workerId}] ${level.toUpperCase()}: ${message}`);
  }
}

/**
 * Get recent logs (fallback when database unavailable)
 */
export function getRecentLogs(workerId = null, limit = 50) {
  let filteredLogs = workerId ? logs.filter(log => log.workerId === workerId) : logs;
  return filteredLogs.slice(-limit);
}

/**
 * Worker run function
 */
export async function run() {
  const dbStatus = getStatus();
  
  if (dbStatus.connected) {
    console.log('[📝 WORKER-LOGGER] ✅ Initialized with database logging');
  } else {
    console.log('[📝 WORKER-LOGGER] ⚠️  Initialized with memory fallback logging');
  }
  
  // Log initial startup
  await log('worker-logger', 'info', 'Worker logger initialized', { 
    database: dbStatus.connected,
    memoryFallback: !dbStatus.connected 
  });
}

console.log(`[📝 WORKER-LOGGER] Module loaded: ${id}`);
#!/usr/bin/env node
/**
 * ARCANOS Worker Logger
 * Logs when workers start, what they do, and any errors
 * Outputs to both console and /logs/workers.log
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const LOG_FILE_PATH = path.resolve(process.cwd(), 'logs', 'workers.log');
const HEARTBEAT_INTERVAL = 60 * 1000; // 60 seconds

console.log('[📝 WORKER-LOGGER] Starting worker logging service...');

/**
 * Ensure logs directory exists
 */
function ensureLogsDirectory() {
  const logsDir = path.dirname(LOG_FILE_PATH);
  try {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
      console.log(`[📝 WORKER-LOGGER] Created logs directory: ${logsDir}`);
    }
  } catch (error) {
    console.error(`[📝 WORKER-LOGGER] Failed to create logs directory: ${error.message}`);
  }
}

/**
 * Write log entry to both console and file
 */
function writeLog(level, source, message, metadata = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level: level.toUpperCase(),
    source,
    message,
    metadata,
    pid: process.pid
  };

  // Console output with emoji
  const emoji = {
    'INFO': 'ℹ️',
    'WARN': '⚠️',
    'ERROR': '❌',
    'SUCCESS': '✅',
    'START': '🚀',
    'STOP': '🛑'
  }[level.toUpperCase()] || 'ℹ️';
  
  console.log(`[📝 WORKER-LOGGER] ${emoji} [${level.toUpperCase()}] ${source}: ${message}`);
  
  if (Object.keys(metadata).length > 0) {
    console.log(`[📝 WORKER-LOGGER]   └─ ${JSON.stringify(metadata)}`);
  }

  // File output
  try {
    const fileLogEntry = `${JSON.stringify(logEntry)}\n`;
    fs.appendFileSync(LOG_FILE_PATH, fileLogEntry, 'utf8');
  } catch (error) {
    console.error(`[📝 WORKER-LOGGER] Failed to write to log file: ${error.message}`);
  }
}

/**
 * Log worker startup
 */
function logWorkerStart(workerId, metadata = {}) {
  writeLog('START', workerId, 'Worker started', {
    ...metadata,
    startTime: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform
  });
}

/**
 * Log worker activity
 */
function logWorkerActivity(workerId, activity, metadata = {}) {
  writeLog('INFO', workerId, activity, metadata);
}

/**
 * Log worker error
 */
function logWorkerError(workerId, error, metadata = {}) {
  const errorInfo = {
    ...metadata,
    error: error.message,
    stack: error.stack,
    errorTime: new Date().toISOString()
  };
  writeLog('ERROR', workerId, `Worker error: ${error.message}`, errorInfo);
}

/**
 * Log worker shutdown
 */
function logWorkerStop(workerId, metadata = {}) {
  writeLog('STOP', workerId, 'Worker stopped', {
    ...metadata,
    stopTime: new Date().toISOString(),
    uptime: process.uptime()
  });
}

/**
 * Monitor system resources and log periodically
 */
function monitorSystemResources() {
  try {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    const resourceInfo = {
      memory: {
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
        external: Math.round(memUsage.external / 1024 / 1024), // MB
        rss: Math.round(memUsage.rss / 1024 / 1024) // MB
      },
      uptime: Math.round(process.uptime()),
      pid: process.pid
    };

    writeLog('INFO', 'WORKER-LOGGER', 'System resource check', resourceInfo);
  } catch (error) {
    logWorkerError('WORKER-LOGGER', error, { context: 'resource monitoring' });
  }
}

/**
 * Handle uncaught exceptions
 */
process.on('uncaughtException', (error) => {
  logWorkerError('WORKER-LOGGER', error, { 
    context: 'uncaught exception',
    critical: true 
  });
  
  // Give some time for the log to be written, then exit
  setTimeout(() => {
    console.error('[📝 WORKER-LOGGER] Exiting due to uncaught exception');
    process.exit(1);
  }, 1000);
});

/**
 * Handle unhandled promise rejections
 */
process.on('unhandledRejection', (reason, promise) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logWorkerError('WORKER-LOGGER', error, { 
    context: 'unhandled promise rejection',
    promise: promise.toString()
  });
});

// Initialize
ensureLogsDirectory();

// Log our own startup
logWorkerStart('WORKER-LOGGER', {
  version: '1.0.0',
  logFile: LOG_FILE_PATH,
  heartbeatInterval: HEARTBEAT_INTERVAL
});

// Monitor system resources periodically
setInterval(monitorSystemResources, HEARTBEAT_INTERVAL);

// Log some initial activity
logWorkerActivity('WORKER-LOGGER', 'Worker logger initialized and monitoring started');

// Graceful shutdown handling
process.on('SIGINT', () => {
  console.log('\n[📝 WORKER-LOGGER] Received SIGINT - Shutting down gracefully...');
  logWorkerStop('WORKER-LOGGER', { reason: 'SIGINT received' });
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[📝 WORKER-LOGGER] Received SIGTERM - Shutting down gracefully...');
  logWorkerStop('WORKER-LOGGER', { reason: 'SIGTERM received' });
  process.exit(0);
});

// Export functions for use by other workers (if imported as module)
export {
  writeLog,
  logWorkerStart,
  logWorkerActivity,
  logWorkerError,
  logWorkerStop
};
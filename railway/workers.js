#!/usr/bin/env node
/**
 * ARCANOS Workers Manager
 * Manages all Railway workers with graceful error handling
 * Prevents crashes due to missing modules or files
 */

import { createRequire } from 'module';
import path from 'path';
import { spawn } from 'child_process';

const require = createRequire(import.meta.url);

console.log('[⚙️ WORKERS] Starting ARCANOS workers manager...');

// List of workers to manage
const WORKERS = [
  {
    name: 'SCHEDULER',
    path: path.resolve(process.cwd(), 'railway', 'scheduler.js'),
    emoji: '📅'
  },
  {
    name: 'WORKER-LOGGER', 
    path: path.resolve(process.cwd(), 'railway', 'worker-logger.js'),
    emoji: '📝'
  },
  {
    name: 'HEARTBEAT',
    path: path.resolve(process.cwd(), 'railway', 'heartbeat.js'),
    emoji: '🔄'
  },
  {
    name: 'AI-CORE',
    path: path.resolve(process.cwd(), 'railway', 'ai-core.js'),
    emoji: '🧠'
  }
];

// Track running worker processes
const workerProcesses = new Map();
let isShuttingDown = false;

/**
 * Check if a worker file exists
 */
function checkWorkerExists(workerPath) {
  try {
    const fs = require('fs');
    return fs.existsSync(workerPath);
  } catch (error) {
    console.error(`[⚙️ WORKERS] Error checking worker file: ${error.message}`);
    return false;
  }
}

/**
 * Start a single worker with error handling
 */
async function startWorker(worker) {
  try {
    console.log(`[⚙️ WORKERS] ${worker.emoji} Starting ${worker.name}...`);
    
    // Check if worker file exists
    if (!checkWorkerExists(worker.path)) {
      console.warn(`[⚙️ WORKERS] ${worker.emoji} Worker file not found: ${worker.path}`);
      console.warn(`[⚙️ WORKERS] ${worker.emoji} ${worker.name} will be skipped`);
      return null;
    }

    // Spawn the worker process
    const workerProcess = spawn('node', [worker.path], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV || 'production'
      }
    });

    // Handle worker output
    workerProcess.stdout.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
        console.log(`${output}`);
      }
    });

    workerProcess.stderr.on('data', (data) => {
      const error = data.toString().trim();
      if (error) {
        console.error(`${error}`);
      }
    });

    // Handle worker process events
    workerProcess.on('error', (error) => {
      console.error(`[⚙️ WORKERS] ${worker.emoji} ${worker.name} process error: ${error.message}`);
      // Remove from tracking
      workerProcesses.delete(worker.name);
      
      // Restart worker after delay if not shutting down
      if (!isShuttingDown) {
        setTimeout(() => {
          console.log(`[⚙️ WORKERS] ${worker.emoji} Restarting ${worker.name} after error...`);
          startWorker(worker);
        }, 5000);
      }
    });

    workerProcess.on('exit', (code, signal) => {
      if (signal) {
        console.log(`[⚙️ WORKERS] ${worker.emoji} ${worker.name} terminated by signal: ${signal}`);
      } else {
        console.log(`[⚙️ WORKERS] ${worker.emoji} ${worker.name} exited with code: ${code}`);
      }

      // Remove from tracking
      workerProcesses.delete(worker.name);
      
      // Restart worker if it didn't exit cleanly and we're not shutting down
      if (!isShuttingDown && code !== 0) {
        setTimeout(() => {
          console.log(`[⚙️ WORKERS] ${worker.emoji} Restarting ${worker.name} after unexpected exit...`);
          startWorker(worker);
        }, 3000);
      }
    });

    // Track the process
    workerProcesses.set(worker.name, workerProcess);
    
    console.log(`[⚙️ WORKERS] ${worker.emoji} ${worker.name} started successfully (PID: ${workerProcess.pid})`);
    return workerProcess;

  } catch (error) {
    console.error(`[⚙️ WORKERS] ${worker.emoji} Failed to start ${worker.name}: ${error.message}`);
    console.error(`[⚙️ WORKERS] ${worker.emoji} ${worker.name} will continue without this worker`);
    return null;
  }
}

/**
 * Start all workers asynchronously
 */
async function startAllWorkers() {
  console.log(`[⚙️ WORKERS] Starting ${WORKERS.length} workers...`);
  
  // Start workers one by one with slight delays to prevent overwhelming
  for (const worker of WORKERS) {
    if (!isShuttingDown) {
      await startWorker(worker);
      // Small delay between starting workers
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.log(`[⚙️ WORKERS] ✅ Workers startup complete. Active workers: ${workerProcesses.size}`);
}

/**
 * Graceful shutdown of all workers
 */
async function shutdownAllWorkers(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`\n[⚙️ WORKERS] Received ${signal} - Shutting down all workers gracefully...`);

  if (workerProcesses.size === 0) {
    console.log('[⚙️ WORKERS] No active workers to shutdown');
    process.exit(0);
  }

  // Send SIGTERM to all workers
  for (const [name, process] of workerProcesses) {
    try {
      console.log(`[⚙️ WORKERS] Terminating ${name}...`);
      process.kill('SIGTERM');
    } catch (error) {
      console.error(`[⚙️ WORKERS] Error terminating ${name}: ${error.message}`);
    }
  }

  // Wait for graceful shutdown
  setTimeout(() => {
    // Force kill any remaining workers
    for (const [name, process] of workerProcesses) {
      try {
        if (!process.killed) {
          console.log(`[⚙️ WORKERS] Force killing ${name}...`);
          process.kill('SIGKILL');
        }
      } catch (error) {
        console.error(`[⚙️ WORKERS] Error force killing ${name}: ${error.message}`);
      }
    }

    console.log('[⚙️ WORKERS] All workers shut down');
    process.exit(0);
  }, 10000); // Wait 10 seconds for graceful shutdown
}

/**
 * Health check for workers
 */
function performWorkersHealthCheck() {
  console.log(`[⚙️ WORKERS] Health check: ${workerProcesses.size}/${WORKERS.length} workers active`);
  
  for (const [name, process] of workerProcesses) {
    try {
      // Send signal 0 to check if process is still alive
      const isAlive = process.kill(0);
      if (!isAlive) {
        console.warn(`[⚙️ WORKERS] Worker ${name} appears to be dead`);
        workerProcesses.delete(name);
      }
    } catch (error) {
      console.warn(`[⚙️ WORKERS] Worker ${name} health check failed: ${error.message}`);
      workerProcesses.delete(name);
    }
  }
}

// Set up signal handlers for graceful shutdown
process.on('SIGINT', () => shutdownAllWorkers('SIGINT'));
process.on('SIGTERM', () => shutdownAllWorkers('SIGTERM'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('[⚙️ WORKERS] ❌ Uncaught exception:', error);
  shutdownAllWorkers('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[⚙️ WORKERS] ❌ Unhandled rejection:', reason);
  shutdownAllWorkers('UNHANDLED_REJECTION');
});

// Start health check interval (every 5 minutes)
setInterval(performWorkersHealthCheck, 5 * 60 * 1000);

// Start all workers
startAllWorkers().catch(error => {
  console.error(`[⚙️ WORKERS] ❌ Failed to start workers: ${error.message}`);
  process.exit(1);
});

console.log('[⚙️ WORKERS] Workers manager initialized');
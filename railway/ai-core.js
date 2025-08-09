#!/usr/bin/env node
/**
 * ARCANOS AI Core Worker
 * Routes requests to the main ARCANOS AI logic with error handling and retry logic
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);

const MAX_RETRIES = 3;
const RETRY_DELAY = 5000; // 5 seconds
const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds

console.log('[🧠 AI-CORE] Starting ARCANOS AI Core Worker...');

let serverProcess = null;
let retryCount = 0;
let isShuttingDown = false;

/**
 * Check if the compiled server exists
 */
function checkServerExists() {
  const serverPath = path.resolve(process.cwd(), 'dist', 'server.js');
  if (!existsSync(serverPath)) {
    throw new Error(`Server file not found at ${serverPath}. Please run 'npm run build' first.`);
  }
  console.log('[🧠 AI-CORE] Server file found at dist/server.js');
  return serverPath;
}

/**
 * Start the AI server with error handling
 */
async function startAIServer() {
  try {
    const serverPath = checkServerExists();
    
    console.log(`[🧠 AI-CORE] Attempt ${retryCount + 1}/${MAX_RETRIES} - Starting AI server...`);
    
    serverProcess = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV || 'production'
      }
    });

    // Handle server output
    serverProcess.stdout.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
        console.log(`[🧠 AI-CORE] ${output}`);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      const error = data.toString().trim();
      if (error) {
        console.error(`[🧠 AI-CORE] ⚠️  ${error}`);
      }
    });

    // Handle server process events
    serverProcess.on('error', (error) => {
      console.error(`[🧠 AI-CORE] ❌ Server process error: ${error.message}`);
      handleServerFailure(error);
    });

    serverProcess.on('exit', (code, signal) => {
      if (signal) {
        console.log(`[🧠 AI-CORE] 🛑 Server terminated by signal: ${signal}`);
      } else {
        console.log(`[🧠 AI-CORE] 🔚 Server exited with code: ${code}`);
      }

      serverProcess = null;
      
      if (!isShuttingDown) {
        if (code !== 0) {
          handleServerFailure(new Error(`Server exited with code ${code}`));
        } else {
          console.log('[🧠 AI-CORE] Server shut down cleanly');
        }
      }
    });

    serverProcess.on('close', (code, signal) => {
      console.log(`[🧠 AI-CORE] Server process closed (code: ${code}, signal: ${signal})`);
    });

    // Reset retry count on successful start
    retryCount = 0;
    console.log('[🧠 AI-CORE] ✅ AI server started successfully');
    
    return serverProcess;
  } catch (error) {
    console.error(`[🧠 AI-CORE] ❌ Failed to start AI server: ${error.message}`);
    throw error;
  }
}

/**
 * Handle server failure with retry logic
 */
async function handleServerFailure(error) {
  if (isShuttingDown) {
    return;
  }

  console.error(`[🧠 AI-CORE] Server failure: ${error.message}`);
  
  retryCount++;
  
  if (retryCount <= MAX_RETRIES) {
    console.log(`[🧠 AI-CORE] Retrying in ${RETRY_DELAY / 1000} seconds... (${retryCount}/${MAX_RETRIES})`);
    
    setTimeout(async () => {
      try {
        await startAIServer();
      } catch (retryError) {
        console.error(`[🧠 AI-CORE] Retry failed: ${retryError.message}`);
        await handleServerFailure(retryError);
      }
    }, RETRY_DELAY);
  } else {
    console.error(`[🧠 AI-CORE] ❌ Maximum retry attempts (${MAX_RETRIES}) exceeded. Giving up.`);
    console.error('[🧠 AI-CORE] AI Core worker will exit. Please check the logs and restart manually.');
    process.exit(1);
  }
}

/**
 * Health check to ensure server is responsive
 */
async function performHealthCheck() {
  if (!serverProcess || isShuttingDown) {
    return;
  }

  try {
    // Simple check if process is still running
    if (serverProcess.killed || serverProcess.exitCode !== null) {
      console.warn('[🧠 AI-CORE] ⚠️  Server process appears to be dead, restarting...');
      await handleServerFailure(new Error('Server process died'));
      return;
    }

    // Send a test signal to check if process is responsive
    const isRunning = serverProcess.kill(0); // Signal 0 doesn't kill, just checks if process exists
    if (!isRunning) {
      console.warn('[🧠 AI-CORE] ⚠️  Server process not responding, restarting...');
      await handleServerFailure(new Error('Server process not responding'));
      return;
    }

    console.log('[🧠 AI-CORE] ✅ Health check passed');
  } catch (error) {
    console.error(`[🧠 AI-CORE] Health check failed: ${error.message}`);
    await handleServerFailure(error);
  }
}

/**
 * Graceful shutdown
 */
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`\n[🧠 AI-CORE] Received ${signal} - Shutting down gracefully...`);

  if (serverProcess) {
    console.log('[🧠 AI-CORE] Terminating server process...');
    
    // Try graceful shutdown first
    serverProcess.kill('SIGTERM');
    
    // Wait for graceful shutdown
    setTimeout(() => {
      if (serverProcess && !serverProcess.killed) {
        console.log('[🧠 AI-CORE] Forcing server shutdown...');
        serverProcess.kill('SIGKILL');
      }
    }, 10000); // Wait 10 seconds for graceful shutdown
  }

  setTimeout(() => {
    console.log('[🧠 AI-CORE] AI Core worker shut down complete');
    process.exit(0);
  }, 12000); // Exit after 12 seconds total
}

// Set up signal handlers for graceful shutdown
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('[🧠 AI-CORE] ❌ Uncaught exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[🧠 AI-CORE] ❌ Unhandled rejection:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

// Start the server
startAIServer().catch(error => {
  console.error(`[🧠 AI-CORE] ❌ Failed to start AI server: ${error.message}`);
  handleServerFailure(error);
});

// Set up health check interval
const healthCheckInterval = setInterval(() => {
  performHealthCheck().catch(error => {
    console.error(`[🧠 AI-CORE] Health check error: ${error.message}`);
  });
}, HEALTH_CHECK_INTERVAL);

// Clean up health check on shutdown
process.on('exit', () => {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }
});

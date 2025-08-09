#!/usr/bin/env node
/**
 * ARCANOS Heartbeat Worker
 * Sends console logs and optional HTTP requests every 60 seconds to keep Railway container active
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const HEARTBEAT_INTERVAL = 60 * 1000; // 60 seconds
const HEALTH_CHECK_URL = process.env.RAILWAY_PUBLIC_DOMAIN 
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health`
  : null;

console.log('[🔄 HEARTBEAT] Worker starting...');
console.log(`[🔄 HEARTBEAT] Health check URL: ${HEALTH_CHECK_URL || 'Not configured'}`);

/**
 * Send HTTP request to keep container active
 */
async function sendHeartbeatRequest() {
  if (!HEALTH_CHECK_URL) {
    return null;
  }

  try {
    const response = await fetch(HEALTH_CHECK_URL, {
      method: 'GET',
      timeout: 10000, // 10 second timeout
      headers: {
        'User-Agent': 'ARCANOS-Heartbeat-Worker'
      }
    });

    return {
      status: response.status,
      ok: response.ok,
      url: HEALTH_CHECK_URL
    };
  } catch (error) {
    console.warn(`[🔄 HEARTBEAT] HTTP request failed: ${error.message}`);
    return {
      error: error.message,
      url: HEALTH_CHECK_URL
    };
  }
}

/**
 * Main heartbeat function
 */
async function sendHeartbeat() {
  const timestamp = new Date().toISOString();
  console.log(`[🔄 HEARTBEAT] ${timestamp}`);

  // Send optional HTTP request
  try {
    const httpResult = await sendHeartbeatRequest();
    if (httpResult) {
      if (httpResult.ok) {
        console.log(`[🔄 HEARTBEAT] Health check OK (${httpResult.status})`);
      } else if (httpResult.error) {
        console.log(`[🔄 HEARTBEAT] Health check failed: ${httpResult.error}`);
      } else {
        console.log(`[🔄 HEARTBEAT] Health check returned ${httpResult.status}`);
      }
    }
  } catch (error) {
    console.error(`[🔄 HEARTBEAT] Unexpected error during health check: ${error.message}`);
  }

  // Log memory usage
  const memUsage = process.memoryUsage();
  const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  console.log(`[🔄 HEARTBEAT] Memory: ${memMB}MB`);
}

// Start heartbeat interval
setInterval(() => {
  sendHeartbeat().catch(error => {
    console.error(`[🔄 HEARTBEAT] Critical error: ${error.message}`);
    // Don't crash the process, just log and continue
  });
}, HEARTBEAT_INTERVAL);

// Initial heartbeat
sendHeartbeat().catch(error => {
  console.error(`[🔄 HEARTBEAT] Initial heartbeat failed: ${error.message}`);
});

// Graceful shutdown handling
process.on('SIGINT', () => {
  console.log('\n[🔄 HEARTBEAT] Received SIGINT - Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[🔄 HEARTBEAT] Received SIGTERM - Shutting down gracefully...');
  process.exit(0);
});

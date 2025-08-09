#!/usr/bin/env node
/**
 * Worker Logger - Central Heartbeat Monitor
 * Monitors all workers and provides fallback detection
 */

import { createOpenAIClient, createCompletion } from './shared/workerUtils.js';
import fs from 'fs';
import path from 'path';

// Worker metadata and main function in required format
export const id = 'worker-logger';
export const description = 'Central heartbeat monitor for all workers with crash detection and fallback';

// Worker registry and heartbeat tracking
const workerRegistry = new Map();
const HEARTBEAT_INTERVAL = 60000; // 1 minute
const CRASH_THRESHOLD = 300000; // 5 minutes

/**
 * Register a worker in the central registry
 */
export function registerWorker(workerId, metadata = {}) {
  workerRegistry.set(workerId, {
    id: workerId,
    lastHeartbeat: new Date(),
    status: 'active',
    crashes: 0,
    metadata,
    registered: new Date()
  });
  logWorkerEvent('REGISTER', workerId, metadata);
}

/**
 * Update worker heartbeat
 */
export function updateHeartbeat(workerId, status = 'active', metadata = {}) {
  if (workerRegistry.has(workerId)) {
    const worker = workerRegistry.get(workerId);
    worker.lastHeartbeat = new Date();
    worker.status = status;
    worker.metadata = { ...worker.metadata, ...metadata };
    workerRegistry.set(workerId, worker);
  } else {
    // Auto-register if not found
    registerWorker(workerId, metadata);
  }
}

/**
 * Check for crashed workers
 */
export function detectCrashedWorkers() {
  const now = new Date();
  const crashedWorkers = [];

  for (const [workerId, worker] of workerRegistry) {
    const timeSinceHeartbeat = now.getTime() - worker.lastHeartbeat.getTime();
    
    if (timeSinceHeartbeat > CRASH_THRESHOLD && worker.status === 'active') {
      worker.status = 'crashed';
      worker.crashes += 1;
      workerRegistry.set(workerId, worker);
      crashedWorkers.push(workerId);
      logWorkerEvent('CRASH_DETECTED', workerId, { 
        timeSinceHeartbeat, 
        crashes: worker.crashes 
      });
    }
  }

  return crashedWorkers;
}

/**
 * Get all worker statuses
 */
export function getAllWorkerStatuses() {
  const statuses = {};
  for (const [workerId, worker] of workerRegistry) {
    statuses[workerId] = {
      status: worker.status,
      lastHeartbeat: worker.lastHeartbeat.toISOString(),
      crashes: worker.crashes,
      uptime: Date.now() - worker.registered.getTime()
    };
  }
  return statuses;
}

/**
 * Log worker events to logs directory
 */
function logWorkerEvent(event, workerId, details = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${event}: ${workerId}\n` +
                   `Details: ${JSON.stringify(details, null, 2)}\n\n`;
  
  try {
    const logPath = path.resolve(process.cwd(), 'logs', 'worker-heartbeat.log');
    fs.appendFileSync(logPath, logEntry, 'utf8');
  } catch (error) {
    console.error('Failed to write worker log:', error);
  }
}

/**
 * Auto-register known workers on startup
 */
function initializeKnownWorkers() {
  const knownWorkers = [
    'auditProcessor',
    'codeImprovement', 
    'memorySync',
    'worker-error-logger',
    'worker-planner-engine',
    'worker-logger'
  ];

  knownWorkers.forEach(workerId => {
    registerWorker(workerId, { autoRegistered: true });
  });
}

// Initialize known workers when module loads
initializeKnownWorkers();

// Start periodic crash detection
setInterval(() => {
  const crashed = detectCrashedWorkers();
  if (crashed.length > 0) {
    console.log(`[WORKER-LOGGER] Detected ${crashed.length} crashed workers:`, crashed);
  }
}, HEARTBEAT_INTERVAL);

export async function run(input, tools) {
  try {
    const action = input.action || 'status';

    switch (action) {
      case 'register':
        if (!input.workerId) {
          throw new Error('workerId required for registration');
        }
        registerWorker(input.workerId, input.metadata || {});
        return {
          success: true,
          action: 'register',
          workerId: input.workerId,
          timestamp: new Date().toISOString(),
          worker: id
        };

      case 'heartbeat':
        if (!input.workerId) {
          throw new Error('workerId required for heartbeat');
        }
        updateHeartbeat(input.workerId, input.status, input.metadata);
        return {
          success: true,
          action: 'heartbeat',
          workerId: input.workerId,
          timestamp: new Date().toISOString(),
          worker: id
        };

      case 'detect-crashes':
        const crashedWorkers = detectCrashedWorkers();
        return {
          success: true,
          action: 'detect-crashes',
          crashedWorkers,
          count: crashedWorkers.length,
          timestamp: new Date().toISOString(),
          worker: id
        };

      case 'status':
      default:
        const statuses = getAllWorkerStatuses();
        const openai = createOpenAIClient();
        
        let aiAnalysis = null;
        if (openai) {
          try {
            const completion = await createCompletion(
              openai,
              'You are ARCANOS worker monitor AI. Analyze worker health and provide recommendations.',
              `Analyze worker statuses: ${JSON.stringify(statuses, null, 2)}`,
              { max_tokens: 150, temperature: 0.1 }
            );
            aiAnalysis = completion.choices[0].message.content;
          } catch (error) {
            aiAnalysis = `AI analysis failed: ${error.message}`;
          }
        }

        return {
          success: true,
          action: 'status',
          totalWorkers: workerRegistry.size,
          workerStatuses: statuses,
          aiAnalysis,
          timestamp: new Date().toISOString(),
          worker: id
        };
    }
  } catch (error) {
    throw new Error(`Worker logger operation failed: ${error.message}`);
  }
}
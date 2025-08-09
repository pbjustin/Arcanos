#!/usr/bin/env node
/**
 * ARCANOS Worker Initialization Module
 * 
 * Spawns and manages 4 workers with heartbeat monitoring
 * Implements OpenAI SDK-based job dispatch
 */

import { logExecution, getStatus } from '../dist/db.js';
import { getOpenAIClient, generateMockResponse } from '../dist/services/openai.js';

export const id = 'init-workers';

// Worker state management
const workers = new Map();
const workerHeartbeats = new Map();
const HEARTBEAT_INTERVAL = 60000; // 60 seconds
const MAX_FAILED_HEARTBEATS = 3;

/**
 * Worker class to manage individual worker instances
 */
class ArcanosWorker {
  constructor(workerId) {
    this.id = workerId;
    this.status = 'initializing';
    this.failedHeartbeats = 0;
    this.lastHeartbeat = new Date();
    this.restartCount = 0;
    this.heartbeatTimer = null;
  }

  async start() {
    try {
      this.status = 'running';
      this.lastHeartbeat = new Date();
      this.failedHeartbeats = 0;
      
      await logExecution(this.id, 'info', `Worker ${this.id} started`);
      
      // Start heartbeat monitoring
      this.startHeartbeat();
      
      return true;
    } catch (error) {
      this.status = 'failed';
      await logExecution(this.id, 'error', `Worker ${this.id} failed to start: ${error.message}`);
      return false;
    }
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(async () => {
      await this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL);
  }

  async sendHeartbeat() {
    try {
      // Simulate heartbeat check - in real implementation this would check worker health
      const isHealthy = Math.random() > 0.1; // 90% success rate for demo
      
      if (isHealthy) {
        this.lastHeartbeat = new Date();
        this.failedHeartbeats = 0;
        await logExecution(this.id, 'debug', `Heartbeat successful`);
      } else {
        this.failedHeartbeats++;
        await logExecution(this.id, 'warn', `Heartbeat failed (${this.failedHeartbeats}/${MAX_FAILED_HEARTBEATS})`);
        
        if (this.failedHeartbeats >= MAX_FAILED_HEARTBEATS) {
          await this.restart();
        }
      }
    } catch (error) {
      this.failedHeartbeats++;
      await logExecution(this.id, 'error', `Heartbeat error: ${error.message}`);
      
      if (this.failedHeartbeats >= MAX_FAILED_HEARTBEATS) {
        await this.restart();
      }
    }
  }

  async restart() {
    try {
      await logExecution(this.id, 'warn', `Restarting worker after ${this.failedHeartbeats} failed heartbeats`);
      
      // Stop current heartbeat
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
      }
      
      this.status = 'restarting';
      this.restartCount++;
      
      // Simulate restart delay
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Restart the worker
      const success = await this.start();
      if (success) {
        await logExecution(this.id, 'info', `Worker ${this.id} restarted successfully (restart #${this.restartCount})`);
      } else {
        await logExecution(this.id, 'error', `Worker ${this.id} restart failed`);
      }
      
      return success;
    } catch (error) {
      this.status = 'failed';
      await logExecution(this.id, 'error', `Worker ${this.id} restart failed: ${error.message}`);
      return false;
    }
  }

  async stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.status = 'stopped';
    await logExecution(this.id, 'info', `Worker ${this.id} stopped`);
  }

  getStatus() {
    return {
      id: this.id,
      status: this.status,
      lastHeartbeat: this.lastHeartbeat,
      failedHeartbeats: this.failedHeartbeats,
      restartCount: this.restartCount
    };
  }
}

/**
 * Initialize all 4 workers
 */
export async function initializeWorkers() {
  const workerIds = ['worker-1', 'worker-2', 'worker-3', 'worker-4'];
  const results = {
    initialized: [],
    failed: [],
    retryCount: 0
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    results.retryCount = attempt;
    
    for (const workerId of workerIds) {
      if (results.initialized.includes(workerId)) {
        continue; // Skip already initialized workers
      }

      try {
        const worker = new ArcanosWorker(workerId);
        const success = await worker.start();
        
        if (success) {
          workers.set(workerId, worker);
          results.initialized.push(workerId);
          await logExecution(id, 'info', `Worker ${workerId} initialized successfully`);
        } else {
          if (!results.failed.includes(workerId)) {
            results.failed.push(workerId);
          }
        }
      } catch (error) {
        if (!results.failed.includes(workerId)) {
          results.failed.push(workerId);
        }
        await logExecution(id, 'error', `Worker ${workerId} initialization failed: ${error.message}`);
      }
    }

    // If all workers initialized, break early
    if (results.initialized.length === workerIds.length) {
      break;
    }

    // Wait before retry
    if (attempt < 3) {
      await logExecution(id, 'warn', `Retrying worker initialization (attempt ${attempt + 1}/3)`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // Log final results
  if (results.failed.length > 0) {
    await logExecution(id, 'error', `Worker initialization completed with failures: ${results.failed.join(', ')}`);
  } else {
    await logExecution(id, 'info', 'All workers initialized successfully');
  }

  return results;
}

/**
 * OpenAI SDK job dispatch function
 * Allows AI to dispatch jobs to workers
 */
export async function dispatchJob(workerId, jobType, jobData) {
  try {
    const worker = workers.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }

    if (worker.status !== 'running') {
      throw new Error(`Worker ${workerId} is not running (status: ${worker.status})`);
    }

    // Log job dispatch
    await logExecution(workerId, 'info', `Job dispatched: ${jobType}`, { jobData });

    // Simulate job processing
    const result = {
      success: true,
      workerId,
      jobType,
      processedAt: new Date().toISOString(),
      result: `Job ${jobType} processed by ${workerId}`
    };

    return result;
  } catch (error) {
    await logExecution(id, 'error', `Job dispatch failed: ${error.message}`, { workerId, jobType });
    throw error;
  }
}

/**
 * Get status of all workers
 */
export function getWorkerStatus() {
  const status = {
    count: workers.size,
    healthy: 0,
    workers: []
  };

  for (const [workerId, worker] of workers) {
    const workerStatus = worker.getStatus();
    status.workers.push(workerStatus);
    
    if (workerStatus.status === 'running') {
      status.healthy++;
    }
  }

  return status;
}

/**
 * Stop all workers
 */
export async function stopAllWorkers() {
  for (const [workerId, worker] of workers) {
    await worker.stop();
  }
  workers.clear();
  await logExecution(id, 'info', 'All workers stopped');
}

/**
 * Worker module run function (called by worker boot system)
 */
export async function run() {
  await logExecution(id, 'info', 'Worker initialization module loaded');
  
  // Initialize workers automatically
  const results = await initializeWorkers();
  
  await logExecution(id, 'info', `Worker initialization complete`, {
    initialized: results.initialized.length,
    failed: results.failed.length,
    retryCount: results.retryCount
  });
}

// Export for new worker pattern
export default {
  name: 'Worker Initialization Module',
  id: 'init-workers',
  run,
  // No schedule - runs once on startup
  functions: {
    initializeWorkers,
    dispatchJob,
    getWorkerStatus,
    stopAllWorkers
  }
};

console.log(`[🏭 INIT-WORKERS] Module loaded: ${id}`);
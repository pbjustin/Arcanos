#!/usr/bin/env node
/**
 * Worker Planner Engine - OpenAI SDK Compliant
 * Schedules and manages AI logic audit and context expansion
 */

import { createOpenAIClient, createCompletion } from './shared/workerUtils.js';
import cron from 'node-cron';

// Worker metadata and main function in required format
export const id = 'worker-planner-engine';
export const description = 'Schedules AI logic audit and context expansion operations every 10 minutes';

// Internal state for scheduling
let scheduledTask = null;
let isRunning = false;
let lastExecution = null;

/**
 * Core planning logic - AI audit and context expansion
 */
async function executePlanningCycle() {
  if (isRunning) {
    console.log(`[${new Date().toISOString()}] Planning cycle already running, skipping...`);
    return;
  }

  isRunning = true;
  console.log(`[${new Date().toISOString()}] Starting AI planning cycle...`);

  try {
    const openai = createOpenAIClient();
    if (!openai) {
      throw new Error('Failed to initialize OpenAI client for planning cycle');
    }

    // AI Logic Audit
    const auditCompletion = await createCompletion(
      openai,
      'You are ARCANOS planning engine AI worker. Perform AI logic audit and recommend system optimizations.',
      'Audit current AI logic patterns, identify optimization opportunities, and suggest context expansion strategies.',
      { max_tokens: 250, temperature: 0.2 }
    );

    // Context Expansion Analysis
    const contextCompletion = await createCompletion(
      openai,
      'You are ARCANOS context expansion AI worker. Analyze context patterns and suggest improvements.',
      'Analyze current context patterns and recommend expansion strategies for better AI performance.',
      { max_tokens: 200, temperature: 0.3 }
    );

    lastExecution = {
      timestamp: new Date().toISOString(),
      audit: auditCompletion.choices[0].message.content,
      contextExpansion: contextCompletion.choices[0].message.content,
      success: true
    };

    console.log(`[${new Date().toISOString()}] Planning cycle completed successfully`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Planning cycle failed:`, error.message);
    lastExecution = {
      timestamp: new Date().toISOString(),
      error: error.message,
      success: false
    };
  } finally {
    isRunning = false;
  }
}

/**
 * Start the scheduled planning engine
 */
export function startScheduling() {
  if (scheduledTask) {
    console.log('Planning engine already scheduled');
    return false;
  }

  // Schedule every 10 minutes (cron pattern: '*/10 * * * *')
  scheduledTask = cron.schedule('*/10 * * * *', async () => {
    await executePlanningCycle();
  }, {
    scheduled: false,
    timezone: "UTC"
  });

  scheduledTask.start();
  console.log(`[${new Date().toISOString()}] Planning engine scheduled (every 10 minutes)`);
  return true;
}

/**
 * Stop the scheduled planning engine
 */
export function stopScheduling() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log(`[${new Date().toISOString()}] Planning engine stopped`);
    return true;
  }
  return false;
}

/**
 * Get current status of the planning engine
 */
export function getStatus() {
  return {
    scheduled: !!scheduledTask,
    running: isRunning,
    lastExecution,
    nextRun: scheduledTask ? 'Every 10 minutes' : 'Not scheduled'
  };
}

export async function run(input, tools) {
  try {
    const command = input.command || 'status';

    switch (command) {
      case 'start':
        const started = startScheduling();
        return {
          success: true,
          action: 'start',
          result: started ? 'Planning engine started' : 'Already running',
          timestamp: new Date().toISOString(),
          worker: id
        };

      case 'stop':
        const stopped = stopScheduling();
        return {
          success: true,
          action: 'stop',
          result: stopped ? 'Planning engine stopped' : 'Not running',
          timestamp: new Date().toISOString(),
          worker: id
        };

      case 'execute':
        await executePlanningCycle();
        return {
          success: true,
          action: 'execute',
          result: 'Manual planning cycle executed',
          lastExecution,
          timestamp: new Date().toISOString(),
          worker: id
        };

      case 'status':
      default:
        return {
          success: true,
          action: 'status',
          result: getStatus(),
          timestamp: new Date().toISOString(),
          worker: id
        };
    }
  } catch (error) {
    throw new Error(`Planning engine operation failed: ${error.message}`);
  }
}
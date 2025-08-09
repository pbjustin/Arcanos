#!/usr/bin/env node
/**
 * Worker Boot Module - Initialize and register all workers
 * Called during server startup to activate all workers
 */

import fs from 'fs';
import path from 'path';

interface WorkerInitResult {
  initialized: string[];
  failed: Array<{ worker: string; error: string }>;
  scheduled: string[];
}

// Dynamic import for workers
async function initializeWorkers(): Promise<WorkerInitResult> {
  const runWorkers = process.env.RUN_WORKERS === 'true' || process.env.RUN_WORKERS === '1';
  
  console.log(`[🔧 WORKER-BOOT] Worker initialization - RUN_WORKERS: ${runWorkers}`);
  
  if (!runWorkers) {
    console.log('[🔧 WORKER-BOOT] Workers disabled via RUN_WORKERS environment variable');
    return {
      initialized: [],
      failed: [],
      scheduled: []
    };
  }

  console.log('[🔧 WORKER-BOOT] Starting worker initialization...');
  
  const workersDir = path.resolve(process.cwd(), 'workers');
  const results: WorkerInitResult = {
    initialized: [],
    failed: [],
    scheduled: []
  };

  try {
    if (!fs.existsSync(workersDir)) {
      throw new Error(`Workers directory not found: ${workersDir}`);
    }

    const files = fs.readdirSync(workersDir);
    const workerFiles = files.filter(file => file.endsWith('.js') && !file.includes('shared'));

    console.log(`[🔧 WORKER-BOOT] Found ${workerFiles.length} worker files`);

    // Initialize worker-logger first for registry
    const loggerPath = path.join(workersDir, 'worker-logger.js');
    if (fs.existsSync(loggerPath)) {
      try {
        const workerLogger = await import(loggerPath);
        console.log(`[🔧 WORKER-BOOT] ✅ worker-logger initialized`);
        results.initialized.push('worker-logger');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[🔧 WORKER-BOOT] ❌ worker-logger failed:`, errorMessage);
        results.failed.push({ worker: 'worker-logger', error: errorMessage });
      }
    }

    // Initialize worker-planner-engine and start scheduling
    const plannerPath = path.join(workersDir, 'worker-planner-engine.js');
    if (fs.existsSync(plannerPath)) {
      try {
        const plannerEngine = await import(plannerPath);
        if (typeof plannerEngine.startScheduling === 'function') {
          plannerEngine.startScheduling();
          console.log(`[🔧 WORKER-BOOT] ✅ worker-planner-engine scheduled`);
          results.scheduled.push('worker-planner-engine');
        }
        results.initialized.push('worker-planner-engine');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[🔧 WORKER-BOOT] ❌ worker-planner-engine failed:`, errorMessage);
        results.failed.push({ worker: 'worker-planner-engine', error: errorMessage });
      }
    }

    // Initialize other workers
    for (const file of workerFiles) {
      const workerId = file.replace('.js', '');
      
      // Skip already processed workers
      if (['worker-logger', 'worker-planner-engine'].includes(workerId)) {
        continue;
      }

      try {
        const workerPath = path.join(workersDir, file);
        const worker = await import(workerPath);
        
        if (worker.id && worker.run) {
          console.log(`[🔧 WORKER-BOOT] ✅ ${worker.id} initialized`);
          results.initialized.push(worker.id);
        } else {
          console.warn(`[🔧 WORKER-BOOT] ⚠️  ${workerId} missing required exports`);
          results.failed.push({ worker: workerId, error: 'Missing required exports' });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[🔧 WORKER-BOOT] ❌ ${workerId} failed:`, errorMessage);
        results.failed.push({ worker: workerId, error: errorMessage });
      }
    }

    console.log(`[🔧 WORKER-BOOT] Initialization complete:`);
    console.log(`   ✅ Initialized: ${results.initialized.length} workers`);
    console.log(`   📅 Scheduled: ${results.scheduled.length} workers`);
    console.log(`   ❌ Failed: ${results.failed.length} workers`);

    return results;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[🔧 WORKER-BOOT] Fatal error during worker initialization:', error);
    return { initialized: [], failed: [{ worker: 'boot', error: errorMessage }], scheduled: [] };
  }
}

export { initializeWorkers, type WorkerInitResult };
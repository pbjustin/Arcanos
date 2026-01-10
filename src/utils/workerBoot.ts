#!/usr/bin/env node
/**
 * Worker Boot Module - Initialize and register all workers
 * Called during server startup to activate all workers
 */

import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { initializeDatabase, getStatus } from '../db.js';
import { createWorkerContext } from './workerContext.js';
import { resolveWorkersDirectory } from './workerPaths.js';

interface WorkerInitResult {
  initialized: string[];
  failed: Array<{ worker: string; error: string }>;
  scheduled: string[];
  database: {
    connected: boolean;
    error?: string | null;
  };
}

// Store scheduled tasks for cleanup
const scheduledTasks: Map<string, cron.ScheduledTask> = new Map();

// Dynamic import for workers
async function initializeWorkers(): Promise<WorkerInitResult> {
  const runWorkers = process.env.RUN_WORKERS === 'true' || process.env.RUN_WORKERS === '1';
  
  console.log(`[🔧 WORKER-BOOT] Worker initialization - RUN_WORKERS: ${runWorkers}`);
  
  // Initialize database first
  console.log('[🔧 WORKER-BOOT] Initializing database connection...');
  const dbInitialized = await initializeDatabase('worker-boot');
  const dbStatus = getStatus();
  
  if (dbInitialized) {
    console.log('[🔧 WORKER-BOOT] ✅ Database initialized successfully');
  } else {
    console.log('[🔧 WORKER-BOOT] ⚠️  Database initialization failed - workers will use fallback mode');
    
    if (!process.env.DATABASE_URL) {
      console.log('[🔧 WORKER-BOOT] ℹ️  DATABASE_URL not set - this is expected for development');
    }
  }
  
  if (!runWorkers) {
    console.log('[🔧 WORKER-BOOT] Workers disabled via RUN_WORKERS environment variable');
    return {
      initialized: [],
      failed: [],
      scheduled: [],
      database: {
        connected: dbStatus.connected,
        error: dbStatus.error
      }
    };
  }

  console.log('[🔧 WORKER-BOOT] Starting worker initialization...');
  
  const { path: workersDir, exists: workersDirExists } = resolveWorkersDirectory();
  const results: WorkerInitResult = {
    initialized: [],
    failed: [],
    scheduled: [],
    database: {
      connected: dbStatus.connected,
      error: dbStatus.error
    }
  };

  try {
    if (!workersDirExists || !fs.existsSync(workersDir)) {
      console.log(`[🔧 WORKER-BOOT] Workers directory not found: ${workersDir}`);
      console.log('[🔧 WORKER-BOOT] Skipping worker initialization');
      return results;
    }

    const resolveWorkerFiles = (directory: string) =>
      fs
        .readdirSync(directory)
        .filter(file => file.endsWith('.js') && !file.includes('shared'));

    let resolvedWorkersDir = workersDir;
    let workerFiles = resolveWorkerFiles(resolvedWorkersDir);

    if (workerFiles.length === 0) {
      const distDir = path.join(workersDir, 'dist');
      if (fs.existsSync(distDir)) {
        resolvedWorkersDir = distDir;
        workerFiles = resolveWorkerFiles(resolvedWorkersDir);
      }
    }

    console.log(
      `[🔧 WORKER-BOOT] Found ${workerFiles.length} worker files in ${resolvedWorkersDir}`
    );

    // Initialize worker-logger first for registry
    const loggerPath = path.join(resolvedWorkersDir, 'worker-logger.js');
    if (fs.existsSync(loggerPath)) {
      try {
        const workerLogger = await import(loggerPath);
        if (typeof workerLogger.run === 'function') {
          await workerLogger.run();
        }
        console.log(`[🔧 WORKER-BOOT] ✅ worker-logger initialized`);
        results.initialized.push('worker-logger');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[🔧 WORKER-BOOT] ❌ worker-logger failed:`, errorMessage);
        results.failed.push({ worker: 'worker-logger', error: errorMessage });
      }
    }

    // Initialize worker-planner-engine and start scheduling
    const plannerPath = path.join(resolvedWorkersDir, 'worker-planner-engine.js');
    if (fs.existsSync(plannerPath)) {
      try {
        const plannerEngine = await import(plannerPath);
        
        if (typeof plannerEngine.run === 'function') {
          await plannerEngine.run();
        }
        
        if (typeof plannerEngine.startScheduling === 'function' && dbStatus.connected) {
          plannerEngine.startScheduling();
          console.log(`[🔧 WORKER-BOOT] ✅ worker-planner-engine scheduled`);
          results.scheduled.push('worker-planner-engine');
        } else if (!dbStatus.connected) {
          console.log(`[🔧 WORKER-BOOT] ⚠️  worker-planner-engine scheduling disabled (no database)`);
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
        const workerPath = path.join(resolvedWorkersDir, file);
        const worker = await import(workerPath);
        
        // Check for new worker pattern (context-based with schedule)
        if (worker.default && typeof worker.default === 'object' && 
            worker.default.name && worker.default.run && worker.default.schedule) {
          
          const workerModule = worker.default;
          const context = createWorkerContext(workerId);
          
          // Schedule the worker if it has a schedule
          if (workerModule.schedule) {
            try {
              const task = cron.schedule(workerModule.schedule, async () => {
                try {
                  await context.log(`Running scheduled worker: ${workerModule.name}`);
                  await workerModule.run(context);
                } catch (error) {
                  const errorMsg = error instanceof Error ? error.message : 'Unknown error';
                  await context.error(`Scheduled execution failed: ${errorMsg}`);
                }
              });
              
              task.start();
              scheduledTasks.set(workerId, task);
              
              console.log(`[🔧 WORKER-BOOT] ✅ ${workerModule.name} scheduled (${workerModule.schedule})`);
              results.scheduled.push(workerId);
              results.initialized.push(workerId);
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : 'Unknown error';
              console.error(`[🔧 WORKER-BOOT] ❌ Failed to schedule ${workerModule.name}:`, errorMessage);
              results.failed.push({ worker: workerId, error: `Scheduling failed: ${errorMessage}` });
            }
          } else {
            // Initialize worker without scheduling
            await workerModule.run(context);
            console.log(`[🔧 WORKER-BOOT] ✅ ${workerModule.name} initialized`);
            results.initialized.push(workerId);
          }
          
        }
        // Check for old worker pattern (legacy)
        else if (worker.id && worker.run) {
          await worker.run();
          console.log(`[🔧 WORKER-BOOT] ✅ ${worker.id} initialized (legacy pattern)`);
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
    console.log(`   🔌 Database: ${dbStatus.connected ? 'Connected' : 'Disconnected'}`);
    console.log(`   ✅ Initialized: ${results.initialized.length} workers`);
    console.log(`   📅 Scheduled: ${results.scheduled.length} workers`);
    if (results.failed.length > 0) {
      console.log(`   ❌ Failed: ${results.failed.length} workers`);
    }

    return results;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[🔧 WORKER-BOOT] Fatal error during worker initialization:', error);
    return { 
      initialized: [], 
      failed: [{ worker: 'boot', error: errorMessage }], 
      scheduled: [],
      database: {
        connected: dbStatus.connected,
        error: dbStatus.error
      }
    };
  }
}

export { initializeWorkers, type WorkerInitResult };

/**
 * Stop all scheduled workers
 */
export function stopScheduledWorkers(): void {
  for (const [workerId, task] of scheduledTasks) {
    task.stop();
    console.log(`[🔧 WORKER-BOOT] ⏹️  Stopped scheduled worker: ${workerId}`);
  }
  scheduledTasks.clear();
}

/**
 * Get list of scheduled workers
 */
export function getScheduledWorkers(): string[] {
  return Array.from(scheduledTasks.keys());
}

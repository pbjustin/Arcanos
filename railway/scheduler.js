#!/usr/bin/env node
/**
 * ARCANOS Scheduler Worker
 * Runs scheduled backend tasks:
 * - Memory check every 20 minutes
 * - Maintenance sweep every 30 minutes
 */

import cron from 'node-cron';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);

console.log('[📅 SCHEDULER] Worker starting...');

/**
 * Memory check function - runs every 20 minutes
 */
async function performMemoryCheck() {
  try {
    console.log('[📅 SCHEDULER] Running memory check...');
    
    const memUsage = process.memoryUsage();
    const memoryReport = {
      timestamp: new Date().toISOString(),
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
      external: Math.round(memUsage.external / 1024 / 1024), // MB
      rss: Math.round(memUsage.rss / 1024 / 1024) // MB
    };

    console.log(`[📅 SCHEDULER] Memory usage: ${memoryReport.heapUsed}MB / ${memoryReport.heapTotal}MB heap, ${memoryReport.rss}MB RSS`);

    // Log to memory usage file
    const memoryPath = path.resolve(process.cwd(), 'memory');
    if (fs.existsSync(memoryPath)) {
      const logPath = path.join(memoryPath, 'usage.log');
      const logEntry = `${memoryReport.timestamp} - Heap: ${memoryReport.heapUsed}MB/${memoryReport.heapTotal}MB, RSS: ${memoryReport.rss}MB\n`;
      
      try {
        fs.appendFileSync(logPath, logEntry, 'utf8');
      } catch (error) {
        console.warn(`[📅 SCHEDULER] Could not write to memory log: ${error.message}`);
      }
    }

    // Warning if memory usage is high
    if (memoryReport.heapUsed > 500) {
      console.warn(`[📅 SCHEDULER] ⚠️  High memory usage detected: ${memoryReport.heapUsed}MB`);
    }

    return memoryReport;
  } catch (error) {
    console.error(`[📅 SCHEDULER] Memory check failed: ${error.message}`);
    throw error;
  }
}

/**
 * Maintenance sweep function - runs every 30 minutes
 */
async function performMaintenanceSweep() {
  try {
    console.log('[📅 SCHEDULER] Running maintenance sweep...');
    
    const sweepResults = {
      timestamp: new Date().toISOString(),
      actions: []
    };

    // Clean up old log files (older than 7 days)
    const logsPath = path.resolve(process.cwd(), 'logs');
    if (fs.existsSync(logsPath)) {
      try {
        const files = fs.readdirSync(logsPath);
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        
        let cleanedFiles = 0;
        files.forEach(file => {
          if (file === '.gitkeep') return; // Skip .gitkeep
          
          const filePath = path.join(logsPath, file);
          try {
            const stats = fs.statSync(filePath);
            if (stats.mtime < sevenDaysAgo) {
              fs.unlinkSync(filePath);
              cleanedFiles++;
            }
          } catch (error) {
            console.warn(`[📅 SCHEDULER] Could not process log file ${file}: ${error.message}`);
          }
        });
        
        if (cleanedFiles > 0) {
          sweepResults.actions.push(`Cleaned ${cleanedFiles} old log files`);
          console.log(`[📅 SCHEDULER] Cleaned ${cleanedFiles} old log files`);
        }
      } catch (error) {
        console.warn(`[📅 SCHEDULER] Could not clean logs directory: ${error.message}`);
      }
    }

    // Clean up old memory files (older than 24 hours)
    const memoryPath = path.resolve(process.cwd(), 'memory');
    if (fs.existsSync(memoryPath)) {
      try {
        const files = fs.readdirSync(memoryPath);
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        
        let cleanedMemoryFiles = 0;
        files.forEach(file => {
          if (file.endsWith('.tmp') || file.startsWith('temp_')) {
            const filePath = path.join(memoryPath, file);
            try {
              const stats = fs.statSync(filePath);
              if (stats.mtime < twentyFourHoursAgo) {
                fs.unlinkSync(filePath);
                cleanedMemoryFiles++;
              }
            } catch (error) {
              console.warn(`[📅 SCHEDULER] Could not process memory file ${file}: ${error.message}`);
            }
          }
        });
        
        if (cleanedMemoryFiles > 0) {
          sweepResults.actions.push(`Cleaned ${cleanedMemoryFiles} temporary memory files`);
          console.log(`[📅 SCHEDULER] Cleaned ${cleanedMemoryFiles} temporary memory files`);
        }
      } catch (error) {
        console.warn(`[📅 SCHEDULER] Could not clean memory directory: ${error.message}`);
      }
    }

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      sweepResults.actions.push('Triggered garbage collection');
      console.log('[📅 SCHEDULER] Triggered garbage collection');
    }

    console.log(`[📅 SCHEDULER] Maintenance sweep completed: ${sweepResults.actions.length} actions performed`);
    return sweepResults;
  } catch (error) {
    console.error(`[📅 SCHEDULER] Maintenance sweep failed: ${error.message}`);
    throw error;
  }
}

// Schedule memory check every 20 minutes
cron.schedule('*/20 * * * *', async () => {
  try {
    await performMemoryCheck();
  } catch (error) {
    console.error(`[📅 SCHEDULER] Scheduled memory check failed: ${error.message}`);
  }
});

// Schedule maintenance sweep every 30 minutes
cron.schedule('*/30 * * * *', async () => {
  try {
    await performMaintenanceSweep();
  } catch (error) {
    console.error(`[📅 SCHEDULER] Scheduled maintenance sweep failed: ${error.message}`);
  }
});

// Run initial memory check and maintenance sweep on startup
console.log('[📅 SCHEDULER] Running initial checks...');
performMemoryCheck()
  .then(() => performMaintenanceSweep())
  .then(() => {
    console.log('[📅 SCHEDULER] Initial checks completed successfully');
  })
  .catch(error => {
    console.error(`[📅 SCHEDULER] Initial checks failed: ${error.message}`);
  });

// Graceful shutdown handling
process.on('SIGINT', () => {
  console.log('\n[📅 SCHEDULER] Received SIGINT - Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[📅 SCHEDULER] Received SIGTERM - Shutting down gracefully...');
  process.exit(0);
});

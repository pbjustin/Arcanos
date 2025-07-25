// AI-Controlled Temp Cleaner Worker
// Cleans temporary data when approved by ARCANOS model
// Enhanced for sleep window with log cleanup functionality

const { modelControlHooks } = require('../dist/services/model-control-hooks');
const { diagnosticsService } = require('../dist/services/diagnostics');
const { createServiceLogger } = require('../src/utils/logger');
const fs = require('fs').promises;
const path = require('path');
const logger = createServiceLogger('TempCleanerWorker');

async function reportFailure(error) {
  logger.error('Worker failure', error);
  try {
    await diagnosticsService.executeDiagnosticCommand(`tempCleaner failure: ${error.message}`);
  } catch (diagErr) {
    logger.error('Diagnostics reporting failed', diagErr);
  }
}

module.exports = async function clearTemp() {
  logger.info('Starting AI-controlled temp cleanup');
  
  try {
    // Request cleanup permission from AI model
    const result = await modelControlHooks.performMaintenance(
      'cleanup',
      { target: 'temp', maxAge: '24h' },
      {
        userId: 'system',
        sessionId: 'temp-cleaner',
        source: 'worker'
      }
    );

    if (result.success) {
      logger.info('AI approved temp cleanup operation');
      
      // Perform AI-approved cleanup
      if (global.gc) {
        global.gc();
        logger.info('Memory garbage collection executed');
      }
      
      // Enhanced: Perform log cleanup during sleep window
      const { shouldReduceServerActivity } = require('../dist/services/sleep-config');
      if (shouldReduceServerActivity()) {
        await performLogCleanup();
      }
      
      logger.success('Temp cleanup completed successfully');
    } else {
      logger.warning('AI denied temp cleanup operation', result.error);
    }

  } catch (error) {
    await reportFailure(error);
  }
};

/**
 * Perform comprehensive log cleanup during sleep window
 */
async function performLogCleanup() {
  try {
    logger.info('Performing log cleanup during sleep window');
    
    const cleanupStats = {
      timestamp: new Date().toISOString(),
      sleepWindow: true,
      filesProcessed: 0,
      filesRemoved: 0,
      bytesFreed: 0,
      directories: []
    };
    
    // Define directories to clean (in order of priority)
    const cleanupDirectories = [
      '/tmp',
      path.join(process.cwd(), 'logs'),
      path.join(process.cwd(), 'temp'),
      path.join(process.cwd(), 'storage', 'temp'),
      path.join(process.cwd(), 'storage', 'logs')
    ];
    
    for (const dir of cleanupDirectories) {
      try {
        const dirStats = await cleanupDirectory(dir);
        cleanupStats.directories.push(dirStats);
        cleanupStats.filesProcessed += dirStats.filesProcessed;
        cleanupStats.filesRemoved += dirStats.filesRemoved;
        cleanupStats.bytesFreed += dirStats.bytesFreed;
      } catch (dirError) {
        logger.warning('Directory not accessible or does not exist', { dir, error: dirError.message });
      }
    }
    
    // Clean up old memory snapshots (keep only last 7 days)
    await cleanupOldMemoryRecords();
    
    // Store cleanup results
    const cleanupResult = await modelControlHooks.manageMemory(
      'store',
      {
        key: `cleanup_report_${new Date().toISOString().split('T')[0]}_${Date.now()}`,
        value: cleanupStats,
        tags: ['cleanup', 'logs', 'sleep', 'maintenance', 'temp']
      },
      {
        userId: 'system',
        sessionId: 'log-cleanup',
        source: 'worker'
      }
    );
    
    if (cleanupResult.success) {
      logger.success('Log cleanup completed successfully', {
        processed: cleanupStats.filesProcessed,
        removed: cleanupStats.filesRemoved,
        freedMB: Math.round(cleanupStats.bytesFreed / 1024 / 1024)
      });
    } else {
      throw new Error(`Cleanup report storage failed: ${cleanupResult.error}`);
    }

  } catch (error) {
    await reportFailure(error);
  }
}

/**
 * Clean up files in a specific directory
 */
async function cleanupDirectory(dirPath) {
  const stats = {
    directory: dirPath,
    filesProcessed: 0,
    filesRemoved: 0,
    bytesFreed: 0,
    errors: []
  };
  
  try {
    const files = await fs.readdir(dirPath);
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
    
    for (const file of files) {
      try {
        const filePath = path.join(dirPath, file);
        const fileStat = await fs.stat(filePath);
        
        stats.filesProcessed++;
        
        // Skip directories and recent files
        if (fileStat.isDirectory()) continue;
        if (now - fileStat.mtime.getTime() < maxAge) continue;
        
        // Remove old log files, temp files, and cache files
        const shouldRemove = /\.(log|tmp|cache|temp)$/i.test(file) || 
                           file.startsWith('temp_') || 
                           file.startsWith('log_') ||
                           file.includes('.log.') ||
                           file.endsWith('.old');
        
        if (shouldRemove) {
          await fs.unlink(filePath);
          stats.filesRemoved++;
          stats.bytesFreed += fileStat.size;
          logger.debug('Removed old file', { file, bytes: fileStat.size });
        }
        
      } catch (fileError) {
        stats.errors.push(`${file}: ${fileError.message}`);
      }
    }
    
  } catch (dirError) {
    stats.errors.push(`Directory access: ${dirError.message}`);
  }
  
  return stats;
}

/**
 * Clean up old memory records to prevent database bloat
 */
async function cleanupOldMemoryRecords() {
  try {
    logger.info('Cleaning up old memory records');
    
    // Get list of all memories
    const memoryResult = await modelControlHooks.manageMemory(
      'list',
      {},
      {
        userId: 'system',
        sessionId: 'memory-cleanup',
        source: 'worker'
      }
    );
    
    if (memoryResult.success && memoryResult.results) {
      const memories = memoryResult.results[0]?.result || [];
      const now = Date.now();
      const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days for temp records
      
      let cleanedCount = 0;
      
      for (const memory of memories) {
        // Only clean up temp/system records, not user data
        if (!memory.tags || !memory.tags.includes('temp')) continue;
        
        const memoryTimestamp = new Date(memory.timestamp || memory.created_at || '1970-01-01').getTime();
        
        if (now - memoryTimestamp > maxAge) {
          try {
            const deleteResult = await modelControlHooks.manageMemory(
              'delete',
              { key: memory.key || memory.id },
              {
                userId: 'system',
                sessionId: 'memory-cleanup',
                source: 'worker'
              }
            );
            
            if (deleteResult.success) {
              cleanedCount++;
            }
          } catch (deleteError) {
            logger.warning('Failed to delete memory record', { key: memory.key, error: deleteError.message });
          }
        }
      }
      
      if (cleanedCount > 0) {
        logger.success('Cleaned up old memory records', { count: cleanedCount });
      }
    }
    
  } catch (error) {
    await reportFailure(error);
  }
}

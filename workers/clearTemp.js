// AI-Controlled Temp Cleaner Worker
// Cleans temporary data when approved by ARCANOS model
// Enhanced for sleep window with log cleanup functionality

const { modelControlHooks } = require('../dist/services/model-control-hooks');
const fs = require('fs').promises;
const path = require('path');

module.exports = async function clearTemp() {
  console.log('[AI-TEMP-CLEANER] Starting AI-controlled temp cleanup');
  
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
      console.log('[AI-TEMP-CLEANER] AI approved temp cleanup operation');
      
      // Perform AI-approved cleanup
      if (global.gc) {
        global.gc();
        console.log('[AI-TEMP-CLEANER] Memory garbage collection executed');
      }
      
      // Enhanced: Perform log cleanup during sleep window
      const { shouldReduceServerActivity } = require('../dist/services/sleep-config');
      if (shouldReduceServerActivity()) {
        await performLogCleanup();
      }
      
      console.log('[AI-TEMP-CLEANER] Temp cleanup completed successfully');
    } else {
      console.log('[AI-TEMP-CLEANER] AI denied temp cleanup operation:', result.error);
    }
    
  } catch (error) {
    console.error('[AI-TEMP-CLEANER] Error in AI-controlled temp cleanup:', error.message);
  }
};

/**
 * Perform comprehensive log cleanup during sleep window
 */
async function performLogCleanup() {
  try {
    console.log('[AI-TEMP-CLEANER] 🧹 Performing log cleanup during sleep window');
    
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
        console.log('[AI-TEMP-CLEANER] Directory %s not accessible or doesn\'t exist: %s', dir, dirError.message);
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
      console.log('[AI-TEMP-CLEANER] ✅ Log cleanup completed successfully');
      console.log('[AI-TEMP-CLEANER] 📊 Cleanup stats - Files processed: %d, Removed: %d, Freed: %sMB', 
        cleanupStats.filesProcessed,
        cleanupStats.filesRemoved,
        Math.round(cleanupStats.bytesFreed / 1024 / 1024)
      );
    } else {
      throw new Error(`Cleanup report storage failed: ${cleanupResult.error}`);
    }
    
  } catch (error) {
    console.error('[AI-TEMP-CLEANER] ❌ Log cleanup failed:', error.message);
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
          console.log('[AI-TEMP-CLEANER] Removed old file: %s (%d bytes)', file, fileStat.size);
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
    console.log('[AI-TEMP-CLEANER] 🗄️ Cleaning up old memory records');
    
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
            console.log('[AI-TEMP-CLEANER] Failed to delete memory record %s: %s', memory.key, deleteError.message);
          }
        }
      }
      
      if (cleanedCount > 0) {
        console.log('[AI-TEMP-CLEANER] 🗑️ Cleaned up %d old memory records', cleanedCount);
      }
    }
    
  } catch (error) {
    console.error('[AI-TEMP-CLEANER] Memory cleanup error:', error.message);
  }
}

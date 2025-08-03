import { fileURLToPath } from 'url';
/**
 * Clear Temp Worker - Handles cleanup of temporary files and logs
 * This file provides the interface expected by sleep-manager
 */

import { createServiceLogger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';

const logger = createServiceLogger('ClearTemp');

/**
 * Main clear temp function called by sleep manager
 * Cleans up temporary files and old logs
 */
export default async function clearTemp(): Promise<void> {
  logger.info('Starting temporary file and log cleanup during sleep window');
  
  try {
    let totalCleaned = 0;

    // Clean up temporary directories
    const tempDirs = [
      path.join(process.cwd(), 'storage', 'temp'),
      path.join(process.cwd(), 'storage', 'cache'),
      path.join(process.cwd(), 'storage', 'logs'),
      path.join(process.cwd(), 'storage', 'goal-logs'),
      '/tmp'
    ];

    for (const dir of tempDirs) {
      if (fs.existsSync(dir)) {
        const cleaned = await cleanupDirectory(dir);
        totalCleaned += cleaned;
      }
    }

    // Clean up old log files in project root
    const logFiles = [
      'error.log',
      'combined.log',
      'debug.log',
      'access.log'
    ];

    for (const logFile of logFiles) {
      const logPath = path.join(process.cwd(), logFile);
      if (fs.existsSync(logPath)) {
        const stats = fs.statSync(logPath);
        // Clear log files older than 7 days or larger than 50MB
        if (stats.mtime.getTime() < Date.now() - (7 * 24 * 60 * 60 * 1000) || 
            stats.size > 50 * 1024 * 1024) {
          try {
            fs.writeFileSync(logPath, ''); // Clear content instead of deleting
            logger.info(`Cleared log file: ${logFile}`);
            totalCleaned++;
          } catch (error: any) {
            logger.warning(`Failed to clear log file: ${logFile}`, { error: error.message });
          }
        }
      }
    }

    logger.success('Temporary file cleanup completed', { totalCleaned });
  } catch (error: any) {
    logger.error('Temporary file cleanup failed', error);
    throw error;
  }
}

/**
 * Clean up files in a directory based on age and patterns
 */
async function cleanupDirectory(dirPath: string): Promise<number> {
  let cleanedCount = 0;
  
  try {
    if (!fs.existsSync(dirPath)) {
      return 0;
    }

    const files = fs.readdirSync(dirPath);
    const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
    
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      
      try {
        const stats = fs.statSync(filePath);
        
        // Skip directories for now
        if (stats.isDirectory()) {
          continue;
        }
        
        // Clean up files based on age and patterns
        const shouldClean = (
          stats.mtime.getTime() < threeDaysAgo ||
          file.endsWith('.tmp') ||
          file.endsWith('.temp') ||
          file.startsWith('temp-') ||
          (file.endsWith('.log') && stats.mtime.getTime() < threeDaysAgo)
        );
        
        if (shouldClean) {
          fs.unlinkSync(filePath);
          cleanedCount++;
          logger.debug(`Cleaned up file: ${filePath}`);
        }
      } catch (error: any) {
        logger.warning(`Failed to process file: ${filePath}`, { error: error.message });
      }
    }
    
    if (cleanedCount > 0) {
      logger.info(`Cleaned ${cleanedCount} files from ${dirPath}`);
    }
  } catch (error: any) {
    logger.warning(`Failed to cleanup directory: ${dirPath}`, { error: error.message });
  }
  
  return cleanedCount;
}

// Allow running directly from node
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  clearTemp().catch(err => {
    logger.error('Clear temp execution failed', err);
    process.exit(1);
  });
}
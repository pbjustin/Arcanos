/**
 * Memory Sync Worker - Handles memory synchronization and snapshots
 * This file provides the interface expected by sleep-manager
 */

import { createServiceLogger } from '../utils/logger';
import fs from 'fs';
import path from 'path';

const logger = createServiceLogger('MemorySync');

/**
 * Main memory sync function called by sleep manager
 * Performs memory synchronization and snapshot operations
 */
export default async function memorySync(): Promise<void> {
  logger.info('Starting memory sync and snapshot during sleep window');
  
  try {
    // Ensure storage directory exists
    const storageDir = path.join(process.cwd(), 'storage', 'memory-snapshots');
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }

    // Get current memory usage
    const memoryUsage = process.memoryUsage();
    const timestamp = new Date().toISOString();
    
    // Create memory snapshot data
    const snapshot = {
      timestamp,
      memoryUsage: {
        rss: memoryUsage.rss,
        heapTotal: memoryUsage.heapTotal,
        heapUsed: memoryUsage.heapUsed,
        external: memoryUsage.external,
        arrayBuffers: memoryUsage.arrayBuffers
      },
      nodeVersion: process.version,
      uptime: process.uptime(),
      platform: process.platform,
      arch: process.arch
    };

    // Write snapshot to file
    const snapshotFile = path.join(storageDir, `memory-snapshot-${Date.now()}.json`);
    fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));

    // Log memory statistics
    logger.info('Memory snapshot created', {
      heapUsedMB: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      rssMB: Math.round(memoryUsage.rss / 1024 / 1024),
      snapshotFile
    });

    // Clean up old snapshots (keep last 7 days)
    await cleanupOldSnapshots(storageDir);

    logger.success('Memory sync completed successfully');
  } catch (error: any) {
    logger.error('Memory sync failed', error);
    throw error;
  }
}

/**
 * Clean up old memory snapshots
 */
async function cleanupOldSnapshots(storageDir: string): Promise<void> {
  try {
    const files = fs.readdirSync(storageDir);
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    
    let cleanedCount = 0;
    for (const file of files) {
      if (file.startsWith('memory-snapshot-') && file.endsWith('.json')) {
        const filePath = path.join(storageDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtime.getTime() < sevenDaysAgo) {
          fs.unlinkSync(filePath);
          cleanedCount++;
        }
      }
    }
    
    if (cleanedCount > 0) {
      logger.info(`Cleaned up ${cleanedCount} old memory snapshots`);
    }
  } catch (error: any) {
    logger.warning('Failed to cleanup old snapshots', { error: error.message });
  }
}

// Allow running directly from node
if (require.main === module) {
  memorySync().catch(err => {
    logger.error('Memory sync execution failed', err);
    process.exit(1);
  });
}
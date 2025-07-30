/**
 * Cleanup utilities for pruning old reflections
 * Manages reflection memory and file cleanup based on age
 */

import { databaseService } from '../services/database';
import { getMemory, saveMemory } from '../services/memory';
import { DateTime } from 'luxon';

export interface PruneOptions {
  directory: string;
  olderThanDays: number;
  dryRun?: boolean;
}

export interface PruneResult {
  totalFound: number;
  pruned: number;
  errors: string[];
  prunedItems: string[];
}

/**
 * Prune old reflections from memory storage
 * Removes entries older than specified days
 */
export async function pruneOldReflections(options: PruneOptions): Promise<PruneResult> {
  const { directory, olderThanDays, dryRun = false } = options;
  const cutoffDate = DateTime.now().minus({ days: olderThanDays });
  
  const result: PruneResult = {
    totalFound: 0,
    pruned: 0,
    errors: [],
    prunedItems: []
  };

  try {
    // Get all reflection memories from the database
    const allReflections = await databaseService.loadAllMemory('reflections');
    result.totalFound = allReflections.length;

    for (const reflection of allReflections) {
      try {
        const memoryKey = reflection.memory_key;
        const memoryValue = reflection.memory_value;

        // Skip if this doesn't match our target directory
        if (!memoryKey.startsWith(directory)) {
          continue;
        }

        // Check if this reflection has a timestamp
        let timestamp: DateTime | null = null;
        
        if (memoryValue && typeof memoryValue === 'object') {
          // Try to get timestamp from various possible fields
          const possibleTimestamps = [
            memoryValue.timestamp,
            memoryValue.created_at,
            memoryValue.createdAt
          ];

          for (const ts of possibleTimestamps) {
            if (ts) {
              timestamp = DateTime.fromISO(ts);
              if (timestamp.isValid) break;
            }
          }
        }

        // If no valid timestamp found, try to extract from memory key
        if (!timestamp || !timestamp.isValid) {
          const timestampMatch = memoryKey.match(/(\d{13})/); // Unix timestamp in milliseconds
          if (timestampMatch) {
            timestamp = DateTime.fromMillis(parseInt(timestampMatch[1]));
          }
        }

        // If still no timestamp, skip this entry
        if (!timestamp || !timestamp.isValid) {
          continue;
        }

        // Check if this reflection is older than cutoff
        if (timestamp < cutoffDate) {
          if (!dryRun) {
            // Mark for deletion by setting a special value - we'll implement soft delete
            // since there's no deleteMemory method available
            const tombstoneValue = {
              ...memoryValue,
              _deleted: true,
              _deletedAt: new Date().toISOString(),
              _originalTimestamp: timestamp.toISO()
            };
            
            await databaseService.saveMemory({
              memory_key: `${memoryKey}_deleted_${Date.now()}`,
              memory_value: tombstoneValue,
              container_id: 'reflections_deleted'
            });
          }
          
          result.pruned++;
          result.prunedItems.push(`${memoryKey} (${timestamp.toISO()})`);
        }
      } catch (error: any) {
        result.errors.push(`Error processing ${reflection.memory_key}: ${error.message}`);
      }
    }

    // Also clean up any system snapshots related to reflections
    await cleanupSystemSnapshots(cutoffDate, dryRun, result);

  } catch (error: any) {
    result.errors.push(`Overall cleanup error: ${error.message}`);
  }

  // Log cleanup results
  console.log(`Reflection cleanup completed:`, {
    directory,
    olderThanDays,
    dryRun,
    ...result
  });

  return result;
}

/**
 * Clean up old system snapshots from self-reflection service
 */
async function cleanupSystemSnapshots(
  cutoffDate: DateTime,
  dryRun: boolean,
  result: PruneResult
): Promise<void> {
  try {
    const systemSnapshots = await databaseService.loadAllMemory('system');
    
    for (const snapshot of systemSnapshots) {
      if (!snapshot.memory_key.startsWith('system_snapshot_')) {
        continue;
      }

      const memoryValue = snapshot.memory_value;
      if (!memoryValue || !memoryValue.created_at) {
        continue;
      }

      const timestamp = DateTime.fromISO(memoryValue.created_at);
      if (!timestamp.isValid || timestamp >= cutoffDate) {
        continue;
      }

      // Check if this snapshot only contains old reflections
      if (memoryValue.memories && Array.isArray(memoryValue.memories)) {
        const hasRecentReflections = memoryValue.memories.some((memory: any) => {
          if (!memory.timestamp) return false;
          const memoryTime = DateTime.fromISO(memory.timestamp);
          return memoryTime.isValid && memoryTime >= cutoffDate;
        });

        // If it has recent reflections, just clean the old ones
        if (hasRecentReflections && !dryRun) {
          const filteredMemories = memoryValue.memories.filter((memory: any) => {
            if (!memory.timestamp) return true;
            const memoryTime = DateTime.fromISO(memory.timestamp);
            return !memoryTime.isValid || memoryTime >= cutoffDate;
          });

          const updatedValue = {
            ...memoryValue,
            memories: filteredMemories,
            memory_count: filteredMemories.length
          };

          await databaseService.saveMemory({
            memory_key: snapshot.memory_key,
            memory_value: updatedValue,
            container_id: 'system'
          });

          result.prunedItems.push(`Cleaned memories from ${snapshot.memory_key}`);
        } else if (!hasRecentReflections && !dryRun) {
          // Mark the entire snapshot as deleted if it only has old reflections
          const tombstoneValue = {
            ...memoryValue,
            _deleted: true,
            _deletedAt: new Date().toISOString(),
            _reason: 'No recent reflections found'
          };
          
          await databaseService.saveMemory({
            memory_key: `${snapshot.memory_key}_deleted_${Date.now()}`,
            memory_value: tombstoneValue,
            container_id: 'system_deleted'
          });

          result.pruned++;
          result.prunedItems.push(`Deleted system snapshot ${snapshot.memory_key}`);
        }
      }
    }
  } catch (error: any) {
    result.errors.push(`System snapshot cleanup error: ${error.message}`);
  }
}
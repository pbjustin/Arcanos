import { initializeMemory, saveMemoryIndex } from './storage.js';
import { memoryState } from './state.js';
import { isValidMemoryEntry } from "./validation.js";
import { logMemoryAccess } from './logging.js';

/**
 * Get memory statistics for diagnostics
 */
export function getMemoryStats(): {
  totalEntries: number;
  entriesByType: Record<string, number>;
  recentAccess: number;
  oldestEntry: string;
  newestEntry: string;
} {
  initializeMemory();

  const entriesByType: Record<string, number> = {};
  let recentAccess = 0;
  let oldestEntry = '';
  let newestEntry = '';

  for (const entry of memoryState.index) {
    // Count by type
    entriesByType[entry.type] = (entriesByType[entry.type] || 0) + 1;

    // Count recent access (within 24 hours)
    const hoursSinceAccess = (Date.now() - new Date(entry.lastAccessed).getTime()) / (1000 * 60 * 60);
    if (hoursSinceAccess < 24) {
      recentAccess++;
    }

    // Track oldest and newest
    if (!oldestEntry || entry.timestamp < oldestEntry) {
      oldestEntry = entry.timestamp;
    }
    if (!newestEntry || entry.timestamp > newestEntry) {
      newestEntry = entry.timestamp;
    }
  }

  return {
    totalEntries: memoryState.index.length,
    entriesByType,
    recentAccess,
    oldestEntry,
    newestEntry
  };
}

/**
 * Clean up old or unused memory entries
 */
export function cleanupMemory(maxAge: number = 30, minAccessCount: number = 0): number {
  initializeMemory();

  const cutoffDate = new Date(Date.now() - (maxAge * 24 * 60 * 60 * 1000));
  const initialCount = memoryState.index.length;

  memoryState.index = memoryState.index.filter(entry => {
    const entryDate = new Date(entry.timestamp);
    return entryDate > cutoffDate || entry.accessCount > minAccessCount;
  });

  const removed = initialCount - memoryState.index.length;
  if (removed > 0) {
    saveMemoryIndex();
    console.log(`🧠 [MEMORY] Cleaned up ${removed} old memory entries`);
  }

  return removed;
}

/**
 * Verify memory integrity to prevent schema conflicts
 */
export function checkMemoryIntegrity(): boolean {
  initializeMemory();
  return memoryState.index.every(entry => isValidMemoryEntry(entry));
}

/**
 * Clear memory state for a specific context or session
 * Used by orchestration shell for memory purging
 */
export async function clearMemoryState(context: string = 'orchestration'): Promise<number> {
  initializeMemory();
  
  const initialCount = memoryState.index.length;
  
  // Filter out entries related to the specified context
  memoryState.index = memoryState.index.filter(entry => {
    const shouldRemove = 
      entry.metadata.moduleId === context ||
      entry.metadata.tags.includes(context) ||
      entry.key.toLowerCase().includes(context.toLowerCase());
    
    if (shouldRemove) {
      logMemoryAccess('CLEAR', entry.key, entry.id);
    }
    
    return !shouldRemove;
  });
  
  const removed = initialCount - memoryState.index.length;
  if (removed > 0) {
    saveMemoryIndex();
    console.log(`🧠 [MEMORY] Cleared ${removed} memory entries for context: ${context}`);
  }
  
  return removed;
}

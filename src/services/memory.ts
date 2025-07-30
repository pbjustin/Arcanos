/**
 * Memory Service - Abstraction layer for ARCANOS memory access
 * Provides simplified interface for async memory operations compatible with OpenAI SDK patterns
 */

import { databaseService } from './database';
import { MemoryStorage } from '../storage/memory-storage';

// Shared fallback memory instance to ensure consistency across modules
export const fallbackMemory = new MemoryStorage();
const useDatabase = !!process.env.DATABASE_URL;

/**
 * Get memory using existing memory access layer
 * Supports both database and fallback in-memory storage
 * @param key - Memory key in format "type/id" or simple key
 * @param containerId - Optional container ID, defaults to 'default'
 * @returns Promise resolving to memory value or null if not found
 */
export const getMemory = async (key: string, containerId: string = 'default'): Promise<any> => {
  try {
    if (useDatabase) {
      const result = await databaseService.loadMemory({
        memory_key: key,
        container_id: containerId
      });
      return result ? result.memory_value : null;
    } else {
      const result = await fallbackMemory.getMemory(containerId, key);
      return result ? result.value : null;
    }
  } catch (error: any) {
    console.error('Memory access error:', error.message);
    return null;
  }
};

/**
 * Save memory using existing memory access layer
 * @param key - Memory key
 * @param value - Value to store
 * @param containerId - Optional container ID, defaults to 'default'
 * @returns Promise resolving to saved memory entry
 */
export const saveMemory = async (key: string, value: any, containerId: string = 'default'): Promise<any> => {
  try {
    if (useDatabase) {
      return await databaseService.saveMemory({
        memory_key: key,
        memory_value: value,
        container_id: containerId
      });
    } else {
      return await fallbackMemory.storeMemory(
        containerId, 
        'default', 
        'context', 
        key, 
        value
      );
    }
  } catch (error: any) {
    console.error('Memory save error:', error.message);
    throw error;
  }
};

/**
 * Store memory using existing memory access layer (alias for saveMemory to match problem statement interface)
 * @param key - Memory key
 * @param value - Value to store
 * @param containerId - Optional container ID, defaults to 'default'
 * @returns Promise resolving to saved memory entry
 */
export const storeMemory = saveMemory;

/**
 * Write memory entry - alias for saveMemory to match expected interface
 * @param key - Memory key
 * @param payload - Data to store
 * @param containerId - Optional container ID, defaults to 'default'
 * @returns Promise resolving to saved memory entry
 */
export const writeMemory = async (key: string, payload: any, containerId: string = 'default'): Promise<any> => {
  return await saveMemory(key, payload, containerId);
};

/**
 * Index memory entry - creates an alias mapping to the main entry
 * @param indexKey - Index key (e.g., 'alias_index/bg3')
 * @param targetKey - Key of the actual memory entry being indexed
 * @param containerId - Optional container ID, defaults to 'default'
 * @returns Promise resolving to saved index entry
 */
export const indexMemory = async (indexKey: string, targetKey: string, containerId: string = 'default'): Promise<any> => {
  const indexData = {
    type: 'alias_index',
    targetKey: targetKey,
    timestamp: new Date().toISOString()
  };
  return await saveMemory(indexKey, indexData, containerId);
};
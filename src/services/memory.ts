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
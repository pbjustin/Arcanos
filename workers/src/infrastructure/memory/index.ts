/**
 * Simple in-memory store for worker data persistence
 * This is a lightweight store for worker-specific data, separate from the main session store
 */

const store = new Map<string, unknown>();

export const MemoryStore = {
  /**
   * Set a value in the memory store
   * @param key - The key to store the value under
   * @param value - The value to store
   */
  async set(key: string, value: unknown): Promise<void> {
    store.set(key, value);
  },

  /**
   * Get a value from the memory store
   * @param key - The key to retrieve
   * @returns The stored value or undefined if not found
   */
  async get(key: string): Promise<unknown> {
    return store.get(key);
  },

  /**
   * Delete a value from the memory store
   * @param key - The key to delete
   */
  async delete(key: string): Promise<void> {
    store.delete(key);
  },

  /**
   * Check if a key exists in the store
   * @param key - The key to check
   */
  async has(key: string): Promise<boolean> {
    return store.has(key);
  },

  /**
   * Get all keys in the store
   */
  async keys(): Promise<string[]> {
    return Array.from(store.keys());
  },

  /**
   * Clear all data from the store
   */
  async clear(): Promise<void> {
    store.clear();
  }
};

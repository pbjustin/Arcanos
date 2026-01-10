import { describe, test, expect, beforeEach } from '@jest/globals';
import { TypedWorkerQueue } from '../workers/src/queue/index.js';
import { memorySyncHandler } from '../workers/src/handlers/memorySync.js';
import { MemoryStore } from '../workers/src/infrastructure/memory/index.js';

// Set a dummy API key for testing
process.env.OPENAI_API_KEY = 'test-api-key';

describe('memorySync worker', () => {
  let queue: TypedWorkerQueue;

  beforeEach(async () => {
    queue = new TypedWorkerQueue();
    queue.register('MEMORY_SYNC', memorySyncHandler);
    await MemoryStore.clear();
  });

  test('should sync data to memory store', async () => {
    const payload = {
      key: 'test-key',
      value: 'test-value',
      embed: false
    };

    const results = await queue.dispatch('MEMORY_SYNC', payload);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ status: 'success', key: 'test-key' });

    // Verify the data was stored
    const storedValue = await MemoryStore.get('test-key');
    expect(storedValue).toBe('test-value');
  });

  test('should sync complex objects to memory store', async () => {
    const payload = {
      key: 'test-object',
      value: { name: 'Test', count: 42 },
      embed: false
    };

    const results = await queue.dispatch('MEMORY_SYNC', payload);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ status: 'success', key: 'test-object' });

    // Verify the data was stored
    const storedValue = await MemoryStore.get('test-object');
    expect(storedValue).toEqual({ name: 'Test', count: 42 });
  });

  test('should retry on transient errors', async () => {
    let attempts = 0;
    const originalSet = MemoryStore.set;
    
    // Mock MemoryStore.set to fail twice then succeed
    MemoryStore.set = async (key: string, value: unknown) => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Transient error');
      }
      return originalSet.call(MemoryStore, key, value);
    };

    const payload = {
      key: 'test-retry',
      value: 'test-value',
      embed: false
    };

    try {
      const results = await queue.dispatch('MEMORY_SYNC', payload, { attempts: 3 });
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ status: 'success', key: 'test-retry' });
      expect(attempts).toBe(3);
    } finally {
      // Restore the original method
      MemoryStore.set = originalSet;
    }
  });
});

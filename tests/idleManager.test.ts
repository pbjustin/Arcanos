/**
 * Tests for idleManager utility
 */

import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { createIdleManager } from '../src/utils/idleManager.js';

describe('IdleManager', () => {
  let mockLogger: any;
  
  beforeEach(() => {
    mockLogger = {
      log: jest.fn()
    };
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('noteTraffic', () => {
    test('should track traffic and adjust idle timeout for high traffic', () => {
      const manager = createIdleManager(mockLogger);
      const initialStats = manager.getStats();
      
      // Simulate high traffic (multiple requests in quick succession)
      for (let i = 0; i < 10; i++) {
        manager.noteTraffic({ request: i });
        jest.advanceTimersByTime(100); // 100ms between requests = 10 req/s
      }
      
      const stats = manager.getStats();
      expect(stats.trafficRate).toBeGreaterThan(0);
      expect(mockLogger.log).toHaveBeenCalledWith(
        "[AUDIT] Traffic noted",
        expect.objectContaining({
          idleTimeoutMs: expect.any(Number),
          trafficRate: expect.any(String)
        })
      );
    });

    test('should decrease idle timeout for low traffic', () => {
      const manager = createIdleManager(mockLogger);
      
      // Simulate low traffic
      manager.noteTraffic({ request: 1 });
      jest.advanceTimersByTime(30000); // 30 seconds
      manager.noteTraffic({ request: 2 });
      
      const stats = manager.getStats();
      expect(stats.trafficRate).toBeLessThan(0.1);
    });
  });

  describe('isIdle', () => {
    test('should return false immediately after traffic', () => {
      const manager = createIdleManager(mockLogger);
      manager.noteTraffic();
      
      const idle = manager.isIdle();
      expect(idle).toBe(false);
    });

    test('should return true after idle timeout expires', () => {
      const manager = createIdleManager(mockLogger);
      manager.noteTraffic();
      
      // Advance time past idle timeout (30s default)
      jest.advanceTimersByTime(35000);
      
      const idle = manager.isIdle();
      expect(idle).toBe(true);
      expect(mockLogger.log).toHaveBeenCalledWith(
        "[AUDIT] Idle check",
        expect.objectContaining({
          idle: expect.any(Boolean),
          memoryIsGrowing: expect.any(Boolean),
          overThreshold: expect.any(Boolean)
        })
      );
    });

    test('should detect memory growth and prevent idle', () => {
      const manager = createIdleManager(mockLogger);
      
      // Get initial stats
      manager.noteTraffic();
      jest.advanceTimersByTime(35000);
      
      // Check idle status which updates memory tracking
      manager.isIdle();
      
      // Memory checks happen after MEMORY_GROWTH_WINDOW_MS (60s)
      jest.advanceTimersByTime(65000);
      
      const stats = manager.getStats();
      expect(stats.memoryIsGrowing).toBeDefined();
    });
  });

  describe('wrapOpenAI', () => {
    test('should cache OpenAI responses', async () => {
      const manager = createIdleManager(mockLogger);
      const mockOpenAI = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({ id: 'test-response', choices: [] })
          }
        }
      };
      
      const wrapped = manager.wrapOpenAI(mockOpenAI);
      const payload = { model: 'gpt-4', messages: [{ role: 'user', content: 'test' }] };
      
      // First call - should hit the API
      const promise1 = wrapped.chat.completions.create(payload);
      
      // Advance time to process batch
      jest.advanceTimersByTime(200);
      
      const result1 = await promise1;
      expect(result1).toBeDefined();
      expect(mockOpenAI.chat.completions.create).toHaveBeenCalledTimes(1);
      
      // Second call with same payload - should hit cache
      const promise2 = wrapped.chat.completions.create(payload);
      jest.advanceTimersByTime(200);
      
      const result2 = await promise2;
      expect(result2).toEqual(result1);
      expect(mockLogger.log).toHaveBeenCalledWith(
        "[AUDIT] OpenAI cache hit",
        expect.objectContaining({ key: expect.any(String) })
      );
    });

    test('should batch identical requests', async () => {
      const manager = createIdleManager(mockLogger);
      const mockOpenAI = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({ id: 'test-response', choices: [] })
          }
        }
      };
      
      const wrapped = manager.wrapOpenAI(mockOpenAI);
      const payload = { model: 'gpt-4', messages: [{ role: 'user', content: 'test' }] };
      
      // Create multiple identical requests
      const promise1 = wrapped.chat.completions.create(payload);
      const promise2 = wrapped.chat.completions.create(payload);
      const promise3 = wrapped.chat.completions.create(payload);
      
      // Advance time to process batch
      jest.advanceTimersByTime(200);
      
      const [result1, result2, result3] = await Promise.all([promise1, promise2, promise3]);
      
      // Should only call the API once
      expect(mockOpenAI.chat.completions.create).toHaveBeenCalledTimes(1);
      expect(result1).toEqual(result2);
      expect(result2).toEqual(result3);
      
      expect(mockLogger.log).toHaveBeenCalledWith(
        "[AUDIT] Batched OpenAI call",
        expect.objectContaining({
          batchSize: 3
        })
      );
    });

    test('should handle errors in batched requests', async () => {
      const manager = createIdleManager(mockLogger);
      const mockError = new Error('API Error');
      const mockOpenAI = {
        chat: {
          completions: {
            create: jest.fn().mockRejectedValue(mockError)
          }
        }
      };
      
      const wrapped = manager.wrapOpenAI(mockOpenAI);
      const payload = { model: 'gpt-4', messages: [{ role: 'user', content: 'test' }] };
      
      const promise = wrapped.chat.completions.create(payload);
      
      // Advance time to process batch
      jest.advanceTimersByTime(200);
      
      await expect(promise).rejects.toThrow('API Error');
    });

    test('should expire cache after TTL', async () => {
      const manager = createIdleManager(mockLogger);
      const mockOpenAI = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({ id: 'test-response', choices: [] })
          }
        }
      };
      
      const wrapped = manager.wrapOpenAI(mockOpenAI);
      const payload = { model: 'gpt-4', messages: [{ role: 'user', content: 'test' }] };
      
      // First call
      const promise1 = wrapped.chat.completions.create(payload);
      jest.advanceTimersByTime(200);
      await promise1;
      
      expect(mockOpenAI.chat.completions.create).toHaveBeenCalledTimes(1);
      
      // Advance time past cache TTL (60s)
      jest.advanceTimersByTime(65000);
      
      // Second call after cache expiry - should hit API again
      const promise2 = wrapped.chat.completions.create(payload);
      jest.advanceTimersByTime(200);
      await promise2;
      
      expect(mockOpenAI.chat.completions.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('getStats', () => {
    test('should return current statistics', () => {
      const manager = createIdleManager(mockLogger);
      manager.noteTraffic();
      
      const stats = manager.getStats();
      
      expect(stats).toHaveProperty('idleTimeoutMs');
      expect(stats).toHaveProperty('trafficRate');
      expect(stats).toHaveProperty('memoryIsGrowing');
      expect(typeof stats.idleTimeoutMs).toBe('number');
      expect(typeof stats.trafficRate).toBe('number');
      expect(typeof stats.memoryIsGrowing).toBe('boolean');
    });
  });

  describe('with default logger', () => {
    test('should work with console as default logger', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      
      const manager = createIdleManager();
      manager.noteTraffic();
      
      // Console.log should have been called
      expect(consoleSpy).toHaveBeenCalled();
      
      consoleSpy.mockRestore();
    });
  });
});

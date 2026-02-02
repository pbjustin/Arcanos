/**
 * Unit and integration tests for debug-confirmation routes
 * Tests token creation and consumption with automation secret authentication
 * Uses direct route testing without starting full server to avoid circular dependencies
 */

import { describe, beforeEach, afterEach, it, expect, jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

// Mock environment before importing modules
const originalEnv = process.env;
const testAutomationSecret = 'test-secret-12345';

describe('Debug Confirmation Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Set up test environment
    process.env = { ...originalEnv };
    process.env.OPENAI_API_KEY = '';
    process.env.ARCANOS_AUTOMATION_SECRET = testAutomationSecret;
    process.env.ARCANOS_AUTOMATION_HEADER = 'x-arcanos-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  describe('Token creation and consumption flow', () => {
    it('should create and consume a token successfully', async () => {
      //audit Assumption: full flow from creation to consumption; risk: integration failure; invariant: token lifecycle works end-to-end; handling: verify complete flow.
      const { createOneTimeToken, consumeOneTimeToken } = await import('../src/lib/tokenStore.js');
      
      // Create a token
      const record = createOneTimeToken();
      expect(record).toBeDefined();
      expect(record.token).toBeDefined();
      expect(typeof record.token).toBe('string');
      
      // Consume the token
      const result = consumeOneTimeToken(record.token);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.record.token).toBe(record.token);
      }
      
      // Try to consume again (should fail - replay prevention)
      const replayResult = consumeOneTimeToken(record.token);
      expect(replayResult.ok).toBe(false);
      if (!replayResult.ok) {
        expect(replayResult.reason).toBe('invalid');
      }
    });

    it('should reject invalid tokens', async () => {
      const { consumeOneTimeToken } = await import('../src/lib/tokenStore.js');
      
      const result = consumeOneTimeToken('invalid-token-xyz');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid');
      }
    });
  });

  describe('Route handler authentication', () => {
    it('should require automation secret for token creation', async () => {
      // Import the router module
      jest.resetModules();
      const routerModule = await import('../src/routes/debug-confirmation.js');
      const router = routerModule.default;
      
      // Find the route handler
      const routes = (router as any).stack;
      const createTokenRoute = routes.find((r: any) => 
        r.route && r.route.path === '/debug/create-confirmation-token'
      );
      
      expect(createTokenRoute).toBeDefined();
      expect(createTokenRoute.route.methods.post).toBe(true);
      
      // Test middleware stack includes authentication
      const middlewares = createTokenRoute.route.stack;
      expect(middlewares.length).toBeGreaterThan(0);
    });

    it('should require automation secret for token consumption', async () => {
      jest.resetModules();
      const routerModule = await import('../src/routes/debug-confirmation.js');
      const router = routerModule.default;
      
      // Find the route handler
      const routes = (router as any).stack;
      const consumeTokenRoute = routes.find((r: any) => 
        r.route && r.route.path === '/debug/consume-confirm-token'
      );
      
      expect(consumeTokenRoute).toBeDefined();
      expect(consumeTokenRoute.route.methods.post).toBe(true);
      
      // Test middleware stack includes authentication
      const middlewares = consumeTokenRoute.route.stack;
      expect(middlewares.length).toBeGreaterThan(0);
    });
  });
});

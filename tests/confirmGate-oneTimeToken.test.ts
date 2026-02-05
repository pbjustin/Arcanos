/**
 * Integration tests for confirmGate middleware with one-time token authentication
 * Tests the complete authentication flow including one-time tokens
 */

import { describe, beforeEach, afterEach, it, expect, jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

const originalEnv = process.env;

describe('ConfirmGate Middleware - One-Time Token Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Set up test environment
    process.env = { ...originalEnv };
    process.env.OPENAI_API_KEY = '';
    // Disable allow-all mode to test authentication
    delete process.env.ALLOW_ALL_GPTS;
    delete process.env.TRUSTED_GPT_IDS;
    process.env.ARCANOS_AUTOMATION_SECRET = 'test-secret';
    process.env.ARCANOS_AUTOMATION_HEADER = 'x-arcanos-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  describe('One-time token authentication', () => {
    it('should approve request with valid one-time token', async () => {
      //audit Assumption: valid one-time token grants access; risk: unauthorized access with stolen token; invariant: token must be valid; handling: verify middleware approval.
      const { createOneTimeToken } = await import('../src/lib/tokenStore.js');
      const { confirmGate } = await import('../src/middleware/confirmGate.js');
      
      // Create a valid token
      const record = createOneTimeToken();
      
      // Create mock request with one-time token
      const mockReq = {
        headers: {
          'x-arcanos-confirm-token': record.token
        },
        method: 'POST',
        path: '/test/endpoint'
      } as unknown as Request;
      
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn()
      } as unknown as Response;
      
      const mockNext = jest.fn() as NextFunction;
      
      // Call confirmGate middleware
      confirmGate(mockReq, mockRes, mockNext);
      
      // Should call next() (approve request)
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.setHeader).toHaveBeenCalledWith('x-confirmation-status', 'one-time-token');
      expect(mockReq.confirmationContext).toBeDefined();
      expect(mockReq.confirmationContext?.usedOneTimeToken).toBe(true);
      expect(mockReq.confirmationContext?.confirmationStatus).toBe('one-time-token');
    });

    it('should reject request with invalid one-time token', async () => {
      const { confirmGate } = await import('../src/middleware/confirmGate.js');
      
      // Create mock request with invalid token
      const mockReq = {
        headers: {
          'x-arcanos-confirm-token': 'invalid-token-xyz'
        },
        body: {},
        method: 'POST',
        path: '/test/endpoint'
      } as unknown as Request;
      
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn()
      } as unknown as Response;
      
      const mockNext = jest.fn() as NextFunction;
      
      // Call confirmGate middleware
      confirmGate(mockReq, mockRes, mockNext);
      
      // Should NOT call next() (reject request)
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalled();
      
      // Extract the error response
      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.error).toBe('Confirmation required');
      expect(jsonCall.confirmationRequired).toBe(true);
    });

    it('should consume one-time token on successful authentication', async () => {
      //audit Assumption: token consumed on use; risk: token replay; invariant: token used once; handling: verify consumption prevents reuse.
      const { createOneTimeToken, consumeOneTimeToken } = await import('../src/lib/tokenStore.js');
      const { confirmGate } = await import('../src/middleware/confirmGate.js');
      
      // Create a valid token
      const record = createOneTimeToken();
      
      // First request with token
      const mockReq1 = {
        headers: {
          'x-arcanos-confirm-token': record.token
        },
        method: 'POST',
        path: '/test/endpoint'
      } as unknown as Request;
      
      const mockRes1 = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn()
      } as unknown as Response;
      
      const mockNext1 = jest.fn() as NextFunction;
      
      // First call should succeed
      confirmGate(mockReq1, mockRes1, mockNext1);
      expect(mockNext1).toHaveBeenCalled();
      
      // Try to consume the same token again (should fail)
      const result = consumeOneTimeToken(record.token);
      expect(result.ok).toBe(false);
    });

    it('should reject expired one-time token', async () => {
      const { createOneTimeToken } = await import('../src/lib/tokenStore.js');
      const { confirmGate } = await import('../src/middleware/confirmGate.js');
      
      // Create a token
      const record = createOneTimeToken();
      
      // Mock Date.now to simulate expiration
      const originalDateNow = Date.now;
      Date.now = jest.fn(() => record.expiresAt + 1000); // 1 second after expiration
      
      try {
        // Create mock request with expired token
        const mockReq = {
          headers: {
            'x-arcanos-confirm-token': record.token
          },
          body: {},
          method: 'POST',
          path: '/test/endpoint'
        } as unknown as Request;
        
        const mockRes = {
          status: jest.fn().mockReturnThis(),
          json: jest.fn().mockReturnThis(),
          setHeader: jest.fn()
        } as unknown as Response;
        
        const mockNext = jest.fn() as NextFunction;
        
        // Call confirmGate middleware
        confirmGate(mockReq, mockRes, mockNext);
        
        // Should reject (token expired)
        expect(mockNext).not.toHaveBeenCalled();
        expect(mockRes.status).toHaveBeenCalledWith(403);
      } finally {
        Date.now = originalDateNow;
      }
    });

    it('should not use one-time token when manual confirmation provided', async () => {
      const { createOneTimeToken, consumeOneTimeToken } = await import('../src/lib/tokenStore.js');
      const { confirmGate } = await import('../src/middleware/confirmGate.js');
      
      // Create a token but also provide manual confirmation
      const record = createOneTimeToken();
      
      const mockReq = {
        headers: {
          'x-confirmed': 'yes',
          'x-arcanos-confirm-token': record.token
        },
        method: 'POST',
        path: '/test/endpoint'
      } as unknown as Request;
      
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn()
      } as unknown as Response;
      
      const mockNext = jest.fn() as NextFunction;
      
      // Call confirmGate middleware
      confirmGate(mockReq, mockRes, mockNext);
      
      // Should approve via manual confirmation, not one-time token
      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.confirmationContext?.usedOneTimeToken).toBe(false);
      expect(mockReq.confirmationContext?.manualConfirmation).toBe(true);
      
      // Token should still be consumable (wasn't used)
      const result = consumeOneTimeToken(record.token);
      expect(result.ok).toBe(true);
    });

    it('should not use one-time token when trusted GPT ID provided', async () => {
      // Set up a trusted GPT ID
      process.env.TRUSTED_GPT_IDS = 'trusted-gpt-123';
      jest.resetModules();
      
      const { createOneTimeToken, consumeOneTimeToken } = await import('../src/lib/tokenStore.js');
      const { confirmGate } = await import('../src/middleware/confirmGate.js');
      
      // Create a token
      const record = createOneTimeToken();
      
      const mockReq = {
        headers: {
          'x-gpt-id': 'trusted-gpt-123',
          'x-arcanos-confirm-token': record.token
        },
        body: {},
        method: 'POST',
        path: '/test/endpoint'
      } as unknown as Request;
      
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn()
      } as unknown as Response;
      
      const mockNext = jest.fn() as NextFunction;
      
      // Call confirmGate middleware
      confirmGate(mockReq, mockRes, mockNext);
      
      // Should approve via trusted GPT, not one-time token
      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.confirmationContext?.usedOneTimeToken).toBe(false);
      expect(mockReq.confirmationContext?.isTrustedGpt).toBe(true);
      
      // Token should still be consumable (wasn't used)
      const result = consumeOneTimeToken(record.token);
      expect(result.ok).toBe(true);
    });

    it('should not use one-time token when automation secret provided', async () => {
      const { createOneTimeToken, consumeOneTimeToken } = await import('../src/lib/tokenStore.js');
      const { confirmGate } = await import('../src/middleware/confirmGate.js');
      
      // Create a token
      const record = createOneTimeToken();
      
      const mockReq = {
        headers: {
          'x-arcanos-secret': 'test-secret',
          'x-arcanos-confirm-token': record.token
        },
        body: {},
        method: 'POST',
        path: '/test/endpoint'
      } as unknown as Request;
      
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn()
      } as unknown as Response;
      
      const mockNext = jest.fn() as NextFunction;
      
      // Call confirmGate middleware
      confirmGate(mockReq, mockRes, mockNext);
      
      // Should approve via automation secret, not one-time token
      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.confirmationContext?.usedOneTimeToken).toBe(false);
      expect(mockReq.confirmationContext?.automationSecretApproved).toBe(true);
      
      // Token should still be consumable (wasn't used)
      const result = consumeOneTimeToken(record.token);
      expect(result.ok).toBe(true);
    });
  });

  describe('Token priority in authentication', () => {
    it('should prioritize manual confirmation over one-time token', async () => {
      const { createOneTimeToken } = await import('../src/lib/tokenStore.js');
      const { confirmGate } = await import('../src/middleware/confirmGate.js');
      
      const record = createOneTimeToken();
      
      const mockReq = {
        headers: {
          'x-confirmed': 'yes',
          'x-arcanos-confirm-token': record.token
        },
        method: 'POST',
        path: '/test'
      } as unknown as Request;
      
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn()
      } as unknown as Response;
      
      const mockNext = jest.fn() as NextFunction;
      
      confirmGate(mockReq, mockRes, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.confirmationContext?.confirmationStatus).toBe('confirmed');
      expect(mockReq.confirmationContext?.usedOneTimeToken).toBe(false);
    });

    it('should use one-time token when no other auth methods provided', async () => {
      const { createOneTimeToken } = await import('../src/lib/tokenStore.js');
      const { confirmGate } = await import('../src/middleware/confirmGate.js');
      
      const record = createOneTimeToken();
      
      const mockReq = {
        headers: {
          'x-arcanos-confirm-token': record.token
        },
        method: 'POST',
        path: '/test'
      } as unknown as Request;
      
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn()
      } as unknown as Response;
      
      const mockNext = jest.fn() as NextFunction;
      
      confirmGate(mockReq, mockRes, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.confirmationContext?.confirmationStatus).toBe('one-time-token');
      expect(mockReq.confirmationContext?.usedOneTimeToken).toBe(true);
    });
  });

  describe('Error handling', () => {
    it('should handle missing token gracefully', async () => {
      const { confirmGate } = await import('../src/middleware/confirmGate.js');
      
      const mockReq = {
        headers: {},
        body: {},
        method: 'POST',
        path: '/test'
      } as unknown as Request;
      
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn()
      } as unknown as Response;
      
      const mockNext = jest.fn() as NextFunction;
      
      confirmGate(mockReq, mockRes, mockNext);
      
      // Should reject with challenge
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(403);
      
      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.confirmationRequired).toBe(true);
      expect(jsonCall.confirmationChallenge).toBeDefined();
    });

    it('should handle malformed token gracefully', async () => {
      const { confirmGate } = await import('../src/middleware/confirmGate.js');
      
      const mockReq = {
        headers: {
          'x-arcanos-confirm-token': ''
        },
        body: {},
        method: 'POST',
        path: '/test'
      } as unknown as Request;
      
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn()
      } as unknown as Response;
      
      const mockNext = jest.fn() as NextFunction;
      
      confirmGate(mockReq, mockRes, mockNext);
      
      // Should reject
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(403);
    });
  });
});

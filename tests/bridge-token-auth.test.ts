import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import type { IncomingMessage } from 'http';

// Set test environment variables before imports
process.env.ARCANOS_AUTOMATION_SECRET = '';
process.env.ARCANOS_AUTOMATION_HEADER = 'x-automation-secret';

// Import after env setup
const tokenStore = await import('../src/lib/tokenStore.js');

describe('Bridge Socket Authentication with One-Time Tokens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Helper to simulate the isAutomationAuthorized function behavior
  function simulateAuthorization(req: Partial<IncomingMessage>, automationSecret: string = ''): boolean {
    try {
      const resolveHeader = (headers: any, name: string) => {
        const normalizedName = name.toLowerCase();
        return headers[normalizedName] || headers[name];
      };

      const headerName = 'x-automation-secret';
      const secret = automationSecret;
      
      if (!secret) {
        const token = resolveHeader(req.headers || {}, 'x-arcanos-confirm-token');
        if (!token) {
          return false;
        }
        return tokenStore.consumeOneTimeToken(token).ok;
      }
      
      const provided = resolveHeader(req.headers || {}, headerName);
      if (provided === secret) {
        return true;
      }
      
      const token = resolveHeader(req.headers || {}, 'x-arcanos-confirm-token');
      if (!token) {
        return false;
      }
      
      return tokenStore.consumeOneTimeToken(token).ok;
    } catch (error) {
      return false;
    }
  }

  describe('Token-based authentication without automation secret', () => {
    test('allows connection with valid one-time token', () => {
      const tokenRecord = tokenStore.createOneTimeToken();
      const validToken = tokenRecord.token;

      const mockReq: Partial<IncomingMessage> = {
        headers: {
          'x-arcanos-confirm-token': validToken
        }
      };

      const result = simulateAuthorization(mockReq);

      expect(result).toBe(true);
    });

    test('rejects connection with invalid one-time token', () => {
      const invalidToken = 'invalid-bridge-token';

      const mockReq: Partial<IncomingMessage> = {
        headers: {
          'x-arcanos-confirm-token': invalidToken
        }
      };

      const result = simulateAuthorization(mockReq);

      expect(result).toBe(false);
    });

    test('rejects connection without token', () => {
      const mockReq: Partial<IncomingMessage> = {
        headers: {}
      };

      const result = simulateAuthorization(mockReq);

      expect(result).toBe(false);
    });

    test('rejects connection with expired token', () => {
      // Create and immediately consume a token to simulate expiration
      const tokenRecord = tokenStore.createOneTimeToken();
      const expiredToken = tokenRecord.token;
      
      // Consume it first
      tokenStore.consumeOneTimeToken(expiredToken);

      const mockReq: Partial<IncomingMessage> = {
        headers: {
          'x-arcanos-confirm-token': expiredToken
        }
      };

      const result = simulateAuthorization(mockReq);

      expect(result).toBe(false);
    });
  });

  describe('Token-based authentication with automation secret', () => {
    test('allows connection with valid automation secret', () => {
      const mockReq: Partial<IncomingMessage> = {
        headers: {
          'x-automation-secret': 'test-automation-secret'
        }
      };

      const result = simulateAuthorization(mockReq, 'test-automation-secret');

      expect(result).toBe(true);
    });

    test('falls back to one-time token when automation secret is invalid', () => {
      const tokenRecord = tokenStore.createOneTimeToken();
      const validToken = tokenRecord.token;

      const mockReq: Partial<IncomingMessage> = {
        headers: {
          'x-automation-secret': 'wrong-secret',
          'x-arcanos-confirm-token': validToken
        }
      };

      const result = simulateAuthorization(mockReq, 'test-automation-secret');

      expect(result).toBe(true);
    });

    test('rejects connection with neither valid secret nor token', () => {
      const mockReq: Partial<IncomingMessage> = {
        headers: {
          'x-automation-secret': 'wrong-secret',
          'x-arcanos-confirm-token': 'invalid-token'
        }
      };

      const result = simulateAuthorization(mockReq, 'test-automation-secret');

      expect(result).toBe(false);
    });

    test('rejects connection with wrong secret and no token', () => {
      const mockReq: Partial<IncomingMessage> = {
        headers: {
          'x-automation-secret': 'wrong-secret'
        }
      };

      const result = simulateAuthorization(mockReq, 'test-automation-secret');

      expect(result).toBe(false);
    });
  });

  describe('Token replay prevention', () => {
    test('token can only be used once for bridge connection', () => {
      const tokenRecord = tokenStore.createOneTimeToken();
      const token = tokenRecord.token;

      const mockReq1: Partial<IncomingMessage> = {
        headers: {
          'x-arcanos-confirm-token': token
        }
      };

      const result1 = simulateAuthorization(mockReq1);
      expect(result1).toBe(true);

      // Second connection attempt: same token is invalid (already consumed)
      const mockReq2: Partial<IncomingMessage> = {
        headers: {
          'x-arcanos-confirm-token': token
        }
      };

      const result2 = simulateAuthorization(mockReq2);
      expect(result2).toBe(false);
    });

    test('consuming token in bridge does not affect other tokens', () => {
      const tokenRecord1 = tokenStore.createOneTimeToken();
      const token1 = tokenRecord1.token;
      const tokenRecord2 = tokenStore.createOneTimeToken();
      const token2 = tokenRecord2.token;

      const mockReq1: Partial<IncomingMessage> = {
        headers: {
          'x-arcanos-confirm-token': token1
        }
      };

      expect(simulateAuthorization(mockReq1)).toBe(true);

      // Second token should still be valid
      const mockReq2: Partial<IncomingMessage> = {
        headers: {
          'x-arcanos-confirm-token': token2
        }
      };

      expect(simulateAuthorization(mockReq2)).toBe(true);
    });
  });

  describe('Error handling', () => {
    test('handles token consumption errors gracefully', () => {
      const token = 'error-token';

      
      // With invalid token, should reject
      const mockReq: Partial<IncomingMessage> = {
        headers: {
          'x-arcanos-confirm-token': token
        }
      };

      // The function should handle errors and return false
      const result = simulateAuthorization(mockReq);
      expect(result).toBe(false);
    });

    test('handles missing headers gracefully', () => {
      const mockReq: Partial<IncomingMessage> = {
        headers: undefined
      };

      const result = simulateAuthorization(mockReq);
      expect(result).toBe(false);
    });
  });

  describe('Security audit markers', () => {
    test('verifies confirmation token is the capability (audit marker)', () => {
      // Audit assumption: confirmation token is the capability
      // Risk: replay if not consumed
      // Invariant: consume on success
      // Handling: consume + accept only when valid
      
      const tokenRecord = tokenStore.createOneTimeToken();
      const token = tokenRecord.token;

      const mockReq: Partial<IncomingMessage> = {
        headers: {
          'x-arcanos-confirm-token': token
        }
      };

      const result = simulateAuthorization(mockReq);

      // Verify token was consumed (preventing replay)
      expect(result).toBe(true);
      
      // Try to reuse token - should fail
      const result2 = simulateAuthorization(mockReq);
      expect(result2).toBe(false);
    });

    test('verifies token can authorize IPC without automation secret (audit marker)', () => {
      // Audit assumption: confirmation token can authorize IPC without automation secret
      // Risk: replay
      // Invariant: token must be consumed
      // Handling: consume + accept when valid
      
      const tokenRecord = tokenStore.createOneTimeToken();
      const token = tokenRecord.token;

      const mockReq: Partial<IncomingMessage> = {
        headers: {
          'x-arcanos-confirm-token': token
        }
      };

      const result = simulateAuthorization(mockReq);

      expect(result).toBe(true);
    });
  });

  describe('Integration scenarios', () => {
    test('token works for bridge authentication after being created via API', () => {
      // Simulate the full flow: create token, use it for bridge auth
      const tokenRecord = tokenStore.createOneTimeToken();
      const token = tokenRecord.token;

      const mockReq: Partial<IncomingMessage> = {
        headers: {
          'x-arcanos-confirm-token': token
        }
      };

      const result = simulateAuthorization(mockReq);
      expect(result).toBe(true);
    });

    test('automation secret takes precedence over token', () => {
      const tokenRecord = tokenStore.createOneTimeToken();
      const token = tokenRecord.token;

      const mockReq: Partial<IncomingMessage> = {
        headers: {
          'x-automation-secret': 'priority-secret',
          'x-arcanos-confirm-token': token
        }
      };

      const result = simulateAuthorization(mockReq, 'priority-secret');

      // Token should not be consumed if secret is valid
      expect(result).toBe(true);
      
      // Token should still be valid (not consumed)
      const tokenCheck = tokenStore.consumeOneTimeToken(token);
      expect(tokenCheck.ok).toBe(true);
    });
  });
});

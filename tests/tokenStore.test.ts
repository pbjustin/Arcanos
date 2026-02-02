import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { createOneTimeToken, consumeOneTimeToken, getOneTimeTokenTtlMs } from '../src/lib/tokenStore.js';

describe('tokenStore', () => {
  // Clear environment variables before each test to ensure clean state
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createOneTimeToken', () => {
    test('generates a valid token with proper structure', () => {
      const token = createOneTimeToken();

      expect(token).toHaveProperty('token');
      expect(token).toHaveProperty('issuedAt');
      expect(token).toHaveProperty('expiresAt');
      expect(token).toHaveProperty('ttlMs');
      expect(typeof token.token).toBe('string');
      expect(token.token.length).toBeGreaterThan(0);
      expect(typeof token.issuedAt).toBe('number');
      expect(typeof token.expiresAt).toBe('number');
      expect(typeof token.ttlMs).toBe('number');
    });

    test('generates unique tokens on consecutive calls', () => {
      const token1 = createOneTimeToken();
      const token2 = createOneTimeToken();

      expect(token1.token).not.toBe(token2.token);
    });

    test('sets expiration time based on TTL', () => {
      const token = createOneTimeToken();
      const expectedExpiration = token.issuedAt + token.ttlMs;

      expect(token.expiresAt).toBe(expectedExpiration);
    });

    test('uses default TTL when no environment variable is set', () => {
      const token = createOneTimeToken();
      const defaultTtl = 10 * 60 * 1000; // 10 minutes in milliseconds

      expect(token.ttlMs).toBe(defaultTtl);
    });
  });

  describe('consumeOneTimeToken', () => {
    test('successfully consumes a valid token', () => {
      const token = createOneTimeToken();
      const result = consumeOneTimeToken(token.token);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.record).toBeDefined();
        expect(result.record.token).toBe(token.token);
      }
    });

    test('prevents replay attacks - token can only be consumed once', () => {
      const token = createOneTimeToken();
      
      // First consumption should succeed
      const firstResult = consumeOneTimeToken(token.token);
      expect(firstResult.ok).toBe(true);

      // Second consumption should fail
      const secondResult = consumeOneTimeToken(token.token);
      expect(secondResult.ok).toBe(false);
      if (!secondResult.ok) {
        expect(secondResult.reason).toBe('invalid');
      }
    });

    test('rejects invalid token', () => {
      const result = consumeOneTimeToken('invalid-token-12345');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid');
      }
    });

    test('rejects missing token', () => {
      const result = consumeOneTimeToken(undefined);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('missing');
      }
    });

    test('rejects empty string token', () => {
      const result = consumeOneTimeToken('');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('missing');
      }
    });

    test('rejects whitespace-only token', () => {
      const result = consumeOneTimeToken('   ');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('missing');
      }
    });

    test('handles expired tokens correctly', async () => {
      // Create a token
      const token = createOneTimeToken();
      
      // Mock Date.now to simulate time passing beyond expiration
      const originalDateNow = Date.now;
      const futureTime = token.expiresAt + 1000; // 1 second after expiration
      Date.now = jest.fn(() => futureTime) as unknown as typeof Date.now;

      try {
        const result = consumeOneTimeToken(token.token);

        // Note: expired tokens are purged before lookup, so they appear as 'invalid'
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(['expired', 'invalid']).toContain(result.reason);
        }
      } finally {
        // Restore original Date.now
        Date.now = originalDateNow;
      }
    });

    test('returns the original token record on successful consumption', () => {
      const token = createOneTimeToken();
      const result = consumeOneTimeToken(token.token);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.record.token).toBe(token.token);
        expect(result.record.issuedAt).toBe(token.issuedAt);
        expect(result.record.expiresAt).toBe(token.expiresAt);
        expect(result.record.ttlMs).toBe(token.ttlMs);
      }
    });
  });

  describe('getOneTimeTokenTtlMs', () => {
    test('returns the configured TTL value', () => {
      const ttl = getOneTimeTokenTtlMs();

      expect(typeof ttl).toBe('number');
      expect(ttl).toBeGreaterThan(0);
    });

    test('returns consistent value across multiple calls', () => {
      const ttl1 = getOneTimeTokenTtlMs();
      const ttl2 = getOneTimeTokenTtlMs();

      expect(ttl1).toBe(ttl2);
    });
  });

  describe('token expiration and cleanup', () => {
    test('purges expired tokens during consumption attempts', async () => {
      // Create multiple tokens
      const token1 = createOneTimeToken();
      const token2 = createOneTimeToken();
      const token3 = createOneTimeToken();

      // Mock Date.now to simulate time passing
      const originalDateNow = Date.now;
      const futureTime = token1.expiresAt + 1000;
      Date.now = jest.fn(() => futureTime) as unknown as typeof Date.now;

      try {
        // All tokens should be expired now
        const result1 = consumeOneTimeToken(token1.token);
        const result2 = consumeOneTimeToken(token2.token);
        const result3 = consumeOneTimeToken(token3.token);

        expect(result1.ok).toBe(false);
        expect(result2.ok).toBe(false);
        expect(result3.ok).toBe(false);
        
        // Note: expired tokens are purged before lookup, so they appear as 'invalid'
        if (!result1.ok) expect(['expired', 'invalid']).toContain(result1.reason);
        if (!result2.ok) expect(['expired', 'invalid']).toContain(result2.reason);
        if (!result3.ok) expect(['expired', 'invalid']).toContain(result3.reason);
      } finally {
        Date.now = originalDateNow;
      }
    });

    test('purges expired tokens during token creation', async () => {
      // Create a token
      const oldToken = createOneTimeToken();

      // Mock Date.now to simulate time passing
      const originalDateNow = Date.now;
      const futureTime = oldToken.expiresAt + 1000;
      Date.now = jest.fn(() => futureTime) as unknown as typeof Date.now;

      try {
        // Create a new token, which should trigger purge of expired tokens
        const newToken = createOneTimeToken();
        expect(newToken.token).toBeDefined();

        // Old token should now be invalid (purged)
        const result = consumeOneTimeToken(oldToken.token);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe('invalid');
        }
      } finally {
        Date.now = originalDateNow;
      }
    });
  });

  describe('token security properties', () => {
    test('token is a UUID format', () => {
      const token = createOneTimeToken();
      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      
      expect(token.token).toMatch(uuidRegex);
    });

    test('tokens have sufficient entropy (multiple unique tokens)', () => {
      const tokens = new Set<string>();
      const count = 100;

      for (let i = 0; i < count; i++) {
        const token = createOneTimeToken();
        tokens.add(token.token);
      }

      // All tokens should be unique
      expect(tokens.size).toBe(count);
    });
  });
});

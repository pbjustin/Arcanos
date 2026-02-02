/**
 * Unit tests for tokenStore module
 * Tests token generation, consumption, replay prevention, and expiration
 */

import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';
import { createOneTimeToken, consumeOneTimeToken, getOneTimeTokenTtlMs } from '../src/lib/tokenStore.js';

describe('tokenStore', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset environment to defaults
    process.env = { ...originalEnv };
    delete process.env.ARCANOS_CONFIRM_TOKEN_TTL_MS;
    delete process.env.ARCANOS_CONFIRM_TOKEN_TTL_MINUTES;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('createOneTimeToken', () => {
    it('should generate a token with valid UUID format', () => {
      const record = createOneTimeToken();

      expect(record).toBeDefined();
      expect(record.token).toBeDefined();
      expect(typeof record.token).toBe('string');
      // UUID v4 format validation
      expect(record.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('should set issuedAt to current timestamp', () => {
      const before = Date.now();
      const record = createOneTimeToken();
      const after = Date.now();

      expect(record.issuedAt).toBeGreaterThanOrEqual(before);
      expect(record.issuedAt).toBeLessThanOrEqual(after);
    });

    it('should set expiresAt to issuedAt + ttlMs', () => {
      const record = createOneTimeToken();

      expect(record.expiresAt).toBe(record.issuedAt + record.ttlMs);
    });

    it('should use default TTL of 10 minutes when no env vars set', () => {
      const record = createOneTimeToken();
      const expectedTtl = 10 * 60 * 1000; // 10 minutes in ms

      expect(record.ttlMs).toBe(expectedTtl);
    });

    it('should generate unique tokens for multiple calls', () => {
      const record1 = createOneTimeToken();
      const record2 = createOneTimeToken();
      const record3 = createOneTimeToken();

      expect(record1.token).not.toBe(record2.token);
      expect(record2.token).not.toBe(record3.token);
      expect(record1.token).not.toBe(record3.token);
    });
  });

  describe('consumeOneTimeToken', () => {
    it('should successfully consume a valid token', () => {
      const record = createOneTimeToken();
      const result = consumeOneTimeToken(record.token);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.record).toBeDefined();
        expect(result.record.token).toBe(record.token);
        expect(result.record.issuedAt).toBe(record.issuedAt);
        expect(result.record.expiresAt).toBe(record.expiresAt);
      }
    });

    it('should return error for missing token', () => {
      const result = consumeOneTimeToken(undefined);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('missing');
      }
    });

    it('should return error for empty string token', () => {
      const result = consumeOneTimeToken('');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('missing');
      }
    });

    it('should return error for whitespace-only token', () => {
      const result = consumeOneTimeToken('   ');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('missing');
      }
    });

    it('should return error for invalid token', () => {
      const result = consumeOneTimeToken('invalid-token-12345');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid');
      }
    });

    it('should prevent replay attacks by consuming token only once', () => {
      //audit Assumption: token is single-use capability; risk: replay attack if not consumed; invariant: second consumption must fail; handling: verify token deleted after first use.
      const record = createOneTimeToken();

      // First consumption should succeed
      const firstResult = consumeOneTimeToken(record.token);
      expect(firstResult.ok).toBe(true);

      // Second consumption should fail (replay prevention)
      const secondResult = consumeOneTimeToken(record.token);
      expect(secondResult.ok).toBe(false);
      if (!secondResult.ok) {
        expect(secondResult.reason).toBe('invalid');
      }
    });

    it('should return error for expired token', () => {
      //audit Assumption: tokens have time-bound validity; risk: stale token acceptance; invariant: expired tokens must be rejected; handling: check expiry before consumption.
      // Create a token and manually manipulate time to expire it
      const record = createOneTimeToken();

      // Mock Date.now to return time after expiration
      const originalDateNow = Date.now;
      const futureTime = record.expiresAt + 1000; // 1 second after expiration
      Date.now = jest.fn(() => futureTime);

      try {
        const result = consumeOneTimeToken(record.token);

        // Token is purged during consumption, so it returns 'invalid' after purge
        // or 'expired' if caught at exact boundary - both are valid rejections
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(['expired', 'invalid']).toContain(result.reason);
        }
      } finally {
        Date.now = originalDateNow;
      }
    });
  });

  describe('TTL configuration', () => {
    it('should use ARCANOS_CONFIRM_TOKEN_TTL_MS when set', () => {
      const customTtl = 5 * 60 * 1000; // 5 minutes
      process.env.ARCANOS_CONFIRM_TOKEN_TTL_MS = customTtl.toString();

      // Need to reload module to pick up new env var
      jest.resetModules();

      // Re-import to get fresh instance with new env
      return import('../src/lib/tokenStore.js').then(({ createOneTimeToken: create, getOneTimeTokenTtlMs: getTtl }) => {
        const ttl = getTtl();
        expect(ttl).toBe(customTtl);

        const record = create();
        expect(record.ttlMs).toBe(customTtl);
      });
    });

    it('should convert ARCANOS_CONFIRM_TOKEN_TTL_MINUTES to milliseconds', () => {
      const customMinutes = 15;
      const expectedMs = customMinutes * 60 * 1000;
      process.env.ARCANOS_CONFIRM_TOKEN_TTL_MINUTES = customMinutes.toString();

      jest.resetModules();

      return import('../src/lib/tokenStore.js').then(({ createOneTimeToken: create, getOneTimeTokenTtlMs: getTtl }) => {
        const ttl = getTtl();
        expect(ttl).toBe(expectedMs);

        const record = create();
        expect(record.ttlMs).toBe(expectedMs);
      });
    });

    it('should prefer TTL_MS over TTL_MINUTES when both are set', () => {
      const ttlMs = 3 * 60 * 1000; // 3 minutes
      const ttlMinutes = 20; // 20 minutes (should be ignored)

      process.env.ARCANOS_CONFIRM_TOKEN_TTL_MS = ttlMs.toString();
      process.env.ARCANOS_CONFIRM_TOKEN_TTL_MINUTES = ttlMinutes.toString();

      jest.resetModules();

      return import('../src/lib/tokenStore.js').then(({ getOneTimeTokenTtlMs: getTtl }) => {
        const ttl = getTtl();
        expect(ttl).toBe(ttlMs);
        expect(ttl).not.toBe(ttlMinutes * 60 * 1000);
      });
    });

    it('should use default TTL when env vars are invalid', () => {
      const defaultTtl = 10 * 60 * 1000;
      process.env.ARCANOS_CONFIRM_TOKEN_TTL_MS = 'invalid';

      jest.resetModules();

      return import('../src/lib/tokenStore.js').then(({ getOneTimeTokenTtlMs: getTtl }) => {
        const ttl = getTtl();
        expect(ttl).toBe(defaultTtl);
      });
    });
  });

  describe('token purging', () => {
    it('should automatically purge expired tokens when creating new tokens', () => {
      //audit Assumption: expired tokens should not accumulate; risk: memory leak from stale tokens; invariant: expired tokens removed on create; handling: purge before creation.
      const originalDateNow = Date.now;

      try {
        // Create tokens at T=0
        Date.now = jest.fn(() => 1000000);
        const token1 = createOneTimeToken();
        const token2 = createOneTimeToken();

        // Move time forward past expiration
        Date.now = jest.fn(() => 1000000 + (11 * 60 * 1000)); // 11 minutes later

        // Create new token (should purge expired ones)
        const token3 = createOneTimeToken();

        // Try to consume old tokens (should be purged)
        const result1 = consumeOneTimeToken(token1.token);
        const result2 = consumeOneTimeToken(token2.token);

        expect(result1.ok).toBe(false);
        expect(result2.ok).toBe(false);

        // New token should still work
        const result3 = consumeOneTimeToken(token3.token);
        expect(result3.ok).toBe(true);
      } finally {
        Date.now = originalDateNow;
      }
    });

    it('should automatically purge expired tokens when consuming tokens', () => {
      const originalDateNow = Date.now;

      try {
        // Create token at T=0
        Date.now = jest.fn(() => 1000000);
        const token = createOneTimeToken();

        // Move time forward past expiration
        Date.now = jest.fn(() => 1000000 + (11 * 60 * 1000)); // 11 minutes later

        // Try to consume (should trigger purge and return error)
        // Token is purged, so it returns 'invalid' after purge
        // or 'expired' if caught at exact boundary - both are valid rejections
        const result = consumeOneTimeToken(token.token);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(['expired', 'invalid']).toContain(result.reason);
        }
      } finally {
        Date.now = originalDateNow;
      }
    });
  });

  describe('getOneTimeTokenTtlMs', () => {
    it('should return the configured TTL in milliseconds', () => {
      const ttl = getOneTimeTokenTtlMs();
      expect(typeof ttl).toBe('number');
      expect(ttl).toBeGreaterThan(0);
    });
  });
});

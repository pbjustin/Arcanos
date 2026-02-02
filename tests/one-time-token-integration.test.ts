import { describe, test, expect } from '@jest/globals';
import { createOneTimeToken, consumeOneTimeToken } from '../src/lib/tokenStore.js';

/**
 * Integration tests for one-time token authentication flow.
 * These tests verify the complete lifecycle of token-based authentication
 * including creation, consumption, replay prevention, and expiration.
 */
describe('one-time token authentication integration', () => {
  describe('token creation and consumption flow', () => {
    test('creates valid token that can be consumed once', () => {
      // Create a new token
      const token = createOneTimeToken();
      
      // Verify token structure
      expect(token).toHaveProperty('token');
      expect(token).toHaveProperty('issuedAt');
      expect(token).toHaveProperty('expiresAt');
      expect(token).toHaveProperty('ttlMs');
      expect(typeof token.token).toBe('string');
      
      // Consume the token
      const consumeResult = consumeOneTimeToken(token.token);
      
      // Verify successful consumption
      expect(consumeResult.ok).toBe(true);
      if (consumeResult.ok) {
        expect(consumeResult.record.token).toBe(token.token);
      }
    });

    test('prevents replay attacks - token cannot be reused', () => {
      // Create and consume a token
      const token = createOneTimeToken();
      const firstConsume = consumeOneTimeToken(token.token);
      
      expect(firstConsume.ok).toBe(true);
      
      // Attempt to reuse the same token (replay attack)
      const secondConsume = consumeOneTimeToken(token.token);
      
      // Replay should be prevented
      expect(secondConsume.ok).toBe(false);
      if (!secondConsume.ok) {
        expect(secondConsume.reason).toBe('invalid');
      }
    });

    test('multiple tokens work independently', () => {
      // Create multiple tokens
      const token1 = createOneTimeToken();
      const token2 = createOneTimeToken();
      const token3 = createOneTimeToken();
      
      // All tokens should be unique
      expect(token1.token).not.toBe(token2.token);
      expect(token2.token).not.toBe(token3.token);
      expect(token1.token).not.toBe(token3.token);
      
      // Consume tokens in different order
      const consume2 = consumeOneTimeToken(token2.token);
      const consume1 = consumeOneTimeToken(token1.token);
      const consume3 = consumeOneTimeToken(token3.token);
      
      // All should succeed
      expect(consume1.ok).toBe(true);
      expect(consume2.ok).toBe(true);
      expect(consume3.ok).toBe(true);
      
      // None should be reusable
      expect(consumeOneTimeToken(token1.token).ok).toBe(false);
      expect(consumeOneTimeToken(token2.token).ok).toBe(false);
      expect(consumeOneTimeToken(token3.token).ok).toBe(false);
    });
  });

  describe('token validation and security', () => {
    test('rejects invalid token format', () => {
      const result = consumeOneTimeToken('not-a-valid-token');
      
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid');
      }
    });

    test('rejects null/undefined token', () => {
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
      const result = consumeOneTimeToken('   \t\n  ');
      
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('missing');
      }
    });

    test('token is a valid UUID v4', () => {
      const token = createOneTimeToken();
      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      
      expect(token.token).toMatch(uuidRegex);
    });
  });

  describe('token lifecycle and expiration', () => {
    test('tokens have proper timestamps', () => {
      const now = Date.now();
      const token = createOneTimeToken();
      
      // issuedAt should be close to current time (within 1 second)
      expect(token.issuedAt).toBeGreaterThanOrEqual(now - 1000);
      expect(token.issuedAt).toBeLessThanOrEqual(now + 1000);
      
      // expiresAt should be in the future
      expect(token.expiresAt).toBeGreaterThan(token.issuedAt);
      
      // ttlMs should match the difference
      expect(token.expiresAt - token.issuedAt).toBe(token.ttlMs);
    });

    test('token can be consumed immediately after creation', () => {
      const token = createOneTimeToken();
      
      // Should be consumable right away
      const result = consumeOneTimeToken(token.token);
      expect(result.ok).toBe(true);
    });

    test('consumed token returns correct record data', () => {
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

  describe('concurrent access and edge cases', () => {
    test('handles rapid token creation', () => {
      const tokens = new Set<string>();
      const count = 50;
      
      // Create many tokens rapidly
      for (let i = 0; i < count; i++) {
        const token = createOneTimeToken();
        tokens.add(token.token);
      }
      
      // All should be unique
      expect(tokens.size).toBe(count);
    });

    test('handles rapid consumption attempts', () => {
      const token = createOneTimeToken();
      
      // Try to consume multiple times rapidly
      const results = [];
      for (let i = 0; i < 10; i++) {
        results.push(consumeOneTimeToken(token.token));
      }
      
      // Only one should succeed
      const successful = results.filter(r => r.ok);
      expect(successful.length).toBe(1);
      
      // All others should fail
      const failed = results.filter(r => !r.ok);
      expect(failed.length).toBe(9);
    });

    test('different tokens do not interfere with each other', () => {
      // Create several tokens
      const tokens = [
        createOneTimeToken(),
        createOneTimeToken(),
        createOneTimeToken()
      ];
      
      // Consume first token
      consumeOneTimeToken(tokens[0].token);
      
      // Other tokens should still be valid
      expect(consumeOneTimeToken(tokens[1].token).ok).toBe(true);
      expect(consumeOneTimeToken(tokens[2].token).ok).toBe(true);
      
      // First token should be consumed
      expect(consumeOneTimeToken(tokens[0].token).ok).toBe(false);
    });
  });

  describe('token entropy and uniqueness', () => {
    test('generates unique tokens across large sample', () => {
      const tokens = new Set<string>();
      const sampleSize = 1000;
      
      for (let i = 0; i < sampleSize; i++) {
        tokens.add(createOneTimeToken().token);
      }
      
      // All tokens should be unique (no collisions)
      expect(tokens.size).toBe(sampleSize);
    });

    test('token format is consistent', () => {
      const tokens = [];
      for (let i = 0; i < 10; i++) {
        tokens.push(createOneTimeToken().token);
      }
      
      // All tokens should have the same format (UUID v4)
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      tokens.forEach(token => {
        expect(token).toMatch(uuidRegex);
      });
    });
  });
});

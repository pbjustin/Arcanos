/**
 * Hash Utilities
 * Reusable hashing functions for various use cases
 */

import crypto from 'crypto';

/**
 * Creates a SHA-256 hash from a given content string
 * 
 * @param content - Content to hash
 * @returns Hexadecimal hash string
 */
export function createSHA256Hash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Creates a cache key by combining model and payload
 * 
 * @param model - Model identifier
 * @param payload - Request payload (string or object)
 * @returns SHA-256 hash of the combined content
 */
export function createCacheKey(model: string, payload: unknown): string {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const content = `${model}:${serialized}`;
  return createSHA256Hash(content);
}

/**
 * Creates a unique identifier from a prefix and random data
 * 
 * @param prefix - Prefix for the identifier
 * @returns Prefixed unique identifier
 */
export function createUniqueId(prefix: string): string {
  const randomHex = crypto.randomBytes(8).toString('hex');
  return `${prefix}_${randomHex}`;
}

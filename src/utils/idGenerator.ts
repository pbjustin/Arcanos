/**
 * Utility for generating unique request and operation IDs
 * Centralizes ID generation logic to reduce code duplication
 */

/**
 * Generate a unique ID with a prefix
 * @param prefix - Prefix for the ID (e.g., 'arc', 'trinity', 'req')
 * @returns Unique ID in format: prefix_timestamp_random
 */
export function generateRequestId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

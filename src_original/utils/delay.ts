/**
 * Modern delay utility using promisified setTimeout
 * Replaces the outdated `new Promise(resolve => setTimeout(resolve, ms))` pattern
 */

import { promisify } from 'util';

/**
 * Promisified setTimeout for modern async/await patterns
 * @param ms - Delay in milliseconds
 * @returns Promise that resolves after the specified delay
 */
export const delay = promisify(setTimeout);

/**
 * Create a delay with exponential backoff
 * @param attempt - The current attempt number (0-based)
 * @param baseDelay - Base delay in milliseconds (default: 1000)
 * @param maxDelay - Maximum delay in milliseconds (default: 30000)
 * @returns Promise that resolves after the calculated delay
 */
export async function exponentialDelay(
  attempt: number, 
  baseDelay: number = 1000, 
  maxDelay: number = 30000
): Promise<void> {
  const delayMs = Math.min(Math.pow(2, attempt) * baseDelay, maxDelay);
  await delay(delayMs);
}

/**
 * Create a delay with jitter to avoid thundering herd
 * @param baseDelay - Base delay in milliseconds
 * @param jitterPercent - Jitter percentage (0-100, default: 20)
 * @returns Promise that resolves after the jittered delay
 */
export async function jitteredDelay(
  baseDelay: number, 
  jitterPercent: number = 20
): Promise<void> {
  const jitter = baseDelay * (jitterPercent / 100);
  const actualDelay = baseDelay + (Math.random() * jitter * 2 - jitter);
  await delay(Math.max(0, actualDelay));
}
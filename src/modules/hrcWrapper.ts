import { hrcCore, type HRCResult } from './hrc.js';
import { queryCache } from '../utils/cache.js';
import { createSHA256Hash } from '../utils/hashUtils.js';

const HRC_FALLBACK: HRCResult = { fidelity: 0, resilience: 0, verdict: 'HRC unavailable' };

function cacheKey(text: string): string {
  return `hrc:${createSHA256Hash(text)}`;
}

/**
 * Evaluates text through HRC with caching. Returns fallback scores on failure.
 */
export async function evaluateWithHRC(text: string): Promise<HRCResult> {
  if (!text.trim()) return HRC_FALLBACK;

  const key = cacheKey(text);
  const cached = queryCache.get(key) as HRCResult | null;
  if (cached) return cached;

  try {
    const result = await hrcCore.evaluate(text);
    queryCache.set(key, result);
    return result;
  } catch {
    return HRC_FALLBACK;
  }
}

/**
 * Wraps a module action result with an HRC evaluation of a text field.
 * Returns the original result with an `hrc` property appended.
 */
export async function withHRC<T extends Record<string, unknown>>(
  result: T,
  textExtractor: (r: T) => string
): Promise<T & { hrc: HRCResult }> {
  const text = textExtractor(result);
  const hrc = await evaluateWithHRC(text);
  return { ...result, hrc };
}

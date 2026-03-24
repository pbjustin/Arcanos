import { hrcCore, type HRCResult } from './hrc.js';
import { queryCache } from "@platform/resilience/cache.js";
import { createSHA256Hash } from "@shared/hashUtils.js";
import {
  buildMemoryInspectionGuardMessage,
  parseMemoryInspectionRequest
} from './memoryInspectionGuard.js';

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

/**
 * Guard backend-memory inspection prompts so unsupported state never falls back to tutor prose.
 * Inputs/outputs: original prompt plus optional session id -> grounded replacement text or null.
 * Edge cases: non-inspection prompts return null so callers preserve normal text output.
 */
export function buildHrcMemoryInspectionGuard(params: {
  prompt: string;
  sessionId?: string | null;
}): { text: string; reason: string } | null {
  const inspectionRequest = parseMemoryInspectionRequest(params.prompt);

  //audit Assumption: only explicit raw-memory inspection prompts should trigger the HRC grounding guard; failure risk: educational prompts are replaced by operational refusal text; expected invariant: the guard activates only for backend inspection requests; handling strategy: short-circuit null when no inspection request is parsed.
  if (!inspectionRequest) {
    return null;
  }

  return {
    text: buildMemoryInspectionGuardMessage({
      sessionId: params.sessionId,
      unsupportedArtifacts: inspectionRequest.unsupportedArtifacts
    }),
    reason: 'unsupported_memory_inspection_prompt'
  };
}

/**
 * Trinity pipeline shared helpers.
 * Internal implementation; consumers should use runThroughBrain from trinity.js only.
 */

import { logger } from "@platform/logging/structuredLogging.js";

/**
 * Computes max and average relevance score from memory entries.
 */
export function calculateMemoryScoreSummary(relevanceScores: number[]): { maxScore: number; averageScore: number } {
  //audit Assumption: empty relevance set is valid for prompts with no memory hits; risk: divide-by-zero; invariant: average score is numeric; handling: return zeros.
  if (relevanceScores.length === 0) {
    return { maxScore: 0, averageScore: 0 };
  }
  const maxScore = Math.max(...relevanceScores);
  const totalScore = relevanceScores.reduce((sum, value) => sum + value, 0);
  const averageScore = totalScore / relevanceScores.length;
  return { maxScore, averageScore };
}

/**
 * Emits a standardized fallback event for stages that still support model fallback.
 */
export function logFallbackEvent(stage: string, requestedModel: string, fallbackModel: string, reason: string): void {
  logger.warn('Trinity fallback invoked', {
    module: 'trinity',
    operation: 'model-fallback',
    stage,
    requestedModel,
    fallbackModel,
    reason
  });
}

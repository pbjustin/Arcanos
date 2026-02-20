/**
 * Trinity pipeline shared helpers.
 * Internal implementation; consumers should use runThroughBrain from trinity.js only.
 */

import { logger } from "@platform/logging/structuredLogging.js";

/**
 * Computes max and average relevance score from memory entries.
 */
export function calculateMemoryScoreSummary(relevanceScores: number[]): { maxScore: number; averageScore: number } {
  if (relevanceScores.length === 0) {
    return { maxScore: 0, averageScore: 0 };
  }
  const maxScore = Math.max(...relevanceScores);
  const totalScore = relevanceScores.reduce((sum, value) => sum + value, 0);
  const averageScore = totalScore / relevanceScores.length;
  return { maxScore, averageScore };
}

export const STRUCTURED_REASONING_PROMPT = `
Return JSON only in this format:

{
  "reasoning_steps": string[],
  "assumptions": string[],
  "constraints": string[],
  "tradeoffs": string[],
  "alternatives_considered": string[],
  "chosen_path_justification": string,
  "final_answer": string
}

Do not include commentary outside JSON.
`;

export function safeJsonParse(text: string) {
  try {
    // Basic cleanup for markdown code blocks if the model includes them
    const jsonStr = text.replace(/```json\s?|```/g, '').trim();
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

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

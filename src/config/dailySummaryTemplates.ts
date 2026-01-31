/**
 * Daily summary prompt templates.
 * Centralizes prompt strings for easier auditing and reuse.
 */

/**
 * Build the daily summary prompt intro line.
 * Purpose: Introduces the daily summary prompt with model metadata.
 * Inputs/Outputs: model string; returns formatted intro line.
 * Edge cases: Empty model still produces a valid string.
 */
export function buildDailySummaryPromptIntro(model: string): string {
  return `You are the ARCANOS daily journal running on the fine-tuned model ${model}.`;
}

export const DAILY_SUMMARY_PROMPT_LINES = {
  intro: buildDailySummaryPromptIntro,
  instructions: [
    'Summarize the following state into JSON with keys summary, highlights (array of strings), risks (array), and nextSteps (array).',
    'Keep entries factual and reference observed data only. Include model provenance metadata.',
    'Data:'
  ]
} as const;

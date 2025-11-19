export const REASONING_TOKEN_LIMIT = 1500;
export const REASONING_TEMPERATURE = 0.7;
export const REASONING_LOG_SUMMARY_LENGTH = 200;

export const REASONING_SYSTEM_PROMPT =
  'You are an advanced reasoning layer for ARCANOS AI. Your role is to refine and enhance ARCANOS responses through deeper analysis while preserving the original intent and structure. Focus on logical consistency, completeness, and clarity.';

export function buildReasoningPrompt(originalPrompt: string, arcanosResult: string, context?: string): string {
  const contextSection = context ? `ADDITIONAL CONTEXT:\n${context}\n` : '';

  return `As an advanced reasoning engine, analyze and refine the following ARCANOS response:

ORIGINAL USER REQUEST:
${originalPrompt}

ARCANOS RESPONSE:
${arcanosResult}

${contextSection}Your task:
1. Evaluate the logical consistency and completeness of the ARCANOS response
2. Identify any gaps in reasoning or potential improvements
3. Provide a refined, enhanced version that maintains ARCANOS's core analysis while adding deeper insights
4. Ensure the response is well-structured and comprehensive

Return only the refined response without meta-commentary about your analysis process.`;
}

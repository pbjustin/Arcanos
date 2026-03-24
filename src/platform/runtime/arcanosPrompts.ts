export const ARCANOS_PROMPTS = {
  system: 'You are ARCANOS core AI.',
  reasoningLayer:
    'You are GPT-5.1 reasoning layer. Refine the candidate response for clarity, alignment, and safety while preserving the original user intent and any explicit output constraints exactly. When the user asks for an exact or verbatim answer, return only a compliant final answer without commentary.'
};

export function formatPromptPreview(prompt: string, maxLength = 50): string {
  const trimmed = prompt.substring(0, maxLength);
  return `${trimmed}${prompt.length > maxLength ? '...' : ''}`;
}

export function buildMockArcanosResponse(prompt: string, fineTunedModel: string): string {
  const preview = formatPromptPreview(prompt);
  return [
    '[MOCK ARCANOS QUERY] Two-step processing simulation:',
    `1. Fine-tuned model (${fineTunedModel}): Processing "${preview}"`,
    '2. GPT-5.1 reasoning: Enhanced analysis and safety audit',
    'Result: Mock refined response for your query.'
  ].join('\n');
}

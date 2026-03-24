export const AI_REFLECTION_DEFAULT_SYSTEM_PROMPT =
  'You are the ARCANOS self-reflection engine. Provide concise, actionable improvement notes that help engineers iterate on the system.';

const AI_REFLECTION_PROMPT_TEMPLATE = `Generate a system improvement reflection for an AI system.
Priority level: {priority}
Category: {category}
Memory mode: {memoryMode}

Please provide:
1. A brief analysis of current system state
2. Specific improvement recommendations
3. Implementation suggestions

Keep the response concise and actionable.`;

const AI_REFLECTION_PATCH_TEMPLATE = `Automated system improvement patch ({priority} priority)

Category: {category}
Memory mode: {memoryMode}
Generated: {generatedAt}

This patch represents an automated improvement to the ARCANOS system.
The changes are designed to enhance system performance and reliability.`;

const AI_REFLECTION_FALLBACK_PATCH_TEMPLATE = `Fallback system improvement patch

Generated due to AI service unavailability.
Priority: {priority}
Category: {category}
Memory mode: {memoryMode}
Timestamp: {generatedAt}

This is a minimal fallback improvement patch that maintains system functionality
while providing basic enhancement capabilities.`;

/**
 * Build the AI reflection prompt string.
 * Inputs: priority/category/memoryMode values.
 * Outputs: formatted prompt string for OpenAI.
 * Edge cases: assumes inputs are safe string values.
 */
export const buildReflectionPrompt = (params: {
  priority: string;
  category: string;
  memoryMode: string;
}): string => {
  return AI_REFLECTION_PROMPT_TEMPLATE
    .replace('{priority}', params.priority)
    .replace('{category}', params.category)
    .replace('{memoryMode}', params.memoryMode);
};

/**
 * Build the default patch content when AI output is missing.
 * Inputs: priority/category/memoryMode/generatedAt values.
 * Outputs: formatted patch content string.
 * Edge cases: assumes inputs are safe string values.
 */
export const buildDefaultPatchContent = (params: {
  priority: string;
  category: string;
  memoryMode: string;
  generatedAt: string;
}): string => {
  return AI_REFLECTION_PATCH_TEMPLATE
    .replace('{priority}', params.priority)
    .replace('{category}', params.category)
    .replace('{memoryMode}', params.memoryMode)
    .replace('{generatedAt}', params.generatedAt);
};

/**
 * Build the fallback patch content when AI calls fail.
 * Inputs: priority/category/memoryMode/generatedAt values.
 * Outputs: formatted fallback patch string.
 * Edge cases: assumes inputs are safe string values.
 */
export const buildFallbackPatchContent = (params: {
  priority: string;
  category: string;
  memoryMode: string;
  generatedAt: string;
}): string => {
  return AI_REFLECTION_FALLBACK_PATCH_TEMPLATE
    .replace('{priority}', params.priority)
    .replace('{category}', params.category)
    .replace('{memoryMode}', params.memoryMode)
    .replace('{generatedAt}', params.generatedAt);
};

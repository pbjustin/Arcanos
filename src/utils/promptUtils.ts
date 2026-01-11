/**
 * Shared Prompt Handling Utilities
 * Common functionality for extracting and normalizing prompts from requests
 */

/**
 * Field names that can contain prompt text in various API endpoints
 */
export const PROMPT_FIELD_NAMES = [
  'prompt',
  'message', 
  'userInput',
  'content',
  'text',
  'query'
] as const;

export type PromptFieldName = typeof PROMPT_FIELD_NAMES[number];

/**
 * Extract prompt text from request body, checking all common field names
 * 
 * @param body - Request body object
 * @returns Object with the prompt text and the field name it was found in
 */
export function extractPromptFromBody(body: Record<string, any>): {
  prompt: string | null;
  sourceField: PromptFieldName | null;
} {
  for (const fieldName of PROMPT_FIELD_NAMES) {
    const value = body[fieldName];
    if (typeof value === 'string' && value.trim().length > 0) {
      return {
        prompt: value.trim(),
        sourceField: fieldName
      };
    }
  }

  return {
    prompt: null,
    sourceField: null
  };
}

/**
 * Normalize a prompt by adding context directives
 * 
 * @param basePrompt - The base prompt text
 * @param directives - Array of context directives to append
 * @returns Normalized prompt with context
 */
export function normalizePromptWithContext(
  basePrompt: string,
  directives: string[]
): string {
  if (directives.length === 0) {
    return basePrompt;
  }

  return `${basePrompt}\n\n[ARCANOS CONTEXT]\n${directives.join('\n')}`;
}

/**
 * Validate prompt length and content
 * 
 * @param prompt - Prompt text to validate
 * @param maxLength - Maximum allowed length (default: 10000)
 * @returns Validation result with error message if invalid
 */
export function validatePromptLength(
  prompt: string | null | undefined,
  maxLength: number = 10000
): { isValid: boolean; error?: string } {
  if (!prompt || typeof prompt !== 'string') {
    return { isValid: false, error: 'Prompt must be a non-empty string' };
  }

  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return { isValid: false, error: 'Prompt cannot be empty' };
  }

  if (trimmed.length > maxLength) {
    return {
      isValid: false,
      error: `Prompt exceeds maximum length of ${maxLength} characters`
    };
  }

  return { isValid: true };
}

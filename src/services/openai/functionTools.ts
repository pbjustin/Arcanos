export interface FunctionToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface FunctionToolSet {
  chatCompletionTools: Array<Record<string, unknown>>;
  responsesTools: Array<Record<string, unknown>>;
}

/**
 * Build equivalent function-tool payloads for Chat Completions and Responses APIs.
 *
 * Purpose:
 * - Keep one canonical tool definition while emitting the API-specific payload shapes each SDK surface expects.
 *
 * Inputs/outputs:
 * - Input: array of canonical function-tool definitions.
 * - Output: paired tool arrays for Chat Completions (`function: { ... }`) and Responses (`name`, `description`, `parameters`).
 *
 * Edge case behavior:
 * - Returns empty tool arrays when no definitions are provided.
 */
export function buildFunctionToolSet(definitions: FunctionToolDefinition[]): FunctionToolSet {
  return {
    chatCompletionTools: definitions.map(definition => ({
      type: 'function',
      function: {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters
      }
    })),
    responsesTools: definitions.map(definition => ({
      type: 'function',
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters
    }))
  };
}

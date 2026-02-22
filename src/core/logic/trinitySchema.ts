/**
 * Canonical JSON schema for Trinity structured reasoning responses.
 * This schema is used with decoding constraints so stage output is deterministic.
 */
export interface TrinityStructuredReasoning {
  reasoning_steps: string[];
  assumptions: string[];
  constraints: string[];
  tradeoffs: string[];
  alternatives_considered: string[];
  chosen_path_justification: string;
  final_answer: string;
}

export const TRINITY_STRUCTURED_REASONING_SCHEMA = {
  name: 'trinity_structured_reasoning',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'reasoning_steps',
      'assumptions',
      'constraints',
      'tradeoffs',
      'alternatives_considered',
      'chosen_path_justification',
      'final_answer'
    ],
    properties: {
      reasoning_steps: {
        type: 'array',
        items: { type: 'string', minLength: 1 }
      },
      assumptions: {
        type: 'array',
        items: { type: 'string', minLength: 1 }
      },
      constraints: {
        type: 'array',
        items: { type: 'string', minLength: 1 }
      },
      tradeoffs: {
        type: 'array',
        items: { type: 'string', minLength: 1 }
      },
      alternatives_considered: {
        type: 'array',
        items: { type: 'string', minLength: 1 }
      },
      chosen_path_justification: {
        type: 'string',
        minLength: 1
      },
      final_answer: {
        type: 'string',
        minLength: 1
      }
    }
  }
} as const;

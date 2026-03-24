/**
 * Canonical JSON schema for Trinity structured reasoning responses.
 * This schema is used with decoding constraints so stage output is deterministic.
 */

import type {
  TrinityConfidence,
  TrinityResponseMode,
  TrinitySourceType,
  TrinityVerificationStatus
} from './trinityHonesty.js';

export interface TrinityStructuredReasoningClaimTag {
  claim_text: string;
  source_type: TrinitySourceType;
  confidence: TrinityConfidence;
  verification_status: TrinityVerificationStatus;
}

export interface TrinityCompactStructuredReasoning {
  response_mode: TrinityResponseMode;
  achievable_subtasks: string[];
  blocked_subtasks: string[];
  user_visible_caveats: string[];
  claim_tags: TrinityStructuredReasoningClaimTag[];
  final_answer: string;
}

export interface TrinityStructuredReasoning extends TrinityCompactStructuredReasoning {
  reasoning_steps: string[];
  assumptions: string[];
  constraints: string[];
  tradeoffs: string[];
  alternatives_considered: string[];
  chosen_path_justification: string;
}

const CLAIM_TAG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claim_text', 'source_type', 'confidence', 'verification_status'],
  properties: {
    claim_text: {
      type: 'string',
      minLength: 1
    },
    source_type: {
      type: 'string',
      enum: ['tool', 'user_context', 'memory', 'inference', 'template']
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low']
    },
    verification_status: {
      type: 'string',
      enum: ['verified', 'unverified', 'inferred', 'unavailable']
    }
  }
} as const;

const COMPACT_REASONING_PROPERTIES = {
  response_mode: {
    type: 'string',
    enum: ['answer', 'partial_refusal', 'refusal']
  },
  achievable_subtasks: {
    type: 'array',
    items: { type: 'string', minLength: 1 }
  },
  blocked_subtasks: {
    type: 'array',
    items: { type: 'string', minLength: 1 }
  },
  user_visible_caveats: {
    type: 'array',
    items: { type: 'string', minLength: 1 }
  },
  claim_tags: {
    type: 'array',
    items: CLAIM_TAG_SCHEMA
  },
  final_answer: {
    type: 'string',
    minLength: 1
  }
} as const;

const COMPACT_REASONING_REQUIRED_FIELDS = [
  'response_mode',
  'achievable_subtasks',
  'blocked_subtasks',
  'user_visible_caveats',
  'claim_tags',
  'final_answer'
] as const;

export const TRINITY_COMPACT_STRUCTURED_REASONING_SCHEMA = {
  name: 'trinity_structured_reasoning_compact',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [...COMPACT_REASONING_REQUIRED_FIELDS],
    properties: {
      ...COMPACT_REASONING_PROPERTIES
    }
  }
} as const;

export const TRINITY_STRUCTURED_REASONING_SCHEMA = {
  name: 'trinity_structured_reasoning',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      ...COMPACT_REASONING_REQUIRED_FIELDS,
      'reasoning_steps',
      'assumptions',
      'constraints',
      'tradeoffs',
      'alternatives_considered',
      'chosen_path_justification'
    ],
    properties: {
      ...COMPACT_REASONING_PROPERTIES,
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
      }
    }
  }
} as const;

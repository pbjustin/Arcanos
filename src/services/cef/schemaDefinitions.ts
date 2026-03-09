/**
 * JSON schema definitions for the CEF command surface.
 */

const VALID_AUDIT_MODES = ['true', 'false', 'passive', 'log-only'] as const;

export const CommandErrorJsonSchema = {
  $id: 'CommandErrorSchema',
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message', 'httpStatusCode'],
  properties: {
    code: {
      type: 'string',
      minLength: 1
    },
    message: {
      type: 'string',
      minLength: 1
    },
    httpStatusCode: {
      type: 'integer',
      minimum: 400,
      maximum: 599
    },
    details: {
      type: 'object',
      additionalProperties: true
    }
  }
} as const;

export const AuditSafeSetModeInputJsonSchema = {
  $id: 'AuditSafeSetModeInputSchema',
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  properties: {
    mode: {
      type: 'string',
      enum: [...VALID_AUDIT_MODES]
    }
  }
} as const;

export const AuditSafeSetModeOutputJsonSchema = {
  $id: 'AuditSafeSetModeOutputSchema',
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  properties: {
    mode: {
      type: 'string',
      enum: [...VALID_AUDIT_MODES]
    }
  }
} as const;

export const AuditSafeInterpretInputJsonSchema = {
  $id: 'AuditSafeInterpretInputSchema',
  type: 'object',
  additionalProperties: false,
  required: ['instruction'],
  properties: {
    instruction: {
      type: 'string',
      minLength: 1
    }
  }
} as const;

export const AuditSafeInterpretOutputJsonSchema = {
  $id: 'AuditSafeInterpretOutputSchema',
  type: 'object',
  additionalProperties: false,
  required: ['instruction', 'mode'],
  properties: {
    instruction: {
      type: 'string',
      minLength: 1
    },
    mode: {
      type: 'string',
      enum: [...VALID_AUDIT_MODES]
    }
  }
} as const;

export const AiPromptInputJsonSchema = {
  $id: 'AiPromptInputSchema',
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: {
      type: 'string',
      minLength: 1
    }
  }
} as const;

export const AiPromptOutputJsonSchema = {
  $id: 'AiPromptOutputSchema',
  type: 'object',
  additionalProperties: false,
  required: ['result'],
  properties: {
    result: {},
    meta: {
      type: 'object',
      additionalProperties: true
    },
    fallback: {
      type: 'boolean'
    },
    usage: {},
    model: {
      type: 'string',
      minLength: 1
    },
    streaming: {
      type: 'boolean'
    }
  }
} as const;

export const CEF_SCHEMA_DEFINITIONS = [
  CommandErrorJsonSchema,
  AuditSafeSetModeInputJsonSchema,
  AuditSafeSetModeOutputJsonSchema,
  AuditSafeInterpretInputJsonSchema,
  AuditSafeInterpretOutputJsonSchema,
  AiPromptInputJsonSchema,
  AiPromptOutputJsonSchema
] as const;

export const CEF_COMMAND_SCHEMA_COVERAGE = {
  'audit-safe:set-mode': {
    inputSchemaName: 'AuditSafeSetModeInputSchema',
    outputSchemaName: 'AuditSafeSetModeOutputSchema',
    errorSchemaName: 'CommandErrorSchema'
  },
  'audit-safe:interpret': {
    inputSchemaName: 'AuditSafeInterpretInputSchema',
    outputSchemaName: 'AuditSafeInterpretOutputSchema',
    errorSchemaName: 'CommandErrorSchema'
  },
  'ai:prompt': {
    inputSchemaName: 'AiPromptInputSchema',
    outputSchemaName: 'AiPromptOutputSchema',
    errorSchemaName: 'CommandErrorSchema'
  }
} as const;

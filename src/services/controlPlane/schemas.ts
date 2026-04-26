import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';

import type {
  ControlPlaneRequestPayload,
  ControlPlaneResponse
} from './types.js';

export interface ControlPlaneSchemaIssue {
  path: string;
  message: string;
}

export type ControlPlaneSchemaResult<T> =
  | { ok: true; data: T; issues: [] }
  | { ok: false; data: null; issues: ControlPlaneSchemaIssue[] };

const routeStatusValues = [
  'TRINITY_CONFIRMED',
  'TRINITY_UNAVAILABLE',
  'TRINITY_REQUESTED_BUT_NOT_CONFIRMED',
  'DIRECT_FAST_PATH',
  'UNKNOWN_ROUTE'
] as const;

export const controlPlaneRequestSchema = {
  $id: 'ControlPlaneRequestSchema',
  type: 'object',
  additionalProperties: false,
  required: ['phase', 'adapter', 'operation'],
  properties: {
    requestId: {
      type: 'string',
      minLength: 1,
      maxLength: 160
    },
    phase: {
      type: 'string',
      enum: ['plan', 'execute', 'mutate']
    },
    adapter: {
      type: 'string',
      enum: ['railway-cli', 'arcanos-cli', 'arcanos-mcp']
    },
    operation: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      pattern: '^[A-Za-z0-9_.:-]+$'
    },
    input: {
      type: 'object',
      additionalProperties: true
    },
    context: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: {
          type: 'string',
          minLength: 1,
          maxLength: 160
        },
        cwd: {
          type: 'string',
          minLength: 1,
          maxLength: 1000
        },
        environment: {
          type: 'string',
          enum: ['workspace', 'remote']
        },
        caller: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'type'],
          properties: {
            id: {
              type: 'string',
              minLength: 1,
              maxLength: 160
            },
            type: {
              type: 'string',
              minLength: 1,
              maxLength: 80
            },
            scopes: {
              type: 'array',
              uniqueItems: true,
              items: {
                type: 'string',
                minLength: 1,
                maxLength: 120
              }
            }
          }
        }
      }
    },
    routePreference: {
      type: 'string',
      enum: ['prefer_trinity', 'direct']
    },
    approval: {
      type: 'object',
      additionalProperties: false,
      required: ['approved'],
      properties: {
        approved: {
          type: 'boolean'
        },
        approvedBy: {
          type: 'string',
          minLength: 1,
          maxLength: 160
        },
        reason: {
          type: 'string',
          minLength: 1,
          maxLength: 500
        },
        confirmationId: {
          type: 'string',
          minLength: 1,
          maxLength: 160
        }
      }
    }
  }
} as const;

export const controlPlaneResponseSchema = {
  $id: 'ControlPlaneResponseSchema',
  type: 'object',
  additionalProperties: false,
  required: [
    'ok',
    'requestId',
    'phase',
    'adapter',
    'operation',
    'route',
    'approval',
    'audit'
  ],
  properties: {
    ok: {
      type: 'boolean'
    },
    requestId: {
      type: 'string',
      minLength: 1
    },
    phase: {
      type: 'string',
      enum: ['plan', 'execute', 'mutate']
    },
    adapter: {
      type: 'string',
      enum: ['railway-cli', 'arcanos-cli', 'arcanos-mcp']
    },
    operation: {
      type: 'string',
      minLength: 1
    },
    route: {
      type: 'object',
      additionalProperties: false,
      required: [
        'requested',
        'status',
        'eligibleForTrinity',
        'reason',
        'evidence',
        'requestedAt',
        'verifiedAt'
      ],
      properties: {
        requested: {
          type: 'string',
          enum: ['trinity', 'direct']
        },
        status: {
          type: 'string',
          enum: [...routeStatusValues]
        },
        eligibleForTrinity: {
          type: 'boolean'
        },
        reason: {
          type: 'string'
        },
        evidence: {
          type: 'object',
          additionalProperties: true
        },
        requestedAt: {
          type: 'string',
          minLength: 1
        },
        verifiedAt: {
          type: 'string',
          minLength: 1
        }
      }
    },
    approval: {
      type: 'object',
      additionalProperties: false,
      required: ['required', 'satisfied', 'gate'],
      properties: {
        required: {
          type: 'boolean'
        },
        satisfied: {
          type: 'boolean'
        },
        gate: {
          type: 'string',
          enum: ['none', 'control-plane-approval']
        },
        reason: {
          type: 'string'
        }
      }
    },
    audit: {
      type: 'object',
      additionalProperties: false,
      required: ['auditId', 'logged'],
      properties: {
        auditId: {
          type: 'string',
          minLength: 1
        },
        logged: {
          type: 'boolean'
        }
      }
    },
    result: {
      type: 'object',
      additionalProperties: true
    },
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          minLength: 1
        },
        message: {
          type: 'string',
          minLength: 1
        },
        details: {
          type: 'object',
          additionalProperties: true
        }
      }
    }
  }
} as const;

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false
});

const requestValidator = ajv.compile(controlPlaneRequestSchema);
const responseValidator = ajv.compile(controlPlaneResponseSchema);

function normalizeAjvErrors(errors: ErrorObject[] | null | undefined): ControlPlaneSchemaIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath || '/',
    message: error.message ?? 'Schema validation failed.'
  }));
}

function validateWith<T>(validator: ValidateFunction, value: unknown): ControlPlaneSchemaResult<T> {
  const valid = validator(value);
  if (!valid) {
    return {
      ok: false,
      data: null,
      issues: normalizeAjvErrors(validator.errors)
    };
  }

  return {
    ok: true,
    data: value as T,
    issues: []
  };
}

export function validateControlPlaneRequestPayload(value: unknown): ControlPlaneSchemaResult<ControlPlaneRequestPayload> {
  return validateWith<ControlPlaneRequestPayload>(requestValidator, value);
}

export function validateControlPlaneResponsePayload(value: unknown): ControlPlaneSchemaResult<ControlPlaneResponse> {
  return validateWith<ControlPlaneResponse>(responseValidator, value);
}

export function assertValidControlPlaneResponse(response: ControlPlaneResponse): ControlPlaneResponse {
  const validation = validateControlPlaneResponsePayload(response);
  if (!validation.ok) {
    const renderedIssues = validation.issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid control-plane response. ${renderedIssues}`);
  }

  return response;
}

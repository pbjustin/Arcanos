import { z } from 'zod';

/** Public wire protocol version. This is intentionally distinct from the persisted schema value. */
export const ACTION_PLAN_EXECUTION_PROTOCOL_VERSION = 'action-plan-execution-v1' as const;
/** Numeric version stored with Phase 2E plans, commands, and runs. Never send this as the wire version. */
export const ACTION_PLAN_EXECUTION_PERSISTED_PROTOCOL_VERSION = 2 as const;
export const ACTION_PLAN_EXECUTION_SNAPSHOT_VERSION = 'action-execution-snapshot-v1' as const;

export const ACTION_PLAN_EXECUTION_LIMITS = Object.freeze({
  maxHttpBodyBytes: 64 * 1024,
  maxOutputBytes: 32 * 1024,
  maxErrorBytes: 4 * 1024,
  maxSnapshotBytes: 32 * 1024,
  maxJsonDepth: 8,
  maxIdCharacters: 128,
  maxRealmCharacters: 256,
  maxIdempotencyKeyCharacters: 256,
  maxErrorCodeCharacters: 64,
  maxLocationCharacters: 512,
} as const);

export const ACTION_PLAN_EXECUTION_RUN_STATES = [
  'REQUESTED',
  'CLAIMED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
  'SUPERSEDED',
] as const;

export const ACTION_PLAN_EXECUTION_OPERATIONS = [
  'request-execution',
  'claim-next',
  'claim',
  'start',
  'submit-result',
  'read-status',
  'read-result',
] as const;

export const ACTION_PLAN_EXECUTION_ROLES = [
  'requester',
  'operator',
  'executor',
  'mcp-requester',
] as const;

export const ACTION_PLAN_EXECUTION_ERROR_CODES = [
  'ACTION_PLAN_EXECUTION_AUTH_REQUIRED',
  'ACTION_PLAN_EXECUTION_FORBIDDEN',
  'ACTION_PLAN_EXECUTION_PROTOCOL_DISABLED',
  'ACTION_PLAN_RESULT_ENDPOINT_REQUIRED',
  'ACTION_PLAN_EXECUTION_REQUEST_INVALID',
  'ACTION_PLAN_EXECUTOR_UNAVAILABLE',
  'ACTION_PLAN_REALM_UNAVAILABLE',
  'ACTION_PLAN_PROVENANCE_UNAVAILABLE',
  'ACTION_PLAN_LEGACY_EXECUTION_STATE_UNRESOLVED',
  'ACTION_PLAN_LEGACY_RESULT_VIEW_UNAVAILABLE',
  'ACTION_PLAN_EXECUTION_ACTIVE',
  'ACTION_PLAN_EXECUTION_IDEMPOTENCY_CONFLICT',
  'ACTION_PLAN_EXECUTION_NOT_FOUND',
  'ACTION_PLAN_EXECUTION_CLAIM_CONFLICT',
  'ACTION_PLAN_EXECUTION_STATE_CONFLICT',
  'ACTION_PLAN_EXECUTION_GENERATION_CONFLICT',
  'ACTION_PLAN_ACTION_SNAPSHOT_UNAVAILABLE',
  'ACTION_PLAN_ACTION_SNAPSHOT_CONFLICT',
  'ACTION_PLAN_RESULT_IDEMPOTENCY_CONFLICT',
  'ACTION_PLAN_EXECUTION_PERSISTENCE_FAILED',
  'ACTION_PLAN_EXECUTION_PROTOCOL_INCOMPATIBLE',
] as const;

export type ActionPlanExecutionErrorCode = typeof ACTION_PLAN_EXECUTION_ERROR_CODES[number];

export const ACTION_PLAN_EXECUTION_PUBLIC_ERRORS: Readonly<Record<
  ActionPlanExecutionErrorCode,
  Readonly<{ status: number; message: string }>
>> = Object.freeze({
  ACTION_PLAN_EXECUTION_AUTH_REQUIRED: {
    status: 401,
    message: 'ActionPlan execution authentication is required.',
  },
  ACTION_PLAN_EXECUTION_FORBIDDEN: {
    status: 403,
    message: 'ActionPlan execution operation is not permitted.',
  },
  ACTION_PLAN_EXECUTION_PROTOCOL_DISABLED: {
    status: 503,
    message: 'ActionPlan execution protocol is unavailable.',
  },
  ACTION_PLAN_RESULT_ENDPOINT_REQUIRED: {
    status: 409,
    message: 'Use the dedicated ActionPlan execution result endpoint.',
  },
  ACTION_PLAN_EXECUTION_REQUEST_INVALID: {
    status: 400,
    message: 'ActionPlan execution request is invalid.',
  },
  ACTION_PLAN_EXECUTOR_UNAVAILABLE: {
    status: 409,
    message: 'No authorized executor is available for this ActionPlan.',
  },
  ACTION_PLAN_REALM_UNAVAILABLE: {
    status: 503,
    message: 'ActionPlan execution realm is unavailable.',
  },
  ACTION_PLAN_PROVENANCE_UNAVAILABLE: {
    status: 409,
    message: 'ActionPlan execution provenance is unavailable.',
  },
  ACTION_PLAN_LEGACY_EXECUTION_STATE_UNRESOLVED: {
    status: 409,
    message: 'Legacy ActionPlan execution evidence must be resolved first.',
  },
  ACTION_PLAN_LEGACY_RESULT_VIEW_UNAVAILABLE: {
    status: 409,
    message: 'Use the authoritative ActionPlan execution result endpoint.',
  },
  ACTION_PLAN_EXECUTION_ACTIVE: {
    status: 409,
    message: 'An ActionPlan execution attempt is already active.',
  },
  ACTION_PLAN_EXECUTION_IDEMPOTENCY_CONFLICT: {
    status: 409,
    message: 'ActionPlan execution idempotency key conflicts with an existing request.',
  },
  ACTION_PLAN_EXECUTION_NOT_FOUND: {
    status: 404,
    message: 'ActionPlan execution was not found.',
  },
  ACTION_PLAN_EXECUTION_CLAIM_CONFLICT: {
    status: 409,
    message: 'ActionPlan execution claim conflicts with its current owner.',
  },
  ACTION_PLAN_EXECUTION_STATE_CONFLICT: {
    status: 409,
    message: 'ActionPlan execution state does not permit this operation.',
  },
  ACTION_PLAN_EXECUTION_GENERATION_CONFLICT: {
    status: 409,
    message: 'ActionPlan execution evidence is stale.',
  },
  ACTION_PLAN_ACTION_SNAPSHOT_UNAVAILABLE: {
    status: 422,
    message: 'A safe ActionPlan action snapshot could not be created.',
  },
  ACTION_PLAN_ACTION_SNAPSHOT_CONFLICT: {
    status: 409,
    message: 'ActionPlan action snapshot does not match the authorized execution.',
  },
  ACTION_PLAN_RESULT_IDEMPOTENCY_CONFLICT: {
    status: 409,
    message: 'ActionPlan result conflicts with previously accepted evidence.',
  },
  ACTION_PLAN_EXECUTION_PERSISTENCE_FAILED: {
    status: 503,
    message: 'ActionPlan execution persistence is unavailable.',
  },
  ACTION_PLAN_EXECUTION_PROTOCOL_INCOMPATIBLE: {
    status: 409,
    message: 'ActionPlan execution protocol is incompatible.',
  },
});

export const actionPlanExecutionIdentifierSchema = z.string()
  .min(1)
  .max(ACTION_PLAN_EXECUTION_LIMITS.maxIdCharacters)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const actionPlanExecutionRealmSchema = z.string()
  .min(1)
  .max(ACTION_PLAN_EXECUTION_LIMITS.maxRealmCharacters)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const actionPlanExecutionIdempotencyKeySchema = z.string()
  .min(1)
  .max(ACTION_PLAN_EXECUTION_LIMITS.maxIdempotencyKeyCharacters)
  .regex(/^[\x21-\x7E]+$/u);

const locationSchema = z.string()
  .min(1)
  .max(ACTION_PLAN_EXECUTION_LIMITS.maxLocationCharacters)
  .regex(/^\/[A-Za-z0-9{}._~:/?#\[\]@!$&'()*+,;=%-]*$/u);

const isoTimestampSchema = z.string().datetime({ offset: true });
const runStateSchema = z.enum(ACTION_PLAN_EXECUTION_RUN_STATES);
const protocolVersionSchema = z.literal(ACTION_PLAN_EXECUTION_PROTOCOL_VERSION);

interface JsonInspection {
  valid: boolean;
  encodedBytes: number | null;
}

function inspectJsonValue(value: unknown, maxDepth: number): JsonInspection {
  const ancestors = new Set<object>();

  function visit(current: unknown, containerDepth: number): boolean {
    if (containerDepth > maxDepth) {
      return false;
    }
    if (
      current === null
      || typeof current === 'string'
      || typeof current === 'boolean'
    ) {
      return true;
    }
    if (typeof current === 'number') {
      return Number.isFinite(current);
    }
    if (typeof current !== 'object') {
      return false;
    }
    if (ancestors.has(current)) {
      return false;
    }

    if (Array.isArray(current)) {
      ancestors.add(current);
      const valid = current.every((entry) => visit(entry, containerDepth + 1));
      ancestors.delete(current);
      return valid;
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }

    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) {
      return false;
    }

    ancestors.add(current);
    const valid = Object.values(current as Record<string, unknown>)
      .every((entry) => visit(entry, containerDepth + 1));
    ancestors.delete(current);
    return valid;
  }

  if (!visit(value, 0)) {
    return { valid: false, encodedBytes: null };
  }

  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      return { valid: false, encodedBytes: null };
    }
    return { valid: true, encodedBytes: Buffer.byteLength(encoded, 'utf8') };
  } catch {
    return { valid: false, encodedBytes: null };
  }
}

function boundedJsonSchema(maxEncodedBytes: number, label: string) {
  return z.unknown().superRefine((value, context) => {
    const inspected = inspectJsonValue(value, ACTION_PLAN_EXECUTION_LIMITS.maxJsonDepth);
    if (!inspected.valid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must be finite, acyclic JSON with at most ${ACTION_PLAN_EXECUTION_LIMITS.maxJsonDepth} levels`,
      });
      return;
    }
    if (inspected.encodedBytes !== null && inspected.encodedBytes > maxEncodedBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} exceeds ${maxEncodedBytes} encoded bytes`,
      });
    }
  });
}

const emptyOperationBodySchema = z.object({}).strict();

export const actionPlanExecutionCommandInputSchema = emptyOperationBodySchema;
export const actionPlanExecutionClaimInputSchema = emptyOperationBodySchema;
export const actionPlanExecutionStartInputSchema = emptyOperationBodySchema;

const safeResultCodeSchema = z.string()
  .min(1)
  .max(ACTION_PLAN_EXECUTION_LIMITS.maxErrorCodeCharacters)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const resultErrorSchema = z.object({
  code: safeResultCodeSchema.optional(),
  category: safeResultCodeSchema.optional(),
}).strict().superRefine((value, context) => {
  const inspected = inspectJsonValue(value, ACTION_PLAN_EXECUTION_LIMITS.maxJsonDepth);
  if (inspected.encodedBytes !== null
    && inspected.encodedBytes > ACTION_PLAN_EXECUTION_LIMITS.maxErrorBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `result error exceeds ${ACTION_PLAN_EXECUTION_LIMITS.maxErrorBytes} encoded bytes`,
    });
  }
});

export const actionPlanExecutionResultInputSchema = z.object({
  action_id: actionPlanExecutionIdentifierSchema,
  snapshot_id: actionPlanExecutionIdentifierSchema,
  outcome: z.enum(['succeeded', 'failed']),
  output: boundedJsonSchema(ACTION_PLAN_EXECUTION_LIMITS.maxOutputBytes, 'result output').optional(),
  error: resultErrorSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.outcome === 'succeeded' && value.error !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'successful result must omit error evidence',
      path: ['error'],
    });
  }
  if (value.outcome === 'failed' && value.output !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'failed result must omit success output',
      path: ['output'],
    });
  }
  const inspected = inspectJsonValue(value, ACTION_PLAN_EXECUTION_LIMITS.maxJsonDepth);
  if (!inspected.valid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'result body must contain only finite, acyclic JSON',
    });
    return;
  }
  if (inspected.encodedBytes !== null
    && inspected.encodedBytes > ACTION_PLAN_EXECUTION_LIMITS.maxHttpBodyBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `result body exceeds ${ACTION_PLAN_EXECUTION_LIMITS.maxHttpBodyBytes} encoded bytes`,
    });
  }
});

const rollbackAssignmentSchema = z.object({
  agent_id: actionPlanExecutionIdentifierSchema,
  capability: z.string().min(1).max(128),
  params: boundedJsonSchema(ACTION_PLAN_EXECUTION_LIMITS.maxSnapshotBytes, 'rollback params'),
  timeout_ms: z.number().int().positive().max(24 * 60 * 60 * 1000),
}).strict();

export const actionPlanExecutionAssignmentSchema = z.object({
  agent_id: actionPlanExecutionIdentifierSchema,
  capability: z.string().min(1).max(128),
  params: boundedJsonSchema(ACTION_PLAN_EXECUTION_LIMITS.maxSnapshotBytes, 'action params'),
  timeout_ms: z.number().int().positive().max(24 * 60 * 60 * 1000),
  rollback_action: rollbackAssignmentSchema.optional(),
}).strict().superRefine((value, context) => {
  const inspected = inspectJsonValue(value, ACTION_PLAN_EXECUTION_LIMITS.maxJsonDepth);
  if (!inspected.valid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'assignment must contain only finite, acyclic JSON',
    });
    return;
  }
  if (inspected.encodedBytes !== null
    && inspected.encodedBytes > ACTION_PLAN_EXECUTION_LIMITS.maxSnapshotBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `assignment exceeds ${ACTION_PLAN_EXECUTION_LIMITS.maxSnapshotBytes} encoded bytes`,
    });
  }
});

const responseBaseSchema = z.object({
  ok: z.literal(true),
  code: z.string().min(1).max(64),
  protocol_version: protocolVersionSchema,
}).strict();

const runLocationSchema = z.object({
  run_id: actionPlanExecutionIdentifierSchema,
  action_id: actionPlanExecutionIdentifierSchema,
  state: runStateSchema,
  status_location: locationSchema,
  result_location: locationSchema,
}).strict();

export const actionPlanExecutionCommandResponseSchema = responseBaseSchema.extend({
  code: z.literal('ACTION_PLAN_EXECUTION_COMMAND_ACCEPTED'),
  command_id: actionPlanExecutionIdentifierSchema,
  plan_id: actionPlanExecutionIdentifierSchema,
  disposition: z.enum(['COMMAND_CREATED', 'COMMAND_REPLAY']),
  runs: z.array(runLocationSchema).min(1).max(100),
}).strict();

const claimLifecycleSchema = z.object({
  status: z.enum([
    'planned',
    'awaiting_confirmation',
    'approved',
    'in_progress',
    'completed',
    'failed',
    'expired',
    'blocked',
  ]),
  expires_at: isoTimestampSchema.nullable(),
}).strict();

const claimPolicySchema = z.object({
  category: z.enum(['ALLOW', 'CONFIRM']),
  evidence_id: actionPlanExecutionIdentifierSchema,
  evaluated_at: isoTimestampSchema,
}).strict();

export const actionPlanExecutionClaimResponseSchema = responseBaseSchema.extend({
  code: z.literal('ACTION_PLAN_EXECUTION_CLAIMED'),
  execution_realm: actionPlanExecutionRealmSchema,
  command_id: actionPlanExecutionIdentifierSchema,
  plan_id: actionPlanExecutionIdentifierSchema,
  run_id: actionPlanExecutionIdentifierSchema,
  action_id: actionPlanExecutionIdentifierSchema,
  snapshot_id: actionPlanExecutionIdentifierSchema,
  snapshot_version: z.literal(ACTION_PLAN_EXECUTION_SNAPSHOT_VERSION),
  state: runStateSchema,
  disposition: z.enum([
    'CLAIMED',
    'CLAIM_REPLAY_NOT_STARTED',
    'CLAIM_RECOVERY_RUNNING',
    'CLAIM_RECOVERY_TERMINAL',
  ]),
  assignment: actionPlanExecutionAssignmentSchema.optional(),
  plan_execution_generation: z.number().int().positive(),
  lifecycle: claimLifecycleSchema,
  policy: claimPolicySchema,
  status_location: locationSchema,
  result_location: locationSchema,
}).strict().superRefine((value, context) => {
  const executable = value.disposition === 'CLAIMED'
    || value.disposition === 'CLAIM_REPLAY_NOT_STARTED';
  if (executable && value.state !== 'CLAIMED') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'executable claim must be CLAIMED' });
  }
  if (executable && value.assignment === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'executable claim requires assignment' });
  }
  if (!executable && value.assignment !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'recovery claim must omit assignment' });
  }
});

export const actionPlanExecutionStartResponseSchema = responseBaseSchema.extend({
  code: z.literal('ACTION_PLAN_EXECUTION_STARTED'),
  execution_realm: actionPlanExecutionRealmSchema,
  plan_id: actionPlanExecutionIdentifierSchema,
  run_id: actionPlanExecutionIdentifierSchema,
  action_id: actionPlanExecutionIdentifierSchema,
  state: z.literal('RUNNING'),
  disposition: z.enum(['STARTED', 'START_REPLAY']),
  status_location: locationSchema,
}).strict();

const terminalCategorySchema = z.enum([
  'succeeded',
  'failed',
  'cancelled',
  'expired',
  'superseded',
]);

export const actionPlanExecutionResultResponseSchema = responseBaseSchema.extend({
  code: z.literal('ACTION_PLAN_EXECUTION_RESULT_ACCEPTED'),
  execution_realm: actionPlanExecutionRealmSchema,
  plan_id: actionPlanExecutionIdentifierSchema,
  run_id: actionPlanExecutionIdentifierSchema,
  action_id: actionPlanExecutionIdentifierSchema,
  snapshot_id: actionPlanExecutionIdentifierSchema,
  state: z.enum(['SUCCEEDED', 'FAILED']),
  terminal_category: z.enum(['succeeded', 'failed']),
  disposition: z.enum(['RESULT_ACCEPTED', 'RESULT_REPLAY', 'RESULT_ALREADY_ACCEPTED']),
  acceptance_receipt: actionPlanExecutionIdentifierSchema,
  status_location: locationSchema,
  result_location: locationSchema,
}).strict();

const statusTimestampsSchema = z.object({
  requested_at: isoTimestampSchema,
  claimed_at: isoTimestampSchema.nullable(),
  started_at: isoTimestampSchema.nullable(),
  completed_at: isoTimestampSchema.nullable(),
  cancelled_at: isoTimestampSchema.nullable(),
  expired_at: isoTimestampSchema.nullable(),
  superseded_at: isoTimestampSchema.nullable(),
}).strict();

export const actionPlanExecutionStatusResponseSchema = responseBaseSchema.extend({
  code: z.literal('ACTION_PLAN_EXECUTION_STATUS'),
  execution_realm: actionPlanExecutionRealmSchema,
  command_id: actionPlanExecutionIdentifierSchema,
  plan_id: actionPlanExecutionIdentifierSchema,
  run_id: actionPlanExecutionIdentifierSchema,
  action_id: actionPlanExecutionIdentifierSchema,
  snapshot_id: actionPlanExecutionIdentifierSchema,
  state: runStateSchema,
  terminal_category: terminalCategorySchema.nullable(),
  disposition: z.literal('STATUS_CURRENT'),
  timestamps: statusTimestampsSchema,
  acceptance_receipt: actionPlanExecutionIdentifierSchema.nullable(),
  result_location: locationSchema.nullable(),
}).strict();

export const actionPlanExecutionResultReadResponseSchema = responseBaseSchema.extend({
  code: z.literal('ACTION_PLAN_EXECUTION_RESULT'),
  execution_realm: actionPlanExecutionRealmSchema,
  plan_id: actionPlanExecutionIdentifierSchema,
  run_id: actionPlanExecutionIdentifierSchema,
  action_id: actionPlanExecutionIdentifierSchema,
  snapshot_id: actionPlanExecutionIdentifierSchema,
  state: z.enum(['SUCCEEDED', 'FAILED']),
  terminal_category: z.enum(['succeeded', 'failed']),
  outcome: z.enum(['succeeded', 'failed']),
  output: boundedJsonSchema(ACTION_PLAN_EXECUTION_LIMITS.maxOutputBytes, 'stored result output').optional(),
  error: resultErrorSchema.optional(),
  acceptance_receipt: actionPlanExecutionIdentifierSchema,
}).strict();

export const actionPlanExecutionCapabilityResponseSchema = responseBaseSchema.extend({
  code: z.literal('ACTION_PLAN_EXECUTION_PROTOCOL_AVAILABLE'),
  execution_realm: actionPlanExecutionRealmSchema,
  role: z.enum(ACTION_PLAN_EXECUTION_ROLES),
  executor_principal_id: actionPlanExecutionIdentifierSchema.optional(),
  executor_instance_id: actionPlanExecutionIdentifierSchema.optional(),
  assigned_agent_id: actionPlanExecutionIdentifierSchema.optional(),
  operations: z.array(z.enum(ACTION_PLAN_EXECUTION_OPERATIONS)).min(1)
    .max(ACTION_PLAN_EXECUTION_OPERATIONS.length)
    .refine((operations) => new Set(operations).size === operations.length, {
      message: 'capability operations must be unique',
    }),
  schema_versions: z.object({
    command: z.literal('action-plan-execution-command-v1'),
    claim: z.literal('action-plan-execution-claim-v1'),
    start: z.literal('action-plan-execution-start-v1'),
    result: z.literal('action-plan-execution-result-v1'),
    status: z.literal('action-plan-execution-status-v1'),
    result_read: z.literal('action-plan-execution-result-read-v1'),
  }).strict(),
  locations: z.object({
    execute_template: locationSchema.optional(),
    claim_next: locationSchema.optional(),
    claim_template: locationSchema.optional(),
    start_template: locationSchema.optional(),
    status_template: locationSchema,
    result_template: locationSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  const executorFields = [
    value.executor_principal_id,
    value.executor_instance_id,
    value.assigned_agent_id,
  ];
  if (value.role === 'executor' && executorFields.some((field) => field === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'executor capability requires the configured executor identity pins',
    });
  }
  if (value.role !== 'executor' && executorFields.some((field) => field !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'non-executor capability must not disclose executor identity pins',
    });
  }
});

export const actionPlanExecutionErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.enum(ACTION_PLAN_EXECUTION_ERROR_CODES),
    message: z.string().min(1).max(160),
  }).strict(),
  request_id: actionPlanExecutionIdentifierSchema.optional(),
  trace_id: actionPlanExecutionIdentifierSchema.optional(),
}).strict().superRefine((value, context) => {
  const expected = ACTION_PLAN_EXECUTION_PUBLIC_ERRORS[value.error.code].message;
  if (value.error.message !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'public error message must match its fixed category',
      path: ['error', 'message'],
    });
  }
});

export type ActionPlanExecutionCommandInput = z.infer<typeof actionPlanExecutionCommandInputSchema>;
export type ActionPlanExecutionResultInput = z.infer<typeof actionPlanExecutionResultInputSchema>;
export type ActionPlanExecutionClaimResponse = z.infer<typeof actionPlanExecutionClaimResponseSchema>;
export type ActionPlanExecutionStatusResponse = z.infer<typeof actionPlanExecutionStatusResponseSchema>;

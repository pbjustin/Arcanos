import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';
import { z } from 'zod';

import {
  ACTION_PLAN_EXECUTION_LIMITS,
  ACTION_PLAN_EXECUTION_PERSISTED_PROTOCOL_VERSION,
  ACTION_PLAN_EXECUTION_PROTOCOL_VERSION,
  ACTION_PLAN_EXECUTION_PUBLIC_ERRORS,
  actionPlanExecutionIdentifierSchema,
  actionPlanExecutionCapabilityResponseSchema,
  actionPlanExecutionClaimInputSchema,
  actionPlanExecutionClaimResponseSchema,
  actionPlanExecutionCommandInputSchema,
  actionPlanExecutionCommandResponseSchema,
  actionPlanExecutionErrorResponseSchema,
  actionPlanExecutionIdempotencyKeySchema,
  actionPlanExecutionResultInputSchema,
  actionPlanExecutionResultReadResponseSchema,
  actionPlanExecutionResultResponseSchema,
  actionPlanExecutionStartInputSchema,
  actionPlanExecutionStartResponseSchema,
  actionPlanExecutionStatusResponseSchema,
} from '../src/shared/types/actionPlanExecution.js';
import {
  ACTION_PLAN_AUTH_ERROR,
  ACTION_PLAN_FORBIDDEN_ERROR,
} from '../src/services/actionPlanExecution/auth.js';
import { ACTION_PLAN_EXECUTION_ERRORS } from '../src/services/actionPlanExecution/errors.js';

interface NamedValue {
  name: string;
  value: unknown;
}

interface InvalidFixture extends NamedValue {
  schema: 'command' | 'claim' | 'start' | 'result';
  expected_code: string;
}

interface ProtocolFixture {
  protocolVersion: string;
  persistedProtocolVersion: number;
  snapshotVersion: string;
  limits: Record<string, number>;
  schemaVersions: Record<string, string>;
  jsonDepthCases: Array<NamedValue & { valid: boolean }>;
  identifierCases: Array<NamedValue & { valid: boolean }>;
  valid: {
    commandBodies: NamedValue[];
    claimBodies: NamedValue[];
    startBodies: NamedValue[];
    resultRequests: NamedValue[];
    commandResponses: NamedValue[];
    claimResponses: NamedValue[];
    startResponses: NamedValue[];
    resultResponses: NamedValue[];
    statusResponses: NamedValue[];
    resultReadResponses: NamedValue[];
    capabilityResponses: NamedValue[];
  };
  invalid: InvalidFixture[];
  idempotencyDecisions: Array<Record<string, unknown>>;
  authorizationDecisions: Array<Record<string, unknown>>;
  zeroEffectContract: {
    rejected_request_expected_effects: Record<string, number>;
  };
}

const fixturePath = join(
  process.cwd(),
  'tests',
  'fixtures',
  'action-plan-execution-protocol-v1.json'
);
const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8')) as ProtocolFixture;

const inputSchemas = {
  command: actionPlanExecutionCommandInputSchema,
  claim: actionPlanExecutionClaimInputSchema,
  start: actionPlanExecutionStartInputSchema,
  result: actionPlanExecutionResultInputSchema,
} satisfies Record<InvalidFixture['schema'], z.ZodTypeAny>;

describe('Phase 2E ActionPlan execution protocol contract', () => {
  it('keeps the public wire version distinct from persisted protocol version 2', () => {
    expect(fixtures.protocolVersion).toBe(ACTION_PLAN_EXECUTION_PROTOCOL_VERSION);
    expect(fixtures.persistedProtocolVersion).toBe(ACTION_PLAN_EXECUTION_PERSISTED_PROTOCOL_VERSION);
    expect(typeof ACTION_PLAN_EXECUTION_PROTOCOL_VERSION).toBe('string');
    expect(typeof ACTION_PLAN_EXECUTION_PERSISTED_PROTOCOL_VERSION).toBe('number');
  });

  it('keeps fixture limits synchronized with production validators', () => {
    expect(fixtures.limits).toEqual(expect.objectContaining(ACTION_PLAN_EXECUTION_LIMITS));
  });

  it('keeps the shared JSON depth boundary identical to the TypeScript result validator', () => {
    for (const fixture of fixtures.jsonDepthCases) {
      const result = actionPlanExecutionResultInputSchema.safeParse({
        action_id: 'action-depth',
        snapshot_id: 'snapshot-depth',
        outcome: 'succeeded',
        output: fixture.value,
      });
      expect(result.success).toBe(fixture.valid);
    }
  });

  it('keeps shared identifiers compatible with the TypeScript protocol grammar', () => {
    for (const fixture of fixtures.identifierCases) {
      expect(actionPlanExecutionIdentifierSchema.safeParse(fixture.value).success).toBe(fixture.valid);
    }
  });

  it.each([
    ['command', fixtures.valid.commandBodies, actionPlanExecutionCommandInputSchema],
    ['claim', fixtures.valid.claimBodies, actionPlanExecutionClaimInputSchema],
    ['start', fixtures.valid.startBodies, actionPlanExecutionStartInputSchema],
    ['result', fixtures.valid.resultRequests, actionPlanExecutionResultInputSchema],
  ] as const)('accepts shared valid %s requests', (_name, cases, schema) => {
    for (const fixture of cases) {
      expect(schema.safeParse(fixture.value)).toEqual(
        expect.objectContaining({ success: true })
      );
    }
  });

  it('rejects every shared invalid request without normalizing unknown fields away', () => {
    for (const fixture of fixtures.invalid) {
      const result = inputSchemas[fixture.schema].safeParse(fixture.value);
      expect(result.success).toBe(false);
      expect(fixture.expected_code).toMatch(/^ACTION_PLAN_/u);
    }
  });

  it.each([
    ['command', fixtures.valid.commandResponses, actionPlanExecutionCommandResponseSchema],
    ['claim', fixtures.valid.claimResponses, actionPlanExecutionClaimResponseSchema],
    ['start', fixtures.valid.startResponses, actionPlanExecutionStartResponseSchema],
    ['result', fixtures.valid.resultResponses, actionPlanExecutionResultResponseSchema],
    ['status', fixtures.valid.statusResponses, actionPlanExecutionStatusResponseSchema],
    ['result read', fixtures.valid.resultReadResponses, actionPlanExecutionResultReadResponseSchema],
    ['capability', fixtures.valid.capabilityResponses, actionPlanExecutionCapabilityResponseSchema],
  ] as const)('accepts shared valid %s responses', (_name, cases, schema) => {
    for (const fixture of cases) {
      expect(schema.safeParse(fixture.value)).toEqual(
        expect.objectContaining({ success: true })
      );
    }
  });

  it('enforces finite acyclic JSON, depth eight, and encoded output bounds', () => {
    const base = {
      action_id: 'action-001',
      snapshot_id: 'snapshot-001',
      outcome: 'succeeded' as const,
    };

    expect(actionPlanExecutionResultInputSchema.safeParse({
      ...base,
      output: 'x'.repeat(ACTION_PLAN_EXECUTION_LIMITS.maxOutputBytes - 2),
    }).success).toBe(true);
    expect(actionPlanExecutionResultInputSchema.safeParse({
      ...base,
      output: 'x'.repeat(ACTION_PLAN_EXECUTION_LIMITS.maxOutputBytes - 1),
    }).success).toBe(false);

    const allowedDepth = { level: 1 } as Record<string, unknown>;
    let allowedCursor = allowedDepth;
    for (let depth = 2; depth < ACTION_PLAN_EXECUTION_LIMITS.maxJsonDepth; depth += 1) {
      const next = { level: depth } as Record<string, unknown>;
      allowedCursor.next = next;
      allowedCursor = next;
    }
    expect(actionPlanExecutionResultInputSchema.safeParse({ ...base, output: allowedDepth }).success)
      .toBe(true);
    allowedCursor.next = { level: ACTION_PLAN_EXECUTION_LIMITS.maxJsonDepth + 1 };
    expect(actionPlanExecutionResultInputSchema.safeParse({ ...base, output: allowedDepth }).success)
      .toBe(false);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const accessorValue = {};
    Object.defineProperty(accessorValue, 'value', { get: () => 'not-json-data' });
    for (const output of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      circular,
      Buffer.from('binary'),
      new Date('2026-07-17T12:00:00.000Z'),
      BigInt(1),
      Symbol('not-json'),
      () => 'not-json',
      { value: undefined },
      accessorValue,
    ]) {
      expect(actionPlanExecutionResultInputSchema.safeParse({ ...base, output }).success).toBe(false);
    }
  });

  it('never accepts raw error messages or caller-selected authorization context', () => {
    const forbiddenTopLevelFields = [
      'owner',
      'executor_id',
      'executor_kind',
      'execution_realm',
      'plan_status',
      'clear_decision',
      'command',
    ];
    for (const field of forbiddenTopLevelFields) {
      expect(actionPlanExecutionResultInputSchema.safeParse({
        action_id: 'action-001',
        snapshot_id: 'snapshot-001',
        outcome: 'failed',
        [field]: 'caller-controlled',
      }).success).toBe(false);
    }
    expect(actionPlanExecutionResultInputSchema.safeParse({
      action_id: 'action-001',
      snapshot_id: 'snapshot-001',
      outcome: 'failed',
      error: { code: 'DEPENDENCY_FAILED', message: 'raw internal detail' },
    }).success).toBe(false);
    for (const code of ['line\nbreak', '安全でない自由形式']) {
      expect(actionPlanExecutionResultInputSchema.safeParse({
        action_id: 'action-001',
        snapshot_id: 'snapshot-001',
        outcome: 'failed',
        error: { code },
      }).success).toBe(false);
    }
  });

  it('requires visible bounded idempotency keys', () => {
    expect(actionPlanExecutionIdempotencyKeySchema.safeParse('retry-key-001').success).toBe(true);
    for (const invalid of [
      '',
      ' leading-space',
      'trailing-space ',
      'line\nbreak',
      'x'.repeat(ACTION_PLAN_EXECUTION_LIMITS.maxIdempotencyKeyCharacters + 1),
    ]) {
      expect(actionPlanExecutionIdempotencyKeySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('requires executor identity pins and does not disclose them to other roles', () => {
    const executor = fixtures.valid.capabilityResponses[0]?.value as Record<string, unknown>;
    expect(actionPlanExecutionCapabilityResponseSchema.safeParse(executor).success).toBe(true);
    const missingInstance = { ...executor };
    delete missingInstance.executor_instance_id;
    expect(actionPlanExecutionCapabilityResponseSchema.safeParse(missingInstance).success).toBe(false);

    const requester = {
      ...executor,
      role: 'requester',
      operations: ['request-execution', 'read-status', 'read-result'],
    } as Record<string, unknown>;
    delete requester.executor_principal_id;
    delete requester.executor_instance_id;
    delete requester.assigned_agent_id;
    expect(actionPlanExecutionCapabilityResponseSchema.safeParse(requester).success).toBe(true);
    expect(actionPlanExecutionCapabilityResponseSchema.safeParse({
      ...requester,
      executor_instance_id: 'must-not-be-disclosed',
    }).success).toBe(false);
  });

  it('allows assignment data only on executable CLAIMED responses', () => {
    const executable = fixtures.valid.claimResponses[0]?.value as Record<string, unknown>;
    const recovery = fixtures.valid.claimResponses[1]?.value as Record<string, unknown>;
    expect(actionPlanExecutionClaimResponseSchema.safeParse(executable).success).toBe(true);
    expect(actionPlanExecutionClaimResponseSchema.safeParse(recovery).success).toBe(true);
    expect(actionPlanExecutionClaimResponseSchema.safeParse({
      ...recovery,
      assignment: executable.assignment,
    }).success).toBe(false);
    const missingAssignment = { ...executable };
    delete missingAssignment.assignment;
    expect(actionPlanExecutionClaimResponseSchema.safeParse(missingAssignment).success).toBe(false);
  });

  it('keeps ordinary status responses free of executable assignment and result payloads', () => {
    const status = fixtures.valid.statusResponses[0]?.value as Record<string, unknown>;
    expect(actionPlanExecutionStatusResponseSchema.safeParse(status).success).toBe(true);
    for (const forbidden of ['assignment', 'params', 'output', 'error', 'command', 'fingerprint']) {
      expect(status).not.toHaveProperty(forbidden);
      expect(actionPlanExecutionStatusResponseSchema.safeParse({
        ...status,
        [forbidden]: 'must-not-appear',
      }).success).toBe(false);
    }
  });

  it('binds every public error category to one fixed message and status', () => {
    for (const [code, contract] of Object.entries(ACTION_PLAN_EXECUTION_PUBLIC_ERRORS)) {
      const response = {
        ok: false,
        error: { code, message: contract.message },
        request_id: 'request-001',
      };
      expect(actionPlanExecutionErrorResponseSchema.safeParse(response).success).toBe(true);
      expect(actionPlanExecutionErrorResponseSchema.safeParse({
        ...response,
        error: { code, message: 'raw dependency detail' },
      }).success).toBe(false);
      expect(contract.status).toBeGreaterThanOrEqual(400);
      expect(contract.status).toBeLessThan(600);
    }
  });

  it('keeps route/domain error definitions synchronized with the public disclosure contract', () => {
    const domainErrors = Object.values(ACTION_PLAN_EXECUTION_ERRORS).map((definition) => ({
      status: definition[0],
      code: definition[1],
      message: definition[2],
    }));
    const authErrors = [
      { status: 401, ...ACTION_PLAN_AUTH_ERROR },
      { status: 403, ...ACTION_PLAN_FORBIDDEN_ERROR },
    ];
    const implementationErrors = [...domainErrors, ...authErrors];

    expect(implementationErrors).toHaveLength(Object.keys(ACTION_PLAN_EXECUTION_PUBLIC_ERRORS).length);
    for (const error of implementationErrors) {
      expect(ACTION_PLAN_EXECUTION_PUBLIC_ERRORS[error.code]).toEqual({
        status: error.status,
        message: error.message,
      });
    }
  });

  it('records auth, realm, idempotency, and zero-effect decisions without payload evidence', () => {
    expect(fixtures.idempotencyDecisions).toHaveLength(4);
    expect(fixtures.authorizationDecisions).toHaveLength(4);
    for (const decision of fixtures.idempotencyDecisions) {
      expect(decision.expected_code).toMatch(/^ACTION_PLAN_/u);
    }
    for (const decision of fixtures.authorizationDecisions) {
      expect(decision.expected_code).toMatch(/^ACTION_PLAN_/u);
    }
    expect(fixtures.zeroEffectContract.rejected_request_expected_effects).toEqual({
      execution_callback: 0,
      local_command: 0,
      worker_job: 0,
      new_run: 0,
      sibling_result: 0,
      plan_success: 0,
      provider_call: 0,
      success_acknowledgement: 0,
    });
  });
});

describe('Phase 2E canonical JSON schemas', () => {
  const schemaDirectory = join(
    process.cwd(),
    'packages',
    'protocol',
    'schemas',
    'v1',
    'action-plan'
  );
  const jsonSchemas = Object.fromEntries([
    'execution-command',
    'execution-claim',
    'execution-start',
    'execution-result',
    'execution-result-read',
    'execution-status',
    'execution-capability',
  ].map((name) => [name, JSON.parse(readFileSync(
    join(schemaDirectory, `${name}.schema.json`),
    'utf8'
  ))]));

  it('compiles every schema deterministically under JSON Schema 2020-12', () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    for (const schema of Object.values(jsonSchemas)) {
      expect(() => ajv.compile(schema)).not.toThrow();
    }
  });

  it('keeps JSON request schemas strict and aligned with the shared fixtures', () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validators = {
      command: ajv.compile(jsonSchemas['execution-command']),
      claim: ajv.compile(jsonSchemas['execution-claim']),
      start: ajv.compile(jsonSchemas['execution-start']),
      result: ajv.compile(jsonSchemas['execution-result']),
    };

    for (const fixture of fixtures.valid.commandBodies) {
      expect(validators.command(fixture.value)).toBe(true);
    }
    for (const fixture of fixtures.valid.claimBodies) {
      expect(validators.claim(fixture.value)).toBe(true);
    }
    for (const fixture of fixtures.valid.startBodies) {
      expect(validators.start(fixture.value)).toBe(true);
    }
    for (const fixture of fixtures.valid.resultRequests) {
      expect(validators.result(fixture.value)).toBe(true);
    }
    for (const fixture of fixtures.invalid) {
      expect(validators[fixture.schema](fixture.value)).toBe(false);
    }
  });

  it('validates canonical status, result-read, and capability responses', () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const cases = [
      [jsonSchemas['execution-status'], fixtures.valid.statusResponses],
      [jsonSchemas['execution-result-read'], fixtures.valid.resultReadResponses],
      [jsonSchemas['execution-capability'], fixtures.valid.capabilityResponses],
    ] as const;

    for (const [schema, values] of cases) {
      const validate = ajv.compile(schema);
      for (const fixture of values) {
        expect(validate(fixture.value)).toBe(true);
      }
    }
  });

  it('publishes explicit byte, depth, and finite-number annotations for runtime enforcement', () => {
    const resultSchema = jsonSchemas['execution-result'] as {
      'x-arcanos-max-http-body-bytes': number;
      'x-arcanos-finite-numbers-only': boolean;
      properties: Record<string, Record<string, unknown>>;
    };
    expect(resultSchema['x-arcanos-max-http-body-bytes'])
      .toBe(ACTION_PLAN_EXECUTION_LIMITS.maxHttpBodyBytes);
    expect(resultSchema['x-arcanos-finite-numbers-only']).toBe(true);
    expect(resultSchema.properties.output['x-arcanos-max-encoded-bytes'])
      .toBe(ACTION_PLAN_EXECUTION_LIMITS.maxOutputBytes);
    expect(resultSchema.properties.output['x-arcanos-max-depth'])
      .toBe(ACTION_PLAN_EXECUTION_LIMITS.maxJsonDepth);
    expect(resultSchema.properties.error['x-arcanos-max-encoded-bytes'])
      .toBe(ACTION_PLAN_EXECUTION_LIMITS.maxErrorBytes);
  });
});

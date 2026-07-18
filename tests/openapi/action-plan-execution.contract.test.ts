import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  ACTION_PLAN_EXECUTION_ERROR_CODES,
  ACTION_PLAN_EXECUTION_LIMITS,
  ACTION_PLAN_EXECUTION_PROTOCOL_VERSION,
} from '../../src/shared/types/actionPlanExecution.js';

interface OpenApiOperation {
  operationId?: string;
  description?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{ $ref?: string }>;
  requestBody?: {
    required?: boolean;
    'x-arcanos-max-http-body-bytes'?: number;
    content?: Record<string, { schema?: { $ref?: string } }>;
  };
  responses?: Record<string, {
    $ref?: string;
    headers?: Record<string, { $ref?: string }>;
  }>;
}

interface OpenApiContract {
  openapi: string;
  info: { version: string; description: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    securitySchemes: Record<string, Record<string, unknown>>;
    parameters: Record<string, Record<string, unknown>>;
    schemas: Record<string, Record<string, unknown>>;
  };
}

interface NamedValue {
  name: string;
  value: unknown;
}

interface Fixtures {
  valid: {
    commandBodies: NamedValue[];
    resultRequests: NamedValue[];
    commandResponses: NamedValue[];
    claimResponses: NamedValue[];
    startResponses: NamedValue[];
    resultResponses: NamedValue[];
    statusResponses: NamedValue[];
    resultReadResponses: NamedValue[];
    capabilityResponses: NamedValue[];
  };
  invalid: Array<NamedValue & { schema: 'command' | 'claim' | 'start' | 'result' }>;
}

interface NormalizedOpenApiAudit {
  baseline: {
    commit: string;
    dedicated_action_plan_execution_openapi_document_present: boolean;
    observation: string;
  };
  before: {
    document: null;
    paths: unknown[];
    operation_ids: string[];
    security_schemes: string[];
  };
  after: {
    document: string;
    openapi: string;
    paths: Array<{
      path: string;
      methods: Array<{
        method: string;
        operation_id: string;
        security: string[];
      }>;
    }>;
    operation_ids: string[];
    security_schemes: string[];
  };
}

const contract = JSON.parse(readFileSync(
  join(process.cwd(), 'contracts', 'action_plan_execution.openapi.v1.json'),
  'utf8'
)) as OpenApiContract;
const fixtures = JSON.parse(readFileSync(
  join(process.cwd(), 'tests', 'fixtures', 'action-plan-execution-protocol-v1.json'),
  'utf8'
)) as Fixtures;
const normalizedAudit = JSON.parse(readFileSync(
  join(
    process.cwd(),
    'docs',
    'audits',
    'action-plan-execution',
    '2026-07-17',
    'openapi-normalized-diff.json'
  ),
  'utf8'
)) as NormalizedOpenApiAudit;

function collectLocalRefs(value: unknown, refs: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectLocalRefs(entry, refs);
    }
    return refs;
  }
  if (!value || typeof value !== 'object') {
    return refs;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && typeof entry === 'string') {
      refs.push(entry);
      continue;
    }
    collectLocalRefs(entry, refs);
  }
  return refs;
}

function resolveLocalRef(document: unknown, ref: string): unknown {
  return ref.slice(2).split('/').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    const key = segment.replace(/~1/gu, '/').replace(/~0/gu, '~');
    return (current as Record<string, unknown>)[key];
  }, document);
}

function operations(): Array<{ path: string; method: string; operation: OpenApiOperation }> {
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
  return Object.entries(contract.paths).flatMap(([path, pathItem]) =>
    Object.entries(pathItem)
      .filter(([method]) => methods.has(method))
      .map(([method, operation]) => ({ path, method, operation }))
  );
}

function compileComponent(schemaName: string) {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  return ajv.compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    ...contract.components.schemas[schemaName],
    components: {
      schemas: contract.components.schemas,
    },
  });
}

function normalizeOpenApiSurface(): NormalizedOpenApiAudit['after'] {
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
  const normalizedPaths = Object.keys(contract.paths).sort().map((path) => ({
    path,
    methods: Object.entries(contract.paths[path])
      .filter(([method]) => methods.has(method))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([method, operation]) => ({
        method,
        operation_id: operation.operationId ?? '',
        security: Array.from(new Set(
          (operation.security ?? []).flatMap((requirement) => Object.keys(requirement))
        )).sort(),
      })),
  }));
  return {
    document: 'contracts/action_plan_execution.openapi.v1.json',
    openapi: contract.openapi,
    paths: normalizedPaths,
    operation_ids: normalizedPaths
      .flatMap(({ methods: pathMethods }) => pathMethods.map(({ operation_id: id }) => id))
      .sort(),
    security_schemes: Object.keys(contract.components.securitySchemes).sort(),
  };
}

describe('ActionPlan execution OpenAPI contract', () => {
  it('matches the deterministic normalized before/after audit artifact', () => {
    expect(normalizedAudit.baseline).toEqual(expect.objectContaining({
      commit: '5e8ef46f48adea6eca82b4fd919821c939cca6c6',
      dedicated_action_plan_execution_openapi_document_present: false,
    }));
    expect(normalizedAudit.baseline.observation)
      .toBe('The approved Phase 2E baseline had no dedicated ActionPlan execution OpenAPI document.');
    expect(normalizedAudit.before).toEqual({
      document: null,
      paths: [],
      operation_ids: [],
      security_schemes: [],
    });
    expect(normalizedAudit.after).toEqual(normalizeOpenApiSurface());
  });

  it('is a self-contained OpenAPI 3.1 contract with resolvable local references', () => {
    expect(contract.openapi).toBe('3.1.0');
    expect(contract.info.version).toBe('1.0.0');
    const refs = collectLocalRefs(contract);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((ref) => ref.startsWith('#/'))).toBe(true);
    for (const ref of refs) {
      expect(resolveLocalRef(contract, ref)).toBeDefined();
    }
  });

  it('publishes exactly the approved command, claim, start, result, status, and capability paths', () => {
    expect(Object.keys(contract.paths)).toEqual([
      '/plans/{planId}/execute',
      '/action-plan-executions/claim-next',
      '/plans/{planId}/executions/{runId}/claim',
      '/plans/{planId}/executions/{runId}/start',
      '/plans/{planId}/executions/{runId}/result',
      '/plans/{planId}/executions/{runId}',
      '/action-plan-executions/protocol',
    ]);
  });

  it('uses unique stable operation IDs', () => {
    const operationIds = operations().map(({ operation }) => operation.operationId);
    expect(operationIds).toEqual([
      'requestActionPlanExecution',
      'claimNextActionPlanExecution',
      'claimActionPlanExecution',
      'startActionPlanExecution',
      'submitActionPlanExecutionResult',
      'getActionPlanExecutionResult',
      'getActionPlanExecution',
      'getActionPlanExecutionProtocol',
    ]);
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it('requires explicit purpose-bound bearer authentication on every operation', () => {
    const securitySchemes = contract.components.securitySchemes;
    expect(Object.keys(securitySchemes)).toEqual([
      'ActionPlanRequesterBearer',
      'ActionPlanOperatorBearer',
      'ActionPlanExecutorBearer',
    ]);
    for (const scheme of Object.values(securitySchemes)) {
      expect(scheme).toEqual(expect.objectContaining({ type: 'http', scheme: 'bearer' }));
    }
    for (const { operation } of operations()) {
      expect(operation.security).toBeDefined();
      expect(operation.security).not.toHaveLength(0);
      expect(operation.security).not.toContainEqual({});
    }
    expect(contract.paths['/plans/{planId}/execute']?.post?.security).toEqual([
      { ActionPlanRequesterBearer: [] },
      { ActionPlanOperatorBearer: [] },
    ]);
    for (const path of [
      '/action-plan-executions/claim-next',
      '/plans/{planId}/executions/{runId}/claim',
      '/plans/{planId}/executions/{runId}/start',
    ]) {
      expect(contract.paths[path]?.post?.security).toEqual([
        { ActionPlanExecutorBearer: [] },
      ]);
    }
  });

  it('makes /execute command-only and the dedicated result path result-only', () => {
    const command = contract.paths['/plans/{planId}/execute']?.post;
    const result = contract.paths['/plans/{planId}/executions/{runId}/result']?.post;
    expect(command?.operationId).toBe('requestActionPlanExecution');
    expect(command?.requestBody?.required).toBe(false);
    expect(command?.requestBody?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/EmptyOperationBody');
    expect(command?.description).toContain('never accepts terminal result evidence');

    expect(result?.operationId).toBe('submitActionPlanExecutionResult');
    expect(result?.requestBody?.required).toBe(true);
    expect(result?.requestBody?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/ExecutionResultInput');
    expect(result?.description).toContain('never claims, starts, dispatches, or creates');

    const commandBody = contract.components.schemas.EmptyOperationBody;
    expect(commandBody).toEqual(expect.objectContaining({
      type: 'object',
      maxProperties: 0,
      additionalProperties: false,
    }));
    const resultBody = contract.components.schemas.ExecutionResultInput as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(resultBody.additionalProperties).toBe(false);
    expect(resultBody.required).toEqual(['action_id', 'snapshot_id', 'outcome']);
    expect(Object.keys(resultBody.properties)).toEqual([
      'action_id',
      'snapshot_id',
      'outcome',
      'output',
      'error',
    ]);

    const validateCommand = compileComponent('EmptyOperationBody');
    const validateResult = compileComponent('ExecutionResultInput');
    for (const fixture of fixtures.valid.commandBodies) {
      expect(validateCommand(fixture.value)).toBe(true);
    }
    for (const fixture of fixtures.valid.resultRequests) {
      expect(validateResult(fixture.value)).toBe(true);
    }
    for (const fixture of fixtures.invalid) {
      if (fixture.schema === 'command') {
        expect(validateCommand(fixture.value)).toBe(false);
      }
      if (fixture.schema === 'result') {
        expect(validateResult(fixture.value)).toBe(false);
      }
    }
  });

  it('documents the 64 KiB pre-parse seam and bounded result subfields', () => {
    const result = contract.paths['/plans/{planId}/executions/{runId}/result']?.post;
    expect(result?.requestBody?.['x-arcanos-max-http-body-bytes'])
      .toBe(ACTION_PLAN_EXECUTION_LIMITS.maxHttpBodyBytes);
    const schema = contract.components.schemas.ExecutionResultInput as {
      'x-arcanos-max-http-body-bytes': number;
      'x-arcanos-finite-numbers-only': boolean;
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema['x-arcanos-max-http-body-bytes'])
      .toBe(ACTION_PLAN_EXECUTION_LIMITS.maxHttpBodyBytes);
    expect(schema['x-arcanos-finite-numbers-only']).toBe(true);
    expect(schema.properties.output?.['x-arcanos-max-encoded-bytes'])
      .toBe(ACTION_PLAN_EXECUTION_LIMITS.maxOutputBytes);
    expect(schema.properties.output?.['x-arcanos-max-depth'])
      .toBe(ACTION_PLAN_EXECUTION_LIMITS.maxJsonDepth);
    expect(contract.components.schemas.SafeResultError?.['x-arcanos-max-encoded-bytes'])
      .toBe(ACTION_PLAN_EXECUTION_LIMITS.maxErrorBytes);
  });

  it('requires bounded idempotency keys on every mutating protocol operation', () => {
    const idempotencyParameter = contract.components.parameters.IdempotencyKey as {
      required: boolean;
      schema: { minLength: number; maxLength: number; pattern: string };
    };
    expect(idempotencyParameter.required).toBe(true);
    expect(idempotencyParameter.schema).toEqual(expect.objectContaining({
      minLength: 1,
      maxLength: ACTION_PLAN_EXECUTION_LIMITS.maxIdempotencyKeyCharacters,
      pattern: '^[!-~]+$',
    }));
    for (const { method, operation } of operations()) {
      if (method !== 'post') {
        continue;
      }
      expect(operation.parameters).toContainEqual({
        $ref: '#/components/parameters/IdempotencyKey',
      });
    }
  });

  it('documents no-store caching on every response carrying execution evidence', () => {
    for (const { operation } of operations()) {
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (status === '204') {
          continue;
        }
        if (response.$ref) {
          const resolved = resolveLocalRef(contract, response.$ref) as {
            headers?: Record<string, { $ref?: string }>;
          };
          expect(resolved.headers?.['Cache-Control']?.$ref)
            .toBe('#/components/headers/NoStore');
          continue;
        }
        expect(response.headers?.['Cache-Control']?.$ref)
          .toBe('#/components/headers/NoStore');
      }
    }
  });

  it('documents every stable error category without raw diagnostic fields', () => {
    const errorCodes = contract.components.schemas.ExecutionErrorCode as { enum: string[] };
    expect(errorCodes.enum).toEqual(ACTION_PLAN_EXECUTION_ERROR_CODES);
    const publicErrorText = JSON.stringify(contract.components.schemas.PublicError);
    for (const forbidden of [
      'stack',
      'sql',
      'path',
      'headers',
      'provider_response',
      'request_body',
      'details',
    ]) {
      expect(publicErrorText).not.toContain(`\"${forbidden}\"`);
    }
  });

  it('keeps sanitized status separate from claim assignment and bounded result reads', () => {
    const statusText = JSON.stringify(contract.components.schemas.ExecutionStatusResponse);
    for (const forbidden of ['assignment', 'params', 'output', 'error', 'command', 'fingerprint']) {
      expect(statusText).not.toContain(`\"${forbidden}\"`);
    }
    const claimText = JSON.stringify(contract.components.schemas.ExecutionClaimResponse);
    expect(claimText).toContain('\"assignment\"');
    const resultText = JSON.stringify(contract.components.schemas.ExecutionResultReadResponse);
    expect(resultText).toContain('\"output\"');
    expect(resultText).toContain('\"error\"');
  });

  it('validates all shared success response fixtures against OpenAPI schemas', () => {
    const cases: Array<[string, NamedValue[]]> = [
      ['ExecutionCommandResponse', fixtures.valid.commandResponses],
      ['ExecutionClaimResponse', fixtures.valid.claimResponses],
      ['ExecutionStartResponse', fixtures.valid.startResponses],
      ['ExecutionResultResponse', fixtures.valid.resultResponses],
      ['ExecutionStatusResponse', fixtures.valid.statusResponses],
      ['ExecutionResultReadResponse', fixtures.valid.resultReadResponses],
      ['ExecutionCapabilityResponse', fixtures.valid.capabilityResponses],
    ];
    for (const [schemaName, values] of cases) {
      const validate = compileComponent(schemaName);
      for (const fixture of values) {
        expect(validate(fixture.value)).toBe(true);
      }
    }
  });

  it('pins the wire protocol version and never confuses it with persisted integer version 2', () => {
    expect(contract.components.schemas.ResponseBase?.properties).toEqual(expect.objectContaining({
      protocol_version: { const: ACTION_PLAN_EXECUTION_PROTOCOL_VERSION },
    }));
    expect(JSON.stringify(contract)).not.toContain('\"protocol_version\":2');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

import { buildGamingDiscoveryQuery } from '../../src/services/gamingSourceDiscovery.js';
import { GAMING_RESPONSE_MAX_CHARACTERS } from '../../src/shared/http/clientResponseCommon.js';
import {
  GAMING_HYBRID_CONTRACT_VERSION,
  GAMING_HYBRID_LIMITS,
  gamingHybridCandidatesSchema,
  gamingHybridIngestionSchema,
  gamingHybridQuerySchema,
} from '../../src/shared/gaming/gamingHybridContract.js';

const contractPath = join(process.cwd(), 'contracts/arcanos_gaming.openapi.v1.json');
const instructionsPath = join(process.cwd(), 'docs/ARCANOS_GAMING_CUSTOM_GPT.md');
const customGptsPath = join(process.cwd(), 'docs/CUSTOM_GPTS.md');
const hybridInstructionsPath = join(process.cwd(), 'docs/gpt/arcanos-gaming-hybrid.instructions.md');

function loadContract() {
  return JSON.parse(readFileSync(contractPath, 'utf8'));
}

function collectLocalRefs(value: unknown, refs: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectLocalRefs(entry, refs));
    return refs;
  }
  if (!value || typeof value !== 'object') {
    return refs;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && typeof entry === 'string' && entry.startsWith('#/')) {
      refs.push(entry);
    } else {
      collectLocalRefs(entry, refs);
    }
  }
  return refs;
}

function resolveLocalRef(document: unknown, ref: string): unknown {
  return ref.slice(2).split('/').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    return (current as Record<string, unknown>)[key];
  }, document);
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKeys(entry, keys));
    return keys;
  }
  if (!value || typeof value !== 'object') {
    return keys;
  }
  for (const [key, entry] of Object.entries(value)) {
    keys.push(key);
    collectKeys(entry, keys);
  }
  return keys;
}

describe('ARCANOS Gaming Custom GPT builder contract', () => {
  it('uses only the canonical fixed Gaming endpoints and builder-safe schema constructs', () => {
    const contract = loadContract();

    expect(contract.openapi).toBe('3.1.0');
    expect(contract.info.version).toBe('1.5.0');
    expect(contract.servers).toEqual([
      {
        url: 'https://acranos-production.up.railway.app',
        description: 'Canonical ARCANOS production deployment',
      },
    ]);
    expect(contract.security).toBeUndefined();
    expect(JSON.stringify(contract)).not.toContain('arcanos-v2-production.up.railway.app');
    expect(Object.keys(contract.paths)).toEqual([
      '/gpt/arcanos-gaming',
      '/gpt/arcanos-gaming/canary',
      '/gpt-access/gaming/sources/ingestions',
      '/gpt-access/gaming/sources/refreshes',
      '/gpt-access/gaming/sources/ingestions/{ingestionId}',
      '/gpt-access/gaming/sources/hybrid/query',
      '/gpt-access/gaming/sources/hybrid/candidates',
      '/gpt-access/gaming/sources/hybrid/ingestions',
    ]);
    expect(Object.keys(contract.paths['/gpt/arcanos-gaming'])).toEqual(['post']);
    expect(Object.keys(contract.paths['/gpt/arcanos-gaming/canary'])).toEqual(['post']);
    expect(Object.keys(contract.paths['/gpt-access/gaming/sources/ingestions'])).toEqual(['post']);
    expect(Object.keys(contract.paths['/gpt-access/gaming/sources/refreshes'])).toEqual(['post']);
    expect(Object.keys(
      contract.paths['/gpt-access/gaming/sources/ingestions/{ingestionId}']
    )).toEqual(['get']);

    const query = contract.paths['/gpt/arcanos-gaming'].post;
    expect(query.operationId).toBe('queryArcanosGaming');
    expect(query.security).toBeUndefined();
    expect(query.description.length).toBeLessThanOrEqual(300);
    expect(query.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/GamingQueryRequest',
    });

    const canary = contract.paths['/gpt/arcanos-gaming/canary'].post;
    expect(canary.operationId).toBe('canaryArcanosGaming');
    expect(canary.security).toBeUndefined();
    expect(canary.description.length).toBeLessThanOrEqual(300);
    expect(canary.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/PublicCanaryRequest',
    });

    expect(contract.components.securitySchemes).toEqual({
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Opaque Gaming source access token',
        description: 'Required for Gaming hybrid knowledge and source lifecycle operations. Configure the dedicated ARCANOS_GAMING_SOURCE_ACCESS_TOKEN; it cannot authorize other GPT Access routes.',
      },
    });

    const protectedOperations = [
      contract.paths['/gpt-access/gaming/sources/ingestions'].post,
      contract.paths['/gpt-access/gaming/sources/refreshes'].post,
      contract.paths['/gpt-access/gaming/sources/ingestions/{ingestionId}'].get,
    ];
    for (const operation of protectedOperations) {
      expect(operation.security).toEqual([{ bearerAuth: [] }]);
      expect(operation.description.length).toBeLessThanOrEqual(300);
      expect(operation.responses['401'].description).toBe(
        'A valid dedicated Gaming source bearer credential is required.'
      );
      expect(operation.responses['503'].description).toContain(
        'dedicated bearer authentication'
      );
    }
    expect(
      protectedOperations.map((operation) => operation['x-openai-isConsequential']),
    ).toEqual([
      true,
      true,
      false,
    ]);

    const keys = collectKeys(contract);
    expect(keys).not.toContain('anyOf');
    expect(keys).not.toContain('oneOf');
    expect(keys).not.toContain('allOf');
    expect(keys).not.toContain('const');

    const refs = collectLocalRefs(contract);
    expect(refs.length).toBeGreaterThan(0);
    refs.forEach((ref) => expect(resolveLocalRef(contract, ref)).toBeDefined());
  });

  it('defines narrow authenticated source ingestion, refresh, and status contracts', () => {
    const contract = loadContract();
    const schemas = contract.components.schemas;
    const ingest = contract.paths['/gpt-access/gaming/sources/ingestions'].post;
    const refresh = contract.paths['/gpt-access/gaming/sources/refreshes'].post;
    const status = contract.paths[
      '/gpt-access/gaming/sources/ingestions/{ingestionId}'
    ].get;

    expect(ingest.operationId).toBe('ingestGamingSources');
    expect(refresh.operationId).toBe('refreshGamingSources');
    expect(status.operationId).toBe('getGamingSourceIngestionStatus');
    expect(ingest.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/GamingSourceIngestionRequest',
    });
    expect(refresh.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/GamingSourceRefreshRequest',
    });
    expect(status.parameters).toEqual([
      expect.objectContaining({
        name: 'ingestionId',
        in: 'path',
        required: true,
        schema: { $ref: '#/components/schemas/GamingOpaqueIdentifier' },
      }),
    ]);

    expect(schemas.GamingSourceIngestionRequest).toEqual(expect.objectContaining({
      type: 'object',
      additionalProperties: false,
      required: ['action', 'payload'],
    }));
    expect(schemas.GamingSourceIngestionRequest.properties.action.enum).toEqual(['ingest']);
    expect(schemas.GamingSourceIngestionPayload).toEqual(expect.objectContaining({
      type: 'object',
      additionalProperties: false,
      required: ['game', 'sourceUrls', 'idempotencyKey'],
    }));
    expect(Object.keys(schemas.GamingSourceIngestionPayload.properties)).toEqual([
      'game',
      'sourceUrls',
      'sourceTypeHint',
      'patchVersion',
      'origin',
      'idempotencyKey',
    ]);
    expect(schemas.GamingSourceIngestionPayload.properties.sourceUrls).toEqual(
      expect.objectContaining({
        type: 'array',
        minItems: 1,
        maxItems: 4,
        uniqueItems: true,
      })
    );
    expect(schemas.GamingSourceIngestionPayload.properties.sourceUrls.items).toEqual(
      expect.objectContaining({
        type: 'string',
        format: 'uri',
        maxLength: 2048,
        pattern: '^https://',
      })
    );
    expect(schemas.GamingSourceIngestionPayload.properties.origin.enum).toEqual([
      'user_supplied',
      'gpt_web_search',
    ]);
    expect(schemas.GamingSourceIngestionPayload.properties.idempotencyKey).toEqual({
      $ref: '#/components/schemas/GamingIdempotencyKey',
    });
    expect(schemas.GamingIdempotencyKey).toEqual(expect.objectContaining({
      type: 'string',
      minLength: 8,
      maxLength: 240,
    }));
    expect(schemas.GamingOpaqueIdentifier).toEqual(expect.objectContaining({
      type: 'string',
      format: 'uuid',
      minLength: 36,
      maxLength: 36,
    }));

    expect(schemas.GamingSourceRefreshRequest).toEqual(expect.objectContaining({
      type: 'object',
      additionalProperties: false,
      required: ['action', 'payload'],
    }));
    expect(schemas.GamingSourceRefreshRequest.properties.action.enum).toEqual(['refresh']);
    expect(schemas.GamingSourceRefreshPayload).toEqual(expect.objectContaining({
      type: 'object',
      additionalProperties: false,
      required: ['sourceIds', 'idempotencyKey'],
    }));
    expect(Object.keys(schemas.GamingSourceRefreshPayload.properties)).toEqual([
      'sourceIds',
      'reason',
      'idempotencyKey',
    ]);
    expect(schemas.GamingSourceRefreshPayload.properties.sourceIds).toEqual(
      expect.objectContaining({
        type: 'array',
        minItems: 1,
        maxItems: 4,
        uniqueItems: true,
        items: { $ref: '#/components/schemas/GamingOpaqueIdentifier' },
      })
    );
    expect(schemas.GamingSourceRefreshPayload.properties).not.toHaveProperty('sourceUrls');

    expect(Object.keys(ingest.responses)).toEqual([
      '202', '400', '401', '409', '413', '415', '422', '429', '500', '503',
    ]);
    expect(Object.keys(refresh.responses)).toEqual([
      '202', '400', '401', '409', '413', '415', '422', '429', '500', '503',
    ]);
    expect(Object.keys(status.responses)).toEqual([
      '200', '400', '401', '404', '429', '500', '503',
    ]);
    expect(ingest.responses['202'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/GamingSourceIngestionAcceptedResponse',
    });
    expect(status.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/GamingSourceIngestionStatusResponse',
    });
    for (const operation of [ingest, refresh, status]) {
      expect(operation.responses).not.toHaveProperty('403');
      expect(operation.responses['401'].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/GamingSourceOperationErrorResponse',
      });
      expect(operation.responses['503'].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/GamingSourceOperationErrorResponse',
      });
      expect(operation.responses['429'].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/GamingSourceRateLimitResponse',
      });
    }
    for (const operation of [ingest, refresh]) {
      for (const statusCode of ['413', '415']) {
        expect(operation.responses[statusCode].content['application/json'].schema).toEqual({
          $ref: '#/components/schemas/GamingSourceOperationErrorResponse',
        });
      }
    }

    for (const schemaName of [
      'GamingSourceAdmission',
      'GamingSourceIngestionAcceptedResponse',
      'GamingSourceIngestionCounts',
      'GamingSourceItemError',
      'GamingSourceIngestionItemStatus',
      'GamingSourceIngestionStatusResponse',
      'GamingSourceOperationError',
      'GamingSourceOperationErrorResponse',
      'GamingSourceRateLimitResponse',
    ]) {
      expect(schemas[schemaName].additionalProperties).toBe(false);
    }
    expect(schemas.GamingSourceOperationError.properties.code.enum).not.toContain(
      'GPT_ACCESS_SCOPE_DENIED'
    );
    expect(schemas.GamingSourceOperationError.properties.code.enum).not.toContain(
      'GPT_ACCESS_INTERNAL_ERROR'
    );
    expect(schemas.GamingSourceOperationError.properties.code.enum).toContain(
      'GAMING_SOURCE_STORAGE_UNAVAILABLE'
    );
    expect(schemas.GamingSourceOperationError.properties.code.enum).toContain(
      'GAMING_SOURCE_AUTH_UNAVAILABLE'
    );
    expect(schemas.GamingSourceRateLimitResponse).toEqual(expect.objectContaining({
      required: ['error', 'message', 'retryAfter'],
      properties: expect.objectContaining({
        error: expect.objectContaining({ enum: ['Rate limit exceeded'] }),
        retryAfter: expect.objectContaining({ type: 'integer', minimum: 1 }),
      }),
    }));
    expect(schemas.GamingSourceIngestionAcceptedResponse.properties.status.enum).toEqual([
      'queued',
      'running',
      'completed',
      'completed_with_errors',
      'failed',
      'cancelled',
      'expired',
    ]);
    expect(schemas.GamingSourceIngestionStatusResponse.properties.status.enum).toEqual([
      'queued',
      'running',
      'completed',
      'completed_with_errors',
      'failed',
      'cancelled',
      'expired',
    ]);
    expect(schemas.GamingSourceIngestionItemStatus.properties.status.enum).toEqual([
      'queued',
      'running',
      'stored',
      'updated',
      'unchanged',
      'rejected',
      'failed',
    ]);
    expect(
      schemas.GamingSourceIngestionItemStatus.properties.patchVersion
    ).toEqual(expect.objectContaining({
      type: 'string',
      maxLength: 64,
    }));

    const protectedSchemaText = JSON.stringify({
      ingestRequest: schemas.GamingSourceIngestionRequest,
      ingestPayload: schemas.GamingSourceIngestionPayload,
      refreshRequest: schemas.GamingSourceRefreshRequest,
      refreshPayload: schemas.GamingSourceRefreshPayload,
      acceptedResponse: schemas.GamingSourceIngestionAcceptedResponse,
      statusResponse: schemas.GamingSourceIngestionStatusResponse,
      itemStatus: schemas.GamingSourceIngestionItemStatus,
    });
    for (const forbiddenField of [
      'rawHtml',
      'headers',
      'cookies',
      'credentials',
      'database',
      'jobId',
      'queue',
      'worker',
      'trustLevel',
      'sourcePriority',
    ]) {
      expect(protectedSchemaText).not.toContain(`\"${forbiddenField}\"`);
    }
  });

  it('defines a closed and bounded public canary protocol without internal diagnostics', () => {
    const contract = loadContract();
    const schemas = contract.components.schemas;
    const canary = contract.paths['/gpt/arcanos-gaming/canary'].post;

    expect(canary.requestBody.content['application/json'].examples.publicPipeline.value).toEqual({
      action: 'canary',
      payload: { scope: 'public_pipeline' },
    });
    expect(Object.keys(canary.responses)).toEqual(['200', '400', '500', '503']);
    expect(canary.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/PublicCanarySuccessResponse',
    });
    for (const status of ['400', '500', '503']) {
      expect(canary.responses[status].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/PublicCanaryFailureResponse',
      });
    }

    expect(schemas.PublicCanaryRequest).toEqual(expect.objectContaining({
      type: 'object',
      additionalProperties: false,
      required: ['action', 'payload'],
    }));
    expect(schemas.PublicCanaryRequest.properties.action.enum).toEqual(['canary']);
    expect(schemas.PublicCanaryPayload).toEqual(expect.objectContaining({
      type: 'object',
      additionalProperties: false,
      required: ['scope'],
    }));
    expect(schemas.PublicCanaryPayload.properties.scope.enum).toEqual(['public_pipeline']);

    const successProperties = schemas.PublicCanarySuccessResponse.properties;
    expect(schemas.PublicCanarySuccessResponse.additionalProperties).toBe(false);
    expect(schemas.PublicCanarySuccessResponse.required).toEqual(Object.keys(successProperties));
    expect(successProperties.schemaVersion.enum).toEqual([contract.info.version]);
    expect(successProperties.message).toEqual(expect.objectContaining({
      minLength: 1,
      maxLength: 160,
      pattern: '\\S',
    }));
    expect(successProperties.requestId.maxLength).toBe(128);
    expect(successProperties.traceId.maxLength).toBe(128);
    expect(successProperties.requestId.pattern).toBe('^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
    expect(successProperties.traceId.pattern).toBe('^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
    expect(successProperties.durationMs.maximum).toBe(30000);
    expect(successProperties.acceptedSources.enum).toEqual([1]);
    expect(successProperties.usedFallback.enum).toEqual([false]);

    const fixture = schemas.PublicCanaryFixture;
    expect(fixture.additionalProperties).toBe(false);
    expect(fixture.required).toEqual(Object.keys(fixture.properties));
    expect(fixture.properties).toEqual(expect.objectContaining({
      source: { type: 'string', enum: ['bundled'] },
      marker: { type: 'string', enum: ['ARCANOS_PUBLIC_CANARY_7F31'] },
      markerVerified: { type: 'boolean', enum: [true] },
    }));

    const expectedChecks = [
      'requestValidation',
      'dispatcher',
      'publicRoute',
      'fixtureValidation',
      'grounding',
      'networkRetrieval',
      'providerExecution',
      'responseConstruction',
      'responseGuard',
    ];
    for (const schemaName of ['PublicCanarySuccessChecks', 'PublicCanaryFailureChecks']) {
      expect(schemas[schemaName].additionalProperties).toBe(false);
      expect(schemas[schemaName].required).toEqual(expectedChecks);
      expect(Object.keys(schemas[schemaName].properties)).toEqual(expectedChecks);
    }
    expect(schemas.PublicCanarySuccessChecks.properties.networkRetrieval.enum).toEqual(['skipped']);
    expect(schemas.PublicCanarySuccessChecks.properties.providerExecution.enum).toEqual(['skipped']);
    for (const property of Object.values(schemas.PublicCanaryFailureChecks.properties) as Array<{
      enum: string[];
    }>) {
      expect(property.enum).toEqual(['passed', 'failed', 'skipped']);
    }

    const failureProperties = schemas.PublicCanaryFailureResponse.properties;
    expect(schemas.PublicCanaryFailureResponse.additionalProperties).toBe(false);
    expect(schemas.PublicCanaryFailureResponse.required).toEqual(Object.keys(failureProperties));
    expect(failureProperties.schemaVersion.enum).toEqual([contract.info.version]);
    expect(failureProperties.requestId.pattern).toBe('^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
    expect(failureProperties.traceId.pattern).toBe('^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
    expect(failureProperties.code.enum).toEqual([
      'BAD_REQUEST',
      'PUBLIC_CANARY_REQUEST_REJECTED',
      'PUBLIC_CANARY_UNAVAILABLE',
      'PUBLIC_CANARY_ROUTE_FAILURE',
      'PUBLIC_CANARY_FIXTURE_UNAVAILABLE',
      'PUBLIC_CANARY_FIXTURE_INVALID',
      'PUBLIC_CANARY_GROUNDING_FAILED',
      'PUBLIC_CANARY_FAILURE_RESPONSE_GUARD_FAILED',
      'PUBLIC_CANARY_RESPONSE_GUARD_FAILED',
    ]);
    expect(failureProperties.acceptedSources).toEqual(expect.objectContaining({
      minimum: 0,
      maximum: 1,
    }));

    const boundedSuccess = {
      ok: true,
      action: 'canary',
      scope: 'public_pipeline',
      schemaVersion: contract.info.version,
      intent: 'public_canary',
      route: 'public_canary',
      message: 'x'.repeat(successProperties.message.maxLength),
      requestId: 'x'.repeat(successProperties.requestId.maxLength),
      traceId: 'x'.repeat(successProperties.traceId.maxLength),
      fixture: {
        source: 'bundled',
        marker: 'ARCANOS_PUBLIC_CANARY_7F31',
        markerVerified: true,
      },
      checks: Object.fromEntries(expectedChecks.map((name) => [
        name,
        ['networkRetrieval', 'providerExecution'].includes(name) ? 'skipped' : 'passed',
      ])),
      usedFallback: false,
      acceptedSources: 1,
      durationMs: successProperties.durationMs.maximum,
    };
    expect(Buffer.byteLength(JSON.stringify(boundedSuccess), 'utf8')).toBeLessThan(2048);

    const boundedFailure = {
      ok: false,
      action: 'canary',
      scope: 'public_pipeline',
      schemaVersion: contract.info.version,
      intent: 'public_canary',
      route: 'public_canary',
      message: 'x'.repeat(failureProperties.message.maxLength),
      requestId: 'x'.repeat(failureProperties.requestId.maxLength),
      traceId: 'x'.repeat(failureProperties.traceId.maxLength),
      code: 'PUBLIC_CANARY_RESPONSE_GUARD_FAILED',
      checks: Object.fromEntries(expectedChecks.map((name) => [name, 'skipped'])),
      usedFallback: true,
      acceptedSources: 1,
      durationMs: failureProperties.durationMs.maximum,
    };
    expect(Buffer.byteLength(JSON.stringify(boundedFailure), 'utf8')).toBeLessThan(2048);

    const publicCanarySchemaText = JSON.stringify({
      request: schemas.PublicCanaryRequest,
      payload: schemas.PublicCanaryPayload,
      fixture,
      successChecks: schemas.PublicCanarySuccessChecks,
      failureChecks: schemas.PublicCanaryFailureChecks,
      success: schemas.PublicCanarySuccessResponse,
      failure: schemas.PublicCanaryFailureResponse,
    });
    for (const forbiddenField of [
      'details',
      'environment',
      'hostname',
      'deploymentId',
      'providerError',
      'stack',
      'logs',
      'token',
      'credentials',
      'databaseUrl',
    ]) {
      expect(publicCanarySchemaText).not.toContain(`\"${forbiddenField}\"`);
    }
  });

  it('documents the single first-call payload with bounded candidate URL fields', () => {
    const schemas = loadContract().components.schemas;
    const queryRequest = schemas.GamingQueryRequest;
    const queryPayload = schemas.GamingQueryPayload;

    expect(queryRequest.required).toEqual(['action', 'payload']);
    expect(queryRequest.properties.action).toEqual(expect.objectContaining({
      type: 'string',
      enum: ['query'],
    }));
    expect(queryPayload.required).toEqual(['mode', 'prompt']);
    expect(queryPayload.properties.prompt).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 8000,
    });
    expect(Object.keys(queryPayload.properties)).toEqual(expect.arrayContaining([
      'mode',
      'game',
      'prompt',
      'url',
      'urls',
      'guideUrl',
      'guideUrls',
    ]));
    for (const property of ['urls', 'guideUrls']) {
      expect(queryPayload.properties[property]).toEqual(expect.objectContaining({
        type: 'array',
        maxItems: 4,
        uniqueItems: true,
      }));
      expect(queryPayload.properties[property].items).toEqual(expect.objectContaining({
        type: 'string',
        format: 'uri',
        maxLength: 2048,
      }));
    }
    expect(queryPayload.properties).not.toHaveProperty('evidenceOrigin');
    expect(queryPayload.properties).not.toHaveProperty('requestedVersion');
    expect(queryPayload.properties).not.toHaveProperty('evidenceAttempt');
    expect(schemas).not.toHaveProperty('GamingEvidenceRetryRequest');
  });

  it('documents the evidence request inside the preserved Gaming envelope', () => {
    const schemas = loadContract().components.schemas;
    const evidenceRequest = schemas.GamingEvidenceRequest;
    const gamingSource = schemas.GamingSource;

    expect(evidenceRequest.required).toEqual([
      'required',
      'reason',
      'game',
      'maxCandidateUrls',
      'queries',
    ]);
    expect(evidenceRequest.properties.reason.enum).toEqual([
      'CURRENT_VERSION_EVIDENCE_REQUIRED',
    ]);
    expect(evidenceRequest.properties.maxCandidateUrls.enum).toEqual([4]);
    expect(evidenceRequest.properties.queries.maxItems).toBe(4);
    expect(evidenceRequest.properties.queries.items.maxLength).toBe(180);
    expect(schemas.GamingResponseData.required).toEqual(['response', 'sources']);
    expect(schemas.GamingResponseData.properties).toEqual(expect.objectContaining({
      response: {
        type: 'string',
        minLength: 1,
        maxLength: GAMING_RESPONSE_MAX_CHARACTERS,
        pattern: '[\\p{L}\\p{N}\\p{S}]',
      },
      sources: {
        type: 'array',
        items: { $ref: '#/components/schemas/GamingSource' },
      },
      fallbackReason: { type: 'string' },
      discoveryReason: { type: 'string' },
      evidenceRequest: { $ref: '#/components/schemas/GamingEvidenceRequest' },
    }));
    expect(schemas.GamingPublicResponse.required).toEqual([
      'ok',
      'requestId',
      'traceId',
      'result',
      '_route',
    ]);
    expect(schemas.PublicError.properties.details).toEqual({
      type: 'object',
      additionalProperties: true,
    });
    expect(gamingSource.required).toEqual(['url']);
    expect(gamingSource.properties).toEqual(expect.objectContaining({
      url: expect.objectContaining({ type: 'string', minLength: 1 }),
      snippet: { type: 'string' },
      error: { type: 'string' },
      sourceId: expect.objectContaining({ type: 'string', format: 'uuid' }),
      sourceType: expect.objectContaining({ type: 'string' }),
      patchVersion: expect.objectContaining({ type: 'string', maxLength: 64 }),
      fetchedAt: expect.objectContaining({ type: 'string', format: 'date-time' }),
      title: expect.objectContaining({ type: 'string', maxLength: 240 }),
      origin: { type: 'string', enum: ['live', 'stored'] },
    }));
    const responsePattern = new RegExp(schemas.GamingResponseData.properties.response.pattern, 'u');
    expect(responsePattern.test('   ')).toBe(false);
    expect(responsePattern.test('...')).toBe(false);
    expect(responsePattern.test('\u034f\u061c\u200b\u202e\u2060\ufe0f\ufeff')).toBe(false);
    expect(responsePattern.test('\u200bPalworld guide')).toBe(true);
    expect(responsePattern.test('🎮')).toBe(true);
  });

  it('keeps the builder query length synchronized with the runtime query builder', () => {
    const contract = loadContract();
    const contractMax = contract.components.schemas.GamingEvidenceRequest
      .properties.queries.items.maxLength;
    const runtimeQuery = buildGamingDiscoveryQuery({
      mode: 'guide',
      game: `Game ${'x'.repeat(95)}`,
      prompt: Array.from({ length: 10 }, (_, index) => `distincttopic${index}${'z'.repeat(24)}`).join(' '),
      patchSensitive: true,
    });

    expect(runtimeQuery.length).toBe(contractMax);
  });

  it('adds authenticated hybrid operations without weakening durable-write confirmation', () => {
    const contract = loadContract();
    expect(contract['x-arcanos-gaming-hybrid-contract-version']).toBe(GAMING_HYBRID_CONTRACT_VERSION);
    for (const [suffix, operationId, schema, consequential] of [
      ['query', 'queryGamingHybridKnowledge', 'GamingHybridQueryRequest', false],
      ['candidates', 'submitGamingHybridCandidates', 'GamingHybridCandidatesRequest', false],
      ['ingestions', 'ingestGamingHybridCandidates', 'GamingHybridIngestionRequest', true],
    ] as const) {
      const operation = contract.paths[`/gpt-access/gaming/sources/hybrid/${suffix}`].post;
      expect(operation.operationId).toBe(operationId);
      expect(operation.security).toEqual([{ bearerAuth: [] }]);
      expect(operation['x-openai-isConsequential']).toBe(consequential);
      expect(operation.description.length).toBeLessThanOrEqual(300);
      expect(operation.summary.length).toBeLessThanOrEqual(300);
      expect(operation.parameters).toBeUndefined();
      expect(operation.requestBody.content['application/json'].schema).toEqual({
        $ref: `#/components/schemas/${schema}`,
      });
      expect(operation.responses['200'].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/GamingHybridResponse',
      });
    }
    const schemas = contract.components.schemas;
    expect(schemas.GamingHybridQueryRequest.properties.storagePolicy.default).toBe('transient_only');
    expect(schemas.GamingHybridQueryRequest.properties.storagePolicy.enum).toEqual([
      'transient_only', 'ask_before_store', 'auto_store_approved',
    ]);
    expect(schemas.GamingHybridIngestionRequest.properties.confirmStore.default).toBe(false);
    expect(schemas.GamingHybridIngestionRequest.properties).not.toHaveProperty('sourceUrls');
    expect(schemas.GamingHybridCandidatesRequest.properties).not.toHaveProperty('question');
    expect(schemas.GamingHybridCandidatesRequest.properties).not.toHaveProperty('context');
  });

  it('validates Action request examples with both OpenAPI and the runtime contract', () => {
    const contract = loadContract();
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    ajv.addSchema(contract, 'gaming-hybrid-action');
    const shared = { contractVersion: GAMING_HYBRID_CONTRACT_VERSION, idempotencyKey: 'example-operation-1' };
    const workflowId = '4517e693-b592-43c8-a827-d4b74168c429';
    const candidateId = 'c25c641a-7031-42f4-a50e-f0db1d6c58c5';
    const examples = [
      {
        name: 'GamingHybridQueryRequest', runtime: gamingHybridQuerySchema,
        valid: { ...shared, game: 'Lantern Vale', question: 'What next?', currentArea: 'Harbor', spoilerTolerance: 'none', answerDepth: 'concise' },
        invalid: [
          { ...shared, game: 'Lantern Vale', question: 'x'.repeat(4001) },
          { ...shared, game: 'Lantern Vale', question: 'What next?', platform: 'x'.repeat(65) },
          { ...shared, game: 'Lantern Vale', question: 'What next?', storagePolicy: 'always_store' },
          { ...shared, game: 'Lantern Vale', question: 'What next?', authToken: 'untrusted' },
          { ...shared, game: 'Lantern Vale', question: 'What next?', contractVersion: 'gaming-hybrid-v0' },
        ],
      },
      {
        name: 'GamingHybridCandidatesRequest', runtime: gamingHybridCandidatesSchema,
        valid: { ...shared, workflowId, candidates: [{ url: 'https://guides.example.org/lantern-vale', claimedCategory: 'official' }] },
        invalid: [
          { ...shared, workflowId, candidates: Array.from({ length: 4 }, () => ({ url: 'https://guides.example.org/guide' })) },
          { ...shared, workflowId, candidates: [{ url: 'https://guides.example.org/guide', rawHtml: '<article>Not a URL hint</article>' }] },
          { ...shared, workflowId, candidates: [{ url: 'https://guides.example.org/guide', claimedPatch: 'x'.repeat(65) }] },
          { ...shared, workflowId, candidates: [] },
        ],
      },
      {
        name: 'GamingHybridIngestionRequest', runtime: gamingHybridIngestionSchema,
        valid: { ...shared, workflowId, candidateIds: [candidateId], storagePolicy: 'ask_before_store', confirmStore: true },
        invalid: [
          { ...shared, workflowId, candidateIds: [candidateId], storagePolicy: 'ask_before_store', confirmStore: 'yes' },
          { ...shared, workflowId, candidateIds: Array(4).fill(candidateId), storagePolicy: 'ask_before_store' },
          { ...shared, workflowId, candidateIds: [], storagePolicy: 'auto_store_approved' },
          { ...shared, workflowId, candidateIds: [candidateId], storagePolicy: 'auto_store_approved', trustLevel: 'official' },
        ],
      },
    ];
    for (const example of examples) {
      const validate = ajv.getSchema(`gaming-hybrid-action#/components/schemas/${example.name}`)!;
      expect(validate(example.valid)).toBe(true);
      expect(example.runtime.safeParse(example.valid).success).toBe(true);
      for (const invalid of example.invalid) {
        expect(validate(invalid)).toBe(false);
        expect(example.runtime.safeParse(invalid).success).toBe(false);
      }
      expect(JSON.stringify(example.valid).length).toBeLessThan(100000);
    }
  });

  it('keeps evidence, currentness, answer provenance, and pending ingestion distinct', () => {
    const schemas = loadContract().components.schemas;
    expect(schemas.GamingHybridResponse.properties.state.enum).toEqual([
      'answer_ready', 'clarification_required', 'discovery_required', 'temporarily_unavailable', 'ingestion_pending',
    ]);
    expect(schemas.GamingHybridResponse.required).toEqual(expect.arrayContaining([
      'contractVersion', 'requestId', 'state', 'nextAction', 'reason', 'sourceKnown', 'evidenceSelected', 'freshnessStatus',
    ]));
    expect(schemas.GamingHybridResponse.properties.freshnessStatus.enum).toEqual([
      'current', 'stale', 'unverified', 'not_applicable', 'conflicting',
    ]);
    expect(schemas.GamingHybridDiscovery.properties.maxRounds.enum).toEqual([GAMING_HYBRID_LIMITS.discoveryRounds]);
    expect(schemas.GamingHybridDiscovery.properties.maxCandidates.enum).toEqual([GAMING_HYBRID_LIMITS.candidates]);
    expect(schemas.GamingHybridCandidatesRequest.properties.candidates.maxItems).toBe(GAMING_HYBRID_LIMITS.candidates);
    expect(schemas.GamingHybridIngestionReference.properties.maxPolls.enum).toEqual([GAMING_HYBRID_LIMITS.polls]);
    expect(schemas.GamingHybridAnswer.properties.provenance.enum).toEqual(['arcanos-trinity']);
    expect(schemas.GamingHybridAnswer.required).toContain('requestId');
    expect(schemas.GamingHybridIngestionReference.properties).not.toHaveProperty('stored');

    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    ajv.addSchema(loadContract(), 'gaming-hybrid-response');
    const validate = ajv.getSchema('gaming-hybrid-response#/components/schemas/GamingHybridResponse')!;
    const pending = {
      contractVersion: GAMING_HYBRID_CONTRACT_VERSION, requestId: 'req_1',
      state: 'ingestion_pending', nextAction: 'poll_ingestion', reason: 'INGESTION_QUEUED',
      sourceKnown: false, evidenceSelected: true, freshnessStatus: 'not_applicable',
      answer: { response: 'Use the harbor lever. [1]', sources: [{ url: 'https://guides.example.org/lantern-vale' }], provenance: 'arcanos-trinity', requestId: 'req_1' },
      ingestion: { ingestionId: 'bc7f4bbe-3a48-4e13-a96f-9a5bc8fccf05', status: 'queued', statusUrl: '/gpt-access/gaming/sources/ingestions/bc7f4bbe-3a48-4e13-a96f-9a5bc8fccf05', maxPolls: 3 },
    };
    expect(validate(pending)).toBe(true);
    expect(validate({ ...pending, freshnessStatus: 'fetched_today_so_current' })).toBe(false);
    expect(validate({ ...pending, answer: { ...pending.answer, response: 'x'.repeat(18001) } })).toBe(false);
    const maximal = {
      ...pending,
      requestId: 'r'.repeat(128), workflowId: '4517e693-b592-43c8-a827-d4b74168c429',
      reason: 'r'.repeat(80), effectivePatch: 'p'.repeat(64), qualification: 'q'.repeat(1000),
      clarification: 'c'.repeat(1000),
      discovery: { round: 1, maxRounds: 1, maxCandidates: 3, searchQueries: Array(3).fill('q'.repeat(400)) },
      candidates: Array.from({ length: 3 }, () => ({
        candidateId: 'c25c641a-7031-42f4-a50e-f0db1d6c58c5', url: 'u'.repeat(2048),
        decision: 'eligible_for_ingestion', reasonCodes: Array(8).fill('r'.repeat(80)), sourceCategory: 'official_updates',
      })),
      answer: {
        ...pending.answer, response: 'a'.repeat(18000), requestId: 'r'.repeat(128),
        sources: Array.from({ length: 8 }, () => ({
          url: 'u'.repeat(2048), title: 't'.repeat(240), sourceId: 'c25c641a-7031-42f4-a50e-f0db1d6c58c5',
          patchVersion: 'p'.repeat(64), fetchedAt: 'd'.repeat(64),
        })),
      },
    };
    expect(validate(maximal)).toBe(true);
    expect(JSON.stringify(maximal).length).toBeLessThan(100000);
  });

  it('packages bounded frontend orchestration and a backend-first activation gate', () => {
    const instructions = readFileSync(hybridInstructionsPath, 'utf8');
    const guide = readFileSync(instructionsPath, 'utf8');
    expect(instructions.length).toBeLessThan(8000);
    expect(instructions).toContain('queryGamingHybridKnowledge first');
    for (const operationId of [
      'submitGamingHybridCandidates', 'ingestGamingHybridCandidates', 'getGamingSourceIngestionStatus',
    ]) expect(instructions).toContain(operationId);
    for (const state of loadContract().components.schemas.GamingHybridResponse.properties.state.enum) {
      expect(instructions).toContain(state);
    }
    for (const requirement of [
      'not prose', 'without redundant search', 'one discovery round', 'at most three',
      'original question', 'server retains the validated original context',
      'untrusted hint', 'transient_only', 'ask_before_store', 'auto_store_approved',
      'platform\'s Action confirmation', 'queued or running is', 'not saved',
      'after ChatGPT closes', 'do not promise a later notification',
      'answer.requestId', 'answer.provenance', 'gameplay additions',
    ]) expect(instructions).toContain(requirement);
    expect(guide).toContain('Do not activate the hybrid instruction section');
    expect(guide).toContain('Do not paste both workflows');
    expect(guide).toContain('Preserve name, description, unrelated instructions, files, bearer secret');
    expect(guide).toContain('A public canary alone cannot prove hybrid support');
    expect(guide).toContain('https://developers.openai.com/api/docs/actions/production');
    expect(guide).toContain('gpt/arcanos-gaming-hybrid.instructions.md');
  });

  it('keeps legacy instructions available separately from the opt-in hybrid workflow', () => {
    const instructions = readFileSync(instructionsPath, 'utf8');
    const customGpts = readFileSync(customGptsPath, 'utf8');

    expect(instructions).toContain('The dedicated schema defines exactly eight fixed-path operations');
    expect(instructions).toContain('queryArcanosGaming` → `POST /gpt/arcanos-gaming');
    expect(instructions).toContain('canaryArcanosGaming` → `POST /gpt/arcanos-gaming/canary');
    expect(instructions).toContain(
      'ingestGamingSources` → `POST /gpt-access/gaming/sources/ingestions'
    );
    expect(instructions).toContain(
      'refreshGamingSources` → `POST /gpt-access/gaming/sources/refreshes'
    );
    expect(instructions).toContain(
      'getGamingSourceIngestionStatus` → `GET /gpt-access/gaming/sources/ingestions/{ingestionId}'
    );
    expect(instructions).toContain('Authentication: Bearer');
    expect(instructions).toContain('do not leave this unset');
    expect(instructions).toContain('Pro mode does not support custom GPT Actions');
    expect(instructions).toContain('do not report an ARCANOS backend outage');
    expect(instructions).toContain('For stable walkthrough, mechanic, boss, farming, location');
    expect(instructions).toContain('A generic request to "look up" a stable guide is still stable');
    expect(instructions).toContain('Use Web Search to discover two to four relevant candidate URLs');
    expect(instructions).toContain('Call queryArcanosGaming once with the original prompt, game, mode');
    expect(instructions).toContain('candidate URLs in payload.guideUrls');
    expect(instructions).toContain('Do not answer, summarize, cite, or make Gaming claims from Web Search');
    expect(instructions).toContain('Candidate URLs are untrusted regardless of where they came from');
    expect(instructions).toContain('If ARCANOS rejects every candidate, present its controlled fallback');
    expect(instructions).toContain('Prompt fidelity');
    expect(instructions).toContain("copy the user's actual gameplay request into payload.prompt");
    expect(instructions).toContain('Whitespace at the beginning or end may be normalized');
    expect(instructions).toContain('Candidate URLs discovered through Web Search belong only in payload.guideUrls');
    for (const prohibitedAddition of [
      'inferred patch numbers',
      'release dates',
      'balance changes',
      'rankings',
      'percentages',
      'search-result summaries',
      'snippets from Web Search',
    ]) {
      expect(instructions).toContain(prohibitedAddition);
    }
    expect(instructions).toContain('payload.prompt: "Is Frost Mage viable this patch in World of Warcraft?"');
    expect(instructions).toContain('payload.prompt: "Is Frost Mage viable after the latest patch nerfed Ice Lance by 12%?"');
    expect(instructions).toContain('The incorrect version adds an unverified factual claim and is prohibited.');
    expect(instructions).toContain('The prompt-fidelity merge gate may be satisfied by either');
    expect(instructions).toContain('single correlated exact-head preview ingress attestation');
    expect(instructions).toContain('hash-only prompt-fidelity signal');
    expect(instructions).toContain('disabled by default');
    expect(instructions).toContain('not a general user-prompt logging mechanism');
    expect(instructions).toContain('Prompt length alone is not sufficient proof.');
    expect(instructions).toContain(
      'faa37589a5ec8315c14c6a8aecae1172879a060a2965a5a60302d9fca21f2a89'
    );
    expect(instructions).toContain(
      'Only backend-accepted readable evidence entries returned in result.data.sources may be cited'
    );
    expect(instructions).toContain('Never cite an entry with an error');
    expect(instructions).toContain('Relevant source retrieved, but readable article text was limited.');
    expect(instructions).toContain('sourceId, sourceType, patchVersion, fetchedAt, title, and origin "stored"');
    expect(instructions).toContain('Ordinary gameplay questions, including current or source-sensitive questions');
    expect(instructions).toContain('Do not trigger durable ingestion merely because');
    expect(instructions).toContain('Send URLs only; never send page text, HTML, cookies, credentials');
    expect(instructions).toContain('Refresh accepts sourceIds, not URLs');
    expect(instructions).toContain('reuse it only for an identical retry');
    expect(instructions).toContain('Do not claim that queued or running content is available');

    for (const example of [
      'Palworld 1.0',
      'Unknown newly released game',
      'Current patch or meta request',
      'Stable older game',
      'User-supplied URL',
      'GPT-discovered sources for ingestion',
      'Refresh admitted sources',
      'All candidate URLs rejected',
    ]) {
      expect(instructions).toContain(`### ${example}`);
    }

    expect(instructions).toContain('/gpt/arcanos-gaming');
    expect(instructions).not.toContain('/gpt/arcanos-gaming/evidence-retry');
    expect(instructions).not.toContain('retryArcanosGamingWithSources');
    expect(instructions).toContain(
      'https://acranos-production.up.railway.app/contracts/arcanos_gaming.openapi.v1.json'
    );
    expect(customGpts).toContain('eight Action operations and an opt-in `gaming-hybrid-v1` backend-first workflow');
    expect(customGpts).toContain('The five legacy operations remain available without adopting hybrid request shapes');
    expect(customGpts).toContain('origin: "stored"');
    expect(customGpts).not.toContain('mandatory backend-first evidence workflow');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';

import type {
  BackstageCanonStorylineSummaryRecord,
  BackstageContext,
} from '../../src/core/db/repositories/backstageBookerRepository.js';
import {
  readBackstageStorylineSummary,
  readBackstageUniverse,
} from '../../src/services/backstageUniverseRead.js';

const contractPath = join(
  process.cwd(),
  'contracts/backstage_booker.openapi.v1.json'
);
const builderGuidePath = join(
  process.cwd(),
  'docs/BACKSTAGE_BOOKER_CUSTOM_GPT.md'
);
const protocolSchemaDirectory = join(
  process.cwd(),
  'packages/protocol/schemas/v1/backstage-booker'
);

function loadJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadContract() {
  return loadJson(contractPath);
}

function loadProtocolSchema(filename: string) {
  return loadJson(join(protocolSchemaDirectory, filename));
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

function actionEnumsForOneOf(contract: any, schemaName: string): string[] {
  return contract.components.schemas[schemaName].oneOf.flatMap(
    (entry: { $ref: string }) => {
      const actionSchema = resolveLocalRef(contract, entry.$ref) as {
        properties: { action: { enum: string[] } };
      };
      return actionSchema.properties.action.enum;
    }
  );
}

function compileComponent(contract: any, schemaName: string) {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  return ajv.compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    ...contract.components.schemas[schemaName],
    components: {
      schemas: contract.components.schemas,
    },
  });
}

describe('Backstage Booker Custom GPT builder contract', () => {
  it('keeps the copy-ready Builder policy within the practical instruction limit', () => {
    const guide = readFileSync(builderGuidePath, 'utf8');
    const policyLead = 'Use the following compact policy text in the GPT instructions';
    const leadOffset = guide.indexOf(policyLead);
    const fenceOffset = guide.indexOf('```text', leadOffset);
    const policyOffset = guide.indexOf('\n', fenceOffset) + 1;
    const fenceEnd = guide.indexOf('\n```', policyOffset);

    expect(leadOffset).toBeGreaterThanOrEqual(0);
    expect(fenceOffset).toBeGreaterThan(leadOffset);
    expect(policyOffset).toBeGreaterThan(fenceOffset);
    expect(fenceEnd).toBeGreaterThan(policyOffset);

    const policy = guide.slice(policyOffset, fenceEnd).replace(/\r\n/gu, '\n');
    expect(policy.length).toBeGreaterThan(0);
    expect(Array.from(policy).length).toBeLessThanOrEqual(8_000);
    expect(Buffer.byteLength(policy, 'utf8')).toBeLessThanOrEqual(8_000);
  });

  it('exposes only the fixed public, durable-result, exact-read, and canon-write operations', () => {
    const contractText = readFileSync(contractPath, 'utf8');
    const contract = JSON.parse(contractText);
    const crlfContractText = contractText.replace(/\r?\n/gu, '\r\n');

    expect(contract.openapi).toBe('3.1.0');
    expect(contract.info.version).toBe('1.5.0');
    expect(Buffer.byteLength(contractText, 'utf8')).toBeLessThanOrEqual(110_000);
    expect(Buffer.byteLength(crlfContractText, 'utf8')).toBeLessThanOrEqual(110_000);
    expect(contract.servers).toEqual([
      {
        url: 'https://acranos-production.up.railway.app',
        description: 'Canonical ARCANOS production deployment',
      },
    ]);
    expect(contract.security).toBeUndefined();
    expect(Object.keys(contract.paths)).toEqual([
      '/gpt/backstage-booker',
      '/jobs/{jobId}/result',
      '/gpt-access/capabilities/v1/backstage-booker/run',
      '/gpt-access/capabilities/v1/backstage-booker/universes/{universeId}',
      '/gpt-access/capabilities/v1/backstage-booker/universes/{universeId}/storyline-summary',
    ]);

    const publicOperation = contract.paths['/gpt/backstage-booker'].post;
    expect(publicOperation.operationId).toBe('runBackstageBooker');
    expect(publicOperation.security).toEqual([{ bearerAuth: [] }]);
    expect(publicOperation['x-openai-isConsequential']).toBe(false);
    expect(publicOperation.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/BackstagePublicRequest',
    });
    expect(contract.components.schemas.BackstagePublicRequest).toEqual(
      expect.objectContaining({
        type: 'object',
        additionalProperties: false,
        required: ['action', 'executionMode', 'payload'],
      })
    );
    expect(contract.components.schemas.BackstagePublicRequest.properties).toEqual({
      action: {
        type: 'string',
        enum: [
          'generateBooking',
          'generateBookingWithHRC',
          'queryContinuity',
          'simulateMatch',
        ],
      },
      executionMode: {
        $ref: '#/components/schemas/BackstagePublicExecutionMode',
      },
      payload: {
        type: 'object',
        description:
          'Action-specific input. For queryContinuity, provide the exact universeId and a query, with optional exact page, subtree, or section scope, retrieval mode, and cursor. For generateBooking or generateBookingWithHRC, provide prompt and the exact universeId when known. For simulateMatch, provide match and a numeric roster; winProbModifier is optional.',
        additionalProperties: false,
        properties: {
          universeId: { $ref: '#/components/schemas/UniverseId' },
          prompt: {
            type: 'string',
            description:
              'Required only for generateBooking and generateBookingWithHRC. Put the complete creative booking request here. For factual lookup, current-state checks, results, champions, storylines, or continuity reviews, use queryContinuity and payload.query.',
            minLength: 1,
            maxLength: 10000,
            pattern: '\\S',
          },
          query: {
            type: 'string',
            description:
              'Required for queryContinuity. Ask one bounded continuity question against the Notion-authoritative snapshot.',
            minLength: 1,
            maxLength: 10000,
            pattern: '\\S',
          },
          retrievalScope: {
            $ref: '#/components/schemas/ContinuityRetrievalScope',
          },
          retrievalMode: {
            $ref: '#/components/schemas/ContinuityRetrievalMode',
          },
          cursor: {
            $ref: '#/components/schemas/ContinuityCursor',
          },
          match: { $ref: '#/components/schemas/MatchInput' },
          rosters: {
            type: 'array',
            minItems: 2,
            maxItems: 100,
            items: { $ref: '#/components/schemas/Wrestler' },
          },
          winProbModifier: {
            type: 'number',
            minimum: -1,
            maximum: 1,
            default: 0,
          },
        },
      },
    });
    expect(contract.components.schemas.BackstagePublicExecutionMode).toEqual(
      expect.objectContaining({
        type: 'string',
        enum: ['sync'],
        default: 'sync',
      })
    );
    for (const schemaName of [
      'GenerateBookingActionRequest',
      'GenerateBookingWithHrcActionRequest',
      'QueryContinuityActionRequest',
      'SimulateMatchActionRequest',
    ]) {
      expect(contract.components.schemas[schemaName]).toEqual(
        expect.objectContaining({
          type: 'object',
          additionalProperties: false,
          required: ['action', 'executionMode', 'payload'],
        })
      );
      expect(contract.components.schemas[schemaName].properties.executionMode)
        .toEqual({
          $ref: '#/components/schemas/BackstagePublicExecutionMode',
        });
    }
    expect(actionEnumsForOneOf(contract, 'BackstagePublicRequest')).toEqual([
      'generateBooking',
      'generateBookingWithHRC',
      'queryContinuity',
      'simulateMatch',
    ]);
    expect(Object.keys(publicOperation.responses)).toEqual([
      '200',
      '202',
      '400',
      '404',
      '409',
      '413',
      '429',
      '500',
      '503',
      '504',
    ]);
    expect(publicOperation.responses['202']).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/BackstageAsyncAcceptedResponse' },
        },
      },
    });
    expect(publicOperation.responses['413']).toMatchObject({
      headers: {
        'Cache-Control': { $ref: '#/components/headers/NoStore' },
      },
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/BackstagePublicErrorResponse' },
        },
      },
    });
    const resultOperation = contract.paths['/jobs/{jobId}/result'].get;
    expect(resultOperation.operationId).toBe('getBackstageBookerJobResult');
    expect(resultOperation.security).toEqual([]);
    expect(resultOperation['x-openai-isConsequential']).toBe(false);
    expect(resultOperation.parameters).toEqual(expect.arrayContaining([
      { $ref: '#/components/parameters/JobReadToken' },
    ]));
    expect(contract.components.parameters.JobReadToken).toMatchObject({
      name: 'x-arcanos-job-read-token',
      in: 'header',
      required: true,
    });

    const validateAccepted = compileComponent(
      contract,
      'BackstageAsyncAcceptedResponse'
    );
    expect(validateAccepted({
      ok: true,
      status: 'queued',
      jobId: '11111111-1111-4111-8111-111111111111',
      poll: '/jobs/11111111-1111-4111-8111-111111111111/result',
      stream: '/jobs/11111111-1111-4111-8111-111111111111/stream',
      jobReadToken: `v1.${'a'.repeat(43)}`,
      jobReadTokenHeader: 'x-arcanos-job-read-token',
      deduped: false,
    })).toBe(true);

    const canonOperation = contract.paths[
      '/gpt-access/capabilities/v1/backstage-booker/run'
    ].post;
    expect(canonOperation.operationId).toBe('writeBackstageCanon');
    expect(canonOperation.security).toEqual([{ bearerAuth: [] }]);
    expect(canonOperation['x-openai-isConsequential']).toBe(true);
    expect(canonOperation.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/BackstageCanonWriteRequest',
    });
    expect(Object.keys(canonOperation.responses)).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '413',
      '415',
      '429',
      '500',
      '503',
    ]);

    const readOperation = contract.paths[
      '/gpt-access/capabilities/v1/backstage-booker/universes/{universeId}'
    ].get;
    expect(readOperation.operationId).toBe('getBackstageUniverse');
    expect(readOperation.security).toEqual([{ bearerAuth: [] }]);
    expect(readOperation['x-openai-isConsequential']).toBe(false);
    expect(readOperation.requestBody).toBeUndefined();
    expect(readOperation.parameters).toEqual([
      expect.objectContaining({
        name: 'universeId',
        in: 'path',
        required: true,
        schema: { $ref: '#/components/schemas/UniverseReadId' },
      }),
    ]);
    expect(readOperation.parameters[0].example).toBe('legacy-demo-universe');
    expect(Object.keys(readOperation.responses)).toEqual([
      '200',
      '400',
      '401',
      '409',
      '429',
      '500',
      '503',
    ]);
    const storylineReadOperation = contract.paths[
      '/gpt-access/capabilities/v1/backstage-booker/universes/{universeId}/storyline-summary'
    ].get;
    expect(storylineReadOperation.operationId)
      .toBe('getBackstageStoryline');
    expect(storylineReadOperation.security).toEqual([{ bearerAuth: [] }]);
    expect(storylineReadOperation['x-openai-isConsequential']).toBe(false);
    expect(storylineReadOperation.requestBody).toBeUndefined();
    expect(storylineReadOperation.parameters).toEqual([
      expect.objectContaining({
        name: 'universeId',
        in: 'path',
        required: true,
        schema: { $ref: '#/components/schemas/UniverseReadId' },
      }),
      expect.objectContaining({
        name: 'storylineKey',
        in: 'query',
        required: true,
        schema: { $ref: '#/components/schemas/StorylineReadKey' },
      }),
      expect.objectContaining({
        name: 'offset',
        in: 'query',
        required: false,
        schema: expect.objectContaining({ default: 0, maximum: 10_000 }),
      }),
      expect.objectContaining({
        name: 'expectedVersion',
        in: 'query',
        required: false,
        schema: expect.objectContaining({ minimum: 1 }),
      }),
    ]);
    expect(storylineReadOperation.parameters[0].example)
      .toBe('legacy-demo-universe');
    expect(storylineReadOperation.parameters[1].example).toBe('demo-storyline');
    expect(Object.keys(storylineReadOperation.responses)).toEqual([
      '200',
      '400',
      '401',
      '404',
      '409',
      '429',
      '500',
      '503',
    ]);
    expect(contract.components.securitySchemes).toEqual({
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Opaque Backstage Booker access token',
        description:
          'Required by this configured Action for Backstage continuity queries, generation, simulation, exact reads, and canon writes. Configure ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN; it cannot authorize other GPT Access routes.',
      },
    });

    collectLocalRefs(contract).forEach((ref) => {
      expect(resolveLocalRef(contract, ref)).toBeDefined();
    });
  });

  it('stays within the ChatGPT Action metadata and response-size limits', () => {
    const contract = loadContract();
    const operationMethods = new Set([
      'get',
      'put',
      'post',
      'delete',
      'options',
      'head',
      'patch',
      'trace',
    ]);

    for (const pathItem of Object.values(contract.paths) as Array<Record<string, any>>) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!operationMethods.has(method)) continue;
        for (const field of ['summary', 'description'] as const) {
          if (typeof operation[field] === 'string') {
            expect(operation[field].length).toBeLessThanOrEqual(300);
          }
        }
        for (const parameter of operation.parameters ?? []) {
          if (typeof parameter.description === 'string') {
            expect(parameter.description.length).toBeLessThanOrEqual(700);
          }
        }
      }
    }

    expect(
      contract.components.schemas.BackstageUniverseReadResponseLimits.properties
        .serializedResultBytes.const
    ).toBeLessThan(100_000);
    const maximumStorylinePageEnvelope = {
      ok: true,
      result: {
        universeId: 'u'.repeat(128),
        source: 'postgresql',
        pageCodePointLimit: 4_000,
        storyline: {
          id: '11111111-1111-4111-8111-111111111111',
          key: 'k'.repeat(240),
          title: 't'.repeat(240),
          status: 'active',
          version: 2_147_483_647,
          universeRevision: '9223372036854775807',
          updatedAt: '2026-08-16T21:30:00.000Z',
        },
        summaryPage: {
          text: '🤼'.repeat(4_000),
          startCodePoint: 6_000,
          endCodePointExclusive: 10_000,
          totalCodePoints: 10_000,
          hasMore: false,
          nextOffset: null,
        },
      },
      requestId: 'r'.repeat(128),
      traceId: 't'.repeat(128),
    };
    expect(JSON.stringify(maximumStorylinePageEnvelope).length).toBeLessThan(100_000);
    expect(Buffer.byteLength(
      JSON.stringify(maximumStorylinePageEnvelope),
      'utf8'
    )).toBeLessThan(100_000);
  });

  it('keeps every public Builder example on the synchronous route', () => {
    const contract = loadContract();
    const validate = compileComponent(contract, 'BackstagePublicRequest');
    const examples = Object.values(
      contract.paths['/gpt/backstage-booker'].post.requestBody.content[
        'application/json'
      ].examples
    ) as Array<{ value: Record<string, unknown> }>;

    const requests = [
      ...examples.map((example) => example.value),
      {
        action: 'generateBookingWithHRC',
        executionMode: 'sync',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: 'Book a premium live event and evaluate the result.',
        },
      },
      {
        action: 'simulateMatch',
        executionMode: 'sync',
        payload: {
          universeId: 'backstage-demo',
          match: {
            wrestler1: 'Rhea Ripley',
            wrestler2: 'Bianca Belair',
            matchType: 'Singles',
            kayfabeMode: true,
          },
          rosters: [
            { name: 'Rhea Ripley', overall: 96 },
            { name: 'Bianca Belair', overall: 95 },
          ],
        },
      },
    ];

    for (const request of requests) {
      expect(request.executionMode).toBe('sync');
      expect({ valid: validate(request), errors: validate.errors }).toEqual({
        valid: true,
        errors: null,
      });
    }
    const subtreeExample = examples.find(example => (
      example.value.action === 'queryContinuity'
      && (example.value.payload as {
        retrievalScope?: { scopeKind?: string };
      } | undefined)?.retrievalScope?.scopeKind === 'subtree'
    ))?.value as {
      payload?: { retrievalScope?: Record<string, unknown> };
    } | undefined;
    expect(subtreeExample?.payload?.retrievalScope).toEqual(expect.objectContaining({
      pageTitle: 'Monday Night Raw',
      scopeKind: 'subtree',
    }));
    expect(subtreeExample?.payload?.retrievalScope).not.toHaveProperty('sectionPath');

    const asynchronousExample = {
      ...requests[0],
      executionMode: 'async',
    };
    expect(validate(asynchronousExample)).toBe(false);
    const missingExecutionMode = Object.fromEntries(
      Object.entries(requests[0]).filter(([key]) => key !== 'executionMode')
    );
    expect(validate(missingExecutionMode)).toBe(false);
    expect(validate({
      action: 'generateBooking',
      executionMode: 'sync',
      payload: { universeId: 'my-universe-2k26' },
    })).toBe(false);
    expect(validate({
      action: 'generateBooking',
      executionMode: 'sync',
      payload: {
        prompt: 'Review Raw.',
        match: {
          wrestler1: 'Rhea Ripley',
          wrestler2: 'Bianca Belair',
          matchType: 'Singles',
        },
      },
    })).toBe(false);
    expect(validate({
      action: 'simulateMatch',
      executionMode: 'sync',
      payload: { prompt: 'Simulate this match.' },
    })).toBe(false);
    expect(validate({
      action: 'simulateMatch',
      executionMode: 'sync',
      payload: {
        match: {
          wrestler1: 'Rhea Ripley',
          wrestler2: 'Bianca Belair',
          matchType: 'Singles',
        },
      },
    })).toBe(false);
  });

  it('publishes a closed, scoped, paginated queryContinuity contract', () => {
    const contract = loadContract();
    const schemas = contract.components.schemas;
    const validateRequest = compileComponent(contract, 'BackstagePublicRequest');
    const validateSuccess = compileComponent(
      contract,
      'BackstagePublicSuccessResponse'
    );
    const request = {
      action: 'queryContinuity',
      executionMode: 'sync',
      payload: {
        universeId: 'my-universe-2k26',
        query: 'List every current Monday Night Raw champion.',
        retrievalScope: {
          pageTitle: 'Monday Night Raw',
          pagePath: ['My Universe 2K26', 'Monday Night Raw'],
          sectionPath: ['Championships'],
        },
        retrievalMode: 'complete_scope',
        cursor: 'continuity-page-2',
      },
    };
    const result = {
      universeId: 'my-universe-2k26',
      authority: 'notion',
      answer: 'CM Punk is the World Heavyweight Champion.',
      resolvedScope: request.payload.retrievalScope,
      coverage: {
        status: 'sampled',
        scopeChunks: 12,
        selectedChunks: 8,
        omittedChunks: 4,
        promptTruncated: false,
        exhaustive: false,
        hasMore: true,
        nextCursor: 'continuity-page-3',
      },
      sources: [{
        sourceId: 'a'.repeat(64),
        pageTitle: 'Monday Night Raw',
        pagePath: ['My Universe 2K26', 'Monday Night Raw'],
        headingPath: ['Championships'],
        category: 'championships',
        contentHash: 'b'.repeat(64),
      }],
    };
    const subtreeRequest = {
      action: 'queryContinuity',
      executionMode: 'sync',
      payload: {
        universeId: 'my-universe-2k26',
        query: 'Summarize the complete Monday Night Raw hierarchy.',
        retrievalScope: {
          pageTitle: 'Monday Night Raw',
          pagePath: ['My Universe 2K26', 'Monday Night Raw'],
          scopeKind: 'subtree',
        },
        retrievalMode: 'complete_scope',
      },
    };
    const subtreeResult = {
      ...result,
      resolvedScope: subtreeRequest.payload.retrievalScope,
      coverage: {
        status: 'sampled',
        scopeChunks: 24,
        selectedChunks: 8,
        omittedChunks: 16,
        scopePages: 4,
        selectedPages: 2,
        omittedPages: 2,
        promptTruncated: false,
        exhaustive: false,
        hasMore: true,
        nextCursor: 'continuity-subtree-page-2',
      },
    };

    expect({ valid: validateRequest(request), errors: validateRequest.errors })
      .toEqual({ valid: true, errors: null });
    expect({
      valid: validateRequest(subtreeRequest),
      errors: validateRequest.errors,
    }).toEqual({ valid: true, errors: null });
    expect(validateRequest({
      action: 'queryContinuity',
      executionMode: 'sync',
      payload: {
        universeId: 'my-universe-2k26',
        query: 'Summarize the complete universe in bounded pages.',
        retrievalMode: 'complete_scope',
      },
    })).toBe(true);
    const envelope = {
      ok: true,
      result,
      _route: {
        gptId: 'backstage-booker',
        module: 'BACKSTAGE:BOOKER',
        route: 'backstage-booker',
        action: 'queryContinuity',
        timestamp: '2026-08-19T16:00:00.000Z',
      },
    };
    expect({ valid: validateSuccess(envelope), errors: validateSuccess.errors })
      .toEqual({ valid: true, errors: null });
    expect({
      valid: validateSuccess({ ...envelope, result: subtreeResult }),
      errors: validateSuccess.errors,
    }).toEqual({ valid: true, errors: null });

    for (const payload of [
      { query: request.payload.query },
      { universeId: request.payload.universeId },
      { ...request.payload, retrievalMode: 'everything' },
      { ...request.payload, retrievalMode: 'relevant' },
      {
        universeId: request.payload.universeId,
        query: request.payload.query,
        cursor: request.payload.cursor,
      },
      { ...request.payload, retrievalScope: { sectionPath: ['Championships'] } },
      {
        ...request.payload,
        retrievalScope: {
          pageTitle: 'Monday Night Raw',
          pageId: '00000000-0000-4000-8000-000000000000',
        },
      },
      {
        ...subtreeRequest.payload,
        retrievalScope: {
          ...subtreeRequest.payload.retrievalScope,
          sectionPath: ['Championships'],
        },
      },
      {
        ...subtreeRequest.payload,
        retrievalScope: {
          ...subtreeRequest.payload.retrievalScope,
          scopeKind: 'descendants',
        },
      },
    ]) {
      expect(validateRequest({ ...request, payload })).toBe(false);
    }

    expect(validateSuccess({
      ...envelope,
      result: {
        ...result,
        coverage: { ...result.coverage, nextCursor: undefined },
      },
    })).toBe(false);
    expect(validateSuccess({
      ...envelope,
      result: {
        ...result,
        coverage: {
          ...result.coverage,
          scopePages: 1,
          selectedPages: 1,
          omittedPages: 0,
        },
      },
    })).toBe(false);
    expect(validateSuccess({
      ...envelope,
      result: {
        ...subtreeResult,
        coverage: {
          ...subtreeResult.coverage,
          omittedPages: undefined,
        },
      },
    })).toBe(false);
    expect(validateSuccess({
      ...envelope,
      result: {
        ...subtreeResult,
        resolvedScope: {
          ...subtreeResult.resolvedScope,
          sectionPath: ['Championships'],
        },
      },
    })).toBe(false);
    expect(validateSuccess({
      ...envelope,
      result: {
        ...result,
        resolvedScope: {
          ...result.resolvedScope,
          scopeKind: 'page',
        },
      },
    })).toBe(false);
    expect(validateSuccess({
      ...envelope,
      result: {
        ...result,
        sources: [{
          ...result.sources[0]!,
          pageId: '00000000-0000-4000-8000-000000000000',
        }],
      },
    })).toBe(false);

    expect(schemas.QueryContinuityPayload.required).toEqual([
      'universeId',
      'query',
    ]);
    expect(schemas.ContinuityRetrievalScope.required).toEqual(['pageTitle']);
    expect(schemas.ContinuityScopeKind).toEqual({
      type: 'string',
      enum: ['page', 'subtree'],
      default: 'page',
    });
    expect(schemas.ContinuityResolvedScope.required).toEqual([
      'pageTitle',
      'pagePath',
    ]);
    expect(schemas.ContinuityResolvedScope.properties.scopeKind).toEqual({
      const: 'subtree',
    });
    expect(schemas.ContinuityRetrievalMode.enum).toEqual([
      'relevant',
      'complete_scope',
    ]);
    expect(schemas.ContinuitySource.properties.headingPath.maxItems).toBe(32);
    expect(schemas.QueryContinuityResult.required).toEqual([
      'universeId',
      'authority',
      'answer',
      'coverage',
      'sources',
    ]);
    expect(schemas.ContinuityCoverage.required).toEqual([
      'status',
      'scopeChunks',
      'selectedChunks',
      'omittedChunks',
      'promptTruncated',
      'exhaustive',
      'hasMore',
    ]);
    expect(schemas.ContinuityCoverage.dependentRequired).toEqual({
      scopePages: ['selectedPages', 'omittedPages'],
      selectedPages: ['scopePages', 'omittedPages'],
      omittedPages: ['scopePages', 'selectedPages'],
    });
    expect(JSON.stringify({
      action: schemas.QueryContinuityActionRequest,
      payload: schemas.QueryContinuityPayload,
      result: schemas.QueryContinuityResult,
      source: schemas.ContinuitySource,
    })).not.toContain('pageId');

    const protocolRequest = loadProtocolSchema(
      'queryContinuity.request.schema.json'
    );
    const protocolCommon = loadProtocolSchema('common.schema.json');
    const protocolResponse = loadProtocolSchema(
      'queryContinuity.response.schema.json'
    );
    expect(schemas.QueryContinuityPayload.required).toEqual(protocolRequest.required);
    expect(schemas.QueryContinuityPayload.properties.query).toEqual(
      protocolRequest.properties.query
    );
    expect(schemas.ContinuityScopeKind).toEqual(
      protocolCommon.$defs.continuityScopeKind
    );
    expect(schemas.QueryContinuityResult.required).toEqual(protocolResponse.required);
  });

  it('publishes the safe closed Notion scope and cursor error details', () => {
    const contract = loadContract();
    const validateError = compileComponent(contract, 'BackstagePublicErrorResponse');
    const operation = contract.paths['/gpt/backstage-booker'].post;

    expect(validateError({
      ok: false,
      error: {
        code: 'BACKSTAGE_NOTION_SCOPE_UNRESOLVED',
        message: 'The requested Backstage Notion scope is ambiguous.',
        details: {
          retryable: false,
          reason: 'ambiguous',
        },
      },
    })).toBe(true);
    expect(validateError({
      ok: false,
      error: {
        code: 'BACKSTAGE_NOTION_SCOPE_UNRESOLVED',
        message: 'The requested Backstage Notion scope was not found.',
        details: {
          retryable: false,
          reason: 'provider-secret',
        },
      },
    })).toBe(false);
    expect(validateError({
      ok: false,
      error: {
        code: 'BACKSTAGE_NOTION_CURSOR_INVALID',
        message: 'The Backstage continuity cursor is invalid or no longer applies. Restart the scoped read without a cursor.',
        details: {
          retryable: false,
        },
      },
    })).toBe(true);
    expect(operation.responses['409'].description).toContain('cursor');
    expect(operation.responses['409'].description).toContain('without a cursor');
    expect(operation.responses['409'].description).toContain(
      'repeated heading occurrences'
    );
    expect(operation.responses['500'].description).toContain(
      'BACKSTAGE_CONTINUITY_QUERY_FAILED'
    );
    expect(operation.responses['500'].description).toContain(
      'BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE'
    );
  });

  it('keeps the exact-ID universe read closed, bounded, and non-consequential', () => {
    const contract = loadContract();
    const schemas = contract.components.schemas;
    const operation = contract.paths[
      '/gpt-access/capabilities/v1/backstage-booker/universes/{universeId}'
    ].get;
    const validateSuccess = compileComponent(
      contract,
      'BackstageUniverseReadSuccessResponse'
    );
    const emptySnapshot: any = {
      ok: true,
      result: {
        universeId: 'my-universe-2k26',
        source: 'postgresql',
        hasPersistedData: false,
        sourceQueryLimits: {
          roster: 25,
          recentEvents: 5,
          recentStoryBeats: 5,
          savedStorylines: 5,
          canonStorylines: 50,
          activeCanonBeats: 100,
        },
        responseLimits: {
          roster: 25,
          recentEvents: 5,
          recentStoryBeats: 5,
          savedStorylines: 5,
          canonStorylines: 8,
          activeCanonBeats: 12,
          participantNamesPerItem: 10,
          canonSummaryCodePoints: 1000,
          legacySummaryCodePoints: 500,
          savedStorylineCodePoints: 1500,
          serializedResultBytes: 61440,
        },
        truncation: {
          truncated: false,
          sections: [],
          omittedItems: {
            roster: 0,
            recentEvents: 0,
            recentStoryBeats: 0,
            savedStorylines: 0,
            canonStorylines: 0,
            activeCanonBeats: 0,
            participantNames: 0,
          },
        },
        snapshot: {
          roster: [],
          recentEvents: [],
          recentStoryBeats: [],
          savedStorylines: [],
          canon: {
            revision: '0',
            storylines: [],
            activeBeats: [],
          },
        },
      },
    };

    expect({
      valid: validateSuccess(emptySnapshot),
      errors: validateSuccess.errors,
    }).toEqual({ valid: true, errors: null });

    const populatedSnapshot = structuredClone(emptySnapshot);
    populatedSnapshot.result.hasPersistedData = true;
    populatedSnapshot.result.snapshot.canon.revision = '6';
    populatedSnapshot.result.snapshot.roster.push({
      name: 'Becky Lynch',
      overall: 94,
    });
    populatedSnapshot.result.snapshot.canon.storylines.push({
      id: '11111111-1111-4111-8111-111111111111',
      key: 'raw-main-event',
      title: 'Raw Main Event',
      summary: 'Becky Lynch faces Lyra Valkyria.',
      status: 'active',
      participantNames: ['Becky Lynch', 'Lyra Valkyria'],
      version: 5,
      universeRevision: '6',
      createdAt: '2026-08-16T20:00:00.000Z',
      updatedAt: '2026-08-16T21:00:00.000Z',
      closedAt: null,
    });
    expect({
      valid: validateSuccess(populatedSnapshot),
      errors: validateSuccess.errors,
    }).toEqual({ valid: true, errors: null });

    const overLimit = structuredClone(emptySnapshot);
    overLimit.result.snapshot.canon.storylines = Array.from(
      { length: 9 },
      () => populatedSnapshot.result.snapshot.canon.storylines[0]!
    );
    expect(validateSuccess(overLimit)).toBe(false);
    expect(validateSuccess({
      ...emptySnapshot,
      unexpected: true,
    })).toBe(false);

    expect(schemas.BackstageUniverseReadSnapshot.properties).toEqual(
      expect.objectContaining({
        roster: expect.objectContaining({ maxItems: 25 }),
        recentEvents: expect.objectContaining({ maxItems: 5 }),
        recentStoryBeats: expect.objectContaining({ maxItems: 5 }),
        savedStorylines: expect.objectContaining({ maxItems: 5 }),
      })
    );
    expect(schemas.BackstageUniverseReadCanonContext.properties).toEqual(
      expect.objectContaining({
        storylines: expect.objectContaining({ maxItems: 8 }),
        activeBeats: expect.objectContaining({ maxItems: 12 }),
      })
    );
    expect(schemas.BackstageUniverseReadParticipantNames.maxItems).toBe(10);
    expect(schemas.BackstageUniverseReadSourceLimits.description)
      .toContain('windows, not total counts');
    expect(schemas.BackstageUniverseReadTruncation.description)
      .toContain('excludes older rows outside sourceQueryLimits');
    const truncationSections = schemas.BackstageUniverseReadTruncation
      .properties.sections;
    expect(truncationSections.maxItems).toBe(truncationSections.items.enum.length);
    expect(truncationSections.items.enum).toEqual(expect.arrayContaining([
      'snapshot.roster.name',
      'snapshot.savedStorylines.key',
      'snapshot.canon.storylines.key',
      'snapshot.canon.storylines.title',
      'snapshot.canon.activeBeats.storylineKey',
    ]));
    expect(
      schemas.BackstageUniverseReadCanonStoryline.properties.summary.oneOf[0]
        .maxLength
    ).toBe(1000);
    expect(
      schemas.BackstageUniverseReadSavedStoryline.properties.storylineExcerpt
        .maxLength
    ).toBe(1500);

    for (const response of Object.values(operation.responses) as any[]) {
      expect(response.headers['Cache-Control']).toEqual({
        $ref: '#/components/headers/NoStore',
      });
    }
    expect(JSON.stringify(operation)).not.toContain('confirmation');
  });

  it('validates the real exact storyline reader against its paginated response schema', async () => {
    const contract = loadContract();
    const operation = contract.paths[
      '/gpt-access/capabilities/v1/backstage-booker/universes/{universeId}/storyline-summary'
    ].get;
    const validateSuccess = compileComponent(
      contract,
      'BackstageStorylineSummaryReadSuccessResponse'
    );
    const storylineKey = 'raw/day one?100% + 🎤';
    const summary = '🤼'.repeat(10_000);
    const storyline: BackstageCanonStorylineSummaryRecord = {
      id: '11111111-1111-4111-8111-111111111111',
      universeId: 'my-universe-2k26',
      storyKey: storylineKey,
      title: 'Monday Night Raw Day One',
      summary,
      status: 'active',
      version: 5,
      createdRevision: '1',
      updatedRevision: '6',
      createdAt: new Date('2026-08-16T20:30:00.000Z'),
      updatedAt: new Date('2026-08-16T21:30:00.000Z'),
      closedAt: null,
    };
    const result = await readBackstageStorylineSummary(
      'my-universe-2k26',
      storylineKey,
      {
        authorityResolver: async () => false,
        reader: { loadCanonStorylineSummary: async () => storyline },
      }
    );
    const envelope = {
      ok: true,
      result,
      requestId: 'r'.repeat(128),
      traceId: 't'.repeat(128),
    };

    expect({ valid: validateSuccess(envelope), errors: validateSuccess.errors })
      .toEqual({ valid: true, errors: null });
    expect(Array.from(result.summaryPage.text!)).toHaveLength(4_000);
    expect(result.summaryPage.nextOffset).toBe(4_000);
    expect(
      contract.components.schemas.BackstageStorylineSummaryPage.properties.text
        .oneOf[0].maxLength
    ).toBe(4_000);
    for (const response of Object.values(operation.responses) as any[]) {
      expect(response.headers['Cache-Control']).toEqual({
        $ref: '#/components/headers/NoStore',
      });
    }
    expect(JSON.stringify(operation)).not.toContain('confirmation');
  });

  it('validates real empty, populated, and truncated read projections', async () => {
    const contract = loadContract();
    const validateSuccess = compileComponent(
      contract,
      'BackstageUniverseReadSuccessResponse'
    );
    const universeId = 'my-universe-2k26';
    const baseContext = (): BackstageContext => ({
      roster: [],
      events: [],
      storyBeats: [],
      storylines: [],
      canonContext: {
        universeId,
        revision: '0',
        storylines: [],
        activeBeats: [],
      },
    });
    const populated = baseContext();
    populated.roster.push({ name: 'Becky Lynch', overall: 94 });
    populated.canonContext.revision = '6';
    populated.canonContext.storylines.push({
      id: '11111111-1111-4111-8111-111111111111',
      universeId,
      storyKey: 'raw-main-event',
      title: 'Raw Main Event',
      summary: 'Becky Lynch faces Lyra Valkyria.',
      status: 'active',
      version: 5,
      participantNames: ['Becky Lynch', 'Lyra Valkyria'],
      createdRevision: '1',
      updatedRevision: '6',
      createdAt: new Date('2026-08-16T20:00:00.000Z'),
      updatedAt: new Date('2026-08-16T21:00:00.000Z'),
      closedAt: null,
    });
    const truncated = baseContext();
    truncated.canonContext.revision = '50';
    truncated.canonContext.storylines = Array.from({ length: 50 }, (_, index) => ({
      id: '11111111-1111-4111-8111-111111111111',
      universeId,
      storyKey: `story-${index}`,
      title: `Story ${index}`,
      summary: 'x'.repeat(10_000),
      status: 'active' as const,
      version: 1,
      participantNames: Array.from({ length: 20 }, (_unused, participantIndex) =>
        `Wrestler ${participantIndex}`
      ),
      createdRevision: '1',
      updatedRevision: '50',
      createdAt: new Date('2026-08-16T20:00:00.000Z'),
      updatedAt: new Date('2026-08-16T21:00:00.000Z'),
      closedAt: null,
    }));

    for (const context of [baseContext(), populated, truncated]) {
      const result = await readBackstageUniverse(universeId, {
        authorityResolver: async () => false,
        reader: { loadContext: async () => context },
      });
      const envelope = {
        ok: true,
        result,
        requestId: 'r'.repeat(128),
        traceId: 't'.repeat(128),
      };
      expect({ valid: validateSuccess(envelope), errors: validateSuccess.errors })
        .toEqual({ valid: true, errors: null });
      const serialized = JSON.stringify(envelope);
      expect(serialized.length).toBeLessThan(100_000);
      expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(100_000);
    }
  });

  it('keeps the authenticated request closed to the two Phase 2 canon actions', () => {
    const contract = loadContract();
    const schemas = contract.components.schemas;
    const canonRequest = schemas.BackstageCanonWriteRequest;

    expect(canonRequest).toEqual(expect.objectContaining({
      type: 'object',
      additionalProperties: false,
      required: ['action', 'payload'],
    }));
    expect(canonRequest.properties).toEqual({
      action: {
        type: 'string',
        enum: ['upsertStoryline', 'appendCanonBeat'],
      },
      payload: {
        type: 'object',
        description:
          'Action-specific canon mutation input. The selected action schema below enforces its required fields.',
        additionalProperties: false,
        properties: {
          universeId: { $ref: '#/components/schemas/UniverseId' },
          mutationId: { $ref: '#/components/schemas/Uuid' },
          expectedVersion: {
            type: 'integer',
            minimum: 0,
            maximum: 2147483647,
          },
          storyline: { $ref: '#/components/schemas/StorylineInput' },
          storylineKey: { $ref: '#/components/schemas/StorylineKey' },
          beat: { $ref: '#/components/schemas/CanonBeatInput' },
          nextStatus: { $ref: '#/components/schemas/StorylineStatus' },
        },
      },
    });
    expect(canonRequest.oneOf).toEqual([
      { $ref: '#/components/schemas/UpsertStorylineActionRequest' },
      { $ref: '#/components/schemas/AppendCanonBeatActionRequest' },
    ]);
    expect(actionEnumsForOneOf(contract, 'BackstageCanonWriteRequest')).toEqual([
      'upsertStoryline',
      'appendCanonBeat',
    ]);
    const validateCanonRequest = compileComponent(
      contract,
      'BackstageCanonWriteRequest'
    );
    expect(
      contract.paths['/gpt-access/capabilities/v1/backstage-booker/run']
        .post.requestBody.content['application/json']
    ).not.toHaveProperty('examples');
    const canonRequests = [
      {
        action: 'upsertStoryline',
        payload: {
          universeId: 'legacy-demo-universe',
          mutationId: '5d87478f-57a3-45e0-9d5a-6b9d56e94ec8',
          expectedVersion: 0,
          storyline: {
            key: 'demo-storyline',
            title: 'Demo Storyline',
            summary: 'Illustrative legacy canon for a non-authoritative universe.',
            status: 'active',
            participantNames: [],
          },
        },
      },
      {
        action: 'appendCanonBeat',
        payload: {
          universeId: 'legacy-demo-universe',
          mutationId: '9c3d1957-9f45-4a9c-99e7-f0b9022d7a4c',
          storylineKey: 'demo-storyline',
          expectedVersion: 1,
          beat: {
            kind: 'development',
            summary: 'The challenger interrupts the champion.',
            occurredAt: '2026-08-15T20:00:00Z',
            participantNames: [],
          },
        },
      },
    ];
    for (const request of canonRequests) {
      expect({
        valid: validateCanonRequest(request),
        errors: validateCanonRequest.errors,
      }).toEqual({ valid: true, errors: null });
      expect(JSON.stringify(request)).not.toContain('my-universe-2k26');
    }

    for (const schemaName of [
      'UpsertStorylineActionRequest',
      'AppendCanonBeatActionRequest',
    ]) {
      expect(schemas[schemaName]).toEqual(expect.objectContaining({
        type: 'object',
        additionalProperties: false,
        required: ['action', 'payload'],
      }));
      expect(Object.keys(schemas[schemaName].properties)).toEqual([
        'action',
        'payload',
      ]);
    }

    const protectedSchemaText = JSON.stringify({
      request: schemas.BackstageCanonWriteRequest,
      upsertAction: schemas.UpsertStorylineActionRequest,
      appendAction: schemas.AppendCanonBeatActionRequest,
      upsertPayload: schemas.UpsertStorylinePayload,
      appendPayload: schemas.AppendCanonBeatPayload,
    });
    for (const legacyAction of [
      'bookEvent',
      'updateRoster',
      'trackStoryline',
      'saveStoryline',
      'generateBooking',
      'generateBookingWithHRC',
      'queryContinuity',
      'simulateMatch',
    ]) {
      expect(protectedSchemaText).not.toContain(legacyAction);
    }
    expect(JSON.stringify(contract)).not.toContain('confirmation_token');
    expect(JSON.stringify(contract)).not.toContain('confirmationChallenge');
  });

  it('mirrors the canonical Phase 2 request constraints', () => {
    const contract = loadContract();
    const schemas = contract.components.schemas;
    const common = loadProtocolSchema('common.schema.json');
    const canon = loadProtocolSchema('canon.schema.json');
    const upsert = loadProtocolSchema('upsertStoryline.request.schema.json');
    const append = loadProtocolSchema('appendCanonBeat.request.schema.json');

    expect(schemas.UniverseId).toEqual(common.$defs.universeId);
    expect(schemas.UniverseReadId).toEqual({
      type: common.$defs.universeId.type,
      minLength: common.$defs.universeId.minLength,
      maxLength: common.$defs.universeId.maxLength,
      pattern: common.$defs.universeId.pattern,
    });
    expect(schemas.UniverseReadId).not.toHaveProperty('default');
    expect(schemas.Uuid.pattern).toBe(canon.$defs.uuid.pattern);
    expect(schemas.UtcTimestamp.pattern).toBe(canon.$defs.utcTimestamp.pattern);
    expect(schemas.StorylineStatus.enum).toEqual(canon.$defs.storylineStatus.enum);
    expect(schemas.ParticipantNames).toEqual(expect.objectContaining({
      type: canon.$defs.participantNames.type,
      maxItems: canon.$defs.participantNames.maxItems,
      uniqueItems: canon.$defs.participantNames.uniqueItems,
    }));
    expect(schemas.WrestlerName).toEqual(expect.objectContaining({
      type: common.$defs.wrestlerName.type,
      minLength: common.$defs.wrestlerName.minLength,
      maxLength: common.$defs.wrestlerName.maxLength,
      pattern: common.$defs.wrestlerName.pattern,
    }));

    expect(schemas.UpsertStorylinePayload).toEqual(expect.objectContaining({
      type: 'object',
      additionalProperties: false,
      required: upsert.required,
    }));
    expect(Object.keys(schemas.UpsertStorylinePayload.properties)).toEqual(
      Object.keys(upsert.properties)
    );
    expect(schemas.UpsertStorylinePayload.properties.expectedVersion).toEqual(
      upsert.properties.expectedVersion
    );
    expect(schemas.UpsertStorylinePayload.required).toContain('universeId');
    expect(schemas.UpsertStorylinePayload.required).toContain('mutationId');

    expect(schemas.AppendCanonBeatPayload).toEqual(expect.objectContaining({
      type: 'object',
      additionalProperties: false,
      required: append.required,
    }));
    expect(Object.keys(schemas.AppendCanonBeatPayload.properties)).toEqual(
      Object.keys(append.properties)
    );
    expect(schemas.AppendCanonBeatPayload.properties.expectedVersion).toEqual(
      append.properties.expectedVersion
    );
    expect(schemas.AppendCanonBeatPayload.required).toContain('universeId');
    expect(schemas.AppendCanonBeatPayload.required).toContain('mutationId');

    expect(schemas.StorylineInput).toEqual(expect.objectContaining({
      type: 'object',
      additionalProperties: false,
      required: canon.$defs.storylineInput.required,
    }));
    expect(Object.keys(schemas.StorylineInput.properties)).toEqual(
      Object.keys(canon.$defs.storylineInput.properties)
    );
    expect(schemas.StorylineKey).toEqual(expect.objectContaining({
      minLength: canon.$defs.storylineKey.minLength,
      maxLength: canon.$defs.storylineKey.maxLength,
      pattern: canon.$defs.storylineKey.pattern,
    }));
    const validateStorylineReadKey = compileComponent(
      contract,
      'StorylineReadKey'
    );
    expect(validateStorylineReadKey('raw/day one?100% + 🎤')).toBe(true);
    expect(validateStorylineReadKey(' raw-day-one-baseline')).toBe(false);
    expect(validateStorylineReadKey('raw-day-one-baseline ')).toBe(false);
    expect(schemas.StorylineTitle).toEqual(expect.objectContaining({
      minLength: canon.$defs.storylineTitle.minLength,
      maxLength: canon.$defs.storylineTitle.maxLength,
      pattern: canon.$defs.storylineTitle.pattern,
    }));
    expect(schemas.StorylineSummary.oneOf[0].maxLength).toBe(
      canon.$defs.storylineSummary.oneOf[0].maxLength
    );

    expect(schemas.CanonBeatInput).toEqual(expect.objectContaining({
      type: 'object',
      additionalProperties: false,
      required: canon.$defs.canonBeatInput.required,
    }));
    expect(Object.keys(schemas.CanonBeatInput.properties)).toEqual(
      Object.keys(canon.$defs.canonBeatInput.properties)
    );
    expect(schemas.CanonBeatKind).toEqual(canon.$defs.canonBeatKind);
    expect(schemas.CanonBeatSummary).toEqual(expect.objectContaining({
      minLength: canon.$defs.canonBeatSummary.minLength,
      maxLength: canon.$defs.canonBeatSummary.maxLength,
      pattern: canon.$defs.canonBeatSummary.pattern,
    }));
  });

  it('preserves the public and capability response envelopes', () => {
    const contract = loadContract();
    const schemas = contract.components.schemas;
    const publicOperation = contract.paths['/gpt/backstage-booker'].post;
    const canonOperation = contract.paths[
      '/gpt-access/capabilities/v1/backstage-booker/run'
    ].post;

    expect(publicOperation.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/BackstagePublicSuccessResponse',
    });
    for (const status of ['400', '404', '409', '503', '504']) {
      expect(publicOperation.responses[status].content['application/json'].schema)
        .toEqual({
          $ref: '#/components/schemas/BackstagePublicErrorResponse',
        });
    }
    expect(schemas.BackstagePublicSuccessResponse).toEqual(expect.objectContaining({
      type: 'object',
      additionalProperties: true,
      required: ['ok', 'result', '_route'],
    }));
    const validatePublicSuccess = compileComponent(
      contract,
      'BackstagePublicSuccessResponse'
    );
    const validatePublicError = compileComponent(
      contract,
      'BackstagePublicErrorResponse'
    );
    const runtimeEnvelope = {
      ok: true,
      result: {
        universeId: 'my-universe-2k26',
        storyline: 'The champion answers the challenger.',
      },
      _route: {
        requestId: 'request-backstage-public',
        traceId: 'trace-backstage-public',
        gptId: 'backstage-booker',
        module: 'BACKSTAGE:BOOKER',
        route: 'backstage-booker',
        action: 'generateBooking',
        timestamp: '2026-08-15T20:00:00.000Z',
      },
    };
    expect({
      valid: validatePublicSuccess(runtimeEnvelope),
      errors: validatePublicSuccess.errors,
    }).toEqual({
      valid: true,
      errors: null,
    });
    const notionUnavailableEnvelope = {
      ok: false,
      error: {
        code: 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE',
        message:
          'The authoritative Backstage Notion index is temporarily unavailable.',
        details: { retryable: true },
      },
      requestId: 'request-notion-index-unavailable',
      traceId: 'trace-notion-index-unavailable',
      _route: runtimeEnvelope._route,
    };
    expect({
      valid: validatePublicError(notionUnavailableEnvelope),
      errors: validatePublicError.errors,
    }).toEqual({ valid: true, errors: null });
    expect(schemas.BackstageRouteMeta.properties.action.enum).toEqual([
      'generateBooking',
      'generateBookingWithHRC',
      'queryContinuity',
      'simulateMatch',
    ]);

    expect(canonOperation.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/BackstageCanonWriteSuccessResponse',
    });
    expect(schemas.BackstageCanonWriteSuccessResponse.oneOf).toEqual([
      { $ref: '#/components/schemas/UpsertStorylineSuccessEnvelope' },
      { $ref: '#/components/schemas/AppendCanonBeatSuccessEnvelope' },
    ]);
    for (const envelopeName of [
      'UpsertStorylineSuccessEnvelope',
      'AppendCanonBeatSuccessEnvelope',
    ]) {
      expect(schemas[envelopeName]).toEqual(expect.objectContaining({
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'result'],
      }));
      expect(schemas[envelopeName].properties.ok.enum).toEqual([true]);
    }
    for (const status of [
      '400',
      '401',
      '404',
      '409',
      '413',
      '415',
      '500',
      '503',
    ]) {
      expect(canonOperation.responses[status].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/BackstageCanonErrorResponse',
      });
    }
    expect(publicOperation.responses['500'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/BackstagePublicErrorResponse',
    });
    expect(canonOperation.responses['403'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/BackstageCanonForbiddenResponse',
    });
    expect(canonOperation.responses['429'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/RateLimitResponse',
    });
    expect(schemas.BackstageCanonErrorResponse).toEqual(expect.objectContaining({
      type: 'object',
      additionalProperties: true,
      required: ['ok', 'error'],
    }));
    expect(schemas.BackstageCanonErrorResponse.properties.ok.enum).toEqual([false]);
    expect(schemas.BackstageCanonForbiddenResponse.oneOf).toEqual([
      { $ref: '#/components/schemas/BackstageCanonErrorResponse' },
      { $ref: '#/components/schemas/BackstageGenericConfirmationMismatchResponse' },
    ]);
    expect(schemas.BackstageGenericConfirmationMismatchResponse).toEqual(
      expect.objectContaining({
        type: 'object',
        additionalProperties: true,
        required: [
          'error',
          'message',
          'code',
          'confirmationRequired',
          'confirmationStatus',
        ],
      })
    );
    expect(schemas.BackstageGenericConfirmationMismatchResponse.properties.code)
      .toEqual({
        type: 'string',
        enum: ['CONFIRMATION_REQUIRED'],
      });
    expect(
      schemas.BackstageGenericConfirmationMismatchResponse.properties
        .confirmationRequired
    ).toEqual({
      type: 'boolean',
      enum: [true],
    });
    const missingStorylineEnvelope = {
      ok: false,
      error: {
        code: 'BACKSTAGE_STORYLINE_NOT_FOUND',
        message: 'The requested Backstage storyline was not found.',
      },
    };
    const validateCanonError = compileComponent(
      contract,
      'BackstageCanonErrorResponse'
    );
    expect({
      valid: validateCanonError(missingStorylineEnvelope),
      errors: validateCanonError.errors,
    }).toEqual({
      valid: true,
      errors: null,
    });

    const validateForbidden = compileComponent(
      contract,
      'BackstageCanonForbiddenResponse'
    );
    const dedicatedForbiddenEnvelope = {
      ok: false,
      error: {
        code: 'GPT_ACCESS_CAPABILITY_ACTION_DENIED',
        message: 'Capability action is not allowlisted for GPT Access execution.',
      },
    };
    expect({
      valid: validateForbidden(dedicatedForbiddenEnvelope),
      errors: validateForbidden.errors,
    }).toEqual({
      valid: true,
      errors: null,
    });
    const genericConfirmationEnvelope = {
      error: 'Confirmation required',
      message: 'This endpoint requires explicit human approval.',
      code: 'CONFIRMATION_REQUIRED',
      endpoint: '/capabilities/v1/backstage-booker/run',
      method: 'POST',
      gptId: null,
      confirmationRequired: true,
      confirmationStatus: 'pending',
      confirmationChallenge: {
        id: 'challenge-id',
      },
      timestamp: '2026-08-15T20:00:00.000Z',
    };
    expect({
      valid: validateForbidden(genericConfirmationEnvelope),
      errors: validateForbidden.errors,
    }).toEqual({
      valid: true,
      errors: null,
    });
    expect(validateForbidden({
      ...genericConfirmationEnvelope,
      confirmationRequired: false,
    })).toBe(false);

    expect(schemas.Storyline.required).toEqual(
      loadProtocolSchema('canon.schema.json').$defs.storyline.required
    );
    expect(schemas.CanonBeat.required).toEqual(
      loadProtocolSchema('canon.schema.json').$defs.canonBeat.required
    );
    expect(schemas.DurablePersistence.properties).toEqual(expect.objectContaining({
      status: { type: 'string', enum: ['durable'] },
      durable: { type: 'boolean', enum: [true] },
      backend: { type: 'string', enum: ['postgresql'] },
      degraded: { type: 'boolean', enum: [false] },
    }));
    expect(schemas.UnknownPersistence.properties.reason.enum).toEqual([
      'commit_outcome_unknown',
    ]);
  });
});

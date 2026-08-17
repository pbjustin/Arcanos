import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';

import type { BackstageContext } from '../../src/core/db/repositories/backstageBookerRepository.js';
import { readBackstageUniverse } from '../../src/services/backstageUniverseRead.js';

const contractPath = join(
  process.cwd(),
  'contracts/backstage_booker.openapi.v1.json'
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
  it('exposes only the fixed public, exact-ID read, and canon-write operations', () => {
    const contract = loadContract();

    expect(contract.openapi).toBe('3.1.0');
    expect(contract.info.version).toBe('1.1.0');
    expect(contract.servers).toEqual([
      {
        url: 'https://acranos-production.up.railway.app',
        description: 'Canonical ARCANOS production deployment',
      },
    ]);
    expect(contract.security).toBeUndefined();
    expect(Object.keys(contract.paths)).toEqual([
      '/gpt/backstage-booker',
      '/gpt-access/capabilities/v1/backstage-booker/run',
      '/gpt-access/capabilities/v1/backstage-booker/universes/{universeId}',
    ]);

    const publicOperation = contract.paths['/gpt/backstage-booker'].post;
    expect(publicOperation.operationId).toBe('runBackstageBooker');
    expect(publicOperation.security).toBeUndefined();
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
        enum: ['generateBooking', 'generateBookingWithHRC', 'simulateMatch'],
      },
      executionMode: {
        $ref: '#/components/schemas/BackstagePublicExecutionMode',
      },
      payload: { type: 'object' },
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
      'simulateMatch',
    ]);
    expect(Object.keys(publicOperation.responses)).toEqual([
      '200',
      '400',
      '429',
      '500',
      '503',
      '504',
    ]);

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
    expect(Object.keys(readOperation.responses)).toEqual([
      '200',
      '400',
      '401',
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
          'Required only for the fixed Backstage Booker exact-ID universe-read and canon-write operations. Configure ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN; this purpose-bound credential cannot authorize other GPT Access routes.',
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
    ];

    for (const request of requests) {
      expect(request.executionMode).toBe('sync');
      expect({ valid: validate(request), errors: validate.errors }).toEqual({
        valid: true,
        errors: null,
      });
    }

    const asynchronousExample = {
      ...requests[0],
      executionMode: 'async',
    };
    expect(validate(asynchronousExample)).toBe(false);
    const missingExecutionMode = Object.fromEntries(
      Object.entries(requests[0]).filter(([key]) => key !== 'executionMode')
    );
    expect(validate(missingExecutionMode)).toBe(false);
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
      payload: { type: 'object' },
    });
    expect(canonRequest.oneOf).toEqual([
      { $ref: '#/components/schemas/UpsertStorylineActionRequest' },
      { $ref: '#/components/schemas/AppendCanonBeatActionRequest' },
    ]);
    expect(actionEnumsForOneOf(contract, 'BackstageCanonWriteRequest')).toEqual([
      'upsertStoryline',
      'appendCanonBeat',
    ]);

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
    for (const status of ['400', '503', '504']) {
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
    expect(schemas.BackstageRouteMeta.properties.action.enum).toEqual([
      'generateBooking',
      'generateBookingWithHRC',
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

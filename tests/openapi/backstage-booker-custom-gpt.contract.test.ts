import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';

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
  it('exposes only the fixed public and dedicated canon-write operations', () => {
    const contract = loadContract();

    expect(contract.openapi).toBe('3.1.0');
    expect(contract.info.version).toBe('1.0.0');
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
      '409',
      '429',
      '503',
    ]);
    expect(contract.components.securitySchemes).toEqual({
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Opaque Backstage Booker access token',
        description:
          'Required only for the fixed Backstage Booker canon-write operation. Configure ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN; this purpose-bound credential cannot authorize other GPT Access routes.',
      },
    });

    collectLocalRefs(contract).forEach((ref) => {
      expect(resolveLocalRef(contract, ref)).toBeDefined();
    });
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
    for (const status of ['400', '401', '403', '409', '503']) {
      expect(canonOperation.responses[status].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/BackstageCanonErrorResponse',
      });
    }
    expect(canonOperation.responses['429'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/RateLimitResponse',
    });
    expect(schemas.BackstageCanonErrorResponse).toEqual(expect.objectContaining({
      type: 'object',
      additionalProperties: true,
      required: ['ok', 'error'],
    }));
    expect(schemas.BackstageCanonErrorResponse.properties.ok.enum).toEqual([false]);

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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildGamingDiscoveryQuery } from '../../src/services/gamingSourceDiscovery.js';
import { GAMING_RESPONSE_MAX_CHARACTERS } from '../../src/shared/http/clientResponseCommon.js';

const contractPath = join(process.cwd(), 'contracts/arcanos_gaming.openapi.v1.json');
const instructionsPath = join(process.cwd(), 'docs/ARCANOS_GAMING_CUSTOM_GPT.md');
const customGptsPath = join(process.cwd(), 'docs/CUSTOM_GPTS.md');

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
    expect(contract.info.version).toBe('1.4.0');
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
    ]);
    expect(Object.keys(contract.paths['/gpt/arcanos-gaming'])).toEqual(['post']);
    expect(Object.keys(contract.paths['/gpt/arcanos-gaming/canary'])).toEqual(['post']);

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

    const keys = collectKeys(contract);
    expect(keys).not.toContain('anyOf');
    expect(keys).not.toContain('oneOf');
    expect(keys).not.toContain('allOf');
    expect(keys).not.toContain('const');

    const refs = collectLocalRefs(contract);
    expect(refs.length).toBeGreaterThan(0);
    refs.forEach((ref) => expect(resolveLocalRef(contract, ref)).toBeDefined());
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

  it('keeps builder instructions synchronized with two operations and one gameplay call', () => {
    const instructions = readFileSync(instructionsPath, 'utf8');
    const customGpts = readFileSync(customGptsPath, 'utf8');

    expect(instructions).toContain('The dedicated schema defines exactly two fixed-path operations');
    expect(instructions).toContain('queryArcanosGaming` → `POST /gpt/arcanos-gaming');
    expect(instructions).toContain('canaryArcanosGaming` → `POST /gpt/arcanos-gaming/canary');
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

    for (const example of [
      'Palworld 1.0',
      'Unknown newly released game',
      'Current patch or meta request',
      'Stable older game',
      'User-supplied URL',
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
    expect(customGpts).toContain('two Action operations and one gameplay call per gameplay request');
    expect(customGpts).toContain('each gameplay workflow still makes one `queryArcanosGaming` call');
    expect(customGpts).not.toContain('mandatory backend-first evidence workflow');
  });
});

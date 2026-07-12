import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildGamingDiscoveryQuery } from '../../src/services/gamingSourceDiscovery.js';
import { validateGamingEvidenceRetryRequest } from '../../src/services/gamingModes.js';

const contractPath = join(process.cwd(), 'contracts/arcanos_gaming.openapi.v1.json');
const instructionsPath = join(process.cwd(), 'docs/ARCANOS_GAMING_CUSTOM_GPT.md');

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
    expect(contract.info.version).toBe('1.2.0');
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
      '/gpt/arcanos-gaming/evidence-retry',
    ]);

    const query = contract.paths['/gpt/arcanos-gaming'].post;
    const retry = contract.paths['/gpt/arcanos-gaming/evidence-retry'].post;
    expect(query.operationId).toBe('queryArcanosGaming');
    expect(retry.operationId).toBe('retryArcanosGamingWithSources');
    expect(query.security).toBeUndefined();
    expect(retry.security).toBeUndefined();
    expect(query.description.length).toBeLessThanOrEqual(300);
    expect(retry.description.length).toBeLessThanOrEqual(300);
    expect(query.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/GamingQueryRequest',
    });
    expect(retry.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/GamingEvidenceRetryRequest',
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

  it('documents the first-call payload and the exact bounded retry input', () => {
    const schemas = loadContract().components.schemas;
    const queryRequest = schemas.GamingQueryRequest;
    const queryPayload = schemas.GamingQueryPayload;
    const retry = schemas.GamingEvidenceRetryRequest;

    expect(queryRequest.required).toEqual(['action', 'payload']);
    expect(queryRequest.properties.action).toEqual(expect.objectContaining({
      type: 'string',
      enum: ['query'],
    }));
    expect(queryPayload.required).toEqual(['mode', 'prompt']);
    expect(Object.keys(queryPayload.properties)).toEqual(expect.arrayContaining([
      'mode',
      'game',
      'prompt',
      'url',
      'urls',
      'guideUrl',
      'guideUrls',
      'evidenceOrigin',
      'requestedVersion',
      'evidenceAttempt',
    ]));
    expect(queryPayload.properties.evidenceOrigin.enum).toEqual(['frontend_web_search']);
    expect(queryPayload.properties.evidenceAttempt).toEqual(expect.objectContaining({
      type: 'integer',
      enum: [1],
    }));

    expect(retry.additionalProperties).toBe(false);
    expect(Object.keys(retry.properties)).toEqual([
      'game',
      'mode',
      'originalPrompt',
      'candidateUrls',
      'requestedVersion',
      'evidenceAttempt',
    ]);
    expect(retry.required).toEqual([
      'game',
      'mode',
      'originalPrompt',
      'candidateUrls',
      'evidenceAttempt',
    ]);
    expect(retry.properties.candidateUrls).toEqual(expect.objectContaining({
      type: 'array',
      maxItems: 4,
      uniqueItems: true,
    }));
    expect(retry.properties.candidateUrls.minItems).toBeUndefined();
    expect(retry.properties.candidateUrls.items.format).toBe('uri');
    expect(retry.properties.evidenceAttempt.enum).toEqual([1]);
  });

  it('keeps requestedVersion syntax aligned with runtime normalization', () => {
    const schemas = loadContract().components.schemas;
    const queryVersion = schemas.GamingQueryPayload.properties.requestedVersion;
    const retryVersion = schemas.GamingEvidenceRetryRequest.properties.requestedVersion;
    const queryPattern = new RegExp(queryVersion.pattern);
    const retryPattern = new RegExp(retryVersion.pattern);
    const baseRequest = {
      game: 'Palworld',
      mode: 'guide',
      originalPrompt: 'Look up a current Palworld guide.',
      candidateUrls: [],
      evidenceAttempt: 1,
    };

    for (const [input, normalized] of [
      ['1.0', '1.0'],
      ['1.0.1', '1.0.1'],
      ['v1.0', '1.0'],
      ['version 1.0', '1.0'],
      ['PATCH 1.0.1', '1.0.1'],
    ]) {
      expect(queryPattern.test(input)).toBe(true);
      expect(retryPattern.test(input)).toBe(true);
      expect(validateGamingEvidenceRetryRequest({
        ...baseRequest,
        requestedVersion: input,
      })).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ requestedVersion: normalized }),
      }));
    }

    for (const input of [
      'guide',
      '1',
      '1.0.1.2',
      `1.0\u202e`,
    ]) {
      expect(queryPattern.test(input)).toBe(false);
      expect(retryPattern.test(input)).toBe(false);
      expect(validateGamingEvidenceRetryRequest({
        ...baseRequest,
        requestedVersion: input,
      }).ok).toBe(false);
    }
  });

  it('keeps retry text limits synchronized with runtime validation', () => {
    const schemas = loadContract().components.schemas;
    const retry = schemas.GamingEvidenceRetryRequest;
    const gameMax = retry.properties.game.maxLength;
    const promptMax = retry.properties.originalPrompt.maxLength;
    const request = {
      game: 'g'.repeat(gameMax),
      mode: 'guide',
      originalPrompt: 'p'.repeat(promptMax),
      candidateUrls: [],
      evidenceAttempt: 1,
    };

    expect(promptMax).toBe(schemas.GamingQueryPayload.properties.prompt.maxLength);
    expect(validateGamingEvidenceRetryRequest(request).ok).toBe(true);
    expect(validateGamingEvidenceRetryRequest({ ...request, game: `${request.game}g` }).ok).toBe(false);
    expect(validateGamingEvidenceRetryRequest({
      ...request,
      originalPrompt: `${request.originalPrompt}p`,
    }).ok).toBe(false);
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
      response: { type: 'string' },
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

  it('keeps builder instructions synchronized with the backend-first one-retry workflow', () => {
    const instructions = readFileSync(instructionsPath, 'utf8');

    expect(instructions).toContain('Call queryArcanosGaming first for every Gaming request');
    expect(instructions).toContain('result.data.evidenceRequest.required:true');
    expect(instructions).toContain('Search only the bounded queries in result.data.evidenceRequest.queries');
    expect(instructions).toContain("inside the outer envelope's Gaming result data");
    expect(instructions).toContain('Collect candidate URLs only');
    expect(instructions).toContain('Do not answer, summarize, cite, or make Gaming claims from Web Search');
    expect(instructions).toContain('Call retryArcanosGamingWithSources once');
    expect(instructions).toContain('Copy originalPrompt unchanged from the pre-search user request');
    expect(instructions).toContain(
      'Never append or substitute Web Search titles, snippets, summaries, claims, or other discovered text'
    );
    expect(instructions).toContain('Call it with an empty candidateUrls array');
    expect(instructions).toContain('Present only the second ARCANOS backend response');
    expect(instructions).toContain('Never perform more than one evidence retry');
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
    expect(instructions).toContain('/gpt/arcanos-gaming/evidence-retry');
    expect(instructions).toContain(
      'https://acranos-production.up.railway.app/contracts/arcanos_gaming.openapi.v1.json'
    );
  });
});

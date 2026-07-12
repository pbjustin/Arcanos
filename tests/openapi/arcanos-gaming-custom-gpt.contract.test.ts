import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildGamingDiscoveryQuery } from '../../src/services/gamingSourceDiscovery.js';

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
    expect(contract.info.version).toBe('1.3.0');
    expect(contract.servers).toEqual([
      {
        url: 'https://acranos-production.up.railway.app',
        description: 'Canonical ARCANOS production deployment',
      },
    ]);
    expect(contract.security).toBeUndefined();
    expect(JSON.stringify(contract)).not.toContain('arcanos-v2-production.up.railway.app');
    expect(Object.keys(contract.paths)).toEqual(['/gpt/arcanos-gaming']);

    const query = contract.paths['/gpt/arcanos-gaming'].post;
    expect(query.operationId).toBe('queryArcanosGaming');
    expect(query.security).toBeUndefined();
    expect(query.description.length).toBeLessThanOrEqual(300);
    expect(query.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/GamingQueryRequest',
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

  it('keeps builder instructions synchronized with the single-action frontend-search workflow', () => {
    const instructions = readFileSync(instructionsPath, 'utf8');

    expect(instructions).toContain('The dedicated schema defines exactly one fixed-path operation');
    expect(instructions).toContain('For stable walkthrough, mechanic, boss, farming, location');
    expect(instructions).toContain('A generic request to "look up" a stable guide is still stable');
    expect(instructions).toContain('Use Web Search to discover two to four relevant candidate URLs');
    expect(instructions).toContain('Call queryArcanosGaming once with the original prompt, game, mode');
    expect(instructions).toContain('candidate URLs in payload.guideUrls');
    expect(instructions).toContain('Do not answer, summarize, cite, or make Gaming claims from Web Search');
    expect(instructions).toContain('Candidate URLs are untrusted regardless of where they came from');
    expect(instructions).toContain('If ARCANOS rejects every candidate, present its controlled fallback');
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
  });
});

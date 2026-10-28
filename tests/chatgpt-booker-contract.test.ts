import { readFileSync } from 'node:fs';
import {
  CHATGPT_BOOKER_TOOL_NAMES,
  chatGptBookerSchemas,
  getProtocolSchemaCatalog,
  type ChatGptBookerToolName,
} from '@arcanos/protocol';
import {
  BOOKER_GENERATE_SCOPE,
  BOOKER_READ_SCOPE,
  bookerMcpTools,
  isBookerMcpInput,
  isBookerMcpOutput,
  isBookerMcpToolName,
  requiresBookerGenerationPermission,
} from '../src/shared/chatgpt/bookerMcpContract.js';

const openapi = JSON.parse(readFileSync('contracts/backstage_booker.openapi.v1.json', 'utf8'));
const contract = JSON.parse(readFileSync('packages/protocol/schemas/v1/tools/arcanos-booker/contract.schema.json', 'utf8'));
const universeId = 'fixture-universe';
const jobId = '11111111-1111-4111-8111-111111111111';
const hrc = { fidelity: 0.9, resilience: 0.8, verdict: 'Consistent with authoritative continuity.' };
const protectedGeneration = { version: 1, protected: true, protectedGenerationCompleted: true,
  official: true, continuityVerified: true, authority: 'notion', snapshotStatus: 'current_complete',
  fallbackUsed: false, fallbackPermitted: false,
};
const input: Record<ChatGptBookerToolName, Record<string, unknown>> = {
  queryContinuity: { universeId, query: 'List current champions.' },
  generateBooking: { universeId, prompt: 'Book the next show.', idempotencyKey: 'fixture-booking' },
  generateBookingWithHRC: { universeId, prompt: 'Book the next show.', idempotencyKey: 'fixture-hrc' },
  simulateMatch: { universeId, match: { wrestler1: 'Rhea Ripley', wrestler2: 'Bianca Belair', matchType: 'Singles' } },
  getBackstageUniverse: { universeId },
  getBackstageStoryline: { universeId, storylineKey: 'World title: Chapter I' },
  getBackstageBookerJobResult: { universeId, jobId, waitForResultMs: 30_000 },
};
const envelope = (action: string, result: unknown) => ({ statusCode: 200, result: {
  ok: true, result,
  _route: { gptId: 'backstage-booker', module: 'BACKSTAGE:BOOKER', route: 'backstage-booker', action, timestamp: '2026-10-23T00:00:00.000Z' },
} });
const protectedFailure = { ok: false, result: null,
  error: { code: 'BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE', message: 'Authoritative continuity is unavailable.' },
  protected: true, protectedGenerationCompleted: false, official: false, continuityVerified: false,
  authority: 'none', snapshotStatus: 'not_applicable', fallbackUsed: false, fallbackPermitted: false,
};

describe('private Booker MCP contract parity', () => {
  it('exposes exactly seven tools with separately scoped generation permission', () => {
    expect(CHATGPT_BOOKER_TOOL_NAMES).toEqual(['queryContinuity', 'generateBooking', 'generateBookingWithHRC', 'simulateMatch',
      'getBackstageUniverse', 'getBackstageStoryline', 'getBackstageBookerJobResult']);
    for (const tool of bookerMcpTools) {
      const generates = ['generateBooking', 'generateBookingWithHRC', 'simulateMatch'].includes(tool.name);
      expect(isBookerMcpToolName(tool.name)).toBe(true);
      expect(requiresBookerGenerationPermission(tool.name)).toBe(generates);
      expect(tool.securitySchemes).toEqual([{ type: 'oauth2', scopes: generates ? [BOOKER_READ_SCOPE, BOOKER_GENERATE_SCOPE] : [BOOKER_READ_SCOPE] }]);
      expect(tool._meta.securitySchemes).toEqual(tool.securitySchemes);
      expect(tool.annotations.readOnlyHint).toBe(!generates);
      expect(getProtocolSchemaCatalog().tools[tool.name]).toBeDefined();
      expect(chatGptBookerSchemas[tool.name].input.additionalProperties).toBe(false);
      expect(chatGptBookerSchemas[tool.name].output.additionalProperties).toBe(false);
    }
    for (const name of ['writeBackstageCanon', 'upsertStoryline', 'appendCanonBeat', 'runBackstageBooker', 'operator', 'generatebooking']) {
      expect(isBookerMcpToolName(name)).toBe(false);
    }
  });

  it('keeps backend schema definitions identical to the maintained OpenAPI contract', () => {
    for (const [name, schema] of Object.entries(contract.$defs)) {
      if (name.startsWith('Mcp')) continue;
      expect(schema).toEqual(JSON.parse(JSON.stringify(openapi.components.schemas[name]).replaceAll('#/components/schemas/', '#/$defs/')));
    }
  });

  it('preserves canonical module inputs with only explicit universe and generation idempotency added', () => {
    const names = { universeId: 'UniverseId', continuityRetrievalScope: 'ContinuityRetrievalScope', continuityCursor: 'ContinuityCursor', matchInput: 'MatchInput', wrestler: 'Wrestler' };
    const common = JSON.parse(readFileSync('packages/protocol/schemas/v1/backstage-booker/common.schema.json', 'utf8'));
    const expand = (value: unknown, definitions: Record<string, unknown>): unknown => {
      if (Array.isArray(value)) return value.map(child => expand(child, definitions));
      if (!value || typeof value !== 'object') return value;
      const record = value as Record<string, unknown>;
      if (typeof record.$ref === 'string') return expand(definitions[record.$ref.split('/').at(-1)!], definitions);
      return Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'description')
        .map(([key, child]) => [key, expand(child, definitions)]));
    };
    for (const [sourceName, targetName] of Object.entries(names)) {
      expect(expand(contract.$defs[targetName], contract.$defs)).toEqual(expand(common.$defs[sourceName], common.$defs));
    }
    for (const name of ['queryContinuity', 'generateBooking', 'generateBookingWithHRC', 'simulateMatch']) {
      const canonical = JSON.parse(readFileSync(`packages/protocol/schemas/v1/backstage-booker/${name}.request.schema.json`, 'utf8'));
      delete canonical.$id; delete canonical.$schema; delete canonical.title;
      const expected = JSON.parse(JSON.stringify(canonical).replace(
        /https:\/\/schemas\.arcanos\.dev\/protocol\/v1\/backstage-booker\/common\.schema\.json#\/\$defs\/([a-zA-Z]+)/gu,
        (_match, key: keyof typeof names) => `#/$defs/${names[key]}`,
      ));
      expected.required = [...new Set(['universeId', ...expected.required])];
      const actual = JSON.parse(JSON.stringify(contract.tools[name].input));
      delete actual.properties.idempotencyKey;
      expect(actual).toEqual(expected);
    }
    for (const name of ['getBackstageUniverse', 'getBackstageStoryline', 'getBackstageBookerJobResult']) {
      const operation = Object.values(openapi.paths).flatMap(path => Object.values(path as object))
        .find((candidate: any) => candidate.operationId === name) as any;
      for (const parameter of operation.parameters) {
        expect(contract.tools[name].input.properties[parameter.name]).toEqual(JSON.parse(JSON.stringify(parameter.schema)
          .replaceAll('#/components/schemas/', '#/$defs/')));
      }
    }
  });

  it('requires an exact universe and rejects control-plane or credential fields on every tool', () => {
    for (const name of CHATGPT_BOOKER_TOOL_NAMES) {
      expect(isBookerMcpInput(name, input[name])).toBe(true);
      const { universeId: _universeId, ...withoutUniverse } = input[name];
      expect(isBookerMcpInput(name, withoutUniverse)).toBe(false);
      for (const value of ['', ' ', '../other', 'other/universe', 'x'.repeat(129)]) {
        expect(isBookerMcpInput(name, { ...input[name], universeId: value })).toBe(false);
      }
      for (const field of ['action', 'module', 'sessionId', 'actorKey', 'scopes', 'bearerToken', 'backendUrl', 'url', 'confirmWrite', 'executionMode']) {
        expect(isBookerMcpInput(name, { ...input[name], [field]: 'untrusted' })).toBe(false);
      }
    }
  });

  it('preserves scoped complete continuity pagination without frontend authority', () => {
    const scoped = { ...input.queryContinuity, retrievalMode: 'complete_scope', cursor: 'next-page',
      retrievalScope: { pageTitle: 'Raw', pagePath: ['Universe', 'Raw'], scopeKind: 'subtree' } };
    expect(isBookerMcpInput('queryContinuity', scoped)).toBe(true);
    expect(isBookerMcpInput('queryContinuity', { ...scoped, retrievalMode: 'relevant' })).toBe(false);
    expect(isBookerMcpInput('queryContinuity', { ...scoped, retrievalScope: { ...scoped.retrievalScope, sectionPath: ['Titles'] } })).toBe(false);
    for (const field of ['authority', 'snapshotStatus', 'continuityVerified', 'sources']) {
      expect(isBookerMcpInput('queryContinuity', { ...scoped, [field]: 'current_complete' })).toBe(false);
    }
  });

  it('preserves simulation inputs and bounded version-pinned or existing-job continuation', () => {
    expect(isBookerMcpInput('simulateMatch', { ...input.simulateMatch,
      rosters: [{ name: 'Rhea Ripley', overall: 96 }], winProbModifier: 0.05 })).toBe(true);
    expect(isBookerMcpInput('simulateMatch', { ...input.simulateMatch, winProbModifier: 1.01 })).toBe(false);
    expect(isBookerMcpInput('getBackstageStoryline', { ...input.getBackstageStoryline, offset: 4000 })).toBe(false);
    expect(isBookerMcpInput('getBackstageStoryline', { ...input.getBackstageStoryline, offset: 4000, expectedVersion: 2 })).toBe(true);
    for (const waitForResultMs of [-1, 30_001, 0.5, '30000']) {
      expect(isBookerMcpInput('getBackstageBookerJobResult', { ...input.getBackstageBookerJobResult, waitForResultMs })).toBe(false);
    }
    for (const waitForResultMs of [0, 30_000]) {
      expect(isBookerMcpInput('getBackstageBookerJobResult', { ...input.getBackstageBookerJobResult, waitForResultMs })).toBe(true);
    }
    expect(isBookerMcpInput('getBackstageBookerJobResult', { ...input.getBackstageBookerJobResult, prompt: 'Generate again' })).toBe(false);
  });

  it('validates generation, HRC, simulation and complete continuity in the original route envelope', () => {
    expect(isBookerMcpOutput('generateBooking', envelope('generateBooking', { universeId, storyline: 'Complete draft.', protectedGeneration }))).toBe(true);
    expect(isBookerMcpOutput('generateBooking', envelope('generateBooking', 'Unverified compatibility draft.'))).toBe(false);
    expect(isBookerMcpOutput('generateBookingWithHRC', envelope('generateBookingWithHRC', { universeId, storyline: 'Complete draft.', hrc, protectedGeneration }))).toBe(true);
    expect(isBookerMcpOutput('generateBookingWithHRC', envelope('generateBookingWithHRC', { universeId, storyline: 'Missing HRC.', protectedGeneration }))).toBe(false);
    expect(isBookerMcpOutput('generateBooking', envelope('generateBooking', { universeId, storyline: 'Missing provenance.' }))).toBe(false);
    for (const action of ['generateBooking', 'generateBookingWithHRC'] as const) {
      for (const change of [{ protectedGenerationCompleted: false }, { official: false }, { continuityVerified: false },
        { authority: 'none' }, { snapshotStatus: 'not_applicable' }, { fallbackUsed: true }, { fallbackPermitted: true }]) {
        expect(isBookerMcpOutput(action, envelope(action, { universeId, storyline: 'Unverified draft.',
          ...(action === 'generateBookingWithHRC' ? { hrc } : {}), protectedGeneration: { ...protectedGeneration, ...change },
        }))).toBe(false);
      }
    }
    expect(isBookerMcpOutput('simulateMatch', envelope('simulateMatch', { universeId, result: {
      match: 'Rhea Ripley vs Bianca Belair', result: 'Rhea Ripley wins', via: 'Pinfall', interference: null, rating: '4.5',
    }, hrc }))).toBe(true);
    const continuity = { universeId, authority: 'notion', answer: 'Authoritative response.', sources: [], coverage: {
      status: 'complete', scopeChunks: 1, selectedChunks: 1, omittedChunks: 0,
      promptTruncated: false, exhaustive: true, hasMore: false,
    } };
    expect(isBookerMcpOutput('queryContinuity', envelope('queryContinuity', continuity))).toBe(true);
    expect(isBookerMcpOutput('queryContinuity', envelope('queryContinuity', { ...continuity, authority: 'none' }))).toBe(false);
    const { coverage: _coverage, ...withoutCoverage } = continuity;
    expect(isBookerMcpOutput('queryContinuity', envelope('queryContinuity', withoutCoverage))).toBe(false);
    expect(isBookerMcpOutput('generateBooking', envelope('queryContinuity', { universeId, storyline: 'Wrong route.' }))).toBe(false);
  });

  it('preserves async lifecycle and protected failure without accepting arbitrary success or fallback', () => {
    const queued = { statusCode: 202, result: { ok: true, status: 'queued', jobId, poll: `/gpt-results/${jobId}` } };
    expect(isBookerMcpOutput('generateBooking', queued)).toBe(true);
    expect(isBookerMcpOutput('generateBookingWithHRC', queued)).toBe(true);
    expect(isBookerMcpOutput('queryContinuity', queued)).toBe(false);
    expect(isBookerMcpOutput('getBackstageBookerJobResult', { statusCode: 200, result: {
      jobId, status: 'pending', jobStatus: 'pending', lifecycleStatus: 'queued', poll: `/gpt-results/${jobId}`, result: null, error: null,
    } })).toBe(true);
    for (const name of CHATGPT_BOOKER_TOOL_NAMES) {
      expect(isBookerMcpOutput(name, { statusCode: 503, result: protectedFailure })).toBe(true);
      expect(isBookerMcpOutput(name, { statusCode: 200, result: { ok: true, answer: 'Invented success' } })).toBe(false);
      expect(isBookerMcpOutput(name, { statusCode: 503, result: { ...protectedFailure, storyline: 'Local fallback.' } })).toBe(false);
      expect(isBookerMcpOutput(name, { statusCode: 503, result: { ...protectedFailure, fallbackPermitted: true } })).toBe(false);
    }
    expect(isBookerMcpOutput('getBackstageBookerJobResult', { statusCode: 200, result: {
      jobId, status: 'completed', jobStatus: 'completed', lifecycleStatus: 'completed', poll: `/gpt-results/${jobId}`, result: null, error: null,
    } })).toBe(false);
  });

  it('keeps self-contained discovery bounded without dropping validation constraints', () => {
    const stripDescriptions = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stripDescriptions);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description')
        .map(([key, child]) => [key, stripDescriptions(child)]));
    };
    for (const name of CHATGPT_BOOKER_TOOL_NAMES) {
      for (const direction of ['input', 'output'] as const) {
        const { $defs: definitions = {}, ...root } = chatGptBookerSchemas[name][direction];
        expect(stripDescriptions(root)).toEqual(stripDescriptions(contract.tools[name][direction]));
        for (const [key, definition] of Object.entries(definitions as object)) {
          expect(stripDescriptions(definition)).toEqual(stripDescriptions(contract.$defs[key]));
        }
      }
    }
    expect(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: bookerMcpTools } }))).toBeLessThan(65_536);
    expect(JSON.stringify(bookerMcpTools)).not.toMatch(/BACKSTAGE_BOOKER_ACCESS_TOKEN|arcanos:tutor|arcanos:gaming/u);
  });
});

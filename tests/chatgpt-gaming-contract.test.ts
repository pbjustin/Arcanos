import { readFileSync } from 'node:fs';
import { chatGptGamingSchemas, CHATGPT_GAMING_TOOL_NAMES } from '@arcanos/protocol/chatgptGaming';
import { isGamingMcpInput, isGamingMcpOutput, gamingMcpTools } from '../src/shared/chatgpt/gamingMcpContract.js';

import { GAMING_HYBRID_LIMITS, GAMING_HYBRID_V2_LIMITS, gamingHybridQuerySchema, gamingHybridCandidatesSchema } from '../src/shared/gaming/gamingHybridContract.js';

const openapi = JSON.parse(readFileSync(new URL('../contracts/arcanos_gaming.openapi.v1.json', import.meta.url), 'utf8'));
const contract = JSON.parse(readFileSync(new URL('../packages/protocol/schemas/v1/tools/arcanos-gaming/contract.schema.json', import.meta.url), 'utf8'));
describe('Gaming MCP contracts preserve the service contract', () => {
  it('keeps shared source definitions equal to Action 1.5.0, with local schema references', () => {
    expect(openapi.info.version).toBe('1.5.0');
    for (const [name, schema] of Object.entries(contract.$defs)) {
      if (name.startsWith('Mcp')) continue;
      expect(schema).toEqual(JSON.parse(JSON.stringify(openapi.components.schemas[name]).replaceAll('#/components/schemas/', '#/$defs/')));
    }
  });
  it('exposes exactly the requested fixed names, with no runtime selector inputs', () => {
    expect(CHATGPT_GAMING_TOOL_NAMES).toEqual(['arcanos_gaming_query', 'arcanos_gaming_canary', 'arcanos_gaming_hybrid_query',
      'arcanos_gaming_submit_candidates', 'arcanos_gaming_ingestion_status', 'arcanos_gaming_ingest_sources',
      'arcanos_gaming_refresh_sources', 'arcanos_gaming_ingest_candidates']);
    for (const name of CHATGPT_GAMING_TOOL_NAMES) {
      expect(chatGptGamingSchemas[name].input.additionalProperties).toBe(false);
      expect(chatGptGamingSchemas[name].output.additionalProperties).toBe(false);
      expect(JSON.stringify(chatGptGamingSchemas[name])).not.toContain('#/components/');
    }
  });
  it('permits gameplay role context while rejecting authority, module, host and token injection', () => {
    const input = { mode: 'build', prompt: 'Build for this class', game: 'Fixture Game', role: 'healer' };
    expect(isGamingMcpInput('arcanos_gaming_query', input)).toBe(true);
    for (const key of ['callerRole', 'scope', 'scopes', 'actorKey', 'bearerToken', 'backendHost', 'module', 'sessionId']) {
      expect(isGamingMcpInput('arcanos_gaming_query', { ...input, [key]: 'untrusted' })).toBe(false);
    }
  });
  it('requires affirmative consent and idempotency for every durable tool', () => {
    for (const name of ['arcanos_gaming_ingest_sources', 'arcanos_gaming_refresh_sources', 'arcanos_gaming_ingest_candidates'] as const) {
      const schema = chatGptGamingSchemas[name].input;
      expect(schema.required).toEqual(expect.arrayContaining(['idempotencyKey', 'storagePolicy', 'confirmStore']));
      expect((schema.properties as Record<string, unknown>).confirmStore).toEqual({ type: 'boolean', const: true });
    }
  });
  it('keeps catalog bounded and distinct from private instructions or registration', () => {
    expect(Buffer.byteLength(JSON.stringify(gamingMcpTools))).toBeLessThan(65_536);
    expect(JSON.stringify(gamingMcpTools)).not.toMatch(/asdk_app_|ARCANOS_GAMING_SOURCE_ACCESS_TOKEN|arcanos:tutor/u);
  });
});


const workflowId = '4517e693-b592-43c8-a827-d4b74168c429';
const v2Query = { contractVersion: 'gaming-hybrid-v2', idempotencyKey: 'fixture-v2-query', question: 'Compare two routes', game: 'Fixture Game' };
const v2Submission = { contractVersion: 'gaming-hybrid-v2', workflowId, idempotencyKey: 'fixture-v2-submit', expectedRevision: 1, // gitleaks:allow -- synthetic idempotency fixture, not a credential
  candidates: [{ url: 'https://guides.example.org/routes', claimedGame: 'Untrusted discovery hint' }] };
const v2Response = { statusCode: 200, result: { contractVersion: 'gaming-hybrid-v2', requestId: 'fixture-v2-result', workflowId,
  state: 'discovery_required', nextAction: 'search', reason: 'COVERAGE_INSUFFICIENT', sourceKnown: false, evidenceSelected: false,
  freshnessStatus: 'unverified', revision: 2, selectedCandidateIds: [], selectedEvidenceIds: [], coverageSatisfied: false,
  missingCoverage: ['alternate route'], gapAssessmentStatus: 'assessed', requirementSupport: [],
  discovery: { type: 'gameplay_evidence', round: 1, maxRounds: 2, maxCandidates: 3, searchQueries: ['Fixture Game alternate route guide'],
    continuationRequired: true, replacementAllowed: true, recoveryRemaining: 1, nextSubmissionCandidateLimit: 3,
    remainingTotalAcquisitionMs: 18_000, remainingCandidateUrls: 4 } } };

describe('explicit Gaming hybrid v2 contract compatibility', () => {
  it('opts into v2 without changing the v1 submission or acquisition limits', () => {
    expect(GAMING_HYBRID_LIMITS).toMatchObject({ discoveryRounds: 1, candidates: 3, candidateTimeoutMs: 12_000, currentnessRounds: 1 });
    expect(GAMING_HYBRID_V2_LIMITS).toMatchObject({ discoveryRounds: 2, candidates: 3, totalCandidateUrls: 6,
      candidateTimeoutMs: 12_000, totalCandidateTimeoutMs: 24_000, currentnessRounds: 1 });
    expect(isGamingMcpInput('arcanos_gaming_hybrid_query', v2Query)).toBe(true);
    expect(gamingHybridQuerySchema.safeParse(v2Query).success).toBe(true);
    expect(isGamingMcpInput('arcanos_gaming_submit_candidates', v2Submission)).toBe(true);
    expect(gamingHybridCandidatesSchema.safeParse(v2Submission).success).toBe(true);
    const { expectedRevision: _revision, ...withoutRevision } = v2Submission;
    for (const input of [withoutRevision, { ...v2Submission, expectedRevision: -1 }, { ...v2Submission, expectedRevision: 1.5 },
      { ...v2Submission, expectedRevision: '1' }, { ...v2Submission, contractVersion: 'gaming-hybrid-v3' },
      { ...v2Submission, candidates: Array(4).fill(v2Submission.candidates[0]) }]) {
      expect(isGamingMcpInput('arcanos_gaming_submit_candidates', input)).toBe(false);
      expect(gamingHybridCandidatesSchema.safeParse(input).success).toBe(false);
    }
    expect(isGamingMcpInput('arcanos_gaming_submit_candidates', { ...v2Submission, contractVersion: 'gaming-hybrid-v1' })).toBe(false);
    expect(isGamingMcpInput('arcanos_gaming_submit_candidates', { ...withoutRevision, contractVersion: 'gaming-hybrid-v1' })).toBe(true);
  });

  it('rejects frontend authority, selected IDs, storage consent and budget fabrication', () => {
    for (const key of ['selectedCandidateIds', 'selectedEvidenceIds', 'authority', 'coverageSatisfied', 'freshnessStatus',
      'confirmStore', 'storagePolicy', 'replacementAllowed', 'remainingTotalAcquisitionMs', 'recoveryRemaining', 'actorKey']) {
      expect(isGamingMcpInput('arcanos_gaming_submit_candidates', { ...v2Submission, [key]: true })).toBe(false);
      expect(gamingHybridCandidatesSchema.safeParse({ ...v2Submission, [key]: true }).success).toBe(false);
    }
    for (const key of ['verified', 'selected', 'rawHtml', 'pageText', 'cookies', 'headers', 'expectedAnswer', 'origin']) {
      const input = { ...v2Submission, candidates: [{ ...v2Submission.candidates[0], [key]: 'untrusted' }] };
      expect(isGamingMcpInput('arcanos_gaming_submit_candidates', input)).toBe(false);
      expect(gamingHybridCandidatesSchema.safeParse(input).success).toBe(false);
    }
  });

  it('requires bounded backend selection, coverage and recovery diagnostics only in v2', () => {
    expect(isGamingMcpOutput('arcanos_gaming_submit_candidates', v2Response)).toBe(true);
    for (const key of ['revision', 'selectedCandidateIds', 'selectedEvidenceIds', 'coverageSatisfied', 'missingCoverage',
      'gapAssessmentStatus', 'requirementSupport']) {
      const result = { ...v2Response.result } as Record<string, unknown>; delete result[key];
      expect(isGamingMcpOutput('arcanos_gaming_submit_candidates', { ...v2Response, result })).toBe(false);
    }
    for (const [key, value] of [['recoveryRemaining', 2], ['nextSubmissionCandidateLimit', 4], ['remainingCandidateUrls', 7],
      ['remainingTotalAcquisitionMs', 24_001], ['round', 3], ['maxRounds', 3]]) {
      expect(isGamingMcpOutput('arcanos_gaming_submit_candidates', { ...v2Response, result: { ...v2Response.result,
        discovery: { ...v2Response.result.discovery, [key]: value } } })).toBe(false);
    }
    const legacy = { statusCode: 200, result: { contractVersion: 'gaming-hybrid-v1', requestId: 'fixture-legacy', state: 'discovery_required',
      nextAction: 'search', reason: 'EVIDENCE_REQUIRED', sourceKnown: false, evidenceSelected: false, freshnessStatus: 'unverified',
      discovery: { round: 0, maxRounds: 1, maxCandidates: 3, searchQueries: [] } } };
    expect(isGamingMcpOutput('arcanos_gaming_hybrid_query', legacy)).toBe(true);
    expect(isGamingMcpOutput('arcanos_gaming_hybrid_query', { ...legacy, result: { ...legacy.result, revision: 0 } })).toBe(false);
    expect(isGamingMcpOutput('arcanos_gaming_hybrid_query', { ...legacy, result: { ...legacy.result,
      discovery: { ...legacy.result.discovery, maxRounds: 2 } } })).toBe(false);
  });

  it('retains one separate currentness operation and bounded workflow-scoped observations', () => {
    const discovery = { ...v2Response.result.discovery, type: 'currentness_verification', maxRounds: 1, round: 0,
      replacementAllowed: false, acquisitionHints: [{ scope: 'url', target: 'https://guides.example.org/blocked',
        reasonCode: 'ACCESS_DENIED', observedAt: '2026-10-03T00:00:00.000Z', expiresAt: '2026-10-03T00:10:00.000Z' }] };
    const output = { ...v2Response, result: { ...v2Response.result, nextAction: 'verify_currentness', discovery } };
    expect(isGamingMcpOutput('arcanos_gaming_submit_candidates', output)).toBe(true);
    for (const change of [{ maxRounds: 2 }, { round: 2 }, { replacementAllowed: true },
      { acquisitionHints: [{ ...discovery.acquisitionHints[0], quality: 'verified' }] },
      { acquisitionHints: Array(7).fill(discovery.acquisitionHints[0]) }]) {
      expect(isGamingMcpOutput('arcanos_gaming_submit_candidates', { ...output, result: { ...output.result,
        discovery: { ...discovery, ...change } } })).toBe(false);
    }
  });

  it('keeps schema transport compaction limited to non-validating documentation annotations', () => {
    const canonical = contract.tools.arcanos_gaming_submit_candidates.output;
    expect(chatGptGamingSchemas.arcanos_gaming_submit_candidates.output.properties).toEqual(canonical.properties);
    const withoutDescriptions = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(withoutDescriptions);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description')
        .map(([key, child]) => [key, withoutDescriptions(child)]));
    };
    for (const name of CHATGPT_GAMING_TOOL_NAMES) {
      for (const direction of ['input', 'output'] as const) {
        const schema = chatGptGamingSchemas[name][direction];
        const { $defs: definitions = {}, ...root } = schema;
        const declaration = contract.tools[name][direction];
        const canonicalRoot = declaration.$ref ? contract.$defs[declaration.$ref.split('/').at(-1)] : declaration;
        expect(withoutDescriptions(root)).toEqual(withoutDescriptions(canonicalRoot));
        for (const [definitionName, definition] of Object.entries(definitions as Record<string, unknown>)) {
          expect(withoutDescriptions(definition)).toEqual(withoutDescriptions(contract.$defs[definitionName]));
        }
      }
    }
  });
});

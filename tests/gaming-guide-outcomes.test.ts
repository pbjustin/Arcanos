import { describe, expect, it } from '@jest/globals';
import { createGamingHybridWorkflow } from '../src/services/gamingHybridKnowledge.js';
import { gamingGuideSearchHint, projectGamingGuideOutcome } from '../src/shared/gaming/gamingHybridPolicyCore.js';
import { isGamingMcpOutput } from '../src/shared/chatgpt/gamingMcpContract.js';
import { gamingApplicabilityScopeRequired } from '../src/shared/gaming/gamingGuideApplicability.js';
import type { GamingHybridResponse } from '../src/shared/gaming/gamingHybridContract.js';

const base: GamingHybridResponse = { contractVersion: 'gaming-hybrid-v1', requestId: 'guide-outcome-fixture',
  state: 'discovery_required', nextAction: 'search', reason: 'COVERAGE_INSUFFICIENT', sourceKnown: false,
  evidenceSelected: false, freshnessStatus: 'unverified' };
const empty = { context: '', sources: [], evidence: [], sourceKnown: false };
const query = { contractVersion: 'gaming-hybrid-v2', idempotencyKey: 'guide-outcome-query', game: 'Elden Ring',
  question: 'Build an early-game Samurai katana build.', mode: 'build', class: 'Samurai',
  progressPoint: 'just left the tutorial' };
const actor = { actorKey: 'guide-outcome-reader' };

describe('four guide frontend outcomes preserve workflow authority', () => {
  it.each(['SOURCE_TOO_LARGE', 'SOURCE_INACCESSIBLE', 'SOURCE_TIMEOUT', 'SOURCE_EXTRACTION_FAILED',
    'UNSUPPORTED_SOURCE_FORMAT', 'URL_BLOCKED', 'GAME_MISMATCH', 'QUESTION_COVERAGE_INSUFFICIENT'])
  ('maps replacement reason %s even after bounded discovery is exhausted', reason => {
    expect(projectGamingGuideOutcome({ ...base, nextAction: 'stop', reason })).toEqual({ frontendOutcome: 'need_new_source' });
  });

  it('maps only actionable, approved answer and targeted clarification states', () => {
    expect(projectGamingGuideOutcome({ ...base, state: 'answer_ready', nextAction: 'answer',
      answer: { response: 'Grounded answer', sources: [], provenance: 'arcanos-trinity', requestId: base.requestId } }))
      .toEqual({ frontendOutcome: 'answer_ready' });
    expect(projectGamingGuideOutcome({ ...base, state: 'clarification_required', nextAction: 'clarify' }))
      .toEqual({ frontendOutcome: 'clarification_required' });
    expect(projectGamingGuideOutcome({ ...base, state: 'temporarily_unavailable', nextAction: 'retry_later' }))
      .toEqual({ frontendOutcome: 'temporarily_unavailable' });
    expect(projectGamingGuideOutcome({ ...base, state: 'ingestion_pending', nextAction: 'poll_ingestion' })).toEqual({});
  });

  it('does not clarify harmless absent metadata and emits a public topic hint', async () => {
    const workflow = createGamingHybridWorkflow({ retrieve: async () => empty });
    const result = await workflow.query(query, actor);
    expect(result.body).toMatchObject({ frontendOutcome: 'need_new_source', nextAction: 'search',
      searchHint: 'Elden Ring early game Samurai katana build guide' });
    expect(result.body.clarification).toBeUndefined();
    expect(isGamingMcpOutput('arcanos_gaming_hybrid_query', { statusCode: result.status, result: result.body })).toBe(true);
  });

  it('keeps a material build-goal clarification distinct from replacement discovery', async () => {
    const { class: _class, progressPoint: _progress, ...ambiguous } = query;
    const result = await createGamingHybridWorkflow({ retrieve: async () => empty }).query({ ...ambiguous,
      idempotencyKey: 'guide-outcome-ambiguous', question: 'Recommend a build.' }, actor);
    expect(result.body).toMatchObject({ frontendOutcome: 'clarification_required', nextAction: 'clarify', reason: 'BUILD_GOAL_REQUIRED' });
  });

  it('does not mistake the verb control for a platform-specific controls request', async () => {
    const question = 'How do I control stamina in Elden Ring?';
    expect(gamingApplicabilityScopeRequired({ question }, 'platform')).toBe(false);
    const result = await createGamingHybridWorkflow({ retrieve: async () => empty }).query({ ...query,
      mode: 'guide', question, idempotencyKey: 'guide-outcome-control-stamina' }, actor);
    expect(result.body).toMatchObject({ frontendOutcome: 'need_new_source', nextAction: 'search' });
    expect(result.body.clarification).toBeUndefined();
  });

  it.each([
    ['What keybindings should I use for Unsheathe?', 'PLATFORM_REQUIRED'],
    ['What are the keyboard controls for a Samurai?', 'PLATFORM_REQUIRED'],
    ['Which control scheme should I use?', 'PLATFORM_REQUIRED'],
    ['What is the regional release time?', 'REGION_REQUIRED']
  ] as const)('clarifies only the missing material scope in %s', async (question, reason) => {
    const result = await createGamingHybridWorkflow({ retrieve: async () => empty }).query({ ...query,
      mode: 'guide', question, idempotencyKey: 'guide-outcome-material-scope' }, actor);
    expect(result.body).toMatchObject({ frontendOutcome: 'clarification_required', nextAction: 'clarify', reason });
    expect(result.body.clarification).toMatch(reason === 'PLATFORM_REQUIRED' ? /platform/iu : /region/iu);
    expect(result.body.discovery).toBeUndefined();
  });

  it.each([
    ['What keybindings should I use for Unsheathe?', { platform: 'PC' }],
    ['What is the regional release time?', { region: 'Europe' }]
  ] as const)('continues discovery once material scope is supplied for %s', async (question, scope) => {
    const result = await createGamingHybridWorkflow({ retrieve: async () => empty }).query({ ...query, ...scope,
      mode: 'guide', question, idempotencyKey: 'guide-outcome-supplied-scope' }, actor);
    expect(result.body).toMatchObject({ frontendOutcome: 'need_new_source', nextAction: 'search' });
    expect(result.body.clarification).toBeUndefined();
  });

  it('clarifies an unnamed requested expansion build without defaulting it to the base game', async () => {
    const result = await createGamingHybridWorkflow({ retrieve: async () => empty }).query({ ...query,
      question: 'Recommend a Samurai DLC build.', idempotencyKey: 'guide-outcome-unspecified-dlc' }, actor);
    expect(result.body).toMatchObject({ frontendOutcome: 'clarification_required', nextAction: 'clarify', reason: 'EDITION_REQUIRED' });
    expect(result.body.clarification).toContain('Shadow of the Erdtree');
  });

  it.each([
    ['Recommend a Samurai build for Shadow of the Erdtree.', {}],
    ['Recommend a Samurai DLC build.', { edition: 'Shadow of the Erdtree' }],
    ['Is DLC required to obtain the Uchigatana?', {}]
  ] as const)('does not ask for an edition already established or immaterial to %s', async (question, scope) => {
    const result = await createGamingHybridWorkflow({ retrieve: async () => empty }).query({ ...query, ...scope,
      mode: 'guide', question, idempotencyKey: 'guide-outcome-known-edition' }, actor);
    expect(result.body).toMatchObject({ frontendOutcome: 'need_new_source', nextAction: 'search' });
    expect(result.body.clarification).toBeUndefined();
  });

  it('retains the v1 scope continuation instead of adding a new clarification gate', async () => {
    const result = await createGamingHybridWorkflow({ retrieve: async () => empty }).query({ ...query,
      contractVersion: 'gaming-hybrid-v1', mode: 'guide', question: 'What keybindings should I use?',
      idempotencyKey: 'guide-outcome-v1-scope' }, actor);
    expect(result.body).toMatchObject({ frontendOutcome: 'need_new_source', nextAction: 'search' });
    expect(result.body.clarification).toBeUndefined();
  });

  it('maps backend outage to temporarily unavailable without public absence claims', async () => {
    const result = await createGamingHybridWorkflow({ retrieve: async () => { throw new Error('private backend details'); } }).query(query, actor);
    expect(result).toMatchObject({ status: 503, body: { frontendOutcome: 'temporarily_unavailable', reason: 'SERVICE_UNAVAILABLE' } });
    expect(JSON.stringify(result.body)).not.toContain('private backend details');
  });

  it('maps acquired source failure without renewing an exhausted v1 budget', async () => {
    const workflow = createGamingHybridWorkflow({ retrieve: async () => empty,
      evaluateCandidates: async () => ({ knowledge: empty, accepted: [],
        decisions: [{ submittedIndex: 0, decision: 'rejected', reasonCodes: ['SOURCE_FETCH_FAILED'] }] }) });
    const first = await workflow.query({ ...query, contractVersion: 'gaming-hybrid-v1' }, actor);
    const result = await workflow.candidates({ contractVersion: 'gaming-hybrid-v1', workflowId: first.body.workflowId,
      idempotencyKey: 'guide-outcome-source', candidates: [{ url: 'https://guides.example.org/samurai' }] }, actor);
    expect(result.body).toMatchObject({ frontendOutcome: 'need_new_source', nextAction: 'stop',
      discovery: { round: 1, maxRounds: 1, continuationRequired: false } });
  });

  it('projects sufficient evidence to an answer through the existing workflow', async () => {
    const fetchedAt = new Date().toISOString();
    const url = 'https://guides.example.org/copper-gate';
    const knowledge = { context: '', sources: [{ sourceId: 'source-1', url, sourceType: 'supplied', fetchedAt,
      snippet: 'Open the copper gate using the copper key.' }], evidence: [{ sourceId: 'source-1', revisionId: 'revision-1',
      recordId: 'record-1', recordType: 'guide' as const, publicUrl: url, text: 'Open the copper gate using the copper key.',
      lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt } }] };
    const workflow = createGamingHybridWorkflow({ retrieve: async () => knowledge,
      generate: async (_input, prepared) => ({ ok: true, route: 'gaming', mode: 'guide', data: {
        response: 'Open the copper gate using the copper key. [1]', sources: prepared!.knowledge.sources,
        grounding: { groundingStatus: 'grounded' } } }) as never });
    const result = await workflow.query({ contractVersion: 'gaming-hybrid-v1', idempotencyKey: 'guide-outcome-answer',
      game: 'Lantern Voyage', question: 'How do I open the copper gate?' }, actor);
    expect(result.body).toMatchObject({ frontendOutcome: 'answer_ready', state: 'answer_ready', nextAction: 'answer' });
  });

  it('excludes private player, account and freeform class strings from search hints', () => {
    expect(gamingGuideSearchHint({ game: 'Elden Ring', question: 'Samurai katana build for account private-user@example.org GuildMoonstone',
      class: 'GuildMoonstone' })).toBe('Elden Ring Samurai katana build guide');
    expect(gamingGuideSearchHint({ game: 'Elden Ring', question: 'build', class: 'private character 123456789' }))
      .toBe('Elden Ring build guide');
  });

  it('declares bounded optional fields without breaking old responses', () => {
    expect(isGamingMcpOutput('arcanos_gaming_hybrid_query', { statusCode: 200, result: base })).toBe(true);
    expect(isGamingMcpOutput('arcanos_gaming_hybrid_query', { statusCode: 200, result: { ...base,
      frontendOutcome: 'need_new_source', searchHint: 'Elden Ring guide' } })).toBe(true);
    for (const change of [{ frontendOutcome: 'unknown' }, { searchHint: 'x'.repeat(351) }, { searchHint: '' }]) {
      expect(isGamingMcpOutput('arcanos_gaming_hybrid_query', { statusCode: 200, result: { ...base, ...change } })).toBe(false);
    }
  });
});

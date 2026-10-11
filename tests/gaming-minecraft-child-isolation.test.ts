import { describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';
import type { ResolvedGamingDocument } from '../src/services/gamingDocumentResolution.js';

const fetch = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(fetch) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { createGamingHybridWorkflow } = await import('../src/services/gamingHybridKnowledge.js');
const url = 'https://guides.example.org/story-mode-lever';
const title = 'Minecraft Story Mode crafting guide';
const story = "In Minecraft Story Mode, Jesse crafts a lever by placing cobblestone and a stick in the crafting grid. Collect a stick and cobblestone before opening the crafting grid. Put the stick above the cobblestone to craft the lever. Use the lever to open the door in Jesse's adventure.";
const minecraft = 'In Minecraft, collect a stick and cobblestone. Put the stick above the cobblestone in the crafting grid to craft a lever. Use the lever to control a redstone signal.';
const question = 'How do I craft a lever?';
const actor = { actorKey: 'minecraft-child-caller', workflowId: 'minecraft-child-workflow' };
const input = { game: 'Minecraft', mode: 'guide' as const, prompt: question, protocolVersion: 'gaming-hybrid-v2' as const, candidates: [{ url }] };
function document(text = story, pageTitle = title): ResolvedGamingDocument {
  return { requestedUrl: url, canonicalUrl: url, publicUrl: url, host: 'guides.example.org', text,
    metadata: { title: pageTitle }, extraction: { strategy: 'article', rawTextLength: text.length, cleanedTextLength: text.length, navigationDensity: 0 },
    resolution: { resolverId: 'generic-web', resolverVersion: 'gaming-document-v1', strategy: 'article', documentType: 'html', supportsStructuredExtraction: false },
    metrics: { rawTextLength: text.length, cleanedTextLength: text.length, instructionFiltered: false, truncated: false } };
}
function serve(text = story, pageTitle = title) {
  fetch.mockImplementation(async () => ({ status: 200, headers: { 'content-type': 'text/html' },
    data: `<html><title>${pageTitle}</title><body><article><h1>${pageTitle}</h1><p>${text}</p></article></body></html>` }));
}
const identity = (doc = document(), game = 'Minecraft') => assessGamingClearSourceIdentity(doc,
  { ...input, game }, assessGamingSourcePolicy(url, game));

describe('closed Minecraft child identity', () => {
  it('rejects acquired Story Mode title and body as another game for the parent', () => {
    expect(identity()).toEqual({ status: 'conflict', gameIdentityVerified: false, reasonCodes: ['GAME_MISMATCH'],
      diagnostic: { ruleId: 'gaming.identity.distinct_title_scope', evidenceCategory: 'document_title' } });
  });
  it('rejects an affirmative child subject even after valid parent-game prose', () => {
    expect(identity(document(`${minecraft} ${story}`, 'Minecraft crafting guide')))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });
  it('keeps the complete requested Story Mode game identity valid', () => {
    expect(identity(document(), 'Minecraft Story Mode').status).toBe('verified');
  });
  it.each([
    '"In Minecraft Story Mode, the adventure has a crafting scene."',
    'Unlike in Minecraft Story Mode, this recipe controls redstone.',
    'As in Minecraft Story Mode, the guide describes a lever.',
    'Like in Minecraft Story Mode, the guide describes a lever.',
    'These recommendations do not apply in Minecraft Story Mode.'
  ])('does not turn a quoted, comparison or negative reference into a child subject: %s', reference => {
    expect(identity(document(`${minecraft} ${reference}`, 'Minecraft crafting guide')).status).toBe('verified');
  });
  it('rejects the child before reporting a narrower acquired edition decision', () => {
    expect(identity(document(`${story} This mechanic is Java-only.`)))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });
  it('does not let a Java qualifier erase a following explicit child scope', () => {
    expect(identity(document(story.replace('Minecraft Story Mode', 'Minecraft Java Story Mode'), 'Minecraft Java Story Mode crafting guide')))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });
});

describe('independently acquired child-game isolation', () => {
  it('rejects the protected-acquisition regression without Game or Edition labels', async () => {
    serve();
    const result = await evaluateGamingHybridCandidates(input, actor);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.accepted).toEqual([]);
    expect(result.decisions[0].reasonCodes).toContain('GAME_MISMATCH');
    expect(result.knowledge.sources).toEqual([]);
  });
  it('ignores frontend claims that the acquired child guide belongs to the parent', async () => {
    serve();
    const result = await evaluateGamingHybridCandidates({ ...input, candidates: [{ url, title: 'Minecraft Java crafting guide', claimedGame: 'Minecraft', claimedPatch: 'latest' }] }, actor);
    expect(result.accepted).toEqual([]);
    expect(result.decisions[0].reasonCodes).toContain('GAME_MISMATCH');
  });
  it('accepts the same acquired guide when the complete requested game is Story Mode', async () => {
    serve();
    const result = await evaluateGamingHybridCandidates({ ...input, game: 'Minecraft Story Mode' }, actor);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].sourceAssessment.gates.identity).toBe('verified');
    expect(result.knowledge.sources[0].game).toBe('Minecraft Story Mode');
  });
  it('returns replacement-source behavior before generation or durable ingestion', async () => {
    serve();
    const generate = jest.fn();
    const ingest = jest.fn();
    const workflow = createGamingHybridWorkflow({ retrieve: async () => ({ context: '', sources: [], sourceKnown: false }), generate, ingest });
    const queried = await workflow.query({ contractVersion: 'gaming-hybrid-v2', idempotencyKey: 'minecraft-child-query', game: 'Minecraft', mode: 'guide', question, storagePolicy: 'transient_only' }, actor);
    const result = await workflow.candidates({ contractVersion: 'gaming-hybrid-v2', workflowId: queried.body.workflowId,
      expectedRevision: queried.body.revision, idempotencyKey: 'minecraft-child-submit', candidates: input.candidates }, actor);
    expect(result.body.frontendOutcome).toBe('need_new_source');
    expect(result.body.candidates?.[0].reasonCodes).toContain('GAME_MISMATCH');
    expect(result.body.evidenceSelected).not.toBe(true);
    expect(result.body.answer).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });
});

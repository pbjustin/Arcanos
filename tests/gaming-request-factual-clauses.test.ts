import { describe, expect, it } from '@jest/globals';
import { selectGamingHybridEvidence } from '../src/services/gamingHybridCandidates.js';
import { assessGamingRequestCoverage } from '../src/shared/gaming/gamingClearEvidence.js';
import { buildGamingRequestRequirements } from '../src/shared/gaming/gamingRetrievalPolicy.js';
import type { GamingStoredKnowledgeContext, GamingStoredKnowledgeInput } from '../src/shared/gaming/gamingStoredEvidenceCore.js';

// Independently authored grammar/control fixtures, not publisher quotations or
// real Elite Dangerous mechanics. No provider, network or durable storage runs.
const firstThree = 'To start system colonisation, visit the colonisation contact. '
  + 'Next, select an uninhabited system on the colonisation map. '
  + 'Then register the system colonisation claim using credits.';
const firstTwo = 'To start system colonisation, visit the colonisation contact. '
  + 'Next, select an uninhabited system on the colonisation map.';
const prerequisites = 'Before starting system colonisation, you must obtain a survey permit.';
const materials = 'The materials required for system colonisation are cargo plates and beacon coils.';
const locations = 'The system colonisation materials, cargo plates and beacon coils, are sold at orbital depots.';
const actionQuestion = 'Explain the first three actions needed for system colonisation.';
const materialQuestion = 'What materials do I need for system colonisation and where can I find them?';

/** Keep the factual question intact while allowing scoped negative controls. */
function request(prompt: string, overrides: Partial<GamingStoredKnowledgeInput> = {}): GamingStoredKnowledgeInput {
  return { game: 'Elite Dangerous', mode: 'guide', prompt, ...overrides };
}

/** Bind authored passages to one already accepted source with exact citations. */
function knowledge(texts: string[], game = 'Elite Dangerous'): GamingStoredKnowledgeContext {
  const fetchedAt = '2026-11-10T12:00:00.000Z';
  const source = { sourceId: 'accepted-factual-guide', game, url: 'https://guides.example.org/authored-factual-clauses',
    sourceType: 'supplied', origin: 'live' as const, fetchedAt, snippet: texts[0] ?? '' };
  return { context: '', sources: [source], evidence: texts.map((text, index) => ({
    sourceId: source.sourceId, revisionId: 'factual-revision', recordId: `factual-passage-${index}`, recordType: 'guide',
    publicUrl: source.url, text, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt }
  })) };
}

describe('factual request clauses retain subject, relation and requested count', () => {
  it('covers the first three acquired actions without demanding literal first/three/needed wording', () => {
    const input = request(actionQuestion);
    expect(buildGamingRequestRequirements(input).length).toBeGreaterThan(0);
    const original = knowledge([firstThree]);
    const selected = selectGamingHybridEvidence(input, original);
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.selectedEvidenceIds).toEqual(['factual-passage-0']);
    expect(selected.knowledge.evidence![0]).toEqual(original.evidence![0]);
    expect(selected.knowledge.sources[0].url).toBe(original.sources[0].url);
  });

  it.each([
    ['only two actions', firstTwo],
    ['one action with three objects', 'To start system colonisation, inspect the contact, map and claim.'],
    ['three numerical topic mentions', 'System colonisation has 3 categories, 3 map markers and 3 icons.'],
    ['three nominal labels', 'First three actions needed for system colonisation: contact, map, claim.'],
    ['one duplicated action', 'To start system colonisation, visit the colonisation contact. '
      + 'To start system colonisation, visit the colonisation contact. To start system colonisation, visit the colonisation contact.'],
    ['unrelated additional procedures', 'To start system colonisation, visit the colonisation contact. '
      + 'To start trading, open the trading panel. Then buy a trading permit.']
  ])('does not satisfy three factual actions using %s', (_label, text) => {
    expect(assessGamingRequestCoverage(request(actionQuestion), knowledge([text])).coverageSatisfied).toBe(false);
  });

  it('preserves a separate prerequisite and its three ordered starting actions', () => {
    const input = request('Explain system colonisation prerequisites and its first three actions.');
    expect(assessGamingRequestCoverage(input, knowledge([prerequisites, firstThree])).coverageSatisfied).toBe(true);
    expect(assessGamingRequestCoverage(input, knowledge([firstThree])).coverageSatisfied).toBe(false);
    expect(assessGamingRequestCoverage(input, knowledge([prerequisites, firstTwo])).coverageSatisfied).toBe(false);
  });

  it('binds same-sentence them to the materials requirement and requires their acquisition location', () => {
    const input = request(materialQuestion);
    expect(buildGamingRequestRequirements(input)).toHaveLength(2);
    const original = knowledge([`${materials} ${locations}`]);
    const selected = selectGamingHybridEvidence(input, original);
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.requirementSupport).toHaveLength(2);
    expect(selected.requirementSupport.every(item => item.evidenceIds.includes('factual-passage-0'))).toBe(true);
    expect(selected.knowledge.evidence![0]).toEqual(original.evidence![0]);
  });

  it.each([
    ['no location', materials],
    ['another object location', `${materials} The copper key is sold at the orbital depot.`],
    ['another activity materials', `${materials} The materials for trading are sold at the orbital depot.`],
    ['no material requirement', locations],
    ['metadata without gameplay', 'System colonisation materials and locations guide. This guide lists materials and where to find them.']
  ])('does not fabricate the materials/acquisition relationship from %s', (_label, text) => {
    expect(assessGamingRequestCoverage(request(materialQuestion), knowledge([text])).coverageSatisfied).toBe(false);
  });

  it('keeps required materials independent of starting actions', () => {
    const input = request('Explain how to start system colonisation and identify required materials.');
    expect(assessGamingRequestCoverage(input, knowledge([firstThree, materials])).coverageSatisfied).toBe(true);
    expect(assessGamingRequestCoverage(input, knowledge([firstThree])).coverageSatisfied).toBe(false);
    expect(assessGamingRequestCoverage(input, knowledge([firstThree, 'The materials required for trading are cargo plates.'])).coverageSatisfied).toBe(false);
  });

  it('retains the existing single starting-procedure question', () => {
    expect(assessGamingRequestCoverage(request('How do I start system colonisation?'), knowledge([firstThree])).coverageSatisfied).toBe(true);
    expect(assessGamingRequestCoverage(request('How do I start system colonisation?'), knowledge(['System colonisation is optional.'])).coverageSatisfied).toBe(false);
  });

  it.each([
    'List the prerequisites.',
    'Where can I find them?',
    'Find a guide, explain the mechanics and cite your sources.'
  ])('keeps missing factual scope unresolved: %s', prompt => {
    const assessment = assessGamingRequestCoverage(request(prompt), knowledge([
      'System colonisation mechanics require a survey permit. List the prerequisites before visiting a contact.'
    ]));
    expect(assessment.coverageSatisfied).toBe(false);
    expect(['unknown', 'not_assessed']).toContain(assessment.gapAssessmentStatus);
  });

  it('does not invent a material referent across request sentences', () => {
    const input = request('What materials do I need for system colonisation? Where can I find them?');
    expect(assessGamingRequestCoverage(input, knowledge([`${materials} ${locations}`])).coverageSatisfied).toBe(false);
  });

  it('preserves the named Requirements for Victory acquisition object', () => {
    const input = request('Where do I obtain the Requirements for Victory book?');
    expect(assessGamingRequestCoverage(input, knowledge(['The Requirements for Victory book is sold at the orbital depot.'])).coverageSatisfied).toBe(true);
    expect(assessGamingRequestCoverage(input, knowledge(['The Victory book is sold at the orbital depot.'])).coverageSatisfied).toBe(false);
  });

  it('rejects wrong-game evidence despite the same action vocabulary', () => {
    expect(selectGamingHybridEvidence(request(actionQuestion), knowledge([firstThree], 'Elite Dangerous II')).coverageSatisfied).toBe(false);
  });

  it('does not clip away the requested factual count when the context budget is insufficient', () => {
    const input = request(actionQuestion, { maxContextChars: 80 });
    const selected = selectGamingHybridEvidence(input, knowledge([firstThree]));
    expect(selected.coverageSatisfied).toBe(false);
    expect(selected.knowledge.context.length).toBeLessThanOrEqual(80);
  });

  it.each([0, 9])('keeps a first-%s action request outside the supported positive count bound unresolved', count => {
    const assessment = assessGamingRequestCoverage(request(`Explain the first ${count} actions needed for system colonisation.`), knowledge([firstThree]));
    expect(assessment.coverageSatisfied).toBe(false);
    expect(assessment.gapAssessmentStatus).toBe('not_assessed');
  });

  it('does not erase an action count from a quoted acquisition title', () => {
    const input = request('Where do I obtain the "First Three Actions" book?');
    expect(assessGamingRequestCoverage(input, knowledge(['The First Three Actions book is sold at the orbital depot.'])).coverageSatisfied).toBe(true);
    expect(assessGamingRequestCoverage(input, knowledge(['The book is sold at the orbital depot.'])).coverageSatisfied).toBe(false);
  });

  it.each([
    'Cargo plates, one of the system colonisation materials, are sold at orbital depots.',
    'System colonisation materials except beacon coils are sold at orbital depots.',
    'System colonisation materials excluding beacon coils are sold at orbital depots.'
  ])('does not treat a qualified material subset as the location of all required materials: %s', location => {
    const partial = `${materials} ${location}`;
    expect(assessGamingRequestCoverage(request(materialQuestion), knowledge([partial])).coverageSatisfied).toBe(false);
  });

  it('does not borrow an incidental topic from another activity material requirement or location', () => {
    const unrelated = 'The materials required for trading beside the system colonisation terminal are cargo plates and beacon coils. '
      + 'These trading materials beside the system colonisation terminal are sold at orbital depots.';
    expect(assessGamingRequestCoverage(request(materialQuestion), knowledge([unrelated])).coverageSatisfied).toBe(false);
  });

  it('does not combine alternative one-action and two-action starting routes into a three-action procedure', () => {
    const alternatives = 'To begin system colonisation, visit the northern contact. '
      + 'Alternatively, to begin system colonisation, visit the southern contact and select a different starting system.';
    expect(assessGamingRequestCoverage(request(actionQuestion), knowledge([alternatives])).coverageSatisfied).toBe(false);
    expect(assessGamingRequestCoverage(request(actionQuestion), knowledge([firstThree])).coverageSatisfied).toBe(true);
  });
});

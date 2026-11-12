import { describe, expect, it } from '@jest/globals';
import { filterGamingDocumentInstructions } from '../src/services/gamingDocumentExtraction.js';
import { selectGamingHybridEvidence } from '../src/services/gamingHybridCandidates.js';
import { assessGamingClearEvidence, assessGamingRequestCoverage } from '../src/shared/gaming/gamingClearEvidence.js';
import { buildGamingRequestRequirements, gamingAttributableClaimText, gamingRequestScopeUnresolved, gamingRequirementSupported, scopeGamingEvidenceParagraphs } from '../src/shared/gaming/gamingRetrievalPolicy.js';
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

  it('does not count unbound same-paragraph imperatives as ordered actions', () => {
    const input = request('Explain the first three actions needed for fishing.');
    const passage = 'To start fishing, equip a rod. Buy a helmet for arena combat. Register for a sword tournament.';
    const data = knowledge([passage]);
    expect(gamingRequirementSupported(passage, buildGamingRequestRequirements(input)[0])).toBe(false);
    expect(assessGamingRequestCoverage(input, data).coverageSatisfied).toBe(false);
    const selected = selectGamingHybridEvidence(input, data);
    expect(selected.coverageSatisfied).toBe(false);
    expect(selected.selectedEvidenceIds).toEqual([]);
    expect(assessGamingClearEvidence(input, data, { requireRequestCoverage: true }).gates.claimSupport).not.toBe('verified');
  });

  it('keeps a period-numbered continuation attached to its action', () => {
    const input = request('Explain the first two actions needed for fishing.');
    const passage = 'To start fishing, equip a rod. 2. Use the rod.';
    expect(gamingRequirementSupported(passage, buildGamingRequestRequirements(input)[0])).toBe(true);
    expect(gamingAttributableClaimText(passage, input.game)).toContain('2. Use the rod.');
    const scoped = filterGamingDocumentInstructions(scopeGamingEvidenceParagraphs(passage, input));
    expect(assessGamingRequestCoverage(input, knowledge([scoped])).coverageSatisfied).toBe(true);
  });

  it('retains a period-numbered first action under an explicit start anchor', () => {
    const input = request('Explain the first three actions needed for fishing.');
    const passage = 'To start fishing: 1. Equip a rod. 2. Inspect the rod. 3. Use the rod.';
    expect(gamingRequirementSupported(passage, buildGamingRequestRequirements(input)[0])).toBe(true);
    expect(assessGamingRequestCoverage(input, knowledge([passage])).coverageSatisfied).toBe(true);
  });

  it('keeps an explicitly anchored first ordinal when scoping later numbered actions', () => {
    const input = request('Explain the first two actions needed for fishing.');
    const passage = '1) To start fishing, equip a rod. 2) Inspect the rod at the pond.';
    expect(assessGamingRequestCoverage(input, knowledge([passage])).coverageSatisfied).toBe(true);
    const scoped = filterGamingDocumentInstructions(scopeGamingEvidenceParagraphs(passage, input));
    expect(scoped).toBe(passage);
    expect(assessGamingRequestCoverage(input, knowledge([scoped])).coverageSatisfied).toBe(true);
  });

  it.each([
    'To start fishing, equip a rod. 2) Equip an arena helmet. 3) Open the tournament gate.',
    'To start fishing, equip a rod. 2) Inspect the arena helmet. 3) Use the rod.',
    'To start fishing, equip a rod. 2) Use the rod and open the tournament gate.',
    'To start fishing, equip a large rod. 2) Open the large gate. 3) Use the large rod.',
    'To start fishing, equip a rod. 2) Equip the arena rod. 3) Use the rod.',
    'To start fishing, equip a rod. 2) Inspect the boss rod. 3) Use the boss rod.',
    'To start fishing, equip the rod mk 1. 2) Equip the rod mk 2. 3) Inspect the rod mk 2.',
    'To start fishing, equip a rod. 2) Open the gate while carrying the rod. 3) Use the rod.',
    'To start fishing, equip a rod. 2) Inspect the rod. 4) Use the rod.'
  ])('does not treat unbound or nonconsecutive ordinals as a complete fishing sequence: %s', passage => {
    const input = request('Explain the first three actions needed for fishing.');
    const data = knowledge([passage]);
    expect(gamingRequirementSupported(passage, buildGamingRequestRequirements(input)[0])).toBe(false);
    expect(assessGamingRequestCoverage(input, data).coverageSatisfied).toBe(false);
    expect(selectGamingHybridEvidence(input, data).selectedEvidenceIds).toEqual([]);
    expect(assessGamingClearEvidence(input, data, { requireRequestCoverage: true }).gates.claimSupport).not.toBe('verified');
  });

  it('does not partially count or retain an ordinal that coordinates an unrelated action', () => {
    const input = request('Explain the first two actions needed for fishing.');
    const passage = 'To start fishing, equip a rod. 2) Use the rod and open the tournament gate.';
    expect(gamingRequirementSupported(passage, buildGamingRequestRequirements(input)[0])).toBe(false);
    expect(assessGamingRequestCoverage(input, knowledge([passage])).coverageSatisfied).toBe(false);
    expect(scopeGamingEvidenceParagraphs(passage, input)).toBe('To start fishing, equip a rod.');
  });

  it('preserves the original numbered claim text and covers explicitly connected actions in selected evidence', () => {
    const input = request('Explain the first three actions needed for fishing.');
    const unrelated = 'To start fishing, equip a rod. 2) Inspect the pond. 3) Use the rod.';
    expect(gamingAttributableClaimText(unrelated, input.game)).toContain('2) Inspect the pond.');
    // The ordinal preserves source order, but it cannot establish why an otherwise unbound action belongs.
    expect(assessGamingRequestCoverage(input, knowledge([unrelated])).coverageSatisfied).toBe(false);
    const passage = 'To start fishing, equip a rod. 2) Inspect the rod. 3) Use the rod.';
    const data = knowledge([passage]);
    expect(gamingRequirementSupported(passage, buildGamingRequestRequirements(input)[0])).toBe(true);
    expect(assessGamingRequestCoverage(input, data).coverageSatisfied).toBe(true);
    const selected = selectGamingHybridEvidence(input, data);
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.selectedEvidenceIds).toEqual(['factual-passage-0']);
    expect(selected.knowledge.evidence![0]).toEqual(data.evidence![0]);
    expect(assessGamingClearEvidence(input, selected.knowledge, { requireRequestCoverage: true }).gates.claimSupport).toBe('verified');
  });

  it.each(['This guide provides a glossary.', '\n\n'])('does not attach an orphan ordinal across a removed clause or paragraph: %s', gap => {
    const input = request('Explain the first two actions needed for fishing.');
    const passage = 'To start fishing, equip a rod. ' + gap + ' 2) Use the rod for fishing.';
    const scoped = filterGamingDocumentInstructions(scopeGamingEvidenceParagraphs(passage, input));
    expect(assessGamingRequestCoverage(input, knowledge([passage])).coverageSatisfied).toBe(false);
    expect(assessGamingRequestCoverage(input, knowledge([scoped])).coverageSatisfied).toBe(false);
  });

  it.each([
    'Selling fishing gear requires a trade licence.',
    'Fishing gear sales require a trade licence.'
  ])('does not borrow the prerequisite of an incidental activity: %s', passage => {
    const input = request('Explain fishing prerequisites and the first concrete steps.');
    const start = 'To start fishing, equip a rod and use it at the pond.';
    const data = knowledge([passage, start]);
    const requirement = buildGamingRequestRequirements(input).find(item => item.procedure === 'prerequisite')!;
    expect(gamingRequirementSupported(passage, requirement)).toBe(false);
    expect(assessGamingRequestCoverage(input, data).coverageSatisfied).toBe(false);
    const selected = selectGamingHybridEvidence(input, data);
    expect(selected.coverageSatisfied).toBe(false);
    expect(selected.selectedEvidenceIds).toEqual(['factual-passage-1']);
    expect(assessGamingClearEvidence(input, data, { requireRequestCoverage: true }).gates.claimSupport).not.toBe('verified');
    expect(assessGamingRequestCoverage(input, knowledge(['Fishing requires a rod.', start])).coverageSatisfied).toBe(true);
  });

  it('binds a registration cost to the registered object and its stated purpose', () => {
    const input = request('Explain prism tuning prerequisites.', { game: 'Lantern Vale' });
    const passage = 'The cost to register an amber prism for tuning requires spending two silver tokens.';
    const data = knowledge([passage], input.game);
    const requirement = buildGamingRequestRequirements(input)[0];
    expect(gamingRequirementSupported(passage, requirement)).toBe(true);
    expect(gamingRequirementSupported('Registering an amber prism near the tuning station for trading requires two tokens.', requirement)).toBe(false);
    const selected = selectGamingHybridEvidence(input, data);
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.selectedEvidenceIds).toEqual(['factual-passage-0']);
    expect(assessGamingClearEvidence({ ...input, game: input.game! }, selected.knowledge,
      { requireRequestCoverage: true }).gates.claimSupport).toBe('verified');
  });

  it.each([
    ['What is the boss weakness during its first phase?',
      'The boss weakness during its first phase is frost damage. Equip a frost weapon while the boss remains in this first phase.'],
    ['How do I damage the Guardian in its first form?',
      'The Guardian in its first form takes additional frost damage. Attack the Guardian with a frost weapon in its first form.']
  ])('preserves ordinary first-phase/form scope instead of treating it as an unresolved procedure: %s', (prompt, passage) => {
    const input = request(prompt);
    const data = knowledge([passage]);
    expect(gamingRequestScopeUnresolved(input)).toBe(false);
    expect(assessGamingRequestCoverage(input, data).coverageSatisfied).toBe(true);
    const selected = selectGamingHybridEvidence(input, data);
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.knowledge.evidence![0]).toEqual(data.evidence![0]);
    expect(assessGamingClearEvidence(input, selected.knowledge, { requireRequestCoverage: true }).gates.claimSupport).toBe('verified');
  });

  it.each([
    'Explain its first three actions.',
    'Explain its first 3 actions.',
    'Explain its first three ordered actions.',
    'Explain its first 3 concrete actions.',
    'Explain its first concrete steps.',
    'Explain its first ordered steps.',
    'Where can I find them?'
  ])('retains the unresolved procedural/material referent guard: %s', prompt => {
    const input = request(prompt);
    expect(gamingRequestScopeUnresolved(input)).toBe(true);
    expect(assessGamingRequestCoverage(input, knowledge([firstThree])).coverageSatisfied).toBe(false);
  });

  it.each([
    'Does system colonisation require a permit?',
    'Does system colonisation need a permit?',
    'Does system colonisation require a permit',
    'System colonisation requires a permit?',
    'System colonisation has no prerequisites?'
  ])('does not promote an unanswered prerequisite question into acquired support: %s', passage => {
    const input = request('Explain system colonisation prerequisites.');
    const requirement = buildGamingRequestRequirements(input)[0];
    const data = knowledge([passage]);
    expect(requirement).toMatchObject({ procedure: 'prerequisite', terms: ['system', 'colonisation'] });
    expect(gamingRequirementSupported(passage, requirement)).toBe(false);
    expect(assessGamingRequestCoverage(input, data).coverageSatisfied).toBe(false);
    const selected = selectGamingHybridEvidence(input, data);
    expect(selected.coverageSatisfied).toBe(false);
    expect(selected.selectedEvidenceIds).toEqual([]);
    expect(assessGamingClearEvidence(input, data, { requireRequestCoverage: true }).gates.claimSupport).not.toBe('verified');
    expect(assessGamingClearEvidence(input, selected.knowledge, { requireRequestCoverage: true }).gates.claimSupport).not.toBe('verified');
  });

  it.each([
    'System colonisation requires a permit.',
    'System colonisation has no prerequisites.',
    'Do system colonisation only if you have a permit.'
  ])('preserves explicit prerequisite and absence-of-prerequisite assertions: %s', passage => {
    const input = request('Explain system colonisation prerequisites.');
    const requirement = buildGamingRequestRequirements(input)[0];
    const data = knowledge([passage]);
    expect(gamingAttributableClaimText(passage, input.game)).toBe(passage);
    expect(gamingRequirementSupported(passage, requirement)).toBe(true);
    const selected = selectGamingHybridEvidence(input, data);
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.selectedEvidenceIds).toEqual(['factual-passage-0']);
    expect(selected.knowledge.evidence![0].publicUrl).toBe(data.evidence![0].publicUrl);
    expect(assessGamingClearEvidence(input, selected.knowledge, { requireRequestCoverage: true }).gates.claimSupport).toBe('verified');
  });

  it('uses an independent prerequisite assertion after an unanswered question', () => {
    const input = request('Explain system colonisation prerequisites.');
    const passage = 'Does system colonisation require a permit? System colonisation requires a survey permit.';
    const data = knowledge([passage]);
    expect(gamingRequirementSupported(passage, buildGamingRequestRequirements(input)[0])).toBe(true);
    const selected = selectGamingHybridEvidence(input, data);
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.selectedEvidenceIds).toEqual(['factual-passage-0']);
    expect(assessGamingClearEvidence(input, selected.knowledge, { requireRequestCoverage: true }).gates.claimSupport).toBe('verified');
  });

  it('retains negative gameplay advice without treating one excluded permit as complete prerequisite proof', () => {
    const input = request('Explain system colonisation prerequisites.');
    const passage = 'System colonisation does not require a permit.';
    expect(gamingAttributableClaimText(passage, input.game)).toBe(passage);
    expect(gamingRequirementSupported(passage, buildGamingRequestRequirements(input)[0])).toBe(false);
    const data = knowledge([passage]);
    expect(assessGamingRequestCoverage(input, data).coverageSatisfied).toBe(false);
    expect(selectGamingHybridEvidence(input, data).coverageSatisfied).toBe(false);
    expect(assessGamingClearEvidence(input, data, { requireRequestCoverage: true }).gates.claimSupport).not.toBe('verified');
  });
});

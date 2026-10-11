import { assessGamingClearEvidence, assessGamingRequestCoverage } from '../src/shared/gaming/gamingClearEvidence.js';
import { buildGamingRequestRequirements, buildGamingRetrievalTerms } from '../src/shared/gaming/gamingRetrievalPolicy.js';
import type { GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';

const game = 'Elden Ring';
const preparation = 'At Church of Elleh in early Elden Ring, what is one safe preparation step before continuing? Avoid spoilers.';
// Synthetic acquired passages exercise coverage only; these are not captured publisher pages.
function knowledge(texts: string[], requestedGame = game): GamingStoredKnowledgeContext {
  const fetchedAt = '2026-10-11T00:00:00.000Z';
  const sources = texts.map((text, index) => ({ sourceId: `candidate-${index}`, game: requestedGame,
    url: `https://guides.example.org/ordinary-${index}`, sourceType: 'supplied', origin: 'live' as const, fetchedAt, snippet: text }));
  return { context: texts.join('\n\n'), sources, evidence: texts.map((text, index) => ({
    sourceId: sources[index].sourceId, revisionId: `revision-${index}`, recordId: `record-${index}`, recordType: 'guide',
    publicUrl: sources[index].url, text, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt }
  })) };
}

describe('ordinary gameplay request coverage', () => {
  test.each([
    'What should I do at the Church of Elleh before moving on?',
    'How do I avoid heavy rolling in Elden Ring?',
    'Which stat should an early-game Samurai using an Uchigatana level first?',
    'For sword and shield, how should I allocate stats?',
    'With sword, shield and armor, how should I allocate stats?',
    preparation,
    'At Copper Quay in Lantern Voyage, what is one safe preparation step before continuing? Avoid spoilers.'
  ])('does not invent independent requests from a single question: %s', prompt => {
    expect(buildGamingRequestRequirements({ game: prompt.includes('Lantern Voyage') ? 'Lantern Voyage' : game, prompt, mode: 'guide' })).toEqual([]);
  });

  test.each([
    'Avoid spoilers.', 'Keep it spoiler-free.', 'Without story spoilers.', 'and avoid spoilers.',
    ', please keep it brief and spoiler-free.'
  ])('keeps presentation instruction %s out of gameplay terms and requirements', preference => {
    const prompt = `At Church of Elleh in early Elden Ring, what is one safe preparation step before continuing? ${preference}`;
    expect(buildGamingRetrievalTerms({ game, prompt }).focusTerms).toEqual(['church', 'elleh', 'early', 'preparation']);
    expect(buildGamingRequestRequirements({ game, prompt })).toEqual([]);
  });

  test('accepts a narrow attributable preparation passage without an artificial second topic', () => {
    const input = { game, prompt: preparation, mode: 'guide' as const, spoilerMode: 'none' as const };
    const data = knowledge(['At the Church of Elleh, buy the crafting kit from the merchant to enable crafting useful supplies. This optional purchase provides an immediate preparation step.']);
    expect(assessGamingRequestCoverage(input, data)).toMatchObject({ coverageSatisfied: true, missingCoverage: [],
      requirementSupport: [{ requirement: 'requested topic', evidenceIds: ['record-0'] }] });
    expect(assessGamingClearEvidence(input, data, { requireRequestCoverage: true }).gates)
      .toMatchObject({ identity: 'verified', claimSupport: 'verified', provenance: 'verified' });
    expect(assessGamingRequestCoverage(input, knowledge(['Elden Ring is an action role-playing game. Its setting includes many locations.'])).coverageSatisfied).toBe(false);
  });

  test('preserves independent questions, comma lists and spoiler-safe conjunctions', () => {
    for (const prompt of ['Explain equipment load and stamina recovery. Avoid spoilers.',
      'Explain equipment load, stamina recovery, and flask upgrades.',
      'How does equipment load work? How does stamina recovery work?',
      'How do I repair the bridge? Also tell me how to open the gate.',
      'Explain equipment load; explain stamina recovery.',
      'Explain:\n- equipment load\n- stamina recovery',
      'Explain:\n1. equipment load\n2. stamina recovery']) {
      expect(buildGamingRequestRequirements({ game, prompt })).toHaveLength(prompt.includes('flask') ? 3 : 2);
    }
  });

  test('an additional question still needs its own coherent passage', () => {
    const input = { game: 'Lantern Voyage', prompt: 'How do I repair the bridge? Also tell me how to open the gate.', mode: 'guide' as const };
    expect(assessGamingRequestCoverage(input, knowledge(['Repair the bridge by replacing its damaged planks.'], input.game)))
      .toMatchObject({ coverageSatisfied: false, missingCoverage: ['requested topic 2'] });
    expect(assessGamingRequestCoverage(input, knowledge(['Repair the bridge by replacing its damaged planks.',
      'Open the gate by pulling the blue lever.'], input.game))).toMatchObject({ coverageSatisfied: true, missingCoverage: [] });
  });

  test('quoted source attribution does not create a gameplay or edition requirement', () => {
    const input = { game: 'Minecraft', prompt: 'The submitted guide is titled "Minecraft Java". How do I craft a crafting table?' };
    expect(buildGamingRequestRequirements(input)).toEqual([]);
    expect(buildGamingRetrievalTerms(input).focusTerms).toEqual(['craft', 'crafting', 'table']);
  });

  test.each([
    { game, prompt: 'How do I get the Sword of Night and Flame?', terms: ['sword', 'night', 'flame'],
      fragments: ['At night, buy a sword from the shop.', 'The Flame spell is sold by the mage.'],
      intact: 'The Sword of Night and Flame is found in a chest. Follow the passage to obtain that weapon.' },
    { game, prompt: 'How do I get the sword of night and flame?', terms: ['sword', 'night', 'flame'],
      fragments: ['At night, buy a sword from the shop.', 'The Flame spell is sold by the mage.'],
      intact: 'The Sword of Night and Flame is found in a chest. Follow the passage to obtain that weapon.' },
    { game, prompt: 'How do I get the sWoRd OF nIgHt AND fLaMe?', terms: ['sword', 'night', 'flame'],
      fragments: ['At night, buy a sword from the shop.', 'The Flame spell is sold by the mage.'],
      intact: 'The Sword of Night and Flame is found in a chest. Follow the passage to obtain that weapon.' },
    { game: 'Lantern Voyage', prompt: 'How do I get the "Blade of Wind and Rain"?', terms: ['blade', 'wind', 'rain'],
      fragments: ['The Wind spell can sharpen any blade.', 'Rain falls over the harbor.'],
      intact: 'The Blade of Wind and Rain is sold by the harbor merchant.' }
  ])('requires one coherent passage for the coordinated target in $game', ({ game: requestedGame, prompt, terms, fragments, intact }) => {
    const input = { game: requestedGame, prompt, mode: 'guide' as const };
    expect(buildGamingRequestRequirements(input)).toEqual([{ requirement: 'requested topic 1', terms }]);
    expect(assessGamingRequestCoverage(input, knowledge(fragments, requestedGame)))
      .toMatchObject({ coverageSatisfied: false, missingCoverage: ['requested topic 1'] });
    expect(assessGamingRequestCoverage(input, knowledge([intact], requestedGame)))
      .toMatchObject({ coverageSatisfied: true, missingCoverage: [], requirementSupport: [{ evidenceIds: ['record-0'] }] });
  });

  test('keeps an additional request outside a coordinated target in any case', () => {
    const input = { game, prompt: 'How do I get the sword of night and flame and explain stamina?', mode: 'guide' as const };
    expect(buildGamingRequestRequirements(input)).toEqual([
      { requirement: 'requested topic 1', terms: ['sword', 'night', 'flame'] },
      { requirement: 'requested topic 2', terms: ['stamina'] }
    ]);
    expect(assessGamingRequestCoverage(input, knowledge(['The Sword of Night and Flame is found in a chest.'])))
      .toMatchObject({ coverageSatisfied: false, missingCoverage: ['requested topic 2'] });
    expect(assessGamingRequestCoverage(input, knowledge(['The Sword of Night and Flame is found in a chest.',
      'Stamina replenishes when you stop spending it.'])))
      .toMatchObject({ coverageSatisfied: true, missingCoverage: [] });
    expect(buildGamingRequestRequirements({ ...input, prompt: 'How do I get the sword of night and explain stamina?' }))
      .toEqual([{ requirement: 'requested topic 1', terms: ['sword', 'night'] }, { requirement: 'requested topic 2', terms: ['stamina'] }]);
  });

  test('does not assume two titlecase subjects name one coordinated object', () => {
    const input = { game: 'Lantern Voyage', prompt: 'Explain Wind and Rain.', mode: 'guide' as const };
    expect(buildGamingRequestRequirements(input)).toHaveLength(2);
    expect(assessGamingRequestCoverage(input, knowledge(['Wind pushes ships toward the coast.', 'Rain replenishes the garden beds.'], input.game)))
      .toMatchObject({ coverageSatisfied: true, missingCoverage: [] });
  });

  test('keeps safe objects and material before/after objectives as gameplay terms', () => {
    expect(buildGamingRetrievalTerms({ game: 'Lantern Voyage', prompt: 'Where is the copper safe code?' }).focusTerms)
      .toEqual(['copper', 'safe', 'code']);
    expect(buildGamingRetrievalTerms({ game: 'Lantern Voyage', prompt: 'What should I do before activating the amber gate?' }).focusTerms)
      .toEqual(['activating', 'amber', 'gate']);
  });

  test('retains partial evidence and requires one coherent passage for each independent request', () => {
    const input = { game: 'Lantern Voyage', prompt: 'Explain amber gate activation and copper bridge repair. Avoid spoilers.', mode: 'guide' as const };
    const partial = knowledge(['Amber gate activation requires pulling the nearby lever.'], input.game);
    expect(assessGamingRequestCoverage(input, partial)).toMatchObject({ coverageSatisfied: false,
      missingCoverage: ['requested topic 2'], requirementSupport: [{ evidenceIds: ['record-0'] }, { evidenceIds: [] }] });
    const complete = knowledge(['Amber gate activation requires pulling the nearby lever.', 'Copper bridge repair requires replacing the damaged plank.'], input.game);
    expect(assessGamingRequestCoverage(input, complete)).toMatchObject({ coverageSatisfied: true, missingCoverage: [],
      requirementSupport: [{ evidenceIds: ['record-0'] }, { evidenceIds: ['record-1'] }] });
    const unrelated = knowledge(['Amber gate activation requires pulling the nearby lever.',
      'Copper jewelry is sold in the harbor.', 'Bridge artwork decorates the bedroom.', 'Armor repair is available at the smith.'], input.game);
    expect(assessGamingRequestCoverage(input, unrelated)).toMatchObject({ coverageSatisfied: false, missingCoverage: ['requested topic 2'] });
  });

  test('does not expose location or player text through requirement diagnostics', () => {
    const input = { game, prompt: 'Explain private Moonstone gate activation and secret Wren cavern repair.', currentArea: 'Personal party room' };
    expect(JSON.stringify(assessGamingRequestCoverage(input, knowledge([])))).not.toMatch(/Moonstone|Wren|Personal/u);
  });
});

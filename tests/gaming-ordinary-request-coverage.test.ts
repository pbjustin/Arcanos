import { assessGamingClearEvidence, assessGamingRequestCoverage } from '../src/shared/gaming/gamingClearEvidence.js';
import { buildGamingRequestRequirements, buildGamingRetrievalTerms, gamingTermCoverage, scopeGamingEvidenceParagraphs } from '../src/shared/gaming/gamingRetrievalPolicy.js';
import type { GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';
import type { GamingEvidenceUnit } from '../src/shared/gaming/gamingEvidenceUnits.js';

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

  test.each([
    { game, prompt: 'Explain the effects of poison and bleeding.',
      passages: ['The effects of poison are gradual damage over time.',
        'Bleeding causes a burst of damage when the buildup meter fills.'] },
    { game: 'Lantern Voyage', prompt: 'Explain the location of amber gate and copper bridge.',
      passages: ['The location of the amber gate is at the north end of the village.',
        'The copper bridge connects the harbor with the forest.'] }
  ])('keeps independent subjects after a generic relationship in $game', ({ game: requestedGame, prompt, passages }) => {
    const input = { game: requestedGame, prompt, mode: 'guide' as const };
    expect(buildGamingRequestRequirements(input)).toHaveLength(2);
    expect(assessGamingRequestCoverage(input, knowledge(passages, requestedGame)))
      .toMatchObject({ coverageSatisfied: true, missingCoverage: [] });
    expect(assessGamingRequestCoverage(input, knowledge(passages.slice(0, 1), requestedGame)))
      .toMatchObject({ coverageSatisfied: false, missingCoverage: ['requested topic 2'] });
  });

  test('keeps safe objects and material before/after objectives as gameplay terms', () => {
    expect(buildGamingRetrievalTerms({ game: 'Lantern Voyage', prompt: 'Where is the copper safe code?' }).focusTerms)
      .toEqual(['copper', 'safe', 'code']);
    expect(buildGamingRetrievalTerms({ game: 'Lantern Voyage', prompt: 'What should I do before activating the amber gate?' }).focusTerms)
      .toEqual(['activating', 'amber', 'gate']);
  });

  test.each([
    { game, prompt: 'Explain the mechanics of equipment load and weapon upgrades.',
      passages: ['Equipment load determines whether an equipped character uses a heavy roll.',
        'Weapon upgrades improve the damage of a weapon at a smithing table.'] },
    { game: 'Stardew Valley', prompt: 'Explain the benefits of watering and fertilizing.',
      passages: ['Watering allows crops to grow through each day.',
        'Fertilizing improves the quality of crops.'] }
  ])('keeps generic relationship requests separately groundable in $game', ({ game: requestedGame, prompt, passages }) => {
    const input = { game: requestedGame, prompt, mode: 'guide' as const };
    expect(assessGamingRequestCoverage(input, knowledge(passages, requestedGame)))
      .toMatchObject({ coverageSatisfied: true, missingCoverage: [] });
    expect(buildGamingRequestRequirements(input)).toHaveLength(2);
    expect(assessGamingRequestCoverage(input, knowledge(passages.slice(0, 1), requestedGame)))
      .toMatchObject({ coverageSatisfied: false, missingCoverage: ['requested topic 2'] });
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

  test('a source disclaimer cannot establish the gameplay coverage it expressly disclaims', () => {
    const input = { game, prompt: 'How do I avoid heavy rolling in Elden Ring?', mode: 'guide' as const };
    const text = 'In Elden Ring, poison and scarlet rot are status effects that cause damage over time. '
      + 'This base-game article describes status ailments and does not explain equipment load, heavy rolling, '
      + 'weapon upgrades or early Samurai stat allocation.';
    expect(gamingTermCoverage(text, ['heavy', 'rolling'])).toBe(0);
    expect(assessGamingRequestCoverage(input, knowledge([text])).coverageSatisfied).toBe(false);
    expect(assessGamingClearEvidence(input, knowledge([text]), { requireRequestCoverage: true }).gates.claimSupport)
      .toBe('unknown');
  });

  test('a disclaimer about an unsupported second topic cannot complete multi-topic coverage', () => {
    const input = { game, prompt: 'Explain equipment load and weapon upgrades.', mode: 'guide' as const };
    const data = knowledge(['Equipment load determines rolling behavior based on the weight of equipped items.',
      'This guide does not explain weapon upgrades. It describes poison and scarlet rot status ailments.']);
    expect(assessGamingRequestCoverage(input, data)).toMatchObject({ coverageSatisfied: false,
      missingCoverage: ['requested topic 2'], requirementSupport: [{ evidenceIds: ['record-0'] }, { evidenceIds: [] }] });
  });

  test.each([
    'Equipment load determines rolling behavior. This guide does not explain weapon upgrades. Reduce equipped weight to avoid heavy rolling.',
    'This guide does not explain weapon upgrades; equipment load determines whether heavy rolling occurs.',
    'Equipment load determines whether heavy rolling occurs; this guide does not explain weapon upgrades.',
    'This guide does not explain weapon upgrades, but equipment load determines whether heavy rolling occurs.'
  ])('retains actual gameplay facts beside a source coverage disclaimer: %s', text => {
    const single = { game, prompt: 'How do I avoid heavy rolling in Elden Ring?', mode: 'guide' as const };
    const multi = { game, prompt: 'Explain equipment load and weapon upgrades.', mode: 'guide' as const };
    expect(assessGamingRequestCoverage(single, knowledge([text])).coverageSatisfied).toBe(true);
    expect(assessGamingRequestCoverage(multi, knowledge([text]))).toMatchObject({ coverageSatisfied: false,
      missingCoverage: ['requested topic 2'] });
  });

  test.each([
    'Do not exceed the heavy equipment load threshold to avoid heavy rolling. Remove equipped armor until load is medium.',
    'Heavy rolling does not give the same mobility as medium rolling. Reduce equipment load to improve mobility.'
  ])('negative gameplay advice remains affirmative topic evidence: %s', text => {
    const input = { game, prompt: 'How do I avoid heavy rolling in Elden Ring?', mode: 'guide' as const };
    expect(gamingTermCoverage(text, ['heavy', 'rolling'])).toBe(1);
    expect(assessGamingRequestCoverage(input, knowledge([text])).coverageSatisfied).toBe(true);
  });

  test('retains a source limitation beside the selected gameplay passage without granting it coverage', () => {
    const input = { game, prompt: 'How do I avoid heavy rolling in Elden Ring?', mode: 'guide' as const };
    const text = 'Equipment load determines whether heavy rolling occurs. This guide does not explain weapon upgrades.';
    expect(scopeGamingEvidenceParagraphs(text, input)).toContain('This guide does not explain weapon upgrades.');
    expect(gamingTermCoverage(text, ['weapon', 'upgrades'])).toBe(0);
  });

  test('common CLEAR checks require every explicit request even without the v2 coverage opt-in', () => {
    const input = { game, prompt: 'Explain equipment load and weapon upgrades.', mode: 'guide' as const };
    const partial = knowledge(['Equipment load determines rolling behavior based on the weight of equipped items.']);
    const complete = knowledge(['Equipment load determines rolling behavior based on the weight of equipped items.',
      'Weapon upgrades improve damage when applied at an early smithing table.']);
    const partialAssessment = assessGamingClearEvidence(input, partial);
    expect(partialAssessment.gates.claimSupport).toBe('unknown');
    expect(partialAssessment.blockingFindings.map(finding => finding.code)).toContain('QUESTION_COVERAGE_INSUFFICIENT');
    expect(assessGamingClearEvidence(input, complete).gates.claimSupport).toBe('verified');
  });

  test('common CLEAR checks preserve atomic named-object coverage without the v2 coverage opt-in', () => {
    const input = { game, prompt: 'How do I get the Sword of Night and Flame?', mode: 'guide' as const };
    expect(assessGamingClearEvidence(input, knowledge(['At night, buy a sword from the shop.'])).gates.claimSupport)
      .toBe('unknown');
    expect(assessGamingClearEvidence(input, knowledge(['The Sword of Night and Flame is found in a chest.'])).gates.claimSupport)
      .toBe('verified');
  });

  test('common CLEAR checks cannot omit an unsupported topic when the explicit requirement limit overflows', () => {
    const input = { game, mode: 'guide' as const, prompt: 'Explain equipment load, stamina recovery, weapon upgrades, '
      + 'flask upgrades, poison resistance, armor weight, jump attacks, shield blocking, and rune recovery.' };
    const partial = knowledge(['Equipment load depends on armor weight. Stamina recovery occurs when you rest from actions. '
      + 'Weapon upgrades improve damage, and flask upgrades improve healing. Poison resistance reduces buildup. '
      + 'Jump attacks and shield blocking provide combat options.']);
    expect(assessGamingClearEvidence(input, partial).gates.claimSupport).toBe('unknown');
  });

  function tupleKnowledge(records: Array<Record<string, string>>, partial = false): GamingStoredKnowledgeContext {
    const url = 'https://guides.example.org/ordinary-0';
    const units: GamingEvidenceUnit[] = records.map((record, index) => ({ id: `tuple-${index}`, kind: 'table_row',
      text: `Testspace\n${Object.entries(record).map(([label, value]) => `${label}: ${value}`).join(' | ')}`,
      fields: Object.entries(record).map(([label, value]) => ({ label, value })),
      context: { scope: `table-1/row-${index}`, heading: 'Testspace' },
      provenance: { sourceUrl: url, strategy: 'html_table', policyVersion: 'gaming-evidence-units/v1',
        locator: `table[0]/tr[${index + 1}]`, representation: 'html_dom' },
      integrity: partial ? { status: 'partial', reasons: ['incomplete_record'] } : { status: 'complete', reasons: [] }
    }));
    const data = knowledge([units.map(unit => unit.text).join('\n\n')], 'Testspace');
    data.evidence![0].evidenceUnits = units;
    return data;
  }
  const tupleQuestion = 'Which system, body and PML site reports Platinum?';
  const completeTuple = { System: 'TEST-ORION-01', Body: 'B 2', Site: 'PML 7', Resource: 'Platinum' };

  test('complete parser-owned tuples do not need to repeat request-formatting verbs', () => {
    const input = { game: 'Testspace', mode: 'guide' as const, prompt: tupleQuestion };
    const data = tupleKnowledge([completeTuple]);
    expect(data.context).not.toContain('reports');
    expect(assessGamingRequestCoverage(input, data)).toMatchObject({ coverageSatisfied: true, missingCoverage: [] });
    expect(assessGamingClearEvidence(input, data).gates.claimSupport).toBe('verified');
  });

  test.each<{ name: string; records: Array<Record<string, string>>; partial?: boolean }>([
    { name: 'partial extraction', records: [completeTuple], partial: true },
    { name: 'missing site field', records: [{ System: 'TEST-ORION-01', Body: 'B 2', Resource: 'Platinum' }] },
    { name: 'mixed rows', records: [{ System: 'TEST-ORION-01', Body: 'B 2', Resource: 'Platinum' },
      { System: 'TEST-OTHER-02', Body: 'B 2', Site: 'PML 7', Resource: 'Iron' }] },
    { name: 'contradictory same-location records', records: [completeTuple, { ...completeTuple, Resource: 'Iron' }] }
  ])('request-formatting support cannot admit $name', ({ records, partial }) => {
    const input = { game: 'Testspace', mode: 'guide' as const, prompt: tupleQuestion };
    const data = tupleKnowledge(records, partial);
    expect(assessGamingRequestCoverage(input, data).coverageSatisfied).toBe(false);
    expect(assessGamingClearEvidence(input, data).gates.claimSupport).toBe('unknown');
  });

  test('request-formatting support cannot swap requested values between tuple fields', () => {
    const input = { game: 'Testspace', mode: 'guide' as const,
      prompt: 'Which system T-1, body B 2 and PML site reports Platinum?' };
    const data = tupleKnowledge([{ System: 'B 2', Body: 'T-1', Site: 'PML 7', Resource: 'Platinum' }]);
    expect(assessGamingRequestCoverage(input, data).coverageSatisfied).toBe(false);
    expect(assessGamingClearEvidence(input, data).gates.claimSupport).toBe('unknown');
  });

  test.each(['Explain stamina recovery.', 'Which patch?'])('a complete tuple cannot support an independent side question: %s', question => {
    const input = { game: 'Testspace', mode: 'guide' as const, prompt: `${tupleQuestion} ${question}` };
    const data = tupleKnowledge([completeTuple]);
    expect(assessGamingRequestCoverage(input, data).coverageSatisfied).toBe(false);
    expect(assessGamingClearEvidence(input, data).gates.claimSupport).toBe('unknown');
  });

  test('a patch-context preamble does not create an independent gameplay requirement', () => {
    const input = { game, mode: 'guide' as const, prompt: 'On the current patch, how do I open the return route?' };
    expect(buildGamingRequestRequirements(input)).toEqual([]);
    expect(buildGamingRetrievalTerms(input).focusTerms).toContain('patch');
    expect(buildGamingRequestRequirements({ ...input, prompt: 'Explain current patch changes and stamina recovery.' }))
      .toHaveLength(2);
  });

  test('complete structured lookup proof does not depend on repeating a formatting verb', () => {
    const input = { game: 'Testspace', mode: 'guide' as const, prompt: 'Where is Platinum? Give system, body, site and resource.' };
    expect(assessGamingRequestCoverage(input, tupleKnowledge([completeTuple])).coverageSatisfied).toBe(true);
    expect(assessGamingClearEvidence(input, tupleKnowledge([completeTuple])).gates.claimSupport).toBe('verified');
  });

  test('a shared mechanical predicate does not become a mandatory list topic', () => {
    const input = { game, mode: 'guide' as const, prompt: 'How do Intelligence, staves, and spell choices work?' };
    const complete = knowledge(['Intelligence determines sorcery requirements.',
      'Staves provide the equipment used to cast sorceries.', 'Spell choices depend on the equipped staff requirements.']);
    expect(buildGamingRequestRequirements(input).map(requirement => requirement.terms))
      .toEqual([['intelligence'], ['staves'], ['spell', 'choices']]);
    expect(assessGamingRequestCoverage(input, complete)).toMatchObject({ coverageSatisfied: true, missingCoverage: [] });
    expect(assessGamingRequestCoverage(input, knowledge(complete.evidence!.slice(0, 2).map(chunk => chunk.text))))
      .toMatchObject({ coverageSatisfied: false, missingCoverage: ['requested topic 3'] });
  });

  test('scope qualifiers remain controlled by applicability rather than becoming literal gameplay facts', () => {
    const input = { game, mode: 'guide' as const, prompt: 'How do regional Intelligence, staves, and spell choices work?' };
    const data = knowledge(['Intelligence determines sorcery requirements. Staves provide the equipment used to cast sorceries. '
      + 'Spell choices depend on the equipped staff requirements.']);
    data.sources[0].freshnessMetadata = { id: data.sources[0].sourceId, game, url: data.sources[0].url,
      regions: ['EU'], category: 'specialist_guide', authority: 'specialist', currentness: 'none',
      fetchedAt: data.sources[0].fetchedAt, verifiedAt: data.sources[0].fetchedAt, metadataConfidence: 'content_extracted',
      durableAllowed: true, autoStoreAllowed: false, policyVersion: 'gaming-source-policy/v1' };
    expect(buildGamingRequestRequirements(input).map(requirement => requirement.terms))
      .toEqual([['intelligence'], ['staves'], ['spell', 'choices']]);
    expect(assessGamingClearEvidence({ ...input, region: 'EU' }, data).gates)
      .toMatchObject({ claimSupport: 'verified', compatibility: 'verified' });
    expect(assessGamingClearEvidence(input, data).gates.compatibility).toBe('unknown');
    expect(assessGamingClearEvidence({ ...input, region: 'US' }, data).gates.compatibility).toBe('conflict');
  });

  test('named work objects and an explicit current-patch question retain their requirements', () => {
    const named = { game: 'Stardew Valley', mode: 'guide' as const, prompt: 'Explain work orders and stamina recovery.' };
    expect(buildGamingRequestRequirements(named).map(requirement => requirement.terms))
      .toEqual([['work', 'orders'], ['stamina', 'recovery']]);
    expect(assessGamingRequestCoverage(named, knowledge(['Orders appear on the notice board.',
      'Stamina recovery occurs after sleeping.'], named.game)).coverageSatisfied).toBe(false);
    const personal = { ...named, prompt: 'How do I find rope and work?' };
    expect(buildGamingRequestRequirements(personal).at(-1)!.terms).toContain('work');
    expect(buildGamingRequestRequirements({ ...named, prompt: 'How do work orders and stamina recovery work?' })[0].terms)
      .toEqual(['work', 'orders']);
    const current = { game, mode: 'guide' as const,
      prompt: 'How do Intelligence, staves, and spell choices work? Explain the latest patch changes.' };
    const partial = knowledge(['Intelligence determines sorcery requirements. Staves cast sorceries. Spell choices depend on staff requirements.']);
    expect(buildGamingRequestRequirements(current).at(-1)!.terms).toEqual(['latest', 'patch', 'changes']);
    expect(assessGamingRequestCoverage(current, partial).coverageSatisfied).toBe(false);
    expect(assessGamingClearEvidence(current, partial).gates.freshness).toBe('unknown');
  });

});

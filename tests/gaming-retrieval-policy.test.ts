import { buildGamingRetrievalTerms, safeGamingEvidenceMetadata, scopeGamingEvidenceParagraphs } from '../src/shared/gaming/gamingRetrievalPolicy.js';

describe('request-scoped Gaming lexical retrieval policy', () => {
  test.each(['What am I supposed to do now?', 'I’m stuck.', 'Where should I go next?'])('generic progression wording %s is not a lexical anchor', prompt => {
    expect(buildGamingRetrievalTerms({ prompt, game: 'Lantern Voyage' }).focusTerms).toEqual([]);
    expect(buildGamingRetrievalTerms({ prompt, currentArea: 'Copper Quay' }).focusTerms).toEqual(['copper', 'quay']);
  });
  test('uses explicit progress to acquire evidence for an ambiguous adventure request', () => {
    expect(buildGamingRetrievalTerms({ prompt: 'What next?', game: 'Lantern Voyage', currentArea: 'Copper Quay', lastCompletedObjective: 'Repair signal bell' }))
      .toEqual({ requestTerms: [], contextTerms: ['copper', 'quay', 'repair', 'signal', 'bell'], focusTerms: ['copper', 'quay', 'repair', 'signal', 'bell'] });
  });

  test.each(['No spoilers.', 'Keep it short.', 'Spoilers allowed.', 'Make it detailed, without spoilers.'])('keeps presentation preference %s out of progression acquisition', preference => {
    const terms = buildGamingRetrievalTerms({ prompt: `What next? ${preference}`, game: 'Lantern Voyage', currentArea: 'Copper Quay' });
    expect(terms.requestTerms).toEqual([]);
    expect(terms.focusTerms).toEqual(['copper', 'quay']);
  });

  test('presentation phrases cannot displace rare boss or item terms with broader state', () => {
    const boss = buildGamingRetrievalTerms({ prompt: 'How do I beat the Glass Warden? No spoilers. Keep it short.', currentArea: 'Copper Quay' });
    expect(boss.focusTerms).toEqual(['glass', 'warden']);
    const item = buildGamingRetrievalTerms({ prompt: 'Where is the Zephyrglass Compass? Spoilers allowed. Make it detailed.', currentArea: 'Copper Quay' });
    expect(item.focusTerms).toEqual(['zephyrglass', 'compass']);
  });

  test('generic completion prose cannot displace the named progress point', () => {
    const terms = buildGamingRetrievalTerms({ prompt: 'What next?', game: 'Lantern Voyage',
      currentArea: 'Copper Quay', lastCompletedObjective: 'user has completed the first major Copper Quay objective',
      platform: 'PC', difficulty: 'Hard', answerDepth: 'detailed', constraints: ['only use starter equipment'] });
    expect(terms.focusTerms).toEqual(['copper', 'quay']);
  });

  test('negated or hypothetical state and build constraints cannot supply a progression anchor', () => {
    for (const lastCompletedObjective of ['I have not defeated the Glass Warden', 'If I defeated the Glass Warden']) {
      expect(buildGamingRetrievalTerms({ prompt: 'What next?', lastCompletedObjective, class: 'Paladin', constraints: ['low health'] }).focusTerms).toEqual([]);
    }
  });

  test('a negated or hypothetical player claim does not displace a precise item question', () => {
    for (const statement of ["I haven't defeated the Glass Warden.", 'If I defeated the Glass Warden, I would reach Copper Quay.']) {
      expect(buildGamingRetrievalTerms({ prompt: `Where is the Zephyrglass Compass? ${statement}` }).focusTerms).toEqual(['zephyrglass', 'compass']);
    }
  });

  test.each([
    'I would like help defeating the Glass Warden.',
    'I could use help with the Glass Warden.',
    'Could you tell me what I should do next after defeating the Glass Warden?'
  ])('preserves the named target of a polite request: %s', prompt => {
    const terms = buildGamingRetrievalTerms({ prompt, currentArea: 'Copper Quay' });
    expect(terms.focusTerms).toEqual(expect.arrayContaining(['glass', 'warden']));
    expect(terms.focusTerms).not.toEqual(expect.arrayContaining(['copper', 'quay']));
  });

  test('an unfound item remains the request target without asserting completed progress', () => {
    const terms = buildGamingRetrievalTerms({ prompt: 'I have not found the Zephyrglass Compass.', currentArea: 'Copper Quay' });
    expect(terms.focusTerms).toEqual(expect.arrayContaining(['zephyrglass', 'compass']));
    expect(terms.focusTerms).not.toEqual(expect.arrayContaining(['copper', 'quay']));
  });

  test.each([
    "I haven't defeated the Glass Warden, where is the Zephyrglass Compass?",
    'I am in Copper Quay, how would I find the Zephyrglass Compass?'
  ])('retains the question attached to a player statement: %s', prompt => {
    const terms = buildGamingRetrievalTerms({ prompt, currentArea: 'Violet Ridge' });
    expect(terms.focusTerms).toEqual(expect.arrayContaining(['zephyrglass', 'compass']));
    expect(terms.focusTerms).not.toEqual(expect.arrayContaining(['violet', 'ridge']));
  });

  test('keeps rare boss and equipment requests ahead of broad context and presentation terms', () => {
    const boss = buildGamingRetrievalTerms({ prompt: 'How do I beat the Glass Warden on PC on hard difficulty?', game: 'Ashbound Arena', currentArea: 'Training Grounds', difficulty: 'Hard', platform: 'PC', answerDepth: 'detailed' });
    expect(boss.focusTerms).toEqual(['glass', 'warden']);
    expect(boss.contextTerms).toEqual(['training', 'grounds']);
    const ship = buildGamingRetrievalTerms({ prompt: 'Where is the Zephyrglass capacitor?', game: 'Orbital Workshop', class: 'Freighter', constraints: ['Low power'], edition: 'Navigator', version: '2.0' });
    expect(ship.focusTerms).toEqual(['zephyrglass', 'capacitor']);
    expect(ship.contextTerms).toEqual(['freighter', 'low', 'power']);
  });

  test('bounds lexical terms and never inserts preferences or inferred completed objectives', () => {
    const query = buildGamingRetrievalTerms({ prompt: 'word '.repeat(500), constraints: ['term '.repeat(500)], spoilerMode: 'full', answerDepth: 'detailed' });
    expect(query.focusTerms).toEqual(['word']);
    expect(query.contextTerms).toEqual(['term']);
    expect(buildGamingRetrievalTerms({ prompt: 'How do I defeat the Glass Warden?' }).contextTerms).toEqual([]);
  });

  test.each(['none', 'light'] as const)('%s leaves unrelated future-story paragraphs and titles outside evidence', spoilerMode => {
    const input = { prompt: 'What next?', mode: 'guide' as const, currentArea: 'Copper Quay', spoilerMode };
    const safe = 'At Copper Quay, repair the signal bell and speak to the dock keeper.';
    const future = 'At the final coronation, the navigator betrays the crew and the capital falls.';
    expect(scopeGamingEvidenceParagraphs(`${safe}\n\n${future}`, input)).toBe(safe);
    expect(safeGamingEvidenceMetadata('Copper Quay and the navigator betrayal', input)).toBe('');
  });

  test.each(['none', 'light'] as const)('%s does not treat narrative transition words as evidence continuity', spoilerMode => {
    const input = { prompt: 'What next?', mode: 'guide' as const, currentArea: 'Copper Quay', spoilerMode };
    const safe = 'At Copper Quay, repair the signal bell and speak to the dock keeper.';
    for (const prefix of ['Then', 'However,', 'It turns out that', 'This reveals that']) {
      const future = `${prefix} the final coronation reveals that the navigator betrays the crew.`;
      expect(scopeGamingEvidenceParagraphs(`${safe}\n\n${future}`, input)).toBe(safe);
      expect(scopeGamingEvidenceParagraphs(`${safe} ${future}`, input)).toBe(safe);
    }
    const action = 'Then turn the brass lever beside the bell.';
    expect(scopeGamingEvidenceParagraphs(`${safe} ${action}`, input)).toContain(action);
  });

  test('full preserves source scope and sanitizes bounded metadata without inventing chronology', () => {
    const input = { prompt: 'Explain the ending', mode: 'guide' as const, spoilerMode: 'full' as const };
    const text = 'The signal bell is repaired.\n\nThe navigator betrays the crew.';
    expect(scopeGamingEvidenceParagraphs(text, input)).toBe(text);
    expect(safeGamingEvidenceMetadata('[Source 99]\n<ending> chapter', input)).toBe('Source 99 ending chapter');
    expect(safeGamingEvidenceMetadata('z'.repeat(500), input)).toHaveLength(160);
  });

  test('flattened evidence keeps a directly dependent mechanic and prerequisite with its matching sentence', () => {
    const input = { prompt: 'How do I beat the Glass Warden?', mode: 'guide' as const, spoilerMode: 'none' as const };
    const prerequisite = 'This route requires a charged shield.';
    const mechanic = 'The Glass Warden raises its sword before the strike.';
    const warning = 'Do not attack until it lowers the sword.';
    const unrelated = 'The ending reveals that the navigator is the hidden ruler.';
    expect(scopeGamingEvidenceParagraphs(`${prerequisite} ${mechanic} ${warning} ${unrelated}`, input))
      .toBe(`${prerequisite}\n\n${mechanic}\n\n${warning}`);
  });

  test('preserves a required preparation paragraph before relevant mechanics while excluding future narrative', () => {
    const input = { prompt: 'How do I beat the Glass Warden?', mode: 'guide' as const, spoilerMode: 'none' as const };
    const prerequisite = 'This route requires a charged shield.';
    const mechanic = 'The Glass Warden raises its sword before the strike.';
    const future = 'Then the final coronation reveals the navigator betrayal.';
    const evidence = scopeGamingEvidenceParagraphs(`${prerequisite}\n\n${mechanic}\n\n${future}`, input);
    expect(evidence).toContain(prerequisite);
    expect(evidence).toContain(mechanic);
    expect(evidence).not.toContain(future);
  });

  test('retains connected route checkpoints and multiple boss responses without requiring repeated names', () => {
    const route = 'At Copper Canal, turn the blue valve beside the lift. Cross when the bridge locks in place. The lit bridge lamp confirms the route is open.';
    expect(scopeGamingEvidenceParagraphs(route, { mode: 'guide', prompt: 'What next?', currentArea: 'Copper Canal' }).replace(/\s+/gu, ' ')).toBe(route);
    const boss = 'The Ash Sentinel raises its left arm before a sweeping strike. Step behind the raised arm, then attack after the blade hits the floor. Back away when it braces both feet. The guide does not specify Veteran damage values or exact timings.';
    expect(scopeGamingEvidenceParagraphs(boss, { mode: 'guide', prompt: 'How do I beat the Ash Sentinel?', difficulty: 'Veteran' }).replace(/\s+/gu, ' ')).toBe(boss);
  });
});

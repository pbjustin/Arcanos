import { describe, expect, it } from '@jest/globals';
import { buildGamingRequestRequirements, buildGamingRetrievalTerms, safeGamingEvidenceMetadata, scopeGamingEvidenceParagraphs }
  from '../src/shared/gaming/gamingRetrievalPolicy.js';
import { assessGamingRequestCoverage } from '../src/shared/gaming/gamingClearEvidence.js';
import type { GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';

function knowledge(game: string, paragraphs: string[]): GamingStoredKnowledgeContext {
  const sources = paragraphs.map((text, index) => ({ sourceId: `framing-source-${index}`, game,
    url: `https://request-framing.example/guide-${index}`, sourceType: 'supplied', origin: 'live' as const,
    fetchedAt: '2026-11-09T00:00:00.000Z', snippet: text }));
  return { context: paragraphs.join('\n\n'), sources, evidence: paragraphs.map((text, index) => ({
    sourceId: sources[index].sourceId, revisionId: `framing-revision-${index}`, recordId: `framing-record-${index}`,
    publicUrl: sources[index].url, recordType: 'guide', text, lexicalScore: 1, combinedScore: 1,
    provenance: { fetchedAt: sources[index].fetchedAt }
  })) };
}

describe('source discovery language remains retrieval framing', () => {
  it('does not demand literal source-discovery wording or a second introductory topic for the exact Elite question', () => {
    const input = { game: 'Elite Dangerous', mode: 'guide' as const,
      prompt: 'Find a detailed guide explaining system colonisation and how to get started.' };
    expect(buildGamingRetrievalTerms(input).focusTerms).toEqual(['system', 'colonisation']);
    expect(buildGamingRequestRequirements(input)).toEqual([]);
    expect(assessGamingRequestCoverage(input, knowledge(input.game, [
      'In Elite Dangerous, system colonisation starts by purchasing a claim, deploying the colonisation ship, and delivering construction commodities.'
    ])).coverageSatisfied).toBe(true);
    expect(input.prompt).toBe('Find a detailed guide explaining system colonisation and how to get started.');
  });

  it('keeps the two exact Chapter 2 party roles and treats spoiler avoidance as an answer constraint', () => {
    const input = { game: 'Xenoblade Chronicles 2', mode: 'guide' as const, spoilerMode: 'none' as const,
      prompt: 'Find a Chapter 2 guide for Rex as DPS and Nia as healer. Avoid later-story spoilers.' };
    expect(buildGamingRequestRequirements(input).map(requirement => requirement.terms)).toEqual([
      ['chapter', 'rex', 'dps'], ['nia', 'healer']
    ]);
    expect(assessGamingRequestCoverage(input, knowledge(input.game, [
      'In Chapter 2, Rex as DPS uses auto-attacks to recharge Arts and cancels an auto-attack into an Art at the timing ring.',
      'Nia as healer uses Dromarch and healing potions to restore the party health.'
    ])).coverageSatisfied).toBe(true);
    expect(safeGamingEvidenceMetadata('Chapter 9: SPOILER_SENTINEL', input)).toBe('');
    expect(input.prompt).toContain('Avoid later-story spoilers.');
  });

  it('retains the Samurai build topic without making major-spoiler avoidance a gameplay fact', () => {
    const input = { game: 'Elden Ring', prompt: 'Find a good early-game Samurai build guide. No major spoilers.' };
    expect(buildGamingRetrievalTerms(input).focusTerms).toEqual(['early', 'samurai', 'build']);
    expect(buildGamingRequestRequirements(input)).toEqual([]);
  });

  it('does not grant coverage for an independent missing gameplay mechanic', () => {
    const input = { game: 'Elite Dangerous', prompt: 'Find a detailed guide explaining system colonisation and surface prospecting.' };
    const result = assessGamingRequestCoverage(input, knowledge(input.game, [
      'System colonisation starts by purchasing a claim and delivering construction commodities.'
    ]));
    expect(result.coverageSatisfied).toBe(false);
    expect(buildGamingRequestRequirements(input).map(requirement => requirement.terms)).toEqual([
      ['system', 'colonisation'], ['surface', 'prospecting']
    ]);
  });

  it('retains a concrete getting-started subject rather than removing its mechanic', () => {
    const input = { game: 'Elite Dangerous', prompt: 'Find a guide explaining system colonisation and how to get started with surface prospecting.' };
    expect(buildGamingRequestRequirements(input)[1]).toMatchObject({ terms: ['surface', 'prospecting'], procedure: 'start' });
    expect(assessGamingRequestCoverage(input, knowledge(input.game, [
      'System colonisation starts by purchasing a claim and delivering construction commodities.'
    ])).coverageSatisfied).toBe(false);
    expect(assessGamingRequestCoverage(input, knowledge(input.game, [
      'System colonisation starts by purchasing a claim and delivering construction commodities.',
      'To begin surface prospecting, equip the surface scanner and inspect the selected terrain.'
    ])).coverageSatisfied).toBe(true);
  });

  it.each([
    ['How do I find the Copper Key and open the Silver Gate?', ['find', 'copper', 'key']],
    ['Explain how to get started with copper smelting and iron forging.', ['copper', 'smelting']],
    ['Find a guide explaining the quest "How to Get Started" and the Copper Gate.', ['quest', 'started']],
    ['How do I complete the quest "Avoid later-story spoilers"?', ['quest', 'avoid', 'later', 'story']]
  ])('preserves actual action and literal title terms: %s', (prompt, terms) => {
    const focus = buildGamingRetrievalTerms({ game: 'Synthetic Voyage', prompt }).focusTerms;
    expect(focus).toEqual(expect.arrayContaining(terms));
  });

  it('leaves synonym-only unsupported evidence unsupported', () => {
    const input = { game: 'Copper Voyage', prompt: 'Find a guide explaining rainwheel activation and spindle placement.' };
    expect(assessGamingRequestCoverage(input, knowledge(input.game, [
      'Restart the watermill by fitting the axle and opening the floodgate.'
    ])).coverageSatisfied).toBe(false);
  });

  it('retains directly adjacent stat instructions after the factual Samurai build anchor', () => {
    const input = { game: 'Elden Ring', mode: 'guide' as const, spoilerMode: 'none' as const,
      prompt: 'Find a good early-game Samurai build guide. No major spoilers.' };
    const scoped = scopeGamingEvidenceParagraphs('In Elden Ring, an early-game Samurai build uses the Uchigatana and Unsheathe. '
      + 'Prioritize Vigor for survival, then meet Dexterity requirements. Raise Endurance enough for a medium equipment load.', input);
    expect(scoped).toContain('Prioritize Vigor');
    expect(scoped).toContain('Dexterity requirements');
    expect(scoped).toContain('medium equipment load');
  });

  it.each(['none', 'light'] as const)('%s excludes unrelated Raise-led narrative after a matching build and stat instruction', spoilerMode => {
    const input = { game: 'Elden Ring', mode: 'guide' as const, spoilerMode,
      prompt: 'Find a good early-game Samurai build guide. No major spoilers.' };
    const anchor = 'In Elden Ring, an early-game Samurai build uses the Uchigatana and Unsheathe.';
    const advice = 'Prioritize Vigor for survival, then meet Dexterity requirements.';
    for (const unrelated of ['Raise the black banner after the final ruler reveals the hidden heir.',
      'Then raise the final monument when the navigator betrays the crew.']) {
      expect(scopeGamingEvidenceParagraphs(`${anchor} ${advice} ${unrelated}`, input)).toBe(`${anchor}\n\n${advice}`);
    }
  });

  it('does not treat a shared Raise verb as topical continuity', () => {
    const input = { mode: 'guide' as const, spoilerMode: 'none' as const, prompt: 'Explain the early-game Samurai build.' };
    const anchor = 'Raise weapon readiness for the early-game Samurai build.';
    expect(scopeGamingEvidenceParagraphs(`${anchor} Raise the black banner after the final ruler reveals the hidden heir.`, input))
      .toBe(anchor);
  });

  it('retains source-stated unfamiliar attribute and equipment requirements with their qualification', () => {
    const input = { mode: 'guide' as const, spoilerMode: 'none' as const, prompt: 'Explain the early-game Prismweaver build.' };
    const anchor = 'An early-game Prismweaver build uses the amber lens and silver robe.';
    const advice = 'Raise Insight enough for the named equipment requirement.';
    const qualification = 'This guide does not establish current patch balance or late-game requirements.';
    const scoped = scopeGamingEvidenceParagraphs(`${anchor} ${advice} ${qualification}`, input);
    expect(scoped).toBe(`${anchor}\n\n${advice}\n\n${qualification}`);
  });

  it('retains an explicitly connected Raise instruction outside a build request', () => {
    const input = { mode: 'guide' as const, spoilerMode: 'none' as const, prompt: 'How do I use the amber shield?' };
    const anchor = 'The amber shield blocks the guardian beam.';
    const advice = 'Raise the amber shield when the guardian prepares the beam.';
    expect(scopeGamingEvidenceParagraphs(`${anchor} ${advice}`, input)).toBe(`${anchor}\n\n${advice}`);
  });

  it('does not import stat instructions from an independent paragraph or an unrelated story sentence', () => {
    const input = { game: 'Elden Ring', mode: 'guide' as const, spoilerMode: 'none' as const, prompt: 'Explain the early-game Samurai build.' };
    const anchor = 'In Elden Ring, an early-game Samurai build uses the Uchigatana and Unsheathe.';
    expect(scopeGamingEvidenceParagraphs(`${anchor}\n\nPrioritize SPOILER_SENTINEL after the final story revelation.`, input)).toBe(anchor);
    expect(scopeGamingEvidenceParagraphs(`${anchor} The final villain is SPOILER_SENTINEL.`, input)).toBe(anchor);
  });

  it('retains the established four-successor ceiling for consecutive stat instructions', () => {
    const input = { game: 'Elden Ring', mode: 'guide' as const, spoilerMode: 'none' as const, prompt: 'Explain the early-game Samurai build.' };
    const body = 'In Elden Ring, an early-game Samurai build uses the Uchigatana. '
      + ['Vigor', 'Dexterity', 'Endurance', 'Strength', 'Faith', 'Arcane'].map(stat => `Raise ${stat} for its named equipment requirement.`).join(' ');
    const scoped = scopeGamingEvidenceParagraphs(body, input);
    expect(scoped).toContain('Raise Strength');
    expect(scoped).not.toContain('Raise Faith');
    expect(scoped).not.toContain('Raise Arcane');
  });
});

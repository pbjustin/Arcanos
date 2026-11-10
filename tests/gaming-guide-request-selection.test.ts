import { describe, expect, it } from '@jest/globals';
import { selectGamingHybridEvidence } from '../src/services/gamingHybridCandidates.js';
import { assessGamingRequestCoverage } from '../src/shared/gaming/gamingClearEvidence.js';
import { buildGamingRequestRequirements, buildGamingRetrievalTerms } from '../src/shared/gaming/gamingRetrievalPolicy.js';
import type { GamingStoredKnowledgeContext, GamingStoredKnowledgeInput } from '../src/shared/gaming/gamingStoredEvidenceCore.js';

// Authored fixtures mirror the grammatical relationships in the retained Frontier
// capture. These are not publisher quotations or proof of live gameplay/provider use.
const input: GamingStoredKnowledgeInput = { game: 'Elite Dangerous', mode: 'guide',
  prompt: 'Find a detailed guide explaining system colonisation in Elite Dangerous and how to get started, including prerequisites and the first concrete steps. Cite the guide sources.' };
const starting = 'To begin system colonisation, access the System Colonisation Contact in station services. Select an unpopulated star system in the available range and choose an initial starport.';
const requirement = 'Registering a star system for colonisation requires credits; the cost depends on the selected initial station. The system colonisation claim expires after its registration window.';
const continuation = 'Travel to the selected system and deploy the System Colonisation Beacon using the System Colonisation Suite. Supply the mined or purchased commodities requested by the colony construction project.';
function knowledge(texts: string[]): GamingStoredKnowledgeContext {
  const fetchedAt = '2026-11-09T12:00:00.000Z';
  const sources = [{ sourceId: 'accepted-guide', game: input.game, url: 'https://guides.example.org/authored-colonisation',
    sourceType: 'supplied', origin: 'live' as const, fetchedAt, snippet: texts[0] ?? '' }];
  return { context: '', sources, evidence: texts.map((text, index) => ({ sourceId: sources[0].sourceId,
    revisionId: 'accepted-revision', recordId: `passage-${index}`, recordType: 'guide', publicUrl: sources[0].url,
    text, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt } })) };
}

describe('guide request interpretation and accepted passage delivery', () => {
  it('covers the exact Elite request with complementary supported requirements and starting instructions', () => {
    const original = knowledge([starting, requirement, continuation]);
    const selected = selectGamingHybridEvidence(input, original);
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.missingCoverage).toEqual([]);
    expect(selected.selectedEvidenceIds).toEqual(expect.arrayContaining(['passage-0', 'passage-1']));
    for (const chunk of selected.knowledge.evidence!) {
      expect(chunk).toEqual(original.evidence!.find(item => item.recordId === chunk.recordId));
      expect(selected.knowledge.sources.find(source => source.sourceId === chunk.sourceId)?.url).toBe(chunk.publicUrl);
    }
  });

  it.each([
    'Find me a guide, explain how to start system colonisation, give me steps, and cite your sources.',
    'How do I begin system colonisation? Cite the guide sources.',
    'How do I get started with system colonisation? Give me ordered steps with citations.'
  ])('does not require source/presentation wording in the acquired gameplay: %s', prompt => {
    const request = { ...input, prompt };
    expect(buildGamingRetrievalTerms(request).focusTerms).toEqual(['system', 'colonisation']);
    expect(assessGamingRequestCoverage(request, knowledge([starting])).coverageSatisfied).toBe(true);
  });

  it('does not turn related wording into evidence for missing prerequisites', () => {
    const selected = selectGamingHybridEvidence(input, knowledge([starting, continuation]));
    expect(selected.coverageSatisfied).toBe(false);
    expect(selected.missingCoverage).toHaveLength(1);
    expect(selected.selectedEvidenceIds).toContain('passage-0');
  });

  it('needs an actual gameplay requirement, rather than a named requirements heading or unrelated prerequisite', () => {
    for (const text of ['System colonisation requirements guide. System colonisation is a way to expand the inhabited region.',
      'System colonisation expands the inhabited region. Aurora mining requires a thermal drill.']) {
      expect(assessGamingRequestCoverage(input, knowledge([starting, text])).coverageSatisfied).toBe(false);
    }
  });

  it('keeps concrete independent gameplay and scope requirements after presentation filtering', () => {
    const request = { ...input, prompt: 'Explain system colonisation prerequisites, unlock conditions, required materials, starting locations and ordered procedures. Cite sources. Only use the PC edition on patch 19.02 without story spoilers.' };
    expect(buildGamingRequestRequirements(request).length).toBeGreaterThanOrEqual(5);
    const terms = buildGamingRetrievalTerms(request).focusTerms;
    expect(terms).toContain('unlock');
    expect(terms).toContain('materials');
    expect(request.prompt).toContain('patch 19.02');
    expect(assessGamingRequestCoverage(request, knowledge([starting, requirement])).coverageSatisfied).toBe(false);
  });

  it('retains useful bounded partial passages without fabricating complete clause coverage', () => {
    const request = { ...input, prompt: 'Explain system colonisation prerequisites and permit quantities.' };
    const selected = selectGamingHybridEvidence(request, knowledge([starting, requirement]));
    expect(selected.coverageSatisfied).toBe(false);
    expect(selected.selectedEvidenceIds.length).toBeGreaterThan(0);
    expect(selected.knowledge.context.length).toBeLessThanOrEqual(12_000);
  });

  it('cannot satisfy an unsupported named mechanic merely through ordinary start synonyms', () => {
    const request = { ...input, prompt: 'How do I begin quantum crystal colonisation?' };
    expect(assessGamingRequestCoverage(request, knowledge([starting, requirement])).coverageSatisfied).toBe(false);
  });

  it('does not erase Start from a named gameplay object', () => {
    expect(buildGamingRetrievalTerms({ game: 'Lantern Voyage', prompt: 'Where is the Start Stone?' }).focusTerms)
      .toEqual(['start', 'stone']);
    expect(buildGamingRetrievalTerms({ game: 'Lantern Voyage', prompt: 'Where is the Requirements terminal?' }).focusTerms)
      .toEqual(['requirements', 'terminal']);
    expect(buildGamingRequestRequirements({ game: 'Lantern Voyage', prompt: 'Where is the Requirements terminal?' })).toEqual([]);
  });

  it('does not count a different starting action or motivational advice as colonisation prerequisites', () => {
    expect(assessGamingRequestCoverage({ ...input, prompt: 'How do I begin system colonisation?' },
      knowledge(['To start trading, inspect the system colonisation chart. System colonisation expands the inhabited region.'])).coverageSatisfied).toBe(false);
    expect(assessGamingRequestCoverage(input, knowledge([starting,
      'You must enjoy system colonisation to appreciate the expanded inhabited region.'])).coverageSatisfied).toBe(false);
  });

  it('keeps an unsupported uranium quantity independent from proven prerequisites', () => {
    const request = { ...input, prompt: 'Explain system colonisation prerequisites and required uranium quantity. Cite sources.' };
    const selected = selectGamingHybridEvidence(request, knowledge([starting, requirement]));
    expect(selected.coverageSatisfied).toBe(false);
    expect(selected.missingCoverage).toHaveLength(1);
    expect(selected.selectedEvidenceIds).toContain('passage-1');
  });

  it('cannot turn a same-topic reward tuple into prerequisite or starting-procedure proof', () => {
    const data = knowledge(['Topic: system colonisation | Reward: credits']);
    data.evidence![0].evidenceUnits = [{ id: 'reward-tuple', kind: 'table_row', text: data.evidence![0].text,
      fields: [{ label: 'Topic', value: 'system colonisation' }, { label: 'Reward', value: 'credits' }],
      context: { scope: 'table-0/row-1' }, integrity: { status: 'complete', reasons: [] },
      provenance: { sourceUrl: data.sources[0].url, strategy: 'html_table', policyVersion: 'gaming-evidence-units/v1',
        locator: 'table[0]/tr[1]', representation: 'html_dom' } }];
    expect(assessGamingRequestCoverage(input, data).coverageSatisfied).toBe(false);
  });

  it.each([
    ['System colonisation is optional, but trading requires a permit.', 'prerequisite'],
    ['System colonisation is optional and trading requires a permit.', 'prerequisite'],
    ['Trading, unlike system colonisation, starts by obtaining a permit.', 'start'],
    ['System colonisation never starts by deploying a beacon.', 'start']
  ] as const)('does not borrow topic anchors from comparison or negative scope: %s', (text, procedure) => {
    const prompt = procedure === 'start' ? 'How do I begin system colonisation?' : 'Explain system colonisation prerequisites.';
    expect(assessGamingRequestCoverage({ ...input, prompt }, knowledge([text])).coverageSatisfied).toBe(false);
  });

  it('keeps Requirements for Victory as an acquisition object', () => {
    const request = { game: 'Lantern Voyage', prompt: 'Where can I obtain the Requirements for Victory book?' };
    expect(buildGamingRetrievalTerms(request).focusTerms).toContain('requirements');
    expect(buildGamingRequestRequirements(request)).toEqual([]);
  });

  it('retains an explicit before-start player prerequisite across its grammatical comma', () => {
    const request = { ...input, prompt: 'Explain system colonisation prerequisites.' };
    expect(assessGamingRequestCoverage(request, knowledge([
      'Before beginning system colonisation, you must obtain a colonisation claim from a colonisation contact.'
    ])).coverageSatisfied).toBe(true);
  });

  it.each(['Never try to start system colonisation, because the feature is unavailable.',
    "Don't start by accessing system colonisation."])(
    'does not report an explicitly forbidden start as a starting procedure: %s', text => {
      expect(assessGamingRequestCoverage({ ...input, prompt: 'How do I begin system colonisation?' }, knowledge([text])).coverageSatisfied).toBe(false);
    });
});

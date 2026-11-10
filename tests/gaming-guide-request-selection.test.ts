import { describe, expect, it } from '@jest/globals';
import { selectGamingHybridEvidence } from '../src/services/gamingHybridCandidates.js';
import { assessGamingRequestCoverage } from '../src/shared/gaming/gamingClearEvidence.js';
import { buildGamingRequestRequirements, buildGamingRetrievalTerms } from '../src/shared/gaming/gamingRetrievalPolicy.js';
import type { GamingStoredKnowledgeContext, GamingStoredKnowledgeInput } from '../src/shared/gaming/gamingStoredEvidenceCore.js';
import { extractGamingHtmlEvidence } from '../src/services/gamingHtmlEvidence.js';

// Authored fixtures mirror the grammatical relationships in the retained Frontier
// capture. These are not publisher quotations or proof of live gameplay/provider use.
const input: GamingStoredKnowledgeInput = { game: 'Elite Dangerous', mode: 'guide',
  prompt: 'Find a detailed guide explaining system colonisation in Elite Dangerous and how to get started, including prerequisites and the first concrete steps. Cite the guide sources.' };
const starting = 'To begin system colonisation, access the System Colonisation Contact in station services. Select an unpopulated star system in the available range and choose an initial starport.';
const requirement = 'Registering a star system for colonisation requires credits; the cost depends on the selected initial station. The system colonisation claim expires after its registration window.';
const continuation = 'Travel to the selected system and deploy the System Colonisation Beacon using the System Colonisation Suite. Supply the mined or purchased commodities requested by the colony construction project.';
/** Bind authored passages to one accepted source for pure selection checks. */
function knowledge(texts: string[]): GamingStoredKnowledgeContext {
  const fetchedAt = '2026-11-09T12:00:00.000Z';
  const sources = [{ sourceId: 'accepted-guide', game: input.game, url: 'https://guides.example.org/authored-colonisation',
    sourceType: 'supplied', origin: 'live' as const, fetchedAt, snippet: texts[0] ?? '' }];
  return { context: '', sources, evidence: texts.map((text, index) => ({ sourceId: sources[0].sourceId,
    revisionId: 'accepted-revision', recordId: `passage-${index}`, recordType: 'guide', publicUrl: sources[0].url,
    text, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt } })) };
}

/** Extract a real parser-owned row from authored HTML without network access. */
function extractedRow(fields: Array<[string, string]>, caption = '', heading = 'Elite Dangerous mechanics'): GamingStoredKnowledgeContext {
  const data = knowledge([]);
  const extracted = extractGamingHtmlEvidence({ contentType: 'text/html', sourceUrl: data.sources[0].url,
    body: `<article><h1>${heading}</h1><table>${caption ? `<caption>${caption}</caption>` : ''}<tr>`
      + fields.map(([label]) => `<th>${label}</th>`).join('') + '</tr><tr>'
      + fields.map(([, value]) => `<td>${value}</td>`).join('') + '</tr></table></article>' });
  expect(extracted.units).toHaveLength(1);
  expect(extracted.units[0]).toMatchObject({ kind: 'table_row', integrity: { status: 'complete', reasons: [] },
    fields: fields.map(([label, value]) => ({ label, value })) });
  const result = knowledge([extracted.units[0].text]);
  result.evidence![0].evidenceUnits = extracted.units;
  return result;
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
    const requirements = buildGamingRequestRequirements(request);
    expect(requirements).toHaveLength(1);
    expect(requirements[0].terms).toEqual(['requirements', 'victory', 'book']);
    expect(requirements[0].procedure).toBeUndefined();
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

  it.each(['How do I begin system colonisation?', 'Explain system colonisation prerequisites.'])(
    'does not use an intact mechanic/value row without a procedure for %s', prompt => {
      const data = extractedRow([['Mechanic', 'system colonisation'], ['Value', 'optional']]);
      expect(assessGamingRequestCoverage({ ...input, prompt }, data).coverageSatisfied).toBe(false);
      expect(selectGamingHybridEvidence({ ...input, prompt }, data).coverageSatisfied).toBe(false);
    });

  it.each([
    ['How do I begin system colonisation?', 'starts by visiting the colonisation contact'],
    ['Explain system colonisation prerequisites.', 'requires a colonisation claim']
  ])('preserves the acquired procedure relation across fields for %s', (prompt, value) => {
    const data = extractedRow([['Mechanic', 'system colonisation'], ['Value', value]]);
    const assessment = assessGamingRequestCoverage({ ...input, prompt }, data);
    expect(assessment.coverageSatisfied).toBe(true);
    expect(assessment.requirementUnitSupport?.[0].evidenceUnitIds).toEqual([data.evidence![0].evidenceUnits![0].id]);
    const selected = selectGamingHybridEvidence({ ...input, prompt }, data);
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.knowledge.evidence![0].evidenceUnits![0]).toEqual(data.evidence![0].evidenceUnits![0]);
    expect(selected.knowledge.sources[0].url).toBe(data.sources[0].url);
  });

  it.each([
    ['How do I begin system colonisation?', 'System colonisation starts by visiting the colonisation contact.'],
    ['Explain system colonisation prerequisites.', 'System colonisation requires a colonisation claim.']
  ])('preserves an explicit acquired relation within one structural field for %s', (prompt, value) => {
    const data = extractedRow([['Mechanic', 'system colonisation'], ['Value', value]]);
    expect(assessGamingRequestCoverage({ ...input, prompt }, data).coverageSatisfied).toBe(true);
  });

  it.each([
    ['Trading starts by buying a freight permit.'],
    ['never starts by visiting the colonisation contact']
  ])('does not attach another subject or a negated predicate to the mechanic: %s', value => {
    expect(assessGamingRequestCoverage({ ...input, prompt: 'How do I begin system colonisation?' },
      extractedRow([['Mechanic', 'system colonisation'], ['Value', value]])).coverageSatisfied).toBe(false);
  });

  it.each(['caption', 'heading', 'field label'])('does not promote an acquired %s to a structural procedure claim', location => {
    const claim = 'System colonisation starts by visiting the colonisation contact';
    const fields: Array<[string, string]> = [['Mechanic', 'system colonisation'], ['Value', 'optional']];
    if (location === 'field label') fields.push([claim, 'nothing']);
    const data = extractedRow(fields, location === 'caption' ? claim : '', location === 'heading' ? claim : undefined);
    expect(assessGamingRequestCoverage({ ...input, prompt: 'How do I begin system colonisation?' }, data).coverageSatisfied).toBe(false);
  });

  it('does not borrow a predicate from another independently intact row', () => {
    const data = extractedRow([['Mechanic', 'system colonisation'], ['Value', 'optional']]);
    const unrelated = extractedRow([['Mechanic', 'trading'], ['Value', 'starts by buying a freight permit']]);
    data.evidence!.push({ ...unrelated.evidence![0], recordId: 'unrelated-passage' });
    expect(assessGamingRequestCoverage({ ...input, prompt: 'How do I begin system colonisation?' }, data).coverageSatisfied).toBe(false);
  });

  it('retains existing non-procedural support for an optional mechanic value', () => {
    expect(assessGamingRequestCoverage({ ...input, prompt: 'Explain system colonisation.' },
      extractedRow([['Mechanic', 'system colonisation'], ['Value', 'optional']])).coverageSatisfied).toBe(true);
  });

  it('keeps a malformed structural unit without fields fail-closed without throwing', () => {
    const data = extractedRow([['Mechanic', 'system colonisation'], ['Value', 'starts by visiting the colonisation contact']]);
    delete (data.evidence![0].evidenceUnits![0] as unknown as { fields?: unknown }).fields;
    const assess = () => assessGamingRequestCoverage({ ...input, prompt: 'How do I begin system colonisation?' }, data);
    expect(assess).not.toThrow();
    expect(assess().coverageSatisfied).toBe(false);
  });
});

import { describe, expect, test } from '@jest/globals';
import { assessGamingClearEvidence, assessGamingRequestCoverage } from '../src/shared/gaming/gamingClearEvidence.js';
import { evaluateGamingFreshness, GAMING_SOURCE_POLICY_VERSION, type GamingFreshnessEvidence } from '../src/shared/gaming/gamingFreshnessCore.js';
import { selectGamingCoverageEvidence, type GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';

import { preserveGamingSelectionAdjacency } from '../src/shared/gaming/gamingRetrievalPolicy.js';

const now = new Date('2026-09-09T12:00:00Z');
const staticInput = { game: 'The Legend of Zelda: Ocarina of Time', mode: 'guide' as const, prompt: 'How do I open the copper gate?' };
function knowledge(game: string, passages: string[], overrides: Partial<GamingStoredKnowledgeContext> = {}): GamingStoredKnowledgeContext {
  return { context: passages.join('\n\n'), sources: passages.map((text, index) => ({ game, sourceId: `source-${index}`,
    url: `https://synthetic.example/guide-${index}`, sourceType: 'supplied', fetchedAt: now.toISOString(), snippet: text })),
  evidence: passages.map((text, index) => ({ sourceId: `source-${index}`, revisionId: `revision-${index}`, recordId: `chunk-${index}`,
    recordType: 'guide', publicUrl: `https://synthetic.example/guide-${index}`, text, lexicalScore: 1, combinedScore: 1,
    provenance: { fetchedAt: now.toISOString() } })), ...overrides };
}
function freshness(game: string, index: number, overrides: Partial<GamingFreshnessEvidence> = {}): GamingFreshnessEvidence {
  return { game, id: `source-${index}`, url: `https://synthetic.example/guide-${index}`,
    policyVersion: GAMING_SOURCE_POLICY_VERSION, category: 'specialist_guide', authority: 'specialist', currentness: 'none',
    durableAllowed: true, autoStoreAllowed: false, fetchedAt: now.toISOString(), verifiedAt: now.toISOString(),
    metadataConfidence: 'content_extracted', patch: '2.1', effectiveFrom: '2026-09-08T00:00:00Z', ...overrides };
}
function currentSet(game: string, guide: string) {
  const data = knowledge(game, [guide, 'The reviewed release index identifies active patch 2.1, effective September 8.']);
  const metadata = [freshness(game, 0), freshness(game, 1, { category: 'official_updates', authority: 'official',
    currentness: 'current_index', currentPatch: '2.1' })];
  data.sources.forEach((source, index) => { source.freshnessMetadata = { ...metadata[index] }; });
  return { data, metadata };
}
const run = (input: typeof staticInput | { game: string; mode: 'guide' | 'build'; prompt: string; requestedVersion?: string }, data: GamingStoredKnowledgeContext) =>
  assessGamingClearEvidence(input, data, { now });

describe('Gaming CLEAR bounded evidence decisions', () => {
  test.each([
    ['Elden Ring', 'How do I upgrade my weapons?', 'Use the smithing table to reinforce your armaments with Smithing Stones.'],
    ['Monster Hunter: World', 'How can I strengthen my armour?', 'At the Smithy, improve your armor with Armor Spheres.'],
    ['Stardew Valley', 'How can I improve my tool?', 'To strengthen your tools, bring the selected item and metal bars to the blacksmith.'],
    ['Elden Ring', 'How do I improve my armaments?', 'At the smithing table, use Smithing Stones to upgrade your weapons.']
  ])('recognizes an acquired improvement action and method for %s without exact wording', (game, prompt, passage) => {
    const input = { game, mode: 'guide' as const, prompt };
    const data = knowledge(game, [passage]);
    expect(assessGamingRequestCoverage(input, data)).toMatchObject({ coverageSatisfied: true, missingCoverage: [] });
    expect(assessGamingClearEvidence(input, data, { now, requireRequestCoverage: true }).decision).toBe('accept');
  });

  test.each([
    ['a different object', 'Use the smithing table to upgrade a weapon. The station next door stores equipment.'],
    ['an unrelated subject', 'Use the smithing table to upgrade the crafting station overlooking your equipment.'],
    ['a negative instruction', 'Never upgrade your equipment at this smithing table.'],
    ['a hypothetical action', 'If the blacksmith opens tomorrow, you might upgrade your equipment with star coins.'],
    ['a speculative report', 'Players are planning to upgrade their equipment at the smithing table.'],
    ['a future feature', 'Use the smithing table to upgrade your equipment with star coins starting in the next patch.'],
    ['a quoted claim', 'The notice repeats "Use the smithing table to upgrade your equipment with Smithing Stones."'],
    ['a time with no method', 'You can upgrade your equipment at some point.'],
    ['an expressly withheld method', 'Upgrade your equipment with no method documented.'],
    ['a guide pointer', 'In the game Elden Ring, use this guide to strengthen your gear.'],
    ['a walkthrough pointer', 'To improve your gear, visit this walkthrough.'],
    ['a still-unavailable item', 'Reinforce your gear with an item that is still unavailable.'],
    ['an unknown location', 'Upgrade your gear at some unknown location.'],
    ['an instruction without a method', 'Upgrade your equipment. That makes fights easier.']
  ])('does not credit %s as a method for improving equipment', (_description, passage) => {
    const input = { game: 'Elden Ring', mode: 'guide' as const, prompt: 'How do I upgrade my equipment?' };
    const data = knowledge(input.game, [passage]);
    expect(assessGamingRequestCoverage(input, data).coverageSatisfied).toBe(false);
    expect(assessGamingClearEvidence(input, data, { now, requireRequestCoverage: true }).decision).not.toBe('accept');
  });

  test.each([
    'Use the linked guide to reinforce your armaments.',
    'Use the separate online guide to reinforce your armaments.'
  ])('does not treat a qualified source reference as the weapon upgrade method: %s', passage => {
    const input = { game: 'Elden Ring', mode: 'guide' as const, prompt: 'How do I upgrade my weapons?' };
    const data = knowledge(input.game, [passage]);
    expect(assessGamingRequestCoverage(input, data).coverageSatisfied).toBe(false);
    expect(assessGamingClearEvidence(input, data, { now, requireRequestCoverage: true }).decision).not.toBe('accept');
  });

  test('does not turn a generic improvement method into proof for a named item', () => {
    const input = { game: 'Elden Ring', mode: 'guide' as const, prompt: 'How do I upgrade the Bloodhound’s Fang?' };
    const data = knowledge(input.game, ['Use the smithing table to reinforce your armaments with Smithing Stones.']);
    expect(assessGamingRequestCoverage(input, data).coverageSatisfied).toBe(false);
  });

  test('does not credit a topic named only in an explicit walkthrough disclaimer', () => {
    const input = { game: 'Hollow Knight', mode: 'guide' as const, prompt: 'How do I unlock the Forgotten Crossroads Stag Station?' };
    const passage = 'The Dirtmouth station opens from below after the gate is unlocked. No Forgotten Crossroads Stag Station instructions are provided.';
    expect(assessGamingRequestCoverage(input, knowledge(input.game, [passage])).coverageSatisfied).toBe(false);
  });

  test('still requires the second requested fact beside a paraphrased equipment action', () => {
    const input = { game: 'Elden Ring', mode: 'guide' as const, prompt: 'How do I upgrade my weapons, and where is the Celestial Dew?' };
    const method = 'Use the smithing table to reinforce your armaments with Smithing Stones.';
    const partial = assessGamingRequestCoverage(input, knowledge(input.game, [method]));
    expect(partial.coverageSatisfied).toBe(false);
    expect(partial.requirementSupport.map(item => item.evidenceIds.length)).toEqual([1, 0]);
    const complete = assessGamingRequestCoverage(input, knowledge(input.game, [method, 'The Celestial Dew is beside the locked gate.']));
    expect(complete.coverageSatisfied).toBe(true);
  });

  const disembarkationRequest = { game: 'Disco Elysium', mode: 'guide' as const,
    prompt: 'What should I do next?', progressPoint: 'Just got off the boat.', spoilerMode: 'light' as const };

  test.each([
    'After disembarking from the ship at the docks, follow the path past the mooring post.',
    'Once you step off the ferry, walk to the ticket office.',
    'After you step off the ferry, follow the guide through the gate.'
  ])('credits an explicit player disembarkation and its actual next action', passage => {
    const data = knowledge(disembarkationRequest.game, [passage]);
    expect(assessGamingRequestCoverage(disembarkationRequest, data).coverageSatisfied).toBe(true);
    expect(assessGamingClearEvidence(disembarkationRequest, data, { now }).decision).toBe('accept');
  });

  test.each([
    'After disembarking from a platform overlooking the boat, follow the path past the mooring post.',
    'After the sailor gets off the boat, follow the path past the mooring post.',
    'After you did not get off the boat, follow the path past the mooring post.',
    'After arriving at the docks by boat, follow the path past the mooring post.',
    'The boat docks before the path opens. Follow the path past the mooring post.',
    'After disembarking from the ship, read the separate walkthrough for next steps.',
    'After disembarking from the ship, head to our walkthrough for the next steps.',
    'After disembarking from the ship, walk to the separate online wiki for the next steps.',
    'After disembarking from the ship, drive away once the next patch unlocks the car.',
    'You got off the boat at the docks. There is no next instruction here.',
    '“After you get off the boat, follow the path past the mooring post.”'
  ])('does not invent a player action or causal handoff from %s', passage => {
    const data = knowledge(disembarkationRequest.game, [passage]);
    expect(assessGamingRequestCoverage(disembarkationRequest, data).coverageSatisfied).toBe(false);
    expect(assessGamingClearEvidence(disembarkationRequest, data, { now }).decision).not.toBe('accept');
  });

  test('keeps a registered narrative checkpoint and its explicit player handoff in one passage', () => {
    const input = { ...disembarkationRequest, game: 'Grand Theft Auto IV' };
    const checkpoint = 'After watching the introduction where Niko and his fellow passengers step off the cargo ship at Liberty City, Roman has arrived to collect you.';
    const driving = "Once you're in his car, you'll need to drive him back to his apartment.";
    expect(preserveGamingSelectionAdjacency(`${checkpoint} ${driving}`, `${checkpoint}\n\n${driving}`, input.game)).toBe('');
    const intact = knowledge(input.game, [`${checkpoint} ${driving}`]);
    expect(assessGamingRequestCoverage(input, intact).coverageSatisfied).toBe(true);
    expect(assessGamingClearEvidence(input, intact, { now }).decision).toBe('accept');
    const transfer = "He's glad to see you. Roman's tired, so he's unable to drive, so it's over to you.";
    expect(assessGamingRequestCoverage(input, knowledge(input.game, [`${checkpoint} ${transfer} ${driving}`]))
      .coverageSatisfied).toBe(true);
    for (const unbound of [
      [checkpoint, driving],
      [`${checkpoint}\n\n${driving}`],
      [`${checkpoint.replace('Niko and his fellow passengers', 'A sailor')} ${driving}`],
      [`${checkpoint.replace('the cargo ship', 'a platform overlooking the ship')} ${driving}`],
      [`${checkpoint.replace('to collect you', 'to collect his friend')} ${driving}`],
      [`${checkpoint} The next mission starts later. ${driving}`],
      [`${checkpoint} Later. ${driving}`],
      [`${checkpoint} This walkthrough describes a later part of the game. ${driving}`],
      [`${checkpoint} Roman has no car. ${driving}`],
      [`This example is hypothetical. ${checkpoint} ${driving}`],
      [`${checkpoint} ${driving.replace('drive him', 'drive her')}`],
      [`${checkpoint} ${driving.replace('need to drive', 'probably be asked to drive')}`],
      [`${checkpoint} Once you are in the car, read the linked walkthrough for the next steps.`]
    ]) expect(assessGamingRequestCoverage(input, knowledge(input.game, unbound)).coverageSatisfied).toBe(false);
  });

  test('requires opening evidence when the player locates the checkpoint at the beginning', () => {
    const input = { ...disembarkationRequest, game: 'Grand Theft Auto IV',
      progressPoint: 'Just got off the boat at the beginning.' };
    const checkpoint = 'After Niko steps off the cargo ship at Liberty City, Roman has arrived to collect you.';
    const driving = "Once you're in his car, you'll need to drive him back to his apartment.";
    const introduction = checkpoint.replace('After Niko', 'After watching the introduction where Niko');
    const opening = knowledge(input.game, [`${introduction} ${driving}`]);
    expect(assessGamingRequestCoverage(input, opening).coverageSatisfied).toBe(true);
    for (const unbound of [
      [`${checkpoint} ${driving}`],
      [introduction, driving],
      ['After you step off the boat at the docks, follow the path past the mooring post.'],
      ['After the boat docks at the beginning, read the separate walkthrough.'],
      ['The boat docks at the beginning. Follow the path past the mooring post.']
    ]) {
      const data = knowledge(input.game, unbound);
      expect(assessGamingRequestCoverage(input, data).coverageSatisfied).toBe(false);
      expect(assessGamingClearEvidence(input, data, { now }).decision).not.toBe('accept');
    }
  });

  test('cannot use passage selection to choose an unspecified disembarkation checkpoint', () => {
    const input = { ...disembarkationRequest, game: 'Sea of Thieves' };
    const routes = [
      'After disembarking from the ship at Sanctuary Outpost, visit the trading company.',
      'After disembarking from the ship at Port Merrick, follow the path to the tavern.'
    ];
    for (const passages of [routes, [routes.join(' ')]]) {
      const data = knowledge(input.game, passages);
      expect(assessGamingRequestCoverage(input, data)).toMatchObject({
        coverageSatisfied: false, gapAssessmentStatus: 'not_assessed'
      });
      expect(assessGamingClearEvidence(input, data, { now }).decision).not.toBe('accept');
    }
    const data = knowledge(input.game, routes);
    const pool = data.evidence!.map((evidence, index) => ({ evidence, source: data.sources[index] }));
    const limits = { chunkChars: 1_200, maxChunks: 1, maxSources: 1, maxContextChars: 1_200, structuredEvidenceChars: 8_000 };
    expect(selectGamingCoverageEvidence(pool, input, limits, assessGamingRequestCoverage)).toEqual([]);
    expect(selectGamingCoverageEvidence(pool.slice(0, 1), input, limits, assessGamingRequestCoverage)).toHaveLength(1);
    expect(assessGamingRequestCoverage(input, knowledge(input.game, [routes[0], routes[0]])).coverageSatisfied).toBe(true);
  });

  test('still checks a separate requested topic after matching disembarkation', () => {
    const input = { ...disembarkationRequest, prompt: 'What should I do next, and where is the elevator?' };
    const passage = 'After disembarking from the ship at the docks, follow the path past the mooring post.';
    const coverage = assessGamingRequestCoverage(input, knowledge(input.game, [passage]));
    expect(coverage.coverageSatisfied).toBe(false);
    expect(coverage.requirementSupport.map(item => item.evidenceIds.length)).toEqual([0, 1]);
  });

  const gtaProgressRequest = { game: 'Grand Theft Auto IV', mode: 'guide' as const,
    prompt: 'What should I do next?', progressPoint: 'Just arrived by boat.', spoilerMode: 'light' as const };

  test.each([
    ['an uncertain planned scene', 'The expected scene has Niko climb off the boat in Liberty City with Roman.'],
    ['a stated plan', 'The plan says Niko climbs off the boat in Liberty City with Roman.'],
    ['a different actor performing the action', 'Roman waits in Liberty City with Niko and watches a sailor climb off the boat.'],
    ['an action with no registered actor', 'A sailor climbs off the boat near the docks.'],
  ])('does not let %s establish the GTA IV checkpoint coverage', (_case, passage) => {
    expect(assessGamingRequestCoverage(gtaProgressRequest, knowledge(gtaProgressRequest.game, [passage])).coverageSatisfied).toBe(false);
  });

  test('accepts a registered GTA IV actor action without requiring unrelated topic entities in that sentence', () => {
    const passage = 'After Niko Bellic climbs off the boat, follow Roman to Hove Beach.';
    expect(assessGamingRequestCoverage(gtaProgressRequest, knowledge(gtaProgressRequest.game, [passage])))
      .toMatchObject({ coverageSatisfied: true, missingCoverage: [] });
  });

  test('retains valid next-step coverage when the acquired prose reports a boat docking', () => {
    const passage = 'After the boat docks at the beginning, drive Roman to Hove Beach along the route marked on the map.';
    expect(assessGamingRequestCoverage(gtaProgressRequest, knowledge(gtaProgressRequest.game, [passage])))
      .toMatchObject({ coverageSatisfied: true, missingCoverage: [] });
  });

  test('does not re-credit a filtered checkpoint claim for a separate multipart requirement', () => {
    const input = { ...gtaProgressRequest,
      prompt: 'What should I do next, what are the first two actions to reach the safehouse, and where is the hospital?' };
    const passage = 'The plan says Niko climbs off the boat in Liberty City with Roman, then follows him to the hospital.';
    const coverage = assessGamingRequestCoverage(input, knowledge(input.game, [passage]));
    expect(coverage.coverageSatisfied).toBe(false);
    expect(coverage.requirementSupport.length).toBeGreaterThan(1);
    expect(coverage.requirementSupport.every(requirement => requirement.evidenceIds.length === 0)).toBe(true);
  });

  test('complementary passages cover the request without requiring multiple sources', () => {
    const input = { ...staticInput, prompt: 'Where are the copper key and silver lever?' };
    const data = knowledge(input.game, ['The copper key is inside the hollow pedestal by the gate.', 'The silver lever is beside the upper balcony entrance.']);
    expect(run(input, data)).toMatchObject({ decision: 'accept', profile: 'evidence', assessmentStatus: 'completed' });
    expect(run(staticInput, knowledge(staticInput.game, ['Open the copper gate with the key from the hollow pedestal.']))).toMatchObject({ decision: 'accept' });
  });

  test('individually relevant documents with contradictory explicit mechanics fail the set', () => {
    const data = knowledge(staticInput.game, ['The copper gate opens after two turns of the lever.', 'The copper gate opens after three turns of the lever.']);
    data.sources.forEach((source, index) => { source.freshnessMetadata = { ...freshness(staticInput.game, index), mechanicValues: { 'gate lever turns': String(index + 2) } }; });
    expect(run(staticInput, data)).toMatchObject({ decision: 'reject', gates: { compatibility: 'conflict' },
      blockingFindings: expect.arrayContaining([expect.objectContaining({ code: 'CONTRADICTORY_EVIDENCE' })]) });
  });

  test('wrong game, wrong edition and unsafe URL cannot be compensated by topic coverage', () => {
    const data = knowledge('Elden Ring', ['Open the copper gate with the key from the hollow pedestal.']);
    expect(run(staticInput, data).decision).toBe('reject');
    const wrongEdition = knowledge(staticInput.game, ['Open the copper gate with the key from the hollow pedestal.']);
    wrongEdition.sources[0].edition = 'Unrelated remake';
    expect(assessGamingClearEvidence({ ...staticInput, edition: 'Master Quest' }, wrongEdition, { now }))
      .toMatchObject({ decision: 'reject', gates: { compatibility: 'conflict' } });
    expect(run(staticInput, wrongEdition))
      .toMatchObject({ decision: 'clarify', gates: { compatibility: 'unknown' } });
    const unspecified = knowledge(staticInput.game, ['Open the copper gate with the key from the hollow pedestal.']);
    expect(assessGamingClearEvidence({ ...staticInput, edition: 'Master Quest' }, unspecified, { now }))
      .toMatchObject({ gates: { compatibility: 'unknown' }, dimensionScores: { alignment: { score: null } } });
    const unsafe = knowledge(staticInput.game, ['Open the copper gate with the key from the hollow pedestal.']);
    unsafe.sources[0].url = 'https://user:secret@synthetic.example/guide';
    expect(run(staticInput, unsafe)).toMatchObject({ decision: 'reject', gates: { security: 'conflict' } });
  });

  test('freshly fetched old build evidence and missing version remain unknown', () => {
    const input = { game: 'Elden Ring', mode: 'build' as const, prompt: 'Which current copper staff build should I use?' };
    const data = knowledge(input.game, ['For the copper staff build, equip the copper staff before the shield.']);
    const unknown = run(input, data);
    expect(unknown.gates.freshness).toBe('unknown');
    expect(unknown.dimensionScores.resilience.score).toBeNull();
    expect(unknown.overall).toBeNull();
    const old = currentSet(input.game, data.evidence![0].text);
    old.data.sources[0].freshnessMetadata!.patch = '1.0';
    expect(run(input, old.data).decision).not.toBe('accept');
  });

  test.each([{ platforms: ['Xbox'] }, { regions: ['EU'] }])('ordinary static advice retains source restrictions without inventing a missing player decision: %j', restriction => {
    const data = knowledge(staticInput.game, ['Open the copper gate with the key from the hollow pedestal.']);
    data.sources[0].freshnessMetadata = { ...freshness(staticInput.game, 0, { patch: undefined, ...restriction }) };
    expect(run(staticInput, data)).toMatchObject({ decision: 'accept',
      gates: { compatibility: 'verified', freshness: 'not_applicable' } });
    expect(assessGamingClearEvidence({ ...staticInput, platform: 'Xbox', region: 'EU' }, data, { now }).decision).toBe('accept');
    expect(assessGamingClearEvidence({ ...staticInput, platform: 'PC', region: 'US' }, data, { now }).decision).toBe('reject');
  });

  test('a controls question still requires a material missing platform decision', () => {
    const input = { ...staticInput, prompt: 'Which keybindings open the copper gate?' };
    const data = knowledge(input.game, ['The copper gate keybindings controls use the interact button to open the gate.']);
    data.sources[0].freshnessMetadata = { ...freshness(input.game, 0, { patch: undefined, platforms: ['Xbox'] }) };
    expect(run(input, data)).toMatchObject({ decision: 'clarify', gates: { compatibility: 'unknown' } });
  });

  test('all-platform/all-region stable evidence needs no irrelevant patch metadata', () => {
    const data = knowledge(staticInput.game, ['Open the copper gate with the key from the hollow pedestal.']);
    data.sources[0].freshnessMetadata = { ...freshness(staticInput.game, 0, { patch: undefined, platforms: ['ALL'], regions: ['all'] }) };
    expect(run(staticInput, data)).toMatchObject({ decision: 'accept', gates: { compatibility: 'verified', freshness: 'not_applicable' } });
  });

  test.each([
    { effectiveFrom: '2026-09-10T12:00:00Z' },
    { publishedAt: '2026-09-10T12:00:00Z' },
    { effectiveUntil: '2026-09-09T11:59:59Z' },
    { effectiveUntil: now.toISOString() }
  ])('explicit future or expired applicability blocks stable evidence: %j', restriction => {
    const data = knowledge(staticInput.game, ['Open the copper gate with the key from the hollow pedestal.']);
    data.sources[0].freshnessMetadata = { ...freshness(staticInput.game, 0, restriction) };
    expect(run(staticInput, data)).toMatchObject({ decision: 'reject', gates: { compatibility: 'conflict' },
      blockingFindings: expect.arrayContaining([expect.objectContaining({ code: 'APPLICABILITY_CONFLICT' })]) });
  });

  test('invalid explicit time metadata remains unknown for a stable question', () => {
    const data = knowledge(staticInput.game, ['Open the copper gate with the key from the hollow pedestal.']);
    data.sources[0].freshnessMetadata = { ...freshness(staticInput.game, 0, { effectiveUntil: 'unverified date' }) };
    expect(run(staticInput, data)).toMatchObject({ decision: 'clarify', overall: null, gates: { compatibility: 'unknown' } });
  });

  test('a verified requested historical patch remains usable after its old interval ends', () => {
    const input = { ...staticInput, requestedVersion: '1.0', prompt: 'For historical patch 1.0, how do I open the copper gate?' };
    const data = knowledge(input.game, ['For historical patch 1.0, open the copper gate using the copper key from the pedestal.']);
    data.sources[0].freshnessMetadata = { ...freshness(input.game, 0, { patch: '1.0',
      effectiveFrom: '2020-01-01T00:00:00Z', effectiveUntil: '2021-01-01T00:00:00Z',
      fetchedAt: '2022-01-01T00:00:00Z', verifiedAt: '2022-01-01T00:00:00Z' }) };
    expect(run(input, data)).toMatchObject({ decision: 'accept', gates: { compatibility: 'verified', freshness: 'verified' } });
    expect(run({ ...input, prompt: 'For current patch 1.0, how do I open the copper gate?' }, data).decision).not.toBe('accept');
  });

  test('current official patch notes support a change but cannot independently establish a build', () => {
    const input = { game: 'Elden Ring', mode: 'build' as const, prompt: 'Which current copper staff build should I use?' };
    const set = currentSet(input.game, 'The patch change gives the copper staff ten points for its build mechanic.');
    set.data.sources[0].sourceType = 'official_updates';
    set.data.sources[0].freshnessMetadata = { ...set.metadata[0], category: 'official_updates', authority: 'official' };
    expect(run(input, set.data).decision).not.toBe('accept');
    expect(run({ ...input, mode: 'guide', prompt: 'What did the patch change for copper staff?' }, set.data).decision).toBe('accept');
  });

  test('copied passages cannot increase resilience or count as independent corroboration', () => {
    const passage = 'Open the copper gate with the key from the hollow pedestal.';
    const one = run(staticInput, knowledge(staticInput.game, [passage]));
    const copied = run(staticInput, knowledge(staticInput.game, [passage, passage]));
    expect(copied.dimensionScores.resilience.score).toBe(one.dimensionScores.resilience.score);
    expect(copied.dimensionScores.efficiency.score).toBeLessThan(one.dimensionScores.efficiency.score!);
    expect(copied.findings.map(finding => finding.code)).toContain('DUPLICATE_EVIDENCE');
  });

  test('missing progression and missing topic coverage prevent generation-ready evidence', () => {
    const data = knowledge(staticInput.game, ['Open the copper gate with the key from the hollow pedestal.']);
    expect(run({ ...staticInput, prompt: 'What next?' }, data).blockingFindings.map(finding => finding.code)).toContain('PROGRESS_POINT_REQUIRED');
    expect(run({ ...staticInput, prompt: 'Where is the sapphire compass?' }, data).decision).not.toBe('accept');
  });

  test('legacy records stay usable without fabricated prior source scores', () => {
    const data = knowledge(staticInput.game, ['Open the copper gate with the key from the hollow pedestal.']);
    const audit = run(staticInput, data);
    expect(audit.decision).toBe('accept');
    expect(data.sources[0].clearSourceAssessment).toBeUndefined();
    expect(audit.findings.map(finding => finding.code)).toContain('LEGACY_SOURCE_NOT_PREVIOUSLY_ASSESSED');
    expect(audit.dimensionScores.resilience.score).toBeLessThan(5);
  });

  test('content, player context and verified patch changes invalidate the assessment binding', () => {
    const data = knowledge(staticInput.game, ['Open the copper gate with the key from the hollow pedestal.']);
    const audit = run(staticInput, data);
    expect(assessGamingClearEvidence({ ...staticInput, currentArea: 'Upper balcony' }, data, { now }).contextFingerprint).not.toBe(audit.contextFingerprint);
    data.evidence![0].text += ' Return to the balcony.';
    expect(run(staticInput, data).subjectHash).not.toBe(audit.subjectHash);
    const set = currentSet('Elden Ring', 'Equip the copper staff for the current copper staff build.');
    const current = { game: 'Elden Ring', mode: 'build' as const, prompt: 'Which copper staff build is current?' };
    const before = run(current, set.data);
    set.data.sources[1].freshnessMetadata!.currentPatch = '2.2';
    expect(run(current, set.data).contextFingerprint).not.toBe(before.contextFingerprint);
  });

  test('a freshness pass for another selected set cannot bless missing evidence', () => {
    const input = { game: 'Elden Ring', mode: 'build' as const, prompt: 'Which copper staff build is current?' };
    const set = currentSet(input.game, 'Equip the copper staff for the current copper staff build.');
    const checked = evaluateGamingFreshness({ game: input.game, mode: input.mode, question: input.prompt, evidence: set.metadata, now });
    checked.selectedEvidenceIds = ['unrelated'];
    expect(assessGamingClearEvidence(input, set.data, { now, freshness: checked }).decision).not.toBe('accept');
  });

  test('the internal advisory grant preserves gameplay coverage with an honestly unknown freshness gate', () => {
    const input = { game: 'Elden Ring', mode: 'build' as const, prompt: 'Which copper staff build should I use?' };
    const data = knowledge(input.game, ['For the copper staff build, equip the copper staff before the shield.']);
    expect(run(input, data).decision).not.toBe('accept');
    const accepted = assessGamingClearEvidence(input, data, { now, allowAdvisoryFreshness: true });
    expect(accepted).toMatchObject({ decision: 'accept', policyProfile: 'gaming-clear-policy/v7:advisory_recommendation:evidence',
      gates: { freshness: 'unknown', claimSupport: 'verified', provenance: 'verified' } });
    expect(accepted.findings).toContainEqual(expect.objectContaining({ code: 'ADVISORY_FRESHNESS_UNVERIFIED', severity: 'warning' }));
    expect(assessGamingClearEvidence({ ...input, prompt: 'Which sapphire wand build should I use?' }, data,
      { now, allowAdvisoryFreshness: true }).decision).not.toBe('accept');
  });

  test('expired but otherwise usable gameplay intervals may be qualified without changing source metadata', () => {
    const input = { game: 'Elden Ring', mode: 'build' as const, prompt: 'Which copper staff build should I use?' };
    const data = knowledge(input.game, ['For the copper staff build, equip the copper staff before the shield.']);
    data.sources[0].freshnessMetadata = { ...freshness(input.game, 0, { effectiveUntil: '2026-09-09T00:00:00Z' }) };
    const before = JSON.stringify(data);
    expect(assessGamingClearEvidence(input, data, { now, allowAdvisoryFreshness: true })).toMatchObject({
      decision: 'accept', gates: { compatibility: 'verified', freshness: 'unknown' } });
    expect(JSON.stringify(data)).toBe(before);
  });

  test.each(['Are the servers down now?', 'What is the latest Elden Ring patch?',
    'Recommend the best mage build on the latest patch', 'Which current copper staff build is best?',
    'What is the current meta?'])('an advisory flag cannot waive requested current-state proof: %s', prompt => {
    const input = { game: 'Elden Ring', mode: 'guide' as const, prompt };
    const data = knowledge(input.game, [`Elden Ring gameplay guide: ${prompt} The synthetic old source discusses servers and patch 1.0.`]);
    expect(assessGamingClearEvidence(input, data, { now, allowAdvisoryFreshness: true }).decision).not.toBe('accept');
  });

  test('advisory freshness never softens contradictory mechanics or known official mechanic changes', () => {
    const input = { game: 'Elden Ring', mode: 'build' as const, prompt: 'Which copper staff build should I use?' };
    const data = knowledge(input.game, ['The copper staff build adds two shield points.', 'The copper staff build adds three shield points.']);
    data.sources.forEach((source, index) => { source.freshnessMetadata = { ...freshness(input.game, index), mechanicValues: { 'staff shield points': String(index + 2) } }; });
    expect(assessGamingClearEvidence(input, data, { now, allowAdvisoryFreshness: true })).toMatchObject({
      decision: 'reject', blockingFindings: expect.arrayContaining([expect.objectContaining({ code: 'CONTRADICTORY_EVIDENCE' })]) });
    const changed = currentSet(input.game, 'For the copper staff build, equip the copper staff before the shield.');
    const evaluated = evaluateGamingFreshness({ game: input.game, mode: input.mode, question: input.prompt, evidence: changed.metadata, now });
    evaluated.usable = false;
    evaluated.status = 'stale';
    evaluated.reasons.push('CURRENT_UPDATE_CHANGES_GUIDE_MECHANIC');
    expect(assessGamingClearEvidence(input, changed.data, { now, freshness: evaluated, allowAdvisoryFreshness: true })).toMatchObject({
      decision: 'reject', blockingFindings: expect.arrayContaining([expect.objectContaining({ code: 'CURRENT_UPDATE_CHANGES_GUIDE_MECHANIC' })]) });
  });
});

// Synthetic passages are invented evaluation data, not real gameplay guidance.
// Calibration and held-out cases are separate and have no model/provider calls.
const corpus = [
  { split: 'calibration', game: staticInput.game, prompt: 'How do I open the copper gate?', text: 'Open the copper gate with the key from the hollow pedestal.', label: true },
  { split: 'calibration', game: 'Elden Ring', prompt: 'Where is the quartz medallion?', text: 'The quartz medallion rests in the eastern synthetic alcove.', label: true },
  { split: 'calibration', game: 'Star Wars: The Old Republic', prompt: 'Where is the silver console?', text: 'Use the silver console in the northern synthetic hangar room.', label: true },
  { split: 'held_out', game: staticInput.game, prompt: 'Where is the violet switch?', text: 'The violet switch is below the synthetic training balcony.', label: true },
  { split: 'held_out', game: 'Elden Ring', prompt: 'Where is the amber lantern?', text: 'Synthetic merchant dialogue discusses distant weather and clothing.', label: false },
  { split: 'held_out', game: 'Star Wars: The Old Republic', prompt: 'Which current copper staff build is best?', text: 'The copper staff build combines a copper staff and synthetic shield.', label: false }
] as const;
describe('labeled Gaming CLEAR evidence calibration', () => {
  test.each(corpus)('$split / $game / accepted=$label', fixture => {
    const assessment = run({ game: fixture.game, mode: 'guide', prompt: fixture.prompt }, knowledge(fixture.game, [fixture.text]));
    expect(assessment.decision === 'accept').toBe(fixture.label);
  });
});

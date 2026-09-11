import { describe, expect, test } from '@jest/globals';
import { assessGamingClearEvidence } from '../src/shared/gaming/gamingClearEvidence.js';
import { evaluateGamingFreshness, GAMING_SOURCE_POLICY_VERSION, type GamingFreshnessEvidence } from '../src/shared/gaming/gamingFreshnessCore.js';
import type { GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';

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
    expect(run(staticInput, wrongEdition).decision).toBe('reject');
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

  test.each([{ platforms: ['Xbox'] }, { regions: ['EU'] }])('explicit static applicability restrictions require the missing player constraint: %j', restriction => {
    const data = knowledge(staticInput.game, ['Open the copper gate with the key from the hollow pedestal.']);
    data.sources[0].freshnessMetadata = { ...freshness(staticInput.game, 0, { patch: undefined, ...restriction }) };
    expect(run(staticInput, data)).toMatchObject({ decision: 'clarify', overall: null,
      gates: { compatibility: 'unknown', freshness: 'not_applicable' }, dimensionScores: { alignment: { score: null } } });
    expect(assessGamingClearEvidence({ ...staticInput, platform: 'Xbox', region: 'EU' }, data, { now }).decision).toBe('accept');
    expect(assessGamingClearEvidence({ ...staticInput, platform: 'PC', region: 'US' }, data, { now }).decision).toBe('reject');
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

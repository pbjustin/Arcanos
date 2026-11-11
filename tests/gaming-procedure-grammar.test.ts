import { describe, expect, it } from '@jest/globals';
import {
  buildGamingRequestRequirements, gamingAttributableClaimText, gamingRequirementSupported
} from '../src/shared/gaming/gamingRetrievalPolicy.js';
import { assessGamingClearEvidence, assessGamingRequestCoverage } from '../src/shared/gaming/gamingClearEvidence.js';
import { selectGamingHybridEvidence } from '../src/services/gamingHybridCandidates.js';
import type { GamingStoredKnowledgeContext, GamingStoredKnowledgeInput } from '../src/shared/gaming/gamingStoredEvidenceCore.js';

// Authored grammar fixtures, not publisher material or live provider evidence.
const request: GamingStoredKnowledgeInput = {
  game: 'Elite Dangerous', mode: 'guide', prompt: 'How do I begin system colonisation?'
};
const requirement = buildGamingRequestRequirements(request)[0];
const positive = [
  { id: 'purpose-comma', text: 'To begin system colonisation, visit the System Colonisation Contact and select a destination.' },
  { id: 'imperative-topic-by', text: 'Start system colonisation by visiting a contact and selecting an unpopulated system.' },
  { id: 'purpose-colon', text: 'To begin system colonisation: visit the System Colonisation Contact.' },
  { id: 'neutral-intro-nested-by', text: 'To start your journey towards the outer colonies, begin by visiting the system colonisation contact.' },
  { id: 'future-player-action', text: 'To begin system colonisation, you will select a destination.' },
  { id: 'modal-ordered-action', text: 'To begin system colonisation, you must first select a destination.' },
  { id: 'restriction-and-affirmative-action', text: 'To begin system colonisation, avoid abandoning an active claim and visit the contact.' }
];
const negative = [
  { id: 'unrelated-declarative', text: 'To begin system colonisation, trade permits are sold at the market.' },
  { id: 'unavailable-declarative', text: 'To begin system colonisation, the process is currently unavailable.' },
  { id: 'unanswered-question', text: 'To begin system colonisation, what do I do?' },
  { id: 'imperative-by-unrelated-fact', text: 'Start system colonisation by learning that trade permits are sold at the market.' },
  { id: 'colon-unrelated-declarative', text: 'To begin system colonisation: trade permits are sold at the market.' },
  { id: 'colon-unavailable-declarative', text: 'To begin system colonisation: the process is currently unavailable.' },
  { id: 'colon-unanswered-question', text: 'To begin system colonisation: what do I do?' },
  { id: 'comma-action-question', text: 'To begin system colonisation, visit the System Colonisation Contact?' },
  { id: 'imperative-action-question', text: 'Start system colonisation by visiting a contact?' },
  { id: 'colon-action-question', text: 'To begin system colonisation: visit the contact?' },
  { id: 'foreign-topic-nested-by', text: 'To start trading, begin by visiting the system colonisation contact.' },
  { id: 'unavailable-then-unrelated-action', text: 'To begin system colonisation, the process is currently unavailable. Open the navigation menu.' },
  { id: 'question-then-unrelated-action', text: 'To begin system colonisation, what do I do? Open the navigation menu.' },
  { id: 'declarative-then-unrelated-action', text: 'To begin system colonisation, trade permits are sold at the market. Open the navigation menu.' },
  { id: 'negative-before-then', text: 'To begin system colonisation, you must not then select a destination.' },
  { id: 'restriction-only', text: 'To begin system colonisation, avoid abandoning an active claim.' },
  { id: 'coordinated-restrictions', text: 'To begin system colonisation, avoid abandoning an active claim and visiting a closed contact.' },
  { id: 'nonaction-before-comma-action', text: 'To begin system colonisation, the process is currently unavailable, open the navigation menu.' },
  { id: 'coordinated-action-question', text: 'To begin system colonisation, visit a contact and select a destination?' },
  { id: 'comma-separated-action-question', text: 'To begin system colonisation, visit a contact, select a destination?' }
];

function knowledge(text: string): GamingStoredKnowledgeContext {
  const fetchedAt = '2026-11-10T12:00:00.000Z';
  const url = 'https://guides.example.org/authored-procedure';
  return { context: '', sources: [{ sourceId: 'authored-guide', game: request.game, url,
    sourceType: 'supplied', origin: 'live', fetchedAt, snippet: '' }], evidence: [{
    sourceId: 'authored-guide', revisionId: 'authored-revision', recordId: 'authored-passage',
    recordType: 'guide', publicUrl: url, text, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt }
  }] };
}

describe('bounded acquired starting-procedure grammar', () => {
  it('constructs a procedure requirement without changing the named topic', () => {
    expect(requirement).toMatchObject({ procedure: 'start', terms: ['system', 'colonisation'] });
  });

  it.each(positive)('accepts an actual action at the predicate boundary: $id', ({ text }) => {
    expect(gamingRequirementSupported(text, requirement)).toBe(true);
  });

  it.each(negative)('rejects missing action support at the predicate boundary: $id', ({ text }) => {
    expect(gamingRequirementSupported(text, requirement)).toBe(false);
  });

  it.each(positive)('carries an attributable action through selection and CLEAR: $id', ({ text }) => {
    expect(gamingAttributableClaimText(text, request.game)).not.toBe('');
    const data = knowledge(text);
    expect(assessGamingRequestCoverage(request, data).coverageSatisfied).toBe(true);
    const selected = selectGamingHybridEvidence(request, data);
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.selectedEvidenceIds).toEqual(['authored-passage']);
    const clear = assessGamingClearEvidence({ ...request, game: request.game! }, selected.knowledge,
      { identityVerified: true, requireRequestCoverage: true });
    expect(clear.gates.claimSupport).toBe('verified');
  });

  it.each(negative)('withholds complete coverage and CLEAR claim support: $id', ({ text }) => {
    const data = knowledge(text);
    expect(assessGamingRequestCoverage(request, data).coverageSatisfied).toBe(false);
    const selected = selectGamingHybridEvidence(request, data);
    expect(selected.coverageSatisfied).toBe(false);
    const clear = assessGamingClearEvidence({ ...request, game: request.game! }, selected.knowledge,
      { identityVerified: true, requireRequestCoverage: true });
    expect(clear.gates.claimSupport).not.toBe('verified');
  });

  it('preserves negative gameplay advice as a restriction without treating it as a start action', () => {
    const advice = 'Do not abandon the system colonisation claim while construction is in progress.';
    expect(gamingAttributableClaimText(advice, request.game)).toContain('Do not abandon');
    expect(gamingRequirementSupported(advice, requirement)).toBe(false);
    const combined = `${positive[0].text} ${advice}`;
    const selected = selectGamingHybridEvidence(request, knowledge(combined));
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.knowledge.evidence?.[0].text).toContain(advice);
  });

  it('keeps a prohibited starting action attributable without promoting it to an affirmative procedure', () => {
    const advice = 'Do not start system colonisation by abandoning your active claim.';
    expect(gamingAttributableClaimText(advice, request.game)).toContain('Do not start');
    expect(gamingRequirementSupported(advice, requirement)).toBe(false);
    expect(assessGamingRequestCoverage(request, knowledge(advice)).coverageSatisfied).toBe(false);
  });

  it('keeps a same-sentence restriction attached to an independently supported starting action', () => {
    const text = 'To begin system colonisation, visit the contact and do not abandon your active claim.';
    expect(gamingRequirementSupported(text, requirement)).toBe(true);
    const selected = selectGamingHybridEvidence(request, knowledge(text));
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.knowledge.evidence?.[0].text).toContain('do not abandon your active claim');
  });

  it('applies the same action grammar to an unfamiliar authored mechanic', () => {
    const unknown = { requirement: 'requested topic', terms: ['prism', 'tuning'], procedure: 'start' as const };
    expect(gamingRequirementSupported('To begin prism tuning, rotate the iris and collect the beacon.', unknown)).toBe(true);
    expect(gamingRequirementSupported('To begin prism tuning, the equipment is currently unavailable.', unknown)).toBe(false);
  });

  it('accepts a topic-bound first action without repeating the request verb', () => {
    const input = { ...request, prompt: 'How do I start fishing?' };
    const text = 'For fishing, first equip a rod and cast into the pond.';
    const fishing = buildGamingRequestRequirements(input)[0];
    expect(gamingRequirementSupported(text, fishing)).toBe(true);
    expect(gamingRequirementSupported('For fishing, equip a better rod after winning the tournament.', fishing)).toBe(false);
    const selected = selectGamingHybridEvidence(input, knowledge(text));
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.selectedEvidenceIds).toEqual(['authored-passage']);
    expect(assessGamingClearEvidence({ ...input, game: request.game! }, selected.knowledge,
      { identityVerified: true, requireRequestCoverage: true }).gates.claimSupport).toBe('verified');
  });
});

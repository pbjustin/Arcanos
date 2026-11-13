import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRuntimeBudgetWithLimit } from '../src/platform/resilience/runtimeBudget.js';
import { logger } from '../src/platform/logging/structuredLogging.js';
import {
  GAMING_CLEAR_DIMENSIONS, createGamingClearAssessment, gamingClearContextFingerprint, gamingClearHash,
  type GamingClearAssessmentInput, type GamingClearDimensions
} from '../src/shared/gaming/gamingClearPolicy.js';

const createSingleChatCompletion = jest.fn();
jest.unstable_mockModule('@services/openai/chatFallbacks.js', () => ({ createSingleChatCompletion }));
jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({
  getClearAuditModel: () => 'gpt-6-luna', getClearAuditEscalationModel: () => 'gpt-6.1-sol'
}));
const { runGamingClearAnswerAudit } = await import('../src/services/gamingClearAnswerAudit.js');

type ClaimSupport = 'SUPPORTED' | 'UNVERIFIED' | 'CONTRADICTED';
type BlockingCategory = 'factual_support' | 'applicability_security' | 'completeness' | 'quality' | 'unclassified';
type Finding = { code: string; severity: 'warning' | 'blocking'; evidenceRefs: string[] };

interface CalibrationCase {
  id: string;
  game: string;
  prompt: string;
  passages: string[];
  answer: string;
  reviewed: { claimSupport: ClaimSupport; rationale: string; deliver: boolean; categories?: BlockingCategory[] };
  fixture: { findingCode?: string; unresolvedFact?: string; clarity?: number; documentedPatch?: string };
}

const frontierUrl = 'https://www.elitedangerous.com/news/system-colonisation-guide';
// This sentence was verified in the retained 5,488-character normalized
// Frontier article with SHA-256 7b650756e8a6f76016102e13a350d0c4b1ef5cdfe3a75f0977e7b8d5d5963367.
// All other passages are synthetic or paraphrases. No current-patch claim is
// made about this historical snapshot.
const beacon = 'After traveling to your selected star system, you will then deploy a System Colonisation Beacon at a pre-determined location.';
const reservation = 'In the February 2025 guide, registering a colonisation attempt reserves the claim for 24 hours.';
const setup = 'Select an unpopulated star system within 15 light-years using the System Colonisation Contact and choose the initial structure.';
const contradictoryQuantity: CalibrationCase = {
  id: 'applicable quantity directly conflicts', game: 'Elite Dangerous',
  prompt: 'How long was the claim reservation according to the February 2025 guide? Cite the guide.',
  passages: [reservation], answer: 'The February 2025 guide states a 12-hour claim reservation. [1]',
  reviewed: { claimSupport: 'CONTRADICTED', rationale: 'The asserted 12 hours conflicts with the exact 24-hour duration.', deliver: false,
    categories: ['factual_support'] },
  fixture: { findingCode: 'CONTRADICTED_CLAIM' }
};
const corpus: CalibrationCase[] = [
  {
    id: 'exact published instruction', game: 'Elite Dangerous', prompt: 'How do I deploy the colonisation beacon? Cite the guide.',
    passages: [beacon], answer: `${beacon} [1]`,
    reviewed: { claimSupport: 'SUPPORTED', rationale: 'The text gives the action and location after travel.', deliver: true },
    fixture: {}
  },
  {
    id: 'correct paraphrase', game: 'Elite Dangerous', prompt: 'How do I deploy the colonisation beacon? Cite the guide.',
    passages: [beacon], answer: 'Travel to the chosen system first, then place the beacon at its assigned location. [1]',
    reviewed: { claimSupport: 'SUPPORTED', rationale: 'The paraphrase preserves destination, location and order.', deliver: true },
    fixture: {}
  },
  {
    id: 'supported instruction scoped to the applicable edition', game: 'The Legend of Zelda: Ocarina of Time',
    prompt: 'Where does Child Link get a Deku Shield in the original release? Cite the guide.',
    passages: ['This original-release walkthrough applies to Child Link. Child Link can buy the Deku Shield at the Kokiri Shop in Kokiri Forest.'],
    answer: 'In the original release, Child Link can buy the Deku Shield at the Kokiri Shop in Kokiri Forest. [1]',
    reviewed: { claimSupport: 'SUPPORTED', rationale: 'The answer keeps the edition and progression conditions.', deliver: true },
    fixture: {}
  },
  {
    id: 'source is silent about asserted prerequisite', game: 'Elite Dangerous',
    prompt: 'What is needed to choose a system for colonisation? Cite the guide.',
    passages: [setup], answer: 'You must also hold a Founders Permit before choosing a system. [1]',
    reviewed: { claimSupport: 'UNVERIFIED', rationale: 'The passage names the contact and destination condition and says nothing about permits.', deliver: false,
      categories: ['factual_support'] },
    fixture: { findingCode: 'INVENTED_PREREQUISITE' }
  },
  {
    id: 'introduction is silent about later action', game: 'Harbor of Bells',
    prompt: 'How do I unlock the harbor after ringing the bell? Cite the guide.',
    passages: ['Harbor of Bells introduces the dockside bell at the beginning of the harbor puzzle.'],
    answer: 'Ring the bell, then insert the silver anchor into the dock gate. [1]',
    reviewed: { claimSupport: 'UNVERIFIED', rationale: 'The introduction names the bell and offers no subsequent instruction.', deliver: false,
      categories: ['factual_support', 'completeness'] },
    fixture: { findingCode: 'UNSUPPORTED_MECHANIC', unresolvedFact: 'LATER_ACTION_UNKNOWN' }
  },
  contradictoryQuantity,
  {
    id: 'mandatory order directly conflicts', game: 'Elite Dangerous',
    prompt: 'Which comes first, travel or beacon deployment? Cite the guide.',
    passages: [beacon], answer: 'Deploy the beacon at its assigned location before traveling to the chosen system. [1]',
    reviewed: { claimSupport: 'CONTRADICTED', rationale: 'The passage explicitly requires travel before beacon deployment.', deliver: false,
      categories: ['factual_support'] },
    fixture: { findingCode: 'CONTRADICTED_CLAIM' }
  },
  {
    id: 'historical guide is silent about currentness', game: 'Elden Ring',
    prompt: 'Which weapon did the Samurai start with? Cite the guide.',
    passages: ['This historical walkthrough covers a release where the Samurai starts with an Uchigatana. It gives no later release information.'],
    answer: 'This is verified on the current patch: the Samurai starts with an Uchigatana. [1]',
    reviewed: { claimSupport: 'UNVERIFIED', rationale: 'The evidence supports the historical setup only. Current applicability is unknown.', deliver: false,
      categories: ['factual_support'] },
    fixture: { findingCode: 'UNSUPPORTED_CURRENTNESS_CLAIM' }
  },
  {
    id: 'awkward but supported answer withheld for clarity', game: 'Xenoblade Chronicles 2',
    prompt: 'Which action begins a Blade Combo? Cite the guide.',
    passages: ['Use a Blade Special to start a Blade Combo.'],
    answer: 'Blade Special. That is what you use. Start a Blade Combo with it. [1]',
    reviewed: { claimSupport: 'SUPPORTED', rationale: 'The supported instruction fully answers the request despite awkward phrasing.', deliver: false,
      categories: ['quality'] },
    fixture: { clarity: 3.25 }
  },
  {
    id: 'fluent but unverified invention', game: 'Harbor of Bells',
    prompt: 'How do I open the harbor gate? Cite the guide.',
    passages: ['Ring the dockside bell twice to open the harbor gate.'],
    answer: 'Ring the dockside bell twice. The gate will only open if you equip the Star Diver charm. [1]',
    reviewed: { claimSupport: 'UNVERIFIED', rationale: 'The second assertion names a charm absent from the passage.', deliver: false,
      categories: ['factual_support'] },
    fixture: { findingCode: 'UNSUPPORTED_CLAIM' }
  },
  {
    id: 'supported words with a citation to the wrong passage', game: 'Harbor of Bells',
    prompt: 'How do I open the harbor gate? Cite the guide.',
    passages: ['Ring the dockside bell twice to open the harbor gate.', 'The dockside bell is beside the waterwheel.'],
    answer: 'Ring the dockside bell twice to open the harbor gate. [2]',
    reviewed: { claimSupport: 'UNVERIFIED', rationale: 'The actual citation establishes the bell location alone.', deliver: false,
      categories: ['factual_support'] },
    fixture: { findingCode: 'CITATION_DOES_NOT_SUPPORT_CLAIM' }
  },
  {
    id: 'honest historical caveat retains complete supported guidance', game: 'Elite Dangerous',
    prompt: 'How long was the claim reservation according to the February 2025 guide? Cite the guide.',
    passages: [reservation],
    answer: 'The February 2025 guide describes a 24-hour reservation. The guide does not establish whether that duration still applies. [1]',
    reviewed: { claimSupport: 'SUPPORTED', rationale: 'The scope is accurate and the requested historical duration is complete.', deliver: true },
    fixture: {}
  },
  {
    id: 'supported partial answer omits a mandatory prerequisite', game: 'Harbor of Bells',
    prompt: 'What prerequisite and action open the harbor gate? Cite the guide.',
    passages: ['Restore power to the bell first. Then ring it twice to open the harbor gate.'],
    answer: 'Ring the bell twice to open the harbor gate. [1]',
    reviewed: { claimSupport: 'SUPPORTED', rationale: 'The stated action is supported. The requested prerequisite is omitted.', deliver: false,
      categories: ['completeness'] },
    fixture: { findingCode: 'MISSING_PREREQUISITE' }
  },
  {
    id: 'a different documented patch leaves claimed applicability unverified', game: 'Harbor of Bells',
    prompt: 'How do I open the harbor gate? Cite the guide.',
    passages: ['The patch 1.0 walkthrough says to ring the dockside bell twice to open the harbor gate.'],
    answer: 'On patch 2.0, ring the dockside bell twice to open the harbor gate. [1]',
    reviewed: { claimSupport: 'UNVERIFIED', rationale: 'Patch 1.0 evidence says nothing affirmative about patch 2.0.', deliver: false,
      categories: ['factual_support'] },
    fixture: { documentedPatch: '1.0' }
  }
];

function buildFixture(row: CalibrationCase, override?: { contradictionRefs: string[] }) {
  const sources = row.passages.map((passage, index) => ({
    sourceId: `source-${index + 1}`,
    url: row.game === 'Elite Dangerous' ? frontierUrl : `https://fixture.example/guide-${index + 1}`,
    sourceType: 'guide', game: row.game, fetchedAt: '2026-11-09T12:00:00.000Z', snippet: passage,
    ...(row.fixture.documentedPatch ? { verifiedPatchVersion: row.fixture.documentedPatch } : {})
  }));
  const evidence = row.passages.map((passage, index) => ({
    sourceId: sources[index].sourceId, revisionId: `revision-${index + 1}`, recordId: `chunk-${index + 1}`,
    publicUrl: sources[index].url, recordType: 'guide' as const, text: passage, lexicalScore: 1, combinedScore: 1,
    provenance: { fetchedAt: sources[index].fetchedAt }
  }));
  const evidenceRefs = evidence.flatMap(item => [item.sourceId, item.revisionId, item.recordId]);
  const dimensions = Object.fromEntries(GAMING_CLEAR_DIMENSIONS.map(name => [name, {
    status: 'evaluated', score: 4.5, reasonCodes: [], evidenceRefs, unresolvedFacts: []
  }])) as GamingClearDimensions;
  const gates: GamingClearAssessmentInput['gates'] = {
    security: 'verified', identity: 'verified', compatibility: 'verified', freshness: 'not_applicable',
    provenance: 'verified', claimSupport: 'verified'
  };
  const evidenceAssessment = createGamingClearAssessment({
    profile: 'evidence', questionProfile: 'walkthrough', subjectId: 'fixture-evidence',
    subjectHash: gamingClearHash(evidence), contextFingerprint: gamingClearContextFingerprint(evidence),
    evidenceRefs, gates, dimensions
  });
  const assessedDimensions = structuredClone(dimensions);
  if (row.fixture.clarity !== undefined) assessedDimensions.clarity.score = row.fixture.clarity;
  if (row.fixture.unresolvedFact) assessedDimensions.leverage.unresolvedFacts = [row.fixture.unresolvedFact];
  const findings: Finding[] = row.fixture.findingCode ? [{
    code: row.fixture.findingCode, severity: 'warning',
    evidenceRefs: override?.contradictionRefs ?? [evidence.at(-1)!.recordId]
  }] : [];
  return {
    input: { game: row.game, prompt: row.prompt, mode: 'guide' as const, answer: row.answer,
      evidenceAssessment, knowledge: { context: row.passages.join('\n'), sources, evidence } },
    completion: { choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ dimensions: assessedDimensions, findings })
    } }] }
  };
}

describe('Gaming evidence-first offline calibration corpus', () => {
  beforeEach(() => {
    createSingleChatCompletion.mockReset();
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(corpus)('$id', async row => {
    const { input, completion } = buildFixture(row);
    createSingleChatCompletion.mockResolvedValueOnce(completion);
    const result = await runGamingClearAnswerAudit({} as never, input, createRuntimeBudgetWithLimit(20_000, 0));
    const { assessment } = result;
    expect(assessment.assessmentStatus).toBe('completed');
    expect(assessment.decision).toBe(row.reviewed.deliver ? 'accept' : 'reject');
    expect(assessment.subjectHash).toBe(gamingClearHash(row.answer));
    if (row.fixture.documentedPatch) {
      expect(assessment.gates.compatibility).toBe('verified');
      expect(assessment.blockingFindings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'UNSUPPORTED_CURRENTNESS_CLAIM' })
      ]));
      expect(createSingleChatCompletion).not.toHaveBeenCalled();
    } else {
      expect(createSingleChatCompletion).toHaveBeenCalledTimes(1);
      const parameters = createSingleChatCompletion.mock.calls[0][1] as { messages: Array<{ content: string }> };
      const payload = JSON.parse(parameters.messages[1].content);
      expect(payload).toMatchObject({ answer: row.answer,
        evidence: row.passages.map((text, index) => ({ text, sourceIndex: index + 1, chunkId: `chunk-${index + 1}` })) });
    }
    expect(result).toMatchObject({ factualSupport: row.reviewed.claimSupport });
    expect([...result.blockingCategories].sort()).toEqual([...(row.reviewed.categories ?? [])].sort());
    if (row.fixture.clarity !== undefined) {
      expect(assessment.overall).toBeGreaterThanOrEqual(4);
      expect(assessment.blockingFindings.map(finding => finding.code)).toEqual(['PROFILE_FLOOR_NOT_MET']);
    }
  });

  it.each([
    { label: 'no evidence', refs: [] },
    { label: 'source ID only', refs: ['source-1'] },
    { label: 'revision ID only', refs: ['revision-1'] }
  ])('keeps a contradiction finding with $label blocking and unverified', async ({ refs }) => {
    const { input, completion } = buildFixture(contradictoryQuantity, { contradictionRefs: refs });
    createSingleChatCompletion.mockResolvedValueOnce(completion);
    const result = await runGamingClearAnswerAudit({} as never, input, createRuntimeBudgetWithLimit(20_000, 0));
    expect(result).toMatchObject({ factualSupport: 'UNVERIFIED', assessment: { assessmentStatus: 'completed', decision: 'reject' } });
    expect(result.assessment.blockingFindings.some(finding => finding.code === 'CONTRADICTED_CLAIM')).toBe(false);
    expect(createSingleChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('rejects the entire assessment if the contradiction invents a selected chunk ID', async () => {
    const { input, completion } = buildFixture(contradictoryQuantity, { contradictionRefs: ['unknown-chunk'] });
    createSingleChatCompletion.mockResolvedValueOnce(completion);
    const result = await runGamingClearAnswerAudit({} as never, input, createRuntimeBudgetWithLimit(20_000, 0));
    expect(result).toMatchObject({ factualSupport: 'UNVERIFIED',
      assessment: { assessmentStatus: 'unavailable', decision: 'unavailable' },
      providerDiagnostic: { resultClass: 'invalid_schema' } });
  });

  it('cannot derive a contradiction from a dimension reason code', async () => {
    const { input, completion } = buildFixture(corpus[0]);
    const parsed = JSON.parse(completion.choices[0].message.content);
    parsed.dimensions.alignment.reasonCodes = ['CONTRADICTED_CLAIM'];
    parsed.dimensions.alignment.unresolvedFacts = ['REQUIRED_DETAIL_UNKNOWN'];
    completion.choices[0].message.content = JSON.stringify(parsed);
    createSingleChatCompletion.mockResolvedValueOnce(completion);
    const result = await runGamingClearAnswerAudit({} as never, input, createRuntimeBudgetWithLimit(20_000, 0));
    expect(result).toMatchObject({ factualSupport: 'UNVERIFIED', assessment: { decision: 'reject' }, blockingCategories: ['completeness'] });
  });

  it('cannot infer factual support from an incomplete otherwise positive response', async () => {
    const { input, completion } = buildFixture(corpus[0]);
    completion.choices[0].finish_reason = 'length';
    createSingleChatCompletion.mockResolvedValueOnce(completion);
    const result = await runGamingClearAnswerAudit({} as never, input, createRuntimeBudgetWithLimit(20_000, 0));
    expect(result).toMatchObject({ factualSupport: 'UNVERIFIED',
      assessment: { assessmentStatus: 'unavailable', decision: 'unavailable' } });
  });
});

import { resolveGamingPlayerContext, type GamingPlayerContext } from './gamingPlayerContext.js';
import { assessGamingProgressionRequest } from './gamingProgressionPolicy.js';
import { buildGamingRetrievalTerms } from './gamingRetrievalPolicy.js';
import { buildStoredGamingLexicalQuery, selectStoredGamingEvidence, formatStoredGamingEvidence, type GamingStoredEvidenceRecord, type GamingStoredKnowledgeInput } from './gamingStoredEvidenceCore.js';
import { normalizeGamingGameIdentity, resolveGamingGuideIdentity } from './gamingGameIdentity.js';
import { buildGamingRecoveryResponse, resolveGamingRecoveryClass, type GamingRecoveryInput } from './gamingRecoveryResponse.js';

export const GAMING_PROGRESS_RECOVERY_PREVIEW_VERSION = 'gaming-progress-recovery/v1';
const FAILURE = 'PREVIEW_GAMING_PROGRESS_RECOVERY_CONTRACT_INVALID';
const GAME = 'Lantern Voyage';
const LIMITS = { chunkChars: 900, maxChunks: 3, maxSources: 3, maxContextChars: 2_400, structuredEvidenceChars: 8_000 };
const GENERIC_AREA = 'Copper Quay has a quiet market beside the pier.';
const BOSS = 'The Glass Warden pauses after its sweeping strike. Dodge behind the raised arm and wait for the blade to land.';
const ITEM = 'The Zephyrglass Compass is inside the cobalt cabinet beside the workshop door.';
const EARLY = 'After the canal pump is repaired at Copper Quay, turn the blue valve beside the lift. Cross when the bridge locks in place.';
const LATER = 'Once the lens is aligned at Glass Observatory, pull the brass lever beside the open hatch.';

function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function input(prompt: string, context: GamingPlayerContext = {}): GamingStoredKnowledgeInput {
  return { game: GAME, prompt, mode: 'guide', ...resolveGamingPlayerContext({ game: GAME, ...context }, prompt) };
}

function record(recordId: string, text: string, relevance = 1): GamingStoredEvidenceRecord {
  return {
    recordId, recordType: 'guide', title: 'Synthetic player guide', searchText: text, normalized: { text },
    sourceId: `synthetic-${recordId}`, revisionId: `synthetic-${recordId}-revision`,
    publicUrl: `https://guides.example/synthetic-${recordId}`, sourceType: 'supplied',
    fetchedAt: new Date('2026-09-08T00:00:00.000Z'), publishedAt: null,
    provenance: { resolverId: 'synthetic-guide', resolverVersion: 'synthetic-v1' }, relevance
  };
}

function requireRecoveryText(response: string): void {
  requireProof(response.length > 0 && response.length <= 600 && response === response.trim());
  requireProof(!/Backend-supported|Fallback status|Why It Works|CLEAR|Trinity|provider|upgrade|repair|stock|^\d+\./imu.test(response));
}

function requireClarification(request: GamingStoredKnowledgeInput): void {
  const progression = assessGamingProgressionRequest(request);
  requireProof(progression.progressionDependent && progression.clarificationNeeded && !progression.hasProgressAnchor && !progression.hasRequestAnchor);
  requireProof(buildGamingRetrievalTerms(request).focusTerms.length === 0);
  requireProof(buildStoredGamingLexicalQuery(request.prompt, request.game, request).query === '');
  requireProof(selectStoredGamingEvidence([record('generic-area', GENERIC_AREA, 100)], request, LIMITS).length === 0);
  for (const sourceKnown of [false, true]) {
    const recovery = { ...request, sourceKnown, evidenceSelected: false, timedOut: true };
    requireProof(resolveGamingRecoveryClass(recovery) === 'clarification_required');
    const response = buildGamingRecoveryResponse(recovery);
    requireRecoveryText(response);
    requireProof(response.includes(GAME) && response.match(/\?/gu)?.length === 1 && !response.includes('timed out'));
    requireProof(response.includes('I have a guide available') === sourceKnown);
  }
}

function requireMissingProgress(): void {
  for (const prompt of [
    'What next?', 'Where do I go?', 'I would like help. What next?', 'I could use some help. What next?',
    'Could you please explain what I should do next?', 'I have not found where to go. What next?',
    'I am not sure what next.', "I haven't defeated the Glass Warden. What next?",
    'If I defeated the Glass Warden, what next?', 'Hypothetically, I am in Copper Quay. Where do I go?',
    'Actually, I have not defeated the Glass Warden. What next?', 'Well, I am not in Copper Quay. What next?',
    'Since I have not defeated the Glass Warden, what next?', 'I have never been to Copper Quay. What next?'
  ]) {
    const request = input(prompt, { platform: 'PC', difficulty: 'Hard', answerDepth: 'concise', spoilerTolerance: 'none' });
    requireProof(request.currentArea === undefined && request.lastCompletedObjective === undefined);
    requireClarification(request);
  }
  const conflicting = input('I am at Glass Observatory. What next?', { currentArea: 'Copper Quay' });
  // The conflicting words remain in the original question, but neither claim can authorize a next step.
  requireProof(conflicting.contextConflicts?.includes('currentArea'));
  requireProof(assessGamingProgressionRequest(conflicting).clarificationNeeded);
  const conflictRecovery = { ...conflicting, sourceKnown: true, evidenceSelected: false };
  requireProof(resolveGamingRecoveryClass(conflictRecovery) === 'clarification_required');
  const conflictText = buildGamingRecoveryResponse(conflictRecovery);
  requireRecoveryText(conflictText);
  requireProof(conflictText.match(/\?/gu)?.length === 1 && conflictText.includes('What was the last objective you completed?'));
  requireClarification({ ...input('What next?'), currentArea: 'Copper Quay', contextOrigins: { currentArea: 'tentative' } });
}

function requireNamedTargets(): void {
  const cases = [
    { prompt: 'How do I beat the Glass Warden?', terms: ['glass', 'warden'], text: BOSS },
    { prompt: 'I would like help defeating the Glass Warden.', terms: ['glass', 'warden'], text: BOSS },
    { prompt: 'Could you tell me what I should do next after defeating the Glass Warden?', terms: ['glass', 'warden'], text: BOSS },
    { prompt: 'I have not found the Zephyrglass Compass.', terms: ['zephyrglass', 'compass'], text: ITEM },
    { prompt: 'Where do I go to find the Zephyrglass Compass if I missed it?', terms: ['zephyrglass', 'compass'], text: ITEM },
    { prompt: "I haven't defeated the Glass Warden, where is the Zephyrglass Compass?", terms: ['zephyrglass', 'compass'], text: ITEM }
  ];
  for (const fixture of cases) {
    const request = input(fixture.prompt, { currentArea: 'Copper Quay' });
    const progression = assessGamingProgressionRequest(request);
    requireProof(!progression.clarificationNeeded && progression.hasRequestAnchor && request.lastCompletedObjective === undefined);
    const terms = buildGamingRetrievalTerms(request);
    requireProof(fixture.terms.every(term => terms.requestTerms.includes(term) && terms.focusTerms.includes(term)));
    requireProof(!terms.focusTerms.includes('copper') && !terms.focusTerms.includes('quay'));
    const selected = selectStoredGamingEvidence([record('generic-area', GENERIC_AREA, 100), record('named-target', fixture.text)], request, LIMITS);
    requireProof(selected.length === 1 && selected[0].evidence.recordId === 'named-target');
    const formatted = formatStoredGamingEvidence(selected, request, LIMITS);
    requireProof(formatted.evidence?.length === 1 && formatted.sources.length === 1);
    requireProof(formatted.context.includes(fixture.text) && !formatted.context.includes(GENERIC_AREA) && formatted.context.length <= LIMITS.maxContextChars);
    requireProof(formatted.context.includes('[Source 1]') && formatted.evidence[0].sourceId === 'synthetic-named-target');
  }
}

function requireAnchoredProgress(): void {
  const candidates = [record('early-checkpoint', EARLY), record('later-checkpoint', LATER), record('generic-area', GENERIC_AREA, 100)];
  for (const fixture of [
    { currentArea: 'Copper Quay', lastCompletedObjective: 'Repaired the canal pump', id: 'early-checkpoint', text: EARLY },
    { currentArea: 'Glass Observatory', lastCompletedObjective: 'Aligned the lens', id: 'later-checkpoint', text: LATER }
  ]) {
    const request = input('What next?', fixture);
    const progression = assessGamingProgressionRequest(request);
    requireProof(!progression.clarificationNeeded && progression.hasProgressAnchor && !progression.hasRequestAnchor);
    const terms = buildGamingRetrievalTerms(request);
    requireProof(terms.requestTerms.length === 0 && terms.contextTerms.length > 0 && terms.focusTerms.join('|') === terms.contextTerms.join('|'));
    const selected = selectStoredGamingEvidence(candidates, { ...request, limit: 1 }, LIMITS);
    requireProof(selected.length === 1 && selected[0].evidence.recordId === fixture.id);
    const formatted = formatStoredGamingEvidence(selected, request, LIMITS);
    requireProof(formatted.sources.length === 1 && formatted.context.includes(fixture.text));
  }
}

function requirePreciseIdentities(): void {
  requireProof(normalizeGamingGameIdentity('Lantern™ Voyage®: Remastered – 1.5') === normalizeGamingGameIdentity('Lantern Voyage Remastered 1.5'));
  for (const [left, right] of [
    ['Lantern Voyage', 'Lantern Voyage II'], ['Lantern Voyage', 'Lantern Voyage Remake'],
    ['Lantern Voyage', 'Lantern Voyage HD 1.5 Remix'], ['Lantern Voyage 1.5', 'Lantern Voyage 15'],
    ['Lantern Voyage PC Edition', 'Lantern Voyage Console Edition'], ['Lantern Voyage+', 'Lantern Voyage']
  ]) requireProof(normalizeGamingGameIdentity(left) !== normalizeGamingGameIdentity(right));
  requireProof(resolveGamingGuideIdentity(GAME, 'Remake') === 'lantern-voyage-remake');
  requireProof(resolveGamingGuideIdentity('Lantern Voyage: Remake', 'Remake') === 'lantern-voyage-remake');
  requireProof(resolveGamingGuideIdentity(GAME, 'Remake') !== resolveGamingGuideIdentity(GAME));
}

function requireRecoveryClasses(): void {
  const request = input('How do I beat the Glass Warden?');
  for (const fixture of [
    { evidenceSelected: true, timedOut: true, expected: 'provider_timeout_with_evidence', found: true, timeout: true },
    { evidenceSelected: false, timedOut: true, expected: 'provider_timeout_without_evidence', found: false, timeout: true },
    { evidenceSelected: true, timedOut: false, expected: 'generation_unavailable', found: true, timeout: false },
    { evidenceSelected: false, timedOut: false, expected: 'source_unavailable', found: false, timeout: false }
  ]) {
    const recovery: GamingRecoveryInput = { ...request, sourceKnown: true, evidenceSelected: fixture.evidenceSelected, timedOut: fixture.timedOut };
    requireProof(resolveGamingRecoveryClass(recovery) === fixture.expected);
    const response = buildGamingRecoveryResponse(recovery);
    requireRecoveryText(response);
    requireProof(response.includes('I found') === fixture.found && response.includes('timed out') === fixture.timeout);
    requireProof(!response.includes('I have a guide available') && !response.includes(BOSS));
    if (fixture.expected === 'source_unavailable') requireProof(response.includes("couldn't locate enough guide information"));
  }
  const safe = buildGamingRecoveryResponse({ ...input('What next?'), game: '[secret](https://private.example)', evidenceSelected: false });
  requireProof(safe.includes('this game') && !safe.includes('private.example'));
}

/** Fixed pure-component proof; no provider, SQL, normal service, request cache, or elapsed-time execution. */
export function runGamingProgressRecoveryPreview(): void {
  try {
    requireMissingProgress();
    requireNamedTargets();
    requireAnchoredProgress();
    requirePreciseIdentities();
    requireRecoveryClasses();
  } catch {
    throw new Error(FAILURE);
  }
}

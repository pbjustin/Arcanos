import { createHash } from 'node:crypto';
import type { GamingKnowledgeProvenanceRecord, PersistGamingSourceRevisionInput } from '../../src/core/db/repositories/gamingSourceRepository.js';
import { createGamingClearAssessment, GAMING_CLEAR_POLICY_VERSION } from '../../src/shared/gaming/gamingClearPolicy.js';
import { GAMING_FRESHNESS_POLICY_VERSION, GAMING_SOURCE_POLICY_VERSION } from '../../src/shared/gaming/gamingFreshnessCore.js';
import { normalizeGamingGameIdentity } from '../../src/shared/gaming/gamingGameIdentity.js';
import type { GamingStoredKnowledgeInput } from '../../src/shared/gaming/gamingStoredEvidenceCore.js';

export const HELDOUT_GAMING_LEXICAL_VERSION = 'gaming-heldout-lexical/v1';
export const HELDOUT_GAMING_HEAD = 'c6c05d799d276c35ca2f76588f209b45ba7c0fb1';
export const HELDOUT_GAMING_NOW = '2026-11-09T12:00:00.000Z';
export const HELDOUT_GAMING_GAME = 'Signal Loom: Ember Reach';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export interface HeldoutGamingPassage {
  id: string; text: string; game?: string; edition?: string; platform?: string; patch?: string;
  restriction?: 'unverified' | 'reference_only' | 'revoked' | 'missing_grant' | 'malformed_provenance';
}

// Held out from the original 15 questions. Authored synthetic evidence and labels
// exercise implementation behavior; they are not publisher captures or gameplay truth.
export const heldoutGamingPassages: HeldoutGamingPassage[] = [
  { id: 'equip-burden', game: 'Dark Souls III', text: 'Equip load determines the roll category. Remove heavy equipment to reduce equip load and improve the roll category.' },
  { id: 'soul-focus', game: 'Hollow Knight', text: 'Focus consumes SOUL to restore health. Hold Focus while standing safely to convert stored SOUL into health.' },
  { id: 'anchor', text: 'Open the resonant anchor by rotating the silver ring. The silver ring is located beneath the resonance arch.' },
  { id: 'recharge', text: 'Recharge the crystal battery at the eastern charging station. The charging station restores battery energy while the player waits.' },
  { id: 'frost', text: 'Frost tolerance reduces chill buildup. Equip the thermal cloak to increase frost tolerance before entering the frozen channel.' },
  { id: 'heat', text: 'Reactor heat decreases while the cooling valve is open. Open the cooling valve to lower reactor heat before restarting the engine.' },
  { id: 'sword', text: 'The Sword of Ash and Mist is found under the basalt arch. Defeat the sentinel to unlock the chest containing the Sword of Ash and Mist.' },
  { id: 'safe-key', text: 'The Glass Key opens the bronze hatch. Find the Glass Key beside the southern lift.\n\nIn the ending, the caretaker destroys the observatory and abandons the expedition.' },
  { id: 'foreign-game', game: 'Signal Loom II: Ember Reach', text: 'Open the resonant anchor by rotating the silver ring.' },
  { id: 'foreign-edition', edition: 'Remastered', text: 'Open the resonant anchor by rotating the silver ring.' },
  { id: 'foreign-platform', platform: 'PS5', text: 'Open the resonant anchor by rotating the silver ring.' },
  { id: 'old-patch', patch: '1.6', text: 'Open the resonant anchor by rotating the silver ring.' },
  { id: 'unverified', restriction: 'unverified', text: 'Open the resonant anchor by rotating the silver ring.' },
  { id: 'reference', restriction: 'reference_only', text: 'Open the resonant anchor by rotating the silver ring.' },
  { id: 'revoked', restriction: 'revoked', text: 'Open the resonant anchor by rotating the silver ring.' },
  { id: 'missing-grant', restriction: 'missing_grant', text: 'Open the resonant anchor by rotating the silver ring.' },
  { id: 'bad-binding', restriction: 'malformed_provenance', text: 'Open the resonant anchor by rotating the silver ring.' }
];

export interface HeldoutGamingQuestion {
  id: string; kind: 'exact' | 'paraphrase' | 'complementary' | 'restriction';
  input: GamingStoredKnowledgeInput; pool: string[]; relevant: string[]; rationale: string;
}
const request = (prompt: string, game = HELDOUT_GAMING_GAME): GamingStoredKnowledgeInput => ({ game, prompt,
  mode: 'guide', edition: 'base-game', platform: 'PC', spoilerMode: 'none', requireRequestCoverage: true, limit: 3 });
const main = ['anchor', 'recharge', 'frost', 'heat', 'sword', 'safe-key'];
export const heldoutGamingQuestions: HeldoutGamingQuestion[] = [
  { id: 'heldout-equip-load', kind: 'exact', input: request('Explain equip load.', 'Dark Souls III'), pool: ['equip-burden'], relevant: ['equip-burden'], rationale: 'The specific named load mechanic is explained by one directly attributable passage.' },
  { id: 'heldout-focus', kind: 'exact', input: request('How does Focus restore health?', 'Hollow Knight'), pool: ['soul-focus'], relevant: ['soul-focus'], rationale: 'The named action binds the resource and healing effect rather than matching a generic guide label.' },
  { id: 'heldout-anchor', kind: 'exact', input: request('How do I open the resonant anchor?'), pool: main, relevant: ['anchor'], rationale: 'The unfamiliar title has an explicit mechanical opening procedure with a named actuator.' },
  { id: 'heldout-recharge', kind: 'exact', input: request('How do I recharge the crystal battery?'), pool: main, relevant: ['recharge'], rationale: 'The passage directly answers the named battery procedure and its charging location.' },
  { id: 'heldout-frost', kind: 'exact', input: request('Explain frost tolerance.'), pool: main, relevant: ['frost'], rationale: 'The passage states the named resistance effect and equipment recommendation.' },
  { id: 'heldout-sword', kind: 'exact', input: request('Where is the Sword of Ash and Mist?'), pool: main, relevant: ['sword'], rationale: 'The coordinated item name is one target with an independently stated location and prerequisite.' },
  { id: 'heldout-spoiler-scope', kind: 'exact', input: request('Where is the Glass Key? Avoid spoilers.'), pool: ['safe-key'], relevant: ['safe-key'], rationale: 'Only the requested item paragraph supports the answer; unrelated ending prose must remain excluded.' },
  { id: 'heldout-two-procedures', kind: 'complementary', input: request('How do I open the resonant anchor? Also explain how to recharge the crystal battery.'), pool: main, relevant: ['anchor', 'recharge'], rationale: 'Two independent player actions need complementary source passages, not duplicated mentions.' },
  { id: 'heldout-two-mechanics', kind: 'complementary', input: request('Explain frost tolerance and reactor heat.'), pool: main, relevant: ['frost', 'heat'], rationale: 'Two unrelated systems need both independently supported mechanics to satisfy full request coverage.' },
  { id: 'heldout-anchor-paraphrase', kind: 'paraphrase', input: request('How can I release the harmonic mooring?'), pool: main, relevant: ['anchor'], rationale: 'The label describes the same authored anchor operation using entirely different nouns and a different verb.' },
  { id: 'heldout-recharge-paraphrase', kind: 'paraphrase', input: request('Where can I replenish the power reserve?'), pool: main, relevant: ['recharge'], rationale: 'Replenishing the power reserve asks for the battery charging facility through alternative terminology.' },
  { id: 'heldout-frost-paraphrase', kind: 'paraphrase', input: request('How can I resist hypothermia?'), pool: main, relevant: ['frost'], rationale: 'The cold-resistance question targets frost tolerance without using its exact source words.' },
  { id: 'heldout-heat-paraphrase', kind: 'paraphrase', input: request('How can I cool the overheating reactor?'), pool: main, relevant: ['heat'], rationale: 'The cooling question shares its system noun but changes the action and temperature terminology.' },
  ...['foreign-game', 'foreign-edition', 'foreign-platform', 'old-patch', 'unverified', 'reference', 'revoked', 'missing-grant', 'bad-binding'].map(id => ({
    id: `heldout-${id}`, kind: 'restriction' as const,
    input: { ...request('How do I open the resonant anchor?'), ...(id === 'old-patch' ? { requestedVersion: '1.7' } : {}) },
    pool: [id], relevant: [], rationale: `The ${id} passage is attractive lexically, but its explicit scope, currentness or authority cannot permit generation.`
  }))
];

export function heldoutGamingRecord(passage: HeldoutGamingPassage): GamingKnowledgeProvenanceRecord {
  const game = passage.game ?? HELDOUT_GAMING_GAME;
  const edition = passage.edition ?? 'base-game';
  const catalogGame = `${game} ${edition}`;
  const text = `In the game ${game}, ${passage.text}`;
  const publicUrl = `https://heldout.example.org/gaming/${passage.id}`;
  const contentHash = digest(text);
  const refs = [`heldout-${passage.id}`];
  const dimension = { status: 'evaluated' as const, score: 4.5, reasonCodes: ['SYNTHETIC_HELDOUT_SOURCE'], evidenceRefs: refs, unresolvedFacts: [] };
  const assessment = createGamingClearAssessment({ profile: 'source', questionProfile: 'walkthrough', sourceRole: 'gameplay_guide',
    subjectId: refs[0], subjectHash: contentHash, contextFingerprint: digest(`${game}:${edition}`), evidenceRefs: refs,
    gates: { identity: 'verified', compatibility: 'verified', claimSupport: 'verified', freshness: 'not_applicable', provenance: 'verified', security: 'verified' },
    dimensions: { clarity: dimension, leverage: dimension, efficiency: dimension, alignment: dimension, resilience: dimension } });
  const classification = passage.restriction === 'unverified' ? 'stored_unverified'
    : passage.restriction === 'reference_only' ? 'reference_only' : 'verified';
  const provenance: Record<string, unknown> = { sourceIdentityPolicyVersion: GAMING_CLEAR_POLICY_VERSION,
    classification, generationEligible: classification === 'verified', gamingClear: assessment, approvedContentHash: contentHash,
    edition, acquiredApplicability: { extractorVersion: GAMING_FRESHNESS_POLICY_VERSION,
      contentHash: passage.restriction === 'malformed_provenance' ? '0'.repeat(64) : contentHash, game, edition,
      platforms: [passage.platform ?? 'PC'] },
    hybridFreshness: { id: refs[0], url: publicUrl, policyVersion: GAMING_SOURCE_POLICY_VERSION, game, edition,
      platforms: [passage.platform ?? 'PC'], ...(passage.patch ? { patch: passage.patch } : {}) } };
  return { recordId: passage.id, recordType: 'guide', semanticKey: passage.id, payloadHash: contentHash,
    title: `${game} guide`, patch: passage.patch ?? null, searchText: text, normalized: { text }, recordCreatedAt: new Date(HELDOUT_GAMING_NOW),
    sourceId: refs[0], gameKey: normalizeGamingGameIdentity(catalogGame), gameName: catalogGame, canonicalUrl: publicUrl,
    canonicalUrlHash: digest(publicUrl), publicUrl, host: 'heldout.example.org', sourceType: 'supplied', trustScore: 0.5,
    revisionId: `revision-${passage.id}`, contentHash, fetchedAt: new Date(HELDOUT_GAMING_NOW), publishedAt: null,
    revisionPatch: passage.patch ?? null, extractor: 'heldout-synthetic', extractorVersion: '1', normalizerSchemaVersion: '1',
    provenance, extractionMetrics: { coverageStatus: 'complete' }, relevance: 1,
    ...(['revoked', 'missing_grant'].includes(passage.restriction ?? '') ? { authorityReassessmentRequired: true } : {}) };
}

export function heldoutGamingPersistence(passage: HeldoutGamingPassage): PersistGamingSourceRevisionInput {
  const record = heldoutGamingRecord(passage);
  const eligible = !['unverified', 'reference_only', 'missing_grant'].includes(passage.restriction ?? '');
  return { gameKey: record.gameKey, gameName: record.gameName, canonicalUrl: record.canonicalUrl, publicUrl: record.publicUrl,
    sourceType: 'supplied', trustScore: 0.5, contentHash: record.contentHash, cleanedContent: record.searchText,
    fetchedAt: HELDOUT_GAMING_NOW, ...(passage.patch ? { patch: passage.patch } : {}), extractor: record.extractor,
    extractorVersion: record.extractorVersion, normalizerSchemaVersion: record.normalizerSchemaVersion,
    provenance: record.provenance, extractionMetrics: record.extractionMetrics,
    ...(eligible ? { authorityAuthorization: { revisionContentHash: record.contentHash, approvedDocumentHash: record.contentHash,
      assessment: record.provenance.gamingClear, restrictedRevisionCount: 0 } } : {}),
    records: [{ recordType: 'guide', semanticKey: passage.id, payloadHash: record.payloadHash, title: record.title ?? undefined,
      searchText: record.searchText, normalized: record.normalized, ...(passage.patch ? { patch: passage.patch } : {}) }] };
}

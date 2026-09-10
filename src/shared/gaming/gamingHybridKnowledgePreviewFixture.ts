import {
  GAMING_HYBRID_CONTRACT_VERSION, GAMING_HYBRID_LIMITS, gamingHybridQuerySchema,
  gamingHybridCandidatesSchema, gamingHybridIngestionSchema
} from './gamingHybridContract.js';
import {
  assessGamingSourcePolicy, classifyGamingQuestionFreshness, evaluateGamingFreshness,
  extractGamingFreshnessMetadata, GAMING_FRESHNESS_DEFAULTS,
  type GamingFreshnessEvidence, type GamingReviewedSourceRule
} from './gamingFreshnessCore.js';
import {
  GAMING_HYBRID_RETAINED_ARTIFACT_CHARS, resolveGamingHybridCandidateAttempt,
  projectGamingHybridCandidateRetention, isGamingApprovedArtifactCurrent
} from './gamingHybridPolicyCore.js';

export const GAMING_HYBRID_KNOWLEDGE_PREVIEW_VERSION = 'gaming-hybrid-knowledge/v1';
const FAILURE = 'PREVIEW_GAMING_HYBRID_KNOWLEDGE_CONTRACT_INVALID';
const GAME = 'Prism Siege';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const WORKFLOW_ID = '10000000-0000-4000-8000-000000000001';
const CANDIDATE_ID = '20000000-0000-4000-8000-000000000001';
const INDEX_URL = 'https://prism.example/updates/current';
const RULES: readonly GamingReviewedSourceRule[] = [
  { id: 'synthetic-current', game: GAME, hosts: ['prism.example'], path: '/updates/current', pathMatch: 'exact',
    category: 'official_updates', currentness: 'current_index', durableAllowed: false, autoStoreAllowed: false },
  { id: 'synthetic-notes', game: GAME, hosts: ['prism.example'], path: '/updates/', pathMatch: 'prefix',
    category: 'official_updates', currentness: 'article', durableAllowed: true, autoStoreAllowed: true },
  { id: 'synthetic-community', game: GAME, hosts: ['community.example'], path: '/guides/', pathMatch: 'prefix',
    category: 'community', currentness: 'none', durableAllowed: true, autoStoreAllowed: false },
  { id: 'synthetic-status', game: GAME, hosts: ['prism.example'], path: '/status', pathMatch: 'exact',
    category: 'official_status', currentness: 'live_status', durableAllowed: false, autoStoreAllowed: false }
];

function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function extract(url: string, labels: string): GamingFreshnessEvidence {
  return extractGamingFreshnessMetadata({ publicUrl: url, text: `Game: ${GAME}\n${labels}`,
    metadata: { title: `${GAME} Patch Notes` } }, { game: GAME }, NOW, RULES);
}

function evaluate(evidence: GamingFreshnessEvidence[], question = 'Which weapon build is best?', mode = 'guide') {
  return evaluateGamingFreshness({ evidence, question, mode, game: GAME, now: NOW });
}

function requireClosedContracts(): void {
  const query = { contractVersion: GAMING_HYBRID_CONTRACT_VERSION, idempotencyKey: 'synthetic-query-1',
    game: GAME, question: 'How do I open the copper gate?' };
  const parsed = gamingHybridQuerySchema.parse(query);
  requireProof(parsed.mode === 'guide' && parsed.storagePolicy === 'transient_only');
  requireProof(!gamingHybridQuerySchema.safeParse({ ...query, canStore: true }).success);
  requireProof(!gamingHybridQuerySchema.safeParse({ ...query, contractVersion: 'unknown' }).success);
  const candidates = { contractVersion: GAMING_HYBRID_CONTRACT_VERSION, workflowId: WORKFLOW_ID,
    idempotencyKey: 'synthetic-candidates-1', candidates: [{ url: 'https://community.example/guides/beam', claimedCategory: 'official_updates' }] };
  requireProof(gamingHybridCandidatesSchema.safeParse(candidates).success);
  requireProof(!gamingHybridCandidatesSchema.safeParse({ ...candidates, candidates: Array.from({ length: 4 }, () => candidates.candidates[0]) }).success);
  requireProof(!gamingHybridCandidatesSchema.safeParse({ ...candidates, candidates: [{ ...candidates.candidates[0], content: 'caller-written evidence' }] }).success);
  const ingestion = { contractVersion: GAMING_HYBRID_CONTRACT_VERSION, workflowId: WORKFLOW_ID,
    idempotencyKey: 'synthetic-ingestion-1', candidateIds: [CANDIDATE_ID], storagePolicy: 'ask_before_store' };
  requireProof(gamingHybridIngestionSchema.parse(ingestion).confirmStore === false);
  requireProof(!gamingHybridIngestionSchema.safeParse({ ...ingestion, confirmed: true }).success);
  requireProof(assessGamingSourcePolicy(candidates.candidates[0].url, GAME, RULES).authority === 'community');
  requireProof(!assessGamingSourcePolicy(candidates.candidates[0].url, GAME, RULES).autoStoreAllowed);
  requireProof(assessGamingSourcePolicy('https://prism.example.attacker.example/updates/current', GAME, RULES).authority === 'unreviewed');
  requireProof(assessGamingSourcePolicy(INDEX_URL, `${GAME} 2`, RULES).authority === 'unreviewed');
}

function requireCurrentApplicability(): void {
  const index = extract(INDEX_URL, 'Current patch: 2.1\nEffective from: 2026-09-08');
  const current = extract('https://prism.example/updates/2.1', 'Patch: 2.1\nEffective from: 2026-09-08\nMechanic: beam damage = 20');
  const obsolete = extract('https://prism.example/updates/1.0', 'Patch: 1.0\nEffective from: 2020-01-01\nMechanic: beam damage = 30');
  requireProof(classifyGamingQuestionFreshness({ prompt: 'Which weapon build is best?' }) === 'patch_sensitive');
  requireProof(!evaluate([obsolete]).usable && !evaluate([index, obsolete]).usable);
  const verified = evaluate([index, obsolete, current]);
  requireProof(verified.usable && verified.effectivePatch === '2.1' && verified.verifiedAsOf === NOW.toISOString());
  requireProof(verified.selectedEvidenceIds.join('|') === [current.id, index.id].join('|'));
  const old = new Date(NOW.getTime() - GAMING_FRESHNESS_DEFAULTS.patch_sensitive - 1).toISOString();
  requireProof(evaluate([{ ...index, fetchedAt: old, verifiedAt: old }, current]).status === 'stale');
  requireProof(evaluate([index, { ...index, id: 'conflicting-index', currentPatch: '2.2' }, current]).status === 'conflicting');
  requireProof(!evaluate([index, { ...current, effectiveFrom: '2026-09-10' }]).usable);
  requireProof(!evaluate([{ ...index, currentBuild: 'build-b' }, current]).usable);
  requireProof(evaluate([{ ...index, currentBuild: 'build-b' }, { ...current, build: 'build-b' }]).effectiveBuild === 'build-b');
  const stable = evaluate([current], 'Where is the copper gate?');
  requireProof(stable.usable && stable.classification === 'stable');
  const status = extract('https://prism.example/status', `Source updated at: ${NOW.toISOString()}`);
  requireProof(!status.durableAllowed && !status.autoStoreAllowed && evaluate([status], 'Are the servers down?').usable);
  requireProof(!evaluate([{ ...status, sourceUpdatedAt: old }], 'Are the servers down?').usable);
}

function requireAcquiredIdentityFreshness(): void {
  // The resolver supplies both identities. This fixture exercises freshness policy,
  // not the URL redaction or acquisition that produced the public citation.
  const privatePath = 'A'.repeat(120);
  const privatePayload = '%7Bprivate-preview-build-payload';
  const text = `Game: ${GAME}\nPatch: 2.1\nCurrent patch: 2.1\nCurrent build: beam-v2\nCurrent season: Gears\nEffective from: 2026-09-08`;
  const document = { publicUrl: INDEX_URL, canonicalUrl: `${INDEX_URL}/${privatePath}?build=${privatePayload}`,
    text, metadata: { title: `${GAME} Patch Notes` } };
  const article = extractGamingFreshnessMetadata(document, { game: GAME }, NOW, RULES);
  requireProof(article.ruleId === 'synthetic-notes' && article.authority === 'official' && article.currentness === 'article');
  requireProof(article.patch === '2.1' && !article.currentPatch && !article.currentBuild && !article.currentSeason);
  const result = evaluate([article]);
  requireProof(!result.usable && result.status === 'unverified');
  const index = extractGamingFreshnessMetadata({ ...document, canonicalUrl: INDEX_URL }, { game: GAME }, NOW, RULES);
  requireProof(index.ruleId === 'synthetic-current' && index.currentness === 'current_index');
  requireProof(index.currentPatch === '2.1' && index.currentBuild === 'beam-v2' && index.currentSeason === 'Gears');
  const unreviewed = extractGamingFreshnessMetadata({ ...document,
    canonicalUrl: `https://prism.example/player-builds/${privatePath}?build=${privatePayload}` }, { game: GAME }, NOW, RULES);
  requireProof(unreviewed.authority === 'unreviewed' && unreviewed.currentness === 'none' && !unreviewed.autoStoreAllowed);
  requireProof(!unreviewed.currentPatch && !unreviewed.currentBuild && !unreviewed.currentSeason);
  for (const evidence of [article, index, unreviewed]) {
    requireProof(evidence.id === INDEX_URL && evidence.url === INDEX_URL);
    const serialized = JSON.stringify({ evidence, result });
    requireProof(!serialized.includes(privatePath) && !serialized.includes('private-preview-build-payload') && !serialized.includes('build='));
  }
  const first = extract('https://prism.example/updates/article?guide=beam&rank=1&rank=2', 'Patch: 2.1');
  const second = extract('https://prism.example/updates/article?guide=beam&rank=2&rank=1', 'Patch: 2.1');
  requireProof(first.id === first.url && second.id === second.url && first.id !== second.id);
  requireProof(first.url.endsWith('?guide=beam&rank=1&rank=2') && second.url.endsWith('?guide=beam&rank=2&rank=1'));
}

function requireSeasonalAndScopeRepairs(): void {
  const index = extract(INDEX_URL, 'Current season: Gears\nEffective from: 2026-09-08');
  const obsolete = extract('https://prism.example/updates/season', 'Season: Gears\nPatch: 1.0\nEffective from: 2026-09-08');
  requireProof(evaluate([index, obsolete], 'How do current season tokens work?').usable);
  for (const [question, mode] of [
    ['What is the best weapon build for the current season?', 'guide'],
    ['What are the latest hotfix beam damage values this season?', 'guide'],
    ['Describe the seasonal loadout.', 'build']
  ]) {
    const unsupported = evaluate([index, obsolete], question, mode);
    requireProof(unsupported.classification === 'seasonal' && !unsupported.usable);
    const current = { ...obsolete, id: 'current-season-balance', patch: '2.1' };
    const verified = evaluate([{ ...index, currentPatch: '2.1' }, obsolete, current], question, mode);
    requireProof(verified.usable && verified.effectivePatch === '2.1' && !verified.selectedEvidenceIds.includes(obsolete.id));
  }
  for (const label of ['Platforms', 'Regions']) {
    for (const value of ['x'.repeat(81), 'all, ', Array.from({ length: 9 }, (_, i) => `scope-${i}`).join(', ')]) {
      const malformed = extract('https://prism.example/updates/scope', `Patch: 2.1\nEffective from: 2026-09-08\n${label}: ${value}`);
      requireProof(malformed.metadataUnverified && !malformed.autoStoreAllowed);
      const result = evaluateGamingFreshness({ question: 'Where is the copper gate?', game: GAME,
        platform: 'PC', region: 'EU', evidence: [malformed], now: NOW });
      requireProof(!result.usable && result.reasons.includes('APPLICABILITY_METADATA_UNVERIFIED'));
    }
  }
}

function requireMechanicConflictRepair(): void {
  const index = extract(INDEX_URL, 'Current patch: 2.1\nEffective from: 2026-09-08');
  const official = extract('https://prism.example/updates/beam', 'Patch: 2.1\nMechanic: beam damage = 20');
  const valid = extract('https://community.example/guides/current', 'Patch: 2.1\nMechanic: beam damage = 20\nMechanic: beam cooldown = 6s');
  for (const reverseClaims of [false, true]) {
    const claims = ['Mechanic: beam damage = 30', 'Mechanic: beam cooldown = 5s'];
    const rejected = extract('https://community.example/guides/conflicting', `Patch: 2.1\n${(reverseClaims ? claims.reverse() : claims).join('\n')}`);
    for (const weaker of [[rejected, valid], [valid, rejected]]) {
      const result = evaluate([index, official, ...weaker]);
      requireProof(result.usable && result.selectedEvidenceIds.join('|') === [official.id, valid.id, index.id].join('|'));
      requireProof(result.reasons.includes('LOWER_AUTHORITY_CONFLICT_EXCLUDED'));
    }
  }
  const conflictingOfficial = { ...official, id: 'other-official', mechanicValues: { 'beam damage': '30' } };
  requireProof(evaluate([index, official, conflictingOfficial]).status === 'conflicting');
}

function requireLifecycleRepairs(): void {
  const attempt = { requestedKey: 'synthetic-candidates-1', round: 0, nextAction: 'search', maxRounds: GAMING_HYBRID_LIMITS.discoveryRounds };
  requireProof(resolveGamingHybridCandidateAttempt(attempt) === 'begin');
  requireProof(resolveGamingHybridCandidateAttempt({ ...attempt, nextAction: 'stop' }) === 'deny');
  const charged = { ...attempt, operationKey: attempt.requestedKey, round: 1, nextAction: 'retry_later' };
  requireProof(resolveGamingHybridCandidateAttempt(charged) === 'resume');
  requireProof(resolveGamingHybridCandidateAttempt({ ...charged, requestedKey: 'alternative-candidates-1' }) === 'deny');
  const decisions = [
    { candidateId: CANDIDATE_ID, url: 'https://community.example/guides/current', decision: 'eligible_for_ingestion',
      reasonCodes: ['VALIDATED_RELEVANT_CONTENT', ...Array.from({ length: 8 }, (_, i) => `SYNTHETIC_REASON_${i}`)],
      sourceCategory: 'community', document: 'synthetic-full-document-not-public', contentHash: 'synthetic-private-hash' },
    { url: 'https://community.example/guides/rejected', decision: 'rejected', reasonCodes: ['GAME_MISMATCH'] }
  ];
  const before = JSON.stringify(decisions);
  const exact = projectGamingHybridCandidateRetention({ retainedChars: GAMING_HYBRID_RETAINED_ARTIFACT_CHARS - 1_000_000,
    candidateChars: 1_000_000, decisions });
  requireProof(exact.retainArtifacts && exact.decisions[0].candidateId === CANDIDATE_ID && exact.decisions[0].decision === 'eligible_for_ingestion');
  const overflow = projectGamingHybridCandidateRetention({ retainedChars: GAMING_HYBRID_RETAINED_ARTIFACT_CHARS,
    candidateChars: 1, decisions });
  requireProof(!overflow.retainArtifacts && !('candidateId' in overflow.decisions[0]));
  requireProof(overflow.decisions[0].decision === 'accepted_transient' && overflow.decisions[0].reasonCodes[0] === 'ARTIFACT_CAPACITY_REACHED');
  requireProof(overflow.decisions[1].decision === 'rejected' && overflow.decisions[1].reasonCodes.join('|') === 'GAME_MISMATCH');
  requireProof(JSON.stringify(decisions) === before && exact.decisions[0].candidateId === CANDIDATE_ID);
  for (const projection of [exact, overflow]) {
    requireProof(projection.decisions.every(decision => decision.reasonCodes.length <= 8));
    requireProof(!JSON.stringify(projection).includes('synthetic-full-document-not-public') && !JSON.stringify(projection).includes('synthetic-private-hash'));
  }
  const approved = { approvedContentHash: 'a'.repeat(64), documentContentHash: 'a'.repeat(64), instructionFiltered: false, truncated: false };
  requireProof(isGamingApprovedArtifactCurrent(approved));
  requireProof(!isGamingApprovedArtifactCurrent({ ...approved, documentContentHash: 'b'.repeat(64) }));
  requireProof(!isGamingApprovedArtifactCurrent({ ...approved, instructionFiltered: true }));
  requireProof(!isGamingApprovedArtifactCurrent({ ...approved, truncated: true }));
}

/** Fixed production-core proof only: no workflow cache, queue, SQL, fetch, provider, or live worker execution. */
export function runGamingHybridKnowledgePreview(): void {
  try {
    requireClosedContracts();
    requireCurrentApplicability();
    requireAcquiredIdentityFreshness();
    requireSeasonalAndScopeRepairs();
    requireMechanicConflictRepair();
    requireLifecycleRepairs();
  } catch {
    throw new Error(FAILURE);
  }
}

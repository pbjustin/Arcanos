import {
  assessGamingClearSource, gamingClearIntactSourceText
} from './gamingClearSource.js';
import { assessGamingClearEvidence, assessGamingRequestCoverage } from './gamingClearEvidence.js';
import {
  createGamingClearAssessment, gamingClearContextFingerprint, gamingClearHash,
  parseGamingClearAssessment, parseGamingClearModelAssessment,
  type GamingClearAssessment, type GamingClearAssessmentInput, type GamingClearDimensions
} from './gamingClearPolicy.js';
import { GAMING_CLEAR_APPROVED_ANSWER, hasBoundGamingClearAnswer } from './gamingClearAnswerBinding.js';
import {
  assessGamingSourcePolicy, extractGamingFreshnessMetadata,
  type GamingFreshnessEvidence, type GamingReviewedSourceRule
} from './gamingFreshnessCore.js';
import type { ResolvedGamingDocument } from '@services/gamingDocumentResolution.js';
import type { GamingStoredKnowledgeContext, GamingStoredKnowledgeInput } from './gamingStoredEvidenceCore.js';
import type { GamingEvidenceUnit } from './gamingEvidenceUnits.js';
import { gamingCrossSourceStructuralConflict, readGamingEvidenceUnits } from './gamingStructuralEvidence.js';

export const GAMING_CLEAR_PREVIEW_VERSION = 'gaming-clear/v1';
export const GAMING_DISCOVERY_RECOVERY_EVIDENCE_PREVIEW_VERSION = 'gaming-discovery-recovery-evidence/v1';
const FAILURE = 'PREVIEW_GAMING_CLEAR_CONTRACT_INVALID';
const GAME = 'Elden Ring';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const SOURCE_URL = 'https://clear-preview.example/guides/intelligence';
const INDEX_URL = 'https://clear-preview.example/updates/current';
const PROSE = 'In Elden Ring, Intelligence supports the listed sorcery requirements. Compare staves and spell choices against the equipped staff requirements before choosing spells. The Intelligence build preserves enough equipment capacity to use the selected staff.';
const ANSWER = 'Compare staves and spell choices against the equipped staff requirements before choosing spells. [1]';
const ACTOR = 'synthetic-clear-private-actor';
const INPUT: GamingStoredKnowledgeInput = { game: GAME, prompt: 'How do Intelligence, staves, and spell choices work?', mode: 'guide' };
const RECOVERY_WEIGHT_STAT = 'weight';
const RECOVERY_INPUT: GamingStoredKnowledgeInput = { game: GAME,
  prompt: 'What is Copperblade weight value and Silverblade weight value?', mode: 'guide' };
const RULES: readonly GamingReviewedSourceRule[] = [
  { id: 'synthetic-clear-guide', game: GAME, hosts: ['clear-preview.example'], path: '/guides/', pathMatch: 'prefix',
    category: 'specialist_guide', currentness: 'none', durableAllowed: true, autoStoreAllowed: false },
  { id: 'synthetic-clear-index', game: GAME, hosts: ['clear-preview.example'], path: '/updates/current', pathMatch: 'exact',
    category: 'official_updates', currentness: 'current_index', durableAllowed: false, autoStoreAllowed: false }
];

function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function document(text = PROSE, title = `${GAME} Mage Build: Intelligence, Staves, and Spell Choices`): ResolvedGamingDocument {
  return { requestedUrl: SOURCE_URL, canonicalUrl: SOURCE_URL, publicUrl: SOURCE_URL, host: 'clear-preview.example', text,
    metadata: { title }, extraction: { strategy: 'article', rawTextLength: text.length, cleanedTextLength: text.length, navigationDensity: 0 },
    resolution: { resolverId: 'generic-web', resolverVersion: 'gaming-document-v1', strategy: 'article', documentType: 'html', supportsStructuredExtraction: false },
    metrics: { rawTextLength: text.length, cleanedTextLength: text.length, instructionFiltered: false, truncated: false } };
}

function metadata(doc: ResolvedGamingDocument): GamingFreshnessEvidence {
  return extractGamingFreshnessMetadata(doc, INPUT, NOW, RULES);
}

function source(doc: ResolvedGamingDocument, input = INPUT): GamingClearAssessment {
  return assessGamingClearSource(input, doc, { subjectId: 'synthetic-clear-source', subjectHash: gamingClearHash(doc.text),
    actorScopeHash: gamingClearHash(ACTOR), sourcePolicy: assessGamingSourcePolicy(doc.publicUrl, GAME, RULES),
    freshness: metadata(doc), now: NOW });
}

function knowledge(documents: ResolvedGamingDocument[]): GamingStoredKnowledgeContext {
  return { context: documents.map(doc => doc.text).join('\n\n'), sources: documents.map(doc => ({ game: GAME,
    sourceId: metadata(doc).id, url: doc.publicUrl, sourceType: 'supplied', fetchedAt: NOW.toISOString(), snippet: doc.text,
    freshnessMetadata: { ...metadata(doc) } })), evidence: documents.map((doc, index) => ({ sourceId: metadata(doc).id,
    revisionId: `synthetic-clear-revision-${index}`, recordId: `synthetic-clear-chunk-${index}`, recordType: 'guide',
    publicUrl: doc.publicUrl, text: doc.text, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt: NOW.toISOString() } })) };
}

function requireAcquiredApplicability(): void {
  const accepted = source(document());
  requireProof(accepted.decision === 'accept' && accepted.gates.identity === 'verified' && accepted.qualityEligible);
  requireProof(accepted.dimensionScores.resilience.unresolvedFacts.includes('INDEPENDENT_CORROBORATION_NOT_ESTABLISHED'));
  const labelOnly = source(document(`Game: ${GAME}. ${'Compare the staff requirements and Intelligence before choosing spells. '.repeat(3)}`, 'Unidentified notebook'));
  requireProof(labelOnly.gates.identity === 'unknown' && labelOnly.decision !== 'accept');
  const wrongBody = source(document(`Game: ${GAME}. In Diablo 4, Intelligence supports this spell setup. ${PROSE}`));
  requireProof(wrongBody.gates.identity === 'conflict' && wrongBody.decision === 'reject');
  const wrongTitle = source(document(PROSE, `${GAME} Nightreign guide`));
  requireProof(wrongTitle.gates.identity === 'conflict' && wrongTitle.decision === 'reject');
  const currentInput: GamingStoredKnowledgeInput = { ...INPUT, prompt: 'Which Intelligence build is best currently?', mode: 'build', requestedVersion: '2.0' };
  const baseline = source(document(`Patch: 1.0. Baseline valid for patches: 2.0. ${PROSE}`), currentInput);
  requireProof(baseline.decision === 'partial' && !baseline.qualityEligible && baseline.gates.compatibility === 'verified'
    && baseline.gates.freshness === 'unknown');
  const wrongPatch = source(document(`Patch: 1.0. Baseline valid for patches: 1.5. ${PROSE}`), currentInput);
  requireProof(wrongPatch.decision === 'reject' && wrongPatch.gates.compatibility === 'conflict');
  const clipped = document(`${PROSE} The next spell requires`);
  clipped.metrics.truncated = true;
  requireProof(gamingClearIntactSourceText(clipped) === PROSE);
  const filtered = document();
  filtered.metrics.instructionFiltered = true;
  requireProof(source(filtered).gates.security === 'conflict' && source(filtered).decision === 'reject');
  requireProof(!JSON.stringify(accepted).includes(PROSE) && !JSON.stringify(accepted).includes(ACTOR));
}

function requireEvidenceApplicability(): GamingClearAssessment {
  const data = knowledge([document()]);
  data.sources[0].clearSourceAssessment = source(document());
  const assess = (input: GamingStoredKnowledgeInput & { region?: string }, set = data) =>
    assessGamingClearEvidence(input, set, { now: NOW, actorScopeHash: gamingClearHash(ACTOR) });
  const accepted = assess(INPUT);
  requireProof(accepted.decision === 'accept' && accepted.gates.claimSupport === 'verified' && accepted.gates.freshness === 'not_applicable');
  const insufficient = assess(INPUT, knowledge([document('A distant balcony offers an unobstructed view of the moonlit horizon.')]));
  requireProof(insufficient.decision !== 'accept' && insufficient.gates.claimSupport === 'unknown');
  const wrongGame = knowledge([document()]);
  wrongGame.sources[0].game = 'Diablo 4';
  requireProof(assess(INPUT, wrongGame).decision === 'reject');
  const regional = knowledge([document(`Regions: EU\n${PROSE}`)]);
  const regionalInput = { ...INPUT, prompt: 'How do regional Intelligence, staves, and spell choices work?' };
  const ordinary = assess(INPUT, regional);
  requireProof(ordinary.decision === 'accept' && ordinary.gates.compatibility === 'verified');
  const matched = assess({ ...regionalInput, region: 'EU' }, regional);
  const missing = assess(regionalInput, regional);
  const conflicting = assess({ ...regionalInput, region: 'US' }, regional);
  requireProof(matched.decision === 'accept' && matched.gates.compatibility === 'verified');
  requireProof(missing.decision !== 'accept' && missing.gates.compatibility === 'unknown');
  requireProof(conflicting.decision === 'reject' && conflicting.gates.compatibility === 'conflict');
  requireProof(matched.contextFingerprint !== missing.contextFingerprint && matched.contextFingerprint !== conflicting.contextFingerprint);
  const currentInput = { ...INPUT, prompt: 'Which Intelligence build is best currently?', mode: 'build' as const, requestedVersion: '2.0', region: 'EU' };
  const guide = document(`Patch: 1.0\nBaseline valid for patches: 2.0\nRegions: EU\n${PROSE}`);
  const index = { ...document('Current patch: 2.0\nRegions: EU\nEffective from: 2026-09-08\nThe release index identifies the active patch for this region.'),
    requestedUrl: INDEX_URL, canonicalUrl: INDEX_URL, publicUrl: INDEX_URL, metadata: { title: `${GAME} Patch Notes` } };
  const current = assess(currentInput, knowledge([guide, index]));
  requireProof(current.decision === 'accept' && current.gates.freshness === 'verified');
  const unverified = assess(currentInput, knowledge([guide]));
  requireProof(unverified.decision !== 'accept' && unverified.gates.freshness === 'unknown' && unverified.overall === null);
  const regionalCurrentMismatch = assess({ ...currentInput, region: 'US' }, knowledge([guide, index]));
  requireProof(regionalCurrentMismatch.decision === 'reject' && regionalCurrentMismatch.gates.compatibility === 'conflict');
  return accepted;
}

function recoveryWeightUnit(sourceIndex: number, rowIndex: number, item = 'Copperblade', value = '10'): GamingEvidenceUnit {
  const fields = [{ label: 'Item', value: item }, { label: 'Stat', value: RECOVERY_WEIGHT_STAT }, { label: 'Value', value },
    { label: 'Unit', value: 'points' }, { label: 'Scope', value: 'base' }, { label: 'Note', value: `entry ${rowIndex}` }];
  return { id: `synthetic-recovery-unit-${sourceIndex}-${rowIndex}`, kind: 'table_row',
    text: fields.map(field => `${field.label}: ${field.value}`).join(' | '), fields,
    context: { scope: 'stats' }, integrity: { status: 'complete', reasons: [] },
    provenance: { sourceUrl: `${SOURCE_URL}/weights-${sourceIndex}`, strategy: 'html_table', representation: 'html_dom',
      policyVersion: 'gaming-evidence-units/v1', locator: `table[0]/tr[${rowIndex}]` } };
}

/** Synthetic source-bound records, without acquiring documents or simulating storage. */
function recoveryKnowledge(groups: readonly (readonly GamingEvidenceUnit[])[]): GamingStoredKnowledgeContext {
  const sources = groups.map((_units, index) => ({ sourceId: `synthetic-recovery-source-${index}`, game: GAME,
    url: `${SOURCE_URL}/weights-${index}`, sourceType: 'supplied', origin: 'live' as const,
    fetchedAt: NOW.toISOString(), snippet: '' }));
  return { context: '', sources, evidence: groups.flatMap((units, index) => units.map((unit, row) => ({
    sourceId: sources[index].sourceId, revisionId: `synthetic-recovery-revision-${index}`,
    recordId: `synthetic-recovery-record-${index}-${row}`, recordType: 'guide' as const,
    publicUrl: sources[index].url, text: unit.text, evidenceUnits: [unit], lexicalScore: 1, combinedScore: 1,
    provenance: { fetchedAt: NOW.toISOString() }
  }))) };
}

function requireDiscoveryRecoveryEvidence(): void {
  const complete = recoveryKnowledge([[recoveryWeightUnit(0, 0)], [recoveryWeightUnit(1, 0, 'Silverblade', '11')]]);
  const assess = (data: GamingStoredKnowledgeContext, input = RECOVERY_INPUT) =>
    assessGamingClearEvidence(input, data, { now: NOW, requireRequestCoverage: true });
  const coverage = assessGamingRequestCoverage(RECOVERY_INPUT, complete);
  requireProof(coverage.coverageSatisfied && coverage.missingCoverage.length === 0);
  requireProof(coverage.requirementSupport.length === 2 && coverage.requirementSupport.every((item, index) =>
    item.candidateIds.join('|') === complete.sources[index].sourceId
    && item.evidenceIds.join('|') === complete.evidence![index].recordId));
  requireProof(coverage.requirementUnitSupport?.length === 2 && coverage.requirementUnitSupport.every((item, index) =>
    item.evidenceUnitIds.join('|') === complete.evidence![index].evidenceUnits![0].id));
  const accepted = assess(complete);
  requireProof(accepted.decision === 'accept' && accepted.gates.claimSupport === 'verified' && !accepted.blockingFindings.length);
  requireProof(assessGamingClearEvidence(RECOVERY_INPUT, complete, { now: NOW }).gates.claimSupport === 'unknown');
  const absent = { ...complete, evidence: complete.evidence!.slice(0, 1) };
  requireProof(!assessGamingRequestCoverage(RECOVERY_INPUT, absent).coverageSatisfied && assess(absent).decision !== 'accept');
  for (const field of ['Value', 'Unit', 'Scope']) {
    const incomplete = structuredClone(complete);
    const unit = incomplete.evidence![1].evidenceUnits![0];
    unit.fields = unit.fields.filter(entry => entry.label !== field);
    unit.text = unit.fields.map(entry => `${entry.label}: ${entry.value}`).join(' | ');
    incomplete.evidence![1].text = unit.text;
    const missing = assessGamingRequestCoverage(RECOVERY_INPUT, incomplete);
    requireProof(!missing.coverageSatisfied && missing.missingCoverage.join('|') === 'requested topic 2');
    requireProof(assess(incomplete).gates.claimSupport === 'unknown' && assess(incomplete).decision !== 'accept');
  }
  const invalid = structuredClone(complete);
  invalid.evidence![1].evidenceUnits![0].integrity.status = 'partial';
  requireProof(!assessGamingRequestCoverage(RECOVERY_INPUT, invalid).coverageSatisfied && assess(invalid).decision !== 'accept');

  // Each source is below its existing document cap; only their full union exceeds it.
  const groups = Array.from({ length: 6 }, (_source, sourceIndex) => Array.from({ length: 350 }, (_row, rowIndex) =>
    recoveryWeightUnit(sourceIndex, rowIndex)));
  const input = { ...RECOVERY_INPUT, prompt: 'What is Copperblade weight value?' };
  requireProof(groups.flat().length === 2_100 && readGamingEvidenceUnits(groups.flat()).length === 0);
  const batches = groups.map((units, index) => ({ sourceUrl: `${SOURCE_URL}/weights-${index}`, units }));
  requireProof(gamingCrossSourceStructuralConflict({ ...input, sources: batches }) === false);
  requireProof(!assess(recoveryKnowledge(groups), input).blockingFindings.some(finding => finding.code === 'CONTRADICTORY_EVIDENCE'));
  groups[5][349] = recoveryWeightUnit(5, 349, 'Copperblade', '11');
  requireProof(gamingCrossSourceStructuralConflict({ ...input, sources: batches }) === true);
  const contradiction = assess(recoveryKnowledge(groups), input);
  requireProof(contradiction.decision === 'reject' && contradiction.blockingFindings.some(finding => finding.code === 'CONTRADICTORY_EVIDENCE'));

  const unavailable = recoveryKnowledge(Array.from({ length: 18 }, (_unused, index) => [recoveryWeightUnit(index, 0)]));
  const unknown = assess(unavailable, input);
  requireProof(unknown.decision !== 'accept' && unknown.gates.claimSupport === 'unknown'
    && unknown.blockingFindings.some(finding => finding.code === 'STRUCTURAL_CONFLICT_ASSESSMENT_UNVERIFIED')
    && !unknown.blockingFindings.some(finding => finding.code === 'CONTRADICTORY_EVIDENCE'));
  const compacted = assess({ ...complete, structuralConflictAssessmentUnavailable: true });
  requireProof(compacted.decision !== 'accept' && compacted.gates.claimSupport === 'unknown'
    && compacted.blockingFindings.some(finding => finding.code === 'STRUCTURAL_CONFLICT_ASSESSMENT_UNVERIFIED'));
  const oversized = Array.from({ length: 2_049 }, (_unused, index) => recoveryWeightUnit(0, index));
  requireProof(readGamingEvidenceUnits(oversized).length === 0);
  requireProof(gamingCrossSourceStructuralConflict({ ...input, sources: [{ sourceUrl: `${SOURCE_URL}/weights-0`, units: oversized }] }) === undefined);
}

function requireAuditAndAnswerBinding(evidence: GamingClearAssessment): void {
  const refs = evidence.dimensionScores.clarity.evidenceRefs;
  const dimension = (): GamingClearDimensions['clarity'] => ({ status: 'evaluated', score: 5,
    reasonCodes: ['SUPPORTED_SYNTHETIC_PASSAGE'], evidenceRefs: refs, unresolvedFacts: [] });
  const dimensions: GamingClearDimensions = { clarity: dimension(), leverage: dimension(), efficiency: dimension(),
    alignment: dimension(), resilience: dimension() };
  const model = { dimensions, findings: [] };
  const projection = parseGamingClearModelAssessment(model, refs);
  requireProof(projection);
  for (const malformed of [null, { ...model, overall: 5 }, { ...model, privateReasoning: ACTOR },
    { ...model, dimensions: { clarity: dimensions.clarity } },
    { ...model, findings: [{ code: 'SUPPORTED', severity: 'warning', evidenceRefs: ['unacquired-reference'] }] },
    { ...model, dimensions: { ...dimensions, resilience: { ...dimensions.resilience, status: 'unknown', score: 5 } } },
    { ...model, dimensions: { ...dimensions, resilience: { ...dimensions.resilience, status: 'not_applicable', score: null } } }]) {
    requireProof(parseGamingClearModelAssessment(malformed, refs) === null);
  }
  const input: GamingClearAssessmentInput = { profile: 'answer', questionProfile: 'explanation', subjectId: 'synthetic-clear-answer',
    subjectHash: gamingClearHash(ANSWER), contextFingerprint: gamingClearContextFingerprint({ evidence: evidence.subjectHash, actor: ACTOR, region: 'EU' }),
    evidenceRefs: refs, gates: { ...evidence.gates }, dimensions: projection.dimensions, findings: projection.findings,
    assessmentMethod: 'mixed', evaluatedAt: NOW.toISOString() };
  const answer = createGamingClearAssessment(input);
  requireProof(answer.decision === 'accept' && parseGamingClearAssessment(answer)?.decision === 'accept');
  requireProof(parseGamingClearAssessment({ ...answer, overall: 0 }) === null);
  const unsupported = createGamingClearAssessment({ ...input,
    findings: [{ code: 'UNSUPPORTED_MECHANIC', severity: 'warning', evidenceRefs: refs }] });
  requireProof(unsupported.overall === 5 && unsupported.decision === 'reject'
    && unsupported.blockingFindings.some(finding => finding.code === 'UNSUPPORTED_MECHANIC' && finding.severity === 'blocking'));
  const unresolved = createGamingClearAssessment({ ...input, dimensions: { ...dimensions,
    resilience: { ...dimensions.resilience, unresolvedFacts: ['PATCH_APPLICABILITY_UNVERIFIED'] } } });
  requireProof(unresolved.decision === 'reject' && unresolved.blockingFindings.some(finding => finding.code === 'MATERIAL_FACT_UNRESOLVED'));
  for (const assessmentStatus of ['unavailable', 'not_run'] as const) {
    const absent = createGamingClearAssessment({ ...input, assessmentStatus });
    requireProof(absent.decision === 'unavailable' && absent.overall === null && !absent.qualityEligible);
    requireProof(!hasBoundGamingClearAnswer({ response: ANSWER, [GAMING_CLEAR_APPROVED_ANSWER]: absent }));
  }
  const carrier = { response: ANSWER, [GAMING_CLEAR_APPROVED_ANSWER]: answer };
  requireProof(hasBoundGamingClearAnswer(carrier));
  requireProof(!hasBoundGamingClearAnswer({ ...carrier, response: `${ANSWER} Guaranteed on every patch.` }));
  requireProof(!hasBoundGamingClearAnswer({ response: ANSWER }));
  requireProof(!hasBoundGamingClearAnswer({ response: ANSWER, [GAMING_CLEAR_APPROVED_ANSWER]: unsupported }));
  const publicJson = JSON.stringify(carrier);
  requireProof(publicJson === JSON.stringify({ response: ANSWER }) && !publicJson.includes('dimensionScores') && !publicJson.includes(ACTOR));
  requireProof(!JSON.stringify(answer).includes(PROSE) && !JSON.stringify(answer).includes(ACTOR));
}

/** Fixed synthetic production-core proof; no acquisition, model audit, provider, SQL, cache, logger, or worker runs. */
export function runGamingClearPreview(): void {
  try {
    requireAcquiredApplicability();
    const evidence = requireEvidenceApplicability();
    requireDiscoveryRecoveryEvidence();
    requireAuditAndAnswerBinding(evidence);
  } catch {
    throw new Error(FAILURE);
  }
}

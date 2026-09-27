import path from 'node:path';
import { checkTutorPrivateBoundary } from './check-tutor-private-boundary.mjs';
import { inspectComposedTutorSkill } from './compose-tutor-skill.mjs';
import { inspectTutorSkillRevisionChain, validateTutorSkillRevisionChain } from './tutor-skill-revision.mjs';
import { inspectUpdatedTutorBundle, inspectUpdatedTutorRelease, updatedReleaseBinding,
  validateUpdatedTutorRelease } from './tutor-updated-plugin-release.mjs';
import { baselineFingerprint, digest, isHash, relativeFile, requireCondition, reviewed,
  validateBaseline } from './tutor-migration.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const closed = (value, keys, code) => requireCondition(value && typeof value === 'object' && !Array.isArray(value) &&
  same(Object.keys(value).sort(), [...keys].sort()), code);
const ids = values => [...values].sort();
const distinctRoots = (a, b) => {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left !== right && !left.startsWith(`${right}/`) && !right.startsWith(`${left}/`);
};

/** Safe metadata derived from existing records, never an alternate hash override. */
export function currentReconciliationBinding({ baseline, composition, revision, diagnosticRevision, intakeRelease, currentRelease }) {
  return {
    baselineFingerprint: baselineFingerprint(baseline), configurationSha256: baseline.configuration.sha256,
    approvedSkillSha256: composition.skill.sha256, approvedPackageFingerprint: composition.packageFingerprint,
    pluginId: currentRelease.pluginId, releaseId: currentRelease.releaseId, version: currentRelease.version,
    skillSha256: currentRelease.approvedSkillSha256, packageFingerprint: currentRelease.capture.packageFingerprint,
    archiveSha256: currentRelease.capture.archive.sha256,
    revisionChainFingerprint: digest(JSON.stringify(canonical({ intake: revision, diagnostic: diagnosticRevision,
      intakeRelease: updatedReleaseBinding(intakeRelease) }))),
    referenceCount: 0, registeredAppId: currentRelease.registeredAppId, appOptional: true
  };
}

export function currentReconciliationSources({ composition, revision, diagnosticRevision, currentRelease }) {
  return { compositionApproval: ids(composition.ownerReview.evidenceIds),
    intakeAuthorization: ids(revision.authorization.evidenceIds), intakeReview: ids(revision.review.evidenceIds),
    diagnosticAuthorization: ids(diagnosticRevision.authorization.evidenceIds),
    diagnosticReview: ids(diagnosticRevision.review.evidenceIds), savedRelease: ids(currentRelease.evidenceIds) };
}

export function currentReconciliationEvidenceBinding(record) {
  return { ...record.binding, sourceEvidenceIds: record.sourceEvidenceIds, installedCapture: record.installedCapture };
}

/** A reviewed successor does not relabel the original native migration capture. */
export function validateCurrentTutorReconciliation(options) {
  const { record, baseline, composition, revision, diagnosticRevision, intakeRelease, currentRelease,
    referenceReview, evidence, state } = options;
  closed(record, ['schemaVersion', 'kind', 'status', 'binding', 'sourceEvidenceIds', 'installedCapture', 'review'],
    'CURRENT_RECONCILIATION_FIELDS_INVALID');
  requireCondition(record.schemaVersion === 1 && record.kind === 'CURRENT_SAVED_RELEASE_RECONCILIATION' &&
    record.status === 'VERIFIED', 'CURRENT_RECONCILIATION_STATUS_INVALID');
  validateBaseline(baseline);
  const baselineHash = baselineFingerprint(baseline);
  requireCondition(baseline.status === 'VERIFIED' && baseline.knowledge.length === 0 &&
    Array.isArray(referenceReview?.references) && referenceReview.references.length === 0,
    'CURRENT_RECONCILIATION_REFERENCES_INVALID');
  requireCondition(composition?.status === 'VERIFIED' && composition.kind === 'PRIVATE_COMPOSED_RELEASE_CANDIDATE' &&
    composition.privateContentsTracked === false && composition.baselineFingerprint === baselineHash &&
    composition.configurationSha256 === baseline.configuration.sha256 && isHash(composition.packageFingerprint) &&
    composition.ownerReview?.status === 'APPROVED' && reviewed(composition.ownerReview) &&
    composition.ownerReview.baselineFingerprint === baselineHash &&
    composition.ownerReview.skillSha256 === composition.skill?.sha256 &&
    composition.ownerReview.packageFingerprint === composition.packageFingerprint,
    'CURRENT_RECONCILIATION_COMPOSITION_INVALID');
  const approval = composition.ownerReview;
  requireCondition(Array.isArray(approval.evidenceIds) && approval.evidenceIds.length > 0 &&
    new Set(approval.evidenceIds).size === approval.evidenceIds.length, 'CURRENT_RECONCILIATION_APPROVAL_MISSING');
  for (const id of approval.evidenceIds) {
    const item = evidence.get(id);
    requireCondition(item?.kind === 'user_reported' && item.status === 'USER_REPORTED' &&
      same(item.compositionBinding, { baselineFingerprint: baselineHash, skillSha256: composition.skill.sha256,
        packageFingerprint: composition.packageFingerprint }), 'CURRENT_RECONCILIATION_APPROVAL_BINDING_INVALID');
  }
  requireCondition(revision && diagnosticRevision && intakeRelease, 'CURRENT_RECONCILIATION_CHAIN_MISSING');
  const chain = validateTutorSkillRevisionChain(options);
  requireCondition(chain.revisionCount === 2 && currentRelease?.version === '0.8.5', 'CURRENT_RECONCILIATION_CHAIN_INVALID');
  validateUpdatedTutorRelease(currentRelease, { expectedSkillSha256: chain.expectedSkillSha256, evidence, state });
  const binding = currentReconciliationBinding(options);
  requireCondition(same(record.binding, binding) && same(record.sourceEvidenceIds, currentReconciliationSources(options)),
    'CURRENT_RECONCILIATION_BINDING_INVALID');
  closed(record.installedCapture, ['rootPath', 'packageFingerprint'], 'CURRENT_RECONCILIATION_CAPTURE_INVALID');
  relativeFile(record.installedCapture.rootPath);
  requireCondition(record.installedCapture.packageFingerprint === binding.packageFingerprint &&
    [currentRelease.capture.rootPath, intakeRelease.capture.rootPath, revision.from.rootPath, composition.outputDirectory]
      .every(root => typeof root === 'string' && distinctRoots(record.installedCapture.rootPath, root)),
    'CURRENT_RECONCILIATION_CAPTURE_INVALID');
  closed(record.review, ['reviewedBy', 'reviewedAt', 'evidenceIds'], 'CURRENT_RECONCILIATION_REVIEW_INVALID');
  requireCondition(reviewed(record.review) && Array.isArray(record.review.evidenceIds) && record.review.evidenceIds.length > 0 &&
    new Set(record.review.evidenceIds).size === record.review.evidenceIds.length, 'CURRENT_RECONCILIATION_REVIEW_INVALID');
  const expectedEvidence = currentReconciliationEvidenceBinding(record);
  for (const id of record.review.evidenceIds) {
    const observed = evidence.get(id);
    requireCondition(observed?.kind === 'repository' && observed.status === 'VERIFIED' &&
      same(observed.currentReconciliationBinding, expectedEvidence), 'CURRENT_RECONCILIATION_REVIEW_BINDING_INVALID');
  }
  for (const gate of ['SKILL_RECONCILED', 'MIGRATED_SKILL_RECONCILED']) if (state.gates[gate]?.status === 'VERIFIED') {
    requireCondition(same(ids(state.gates[gate].evidenceIds), ids(record.review.evidenceIds)),
      'CURRENT_RECONCILIATION_GATE_BINDING_INVALID');
  }
  return { status: 'VERIFIED', binding, artifactInspection: 'NOT_INSPECTED' };
}

/** Recompute approval/source provenance, both revisions, saved archive and installed bytes. */
export async function inspectCurrentTutorReconciliation(options) {
  try {
    const validated = validateCurrentTutorReconciliation(options);
    const { inputRoot, baseline, composition, currentRelease, record, evidence, state, referenceReview, packageRoot } = options;
    await checkTutorPrivateBoundary(inputRoot);
    const original = await inspectComposedTutorSkill({ inputRoot, baseline, packageRoot, referenceReview,
      outputDirectory: composition.outputDirectory, expectedSkillSha256: composition.skill.sha256,
      expectedPackageFingerprint: composition.packageFingerprint });
    requireCondition(same(original.report, composition.report) && original.sectionCount === composition.sectionCount &&
      same(ids(original.approvedRuleIds), ids(composition.approvedRuleIds)), 'CURRENT_RECONCILIATION_COMPOSITION_CHANGED');
    const saved = await inspectUpdatedTutorRelease({ inputRoot, release: currentRelease,
      expectedSkillSha256: validated.binding.skillSha256, evidence, state });
    const chain = await inspectTutorSkillRevisionChain(options);
    requireCondition(chain.revisionCount === 2 && chain.originalBytesPreserved === true &&
      chain.fromSkillSha256 === validated.binding.approvedSkillSha256 && chain.toSkillSha256 === validated.binding.skillSha256,
      'CURRENT_RECONCILIATION_CHAIN_CHANGED');
    const installed = await inspectUpdatedTutorBundle({ bundleRoot: path.join(inputRoot, record.installedCapture.rootPath),
      expectedSkillSha256: validated.binding.skillSha256, version: currentRelease.version, packageName: currentRelease.packageName });
    requireCondition(same(installed.members, saved.members) && installed.packageFingerprint === saved.packageFingerprint,
      'CURRENT_RECONCILIATION_INSTALLED_BYTES_CHANGED');
    return { ...validated, artifactInspection: 'VERIFIED', installedMemberCount: installed.members.length,
      originalApprovedBytesPreserved: true, revisionCount: 2, referenceCount: 0, appOptional: true,
      behaviorVerified: false, parityVerified: false, backendVerified: false };
  } catch (error) {
    throw new Error(/^[A-Z][A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : 'CURRENT_RECONCILIATION_PRIVATE_INPUT_INVALID');
  }
}

/** Future final-release checks must select current revised bytes, never the historical native skill. */
export async function verifyCurrentTutorReleaseInputs(options) {
  const inspection = await inspectCurrentTutorReconciliation(options);
  const { parity, baseline, currentRelease } = options;
  requireCondition(parity.status === 'VERIFIED' && Array.isArray(parity.cases) && parity.cases.length === 16 &&
    parity.cases.every(row => row.disposition !== 'BLOCKER' && row.oldGpt?.artifactSha256 === baseline.configuration.sha256 &&
      row.oldGpt?.configurationFingerprint === baselineFingerprint(baseline) &&
      row.plugin?.artifactSha256 === currentRelease.approvedSkillSha256 &&
      row.plugin?.configurationFingerprint === currentRelease.capture.packageFingerprint), 'CURRENT_PARITY_RESULT_STALE');
  return inspection;
}

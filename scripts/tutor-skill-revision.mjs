import path from 'node:path';
import { checkTutorPrivateBoundary } from './check-tutor-private-boundary.mjs';
import { inspectUpdatedTutorBundle, inspectUpdatedTutorRelease, inventoryUpdatedTutorArchive,
  tutorRegisteredAppId, validateUpdatedTutorRelease } from './tutor-updated-plugin-release.mjs';
import { digest, isHash, maxFileSize, packageFingerprint, readSafeFile, relativeFile,
  requireCondition, reviewed, text } from './tutor-migration.mjs';

const skillPath = 'skills/instructions/SKILL.md';
const intakeTransition = { scope: 'CONFIDENCE_TIME_INTAKE_ONLY', from: '0.8.3', to: '0.8.4' };
const diagnosticTransition = { scope: 'DIAGNOSTIC_SINGLE_QUESTION_ONLY', from: '0.8.4', to: '0.8.5' };
// Historical captures retain their account provenance but have no current-release gate.
const historicalState = { gates: { UPDATED_PLUGIN_ARCHIVE_VERIFIED: { status: 'BLOCKED' } } };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const closed = (value, keys, code) => requireCondition(value && typeof value === 'object' &&
  !Array.isArray(value) && same(Object.keys(value).sort(), [...keys].sort()), code);
const sorted = members => [...members].sort((left, right) => left.path.localeCompare(right.path, 'en'));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function skillRevisionAuthorization(revision) {
  return { pluginId: revision.pluginId, scope: revision.scope, fromSkillSha256: revision.from.skillSha256,
    toSkillSha256: revision.to.skillSha256, targetVersion: revision.to.version,
    insertionSha256: revision.insertion.sha256 };
}

export function skillRevisionBinding(revision) {
  return { ...skillRevisionAuthorization(revision), fromReleaseId: revision.from.releaseId,
    fromPackageFingerprint: revision.from.packageFingerprint,
    insertionOffsetBytes: revision.insertion.offsetBytes, insertionSizeBytes: revision.insertion.sizeBytes };
}

function validateRevisionStep(revision, { sourceSkill, currentRelease, evidence }, transition) {
  closed(revision, ['schemaVersion', 'kind', 'scope', 'status', 'pluginId', 'from', 'to', 'insertion',
    'authorization', 'review'], 'SKILL_REVISION_FIELDS_INVALID');
  requireCondition(revision.schemaVersion === 1 && revision.kind === 'OWNER_AUTHORIZED_SINGLE_INSERTION' &&
    revision.scope === transition.scope && revision.status === 'VERIFIED' &&
    revision.pluginId === 'plugin_d292d1e45ae08191b3911299e30e1a25', 'SKILL_REVISION_SCOPE_INVALID');
  closed(revision.from, ['releaseId', 'version', 'skillSha256', 'packageFingerprint', 'archive', 'rootPath',
    'evidenceId'], 'SKILL_REVISION_SOURCE_INVALID');
  closed(revision.to, ['version', 'skillSha256', 'skillSizeBytes'], 'SKILL_REVISION_TARGET_INVALID');
  closed(revision.insertion, ['offsetBytes', 'sizeBytes', 'sha256'], 'SKILL_REVISION_INSERTION_INVALID');
  requireCondition(revision.from.skillSha256 === sourceSkill?.sha256 && isHash(revision.from.skillSha256) &&
    Number.isSafeInteger(sourceSkill.sizeBytes), 'SKILL_REVISION_COMPOSITION_BINDING_INVALID');
  requireCondition(revision.from.version === transition.from && revision.to.version === transition.to &&
    text(revision.from.releaseId) && isHash(revision.from.packageFingerprint) &&
    isHash(revision.to.skillSha256) && revision.to.skillSha256 !== revision.from.skillSha256 &&
    Number.isSafeInteger(revision.insertion.offsetBytes) && revision.insertion.offsetBytes >= 0 &&
    revision.insertion.offsetBytes <= sourceSkill.sizeBytes &&
    Number.isSafeInteger(revision.insertion.sizeBytes) && revision.insertion.sizeBytes > 0 &&
    revision.insertion.sizeBytes <= 4096 && isHash(revision.insertion.sha256) &&
    revision.to.skillSizeBytes === sourceSkill.sizeBytes + revision.insertion.sizeBytes &&
    revision.to.skillSizeBytes <= maxFileSize, 'SKILL_REVISION_INSERTION_INVALID');
  requireCondition(currentRelease?.pluginId === revision.pluginId && currentRelease.version === revision.to.version &&
    currentRelease.approvedSkillSha256 === revision.to.skillSha256 &&
    currentRelease.previousRelease?.releaseId === revision.from.releaseId &&
    currentRelease.previousRelease.version === revision.from.version, 'SKILL_REVISION_CURRENT_RELEASE_MISMATCH');
  const currentSkill = currentRelease.capture?.members?.find(member => member.path === skillPath);
  requireCondition(currentSkill?.sha256 === revision.to.skillSha256 && currentSkill.sizeBytes === revision.to.skillSizeBytes,
    'SKILL_REVISION_CURRENT_SKILL_MISMATCH');
  relativeFile(revision.from.rootPath);
  closed(revision.from.archive, ['path', 'sha256', 'sizeBytes'], 'SKILL_REVISION_SOURCE_ARCHIVE_INVALID');
  relativeFile(revision.from.archive.path);
  requireCondition(isHash(revision.from.archive.sha256) && Number.isSafeInteger(revision.from.archive.sizeBytes) &&
    revision.from.archive.sizeBytes > 0 && revision.from.archive.sizeBytes <= 4 * maxFileSize &&
    !revision.from.archive.path.startsWith(`${revision.from.rootPath}/`), 'SKILL_REVISION_SOURCE_ARCHIVE_INVALID');
  const source = evidence.get(revision.from.evidenceId);
  const sourceBinding = source?.updatedReleaseBinding;
  requireCondition(source?.kind === 'chatgpt' && source.status === 'VERIFIED' &&
    sourceBinding?.artifactFormat === 'PLUGIN_CREATOR_SAVED_RELEASE' && sourceBinding.pluginId === revision.pluginId &&
    sourceBinding.releaseId === revision.from.releaseId && sourceBinding.currentReleaseId === revision.from.releaseId &&
    sourceBinding.version === revision.from.version && sourceBinding.visibility === 'PRIVATE' &&
    sourceBinding.skillSha256 === revision.from.skillSha256 &&
    sourceBinding.packageFingerprint === revision.from.packageFingerprint &&
    sourceBinding.archiveSha256 === revision.from.archive.sha256 &&
    sourceBinding.registeredAppId === tutorRegisteredAppId && sourceBinding.appOptional === true,
    'SKILL_REVISION_SOURCE_EVIDENCE_INVALID');
  closed(revision.authorization, ['evidenceIds'], 'SKILL_REVISION_AUTHORIZATION_INVALID');
  closed(revision.review, ['reviewedBy', 'reviewedAt', 'evidenceIds', 'originalBytesPreserved'],
    'SKILL_REVISION_REVIEW_INVALID');
  requireCondition(reviewed(revision.review) && revision.review.originalBytesPreserved === true,
    'SKILL_REVISION_REVIEW_INVALID');
  for (const [record, kind, status, field, binding] of [
    [revision.authorization, 'user_reported', 'USER_REPORTED', 'skillRevisionAuthorization', skillRevisionAuthorization(revision)],
    [revision.review, 'repository', 'VERIFIED', 'skillRevisionBinding', skillRevisionBinding(revision)]
  ]) {
    requireCondition(Array.isArray(record.evidenceIds) && record.evidenceIds.length > 0 &&
      new Set(record.evidenceIds).size === record.evidenceIds.length, 'SKILL_REVISION_EVIDENCE_MISSING');
    for (const id of record.evidenceIds) {
      const item = evidence.get(id);
      requireCondition(item?.kind === kind && item.status === status, 'SKILL_REVISION_EVIDENCE_INVALID');
      closed(item[field], Object.keys(binding), 'SKILL_REVISION_EVIDENCE_BINDING_INVALID');
      requireCondition(Object.entries(binding).every(([key, value]) => item[field][key] === value),
        'SKILL_REVISION_EVIDENCE_BINDING_INVALID');
    }
  }
  return { expectedSkillSha256: revision.to.skillSha256, binding: skillRevisionBinding(revision) };
}

/** A scoped owner authorization supplements, and never rewrites, the historical composition approval. */
export function validateTutorSkillRevision(revision, { composition, currentRelease, evidence }) {
  requireCondition(composition?.status === 'VERIFIED' && composition.ownerReview?.status === 'APPROVED' &&
    composition.skill?.sha256 === composition.ownerReview.skillSha256, 'SKILL_REVISION_COMPOSITION_BINDING_INVALID');
  return validateRevisionStep(revision, { sourceSkill: composition.skill, currentRelease, evidence }, intakeTransition);
}

/** Only the two separately authorized transitions are supported; no arbitrary version/hash override exists. */
export function validateTutorSkillRevisionChain({ revision, diagnosticRevision = null, intakeRelease = null,
  composition, currentRelease, evidence }) {
  requireCondition((diagnosticRevision === null && intakeRelease === null) ||
    (diagnosticRevision && typeof diagnosticRevision === 'object' && !Array.isArray(diagnosticRevision) &&
      intakeRelease && typeof intakeRelease === 'object' && !Array.isArray(intakeRelease)),
    'SKILL_REVISION_CHAIN_INCOMPLETE');
  const intake = validateTutorSkillRevision(revision, { composition,
    currentRelease: diagnosticRevision ? intakeRelease : currentRelease, evidence });
  if (!diagnosticRevision) return { ...intake, revisionCount: 1 };
  validateUpdatedTutorRelease(intakeRelease, { expectedSkillSha256: intake.expectedSkillSha256,
    evidence, state: historicalState });
  const source = diagnosticRevision.from;
  requireCondition(source && source.releaseId === intakeRelease.releaseId && source.version === intakeRelease.version &&
    source.skillSha256 === intakeRelease.approvedSkillSha256 &&
    source.packageFingerprint === intakeRelease.capture.packageFingerprint &&
    source.archive?.sha256 === intakeRelease.capture.archive.sha256 &&
    source.archive?.sizeBytes === intakeRelease.capture.archive.sizeBytes &&
    intakeRelease.evidenceIds.includes(source.evidenceId), 'SKILL_REVISION_CHAIN_SOURCE_MISMATCH');
  const sourceSkill = intakeRelease.capture.members.find(member => member.path === skillPath);
  const diagnostic = validateRevisionStep(diagnosticRevision, { sourceSkill, currentRelease, evidence }, diagnosticTransition);
  requireCondition(!diagnosticRevision.authorization.evidenceIds.some(id => revision.authorization.evidenceIds.includes(id)) &&
    !diagnosticRevision.review.evidenceIds.some(id => revision.review.evidenceIds.includes(id)),
    'SKILL_REVISION_CHAIN_AUTHORIZATION_REUSED');
  return { ...diagnostic, revisionCount: 2, predecessorBinding: intake.binding };
}

/** Reconstruct the old bytes by removing exactly the reviewed insertion from the saved successor. */
async function inspectRevisionStep({ inputRoot, revision, sourceSkill, currentRelease, evidence }, transition) {
  validateRevisionStep(revision, { sourceSkill, currentRelease, evidence }, transition);
  await checkTutorPrivateBoundary(inputRoot);
  const archive = await readSafeFile(inputRoot, revision.from.archive.path, 4 * maxFileSize, true);
  requireCondition(archive.sha256 === revision.from.archive.sha256 && archive.sizeBytes === revision.from.archive.sizeBytes,
    'SKILL_REVISION_SOURCE_ARCHIVE_MISMATCH');
  const oldMembers = inventoryUpdatedTutorArchive(archive.bytes);
  const oldFiles = new Map(oldMembers.filter(member => member.type === 'file').map(member => [member.path, member]));
  requireCondition(packageFingerprint(oldFiles) === revision.from.packageFingerprint,
    'SKILL_REVISION_SOURCE_FINGERPRINT_MISMATCH');
  const prior = await inspectUpdatedTutorBundle({ bundleRoot: path.join(inputRoot, revision.from.rootPath),
    expectedSkillSha256: revision.from.skillSha256, version: revision.from.version });
  requireCondition(same(prior.members, oldMembers), 'SKILL_REVISION_SOURCE_EXTRACTION_MISMATCH');
  const current = await inspectUpdatedTutorBundle({ bundleRoot: path.join(inputRoot, currentRelease.capture.rootPath),
    expectedSkillSha256: revision.to.skillSha256, version: revision.to.version });
  requireCondition(same(current.members, sorted(currentRelease.capture.members)) &&
    current.packageFingerprint === currentRelease.capture.packageFingerprint, 'SKILL_REVISION_CURRENT_EXTRACTION_MISMATCH');
  const before = await readSafeFile(inputRoot, `${revision.from.rootPath}/${skillPath}`);
  const after = await readSafeFile(inputRoot, `${currentRelease.capture.rootPath}/${skillPath}`);
  const { offsetBytes, sizeBytes, sha256 } = revision.insertion;
  requireCondition(before.sizeBytes === sourceSkill.sizeBytes && after.sizeBytes === revision.to.skillSizeBytes &&
    digest(after.bytes.subarray(offsetBytes, offsetBytes + sizeBytes)) === sha256 &&
    before.bytes.subarray(0, offsetBytes).equals(after.bytes.subarray(0, offsetBytes)) &&
    before.bytes.subarray(offsetBytes).equals(after.bytes.subarray(offsetBytes + sizeBytes)),
    'SKILL_REVISION_ORIGINAL_BYTES_CHANGED');
  let unchangedFileCount = 0;
  for (const [name, old] of oldFiles) {
    if (name === skillPath) continue;
    const saved = current.members.find(member => member.path === name);
    if (['plugin.json', '.codex-plugin/plugin.json'].includes(name)) {
      const oldManifest = JSON.parse((await readSafeFile(inputRoot, `${revision.from.rootPath}/${name}`)).content);
      const newManifest = JSON.parse((await readSafeFile(inputRoot, `${currentRelease.capture.rootPath}/${name}`)).content);
      delete oldManifest.version;
      delete newManifest.version;
      requireCondition(same(canonical(oldManifest), canonical(newManifest)), 'SKILL_REVISION_MANIFEST_SCOPE_CHANGED');
    } else {
      requireCondition(saved?.sha256 === old.sha256 && saved.sizeBytes === old.sizeBytes,
        'SKILL_REVISION_OTHER_FILE_CHANGED');
      unchangedFileCount += 1;
    }
  }
  return { sourceValidation: 'PASS', kind: revision.kind, scope: revision.scope,
    fromSkillSha256: before.sha256, toSkillSha256: after.sha256,
    originalBytesPreserved: true, insertion: revision.insertion,
    unchangedFileCount, manifestVersionOnlyChanges: true, behaviorVerified: false };
}

export async function inspectTutorSkillRevision({ inputRoot, revision, composition, currentRelease, evidence }) {
  validateTutorSkillRevision(revision, { composition, currentRelease, evidence });
  return inspectRevisionStep({ inputRoot, revision, sourceSkill: composition.skill, currentRelease, evidence }, intakeTransition);
}

export async function inspectTutorSkillRevisionChain(options) {
  const { inputRoot, revision, diagnosticRevision = null, intakeRelease = null,
    composition, currentRelease, evidence } = options;
  validateTutorSkillRevisionChain(options);
  if (!diagnosticRevision) return inspectTutorSkillRevision(options);
  await inspectUpdatedTutorRelease({ inputRoot, release: intakeRelease,
    expectedSkillSha256: revision.to.skillSha256, evidence, state: historicalState });
  const intake = await inspectTutorSkillRevision({ inputRoot, revision, composition, currentRelease: intakeRelease, evidence });
  const sourceSkill = intakeRelease.capture.members.find(member => member.path === skillPath);
  const diagnostic = await inspectRevisionStep({ inputRoot, revision: diagnosticRevision, sourceSkill,
    currentRelease, evidence }, diagnosticTransition);
  return { sourceValidation: 'PASS', revisionCount: 2, fromSkillSha256: intake.fromSkillSha256,
    toSkillSha256: diagnostic.toSkillSha256, originalBytesPreserved: true,
    steps: [intake, diagnostic], behaviorVerified: false };
}

import path from 'node:path';
import { checkTutorPrivateBoundary } from './check-tutor-private-boundary.mjs';
import { inspectUpdatedTutorBundle, inventoryUpdatedTutorArchive, tutorRegisteredAppId } from './tutor-updated-plugin-release.mjs';
import { digest, isHash, maxFileSize, packageFingerprint, readSafeFile, relativeFile,
  requireCondition, reviewed, text } from './tutor-migration.mjs';

const skillPath = 'skills/instructions/SKILL.md';
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

/** A scoped owner authorization supplements, and never rewrites, the historical composition approval. */
export function validateTutorSkillRevision(revision, { composition, currentRelease, evidence }) {
  closed(revision, ['schemaVersion', 'kind', 'scope', 'status', 'pluginId', 'from', 'to', 'insertion',
    'authorization', 'review'], 'SKILL_REVISION_FIELDS_INVALID');
  requireCondition(revision.schemaVersion === 1 && revision.kind === 'OWNER_AUTHORIZED_SINGLE_INSERTION' &&
    revision.scope === 'CONFIDENCE_TIME_INTAKE_ONLY' && revision.status === 'VERIFIED' &&
    revision.pluginId === 'plugin_d292d1e45ae08191b3911299e30e1a25', 'SKILL_REVISION_SCOPE_INVALID');
  closed(revision.from, ['releaseId', 'version', 'skillSha256', 'packageFingerprint', 'archive', 'rootPath',
    'evidenceId'], 'SKILL_REVISION_SOURCE_INVALID');
  closed(revision.to, ['version', 'skillSha256', 'skillSizeBytes'], 'SKILL_REVISION_TARGET_INVALID');
  closed(revision.insertion, ['offsetBytes', 'sizeBytes', 'sha256'], 'SKILL_REVISION_INSERTION_INVALID');
  requireCondition(composition?.status === 'VERIFIED' && composition.ownerReview?.status === 'APPROVED' &&
    revision.from.skillSha256 === composition.skill?.sha256 &&
    revision.from.skillSha256 === composition.ownerReview.skillSha256 && isHash(revision.from.skillSha256) &&
    Number.isSafeInteger(composition.skill.sizeBytes), 'SKILL_REVISION_COMPOSITION_BINDING_INVALID');
  requireCondition(revision.from.version === '0.8.3' && revision.to.version === '0.8.4' &&
    text(revision.from.releaseId) && isHash(revision.from.packageFingerprint) &&
    isHash(revision.to.skillSha256) && revision.to.skillSha256 !== revision.from.skillSha256 &&
    Number.isSafeInteger(revision.insertion.offsetBytes) && revision.insertion.offsetBytes >= 0 &&
    revision.insertion.offsetBytes <= composition.skill.sizeBytes &&
    Number.isSafeInteger(revision.insertion.sizeBytes) && revision.insertion.sizeBytes > 0 &&
    revision.insertion.sizeBytes <= 4096 && isHash(revision.insertion.sha256) &&
    revision.to.skillSizeBytes === composition.skill.sizeBytes + revision.insertion.sizeBytes &&
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

/** Reconstruct the old bytes by removing exactly the reviewed insertion from the saved successor. */
export async function inspectTutorSkillRevision({ inputRoot, revision, composition, currentRelease, evidence }) {
  validateTutorSkillRevision(revision, { composition, currentRelease, evidence });
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
  requireCondition(before.sizeBytes === composition.skill.sizeBytes && after.sizeBytes === revision.to.skillSizeBytes &&
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

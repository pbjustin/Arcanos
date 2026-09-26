import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createUpdatedFixture, refreshUpdatedFixture, writeFixtureJson } from './tutor-updated-release-fixture.js';

type Json = ReturnType<typeof JSON.parse>;
type SavedFixture = ReturnType<typeof createUpdatedFixture>;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export function authorizeFixtureRevision(saved: SavedFixture) {
  const from = structuredClone(saved.release);
  const sourceEvidence = structuredClone(saved.evidence);
  const sourceRoot = 'mock-prior-release/extracted';
  mkdirSync(path.join(saved.inputRoot, 'mock-prior-release'), { recursive: true });
  cpSync(saved.bundle, path.join(saved.inputRoot, sourceRoot), { recursive: true });
  cpSync(path.join(saved.inputRoot, from.capture.archive.path), path.join(saved.inputRoot, 'mock-prior-release/prior.tar.gz'));
  const skillFile = path.join(saved.bundle, 'skills/instructions/SKILL.md');
  const before = readFileSync(skillFile);
  const insertion = Buffer.from('\nMock scoped intake override: teach immediately with reasonable defaults.\n');
  const offsetBytes = before.indexOf(Buffer.from('\n---\n')) + 5;
  if (offsetBytes < 5) throw new Error('Fixture frontmatter missing');
  const after = Buffer.concat([before.subarray(0, offsetBytes), insertion, before.subarray(offsetBytes)]);
  writeFileSync(skillFile, after);
  for (const name of ['plugin.json', '.codex-plugin/plugin.json']) {
    const manifest = JSON.parse(readFileSync(path.join(saved.bundle, name), 'utf8'));
    manifest.version = '0.8.4';
    writeFixtureJson(path.join(saved.bundle, name), manifest);
  }
  Object.assign(saved.release, { version: '0.8.4', releaseId: 'pluginrel_mock_revision', currentReleaseId: 'pluginrel_mock_revision',
    previousRelease: { releaseId: from.releaseId, version: from.version }, approvedSkillSha256: hash(after),
    evidenceIds: ['mock-revised-release'] });
  saved.evidence.id = 'mock-revised-release';
  saved.state.gates.UPDATED_PLUGIN_ARCHIVE_VERIFIED.evidenceIds = ['mock-revised-release'];
  refreshUpdatedFixture(saved);
  const revision: Json = { schemaVersion: 1, kind: 'OWNER_AUTHORIZED_SINGLE_INSERTION', scope: 'CONFIDENCE_TIME_INTAKE_ONLY',
    status: 'VERIFIED', pluginId: from.pluginId,
    from: { releaseId: from.releaseId, version: from.version, skillSha256: hash(before),
      packageFingerprint: from.capture.packageFingerprint, archive: { ...from.capture.archive, path: 'mock-prior-release/prior.tar.gz' },
      rootPath: sourceRoot, evidenceId: sourceEvidence.id },
    to: { version: '0.8.4', skillSha256: hash(after), skillSizeBytes: after.length },
    insertion: { offsetBytes, sizeBytes: insertion.length, sha256: hash(insertion) },
    authorization: { evidenceIds: ['mock-owner-intake-authorization'] },
    review: { reviewedBy: 'Mock independent scope reviewer', reviewedAt: '2026-09-26T00:00:00Z',
      evidenceIds: ['mock-intake-scope-review'], originalBytesPreserved: true } };
  const authorizationBinding = { pluginId: revision.pluginId, scope: revision.scope,
    fromSkillSha256: revision.from.skillSha256, toSkillSha256: revision.to.skillSha256,
    targetVersion: revision.to.version, insertionSha256: revision.insertion.sha256 };
  const ownerEvidence: Json = { id: 'mock-owner-intake-authorization', kind: 'user_reported', status: 'USER_REPORTED',
    observedAt: revision.review.reviewedAt, summary: 'Synthetic scoped authorization only.', skillRevisionAuthorization: authorizationBinding };
  const reviewEvidence: Json = { id: 'mock-intake-scope-review', kind: 'repository', status: 'VERIFIED',
    observedAt: revision.review.reviewedAt, summary: 'Synthetic independent revision review only.',
    skillRevisionBinding: { ...authorizationBinding, fromReleaseId: revision.from.releaseId,
      fromPackageFingerprint: revision.from.packageFingerprint, insertionOffsetBytes: offsetBytes, insertionSizeBytes: insertion.length } };
  return { saved, revision, sourceEvidence, ownerEvidence, reviewEvidence };
}

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

type Json = ReturnType<typeof JSON.parse>;
export const updatedFixtureFiles = ['.app.json', '.codex-plugin/plugin.json', 'assets/gpt-icon.png', 'plugin.json',
  'skills/instructions/SKILL.md', 'skills/instructions/agents/openai.yaml', 'skills/instructions/lookup/knowledge-index.json'];
const directories = ['.codex-plugin', 'assets', 'skills', 'skills/instructions',
  'skills/instructions/agents', 'skills/instructions/lookup'];
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function writeFixtureJson(file: string, value: Json) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function tarFixtureMember(name: string, bytes: Buffer, type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

export function refreshUpdatedFixture(fixture: { bundle: string; inputRoot: string; release: Json; evidence: Json }) {
  const members = [...directories.map(name => ({ path: name, type: 'directory', sha256: hash(Buffer.alloc(0)), sizeBytes: 0 })),
    ...updatedFixtureFiles.map(name => {
      const bytes = readFileSync(path.join(fixture.bundle, name));
      return { path: name, type: 'file', sha256: hash(bytes), sizeBytes: bytes.length };
    })].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const tar = Buffer.concat([...members.map(member => tarFixtureMember(member.path + (member.type === 'directory' ? '/' : ''),
    member.type === 'directory' ? Buffer.alloc(0) : readFileSync(path.join(fixture.bundle, member.path)),
    member.type === 'directory' ? '5' : '0')), Buffer.alloc(1024)]);
  const archive = gzipSync(tar);
  const packageFingerprint = hash(JSON.stringify(members.filter(member => member.type === 'file').map(member =>
    ({ path: member.path, sha256: member.sha256, sizeBytes: member.sizeBytes }))));
  const release = fixture.release;
  release.capture.members = members;
  release.capture.packageFingerprint = packageFingerprint;
  release.capture.archive.sha256 = hash(archive);
  release.capture.archive.sizeBytes = archive.length;
  writeFileSync(path.join(fixture.inputRoot, release.capture.archive.path), archive);
  fixture.evidence.updatedReleaseBinding = { artifactFormat: release.artifactFormat, pluginId: release.pluginId,
    releaseId: release.releaseId, currentReleaseId: release.currentReleaseId, version: release.version,
    visibility: release.visibility, skillSha256: release.approvedSkillSha256, packageFingerprint,
    archiveSha256: release.capture.archive.sha256, registeredAppId: release.registeredAppId, appOptional: true };
}

/** Public synthetic data only; this is not an account or migration observation. */
export function createUpdatedFixture(inputRoot: string, skillContent: string) {
  const rootPath = 'mock-saved-update/extracted';
  const bundle = path.join(inputRoot, rootPath);
  for (const directory of directories) mkdirSync(path.join(bundle, directory), { recursive: true });
  const manifest: Json = { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'gpt-e9bcdc399db672af9f66dfd7e18e7953', version: '0.8.3', description: 'Mock fixture description.',
    author: { name: 'Mock owner' }, extensions: { 'com.openai': { apps: './.app.json',
      interface: { displayName: 'ARCANOS TUTOR', capabilities: ['skills'] } } } };
  writeFixtureJson(path.join(bundle, 'plugin.json'), manifest);
  writeFixtureJson(path.join(bundle, '.codex-plugin/plugin.json'), { interface: manifest.extensions['com.openai'].interface,
    name: manifest.name, version: manifest.version, description: manifest.description, author: manifest.author,
    keywords: [], skills: './skills', apps: './.app.json' });
  const registeredAppId = 'asdk_app_6ab4747769088191856fd8eb02507240';
  writeFixtureJson(path.join(bundle, '.app.json'), { apps: { 'arcanos-tutor': { id: registeredAppId, optional: true } } });
  writeFileSync(path.join(bundle, 'assets/gpt-icon.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  writeFileSync(path.join(bundle, 'skills/instructions/SKILL.md'), skillContent);
  writeFileSync(path.join(bundle, 'skills/instructions/agents/openai.yaml'), 'interface:\n  display_name: Mock Tutor\n');
  writeFixtureJson(path.join(bundle, 'skills/instructions/lookup/knowledge-index.json'), { files: [] });
  const evidenceId = 'mock-saved-plugin-update';
  const release: Json = { schemaVersion: 1, status: 'VERIFIED', artifactFormat: 'PLUGIN_CREATOR_SAVED_RELEASE',
    pluginId: 'plugin_d292d1e45ae08191b3911299e30e1a25', packageName: manifest.name, version: manifest.version,
    releaseId: 'pluginrel_mock_updated', currentReleaseId: 'pluginrel_mock_updated', visibility: 'PRIVATE',
    previousRelease: { releaseId: 'pluginrel_mock_previous', version: '0.8.2' },
    capture: { rootPath, archive: { path: 'mock-saved-update/current.tar.gz', sha256: '', sizeBytes: 0 },
      members: [], packageFingerprint: '' }, approvedSkillSha256: hash(skillContent), registeredAppId, appOptional: true,
    skillCount: 1, referenceCount: 0, appCount: 1, accountReview: { reviewedBy: 'Mock account reviewer',
      reviewedAt: '2026-09-26T00:00:00Z', confirmedSamePlugin: true, confirmedPrivate: true, confirmedCurrentRelease: true },
    evidenceIds: [evidenceId] };
  const evidence: Json = { id: evidenceId, kind: 'chatgpt', status: 'VERIFIED', observedAt: release.accountReview.reviewedAt,
    summary: 'Synthetic saved-release fixture only.', updatedReleaseBinding: {} };
  const state = { gates: { UPDATED_PLUGIN_ARCHIVE_VERIFIED: { status: 'VERIFIED', evidenceIds: [evidenceId] } } };
  const fixture = { bundle, inputRoot, release, evidence, state };
  refreshUpdatedFixture(fixture);
  return fixture;
}

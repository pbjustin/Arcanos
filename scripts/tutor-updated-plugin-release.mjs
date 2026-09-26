import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import Ajv2020 from 'ajv/dist/2020.js';
import yaml from 'js-yaml';
import { checkTutorPrivateBoundary } from './check-tutor-private-boundary.mjs';
import {
  digest, isHash, maxFileSize, noSymlinkAncestors, packageFingerprint, readSafeFile,
  relativeFile, requireCondition, reviewed, safeContent, text
} from './tutor-migration.mjs';

export const updatedReleaseFormat = 'PLUGIN_CREATOR_SAVED_RELEASE';
export const approvedTutorSkillSha256 = '7661b328b99aa096f930f46e272ef9208de6f11e22c002e77f79d9ab78a15096';
export const tutorRegisteredAppId = 'asdk_app_6ab4747769088191856fd8eb02507240';
const schemaRoot = fileURLToPath(new URL('../integrations/arcanos-tutor/', import.meta.url));
const schemaDigest = '0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883';
const skill = 'skills/instructions/SKILL.md';
const files = ['.app.json', '.codex-plugin/plugin.json', 'assets/gpt-icon.png', 'plugin.json',
  skill, 'skills/instructions/agents/openai.yaml', 'skills/instructions/lookup/knowledge-index.json'];
const directories = ['.codex-plugin', 'assets', 'skills', 'skills/instructions',
  'skills/instructions/agents', 'skills/instructions/lookup'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const closed = (value, keys, code) => requireCondition(value && typeof value === 'object' &&
  !Array.isArray(value) && same(Object.keys(value).sort(), [...keys].sort()), code);
const sorted = members => [...members].sort((a, b) => a.path.localeCompare(b.path, 'en'));
const metadata = (name, type, bytes) => ({ path: name, type, sha256: digest(bytes), sizeBytes: bytes.length });

function validateMembers(members) {
  requireCondition(Array.isArray(members) && members.length === files.length + directories.length,
    'UPDATED_MEMBER_INVENTORY_INVALID');
  const paths = new Set();
  for (const member of members) {
    closed(member, ['path', 'type', 'sha256', 'sizeBytes'], 'UPDATED_MEMBER_FIELDS_INVALID');
    relativeFile(member.path);
    requireCondition(!paths.has(member.path.toLowerCase()), 'UPDATED_DUPLICATE_MEMBER');
    paths.add(member.path.toLowerCase());
    requireCondition(isHash(member.sha256) && Number.isSafeInteger(member.sizeBytes) && member.sizeBytes >= 0 &&
      member.sizeBytes <= maxFileSize && (member.type === 'file' ? files.includes(member.path) && member.sizeBytes > 0 :
        member.type === 'directory' && directories.includes(member.path) && member.sizeBytes === 0 &&
        member.sha256 === digest(Buffer.alloc(0))), 'UPDATED_MEMBER_INVALID');
  }
  requireCondition(same(members.map(member => member.path).sort(), [...files, ...directories].sort()),
    'UPDATED_MEMBER_LAYOUT_INVALID');
}

/** Inspect a candidate or saved extracted bundle without asserting account provenance. */
export async function inspectUpdatedTutorBundle({ bundleRoot, expectedSkillSha256 = approvedTutorSkillSha256,
  version = '0.8.3', packageName = 'gpt-e9bcdc399db672af9f66dfd7e18e7953' }) {
  await noSymlinkAncestors(bundleRoot);
  const actualFiles = new Map();
  const members = [];
  async function visit(relative = '') {
    for (const entry of await readdir(path.join(bundleRoot, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      relativeFile(name);
      requireCondition(!entry.isSymbolicLink(), 'SYMLINK_NOT_ALLOWED');
      requireCondition(members.length < files.length + directories.length, 'UPDATED_UNEXPECTED_MEMBER');
      if (entry.isDirectory()) {
        requireCondition(directories.includes(name), 'UPDATED_UNEXPECTED_DIRECTORY');
        members.push(metadata(name, 'directory', Buffer.alloc(0)));
        await visit(name);
      } else {
        requireCondition(entry.isFile() && files.includes(name), 'UPDATED_UNEXPECTED_FILE');
        const actual = await readSafeFile(bundleRoot, name, maxFileSize, name.endsWith('.png'));
        actualFiles.set(name, actual);
        members.push(metadata(name, 'file', actual.bytes));
      }
    }
  }
  await visit();
  validateMembers(members);
  requireCondition(isHash(expectedSkillSha256) && actualFiles.get(skill).sha256 === expectedSkillSha256,
    'UPDATED_APPROVED_SKILL_MISMATCH');
  const schema = await readSafeFile(schemaRoot, 'schemas/agent-plugins-1.0.0.schema.json');
  requireCondition(digest(schema.content.replace(/\r\n/gu, '\n')) === schemaDigest, 'SCHEMA_DIGEST_MISMATCH');
  const manifest = JSON.parse(actualFiles.get('plugin.json').content);
  requireCondition(new Ajv2020({ allErrors: true, strict: true }).compile(JSON.parse(schema.content))(manifest),
    'UPDATED_MANIFEST_SCHEMA_INVALID');
  requireCondition(manifest.name === packageName && manifest.version === version, 'UPDATED_MANIFEST_IDENTITY_INVALID');
  closed(manifest.extensions, ['com.openai'], 'UPDATED_EXTENSION_INVALID');
  const extension = manifest.extensions['com.openai'];
  closed(extension, ['apps', 'interface'], 'UPDATED_EXTENSION_INVALID');
  requireCondition(extension.apps === './.app.json' && extension.interface?.displayName === 'ARCANOS TUTOR' &&
    same(extension.interface.capabilities, ['skills']), 'UPDATED_EXTENSION_INVALID');
  const compatibility = JSON.parse(actualFiles.get('.codex-plugin/plugin.json').content);
  closed(compatibility, ['interface', 'name', 'version', 'description', 'author', 'keywords', 'skills', 'apps'],
    'UPDATED_COMPATIBILITY_MANIFEST_INVALID');
  requireCondition(compatibility.name === packageName && compatibility.version === version &&
    compatibility.skills === './skills' && compatibility.apps === './.app.json' &&
    same(compatibility.interface, extension.interface) && same(compatibility.author, manifest.author) &&
    compatibility.description === manifest.description && same(compatibility.keywords, []),
    'UPDATED_COMPATIBILITY_MANIFEST_INVALID');
  const mappingContent = actualFiles.get('.app.json').content;
  // JSON.parse otherwise silently overwrites duplicate keys, hiding a second app declaration.
  const mappingKeys = [...mappingContent.matchAll(/("(?:\\.|[^"\\])*")\s*:/gu)].map(match => JSON.parse(match[1]));
  requireCondition(same(mappingKeys.sort(), ['apps', 'arcanos-tutor', 'id', 'optional'].sort()), 'UPDATED_APP_MAPPING_INVALID');
  const mapping = JSON.parse(mappingContent);
  closed(mapping, ['apps'], 'UPDATED_APP_MAPPING_INVALID');
  closed(mapping.apps, ['arcanos-tutor'], 'UPDATED_APP_MAPPING_INVALID');
  closed(mapping.apps['arcanos-tutor'], ['id', 'optional'], 'UPDATED_APP_MAPPING_INVALID');
  requireCondition(mapping.apps['arcanos-tutor'].id === tutorRegisteredAppId &&
    mapping.apps['arcanos-tutor'].optional === true, 'UPDATED_APP_MAPPING_INVALID');
  requireCondition(same(JSON.parse(actualFiles.get('skills/instructions/lookup/knowledge-index.json').content),
    { files: [] }), 'UPDATED_REFERENCES_NOT_EMPTY');
  const frontmatter = actualFiles.get(skill).content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  requireCondition(frontmatter, 'UPDATED_SKILL_METADATA_INVALID');
  const skillMetadata = yaml.load(frontmatter[1]);
  closed(skillMetadata, ['name', 'description'], 'UPDATED_SKILL_METADATA_INVALID');
  requireCondition(skillMetadata.name === 'arcanos-tutor' && text(skillMetadata.description), 'UPDATED_SKILL_METADATA_INVALID');
  return { sourceValidation: 'PASS', provenance: 'LOCAL_BYTES_ONLY', members: sorted(members),
    packageFingerprint: packageFingerprint(actualFiles), skillSha256: actualFiles.get(skill).sha256,
    registeredAppId: tutorRegisteredAppId, appOptional: true, skillCount: 1, referenceCount: 0, appCount: 1 };
}

/** Deliberately bounded regular-file/directory USTAR reader; links, PAX overrides and unsafe paths fail closed. */
export function inventoryUpdatedTutorArchive(compressed) {
  const archive = gunzipSync(compressed, { maxOutputLength: 4 * maxFileSize });
  requireCondition(archive.length % 512 === 0, 'UPDATED_TAR_INVALID');
  const members = [];
  let offset = 0;
  const field = (header, start, size) => {
    const value = header.subarray(start, start + size);
    const end = value.indexOf(0);
    return new TextDecoder('utf-8', { fatal: true }).decode(end < 0 ? value : value.subarray(0, end));
  };
  const octal = value => {
    requireCondition(/^[0-7]+$/u.test(value.trim()), 'UPDATED_TAR_NUMBER_INVALID');
    return Number.parseInt(value.trim(), 8);
  };
  while (offset + 512 <= archive.length && archive.subarray(offset, offset + 512).some(byte => byte !== 0)) {
    requireCondition(members.length < 13, 'UPDATED_TAR_MEMBER_LIMIT');
    const header = archive.subarray(offset, offset + 512);
    const checksum = octal(field(header, 148, 8));
    requireCondition(header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0) === checksum,
      'UPDATED_TAR_CHECKSUM_INVALID');
    requireCondition(field(header, 257, 6) === 'ustar', 'UPDATED_TAR_FORMAT_UNSUPPORTED');
    const type = field(header, 156, 1);
    requireCondition(['', '0', '5'].includes(type) && field(header, 157, 100) === '', 'UPDATED_TAR_LINK_OR_TYPE_INVALID');
    const prefix = field(header, 345, 155);
    const rawName = `${prefix ? `${prefix}/` : ''}${field(header, 0, 100)}`;
    const name = type === '5' && rawName.endsWith('/') ? rawName.slice(0, -1) : rawName;
    relativeFile(name);
    const size = octal(field(header, 124, 12));
    requireCondition(size <= maxFileSize && (type !== '5' || size === 0) && offset + 512 + size <= archive.length,
      'UPDATED_TAR_SIZE_INVALID');
    const bytes = archive.subarray(offset + 512, offset + 512 + size);
    safeContent(bytes.toString('utf8'));
    members.push(metadata(name, type === '5' ? 'directory' : 'file', bytes));
    const paddedSize = Math.ceil(size / 512) * 512;
    requireCondition(!archive.subarray(offset + 512 + size, offset + 512 + paddedSize).some(byte => byte !== 0),
      'UPDATED_TAR_PADDING_INVALID');
    offset += 512 + paddedSize;
  }
  requireCondition(archive.length - offset >= 1024 && !archive.subarray(offset).some(byte => byte !== 0),
    'UPDATED_TAR_TRAILER_INVALID');
  validateMembers(members);
  return sorted(members);
}

export function updatedReleaseBinding(release) {
  return { artifactFormat: updatedReleaseFormat, pluginId: release.pluginId, releaseId: release.releaseId,
    currentReleaseId: release.currentReleaseId, version: release.version, visibility: release.visibility,
    skillSha256: release.approvedSkillSha256, packageFingerprint: release.capture.packageFingerprint,
    archiveSha256: release.capture.archive.sha256, registeredAppId: release.registeredAppId, appOptional: true };
}

export function validateUpdatedTutorRelease(release, { expectedSkillSha256, evidence, state }) {
  closed(release, ['schemaVersion', 'status', 'artifactFormat', 'pluginId', 'packageName', 'version', 'releaseId',
    'currentReleaseId', 'visibility', 'previousRelease', 'capture', 'approvedSkillSha256', 'registeredAppId',
    'appOptional', 'skillCount', 'referenceCount', 'appCount', 'accountReview', 'evidenceIds'], 'UPDATED_RELEASE_FIELDS_INVALID');
  requireCondition(release.schemaVersion === 1 && release.status === 'VERIFIED' && release.artifactFormat === updatedReleaseFormat &&
    release.pluginId === 'plugin_d292d1e45ae08191b3911299e30e1a25' &&
    release.packageName === 'gpt-e9bcdc399db672af9f66dfd7e18e7953' && release.visibility === 'PRIVATE' &&
    text(release.version) && text(release.releaseId) && release.releaseId === release.currentReleaseId &&
    release.approvedSkillSha256 === expectedSkillSha256 && isHash(expectedSkillSha256) &&
    release.registeredAppId === tutorRegisteredAppId && release.appOptional === true &&
    release.skillCount === 1 && release.referenceCount === 0 && release.appCount === 1, 'UPDATED_RELEASE_INVALID');
  closed(release.previousRelease, ['releaseId', 'version'], 'UPDATED_PREVIOUS_RELEASE_INVALID');
  requireCondition(text(release.previousRelease.releaseId) && release.previousRelease.releaseId !== release.releaseId &&
    text(release.previousRelease.version) && release.previousRelease.version !== release.version, 'UPDATED_PREVIOUS_RELEASE_INVALID');
  closed(release.capture, ['rootPath', 'archive', 'members', 'packageFingerprint'], 'UPDATED_CAPTURE_INVALID');
  relativeFile(release.capture.rootPath);
  closed(release.capture.archive, ['path', 'sha256', 'sizeBytes'], 'UPDATED_ARCHIVE_INVALID');
  relativeFile(release.capture.archive.path);
  requireCondition(isHash(release.capture.archive.sha256) && Number.isSafeInteger(release.capture.archive.sizeBytes) &&
    release.capture.archive.sizeBytes > 0 && release.capture.archive.sizeBytes <= 4 * maxFileSize &&
    !release.capture.archive.path.startsWith(`${release.capture.rootPath}/`), 'UPDATED_ARCHIVE_INVALID');
  validateMembers(release.capture.members);
  const memberFiles = new Map(release.capture.members.filter(member => member.type === 'file').map(member => [member.path, member]));
  requireCondition(memberFiles.get(skill).sha256 === expectedSkillSha256 &&
    packageFingerprint(memberFiles) === release.capture.packageFingerprint, 'UPDATED_FINGERPRINT_INVALID');
  closed(release.accountReview, ['reviewedBy', 'reviewedAt', 'confirmedSamePlugin', 'confirmedPrivate',
    'confirmedCurrentRelease'], 'UPDATED_ACCOUNT_REVIEW_INVALID');
  requireCondition(reviewed(release.accountReview) && release.accountReview.confirmedSamePlugin === true &&
    release.accountReview.confirmedPrivate === true && release.accountReview.confirmedCurrentRelease === true,
    'UPDATED_ACCOUNT_REVIEW_INVALID');
  requireCondition(Array.isArray(release.evidenceIds) && release.evidenceIds.length > 0 &&
    new Set(release.evidenceIds).size === release.evidenceIds.length, 'UPDATED_ACCOUNT_EVIDENCE_INVALID');
  const binding = updatedReleaseBinding(release);
  for (const id of release.evidenceIds) {
    const observed = evidence.get(id);
    requireCondition(observed?.kind === 'chatgpt' && observed.status === 'VERIFIED', 'UPDATED_ACCOUNT_EVIDENCE_INVALID');
    closed(observed.updatedReleaseBinding, Object.keys(binding), 'UPDATED_ACCOUNT_BINDING_INVALID');
    requireCondition(Object.entries(binding).every(([key, value]) => observed.updatedReleaseBinding[key] === value),
      'UPDATED_ACCOUNT_BINDING_INVALID');
  }
  if (state.gates.UPDATED_PLUGIN_ARCHIVE_VERIFIED.status === 'VERIFIED') requireCondition(
    same([...state.gates.UPDATED_PLUGIN_ARCHIVE_VERIFIED.evidenceIds].sort(), [...release.evidenceIds].sort()),
    'UPDATED_ACCOUNT_GATE_MISMATCH');
  return binding;
}

/** Verify the actual saved archive and extraction independently of claimed metadata. */
export async function inspectUpdatedTutorRelease({ inputRoot, release, expectedSkillSha256, evidence, state }) {
  validateUpdatedTutorRelease(release, { expectedSkillSha256, evidence, state });
  await checkTutorPrivateBoundary(inputRoot);
  const archive = await readSafeFile(inputRoot, release.capture.archive.path, 4 * maxFileSize, true);
  requireCondition(archive.sha256 === release.capture.archive.sha256 && archive.sizeBytes === release.capture.archive.sizeBytes,
    'UPDATED_ARCHIVE_DIGEST_MISMATCH');
  const archivedMembers = inventoryUpdatedTutorArchive(archive.bytes);
  requireCondition(same(archivedMembers, sorted(release.capture.members)), 'UPDATED_ARCHIVE_INVENTORY_MISMATCH');
  const inspected = await inspectUpdatedTutorBundle({ bundleRoot: path.join(inputRoot, release.capture.rootPath),
    expectedSkillSha256, version: release.version, packageName: release.packageName });
  requireCondition(same(inspected.members, archivedMembers) && inspected.packageFingerprint === release.capture.packageFingerprint,
    'UPDATED_SAVED_EXTRACTION_MISMATCH');
  return { ...inspected, provenance: updatedReleaseFormat, archiveSha256: archive.sha256,
    releaseId: release.releaseId, privacyBoundary: 'PASS' };
}

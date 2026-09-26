import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const statuses = Object.freeze(['VERIFIED', 'USER_REPORTED', 'IMPLEMENTED_NOT_VERIFIED', 'BLOCKED', 'NOT_STARTED']);
export const gates = Object.freeze([
  'CODE_READY', 'BACKEND_DEPLOYED', 'OAUTH_CONFIGURED', 'CHATGPT_CONNECTION_REGISTERED',
  'TOOL_DISCOVERY_VERIFIED', 'LIVE_TUTOR_CALL_VERIFIED', 'GPT_BASELINE_CAPTURED',
  'TUTOR_SKILL_COMPOSED', 'TUTOR_SKILL_RECONCILED', 'TUTOR_SKILL_BEHAVIOR_VERIFIED',
  'CAPABILITY_EQUIVALENCE_VERIFIED', 'BACKEND_APP_REGISTERED', 'BACKEND_APP_OPTIONALITY_VERIFIED',
  'MIGRATED_SKILL_RECONCILED',
  'GPT_MIGRATED', 'SKILL_RECONCILED', 'REFERENCES_RECONCILED', 'PARITY_VERIFIED',
  'PACKAGE_READY', 'RELEASE_READY'
]);
export const categories = Object.freeze([
  'direct', 'indirect', 'non_activation', 'clarification', 'concise', 'structured',
  'exact_format', 'difficult', 'follow_up', 'memory', 'admin', 'authentication',
  'unavailable', 'timeout', 'cancellation', 'references'
]);
export const endpoint = 'https://acranos-production.up.railway.app/chatgpt/mcp';
export const skillPath = 'skills/arcanos-tutor/SKILL.md';
export const maxFileSize = 1024 * 1024;
const credentialPatterns = [
  /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/u,
  /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/u,
  /\bBearer\s+[A-Za-z0-9_.~+/-]{12,}/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
  /(?:postgres(?:ql)?|redis):\/\/[^\s/]+:[^\s@]+@/iu,
  /["']?(?:(?:access|refresh|auth)[_-]?token|client[_-]?secret|authorization(?:[_-]?code)?|password|(?:session[_-]?)?cookie|session[_-]?token|(?:openai[_-]?)?api[_-]?key|private(?:[_-]?signing)?[_-]?key|(?:signing|secret)[_-]?key)["']?\s*[:=]\s*["']?[^\s"',}{][^\r\n]{3,}/iu
];
export function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}
export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
export function baselineFingerprint(baseline) {
  return digest(JSON.stringify({ configuration: baseline.configuration.sha256,
    knowledge: baseline.knowledge.map(({ name, sha256, sizeBytes }) => ({ name, sha256, sizeBytes }))
      .sort((left, right) => left.name.localeCompare(right.name, 'en')) }));
}
export function packageFingerprint(files) {
  return digest(JSON.stringify([...files].map(([file, { sha256, sizeBytes }]) => ({ path: file, sha256, sizeBytes }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'))));
}
export function isHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
export function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
export function reviewed(value) {
  return text(value?.reviewedBy) && text(value?.reviewedAt) && Number.isFinite(Date.parse(value.reviewedAt));
}
export function safeContent(content) {
  requireCondition(!credentialPatterns.some(pattern => pattern.test(content)), 'POSSIBLE_CREDENTIAL');
}
export function relativeFile(value) {
  requireCondition(text(value) && !path.isAbsolute(value) && !value.includes('\\') &&
    !value.includes(':') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..') &&
    !/[\u0000-\u001f]/u.test(value), 'UNSAFE_PATH');
  return value;
}
// Reject links in every ancestor, including a linked package/input root. Checking
// only descendants leaves a junction or symlink in a parent as an escape hatch.
export async function noSymlinkAncestors(value) {
  let current = path.resolve(value);
  while (true) {
    requireCondition(!(await lstat(current)).isSymbolicLink(), 'SYMLINK_NOT_ALLOWED');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export async function readSafeFile(root, relative, limit = maxFileSize, binary = false) {
  relativeFile(relative);
  const absolute = path.resolve(root, relative);
  await noSymlinkAncestors(absolute);
  const canonicalRoot = await realpath(root);
  const canonicalFile = await realpath(absolute);
  requireCondition(canonicalFile.startsWith(`${canonicalRoot}${path.sep}`), 'PATH_ESCAPE');
  const info = await lstat(canonicalFile);
  requireCondition(info.isFile() && info.size <= limit, 'FILE_SIZE_EXCEEDED');
  const bytes = await readFile(canonicalFile);
  requireCondition(bytes.length <= limit, 'FILE_SIZE_EXCEEDED');
  const content = new TextDecoder('utf-8', { fatal: !binary }).decode(bytes);
  safeContent(content);
  return { bytes, content, sha256: digest(bytes), sizeBytes: bytes.length };
}
export function validateArtifact(artifact) {
  requireCondition(artifact && isHash(artifact.sha256) && Number.isSafeInteger(artifact.sizeBytes) &&
    artifact.sizeBytes > 0 && artifact.sizeBytes <= maxFileSize, 'ARTIFACT_METADATA_INVALID');
  relativeFile(artifact.path);
}
export async function verifyArtifact(root, artifact) {
  validateArtifact(artifact);
  const actual = await readSafeFile(root, artifact.path);
  requireCondition(actual.sha256 === artifact.sha256 && actual.sizeBytes === artifact.sizeBytes, 'ARTIFACT_DIGEST_MISMATCH');
  return actual;
}
const builderFields = ['description', 'instructions', 'conversationStarters', 'enabledCapabilities', 'actions', 'sharingStatus', 'representativeBehavior'];
function fieldMetadata(value) {
  const encoded = JSON.stringify(value);
  return { sha256: digest(encoded), sizeBytes: Buffer.byteLength(encoded) };
}
export function validatePublishedConfiguration(configuration) {
  requireCondition(configuration?.schemaVersion === 1 && configuration.publication?.status === 'published' &&
    text(configuration.publication.version) && Number.isFinite(Date.parse(configuration.publication.publishedAt)), 'PUBLISHED_VERSION_REQUIRED');
  requireCondition(text(configuration.displayName) && text(configuration.description) && text(configuration.instructions) &&
    text(configuration.sharingStatus), 'BUILDER_TEXT_MISSING');
  for (const field of ['conversationStarters', 'enabledCapabilities', 'representativeBehavior']) {
    requireCondition(Array.isArray(configuration[field]) && configuration[field].every(text), 'BUILDER_LIST_INVALID');
  }
  requireCondition(configuration.representativeBehavior.length > 0, 'EXPECTED_BEHAVIOR_MISSING');
  requireCondition(Array.isArray(configuration.actions) && configuration.actions.every(action => text(action.name) &&
    action.schema && typeof action.schema === 'object' && !Array.isArray(action.schema)), 'ACTION_SCHEMA_MISSING');
  requireCondition(Array.isArray(configuration.knowledge), 'KNOWLEDGE_INVENTORY_MISSING');
  const names = new Set();
  for (const file of configuration.knowledge) {
    requireCondition(text(file.name) && !names.has(file.name), 'KNOWLEDGE_NAME_INVALID');
    names.add(file.name);
    relativeFile(file.path);
  }
  return configuration;
}
/** Produce hashes/metadata only: private instruction and Action contents never leave inputRoot. */
export async function captureBaseline(inputRoot, file = 'published-gpt.json') {
  const actual = await readSafeFile(inputRoot, file);
  const configuration = validatePublishedConfiguration(JSON.parse(actual.content));
  const knowledge = [];
  for (const item of configuration.knowledge) {
    const actualFile = await readSafeFile(inputRoot, item.path, maxFileSize, true);
    knowledge.push({ name: item.name, path: item.path, sha256: actualFile.sha256, sizeBytes: actualFile.sizeBytes });
  }
  return {
    schemaVersion: 1, status: 'IMPLEMENTED_NOT_VERIFIED', source: 'latest_published_gpt',
    publicationAssurance: 'USER_REPORTED',
    configuration: {
      path: file, sha256: actual.sha256, sizeBytes: actual.sizeBytes,
      publishedVersion: configuration.publication.version, publishedAt: configuration.publication.publishedAt,
      displayName: configuration.displayName,
      enabledCapabilities: configuration.enabledCapabilities,
      actions: configuration.actions.map(action => ({ name: action.name, schemaSha256: digest(JSON.stringify(action.schema)) })),
      fields: Object.fromEntries(builderFields.map(field => [field, fieldMetadata(configuration[field])]))
    },
    knowledge, missingInputs: []
  };
}
export function validateBaseline(inventory) {
  requireCondition(Object.keys(inventory).every(key => ['schemaVersion', 'status', 'source', 'publicationAssurance',
    'publicationReview', 'configuration', 'knowledge', 'missingInputs'].includes(key)), 'BASELINE_PRIVATE_FIELD_NOT_ALLOWED');
  requireCondition(inventory.schemaVersion === 1 && statuses.includes(inventory.status) && inventory.source === 'latest_published_gpt' &&
    Array.isArray(inventory.knowledge) && Array.isArray(inventory.missingInputs) && inventory.missingInputs.every(text), 'BASELINE_INVENTORY_INVALID');
  for (const item of inventory.knowledge) {
    validateArtifact(item);
    requireCondition(text(item.name) && Object.keys(item).every(key => ['name', 'path', 'sha256', 'sizeBytes'].includes(key)), 'KNOWLEDGE_NAME_INVALID');
  }
  if (inventory.configuration !== null) {
    requireCondition(Object.keys(inventory.configuration).every(key => ['path', 'sha256', 'sizeBytes', 'publishedVersion',
      'publishedAt', 'displayName', 'enabledCapabilities', 'actions', 'fields'].includes(key)), 'BASELINE_PRIVATE_FIELD_NOT_ALLOWED');
    validateArtifact(inventory.configuration);
    requireCondition(text(inventory.configuration.displayName) && text(inventory.configuration.publishedVersion) &&
      Number.isFinite(Date.parse(inventory.configuration.publishedAt)), 'BASELINE_PUBLICATION_MISSING');
    for (const field of builderFields) {
      const metadata = inventory.configuration.fields?.[field];
      requireCondition(isHash(metadata?.sha256) && Number.isSafeInteger(metadata.sizeBytes) && metadata.sizeBytes > 0 &&
        Object.keys(metadata).every(key => ['sha256', 'sizeBytes'].includes(key)), 'BASELINE_FIELD_MISSING');
    }
    requireCondition(Object.keys(inventory.configuration.fields).every(field => builderFields.includes(field)) &&
      Array.isArray(inventory.configuration.enabledCapabilities) && inventory.configuration.enabledCapabilities.every(text) &&
      Array.isArray(inventory.configuration.actions) && inventory.configuration.actions.every(action => text(action.name) &&
        isHash(action.schemaSha256) && Object.keys(action).every(key => ['name', 'schemaSha256'].includes(key))), 'BASELINE_SAFE_METADATA_INVALID');
  }
  requireCondition(inventory.status !== 'VERIFIED' || (inventory.configuration !== null && inventory.missingInputs.length === 0), 'BASELINE_VERIFICATION_UNSUPPORTED');
  if (inventory.status === 'VERIFIED') requireCondition(['USER_REPORTED', 'VERIFIED'].includes(inventory.publicationAssurance) &&
    reviewed(inventory.publicationReview) && inventory.publicationReview.latestPublishedConfirmed === true &&
    Array.isArray(inventory.publicationReview.evidenceIds) && inventory.publicationReview.evidenceIds.length > 0, 'PUBLICATION_REVIEW_MISSING');
  return inventory;
}

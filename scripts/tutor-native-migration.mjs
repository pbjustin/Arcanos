import { readdir } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { checkTutorPrivateBoundary } from './check-tutor-private-boundary.mjs';
import {
  baselineFingerprint, maxFileSize, noSymlinkAncestors, packageFingerprint,
  readSafeFile, relativeFile, requireCondition, reviewed, text, validateArtifact, verifyArtifact
} from './tutor-migration.mjs';

export const nativeMigrationFormat = 'CHATGPT_NATIVE_SKILLS_ONLY';
const keysEqual = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const sameArtifact = (left, right) => left?.path === right?.path && left?.sha256 === right?.sha256 &&
  left?.sizeBytes === right?.sizeBytes;

function bundlePath(migration, artifact) {
  const prefix = `${migration.capture.rootPath}/`;
  requireCondition(artifact.path.startsWith(prefix), 'NATIVE_ARTIFACT_OUTSIDE_CAPTURE');
  return relativeFile(artifact.path.slice(prefix.length));
}

export function nativeMigrationBinding(migration) {
  return {
    artifactFormat: nativeMigrationFormat, baselineFingerprint: migration.baselineFingerprint,
    pluginId: migration.capture.pluginId, cachePackageName: migration.capture.cachePackageName,
    version: migration.capture.version, skillSha256: migration.skill.sha256,
    metadataSha256: migration.metadata.sha256, packageFingerprint: migration.capture.packageFingerprint,
    appAttachment: 'NOT_ATTACHED'
  };
}

/** Validate reviewed safe metadata; this does not infer reconciliation or release. */
export function validateNativeMigration(migration, baseline, evidence, state) {
  requireCondition(migration.artifactFormat === nativeMigrationFormat &&
    Object.keys(migration).every(key => ['schemaVersion', 'status', 'artifactFormat', 'baselineFingerprint',
      'skill', 'metadata', 'appMapping', 'appAttachment', 'references', 'warnings', 'instructionComparison',
      'capture', 'accountReview', 'evidenceIds'].includes(key)), 'NATIVE_MIGRATION_FIELDS_INVALID');
  requireCondition(baseline.status === 'VERIFIED' &&
    migration.baselineFingerprint === baselineFingerprint(baseline), 'NATIVE_BASELINE_BINDING_INVALID');
  requireCondition(migration.appAttachment === 'NOT_ATTACHED' && migration.appMapping === null &&
    !Object.hasOwn(migration, 'registeredAppId'), 'NATIVE_APP_ATTACHMENT_INVALID');
  const capture = migration.capture;
  requireCondition(keysEqual(capture, ['pluginId', 'cachePackageName', 'version', 'rootPath', 'files',
    'packageFingerprint', 'receipt']) && [capture.pluginId, capture.cachePackageName, capture.version].every(text),
  'NATIVE_CAPTURE_INVALID');
  relativeFile(capture.rootPath);
  requireCondition(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/u.test(capture.pluginId) &&
    /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/u.test(capture.cachePackageName), 'NATIVE_IDENTITY_INVALID');
  requireCondition(Array.isArray(capture.files) && capture.files.length > 0 && capture.files.length <= 128,
    'NATIVE_FILE_INVENTORY_INVALID');
  const files = new Map();
  for (const artifact of capture.files) {
    requireCondition(keysEqual(artifact, ['path', 'sha256', 'sizeBytes']), 'NATIVE_FILE_METADATA_INVALID');
    validateArtifact(artifact);
    const relative = bundlePath(migration, artifact);
    requireCondition(!files.has(relative) && ![...files.keys()].some(file => file.toLowerCase() === relative.toLowerCase()),
      'NATIVE_DUPLICATE_FILE');
    requireCondition(!['.app.json', '.mcp.json', 'mcp.json'].includes(path.posix.basename(relative)),
      'NATIVE_APP_ATTACHMENT_INVALID');
    files.set(relative, artifact);
  }
  requireCondition([...files.values()].reduce((sum, file) => sum + file.sizeBytes, 0) <= 4 * maxFileSize,
    'NATIVE_PACKAGE_SIZE_EXCEEDED');
  requireCondition(packageFingerprint(files) === capture.packageFingerprint, 'NATIVE_PACKAGE_FINGERPRINT_INVALID');
  for (const artifact of [migration.skill, migration.metadata]) {
    validateArtifact(artifact);
    requireCondition(sameArtifact(files.get(bundlePath(migration, artifact)), artifact), 'NATIVE_ARTIFACT_INVENTORY_MISMATCH');
  }
  requireCondition(bundlePath(migration, migration.metadata) === '.codex-plugin/plugin.json' &&
    path.posix.basename(migration.skill.path) === 'SKILL.md' &&
    [...files.keys()].filter(file => path.posix.basename(file) === 'SKILL.md').length === 1,
  'NATIVE_PLUGIN_LAYOUT_INVALID');
  const skillDirectory = path.posix.dirname(bundlePath(migration, migration.skill));
  const supportedFiles = ['.codex-plugin/plugin.json', 'assets/gpt-icon.png', `${skillDirectory}/SKILL.md`,
    `${skillDirectory}/agents/openai.yaml`, `${skillDirectory}/lookup/knowledge-index.json`];
  requireCondition(JSON.stringify([...files.keys()].sort()) === JSON.stringify(supportedFiles.sort()),
    'NATIVE_FILE_LAYOUT_UNSUPPORTED');
  validateArtifact(capture.receipt);
  requireCondition(bundlePath(migration, capture.receipt) === 'capture-review.json' &&
    !files.has('capture-review.json'), 'NATIVE_CAPTURE_RECEIPT_INVALID');
  requireCondition(reviewed(migration.accountReview) && migration.accountReview.confirmedMigrated === true &&
    migration.accountReview.confirmedWarningsReviewed === true, 'NATIVE_ACCOUNT_REVIEW_MISSING');
  requireCondition(Array.isArray(migration.evidenceIds) && migration.evidenceIds.length > 0 &&
    new Set(migration.evidenceIds).size === migration.evidenceIds.length, 'NATIVE_ACCOUNT_EVIDENCE_MISSING');
  const binding = nativeMigrationBinding(migration);
  for (const id of migration.evidenceIds) {
    const observed = evidence.get(id);
    requireCondition(observed?.kind === 'chatgpt' && observed.status === 'VERIFIED' &&
      keysEqual(observed.migrationBinding, Object.keys(binding)) &&
      Object.entries(binding).every(([key, value]) => observed.migrationBinding[key] === value),
    'NATIVE_ACCOUNT_BINDING_INVALID');
  }
  if (state.gates.GPT_MIGRATED.status === 'VERIFIED') requireCondition(
    state.gates.GPT_MIGRATED.evidenceIds.length === migration.evidenceIds.length &&
    state.gates.GPT_MIGRATED.evidenceIds.every(id => migration.evidenceIds.includes(id)),
  'NATIVE_ACCOUNT_GATE_MISMATCH');
  return { files, binding };
}

async function capturedFiles(root) {
  await noSymlinkAncestors(root);
  const result = [];
  async function visit(relative = '') {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      requireCondition(!entry.isSymbolicLink(), 'SYMLINK_NOT_ALLOWED');
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      relativeFile(file);
      if (entry.isDirectory()) await visit(file);
      else {
        requireCondition(entry.isFile(), 'NATIVE_FILE_TYPE_INVALID');
        result.push(file);
        requireCondition(result.length <= 129, 'NATIVE_FILE_INVENTORY_INVALID');
      }
    }
  }
  await visit();
  return result.sort();
}

/** Inspect unchanged native bytes even when other release gates are blocked. */
async function inspectNativeMigrationBytes({ inputRoot, migration, baseline, evidence, state }) {
  const { files } = validateNativeMigration(migration, baseline, evidence, state);
  const actualNames = await capturedFiles(path.resolve(inputRoot, migration.capture.rootPath));
  requireCondition(JSON.stringify(actualNames) === JSON.stringify([...files.keys(), 'capture-review.json'].sort()),
    'NATIVE_CAPTURE_INVENTORY_MISMATCH');
  for (const artifact of files.values()) {
    const actual = await readSafeFile(inputRoot, artifact.path, maxFileSize, true);
    requireCondition(actual.sha256 === artifact.sha256 && actual.sizeBytes === artifact.sizeBytes,
      'ARTIFACT_DIGEST_MISMATCH');
  }
  await verifyArtifact(inputRoot, baseline.configuration);
  const receipt = JSON.parse((await verifyArtifact(inputRoot, migration.capture.receipt)).content);
  const expectedReceiptFiles = [...files].map(([file, artifact]) => ({ ...artifact, path: file }));
  requireCondition(receipt.schemaVersion === 1 && receipt.sourceKind === 'INSTALLED_PLUGIN_CACHE' &&
    receipt.copyByteIdentity === true && Number.isFinite(Date.parse(receipt.capturedAt)) &&
    ['pluginId', 'cachePackageName', 'version', 'packageFingerprint'].every(key => receipt[key] === migration.capture[key]) &&
    receipt.baselineFingerprint === migration.baselineFingerprint &&
    Array.isArray(receipt.files) && receipt.files.length === expectedReceiptFiles.length &&
    receipt.files.every((file, index) => sameArtifact(file, expectedReceiptFiles[index])), 'NATIVE_CAPTURE_RECEIPT_MISMATCH');
  const manifest = JSON.parse((await verifyArtifact(inputRoot, migration.metadata)).content);
  const interfaceFields = ['capabilities', 'category', 'composerIcon', 'defaultPrompt', 'developerName', 'displayName',
    'logo', 'longDescription', 'shortDescription'];
  requireCondition(keysEqual(manifest, ['author', 'description', 'interface', 'name', 'skills', 'version']) &&
    keysEqual(manifest.author, ['name']) && text(manifest.author.name) && text(manifest.description) &&
    manifest.interface && typeof manifest.interface === 'object' && !Array.isArray(manifest.interface) &&
    Object.keys(manifest.interface).every(key => interfaceFields.includes(key)) && text(manifest.interface.displayName) &&
    JSON.stringify(manifest.interface.capabilities) === JSON.stringify(['skills']) &&
    ['category', 'developerName', 'longDescription', 'shortDescription'].every(key =>
      manifest.interface[key] === undefined || text(manifest.interface[key])) &&
    ['composerIcon', 'logo'].every(key => manifest.interface[key] === undefined ||
      ['assets/gpt-icon.png', './assets/gpt-icon.png'].includes(manifest.interface[key])) &&
    (manifest.interface.defaultPrompt === undefined || (Array.isArray(manifest.interface.defaultPrompt) &&
      manifest.interface.defaultPrompt.every(text))) &&
    manifest.name === migration.capture.cachePackageName && manifest.version === migration.capture.version && text(manifest.skills),
  'NATIVE_MANIFEST_INVALID');
  const skillsRoot = relativeFile(manifest.skills.replace(/^\.\//u, '').replace(/\/$/u, ''));
  const skillRelative = bundlePath(migration, migration.skill);
  requireCondition(skillRelative.startsWith(`${skillsRoot}/`) &&
    !skillRelative.slice(skillsRoot.length + 1).startsWith('/'), 'NATIVE_SKILL_PATH_MISMATCH');
  const indexPath = path.posix.join(path.posix.dirname(skillRelative), 'lookup/knowledge-index.json');
  const indexArtifact = files.get(indexPath);
  requireCondition(indexArtifact, 'NATIVE_KNOWLEDGE_INDEX_MISSING');
  const knowledge = JSON.parse((await verifyArtifact(inputRoot, indexArtifact)).content);
  // Only the observed empty native index is supported. Nonempty formats need
  // actual-file review, never an inference that native references did not exist.
  requireCondition(keysEqual(knowledge, ['files']) && Array.isArray(knowledge.files) && knowledge.files.length === 0 &&
    migration.references.length === 0 && baseline.knowledge.length === 0, 'NATIVE_REFERENCE_FORMAT_UNSUPPORTED');
  const agentPath = path.posix.join(path.posix.dirname(skillRelative), 'agents/openai.yaml');
  const agent = yaml.load((await verifyArtifact(inputRoot, files.get(agentPath))).content);
  requireCondition(keysEqual(agent, ['interface']) && keysEqual(agent.interface, ['display_name', 'short_description']) &&
    text(agent.interface.display_name) && text(agent.interface.short_description), 'NATIVE_AGENT_METADATA_UNSUPPORTED');
  await verifyArtifact(inputRoot, migration.skill);
  return { artifactFormat: nativeMigrationFormat, artifactInspection: 'VERIFIED',
    packageFingerprint: migration.capture.packageFingerprint, fileCount: files.size, appAttachment: 'NOT_ATTACHED' };
}

export async function inspectNativeMigration(options) {
  try {
    await checkTutorPrivateBoundary(options.inputRoot);
    return await inspectNativeMigrationBytes(options);
  } catch (error) {
    // Parsers and filesystem errors may include private excerpts or paths.
    // Only our bounded diagnostic codes may escape this inspection API.
    throw new Error(/^[A-Z][A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : 'NATIVE_PRIVATE_INPUT_INVALID');
  }
}

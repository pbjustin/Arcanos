import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import yaml from 'js-yaml';
import { validateSkillFirst } from './validate-tutor-skill-first.mjs';
import {
  baselineFingerprint, captureBaseline, categories, digest, endpoint, gates, isHash, noSymlinkAncestors, packageFingerprint,
  readSafeFile, relativeFile, requireCondition, reviewed, skillPath, statuses, text,
  validateArtifact, validateBaseline, verifyArtifact
} from './tutor-migration.mjs';

const schemaFile = 'schemas/agent-plugins-1.0.0.schema.json';
const schemaDigest = '0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883';
// Non-secret registration observed in the authorized ChatGPT setup. Changing the
// account registration requires a reviewed update to this pin and its evidence;
// this offline check does not itself contact or authenticate to ChatGPT.
const registeredAppId = 'asdk_app_6ab4747769088191856fd8eb02507240';
const sidecars = ['connection.requirements.json', 'migration-state.json', 'baseline.inventory.json',
  'migration.inventory.json', 'parity-matrix.json', 'reference-review.json'];
const connectionChecks = ['registeredConnection', 'endpoint', 'authentication', 'toolDiscovery', 'liveExecution'];
const crossCapability = /\b(?:ARCANOS[: _-](?:GAMING|CORE)|BACKSTAGE[: _-]BOOKER|arcanos_(?:gaming|core)[a-z0-9_]*|(?:gaming|backstage|booker|operator)_[a-z0-9_]+|(?:modules|memory|jobs|dag|canon|operator)\.[a-z0-9_.]+)\b/iu;
const unresolved = /(?:\b(?:TODO|TBD|REPLACE_ME|YOUR_APP_ID)\b|<[^>]*(?:app[_ -]?id|placeholder)[^>]*>|\$\{[^}]+\})/iu;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const normalize = value => value.replace(/\r\n/gu, '\n').trim();

function tutorAppMapping(mapping, appId, allowMigratedAlias = false) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || !equal(Object.keys(mapping), ['apps']) ||
    !mapping.apps || typeof mapping.apps !== 'object' || Array.isArray(mapping.apps)) return false;
  const aliases = Object.keys(mapping.apps);
  if (aliases.length !== 1 || !text(aliases[0]) || (!allowMigratedAlias && aliases[0] !== 'arcanos-tutor')) return false;
  const app = mapping.apps[aliases[0]];
  // OpenAI's published optional-app example uses optional:true with no required
  // flag. The portable schema leaves this extension opaque; enforce it here.
  return app && typeof app === 'object' && !Array.isArray(app) && equal(Object.keys(app).sort(), ['id', 'optional']) &&
    app.id === appId && app.optional === true;
}

function validateEvidence(connection, state) {
  requireCondition(connection.schemaVersion === 1 && connection.endpoint === endpoint && equal(connection.toolNames, ['arcanos_tutor']), 'CONNECTION_CONTRACT_INVALID');
  requireCondition(equal(connection.usagePolicy, { defaultTeachingPath: 'skill_only', appRequired: false,
    backendInvocation: 'explicit_request_only', uniqueBackendCapabilities: [], scope: 'arcanos:tutor' }),
  'OPTIONAL_BACKEND_USAGE_POLICY_INVALID');
  requireCondition(connection.registeredAppId === registeredAppId &&
    connection.technicalId === `plugin_${connection.registeredAppId}`, 'REGISTERED_APP_ID_INVALID');
  requireCondition(Array.isArray(connection.evidence) && connection.evidence.length > 0, 'EVIDENCE_MISSING');
  const evidence = new Map();
  for (const item of connection.evidence) {
    requireCondition(text(item.id) && !evidence.has(item.id) && ['repository', 'railway', 'chatgpt', 'auth0', 'user_reported'].includes(item.kind) &&
      statuses.includes(item.status) && text(item.summary) && Number.isFinite(Date.parse(item.observedAt)), 'EVIDENCE_INVALID');
    requireCondition(item.kind !== 'user_reported' || item.status !== 'VERIFIED', 'USER_REPORT_IS_NOT_VERIFICATION');
    evidence.set(item.id, item);
  }
  const validateClaim = (claim, allowHostCapabilityExclusion = false) => {
    const excluded = allowHostCapabilityExclusion && claim?.status === 'NOT_APPLICABLE';
    requireCondition(claim && (statuses.includes(claim.status) || excluded) && Array.isArray(claim.evidenceIds) &&
      claim.evidenceIds.every(id => evidence.has(id)), 'EVIDENCE_REFERENCE_INVALID');
    if (excluded) requireCondition(claim.evidenceIds.length > 0 && claim.evidenceIds.every(id =>
      evidence.get(id).kind === 'user_reported' && evidence.get(id).status === 'USER_REPORTED'),
    'CAPABILITY_SCOPE_EVIDENCE_INVALID');
    if (['VERIFIED', 'USER_REPORTED'].includes(claim.status)) requireCondition(claim.evidenceIds.length > 0, 'CLAIM_EVIDENCE_MISSING');
    if (claim.status === 'VERIFIED') requireCondition(claim.evidenceIds.some(id => evidence.get(id).status === 'VERIFIED' && evidence.get(id).kind !== 'user_reported'), 'VERIFICATION_EVIDENCE_MISSING');
  };
  requireCondition(equal(Object.keys(connection.checks ?? {}).sort(), [...connectionChecks].sort()), 'CONNECTION_CHECKS_INVALID');
  for (const name of connectionChecks) validateClaim(connection.checks[name]);
  const permittedKinds = {
    registeredConnection: ['chatgpt'], endpoint: ['chatgpt'], authentication: ['chatgpt', 'auth0'],
    toolDiscovery: ['chatgpt'], liveExecution: ['chatgpt']
  };
  for (const name of connectionChecks) {
    const claim = connection.checks[name];
    if (claim.status === 'VERIFIED') requireCondition(claim.evidenceIds.some(id => evidence.get(id).status === 'VERIFIED' &&
      permittedKinds[name].includes(evidence.get(id).kind)), 'CONNECTION_EVIDENCE_DOMAIN_INVALID');
  }
  requireCondition(statuses.includes(connection.builderReconciliation) && statuses.includes(connection.referenceReconciliation), 'RECONCILIATION_STATUS_INVALID');
  requireCondition(state.schemaVersion === 1 && equal(Object.keys(state.gates ?? {}).sort(), [...gates].sort()), 'MIGRATION_GATES_INVALID');
  for (const gate of gates) {
    validateClaim(state.gates[gate], gate === 'CAPABILITY_EQUIVALENCE_VERIFIED');
    requireCondition(text(state.gates[gate].note), 'GATE_NOTE_MISSING');
  }
  const gateKinds = { CODE_READY: ['repository'], BACKEND_DEPLOYED: ['railway'], OAUTH_CONFIGURED: ['auth0', 'chatgpt'],
    CHATGPT_CONNECTION_REGISTERED: ['chatgpt'], TOOL_DISCOVERY_VERIFIED: ['chatgpt'], LIVE_TUTOR_CALL_VERIFIED: ['chatgpt'],
    GPT_BASELINE_CAPTURED: ['repository', 'chatgpt'], GPT_MIGRATED: ['chatgpt'], SKILL_RECONCILED: ['repository', 'chatgpt'],
    TUTOR_SKILL_COMPOSED: ['repository'], TUTOR_SKILL_RECONCILED: ['repository'],
    TUTOR_SKILL_BEHAVIOR_VERIFIED: ['chatgpt'], CAPABILITY_EQUIVALENCE_VERIFIED: ['chatgpt'],
    BACKEND_APP_REGISTERED: ['chatgpt'], BACKEND_APP_OPTIONALITY_VERIFIED: ['repository'],
    MIGRATED_SKILL_RECONCILED: ['repository', 'chatgpt'],
    REFERENCES_RECONCILED: ['repository', 'chatgpt'], PARITY_VERIFIED: ['chatgpt'], PACKAGE_READY: ['repository'], RELEASE_READY: ['repository'] };
  for (const gate of gates) if (state.gates[gate].status === 'VERIFIED') requireCondition(state.gates[gate].evidenceIds.some(id =>
    evidence.get(id).status === 'VERIFIED' && gateKinds[gate].includes(evidence.get(id).kind)), 'GATE_EVIDENCE_DOMAIN_INVALID');
  const dependencies = { GPT_MIGRATED: ['GPT_BASELINE_CAPTURED', 'CHATGPT_CONNECTION_REGISTERED', 'TOOL_DISCOVERY_VERIFIED'],
    TUTOR_SKILL_COMPOSED: ['GPT_BASELINE_CAPTURED'], TUTOR_SKILL_RECONCILED: ['TUTOR_SKILL_COMPOSED'],
    TUTOR_SKILL_BEHAVIOR_VERIFIED: ['TUTOR_SKILL_RECONCILED'],
    CAPABILITY_EQUIVALENCE_VERIFIED: ['GPT_BASELINE_CAPTURED'],
    BACKEND_APP_REGISTERED: ['CHATGPT_CONNECTION_REGISTERED'],
    MIGRATED_SKILL_RECONCILED: ['GPT_MIGRATED', 'TUTOR_SKILL_RECONCILED'],
    SKILL_RECONCILED: ['GPT_BASELINE_CAPTURED', 'GPT_MIGRATED'], REFERENCES_RECONCILED: ['GPT_BASELINE_CAPTURED', 'GPT_MIGRATED'],
    PARITY_VERIFIED: ['SKILL_RECONCILED', 'REFERENCES_RECONCILED'], PACKAGE_READY: ['CODE_READY', 'PARITY_VERIFIED', 'LIVE_TUTOR_CALL_VERIFIED'],
    RELEASE_READY: gates.filter(gate => gate !== 'RELEASE_READY') };
  for (const [gate, prerequisites] of Object.entries(dependencies)) if (state.gates[gate].status === 'VERIFIED') requireCondition(
    prerequisites.every(prerequisite => state.gates[prerequisite].status === 'VERIFIED' ||
      // Only this gate supports owner exclusion. The exact scope and owner
      // evidence binding are validated by validateSkillFirst before any success.
      (prerequisite === 'CAPABILITY_EQUIVALENCE_VERIFIED' &&
        state.gates[prerequisite].status === 'NOT_APPLICABLE')), 'GATE_DEPENDENCY_NOT_VERIFIED');
  for (const [gate, check] of Object.entries({ CHATGPT_CONNECTION_REGISTERED: 'registeredConnection', BACKEND_APP_REGISTERED: 'registeredConnection', OAUTH_CONFIGURED: 'authentication', TOOL_DISCOVERY_VERIFIED: 'toolDiscovery', LIVE_TUTOR_CALL_VERIFIED: 'liveExecution' })) {
    requireCondition(state.gates[gate].status === connection.checks[check].status, 'CONNECTION_STATE_CONTRADICTION');
  }
  return evidence;
}

function validateMigration(migration) {
  requireCondition(migration.schemaVersion === 1 && statuses.includes(migration.status) && Array.isArray(migration.references) &&
    Array.isArray(migration.warnings) && migration.warnings.every(text), 'MIGRATION_INVENTORY_INVALID');
  for (const name of ['skill', 'metadata', 'appMapping']) if (migration[name] !== null) validateArtifact(migration[name]);
  const referencePaths = new Set();
  for (const artifact of migration.references) {
    validateArtifact(artifact);
    requireCondition(text(artifact.name) && !referencePaths.has(artifact.path), 'REFERENCE_NAME_MISSING');
    referencePaths.add(artifact.path);
  }
  requireCondition(migration.status !== 'VERIFIED' || (migration.skill && migration.metadata && migration.appMapping), 'MIGRATION_ARTIFACTS_MISSING');
  requireCondition(migration.status !== 'VERIFIED' || text(migration.registeredAppId), 'MIGRATION_CONNECTION_MISSING');
  if (migration.instructionComparison !== null) {
    const comparison = migration.instructionComparison;
    requireCondition(comparison.status === 'VERIFIED' && reviewed(comparison) &&
      ['PASS', 'ACCEPTED_DIFFERENCE'].includes(comparison.disposition) && text(comparison.summary) &&
      ['baselineInstructionsSha256', 'migratedSkillSha256', 'packagedSkillSha256'].every(key => isHash(comparison[key])), 'INSTRUCTION_REVIEW_INVALID');
  }
}

function ownerAccepted(acceptance, bindings) {
  return acceptance?.accepted === true && text(acceptance.acceptedBy) && Number.isFinite(Date.parse(acceptance.acceptedAt)) &&
    text(acceptance.reason) && Object.entries(bindings).every(([key, value]) => acceptance[key] === value);
}

function validateParity(parity, evidence) {
  requireCondition(parity.schemaVersion === 1 && statuses.includes(parity.status) && Array.isArray(parity.cases) &&
    Array.isArray(parity.liveEvidenceIds) && parity.liveEvidenceIds.every(id => evidence.has(id)), 'PARITY_MATRIX_INVALID');
  const ids = new Set();
  const covered = new Set();
  for (const item of parity.cases) {
    requireCondition(text(item.id) && !ids.has(item.id) && categories.includes(item.category) &&
      text(item.prompt) && text(item.expected) && ['PASS', 'ACCEPTED_DIFFERENCE', 'BLOCKER'].includes(item.disposition), 'PARITY_CASE_INVALID');
    ids.add(item.id);
    covered.add(item.category);
    requireCondition(item.toolInvoked === null || item.toolInvoked === 'arcanos_tutor', 'PARITY_TOOL_INVALID');
    for (const side of ['oldGpt', 'plugin']) {
      const result = item[side];
      if (result !== null) {
        requireCondition(statuses.includes(result.status) && text(result.summary) && result.sha256 === digest(result.summary) &&
          result.hashBasis === 'sanitized_summary' && Array.isArray(result.evidenceIds) && result.evidenceIds.length > 0 &&
          result.evidenceIds.every(id => evidence.has(id) && ['chatgpt', 'user_reported'].includes(evidence.get(id).kind)), 'PARITY_RESULT_PROVENANCE_INVALID');
        requireCondition(isHash(result.artifactSha256) && isHash(result.configurationFingerprint), 'PARITY_ARTIFACT_BINDING_MISSING');
        if (result.status === 'VERIFIED') requireCondition(result.evidenceIds.some(id => {
          const observed = evidence.get(id);
          const binding = observed.parityBinding;
          return observed.kind === 'chatgpt' && observed.status === 'VERIFIED' && binding?.caseId === item.id &&
            binding.side === side && binding.promptSha256 === digest(item.prompt) &&
            binding.configurationFingerprint === result.configurationFingerprint && binding.summarySha256 === result.sha256;
        }), 'PARITY_OBSERVATION_BINDING_MISSING');
      }
    }
    if (item.disposition !== 'BLOCKER') {
      requireCondition(item.oldGpt && item.plugin && text(item.materialDifference) && reviewed(item), 'PARITY_COMPARISON_MISSING');
      if (['authentication', 'unavailable', 'timeout', 'cancellation'].includes(item.category)) {
        requireCondition(item.toolInvoked === 'arcanos_tutor', 'PARITY_TUTOR_EXECUTION_MISSING');
      }
      if (['direct', 'indirect', 'concise', 'structured', 'difficult', 'exact_format', 'follow_up', 'references', 'non_activation', 'memory', 'admin', 'clarification'].includes(item.category)) {
        requireCondition(item.toolInvoked === null, 'PARITY_UNEXPECTED_EXECUTION');
      }
    }
    if (item.disposition === 'ACCEPTED_DIFFERENCE') requireCondition(ownerAccepted(item.ownerAcceptance, {
      promptSha256: digest(item.prompt), oldFingerprint: item.oldGpt.configurationFingerprint,
      pluginFingerprint: item.plugin.configurationFingerprint
    }), 'PARITY_OWNER_ACCEPTANCE_MISSING');
  }
  requireCondition(categories.every(category => covered.has(category)), 'PARITY_COVERAGE_MISSING');
  requireCondition(parity.status !== 'VERIFIED' || parity.cases.every(item => item.disposition !== 'BLOCKER'), 'PARITY_BLOCKERS_REMAIN');
  requireCondition(parity.status !== 'VERIFIED' || parity.cases.every(item => item.oldGpt?.status === 'VERIFIED' && item.plugin?.status === 'VERIFIED'), 'PARITY_UNVERIFIED_PAIR');
}

function validateReferences(review) {
  requireCondition(review.schemaVersion === 1 && Array.isArray(review.references), 'REFERENCE_REVIEW_INVALID');
  const paths = new Set();
  const sources = new Set();
  for (const item of review.references) {
    relativeFile(item.sourcePath);
    relativeFile(item.packagePath);
    requireCondition(item.packagePath.startsWith('skills/arcanos-tutor/references/') && /\.(?:md|txt|json|csv)$/u.test(item.packagePath) &&
      !paths.has(item.packagePath) && !sources.has(item.sourcePath) && item.approvedForRepository === true && reviewed(item) &&
      isHash(item.sha256) && Number.isSafeInteger(item.sizeBytes) && item.sizeBytes > 0, 'REFERENCE_APPROVAL_MISSING');
    paths.add(item.packagePath);
    sources.add(item.sourcePath);
  }
}

async function readPackage(root, references) {
  const packageRoot = path.join(root, 'package');
  await noSymlinkAncestors(packageRoot);
  const allowed = new Set(['plugin.json', '.app.json', skillPath, ...references.map(item => item.packagePath)]);
  const directories = new Set(['skills', 'skills/arcanos-tutor']);
  for (const file of allowed) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/'));
  }
  const files = new Map();
  async function visit(relative = '') {
    for (const entry of await readdir(path.join(packageRoot, relative), { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      await noSymlinkAncestors(path.join(packageRoot, file));
      if (entry.isDirectory()) {
        requireCondition(directories.has(file), 'UNEXPECTED_DIRECTORY');
        await visit(file);
      } else {
        requireCondition(allowed.has(file), 'UNEXPECTED_FILE');
        const actual = await readSafeFile(packageRoot, file);
        requireCondition(!unresolved.test(actual.content), 'UNRESOLVED_PLACEHOLDER');
        requireCondition(!crossCapability.test(actual.content), 'CROSS_PLUGIN_CAPABILITY');
        files.set(file, actual);
      }
    }
  }
  await visit();
  requireCondition(files.size === allowed.size, 'MISSING_REQUIRED_FILE');
  requireCondition([...files.values()].reduce((total, file) => total + file.sizeBytes, 0) <= 4 * 1024 * 1024, 'PACKAGE_SIZE_EXCEEDED');
  for (const item of references) requireCondition(files.get(item.packagePath).sha256 === item.sha256 &&
    files.get(item.packagePath).sizeBytes === item.sizeBytes, 'REFERENCE_DIGEST_MISMATCH');
  return files;
}

async function verifyInputs(inputRoot, baseline, migration, referenceReview, parity, files, validateManifest) {
  const packagedSkill = files.get(skillPath);
  const captured = await captureBaseline(inputRoot, baseline.configuration.path);
  requireCondition(equal(captured.configuration, baseline.configuration) && equal(captured.knowledge, baseline.knowledge), 'BASELINE_INPUT_MISMATCH');
  const migratedSkill = await verifyArtifact(inputRoot, migration.skill);
  const metadata = JSON.parse((await verifyArtifact(inputRoot, migration.metadata)).content);
  const configuration = JSON.parse((await verifyArtifact(inputRoot, baseline.configuration)).content);
  requireCondition(validateManifest(metadata) && metadata.name === 'arcanos-tutor' &&
    metadata.$schema === 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'MIGRATED_METADATA_MISMATCH');
  const mappingPointer = metadata.extensions?.['com.openai']?.apps;
  requireCondition(text(mappingPointer), 'MIGRATED_APP_MAPPING_MISSING');
  const mappingRelative = relativeFile(mappingPointer.replace(/^\.\//u, ''));
  const mappingPath = relativeFile(path.posix.join(path.posix.dirname(migration.metadata.path), mappingRelative));
  requireCondition(mappingPath === migration.appMapping.path, 'MIGRATED_APP_MAPPING_PATH_MISMATCH');
  const migratedMapping = JSON.parse((await verifyArtifact(inputRoot, migration.appMapping)).content);
  requireCondition(tutorAppMapping(migratedMapping, migration.registeredAppId, true), 'MIGRATED_APP_MAPPING_INVALID');
  requireCondition(reviewed(migration.accountReview) && migration.accountReview.confirmedMigrated === true &&
    migration.accountReview.confirmedWarningsReviewed === true, 'MIGRATION_ACCOUNT_REVIEW_MISSING');
  const comparison = migration.instructionComparison;
  requireCondition(comparison.baselineInstructionsSha256 === baseline.configuration.fields.instructions.sha256 &&
    comparison.migratedSkillSha256 === migratedSkill.sha256 && comparison.packagedSkillSha256 === packagedSkill.sha256, 'INSTRUCTION_REVIEW_STALE');
  if (comparison.disposition === 'PASS') requireCondition(normalize(migratedSkill.content).includes(normalize(configuration.instructions)) &&
    normalize(packagedSkill.content).includes(normalize(configuration.instructions)), 'INSTRUCTIONS_NOT_PRESERVED');
  else requireCondition(ownerAccepted(comparison.ownerAcceptance, {
    baselineInstructionsSha256: comparison.baselineInstructionsSha256,
    migratedSkillSha256: migratedSkill.sha256, packagedSkillSha256: packagedSkill.sha256
  }), 'INSTRUCTION_OWNER_ACCEPTANCE_MISSING');
  requireCondition(normalize(packagedSkill.content).includes(normalize(migratedSkill.content).replace(/^---\n[\s\S]*?\n---\n/u, '').trim()), 'MIGRATED_SKILL_NOT_INCLUDED');
  requireCondition(reviewed(migration.skill) && migration.skill.approvedForPrivateRelease === true,
    'MIGRATED_SKILL_PRIVATE_RELEASE_NOT_APPROVED');
  const originals = new Map(baseline.knowledge.map(item => [item.name, item]));
  const migrated = new Map();
  for (const item of migration.references) {
    requireCondition(!migrated.has(item.name), 'DUPLICATE_REFERENCE');
    await verifyArtifact(inputRoot, item);
    migrated.set(item.name, item);
  }
  requireCondition(originals.size === migrated.size, 'REFERENCE_COUNT_MISMATCH');
  for (const [name, original] of originals) {
    const current = migrated.get(name);
    requireCondition(current && original.sha256 === current.sha256 && original.sizeBytes === current.sizeBytes, 'REFERENCE_PARITY_MISMATCH');
  }
  requireCondition(referenceReview.references.length === migration.references.length, 'UNREVIEWED_REFERENCE');
  for (const item of referenceReview.references) {
    const current = migration.references.find(reference => reference.path === item.sourcePath);
    requireCondition(current && current.sha256 === item.sha256 && current.sizeBytes === item.sizeBytes, 'REFERENCE_REVIEW_STALE');
  }
  for (const item of parity.cases) {
    requireCondition(item.oldGpt.artifactSha256 === baseline.configuration.sha256 && item.plugin.artifactSha256 === migratedSkill.sha256 &&
      item.oldGpt.configurationFingerprint === baselineFingerprint(baseline) &&
      item.plugin.configurationFingerprint === packageFingerprint(files), 'PARITY_RESULT_STALE');
  }
}

/** Validates source and evidence without network access or account mutations. */
export async function validateArcanosTutorPackage(root, { inputRoot } = {}) {
  await noSymlinkAncestors(root);
  const records = {};
  for (const name of sidecars) records[name] = JSON.parse((await readSafeFile(root, name)).content);
  const connection = records['connection.requirements.json'];
  const state = records['migration-state.json'];
  const baseline = validateBaseline(records['baseline.inventory.json']);
  const migration = records['migration.inventory.json'];
  const parity = records['parity-matrix.json'];
  const review = records['reference-review.json'];
  const evidence = validateEvidence(connection, state);
  if (baseline.publicationReview) requireCondition(baseline.publicationReview.evidenceIds.every(id => evidence.has(id) &&
    ['chatgpt', 'user_reported'].includes(evidence.get(id).kind)), 'PUBLICATION_REVIEW_PROVENANCE_INVALID');
  validateMigration(migration);
  validateParity(parity, evidence);
  validateReferences(review);
  const gateConsistent = (gate, condition) => requireCondition(state.gates[gate].status !== 'VERIFIED' || condition, 'GATE_STATE_CONTRADICTION');
  gateConsistent('GPT_BASELINE_CAPTURED', baseline.status === 'VERIFIED');
  gateConsistent('GPT_MIGRATED', migration.status === 'VERIFIED' && migration.skill && migration.metadata);
  gateConsistent('SKILL_RECONCILED', migration.instructionComparison !== null && connection.builderReconciliation === 'VERIFIED');
  gateConsistent('REFERENCES_RECONCILED', connection.referenceReconciliation === 'VERIFIED' && baseline.status === 'VERIFIED' && migration.status === 'VERIFIED');
  gateConsistent('PARITY_VERIFIED', parity.status === 'VERIFIED');
  const files = await readPackage(root, review.references);
  const skillFirst = await validateSkillFirst({ root, inputRoot, baseline, state, evidence,
    templateFiles: files, referenceReview: review });
  const schema = await readSafeFile(root, schemaFile);
  requireCondition(digest(schema.content.replace(/\r\n/gu, '\n')) === schemaDigest, 'SCHEMA_DIGEST_MISMATCH');
  const manifest = JSON.parse(files.get('plugin.json').content);
  const validator = new Ajv2020({ allErrors: true, strict: true }).compile(JSON.parse(schema.content));
  requireCondition(validator(manifest), 'MANIFEST_SCHEMA_INVALID');
  requireCondition(manifest.name === 'arcanos-tutor' && !/pilot/iu.test(manifest.description ?? '') &&
    equal(Object.keys(manifest.extensions ?? {}), ['com.openai']), 'MANIFEST_IDENTITY_INVALID');
  const extension = manifest.extensions['com.openai'];
  const interfaceFields = ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category', 'capabilities', 'defaultPrompt'];
  requireCondition(equal(Object.keys(extension).sort(), ['apps', 'interface']) && extension.apps === './.app.json' &&
    Object.keys(extension.interface ?? {}).every(key => interfaceFields.includes(key)) && extension.interface.displayName === 'ARCANOS TUTOR' &&
    (extension.interface.capabilities === undefined || equal(extension.interface.capabilities, ['Read'])) &&
    (extension.interface.defaultPrompt === undefined || (Array.isArray(extension.interface.defaultPrompt) &&
      extension.interface.defaultPrompt.every(text))), 'OPENAI_EXTENSION_INVALID');
  const mapping = JSON.parse(files.get('.app.json').content);
  requireCondition(tutorAppMapping(mapping, connection.registeredAppId), 'APP_MAPPING_INVALID');
  const skill = files.get(skillPath);
  const frontmatter = skill.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  requireCondition(frontmatter, 'SKILL_FRONTMATTER_MISSING');
  const skillMetadata = yaml.load(frontmatter[1]);
  requireCondition(skillMetadata?.name === 'arcanos-tutor' && text(skillMetadata.description) && skillMetadata.description.length <= 1024 &&
    equal(Object.keys(skillMetadata).sort(), ['description', 'name']) && text(skill.content.slice(frontmatter[0].length)), 'SKILL_METADATA_INVALID');
  const mentionedTools = new Set(skill.content.match(/\barcanos_[a-z][a-z0-9_]*/gu) ?? []);
  requireCondition(equal([...mentionedTools], ['arcanos_tutor']), 'SKILL_TOOL_DEPENDENCY_INVALID');

  const blockers = [...skillFirst.blockers];
  const block = (condition, code) => { if (!condition) blockers.push(code); };
  // Package/release are derived after artifact inspection, not prerequisites that
  // operators have to self-certify before invoking this validator.
  for (const gate of gates.slice(0, -2)) block(state.gates[gate].status === 'VERIFIED' ||
    (gate === 'CAPABILITY_EQUIVALENCE_VERIFIED' && skillFirst.capabilityScopeExcluded &&
      skillFirst.capabilityRequirementSatisfied), gate);
  block(baseline.status === 'VERIFIED', 'PUBLISHED_BASELINE_MISSING');
  block(migration.status === 'VERIFIED' && migration.skill && migration.metadata, 'MIGRATED_ARTIFACTS_MISSING');
  block(migration.instructionComparison !== null && connection.builderReconciliation === 'VERIFIED', 'SKILL_RECONCILIATION_MISSING');
  block(connection.referenceReconciliation === 'VERIFIED', 'REFERENCE_RECONCILIATION_MISSING');
  block(parity.status === 'VERIFIED' && parity.cases.every(item => item.disposition !== 'BLOCKER'), 'PARITY_BLOCKERS_REMAIN');
  block(connectionChecks.every(name => connection.checks[name].status === 'VERIFIED'), 'CONNECTION_VERIFICATION_INCOMPLETE');
  block(parity.liveEvidenceIds.some(id => evidence.get(id).kind === 'chatgpt' && evidence.get(id).status === 'VERIFIED' &&
    connection.checks.liveExecution.evidenceIds.includes(id)), 'LIVE_CHATGPT_EVIDENCE_MISSING');
  block(Boolean(inputRoot), 'ACTUAL_INPUT_ARTIFACTS_NOT_INSPECTED');
  if (migration.registeredAppId !== undefined) requireCondition(migration.registeredAppId === connection.registeredAppId, 'MIGRATION_CONNECTION_MISMATCH');
  gateConsistent('MIGRATED_SKILL_RECONCILED', migration.instructionComparison !== null && connection.builderReconciliation === 'VERIFIED');
  if (inputRoot && blockers.length === 0) await verifyInputs(inputRoot, baseline, migration, review, parity, skillFirst.privateFiles, validator);
  return {
    sourceValidation: 'PASS', releaseStatus: blockers.length === 0 ? 'VERIFIED' : 'BLOCKED',
    releaseBlockers: [...new Set(blockers)], archiveWritten: false,
    gates: Object.fromEntries(gates.map(gate => [gate, ['PACKAGE_READY', 'RELEASE_READY'].includes(gate) ?
      (blockers.length === 0 ? 'VERIFIED' : 'BLOCKED') : state.gates[gate].status])),
    packageFingerprint: packageFingerprint(files),
    artifactKind: 'PUBLIC_TEMPLATE',
    privatePackageFingerprint: skillFirst.composition.packageFingerprint,
    skillOnlyTeachingReadiness: skillFirst.teachingReadiness,
    capabilityEquivalenceVerified: skillFirst.capabilitiesVerified,
    capabilityScopeExcluded: skillFirst.capabilityScopeExcluded,
    backendReadiness: skillFirst.backendReadiness,
    distributionCandidates: [...files].map(([file, actual]) => ({ path: file, sha256: actual.sha256, sizeBytes: actual.sizeBytes })),
    validatedFileCount: files.size
  };
}

export async function runCli() {
  const args = process.argv.slice(2);
  let root = fileURLToPath(new URL('../integrations/arcanos-tutor/', import.meta.url));
  let inputRoot;
  let release = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--release') release = true;
    else if (args[index] === '--root' && args[index + 1]) root = path.resolve(args[++index]);
    else if (args[index] === '--inputs' && args[index + 1]) inputRoot = path.resolve(args[++index]);
    else throw new Error('UNSUPPORTED_ARGUMENT');
  }
  const result = await validateArcanosTutorPackage(root, { inputRoot });
  if (release && result.releaseStatus !== 'VERIFIED') {
    process.stdout.write(`${JSON.stringify({ ...result, code: 'RELEASE_BLOCKED' })}\n`);
    process.exitCode = 2;
  } else process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch(() => {
    // No paths, parser excerpts, or rejected content: inputs may contain secrets.
    process.stderr.write('PACKAGE_INVALID: Tutor validation failed; no input contents are logged.\n');
    process.exitCode = 1;
  });
}

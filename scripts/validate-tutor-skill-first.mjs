import path from 'node:path';
import { inspectComposedTutorSkill, teachingPlaceholder } from './compose-tutor-skill.mjs';
import { checkTutorPrivateBoundary } from './check-tutor-private-boundary.mjs';
import { validateTutorInvocationPolicy, validateTutorTeachingMatrix } from './tutor-invocation-policy.mjs';
import { baselineFingerprint, digest, isHash, packageFingerprint, readSafeFile, relativeFile,
  requireCondition, reviewed, skillPath, text, validateArtifact } from './tutor-migration.mjs';

const capabilityNames = ['Web Search', 'Canvas', 'Image Generation', 'Code Interpreter & Data Analysis'];
const compositionKeys = ['schemaVersion', 'kind', 'status', 'baselineFingerprint', 'configurationSha256',
  'outputDirectory', 'skill', 'packageFingerprint', 'report', 'sectionCount', 'approvedRuleIds', 'ownerReview', 'privateContentsTracked'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const closed = (value, keys, code) => requireCondition(value && typeof value === 'object' && !Array.isArray(value) &&
  same(Object.keys(value).sort(), [...keys].sort()), code);

export function validateCompositionInventory(record, baseline) {
  closed(record, compositionKeys, 'COMPOSITION_SAFE_FIELDS_REQUIRED');
  requireCondition(record.schemaVersion === 1 && record.kind === 'PRIVATE_COMPOSED_RELEASE_CANDIDATE' &&
    ['IMPLEMENTED_NOT_VERIFIED', 'VERIFIED'].includes(record.status) && record.privateContentsTracked === false,
  'COMPOSITION_INVENTORY_INVALID');
  requireCondition(record.baselineFingerprint === baselineFingerprint(baseline) &&
    record.configurationSha256 === baseline.configuration.sha256, 'COMPOSITION_BASELINE_MISMATCH');
  relativeFile(record.outputDirectory);
  requireCondition(Number.isSafeInteger(record.sectionCount) && record.sectionCount >= 0 &&
    Array.isArray(record.approvedRuleIds) && new Set(record.approvedRuleIds).size === record.approvedRuleIds.length &&
    record.approvedRuleIds.every(id => /^instruction-section-\d{3}$/u.test(id)), 'COMPOSITION_RULE_IDS_INVALID');
  if (record.skill !== null) {
    closed(record.skill, ['path', 'sha256', 'sizeBytes'], 'COMPOSITION_SAFE_FIELDS_REQUIRED');
    validateArtifact(record.skill);
    requireCondition(record.skill.path === skillPath && isHash(record.packageFingerprint), 'COMPOSITION_SKILL_INVALID');
    closed(record.report, ['path', 'sha256', 'sizeBytes'], 'COMPOSITION_SAFE_FIELDS_REQUIRED');
    validateArtifact(record.report);
    requireCondition(record.report.path === 'composition-report.json' && record.sectionCount > 0, 'COMPOSITION_REPORT_INVALID');
  } else requireCondition(record.report === null && record.packageFingerprint === null && record.sectionCount === 0 &&
    record.approvedRuleIds.length === 0 && record.status !== 'VERIFIED', 'COMPOSITION_ARTIFACT_MISSING');
  const review = record.ownerReview;
  if (review?.status === 'PENDING') closed(review, ['status'], 'COMPOSITION_REVIEW_INVALID');
  else {
    closed(review, ['status', 'reviewedBy', 'reviewedAt', 'skillSha256', 'packageFingerprint', 'baselineFingerprint', 'evidenceIds'], 'COMPOSITION_REVIEW_INVALID');
    requireCondition(review.status === 'APPROVED' && reviewed(review) && record.skill &&
      review.skillSha256 === record.skill.sha256 && review.packageFingerprint === record.packageFingerprint &&
      review.baselineFingerprint === record.baselineFingerprint && Array.isArray(review.evidenceIds) &&
      review.evidenceIds.length > 0 && review.evidenceIds.every(text), 'COMPOSITION_REVIEW_BINDING_INVALID');
  }
  requireCondition(record.status !== 'VERIFIED' || review.status === 'APPROVED', 'COMPOSITION_OWNER_REVIEW_MISSING');
  return record;
}

function boundObservation(verification, evidence, bindingName, bindings) {
  return reviewed(verification) && ['baselineFingerprint', 'skillSha256', 'packageFingerprint'].every(key =>
    verification[key] === bindings[key]) && Object.entries(bindings).every(([key, value]) =>
    verification[key] === undefined || verification[key] === value) &&
    Array.isArray(verification.evidenceIds) && verification.evidenceIds.length > 0 &&
    verification.evidenceIds.some(id => {
      const item = evidence.get(id);
      return item?.kind === 'chatgpt' && item.status === 'VERIFIED' &&
        Object.entries(bindings).every(([key, value]) => item[bindingName]?.[key] === value);
    });
}

export function validateCapabilityEquivalence(ledger, baseline) {
  closed(ledger, ['schemaVersion', 'status', 'accessedAt', 'baselineConfigurationSha256', 'baselineFingerprint',
    'baselineInventory', 'report', 'evidenceScope', 'platformContract', 'sourceDocs', 'capabilities', 'scopeDecision'], 'CAPABILITY_SAFE_FIELDS_REQUIRED');
  requireCondition(ledger?.schemaVersion === 1 && ledger.baselineFingerprint === baselineFingerprint(baseline) &&
    ledger.baselineConfigurationSha256 === baseline.configuration.sha256 &&
    Array.isArray(ledger.capabilities) && ledger.capabilities.length === 4 &&
    ['NOT_TESTED', 'VERIFIED'].includes(ledger.status) && Number.isFinite(Date.parse(ledger.accessedAt)) &&
    same(baseline.configuration.enabledCapabilities, capabilityNames), 'CAPABILITY_LEDGER_INVALID');
  const sourceIds = new Set();
  requireCondition(Array.isArray(ledger.sourceDocs) && ledger.sourceDocs.length > 0, 'CAPABILITY_SOURCES_MISSING');
  for (const source of ledger.sourceDocs) {
    requireCondition(Object.keys(source).every(key => ['id', 'url', 'accessedAt', 'commit', 'blobSha', 'localFile'].includes(key)) &&
      text(source.id) && !sourceIds.has(source.id) && /^https:\/\//u.test(source.url) &&
      Number.isFinite(Date.parse(source.accessedAt)), 'CAPABILITY_SOURCE_INVALID');
    sourceIds.add(source.id);
  }
  const platform = ledger.platformContract;
  closed(platform, ['architecture', 'registeredAppId', 'appEntryOptional', 'optionalSyntaxEvidenceIds',
    'portableSchemaVerified', 'portableSchemaLimit', 'activation', 'privateDistribution', 'surfaceLimit', 'evidenceIds'],
  'CAPABILITY_PLATFORM_FIELDS_INVALID');
  requireCondition(platform.architecture === 'one_plugin_with_app_independent_core_and_optional_backend' &&
    platform.appEntryOptional === true && platform.portableSchemaVerified === true &&
    platform.registeredAppId === 'asdk_app_6ab4747769088191856fd8eb02507240' &&
    [platform.optionalSyntaxEvidenceIds, platform.evidenceIds].every(ids => Array.isArray(ids) &&
      ids.length > 0 && ids.every(id => sourceIds.has(id))), 'CAPABILITY_OPTIONALITY_INVALID');
  const names = new Set();
  for (const row of ledger.capabilities) {
    const keys = ['id', 'publishedName', 'enabled', 'proposedEquivalent', 'surfaces', 'explicitIntent',
      'testMethod', 'status', 'knownDifferences', 'evidenceIds', 'executionEvidence'];
    if (row.verification !== undefined) keys.push('verification');
    closed(row, keys, 'CAPABILITY_ROW_SAFE_FIELDS_REQUIRED');
    closed(row.surfaces, ['web', 'desktop', 'mobile'], 'CAPABILITY_SURFACES_INVALID');
    requireCondition(capabilityNames.includes(row.publishedName) && !names.has(row.publishedName) &&
      row.enabled === true && ['NOT_TESTED', 'VERIFIED'].includes(row.status) &&
      text(row.proposedEquivalent) && Object.values(row.surfaces).every(text) && text(row.explicitIntent) && text(row.testMethod) &&
      Array.isArray(row.knownDifferences) && row.knownDifferences.length > 0 && row.knownDifferences.every(text) &&
      Array.isArray(row.evidenceIds) && row.evidenceIds.length > 0 && row.evidenceIds.every(id => sourceIds.has(id)) &&
      Array.isArray(row.executionEvidence) && row.executionEvidence.every(text), 'CAPABILITY_ROW_INVALID');
    if (row.status === 'VERIFIED') {
      closed(row.verification, ['reviewedBy', 'reviewedAt', 'baselineFingerprint', 'skillSha256',
        'packageFingerprint', 'evidenceIds', 'surface'], 'CAPABILITY_VERIFICATION_FIELDS_INVALID');
      requireCondition(reviewed(row.verification) && isHash(row.verification.skillSha256) &&
        isHash(row.verification.packageFingerprint) && row.verification.baselineFingerprint === ledger.baselineFingerprint,
      'CAPABILITY_VERIFICATION_INVALID');
    } else requireCondition(row.verification === undefined || row.verification === null, 'CAPABILITY_UNEXECUTED_REVIEW');
    names.add(row.publishedName);
  }
  requireCondition(ledger.status !== 'VERIFIED' || ledger.capabilities.every(row => row.status === 'VERIFIED'),
    'CAPABILITY_AGGREGATE_INVALID');
  if (ledger.scopeDecision !== null) {
    const decision = ledger.scopeDecision;
    closed(decision, ['decision', 'reviewedBy', 'reviewedAt', 'reason', 'baselineFingerprint',
      'configurationSha256', 'capabilityNames', 'evidenceIds'], 'CAPABILITY_SCOPE_DECISION_INVALID');
    requireCondition(decision.decision === 'HOST_CHATGPT_FEATURES_OUTSIDE_TUTOR' && reviewed(decision) &&
      text(decision.reason) && same(decision.capabilityNames, capabilityNames) &&
      Array.isArray(decision.evidenceIds) && decision.evidenceIds.length > 0 &&
      decision.evidenceIds.every(text) && new Set(decision.evidenceIds).size === decision.evidenceIds.length,
    'CAPABILITY_SCOPE_DECISION_INVALID');
    requireCondition(baseline.status === 'VERIFIED' &&
      decision.baselineFingerprint === ledger.baselineFingerprint &&
      decision.configurationSha256 === ledger.baselineConfigurationSha256, 'CAPABILITY_SCOPE_BINDING_INVALID');
    // Owner exclusion changes release scope, never the historical enabled settings
    // or execution evidence. It cannot be presented as verified equivalence.
    requireCondition(ledger.status === 'NOT_TESTED' && ledger.capabilities.every(row =>
      row.status === 'NOT_TESTED' && row.executionEvidence.length === 0 && !row.verification),
    'CAPABILITY_EXCLUSION_CLAIMS_VERIFICATION');
  }
  return ledger;
}

/** Offline evidence checks. No account connection is required for source validation. */
export async function validateSkillFirst({ root, inputRoot, baseline, state, evidence, templateFiles, referenceReview }) {
  const read = async name => JSON.parse((await readSafeFile(root, name)).content);
  const composition = validateCompositionInventory(await read('skill-composition.inventory.json'), baseline);
  const policy = await read('invocation-policy.json');
  const matrix = await read('teaching-behavior-matrix.json');
  const capabilities = validateCapabilityEquivalence(await read('capability-equivalence.json'), baseline);
  validateTutorInvocationPolicy(policy);
  validateTutorTeachingMatrix(matrix, policy);
  requireCondition(matrix.baselineFingerprint === composition.baselineFingerprint && matrix.cases.every(row =>
    row.approvedRuleIds.every(id => composition.approvedRuleIds.includes(id))), 'TEACHING_RULE_BINDING_INVALID');
  const template = templateFiles.get(skillPath).content;
  requireCondition(template.split(teachingPlaceholder).length === 2, 'PUBLIC_TEMPLATE_REQUIRED');
  const bindings = { baselineFingerprint: composition.baselineFingerprint, skillSha256: composition.skill?.sha256,
    packageFingerprint: composition.packageFingerprint };
  const ownerApproved = composition.ownerReview.status === 'APPROVED' && composition.ownerReview.evidenceIds.every(id => {
    const item = evidence.get(id);
    return item?.kind === 'user_reported' && item.status === 'USER_REPORTED' &&
      same(item.compositionBinding, bindings);
  });
  const teachingVerified = matrix.evidenceStatus === 'VERIFIED' && matrix.cases.every(row =>
    row.evidenceStatus === 'VERIFIED' && row.actualResult?.outcome === 'PASS' &&
    row.actualResult.skillActivated === row.expectedSkillActivation && row.actualResult.appInvoked === row.expectedAppInvocation &&
    row.actualResult.summarySha256 === digest(row.actualResult.summary) &&
    boundObservation(row.verification, evidence, 'teachingBinding', { ...bindings, caseId: row.id,
      promptSha256: digest(row.prompt), summarySha256: row.actualResult.summarySha256,
      artifactSha256: row.actualResult.artifactSha256 }));
  const capabilitiesVerified = capabilities.capabilities.every(row => row.status === 'VERIFIED' &&
    text(row.verification?.surface) && boundObservation(row.verification, evidence, 'capabilityBinding',
      { ...bindings, publishedName: row.publishedName, surface: row.verification.surface }));
  const capabilityScopeExcluded = capabilities.scopeDecision !== null;
  if (capabilityScopeExcluded) {
    const { evidenceIds, ...binding } = capabilities.scopeDecision;
    requireCondition(evidenceIds.every(id => {
      const item = evidence.get(id);
      return item?.kind === 'user_reported' && item.status === 'USER_REPORTED' &&
        same(Object.keys(item.capabilityScopeBinding ?? {}).sort(), Object.keys(binding).sort()) &&
        Object.entries(binding).every(([key, value]) => same(item.capabilityScopeBinding[key], value));
    }), 'CAPABILITY_SCOPE_EVIDENCE_INVALID');
    requireCondition(state.gates.GPT_BASELINE_CAPTURED.status === 'VERIFIED' &&
      same(state.gates.CAPABILITY_EQUIVALENCE_VERIFIED.evidenceIds, evidenceIds), 'CAPABILITY_SCOPE_GATE_INVALID');
  }
  requireCondition((state.gates.CAPABILITY_EQUIVALENCE_VERIFIED.status === 'NOT_APPLICABLE') === capabilityScopeExcluded,
    'CAPABILITY_SCOPE_GATE_INVALID');
  const capabilityRequirementSatisfied = capabilitiesVerified || capabilityScopeExcluded;
  const consistent = (gate, condition) => requireCondition(state.gates[gate].status !== 'VERIFIED' || condition,
    'SKILL_FIRST_GATE_CONTRADICTION');
  consistent('TUTOR_SKILL_COMPOSED', Boolean(composition.skill));
  consistent('TUTOR_SKILL_RECONCILED', ownerApproved);
  consistent('TUTOR_SKILL_BEHAVIOR_VERIFIED', teachingVerified);
  consistent('CAPABILITY_EQUIVALENCE_VERIFIED', capabilitiesVerified);
  const blockers = [];
  if (!composition.skill) blockers.push('PRIVATE_COMPOSED_SKILL_MISSING');
  if (!ownerApproved) blockers.push('PRIVATE_SKILL_OWNER_REVIEW_MISSING');
  if (!teachingVerified) blockers.push('SKILL_BEHAVIOR_NOT_VERIFIED');
  if (!capabilityRequirementSatisfied) blockers.push('CAPABILITY_EQUIVALENCE_NOT_VERIFIED');
  let privateFiles;
  if (inputRoot && composition.skill) {
    await checkTutorPrivateBoundary(inputRoot);
    const inspected = await inspectComposedTutorSkill({ inputRoot, baseline, packageRoot: path.join(root, 'package'),
      referenceReview, outputDirectory: composition.outputDirectory, expectedSkillSha256: composition.skill.sha256,
      expectedPackageFingerprint: composition.packageFingerprint });
    requireCondition(same(inspected.report, composition.report) && inspected.sectionCount === composition.sectionCount,
      'COMPOSITION_INSPECTION_MISMATCH');
    requireCondition(same([...inspected.approvedRuleIds].sort(), [...composition.approvedRuleIds].sort()),
      'APPROVED_TEACHING_RULE_PROVENANCE_MISMATCH');
    privateFiles = new Map(await Promise.all(inspected.distributionFiles.map(async file => [file.path,
      await readSafeFile(inputRoot, `${composition.outputDirectory}/package/${file.path}`)])));
    requireCondition(packageFingerprint(privateFiles) === composition.packageFingerprint, 'PRIVATE_PACKAGE_CHANGED');
    const configuration = JSON.parse((await readSafeFile(inputRoot, baseline.configuration.path)).content);
    // Explicit source-content checks supplement credential scanning. Never emit a
    // rejected value: even a parser excerpt could disclose the private baseline.
    for (const actual of templateFiles.values()) requireCondition(!actual.content.includes(configuration.instructions) &&
      !configuration.representativeBehavior.some(value => actual.content.includes(value)), 'PRIVATE_TEACHING_IN_PUBLIC_TEMPLATE');
  } else blockers.push('PRIVATE_COMPOSITION_NOT_INSPECTED');
  return { composition, privateFiles, blockers, teachingVerified, capabilitiesVerified,
    capabilityScopeExcluded, capabilityRequirementSatisfied,
    teachingReadiness: ownerApproved && teachingVerified && capabilityRequirementSatisfied ? 'VERIFIED' : 'BLOCKED',
    backendReadiness: state.gates.LIVE_TUTOR_CALL_VERIFIED.status };
}

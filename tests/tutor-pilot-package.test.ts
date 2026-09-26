import { afterEach, describe, expect, it } from '@jest/globals';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

type Json = ReturnType<typeof JSON.parse>;
const script = path.join(process.cwd(), 'scripts/validate-arcanos-tutor-package.mjs');
const captureScript = path.join(process.cwd(), 'scripts/capture-tutor-baseline.mjs');
const compositionScript = path.join(process.cwd(), 'scripts/compose-tutor-skill.mjs');
const source = path.join(process.cwd(), 'integrations/arcanos-tutor');
const skillPath = 'skills/arcanos-tutor/SKILL.md';
const temporaryRoots: string[] = [];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const review = { reviewedBy: 'mock fixture reviewer', reviewedAt: '2026-09-24T00:00:00Z' };
const hostCapabilityNames = ['Web Search', 'Canvas', 'Image Generation', 'Code Interpreter & Data Analysis'];
function json(root: string, file: string): Json { return JSON.parse(readFileSync(path.join(root, file), 'utf8')); }
function write(root: string, file: string, value: Json) { writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`); }
function edit(root: string, file: string, mutate: (value: Json) => void) { const value = json(root, file); mutate(value); write(root, file, value); }
function copyPackage(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arcanos-tutor-package-'));
  temporaryRoots.push(root);
  cpSync(source, root, { recursive: true });
  return root;
}
function validate(root = source, args: string[] = []) {
  return spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
}
function artifact(root: string, file: string) {
  const bytes = readFileSync(path.join(root, file));
  return { path: file, sha256: hash(bytes), sizeBytes: bytes.length };
}
function baselineFingerprint(baseline: Json) {
  return hash(JSON.stringify({ configuration: baseline.configuration.sha256,
    knowledge: baseline.knowledge.map(({ name, sha256, sizeBytes }: Json) => ({ name, sha256, sizeBytes }))
      .sort((left: Json, right: Json) => left.name.localeCompare(right.name, 'en')) }));
}
function completeFixture() {
  const root = copyPackage();
  expect(spawnSync('git', ['-C', root, 'init', '--quiet'], { windowsHide: true }).status).toBe(0);
  writeFileSync(path.join(root, '.gitignore'), '.local-migration/\n');
  const inputs = path.join(root, '.local-migration/arcanos-tutor');
  mkdirSync(inputs, { recursive: true });
  const instruction = 'Mock teaching personality: explain one small step, then invite one practice attempt.';
  write(inputs, 'published-gpt.json', { schemaVersion: 1,
    publication: { status: 'published', version: 'mock-v1', publishedAt: '2026-09-23T00:00:00Z' },
    displayName: 'ARCANOS TUTOR', description: 'Mock Tutor description', instructions: instruction,
    conversationStarters: ['Explain a fraction.'],
    enabledCapabilities: ['Web Search', 'Canvas', 'Image Generation', 'Code Interpreter & Data Analysis'],
    actions: [{ name: 'mock tutor', schema: { type: 'object' } }],
    sharingStatus: 'private', representativeBehavior: ['Clear short explanations.'], knowledge: [{ name: 'mock-notes.txt', path: 'mock-notes.txt' }] });
  writeFileSync(path.join(inputs, 'mock-notes.txt'), 'Mock reviewed reference: one half equals two quarters.\n');
  const captured = spawnSync(process.execPath, [captureScript, '--inputs', inputs, '--output', path.join(root, 'mock-baseline.json')], { encoding: 'utf8' });
  expect(captured.status).toBe(0);
  const baseline = json(root, 'mock-baseline.json');
  baseline.status = 'VERIFIED';
  baseline.publicationReview = { ...review, latestPublishedConfirmed: true, evidenceIds: ['mock-owner-baseline'] };
  write(root, 'baseline.inventory.json', baseline);
  const oldFingerprint = baselineFingerprint(baseline);
  write(inputs, 'mock-behavior-review.json', { cases: [{ id: 'tutoring', expectedBehavior: 'Clear short explanations.',
    privateSourceExcerpts: [{ line: 1, text: instruction, sha256: hash(instruction) }] }] });
  write(inputs, 'mock-owner-review.json', { ...review, latestPublishedConfirmed: true,
    completeTranscriptionApproved: true, representativeBehaviorApproved: true, evidenceId: 'mock-owner-baseline',
    reviewContext: { configurationSha256: baseline.configuration.sha256, baselineFingerprint: oldFingerprint,
      expectedBehaviorArtifact: artifact(inputs, 'mock-behavior-review.json') } });
  const referencePath = 'skills/arcanos-tutor/references/mock-notes.txt';
  mkdirSync(path.dirname(path.join(root, 'package', referencePath)), { recursive: true });
  cpSync(path.join(inputs, 'mock-notes.txt'), path.join(root, 'package', referencePath));
  write(root, 'reference-review.json', { schemaVersion: 1, references: [{ sourcePath: 'mock-notes.txt', packagePath: referencePath,
    sha256: baseline.knowledge[0].sha256, sizeBytes: baseline.knowledge[0].sizeBytes, approvedForRepository: true, ...review }] });
  const composed = spawnSync(process.execPath, [compositionScript, '--inputs', inputs,
    '--baseline', path.join(root, 'baseline.inventory.json'), '--package', path.join(root, 'package'),
    '--references', path.join(root, 'reference-review.json'), '--owner-review', 'mock-owner-review.json',
    '--output', 'mock-composed-skill'], { encoding: 'utf8' });
  expect(composed.stderr).toBe('');
  expect(composed.status).toBe(0);
  const composition = JSON.parse(composed.stdout);
  const bindings = { baselineFingerprint: oldFingerprint, skillSha256: composition.skill.sha256,
    packageFingerprint: composition.packageFingerprint };
  write(root, 'skill-composition.inventory.json', { schemaVersion: 1, kind: 'PRIVATE_COMPOSED_RELEASE_CANDIDATE',
    status: 'VERIFIED', baselineFingerprint: oldFingerprint, configurationSha256: baseline.configuration.sha256,
    outputDirectory: composition.outputDirectory, skill: composition.skill, packageFingerprint: composition.packageFingerprint,
    report: composition.report, sectionCount: composition.sectionCount, approvedRuleIds: composition.approvedRuleIds,
    ownerReview: { status: 'APPROVED', ...review, ...bindings, evidenceIds: ['mock-owner-composition'] },
    privateContentsTracked: false });
  const migrated = `---\nname: arcanos-tutor\ndescription: Mock migrated Tutor instructions.\n---\n${instruction}\n`;
  writeFileSync(path.join(inputs, 'migrated-skill.md'), migrated);
  cpSync(path.join(root, 'package/plugin.json'), path.join(inputs, 'migrated-plugin.json'));
  cpSync(path.join(root, 'package/.app.json'), path.join(inputs, '.app.json'));
  const appId = json(root, 'connection.requirements.json').registeredAppId;
  const migration = { schemaVersion: 1, status: 'VERIFIED', registeredAppId: appId,
    skill: { ...artifact(inputs, 'migrated-skill.md'), ...review, approvedForPrivateRelease: true },
    metadata: artifact(inputs, 'migrated-plugin.json'), appMapping: artifact(inputs, '.app.json'), references: baseline.knowledge, warnings: [],
    accountReview: { ...review, confirmedMigrated: true, confirmedWarningsReviewed: true },
    instructionComparison: { status: 'VERIFIED', ...review, disposition: 'PASS', summary: 'Mock exact instruction preservation.',
      baselineInstructionsSha256: baseline.configuration.fields.instructions.sha256,
      migratedSkillSha256: hash(migrated), packagedSkillSha256: composition.skill.sha256 } };
  write(root, 'migration.inventory.json', migration);
  edit(root, 'connection.requirements.json', connection => {
    connection.evidence.push({ id: 'mock-account-observation', kind: 'chatgpt', status: 'VERIFIED', observedAt: review.reviewedAt, summary: 'Synthetic account evidence; no actual migration.' });
    connection.evidence.push({ id: 'mock-repo-observation', kind: 'repository', status: 'VERIFIED', observedAt: review.reviewedAt, summary: 'Synthetic reviewed local fixture.' });
    connection.evidence.push({ id: 'mock-deploy-observation', kind: 'railway', status: 'VERIFIED', observedAt: review.reviewedAt, summary: 'Synthetic deployment fixture; no deployment performed.' });
    connection.evidence.push({ id: 'mock-owner-baseline', kind: 'user_reported', status: 'USER_REPORTED', observedAt: review.reviewedAt, summary: 'Synthetic owner baseline approval.' });
    connection.evidence.push({ id: 'mock-owner-composition', kind: 'user_reported', status: 'USER_REPORTED', observedAt: review.reviewedAt,
      summary: 'Synthetic owner approval of exact private composition.', compositionBinding: bindings });
    // A complete synthetic fixture owns its connection claims independently of
    // the real ledger, whose current live connection may legitimately be blocked.
    for (const check of Object.values<Json>(connection.checks)) {
      check.status = 'VERIFIED';
      check.evidenceIds = ['mock-account-observation'];
    }
    connection.builderReconciliation = 'VERIFIED';
    connection.referenceReconciliation = 'VERIFIED';
  });
  edit(root, 'teaching-behavior-matrix.json', matrix => {
    matrix.baselineFingerprint = oldFingerprint;
    matrix.evidenceStatus = 'VERIFIED';
    for (const item of matrix.cases) {
      // Synthetic source bytes are deliberately unrelated to the reviewed real
      // semantic mapping. These expected checks are fixture safeguards only.
      item.approvedRuleIds = [];
      item.baselineRuleStatus = 'INTEGRATION_ONLY';
      item.ruleProvenance = 'integration_safeguard';
      item.evidenceStatus = 'VERIFIED';
      const summary = `Mock observed teaching case ${item.id}; synthetic fixture only.`;
      item.actualResult = { summary, summarySha256: hash(summary), skillActivated: item.expectedSkillActivation,
        appInvoked: item.expectedAppInvocation, outcome: 'PASS', artifactSha256: hash(`mock teaching artifact ${item.id}`) };
      const id = `mock-teaching-${item.id}`;
      item.verification = { ...review, ...bindings, evidenceIds: [id] };
      edit(root, 'connection.requirements.json', connection => {
        connection.evidence.push({ id, kind: 'chatgpt', status: 'VERIFIED', observedAt: review.reviewedAt,
          summary, teachingBinding: { ...bindings, caseId: item.id, promptSha256: hash(item.prompt),
            summarySha256: item.actualResult.summarySha256, artifactSha256: item.actualResult.artifactSha256 } });
      });
    }
  });
  edit(root, 'capability-equivalence.json', ledger => {
    ledger.scopeDecision = null;
    ledger.baselineConfigurationSha256 = baseline.configuration.sha256;
    ledger.baselineFingerprint = oldFingerprint;
    ledger.status = 'VERIFIED';
    for (const item of ledger.capabilities) {
      item.status = 'VERIFIED';
      const id = `mock-capability-${item.id}`;
      item.verification = { ...review, ...bindings, surface: 'mock-web-surface', evidenceIds: [id] };
      edit(root, 'connection.requirements.json', connection => {
        connection.evidence.push({ id, kind: 'chatgpt', status: 'VERIFIED', observedAt: review.reviewedAt,
          summary: `Mock capability observation for ${item.publishedName}; synthetic fixture only.`,
          capabilityBinding: { ...bindings, publishedName: item.publishedName, surface: item.verification.surface } });
      });
    }
  });
  edit(root, 'parity-matrix.json', parity => {
    parity.status = 'VERIFIED';
    parity.liveEvidenceIds = ['mock-account-observation'];
    for (const item of parity.cases) {
      const summary = `Mock comparison for ${item.id}.`;
      item.oldGpt = { status: 'VERIFIED', summary, sha256: hash(summary), hashBasis: 'sanitized_summary', artifactSha256: baseline.configuration.sha256,
        configurationFingerprint: oldFingerprint, evidenceIds: ['mock-account-observation'] };
      item.plugin = { ...item.oldGpt, artifactSha256: migration.skill.sha256, configurationFingerprint: composition.packageFingerprint };
      for (const side of ['oldGpt', 'plugin']) {
        const id = `mock-parity-${item.id}-${side}`;
        item[side].evidenceIds = [id];
        edit(root, 'connection.requirements.json', connection => {
          connection.evidence.push({ id, kind: 'chatgpt', status: 'VERIFIED', observedAt: review.reviewedAt,
            summary: `Mock observed ${item.id} ${side} fixture only.`, parityBinding: { caseId: item.id, side,
              promptSha256: hash(item.prompt), configurationFingerprint: item[side].configurationFingerprint,
              summarySha256: item[side].sha256 } });
        });
      }
      item.toolInvoked = ['authentication', 'unavailable', 'timeout', 'cancellation'].includes(item.category) ? 'arcanos_tutor' : null;
      item.materialDifference = 'No material difference in this synthetic fixture.';
      item.disposition = 'PASS';
      Object.assign(item, review);
    }
  });
  edit(root, 'migration-state.json', state => {
    for (const [name, gate] of Object.entries<Json>(state.gates)) {
      if (['PACKAGE_READY', 'RELEASE_READY'].includes(name)) { gate.status = 'BLOCKED'; continue; }
      gate.status = 'VERIFIED';
      gate.evidenceIds = name === 'BACKEND_DEPLOYED' ? ['mock-deploy-observation'] :
        ['CODE_READY', 'GPT_BASELINE_CAPTURED', 'SKILL_RECONCILED', 'REFERENCES_RECONCILED',
          'TUTOR_SKILL_COMPOSED', 'TUTOR_SKILL_RECONCILED', 'BACKEND_APP_OPTIONALITY_VERIFIED',
          'MIGRATED_SKILL_RECONCILED'].includes(name) ? ['mock-repo-observation'] : ['mock-account-observation'];
    }
  });
  return { root, inputs, baseline, migration, composition, bindings, instruction,
    privatePackage: path.join(inputs, composition.outputDirectory, 'package') };
}

function capabilityExclusionFixture() {
  const fixture = completeFixture();
  const evidenceId = 'mock-owner-host-feature-exclusion';
  const binding = { decision: 'HOST_CHATGPT_FEATURES_OUTSIDE_TUTOR', ...review,
    reason: 'Mock owner excludes these host features from Tutor release scope.',
    baselineFingerprint: baselineFingerprint(fixture.baseline), configurationSha256: fixture.baseline.configuration.sha256,
    capabilityNames: [...hostCapabilityNames] };
  edit(fixture.root, 'capability-equivalence.json', ledger => {
    ledger.scopeDecision = { ...binding, evidenceIds: [evidenceId] };
    ledger.status = 'NOT_TESTED';
    for (const item of ledger.capabilities) {
      item.status = 'NOT_TESTED';
      item.executionEvidence = [];
      delete item.verification;
    }
  });
  edit(fixture.root, 'connection.requirements.json', connection => {
    connection.evidence = connection.evidence.filter((item: Json) => !item.id.startsWith('mock-capability-'));
    connection.evidence.push({ id: evidenceId, kind: 'user_reported', status: 'USER_REPORTED', observedAt: review.reviewedAt,
      summary: 'Mock owner scope decision only; no capability execution or equivalence claim.', capabilityScopeBinding: binding });
  });
  edit(fixture.root, 'migration-state.json', state => {
    state.gates.CAPABILITY_EQUIVALENCE_VERIFIED.status = 'NOT_APPLICABLE';
    state.gates.CAPABILITY_EQUIVALENCE_VERIFIED.evidenceIds = [evidenceId];
  });
  return { ...fixture, evidenceId };
}

function editCapabilityScope(fixture: ReturnType<typeof capabilityExclusionFixture>, mutate: (scope: Json) => void) {
  edit(fixture.root, 'capability-equivalence.json', ledger => { mutate(ledger.scopeDecision); });
  const binding = { ...json(fixture.root, 'capability-equivalence.json').scopeDecision };
  delete binding.evidenceIds;
  edit(fixture.root, 'connection.requirements.json', connection => {
    connection.evidence.find((item: Json) => item.id === fixture.evidenceId).capabilityScopeBinding = binding;
  });
}

function behaviorDeferralFixture() {
  const fixture = completeFixture();
  const evidenceId = 'mock-behavior-deferral';
  edit(fixture.root, 'teaching-behavior-matrix.json', matrix => {
    matrix.evidenceStatus = 'UNEXECUTED';
    for (const item of matrix.cases) {
      item.evidenceStatus = 'UNEXECUTED';
      item.actualResult = null;
      item.verification = null;
    }
  });
  edit(fixture.root, 'connection.requirements.json', connection => {
    connection.evidence = connection.evidence.filter((item: Json) => !item.id.startsWith('mock-teaching-'));
    connection.evidence.push({ id: evidenceId, kind: 'repository', status: 'VERIFIED', observedAt: review.reviewedAt,
      summary: 'Mock review of task execution-surface limits; no teaching execution.',
      behaviorDeferralBinding: { ...fixture.bindings, reason: 'NO_SUPPORTED_SURFACE_WITHIN_TASK_BOUNDARIES',
        surface: 'ChatGPT web; desktop local marketplace requires private cache outside allowed input directory',
        postMigrationRequired: true } });
  });
  edit(fixture.root, 'migration-state.json', state => {
    state.gates.TUTOR_SKILL_BEHAVIOR_VERIFIED.status = 'DEFERRED_POST_MIGRATION';
    state.gates.TUTOR_SKILL_BEHAVIOR_VERIFIED.evidenceIds = [evidenceId];
  });
  return { ...fixture, evidenceId };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('arcanos-tutor-package-')) throw new Error('Unexpected temporary test path');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Standalone Tutor package and migration release boundary', () => {
  it('validates the final identity and only the three reviewed distribution files', () => {
    const result = validate();
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ sourceValidation: 'PASS', releaseStatus: 'BLOCKED', archiveWritten: false, validatedFileCount: 3 });
    expect(report.distributionCandidates.map((item: Json) => item.path).sort()).toEqual(['.app.json', 'plugin.json', skillPath]);
    expect(report.distributionCandidates.every((item: Json) => /^[a-f0-9]{64}$/u.test(item.sha256))).toBe(true);
  });
  it('blocks actual release without the published and migrated artifacts', () => {
    const result = validate(source, ['--release']);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).releaseBlockers).toContain('ACTUAL_INPUT_ARTIFACTS_NOT_INSPECTED');
  });
  it('accepts a complete reviewed safe synthetic migration without claiming a real one', () => {
    const fixture = completeFixture();
    const result = validate(fixture.root, ['--release', '--inputs', fixture.inputs]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ releaseStatus: 'VERIFIED', archiveWritten: false,
      artifactKind: 'PUBLIC_TEMPLATE', privatePackageFingerprint: fixture.composition.packageFingerprint,
      skillOnlyTeachingReadiness: 'VERIFIED', backendReadiness: 'VERIFIED',
      capabilityEquivalenceVerified: true, capabilityScopeExcluded: false,
      gates: { PACKAGE_READY: 'VERIFIED', RELEASE_READY: 'VERIFIED' } });
    const template = readFileSync(path.join(fixture.root, 'package', skillPath), 'utf8');
    expect(template).toContain('{{PUBLISHED_TUTOR_INSTRUCTIONS}}');
    expect(template).not.toContain(fixture.instruction);
    expect(readFileSync(path.join(fixture.privatePackage, skillPath), 'utf8')).toContain(fixture.instruction);
    expect(JSON.parse(result.stdout).packageFingerprint).not.toBe(fixture.composition.packageFingerprint);
  });
  it.each(['.env', 'private-builder-export.json', 'mcp.json', 'README.md', '.local-migration.json'])('rejects unreviewed packaged file %s', filename => {
    const root = copyPackage();
    writeFileSync(path.join(root, 'package', filename), '{}');
    expect(validate(root).status).toBe(1);
  });
  it('rejects a private-input directory inside the distribution', () => {
    const root = copyPackage();
    mkdirSync(path.join(root, 'package/.local-migration'));
    expect(validate(root).status).toBe(1);
  });
  it.each(['memory.search', 'jobs.get', 'dag.dispatch', 'gaming_query', 'backstage_generate', 'modules.invoke', 'ARCANOS Core', 'arcanos_gaming'])('rejects cross-capability dependency %s', tool => {
    const root = copyPackage();
    writeFileSync(path.join(root, 'package', skillPath), `${readFileSync(path.join(root, 'package', skillPath), 'utf8')}\nCall ${tool}, then arcanos_tutor.\n`);
    expect(validate(root).status).toBe(1);
  });
  it.each(['plugin_asdk_app_6ab4747769088191856fd8eb02507240', 'REPLACE_ME'])('rejects an invalid registered-app mapping %s', id => {
    const root = copyPackage();
    edit(root, 'package/.app.json', mapping => { mapping.apps['arcanos-tutor'].id = id; });
    expect(validate(root).status).toBe(1);
  });
  it.each(['required', 'string-required', 'optional-false', 'string-optional', 'both-flags', 'missing-optional'])('rejects a public mapping with %s semantics', kind => {
    const root = copyPackage();
    edit(root, 'package/.app.json', mapping => {
      const tutor = mapping.apps['arcanos-tutor'];
      if (kind === 'required') { delete tutor.optional; tutor.required = true; }
      else if (kind === 'string-required') { delete tutor.optional; tutor.required = 'true'; }
      else if (kind === 'optional-false') tutor.optional = false;
      else if (kind === 'string-optional') tutor.optional = 'true';
      else if (kind === 'both-flags') tutor.required = false;
      else delete tutor.optional;
    });
    expect(validate(root).status).toBe(1);
  });
  it('rejects an extra registered app and tool', () => {
    const root = copyPackage();
    edit(root, 'package/.app.json', mapping => { mapping.apps.extra = { id: mapping.apps['arcanos-tutor'].id, required: true }; });
    expect(validate(root).status).toBe(1);
    cpSync(path.join(source, 'package/.app.json'), path.join(root, 'package/.app.json'));
    edit(root, 'connection.requirements.json', connection => { connection.toolNames.push('extra_tool'); });
    expect(validate(root).status).toBe(1);
  });
  it('accepts equivalent property order in the final and migrated app mappings', () => {
    const root = copyPackage();
    edit(root, 'package/.app.json', mapping => {
      const id = mapping.apps['arcanos-tutor'].id;
      mapping.apps['arcanos-tutor'] = { optional: true, id };
    });
    expect(validate(root).status).toBe(0);
    const fixture = completeFixture();
    edit(fixture.inputs, '.app.json', mapping => {
      const id = mapping.apps['arcanos-tutor'].id;
      mapping.apps['arcanos-tutor'] = { optional: true, id };
    });
    edit(fixture.root, 'migration.inventory.json', migration => { migration.appMapping = artifact(fixture.inputs, '.app.json'); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(0);
  });
  it.each(['registeredAppId', 'appMapping'])('rejects verified migration without its %s binding', field => {
    const fixture = completeFixture();
    edit(fixture.root, 'migration.inventory.json', migration => { delete migration[field]; });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('rejects a migrated manifest pointing to an unreviewed app mapping', () => {
    const fixture = completeFixture();
    cpSync(path.join(fixture.inputs, '.app.json'), path.join(fixture.inputs, 'other-app.json'));
    edit(fixture.inputs, 'migrated-plugin.json', metadata => { metadata.extensions['com.openai'].apps = './other-app.json'; });
    edit(fixture.root, 'migration.inventory.json', migration => { migration.metadata = artifact(fixture.inputs, 'migrated-plugin.json'); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('rejects migrated metadata without its app mapping pointer', () => {
    const fixture = completeFixture();
    edit(fixture.inputs, 'migrated-plugin.json', metadata => { delete metadata.extensions['com.openai'].apps; });
    edit(fixture.root, 'migration.inventory.json', migration => { migration.metadata = artifact(fixture.inputs, 'migrated-plugin.json'); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('rejects an actual migrated app mapping for another registered connection', () => {
    const fixture = completeFixture();
    edit(fixture.inputs, '.app.json', mapping => { mapping.apps['arcanos-tutor'].id = `asdk_app_${'0'.repeat(32)}`; });
    edit(fixture.root, 'migration.inventory.json', migration => { migration.appMapping = artifact(fixture.inputs, '.app.json'); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it.each(['required', 'string-required', 'optional-false', 'string-optional', 'both-flags', 'missing-optional', 'extra-app', 'array-apps', 'empty-alias'])('rejects a migrated mapping with %s semantics', kind => {
    const fixture = completeFixture();
    edit(fixture.inputs, '.app.json', mapping => {
      const tutor = mapping.apps['arcanos-tutor'];
      if (kind === 'required') { delete tutor.optional; tutor.required = true; }
      else if (kind === 'string-required') { delete tutor.optional; tutor.required = 'true'; }
      else if (kind === 'optional-false') tutor.optional = false;
      else if (kind === 'string-optional') tutor.optional = 'true';
      else if (kind === 'both-flags') tutor.required = false;
      else if (kind === 'missing-optional') delete tutor.optional;
      else if (kind === 'extra-app') mapping.apps.extra = { ...tutor };
      else if (kind === 'array-apps') mapping.apps = [tutor];
      else if (kind === 'empty-alias') mapping.apps = { '': tutor };
    });
    edit(fixture.root, 'migration.inventory.json', migration => { migration.appMapping = artifact(fixture.inputs, '.app.json'); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('accepts one migrated alias bound to the same optional Tutor connection', () => {
    const fixture = completeFixture();
    edit(fixture.inputs, '.app.json', mapping => { mapping.apps = { 'migrated-tutor-alias': mapping.apps['arcanos-tutor'] }; });
    edit(fixture.root, 'migration.inventory.json', migration => { migration.appMapping = artifact(fixture.inputs, '.app.json'); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(0);
  });
  it.each(['../.app.json', '/.app.json', 'C:/mock/.app.json'])('rejects unsafe migrated app mapping pointer %s', pointer => {
    const fixture = completeFixture();
    edit(fixture.inputs, 'migrated-plugin.json', metadata => { metadata.extensions['com.openai'].apps = pointer; });
    edit(fixture.root, 'migration.inventory.json', migration => { migration.metadata = artifact(fixture.inputs, 'migrated-plugin.json'); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('resolves the migrated app mapping relative to a nested manifest', () => {
    const fixture = completeFixture();
    mkdirSync(path.join(fixture.inputs, 'generated'));
    renameSync(path.join(fixture.inputs, 'migrated-plugin.json'), path.join(fixture.inputs, 'generated/plugin.json'));
    renameSync(path.join(fixture.inputs, '.app.json'), path.join(fixture.inputs, 'generated/.app.json'));
    edit(fixture.root, 'migration.inventory.json', migration => {
      migration.metadata = artifact(fixture.inputs, 'generated/plugin.json');
      migration.appMapping = artifact(fixture.inputs, 'generated/.app.json');
    });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(0);
  });
  it('rejects replacing both mapping records with a plausible but unobserved app ID', () => {
    const root = copyPackage();
    const invented = `asdk_app_${'0'.repeat(32)}`;
    edit(root, 'package/.app.json', mapping => { mapping.apps['arcanos-tutor'].id = invented; });
    edit(root, 'connection.requirements.json', connection => { connection.registeredAppId = invented; connection.technicalId = `plugin_${invented}`; });
    expect(validate(root).status).toBe(1);
  });
  it('rejects unknown manifest fields, replaced schema, and missing skill frontmatter', () => {
    const root = copyPackage();
    edit(root, 'package/plugin.json', manifest => { manifest.arbitraryUnsupportedProperty = true; });
    expect(validate(root).status).toBe(1);
    cpSync(path.join(source, 'package/plugin.json'), path.join(root, 'package/plugin.json'));
    writeFileSync(path.join(root, 'schemas/agent-plugins-1.0.0.schema.json'), '{}');
    expect(validate(root).status).toBe(1);
    cpSync(path.join(source, 'schemas/agent-plugins-1.0.0.schema.json'), path.join(root, 'schemas/agent-plugins-1.0.0.schema.json'));
    writeFileSync(path.join(root, 'package', skillPath), 'Missing frontmatter.');
    expect(validate(root).status).toBe(1);
  });
  it('accepts schema CRLF without weakening its digest', () => {
    const root = copyPackage();
    const file = path.join(root, 'schemas/agent-plugins-1.0.0.schema.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\r?\n/gu, '\r\n'));
    expect(validate(root).status).toBe(0);
  });
  it('rejects oversized packaged inputs', () => {
    const root = copyPackage();
    writeFileSync(path.join(root, 'package', skillPath), 'x'.repeat(1024 * 1024 + 1));
    expect(validate(root).status).toBe(1);
  });
  it('rejects credential-like content without printing it', () => {
    const root = copyPackage();
    const mockMaterial = ['sk', 'proj', 'mock'.repeat(15)].join('-');
    writeFileSync(path.join(root, 'package', skillPath), mockMaterial);
    const result = validate(root);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(mockMaterial);
  });
  it.each(['clientSecret', 'accessToken', 'refreshToken', 'apiKey', 'privateSigningKey', 'OPENAI_API_KEY',
    'client-secret', 'access-token', 'refresh-token', 'api-key', 'private-key', 'private_signing_key']
    .flatMap(key => ['skill', 'approved-reference'].map(target => [key, target])))('rejects named %s material in %s without logging it', (key, target) => {
    const root = copyPackage();
    const mockMaterial = 'mock_opaque_material_for_validator_fixture';
    const content = `${JSON.stringify({ [key]: mockMaterial })}\n`;
    if (target === 'skill') {
      const file = path.join(root, 'package', skillPath);
      writeFileSync(file, `${readFileSync(file, 'utf8')}\n${content}`);
    } else {
      const referencePath = 'skills/arcanos-tutor/references/mock-credentials.json';
      mkdirSync(path.dirname(path.join(root, 'package', referencePath)), { recursive: true });
      writeFileSync(path.join(root, 'package', referencePath), content);
      write(root, 'reference-review.json', { schemaVersion: 1, references: [{ sourcePath: 'mock-credentials.json',
        packagePath: referencePath, sha256: hash(content), sizeBytes: Buffer.byteLength(content),
        approvedForRepository: true, ...review }] });
    }
    const result = validate(root);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(mockMaterial);
    expect(`${result.stdout}${result.stderr}`).not.toContain(content.trim());
  });
  it.each(['ENCRYPTED', 'DSA'])('rejects a %s private-key label without printing its mock contents', label => {
    const root = copyPackage();
    const mockMaterial = ['-----BEGIN', label, 'PRIVATE KEY-----', '\nmock_encoded_fixture_material\n'].join(' ');
    const file = path.join(root, 'package', skillPath);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n${mockMaterial}`);
    const result = validate(root);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain('mock_encoded_fixture_material');
  });
  it('rejects a junction in an ancestor and inside the package', () => {
    const root = copyPackage();
    const linked = path.join(root, 'linked');
    mkdirSync(path.join(root, 'container'));
    cpSync(source, path.join(root, 'container/candidate'), { recursive: true });
    symlinkSync(path.join(root, 'container'), linked, 'junction');
    const viaAncestor = validate(path.join(linked, 'candidate'));
    expect(viaAncestor.status).toBe(1);
    rmSync(linked, { recursive: true });
    renameSync(path.join(root, 'package/skills'), path.join(root, 'outside-skills'));
    symlinkSync(path.join(root, 'outside-skills'), path.join(root, 'package/skills'), 'junction');
    expect(validate(root).status).toBe(1);
  });
  it('cannot promote user-reported connection evidence using unrelated verified evidence', () => {
    const root = copyPackage();
    edit(root, 'connection.requirements.json', connection => {
      connection.evidence.find((item: Json) => item.id === 'chatgpt-registration').status = 'USER_REPORTED';
      connection.checks.registeredConnection.evidenceIds = ['chatgpt-registration', 'repository-foundation'];
    });
    expect(validate(root).status).toBe(1);
  });
  it('rejects inconsistent connection states and missing parity categories', () => {
    const root = copyPackage();
    edit(root, 'migration-state.json', state => { state.gates.LIVE_TUTOR_CALL_VERIFIED.status = 'USER_REPORTED'; });
    expect(validate(root).status).toBe(1);
    cpSync(path.join(source, 'migration-state.json'), path.join(root, 'migration-state.json'));
    edit(root, 'parity-matrix.json', parity => { parity.cases = parity.cases.filter((item: Json) => item.category !== 'cancellation'); });
    expect(validate(root).status).toBe(1);
  });
  it('rejects baseline verification claims without captured configuration', () => {
    const root = copyPackage();
    edit(root, 'baseline.inventory.json', baseline => {
      baseline.status = 'BLOCKED';
      baseline.configuration = null;
      baseline.missingInputs = ['published_configuration'];
      delete baseline.publicationReview;
    });
    edit(root, 'migration-state.json', state => { state.gates.GPT_BASELINE_CAPTURED.status = 'VERIFIED'; state.gates.GPT_BASELINE_CAPTURED.evidenceIds = ['repository-foundation']; });
    expect(validate(root).status).toBe(1);
  });
  it.each(['configuration', 'reference', 'metadata', 'appMapping'])('rejects changed private %s bytes after review', target => {
    const fixture = completeFixture();
    const file = target === 'configuration' ? 'published-gpt.json' : target === 'reference' ? 'mock-notes.txt' : target === 'appMapping' ? '.app.json' : 'migrated-plugin.json';
    writeFileSync(path.join(fixture.inputs, file), 'Changed mock artifact.');
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('invalidates parity when final packaged safeguards change even if their review hash is updated', () => {
    const fixture = completeFixture();
    const file = path.join(fixture.root, 'package', skillPath);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nA changed mock safeguard.\n`);
    edit(fixture.root, 'migration.inventory.json', migration => { migration.instructionComparison.packagedSkillSha256 = hash(readFileSync(file)); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('rejects unapproved references and renamed knowledge files', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'reference-review.json', refs => { refs.references[0].approvedForRepository = false; });
    expect(validate(fixture.root).status).toBe(1);
    edit(fixture.root, 'reference-review.json', refs => { refs.references[0].approvedForRepository = true; });
    edit(fixture.root, 'migration.inventory.json', migration => { migration.references[0].name = 'renamed.txt'; });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('requires explicit owner acceptance for an accepted parity difference', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'parity-matrix.json', parity => { parity.cases[0].disposition = 'ACCEPTED_DIFFERENCE'; });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('accepts an explicit owner-approved difference bound to both configurations and the exact prompt', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'parity-matrix.json', parity => {
      const item = parity.cases[0];
      item.disposition = 'ACCEPTED_DIFFERENCE';
      item.ownerAcceptance = { accepted: true, acceptedBy: 'mock fixture owner', acceptedAt: review.reviewedAt,
        reason: 'Mock accepted teaching style difference.', promptSha256: hash(item.prompt),
        oldFingerprint: item.oldGpt.configurationFingerprint, pluginFingerprint: item.plugin.configurationFingerprint };
    });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(0);
  });
  it('invalidates parity when final manifest metadata changes', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'package/plugin.json', manifest => { manifest.version = '0.1.1'; });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('invalidates parity after a fully rehashed reference replacement', () => {
    const fixture = completeFixture();
    const replacement = 'A newly reviewed mock reference.\n';
    writeFileSync(path.join(fixture.inputs, 'mock-notes.txt'), replacement);
    writeFileSync(path.join(fixture.root, 'package/skills/arcanos-tutor/references/mock-notes.txt'), replacement);
    for (const file of ['baseline.inventory.json', 'migration.inventory.json']) edit(fixture.root, file, inventory => {
      const entry = (inventory.knowledge ?? inventory.references)[0];
      entry.sha256 = hash(replacement); entry.sizeBytes = Buffer.byteLength(replacement);
    });
    edit(fixture.root, 'reference-review.json', refs => { refs.references[0].sha256 = hash(replacement); refs.references[0].sizeBytes = Buffer.byteLength(replacement); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('rejects raw private Builder instructions in the sanitized inventory', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'baseline.inventory.json', baseline => { baseline.configuration.instructions = 'Mock private instruction leak.'; });
    const result = validate(fixture.root);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain('Mock private instruction leak');
  });
  it('cannot use the earlier standalone tool call to certify installed-skill parity', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'parity-matrix.json', parity => { parity.cases[0].plugin.evidenceIds = ['chatgpt-live-call']; });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it.each([['direct', 'arcanos_tutor'], ['non_activation', 'arcanos_tutor'], ['authentication', null]])('rejects a passed %s case with the wrong tool activation', (category, tool) => {
    const fixture = completeFixture();
    edit(fixture.root, 'parity-matrix.json', parity => { parity.cases.find((item: Json) => item.category === category).toolInvoked = tool; });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('cannot promote user-reported pairs using a verified aggregate gate', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'parity-matrix.json', parity => { parity.cases[0].plugin.status = 'USER_REPORTED'; });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('rejects duplicate source approvals that could hide an omitted migrated reference', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'reference-review.json', refs => { refs.references.push({ ...refs.references[0], packagePath: 'skills/arcanos-tutor/references/copy.txt' }); });
    expect(validate(fixture.root).status).toBe(1);
  });
  it('keeps the fully synthetic private package ignored and binds all teaching and capability observations', () => {
    const fixture = completeFixture();
    expect(spawnSync('git', ['-C', fixture.root, 'check-ignore', '--quiet', '--',
      '.local-migration/arcanos-tutor/'], { windowsHide: true }).status).toBe(0);
    expect(spawnSync('git', ['-C', fixture.root, 'ls-files', '--', '.local-migration/arcanos-tutor/'],
      { encoding: 'utf8', windowsHide: true }).stdout).toBe('');
    const teaching = json(fixture.root, 'teaching-behavior-matrix.json');
    expect(teaching.cases).toHaveLength(18);
    expect(teaching.cases.every((item: Json) => item.verification.packageFingerprint === fixture.composition.packageFingerprint)).toBe(true);
    expect(json(fixture.root, 'capability-equivalence.json').capabilities).toHaveLength(4);
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(0);
  });
  it.each(['skillSha256', 'packageFingerprint', 'baselineFingerprint'])('rejects composition owner approval with a stale %s binding', field => {
    const fixture = completeFixture();
    edit(fixture.root, 'connection.requirements.json', connection => {
      connection.evidence.find((item: Json) => item.id === 'mock-owner-composition').compositionBinding[field] = hash('mock stale owner binding');
    });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('rejects baseline approval reused as approval of the composed private skill', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'skill-composition.inventory.json', composition => { composition.ownerReview.evidenceIds = ['mock-owner-baseline']; });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it.each(['instruction-section-001', 'instruction-section-999'])('rejects invented approved source section %s even when the teaching matrix repeats it', section => {
    const fixture = completeFixture();
    edit(fixture.root, 'skill-composition.inventory.json', composition => { composition.approvedRuleIds = [section]; });
    edit(fixture.root, 'teaching-behavior-matrix.json', matrix => {
      matrix.cases[0].approvedRuleIds = [section];
      matrix.cases[0].baselineRuleStatus = 'APPROVED_SOURCE_REFERENCE';
      matrix.cases[0].ruleProvenance = 'approved_baseline_and_integration_safeguard';
    });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it.each(['owner-review', 'skill-bytes', 'composition-report'])('rejects changed private composition %s without exposing instructions', target => {
    const fixture = completeFixture();
    const file = target === 'owner-review' ? path.join(fixture.inputs, 'mock-owner-review.json') :
      target === 'skill-bytes' ? path.join(fixture.privatePackage, skillPath) :
        path.join(fixture.inputs, fixture.composition.outputDirectory, 'composition-report.json');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nChanged mock composition bytes.\n`);
    const result = validate(fixture.root, ['--release', '--inputs', fixture.inputs]);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(fixture.instruction);
  });
  it('rejects loss of the private-input ignore boundary before inspecting release bytes', () => {
    const fixture = completeFixture();
    writeFileSync(path.join(fixture.root, '.gitignore'), 'mock-unrelated-directory/\n');
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('requires private-release approval for a migrated skill even when repository approval is set', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'migration.inventory.json', migration => {
      delete migration.skill.approvedForPrivateRelease;
      migration.skill.approvedForRepository = true;
    });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it.each(['teaching', 'capability'])('cannot promote repository preview evidence into verified %s observations', target => {
    const fixture = completeFixture();
    edit(fixture.root, 'connection.requirements.json', connection => {
      connection.evidence.find((item: Json) => item.id.startsWith(`mock-${target}-`)).kind = 'repository';
    });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it.each(['teaching', 'capability'])('rejects %s evidence bound to the public template instead of the private package', target => {
    const fixture = completeFixture();
    const publicFingerprint = JSON.parse(validate(fixture.root).stdout).packageFingerprint;
    const bindingName = target === 'teaching' ? 'teachingBinding' : 'capabilityBinding';
    edit(fixture.root, 'connection.requirements.json', connection => {
      connection.evidence.find((item: Json) => item.id.startsWith(`mock-${target}-`))[bindingName].packageFingerprint = publicFingerprint;
    });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('rejects a teaching summary changed without updating its observation binding', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'teaching-behavior-matrix.json', matrix => {
      const result = matrix.cases[0].actualResult;
      result.summary = 'Mock changed teaching observation.';
      result.summarySha256 = hash(result.summary);
    });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('rejects a claimed passing teaching result that invoked the optional backend for ordinary tutoring', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'teaching-behavior-matrix.json', matrix => {
      matrix.cases.find((item: Json) => item.id === 'DIRECT_EXPLANATION').actualResult.appInvoked = true;
    });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('rejects capability verification for a different surface', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'capability-equivalence.json', ledger => { ledger.capabilities[0].verification.surface = 'mock-mobile-surface'; });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it.each(['baselineFingerprint', 'skillSha256', 'packageFingerprint'])('rejects capability verification missing its %s binding', field => {
    const fixture = completeFixture();
    edit(fixture.root, 'capability-equivalence.json', ledger => { delete ledger.capabilities[0].verification[field]; });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('does not infer capability parity from a verified aggregate gate', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'capability-equivalence.json', ledger => { ledger.capabilities[0].status = 'NOT_TESTED'; });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('releases a complete synthetic fixture with exact owner-excluded host features without claiming capability verification', () => {
    const fixture = capabilityExclusionFixture();
    const result = validate(fixture.root, ['--release', '--inputs', fixture.inputs]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ releaseStatus: 'VERIFIED', releaseBlockers: [], archiveWritten: false,
      skillOnlyTeachingReadiness: 'VERIFIED', capabilityEquivalenceVerified: false, capabilityScopeExcluded: true,
      backendReadiness: 'VERIFIED', gates: { CAPABILITY_EQUIVALENCE_VERIFIED: 'NOT_APPLICABLE',
        PACKAGE_READY: 'VERIFIED', RELEASE_READY: 'VERIFIED' } });
    const ledger = json(fixture.root, 'capability-equivalence.json');
    expect(ledger.status).toBe('NOT_TESTED');
    expect(ledger.scopeDecision.capabilityNames).toEqual(hostCapabilityNames);
    expect(ledger.capabilities.every((item: Json) => item.status === 'NOT_TESTED' && item.executionEvidence.length === 0 &&
      item.verification === undefined)).toBe(true);
    expect(json(fixture.root, 'connection.requirements.json').evidence.some((item: Json) => item.id.startsWith('mock-capability-'))).toBe(false);
  });
  it('keeps the actual package blocked after the host-feature exclusion without inspecting private inputs', () => {
    const result = validate(source, ['--release']);
    expect(result.status).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ releaseStatus: 'BLOCKED', capabilityEquivalenceVerified: false, capabilityScopeExcluded: true,
      gates: { CAPABILITY_EQUIVALENCE_VERIFIED: 'NOT_APPLICABLE', PACKAGE_READY: 'BLOCKED', RELEASE_READY: 'BLOCKED' } });
    expect(report.releaseBlockers).toContain('ACTUAL_INPUT_ARTIFACTS_NOT_INSPECTED');
    expect(report.releaseBlockers).not.toContain('CAPABILITY_EQUIVALENCE_NOT_VERIFIED');
    expect(report.releaseBlockers).not.toContain('CAPABILITY_EQUIVALENCE_VERIFIED');
  });
  it.each(['missing-decision', 'null-decision', 'empty-evidence', 'missing-evidence', 'wrong-kind', 'wrong-status',
    'missing-binding', 'mismatched-binding', 'unreviewed-owner', 'mismatched-gate-evidence', 'verified-gate', 'blocked-gate'])(
    'rejects host-feature exclusion with %s', failure => {
      const fixture = capabilityExclusionFixture();
      edit(fixture.root, 'capability-equivalence.json', ledger => {
        if (failure === 'missing-decision') delete ledger.scopeDecision;
        if (failure === 'null-decision') ledger.scopeDecision = null;
        if (failure === 'empty-evidence') ledger.scopeDecision.evidenceIds = [];
        if (failure === 'unreviewed-owner') ledger.scopeDecision.reviewedBy = '';
      });
      edit(fixture.root, 'connection.requirements.json', connection => {
        const item = connection.evidence.find((entry: Json) => entry.id === fixture.evidenceId);
        if (failure === 'missing-evidence') connection.evidence = connection.evidence.filter((entry: Json) => entry.id !== fixture.evidenceId);
        if (failure === 'wrong-kind') item.kind = 'repository';
        if (failure === 'wrong-status') item.status = 'VERIFIED';
        if (failure === 'missing-binding') delete item.capabilityScopeBinding;
        if (failure === 'mismatched-binding') item.capabilityScopeBinding.reason = 'Mock different owner decision.';
      });
      edit(fixture.root, 'migration-state.json', state => {
        if (failure === 'mismatched-gate-evidence') state.gates.CAPABILITY_EQUIVALENCE_VERIFIED.evidenceIds = ['mock-owner-baseline'];
        if (failure === 'verified-gate') state.gates.CAPABILITY_EQUIVALENCE_VERIFIED.status = 'VERIFIED';
        if (failure === 'blocked-gate') state.gates.CAPABILITY_EQUIVALENCE_VERIFIED.status = 'BLOCKED';
      });
      expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
    });
  it.each(['baselineFingerprint', 'configurationSha256'])('rejects a consistently forged host-feature %s scope binding', field => {
    const fixture = capabilityExclusionFixture();
    editCapabilityScope(fixture, scope => { scope[field] = hash('mock other published baseline'); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it.each(['unknown-feature', 'partial-set', 'duplicate-feature', 'reordered-set', 'extra-feature'])(
    'rejects a host-feature exclusion with %s even when its evidence matches', failure => {
      const fixture = capabilityExclusionFixture();
      editCapabilityScope(fixture, scope => {
        if (failure === 'unknown-feature') scope.capabilityNames[0] = 'Mock unknown capability';
        if (failure === 'partial-set') scope.capabilityNames.pop();
        if (failure === 'duplicate-feature') scope.capabilityNames[1] = scope.capabilityNames[0];
        if (failure === 'reordered-set') scope.capabilityNames.reverse();
        if (failure === 'extra-feature') scope.capabilityNames.push('Mock extra capability');
      });
      expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
    });
  it.each(['aggregate', 'row', 'verification', 'execution-evidence', 'row-not-applicable'])(
    'rejects capability %s claims under owner scope exclusion', failure => {
      const fixture = capabilityExclusionFixture();
      edit(fixture.root, 'capability-equivalence.json', ledger => {
        if (failure === 'aggregate') ledger.status = 'VERIFIED';
        if (failure === 'row') ledger.capabilities[0].status = 'VERIFIED';
        if (failure === 'row-not-applicable') ledger.capabilities[0].status = 'NOT_APPLICABLE';
        if (failure === 'verification') ledger.capabilities[0].verification = { ...review, ...fixture.bindings,
          surface: 'mock-web-surface', evidenceIds: ['mock-account-observation'] };
        if (failure === 'execution-evidence') ledger.capabilities[0].executionEvidence = ['mock-account-observation'];
      });
      expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
    });
  it.each(Object.keys(json(source, 'migration-state.json').gates).filter(name => name !== 'CAPABILITY_EQUIVALENCE_VERIFIED'))(
    'does not permit NOT_APPLICABLE on the unrelated %s gate', gate => {
      const fixture = capabilityExclusionFixture();
      edit(fixture.root, 'migration-state.json', state => { state.gates[gate].status = 'NOT_APPLICABLE'; });
      expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
    });
  it.each(Object.keys(json(source, 'connection.requirements.json').checks))(
    'does not permit NOT_APPLICABLE on connection check %s', check => {
      const fixture = capabilityExclusionFixture();
      edit(fixture.root, 'connection.requirements.json', connection => { connection.checks[check].status = 'NOT_APPLICABLE'; });
      expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
    });
  it.each(['evidence', 'builderReconciliation', 'referenceReconciliation'])(
    'does not permit NOT_APPLICABLE on connection %s', target => {
      const fixture = capabilityExclusionFixture();
      edit(fixture.root, 'connection.requirements.json', connection => {
        if (target === 'evidence') connection.evidence.find((item: Json) => item.id === fixture.evidenceId).status = 'NOT_APPLICABLE';
        else connection[target] = 'NOT_APPLICABLE';
      });
      expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
    });
  it('does not let host-feature exclusion clear pending private-skill owner approval', () => {
    const fixture = capabilityExclusionFixture();
    edit(fixture.root, 'skill-composition.inventory.json', composition => {
      composition.status = 'IMPLEMENTED_NOT_VERIFIED'; composition.ownerReview = { status: 'PENDING' };
    });
    edit(fixture.root, 'migration-state.json', state => {
      for (const gate of ['TUTOR_SKILL_RECONCILED', 'TUTOR_SKILL_BEHAVIOR_VERIFIED', 'MIGRATED_SKILL_RECONCILED']) {
        state.gates[gate].status = 'BLOCKED';
      }
    });
    const result = validate(fixture.root, ['--release', '--inputs', fixture.inputs]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ releaseStatus: 'BLOCKED', skillOnlyTeachingReadiness: 'BLOCKED',
      capabilityEquivalenceVerified: false, capabilityScopeExcluded: true });
    expect(JSON.parse(result.stdout).releaseBlockers).toContain('PRIVATE_SKILL_OWNER_REVIEW_MISSING');
  });
  it('accepts a bound behavior deferral while keeping actual teaching and release blocked', () => {
    const fixture = behaviorDeferralFixture();
    expect(validate(fixture.root).status).toBe(0);
    const result = validate(fixture.root, ['--release', '--inputs', fixture.inputs]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ teachingBehaviorDeferred: true, skillOnlyTeachingReadiness: 'BLOCKED',
      releaseStatus: 'BLOCKED', gates: { TUTOR_SKILL_BEHAVIOR_VERIFIED: 'DEFERRED_POST_MIGRATION',
        PACKAGE_READY: 'BLOCKED', RELEASE_READY: 'BLOCKED' } });
    expect(report.releaseBlockers).toEqual(expect.arrayContaining(['TUTOR_SKILL_BEHAVIOR_VERIFIED', 'SKILL_BEHAVIOR_NOT_VERIFIED']));
    const matrix = json(fixture.root, 'teaching-behavior-matrix.json');
    expect(matrix.cases).toHaveLength(18);
    expect(matrix.cases.every((item: Json) => item.evidenceStatus === 'UNEXECUTED' &&
      item.actualResult === null && item.verification === null)).toBe(true);
  });
  it('rejects behavior deferral with stale, incomplete, untrusted, or broadened evidence', () => {
    const fixture = behaviorDeferralFixture();
    const original = readFileSync(path.join(fixture.root, 'connection.requirements.json'));
    const mutations: Array<(item: Json) => void> = [
      item => { delete item.behaviorDeferralBinding; },
      ...['baselineFingerprint', 'skillSha256', 'packageFingerprint'].map(field =>
        (item: Json) => { item.behaviorDeferralBinding[field] = hash('mock stale artifact'); }),
      item => { item.behaviorDeferralBinding.reason = 'NO_PREVIEW_EXISTS_ANYWHERE'; },
      item => { item.behaviorDeferralBinding.surface = 'Mock unsupported universal claim'; },
      item => { item.behaviorDeferralBinding.postMigrationRequired = false; },
      item => { item.behaviorDeferralBinding.releaseExempt = true; },
      item => { item.kind = 'user_reported'; item.status = 'USER_REPORTED'; }
    ];
    for (const mutate of mutations) {
      writeFileSync(path.join(fixture.root, 'connection.requirements.json'), original);
      edit(fixture.root, 'connection.requirements.json', connection => {
        mutate(connection.evidence.find((item: Json) => item.id === fixture.evidenceId));
      });
      expect(validate(fixture.root).status).toBe(1);
    }
    writeFileSync(path.join(fixture.root, 'connection.requirements.json'), original);
    for (const evidenceIds of [[], [fixture.evidenceId, fixture.evidenceId]]) {
      edit(fixture.root, 'migration-state.json', state => {
        state.gates.TUTOR_SKILL_BEHAVIOR_VERIFIED.evidenceIds = evidenceIds;
      });
      expect(validate(fixture.root).status).toBe(1);
    }
  });
  it('limits behavior deferral to its own gate without allowing connection or evidence deferral', () => {
    const fixture = behaviorDeferralFixture();
    const originalState = readFileSync(path.join(fixture.root, 'migration-state.json'));
    for (const gate of Object.keys(json(fixture.root, 'migration-state.json').gates).filter(name => name !== 'TUTOR_SKILL_BEHAVIOR_VERIFIED')) {
      writeFileSync(path.join(fixture.root, 'migration-state.json'), originalState);
      edit(fixture.root, 'migration-state.json', state => { state.gates[gate].status = 'DEFERRED_POST_MIGRATION'; });
      expect(validate(fixture.root).status).toBe(1);
    }
    writeFileSync(path.join(fixture.root, 'migration-state.json'), originalState);
    const originalConnection = readFileSync(path.join(fixture.root, 'connection.requirements.json'));
    for (const check of Object.keys(json(fixture.root, 'connection.requirements.json').checks)) {
      writeFileSync(path.join(fixture.root, 'connection.requirements.json'), originalConnection);
      edit(fixture.root, 'connection.requirements.json', connection => { connection.checks[check].status = 'DEFERRED_POST_MIGRATION'; });
      expect(validate(fixture.root).status).toBe(1);
    }
    writeFileSync(path.join(fixture.root, 'connection.requirements.json'), originalConnection);
    edit(fixture.root, 'connection.requirements.json', connection => {
      connection.evidence.find((item: Json) => item.id === fixture.evidenceId).status = 'DEFERRED_POST_MIGRATION';
    });
    expect(validate(fixture.root).status).toBe(1);
  });
  it('rejects behavior deferral without owner approval or with a teaching execution claim', () => {
    const fixture = behaviorDeferralFixture();
    edit(fixture.root, 'skill-composition.inventory.json', composition => {
      composition.status = 'IMPLEMENTED_NOT_VERIFIED'; composition.ownerReview = { status: 'PENDING' };
    });
    edit(fixture.root, 'migration-state.json', state => {
      state.gates.TUTOR_SKILL_RECONCILED.status = 'BLOCKED';
      state.gates.MIGRATED_SKILL_RECONCILED.status = 'BLOCKED';
    });
    expect(validate(fixture.root).status).toBe(1);
    const executedFixture = completeFixture();
    const deferralEvidence = json(fixture.root, 'connection.requirements.json').evidence.find((item: Json) => item.id === fixture.evidenceId);
    deferralEvidence.behaviorDeferralBinding = { ...deferralEvidence.behaviorDeferralBinding, ...executedFixture.bindings };
    edit(executedFixture.root, 'connection.requirements.json', connection => { connection.evidence.push(deferralEvidence); });
    edit(executedFixture.root, 'migration-state.json', state => {
      state.gates.TUTOR_SKILL_BEHAVIOR_VERIFIED.status = 'DEFERRED_POST_MIGRATION';
      state.gates.TUTOR_SKILL_BEHAVIOR_VERIFIED.evidenceIds = [fixture.evidenceId];
    });
    expect(validate(executedFixture.root).status).toBe(1);
  });
  it('captures only metadata and leaves latest publication unverified', () => {
    const fixture = completeFixture();
    const captured = json(fixture.root, 'mock-baseline.json');
    expect(captured.status).toBe('IMPLEMENTED_NOT_VERIFIED');
    expect(captured.publicationAssurance).toBe('USER_REPORTED');
    expect(JSON.stringify(captured)).not.toContain('Mock teaching personality');
    expect(captured.configuration.fields.instructions.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
  it('rejects unpublished drafts and path traversal during baseline capture without exposing inputs', () => {
    const fixture = completeFixture();
    edit(fixture.inputs, 'published-gpt.json', configuration => { configuration.publication.status = 'draft'; });
    const result = spawnSync(process.execPath, [captureScript, '--inputs', fixture.inputs, '--output', path.join(fixture.root, 'draft.json')], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('Mock teaching personality');
    edit(fixture.inputs, 'published-gpt.json', configuration => { configuration.publication.status = 'published'; configuration.knowledge[0].path = '../escape.txt'; });
    expect(spawnSync(process.execPath, [captureScript, '--inputs', fixture.inputs, '--output', path.join(fixture.root, 'unsafe.json')]).status).toBe(1);
  });
});

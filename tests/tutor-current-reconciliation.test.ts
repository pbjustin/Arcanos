import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createUpdatedFixture, writeFixtureJson } from './helpers/tutor-updated-release-fixture.js';
import { authorizeFixtureDiagnosticRevision, authorizeFixtureRevision } from './helpers/tutor-skill-revision-fixture.js';

type Json = ReturnType<typeof JSON.parse>;
const helper = pathToFileURL(path.join(process.cwd(), 'scripts/tutor-current-reconciliation.mjs')).href;
const roots: string[] = [];
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const readJson = (file: string): Json => JSON.parse(readFileSync(file, 'utf8'));
const review = { reviewedBy: 'Mock owner', reviewedAt: '2026-09-26T00:00:00Z' };
const skillPath = 'skills/arcanos-tutor/SKILL.md';
const nativeSkillPath = 'skills/instructions/SKILL.md';
const instruction = 'Mock private teaching core: explain one small step, then invite practice.\n';

function invoke(options: Json, operation = 'validateCurrentTutorReconciliation') {
  const code = `import * as h from ${JSON.stringify(helper)};
    const o=JSON.parse(process.argv[1]); o.evidence=new Map(o.evidence.map(e=>[e.id,e]));
    try { console.log(JSON.stringify(await h[process.argv[2]](o))); }
    catch(e) { console.error(/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'MOCK_VALIDATION_REJECTED'); process.exitCode=1; }`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(options), operation], { encoding: 'utf8' });
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arcanos-tutor-current-'));
  roots.push(root);
  expect(spawnSync('git', ['init', '--quiet', root], { windowsHide: true }).status).toBe(0);
  writeFileSync(path.join(root, '.gitignore'), '.local-migration/\n');
  const inputRoot = path.join(root, '.local-migration/arcanos-tutor');
  const packageRoot = path.join(root, 'integration/package');
  mkdirSync(inputRoot, { recursive: true });
  mkdirSync(path.join(packageRoot, 'skills/arcanos-tutor'), { recursive: true });
  const expected = 'Mock small-step explanation with optional practice.';
  writeFixtureJson(path.join(inputRoot, 'published-gpt.json'), { schemaVersion: 1,
    publication: { status: 'published', version: 'mock-v1', publishedAt: '2026-03-05T23:54' },
    displayName: 'Mock Tutor', description: 'Mock description.', instructions: instruction,
    conversationStarters: [], enabledCapabilities: [], actions: [], sharingStatus: 'private',
    representativeBehavior: [expected], knowledge: [] });
  const baselinePath = path.join(root, 'baseline.inventory.json');
  const captured = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts/capture-tutor-baseline.mjs'),
    '--inputs', inputRoot, '--output', baselinePath], { encoding: 'utf8' });
  expect(captured.status).toBe(0);
  const baseline = readJson(baselinePath);
  baseline.status = 'VERIFIED';
  baseline.publicationReview = { ...review, latestPublishedConfirmed: true, evidenceIds: ['mock-baseline-owner'] };
  writeFixtureJson(baselinePath, baseline);
  const baselineFingerprint = hash(JSON.stringify({ configuration: baseline.configuration.sha256, knowledge: [] }));
  const behaviorPath = path.join(inputRoot, 'mock-behavior.json');
  writeFixtureJson(behaviorPath, { cases: [{ id: 'tutoring', expectedBehavior: expected,
    privateSourceExcerpts: [{ line: 1, text: instruction.trimEnd(), sha256: hash(instruction.trimEnd()) }] }] });
  const behaviorBytes = readFileSync(behaviorPath);
  writeFixtureJson(path.join(inputRoot, 'mock-owner-review.json'), { ...review, evidenceId: 'mock-baseline-owner',
    latestPublishedConfirmed: true, completeTranscriptionApproved: true, representativeBehaviorApproved: true,
    reviewContext: { configurationSha256: baseline.configuration.sha256, baselineFingerprint,
      expectedBehaviorArtifact: { path: 'mock-behavior.json', sha256: hash(behaviorBytes), sizeBytes: behaviorBytes.length } } });
  writeFileSync(path.join(packageRoot, skillPath), '---\nname: arcanos-tutor\ndescription: Mock teaching skill.\n---\n'
    + '# Teaching\n{{PUBLISHED_TUTOR_INSTRUCTIONS}}\n# Public safeguards\nBackend use is optional.\n');
  writeFixtureJson(path.join(packageRoot, 'plugin.json'), { name: 'mock-tutor', version: '0.1.0' });
  writeFixtureJson(path.join(packageRoot, '.app.json'), { apps: { mock: { id: 'mock-app', optional: true } } });
  const referenceReview = { schemaVersion: 1, references: [] };
  writeFixtureJson(path.join(root, 'integration/reference-review.json'), referenceReview);
  const composed = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts/compose-tutor-skill.mjs'),
    '--inputs', inputRoot, '--baseline', baselinePath, '--package', packageRoot,
    '--owner-review', 'mock-owner-review.json', '--output', 'mock-composed'], { encoding: 'utf8' });
  expect(composed.stderr).toBe('');
  expect(composed.status).toBe(0);
  const summary = JSON.parse(composed.stdout);
  const compositionBinding = { baselineFingerprint, skillSha256: summary.skill.sha256,
    packageFingerprint: summary.packageFingerprint };
  const composition = { schemaVersion: 1, kind: 'PRIVATE_COMPOSED_RELEASE_CANDIDATE', status: 'VERIFIED',
    baselineFingerprint, configurationSha256: baseline.configuration.sha256, outputDirectory: 'mock-composed',
    skill: summary.skill, packageFingerprint: summary.packageFingerprint, report: summary.report,
    sectionCount: summary.sectionCount, approvedRuleIds: summary.approvedRuleIds, privateContentsTracked: false,
    ownerReview: { status: 'APPROVED', ...review, ...compositionBinding, evidenceIds: ['mock-composition-owner'] } };
  const approved = readFileSync(path.join(inputRoot, 'mock-composed/package', skillPath), 'utf8');
  const chain = authorizeFixtureDiagnosticRevision(authorizeFixtureRevision(createUpdatedFixture(inputRoot, approved)));
  const installedRoot = 'mock-installed-current';
  cpSync(chain.saved.bundle, path.join(inputRoot, installedRoot), { recursive: true });
  const state: Json = structuredClone(chain.saved.state);
  for (const gate of ['SKILL_RECONCILED', 'MIGRATED_SKILL_RECONCILED']) {
    state.gates[gate] = { status: 'VERIFIED', evidenceIds: ['mock-current-review'] };
  }
  const options: Json = { inputRoot, packageRoot, baseline, composition, referenceReview, state,
    revision: chain.revision, diagnosticRevision: chain.diagnosticRevision, intakeRelease: chain.intakeRelease,
    currentRelease: chain.saved.release, evidence: [chain.sourceEvidence, chain.ownerEvidence, chain.reviewEvidence,
      chain.intakeEvidence, chain.diagnosticOwnerEvidence, chain.diagnosticReviewEvidence, chain.saved.evidence,
      { id: 'mock-composition-owner', kind: 'user_reported', status: 'USER_REPORTED', compositionBinding }] };
  const bound = invoke(options, 'currentReconciliationBinding');
  expect(bound.status).toBe(0);
  const sources = invoke(options, 'currentReconciliationSources');
  expect(sources.status).toBe(0);
  options.record = { schemaVersion: 1, kind: 'CURRENT_SAVED_RELEASE_RECONCILIATION', status: 'VERIFIED',
    binding: JSON.parse(bound.stdout), sourceEvidenceIds: JSON.parse(sources.stdout),
    installedCapture: { rootPath: installedRoot, packageFingerprint: chain.saved.release.capture.packageFingerprint },
    review: { ...review, evidenceIds: ['mock-current-review'] } };
  options.evidence.push({ id: 'mock-current-review', kind: 'repository', status: 'VERIFIED',
    currentReconciliationBinding: { ...options.record.binding, sourceEvidenceIds: options.record.sourceEvidenceIds,
      installedCapture: options.record.installedCapture } });
  return { root, options, inputRoot, packageRoot, installedRoot };
}
type Fixture = ReturnType<typeof fixture>;
function evidence(f: Fixture, id: string): Json { return f.options.evidence.find((item: Json) => item.id === id); }
function mutateJson(file: string, mutate: (value: Json) => void) {
  const value = readJson(file); mutate(value); writeFixtureJson(file, value);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('arcanos-tutor-current-')) {
      throw new Error('Unexpected fixture path');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Reviewed current Tutor release reconciliation', () => {
  it('keeps the release blocked without private inputs despite reviewed current metadata', () => {
    const result = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts/validate-arcanos-tutor-package.mjs')],
      { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.releaseStatus).toBe('BLOCKED');
    expect(report.currentReconciliation.artifactInspection).toBe('NOT_INSPECTED');
    expect(report.currentReconciliationInspection).toBeNull();
    expect(report.releaseBlockers).toEqual(expect.arrayContaining(['CURRENT_RECONCILIATION_BYTES_NOT_INSPECTED',
      'LIVE_TUTOR_CALL_VERIFIED', 'PARITY_VERIFIED', 'REVISED_SKILL_PARITY_NOT_VERIFIED']));
  });

  it('inspects original approved source, both authorized insertions, saved archive and distinct installed bytes', () => {
    const f = fixture();
    const metadata = invoke(f.options);
    expect(metadata.stderr).toBe('');
    expect(metadata.status).toBe(0);
    expect(JSON.parse(metadata.stdout).artifactInspection).toBe('NOT_INSPECTED');
    const result = invoke(f.options, 'inspectCurrentTutorReconciliation');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ artifactInspection: 'VERIFIED', installedMemberCount: 13,
      originalApprovedBytesPreserved: true, revisionCount: 2, referenceCount: 0, appOptional: true,
      behaviorVerified: false, parityVerified: false, backendVerified: false });
    expect(result.stdout).not.toContain(instruction.trim());
  });

  it.each([
    ['unapproved baseline', (f: Fixture) => { f.options.baseline.status = 'BLOCKED'; }],
    ['reference addition', (f: Fixture) => { f.options.referenceReview.references.push({ sourcePath: 'mock-reference.txt' }); }],
    ['unapproved composition', (f: Fixture) => { f.options.composition.ownerReview.status = 'PENDING'; }],
    ['forged composition approval', (f: Fixture) => { evidence(f, 'mock-composition-owner').compositionBinding.skillSha256 = hash('mock wrong'); }],
    ['missing composition evidence', (f: Fixture) => { f.options.composition.ownerReview.evidenceIds = []; }],
    ['missing intake authorization', (f: Fixture) => { f.options.revision.authorization.evidenceIds = []; }],
    ['forged diagnostic authorization', (f: Fixture) => { evidence(f, 'mock-owner-diagnostic-authorization').skillRevisionAuthorization.insertionSha256 = hash('mock wrong'); }],
    ['missing independent revision review', (f: Fixture) => { f.options.diagnosticRevision.review.evidenceIds = []; }],
    ['incomplete revision chain', (f: Fixture) => { f.options.intakeRelease = null; }],
    ['wrong release fingerprint', (f: Fixture) => { f.options.record.binding.packageFingerprint = hash('mock wrong'); }],
    ['wrong approved fingerprint', (f: Fixture) => { f.options.record.binding.approvedPackageFingerprint = hash('mock wrong'); }],
    ['wrong chain fingerprint', (f: Fixture) => { f.options.record.binding.revisionChainFingerprint = hash('mock wrong'); }],
    ['omitted chain evidence IDs', (f: Fixture) => { f.options.record.sourceEvidenceIds.diagnosticAuthorization = []; }],
    ['unbound reconciliation review', (f: Fixture) => { delete evidence(f, 'mock-current-review').currentReconciliationBinding; }],
    ['unverified reconciliation review', (f: Fixture) => { evidence(f, 'mock-current-review').status = 'USER_REPORTED'; }],
    ['wrong gate review IDs', (f: Fixture) => { f.options.state.gates.SKILL_RECONCILED.evidenceIds = ['mock-other']; }],
    ['unreviewed extra claim', (f: Fixture) => { f.options.record.backendVerified = true; }]
  ] as const)('rejects %s', (_label, change) => {
    const f = fixture(); change(f);
    expect(invoke(f.options).status).toBe(1);
  });

  it.each(['same', 'case alias', 'ancestor', 'case ancestor', 'child', 'composition', 'traversal'])
    ('rejects %s capture paths without treating one directory as independent installation evidence', kind => {
      const f = fixture();
      const saved = f.options.currentRelease.capture.rootPath;
      const paths: Record<string, string> = { same: saved, 'case alias': saved.toUpperCase(),
        ancestor: saved.split('/')[0], 'case ancestor': saved.split('/')[0].toUpperCase(),
        child: `${saved}/nested`, composition: f.options.composition.outputDirectory, traversal: '../mock-escape' };
      f.options.record.installedCapture.rootPath = paths[kind];
      expect(invoke(f.options).status).toBe(1);
    });

  it.each(['baseline bytes', 'owner review', 'expected behavior', 'original composition', 'composition report',
    'saved archive', 'intake source', 'diagnostic source', 'installed skill', 'installed app', 'unlisted installed reference'])
    ('inspects and rejects changed %s even when metadata and release blockers are unchanged', target => {
      const f = fixture();
      const input = (file: string) => path.join(f.inputRoot, file);
      const files: Record<string, string> = {
        'baseline bytes': input('published-gpt.json'), 'owner review': input('mock-owner-review.json'),
        'expected behavior': input('mock-behavior.json'),
        'original composition': input(`mock-composed/package/${skillPath}`),
        'composition report': input('mock-composed/composition-report.json'),
        'saved archive': input(f.options.currentRelease.capture.archive.path),
        'intake source': input(`${f.options.revision.from.rootPath}/${nativeSkillPath}`),
        'diagnostic source': input(`${f.options.intakeRelease.capture.rootPath}/${nativeSkillPath}`),
        'installed skill': input(`${f.installedRoot}/${nativeSkillPath}`),
        'installed app': input(`${f.installedRoot}/.app.json`),
        'unlisted installed reference': input(`${f.installedRoot}/skills/instructions/lookup/mock-extra.txt`) };
      if (target === 'owner review') mutateJson(files[target], value => { value.completeTranscriptionApproved = false; });
      else if (target === 'installed app') mutateJson(files[target], value => { value.apps['arcanos-tutor'].optional = false; });
      else if (target === 'unlisted installed reference') writeFileSync(files[target], 'Mock unexpected reference.');
      else writeFileSync(files[target], Buffer.concat([readFileSync(files[target]), Buffer.from('\nMock unexpected byte change.\n')]));
      expect(invoke(f.options).status).toBe(0);
      const result = invoke(f.options, 'inspectCurrentTutorReconciliation');
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/^[A-Z][A-Z0-9_]+\r?\n$/);
      expect(result.stderr + result.stdout).not.toContain(instruction.trim());
    });

  it('requires the existing ignored private boundary before inspection', () => {
    const f = fixture();
    writeFileSync(path.join(f.root, '.gitignore'), '');
    const result = invoke(f.options, 'inspectCurrentTutorReconciliation');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PRIVATE_INPUT_TRACKED_OR_NOT_IGNORED');
  });

  it.each(['historical skill', 'historical fingerprint', 'missing rows', 'blocked disposition', 'unverified parity'])
    ('does not allow %s in a future final-release input check', defect => {
      const f = fixture();
      f.options.parity = { status: 'VERIFIED', cases: Array.from({ length: 16 }, () => ({ disposition: 'PASS',
        oldGpt: { artifactSha256: f.options.baseline.configuration.sha256,
          configurationFingerprint: f.options.composition.baselineFingerprint },
        plugin: { artifactSha256: f.options.currentRelease.approvedSkillSha256,
          configurationFingerprint: f.options.currentRelease.capture.packageFingerprint } })) };
      if (defect === 'historical skill') f.options.parity.cases[0].plugin.artifactSha256 = f.options.composition.skill.sha256;
      if (defect === 'historical fingerprint') f.options.parity.cases[0].plugin.configurationFingerprint = f.options.composition.packageFingerprint;
      if (defect === 'missing rows') f.options.parity.cases.pop();
      if (defect === 'blocked disposition') f.options.parity.cases[0].disposition = 'BLOCKER';
      if (defect === 'unverified parity') f.options.parity.status = 'BLOCKED';
      const result = invoke(f.options, 'verifyCurrentTutorReleaseInputs');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('CURRENT_PARITY_RESULT_STALE');
    });
});

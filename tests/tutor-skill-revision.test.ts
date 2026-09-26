import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { authorizeFixtureDiagnosticRevision, authorizeFixtureRevision } from './helpers/tutor-skill-revision-fixture.js';
import { createUpdatedFixture, refreshUpdatedFixture, writeFixtureJson } from './helpers/tutor-updated-release-fixture.js';

type Json = ReturnType<typeof JSON.parse>;
const helper = pathToFileURL(path.join(process.cwd(), 'scripts/tutor-skill-revision.mjs')).href;
const roots: string[] = [];
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arcanos-tutor-revision-'));
  roots.push(root);
  expect(spawnSync('git', ['init', '--quiet', root], { windowsHide: true }).status).toBe(0);
  writeFileSync(path.join(root, '.gitignore'), '.local-migration/\n');
  const inputRoot = path.join(root, '.local-migration/arcanos-tutor');
  mkdirSync(inputRoot, { recursive: true });
  writeFixtureJson(path.join(inputRoot, 'published-gpt.json'), { instructions: 'Mock published baseline held separately from the revised skill.',
    representativeBehavior: ['Mock expected original teaching behavior.'] });
  const before = '---\nname: arcanos-tutor\ndescription: Mock Tutor skill.\n---\nMock original teaching text stays unchanged.\n';
  const composition = { status: 'VERIFIED', skill: { sha256: hash(before), sizeBytes: Buffer.byteLength(before) },
    ownerReview: { status: 'APPROVED', skillSha256: hash(before) } };
  return { root, inputRoot, composition, ...authorizeFixtureRevision(createUpdatedFixture(inputRoot, before)) };
}
type Fixture = ReturnType<typeof fixture> & Partial<ReturnType<typeof authorizeFixtureDiagnosticRevision>>;
function run(f: Fixture, inspect = true) {
  const options = { inputRoot: f.inputRoot, revision: f.revision, composition: f.composition,
    currentRelease: f.saved.release, diagnosticRevision: f.diagnosticRevision, intakeRelease: f.intakeRelease,
    evidence: [f.sourceEvidence, f.ownerEvidence, f.reviewEvidence, f.saved.evidence,
      f.intakeEvidence, f.diagnosticOwnerEvidence, f.diagnosticReviewEvidence].filter(Boolean) };
  const code = `import {inspectTutorSkillRevisionChain,validateTutorSkillRevisionChain} from ${JSON.stringify(helper)};
    const o=JSON.parse(process.argv[1]);o.evidence=new Map(o.evidence.map(e=>[e.id,e]));
    try{console.log(JSON.stringify(${inspect ? 'await inspectTutorSkillRevisionChain(o)' : 'validateTutorSkillRevisionChain(o)'}));}
    catch(e){console.error(e.message);process.exitCode=1;}`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(options)], { encoding: 'utf8' });
}
function rebindChangedSkill(f: Fixture) {
  const after = readFileSync(path.join(f.saved.bundle, 'skills/instructions/SKILL.md'));
  const changed = hash(after);
  const revision = f.diagnosticRevision ?? f.revision;
  const owner = f.diagnosticOwnerEvidence ?? f.ownerEvidence;
  const review = f.diagnosticReviewEvidence ?? f.reviewEvidence;
  revision.to.skillSha256 = changed;
  f.saved.release.approvedSkillSha256 = changed;
  owner.skillRevisionAuthorization.toSkillSha256 = changed;
  review.skillRevisionBinding.toSkillSha256 = changed;
  refreshUpdatedFixture(f.saved);
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('arcanos-tutor-revision-')) {
      throw new Error('Unexpected fixture path');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Scoped successor skill approval without historical evidence rewriting', () => {
  it('proves one authorized insertion and preserves the original approved skill bytes', () => {
    const f = fixture();
    const original = structuredClone(f.composition);
    const result = run(f);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ sourceValidation: 'PASS', originalBytesPreserved: true,
      unchangedFileCount: 4, manifestVersionOnlyChanges: true, behaviorVerified: false });
    expect(f.composition).toEqual(original);
  });
  it.each(['missing-owner', 'wrong-owner-kind', 'conflicting-owner', 'missing-review', 'conflicting-review',
    'wrong-source', 'old-release', 'changed-history', 'scope-broadening', 'invalid-offset', 'extra-field'])(
    'rejects unsupported revision metadata: %s', failure => {
      const f = fixture();
      if (failure === 'missing-owner') f.revision.authorization.evidenceIds = [];
      if (failure === 'wrong-owner-kind') f.ownerEvidence.kind = 'repository';
      if (failure === 'conflicting-owner') f.ownerEvidence.skillRevisionAuthorization.toSkillSha256 = hash('mock conflict');
      if (failure === 'missing-review') f.revision.review.evidenceIds = [];
      if (failure === 'conflicting-review') f.reviewEvidence.skillRevisionBinding.insertionOffsetBytes += 1;
      if (failure === 'wrong-source') f.sourceEvidence.updatedReleaseBinding.archiveSha256 = hash('mock wrong source');
      if (failure === 'old-release') f.saved.release.version = '0.8.3';
      if (failure === 'changed-history') f.composition.skill.sha256 = hash('mock rewritten history');
      if (failure === 'scope-broadening') f.revision.scope = 'ARBITRARY_SKILL_REWRITE';
      if (failure === 'invalid-offset') f.revision.insertion.offsetBytes = -1;
      if (failure === 'extra-field') f.revision.allowChangedOriginal = true;
      expect(run(f, false).status).toBe(1);
    });
  it('rejects a changed insertion even when the successor skill digest is rebound', () => {
    const f = fixture();
    const file = path.join(f.saved.bundle, 'skills/instructions/SKILL.md');
    const bytes = readFileSync(file);
    bytes[f.revision.insertion.offsetBytes + 1] ^= 1;
    writeFileSync(file, bytes);
    rebindChangedSkill(f);
    expect(run(f).stderr).toContain('SKILL_REVISION_ORIGINAL_BYTES_CHANGED');
  });
  it('rejects mutation of preserved teaching bytes despite refreshed inventory and approval hashes', () => {
    const f = fixture();
    const file = path.join(f.saved.bundle, 'skills/instructions/SKILL.md');
    const bytes = readFileSync(file);
    bytes[bytes.length - 3] ^= 1;
    writeFileSync(file, bytes);
    rebindChangedSkill(f);
    expect(run(f).stderr).toContain('SKILL_REVISION_ORIGINAL_BYTES_CHANGED');
  });
  it('rejects source archive substitution', () => {
    const f = fixture();
    writeFileSync(path.join(f.inputRoot, f.revision.from.archive.path), 'mock substituted archive');
    expect(run(f).stderr).toContain('SKILL_REVISION_SOURCE_ARCHIVE_MISMATCH');
  });
  it('rejects source extraction drift independent of the valid archived source', () => {
    const f = fixture();
    writeFileSync(path.join(f.inputRoot, f.revision.from.rootPath, 'skills/instructions/agents/openai.yaml'), 'mock changed metadata');
    expect(run(f).stderr).toContain('SKILL_REVISION_SOURCE_EXTRACTION_MISMATCH');
  });
  it('rejects changes to an otherwise legitimate package file', () => {
    const f = fixture();
    writeFileSync(path.join(f.saved.bundle, 'skills/instructions/agents/openai.yaml'), 'interface:\n  display_name: Mock changed name\n');
    refreshUpdatedFixture(f.saved);
    expect(run(f).stderr).toContain('SKILL_REVISION_OTHER_FILE_CHANGED');
  });
  it('rejects additional manifest changes even when both manifest copies agree', () => {
    const f = fixture();
    for (const name of ['plugin.json', '.codex-plugin/plugin.json']) {
      const manifest: Json = JSON.parse(readFileSync(path.join(f.saved.bundle, name), 'utf8'));
      manifest.description = 'Mock unauthorized description rewrite.';
      writeFixtureJson(path.join(f.saved.bundle, name), manifest);
    }
    refreshUpdatedFixture(f.saved);
    expect(run(f).stderr).toContain('SKILL_REVISION_MANIFEST_SCOPE_CHANGED');
  });
});

describe('Diagnostic-only successor chain (synthetic byte and authorization evidence)', () => {
  function diagnosticFixture() {
    const first = fixture();
    return { ...first, ...authorizeFixtureDiagnosticRevision(first) };
  }
  it('proves both insertions without rewriting historical composition or intake approval', () => {
    const f = diagnosticFixture();
    const original = structuredClone({ composition: f.composition, revision: f.revision });
    const result = run(f);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ sourceValidation: 'PASS', revisionCount: 2,
      originalBytesPreserved: true, behaviorVerified: false });
    expect(report.steps.map((step: Json) => step.scope)).toEqual(['CONFIDENCE_TIME_INTAKE_ONLY', 'DIAGNOSTIC_SINGLE_QUESTION_ONLY']);
    expect(report.steps.every((step: Json) => step.unchangedFileCount === 4 && step.manifestVersionOnlyChanges)).toBe(true);
    expect({ composition: f.composition, revision: f.revision }).toEqual(original);
  });
  it.each(['missing-intake-release', 'missing-diagnostic-record', 'unsupported-version', 'wrong-scope',
    'wrong-predecessor', 'unbound-intake-evidence', 'missing-owner', 'conflicting-owner', 'missing-review',
    'conflicting-review', 'changed-first-approval', 'false-records'])(
    'rejects an unsupported diagnostic chain: %s', failure => {
      const f: Fixture = diagnosticFixture();
      if (failure === 'missing-intake-release') delete f.intakeRelease;
      if (failure === 'missing-diagnostic-record') delete f.diagnosticRevision;
      if (failure === 'unsupported-version') f.diagnosticRevision.to.version = '0.8.6';
      if (failure === 'wrong-scope') f.diagnosticRevision.scope = 'GENERAL_TEACHING_REWRITE';
      if (failure === 'wrong-predecessor') f.diagnosticRevision.from.releaseId = 'pluginrel_mock_unrelated';
      if (failure === 'unbound-intake-evidence') f.intakeEvidence.updatedReleaseBinding.archiveSha256 = hash('mock unrelated archive');
      if (failure === 'missing-owner') f.diagnosticRevision.authorization.evidenceIds = [];
      if (failure === 'conflicting-owner') f.diagnosticOwnerEvidence.skillRevisionAuthorization.insertionSha256 = hash('mock unrelated insertion');
      if (failure === 'missing-review') f.diagnosticRevision.review.evidenceIds = [];
      if (failure === 'conflicting-review') f.diagnosticReviewEvidence.skillRevisionBinding.insertionOffsetBytes += 1;
      if (failure === 'changed-first-approval') f.ownerEvidence.skillRevisionAuthorization.toSkillSha256 = hash('mock rewritten intake approval');
      if (failure === 'false-records') { f.diagnosticRevision = false; f.intakeRelease = false; }
      expect(run(f, false).status).toBe(1);
    });
  it('rejects diagnostic insertion drift despite rebinding the successor skill digest', () => {
    const f = diagnosticFixture();
    const file = path.join(f.saved.bundle, 'skills/instructions/SKILL.md');
    const bytes = readFileSync(file);
    bytes[f.diagnosticRevision.insertion.offsetBytes + 1] ^= 1;
    writeFileSync(file, bytes);
    rebindChangedSkill(f);
    expect(run(f).stderr).toContain('SKILL_REVISION_ORIGINAL_BYTES_CHANGED');
  });
  it('rejects changes to the already approved intake override during the diagnostic insertion', () => {
    const f = diagnosticFixture();
    const file = path.join(f.saved.bundle, 'skills/instructions/SKILL.md');
    const bytes = readFileSync(file);
    bytes[f.revision.insertion.offsetBytes + 1] ^= 1;
    writeFileSync(file, bytes);
    rebindChangedSkill(f);
    expect(run(f).stderr).toContain('SKILL_REVISION_ORIGINAL_BYTES_CHANGED');
  });
  it('rejects substitution of the actual saved predecessor archive', () => {
    const f = diagnosticFixture();
    writeFileSync(path.join(f.inputRoot, f.intakeRelease.capture.archive.path), 'mock replaced predecessor');
    expect(run(f).stderr).toContain('UPDATED_ARCHIVE_DIGEST_MISMATCH');
  });
  it('does not infer a one-task diagnostic from question-mark count in synthetic review fixtures', () => {
    const reviewed = (caseRecord: { diagnostic: boolean; learnerResponseTasks: number; stackedAlternatives: number }) =>
      !caseRecord.diagnostic || (caseRecord.learnerResponseTasks === 1 && caseRecord.stackedAlternatives === 0);
    // These are supplied reviewer facts, not NLP classification or installed model proof.
    expect(reviewed({ diagnostic: true, learnerResponseTasks: 1, stackedAlternatives: 0 })).toBe(true);
    expect(reviewed({ diagnostic: true, learnerResponseTasks: 1, stackedAlternatives: 3 })).toBe(false);
    expect(reviewed({ diagnostic: true, learnerResponseTasks: 2, stackedAlternatives: 0 })).toBe(false);
    expect(reviewed({ diagnostic: true, learnerResponseTasks: 0, stackedAlternatives: 0 })).toBe(false);
    expect(reviewed({ diagnostic: false, learnerResponseTasks: 0, stackedAlternatives: 0 })).toBe(true);
  });
});

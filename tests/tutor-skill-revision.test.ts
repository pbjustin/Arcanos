import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { authorizeFixtureRevision } from './helpers/tutor-skill-revision-fixture.js';
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
type Fixture = ReturnType<typeof fixture>;
function run(f: Fixture, inspect = true) {
  const options = { inputRoot: f.inputRoot, revision: f.revision, composition: f.composition,
    currentRelease: f.saved.release, evidence: [f.sourceEvidence, f.ownerEvidence, f.reviewEvidence, f.saved.evidence] };
  const code = `import {inspectTutorSkillRevision,validateTutorSkillRevision} from ${JSON.stringify(helper)};
    const o=JSON.parse(process.argv[1]);o.evidence=new Map(o.evidence.map(e=>[e.id,e]));
    try{console.log(JSON.stringify(${inspect ? 'await inspectTutorSkillRevision(o)' : 'validateTutorSkillRevision(o.revision,o)'}));}
    catch(e){console.error(e.message);process.exitCode=1;}`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(options)], { encoding: 'utf8' });
}
function rebindChangedSkill(f: Fixture) {
  const after = readFileSync(path.join(f.saved.bundle, 'skills/instructions/SKILL.md'));
  const changed = hash(after);
  f.revision.to.skillSha256 = changed;
  f.saved.release.approvedSkillSha256 = changed;
  f.ownerEvidence.skillRevisionAuthorization.toSkillSha256 = changed;
  f.reviewEvidence.skillRevisionBinding.toSkillSha256 = changed;
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

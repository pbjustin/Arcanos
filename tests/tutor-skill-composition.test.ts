import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type Json = ReturnType<typeof JSON.parse>;
const roots: string[] = [];
const script = path.join(process.cwd(), 'scripts/compose-tutor-skill.mjs');
const capture = path.join(process.cwd(), 'scripts/capture-tutor-baseline.mjs');
const skillPath = 'skills/arcanos-tutor/SKILL.md';
const placeholder = '{{PUBLISHED_TUTOR_INSTRUCTIONS}}';
const mockInstructions = '## Mock introduction\r\nAsk diagnostic questions about prior knowledge and adapt the explanation. π\r\n\r\n## Mock practice\r\nUse a worked example and offer a hint.\r\n';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const readJson = (file: string): Json => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file: string, value: Json) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const review = { reviewedBy: 'mock owner', reviewedAt: '2026-09-25T00:00:00Z' };

function fixture(withReference = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arcanos-tutor-composition-'));
  roots.push(root);
  expect(spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8', windowsHide: true }).status).toBe(0);
  writeFileSync(path.join(root, '.gitignore'), '.local-migration/\n');
  const inputRoot = path.join(root, '.local-migration/arcanos-tutor');
  const packageRoot = path.join(root, 'integration/package');
  mkdirSync(inputRoot, { recursive: true });
  mkdirSync(path.join(packageRoot, 'skills/arcanos-tutor'), { recursive: true });
  const expected = 'Mock expectation: diagnose prior knowledge and adapt the explanation.';
  const published = {
    schemaVersion: 1, publication: { status: 'published', version: 'mock-v1', publishedAt: '2026-03-05T23:54' },
    displayName: 'Mock Tutor', description: 'Mock description', instructions: mockInstructions,
    conversationStarters: [], enabledCapabilities: [], actions: [], sharingStatus: 'private',
    representativeBehavior: [expected], knowledge: withReference ? [{ name: 'mock-notes.txt', path: 'mock-notes.txt' }] : []
  };
  writeJson(path.join(inputRoot, 'published-gpt.json'), published);
  if (withReference) writeFileSync(path.join(inputRoot, 'mock-notes.txt'), 'Mock reference only.\n');
  const baselinePath = path.join(root, 'baseline.inventory.json');
  const result = spawnSync(process.execPath, [capture, '--inputs', inputRoot, '--output', baselinePath], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  const baseline = readJson(baselinePath);
  baseline.status = 'VERIFIED';
  baseline.publicationReview = { ...review, latestPublishedConfirmed: true, evidenceIds: ['mock-owner-review'] };
  writeJson(baselinePath, baseline);
  const fingerprint = hash(JSON.stringify({ configuration: baseline.configuration.sha256,
    knowledge: baseline.knowledge.map(({ name, sha256, sizeBytes }: Json) => ({ name, sha256, sizeBytes })) }));
  const behavior = { cases: [{ id: 'tutoring', expectedBehavior: expected,
    privateSourceExcerpts: [{ line: 2, text: mockInstructions.split('\r\n')[1], sha256: hash(mockInstructions.split('\r\n')[1]) }] }] };
  const behaviorPath = path.join(inputRoot, 'mock-behavior.json');
  writeJson(behaviorPath, behavior);
  writeJson(path.join(inputRoot, 'mock-owner-review.json'), { ...review, evidenceId: 'mock-owner-review',
    latestPublishedConfirmed: true, completeTranscriptionApproved: true, representativeBehaviorApproved: true,
    reviewContext: { configurationSha256: baseline.configuration.sha256, baselineFingerprint: fingerprint,
      expectedBehaviorArtifact: { path: 'mock-behavior.json', sha256: hash(readFileSync(behaviorPath)), sizeBytes: readFileSync(behaviorPath).length } } });
  writeFileSync(path.join(packageRoot, skillPath), `---\nname: arcanos-tutor\ndescription: Mock skill.\n---\n# Teaching\n${placeholder}\n# Public safeguards\nBackend use is optional.\n`);
  writeJson(path.join(packageRoot, 'plugin.json'), { name: 'mock-tutor', version: '0.1.0' });
  writeJson(path.join(packageRoot, '.app.json'), { apps: { mock: { id: 'mock-app', required: false } } });
  const references: Json[] = [];
  if (withReference) {
    const packagePath = 'skills/arcanos-tutor/references/mock-notes.txt';
    mkdirSync(path.dirname(path.join(packageRoot, packagePath)), { recursive: true });
    const bytes = readFileSync(path.join(inputRoot, 'mock-notes.txt'));
    writeFileSync(path.join(packageRoot, packagePath), bytes);
    references.push({ sourcePath: 'mock-notes.txt', packagePath, sha256: hash(bytes), sizeBytes: bytes.length,
      approvedForRepository: true, ...review });
  }
  const referencePath = path.join(root, 'integration/reference-review.json');
  writeJson(referencePath, { schemaVersion: 1, references });
  return { root, inputRoot, packageRoot, baselinePath, referencePath, baseline, fingerprint };
}
type Fixture = ReturnType<typeof fixture>;
function compose(f: Fixture, output = 'mock-composed', extra: string[] = []) {
  return spawnSync(process.execPath, [script, '--inputs', f.inputRoot, '--baseline', f.baselinePath,
    '--package', f.packageRoot, '--owner-review', 'mock-owner-review.json', '--output', output, ...extra], { encoding: 'utf8' });
}
function inspect(f: Fixture, extra: Json = {}) {
  const options = { inputRoot: f.inputRoot, baseline: readJson(f.baselinePath), packageRoot: f.packageRoot,
    referenceReview: readJson(f.referencePath), outputDirectory: 'mock-composed', ...extra };
  const code = 'import {inspectComposedTutorSkill} from '+JSON.stringify(pathToFileURL(script).href)+'; '
    + 'try { console.log(JSON.stringify(await inspectComposedTutorSkill(JSON.parse(process.argv[1])))); } catch { process.stderr.write("MOCK_INSPECTION_REJECTED\\n"); process.exitCode=1; }';
  return spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(options)], { encoding: 'utf8' });
}
function mutate(file: string, fn: (value: Json) => void) { const value = readJson(file); fn(value); writeJson(file, value); }

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('arcanos-tutor-composition-')) throw new Error('Unexpected fixture path');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Private Tutor skill composition from approved source bytes', () => {
  it('preserves exact UTF-8/CRLF teaching bytes, copies the public files, and is deterministic', () => {
    const f = fixture();
    const before = readFileSync(path.join(f.inputRoot, 'published-gpt.json'));
    const first = compose(f);
    expect(first.status).toBe(0);
    const firstResult = JSON.parse(first.stdout);
    expect(firstResult.approvedRuleIds).toEqual([]);
    const second = compose(f, 'mock-second');
    expect(second.status).toBe(0);
    const secondResult = JSON.parse(second.stdout);
    expect(secondResult.skill).toEqual(firstResult.skill);
    expect(secondResult.report).toEqual(firstResult.report);
    expect(secondResult.packageFingerprint).toBe(firstResult.packageFingerprint);
    const composed = readFileSync(path.join(f.inputRoot, 'mock-composed/package', skillPath));
    const source = readFileSync(path.join(f.packageRoot, skillPath), 'utf8');
    expect(composed.equals(Buffer.from(source.replace(placeholder, mockInstructions)))).toBe(true);
    for (const file of ['plugin.json', '.app.json']) expect(readFileSync(path.join(f.inputRoot, 'mock-composed/package', file)))
      .toEqual(readFileSync(path.join(f.packageRoot, file)));
    expect(readFileSync(path.join(f.inputRoot, 'published-gpt.json'))).toEqual(before);
    expect(first.stdout).not.toContain(mockInstructions.split('\r\n')[1]);
    const report = readJson(path.join(f.inputRoot, 'mock-composed/composition-report.json'));
    expect(report.compositionReview.status).toBe('PENDING');
    expect(report.transformation.reason).toBe('verbatim insertion; no pedagogy paraphrase');
    expect(report.sectionMap[0].sourceStartByte).toBe(0);
    expect(report.sectionMap.at(-1).sourceEndByte).toBe(Buffer.byteLength(mockInstructions));
    for (const section of report.sectionMap) {
      const sourceBytes = Buffer.from(mockInstructions).subarray(section.sourceStartByte, section.sourceEndByte);
      expect(composed.subarray(section.outputStartByte, section.outputEndByte)).toEqual(sourceBytes);
      expect(hash(sourceBytes)).toBe(section.sha256);
    }
    const inspected = inspect(f, { expectedSkillSha256: firstResult.skill.sha256, expectedPackageFingerprint: firstResult.packageFingerprint });
    expect(inspected.status).toBe(0);
    expect(JSON.parse(inspected.stdout).approvedRuleIds).toEqual(firstResult.approvedRuleIds);
  });

  it('does not approve semantic mappings when a new artifact reuses a reviewed category name', () => {
    const f = fixture();
    expect(compose(f).status).toBe(0);
    const report = readJson(path.join(f.inputRoot, 'mock-composed/composition-report.json'));
    expect(report.teachingRuleMap).toHaveLength(15);
    expect(report.teachingRuleMap.find((item: Json) => item.id === 'diagnostic_questioning')).toMatchObject({
      status: 'SEMANTIC_REVIEW_PENDING', approvedSourceIds: [], sourceBehaviorIds: [], candidateSourceIds: ['instruction-section-001'] });
    expect(report.teachingRuleMap.every((item: Json) => item.approvedSourceIds.length === 0)).toBe(true);
    expect(report.teachingRuleMap.find((item: Json) => item.id === 'worked_examples')).toMatchObject({
      status: 'SEMANTIC_REVIEW_PENDING', approvedSourceIds: [] });
    expect(report.teachingRuleMap.find((item: Json) => item.id === 'uncertainty')).toMatchObject({
      status: 'NOT_ESTABLISHED_IN_BASELINE', approvedSourceIds: [] });
  });

  it('copies only separately approved references and checks their byte hashes', () => {
    const f = fixture(true);
    const result = compose(f);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).distributionFiles).toHaveLength(4);
    expect(inspect(f).status).toBe(0);
    writeFileSync(path.join(f.packageRoot, 'skills/arcanos-tutor/references/mock-notes.txt'), 'Changed mock content.');
    expect(compose(f, 'mock-stale-reference').status).toBe(1);
  });

  it.each(['skill', 'manifest', 'mapping', 'report', 'template', 'template-manifest', 'template-mapping'])('rejects changed %s bytes or claims at inspection', target => {
    const f = fixture();
    expect(compose(f).status).toBe(0);
    const files: Record<string, string> = {
      skill: path.join(f.inputRoot, 'mock-composed/package', skillPath),
      manifest: path.join(f.inputRoot, 'mock-composed/package/plugin.json'),
      mapping: path.join(f.inputRoot, 'mock-composed/package/.app.json'),
      report: path.join(f.inputRoot, 'mock-composed/composition-report.json'),
      template: path.join(f.packageRoot, skillPath),
      'template-manifest': path.join(f.packageRoot, 'plugin.json'),
      'template-mapping': path.join(f.packageRoot, '.app.json')
    };
    const file = files[target];
    if (target === 'report') mutate(file, record => { record.compositionReview.status = 'APPROVED'; });
    else writeFileSync(file, `${readFileSync(file, 'utf8')}\nMock change.\n`);
    expect(inspect(f).status).toBe(1);
  });

  it.each(['expectedSkillSha256', 'expectedPackageFingerprint'])('rejects a stale externally recorded %s', field => {
    const f = fixture();
    expect(compose(f).status).toBe(0);
    expect(inspect(f, { [field]: hash('mock stale binding') }).status).toBe(1);
  });

  it.each(['unapproved-baseline', 'changed-source', 'wrong-owner-binding', 'changed-behavior', 'changed-excerpt'])('fails closed for %s without disclosing source text', failure => {
    const f = fixture();
    if (failure === 'unapproved-baseline') mutate(f.baselinePath, record => { record.status = 'BLOCKED'; });
    if (failure === 'changed-source') mutate(path.join(f.inputRoot, 'published-gpt.json'), record => { record.instructions += '\nMock private change.'; });
    if (failure === 'wrong-owner-binding') mutate(path.join(f.inputRoot, 'mock-owner-review.json'), record => { record.reviewContext.baselineFingerprint = hash('mock other baseline'); });
    if (failure === 'changed-behavior' || failure === 'changed-excerpt') {
      const file = path.join(f.inputRoot, 'mock-behavior.json');
      mutate(file, record => {
        if (failure === 'changed-behavior') record.cases[0].expectedBehavior = 'Changed mock interpretation.';
        else record.cases[0].privateSourceExcerpts[0].line = 1;
      });
      if (failure === 'changed-excerpt') mutate(path.join(f.inputRoot, 'mock-owner-review.json'), record => {
        record.reviewContext.expectedBehaviorArtifact.sha256 = hash(readFileSync(file));
        record.reviewContext.expectedBehaviorArtifact.sizeBytes = readFileSync(file).length;
      });
    }
    const result = compose(f);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('COMPOSITION_INVALID: no private input contents or filesystem details are logged.\n');
    expect(readdirSync(f.inputRoot)).not.toContain('mock-composed');
  });

  it('does not overwrite an existing private output or its approval report', () => {
    const f = fixture();
    expect(compose(f).status).toBe(0);
    const reportPath = path.join(f.inputRoot, 'mock-composed/composition-report.json');
    const before = readFileSync(reportPath);
    expect(compose(f).status).toBe(1);
    expect(readFileSync(reportPath)).toEqual(before);
  });

  it.each(['../outside', '..', '/outside'])('rejects output escape %s', output => {
    const f = fixture();
    expect(compose(f, output).status).toBe(1);
  });

  it.each(['absent-ignore', 'tracked-input', 'unreviewed-package-file', 'unapproved-reference', 'duplicate-placeholder', 'missing-placeholder'])('rejects %s', failure => {
    const f = fixture(failure === 'unapproved-reference');
    if (failure === 'absent-ignore') writeFileSync(path.join(f.root, '.gitignore'), 'mock-other/\n');
    if (failure === 'tracked-input') expect(spawnSync('git', ['-C', f.root, 'add', '--force', '.local-migration/arcanos-tutor/published-gpt.json'], { encoding: 'utf8' }).status).toBe(0);
    if (failure === 'unreviewed-package-file') writeFileSync(path.join(f.packageRoot, 'mock-extra.txt'), 'Mock unreviewed file.');
    if (failure === 'unapproved-reference') mutate(f.referencePath, record => { record.references[0].approvedForRepository = false; });
    if (failure === 'duplicate-placeholder') writeFileSync(path.join(f.packageRoot, skillPath), `${placeholder}\n${placeholder}`);
    if (failure === 'missing-placeholder') writeFileSync(path.join(f.packageRoot, skillPath), 'Mock template without insertion slot.');
    expect(compose(f).status).toBe(1);
  });

  it('rejects junction/symlink output parents and linked public template directories', () => {
    const f = fixture();
    const outside = path.join(f.root, 'mock-outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(f.inputRoot, 'mock-linked'), 'junction');
    expect(compose(f, 'mock-linked/new-output').status).toBe(1);
    expect(readdirSync(outside)).toEqual([]);
    const linkedPackage = path.join(f.root, 'mock-linked-package');
    symlinkSync(f.packageRoot, linkedPackage, 'junction');
    const result = spawnSync(process.execPath, [script, '--inputs', f.inputRoot, '--baseline', f.baselinePath,
      '--package', linkedPackage, '--references', f.referencePath, '--owner-review', 'mock-owner-review.json'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
  });
});

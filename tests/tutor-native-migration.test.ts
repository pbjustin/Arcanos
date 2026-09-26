import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type Json = ReturnType<typeof JSON.parse>;
const helper = pathToFileURL(path.join(process.cwd(), 'scripts/tutor-native-migration.mjs')).href;
const validator = pathToFileURL(path.join(process.cwd(), 'scripts/validate-arcanos-tutor-package.mjs')).href;
const source = path.join(process.cwd(), 'integrations/arcanos-tutor');
const roots: string[] = [];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const review = { reviewedBy: 'mock reviewer', reviewedAt: '2026-09-26T00:00:00Z' };
const readJson = (file: string): Json => JSON.parse(readFileSync(file, 'utf8'));
function writeJson(file: string, value: Json) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function artifact(root: string, file: string) {
  const bytes = readFileSync(path.join(root, file));
  return { path: file, sha256: hash(bytes), sizeBytes: bytes.length };
}
function fingerprint(baseline: Json) {
  return hash(JSON.stringify({ configuration: baseline.configuration.sha256,
    knowledge: baseline.knowledge.map(({ name, sha256, sizeBytes }: Json) => ({ name, sha256, sizeBytes }))
      .sort((a: Json, b: Json) => a.name.localeCompare(b.name, 'en')) }));
}
const bundlePaths = ['.codex-plugin/plugin.json', 'assets/gpt-icon.png',
  'skills/instructions/agents/openai.yaml', 'skills/instructions/lookup/knowledge-index.json',
  'skills/instructions/SKILL.md'];

function fixture(baselineOverride?: Json) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arcanos-tutor-native-'));
  roots.push(root);
  expect(spawnSync('git', ['init', '--quiet', root], { windowsHide: true }).status).toBe(0);
  writeFileSync(path.join(root, '.gitignore'), '.local-migration/\n');
  const inputRoot = path.join(root, '.local-migration/arcanos-tutor');
  const captureRoot = 'mock-installed';
  const bundle = path.join(inputRoot, captureRoot);
  for (const file of bundlePaths) mkdirSync(path.dirname(path.join(bundle, file)), { recursive: true });
  writeJson(path.join(inputRoot, 'published-gpt.json'), { instructions: 'Mock native private teaching source.', representativeBehavior: ['Mock source expectation.'] });
  const baseline = baselineOverride ?? { status: 'VERIFIED', configuration: artifact(inputRoot, 'published-gpt.json'), knowledge: [] };
  const manifest = { author: { name: 'Mock owner' }, description: 'Mock native skill fixture.', interface: { displayName: 'Mock Tutor', capabilities: ['skills'] },
    name: 'gpt-mock-native', skills: './skills/', version: '0.1.0+bundle.mock' };
  writeJson(path.join(bundle, bundlePaths[0]), manifest);
  writeFileSync(path.join(bundle, bundlePaths[1]), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  writeFileSync(path.join(bundle, bundlePaths[2]), 'interface:\n  display_name: Mock Tutor\n  short_description: Mock short description.\n');
  writeJson(path.join(bundle, bundlePaths[3]), { files: [] });
  writeFileSync(path.join(bundle, bundlePaths[4]), '---\nname: instructions\ndescription: Mock native skill.\n---\nExplain a mock fraction.\n');
  const migration: Json = { schemaVersion: 1, status: 'VERIFIED', artifactFormat: 'CHATGPT_NATIVE_SKILLS_ONLY',
    baselineFingerprint: fingerprint(baseline), skill: null, metadata: null, appMapping: null, appAttachment: 'NOT_ATTACHED',
    references: [], warnings: ['Mock warning: custom Actions were omitted.'], instructionComparison: null,
    capture: { pluginId: 'plugin_mock_native', cachePackageName: manifest.name, version: manifest.version,
      rootPath: captureRoot, files: [], packageFingerprint: '', receipt: null },
    accountReview: { ...review, confirmedMigrated: true, confirmedWarningsReviewed: true }, evidenceIds: ['mock-migration'] };
  const evidence: Json[] = [{ id: 'mock-migration', kind: 'chatgpt', status: 'VERIFIED', observedAt: review.reviewedAt,
    summary: 'Synthetic account migration fixture only.', migrationBinding: {} }];
  const state = { gates: { GPT_MIGRATED: { status: 'VERIFIED', evidenceIds: ['mock-migration'] } } };
  const f = { root, inputRoot, bundle, captureRoot, baseline, migration, evidence, state };
  refresh(f);
  return f;
}
type Fixture = ReturnType<typeof fixture>;
function refresh(f: Fixture) {
  const files = bundlePaths.map(file => artifact(f.inputRoot, `${f.captureRoot}/${file}`));
  const relativeFiles = files.map(file => ({ ...file, path: file.path.slice(f.captureRoot.length + 1) }));
  const packageFingerprint = hash(JSON.stringify([...relativeFiles].sort((a, b) => a.path.localeCompare(b.path, 'en'))));
  f.migration.skill = files[4];
  f.migration.metadata = files[0];
  Object.assign(f.migration.capture, { files, packageFingerprint });
  writeJson(path.join(f.bundle, 'capture-review.json'), { schemaVersion: 1, sourceKind: 'INSTALLED_PLUGIN_CACHE',
    capturedAt: review.reviewedAt, copyByteIdentity: true, pluginId: f.migration.capture.pluginId,
    cachePackageName: f.migration.capture.cachePackageName, version: f.migration.capture.version,
    baselineFingerprint: f.migration.baselineFingerprint, files: relativeFiles, packageFingerprint });
  f.migration.capture.receipt = artifact(f.inputRoot, `${f.captureRoot}/capture-review.json`);
  f.evidence[0].migrationBinding = { artifactFormat: 'CHATGPT_NATIVE_SKILLS_ONLY', baselineFingerprint: f.migration.baselineFingerprint,
    pluginId: f.migration.capture.pluginId, cachePackageName: f.migration.capture.cachePackageName,
    version: f.migration.capture.version, skillSha256: f.migration.skill.sha256,
    metadataSha256: f.migration.metadata.sha256, packageFingerprint, appAttachment: 'NOT_ATTACHED' };
}
function run(f: Fixture, inspect = true) {
  const options = { inputRoot: f.inputRoot, migration: f.migration, baseline: f.baseline, evidence: f.evidence, state: f.state };
  const code = `import {inspectNativeMigration,validateNativeMigration} from ${JSON.stringify(helper)};
    const o=JSON.parse(process.argv[1]); o.evidence=new Map(o.evidence.map(e=>[e.id,e]));
    try { const r=${inspect ? 'await inspectNativeMigration(o)' : 'validateNativeMigration(o.migration,o.baseline,o.evidence,o.state)'};
    console.log(JSON.stringify(r)); } catch(e) { console.error(e.message); process.exitCode=1; }`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(options)], { encoding: 'utf8' });
}
function integration(f: Fixture, inspect: boolean) {
  const packageRoot = path.join(f.root, 'integration');
  cpSync(source, packageRoot, { recursive: true });
  const connection = readJson(path.join(packageRoot, 'connection.requirements.json'));
  connection.evidence.push(...f.evidence);
  writeJson(path.join(packageRoot, 'connection.requirements.json'), connection);
  const state = readJson(path.join(packageRoot, 'migration-state.json'));
  state.gates.GPT_MIGRATED = { ...f.state.gates.GPT_MIGRATED, note: 'Synthetic account migration only.' };
  state.gates.UPDATED_PLUGIN_ARCHIVE_VERIFIED = { status: 'BLOCKED', evidenceIds: [], note: 'Historical migration fixture only.' };
  rmSync(path.join(packageRoot, 'updated-plugin-release.json'), { force: true });
  rmSync(path.join(packageRoot, 'skill-revision.inventory.json'), { force: true });
  writeJson(path.join(packageRoot, 'migration-state.json'), state);
  writeJson(path.join(packageRoot, 'migration.inventory.json'), f.migration);
  const code = `import {validateArcanosTutorPackage} from ${JSON.stringify(validator)};
    try { console.log(JSON.stringify(await validateArcanosTutorPackage(process.argv[1],JSON.parse(process.argv[2])))); }
    catch(e) { console.error(e.message); process.exitCode=1; }`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code, packageRoot,
    JSON.stringify(inspect ? { inputRoot: f.inputRoot } : {})], { encoding: 'utf8' });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('arcanos-tutor-native-')) throw new Error('Unexpected fixture path');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Captured native skills-only Tutor migration', () => {
  it('inspects native bytes and zero references without inventing an app or reconciliation approval', () => {
    const f = fixture();
    const result = run(f);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ artifactFormat: 'CHATGPT_NATIVE_SKILLS_ONLY', artifactInspection: 'VERIFIED',
      packageFingerprint: f.migration.capture.packageFingerprint, fileCount: 5, appAttachment: 'NOT_ATTACHED' });
    expect(f.migration.instructionComparison).toBeNull();
    expect(f.migration.skill.approvedForPrivateRelease).toBeUndefined();
  });

  it.each([
    ['missing evidence', (f: Fixture) => { f.migration.evidenceIds = []; }],
    ['duplicate evidence', (f: Fixture) => { f.migration.evidenceIds.push('mock-migration'); }],
    ['missing binding', (f: Fixture) => { delete f.evidence[0].migrationBinding; }],
    ['wrong plugin', (f: Fixture) => { f.evidence[0].migrationBinding.pluginId = 'mock-other'; }],
    ['wrong baseline', (f: Fixture) => { f.migration.baselineFingerprint = hash('mock other'); }],
    ['unverified baseline', (f: Fixture) => { f.baseline.status = 'BLOCKED'; }],
    ['wrong manifest digest', (f: Fixture) => { f.evidence[0].migrationBinding.metadataSha256 = hash('mock other'); }],
    ['wrong package digest', (f: Fixture) => { f.evidence[0].migrationBinding.packageFingerprint = hash('mock other'); }],
    ['extra binding field', (f: Fixture) => { f.evidence[0].migrationBinding.extra = true; }],
    ['user reported observation', (f: Fixture) => { f.evidence[0].kind = 'user_reported'; }],
    ['repository-only observation', (f: Fixture) => { f.evidence[0].kind = 'repository'; }],
    ['unverified observation', (f: Fixture) => { f.evidence[0].status = 'USER_REPORTED'; }],
    ['unreviewed account', (f: Fixture) => { f.migration.accountReview.confirmedMigrated = false; }],
    ['unreviewed warnings', (f: Fixture) => { f.migration.accountReview.confirmedWarningsReviewed = false; }],
    ['different gate evidence', (f: Fixture) => { f.state.gates.GPT_MIGRATED.evidenceIds = ['mock-other']; }],
    ['invented app ID', (f: Fixture) => { f.migration.registeredAppId = 'mock-app'; }],
    ['invented mapping', (f: Fixture) => { f.migration.appMapping = f.migration.metadata; }],
    ['attached app claim', (f: Fixture) => { f.migration.appAttachment = 'ATTACHED'; }],
    ['duplicate artifact', (f: Fixture) => { f.migration.capture.files.push(f.migration.capture.files[0]); }],
    ['artifact outside capture', (f: Fixture) => { f.migration.capture.files[0].path = 'mock-outside.json'; }],
    ['traversal', (f: Fixture) => { f.migration.capture.rootPath = '../mock-outside'; }]
  ])('rejects %s', (_name, mutate) => {
    const f = fixture();
    mutate(f);
    expect(run(f, false).status).toBe(1);
  });

  it.each(bundlePaths)('rejects changed %s bytes before release readiness', file => {
    const f = fixture();
    writeFileSync(path.join(f.bundle, file), 'Mock changed content.\n');
    expect(run(f).stderr).toContain('ARTIFACT_DIGEST_MISMATCH');
  });

  it('rejects missing and uncaptured extra files', () => {
    const f = fixture();
    renameSync(path.join(f.bundle, bundlePaths[1]), path.join(f.bundle, 'assets/mock-renamed.png'));
    expect(run(f).stderr).toContain('NATIVE_CAPTURE_INVENTORY_MISMATCH');
    renameSync(path.join(f.bundle, 'assets/mock-renamed.png'), path.join(f.bundle, bundlePaths[1]));
    writeFileSync(path.join(f.bundle, 'mock-extra.txt'), 'Mock unreviewed extra.\n');
    expect(run(f).stderr).toContain('NATIVE_CAPTURE_INVENTORY_MISMATCH');
  });

  it('rejects an extra reference or app file even when included in the claimed complete inventory', () => {
    for (const relative of ['skills/instructions/lookup/mock-unlisted-reference.txt', '.APP.JSON']) {
      const f = fixture();
      const file = `${f.captureRoot}/${relative}`;
      writeFileSync(path.join(f.inputRoot, file), 'Mock extra bytes.\n');
      f.migration.capture.files.push(artifact(f.inputRoot, file));
      const relativeFiles = f.migration.capture.files.map((item: Json) => ({ ...item, path: item.path.slice(f.captureRoot.length + 1) }));
      f.migration.capture.packageFingerprint = hash(JSON.stringify(relativeFiles.sort((a: Json, b: Json) => a.path.localeCompare(b.path, 'en'))));
      expect(run(f, false).stderr).toContain('NATIVE_FILE_LAYOUT_UNSUPPORTED');
    }
  });

  it.each(['apps', 'mcpServers', 'hooks', '$schema'])('rejects unexpected native manifest %s even with matching hashes', field => {
    const f = fixture();
    const file = path.join(f.bundle, bundlePaths[0]);
    const manifest = readJson(file);
    manifest[field] = 'mock-value';
    writeJson(file, manifest);
    refresh(f);
    expect(run(f).stderr).toContain('NATIVE_MANIFEST_INVALID');
  });

  it.each(['name', 'version', 'skills'])('rejects native manifest %s mismatch with matching hashes', field => {
    const f = fixture();
    const file = path.join(f.bundle, bundlePaths[0]);
    const manifest = readJson(file);
    manifest[field] = 'mock-other';
    writeJson(file, manifest);
    refresh(f);
    expect(run(f).status).toBe(1);
  });

  it.each(['apps', 'mcpServers', 'dependencies'])('rejects unexpected nested interface %s', field => {
    const f = fixture();
    const file = path.join(f.bundle, bundlePaths[0]);
    const manifest = readJson(file);
    manifest.interface[field] = { mock: 'mock-value' };
    writeJson(file, manifest);
    refresh(f);
    expect(run(f).stderr).toContain('NATIVE_MANIFEST_INVALID');
  });

  it('rejects additional capabilities and agent dependency metadata', () => {
    const f = fixture();
    const file = path.join(f.bundle, bundlePaths[0]);
    const manifest = readJson(file);
    manifest.interface.capabilities.push('apps');
    writeJson(file, manifest);
    refresh(f);
    expect(run(f).stderr).toContain('NATIVE_MANIFEST_INVALID');
    manifest.interface.capabilities = ['skills'];
    writeJson(file, manifest);
    writeFileSync(path.join(f.bundle, bundlePaths[2]), 'interface:\n  display_name: Mock Tutor\n  short_description: Mock description\ndependencies:\n  tools: []\n');
    refresh(f);
    expect(run(f).stderr).toContain('NATIVE_AGENT_METADATA_UNSUPPORTED');
  });

  it.each([bundlePaths[0], bundlePaths[3], bundlePaths[2]])('redacts malformed private parser input in %s', file => {
    const f = fixture();
    const marker = 'MOCK_PRIVATE_PARSER_EXCERPT';
    writeFileSync(path.join(f.bundle, file), `{\"${marker}\": [\n`);
    refresh(f);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('NATIVE_PRIVATE_INPUT_INVALID');
    expect(`${result.stdout}${result.stderr}`).not.toContain(marker);
  });

  it.each(['wrong root', 'not ignored', 'tracked input'])('enforces the private boundary before reads: %s', mode => {
    const f = fixture();
    if (mode === 'wrong root') f.inputRoot = f.root;
    else if (mode === 'not ignored') writeFileSync(path.join(f.root, '.gitignore'), '\n');
    else expect(spawnSync('git', ['-C', f.root, 'add', '--force', '.local-migration/arcanos-tutor/published-gpt.json'], { windowsHide: true }).status).toBe(0);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/PRIVATE_INPUT_ROOT_REQUIRED|PRIVATE_INPUT_TRACKED_OR_NOT_IGNORED/u);
  });

  it('rejects nonempty or unrecognized knowledge inventories rather than treating them as zero', () => {
    const f = fixture();
    writeJson(path.join(f.bundle, bundlePaths[3]), { files: [{ name: 'mock-reference.txt' }] });
    refresh(f);
    expect(run(f).stderr).toContain('NATIVE_REFERENCE_FORMAT_UNSUPPORTED');
    writeJson(path.join(f.bundle, bundlePaths[3]), {});
    refresh(f);
    expect(run(f).stderr).toContain('NATIVE_REFERENCE_FORMAT_UNSUPPORTED');
  });

  it('rejects stale provenance receipt assertions even when its hash is updated', () => {
    const f = fixture();
    const file = path.join(f.bundle, 'capture-review.json');
    const receipt = readJson(file);
    receipt.copyByteIdentity = false;
    writeJson(file, receipt);
    f.migration.capture.receipt = artifact(f.inputRoot, `${f.captureRoot}/capture-review.json`);
    expect(run(f).stderr).toContain('NATIVE_CAPTURE_RECEIPT_MISMATCH');
  });

  it('rejects a linked captured directory', () => {
    const f = fixture();
    const moved = path.join(f.inputRoot, 'mock-original');
    renameSync(f.bundle, moved);
    symlinkSync(moved, f.bundle, process.platform === 'win32' ? 'junction' : 'dir');
    expect(run(f).stderr).toContain('SYMLINK_NOT_ALLOWED');
  });

  it('records migration occurrence without clearing existing release or instruction blockers', () => {
    const f = fixture(readJson(path.join(source, 'baseline.inventory.json')));
    const result = integration(f, false);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.gates.GPT_MIGRATED).toBe('VERIFIED');
    expect(report.releaseStatus).toBe('BLOCKED');
    expect(report.releaseBlockers).toEqual(expect.arrayContaining(['SKILL_RECONCILIATION_MISSING',
      'PARITY_BLOCKERS_REMAIN', 'CONNECTION_VERIFICATION_INCOMPLETE', 'ACTUAL_INPUT_ARTIFACTS_NOT_INSPECTED',
      'NATIVE_MIGRATED_PACKAGE_RECONCILIATION_REQUIRED']));
    expect(report.migrationArtifactInspection).toBeNull();
  });

  it('inspects native bytes before unrelated release blockers can skip artifact inspection', () => {
    const f = fixture(readJson(path.join(source, 'baseline.inventory.json')));
    writeFileSync(path.join(f.bundle, bundlePaths[4]), 'Mock changed content.\n');
    const result = integration(f, true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ARTIFACT_DIGEST_MISMATCH');
  });

  it('cannot switch a native capture to the portable format to evade app validation', () => {
    const f = fixture(readJson(path.join(source, 'baseline.inventory.json')));
    f.migration.artifactFormat = 'PORTABLE_PLUGIN';
    expect(integration(f, false).stderr).toContain('MIGRATION_ARTIFACTS_MISSING');
  });
});

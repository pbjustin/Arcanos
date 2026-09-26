import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createUpdatedFixture, refreshUpdatedFixture, tarFixtureMember, writeFixtureJson } from './helpers/tutor-updated-release-fixture.js';

type Json = ReturnType<typeof JSON.parse>;
const helper = pathToFileURL(path.join(process.cwd(), 'scripts/tutor-updated-plugin-release.mjs')).href;
const roots: string[] = [];
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arcanos-tutor-updated-'));
  roots.push(root);
  expect(spawnSync('git', ['init', '--quiet', root], { windowsHide: true }).status).toBe(0);
  writeFileSync(path.join(root, '.gitignore'), '.local-migration/\n');
  const inputRoot = path.join(root, '.local-migration/arcanos-tutor');
  mkdirSync(inputRoot, { recursive: true });
  writeFixtureJson(path.join(inputRoot, 'published-gpt.json'), { instructions: 'Mock private baseline with more than thirty two characters.',
    representativeBehavior: ['Mock behavior without executing any teaching case.'] });
  return { root, ...createUpdatedFixture(inputRoot,
    '---\nname: arcanos-tutor\ndescription: Mock optional Tutor skill.\n---\nMock ordinary tutoring; backend only on explicit request.\n') };
}
type Fixture = ReturnType<typeof fixture>;
function run(f: Fixture, action = 'saved') {
  const options = { inputRoot: f.inputRoot, bundleRoot: f.bundle, release: f.release,
    expectedSkillSha256: f.release.approvedSkillSha256, evidence: [f.evidence], state: f.state };
  const code = `import {readFile} from 'node:fs/promises';
    import {inspectUpdatedTutorBundle,inspectUpdatedTutorRelease,inventoryUpdatedTutorArchive} from ${JSON.stringify(helper)};
    const o=JSON.parse(process.argv[1]); o.evidence=new Map(o.evidence.map(e=>[e.id,e]));
    try {const r=process.argv[2]==='bundle'?await inspectUpdatedTutorBundle(o):process.argv[2]==='archive'?
      inventoryUpdatedTutorArchive(await readFile(o.inputRoot+'/'+o.release.capture.archive.path)):await inspectUpdatedTutorRelease(o);
      console.log(JSON.stringify(r));} catch(e){console.error(e.message);process.exitCode=1;}`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(options), action], { encoding: 'utf8' });
}
function edit(f: Fixture, file: string, mutate: (value: Json) => void) {
  const value = JSON.parse(readFileSync(path.join(f.bundle, file), 'utf8'));
  mutate(value);
  writeFixtureJson(path.join(f.bundle, file), value);
  refreshUpdatedFixture(f);
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('arcanos-tutor-updated-')) {
      throw new Error('Unexpected temporary fixture path');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Current saved optional-app Tutor release', () => {
  it('independently compares all archive and extracted members without running the backend', () => {
    const f = fixture();
    const result = run(f);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ provenance: 'PLUGIN_CREATOR_SAVED_RELEASE', skillCount: 1,
      referenceCount: 0, appCount: 1, appOptional: true, skillSha256: f.release.approvedSkillSha256, privacyBoundary: 'PASS' });
    expect(JSON.parse(result.stdout).members).toHaveLength(13);
  });
  it('accepts JSON key reordering while maintaining current archive hashes', () => {
    const f = fixture();
    const manifestPath = path.join(f.bundle, '.codex-plugin/plugin.json');
    const before = readFileSync(manifestPath);
    writeFixtureJson(manifestPath, Object.fromEntries(Object.entries(JSON.parse(before.toString('utf8'))).reverse()));
    refreshUpdatedFixture(f);
    expect(hash(readFileSync(manifestPath))).not.toBe(hash(before));
    expect(run(f).status).toBe(0);
  });
  it.each(['missing-optional', 'string-optional', 'required-conflict', 'technical-id', 'duplicate'])('rejects app mapping %s', failure => {
    const f = fixture();
    edit(f, '.app.json', value => {
      const app = value.apps['arcanos-tutor'];
      if (failure === 'missing-optional') delete app.optional;
      if (failure === 'string-optional') app.optional = 'true';
      if (failure === 'required-conflict') app.required = true;
      if (failure === 'technical-id') app.id = `plugin_${app.id}`;
      if (failure === 'duplicate') value.apps.copy = { ...app };
    });
    expect(run(f).stderr).toContain('UPDATED_APP_MAPPING_INVALID');
  });
  it('rejects changed skill even when archive and inventory are refreshed', () => {
    const f = fixture();
    writeFileSync(path.join(f.bundle, 'skills/instructions/SKILL.md'), 'Changed mock instructions.');
    refreshUpdatedFixture(f);
    expect(run(f).stderr).toContain('UPDATED_FINGERPRINT_INVALID');
  });
  it('rejects repeated JSON app keys instead of accepting the last value', () => {
    const f = fixture();
    const mappingPath = path.join(f.bundle, '.app.json');
    const raw = readFileSync(mappingPath, 'utf8').replace('"optional": true', '"optional": true, "optional": true');
    writeFileSync(mappingPath, raw);
    refreshUpdatedFixture(f);
    expect(run(f).stderr).toContain('UPDATED_APP_MAPPING_INVALID');
  });
  it('rejects a different extraction despite a valid saved archive', () => {
    const f = fixture();
    writeFileSync(path.join(f.bundle, 'skills/instructions/agents/openai.yaml'), 'interface:\n  display_name: Changed mock\n');
    expect(run(f).stderr).toContain('UPDATED_SAVED_EXTRACTION_MISMATCH');
  });
  it('rejects archive corruption instead of trusting extracted members', () => {
    const f = fixture();
    const archivePath = path.join(f.inputRoot, f.release.capture.archive.path);
    writeFileSync(archivePath, Buffer.concat([readFileSync(archivePath), Buffer.from('mock changed')]));
    expect(run(f).stderr).toContain('UPDATED_ARCHIVE_DIGEST_MISMATCH');
  });
  it.each(['.env', '.mcp.json', 'skills/instructions/references/mock.txt'])('rejects unexpected member %s', file => {
    const f = fixture();
    mkdirSync(path.dirname(path.join(f.bundle, file)), { recursive: true });
    writeFileSync(path.join(f.bundle, file), 'mock extra content');
    expect(run(f).status).toBe(1);
  });
  it('rejects nonempty knowledge and credential-shaped material', () => {
    const f = fixture();
    edit(f, 'skills/instructions/lookup/knowledge-index.json', value => { value.files = ['mock.txt']; });
    expect(run(f).stderr).toContain('UPDATED_REFERENCES_NOT_EMPTY');
    edit(f, 'skills/instructions/lookup/knowledge-index.json', value => { value.files = []; });
    writeFileSync(path.join(f.bundle, 'skills/instructions/agents/openai.yaml'), 'client_secret: mock-sensitive-fixture-value\n');
    refreshUpdatedFixture(f);
    expect(run(f).stderr).toContain('POSSIBLE_CREDENTIAL');
  });
  it.each(['../escape', '/absolute', 'C:/absolute', 'skills\\escape'])('rejects raw archive path %s', name => {
    const f = fixture();
    writeFileSync(path.join(f.inputRoot, f.release.capture.archive.path), gzipSync(Buffer.concat([
      tarFixtureMember(name, Buffer.from('mock bytes')), Buffer.alloc(1024)])));
    expect(run(f, 'archive').stderr).toContain('UNSAFE_PATH');
  });
  it.each(['1', '2', 'x'])('rejects archive type %s before extraction', type => {
    const f = fixture();
    writeFileSync(path.join(f.inputRoot, f.release.capture.archive.path), gzipSync(Buffer.concat([
      tarFixtureMember('mock', Buffer.alloc(0), type), Buffer.alloc(1024)])));
    expect(run(f, 'archive').stderr).toContain('UPDATED_TAR_LINK_OR_TYPE_INVALID');
  });
  it.each(['release', 'visibility', 'optional', 'fingerprint', 'evidence'])('rejects unsupported saved claim %s', failure => {
    const f = fixture();
    if (failure === 'release') f.release.currentReleaseId = 'pluginrel_mock_newer';
    if (failure === 'visibility') f.release.visibility = 'PUBLIC';
    if (failure === 'optional') f.release.appOptional = false;
    if (failure === 'fingerprint') f.release.capture.packageFingerprint = hash('mock wrong fingerprint');
    if (failure === 'evidence') f.evidence.updatedReleaseBinding.archiveSha256 = hash('mock wrong archive');
    expect(run(f).status).toBe(1);
  });
});

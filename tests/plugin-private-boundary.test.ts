import { afterEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const roots: string[] = [];
const script = path.join(process.cwd(), 'scripts/check-plugin-private-boundary.mjs');
const tutorScript = path.join(process.cwd(), 'scripts/check-tutor-private-boundary.mjs');
const mockInstructions = 'Private synthetic Gaming instructions that must stay inside the ignored input directory.\r\n\r\n'
  + 'Preserve the synthetic player progression and spoiler constraints in all generated fixture responses.';

function fixture(pluginName = 'arcanos-gaming') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arcanos-plugin-boundary-'));
  roots.push(root);
  expect(spawnSync('git', ['init', '--quiet', root], { windowsHide: true }).status).toBe(0);
  writeFileSync(path.join(root, '.gitignore'), '/.local-migration/\n');
  const inputRoot = path.join(root, '.local-migration', pluginName);
  mkdirSync(inputRoot, { recursive: true });
  writeFileSync(path.join(inputRoot, 'published-gpt.json'), JSON.stringify({ instructions: mockInstructions,
    representativeBehavior: ['Synthetic expected behavior stays private with the published instructions.'] }));
  return { root, inputRoot, pluginName };
}

function inspect(inputRoot: string, pluginName = 'arcanos-gaming', options = {}) {
  const code = `import {checkPluginPrivateBoundary} from ${JSON.stringify(pathToFileURL(script).href)};`
    + 'try { console.log(JSON.stringify(await checkPluginPrivateBoundary(process.argv[1], process.argv[2], JSON.parse(process.argv[3])))); } '
    + 'catch(error) { console.error(error.message); process.exitCode=1; }';
  return spawnSync(process.execPath, ['--input-type=module', '-e', code, inputRoot, pluginName, JSON.stringify(options)], { encoding: 'utf8' });
}

function publicSourceFixture() {
  const f = fixture();
  const publicPath = 'canonical-gaming.md';
  const bytes = Buffer.from(mockInstructions.replace(/\r\n/gu, '\n'));
  writeFileSync(path.join(f.root, publicPath), bytes);
  expect(spawnSync('git', ['-C', f.root, 'add', '--', publicPath, '.gitignore'], { windowsHide: true }).status).toBe(0);
  expect(spawnSync('git', ['-C', f.root, '-c', 'user.name=Fixture Owner', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Synthetic public baseline'], { windowsHide: true }).status).toBe(0);
  const baseCommit = spawnSync('git', ['-C', f.root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  const publicSources = { baseCommit, artifacts: [{ path: publicPath,
    sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length }] };
  return { ...f, publicPath, bytes, publicSources };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('arcanos-plugin-boundary-')) {
      throw new Error('Unexpected fixture path');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Shared private plugin migration boundary', () => {
  it.each(['arcanos-gaming', 'arcanos-tutor'])('accepts ignored untracked %s inputs without disclosing them', pluginName => {
    const f = fixture(pluginName);
    const result = inspect(f.inputRoot, pluginName);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ privacyBoundary: 'PASS', privateInputIgnored: true,
      privateInputTracked: false, inspectedWorkingFiles: 1, inspectedStagedFiles: 0 });
    expect(result.stdout).not.toContain(mockInstructions);
    expect(result.stderr).toBe('');
  });

  it('preserves the Tutor wrapper fixed-product boundary', () => {
    const f = fixture('arcanos-tutor');
    const result = spawnSync(process.execPath, [tutorScript, '--inputs', f.inputRoot], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).privacyBoundary).toBe('PASS');
    const gaming = fixture();
    expect(spawnSync(process.execPath, [tutorScript, '--inputs', gaming.inputRoot], { encoding: 'utf8' }).status).toBe(1);
  });

  it.each(['arcanos-tutor', '../arcanos-gaming', 'arcanos-gaming/extra', ''])('rejects a mismatched or unsafe product slug %s', slug => {
    const result = inspect(fixture().inputRoot, slug);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PRIVATE_INPUT_ROOT_REQUIRED');
  });

  it('rejects inputs outside the ignored migration parent', () => {
    const f = fixture();
    const result = inspect(path.join(f.root, 'arcanos-gaming'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PRIVATE_INPUT_ROOT_REQUIRED');
  });

  it('rejects an unignored input root', () => {
    const f = fixture();
    writeFileSync(path.join(f.root, '.gitignore'), '');
    const result = inspect(f.inputRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PRIVATE_INPUT_TRACKED_OR_NOT_IGNORED');
  });

  it('rejects force-staged private data anywhere under the migration boundary', () => {
    const f = fixture();
    expect(spawnSync('git', ['-C', f.root, 'add', '--force', '--', '.local-migration'], { windowsHide: true }).status).toBe(0);
    const result = inspect(f.inputRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PRIVATE_INPUT_TRACKED_OR_NOT_IGNORED');
    expect(result.stderr).not.toContain(mockInstructions);
  });

  it.each(['working file', 'staged blob'])('rejects escaped instruction bytes in a %s', mode => {
    const f = fixture();
    const escaped = path.join(f.root, 'escaped.txt');
    writeFileSync(escaped, mockInstructions.replace(/\r\n/gu, '\n'));
    if (mode === 'staged blob') {
      expect(spawnSync('git', ['-C', f.root, 'add', '--', 'escaped.txt'], { windowsHide: true }).status).toBe(0);
      writeFileSync(escaped, 'Safe replacement does not conceal the staged private bytes.');
    }
    const result = inspect(f.inputRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PRIVATE_CONTENT_OUTSIDE_IGNORED_INPUTS');
    expect(result.stderr).not.toContain(mockInstructions);
  });

  it('rejects a junction used as the input root', () => {
    const f = fixture();
    const linkedRoot = path.join(f.root, '.local-migration/arcanos-linked');
    symlinkSync(f.inputRoot, linkedRoot, 'junction');
    const result = inspect(linkedRoot, 'arcanos-linked');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SYMLINK_NOT_ALLOWED');
  });

  it('accepts only explicitly reviewed unchanged public source at its exact baseline path', () => {
    const f = publicSourceFixture();
    expect(inspect(f.inputRoot).status).toBe(1);
    expect(inspect(f.inputRoot, f.pluginName, { publicSources: f.publicSources }).status).toBe(0);
  });

  it.each(['changed source', 'copied source', 'staged source'])('rejects a %s despite the public-source review', mode => {
    const f = publicSourceFixture();
    const changedPath = mode === 'copied source' ? 'unreviewed-copy.md' : f.publicPath;
    writeFileSync(path.join(f.root, changedPath), Buffer.concat([f.bytes, Buffer.from('\nChanged synthetic bytes.\n')]));
    if (mode === 'staged source') {
      expect(spawnSync('git', ['-C', f.root, 'add', '--', changedPath], { windowsHide: true }).status).toBe(0);
      writeFileSync(path.join(f.root, changedPath), f.bytes);
    }
    const result = inspect(f.inputRoot, f.pluginName, { publicSources: f.publicSources });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PRIVATE_CONTENT_OUTSIDE_IGNORED_INPUTS');
  });

  it.each(['hash', 'size', 'branch', 'unknown path'])('rejects a public-source review with an invalid %s binding', mode => {
    const f = publicSourceFixture();
    if (mode === 'hash') f.publicSources.artifacts[0].sha256 = '0'.repeat(64);
    if (mode === 'size') f.publicSources.artifacts[0].sizeBytes += 1;
    if (mode === 'branch') f.publicSources.baseCommit = 'HEAD';
    if (mode === 'unknown path') f.publicSources.artifacts[0].path = 'missing.md';
    const result = inspect(f.inputRoot, f.pluginName, { publicSources: f.publicSources });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PUBLIC_SOURCE_');
    expect(result.stderr).not.toContain(mockInstructions);
  });
});

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSelfHealPreviewArtifact, verifySelfHealPreviewArtifact,
  writeSelfHealPreviewArtifact, SELF_HEAL_PREVIEW_ARTIFACT_PATH,
} from '../scripts/self-heal-preview-artifact.mjs';

let rootPath;
const sourceSha = 'a'.repeat(40);
const options = () => ({ sourceSha, rootPath });
beforeEach(() => {
  rootPath = mkdtempSync(join(tmpdir(), 'arcanos-preview-artifact-'));
  for (const directory of ['dist', 'workers/dist', 'packages/protocol/dist', 'packages/cli/dist',
    'packages/arcanos-runtime/dist', 'packages/arcanos-openai/dist', 'scripts', 'config']) {
    mkdirSync(join(rootPath, directory), { recursive: true });
    writeFileSync(join(rootPath, directory, 'fixture.js'), `// synthetic ${directory}\n`);
  }
  writeFileSync(join(rootPath, 'package.json'), '{"name":"synthetic-preview"}');
  writeFileSync(join(rootPath, 'package-lock.json'), '{}');
});
afterEach(() => {
  expect(dirname(resolve(rootPath))).toBe(resolve(tmpdir()));
  expect(basename(rootPath)).toMatch(/^arcanos-preview-artifact-/u);
  rmSync(rootPath, { recursive: true, force: true });
});

describe('self-healing preview executable artifact', () => {
  it('binds the source SHA and every compiled/script byte deterministically', () => {
    const first = createSelfHealPreviewArtifact(options());
    expect(first).toEqual(createSelfHealPreviewArtifact(options()));
    expect(first.files.map(file => file.path)).toEqual([...first.files.map(file => file.path)].sort());
    const receipt = writeSelfHealPreviewArtifact(options());
    expect(verifySelfHealPreviewArtifact(options())).toEqual(receipt);
    expect(receipt).toMatchObject({ sourceSha, fileCount: 10 });
  });
  it.each(['dist/fixture.js', 'scripts/fixture.js', 'packages/protocol/dist/fixture.js', 'package-lock.json'])(
    'rejects changed executable or dependency metadata: %s', path => {
      writeSelfHealPreviewArtifact(options());
      writeFileSync(join(rootPath, path), 'changed synthetic bytes');
      expect(() => verifySelfHealPreviewArtifact(options())).toThrow('SELF_HEAL_PREVIEW_ARTIFACT_INVALID');
    },
  );
  it('rejects missing roots, extra compiled files and source drift', () => {
    rmSync(join(rootPath, 'workers/dist'), { recursive: true });
    expect(() => createSelfHealPreviewArtifact(options())).toThrow();
    mkdirSync(join(rootPath, 'workers/dist'));
    writeSelfHealPreviewArtifact(options());
    expect(() => verifySelfHealPreviewArtifact({ ...options(), sourceSha: 'b'.repeat(40) })).toThrow();
    writeFileSync(join(rootPath, 'dist/extra.js'), 'unexpected extra executable');
    expect(() => verifySelfHealPreviewArtifact(options())).toThrow();
  });
  it('refuses manifest overwrite and unknown fields without exposing content', () => {
    writeSelfHealPreviewArtifact(options());
    expect(() => writeSelfHealPreviewArtifact(options())).toThrow();
    const path = join(rootPath, SELF_HEAL_PREVIEW_ARTIFACT_PATH);
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    // Replace our own temporary fixture; never mutate a real artifact in verification.
    rmSync(path);
    writeFileSync(path, JSON.stringify({ ...artifact, unexpected: 'synthetic diagnostic' }));
    expect(() => verifySelfHealPreviewArtifact(options())).toThrow('SELF_HEAL_PREVIEW_ARTIFACT_INVALID');
  });
  it.each(['', 'a'.repeat(39), 'A'.repeat(40), '../synthetic', null])('rejects malformed source identity %s', invalid => {
    expect(() => createSelfHealPreviewArtifact({ ...options(), sourceSha: invalid })).toThrow();
  });
  it('rejects an intermediate executable-root link', () => {
    const moved = join(rootPath, 'linked-packages');
    mkdirSync(moved);
    rmSync(join(rootPath, 'packages'), { recursive: true });
    symlinkSync(moved, join(rootPath, 'packages'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => createSelfHealPreviewArtifact(options())).toThrow('SELF_HEAL_PREVIEW_ARTIFACT_INVALID');
  });
  it('supports the exact write and verify CLI used by the image, and refuses mutation or unknown verbs', () => {
    const script = join(rootPath, 'scripts/self-heal-preview-artifact.mjs');
    copyFileSync(fileURLToPath(new URL('../scripts/self-heal-preview-artifact.mjs', import.meta.url)), script);
    const run = verb => spawnSync(process.execPath, [script, verb, '--source-sha', sourceSha],
      { cwd: rootPath, encoding: 'utf8', timeout: 5000, windowsHide: true });
    const written = run('--write');
    expect(written.status).toBe(0);
    expect(run('--verify')).toMatchObject({ status: 0, stdout: written.stdout });
    expect(run('--unknown').status).toBe(1);
    writeFileSync(join(rootPath, 'dist/fixture.js'), 'changed synthetic bytes');
    expect(run('--verify')).toMatchObject({ status: 1, stderr: expect.stringContaining('SELF_HEAL_PREVIEW_ARTIFACT_INVALID') });
  });
});

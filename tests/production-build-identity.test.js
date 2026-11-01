import { execFileSync } from 'node:child_process';
import fs, { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  BUILD_IDENTITY_PATH, readProductionBuildIdentity, reportProductionBuildIdentity,
  writeProductionBuildIdentity,
} from '../scripts/production-build-identity.mjs';

const roots = [];
function fixture() {
  const rootPath = mkdtempSync(join(tmpdir(), 'arcanos-build-identity-'));
  roots.push(rootPath);
  for (const path of ['src', 'scripts', 'packages', 'dist']) mkdirSync(join(rootPath, path));
  writeFileSync(join(rootPath, 'src/start-server.ts'), 'export const version = 1;\n');
  writeFileSync(join(rootPath, 'dist/start-server.js'), 'export const version = 1;\n');
  writeFileSync(join(rootPath, 'scripts/start.mjs'), 'export {};\n');
  writeFileSync(join(rootPath, '.gitignore'), 'dist/\nnode_modules/\n.env\n');
  return { rootPath, env: {} };
}
function initializeGitFixture(options) {
  const git = args => execFileSync('git', args, { cwd: options.rootPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'core.hooksPath', '.unused-test-hooks']);
  git(['add', '.']);
  git(['-c', 'user.name=Offline fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'synthetic build inputs']);
  return git;
}
afterEach(() => {
  for (const rootPath of roots.splice(0)) rmSync(rootPath, { recursive: true, force: true });
});

describe('production build identity', () => {
  it('reports unknown for old builds without a receipt, without trusting platform SHA', () => {
    const options = fixture();
    options.env.RAILWAY_GIT_COMMIT_SHA = 'a'.repeat(40);
    expect(readProductionBuildIdentity(options)).toMatchObject({
      status: 'unverified', gitSha: null, buildId: null, configuredGitSha: 'a'.repeat(40),
    });
  });

  it('measures reproducible source and emitted bytes independently of environment claims', () => {
    const options = fixture();
    const first = writeProductionBuildIdentity(options);
    expect(writeProductionBuildIdentity(options)).toEqual(first);
    expect(readProductionBuildIdentity(options)).toMatchObject({
      status: 'unverified', artifactStatus: 'matches_build_receipt', gitSha: null,
      buildId: first.buildId, sourceDigest: first.sourceDigest,
    });
    writeFileSync(join(options.rootPath, 'dist/start-server.js'), 'compiled mutation');
    expect(readProductionBuildIdentity(options)).toMatchObject({ status: 'mismatch', artifactStatus: 'mismatch', gitSha: null });
    const second = writeProductionBuildIdentity(options);
    expect(second.sourceDigest).toBe(first.sourceDigest);
    expect(second.artifactDigest).not.toBe(first.artifactDigest);
    expect(second.buildId).not.toBe(first.buildId);
  });

  it('detects changed source, runtime script and added executable files', () => {
    for (const path of ['src/start-server.ts', 'scripts/start.mjs', 'dist/injected.js']) {
      const options = fixture();
      writeProductionBuildIdentity(options);
      writeFileSync(join(options.rootPath, path), 'changed');
      expect(readProductionBuildIdentity(options)).toMatchObject({ status: 'mismatch' });
    }
  });

  it('rejects a junction or symlink ancestor outside the fixed code roots', () => {
    const options = fixture();
    const external = fixture();
    symlinkSync(external.rootPath, join(options.rootPath, 'workers'), 'junction');
    expect(() => writeProductionBuildIdentity(options)).toThrow('BUILD_IDENTITY_LINK');
  });

  it.each(['README.md', 'catalog.json'])('ignores the ordinary packages/%s file when discovering emitted workspace output', name => {
    const options = fixture();
    const output = join(options.rootPath, 'packages', 'example', 'dist');
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'index.js'), 'export const version = 1;\n');
    writeFileSync(join(options.rootPath, 'packages', name), 'ordinary workspace-root file');

    const identity = writeProductionBuildIdentity(options);
    expect(readProductionBuildIdentity(options)).toMatchObject({
      status: 'unverified', artifactStatus: 'matches_build_receipt', buildId: identity.buildId
    });
    writeFileSync(join(output, 'index.js'), 'compiled mutation');
    expect(readProductionBuildIdentity(options)).toMatchObject({ status: 'mismatch', artifactStatus: 'mismatch' });
  });

  it('continues rejecting linked workspace roots instead of skipping them as ordinary files', () => {
    const options = fixture();
    const external = fixture();
    symlinkSync(external.rootPath, join(options.rootPath, 'packages', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => writeProductionBuildIdentity(options)).toThrow('BUILD_IDENTITY_LINK');
  });

  it('ignores POSIX ENOTDIR for package files while preserving permission failures', async () => {
    const options = fixture();
    writeFileSync(join(options.rootPath, 'packages', 'catalog.json'), '{}');
    const fileDescendant = join(options.rootPath, 'packages', 'catalog.json', 'dist');
    let failure = Object.assign(new Error('test filesystem ENOTDIR'), { code: 'ENOTDIR' });
    let inspectedDescendant = false;
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule('node:fs', () => ({
        ...fs,
        lstatSync: path => {
          if (path === fileDescendant) {
            inspectedDescendant = true;
            throw failure;
          }
          return fs.lstatSync(path);
        }
      }));
      try {
        const isolated = await import('../scripts/production-build-identity.mjs');
        expect(() => isolated.writeProductionBuildIdentity(options)).not.toThrow();
        expect(isolated.readProductionBuildIdentity(options)).toMatchObject({ artifactStatus: 'matches_build_receipt' });
        expect(inspectedDescendant).toBe(true);
        failure = Object.assign(new Error('test filesystem EACCES'), { code: 'EACCES' });
        inspectedDescendant = false;
        expect(() => isolated.writeProductionBuildIdentity(options)).toThrow(failure);
        expect(inspectedDescendant).toBe(true);
      } finally {
        jest.unstable_unmockModule('node:fs');
      }
    });
  });

  it('distinguishes changed build/runtime commit references from proven commits', () => {
    const options = fixture();
    options.env.RAILWAY_GIT_COMMIT_SHA = 'a'.repeat(40);
    writeProductionBuildIdentity(options);
    options.env.RAILWAY_GIT_COMMIT_SHA = 'b'.repeat(40);
    expect(readProductionBuildIdentity(options)).toMatchObject({
      status: 'mismatch', gitSha: null, artifactStatus: 'matches_build_receipt', referenceStatus: 'mismatch',
      configuredGitSha: 'b'.repeat(40), buildConfiguredGitSha: 'a'.repeat(40),
    });
  });

  it('establishes a Git SHA only for a complete clean checkout with matching blob bytes', () => {
    const options = fixture();
    const git = initializeGitFixture(options);
    const sha = git(['rev-parse', 'HEAD']).trim();
    expect(writeProductionBuildIdentity(options).gitSha).toBe(sha);
    expect(readProductionBuildIdentity(options)).toMatchObject({ status: 'verified_checkout', gitSha: sha });
    options.env.RAILWAY_GIT_COMMIT_SHA = 'a'.repeat(40);
    expect(readProductionBuildIdentity(options)).toMatchObject({ status: 'mismatch', referenceStatus: 'mismatch', gitSha: sha });
    writeProductionBuildIdentity(options);
    options.env = {};
    expect(readProductionBuildIdentity(options)).toMatchObject({ status: 'mismatch', referenceStatus: 'mismatch', gitSha: sha });
    writeFileSync(join(options.rootPath, 'src/start-server.ts'), 'dirty source');
    // Even a new receipt cannot claim the unchanged HEAD represents modified build inputs.
    expect(writeProductionBuildIdentity(options).gitSha).toBeNull();
    git(['update-index', '--assume-unchanged', 'src/start-server.ts']);
    expect(git(['status', '--porcelain']).trim()).toBe('');
    expect(writeProductionBuildIdentity(options).gitSha).toBeNull();
  });

  it('establishes the same clean-checkout identity through a junction or symlink alias', () => {
    const options = fixture();
    const git = initializeGitFixture(options);
    const sha = git(['rev-parse', 'HEAD']).trim();
    const aliases = mkdtempSync(join(tmpdir(), 'arcanos-build-identity-alias-'));
    roots.push(aliases);
    const alias = join(aliases, 'checkout');
    symlinkSync(options.rootPath, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(realpathSync.native(alias)).toBe(realpathSync.native(options.rootPath));
    const physicalIdentity = writeProductionBuildIdentity(options);
    const aliasedOptions = { ...options, rootPath: alias };

    expect(writeProductionBuildIdentity(aliasedOptions)).toEqual(physicalIdentity);
    expect(readProductionBuildIdentity(aliasedOptions)).toMatchObject({ status: 'verified_checkout', gitSha: sha });
    writeFileSync(join(alias, 'src/start-server.ts'), 'dirty source through alias');
    expect(writeProductionBuildIdentity(aliasedOptions).gitSha).toBeNull();
  });

  it('does not accept local Git metadata that names another physical worktree', () => {
    const checkout = fixture();
    const git = initializeGitFixture(checkout);
    git(['config', 'core.worktree', checkout.rootPath]);
    const snapshot = fixture();
    writeFileSync(join(snapshot.rootPath, '.git'), `gitdir: ${join(checkout.rootPath, '.git')}\n`);
    const discoveredRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: snapshot.rootPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }).trim();

    expect(realpathSync.native(discoveredRoot)).toBe(realpathSync.native(checkout.rootPath));
    expect(realpathSync.native(discoveredRoot)).not.toBe(realpathSync.native(snapshot.rootPath));
    expect(writeProductionBuildIdentity(snapshot).gitSha).toBeNull();
  });

  it('does not borrow an ancestor repository for a nested source snapshot without its own Git metadata', () => {
    const checkout = fixture();
    const snapshot = join(checkout.rootPath, 'snapshot');
    mkdirSync(snapshot);
    for (const path of ['src', 'scripts', 'packages', 'dist']) mkdirSync(join(snapshot, path));
    writeFileSync(join(snapshot, 'src/start-server.ts'), 'export const version = 1;\n');
    writeFileSync(join(snapshot, 'dist/start-server.js'), 'export const version = 1;\n');
    writeFileSync(join(checkout.rootPath, '.gitignore'), 'dist/\nnode_modules/\n.env\nsnapshot/\n');
    initializeGitFixture(checkout);

    expect(writeProductionBuildIdentity({ rootPath: snapshot, env: {} }).gitSha).toBeNull();
  });

  it('contains only validated identity fields and never logs credentials or arbitrary receipt fields', () => {
    const options = fixture();
    options.env.OPENAI_API_KEY = 'test-synthetic-private-key';
    options.env.RAILWAY_GIT_COMMIT_SHA = 'invalid-reference-with-private-data';
    writeFileSync(join(options.rootPath, '.env'), 'PRIVATE=synthetic-private-value');
    const receipt = writeProductionBuildIdentity(options);
    const path = join(options.rootPath, BUILD_IDENTITY_PATH);
    writeFileSync(path, JSON.stringify({ ...receipt, secret: 'test-synthetic-private-payload' }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const info = reportProductionBuildIdentity(options);
    expect(info.configuredGitSha).toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-private');
    expect(readFileSync(path, 'utf8')).not.toContain('synthetic-private-key');
  });

  it('reports corrupt receipts unverified without reflecting their contents', () => {
    const options = fixture();
    writeFileSync(join(options.rootPath, BUILD_IDENTITY_PATH), '{private incomplete payload');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(reportProductionBuildIdentity(options).status).toBe('unverified');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private incomplete');
  });
});

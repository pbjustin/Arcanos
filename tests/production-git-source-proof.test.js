import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';
import {
  GIT_SOURCE_PROOF_PATH, createGitSourceProof, verifyGitSourceProof, writeGitSourceProofFromRepository,
} from '../scripts/production-git-source-proof.mjs';
import {
  BUILD_IDENTITY_PATH, readProductionBuildIdentity, writeProductionBuildIdentity,
} from '../scripts/production-build-identity.mjs';

const roots = [];
const isSourcePath = path => path.startsWith('src/') && path.endsWith('.ts');
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'arcanos-git-proof-'));
  roots.push(directory);
  const repository = join(directory, 'repository');
  const rootPath = join(directory, 'snapshot');
  mkdirSync(join(repository, 'src/nested'), { recursive: true });
  writeFileSync(join(repository, 'src/index.ts'), 'export const version = 1;\n');
  writeFileSync(join(repository, 'src/nested/worker.ts'), 'export const worker = true;\n');
  writeFileSync(join(repository, 'README.md'), 'outside the measured source inventory\n');
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'core.hooksPath', '.unused-test-hooks']);
  git(['add', '.']);
  git(['-c', 'user.name=Offline fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'synthetic source']);
  mkdirSync(join(rootPath, 'dist'), { recursive: true });
  cpSync(join(repository, 'src'), join(rootPath, 'src'), { recursive: true });
  const sourceFiles = ['src/index.ts', 'src/nested/worker.ts'].map(path => ({
    path, sha256: createHash('sha256').update(readFileSync(join(rootPath, path))).digest('hex')
  }));
  return { rootPath, gitDirectory: join(repository, '.git'), gitSha: git(['rev-parse', 'HEAD']).trim(), sourceFiles, isSourcePath };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('portable production Git source proof', () => {
  it('proves actual source bytes using real commit/tree objects without runtime .git', () => {
    const options = fixture();
    expect(writeGitSourceProofFromRepository(options)).toBe(true);
    rmSync(options.gitDirectory, { recursive: true });
    expect(verifyGitSourceProof(options)).toBe(true);
    const proof = JSON.parse(readFileSync(join(options.rootPath, GIT_SOURCE_PROOF_PATH), 'utf8'));
    expect(proof.trees.length).toBe(3);
    expect(proof).not.toHaveProperty('repository');
    expect(proof).not.toHaveProperty('credentials');
  });

  it('cannot verify a different commit reference using valid source objects', () => {
    const options = fixture();
    expect(writeGitSourceProofFromRepository(options)).toBe(true);
    expect(verifyGitSourceProof({ ...options, gitSha: 'a'.repeat(40) })).toBe(false);
  });

  it('binds real Git source proof and generated output in the runtime receipt without checkout metadata', () => {
    const options = fixture();
    mkdirSync(join(options.rootPath, 'packages'));
    writeFileSync(join(options.rootPath, 'dist/start-server.js'), 'export const compiled = true;\n');
    expect(writeGitSourceProofFromRepository(options)).toBe(true);
    rmSync(options.gitDirectory, { recursive: true });
    const identityOptions = { rootPath: options.rootPath, env: { RAILWAY_GIT_COMMIT_SHA: options.gitSha } };
    writeProductionBuildIdentity(identityOptions);
    expect(readProductionBuildIdentity(identityOptions)).toMatchObject({
      status: 'verified_git_source', gitSha: options.gitSha,
      artifactStatus: 'matches_build_receipt', referenceStatus: 'matches_verified_git_source',
    });
    writeFileSync(join(options.rootPath, 'dist/start-server.js'), 'tampered artifact');
    expect(readProductionBuildIdentity(identityOptions)).toMatchObject({
      status: 'mismatch', gitSha: null, artifactStatus: 'mismatch',
    });
  });

  it('rejects a fabricated commit claim even if the unkeyed receipt hash is recomputed', () => {
    const options = fixture();
    mkdirSync(join(options.rootPath, 'packages'));
    writeFileSync(join(options.rootPath, 'dist/start-server.js'), 'export const compiled = true;\n');
    expect(writeGitSourceProofFromRepository(options)).toBe(true);
    const identityOptions = { rootPath: options.rootPath, env: { RAILWAY_GIT_COMMIT_SHA: options.gitSha } };
    const receipt = writeProductionBuildIdentity(identityOptions);
    receipt.gitSha = 'a'.repeat(40);
    receipt.configuredGitSha = receipt.gitSha;
    const { sourceDigest, artifactDigest, gitSha, configuredGitSha } = receipt;
    receipt.buildId = createHash('sha256').update(JSON.stringify({ sourceDigest, artifactDigest, gitSha, configuredGitSha })).digest('hex');
    writeFileSync(join(options.rootPath, BUILD_IDENTITY_PATH), JSON.stringify(receipt));
    expect(readProductionBuildIdentity({ ...identityOptions, env: { RAILWAY_GIT_COMMIT_SHA: receipt.gitSha } })).toMatchObject({
      status: 'mismatch', gitSha: null, artifactStatus: 'matches_build_receipt',
    });
  });

  it.each(['commit', 'tree', 'gitSha'])('rejects tampered %s even when the rest of the proof is valid', field => {
    const options = fixture();
    expect(writeGitSourceProofFromRepository(options)).toBe(true);
    const path = join(options.rootPath, GIT_SOURCE_PROOF_PATH);
    const proof = JSON.parse(readFileSync(path, 'utf8'));
    if (field === 'commit') proof.commit = Buffer.from('tree fake\n').toString('base64');
    if (field === 'tree') proof.trees[0].bytes = Buffer.from('different tree').toString('base64');
    if (field === 'gitSha') proof.gitSha = 'b'.repeat(40);
    writeFileSync(path, JSON.stringify(proof));
    expect(verifyGitSourceProof(options)).toBe(false);
  });

  it('rejects changed source even when a new SHA-256 inventory claims those changed bytes', () => {
    const options = fixture();
    expect(writeGitSourceProofFromRepository(options)).toBe(true);
    writeFileSync(join(options.rootPath, options.sourceFiles[0].path), 'changed source');
    options.sourceFiles[0].sha256 = createHash('sha256').update('changed source').digest('hex');
    expect(verifyGitSourceProof(options)).toBe(false);
  });

  it('rejects omitted and extra measured source paths', () => {
    const options = fixture();
    expect(writeGitSourceProofFromRepository(options)).toBe(true);
    expect(verifyGitSourceProof({ ...options, sourceFiles: options.sourceFiles.slice(1) })).toBe(false);
    expect(verifyGitSourceProof({ ...options, sourceFiles: [...options.sourceFiles, { path: 'src/extra.ts', sha256: 'a'.repeat(64) }] })).toBe(false);
    expect(verifyGitSourceProof({ ...options, sourceFiles: [options.sourceFiles[0], options.sourceFiles[0]] })).toBe(false);
  });

  it('refuses to create source evidence when the snapshot is missing expected Git inputs', () => {
    const options = fixture();
    rmSync(join(options.rootPath, 'src/nested/worker.ts'));
    options.sourceFiles.pop();
    expect(writeGitSourceProofFromRepository(options)).toBe(false);
    expect(verifyGitSourceProof(options)).toBe(false);
  });

  it('rejects source and proof links', () => {
    const options = fixture();
    expect(writeGitSourceProofFromRepository(options)).toBe(true);
    const original = join(options.rootPath, 'src/index.ts');
    rmSync(original);
    symlinkSync(join(options.gitDirectory, '../src/index.ts'), original);
    expect(verifyGitSourceProof(options)).toBe(false);
    const proofPath = join(options.rootPath, GIT_SOURCE_PROOF_PATH);
    const bytes = readFileSync(proofPath);
    rmSync(proofPath);
    const external = join(options.rootPath, 'proof.json');
    writeFileSync(external, bytes);
    symlinkSync(external, proofPath);
    expect(verifyGitSourceProof(options)).toBe(false);
  });

  it('rejects a linked proof-directory ancestor for both reads and writes', () => {
    const options = fixture();
    expect(writeGitSourceProofFromRepository(options)).toBe(true);
    const output = join(options.rootPath, 'dist');
    const external = join(options.rootPath, 'external-output');
    cpSync(output, external, { recursive: true });
    rmSync(output, { recursive: true });
    symlinkSync(external, output, process.platform === 'win32' ? 'junction' : 'dir');
    expect(verifyGitSourceProof(options)).toBe(false);
    expect(writeGitSourceProofFromRepository(options)).toBe(false);
  });

  it.each([null, '', 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), 'a'.repeat(40) + '\n'])('rejects malformed SHA %p before any fetch', gitSha => {
    expect(createGitSourceProof({ gitSha })).toBe(false);
  });

  it('rejects malformed, oversized and incomplete tree proofs', () => {
    const options = fixture();
    const path = join(options.rootPath, GIT_SOURCE_PROOF_PATH);
    expect(verifyGitSourceProof(options)).toBe(false);
    writeFileSync(path, '{broken');
    expect(verifyGitSourceProof(options)).toBe(false);
    writeFileSync(path, 'x'.repeat(8 * 1024 * 1024 + 1));
    expect(verifyGitSourceProof(options)).toBe(false);
    expect(writeGitSourceProofFromRepository(options)).toBe(true);
    const proof = JSON.parse(readFileSync(path, 'utf8'));
    proof.trees.pop();
    writeFileSync(path, JSON.stringify(proof));
    expect(verifyGitSourceProof(options)).toBe(false);
  });
});

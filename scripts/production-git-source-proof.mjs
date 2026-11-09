import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const GIT_SOURCE_PROOF_PATH = 'dist/git-source-proof.json';
const REPOSITORY = 'https://github.com/pbjustin/Arcanos.git';
const SHA = /^[0-9a-f]{40}$/u;
const isSha = value => typeof value === 'string' && SHA.test(value);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PATHS = 20_000;
const gitObjectHash = (type, bytes) => createHash('sha1')
  .update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');

function gitEnvironment() {
  const env = { ...process.env };
  // Do not borrow caller-supplied repositories, config, helpers or disabled TLS.
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_') && !['GIT_SSL_CAINFO', 'GIT_SSL_CAPATH'].includes(name)) delete env[name];
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
}

function git(gitDirectory, args) {
  return execFileSync('git', [
    '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null',
    '-c', 'protocol.file.allow=never', '-c', 'http.followRedirects=false',
    '-c', 'http.sslVerify=true', '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true',
    `--git-dir=${gitDirectory}`, ...args
  ], { env: gitEnvironment(), stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_BYTES, timeout: 60_000 });
}

function decodeObject(value) {
  if (typeof value !== 'string' || value.length > MAX_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error('GIT_SOURCE_PROOF_INVALID');
  }
  return Buffer.from(value, 'base64');
}

function proofPath(rootPath) {
  const directory = resolve(rootPath, 'dist');
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('GIT_SOURCE_PROOF_INVALID');
  const path = resolve(rootPath, GIT_SOURCE_PROOF_PATH);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('GIT_SOURCE_PROOF_INVALID');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return path;
}

function treeEntries(bytes) {
  const entries = [];
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    const nul = bytes.indexOf(0, space + 1);
    if (space <= offset || nul <= space + 1 || nul + 21 > bytes.length) throw new Error('GIT_SOURCE_PROOF_INVALID');
    const mode = bytes.subarray(offset, space).toString('ascii');
    const nameBytes = bytes.subarray(space + 1, nul);
    const name = nameBytes.toString('utf8');
    if (!Buffer.from(name).equals(nameBytes) || ['.', '..'].includes(name) || /[\/\\\u0000-\u001f]/u.test(name)) {
      throw new Error('GIT_SOURCE_PROOF_INVALID');
    }
    const sha = bytes.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

function verifyProof({ proof, rootPath, gitSha, sourceFiles, isSourcePath }) {
  if (!isSha(gitSha) || !proof || proof.version !== 1 || proof.gitSha !== gitSha
    || typeof isSourcePath !== 'function' || !Array.isArray(proof.trees)
    || proof.trees.length > MAX_PATHS || !Array.isArray(sourceFiles) || sourceFiles.length > MAX_PATHS) return false;
  const commit = decodeObject(proof.commit);
  if (gitObjectHash('commit', commit) !== gitSha) return false;
  const rootMatch = /^tree ([0-9a-f]{40})\n/u.exec(commit.toString('utf8'));
  if (!rootMatch) return false;
  const trees = new Map();
  for (const entry of proof.trees) {
    if (!entry || !isSha(entry.sha) || trees.has(entry.sha)) return false;
    const bytes = decodeObject(entry.bytes);
    if (gitObjectHash('tree', bytes) !== entry.sha) return false;
    trees.set(entry.sha, bytes);
  }
  const expected = new Map();
  let paths = 0;
  const walk = (sha, prefix, depth) => {
    if (depth > 64 || !trees.has(sha)) throw new Error('GIT_SOURCE_PROOF_INVALID');
    const names = new Set();
    for (const entry of treeEntries(trees.get(sha))) {
      if (++paths > MAX_PATHS || names.has(entry.name)) throw new Error('GIT_SOURCE_PROOF_INVALID');
      names.add(entry.name);
      const path = `${prefix}${entry.name}`;
      if (entry.mode === '40000') walk(entry.sha, `${path}/`, depth + 1);
      else if (isSourcePath(path)) {
        if (!['100644', '100755'].includes(entry.mode)) throw new Error('GIT_SOURCE_PROOF_INVALID');
        expected.set(path, entry.sha);
      }
    }
  };
  walk(rootMatch[1], '', 0);
  if (expected.size !== sourceFiles.length) return false;
  const actual = new Set();
  for (const file of sourceFiles) {
    if (!file || typeof file.path !== 'string' || actual.has(file.path) || !expected.has(file.path)) return false;
    actual.add(file.path);
    const parts = file.path.split('/');
    if (parts.some(part => !part || ['.', '..'].includes(part))) return false;
    let absolute = rootPath;
    for (const part of parts) {
      absolute = resolve(absolute, part);
      if (lstatSync(absolute).isSymbolicLink()) return false;
    }
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return false;
    const contents = readFileSync(absolute);
    if (contents.length > 32 * 1024 * 1024
      || createHash('sha256').update(contents).digest('hex') !== file.sha256
      || gitObjectHash('blob', contents) !== expected.get(file.path)) return false;
  }
  return true;
}

/** Runtime verification uses only content-addressed Git objects, never network or .git. */
export function verifyGitSourceProof(options) {
  try {
    const path = proofPath(options.rootPath);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return false;
    return verifyProof({ ...options, proof: JSON.parse(readFileSync(path, 'utf8')) });
  } catch { return false; }
}

/** Build a portable proof from real Git objects; also supports isolated local Git fixtures. */
export function writeGitSourceProofFromRepository(options) {
  try {
    if (!isSha(options.gitSha)) return false;
    const commit = git(options.gitDirectory, ['cat-file', 'commit', options.gitSha]);
    const treeShas = git(options.gitDirectory, ['ls-tree', '-r', '-t', '-z', options.gitSha])
      .toString('utf8').split('\0').filter(Boolean)
      .map(entry => /^040000 tree ([0-9a-f]{40})\t/u.exec(entry)?.[1]).filter(Boolean);
    const rootMatch = /^tree ([0-9a-f]{40})\n/u.exec(commit.toString('utf8'));
    if (!rootMatch) return false;
    const trees = [...new Set([rootMatch[1], ...treeShas])].sort().map(sha => ({
      sha, bytes: git(options.gitDirectory, ['cat-file', 'tree', sha]).toString('base64')
    }));
    const proof = { version: 1, gitSha: options.gitSha, commit: commit.toString('base64'), trees };
    const serialized = `${JSON.stringify(proof)}\n`;
    if (Buffer.byteLength(serialized) > MAX_BYTES || !verifyProof({ ...options, proof })) return false;
    writeFileSync(proofPath(options.rootPath), serialized);
    return true;
  } catch { return false; }
}

/** Fetch exactly the requested public commit; no branch resolution, credentials or runtime Git. */
export function createGitSourceProof(options) {
  if (!isSha(options.gitSha)) return false;
  let directory;
  try {
    directory = mkdtempSync(join(tmpdir(), 'arcanos-git-source-'));
    git(directory, ['init', '--bare', directory]);
    git(directory, ['fetch', '--depth=1', '--no-tags', REPOSITORY, options.gitSha]);
    if (git(directory, ['rev-parse', 'FETCH_HEAD']).toString('utf8').trim() !== options.gitSha) return false;
    return writeGitSourceProofFromRepository({ ...options, gitDirectory: directory });
  } catch { return false; }
  finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
}

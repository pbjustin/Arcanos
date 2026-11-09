import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGitSourceProof, verifyGitSourceProof } from './production-git-source-proof.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const BUILD_IDENTITY_PATH = 'dist/build-identity.json';
// Fixed code/build inputs only: never walk runtime volumes, credentials or node_modules.
const SOURCE_ROOTS = [
  'src', 'scripts', 'config', 'contracts', 'schemas', 'openapi',
  'workers/src', 'daemon-python/arcanos', 'packages', 'vendor', 'arcanos-ai-runtime/src',
];
const SOURCE_FILES = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'Dockerfile', 'railway.json',
  'workers/package.json', 'workers/tsconfig.json', 'daemon-python/pyproject.toml',
  'prisma/schema.prisma', 'arcanos-ai-runtime/package.json',
  'arcanos-ai-runtime/package-lock.json', 'arcanos-ai-runtime/tsconfig.json',
];
const CODE_EXTENSIONS = /\.(?:[cm]?js|ts|json|py|toml)$/u;
const SHA = /^[0-9a-f]{40}$/iu;
const DIGEST = /^[0-9a-f]{64}$/u;
const hash = value => createHash('sha256').update(value).digest('hex');
const normalizeSha = value => typeof value === 'string' && SHA.test(value) ? value.toLowerCase() : null;
const invalidSha = value => value !== undefined && value !== '' && !normalizeSha(value);

/** Shared with the Git tree verifier so omitted and added build inputs are detected. */
export function isProductionSourcePath(path) {
  if (path === 'scripts/self-heal-preview-artifact.json') return false;
  if (SOURCE_FILES.includes(path)) return true;
  if (!SOURCE_ROOTS.some(root => path.startsWith(`${root}/`))) return false;
  const components = path.split('/');
  if (components.some(name => ['node_modules', '__pycache__', '.git'].includes(name) || /^\.env(?:\.|$)/u.test(name))) return false;
  if (components.includes('dist') && !path.startsWith('vendor/')) return false;
  return CODE_EXTENSIONS.test(path);
}

/** Hash bounded source or emitted files, rejecting links and excluding private/runtime data. */
function inventory(rootPath, runtime) {
  const files = [];
  let bytes = 0;
  const visit = path => {
    const absolute = resolve(rootPath, path);
    let stat;
    try {
      let parent = rootPath;
      for (const component of path.split('/')) {
        parent = resolve(parent, component);
        if (lstatSync(parent).isSymbolicLink()) throw new Error('BUILD_IDENTITY_LINK');
      }
      stat = lstatSync(absolute);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('BUILD_IDENTITY_LINK');
    if (/(?:^|\/)\.env(?:\.|$)/u.test(path)) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (['node_modules', '__pycache__', '.git'].includes(name) && !runtime) continue;
        // Checked-in vendor dist files are dependency inputs, not generated workspace output.
        if (name === 'dist' && !runtime && path !== 'vendor' && !path.startsWith('vendor/')) continue;
        visit(`${path}/${name}`);
      }
      return;
    }
    if (path === BUILD_IDENTITY_PATH || path === 'scripts/self-heal-preview-artifact.json') return;
    if (!runtime && !isProductionSourcePath(path)) return;
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('BUILD_IDENTITY_SIZE');
    bytes += stat.size;
    if (bytes > 512 * 1024 * 1024 || files.length >= 20_000) throw new Error('BUILD_IDENTITY_SIZE');
    files.push({ path, sha256: hash(readFileSync(absolute)) });
  };
  if (runtime) {
    visit('dist');
    visit('workers/dist');
    for (const name of readdirSync(resolve(rootPath, 'packages')).sort()) visit(`packages/${name}/dist`);
  } else {
    for (const path of SOURCE_ROOTS) visit(path);
    for (const path of SOURCE_FILES) visit(path);
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return files;
}

/** Establish a commit only from a complete, byte-matching Git checkout. Env references are claims. */
function verifiedGitSha(rootPath, sourceFiles) {
  try {
    // A source snapshot without its own Git metadata must not discover an ancestor repository.
    lstatSync(resolve(rootPath, '.git'));
    const git = args => execFileSync('git', args, { cwd: rootPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024, timeout: 5_000 });
    if (realpathSync.native(git(['rev-parse', '--show-toplevel']).trim()) !== realpathSync.native(rootPath)) return null;
    if (git(['status', '--porcelain', '--untracked-files=all']).trim()) return null;
    const sha = normalizeSha(git(['rev-parse', 'HEAD']).trim());
    if (!sha) return null;
    const tracked = new Set();
    for (const entry of git(['ls-tree', '-rz', sha]).split('\0').filter(Boolean)) {
      const match = /^(\d+) blob ([0-9a-f]{40})\t(.+)$/u.exec(entry);
      if (!match || !['100644', '100755'].includes(match[1])) return null;
      const path = match[3];
      const absolute = resolve(rootPath, path);
      if (!lstatSync(absolute).isFile()) return null;
      const contents = readFileSync(absolute);
      const blob = createHash('sha1').update(`blob ${contents.length}\0`).update(contents).digest('hex');
      if (blob !== match[2]) return null;
      tracked.add(path);
    }
    return sourceFiles.every(file => tracked.has(file.path)) ? sha : null;
  } catch { return null; }
}

/** Write a receipt for actual build output; optional fetching proves source, never env claims alone. */
export function writeProductionBuildIdentity({ rootPath = ROOT, env = process.env, verifySource = false } = {}) {
  if (invalidSha(env.RAILWAY_GIT_COMMIT_SHA)) throw new Error('BUILD_GIT_SHA_INVALID');
  // Require real build output; a source-only command cannot manufacture a build receipt.
  if (!lstatSync(resolve(rootPath, 'dist/start-server.js')).isFile()) throw new Error('BUILD_OUTPUT_REQUIRED');
  const sourceFiles = inventory(rootPath, false);
  const sourceDigest = hash(JSON.stringify(sourceFiles));
  const configuredGitSha = normalizeSha(env.RAILWAY_GIT_COMMIT_SHA);
  let gitSha = verifiedGitSha(rootPath, sourceFiles);
  if (!gitSha && configuredGitSha) {
    const options = { rootPath, gitSha: configuredGitSha, sourceFiles, isSourcePath: isProductionSourcePath };
    if ((verifySource && createGitSourceProof(options)) || verifyGitSourceProof(options)) gitSha = configuredGitSha;
  }
  const artifactDigest = hash(JSON.stringify(inventory(rootPath, true)));
  const buildId = hash(JSON.stringify({ sourceDigest, artifactDigest, gitSha, configuredGitSha }));
  const identity = { version: 1, buildId, sourceDigest, artifactDigest, gitSha, configuredGitSha };
  writeFileSync(resolve(rootPath, BUILD_IDENTITY_PATH), `${JSON.stringify(identity)}\n`);
  return identity;
}

/** Read and remeasure the receipt; never promote a platform commit reference to proven source. */
export function readProductionBuildIdentity({ rootPath = ROOT, env = process.env } = {}) {
  const configuredGitSha = normalizeSha(env.RAILWAY_GIT_COMMIT_SHA);
  const invalidReference = invalidSha(env.RAILWAY_GIT_COMMIT_SHA);
  const unknown = { status: invalidReference ? 'mismatch' : 'unverified', gitSha: null, buildId: null, sourceDigest: null, artifactDigest: null, configuredGitSha, buildConfiguredGitSha: null, artifactStatus: 'unknown', referenceStatus: invalidReference ? 'invalid' : 'unknown' };
  try {
    const path = resolve(rootPath, BUILD_IDENTITY_PATH);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return unknown;
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    if (receipt.version !== 1 || ![receipt.buildId, receipt.sourceDigest, receipt.artifactDigest].every(value => typeof value === 'string' && DIGEST.test(value))
      || (receipt.gitSha !== null && !normalizeSha(receipt.gitSha))
      || (receipt.configuredGitSha !== null && !normalizeSha(receipt.configuredGitSha))) return unknown;
    const { sourceDigest, artifactDigest, gitSha, configuredGitSha: buildConfiguredGitSha, buildId } = receipt;
    const sourceFiles = inventory(rootPath, false);
    const artifactMatches = hash(JSON.stringify({ sourceDigest, artifactDigest, gitSha, configuredGitSha: buildConfiguredGitSha })) === buildId
      && hash(JSON.stringify(sourceFiles)) === sourceDigest
      && hash(JSON.stringify(inventory(rootPath, true))) === artifactDigest;
    // A recomputed unkeyed receipt cannot manufacture independently proven source.
    const checkoutVerified = Boolean(gitSha && verifiedGitSha(rootPath, sourceFiles) === gitSha);
    const sourceVerified = Boolean(gitSha && verifyGitSourceProof({ rootPath, gitSha, sourceFiles, isSourcePath: isProductionSourcePath }));
    const provenanceVerified = checkoutVerified || sourceVerified;
    const referenceMismatch = Boolean(
      (gitSha && buildConfiguredGitSha && gitSha !== buildConfiguredGitSha)
      || (configuredGitSha && gitSha && configuredGitSha !== gitSha)
      || (configuredGitSha && buildConfiguredGitSha && configuredGitSha !== buildConfiguredGitSha)
    );
    return {
      status: !artifactMatches || referenceMismatch || invalidReference || (gitSha && !provenanceVerified) ? 'mismatch'
        : buildConfiguredGitSha && !configuredGitSha ? 'unverified'
        : checkoutVerified ? 'verified_checkout' : sourceVerified ? 'verified_git_source' : 'unverified',
      gitSha: artifactMatches && provenanceVerified ? gitSha : null,
      buildId, sourceDigest, artifactDigest, configuredGitSha, buildConfiguredGitSha,
      artifactStatus: artifactMatches ? 'matches_build_receipt' : 'mismatch',
      referenceStatus: invalidReference ? 'invalid' : referenceMismatch ? 'mismatch'
        : configuredGitSha && checkoutVerified ? 'matches_verified_checkout'
        : configuredGitSha && sourceVerified ? 'matches_verified_git_source'
        : configuredGitSha && buildConfiguredGitSha ? 'matches_build_reference' : 'unverified',
    };
  } catch { return unknown; }
}

/** Log only validated identity fields, preserving error severity even when inventory is unavailable. */
export function reportProductionBuildIdentity(options) {
  const identity = readProductionBuildIdentity(options);
  const log = identity.status === 'mismatch' ? console.error : identity.status === 'unverified' ? console.warn : console.log;
  log('[railway-launcher] build.identity', JSON.stringify(identity));
  return identity;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== '--write' || process.argv.length > 4 || (process.argv[3] && process.argv[3] !== '--verify-source')) {
    process.exitCode = 1;
  } else {
    try { console.log('[build] identity', JSON.stringify(writeProductionBuildIdentity({ verifySource: process.argv[3] === '--verify-source' }))); }
    catch { console.error('[build] identity unavailable'); process.exitCode = 1; }
  }
}

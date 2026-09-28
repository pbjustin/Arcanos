import { readFile, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { digest, noSymlinkAncestors, readSafeFile, requireCondition, validateArtifact } from './tutor-migration.mjs';

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  requireCondition(result.status === 0, 'PRIVATE_BOUNDARY_GIT_FAILED');
  return result.stdout;
}

async function reviewedPublicSources(root, review) {
  const sources = new Map();
  if (review === undefined) return sources;
  requireCondition(review && Object.keys(review).sort().join(',') === 'artifacts,baseCommit' &&
    /^[a-f0-9]{40}$/u.test(review.baseCommit) && Array.isArray(review.artifacts) &&
    review.artifacts.length > 0 && review.artifacts.length <= 32, 'PUBLIC_SOURCE_REVIEW_INVALID');
  requireCondition(git(root, ['cat-file', '-t', review.baseCommit]).toString('utf8').trim() === 'commit',
    'PUBLIC_SOURCE_BASE_INVALID');
  for (const artifact of review.artifacts) {
    validateArtifact(artifact);
    requireCondition(Object.keys(artifact).sort().join(',') === 'path,sha256,sizeBytes' &&
      !artifact.path.startsWith('.local-migration/') && !sources.has(artifact.path), 'PUBLIC_SOURCE_REVIEW_INVALID');
    const mode = git(root, ['ls-tree', '--format=%(objecttype) %(objectmode)', review.baseCommit, '--', artifact.path])
      .toString('utf8').trim();
    requireCondition(['blob 100644', 'blob 100755'].includes(mode), 'PUBLIC_SOURCE_FILE_INVALID');
    const bytes = git(root, ['show', `${review.baseCommit}:${artifact.path}`]);
    requireCondition(bytes.length === artifact.sizeBytes && digest(bytes) === artifact.sha256,
      'PUBLIC_SOURCE_BASE_DIGEST_MISMATCH');
    sources.set(artifact.path, artifact);
  }
  return sources;
}

/**
 * Shared migration boundary. The caller supplies the fixed product slug.
 * Optional public sources permit only reviewed pre-existing bytes at their original
 * tracked paths; changed files and copies at other paths still undergo the scan.
 */
export async function checkPluginPrivateBoundary(inputRoot, pluginName, { publicSources } = {}) {
  inputRoot = path.resolve(inputRoot);
  requireCondition(typeof pluginName === 'string' && /^arcanos-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(pluginName) &&
    path.basename(inputRoot) === pluginName &&
    path.basename(path.dirname(inputRoot)) === '.local-migration', 'PRIVATE_INPUT_ROOT_REQUIRED');
  await noSymlinkAncestors(inputRoot);
  const root = path.dirname(path.dirname(inputRoot));
  const ignored = spawnSync('git', ['-C', root, 'check-ignore', '--quiet', '--no-index', '--',
    `.local-migration/${pluginName}/`], { windowsHide: true });
  requireCondition(ignored.status === 0 && git(root, ['ls-files', '--', '.local-migration/']).length === 0,
    'PRIVATE_INPUT_TRACKED_OR_NOT_IGNORED');
  const publicArtifacts = await reviewedPublicSources(root, publicSources);
  const raw = await readSafeFile(inputRoot, 'published-gpt.json');
  const source = JSON.parse(raw.content);
  const privateValues = [raw.content, source.instructions, JSON.stringify(source.instructions),
    JSON.stringify(source.representativeBehavior), ...source.representativeBehavior,
    ...source.instructions.split(/\r?\n\s*\r?\n/u).filter(value => value.length >= 80)]
    .filter(value => typeof value === 'string' && value.length >= 32);
  const scan = (bytes, relative) => {
    const publicArtifact = publicArtifacts.get(relative);
    if (publicArtifact && bytes.length === publicArtifact.sizeBytes && digest(bytes) === publicArtifact.sha256) return;
    const content = bytes.toString('utf8').replace(/\r\n/gu, '\n');
    requireCondition(!privateValues.some(value => content.includes(value.replace(/\r\n/gu, '\n'))),
      'PRIVATE_CONTENT_OUTSIDE_IGNORED_INPUTS');
  };
  const files = [...new Set(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .toString('utf8').split('\0').filter(Boolean))];
  let inspected = 0;
  for (const relative of files) {
    const absolute = path.resolve(root, relative);
    requireCondition(absolute.startsWith(`${root}${path.sep}`), 'PRIVATE_BOUNDARY_PATH_ESCAPE');
    const info = await lstat(absolute).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info?.isFile()) continue;
    scan(await readFile(absolute), relative);
    inspected += 1;
  }
  const staged = git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .toString('utf8').split('\0').filter(Boolean);
  for (const relative of staged) scan(git(root, ['show', `:${relative}`]), relative);
  return { privacyBoundary: 'PASS', privateInputIgnored: true, privateInputTracked: false,
    inspectedWorkingFiles: inspected, inspectedStagedFiles: staged.length };
}

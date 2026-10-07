import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'pbjustin/Arcanos';
const API_ORIGIN = 'https://api.github.com';
const SCANNER_VERSION = '8.24.3';
const SHA = /^(?!0{40}$)[0-9a-f]{40}$/u;

export class CiGitleaksRangeError extends Error {
  constructor(code, exitCode = 1) {
    super(code);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function requireRange(condition, code) {
  if (!condition) throw new CiGitleaksRangeError(code);
}

// Git and the scanner receive no GitHub token, provider key, or ambient Git configuration.
function childEnvironment(environment) {
  return { ...Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']
    .filter(key => typeof environment[key] === 'string')
    .map(key => [key, environment[key]])), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
}

function execute(runProcess, executable, args, options) {
  try {
    return runProcess(executable, args, {
      ...options, encoding: 'utf8', shell: false, timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    throw new CiGitleaksRangeError('CI_GITLEAKS_PROCESS_FAILED');
  }
}

async function readGitHubJson(fetchImpl, pathname, token) {
  const url = `${API_ORIGIN}${pathname}`;
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'arcanos-ci-gitleaks-range' },
    });
  } catch {
    throw new CiGitleaksRangeError('CI_GITLEAKS_API_FAILED');
  }
  requireRange(response?.status === 200 && response.redirected === false && response.url === url,
    'CI_GITLEAKS_API_RESPONSE_INVALID');
  let text;
  try { text = await response.text(); }
  catch { throw new CiGitleaksRangeError('CI_GITLEAKS_API_RESPONSE_INVALID'); }
  requireRange(typeof text === 'string' && Buffer.byteLength(text) <= 128 * 1024,
    'CI_GITLEAKS_API_RESPONSE_INVALID');
  try { return JSON.parse(text); }
  catch { throw new CiGitleaksRangeError('CI_GITLEAKS_API_RESPONSE_INVALID'); }
}

async function readSnapshot({ fetchImpl, repository, defaultBranch, branch, expectedSha, token }) {
  const repo = await readGitHubJson(fetchImpl, `/repos/${repository}`, token);
  requireRange(repo?.full_name === repository && repo.default_branch === defaultBranch,
    'CI_GITLEAKS_REPOSITORY_IDENTITY_INVALID');
  const base = await readGitHubJson(fetchImpl,
    `/repos/${repository}/branches/${encodeURIComponent(defaultBranch)}`, token);
  requireRange(base?.name === defaultBranch && base.protected === true && SHA.test(base.commit?.sha ?? ''),
    'CI_GITLEAKS_PROTECTED_BASE_INVALID');
  const candidate = await readGitHubJson(fetchImpl,
    `/repos/${repository}/branches/${encodeURIComponent(branch)}`, token);
  requireRange(candidate?.name === branch && candidate.commit?.sha === expectedSha,
    'CI_GITLEAKS_CANDIDATE_REF_DRIFT');
  return { baseSha: base.commit.sha, headSha: candidate.commit.sha };
}

/** Blocking incremental security gate for same-repository manual feature dispatches only. */
export async function runCiGitleaksRange({ environment = process.env, cwd = process.cwd(),
  fetchImpl = globalThis.fetch, runProcess = spawnSync } = {}) {
  const repository = environment.GITHUB_REPOSITORY;
  const defaultBranch = environment.DEFAULT_BRANCH;
  const ref = environment.GITHUB_REF;
  const expectedSha = environment.GITHUB_SHA;
  const scanner = environment.GITLEAKS_BIN;
  const token = environment.GITHUB_TOKEN;
  requireRange(environment.GITHUB_EVENT_NAME === 'workflow_dispatch' && repository === REPOSITORY,
    'CI_GITLEAKS_EVENT_INVALID');
  requireRange(typeof defaultBranch === 'string' && defaultBranch.length > 0 && defaultBranch.length <= 255
    && typeof ref === 'string' && ref.startsWith('refs/heads/') && ref.length <= 266
    && !/[\x00-\x20\x7f]/u.test(defaultBranch + ref) && ref !== `refs/heads/${defaultBranch}`,
  'CI_GITLEAKS_FEATURE_REF_INVALID');
  requireRange(SHA.test(expectedSha ?? ''), 'CI_GITLEAKS_HEAD_INVALID');
  requireRange(typeof scanner === 'string' && path.isAbsolute(scanner), 'CI_GITLEAKS_SCANNER_INVALID');
  requireRange(typeof token === 'string' && token.length > 0 && token.trim() === token && !/[\r\n]/u.test(token),
    'CI_GITLEAKS_AUTH_MISSING');
  requireRange(!environment.GITLEAKS_CONFIG && !environment.GITLEAKS_CONFIG_TOML,
    'CI_GITLEAKS_CONFIGURATION_INVALID');
  const branch = ref.slice('refs/heads/'.length);
  const options = { cwd, env: childEnvironment(environment) };
  const gitResult = args => execute(runProcess, 'git', args, options);
  const git = args => {
    const result = gitResult(args);
    requireRange(!result.error && result.status === 0, 'CI_GITLEAKS_GIT_FAILED');
    return String(result.stdout ?? '').trim();
  };
  git(['check-ref-format', ref]);
  git(['check-ref-format', `refs/heads/${defaultBranch}`]);
  const origin = git(['remote', 'get-url', 'origin']);
  requireRange([`https://github.com/${repository}`, `https://github.com/${repository}.git`,
    `git@github.com:${repository}`, `git@github.com:${repository}.git`].includes(origin),
  'CI_GITLEAKS_ORIGIN_INVALID');
  const verifyCheckout = () => {
    requireRange(git(['rev-parse', '--verify', 'HEAD']) === expectedSha, 'CI_GITLEAKS_CHECKOUT_HEAD_MISMATCH');
    requireRange(git(['rev-parse', '--is-shallow-repository']) === 'false', 'CI_GITLEAKS_SHALLOW_CHECKOUT');
    const symbolic = gitResult(['symbolic-ref', '--quiet', 'HEAD']);
    requireRange(!symbolic.error && (symbolic.status === 1
      || symbolic.status === 0 && String(symbolic.stdout ?? '').trim() === ref),
    'CI_GITLEAKS_CHECKOUT_REF_MISMATCH');
    requireRange(git(['status', '--porcelain', '--untracked-files=all']) === '', 'CI_GITLEAKS_CHECKOUT_DIRTY');
  };
  verifyCheckout();
  const version = execute(runProcess, scanner, ['version'], options);
  requireRange(!version.error && version.status === 0 && String(version.stdout ?? '').trim() === SCANNER_VERSION,
    'CI_GITLEAKS_SCANNER_VERSION_INVALID');
  const snapshotInput = { fetchImpl, repository, defaultBranch, branch, expectedSha, token };
  const before = await readSnapshot(snapshotInput);
  requireRange(before.baseSha !== expectedSha, 'CI_GITLEAKS_EMPTY_RANGE');
  git(['cat-file', '-e', `${before.baseSha}^{commit}`]);
  git(['cat-file', '-e', `${expectedSha}^{commit}`]);
  git(['merge-base', '--is-ancestor', before.baseSha, expectedSha]);
  const range = `${before.baseSha}..${expectedSha}`;
  const commitCount = Number(git(['rev-list', '--count', range]));
  const mergeCount = Number(git(['rev-list', '--count', '--merges', range]));
  requireRange(Number.isSafeInteger(commitCount) && commitCount > 0 && Number.isSafeInteger(mergeCount)
    && mergeCount >= 0 && mergeCount <= commitCount, 'CI_GITLEAKS_RANGE_INVALID');
  // first-parent applies only to merge diffs; traversal still includes every candidate commit.
  const result = execute(runProcess, scanner, ['git', '.',
    `--log-opts=--full-history --diff-merges=first-parent ${range}`, '--redact=100', '--no-banner'], options);
  // Pin both live refs throughout the gate; never accept a scan after repository/base/head drift.
  const after = await readSnapshot(snapshotInput);
  requireRange(after.baseSha === before.baseSha && after.headSha === before.headSha, 'CI_GITLEAKS_BASE_REF_DRIFT');
  verifyCheckout();
  if (result.error || result.status !== 0) {
    const exitCode = Number.isInteger(result.status) && result.status > 0 && result.status <= 255 ? result.status : 1;
    throw new CiGitleaksRangeError('CI_GITLEAKS_SCAN_FAILED', exitCode);
  }
  return { status: 'PASS', event: 'workflow_dispatch', repository, ref, baseSha: before.baseSha,
    headSha: expectedSha, commitCount, mergeCount, scannerVersion: SCANNER_VERSION,
    scope: 'all-candidate-commits-with-first-parent-merge-diffs' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireRange(process.argv.length === 2, 'CI_GITLEAKS_ARGUMENTS_INVALID');
    console.log(JSON.stringify(await runCiGitleaksRange()));
  } catch (error) {
    console.error(error instanceof CiGitleaksRangeError ? error.code : 'CI_GITLEAKS_RANGE_FAILED');
    process.exitCode = error instanceof CiGitleaksRangeError ? error.exitCode : 1;
  }
}

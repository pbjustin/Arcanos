import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { devNull } from 'node:os';

const REPOSITORY = 'pbjustin/Arcanos';
const OWNER = 'pbjustin';
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_AUTHORIZATION_SECONDS = 7200;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const API_TIMEOUT_MS = 15_000;
const GIT_TIMEOUT_MS = 60_000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const STACK = Object.freeze([
  Object.freeze({ prNumber: 1533, headRef: 'codex/gaming-generic-foundation-1532', baseRef: 'main' }),
  Object.freeze({ prNumber: 1534, headRef: 'codex/gaming-claim-corroboration-1532', baseRef: 'codex/gaming-generic-foundation-1532' }),
  Object.freeze({ prNumber: 1535, headRef: 'codex/gaming-generic-benchmark-1532', baseRef: 'codex/gaming-claim-corroboration-1532' }),
]);
export const REVIEWED_STACK_ANCHORS = Object.freeze([
  Object.freeze({ prNumber: 1533, headShas: Object.freeze([
    '11344a08973127fe99b6cf5fb17cd2c6f255b800', 'b235d2095e3c7484d7cc4f212d457120d105a9ea',
  ]) }),
  Object.freeze({ prNumber: 1534, headShas: Object.freeze([
    'c48c7e0093da72edbd388713b7e3a9ea952b1f6e', '15aafe3a47bc5e3011b11f580d21c758bb1b6c1a',
  ]) }),
  Object.freeze({ prNumber: 1535, headShas: Object.freeze([
    '18d1c2a89e92c77acf45c29e9700fcec0701bf07', '0aad0628897621440b59962603eecef3322861a7',
  ]) }),
]);
const FORBIDDEN_PROJECTS = ['7faf44e5-519c-4e73-8d7a-da9f389e6187', '8e4cb1eb-1441-4e83-b434-15c06c676a5f'];
const FORBIDDEN_WORKSPACE = '1c9265a3-986f-4304-ad3e-5a874caab039';
const snapshots = new WeakSet();

export class StackedDraftPreviewContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'StackedDraftPreviewContractError';
    this.code = code;
  }
}

function requireCondition(condition, code) {
  if (!condition) throw new StackedDraftPreviewContractError(code);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (!ownKeys.every(key => typeof key === 'string')) return false;
  const actual = ownKeys.sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => key === actual[index]);
}

function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireSha(value, code = 'STACKED_PREVIEW_SHA_INVALID') {
  requireCondition(typeof value === 'string' && SHA.test(value), code);
  return value;
}

function timeMilliseconds(now) {
  const value = now instanceof Date ? now.getTime() : now;
  requireCondition(Number.isSafeInteger(value) && value >= 0, 'STACKED_PREVIEW_CLOCK_INVALID');
  return value;
}

function expiryMilliseconds(expiresAt) {
  requireCondition(typeof expiresAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(expiresAt), 'STACKED_PREVIEW_EXPIRY_INVALID');
  const value = Date.parse(expiresAt);
  requireCondition(Number.isSafeInteger(value) && new Date(value).toISOString() === expiresAt, 'STACKED_PREVIEW_EXPIRY_INVALID');
  return value;
}

function validatePolicy(policy) {
  requireCondition(exactKeys(policy, ['version', 'enabled', 'repository', 'owner', 'maxAuthorizationSeconds',
    'environmentPrefix', 'imageRepository', 'forbiddenProjectIds', 'stack', 'target'])
    && policy.version === 1 && typeof policy.enabled === 'boolean'
    && policy.repository === REPOSITORY && policy.owner === OWNER
    && policy.environmentPrefix === 'pr-1532aa-'
    && policy.imageRepository === 'ghcr.io/pbjustin/arcanos-stacked-preview'
    && Number.isSafeInteger(policy.maxAuthorizationSeconds)
    && policy.maxAuthorizationSeconds > 0 && policy.maxAuthorizationSeconds <= MAX_AUTHORIZATION_SECONDS
    && Array.isArray(policy.forbiddenProjectIds)
    && policy.forbiddenProjectIds.every(id => typeof id === 'string' && UUID.test(id))
    && FORBIDDEN_PROJECTS.every(id => policy.forbiddenProjectIds.includes(id))
    && Array.isArray(policy.stack) && policy.stack.length === STACK.length
    && policy.stack.every((entry, index) => exactKeys(entry, ['prNumber', 'headRef', 'baseRef'])
      && Object.entries(STACK[index]).every(([key, value]) => entry[key] === value))
    && (policy.target === null || isRecord(policy.target)), 'STACKED_PREVIEW_POLICY_INVALID');
  return policy;
}

function readDefaultPolicy() {
  try {
    const bytes = readFileSync(new URL('../config/railway-stacked-draft-preview.json', import.meta.url));
    requireCondition(bytes.length <= 16_384, 'STACKED_PREVIEW_POLICY_INVALID');
    return freeze(validatePolicy(JSON.parse(bytes.toString('utf8'))));
  } catch (error) {
    if (error instanceof StackedDraftPreviewContractError) throw error;
    throw new StackedDraftPreviewContractError('STACKED_PREVIEW_POLICY_UNAVAILABLE');
  }
}

// A missing or invalid checked-in policy fails closed, including in audit mode.
export const DEFAULT_POLICY = readDefaultPolicy();

export function requireDeploymentActivation(snapshot, { now = Date.now() } = {}) {
  requireCondition(snapshots.has(snapshot), 'STACKED_PREVIEW_AUTHORIZATION_SNAPSHOT_REQUIRED');
  requireCondition(expiryMilliseconds(snapshot.expiresAt) > timeMilliseconds(now), 'STACKED_PREVIEW_AUTHORIZATION_EXPIRED');
  const { policy } = snapshot;
  requireCondition(policy.enabled === true, 'STACKED_PREVIEW_ACTIVATION_BLOCKED');
  const target = policy.target;
  const targetKeys = ['workspaceId', 'projectId', 'baseEnvironmentId', 'workerServiceId',
    'webServiceId', 'region', 'cpuLimit', 'memoryLimitGb', 'imageRepository'];
  const hasRegistryFingerprint = isRecord(target) && Object.hasOwn(target, 'registryPullCredentialSha256');
  if (hasRegistryFingerprint) targetKeys.push('registryPullCredentialSha256');
  requireCondition(exactKeys(target, targetKeys)
    && ['workspaceId', 'projectId', 'baseEnvironmentId', 'workerServiceId', 'webServiceId']
      .every(key => typeof target[key] === 'string' && UUID.test(target[key]))
    && target.workspaceId !== FORBIDDEN_WORKSPACE
    && target.workerServiceId !== target.webServiceId
    && !policy.forbiddenProjectIds.includes(target.projectId)
    && (!hasRegistryFingerprint || (typeof target.registryPullCredentialSha256 === 'string'
      && SHA256.test(target.registryPullCredentialSha256)))
    && typeof target.region === 'string' && /^[a-z][a-z0-9-]{1,62}$/u.test(target.region)
    && typeof target.cpuLimit === 'number' && target.cpuLimit > 0 && target.cpuLimit <= 1
    && typeof target.memoryLimitGb === 'number' && target.memoryLimitGb > 0 && target.memoryLimitGb <= 1
    && target.imageRepository === policy.imageRepository, 'STACKED_PREVIEW_TARGET_BLOCKED');
  return target;
}

export function validateAuthorization({ authorization, policy = DEFAULT_POLICY, actor, repository,
  controllerSha, now = Date.now(), requireActivation = true }) {
  validatePolicy(policy);
  requireCondition(actor === OWNER && repository === REPOSITORY, 'STACKED_PREVIEW_OWNER_AUTHORIZATION_REQUIRED');
  requireSha(controllerSha, 'STACKED_PREVIEW_CONTROLLER_INVALID');
  requireCondition(exactKeys(authorization, ['version', 'controllerSha', 'mainSha', 'expiresAt', 'stack',
    'sourceArchiveSha256']) && authorization.version === 1, 'STACKED_PREVIEW_AUTHORIZATION_INVALID');
  requireSha(authorization.controllerSha, 'STACKED_PREVIEW_CONTROLLER_INVALID');
  requireCondition(authorization.controllerSha === controllerSha, 'STACKED_PREVIEW_CONTROLLER_DRIFT');
  requireSha(authorization.mainSha, 'STACKED_PREVIEW_MAIN_INVALID');
  requireCondition(typeof authorization.sourceArchiveSha256 === 'string'
    && SHA256.test(authorization.sourceArchiveSha256), 'STACKED_PREVIEW_ARCHIVE_DIGEST_INVALID');
  requireCondition(Array.isArray(authorization.stack) && authorization.stack.length === STACK.length
    && authorization.stack.every((entry, index) => exactKeys(entry, ['prNumber', 'headSha', 'treeSha'])
      && entry.prNumber === STACK[index].prNumber && typeof entry.headSha === 'string' && SHA.test(entry.headSha)
      && typeof entry.treeSha === 'string' && SHA.test(entry.treeSha)), 'STACKED_PREVIEW_AUTHORIZED_STACK_INVALID');
  const currentTime = timeMilliseconds(now);
  const expires = expiryMilliseconds(authorization.expiresAt);
  requireCondition(expires > currentTime, 'STACKED_PREVIEW_AUTHORIZATION_EXPIRED');
  requireCondition(expires - currentTime <= policy.maxAuthorizationSeconds * 1000, 'STACKED_PREVIEW_AUTHORIZATION_TTL_EXCEEDED');
  requireCondition(typeof requireActivation === 'boolean', 'STACKED_PREVIEW_ACTIVATION_OPTION_INVALID');
  const snapshot = freeze({ ...clone(authorization), actor, repository,
    authorizedAt: new Date(currentTime).toISOString(), policy: clone(policy) });
  snapshots.add(snapshot);
  if (requireActivation) requireDeploymentActivation(snapshot, { now: currentTime });
  return snapshot;
}

export async function verifyStack({ authorization, pullRequests, mainSha, controllerSha, git, now = Date.now }) {
  const currentTime = () => timeMilliseconds(typeof now === 'function' ? now() : now);
  requireCondition(snapshots.has(authorization), 'STACKED_PREVIEW_AUTHORIZATION_SNAPSHOT_REQUIRED');
  requireCondition(expiryMilliseconds(authorization.expiresAt) > currentTime(), 'STACKED_PREVIEW_AUTHORIZATION_EXPIRED');
  requireSha(controllerSha, 'STACKED_PREVIEW_CONTROLLER_INVALID');
  requireCondition(controllerSha === authorization.controllerSha, 'STACKED_PREVIEW_CONTROLLER_DRIFT');
  requireSha(mainSha, 'STACKED_PREVIEW_MAIN_INVALID');
  requireCondition(mainSha === authorization.mainSha, 'STACKED_PREVIEW_MAIN_DRIFT');
  requireCondition(Array.isArray(pullRequests) && pullRequests.length === STACK.length,
    'STACKED_PREVIEW_PR_SNAPSHOTS_INVALID');
  // Capture only the admission fields before any await; callers cannot change an admitted head mid-verification.
  const observedPullRequests = pullRequests.map(pr => {
    requireCondition(isRecord(pr), 'STACKED_PREVIEW_OPEN_DRAFT_REQUIRED');
    return { number: pr.number, state: pr.state, draft: pr.draft,
      head: { ref: pr.head?.ref, sha: pr.head?.sha, repo: { full_name: pr.head?.repo?.full_name } },
      base: { ref: pr.base?.ref, sha: pr.base?.sha, repo: { full_name: pr.base?.repo?.full_name } } };
  });
  requireCondition(git !== null && typeof git === 'object' && ['treeSha', 'isAncestor', 'archiveSha256']
    .every(name => typeof git[name] === 'function'), 'STACKED_PREVIEW_GIT_ADAPTER_INVALID');
  const observedStack = [];
  let predecessorSha = mainSha;
  for (const [index, expected] of authorization.policy.stack.entries()) {
    const pr = observedPullRequests[index];
    const allowed = authorization.stack[index];
    requireCondition(isRecord(pr) && pr.number === expected.prNumber && pr.state === 'open' && pr.draft === true,
      'STACKED_PREVIEW_OPEN_DRAFT_REQUIRED');
    requireCondition(pr.head?.repo?.full_name === REPOSITORY && pr.base?.repo?.full_name === REPOSITORY,
      'STACKED_PREVIEW_REPOSITORY_DRIFT');
    requireCondition(pr.head?.ref === expected.headRef && pr.base?.ref === expected.baseRef,
      'STACKED_PREVIEW_BRANCH_DRIFT');
    requireSha(pr.head?.sha, 'STACKED_PREVIEW_HEAD_INVALID');
    requireSha(pr.base?.sha, 'STACKED_PREVIEW_BASE_INVALID');
    requireCondition(pr.head.sha === allowed.headSha, 'STACKED_PREVIEW_HEAD_DRIFT');
    requireCondition(pr.base.sha === predecessorSha, 'STACKED_PREVIEW_BASE_DRIFT');
    const treeSha = await git.treeSha(pr.head.sha);
    requireSha(treeSha, 'STACKED_PREVIEW_TREE_INVALID');
    requireCondition(treeSha === allowed.treeSha, 'STACKED_PREVIEW_TREE_DRIFT');
    requireCondition(await git.isAncestor(predecessorSha, pr.head.sha) === true,
      'STACKED_PREVIEW_ANCESTRY_INVALID');
    for (const reviewedSha of REVIEWED_STACK_ANCHORS[index].headShas) {
      requireCondition(await git.isAncestor(reviewedSha, pr.head.sha) === true,
        'STACKED_PREVIEW_REVIEWED_HISTORY_MISSING');
    }
    observedStack.push({ prNumber: expected.prNumber, headSha: pr.head.sha, treeSha,
      headRef: pr.head.ref, baseRef: pr.base.ref, baseSha: pr.base.sha });
    predecessorSha = pr.head.sha;
  }
  // The approved exact trees bind reviewed content; ancestry alone does not prove scope or absence of unrelated changes.
  const actualArchiveSha256 = await git.archiveSha256(predecessorSha);
  requireCondition(typeof actualArchiveSha256 === 'string' && SHA256.test(actualArchiveSha256)
    && actualArchiveSha256 === authorization.sourceArchiveSha256, 'STACKED_PREVIEW_ARCHIVE_DRIFT');
  requireCondition(expiryMilliseconds(authorization.expiresAt) > currentTime(), 'STACKED_PREVIEW_AUTHORIZATION_EXPIRED');
  return freeze({ repository: REPOSITORY, controllerSha, mainSha, candidateSha: predecessorSha,
    treeSha: observedStack.at(-1).treeSha, sourceArchiveSha256: actualArchiveSha256, stack: observedStack });
}

function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new StackedDraftPreviewContractError('STACKED_PREVIEW_GITHUB_READ_FAILED'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function readBoundedJson(response, signal) {
  if (!(response?.ok === true && response.redirected !== true
    && response.body && typeof response.body.getReader === 'function')) {
    if (typeof response?.body?.cancel === 'function') void response.body.cancel().catch(() => {});
    throw new StackedDraftPreviewContractError('STACKED_PREVIEW_GITHUB_READ_FAILED');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      requireCondition(bytes <= MAX_RESPONSE_BYTES, 'STACKED_PREVIEW_GITHUB_RESPONSE_LIMIT');
      chunks.push(Buffer.from(value));
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requireCondition(isRecord(parsed), 'STACKED_PREVIEW_GITHUB_READ_FAILED');
    return parsed;
  } catch (error) {
    if (error instanceof StackedDraftPreviewContractError) throw error;
    throw new StackedDraftPreviewContractError('STACKED_PREVIEW_GITHUB_READ_FAILED');
  } finally {
    // Do not let an uncooperative response body's cancellation hold the deadline open.
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* Cancellation already owns any pending read. */ }
  }
}

// GET-only, fixed-origin and fixed-resource adapter. It never follows a token-bearing redirect or retries a stale read.
export class GitHubReadAdapter {
  #token;
  #fetchImpl;
  #timeoutMs;

  constructor({ token, fetchImpl = globalThis.fetch, timeoutMs = API_TIMEOUT_MS }) {
    requireCondition(typeof token === 'string' && token.length >= 20 && token.trim() === token
      && !/[\r\n]/u.test(token), 'STACKED_PREVIEW_GITHUB_TOKEN_INVALID');
    requireCondition(typeof fetchImpl === 'function', 'STACKED_PREVIEW_FETCH_UNAVAILABLE');
    requireCondition(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= API_TIMEOUT_MS,
      'STACKED_PREVIEW_GITHUB_DEADLINE_INVALID');
    this.#token = token;
    this.#fetchImpl = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  async request(resource) {
    requireCondition(['/branches/main', '/collaborators/pbjustin/permission', ...STACK.map(entry => `/pulls/${entry.prNumber}`)]
      .includes(resource) || (typeof resource === 'string'
        && /^\/commits\/[0-9a-f]{40}\/check-runs\?per_page=100&page=(?:[1-9]|10)&filter=all$/u.test(resource)),
    'STACKED_PREVIEW_GITHUB_RESOURCE_INVALID');
    const signal = AbortSignal.timeout(this.#timeoutMs);
    try {
      const response = await withAbort(this.#fetchImpl(`https://api.github.com/repos/${REPOSITORY}${resource}`, {
        method: 'GET', redirect: 'error', signal,
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${this.#token}`,
          'user-agent': 'arcanos-stacked-draft-preview/1', 'x-github-api-version': '2022-11-28' },
      }), signal);
      return await readBoundedJson(response, signal);
    } catch (error) {
      if (error instanceof StackedDraftPreviewContractError) throw error;
      throw new StackedDraftPreviewContractError('STACKED_PREVIEW_GITHUB_READ_FAILED');
    }
  }

  async readPullRequest(prNumber) {
    requireCondition(STACK.some(entry => entry.prNumber === prNumber), 'STACKED_PREVIEW_PR_NOT_ALLOWLISTED');
    return this.request(`/pulls/${prNumber}`);
  }

  async readMain() {
    const main = await this.request('/branches/main');
    requireCondition(main.name === 'main' && main.protected === true, 'STACKED_PREVIEW_PROTECTED_MAIN_REQUIRED');
    requireSha(main.commit?.sha, 'STACKED_PREVIEW_MAIN_INVALID');
    return freeze({ sha: main.commit.sha, protected: true });
  }

  async readOwnerPermission() {
    const receipt = await this.request('/collaborators/pbjustin/permission');
    requireCondition(receipt.permission === 'admin' && receipt.user?.login === OWNER,
      'STACKED_PREVIEW_OWNER_PERMISSION_REQUIRED');
    return freeze({ actor: OWNER, permission: 'admin' });
  }

  async readRequiredCI(headSha) {
    requireSha(headSha);
    const checks = [];
    const ids = new Set();
    let totalCount;
    for (let page = 1; page <= 10; page += 1) {
      const result = await this.request(`/commits/${headSha}/check-runs?per_page=100&page=${page}&filter=all`);
      requireCondition(Number.isSafeInteger(result.total_count) && result.total_count >= 0 && result.total_count <= 1000
        && Array.isArray(result.check_runs) && result.check_runs.length <= 100,
      'STACKED_PREVIEW_CI_RESPONSE_INVALID');
      totalCount ??= result.total_count;
      requireCondition(totalCount === result.total_count, 'STACKED_PREVIEW_CI_SNAPSHOT_DRIFT');
      for (const check of result.check_runs) {
        requireCondition(isRecord(check) && Number.isSafeInteger(check.id) && check.id > 0 && !ids.has(check.id)
          && typeof check.name === 'string' && check.name.length > 0 && check.name.length <= 255
          && check.head_sha === headSha && Number.isSafeInteger(check.app?.id) && check.app.id > 0,
        'STACKED_PREVIEW_CI_RESPONSE_INVALID');
        ids.add(check.id);
        checks.push(check);
      }
      if (result.check_runs.length < 100 || checks.length === totalCount) break;
      requireCondition(page < 10, 'STACKED_PREVIEW_CI_PAGINATION_LIMIT');
    }
    requireCondition(checks.length === totalCount, 'STACKED_PREVIEW_CI_SNAPSHOT_INCOMPLETE');
    const latest = new Map();
    for (const check of checks) {
      const key = `${check.app.id}:${check.name}`;
      if (!latest.has(key) || latest.get(key).id < check.id) latest.set(key, check);
    }
    const current = [...latest.values()];
    requireCondition(current.every(check => check.status === 'completed'), 'STACKED_PREVIEW_CI_NOT_COMPLETE');
    requireCondition(current.every(check => ['success', 'skipped'].includes(check.conclusion)), 'STACKED_PREVIEW_CI_NOT_GREEN');
    const aggregate = current.find(check => check.name === 'All Checks Complete'
      && check.app.id === 15368 && check.app.slug === 'github-actions' && check.app.owner?.login === 'github');
    requireCondition(aggregate?.status === 'completed' && aggregate.conclusion === 'success'
      && typeof aggregate.details_url === 'string'
      && /^https:\/\/github\.com\/pbjustin\/Arcanos\/actions\/runs\/[1-9][0-9]*\/job\/[1-9][0-9]*$/u.test(aggregate.details_url),
    'STACKED_PREVIEW_REQUIRED_CI_NOT_VERIFIED');
    return freeze({ headSha, aggregate: { id: aggregate.id, name: aggregate.name, status: aggregate.status,
      conclusion: aggregate.conclusion, jobUrl: aggregate.details_url },
    checks: current.map(check => ({ id: check.id, name: check.name, appId: check.app.id,
      status: check.status, conclusion: check.conclusion })) });
  }

  async readStack() {
    const [main, ...pullRequests] = await Promise.all([this.readMain(),
      ...STACK.map(entry => this.readPullRequest(entry.prNumber))]);
    return freeze({ mainSha: main.sha, mainProtected: true, pullRequests });
  }
}

function gitEnvironment() {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...environment, GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' };
}

// Only built-in object reads run. No shell, hooks, checkout, fetch, package install, PR program or customizable runner.
export class GitReadAdapter {
  constructor({ cwd }) {
    requireCondition(typeof cwd === 'string' && isAbsolute(cwd), 'STACKED_PREVIEW_GIT_DIRECTORY_INVALID');
    this.cwd = cwd;
  }

  async #readObject(args, allowNotAncestor = false) {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd: this.cwd, env: gitEnvironment(), shell: false,
        timeout: GIT_TIMEOUT_MS, maxBuffer: 65_536, encoding: 'utf8' }, (error, stdout) => {
        if (allowNotAncestor && error?.code === 1) return resolve(false);
        if (error) return reject(new StackedDraftPreviewContractError('STACKED_PREVIEW_GIT_READ_FAILED'));
        resolve(stdout.trim());
      });
    });
  }

  async treeSha(headSha) {
    requireSha(headSha);
    await this.#readObject(['rev-parse', '--verify', `${headSha}^{commit}`]);
    return requireSha(await this.#readObject(['rev-parse', '--verify', `${headSha}^{tree}`]), 'STACKED_PREVIEW_TREE_INVALID');
  }

  async isAncestor(baseSha, headSha) {
    requireSha(baseSha);
    requireSha(headSha);
    const result = await this.#readObject(['merge-base', '--is-ancestor', baseSha, headSha], true);
    return result === '';
  }

  async archiveSha256(headSha) {
    requireSha(headSha);
    await this.#readObject(['rev-parse', '--verify', `${headSha}^{commit}`]);
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      let bytes = 0;
      let failure = null;
      const child = spawn('git', ['archive', '--format=tar', headSha], {
        cwd: this.cwd, env: gitEnvironment(), shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stop = code => {
        failure ??= new StackedDraftPreviewContractError(code);
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => stop('STACKED_PREVIEW_GIT_READ_FAILED'), GIT_TIMEOUT_MS);
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_ARCHIVE_BYTES) stop('STACKED_PREVIEW_ARCHIVE_LIMIT');
        else hash.update(chunk);
      });
      child.stderr.resume();
      child.on('error', () => stop('STACKED_PREVIEW_GIT_READ_FAILED'));
      child.on('close', code => {
        clearTimeout(timer);
        if (failure || code !== 0) reject(failure ?? new StackedDraftPreviewContractError('STACKED_PREVIEW_GIT_READ_FAILED'));
        else resolve(hash.digest('hex'));
      });
    });
  }
}

#!/usr/bin/env node
// Trusted-main controller. Candidate code is never imported or executed here.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSandbox } from './gaming-exact-commit-sandbox.mjs';

export const REPOSITORY = 'pbjustin/Arcanos';
export const WORKFLOW = 'gaming-exact-commit-verification.yml';
export const SHA = /^(?!0{40}$)[0-9a-f]{40}$/u;
export const TARGETS = Object.freeze({
  dc7e7fdd34fd3563653ecb224102c73c1696239e: Object.freeze({ prNumber: 1534,
    branch: 'codex/gaming-claim-corroboration-1532', base: 'codex/gaming-generic-foundation-1532' }),
  '0a6f0d4545a6c9e26fff81f9275d1fc2457bb470': Object.freeze({ prNumber: 1535,
    branch: 'codex/gaming-generic-benchmark-1532', base: 'codex/gaming-claim-corroboration-1532' }),
});
export const MANIFESTS = Object.freeze(['package.json', 'package-lock.json',
  'packages/protocol/package.json', 'packages/cli/package.json',
  'packages/arcanos-runtime/package.json', 'packages/arcanos-openai/package.json',
  'workers/package.json', 'arcanos-ai-runtime/package.json', 'vendor/minimatch-9.0.7/package.json']);
export const NODE_IMAGE = 'node:24.18.1-bookworm@sha256:87362b5d965240a1bc79f85cec63179d4ee853741413b274a4721f2742eb8393';

export function requireSafe(condition, code) {
  if (!condition) throw new Error(code);
}
export function validateDispatch(event, environment) {
  requireSafe(environment.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && environment.GITHUB_REPOSITORY === REPOSITORY
    && environment.GITHUB_REF === 'refs/heads/main'
    && environment.GITHUB_WORKFLOW_REF === `${REPOSITORY}/.github/workflows/${WORKFLOW}@refs/heads/main`
    && environment.GITHUB_RUN_ATTEMPT === '1', 'GAMING_CI_DISPATCH_CONTEXT_INVALID');
  requireSafe(environment.GITHUB_ACTOR === 'pbjustin' && environment.GITHUB_TRIGGERING_ACTOR === 'pbjustin'
    && event.sender?.login === 'pbjustin' && event.sender?.id === 220257666,
  'GAMING_CI_OWNER_REQUIRED');
  requireSafe(event.repository?.full_name === REPOSITORY && event.repository?.id === 1017714023
    && event.repository?.default_branch === 'main', 'GAMING_CI_REPOSITORY_INVALID');
  requireSafe(SHA.test(environment.GITHUB_SHA ?? '')
    && environment.CONTROLLER_SHA === environment.GITHUB_SHA, 'GAMING_CI_CONTROLLER_INVALID');
  requireSafe(event.inputs && Object.keys(event.inputs).sort().join(',') === 'mocked,source_sha',
    'GAMING_CI_INPUTS_INVALID');
  requireSafe(event.inputs.mocked === true || event.inputs.mocked === 'true', 'GAMING_CI_MOCK_REQUIRED');
  requireSafe(typeof event.inputs.source_sha === 'string' && SHA.test(event.inputs.source_sha),
    'GAMING_CI_SOURCE_SHA_INVALID');
  const target = TARGETS[event.inputs.source_sha];
  requireSafe(target, 'GAMING_CI_SOURCE_NOT_AUTHORIZED');
  return { sourceSha: event.inputs.source_sha, controllerSha: environment.GITHUB_SHA, ...target };
}

// This environment is for trusted Git/npm clients only; no ambient credentials/configuration.
export function clientEnvironment(environment = process.env, home = '/tmp') {
  return { PATH: environment.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', CI: 'true',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
}
// Transport/CA settings belong only to the trusted, script-disabled registry client.
// The offline candidate receives none of these settings or ambient credentials.
export function dependencyClientEnvironment(environment, home) {
  return { ...clientEnvironment(environment, home), ...Object.fromEntries(
    ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
      'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'].filter(key => typeof environment[key] === 'string')
      .map(key => [key, environment[key]])) };
}
function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: clientEnvironment(), encoding: 'utf8',
    timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }).trim();
}
export function assertCheckout(expectedSha, expectedTree, observedSha, observedTree) {
  requireSafe(SHA.test(expectedSha ?? '') && SHA.test(expectedTree ?? '')
    && observedSha === expectedSha && observedTree === expectedTree, 'GAMING_CI_CHECKOUT_MISMATCH');
}
export function validateTreeEntries(entries) {
  for (const entry of entries.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob [0-9a-f]{40}\t(.+)$/u.exec(entry);
    requireSafe(match && !/[\x00-\x1f\x7f\\]/u.test(match[2])
      && !path.isAbsolute(match[2]) && !match[2].split('/').some(part => ['..', '.', '.git', 'node_modules'].includes(part)),
    'GAMING_CI_TREE_ENTRY_UNSAFE');
  }
}
export function assertManifests(controller, candidate) {
  for (const relative of MANIFESTS) {
    requireSafe(readFileSync(path.join(controller, relative)).equals(readFileSync(path.join(candidate, relative))),
      'GAMING_CI_DEPENDENCY_MANIFEST_DRIFT');
  }
}
async function api(fetchImpl, pathname, token) {
  const url = `https://api.github.com/repos/${REPOSITORY}${pathname}`;
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'arcanos-gaming-exact-commit' } });
  requireSafe(response.status === 200 && !response.redirected && response.url === url,
    'GAMING_CI_REPOSITORY_READ_FAILED');
  const body = await response.text();
  requireSafe(Buffer.byteLength(body) <= 512 * 1024, 'GAMING_CI_REPOSITORY_READ_TOO_LARGE');
  return JSON.parse(body);
}
export async function admit({ event, environment, fetchImpl = globalThis.fetch }) {
  const target = validateDispatch(event, environment);
  const token = environment.GITHUB_TOKEN;
  requireSafe(typeof token === 'string' && token.length > 0 && !/[\r\n]/u.test(token), 'GAMING_CI_READ_TOKEN_REQUIRED');
  const main = await api(fetchImpl, '/branches/main', token);
  requireSafe(main.name === 'main' && main.protected === true && main.commit?.sha === target.controllerSha,
    'GAMING_CI_PROTECTED_CONTROLLER_DRIFT');
  const pr = await api(fetchImpl, `/pulls/${target.prNumber}`, token);
  requireSafe(pr.number === target.prNumber && pr.state === 'open' && pr.draft === true
    && pr.merged === false && pr.merged_at === null
    && pr.head?.sha === target.sourceSha && pr.head?.ref === target.branch
    && pr.head?.repo?.full_name === REPOSITORY && pr.head?.repo?.id === 1017714023
    && pr.base?.ref === target.base && pr.base?.repo?.full_name === REPOSITORY,
  'GAMING_CI_DRAFT_HEAD_DRIFT');
  const commit = await api(fetchImpl, `/git/commits/${target.sourceSha}`, token);
  requireSafe(commit.sha === target.sourceSha && SHA.test(commit.tree?.sha ?? ''), 'GAMING_CI_COMMIT_NOT_VERIFIED');
  return { version: 1, repository: REPOSITORY, workflow: WORKFLOW, ...target,
    sourceTree: commit.tree.sha, mocked: true, hosted: false, deployment: false,
    actor: 'pbjustin', runId: environment.GITHUB_RUN_ID, runAttempt: 1 };
}

function readReceipt(directory) {
  const receipt = JSON.parse(readFileSync(path.join(directory, 'admission.json'), 'utf8'));
  requireSafe(TARGETS[receipt.sourceSha]?.prNumber === receipt.prNumber && SHA.test(receipt.sourceTree)
    && receipt.mocked === true && receipt.hosted === false && receipt.deployment === false,
  'GAMING_CI_ADMISSION_RECEIPT_INVALID');
  return receipt;
}
function assertSource(controller, candidate, receipt) {
  requireSafe(git(controller, ['rev-parse', 'HEAD']) === receipt.controllerSha, 'GAMING_CI_CONTROLLER_CHECKOUT_MISMATCH');
  assertCheckout(receipt.sourceSha, receipt.sourceTree,
    git(candidate, ['rev-parse', 'HEAD']), git(candidate, ['rev-parse', 'HEAD^{tree}']));
  validateTreeEntries(execFileSync('git', ['ls-tree', '-r', '-z', receipt.sourceSha],
    { cwd: candidate, env: clientEnvironment(), encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }));
  requireSafe(git(candidate, ['status', '--porcelain=v1']) === '', 'GAMING_CI_SOURCE_WORKTREE_DIRTY');
  assertManifests(controller, candidate);
}
function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

// No candidate npm configuration, lifecycle hook or source enters networked preparation.
export function prepareDependencies(controller, destination, environment = process.env) {
  requireSafe(!existsSync(destination), 'GAMING_CI_DEPENDENCY_DIRECTORY_EXISTS');
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const relative of MANIFESTS) {
    mkdirSync(path.dirname(path.join(destination, relative)), { recursive: true });
    cpSync(path.join(controller, relative), path.join(destination, relative));
  }
  cpSync(path.join(controller, 'vendor/minimatch-9.0.7'), path.join(destination, 'vendor/minimatch-9.0.7'),
    { recursive: true, filter: source => !source.split(path.sep).some(part => ['node_modules', '.git'].includes(part)) });
  const home = path.join(destination, '.empty-home');
  mkdirSync(home, { mode: 0o700 });
  const userConfig = path.join(home, 'user.npmrc');
  const globalConfig = path.join(home, 'global.npmrc');
  writeFileSync(userConfig, ''); writeFileSync(globalConfig, '');
  const result = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org', `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`],
  { cwd: destination, env: dependencyClientEnvironment(environment, home), encoding: 'utf8', timeout: 600_000,
    maxBuffer: 8 * 1024 * 1024, shell: false });
  // Never stream package output as GitHub workflow commands or retain credentials.
  writeFileSync(path.join(destination, 'dependency-install.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  requireSafe(result.status === 0 && !result.error, 'GAMING_CI_DEPENDENCY_PREPARATION_FAILED');
}

export async function main(mode, environment = process.env) {
  requireSafe(['admit', 'assert-source', 'prepare', 'run', 'finalize'].includes(mode), 'GAMING_CI_COMMAND_INVALID');
  const controller = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = path.join(environment.RUNNER_TEMP, 'gaming-exact-commit');
  if (mode === 'admit') {
    const event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, 'utf8'));
    const receipt = await admit({ event, environment });
    requireSafe(git(controller, ['rev-parse', 'HEAD']) === receipt.controllerSha, 'GAMING_CI_CONTROLLER_CHECKOUT_MISMATCH');
    requireSafe(!existsSync(directory), 'GAMING_CI_RECEIPT_DIRECTORY_EXISTS');
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(path.join(directory, 'admission.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    const outputs = `source_sha=${receipt.sourceSha}\nsource_tree=${receipt.sourceTree}\npr_number=${receipt.prNumber}\n`;
    writeFileSync(environment.GITHUB_OUTPUT, outputs, { flag: 'a' });
    console.log(`GAMING_CI_ADMITTED source=${receipt.sourceSha} tree=${receipt.sourceTree} controller=${receipt.controllerSha}`);
    return;
  }
  const receipt = readReceipt(directory);
  const candidate = path.join(environment.GITHUB_WORKSPACE, 'candidate');
  assertSource(controller, candidate, receipt);
  if (mode === 'finalize') {
    const event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, 'utf8'));
    const current = await admit({ event, environment });
    requireSafe(current.sourceSha === receipt.sourceSha && current.sourceTree === receipt.sourceTree
      && current.controllerSha === receipt.controllerSha, 'GAMING_CI_FINAL_SOURCE_DRIFT');
    requireSafe(['success', 'failure', 'cancelled', 'skipped'].includes(environment.CANDIDATE_RESULT),
      'GAMING_CI_FINAL_RESULT_INVALID');
    writeFileSync(path.join(directory, 'finalization.json'), `${JSON.stringify({ ...current,
      candidateResult: environment.CANDIDATE_RESULT, draft: true, merged: false,
      exactSourcePreserved: true }, null, 2)}\n`);
    return;
  }
  if (mode === 'assert-source') {
    writeFileSync(path.join(directory, 'checkout.json'), `${JSON.stringify({ ...receipt, actualCheckoutSha: receipt.sourceSha,
      actualTreeSha: receipt.sourceTree, candidateCodeExecuted: false }, null, 2)}\n`);
    console.log(`GAMING_CI_EXACT_CHECKOUT source=${receipt.sourceSha} tree=${receipt.sourceTree}`);
    return;
  }
  if (mode === 'prepare') {
    const sourceArchive = path.join(directory, 'source.tar');
    const archive = execFileSync('git', ['archive', '--format=tar', receipt.sourceSha],
      { cwd: candidate, env: clientEnvironment(), timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(sourceArchive, archive, { mode: 0o644 });
    const dependencies = path.join(directory, 'dependencies');
    prepareDependencies(controller, dependencies, environment);
    const dependencyArchive = path.join(directory, 'dependencies.tar');
    const members = ['node_modules', ...MANIFESTS.filter(p => p.endsWith('/package.json'))
      .map(p => `${path.dirname(p)}/node_modules`)].filter(p => existsSync(path.join(dependencies, p)));
    execFileSync('tar', ['-cf', dependencyArchive, '-C', dependencies, ...members],
      { env: clientEnvironment(), timeout: 30_000 });
    chmodSync(dependencyArchive, 0o644);
    writeFileSync(path.join(directory, 'preparation.json'), `${JSON.stringify({ ...receipt,
      sourceArchiveSha256: sha256(sourceArchive), dependencyArchiveSha256: sha256(dependencyArchive),
      dependencyManifests: MANIFESTS, lifecycleScriptsDuringAcquisition: false,
      ambientCredentialsInherited: false }, null, 2)}\n`);
    return;
  }
  const imageId = environment.GAMING_CI_IMAGE_ID;
  requireSafe(/^sha256:[0-9a-f]{64}$/u.test(imageId ?? ''), 'GAMING_CI_IMAGE_ID_INVALID');
  const prepared = JSON.parse(readFileSync(path.join(directory, 'preparation.json'), 'utf8'));
  requireSafe(sha256(path.join(directory, 'source.tar')) === prepared.sourceArchiveSha256
    && sha256(path.join(directory, 'dependencies.tar')) === prepared.dependencyArchiveSha256,
  'GAMING_CI_ARCHIVE_DRIFT');
  await runSandbox({ imageId, sourceArchive: path.join(directory, 'source.tar'),
    dependenciesArchive: path.join(directory, 'dependencies.tar'), controllerRoot: controller,
    receiptDirectory: directory, sourceSha: receipt.sourceSha, sourceTree: receipt.sourceTree,
    prNumber: receipt.prNumber });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  requireSafe(process.argv.length === 3, 'GAMING_CI_ARGUMENTS_INVALID');
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}

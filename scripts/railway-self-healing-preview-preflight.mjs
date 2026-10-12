/** Owner-run metadata preflight only: no provisioning, probes or PR execution. */
import { execFileSync } from 'node:child_process';
import { constants, lstatSync, openSync, closeSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RailwayGraphqlApi, GitHubApi, validateLifecyclePullRequest } from './railway-pr-preview-lifecycle.mjs';
import { SELF_HEALING_PREVIEW_PROFILE as PROFILE, planSelfHealingPreview } from './railway-self-healing-preview-profile.mjs';

const WORKFLOW_REF = 'pbjustin/Arcanos/.github/workflows/railway-self-healing-preview-preflight.yml@refs/heads/main';
const OUTPUT_NAME = 'railway-self-healing-preview-preflight.json';
const SHA = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const FLAGS = Object.freeze({ liveAcceptance: 'BLOCKED', deploymentPerformed: false,
  provisioningImplemented: false, runtimeSupervisorImplemented: false, ownerInstallationPerformed: false,
  provisioningExecutionPerformed: false, previewIsolationVerified: false, selfHealingRuntimeAcceptanceSupported: false,
  ownerMainInstallation: 'BLOCKED', productionAutoDeployExclusionVerified: false });
const CODES = new Set(['SELF_HEALING_PREVIEW_PREFLIGHT_INPUT_INVALID',
  'SELF_HEALING_PREVIEW_PREFLIGHT_PROVENANCE_INVALID', 'SELF_HEALING_PREVIEW_PREFLIGHT_CHECKOUT_INVALID',
  'SELF_HEALING_PREVIEW_PREFLIGHT_INVENTORY_INVALID', 'SELF_HEALING_PREVIEW_PREFLIGHT_TIMEOUT',
  'SELF_HEALING_PREVIEW_PREFLIGHT_OUTPUT_INVALID', 'SELF_HEALING_PREVIEW_PR_HEAD_MISMATCH',
  'SELF_HEALING_PREVIEW_ALREADY_EXISTS', 'SELF_HEALING_PREVIEW_INVENTORY_STALE']);
class PreflightError extends Error { constructor(code) { super(code); this.code = code; } }
function requireCondition(condition, code) { if (!condition) throw new PreflightError(code); }

export function validatePreflightInput(env) {
  requireCondition(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && env.GITHUB_REPOSITORY === PROFILE.repository && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_WORKFLOW_REF === WORKFLOW_REF && env.GITHUB_ACTOR === 'pbjustin'
    && env.GITHUB_TRIGGERING_ACTOR === 'pbjustin' && env.GITHUB_RUN_ATTEMPT === '1'
    && /^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID ?? '') && SHA.test(env.GITHUB_WORKFLOW_SHA ?? '')
    && typeof env.GITHUB_WORKSPACE === 'string' && path.isAbsolute(env.GITHUB_WORKSPACE),
  'SELF_HEALING_PREVIEW_PREFLIGHT_PROVENANCE_INVALID');
  requireCondition(/^[1-9][0-9]{0,8}$/u.test(env.PR_NUMBER ?? '') && SHA.test(env.EXPECTED_SHA ?? ''),
    'SELF_HEALING_PREVIEW_PREFLIGHT_INPUT_INVALID');
  return { repository: PROFILE.repository, prNumber: Number(env.PR_NUMBER), sourceCommit: env.EXPECTED_SHA,
    controllerCommit: env.GITHUB_WORKFLOW_SHA, workflowRef: WORKFLOW_REF, runId: env.GITHUB_RUN_ID };
}

/** Git reads receive no API credentials and never check out a candidate ref. */
export function readTrustedCheckout(env, readGit = execFileSync) {
  const options = { cwd: env.GITHUB_WORKSPACE, encoding: 'utf8', timeout: 10_000,
    maxBuffer: 1_048_576, env: { PATH: env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } };
  return { sha: readGit('git', ['rev-parse', 'HEAD'], options).trim(),
    clean: readGit('git', ['status', '--porcelain=v1', '--untracked-files=all'], options).trim() === '' };
}

export const METADATA_QUERIES = Object.freeze(Object.fromEntries(['services', 'volumes'].map(kind => [kind,
  `query SelfHealingPreview${kind}($projectId: String!, $after: String) {
    project(id: $projectId) { id ${kind}(first: 100, after: $after) {
      edges { node { id projectId } } pageInfo { hasNextPage endCursor }
    } }
  }`] )));

/** Read global project IDs, including unattached volumes, with fail-closed pagination. */
export async function readProjectIdentifiers(railway, kind, checkDeadline = () => {}) {
  requireCondition(Object.hasOwn(METADATA_QUERIES, kind), 'SELF_HEALING_PREVIEW_PREFLIGHT_INVENTORY_INVALID');
  const ids = new Set(), cursors = new Set();
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    checkDeadline();
    const result = await railway.graphql(METADATA_QUERIES[kind], { projectId: PROFILE.projectId, after });
    checkDeadline();
    const connection = result?.project?.[kind];
    requireCondition(result?.project?.id === PROFILE.projectId && Array.isArray(connection?.edges)
      && connection.edges.length <= 100 && typeof connection.pageInfo?.hasNextPage === 'boolean',
    'SELF_HEALING_PREVIEW_PREFLIGHT_INVENTORY_INVALID');
    for (const edge of connection.edges) {
      requireCondition(UUID.test(edge?.node?.id ?? '') && edge.node.projectId === PROFILE.projectId
        && !ids.has(edge.node.id), 'SELF_HEALING_PREVIEW_PREFLIGHT_INVENTORY_INVALID');
      ids.add(edge.node.id);
    }
    if (!connection.pageInfo.hasNextPage) return [...ids];
    const cursor = connection.pageInfo.endCursor;
    requireCondition(connection.edges.length > 0 && typeof cursor === 'string' && cursor.length > 0
      && cursor.length <= 1_024 && !cursors.has(cursor), 'SELF_HEALING_PREVIEW_PREFLIGHT_INVENTORY_INVALID');
    cursors.add(cursor); after = cursor;
  }
  throw new PreflightError('SELF_HEALING_PREVIEW_PREFLIGHT_INVENTORY_INVALID');
}

/** Injected dependencies support offline checks without any mutation capability. */
export async function runSelfHealingPreviewPreflight(env, dependencies = {}) {
  let identity = null;
  const report = { schemaVersion: 1, kind: 'railway-self-healing-preview-preflight', status: 'BLOCKED',
    ...FLAGS, identity, plan: null, code: 'SELF_HEALING_PREVIEW_PREFLIGHT_READ_FAILED' };
  try {
    identity = validatePreflightInput(env);
    validatePreflightOutputPath(env);
    const checkout = (dependencies.readCheckout ?? readTrustedCheckout)(env);
    requireCondition(checkout.sha === identity.controllerCommit && checkout.clean === true,
      'SELF_HEALING_PREVIEW_PREFLIGHT_CHECKOUT_INVALID');
    report.identity = identity;
    const now = dependencies.now ?? (() => new Date().toISOString());
    const startedAt = Date.parse(now());
    const checkDeadline = () => requireCondition(Date.parse(now()) - startedAt <= 55_000,
      'SELF_HEALING_PREVIEW_PREFLIGHT_TIMEOUT');
    const github = dependencies.github ?? new GitHubApi({ token: env.GITHUB_TOKEN });
    const railway = dependencies.railway ?? new RailwayGraphqlApi({ token: env.RAILWAY_API_TOKEN });
    const initial = await github.readPullRequest(identity.prNumber);
    const requireExactPull = pull => {
      const parsed = validateLifecyclePullRequest(pull, identity.prNumber);
      requireCondition(parsed.state === 'open' && !parsed.draft && parsed.baseRef === 'main'
        && parsed.headSha === identity.sourceCommit && SHA.test(pull.base.sha ?? ''),
      'SELF_HEALING_PREVIEW_PR_HEAD_MISMATCH');
      return parsed;
    };
    requireExactPull(initial); report.identity.baseCommit = initial.base.sha; checkDeadline();
    await railway.validateAuthority({ requireNativeDisabled: false }); checkDeadline();
    const observedAt = now();
    const environments = await railway.listEnvironments(); checkDeadline();
    const serviceIds = await readProjectIdentifiers(railway, 'services', checkDeadline);
    const volumeIds = await readProjectIdentifiers(railway, 'volumes', checkDeadline);
    const current = await github.readPullRequest(identity.prNumber); checkDeadline();
    requireExactPull(current);
    requireCondition(current.head.ref === initial.head.ref && current.base.sha === initial.base.sha,
      'SELF_HEALING_PREVIEW_PR_HEAD_MISMATCH');
    report.plan = planSelfHealingPreview({ pullRequest: current, prNumber: identity.prNumber,
      expectedHeadSha: identity.sourceCommit, now: now(), inventory: {
        projectId: PROFILE.projectId, workspaceId: PROFILE.workspaceId, complete: true, observedAt,
        environments: environments.map(({ id, name }) => ({ id, name })), serviceIds, volumeIds } });
    report.code = 'SELF_HEALING_PREVIEW_PREFLIGHT_PLAN_ONLY';
  } catch (error) {
    report.plan = null;
    report.code = CODES.has(error?.code) ? error.code : 'SELF_HEALING_PREVIEW_PREFLIGHT_READ_FAILED';
  }
  return report;
}

/** Only one new direct 0600 file under the real runner temp directory is admitted. */
export function validatePreflightOutputPath(env) {
  const directory = env.RUNNER_TEMP;
  requireCondition(typeof directory === 'string' && path.isAbsolute(directory)
    && !lstatSync(directory).isSymbolicLink() && lstatSync(directory).isDirectory()
    && realpathSync(directory) === path.resolve(directory), 'SELF_HEALING_PREVIEW_PREFLIGHT_OUTPUT_INVALID');
  const output = path.join(directory, OUTPUT_NAME);
  requireCondition(env.PREFLIGHT_OUTPUT_PATH === output, 'SELF_HEALING_PREVIEW_PREFLIGHT_OUTPUT_INVALID');
  try { lstatSync(output); throw new PreflightError('SELF_HEALING_PREVIEW_PREFLIGHT_OUTPUT_INVALID'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return output;
}

export function writePreflightReport(env, report) {
  const output = validatePreflightOutputPath(env);
  const fd = openSync(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(report)}\n`, 'utf8'); } finally { closeSync(fd); }
}

function markRetainedArtifact(env) {
  if (env.GITHUB_OUTPUT === undefined) return;
  const output = env.GITHUB_OUTPUT, relative = path.relative(env.RUNNER_TEMP, output);
  requireCondition(path.isAbsolute(output) && relative.length > 0 && !relative.startsWith('..')
    && !path.isAbsolute(relative) && realpathSync(output) === path.resolve(output)
    && lstatSync(output).isFile() && !lstatSync(output).isSymbolicLink(),
  'SELF_HEALING_PREVIEW_PREFLIGHT_OUTPUT_INVALID');
  const fd = openSync(output, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW);
  try { writeFileSync(fd, 'artifact_ready=true\n', 'utf8'); } finally { closeSync(fd); }
}

async function runCli() {
  const report = process.argv.length === 2 ? await runSelfHealingPreviewPreflight(process.env)
    : { schemaVersion: 1, kind: 'railway-self-healing-preview-preflight', status: 'BLOCKED', ...FLAGS,
      identity: null, plan: null, code: 'SELF_HEALING_PREVIEW_PREFLIGHT_INPUT_INVALID' };
  try { writePreflightReport(process.env, report); markRetainedArtifact(process.env); }
  catch { report.plan = null; report.code = 'SELF_HEALING_PREVIEW_PREFLIGHT_OUTPUT_INVALID'; }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.code !== 'SELF_HEALING_PREVIEW_PREFLIGHT_PLAN_ONLY') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runCli();

import { createHash, randomBytes } from 'node:crypto';
import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, fstatSync, readFileSync,
  writeFileSync, fsyncSync, realpathSync, renameSync, readSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeLivePreviewEvidence, verifyLivePreviewEvidence } from './live-pr-preview-verifier.mjs';
import { validateLiveValidationTarget, assertLiveValidationInventory,
  LIVE_VALIDATION_HARD_LIMITS } from './live-validation-target.mjs';
import { canonicalLiveValidationJson } from './live-validation-bootstrap.mjs';
import { execFileSync } from 'node:child_process';

export const liveValidationTargetSha256 = target => canonicalHash(validateLiveValidationTarget(target));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROFILE_IDS = ['gaming-guide-positive', 'gaming-guide-negative'];
const MODEL_STAGES = ['intake', 'reasoning', 'final'];
export const LIVE_VALIDATION_OPERATOR_GATE_IDS = Object.freeze(['type-check', 'lint', 'build', 'railway', 'workflow',
  'secret-scan', 'service-auth', 'egress', 'exact-sha', 'gaming']);
const SUMMARY_VERSION = 'arcanos-live-validation-evidence/v1';
const STATE_VERSION = 'arcanos-live-validation-controller-state/v1';
const MAX_JSON = 2 * 1024 * 1024;
export const LIVE_VALIDATION_ACCEPTANCE_TRANSPORT_TIMEOUT_MS = 315_000;
const CONTROL_TIMEOUT_MS = 60_000;
const CLEANUP_CONFIRMATION_TIMEOUT_MS = 60_000;
const digest = value => createHash('sha256').update(value).digest('hex');
const canonicalHash = value => digest(canonicalLiveValidationJson(value));
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;

export class LiveValidationControllerError extends Error {
  constructor(code) { super(code); this.name = 'LiveValidationControllerError'; this.code = code; }
}
function requireController(condition, code) { if (!condition) throw new LiveValidationControllerError(code); }
function safeCode(error) {
  return /^LIVE_(?:VALIDATION|PREVIEW)_[A-Z0-9_]{1,100}$/u.test(error?.code ?? '')
    ? error.code : 'LIVE_VALIDATION_CONTROLLER_BLOCKED';
}
function publicEvidenceContainsSession(value, secrets) {
  if (typeof value === 'string') return secrets.some(secret => value.toLowerCase().includes(secret.toLowerCase()));
  if (Array.isArray(value)) return value.some(item => publicEvidenceContainsSession(item, secrets));
  if (record(value)) return Object.values(value).some(item => publicEvidenceContainsSession(item, secrets));
  return false;
}
function json(text, code) { try { return JSON.parse(text); } catch { throw new LiveValidationControllerError(code); } }

export function parseLiveValidationControllerArguments(argv) {
  const args = { command: argv[0] === 'cleanup' ? 'cleanup' : 'run', execute: false, allowPaidProvider: false, operatorBootstrap: false,
    profile: 'gaming-guide', limits: { ...LIVE_VALIDATION_HARD_LIMITS } };
  const fields = { '--target-file': 'targetFile', '--artifact-attestation-file': 'artifactFile', '--pr-number': 'prNumber',
    '--commit-sha': 'commitSha', '--profile': 'profile', '--evidence-dir': 'evidenceDirectory' };
  const caps = { '--max-spend-micro-usd': 'maxSpendMicroUsd', '--max-provider-requests': 'maxRequests',
    '--max-workflows': 'maxWorkflows', '--duration-ms': 'durationMs' };
  const seen = new Set();
  for (let i = args.command === 'cleanup' ? 1 : 0; i < argv.length; i++) {
    const flag = argv[i];
    requireController(!seen.has(flag), 'LIVE_VALIDATION_ARGUMENT_INVALID'); seen.add(flag);
    if (flag === '--execute') args.execute = true;
    else if (flag === '--allow-paid-provider') args.allowPaidProvider = true;
    else if (flag === '--operator-bootstrap') args.operatorBootstrap = true;
    else {
      requireController(Object.hasOwn(fields, flag) || Object.hasOwn(caps, flag), 'LIVE_VALIDATION_ARGUMENT_INVALID');
      const value = argv[++i]; requireController(typeof value === 'string' && !value.startsWith('--'), 'LIVE_VALIDATION_ARGUMENT_INVALID');
      if (Object.hasOwn(caps, flag)) {
        requireController(/^[1-9][0-9]*$/u.test(value), 'LIVE_VALIDATION_ARGUMENT_INVALID'); args.limits[caps[flag]] = Number(value);
      } else args[fields[flag]] = value;
    }
  }
  requireController((args.prNumber !== undefined || args.commitSha !== undefined)
    && (args.prNumber === undefined || /^[1-9][0-9]*$/u.test(args.prNumber) && integer(Number(args.prNumber), 1))
    && (args.commitSha === undefined || SHA.test(args.commitSha) && args.commitSha !== '0'.repeat(40)) && args.profile === 'gaming-guide'
    && path.isAbsolute(args.targetFile ?? '') && path.isAbsolute(args.evidenceDirectory ?? ''), 'LIVE_VALIDATION_ARGUMENT_INVALID');
  if (args.prNumber !== undefined) args.prNumber = Number(args.prNumber);
  for (const [key, cap] of Object.entries(LIVE_VALIDATION_HARD_LIMITS)) {
    requireController(integer(args.limits[key], 1, cap), 'LIVE_VALIDATION_LIMIT_INVALID');
  }
  requireController(args.execute === args.allowPaidProvider && (args.command !== 'cleanup' || !args.execute),
    'LIVE_VALIDATION_PAID_AUTHORIZATION_REQUIRED');
  if (args.command === 'run') requireController(path.isAbsolute(args.artifactFile ?? ''), 'LIVE_VALIDATION_ARTIFACT_REQUIRED');
  return args;
}

function outsideCheckout(directory, root) {
  const resolved = realpathSync(directory); const relative = path.relative(realpathSync(root), resolved);
  requireController(relative !== '' && (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)),
    'LIVE_VALIDATION_OPERATOR_DIRECTORY_UNSAFE');
  const stat = lstatSync(directory);
  requireController(!stat.isSymbolicLink() && stat.isDirectory() && (stat.mode & 0o077) === 0
    && (typeof process.getuid !== 'function' || stat.uid === process.getuid()), 'LIVE_VALIDATION_OPERATOR_DIRECTORY_UNSAFE');
  return resolved;
}
function evidenceDirectory(directory, root) {
  // Never recursively create or remove an operator-selected tree.
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  return outsideCheckout(directory, root);
}
function protectedWrite(file, value) {
  const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  if (existsSync(file)) {
    const stat = lstatSync(file);
    requireController(!stat.isSymbolicLink() && stat.isFile() && (stat.mode & 0o077) === 0
      && (typeof process.getuid !== 'function' || stat.uid === process.getuid()), 'LIVE_VALIDATION_STATE_UNSAFE');
  }
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  const parent = openSync(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
export function readTrustedOperatorFile(file, root) {
  requireController(path.isAbsolute(file), 'LIVE_VALIDATION_OPERATOR_PATH_REQUIRED');
  outsideCheckout(path.dirname(file), root);
  requireController(!lstatSync(file).isSymbolicLink(), 'LIVE_VALIDATION_OPERATOR_FILE_UNSAFE');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireController(stat.isFile() && (stat.mode & 0o077) === 0 && stat.size > 0 && stat.size <= MAX_JSON
      && (typeof process.getuid !== 'function' || stat.uid === process.getuid()), 'LIVE_VALIDATION_OPERATOR_FILE_UNSAFE');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
export function readTrustedRunnerGitState(root) {
  const git = args => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', ...args], {
    cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 5000, maxBuffer: 128 * 1024 }).trim();
  const head = git(['rev-parse', 'HEAD']);
  requireController(realpathSync(git(['rev-parse', '--show-toplevel'])) === realpathSync(root)
    && git(['config', '--get', 'remote.origin.url']) === 'https://github.com/pbjustin/Arcanos.git'
    && SHA.test(head) && git(['status', '--porcelain', '--untracked-files=all']) === '', 'LIVE_VALIDATION_TRUSTED_CHECKOUT_INVALID');
  return { root, head, clean: true, repository: 'pbjustin/Arcanos' };
}
function opaqueHash(file, maximum = 2 * 1024 * 1024 * 1024) {
  requireController(!lstatSync(file).isSymbolicLink(), 'LIVE_VALIDATION_ARTIFACT_INVALID');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireController(stat.isFile() && stat.size > 0 && stat.size <= maximum, 'LIVE_VALIDATION_ARTIFACT_INVALID');
    // Opaque bytes are hashed, never unpacked, executed or imported by this controller.
    const hash = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      const bytes = readSync(fd, buffer, 0, buffer.length, offset); requireController(bytes > 0, 'LIVE_VALIDATION_ARTIFACT_INVALID');
      hash.update(buffer.subarray(0, bytes)); offset += bytes;
    }
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

/** Recompute both opaque archives and their original manifest, rather than trusting a caller's digest. */
export function validateLiveValidationArtifact(binding, { args, git, directory, environment = {} }) {
  const keys = ['version', 'repository', 'sourceCommit', 'prNumber', 'profile', 'workflowRunId', 'workflowRunAttempt',
    'controllerRevision', 'treeSha', 'compiledSha256', 'files', 'artifactId', 'artifactDigest', 'attestationSha256'];
  requireController(exact(binding, keys) && binding.version === 1 && binding.repository === 'pbjustin/Arcanos'
    && binding.sourceCommit === args.commitSha && binding.prNumber === args.prNumber && binding.profile === args.profile
    && binding.controllerRevision === git.head && SHA.test(binding.treeSha ?? '') && HASH.test(binding.compiledSha256 ?? '') && binding.workflowRunAttempt === 1
    && /^[1-9][0-9]*$/u.test(binding.workflowRunId ?? '') && /^[1-9][0-9]*$/u.test(binding.artifactId ?? '')
    && /^sha256:[0-9a-f]{64}$/u.test(binding.artifactDigest ?? '') && HASH.test(binding.attestationSha256 ?? '')
    && exact(binding.files, ['source.tar', 'build.tar']) && Object.values(binding.files).every(value => HASH.test(value)),
  'LIVE_VALIDATION_ARTIFACT_BINDING_INVALID');
  if (environment.WORKFLOW_RUN_ID) requireController(binding.workflowRunId === environment.WORKFLOW_RUN_ID,
    'LIVE_VALIDATION_ARTIFACT_RUN_MISMATCH');
  if (environment.WORKFLOW_RUN_ATTEMPT) requireController(environment.WORKFLOW_RUN_ATTEMPT === '1', 'LIVE_VALIDATION_RERUN_FORBIDDEN');
  requireController(path.isAbsolute(directory ?? '') && !lstatSync(directory).isSymbolicLink()
    && lstatSync(directory).isDirectory(), 'LIVE_VALIDATION_ARTIFACT_INVALID');
  for (const name of ['source.tar', 'build.tar']) requireController(opaqueHash(path.join(directory, name)) === binding.files[name],
    'LIVE_VALIDATION_ARTIFACT_DIGEST_MISMATCH');
  const manifestFile = path.join(directory, 'candidate-attestation.json');
  requireController(!lstatSync(manifestFile).isSymbolicLink(), 'LIVE_VALIDATION_ARTIFACT_INVALID');
  const manifestFd = openSync(manifestFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw;
  try {
    const stat = fstatSync(manifestFd);
    requireController(stat.isFile() && stat.size > 0 && stat.size <= 16_384, 'LIVE_VALIDATION_ARTIFACT_INVALID');
    raw = readFileSync(manifestFd, 'utf8');
  } finally { closeSync(manifestFd); }
  requireController(Buffer.byteLength(raw) <= 16_384
    && digest(raw) === binding.attestationSha256, 'LIVE_VALIDATION_ARTIFACT_DIGEST_MISMATCH');
  const manifest = json(raw, 'LIVE_VALIDATION_ARTIFACT_INVALID');
  const candidateKeys = keys.filter(key => !['artifactId', 'artifactDigest', 'attestationSha256'].includes(key));
  requireController(exact(manifest, candidateKeys) && candidateKeys.every(key =>
    canonicalLiveValidationJson(manifest[key]) === canonicalLiveValidationJson(binding[key])), 'LIVE_VALIDATION_ARTIFACT_BINDING_INVALID');
  return Object.freeze(structuredClone(binding));
}

/** Initial premerge bootstrap is explicit operator authority, never a fallback from a failed workflow gate. */
export function validateLiveValidationOperatorArtifact(binding, { args, git, directory, raw }) {
  requireController(exact(binding, ['version', 'repository', 'sourceCommit', 'prNumber', 'profile', 'trustedControllerSha',
    'treeSha', 'compiledSha256', 'files', 'offlineGateRecords']) && binding.version === 'arcanos-live-validation-operator-bootstrap/v1'
    && binding.repository === 'pbjustin/Arcanos' && binding.sourceCommit === args.commitSha
    && binding.prNumber === args.prNumber && binding.profile === args.profile && binding.trustedControllerSha === git.head
    && SHA.test(binding.treeSha ?? '') && HASH.test(binding.compiledSha256 ?? '')
    && exact(binding.files, ['source.tar', 'build.tar']) && Object.values(binding.files).every(value => HASH.test(value))
    && Array.isArray(binding.offlineGateRecords) && binding.offlineGateRecords.length === LIVE_VALIDATION_OPERATOR_GATE_IDS.length,
  'LIVE_VALIDATION_OPERATOR_ATTESTATION_INVALID');
  for (const gate of LIVE_VALIDATION_OPERATOR_GATE_IDS) {
    const matches = binding.offlineGateRecords.filter(item => item?.gate === gate);
    requireController(matches.length === 1 && exact(matches[0], ['gate', 'status', 'commitSha', 'evidenceSha256'])
      && matches[0].status === 'PASS' && matches[0].commitSha === args.commitSha && HASH.test(matches[0].evidenceSha256 ?? '')
      && matches[0].evidenceSha256 !== '0'.repeat(64), 'LIVE_VALIDATION_OPERATOR_OFFLINE_GATE_FAILED');
  }
  requireController(path.isAbsolute(directory ?? '') && !lstatSync(directory).isSymbolicLink()
    && lstatSync(directory).isDirectory(), 'LIVE_VALIDATION_ARTIFACT_INVALID');
  for (const name of ['source.tar', 'build.tar']) requireController(opaqueHash(path.join(directory, name)) === binding.files[name],
    'LIVE_VALIDATION_ARTIFACT_DIGEST_MISMATCH');
  return Object.freeze({ ...structuredClone(binding), controllerRevision: binding.trustedControllerSha,
    artifactAuthority: 'operator_bootstrap', attestationSha256: digest(raw) });
}

async function boundedJson(response, code) {
  requireController(response.ok === true, code);
  const length = Number(response.headers?.get?.('content-length'));
  requireController(!length || length <= MAX_JSON, code);
  const raw = await response.text(); requireController(Buffer.byteLength(raw) <= MAX_JSON, code);
  return json(raw, code);
}
export function createLiveValidationGitHubApi({ token, fetchImplementation = globalThis.fetch }) {
  requireController(typeof token === 'string' && token.length > 10, 'LIVE_VALIDATION_GITHUB_CREDENTIAL_REQUIRED');
  return Object.freeze({
    async get(route) {
      requireController(route === '/user' || /^\/repos\/pbjustin\/Arcanos\/[a-zA-Z0-9/_.?=&%-]+$/u.test(route), 'LIVE_VALIDATION_GITHUB_ROUTE_INVALID');
      const response = await fetchImplementation('https://api.github.com' + route, {
        headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        redirect: 'error', signal: AbortSignal.timeout(20_000)
      });
      return boundedJson(response, 'LIVE_VALIDATION_GITHUB_METADATA_UNAVAILABLE');
    }
  });
}

/** Authoritative exact-head and artifact checks run twice, including immediately before admission. */
export async function assertLiveValidationGitHubGate({ github, args, artifact, environment, git }) {
  const base = '/repos/pbjustin/Arcanos';
  const pr = await github.get(`${base}/pulls/${args.prNumber}`);
  requireController(pr.state === 'open' && pr.head?.sha === args.commitSha
    && pr.head?.repo?.full_name === 'pbjustin/Arcanos' && pr.base?.repo?.full_name === 'pbjustin/Arcanos'
    && pr.base?.ref === 'main', 'LIVE_VALIDATION_PR_HEAD_GATE_FAILED');
  const actor = args.operatorBootstrap ? (await github.get('/user')).login : environment.GITHUB_ACTOR;
  requireController(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/u.test(actor ?? ''), 'LIVE_VALIDATION_MAINTAINER_REQUIRED');
  const permission = await github.get(`${base}/collaborators/${actor}/permission`);
  requireController(['admin', 'maintain'].includes(permission.permission), 'LIVE_VALIDATION_MAINTAINER_REQUIRED');
  let offlineJobId; let workflowRunId;
  if (!args.operatorBootstrap) {
    requireController(environment.WORKFLOW_RUN_ATTEMPT === '1' && environment.WORKFLOW_RUN_ID === artifact.workflowRunId
      && environment.CONTROLLER_REVISION === git.head, 'LIVE_VALIDATION_RERUN_FORBIDDEN');
    const [run, uploaded, jobs] = await Promise.all([
      github.get(`${base}/actions/runs/${artifact.workflowRunId}`), github.get(`${base}/actions/artifacts/${artifact.artifactId}`),
      github.get(`${base}/actions/runs/${artifact.workflowRunId}/jobs?per_page=100`)
    ]);
    requireController(run.event === 'workflow_dispatch' && run.run_attempt === 1 && String(run.id) === artifact.workflowRunId
      && run.head_sha === git.head && run.head_branch === 'main' && run.path === '.github/workflows/live-pr-acceptance.yml'
      && run.repository?.full_name === 'pbjustin/Arcanos' && run.actor?.login === actor,
    'LIVE_VALIDATION_TRUSTED_WORKFLOW_REQUIRED');
    requireController(String(uploaded.id) === artifact.artifactId && uploaded.expired === false
      && uploaded.name === `live-validation-candidate-${artifact.workflowRunId}-1`
      && uploaded.digest === artifact.artifactDigest && String(uploaded.workflow_run?.id) === artifact.workflowRunId
      && uploaded.workflow_run?.head_sha === git.head, 'LIVE_VALIDATION_ARTIFACT_PROVENANCE_FAILED');
    requireController(Array.isArray(jobs.jobs) && jobs.total_count === jobs.jobs.length && jobs.total_count <= 100,
      'LIVE_VALIDATION_CHECKS_INCOMPLETE');
    const offline = jobs.jobs.filter(job => job.name === 'Validate exact candidate without live credentials');
    requireController(offline.length === 1 && offline[0].status === 'completed' && offline[0].conclusion === 'success'
      && offline[0].head_sha === git.head, 'LIVE_VALIDATION_OFFLINE_GATE_FAILED');
    offlineJobId = offline[0].id; workflowRunId = artifact.workflowRunId;
  } else {
    requireController(artifact.artifactAuthority === 'operator_bootstrap' && artifact.trustedControllerSha === git.head,
      'LIVE_VALIDATION_OPERATOR_ATTESTATION_INVALID');
    requireController(!environment.GITHUB_ACTIONS && (!environment.WORKFLOW_RUN_ATTEMPT || environment.WORKFLOW_RUN_ATTEMPT === '1'),
      'LIVE_VALIDATION_OPERATOR_BOOTSTRAP_WORKFLOW_FORBIDDEN');
  }
  const checks = await github.get(`${base}/commits/${args.commitSha}/check-runs?per_page=100`);
  requireController(Array.isArray(checks.check_runs) && checks.total_count === checks.check_runs.length
    && checks.total_count <= 100, 'LIVE_VALIDATION_CHECKS_INCOMPLETE');
  for (const name of ['All Checks Complete', 'docs:check']) {
    const matching = checks.check_runs.filter(check => check.name === name);
    requireController(matching.length > 0 && matching.every(check => check.head_sha === args.commitSha
      && check.status === 'completed' && check.conclusion === 'success' && check.app?.slug === 'github-actions'),
    'LIVE_VALIDATION_REQUIRED_CHECK_FAILED');
  }
  return { prNumber: args.prNumber, commitSha: args.commitSha, baseSha: pr.base.sha,
    controllerRevision: git.head, artifactAuthority: args.operatorBootstrap ? 'operator_bootstrap' : 'github_actions',
    artifactAttestationSha256: artifact.attestationSha256, maintainer: actor, requiredChecks: ['All Checks Complete', 'docs:check'],
    ...(args.operatorBootstrap ? { offlineGateRecordsSha256: canonicalHash(artifact.offlineGateRecords) } : { workflowRunId, offlineJobId }) };
}

// Railway documents commitSha on serviceInstanceDeployV2; no branch identity is used.
const INVENTORY_QUERY = `query LiveValidationInventory($environmentId:String!,$runtimeServiceId:String!){
 projectToken{projectId environmentId}
 environment(id:$environmentId){id name projectId deletedAt config(decryptVariables:false)
  serviceInstances(first:100){pageInfo{hasNextPage} edges{node{id serviceId environmentId deletedAt restartPolicyType numReplicas source{repo image}
   latestDeployment{id projectId environmentId serviceId status deploymentStopped meta}
   activeDeployments{id projectId environmentId serviceId status deploymentStopped meta}
   domains{serviceDomains{id domain deletedAt} customDomains{id domain deletedAt}}}}}
  deploymentTriggers(first:100){pageInfo{hasNextPage} edges{node{id projectId environmentId serviceId repository}}}
  volumeInstances(first:100){pageInfo{hasNextPage} edges{node{id environmentId serviceId volumeId mountPath deletedAt}}}
  variables(first:100){pageInfo{hasNextPage} edges{node{name serviceId environmentId}}}}
 privateNetworks(environmentId:$environmentId){publicId projectId environmentId deletedAt}
 runtimeTcp:tcpProxies(environmentId:$environmentId,serviceId:$runtimeServiceId){id serviceId environmentId deletedAt}
}`;
const DEPLOYMENT_QUERY = 'query LiveValidationDeployment($id:String!){deployment(id:$id){id projectId environmentId serviceId status deploymentStopped meta}}';

export function createLiveValidationRailwayApi({ token, fetchImplementation = globalThis.fetch }) {
  requireController(typeof token === 'string' && token.length > 10, 'LIVE_VALIDATION_RAILWAY_CREDENTIAL_REQUIRED');
  async function graphql(query, variables) {
    const response = await fetchImplementation('https://backboard.railway.app/graphql/v2', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Project-Access-Token': token },
      body: JSON.stringify({ query, variables }), redirect: 'error', signal: AbortSignal.timeout(20_000)
    });
    const result = await boundedJson(response, 'LIVE_VALIDATION_RAILWAY_METADATA_UNAVAILABLE');
    requireController(record(result.data) && !result.errors?.length, 'LIVE_VALIDATION_RAILWAY_METADATA_UNAVAILABLE');
    return result.data;
  }
  return Object.freeze({
    inventory: target => graphql(INVENTORY_QUERY, { environmentId: target.environmentId, runtimeServiceId: target.runtimeServiceId }),
    async deployment(id) { requireController(UUID.test(id), 'LIVE_VALIDATION_DEPLOYMENT_ID_INVALID'); return (await graphql(DEPLOYMENT_QUERY, { id })).deployment; },
    async deploy(target, role, commitSha) {
      requireController(role === 'runtime' && SHA.test(commitSha), 'LIVE_VALIDATION_DEPLOYMENT_INVALID');
      const result = await graphql('mutation LiveValidationDeploy($environmentId:String!,$serviceId:String!,$commitSha:String!){serviceInstanceDeployV2(environmentId:$environmentId,serviceId:$serviceId,commitSha:$commitSha)}',
        { environmentId: target.environmentId, serviceId: target.runtimeServiceId, commitSha });
      requireController(UUID.test(result.serviceInstanceDeployV2 ?? ''), 'LIVE_VALIDATION_DEPLOYMENT_ID_INVALID');
      return result.serviceInstanceDeployV2;
    },
    async bindTestToken(target, value) {
      validateLiveValidationTarget(target);
      requireController(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'LIVE_VALIDATION_SERVICE_CREDENTIAL_REQUIRED');
      const result = await graphql('mutation LiveValidationTestToken($input:VariableUpsertInput!){variableUpsert(input:$input)}',
        { input: { projectId: target.projectId, environmentId: target.environmentId, serviceId: target.runtimeServiceId,
          name: 'ARCANOS_LIVE_VALIDATION_TEST_TOKEN', value, skipDeploys: true } });
      requireController(result.variableUpsert === true, 'LIVE_VALIDATION_SERVICE_CREDENTIAL_BINDING_FAILED');
    },
    async stop(id) {
      requireController(UUID.test(id), 'LIVE_VALIDATION_DEPLOYMENT_ID_INVALID');
      const result = await graphql('mutation LiveValidationStop($id:String!){deploymentStop(id:$id)}', { id });
      requireController(result.deploymentStop === true, 'LIVE_VALIDATION_CLEANUP_STOP_FAILED');
    },
    async cancel(id) {
      requireController(UUID.test(id), 'LIVE_VALIDATION_DEPLOYMENT_ID_INVALID');
      const result = await graphql('mutation LiveValidationCancel($id:String!){deploymentCancel(id:$id)}', { id });
      requireController(result.deploymentCancel === true, 'LIVE_VALIDATION_CLEANUP_CANCEL_FAILED');
    }
  });
}

function nodes(connection) {
  requireController(connection?.pageInfo?.hasNextPage === false && Array.isArray(connection.edges)
    && connection.edges.length <= 100 && connection.edges.every(edge => record(edge?.node)), 'LIVE_VALIDATION_INVENTORY_INCOMPLETE');
  return connection.edges.map(edge => edge.node);
}
function metadata(value) { return typeof value === 'string' ? json(value, 'LIVE_VALIDATION_DEPLOYMENT_METADATA_INVALID') : value; }
function assertLiveValidationRuntimePolicy(deployment) {
  const deploy = metadata(deployment.meta)?.serviceManifest?.deploy;
  const regions = deploy?.multiRegionConfig;
  requireController(record(deploy) && deploy.restartPolicyType === 'NEVER' && deploy.numReplicas === 1
    && (regions === undefined || regions === null || record(regions) && Object.keys(regions).length === 1
      && Object.values(regions).every(region => record(region) && region.numReplicas === 1)),
  'LIVE_VALIDATION_RUNTIME_POLICY_INVALID');
}
export function normalizeLiveValidationInventory(target, raw, { phase = 'paid' } = {}) {
  const env = raw.environment;
  requireController(raw.projectToken?.projectId === target.projectId && raw.projectToken?.environmentId === target.environmentId,
    'LIVE_VALIDATION_RAILWAY_TOKEN_SCOPE_INVALID');
  requireController(env?.id === target.environmentId && env.projectId === target.projectId && !env.deletedAt,
    'LIVE_VALIDATION_INVENTORY_TARGET_MISMATCH');
  const config = typeof env.config === 'string' ? json(env.config, 'LIVE_VALIDATION_INVENTORY_INVALID') : env.config;
  requireController(record(config) && record(config.services) && record(config.sharedVariables)
    && config.privateNetworkDisabled === false, 'LIVE_VALIDATION_INVENTORY_INVALID');
  const instances = nodes(env.serviceInstances).filter(item => !item.deletedAt);
  const triggers = nodes(env.deploymentTriggers); const volumeInstances = nodes(env.volumeInstances).filter(item => !item.deletedAt);
  const variables = nodes(env.variables);
  requireController(instances.every(item => item.environmentId === target.environmentId)
    && variables.every(item => item.environmentId === target.environmentId)
    && triggers.every(item => item.environmentId === target.environmentId && item.projectId === target.projectId)
    && volumeInstances.every(item => item.environmentId === target.environmentId), 'LIVE_VALIDATION_INVENTORY_TARGET_MISMATCH');
  requireController(triggers.length === 0, 'LIVE_VALIDATION_AUTODEPLOY_FORBIDDEN');
  requireController(Object.keys(config.services).length === 1
    && Object.keys(config.services)[0] === target.runtimeServiceId,
    'LIVE_VALIDATION_INVENTORY_SERVICES_INVALID');
  requireController(instances.every(instance => instance.restartPolicyType === 'NEVER' && instance.numReplicas === 1),
    'LIVE_VALIDATION_RUNTIME_POLICY_INVALID');
  const networks = raw.privateNetworks;
  requireController(Array.isArray(networks) && networks.length === 1 && !networks[0].deletedAt
    && networks[0].environmentId === target.environmentId && networks[0].projectId === target.projectId,
    'LIVE_VALIDATION_PRIVATE_NETWORK_REQUIRED');
  const mounts = volumeInstances.map(volume => ({ id: volume.volumeId, serviceId: volume.serviceId,
    mountPath: volume.mountPath, purpose: 'quota_ledger' }));
  const services = instances.map(instance => {
    const role = instance.serviceId === target.runtimeServiceId ? 'runtime' : 'unknown';
    const service = config.services[instance.serviceId]; const source = service?.source;
    const tcp = raw.runtimeTcp;
    requireController(record(source) && Array.isArray(tcp) && tcp.every(item => item.environmentId === target.environmentId
      && item.serviceId === instance.serviceId), 'LIVE_VALIDATION_INVENTORY_INVALID');
    const latest = instance.latestDeployment;
    requireController(Array.isArray(instance.activeDeployments) && instance.activeDeployments.length <= 1
      && (latest || instance.activeDeployments.length === 0), 'LIVE_VALIDATION_DEPLOYMENT_METADATA_INVALID');
    if (latest) requireController(latest.projectId === target.projectId && latest.environmentId === target.environmentId
      && latest.serviceId === instance.serviceId && UUID.test(latest.id ?? ''), 'LIVE_VALIDATION_DEPLOYMENT_TARGET_MISMATCH');
    const observedCommitSha = latest ? metadata(latest.meta)?.commitHash : null;
    requireController(!latest || SHA.test(observedCommitSha ?? ''), 'LIVE_VALIDATION_DEPLOYMENT_SHA_MISMATCH');
    if (phase === 'paid') {
      if (latest) assertLiveValidationRuntimePolicy(latest);
      instance.activeDeployments.forEach(assertLiveValidationRuntimePolicy);
    }
    return { id: instance.serviceId, role,
      variableNames: [...new Set([...variables.filter(item => item.serviceId === instance.serviceId).map(item => item.name),
        ...Object.keys(service.variables ?? {})])],
      publicDomains: [...(instance.domains?.serviceDomains ?? []), ...(instance.domains?.customDomains ?? [])].filter(item => !item.deletedAt).map(item => item.domain),
      tcpProxyDomains: tcp.filter(item => !item.deletedAt).map(item => item.id),
      volumeMounts: mounts.filter(volume => volume.serviceId === instance.serviceId).map(({ serviceId, ...volume }) => volume),
      // Branch names and deployment messages are not source pin evidence.
      source: { repository: source.repo, commitSha: observedCommitSha, autoDeploy: false } };
  });
  const inventory = assertLiveValidationInventory(target, { projectId: env.projectId, environmentId: env.id, environmentName: env.name,
    sharedVariableNames: [...new Set([...variables.filter(item => !item.serviceId).map(item => item.name), ...Object.keys(config.sharedVariables)])],
    privateNetworkEnabled: true, volumes: mounts, services }, { phase });
  return { inventory, instances };
}

export function assertLiveValidationDeployment(deployment, target, role, commitSha, { successful = true } = {}) {
  requireController(record(deployment) && UUID.test(deployment.id ?? '') && deployment.projectId === target.projectId
    && deployment.environmentId === target.environmentId && deployment.serviceId === target[`${role}ServiceId`],
  'LIVE_VALIDATION_DEPLOYMENT_TARGET_MISMATCH');
  const meta = metadata(deployment.meta);
  requireController(record(meta) && meta.commitHash === commitSha && meta.repo === target.repository,
    'LIVE_VALIDATION_DEPLOYMENT_SHA_MISMATCH');
  if (successful) {
    requireController(deployment.status === 'SUCCESS' && deployment.deploymentStopped === false,
      'LIVE_VALIDATION_DEPLOYMENT_NOT_READY');
    assertLiveValidationRuntimePolicy(deployment);
  }
  return deployment;
}
function identityFields(value) {
  return Object.fromEntries(['role', 'sourceCommit', 'projectId', 'environmentId', 'serviceId', 'deploymentId',
    'buildManifestSha256'].map(key => [key, value?.[key]]));
}
function assertReady(value, target, role, commitSha, deploymentId, artifact) {
  requireController(value?.role === role && value.sourceCommit === commitSha && value.projectId === target.projectId
    && value.environmentId === target.environmentId && value.serviceId === target[`${role}ServiceId`]
    && value.deploymentId === deploymentId && HASH.test(value.buildManifestSha256 ?? '')
    && value.readiness?.providerCallsEnabled === false && value.readiness.modelCredentialBound === true
    && value.readiness.durableWritesEnabled === false,
  'LIVE_VALIDATION_PRIVATE_IDENTITY_MISMATCH');
  const manifest = value.buildManifest;
  requireController(exact(manifest, ['version', 'repository', 'sourceCommit', 'role', 'treeSha', 'compiledSha256'])
    && manifest.version === 1 && manifest.repository === target.repository && manifest.sourceCommit === commitSha && manifest.role === role
    && manifest.treeSha === artifact.treeSha && manifest.compiledSha256 === artifact.compiledSha256
    && canonicalHash(manifest) === value.buildManifestSha256, 'LIVE_VALIDATION_BUILD_MANIFEST_MISMATCH');
  return identityFields(value);
}
/** Service credentials only enter the approved managed HTTPS origin; never log response errors. */
export function createLiveValidationServiceClient({ origin, token, fetchImplementation = globalThis.fetch }) {
  requireController(typeof token === 'string' && token.length >= 32 && token.length <= 256
    && /^[A-Za-z0-9_-]+$/u.test(token), 'LIVE_VALIDATION_SERVICE_CREDENTIAL_REQUIRED');
  // Validate origin as part of the already protected target, then prohibit alternative destinations.
  const targetOrigin = new URL(origin);
  requireController(origin === targetOrigin.origin && targetOrigin.protocol === 'https:'
    && /^[a-z0-9-]+\.up\.railway\.app$/u.test(targetOrigin.hostname), 'LIVE_VALIDATION_PUBLIC_TARGET_INVALID');
  return Object.freeze({ async requestJSON(route, options = {}) {
    requireController(typeof route === 'string' && /^\/(?:ready|runs|acceptance|usage|stop)$/u.test(route), 'LIVE_VALIDATION_SERVICE_ROUTE_INVALID');
    const timeoutMs = options.timeoutMs ?? CONTROL_TIMEOUT_MS;
    requireController(integer(timeoutMs, 1, LIVE_VALIDATION_ACCEPTANCE_TRANSPORT_TIMEOUT_MS), 'LIVE_VALIDATION_SERVICE_TIMEOUT_INVALID');
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const response = await fetchImplementation(new URL(route, origin), { method: options.method ?? 'GET',
      headers: { ...options.headers, authorization: 'Bearer ' + token, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal, redirect: 'error' });
    return { status: response.status, body: await boundedJson(response, 'LIVE_VALIDATION_SERVICE_REQUEST_FAILED') };
  } });
}
async function serviceJson(client, route, options = {}) {
  const result = await client.requestJSON(route, { timeoutMs: CONTROL_TIMEOUT_MS, ...options });
  requireController(result.status === 200 && record(result.body), 'LIVE_VALIDATION_SERVICE_REQUEST_FAILED');
  return result.body;
}
function authHeaders(_run, runtime) {
  return { 'x-arcanos-source-commit': runtime.sourceCommit, 'x-arcanos-deployment-id': runtime.deploymentId };
}

export async function resolveLiveValidationSelection(github, selection) {
  const base = '/repos/pbjustin/Arcanos';
  let prNumber = selection.prNumber;
  if (prNumber === undefined) {
    const matches = await github.get(`${base}/commits/${selection.commitSha}/pulls?per_page=100`);
    requireController(Array.isArray(matches) && matches.length < 100, 'LIVE_VALIDATION_PR_SELECTION_AMBIGUOUS');
    const exactHeads = matches.filter(pr => pr.state === 'open' && pr.head?.sha === selection.commitSha
      && pr.head?.repo?.full_name === 'pbjustin/Arcanos' && pr.base?.ref === 'main');
    requireController(exactHeads.length === 1, 'LIVE_VALIDATION_PR_SELECTION_AMBIGUOUS');
    prNumber = exactHeads[0].number;
  }
  const pr = await github.get(`${base}/pulls/${prNumber}`);
  requireController(pr.state === 'open' && pr.head?.repo?.full_name === 'pbjustin/Arcanos'
    && pr.base?.repo?.full_name === 'pbjustin/Arcanos' && pr.base?.ref === 'main'
    && SHA.test(pr.head?.sha ?? '') && (!selection.commitSha || selection.commitSha === pr.head.sha), 'LIVE_VALIDATION_PR_HEAD_GATE_FAILED');
  return { prNumber, commitSha: pr.head.sha };
}

export function sanitizeLiveValidationObservation(value) {
  requireController(value?.schemaVersion === 1 && value.contractVersion === 'gaming-hybrid-v2'
    && ['accepted', 'clarification_required', 'need_new_source', 'unavailable'].includes(value.outcome)
    && ['USER_DECISION_GAP', 'EVIDENCE_GAP', 'NONCRITICAL_GAP', 'CONFLICT', 'NONE', 'UNOBSERVED'].includes(value.semanticGap),
  'LIVE_VALIDATION_PROFILE_OBSERVATION_FAILED');
  const stages = ['acquisition', 'selection', 'generation', 'intake', 'reasoning', 'final', 'answer_audit', 'response'];
  requireController(record(value.stages) && stages.every(stage => ['not_run', 'started', 'passed', 'failed', 'timed_out'].includes(value.stages[stage]?.status)
    && (value.stages[stage].elapsedMs === null || integer(value.stages[stage].elapsedMs, 0, 3_600_000))), 'LIVE_VALIDATION_PROFILE_OBSERVATION_FAILED');
  const budget = amount => integer(amount, 0, LIVE_VALIDATION_HARD_LIMITS.durationMs) ? amount : null;
  const count = amount => integer(amount, 0, 64) ? amount : null;
  const audit = value.audit;
  const trace = value.clarification;
  const clarification = record(trace) && trace.version === 1
    && ['submittedCount', 'completedCount', 'postAcquisitionCount'].every(key => integer(trace[key], 0, 8))
    && trace.completedCount <= trace.submittedCount && trace.postAcquisitionCount <= trace.completedCount
    && integer(trace.acquisitionCount, 0, 1)
    && ['sameWorkflow', 'revisionsAdvanced', 'retainedEvidence', 'budgetsPreserved'].every(key => typeof trace[key] === 'boolean')
    ? { version: 1, submittedCount: trace.submittedCount, completedCount: trace.completedCount,
      postAcquisitionCount: trace.postAcquisitionCount, sameWorkflow: trace.sameWorkflow,
      revisionsAdvanced: trace.revisionsAdvanced, retainedEvidence: trace.retainedEvidence,
      budgetsPreserved: trace.budgetsPreserved, acquisitionCount: trace.acquisitionCount } : undefined;
  return { schemaVersion: 1, contractVersion: 'gaming-hybrid-v2', outcome: value.outcome, semanticGap: value.semanticGap,
    reason: /^[A-Z][A-Z0-9_]{0,79}$/u.test(value.reason ?? '') ? value.reason : null,
    candidates: Array.isArray(value.candidates) ? value.candidates.slice(0, 8).map(item => ({
      decision: ['accepted_transient', 'eligible_for_ingestion', 'already_indexed', 'rejected', 'requires_confirmation'].includes(item?.decision) ? item.decision : 'unobserved',
      reasonCodes: Array.isArray(item?.reasonCodes) ? item.reasonCodes.filter(code => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(code)).slice(0, 8) : [] })) : [],
    coverage: { satisfied: value.coverage?.satisfied === true,
      assessmentStatus: ['assessed', 'unknown', 'not_assessed'].includes(value.coverage?.assessmentStatus)
        ? value.coverage.assessmentStatus : 'not_assessed', missingCount: count(value.coverage?.missingCount) },
    selectedCandidateCount: count(value.selectedCandidateCount), selectedEvidenceCount: count(value.selectedEvidenceCount),
    qualification: { visible: value.qualification?.visible === true,
      patchCompatibility: ['unverified', 'stale', 'not_required', 'verified', 'unobserved'].includes(value.qualification?.patchCompatibility)
        ? value.qualification.patchCompatibility : 'unobserved',
      claimsVerifiedCurrentness: value.qualification?.claimsVerifiedCurrentness === true },
    audit: !record(audit) ? null : {
      assessmentStatus: ['completed', 'not_run', 'unavailable'].includes(audit.assessmentStatus) ? audit.assessmentStatus : 'unobserved',
      decision: ['accept', 'reject', 'partial', 'unavailable'].includes(audit.decision) ? audit.decision : 'unobserved',
      boundToFinalAnswer: audit.boundToFinalAnswer === true },
    ...(clarification ? { clarification } : {}),
    auditStartBudget: { runtimeRemainingMs: budget(value.auditStartBudget?.runtimeRemainingMs),
      requestRemainingMs: budget(value.auditStartBudget?.requestRemainingMs) },
    stages: Object.fromEntries(stages.map(stage => [stage, { status: value.stages[stage].status, elapsedMs: value.stages[stage].elapsedMs }])) };
}
function assertProfileRequirements(expected) {
  requireController(record(expected), 'LIVE_VALIDATION_PROFILE_INVALID');
  if (Object.hasOwn(expected, 'requiredModelStages')) requireController(Array.isArray(expected.requiredModelStages)
    && expected.requiredModelStages.length > 0 && expected.requiredModelStages.length <= MODEL_STAGES.length
    && new Set(expected.requiredModelStages).size === expected.requiredModelStages.length
    && expected.requiredModelStages.every(stage => MODEL_STAGES.includes(stage)), 'LIVE_VALIDATION_PROFILE_INVALID');
  if (Object.hasOwn(expected, 'clarification')) requireController(exact(expected.clarification, ['completedCount', 'postAcquisitionCount'])
    && integer(expected.clarification.completedCount, 1, 8)
    && integer(expected.clarification.postAcquisitionCount, 0, expected.clarification.completedCount), 'LIVE_VALIDATION_PROFILE_INVALID');
}
function assertProfileObservation(value, expected) {
  requireController(value?.outcome === expected.outcome && value.semanticGap === expected.semanticGap,
    'LIVE_VALIDATION_PROFILE_OBSERVATION_FAILED');
  if (expected.outcome === 'accepted') requireController(value.coverage.satisfied && value.selectedEvidenceCount > 0
    && value.audit?.assessmentStatus === 'completed' && value.audit.decision === 'accept' && value.audit.boundToFinalAnswer,
  'LIVE_VALIDATION_PROFILE_OBSERVATION_FAILED');
  const completed = stage => value.stages[stage]?.status === 'passed' && value.stages[stage].elapsedMs !== null;
  if (expected.outcome === 'accepted') requireController(['acquisition', 'selection', 'generation', 'answer_audit', 'response'].every(completed)
    && MODEL_STAGES.some(completed), 'LIVE_VALIDATION_PROFILE_STAGE_FAILED');
  if (Object.hasOwn(expected, 'requiredModelStages')) {
    requireController(expected.requiredModelStages.every(completed), 'LIVE_VALIDATION_PROFILE_STAGE_FAILED');
  }
  if (Object.hasOwn(expected, 'clarification')) {
    const required = expected.clarification;
    const trace = value.clarification;
    requireController(trace?.submittedCount === required.completedCount && trace.completedCount === required.completedCount
      && trace.postAcquisitionCount === required.postAcquisitionCount && trace.sameWorkflow && trace.revisionsAdvanced
      && trace.acquisitionCount === 1 && (required.postAcquisitionCount === 0 || trace.retainedEvidence && trace.budgetsPreserved),
    'LIVE_VALIDATION_PROFILE_CLARIFICATION_FAILED');
  }
  if (expected.providerCalls === 0) requireController(value.candidates.some(candidate => candidate.decision === 'rejected'
    && candidate.reasonCodes.some(code => /(?:MISMATCH|CONFLICT)/u.test(code))), 'LIVE_VALIDATION_NEGATIVE_REASON_MISSING');
  if (expected.qualifiedUnknownPatch) requireController(value.qualification.visible === true
    && value.qualification.patchCompatibility === 'unverified' && value.qualification.claimsVerifiedCurrentness === false,
  'LIVE_VALIDATION_FRESHNESS_QUALIFICATION_FAILED');
}

export function sanitizeLiveValidationUsage(value, { plan, target }) {
  requireController(value?.runId === plan.runId && value.commitSha === plan.commitSha && value.prNumber === plan.prNumber
    && value.runtimeDeploymentId === plan.runtimeDeploymentId && value.profileHash === plan.profileHash
    && record(value.usage) && record(value.limits) && record(value.counts), 'LIVE_VALIDATION_USAGE_IDENTITY_MISMATCH');
  const keys = ['requests', 'metadataRequests', 'providerCalls', 'generationCalls', 'auditCalls',
    'reservedInputTokens', 'reservedOutputTokens', 'reservedTotalTokens', 'reservedSpendMicroUsd',
    'observedInputTokens', 'observedOutputTokens', 'observedTotalTokens', 'observedSpendMicroUsd'];
  requireController(keys.every(key => integer(value.usage[key])) && integer(value.counts.workflows)
    && value.limits.maxRequests <= target.limits.maxRequests && value.limits.maxWorkflows <= target.limits.maxWorkflows
    && value.limits.maxSpendMicroUsd <= target.limits.maxSpendMicroUsd && value.limits.maxConcurrency === 1
    && value.limits.maxRetries === 0 && value.usage.requests <= value.limits.maxRequests
    && value.counts.workflows <= value.limits.maxWorkflows && value.usage.reservedSpendMicroUsd <= value.limits.maxSpendMicroUsd
    && value.usage.observedSpendMicroUsd <= value.usage.reservedSpendMicroUsd
    && value.usage.providerCalls === value.usage.generationCalls + value.usage.auditCalls
    && value.usage.requests === value.usage.providerCalls + value.usage.metadataRequests,
  'LIVE_VALIDATION_USAGE_LIMIT_FAILED');
  return { runId: plan.runId, status: ['active', 'stopped'].includes(value.status) ? value.status : 'unknown',
    workflows: value.counts.workflows, ...Object.fromEntries(keys.map(key => [key, value.usage[key]])) };
}

function validateState(state, { target, args }) {
  const keys = ['version', 'targetHash', 'prNumber', 'commitSha', 'runId', 'runtimeDeploymentId',
    'runtimeCreated', 'runStarted', 'completed', 'cleanupComplete'];
  requireController((exact(state, keys) || exact(state, [...keys, 'runtimeDeployAttempted'])) && state.version === STATE_VERSION
    && state.targetHash === liveValidationTargetSha256(target) && state.prNumber === args.prNumber && state.commitSha === args.commitSha
    && /^[0-9a-f]{32}$/u.test(state.runId ?? '') && (state.runtimeDeploymentId === null || UUID.test(state.runtimeDeploymentId))
    && ['runtimeCreated', 'runStarted', 'completed', 'cleanupComplete'].every(key => typeof state[key] === 'boolean')
    && (!state.runtimeCreated || UUID.test(state.runtimeDeploymentId ?? ''))
    && (!Object.hasOwn(state, 'runtimeDeployAttempted') || typeof state.runtimeDeployAttempted === 'boolean'
      && (state.runtimeDeployAttempted || !state.runtimeCreated && state.runtimeDeploymentId === null && !state.runStarted)),
  'LIVE_VALIDATION_CLEANUP_STATE_INVALID');
  return state;
}

/** Stop only the deployment created by this run; retain the reusable environment and service. */
export async function cleanupLiveValidationRun({ target, args, state, railway, runtime, writeState,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  validateState(state, { target, args });
  const failures = []; let stopped = false; let runClosed = !state.runStarted;
  const inspectInventory = async ({ requireAbsent = false } = {}) => {
    try {
      const observed = normalizeLiveValidationInventory(target, await railway.inventory(target), { phase: 'predeploy' });
      if (requireAbsent) requireController(observed.instances.every(instance => instance.activeDeployments.length === 0),
        'LIVE_VALIDATION_CLEANUP_ACTIVE_DEPLOYMENT_REMAINS');
      return observed;
    }
    catch (error) { failures.push(safeCode(error)); }
  };
  const ownedDeployment = deployment => {
    assertLiveValidationDeployment(deployment, target, 'runtime', args.commitSha, { successful: false });
    requireController(deployment.id === state.runtimeDeploymentId, 'LIVE_VALIDATION_DEPLOYMENT_TARGET_MISMATCH');
    return deployment;
  };
  const terminated = deployment => {
    if (deployment.deploymentStopped === true || ['REMOVED', 'FAILED', 'SKIPPED'].includes(deployment.status)) return true;
    if (deployment.status === 'CRASHED') {
      try { assertLiveValidationRuntimePolicy(deployment); return true; } catch { /* Stop a crash that could restart. */ }
    }
    return false;
  };
  const terminationOperation = deployment => {
    if (['QUEUED', 'BUILDING', 'INITIALIZING', 'WAITING', 'NEEDS_APPROVAL'].includes(deployment.status)) return 'cancel';
    requireController(['DEPLOYING', 'SUCCESS', 'SLEEPING', 'CRASHED', 'REMOVING'].includes(deployment.status),
      'LIVE_VALIDATION_CLEANUP_DEPLOYMENT_STATUS_INVALID');
    return 'stop';
  };
  // Inventory drift still blocks a clean verdict, but cannot prevent closing an independently verified owned deployment.
  await inspectInventory({ requireAbsent: !state.runtimeCreated });
  // A lost deployment response can create a runtime after an empty snapshot. Do not adopt an unacknowledged ID.
  // Legacy no-ID states lack pre-request intent, so their deployment outcome is also unknown.
  if (!state.runtimeCreated && state.runtimeDeployAttempted !== false)
    failures.push('LIVE_VALIDATION_CLEANUP_DEPLOYMENT_OUTCOME_UNKNOWN');
  try {
    if (state.runtimeCreated) {
      let deployment = ownedDeployment(await railway.deployment(state.runtimeDeploymentId));
      if (!terminated(deployment) && state.runStarted && runtime) {
        try {
          const result = await serviceJson(runtime, '/stop', { method: 'POST', body: { runId: state.runId },
            headers: { 'x-arcanos-source-commit': args.commitSha, 'x-arcanos-deployment-id': state.runtimeDeploymentId } });
          requireController(result.stopped === true && result.runId === state.runId, 'LIVE_VALIDATION_CLEANUP_CLOSE_FAILED');
          runClosed = true;
        } catch { /* Stopping the exact deployment below closes all model execution even if the runtime is unavailable. */ }
      }
      const confirmationDeadline = now() + CLEANUP_CONFIRMATION_TIMEOUT_MS;
      const requested = new Set();
      while (true) {
        let operation; let rejection;
        if (!terminated(deployment)) {
          requireController(now() < confirmationDeadline, 'LIVE_VALIDATION_CLEANUP_STOP_READBACK_FAILED');
          operation = terminationOperation(deployment);
          if (!requested.has(operation)) {
            requested.add(operation);
            try { await railway[operation](state.runtimeDeploymentId); }
            catch (error) { rejection = error; }
          }
        }
        let after;
        try { after = ownedDeployment(await railway.deployment(state.runtimeDeploymentId)); }
        catch (error) { throw rejection ?? error; }
        if (terminated(after)) break;
        // A build may become running while cancellation is in flight. Change operation once, without retrying a rejection.
        if (rejection && terminationOperation(after) === operation) throw rejection;
        deployment = after;
        requireController(now() < confirmationDeadline, 'LIVE_VALIDATION_CLEANUP_STOP_READBACK_FAILED');
        if (rejection) continue;
        await sleep(Math.min(1_000, confirmationDeadline - now()));
      }
      stopped = true; runClosed = true;
    }
  } catch (error) { failures.push(safeCode(error)); }
  const finalInventory = await inspectInventory({ requireAbsent: true });
  if (!state.runtimeCreated && state.runtimeDeployAttempted === false && finalInventory) stopped = true;
  state.cleanupComplete = stopped && runClosed && failures.length === 0; writeState(state);
  return { version: SUMMARY_VERSION, status: state.cleanupComplete ? 'PASS' : 'FAIL',
    code: state.cleanupComplete ? 'LIVE_VALIDATION_CLEANUP_PASS' : 'LIVE_VALIDATION_CLEANUP_BLOCKED',
    runtimeDeploymentStopped: stopped, runClosed, definitionsRetained: failures.length === 0, failures };
}

export async function runLiveValidationController(argv, dependencies = {}) {
  const args = parseLiveValidationControllerArguments(argv);
  const root = dependencies.repositoryRoot ?? ROOT; const environment = dependencies.environment ?? process.env;
  const read = dependencies.readOperatorFile ?? readTrustedOperatorFile;
  const git = (dependencies.readGitState ?? readTrustedRunnerGitState)(root);
  requireController(git.clean === true && git.repository === 'pbjustin/Arcanos' && SHA.test(git.head ?? ''), 'LIVE_VALIDATION_TRUSTED_CHECKOUT_INVALID');
  let github;
  const createGitHub = () => github ??= (dependencies.createGitHubApi ?? createLiveValidationGitHubApi)({ token: environment.GITHUB_TOKEN,
    fetchImplementation: dependencies.fetchImplementation });
  if (args.prNumber === undefined || args.commitSha === undefined) {
    requireController(args.execute, 'LIVE_VALIDATION_OFFLINE_EXACT_SELECTION_REQUIRED');
    Object.assign(args, await resolveLiveValidationSelection(createGitHub(), args));
  }
  const target = validateLiveValidationTarget(json(read(args.targetFile, root), 'LIVE_VALIDATION_TARGET_INVALID'));
  for (const [key, limit] of Object.entries(args.limits)) requireController(limit === target.limits[key], 'LIVE_VALIDATION_OPERATOR_LIMIT_MISMATCH');
  const directory = evidenceDirectory(args.evidenceDirectory, root); const stateFile = path.join(directory, 'controller-state.private.json');
  const now = dependencies.now ?? Date.now; const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const createRailway = () => (dependencies.createRailwayApi ?? createLiveValidationRailwayApi)({ token: environment.RAILWAY_LIVE_VALIDATION_TOKEN,
    fetchImplementation: dependencies.fetchImplementation });
  let testToken;
  const createRuntime = () => (dependencies.createServiceClient ?? createLiveValidationServiceClient)({ origin: target.publicOrigin,
    token: testToken, fetchImplementation: dependencies.fetchImplementation });
  if (args.command === 'cleanup') {
    if (!existsSync(stateFile)) {
      const summary = { version: SUMMARY_VERSION, status: 'PASS', code: 'LIVE_VALIDATION_CLEANUP_NO_RUN', definitionsRetained: true };
      protectedWrite(path.join(directory, 'cleanup-summary.json'), summary); return summary;
    }
    const state = validateState(json(read(stateFile, root), 'LIVE_VALIDATION_CLEANUP_STATE_INVALID'), { target, args });
    const summary = await cleanupLiveValidationRun({ target, args, state, railway: createRailway(), runtime: undefined,
      writeState: value => protectedWrite(stateFile, value), now, sleep });
    protectedWrite(path.join(directory, 'cleanup-summary.json'), summary); return summary;
  }
  const artifactRaw = read(args.artifactFile, root); const binding = json(artifactRaw, 'LIVE_VALIDATION_ARTIFACT_INVALID');
  const artifact = args.operatorBootstrap
    ? validateLiveValidationOperatorArtifact(binding, { args, git, raw: artifactRaw, directory: environment.LIVE_VALIDATION_ARTIFACT_DIRECTORY })
    : validateLiveValidationArtifact(binding, { args, git, environment, directory: environment.LIVE_VALIDATION_ARTIFACT_DIRECTORY });
  const profiles = dependencies.readProfiles ? dependencies.readProfiles(root)
    : json(readFileSync(path.join(root, 'examples/live-validation/profiles.json'), 'utf8'), 'LIVE_VALIDATION_PROFILE_INVALID');
  requireController(profiles.version === 1 && Array.isArray(profiles.profiles) && profiles.profiles.length === 2
    && PROFILE_IDS.every((id, index) => profiles.profiles[index]?.id === id)
    && profiles.profiles.every(entry => entry.moduleId === 'gaming' && entry.input?.query?.storagePolicy === 'transient_only'), 'LIVE_VALIDATION_PROFILE_INVALID');
  profiles.profiles.forEach(entry => assertProfileRequirements(entry.expected));
  const profileHash = canonicalHash(profiles);
  const localGate = { targetHash: liveValidationTargetSha256(target), artifactAttestationSha256: artifact.attestationSha256,
    profileHash, commitSha: args.commitSha, controllerRevision: git.head, limits: args.limits,
    artifactAuthority: args.operatorBootstrap ? 'operator_bootstrap' : 'github_actions' };
  if (!args.execute) return { version: SUMMARY_VERSION, status: 'PASS', code: 'LIVE_VALIDATION_OFFLINE_PREFLIGHT_PASS',
    paidProviderEnabled: false, infrastructureMutation: false, ...localGate };
  if (!args.operatorBootstrap) requireController(environment.WORKFLOW_RUN_ATTEMPT === '1', 'LIVE_VALIDATION_RERUN_FORBIDDEN');
  const githubGate = await assertLiveValidationGitHubGate({ github: createGitHub(), args, artifact, environment, git });
  requireController(!existsSync(stateFile), 'LIVE_VALIDATION_RUN_REPLAY_FORBIDDEN');
  const railway = createRailway(); let runtime;
  const state = { version: STATE_VERSION, targetHash: localGate.targetHash, prNumber: args.prNumber, commitSha: args.commitSha,
    runId: canonicalHash({ targetHash: localGate.targetHash, artifactAttestationSha256: artifact.attestationSha256 }).slice(0, 32),
    runtimeDeploymentId: null, runtimeCreated: false, runtimeDeployAttempted: false,
    runStarted: false, completed: false, cleanupComplete: false };
  const writeState = value => protectedWrite(stateFile, value); writeState(state);
  const started = now(); let deadline = started + 1_200_000; // Deployment has a separate, unpaid deadline.
  const checkDeadline = () => requireController(now() < deadline && !dependencies.signal?.aborted, 'LIVE_VALIDATION_DEADLINE_EXCEEDED');
  const runJson = (route, options = {}) => { checkDeadline(); return serviceJson(runtime, route,
    { ...options, headers: { 'x-arcanos-source-commit': args.commitSha, 'x-arcanos-deployment-id': state.runtimeDeploymentId, ...options.headers },
      timeoutMs: Math.min(options.timeoutMs ?? CONTROL_TIMEOUT_MS, deadline - now()) }); };
  let summary; let cleanup; let runtimeIdentity; let plan; let actualUsage; const cases = [];
  try {
    checkDeadline(); const before = normalizeLiveValidationInventory(target, await railway.inventory(target), { phase: 'predeploy' });
    requireController(before.instances[0].activeDeployments?.length === 0, 'LIVE_VALIDATION_RUNTIME_ALREADY_ACTIVE');
    testToken = (dependencies.randomBytes ?? randomBytes)(32).toString('hex');
    await railway.bindTestToken(target, testToken); runtime = createRuntime();
    state.runtimeDeployAttempted = true; writeState(state); // Record intent before a request whose response can be lost.
    state.runtimeDeploymentId = await railway.deploy(target, 'runtime', args.commitSha); state.runtimeCreated = true; writeState(state);
    while (true) {
      checkDeadline(); const deployment = await railway.deployment(state.runtimeDeploymentId);
      assertLiveValidationDeployment(deployment, target, 'runtime', args.commitSha, { successful: false });
      if (deployment.status === 'SUCCESS') { assertLiveValidationDeployment(deployment, target, 'runtime', args.commitSha); break; }
      requireController(!['FAILED', 'CRASHED', 'REMOVED', 'CANCELED'].includes(deployment.status), 'LIVE_VALIDATION_DEPLOYMENT_FAILED');
      await sleep(Math.min(3_000, Math.max(1, deadline - now())));
    }
    const observed = normalizeLiveValidationInventory(target, await railway.inventory(target));
    requireController(observed.instances[0].activeDeployments?.length === 1
      && observed.instances[0].activeDeployments[0].id === state.runtimeDeploymentId, 'LIVE_VALIDATION_ACTIVE_DEPLOYMENT_MISMATCH');
    runtimeIdentity = assertReady(await runJson('/ready'), target, 'runtime', args.commitSha, state.runtimeDeploymentId, artifact);
    const freshGate = await assertLiveValidationGitHubGate({ github: createGitHub(), args, artifact, environment, git });
    requireController(freshGate.baseSha === githubGate.baseSha, 'LIVE_VALIDATION_PR_BASE_MOVED');
    checkDeadline(); const paidStarted = now(); deadline = paidStarted + args.limits.durationMs;
    plan = { runId: state.runId, prNumber: args.prNumber, commitSha: args.commitSha,
      runtimeDeploymentId: state.runtimeDeploymentId, profileHash, expiresAtMs: deadline, paidAuthorized: true };
    state.runStarted = true; writeState(state); // Cleanup covers a partially delivered activation.
    const admitted = await runJson('/runs', { method: 'POST', body: plan });
    requireController(admitted.admitted === true && admitted.runId === state.runId, 'LIVE_VALIDATION_RUNTIME_ADMISSION_FAILED');
    let priorUsage = sanitizeLiveValidationUsage(await runJson('/usage'), { plan, target }); actualUsage = priorUsage;
    for (const entry of profiles.profiles) {
      const response = await runJson('/acceptance', { method: 'POST', body: { runId: state.runId, caseId: entry.id, input: entry.input },
        headers: authHeaders(plan, runtimeIdentity), signal: dependencies.signal, timeoutMs: LIVE_VALIDATION_ACCEPTANCE_TRANSPORT_TIMEOUT_MS });
      const observedCase = { caseId: entry.id, status: 'FAILED', runtimeClaimedPass: response.profilePassed === true }; cases.push(observedCase);
      try { observedCase.evidence = sanitizeLivePreviewEvidence(response.evidence); } catch { observedCase.evidenceProjection = 'unavailable'; }
      try { observedCase.observation = sanitizeLiveValidationObservation(response.observation); } catch { observedCase.observationProjection = 'unavailable'; }
      if (observedCase.evidence) observedCase.verification = verifyLivePreviewEvidence(observedCase.evidence, {
        sourceCommit: args.commitSha, approvedSourceCommit: args.commitSha, deploymentId: state.runtimeDeploymentId, moduleId: 'gaming', mode: 'live-backend-v1' });
      requireController(response.caseId === entry.id && response.profilePassed === true && response.productionChanged === false
        && response.durableWrites === 0 && canonicalHash(identityFields(response.identity)) === canonicalHash(runtimeIdentity), 'LIVE_VALIDATION_PROFILE_FAILED');
      requireController(observedCase.evidence?.caseId === entry.caseId && observedCase.verification?.status === 'PASS', 'LIVE_VALIDATION_PROFILE_EVIDENCE_FAILED');
      if (entry.expected.outcome === 'accepted') {
        const approvedSources = entry.input.candidateUrls.map(raw => { const url = new URL(raw); url.search = ''; url.hash = ''; return digest(url.toString()); });
        requireController(approvedSources.length > 0 && observedCase.evidence.result.sources.some(source => source.usable === true
          && approvedSources.includes(source.documentUrlSha256)), 'LIVE_VALIDATION_SUPPLIED_SOURCE_BINDING_FAILED');
      }
      assertProfileObservation(observedCase.observation, entry.expected);
      const usage = sanitizeLiveValidationUsage(await runJson('/usage'), { plan, target });
      const providerCalls = usage.providerCalls - priorUsage.providerCalls; const generationCalls = usage.generationCalls - priorUsage.generationCalls;
      const auditCalls = usage.auditCalls - priorUsage.auditCalls;
      requireController(providerCalls >= 0 && generationCalls >= 0 && auditCalls >= 0
        && (entry.expected.providerCalls === 0 ? providerCalls === 0 && generationCalls === 0 && auditCalls === 0
          : generationCalls > 0 && auditCalls > 0), 'LIVE_VALIDATION_ACTUAL_PROVIDER_USAGE_FAILED');
      Object.assign(observedCase, { status: 'PASS', actualUsage: { providerCalls, generationCalls, auditCalls } }); priorUsage = usage; actualUsage = usage;
    }
    requireController(priorUsage.workflows === 2, 'LIVE_VALIDATION_WORKFLOW_COUNT_FAILED'); state.completed = true; writeState(state);
    summary = { version: SUMMARY_VERSION, status: 'PASS', code: 'LIVE_VALIDATION_ACCEPTANCE_PASS', ...localGate,
      runId: state.runId, prNumber: args.prNumber, runtimeIdentity, cases, actualUsage, productionChanged: false, durableWrites: 0,
      paidElapsedMs: Math.max(0, now() - paidStarted), elapsedMs: Math.max(0, now() - started) };
  } catch (error) {
    let usageReadback = 'unavailable';
    if (plan && state.runStarted) try { actualUsage = sanitizeLiveValidationUsage(await serviceJson(runtime, '/usage', { headers: authHeaders(plan, runtimeIdentity) }), { plan, target }); usageReadback = 'PASS'; } catch { /* Preserve original failure. */ }
    summary = { version: SUMMARY_VERSION, status: cases.length > 0 ? 'FAILED' : 'BLOCKED', code: safeCode(error), ...localGate,
      runId: state.runId, prNumber: args.prNumber, elapsedMs: Math.max(0, now() - started), observedCases: cases,
      ...(runtimeIdentity ? { runtimeIdentity } : {}), ...(actualUsage ? { actualUsage } : {}), usageReadback };
  } finally {
    cleanup = await cleanupLiveValidationRun({ target, args, state, railway, runtime, writeState, now, sleep });
    protectedWrite(path.join(directory, 'cleanup-summary.json'), cleanup);
  }
  if (cleanup.status !== 'PASS' && summary.status === 'PASS') { summary.status = 'BLOCKED'; summary.code = 'LIVE_VALIDATION_CLEANUP_BLOCKED'; }
  summary.cleanup = cleanup;
  if (publicEvidenceContainsSession(summary, [testToken].filter(value => typeof value === 'string'))) {
    summary = { version: SUMMARY_VERSION, status: 'FAILED', code: 'LIVE_VALIDATION_EVIDENCE_SECRET_REJECTED', ...localGate, runId: state.runId, prNumber: args.prNumber, cleanup };
  }
  protectedWrite(path.join(directory, 'acceptance-summary.json'), summary); return { ...summary, evidenceSha256: canonicalHash(summary) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const abort = new AbortController(); const cancel = () => abort.abort(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const result = await runLiveValidationController(process.argv.slice(2), { signal: abort.signal });
    console.log(JSON.stringify({ status: result.status, code: result.code, evidenceSha256: result.evidenceSha256 ?? canonicalHash(result) }));
    if (result.status !== 'PASS') process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ status: 'BLOCKED', code: safeCode(error) })); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}

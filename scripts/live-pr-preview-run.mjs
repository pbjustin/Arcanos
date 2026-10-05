#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createLivePreviewBroker } from './live-pr-preview-broker.mjs';
import { validateLivePreviewAdmission } from './live-pr-preview-policy.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BODY_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;
const PROVIDER_URL = 'https://api.openai.com/v1/responses';
const MODEL_URL_PREFIX = 'https://api.openai.com/v1/models/';
const RESPONSE_MODEL_POLICY_PATH = 'src/shared/gpt/generativeModelPolicyCore.ts';
const VALUES = new Set(['--approval-file', '--attestation-file', '--trust-file', '--commit-sha',
  '--claims-dir', '--session-out', '--port']);
const FLAGS = new Set(['--execute', '--allow-paid-provider']);

export class LivePreviewRunnerError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function requireRunner(condition, code) {
  if (!condition) throw new LivePreviewRunnerError(code);
}

export function parseLivePreviewRunArguments(argv) {
  const result = { execute: false, allowPaidProvider: false, port: 0 };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    requireRunner((VALUES.has(key) || FLAGS.has(key)) && !seen.has(key), 'LIVE_PREVIEW_ARGUMENT_INVALID');
    seen.add(key);
    const property = key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (FLAGS.has(key)) { result[property] = true; continue; }
    requireRunner(typeof argv[index + 1] === 'string' && !argv[index + 1].startsWith('--'), 'LIVE_PREVIEW_ARGUMENT_INVALID');
    result[property] = argv[++index];
  }
  requireRunner(['approvalFile', 'attestationFile', 'trustFile', 'commitSha'].every(key => result[key]),
    'LIVE_PREVIEW_ARGUMENT_REQUIRED');
  requireRunner(/^[0-9a-f]{40}$/u.test(result.commitSha), 'LIVE_PREVIEW_SHA_INVALID');
  requireRunner(!result.allowPaidProvider || result.execute, 'LIVE_PREVIEW_EXECUTION_FLAGS_REQUIRED');
  if (result.execute) requireRunner(result.allowPaidProvider && result.claimsDir && result.sessionOut,
    'LIVE_PREVIEW_EXECUTION_FLAGS_REQUIRED');
  requireRunner(/^(?:0|[1-9][0-9]*)$/u.test(String(result.port)) && Number(result.port) <= 65_535,
    'LIVE_PREVIEW_PORT_INVALID');
  result.port = Number(result.port);
  return result;
}

function outsideCheckout(filePath, repositoryRoot) {
  const relative = path.relative(realpathSync(repositoryRoot), filePath);
  requireRunner(relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'LIVE_PREVIEW_OPERATOR_PATH_REQUIRED');
}

function protectedStat(stat, directory = false) {
  requireRunner(typeof process.getuid === 'function' && stat.uid === process.getuid()
    && (directory ? stat.isDirectory() : stat.isFile()) && (stat.mode & 0o077) === 0,
  'LIVE_PREVIEW_OPERATOR_FILE_UNSAFE');
}

/** Trust inputs are operator-owned and never read from a PR checkout. */
export function readTrustedOperatorFile(filePath, repositoryRoot = REPOSITORY_ROOT) {
  requireRunner(path.isAbsolute(filePath), 'LIVE_PREVIEW_OPERATOR_PATH_REQUIRED');
  protectedDirectory(path.dirname(filePath), repositoryRoot);
  requireRunner(!lstatSync(filePath).isSymbolicLink(), 'LIVE_PREVIEW_OPERATOR_FILE_UNSAFE');
  outsideCheckout(realpathSync(filePath), repositoryRoot);
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    protectedStat(stat);
    requireRunner(stat.size > 0 && stat.size <= BODY_LIMIT, 'LIVE_PREVIEW_OPERATOR_FILE_INVALID');
    return readFileSync(descriptor, 'utf8');
  } finally { closeSync(descriptor); }
}

function protectedDirectory(directory, repositoryRoot) {
  requireRunner(path.isAbsolute(directory), 'LIVE_PREVIEW_OPERATOR_PATH_REQUIRED');
  requireRunner(!lstatSync(directory).isSymbolicLink(), 'LIVE_PREVIEW_OPERATOR_FILE_UNSAFE');
  const resolved = realpathSync(directory);
  outsideCheckout(resolved, repositoryRoot);
  protectedStat(lstatSync(resolved), true);
  return resolved;
}

function verifyOutputPath(filePath, repositoryRoot) {
  requireRunner(path.isAbsolute(filePath), 'LIVE_PREVIEW_OPERATOR_PATH_REQUIRED');
  const directory = protectedDirectory(path.dirname(filePath), repositoryRoot);
  const output = path.join(directory, path.basename(filePath));
  try { lstatSync(output); throw new LivePreviewRunnerError('LIVE_PREVIEW_SESSION_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return output;
}

function writeExclusiveProtectedFile(filePath, data) {
  const descriptor = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(descriptor, data, 'utf8'); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  const directory = openSync(path.dirname(filePath), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/** O_EXCL + fsync provides a fail-closed, durable single-use approval claim. */
export function claimLivePreviewApprovalOnce(claimsDirectory, approvalId, repositoryRoot = REPOSITORY_ROOT) {
  requireRunner(/^[a-zA-Z0-9_-]{16,128}$/u.test(approvalId), 'LIVE_PREVIEW_APPROVAL_ID_INVALID');
  const directory = protectedDirectory(claimsDirectory, repositoryRoot);
  try { writeExclusiveProtectedFile(path.join(directory, approvalId + '.claim'), 'claimed\n'); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw new LivePreviewRunnerError('LIVE_PREVIEW_CLAIM_FAILED'); }
}

/** Git inspects trusted code only, with no provider credential inherited by the subprocess. */
export function readTrustedRunnerGitState(repositoryRoot = REPOSITORY_ROOT, spawn = spawnSync) {
  const git = args => {
    const result = spawn('git', ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', ...args], {
      cwd: repositoryRoot, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 5_000,
      maxBuffer: 128 * 1024,
    });
    requireRunner(result.status === 0, 'LIVE_PREVIEW_TRUSTED_CHECKOUT_INVALID');
    return result.stdout.trim();
  };
  const root = git(['rev-parse', '--show-toplevel']);
  const head = git(['rev-parse', 'HEAD']);
  const remote = git(['config', '--get', 'remote.origin.url']);
  const status = git(['status', '--porcelain', '--untracked-files=all']);
  requireRunner(realpathSync(root) === realpathSync(repositoryRoot)
    && remote === 'https://github.com/pbjustin/Arcanos.git' && /^[0-9a-f]{40}$/u.test(head) && status === '',
  'LIVE_PREVIEW_TRUSTED_CHECKOUT_INVALID');
  return { root, head, clean: true, repository: 'pbjustin/Arcanos' };
}

/** Load only the reviewed pure policy blob at the already verified trusted runner revision. */
export async function loadTrustedResponseModelIdentity(repositoryRoot, trustedRunnerSha, spawn = spawnSync) {
  requireRunner(/^[0-9a-f]{40}$/u.test(trustedRunnerSha), 'LIVE_PREVIEW_TRUSTED_REVISION_MISMATCH');
  const result = spawn('git', ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', 'show',
    `${trustedRunnerSha}:${RESPONSE_MODEL_POLICY_PATH}`], {
    cwd: repositoryRoot, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 5_000,
    maxBuffer: 128 * 1024,
  });
  requireRunner(result.status === 0 && typeof result.stdout === 'string' && result.stdout.length > 0,
    'LIVE_PREVIEW_MODEL_POLICY_LOAD_FAILED');
  const source = result.stdout;
  // Conservative by design: the shared core is self-contained. New dependencies require review.
  requireRunner(!/\b(?:import|require|process|globalThis|global|fetch|eval|Function|module|exports|Deno|Bun)\b|\bexport\s*(?:\*|\{)/u.test(source),
    'LIVE_PREVIEW_MODEL_POLICY_DEPENDENCY_FORBIDDEN');
  try {
    const transformed = stripTypeScriptTypes(source, { mode: 'transform' });
    const policy = await import('data:text/javascript;base64,' + Buffer.from(transformed).toString('base64'));
    requireRunner(typeof policy.assertGenerativeModelResponseIdentity === 'function', 'LIVE_PREVIEW_MODEL_POLICY_LOAD_FAILED');
    return policy.assertGenerativeModelResponseIdentity;
  } catch (error) {
    if (error instanceof LivePreviewRunnerError) throw error;
    throw new LivePreviewRunnerError('LIVE_PREVIEW_MODEL_POLICY_LOAD_FAILED');
  }
}

function constantTimeBearer(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual); const right = Buffer.from('Bearer ' + expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  requireRunner(request.headers['content-type'] === 'application/json', 'LIVE_PREVIEW_CONTENT_TYPE_INVALID');
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    requireRunner(bytes <= BODY_LIMIT, 'LIVE_PREVIEW_BODY_LIMIT');
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new LivePreviewRunnerError('LIVE_PREVIEW_BODY_INVALID'); }
  requireRunner(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'LIVE_PREVIEW_BODY_INVALID');
  return parsed;
}

function readRequestTimeoutMs(request, admission) {
  const rawTimeout = request.headers['x-arcanos-request-timeout-ms'];
  const maxTimeout = Math.min(120_000, admission.approval.limits.durationMs);
  const timeoutMs = rawTimeout === undefined ? maxTimeout : Number(rawTimeout);
  requireRunner(rawTimeout === undefined || (/^[1-9][0-9]*$/u.test(rawTimeout)
    && Number.isSafeInteger(timeoutMs) && timeoutMs <= maxTimeout), 'LIVE_PREVIEW_DURATION_LIMIT');
  return timeoutMs;
}

/** The trusted runner serves only a loopback broker; a private TLS tunnel is configured separately. */
export function createBrokerHttpApplication({ broker, session, admission }) {
  return async (request, response) => {
    const controller = new AbortController();
    response.once('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      requireRunner(constantTimeBearer(request.headers.authorization, session.brokerBearer), 'LIVE_PREVIEW_IDENTITY_UNAUTHORIZED');
      requireRunner(Date.now() < session.expiresAtMs, 'LIVE_PREVIEW_APPROVAL_EXPIRED');
      requireRunner(request.headers['x-arcanos-source-commit'] === admission.approval.commitSha
        && request.headers['x-arcanos-deployment-id'] === admission.approval.deployment.deploymentId,
      'LIVE_PREVIEW_DEPLOYMENT_MISMATCH');
      if (request.method === 'GET' && request.url === '/usage') {
        sendJson(response, 200, broker.evidence());
        return;
      }
      if (request.method === 'GET' && request.url === '/session') {
        sendJson(response, 200, { version: 1, sourceCommit: admission.approval.commitSha,
          approvedSourceCommit: admission.approval.commitSha, deploymentId: admission.approval.deployment.deploymentId,
          projectId: admission.approval.deployment.projectId, environmentId: admission.approval.deployment.environmentId,
          serviceId: admission.approval.deployment.serviceId,
          backendOrigin: admission.attestation.backendOrigin, brokerOrigin: admission.attestation.brokerOrigin,
          environmentName: admission.approval.deployment.environmentName, prNumber: admission.approval.prNumber,
          moduleIds: admission.approval.moduleIds,
          mode: 'live-backend-v1', expiresAtMs: session.expiresAtMs, limits: admission.approval.limits,
          models: admission.approval.models, testBearer: session.testBearer,
          requestTimeoutMs: Math.min(120_000, admission.approval.limits.durationMs) });
        return;
      }
      if (request.method === 'GET' && request.url.startsWith('/v1/models/')) {
        const moduleId = request.headers['x-arcanos-live-module'];
        requireRunner(admission.approval.moduleIds.includes(moduleId), 'LIVE_PREVIEW_MODULE_UNAPPROVED');
        const encodedId = request.url.slice('/v1/models/'.length);
        let id;
        try { id = decodeURIComponent(encodedId); } catch { throw new LivePreviewRunnerError('LIVE_PREVIEW_MODEL_UNAPPROVED'); }
        requireRunner(encodeURIComponent(id) === encodedId && admission.approval.models.some(model => model.id === id),
          'LIVE_PREVIEW_MODEL_UNAPPROVED');
        const result = await broker.retrieveModel(id, session.brokerBearer, { signal: controller.signal, moduleId,
          timeoutMs: readRequestTimeoutMs(request, admission) });
        sendJson(response, 200, result);
        return;
      }
      requireRunner(request.method === 'POST' && request.url === '/v1/responses', 'LIVE_PREVIEW_ROUTE_FORBIDDEN');
      const moduleId = request.headers['x-arcanos-live-module'];
      requireRunner(admission.approval.moduleIds.includes(moduleId), 'LIVE_PREVIEW_MODULE_UNAPPROVED');
      const stage = request.headers['x-arcanos-live-stage'];
      requireRunner(stage === 'generation' || stage === 'answer_audit', 'LIVE_PREVIEW_STAGE_INVALID');
      const timeoutMs = readRequestTimeoutMs(request, admission);
      const body = await readBody(request);
      const result = await broker.invoke(body, session.brokerBearer, { signal: controller.signal,
        stage: stage === 'generation' ? 'model_generation' : 'answer_audit', timeoutMs, moduleId });
      sendJson(response, 200, result);
    } catch (error) {
      const code = typeof error.code === 'string' && /^LIVE_PREVIEW_[A-Z_]+$/u.test(error.code)
        ? error.code : 'LIVE_PREVIEW_REQUEST_FAILED';
      sendJson(response, code === 'LIVE_PREVIEW_IDENTITY_UNAUTHORIZED' ? 401 : 403, { error: { code } });
    }
  };
}

/** No redirects, alternate URLs, streaming, request retries or provider error bodies escape this adapter. */
export function createOpenAiResponsesTransport(fetchImplementation = globalThis.fetch) {
  return async ({ url, method = 'POST', headers, body, signal }) => {
    let metadataUrl = false;
    if (typeof url === 'string' && url.startsWith(MODEL_URL_PREFIX)) {
      try {
        const id = decodeURIComponent(url.slice(MODEL_URL_PREFIX.length));
        metadataUrl = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(id)
          && url === MODEL_URL_PREFIX + encodeURIComponent(id);
      } catch { /* Reject alternate paths or encodings. */ }
    }
    requireRunner((method === 'POST' && url === PROVIDER_URL) || (method === 'GET' && metadataUrl),
      'LIVE_PREVIEW_PROVIDER_URL_FORBIDDEN');
    const result = await fetchImplementation(url, { method, headers,
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}), signal, redirect: 'error' });
    requireRunner(result.status >= 200 && result.status < 300, 'LIVE_PREVIEW_PROVIDER_FAILED');
    const chunks = []; let bytes = 0;
    for await (const chunk of result.body) {
      bytes += chunk.length;
      requireRunner(bytes <= RESPONSE_LIMIT, 'LIVE_PREVIEW_PROVIDER_RESPONSE_LIMIT');
      chunks.push(Buffer.from(chunk));
    }
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new LivePreviewRunnerError('LIVE_PREVIEW_PROVIDER_RESPONSE_INVALID'); }
    return { status: result.status, body: parsed };
  };
}

/** Does not execute, check out, import or build the PR revision. Default invocation is offline validation. */
export async function runLivePreviewSupervisor(argv, dependencies = {}) {
  const args = parseLivePreviewRunArguments(argv);
  const repositoryRoot = dependencies.repositoryRoot ?? REPOSITORY_ROOT;
  const readOperatorFile = dependencies.readOperatorFile ?? readTrustedOperatorFile;
  const parseFile = file => {
    try { return JSON.parse(readOperatorFile(file, repositoryRoot)); }
    catch (error) { if (error instanceof LivePreviewRunnerError) throw error;
      throw new LivePreviewRunnerError('LIVE_PREVIEW_OPERATOR_FILE_INVALID'); }
  };
  const trust = parseFile(args.trustFile);
  const signedApproval = parseFile(args.approvalFile);
  const attestation = parseFile(args.attestationFile);
  requireRunner(trust && Object.keys(trust).length === 3 && typeof trust.approvalPublicKey === 'string'
    && /^[0-9a-f]{40}$/u.test(trust.trustedRunnerSha), 'LIVE_PREVIEW_TRUST_INVALID');
  const git = (dependencies.readGitState ?? readTrustedRunnerGitState)(repositoryRoot);
  requireRunner(git.clean === true && git.repository === 'pbjustin/Arcanos' && git.head === trust.trustedRunnerSha,
    'LIVE_PREVIEW_TRUSTED_REVISION_MISMATCH');
  requireRunner(signedApproval.approval?.commitSha === args.commitSha, 'LIVE_PREVIEW_SHA_MISMATCH');
  const admission = validateLivePreviewAdmission({ enabled: true, signedApproval,
    trustedApprovalPublicKey: trust.approvalPublicKey, attestation, trustedIsolation: trust.trustedIsolation });
  const evidence = { mode: 'live-backend-v1', executed: args.execute, providerInvoked: false,
    trustedRunnerSha: git.head, sourceCommit: admission.approval.commitSha,
    deploymentId: admission.approval.deployment.deploymentId, approvalValidated: true,
    syntheticPreviewSuccess: null, liveBackendSuccess: null, installedPluginOAuthSuccess: null };
  if (!args.execute) return evidence;

  const claimsDirectory = protectedDirectory(args.claimsDir, repositoryRoot);
  const sessionPath = verifyOutputPath(args.sessionOut, repositoryRoot);
  const responseModelIdentity = await (dependencies.loadResponseModelIdentity ?? loadTrustedResponseModelIdentity)(repositoryRoot, git.head);
  const broker = (dependencies.createBroker ?? createLivePreviewBroker)({ admission,
    responseModelIdentity,
    claimRun: approvalId => claimLivePreviewApprovalOnce(claimsDirectory, approvalId, repositoryRoot),
    resolveCredential: () => {
      const credential = (dependencies.environment ?? process.env).ARCANOS_LIVE_PREVIEW_OPENAI_API_KEY;
      requireRunner(typeof credential === 'string' && credential.length >= 20, 'LIVE_PREVIEW_CREDENTIAL_REQUIRED');
      return credential;
    },
    invokeProvider: dependencies.invokeProvider ?? createOpenAiResponsesTransport(),
  });
  const session = await broker.authorizeRun();
  const server = (dependencies.createServer ?? createServer)(createBrokerHttpApplication({ broker, session, admission }));
  server.requestTimeout = 10_000; server.headersTimeout = 5_000; server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', () => reject(new LivePreviewRunnerError('LIVE_PREVIEW_BROKER_LISTEN_FAILED')));
      server.listen(args.port, '127.0.0.1', resolve);
    });
  } catch (error) { broker.close(); server.close(); throw error; }
  const address = server.address();
  evidence.listenerOrigin = `http://127.0.0.1:${address.port}`;
  try {
    writeExclusiveProtectedFile(sessionPath, JSON.stringify({ version: 1, mode: 'live-backend-v1',
      sourceCommit: admission.approval.commitSha, approvedSourceCommit: admission.approval.commitSha,
      deploymentId: admission.approval.deployment.deploymentId, projectId: admission.approval.deployment.projectId,
      environmentId: admission.approval.deployment.environmentId, limits: admission.approval.limits,
      serviceId: admission.approval.deployment.serviceId,
      models: admission.approval.models, prNumber: admission.approval.prNumber,
      moduleIds: admission.approval.moduleIds,
      environmentName: admission.approval.deployment.environmentName,
      requestTimeoutMs: Math.min(120_000, admission.approval.limits.durationMs),
      backendOrigin: admission.attestation.backendOrigin, brokerOrigin: admission.attestation.brokerOrigin,
      listenerOrigin: evidence.listenerOrigin, ...session }) + '\n');
  } catch { broker.close(); server.close(); server.closeAllConnections();
    throw new LivePreviewRunnerError('LIVE_PREVIEW_SESSION_WRITE_FAILED'); }
  const completed = new Promise(resolve => {
    const timer = setTimeout(() => {
      broker.close();
      server.close(); server.closeAllConnections();
      resolve({ ...evidence, providerInvoked: broker.evidence().usage?.requests > 0,
        broker: broker.evidence() });
    }, Math.max(1, session.expiresAtMs - Date.now()));
    server.once('close', () => { clearTimeout(timer); broker.close();
      resolve({ ...evidence, providerInvoked: broker.evidence().usage?.requests > 0, broker: broker.evidence() }); });
  });
  return { evidence, completed, close: () => { broker.close(); server.close(); server.closeAllConnections(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await runLivePreviewSupervisor(process.argv.slice(2));
    console.log(JSON.stringify(result.evidence ?? result));
    if (result.completed) console.log(JSON.stringify(await result.completed));
  } catch (error) {
    const code = typeof error.code === 'string' && /^LIVE_PREVIEW_[A-Z_]+$/u.test(error.code)
      ? error.code : 'LIVE_PREVIEW_RUN_FAILED';
    console.error(JSON.stringify({ mode: 'live-backend-v1', executed: false, error: code }));
    process.exitCode = 1;
  }
}

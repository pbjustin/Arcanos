#!/usr/bin/env node
// Local disposable image validation only. It has no Railway or publication authority.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateGamingBuildReceipt, verifyImageArchive } from './stacked-draft-preview-build.mjs';
import { buildGamingScopedPreviewAssertionInventory, runGamingScopedPreviewE2e } from './gaming-scoped-preview-e2e.mjs';
import { resolveNativePrPreviewOrThrow } from './start-railway-service.mjs';

const requireCondition = (value, code) => { if (!value) throw new Error(`GAMING_IMAGE_SMOKE_${code}`); };
const nativeFetch = globalThis.fetch;
// This is the frozen launcher's accepted UUID contract, including version and
// variant. Broad UUID-shaped test strings must not reach container startup.
const NATIVE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TRANSPORT_ERROR_NAMES = new Set(['Error', 'TypeError', 'AbortError', 'TimeoutError']);
const TRANSPORT_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EACCES', 'EPERM', 'ENETUNREACH',
  'EHOSTUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_CLOSED', 'UND_ERR_DESTROYED', 'UND_ERR_HEADERS_OVERFLOW',
  'UND_ERR_INVALID_ARG', 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'HPE_INVALID_HEADER_TOKEN', 'HPE_UNEXPECTED_CONTENT_LENGTH', 'ERR_INVALID_URL', 'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_STATE', 'ERR_HTTP_INVALID_HEADER_VALUE', 'ERR_HTTP_INVALID_STATUS_CODE', 'ERR_INVALID_CHAR',
  'ERR_SOCKET_CLOSED', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE']);
function executeDocker(program, args, options) {
  const result = spawnSync(program, args, options);
  requireCondition(result.status === 0 && !result.error, 'DOCKER_COMMAND_FAILED');
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}
function readJson(file) {
  const stat = lstatSync(file);
  requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 128 * 1024, 'INPUT_INVALID');
  return JSON.parse(readFileSync(file, 'utf8'));
}

export async function runGamingImageSmoke({ authorizationFile, buildFile, imageFile, outputFile,
  environment = process.env, execute = executeDocker, fetchLocal = nativeFetch,
  verify = runGamingScopedPreviewE2e, monotonicNow = () => performance.now(),
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }) {
  const evidence = { kind: 'gaming_local_image_synthetic_smoke', GAMING_SCOPED_PREVIEW: 'NOT_RUN',
    hostedExecuted: false, status: 'FAIL', executedAssertions: 0, requestsAttempted: 0, kernelEntrypointVerified: {},
    cleanup: { verifiedAbsent: false }, realExternalSourceAcceptance: 'NOT_PROVEN', modelGeneratedGameplayAnswers: 'NOT_PROVEN' };
  const owned = [];
  const trustedInventory = new Set(buildGamingScopedPreviewAssertionInventory());
  const cleanEnvironment = Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG'].filter(key => typeof environment[key] === 'string')
    .map(key => [key, environment[key]]));
  const docker = args => execute('docker', ['--host=unix:///var/run/docker.sock', ...args], {
    env: cleanEnvironment, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  let failure;
  try {
    requireCondition(['GITHUB_TOKEN', 'GH_TOKEN', 'GHCR_TOKEN', 'RAILWAY_API_TOKEN', 'RAILWAY_TOKEN',
      'OPENAI_API_KEY', 'NOTION_API_KEY', 'NOTION_TOKEN', 'DATABASE_URL', 'REDIS_URL'].every(key => !environment[key]), 'CREDENTIALS_FORBIDDEN');
    const authorization = readJson(authorizationFile), build = readJson(buildFile);
    validateGamingBuildReceipt(build, authorization);
    verifyImageArchive(imageFile, build, authorization);
    requireCondition(Object.values(authorization.target).every(value => NATIVE_UUID.test(value)), 'RUNTIME_IDENTITY_INVALID');
    evidence.imageId = build.imageId; evidence.candidateSha = build.candidateSha;
    const origins = {}, loopback = {};
    for (const [index, role] of ['worker', 'web'].entries()) {
      const owner = randomUUID();
      const name = `gaming-smoke-${authorization.runId}-${role}-${owner.slice(0, 8)}`;
      requireCondition(docker(['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']) === '', 'CONTAINER_NAME_COLLISION');
      const labels = { 'io.arcanos.gaming-smoke.owner': owner, 'io.arcanos.gaming-smoke.run': authorization.runId,
        'io.arcanos.gaming-smoke.head': build.candidateSha, 'io.arcanos.gaming-smoke.image': build.imageId };
      const ownership = { name, labels, imageId: build.imageId, id: null, role };
      owned.push(ownership);
      const publicDomain = `${role}-${build.runtimeEnvironmentName}.up.railway.app`;
      origins[role] = `https://${publicDomain}`;
      const variables = { NODE_ENV: 'production', PORT: '8080', ARCANOS_PROCESS_KIND: role,
        RAILWAY_PROJECT_ID: authorization.target.projectId,
        RAILWAY_ENVIRONMENT_ID: '00000005-0000-4000-8000-000000000005',
        RAILWAY_ENVIRONMENT_NAME: build.runtimeEnvironmentName,
        RAILWAY_SERVICE_ID: authorization.target[`${role}ServiceId`],
        RAILWAY_DEPLOYMENT_ID: `0000000${index + 6}-0000-4000-8000-00000000000${index + 6}`,
        RAILWAY_PUBLIC_DOMAIN: publicDomain };
      const preview = resolveNativePrPreviewOrThrow(['--pr-preview-app-safe-v1'],
        { ...variables, RAILWAY_GIT_COMMIT_SHA: build.candidateSha });
      requireCondition(preview.enabled === true && preview.prNumber === 1558
        && preview.processKind === role && preview.sourceCommit === build.candidateSha, 'RUNTIME_IDENTITY_INVALID');
      // Image entrypoint and nonroot USER remain intact. No host mounts or
      // credential environment are passed; kernel seccomp precedes Node startup.
      const id = docker(['run', '--detach', '--pull=never', '--name', name, '--memory=512m', '--cpus=0.5', '--pids-limit=64',
        '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
        '--publish', '127.0.0.1::8080', ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
        ...Object.entries(variables).flatMap(([key, value]) => ['--env', `${key}=${value}`]), build.imageId]);
      requireCondition(/^[0-9a-f]{64}$/u.test(id), 'CONTAINER_ID_INVALID');
      ownership.id = id;
      const port = /^127\.0\.0\.1:([0-9]{1,5})$/u.exec(docker(['port', name, '8080/tcp']));
      requireCondition(port && Number(port[1]) > 0 && Number(port[1]) <= 65535, 'LOOPBACK_PORT_INVALID');
      loopback[role] = `http://127.0.0.1:${port[1]}`;
      const started = monotonicNow(); let ready = false;
      while (monotonicNow() - started < 30_000) {
        try {
          const response = await fetchLocal(`${loopback[role]}/readyz`, {
            redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(2000),
          });
          try { ready = response.status === 200 && response.redirected === false; }
          finally { void response.body?.cancel().catch(() => {}); }
          if (ready) break;
        } catch { /* Startup is bounded; no retry occurs inside the 84-case verifier. */ }
        await delay(100);
      }
      requireCondition(ready, 'READINESS_DEADLINE');
      // The marker precedes the protected gate's multi-line receipt. Retain
      // the start of the log under the unchanged 1 MiB command output cap;
      // a last-lines projection can discard the required entrypoint evidence.
      evidence.kernelEntrypointVerified[role] = /GAMING_PREVIEW_KERNEL_NETWORK_BOUNDARY=ENFORCED/u
        .test(docker(['logs', name]));
      requireCondition(evidence.kernelEntrypointVerified[role], 'KERNEL_ENTRYPOINT_UNVERIFIED');
    }
    let requests = 0;
    const fetchMapped = async (url, init) => {
      const parsed = new URL(url);
      const role = ['web', 'worker'].find(value => parsed.origin === origins[value]);
      requireCondition(role && parsed.protocol === 'https:' && !parsed.username && !parsed.password, 'OUTBOUND_ORIGIN_FORBIDDEN');
      const local = new URL(`${parsed.pathname}${parsed.search}`, loopback[role]);
      requireCondition(local.origin === loopback[role] && local.hostname === '127.0.0.1', 'LOOPBACK_TARGET_INVALID');
      requests++;
      evidence.requestsAttempted = Math.min(requests, 85);
      const requestStarted = monotonicNow();
      const elapsedMs = () => Math.max(0, Math.min(60_000, Math.round(monotonicNow() - requestStarted)));
      // The trusted wrapper can reject its abort race before an underlying
      // fetch rejection settles. Record the signal synchronously so cleanup
      // cannot precede the only useful timeout classification.
      const onAbort = () => { evidence.transportFailure = { role, elapsedMs: elapsedMs(),
        errorName: 'AbortError', causeCode: null, signalAborted: true }; };
      if (init?.signal?.aborted) onAbort();
      else init?.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await fetchLocal(local.href, { ...init, credentials: 'omit', redirect: 'error' });
        requireCondition(response.redirected === false, 'REDIRECT_FORBIDDEN');
        const mapped = new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
        Object.defineProperties(mapped, { url: { value: parsed.href }, redirected: { value: false } });
        return mapped;
      } catch (error) {
        evidence.transportFailure = { role, elapsedMs: elapsedMs(),
          errorName: TRANSPORT_ERROR_NAMES.has(error?.name) ? error.name : 'UnknownError',
          causeCode: TRANSPORT_ERROR_CODES.has(error?.cause?.code) ? error.cause.code : null,
          signalAborted: init?.signal?.aborted === true };
        throw error;
      } finally { init?.signal?.removeEventListener('abort', onAbort); }
    };
    const report = await verify({ args: ['--pr-number', '1558', '--commit-sha', build.candidateSha,
      '--web-base-url', origins.web, '--worker-base-url', origins.worker, '--execute', '--allow-network'],
    localGitState: { repository: 'pbjustin/Arcanos', head: build.candidateSha, clean: true, sourceTreeSha: build.treeSha },
    fetchImpl: fetchMapped });
    requireCondition(report.GAMING_SCOPED_PREVIEW === 'NOT_RUN' && report.hostedExecuted !== true
      && report.summary.requestsMade === 84 && requests === 84
      && report.assertionInventory.plannedCaseIds.length === 84 && report.assertionInventory.executedCaseIds.length === 84
      && JSON.stringify(report.assertionInventory.plannedCaseIds) === JSON.stringify(report.assertionInventory.executedCaseIds), 'INVENTORY_INCOMPLETE');
    evidence.executedAssertions = 84; evidence.status = 'PASS';
    evidence.assertionInventory = report.assertionInventory;
  } catch (error) {
    failure = error;
    evidence.errorCode = /^[A-Z0-9_]+$/u.test(error?.code ?? error?.message ?? '') ? error.code ?? error.message : 'GAMING_IMAGE_SMOKE_FAILED';
    const failedCaseId = [error?.caseId, `native:${error?.caseId}`, `mcp:${error?.caseId}`]
      .find(value => trustedInventory.has(value));
    if (failedCaseId) evidence.failedCaseId = failedCaseId;
    // Retain a small fixed diagnostic projection before removing a failed
    // runtime. Raw logs, environment and arbitrary container data stay private.
    evidence.startupDiagnostics = {};
    for (const owner of owned) {
      try {
        const container = JSON.parse(docker(['inspect', '--type', 'container', '--format', '{{json .}}', owner.name]));
        const logs = docker(['logs', owner.name]);
        const states = ['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'];
        evidence.startupDiagnostics[owner.role] = {
          state: states.includes(container.State?.Status) ? container.State.Status : 'unknown',
          exitCode: Number.isSafeInteger(container.State?.ExitCode) ? container.State.ExitCode : null,
          oomKilled: container.State?.OOMKilled === true,
          kernelBoundaryMarker: /GAMING_PREVIEW_KERNEL_NETWORK_BOUNDARY=ENFORCED/u.test(logs),
          observedCodes: [...new Set(logs.match(/\b(?:PREVIEW_(?:ISOLATION|APPLICATION)_[A-Z0-9_]+|GAMING_PREVIEW_(?:RUNTIME|KERNEL)_[A-Z0-9_]+|EPERM|EACCES|EADDRINUSE|ENOMEM)\b/gu) ?? [])].slice(0, 16),
        };
      } catch { evidence.startupDiagnostics[owner.role] = { available: false }; }
    }
  } finally {
    const failures = [];
    for (const owner of owned.reverse()) {
      try {
        let container;
        try { container = JSON.parse(docker(['inspect', '--type', 'container', '--format', '{{json .}}', owner.name])); }
        catch {
          requireCondition(docker(['ps', '--all', '--filter', `name=^/${owner.name}$`, '--format', '{{.ID}}']) === '', 'CLEANUP_OWNERSHIP_UNVERIFIED');
          continue;
        }
        requireCondition(/^[0-9a-f]{64}$/u.test(container?.Id ?? '') && container.Name === `/${owner.name}`
          && container.Image === owner.imageId && (!owner.id || container.Id === owner.id)
          && Object.entries(owner.labels).every(([key, value]) => container.Config?.Labels?.[key] === value), 'CLEANUP_OWNERSHIP_UNVERIFIED');
        // Delete by immutable container ID only after independently checking
        // exact labels and image identity, including partial-create recovery.
        try { docker(['rm', '--force', container.Id]); } catch { /* Independently verify actual absence below. */ }
        requireCondition(docker(['ps', '--all', '--filter', `id=${container.Id}`, '--format', '{{.ID}}']) === '', 'CLEANUP_UNVERIFIED');
      } catch { failures.push(owner.name); }
    }
    evidence.cleanup = { verifiedAbsent: failures.length === 0, ownedContainers: owned.length };
    if (failures.length > 0) { evidence.status = 'FAIL'; failure = new Error('GAMING_IMAGE_SMOKE_CLEANUP_UNVERIFIED'); }
    if (outputFile) writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  if (failure) throw failure;
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [authorizationFile, buildFile, imageFile, outputFile] = process.argv.slice(2);
  try {
    requireCondition(process.argv.length === 6, 'ARGUMENT_INVALID');
    const result = await runGamingImageSmoke({ authorizationFile, buildFile, imageFile, outputFile });
    console.log(JSON.stringify({ status: result.status, executedAssertions: result.executedAssertions,
      GAMING_SCOPED_PREVIEW: 'NOT_RUN', hostedExecuted: false, cleanupVerified: result.cleanup.verifiedAbsent }));
  } catch { console.error('GAMING_IMAGE_SMOKE_FAILED'); process.exitCode = 1; }
}

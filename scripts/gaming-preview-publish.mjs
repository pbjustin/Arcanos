#!/usr/bin/env node
// Publication consumes data only. Never start an image in this credentialed job.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateGamingBuildReceipt, verifyImageArchive } from './stacked-draft-preview-build.mjs';

const repository = 'ghcr.io/pbjustin/arcanos-gaming-preview';
const requireCondition = (value, code) => { if (!value) throw new Error(`GAMING_PUBLISH_${code}`); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_PACKAGE_TIMEOUT_MS = 15_000;

function cancelWithoutWaiting(value) {
  try { void Promise.resolve(value?.cancel()).catch(() => {}); }
  catch { /* A caller-owned transport cannot keep publication waiting. */ }
}

async function withPackageDeadline(value, signal) {
  let onAbort;
  try {
    const result = await Promise.race([Promise.resolve(value), new Promise((_, reject) => {
      onAbort = () => reject(new Error('GAMING_PUBLISH_PACKAGE_DEADLINE'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    })]);
    requireCondition(!signal.aborted, 'PACKAGE_DEADLINE');
    return result;
  } catch (error) {
    if (signal.aborted) throw new Error('GAMING_PUBLISH_PACKAGE_DEADLINE');
    throw error;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function readPrivatePackage({ fetchImpl, token, timeoutMs }) {
  const signal = AbortSignal.timeout(timeoutMs);
  const transport = Promise.resolve().then(() => {
    requireCondition(!signal.aborted, 'PACKAGE_DEADLINE');
    // The user-named endpoint is documented for public package metadata.
    // Keep this authenticated-owner request and validate its exact owner below.
    return fetchImpl('https://api.github.com/user/packages/container/arcanos-gaming-preview', {
      method: 'GET', redirect: 'error', signal,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
  });
  // Discard a late response after a noncooperative injected transport times out.
  transport.then(response => { if (signal.aborted) cancelWithoutWaiting(response?.body); }, () => {}).catch(() => {});
  const response = await withPackageDeadline(transport, signal);
  let reader;
  try {
    requireCondition(!signal.aborted, 'PACKAGE_DEADLINE');
    requireCondition(response.status === 200 && response.redirected === false
      && response.headers.get('content-type')?.startsWith('application/json') && response.body?.getReader, 'PRIVATE_PACKAGE_REQUIRED');
    reader = response.body.getReader(); let size = 0; const chunks = [];
    while (true) {
      requireCondition(!signal.aborted, 'PACKAGE_DEADLINE');
      const part = await withPackageDeadline(reader.read(), signal);
      if (part.done) break;
      size += part.value.length; requireCondition(size <= 16384, 'PACKAGE_RESPONSE_LIMIT'); chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    cancelWithoutWaiting(reader ?? response.body);
    try { reader?.releaseLock(); } catch { /* A pending read may still own the lock. */ }
  }
}

function read(file, limit = 128 * 1024) {
  const stat = lstatSync(file);
  requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= limit, 'FILE_INVALID');
  return readFileSync(file);
}
export async function publishGamingImage({ authorizationFile, buildFile, imageFile, sourceFile, outputFile,
  environment = process.env, fetchImpl = fetch, execute = execFileSync, now = Date.now,
  packageTimeoutMs = MAX_PACKAGE_TIMEOUT_MS }) {
  requireCondition(Number.isSafeInteger(packageTimeoutMs) && packageTimeoutMs > 0
    && packageTimeoutMs <= MAX_PACKAGE_TIMEOUT_MS, 'PACKAGE_TIMEOUT_INVALID');
  const authorization = JSON.parse(read(authorizationFile));
  const bytes = read(buildFile), receipt = JSON.parse(bytes);
  validateGamingBuildReceipt(receipt, authorization);
  verifyImageArchive(imageFile, receipt, authorization);
  requireCondition(hash(read(sourceFile, 512 * 1024 * 1024)) === authorization.sourceArchiveSha256, 'SOURCE_ARCHIVE_DRIFT');
  requireCondition(environment.GITHUB_REPOSITORY === 'pbjustin/Arcanos' && environment.GITHUB_ACTOR === 'pbjustin'
    && environment.EVENT_SENDER === 'pbjustin' && environment.GITHUB_REF === 'refs/heads/main'
    && environment.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && environment.GITHUB_WORKFLOW_REF === 'pbjustin/Arcanos/.github/workflows/railway-gaming-preview.yml@refs/heads/main'
    && environment.GITHUB_RUN_ATTEMPT === '1' && /^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ID)
    && authorization.runId === environment.GITHUB_RUN_ID && authorization.controllerSha === environment.CONTROLLER_SHA
    && environment.GITHUB_SHA === environment.CONTROLLER_SHA && Date.parse(authorization.expiresAt) > now(), 'AUTHORITY_INVALID');
  const token = environment.GHCR_TOKEN;
  requireCondition(typeof token === 'string' && token.length > 0 && !/[\r\n]/u.test(token), 'TOKEN_REQUIRED');
  const pkg = await readPrivatePackage({ fetchImpl, token, timeoutMs: packageTimeoutMs });
  requireCondition(pkg.name === 'arcanos-gaming-preview' && pkg.package_type === 'container' && pkg.visibility === 'private'
    && pkg.owner?.login === 'pbjustin' && Number.isSafeInteger(pkg.id) && pkg.id > 0, 'PRIVATE_PACKAGE_REQUIRED');
  const clean = { PATH: environment.PATH, HOME: environment.HOME, DOCKER_CONFIG: environment.DOCKER_CONFIG };
  const command = (args, options = {}) => execute('docker', ['--host=unix:///var/run/docker.sock', ...args], {
    env: Object.fromEntries(Object.entries(clean).filter(([, value]) => typeof value === 'string')),
    encoding: 'utf8', timeout: 300_000, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, ...options,
  }).trim();
  const tag = `${repository}:run-${authorization.runId}-1`;
  command(['load', '--input', imageFile]);
  requireCondition(command(['image', 'inspect', '--format', '{{.Id}}', receipt.imageId]) === receipt.imageId, 'IMAGE_ID_DRIFT');
  try {
    command(['login', 'ghcr.io', '--username', 'pbjustin', '--password-stdin'], { input: token });
    requireCondition(Date.parse(authorization.expiresAt) > now(), 'AUTHORIZATION_EXPIRED');
    command(['tag', receipt.imageId, tag]); command(['push', tag]);
    requireCondition(command(['image', 'inspect', '--format', '{{.Id}}', tag]) === receipt.imageId, 'IMAGE_ID_DRIFT');
    const digests = JSON.parse(command(['image', 'inspect', '--format', '{{json .RepoDigests}}', tag]));
    const matches = digests.filter(value => /^ghcr\.io\/pbjustin\/arcanos-gaming-preview@sha256:[0-9a-f]{64}$/u.test(value));
    requireCondition(matches.length === 1, 'IMAGE_DIGEST_DRIFT');
    const published = { image: matches[0], imageId: receipt.imageId, buildReceiptSha256: hash(bytes) };
    writeFileSync(outputFile, `${JSON.stringify(published)}\n`, { mode: 0o600, flag: 'wx' });
    return published;
  } finally { command(['logout', 'ghcr.io']); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [authorizationFile, buildFile, imageFile, sourceFile, outputFile] = process.argv.slice(2);
  try { await publishGamingImage({ authorizationFile, buildFile, imageFile, sourceFile, outputFile }); }
  catch (error) {
    console.error(/^(GAMING_PUBLISH_|GAMING_BUILD_|STACKED_BUILD_)[A-Z_]+$/u.test(error?.message ?? '') ? error.message : 'GAMING_PUBLISH_FAILED');
    process.exitCode = 1;
  }
}

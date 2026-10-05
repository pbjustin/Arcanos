/** Shared bootstrap for the separate validation services. Never imported by production. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { canonicalLivePreviewJson } from './live-pr-preview-policy.mjs';
import { validateLiveValidationTarget } from './live-validation-target.mjs';

export class LiveValidationBootstrapError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const requireValidation = (condition, code) => {
  if (!condition) throw new LiveValidationBootstrapError(code);
};
export const validationHash = value => createHash('sha256').update(canonicalLivePreviewJson(value)).digest('hex');
export function validationOpaqueEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Content digest includes relative paths, file lengths and bytes; symlinks fail closed. */
export function validationDirectoryHash(directory) {
  const hash = createHash('sha256');
  function visit(current, prefix) {
    for (const name of readdirSync(current).sort()) {
      const file = path.join(current, name); const relative = prefix + name; const stat = lstatSync(file);
      requireValidation(!stat.isSymbolicLink(), 'DEPLOYMENT_BUILD_SYMLINK_FORBIDDEN');
      if (stat.isDirectory()) visit(file, relative + '/');
      else {
        requireValidation(stat.isFile(), 'DEPLOYMENT_BUILD_FILE_INVALID');
        const bytes = readFileSync(file);
        hash.update(JSON.stringify([relative, bytes.length]) + '\n'); hash.update(bytes);
      }
    }
  }
  visit(directory, ''); return hash.digest('hex');
}

/** Called during a credential-empty image build on an independent exact public Git checkout. */
export function createValidationBuildManifest(repositoryRoot, expectedSha, role) {
  requireValidation(/^[0-9a-f]{40}$/u.test(expectedSha) && ['runtime', 'supervisor'].includes(role), 'DEPLOYMENT_BUILD_SHA_INVALID');
  const git = args => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: repositoryRoot, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10_000,
  }).trim();
  requireValidation(git(['rev-parse', 'HEAD']) === expectedSha
    && git(['config', '--get', 'remote.origin.url']) === 'https://github.com/pbjustin/Arcanos.git'
    && git(['status', '--porcelain', '--untracked-files=all']) === '', 'DEPLOYMENT_BUILD_SOURCE_MISMATCH');
  return { version: 1, repository: 'pbjustin/Arcanos', sourceCommit: expectedSha, role,
    treeSha: git(['rev-parse', 'HEAD^{tree}']), compiledSha256: validationDirectoryHash(path.join(repositoryRoot, 'dist')) };
}

export function validationIdentity({ target, role, environment, manifest, repositoryRoot }) {
  target = validateLiveValidationTarget(target);
  requireValidation(manifest?.version === 1 && manifest.repository === target.repository && manifest.role === role
    && /^[0-9a-f]{40}$/u.test(manifest.sourceCommit ?? '') && /^[0-9a-f]{40}$/u.test(manifest.treeSha ?? '')
    && /^[0-9a-f]{64}$/u.test(manifest.compiledSha256 ?? ''), 'DEPLOYMENT_BUILD_MANIFEST_INVALID');
  requireValidation(environment.RAILWAY_PROJECT_ID === target.projectId
    && environment.RAILWAY_ENVIRONMENT_ID === target.environmentId && environment.RAILWAY_ENVIRONMENT_NAME === 'live-validation'
    && environment.RAILWAY_SERVICE_ID === target[`${role}ServiceId`]
    && environment.RAILWAY_GIT_COMMIT_SHA === manifest.sourceCommit
    && /^[0-9a-f-]{36}$/u.test(environment.RAILWAY_DEPLOYMENT_ID ?? '')
    && (role !== 'supervisor' || manifest.sourceCommit === target.trustedSupervisorSha), 'DEPLOYMENT_IDENTITY_MISMATCH');
  requireValidation(validationDirectoryHash(path.join(repositoryRoot, 'dist')) === manifest.compiledSha256,
    'DEPLOYMENT_COMPILED_CONTENT_MISMATCH');
  return Object.freeze({ role, sourceCommit: manifest.sourceCommit, projectId: target.projectId,
    environmentId: target.environmentId, serviceId: target[`${role}ServiceId`],
    deploymentId: environment.RAILWAY_DEPLOYMENT_ID, buildManifestSha256: validationHash(manifest) });
}

/** Variables are securely delivered by Railway; materialization emits no PEM/key values. */
export function materializeValidationTls(environment, directory, repositoryRoot) {
  requireValidation(path.isAbsolute(directory), 'TLS_IDENTITY_FILE_PATH_INVALID');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory); const resolved = realpathSync(directory);
  const relative = path.relative(realpathSync(repositoryRoot), resolved);
  requireValidation(!stat.isSymbolicLink() && stat.isDirectory() && (stat.mode & 0o077) === 0
    && stat.uid === process.getuid() && (relative.startsWith('../') || path.isAbsolute(relative)), 'TLS_IDENTITY_FILE_PATH_INVALID');
  const files = {};
  for (const [property, suffix] of [['caFile', 'CA'], ['certFile', 'CERT'], ['keyFile', 'KEY']]) {
    const variable = `ARCANOS_LIVE_VALIDATION_TLS_${suffix}_PEM`; const value = environment[variable];
    requireValidation(typeof value === 'string' && value.length > 0 && value.length <= 65_536,
      'TLS_IDENTITY_BINDING_BLOCKED');
    const filename = path.join(resolved, suffix.toLowerCase() + '.pem');
    const fd = openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
    files[property] = filename;
    delete environment[variable];
  }
  return files;
}

export async function readValidationJson(request, maximumBytes = 65_536) {
  requireValidation(request.headers['content-type'] === 'application/json'
    && request.headers['content-encoding'] === undefined, 'LIVE_VALIDATION_REQUEST_INVALID');
  let bytes = 0; const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length; requireValidation(bytes <= maximumBytes, 'LIVE_VALIDATION_REQUEST_LIMIT'); chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new LiveValidationBootstrapError('LIVE_VALIDATION_REQUEST_INVALID'); }
}
export function validationJson(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
export async function startValidationHealth(port, role) {
  requireValidation(/^[1-9][0-9]{0,4}$/u.test(String(port)) && Number(port) <= 65_535 && Number(port) !== 8443,
    'LIVE_VALIDATION_HEALTH_PORT_INVALID');
  const server = createServer((request, response) => {
    validationJson(response, request.method === 'GET' && request.url === '/healthz'
      ? { ok: true, role, providerCallsEnabled: false } : { code: 'NOT_FOUND' }, request.url === '/healthz' ? 200 : 404);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(port), '::', resolve); });
  return server;
}

/** The candidate never receives a production/provider/lifecycle credential. */
export function assertValidationRoleCredentials(role, environment) {
  const forbidden = /(?:API_KEY|DATABASE|POSTGRES|^PG(?:HOST|USER|PORT|DATABASE|PASSWORD|SSLMODE)$|REDIS|NOTION|OAUTH|TOKEN|SECRET|REGISTER_KEY)/u;
  for (const name of Object.keys(environment)) {
    if (role === 'supervisor' && name === 'ARCANOS_LIVE_PREVIEW_OPENAI_API_KEY') continue;
    requireValidation(!forbidden.test(name), 'LIVE_VALIDATION_UNRELATED_CREDENTIAL_FORBIDDEN');
  }
  requireValidation(!['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'OPENAI_BASE_URL'].some(name => Object.hasOwn(environment, name)),
    'EGRESS_POLICY_AMBIENT_OVERRIDE_FORBIDDEN');
}

/** Single validation-service bootstrap. Never imported by production. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { validateLiveValidationTarget } from './live-validation-target.mjs';

export class LiveValidationBootstrapError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const requireValidation = (condition, code) => {
  if (!condition) throw new LiveValidationBootstrapError(code);
};
/** Canonical bounded JSON without evaluating getters or custom serialization. */
export function canonicalLiveValidationJson(value, depth = 0, budget = { nodes: 0 }) {
  requireValidation(depth <= 16 && ++budget.nodes <= 4096, 'LIVE_VALIDATION_JSON_INVALID');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { requireValidation(Number.isFinite(value), 'LIVE_VALIDATION_JSON_INVALID'); return JSON.stringify(value); }
  requireValidation(value && typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype), 'LIVE_VALIDATION_JSON_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors);
  requireValidation(keys.length <= 1025 && keys.every(key => typeof key === 'string'), 'LIVE_VALIDATION_JSON_INVALID');
  if (Array.isArray(value)) {
    const length = descriptors.length?.value;
    requireValidation(Number.isSafeInteger(length) && length >= 0 && length <= 1024 && keys.length === length + 1, 'LIVE_VALIDATION_JSON_INVALID');
    return '[' + Array.from({ length }, (_, index) => {
      const item = descriptors[index]; requireValidation(item?.enumerable && Object.hasOwn(item, 'value'), 'LIVE_VALIDATION_JSON_INVALID');
      return canonicalLiveValidationJson(item.value, depth + 1, budget);
    }).join(',') + ']';
  }
  return '{' + keys.sort().map(key => {
    const item = descriptors[key];
    requireValidation(item.enumerable && Object.hasOwn(item, 'value') && !['__proto__', 'constructor', 'prototype'].includes(key), 'LIVE_VALIDATION_JSON_INVALID');
    return JSON.stringify(key) + ':' + canonicalLiveValidationJson(item.value, depth + 1, budget);
  }).join(',') + '}';
}
export const validationHash = value => createHash('sha256').update(canonicalLiveValidationJson(value)).digest('hex');
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
  requireValidation(/^[0-9a-f]{40}$/u.test(expectedSha) && role === 'runtime', 'DEPLOYMENT_BUILD_SHA_INVALID');
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
  requireValidation(role === 'runtime', 'DEPLOYMENT_IDENTITY_MISMATCH');
  canonicalLiveValidationJson(manifest);
  requireValidation(manifest?.version === 1 && manifest.repository === target.repository && manifest.role === role
    && /^[0-9a-f]{40}$/u.test(manifest.sourceCommit ?? '') && /^[0-9a-f]{40}$/u.test(manifest.treeSha ?? '')
    && /^[0-9a-f]{64}$/u.test(manifest.compiledSha256 ?? ''), 'DEPLOYMENT_BUILD_MANIFEST_INVALID');
  requireValidation(environment.RAILWAY_PROJECT_ID === target.projectId
    && environment.RAILWAY_ENVIRONMENT_ID === target.environmentId && environment.RAILWAY_ENVIRONMENT_NAME === 'live-validation'
    && environment.RAILWAY_SERVICE_ID === target[`${role}ServiceId`]
    && environment.RAILWAY_GIT_COMMIT_SHA === manifest.sourceCommit
    && /^[0-9a-f-]{36}$/u.test(environment.RAILWAY_DEPLOYMENT_ID ?? ''), 'DEPLOYMENT_IDENTITY_MISMATCH');
  requireValidation(validationDirectoryHash(path.join(repositoryRoot, 'dist')) === manifest.compiledSha256,
    'DEPLOYMENT_COMPILED_CONTENT_MISMATCH');
  return Object.freeze({ role, sourceCommit: manifest.sourceCommit, projectId: target.projectId,
    environmentId: target.environmentId, serviceId: target[`${role}ServiceId`],
    deploymentId: environment.RAILWAY_DEPLOYMENT_ID, buildManifestSha256: validationHash(manifest) });
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
/** The service receives only its validation key and test token; production/data/lifecycle credentials fail closed. */
export function assertValidationRoleCredentials(role, environment) {
  const forbidden = /(?:API_KEY|DATABASE|POSTGRES|^PG(?:HOST|USER|PORT|DATABASE|PASSWORD|SSLMODE)$|REDIS|NOTION|OAUTH|TOKEN|SECRET|REGISTER_KEY|PRIVATE_KEY|_KEY_PEM|^ARCANOS_LIVE_VALIDATION_(?:TLS|CONTROLLER)_)/u;
  for (const name of Object.keys(environment)) {
    if (role === 'runtime' && ['ARCANOS_LIVE_PREVIEW_OPENAI_API_KEY', 'ARCANOS_LIVE_VALIDATION_TEST_TOKEN'].includes(name)) continue;
    requireValidation(!forbidden.test(name), 'LIVE_VALIDATION_UNRELATED_CREDENTIAL_FORBIDDEN');
  }
  requireValidation(!['NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'OPENAI_BASE_URL'].some(name => Object.hasOwn(environment, name)),
    'EGRESS_POLICY_AMBIENT_OVERRIDE_FORBIDDEN');
}

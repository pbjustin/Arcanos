import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const LANGUAGES = ['javascript', 'typescript', 'python', 'go', 'ruby', 'java'];
const PROMPT = 'Describe the repository features supplied in metadata.';
const MAX_RESPONSE_BYTES = 65536;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('INVALID_INPUT');
  return value;
}

/**
 * Build the existing Core query shape from explicit repository metadata.
 * Missing feature lists become empty objects; unknown languages and invalid
 * counts fail before serialization. This is not a durable registration API.
 */
export function buildRepositoryRequest(input) {
  const features = typeof input.features === 'string'
    ? JSON.parse(input.features.trim() || '{}')
    : input.features ?? {};
  if (!record(features) || Object.keys(features).some((key) =>
    !LANGUAGES.includes(key) || !Number.isSafeInteger(features[key]) || features[key] < 0)) {
    throw new Error('INVALID_FEATURES');
  }
  const detectedFeatures = Object.fromEntries(LANGUAGES
    .filter((key) => features[key] > 0).map((key) => [key, features[key]]));
  const languages = Object.keys(detectedFeatures).join(',');
  if (input.languages !== undefined && input.languages !== languages) {
    throw new Error('INCONSISTENT_LANGUAGES');
  }
  const commitHash = text(input.commitHash);
  if (!/^[a-f\d]{40}$/iu.test(commitHash)) throw new Error('INVALID_COMMIT');
  const timestamp = text(input.timestamp);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error('INVALID_TIMESTAMP');
  return {
    action: 'query',
    prompt: PROMPT,
    metadata: {
      repo_name: text(input.repoName),
      commit_hash: commitHash,
      detected_features: detectedFeatures,
      languages,
      branch: text(input.branch),
      timestamp,
      event_type: 'repository_registration',
      github_repository: text(input.githubRepository),
    },
  };
}

/** Validate the exact candidate envelope; reject extra actions/session fields. */
export function validateRepositoryRequest(value) {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'action,metadata,prompt'
    || value.action !== 'query' || value.prompt !== PROMPT || !record(value.metadata)) {
    throw new Error('INVALID_REQUEST');
  }
  const metadata = value.metadata;
  const rebuilt = buildRepositoryRequest({
    repoName: metadata.repo_name, commitHash: metadata.commit_hash,
    features: metadata.detected_features, languages: metadata.languages,
    branch: metadata.branch, timestamp: metadata.timestamp,
    githubRepository: metadata.github_repository,
  });
  if (Object.keys(metadata).sort().join(',') !== Object.keys(rebuilt.metadata).sort().join(',')
    || metadata.event_type !== 'repository_registration') throw new Error('INVALID_METADATA');
  return rebuilt;
}

function report(requestStatus, httpStatus = null) {
  return {
    schemaVersion: 1,
    reportingStatus: 'completed',
    registrationStatus: 'unsupported',
    registrationSucceeded: false,
    requestStatus,
    httpStatus,
  };
}

function loopbackTarget(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash
    || url.pathname !== '/') throw new Error('INVALID_MOCK_TARGET');
  return new URL('/gpt/arcanos-daemon', url).href;
}

/**
 * Prepare without network by default: Core has no registration persistence
 * contract. An explicit numeric-loopback mock URL permits one bounded query
 * for regression verification only. Never retries or follows redirects, and
 * never treats HTTP success or model-generated claims as registration proof.
 * Reports contain fixed statuses only, not payloads, responses or error text.
 */
export async function runRepositoryRegistration(input, options = {}) {
  let body;
  try {
    body = JSON.stringify(validateRepositoryRequest(buildRepositoryRequest(input)));
    validateRepositoryRequest(JSON.parse(body));
  } catch {
    return report('payload_invalid');
  }
  if (options.mockBaseUrl === undefined) return report('not_sent_contract_unsupported');
  let target;
  const timeoutMs = options.timeoutMs ?? 5000;
  try {
    target = loopbackTarget(options.mockBaseUrl);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
      throw new Error('INVALID_TIMEOUT');
    }
  } catch {
    return report('mock_target_rejected');
  }
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => {
      controller.abort();
      resolveTimeout(report('timeout'));
    }, timeoutMs);
  });
  const exchange = async () => {
    try {
      const response = await (options.fetchFn ?? fetch)(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'ARCANOS-GitHub-Actions/1.0' },
        body,
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response || !Number.isInteger(response.status)) return report('missing_response');
      const status = response.status;
      if (status < 200 || status >= 300) return report('http_error', status);
      const raw = await response.text();
      if (!raw || Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) return report('invalid_response', status);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return report('invalid_response', status); }
      if (!record(parsed) || parsed.ok !== true) return report('backend_rejected', status);
      return report('mock_query_accepted', status);
    } catch {
      return report(controller.signal.aborted ? 'timeout' : 'network_error');
    }
  };
  try {
    return await Promise.race([timeout, exchange()]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--mock-base-url')) {
    throw new Error('INVALID_ARGUMENTS');
  }
  const result = await runRepositoryRegistration({
    repoName: process.env.REGISTRATION_REPO_NAME,
    commitHash: process.env.GITHUB_SHA,
    features: process.env.REGISTRATION_FEATURES,
    languages: process.env.REGISTRATION_LANGUAGES,
    branch: process.env.GITHUB_REF_NAME,
    githubRepository: process.env.GITHUB_REPOSITORY,
    timestamp: new Date().toISOString(),
  }, args.length ? { mockBaseUrl: args[1] } : {});
  writeFileSync('repository-registration-status.json', `${JSON.stringify(result, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      `registration_status=${result.registrationStatus}\nrequest_status=${result.requestStatus}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## Repository registration\n\nWorkflow policy: noncritical.\n\nRegistration: unsupported (not successful).\n\nRequest: ${result.requestStatus}.\n\nNo durable repository-registration contract exists on the Core query route.\n`);
  }
  console.log(JSON.stringify(result));
  console.log('::warning::Durable repository registration is unsupported. Workflow completion is not registration success.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Repository registration reporting failed; no registration success is claimed.');
    process.exitCode = 1;
  });
}

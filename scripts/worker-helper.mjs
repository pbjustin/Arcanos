#!/usr/bin/env node

import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
export const MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH = 32;
export const MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH = 4_096;
const MAX_HELPER_RESPONSE_BYTES = 1_048_576;
const DEFAULT_HELPER_REQUEST_TIMEOUT_MS = 30_000;
const PLACEHOLDER_CREDENTIAL_PATTERN =
  /^(?:<[^>]+>|(?:change[-_]?me|example|placeholder)(?:[-_].*)?|replace[-_]?with(?:[-_].*)?)$/iu;

export const WORKER_HELPER_TOKEN_ENV_NAME = 'ARCANOS_WORKER_HELPER_TOKEN';
export const WORKER_HELPER_TOKEN_HEADER_NAME = 'x-arcanos-worker-helper-token';

// Keep this standalone script independent of compiled application output. A
// focused drift test compares this registry with the TypeScript source of truth.
export const SCRIPT_PURPOSE_BOUND_CREDENTIAL_ENV_NAMES = Object.freeze([
  'ARCANOS_CONTROL_PLANE_ACCESS_TOKEN',
  'ARCANOS_CONTROL_PLANE_APPROVAL_TOKEN',
  'ARCANOS_CORE_ADVISORY_ACCESS_TOKEN',
  'ARCANOS_AI_RUNTIME_ACCESS_TOKEN',
  'ARCANOS_GPT_ACCESS_TOKEN',
  'ARCANOS_GAMING_SOURCE_ACCESS_TOKEN',
  'ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN',
  'ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN',
  'ARCANOS_AUTOMATION_SECRET',
  'ARCANOS_CLI_BRIDGE_TOKEN',
  'ARCANOS_DAEMON_ACCESS_TOKEN',
  'ARCANOS_DEBUG_CMD_TOKEN',
  'ARCANOS_JOB_READ_CAPABILITY_SECRET',
  'ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET',
  'ARCANOS_MEMORY_ACCESS_TOKEN',
  'ARCANOS_WORKER_HELPER_TOKEN',
  'ACTION_PLAN_REQUEST_TOKEN',
  'ACTION_PLAN_OPERATOR_TOKEN',
  'ACTION_PLAN_EXECUTOR_TOKEN',
  'GPT_DAG_BRIDGE_BEARER_TOKEN',
  'METRICS_AUTH_TOKEN',
  'MCP_BEARER_TOKEN',
  'OPENAI_ACTION_SHARED_SECRET',
  'ROOT_OVERRIDE_TOKEN',
  'ARCANOS_ADMIN_TOKEN',
  'DEBUG_WATCHDOG_KEY',
  'DEBUG_SERVER_TOKEN',
]);

function printUsage() {
  console.log(`Usage:
  node scripts/worker-helper.mjs status [--base-url URL]
  node scripts/worker-helper.mjs latest-job [--base-url URL]
  node scripts/worker-helper.mjs job <jobId> [--base-url URL]
  node scripts/worker-helper.mjs queue-ask "<prompt>" [--session-id ID] [--domain DOMAIN] [--override-audit-safe VALUE] [--endpoint-name NAME] [--client-context-json JSON] [--base-url URL]
  node scripts/worker-helper.mjs dispatch "<input>" [--session-id ID] [--domain DOMAIN] [--override-audit-safe VALUE] [--source-endpoint NAME] [--attempts N] [--backoff-ms N] [--base-url URL]
  node scripts/worker-helper.mjs heal [--force true|false] [--base-url URL]

Environment:
  ARCANOS_BASE_URL             Base URL for the main app helper surface.
  ARCANOS_WORKER_HELPER_TOKEN  Env-only credential for privileged commands.

Accepted domains:
  diagnostic, code, creative, natural, execution`);
}

function parseCommandLine(argv) {
  const positionals = [];
  const flags = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const currentArgument = argv[index];
    if (!currentArgument.startsWith('--')) {
      positionals.push(currentArgument);
      continue;
    }

    const trimmedFlag = currentArgument.slice(2);
    const separatorIndex = trimmedFlag.indexOf('=');
    if (separatorIndex >= 0) {
      const flagName = trimmedFlag.slice(0, separatorIndex);
      const flagValue = trimmedFlag.slice(separatorIndex + 1);
      flags.set(flagName, flagValue);
      continue;
    }

    const nextArgument = argv[index + 1];
    if (nextArgument && !nextArgument.startsWith('--')) {
      flags.set(trimmedFlag, nextArgument);
      index += 1;
      continue;
    }

    flags.set(trimmedFlag, 'true');
  }

  return {
    command: positionals[0],
    args: positionals.slice(1),
    flags
  };
}

function getFlagValue(flags, name, fallbackValue) {
  if (flags.has(name)) {
    return flags.get(name);
  }
  return fallbackValue;
}

function parseBooleanValue(rawValue, fallbackValue) {
  if (rawValue === undefined) {
    return fallbackValue;
  }

  const normalizedValue = String(rawValue).trim().toLowerCase();
  if (normalizedValue === 'true') {
    return true;
  }
  if (normalizedValue === 'false') {
    return false;
  }

  throw new Error(`Invalid boolean value: ${rawValue}`);
}

function parseIntegerValue(rawValue, label) {
  if (rawValue === undefined) {
    return undefined;
  }

  const parsedValue = Number.parseInt(String(rawValue), 10);
  if (!Number.isFinite(parsedValue)) {
    throw new Error(`Invalid integer for ${label}: ${rawValue}`);
  }

  return parsedValue;
}

function parseClientContext(rawValue) {
  if (rawValue === undefined) {
    return undefined;
  }

  //audit Assumption: client context is supplied as JSON text from CLI automation; failure risk: malformed JSON produces ambiguous route payloads; expected invariant: valid JSON object or array-backed context is parsed before request dispatch; handling strategy: fail fast during CLI argument parsing.
  return JSON.parse(rawValue);
}

function digestOpaqueSecret(value) {
  return createHash('sha256').update(value, 'utf16le').digest();
}

function opaqueSecretsMatch(left, right) {
  return timingSafeEqual(digestOpaqueSecret(left), digestOpaqueSecret(right));
}

function resolveWorkerHelperToken(environment) {
  const configuredValues = Object.fromEntries(
    SCRIPT_PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map((environmentName) => [
      environmentName,
      environment?.[environmentName],
    ])
  );
  const token = configuredValues[WORKER_HELPER_TOKEN_ENV_NAME];
  if (
    typeof token !== 'string'
    || token.length < MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH
    || token.length > MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH
    || token !== token.trim()
    || /\s/u.test(token)
    || PLACEHOLDER_CREDENTIAL_PATTERN.test(token)
  ) {
    return null;
  }

  const collides = SCRIPT_PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.some((environmentName) => {
    if (environmentName === WORKER_HELPER_TOKEN_ENV_NAME) {
      return false;
    }

    const rawCandidate = configuredValues[environmentName];
    if (typeof rawCandidate !== 'string') {
      return false;
    }

    const candidate = rawCandidate.trim();
    return (
      candidate.length > 0
      && candidate.length <= MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH
      && opaqueSecretsMatch(token, candidate)
    );
  });

  return collides ? null : token;
}

function resolveExactBaseOrigin(rawBaseUrl, privileged) {
  if (typeof rawBaseUrl !== 'string' || rawBaseUrl.length === 0) {
    throw new Error('Worker-helper base URL must be an exact HTTP(S) origin.');
  }

  let parsed;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new Error('Worker-helper base URL must be an exact HTTP(S) origin.');
  }

  const loopbackHost = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])
    .has(parsed.hostname.toLowerCase());
  const allowedProtocol = privileged
    ? parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopbackHost)
    : parsed.protocol === 'https:' || parsed.protocol === 'http:';
  if (
    !allowedProtocol
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== '/'
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new Error(
      privileged
        ? 'Privileged worker-helper destination must be an exact HTTPS origin or an HTTP loopback origin.'
        : 'Worker-helper base URL must be an exact HTTP(S) origin.'
    );
  }

  return parsed.origin;
}

function buildHeadersWithCredential(credential) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...(credential ? { [WORKER_HELPER_TOKEN_HEADER_NAME]: credential } : {}),
  };
}

export function buildHelperRequestHeaders({
  privileged = false,
  environment = process.env
} = {}) {
  const credential = privileged
    ? resolveWorkerHelperToken(environment)
    : null;
  if (privileged && !credential) {
    throw new Error('Privileged worker-helper credential configuration is invalid.');
  }

  return buildHeadersWithCredential(credential);
}

function sanitizeCredentialEcho(value, credential, depth = 0) {
  if (!credential) {
    return value;
  }
  if (depth > 32) {
    return '[REDACTED_DEPTH_LIMIT]';
  }
  if (typeof value === 'string') {
    return value.split(credential).join('[REDACTED]');
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeCredentialEcho(entry, credential, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => (
        key.includes(credential)
          ? []
          : [[key, sanitizeCredentialEcho(entry, credential, depth + 1)]]
      ))
    );
  }
  return null;
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Best-effort cancellation only.
  }
}

function readResponseHeader(response, name) {
  return typeof response?.headers?.get === 'function'
    ? response.headers.get(name)
    : null;
}

async function readBoundedJsonResponse(response) {
  const declaredLength = readResponseHeader(response, 'content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) {
      await cancelResponseBody(response);
      throw new Error('Worker-helper response was invalid.');
    }
    if (Number(declaredLength) > MAX_HELPER_RESPONSE_BYTES) {
      await cancelResponseBody(response);
      throw new Error('Worker-helper response exceeded the allowed size.');
    }
  }

  const contentType = readResponseHeader(response, 'content-type');
  if (contentType !== null && !/\bjson\b/iu.test(contentType)) {
    await cancelResponseBody(response);
    throw new Error('Worker-helper response was not JSON.');
  }

  let responseText;
  if (typeof response?.body?.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_HELPER_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error('Worker-helper response exceeded the allowed size.');
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    responseText = new TextDecoder('utf-8', { fatal: true }).decode(combined);
  } else {
    throw new Error('Worker-helper response was invalid.');
  }

  if (responseText.length === 0) {
    return null;
  }

  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error('Worker-helper response was not valid JSON.');
  }
}

export async function sendHelperRequest({
  method,
  path,
  body,
  baseUrl,
  privileged = false,
  environment = process.env,
  fetchFn = globalThis.fetch,
  timeoutMs = DEFAULT_HELPER_REQUEST_TIMEOUT_MS,
}) {
  const credential = privileged
    ? resolveWorkerHelperToken(environment)
    : null;
  if (privileged && !credential) {
    throw new Error('Privileged worker-helper credential configuration is invalid.');
  }

  const baseOrigin = resolveExactBaseOrigin(baseUrl, privileged);
  const requestUrl = new URL(path, `${baseOrigin}/`);
  if (requestUrl.origin !== baseOrigin) {
    throw new Error('Worker-helper request path must remain within the configured origin.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    try {
      response = await fetchFn(requestUrl, {
        method,
        headers: buildHeadersWithCredential(credential),
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: privileged ? 'error' : 'follow',
        signal: controller.signal,
      });
    } catch {
      throw new Error('Worker-helper request could not be completed.');
    }

    if (response.status >= 300 && response.status < 400) {
      await cancelResponseBody(response);
      throw new Error('Worker-helper redirect response was rejected.');
    }

    if (!response.ok) {
      await cancelResponseBody(response);
      const error = new Error(`Worker-helper request failed with HTTP ${response.status}.`);
      error.statusCode = response.status;
      throw error;
    }

    try {
      return sanitizeCredentialEcho(
        await readBoundedJsonResponse(response),
        credential
      );
    } catch {
      throw new Error('Worker-helper response was invalid or exceeded the allowed size.');
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function runWorkerHelperCli({
  argv = process.argv.slice(2),
  environment = process.env,
  fetchFn = globalThis.fetch,
  writeOutput = (output) => console.log(output),
} = {}) {
  const { command, args, flags } = parseCommandLine(argv);
  if (!command || command === 'help' || command === '--help') {
    printUsage();
    return;
  }

  const normalizedFlagNames = new Set(
    [...flags.keys()].map(flagName => flagName.toLowerCase())
  );
  if (
    normalizedFlagNames.has('token')
    || normalizedFlagNames.has('worker-helper-token')
    || normalizedFlagNames.has('authorization')
  ) {
    throw new Error('Worker-helper credentials may only be supplied through the environment.');
  }

  const baseUrl = getFlagValue(
    flags,
    'base-url',
    environment?.ARCANOS_BASE_URL || DEFAULT_BASE_URL
  );

  let responsePayload;

  switch (command) {
    case 'status':
      responsePayload = await sendHelperRequest({
        method: 'GET',
        path: '/worker-helper/status',
        baseUrl,
        environment,
        fetchFn,
      });
      break;
    case 'latest-job':
      responsePayload = await sendHelperRequest({
        method: 'GET',
        path: '/worker-helper/jobs/latest',
        baseUrl,
        privileged: true,
        environment,
        fetchFn,
      });
      break;
    case 'job': {
      const jobId = args[0];
      if (!jobId) {
        throw new Error('Missing job id. Usage: node scripts/worker-helper.mjs job <jobId>');
      }

      responsePayload = await sendHelperRequest({
        method: 'GET',
        path: `/worker-helper/jobs/${encodeURIComponent(jobId)}`,
        baseUrl,
        privileged: true,
        environment,
        fetchFn,
      });
      break;
    }
    case 'queue-ask': {
      const prompt = args[0];
      if (!prompt) {
        throw new Error('Missing prompt. Usage: node scripts/worker-helper.mjs queue-ask "<prompt>"');
      }

      responsePayload = await sendHelperRequest({
        method: 'POST',
        path: '/worker-helper/queue/ask',
        baseUrl,
        privileged: true,
        environment,
        fetchFn,
        body: {
          prompt,
          sessionId: getFlagValue(flags, 'session-id', undefined),
          cognitiveDomain: getFlagValue(flags, 'domain', undefined),
          overrideAuditSafe: getFlagValue(flags, 'override-audit-safe', undefined),
          endpointName: getFlagValue(flags, 'endpoint-name', undefined),
          clientContext: parseClientContext(getFlagValue(flags, 'client-context-json', undefined))
        }
      });
      break;
    }
    case 'dispatch': {
      const input = args[0];
      if (!input) {
        throw new Error('Missing input. Usage: node scripts/worker-helper.mjs dispatch "<input>"');
      }

      responsePayload = await sendHelperRequest({
        method: 'POST',
        path: '/worker-helper/dispatch',
        baseUrl,
        privileged: true,
        environment,
        fetchFn,
        body: {
          input,
          sessionId: getFlagValue(flags, 'session-id', undefined),
          cognitiveDomain: getFlagValue(flags, 'domain', undefined),
          overrideAuditSafe: getFlagValue(flags, 'override-audit-safe', undefined),
          attempts: parseIntegerValue(getFlagValue(flags, 'attempts', undefined), 'attempts'),
          backoffMs: parseIntegerValue(getFlagValue(flags, 'backoff-ms', undefined), 'backoff-ms'),
          sourceEndpoint: getFlagValue(flags, 'source-endpoint', undefined)
        }
      });
      break;
    }
    case 'heal':
      responsePayload = await sendHelperRequest({
        method: 'POST',
        path: '/worker-helper/heal',
        baseUrl,
        privileged: true,
        environment,
        fetchFn,
        body: {
          force: parseBooleanValue(getFlagValue(flags, 'force', undefined), true)
        }
      });
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }

  writeOutput(JSON.stringify(responsePayload, null, 2));
  return responsePayload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorkerHelperCli().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

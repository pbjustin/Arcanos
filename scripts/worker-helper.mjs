#!/usr/bin/env node

const DEFAULT_BASE_URL = process.env.ARCANOS_BASE_URL || 'http://127.0.0.1:3000';
const DEFAULT_HELPER_KEY =
  process.env.ARCANOS_WORKER_HELPER_KEY || process.env.ADMIN_KEY || process.env.REGISTER_KEY;

function printUsage() {
  console.log(`Usage:
  node scripts/worker-helper.mjs status [--base-url URL] [--key SECRET]
  node scripts/worker-helper.mjs latest-job [--base-url URL] [--key SECRET]
  node scripts/worker-helper.mjs job <jobId> [--base-url URL] [--key SECRET]
  node scripts/worker-helper.mjs queue-ask "<prompt>" [--session-id ID] [--domain DOMAIN] [--override-audit-safe VALUE] [--endpoint-name NAME] [--client-context-json JSON] [--base-url URL] [--key SECRET]
  node scripts/worker-helper.mjs dispatch "<input>" [--session-id ID] [--domain DOMAIN] [--override-audit-safe VALUE] [--source-endpoint NAME] [--attempts N] [--backoff-ms N] [--base-url URL] [--key SECRET]
  node scripts/worker-helper.mjs heal [--force true|false] [--base-url URL] [--key SECRET]

Environment:
  ARCANOS_BASE_URL             Base URL for the main app helper surface.
  ARCANOS_WORKER_HELPER_KEY    Helper auth key. Falls back to ADMIN_KEY or REGISTER_KEY.

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

function assertConfiguredKey(key) {
  //audit Assumption: helper auth should fail locally before making a network request when no secret is configured; failure risk: confusing 403/503 responses from the server without local remediation guidance; expected invariant: CLI requires one explicit secret source; handling strategy: abort with setup instructions.
  if (!key) {
    throw new Error(
      'Missing helper key. Set ARCANOS_WORKER_HELPER_KEY, ADMIN_KEY, or REGISTER_KEY, or pass --key.'
    );
  }
}

async function sendHelperRequest({ method, path, body, baseUrl, helperKey }) {
  const requestUrl = new URL(path, baseUrl);
  const response = await fetch(requestUrl, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-worker-helper-key': helperKey
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const responseText = await response.text();
  let responseBody;
  try {
    responseBody = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseBody = responseText;
  }

  if (!response.ok) {
    const error = new Error(`Request failed with status ${response.status}`);
    error.responseBody = responseBody;
    error.statusCode = response.status;
    throw error;
  }

  return responseBody;
}

async function main() {
  const { command, args, flags } = parseCommandLine(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help') {
    printUsage();
    return;
  }

  const baseUrl = getFlagValue(flags, 'base-url', DEFAULT_BASE_URL);
  const helperKey = getFlagValue(flags, 'key', DEFAULT_HELPER_KEY);
  assertConfiguredKey(helperKey);

  let responsePayload;

  switch (command) {
    case 'status':
      responsePayload = await sendHelperRequest({
        method: 'GET',
        path: '/worker-helper/status',
        baseUrl,
        helperKey
      });
      break;
    case 'latest-job':
      responsePayload = await sendHelperRequest({
        method: 'GET',
        path: '/worker-helper/jobs/latest',
        baseUrl,
        helperKey
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
        helperKey
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
        helperKey,
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
        helperKey,
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
        helperKey,
        body: {
          force: parseBooleanValue(getFlagValue(flags, 'force', undefined), true)
        }
      });
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }

  console.log(JSON.stringify(responsePayload, null, 2));
}

main().catch(error => {
  const responseBody = error.responseBody;
  if (responseBody !== undefined) {
    console.error(JSON.stringify(responseBody, null, 2));
  } else {
    console.error(error.message);
  }
  process.exit(1);
});

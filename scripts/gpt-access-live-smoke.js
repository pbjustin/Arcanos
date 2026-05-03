#!/usr/bin/env node
/**
 * Purpose: Run a safe read-only GPT Access live smoke against a deployed backend.
 * Inputs/Outputs: Reads a base URL and optional GPT access token from env, prints bounded JSON-lines endpoint results, and exits non-zero on failed checks.
 * Edge cases: Never accepts tokens via CLI, never prints headers or env, and redacts known secret shapes from response bodies and errors.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const SMOKE_STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
});

export const PUBLIC_CHECKS = Object.freeze([
  Object.freeze({
    path: '/gpt-access/openapi.json',
    requiresAuth: false,
  }),
]);

export const PROTECTED_CHECKS = Object.freeze([
  Object.freeze({
    path: '/gpt-access/status',
    requiresAuth: true,
  }),
  Object.freeze({
    path: '/gpt-access/workers/status',
    requiresAuth: true,
  }),
  Object.freeze({
    path: '/gpt-access/queue/inspect',
    requiresAuth: true,
  }),
  Object.freeze({
    path: '/gpt-access/self-heal/status',
    requiresAuth: true,
  }),
]);

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BODY_CHARS = 2_400;

const BASE_URL_ENV_NAMES = Object.freeze([
  'ARCANOS_GPT_ACCESS_BASE_URL',
  'ARCANOS_BASE_URL',
  'ARCANOS_BACKEND_URL',
  'SERVER_URL',
  'BACKEND_URL',
  'PUBLIC_BASE_URL',
  'RAILWAY_PUBLIC_URL',
  'RAILWAY_STATIC_URL',
]);

const ACCESS_TOKEN_ENV_NAMES = Object.freeze([
  'ARCANOS_GPT_ACCESS_TOKEN',
  'GPT_ACCESS_TOKEN',
]);

const KNOWN_SECRET_ENV_NAMES = Object.freeze([
  ...ACCESS_TOKEN_ENV_NAMES,
  'DATABASE_URL',
  'DATABASE_PRIVATE_URL',
  'DATABASE_PUBLIC_URL',
  'OPENAI_API_KEY',
  'RAILWAY_TOKEN',
  'RAILWAY_API_TOKEN',
  'SESSION_SECRET',
]);

const SENSITIVE_EXACT_KEYS = new Set([
  'apikey',
  'auth',
  'authorization',
  'authorizationheader',
  'cookie',
  'databaseprivateurl',
  'databasepublicurl',
  'databaseurl',
  'envvars',
  'environmentvariables',
  'fullenv',
  'headers',
  'openaiapikey',
  'password',
  'processenv',
  'secret',
  'sessionid',
  'setcookie',
  'token',
]);

const SENSITIVE_KEY_FRAGMENTS = [
  'accesstoken',
  'apikey',
  'authtoken',
  'connectionstring',
  'credential',
  'databaseurl',
  'password',
  'refreshtoken',
  'secret',
  'sessiontoken',
];

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const STRING_REDACTIONS = Object.freeze([
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_OPENAI_KEY]'],
  [/\b(?:railway|rwy)[_-]?[A-Za-z0-9]{16,}\b/gi, '[REDACTED_RAILWAY_TOKEN]'],
  [/\b(?:postgres|postgresql|mysql|mongodb):\/\/[^\s"'<>]+/gi, '[REDACTED_DATABASE_URL]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  [/\b(?:authorization|cookie|set-cookie|api[_-]?key|openai[_-]?api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|openai[_-]?token|railway[_-]?token|refresh[_-]?token|session[_-]?token|token|secret|password|session(?:id)?|database[_-]?url)\s*[:=]\s*["']?[^"'\s,;}]+/gi, '$1=[REDACTED]'],
]);

function readPositiveInteger(rawValue, fallbackValue) {
  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? Math.trunc(parsedValue)
    : fallbackValue;
}

function firstConfiguredEnvValue(env, names) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return '';
}

export function readAccessTokenFromEnv(env = process.env) {
  return firstConfiguredEnvValue(env, ACCESS_TOKEN_ENV_NAMES);
}

export function parseArgs(argv, env = process.env) {
  const config = {
    baseUrl: firstConfiguredEnvValue(env, BASE_URL_ENV_NAMES),
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    maxBodyChars: DEFAULT_MAX_BODY_CHARS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argFlag = argv[index];
    const next = argv[index + 1];

    if (argFlag === '--base-url' && typeof next === 'string' && next.trim().length > 0) {
      config.baseUrl = next.trim();
      index += 1;
      continue;
    }

    if (argFlag === '--request-timeout-ms' && typeof next === 'string' && next.trim().length > 0) {
      config.requestTimeoutMs = readPositiveInteger(next, DEFAULT_REQUEST_TIMEOUT_MS);
      index += 1;
      continue;
    }

    if (argFlag === '--max-body-chars' && typeof next === 'string' && next.trim().length > 0) {
      config.maxBodyChars = readPositiveInteger(next, DEFAULT_MAX_BODY_CHARS);
      index += 1;
    }
  }

  return config;
}

export function normalizeBaseUrl(rawBaseUrl) {
  const trimmedBaseUrl = typeof rawBaseUrl === 'string'
    ? rawBaseUrl.trim().replace(/\/+$/, '')
    : '';

  if (!trimmedBaseUrl) {
    throw new Error('Missing --base-url and no backend URL env var was set.');
  }

  const candidateUrl = /^https?:\/\//i.test(trimmedBaseUrl)
    ? trimmedBaseUrl
    : `https://${trimmedBaseUrl}`;
  const parsedUrl = new URL(candidateUrl);

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Base URL must use http or https.');
  }

  return parsedUrl.toString().replace(/\/+$/, '');
}

function createRequestTimeout(timeoutMs) {
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);

  return {
    signal: abortController.signal,
    dispose() {
      clearTimeout(timeoutHandle);
    },
  };
}

function isJsonContentType(contentType) {
  return /\bjson\b/i.test(contentType);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePayloadKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitivePayloadKey(key) {
  const normalizedKey = normalizePayloadKey(key);
  return SENSITIVE_EXACT_KEYS.has(normalizedKey) ||
    SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment));
}

function redactKnownSecretValues(value, secretValues) {
  return secretValues.reduce((currentValue, secretValue) => {
    if (secretValue.length < 8 || !currentValue.includes(secretValue)) {
      return currentValue;
    }

    return currentValue.split(secretValue).join('[REDACTED_SECRET_VALUE]');
  }, value);
}

export function sanitizeString(value, secretValues = []) {
  const knownSecretRedacted = redactKnownSecretValues(String(value), secretValues);
  return STRING_REDACTIONS.reduce(
    (currentValue, [pattern, replacement]) => currentValue.replace(pattern, replacement),
    knownSecretRedacted
  );
}

export function collectKnownSecretValues(env = process.env) {
  return KNOWN_SECRET_ENV_NAMES
    .map((name) => env[name])
    .filter((value) => typeof value === 'string' && value.trim().length >= 8)
    .map((value) => value.trim());
}

export function sanitizeJsonValue(value, options = {}) {
  const secretValues = Array.isArray(options.secretValues) ? options.secretValues : [];
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 8;
  const maxArrayItems = Number.isFinite(options.maxArrayItems) ? options.maxArrayItems : 25;
  const maxObjectKeys = Number.isFinite(options.maxObjectKeys) ? options.maxObjectKeys : 40;
  const seen = new WeakSet();

  function sanitize(entry, key, depth) {
    if (typeof key === 'string' && isSensitivePayloadKey(key)) {
      return '[REDACTED]';
    }

    if (typeof entry === 'string') {
      return sanitizeString(entry, secretValues);
    }

    if (entry === null || typeof entry === 'number' || typeof entry === 'boolean') {
      return entry;
    }

    if (!entry || typeof entry !== 'object') {
      return null;
    }

    if (depth > maxDepth) {
      return '[REDACTED_DEPTH]';
    }

    if (seen.has(entry)) {
      return '[REDACTED_CIRCULAR]';
    }
    seen.add(entry);

    if (Array.isArray(entry)) {
      const sanitizedItems = entry
        .slice(0, maxArrayItems)
        .map((item) => sanitize(item, null, depth + 1));
      if (entry.length > maxArrayItems) {
        sanitizedItems.push(`[TRUNCATED_${entry.length - maxArrayItems}_ITEMS]`);
      }
      return sanitizedItems;
    }

    const sanitizedRecord = {};
    const entries = Object.entries(entry);
    for (const [entryKey, entryValue] of entries.slice(0, maxObjectKeys)) {
      sanitizedRecord[entryKey] = UNSAFE_OBJECT_KEYS.has(entryKey)
        ? '[REDACTED]'
        : sanitize(entryValue, entryKey, depth + 1);
    }

    if (entries.length > maxObjectKeys) {
      sanitizedRecord.__truncatedKeys = entries.length - maxObjectKeys;
    }

    return sanitizedRecord;
  }

  return sanitize(value, null, 0);
}

function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function summarizeOpenApiBody(parsedBody, secretValues) {
  const sanitizedBody = sanitizeJsonValue(parsedBody, {
    secretValues,
    maxDepth: 6,
    maxArrayItems: 20,
    maxObjectKeys: 80,
  });
  const recordBody = sanitizedBody && typeof sanitizedBody === 'object' && !Array.isArray(sanitizedBody)
    ? sanitizedBody
    : {};

  return {
    openapi: recordBody.openapi ?? null,
    servers: recordBody.servers ?? null,
    paths: Object.fromEntries(
      [...PUBLIC_CHECKS, ...PROTECTED_CHECKS].map((check) => {
        const pathDefinition = recordBody.paths?.[check.path];
        const getDefinition = pathDefinition?.get;
        return [
          check.path,
          {
            present: Boolean(pathDefinition),
            methods: pathDefinition && typeof pathDefinition === 'object'
              ? Object.keys(pathDefinition)
              : [],
            operationId: getDefinition?.operationId ?? null,
            security: getDefinition?.security ?? null,
          },
        ];
      })
    ),
  };
}

function bodyPassesCheckContract(path, parsedBody) {
  if (path !== '/gpt-access/openapi.json') {
    return true;
  }

  if (!isRecord(parsedBody) || typeof parsedBody.openapi !== 'string' || !isRecord(parsedBody.paths)) {
    return false;
  }

  return [...PUBLIC_CHECKS, ...PROTECTED_CHECKS].every((check) => (
    isRecord(parsedBody.paths[check.path]) && isRecord(parsedBody.paths[check.path].get)
  ));
}

export function buildBodyForOutput(path, parsedBody, options = {}) {
  const secretValues = Array.isArray(options.secretValues) ? options.secretValues : [];
  const maxBodyChars = Number.isFinite(options.maxBodyChars)
    ? options.maxBodyChars
    : DEFAULT_MAX_BODY_CHARS;
  const candidateBody = path === '/gpt-access/openapi.json'
    ? summarizeOpenApiBody(parsedBody, secretValues)
    : sanitizeJsonValue(parsedBody, { secretValues });
  const renderedBody = JSON.stringify(candidateBody);

  if (renderedBody.length <= maxBodyChars) {
    return candidateBody;
  }

  return {
    truncated: true,
    preview: truncate(renderedBody, maxBodyChars),
  };
}

function buildShortError(message, options = {}) {
  const secretValues = Array.isArray(options.secretValues) ? options.secretValues : [];
  const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl : '';
  const baseUrlRedacted = baseUrl
    ? String(message).split(baseUrl).join('[REDACTED_BASE_URL]')
    : String(message);
  return truncate(sanitizeString(baseUrlRedacted, secretValues).replace(/\s+/g, ' ').trim(), 300);
}

async function readResponseBody(response) {
  const bodyText = await response.text();
  if (!bodyText.trim()) {
    return {
      parsed: null,
      parsedOk: true,
      bodyText,
    };
  }

  try {
    return {
      parsed: JSON.parse(bodyText),
      parsedOk: true,
      bodyText,
    };
  } catch {
    return {
      parsed: null,
      parsedOk: false,
      bodyText,
    };
  }
}

function createResultRecord({ path, httpStatus, contentType, body, error, passed }) {
  const result = {
    path,
    httpStatus,
    contentType,
  };

  if (error) {
    result.error = error;
  } else {
    result.body = body;
  }

  result.result = passed ? SMOKE_STATUS.PASS : SMOKE_STATUS.FAIL;
  return result;
}

export function buildSmokeChecks(authValue) {
  return authValue
    ? [...PUBLIC_CHECKS, ...PROTECTED_CHECKS]
    : [...PUBLIC_CHECKS];
}

export async function runSmokeCheck(check, context) {
  const timeout = createRequestTimeout(context.requestTimeoutMs);
  const headers = {
    accept: 'application/json',
    'user-agent': 'arcanos-gpt-access-live-smoke/1.0',
  };

  if (check.requiresAuth) {
    headers.authorization = `Bearer ${context.authValue}`;
  }

  try {
    const response = await context.fetchFn(`${context.baseUrl}${check.path}`, {
      method: 'GET',
      headers,
      signal: timeout.signal,
    });
    const contentType = response.headers?.get?.('content-type') ?? '';
    const responseBody = await readResponseBody(response);
    const jsonContentType = isJsonContentType(contentType);
    const passed = response.status === 200 &&
      jsonContentType &&
      responseBody.parsedOk &&
      bodyPassesCheckContract(check.path, responseBody.parsed);

    if (!responseBody.parsedOk) {
      return createResultRecord({
        path: check.path,
        httpStatus: response.status,
        contentType,
        error: buildShortError(`Non-JSON response body: ${responseBody.bodyText}`, context),
        passed: false,
      });
    }

    return createResultRecord({
      path: check.path,
      httpStatus: response.status,
      contentType,
      body: buildBodyForOutput(check.path, responseBody.parsed, context),
      passed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createResultRecord({
      path: check.path,
      httpStatus: null,
      contentType: null,
      error: buildShortError(message, context),
      passed: false,
    });
  } finally {
    timeout.dispose();
  }
}

export async function runLiveSmoke(config, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const authValue = readAccessTokenFromEnv(env);
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const secretValues = collectKnownSecretValues(env);
  const fetchFn = dependencies.fetchFn ?? fetch;
  const checks = buildSmokeChecks(authValue);
  const results = [];

  for (const check of checks) {
    results.push(await runSmokeCheck(check, {
      authValue,
      baseUrl,
      fetchFn,
      maxBodyChars: config.maxBodyChars,
      requestTimeoutMs: config.requestTimeoutMs,
      secretValues,
    }));
  }

  return results;
}

export function printSmokeResults(results, output = process.stdout) {
  for (const result of results) {
    output.write(`${JSON.stringify(result)}\n`);
  }
}

function buildConfigurationFailure(error, env = process.env) {
  const secretValues = collectKnownSecretValues(env);
  return createResultRecord({
    path: '(configuration)',
    httpStatus: null,
    contentType: null,
    error: buildShortError(error instanceof Error ? error.message : String(error), { secretValues }),
    passed: false,
  });
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const results = await runLiveSmoke(config);
  printSmokeResults(results);
  process.exitCode = results.every((result) => result.result === SMOKE_STATUS.PASS) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const result = buildConfigurationFailure(error);
    printSmokeResults([result]);
    process.exitCode = 1;
  });
}

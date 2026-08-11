#!/usr/bin/env node

import process from 'node:process';
import { pathToFileURL } from 'node:url';

const MAX_VARIABLE_INPUT_BYTES = 1_048_576;
const MAX_READINESS_RESPONSE_BYTES = 65_536;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const EXPECTED_DRAINING_SECONDS_VARIABLE = '60';
const PUBLIC_DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;
const WEB_READINESS_CHECK_NAMES = Object.freeze([
  'openai',
  'database',
  'redis',
  'public-provider-admission',
  'startup',
]);
const DATABASE_DISCRETE_VARIABLE_NAMES = Object.freeze([
  'PGUSER',
  'PGPASSWORD',
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
]);
const REDIS_HOST_VARIABLE_NAMES = Object.freeze([
  'REDISHOST',
  'REDIS_HOST',
]);

function fail(code) {
  throw new Error(code);
}

function hasJsonContentType(headers) {
  const rawValue = headers?.get?.('content-type');
  return (
    typeof rawValue === 'string'
    && rawValue.split(';', 1)[0].trim().toLowerCase() === 'application/json'
  );
}

function hasNoStoreDirective(headers) {
  const rawValue = headers?.get?.('cache-control');
  return (
    typeof rawValue === 'string'
    && rawValue
      .split(',')
      .some(directive => directive.trim().toLowerCase() === 'no-store')
  );
}

function hasConfiguredVariable(variables, name) {
  const value = variables[name];
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim();
  return (
    normalized.length > 0
    && normalized.toLowerCase() !== 'undefined'
    && normalized.toLowerCase() !== 'null'
  );
}

function requireProductionWebDependencyConfiguration(variables) {
  if (variables.NODE_ENV !== 'production') {
    fail('RAILWAY_WEB_RUNTIME_ENVIRONMENT_INVALID');
  }

  const databaseConfigured = (
    hasConfiguredVariable(variables, 'DATABASE_URL')
    || DATABASE_DISCRETE_VARIABLE_NAMES.every(name => (
      hasConfiguredVariable(variables, name)
    ))
  );
  const redisConfigured = (
    hasConfiguredVariable(variables, 'REDIS_URL')
    || REDIS_HOST_VARIABLE_NAMES.some(name => (
      hasConfiguredVariable(variables, name)
    ))
  );

  if (!databaseConfigured || !redisConfigured) {
    fail('RAILWAY_WEB_DEPENDENCY_CONFIGURATION_MISSING');
  }
}

function requireExactIdentity(variables, expectedIdentity) {
  const expected = {
    RAILWAY_PROJECT_ID: expectedIdentity.projectId,
    RAILWAY_ENVIRONMENT_NAME: expectedIdentity.environmentName,
    RAILWAY_SERVICE_ID: expectedIdentity.serviceId,
  };

  for (const [name, value] of Object.entries(expected)) {
    if (typeof value !== 'string' || value.length === 0 || variables[name] !== value) {
      fail('RAILWAY_READINESS_IDENTITY_MISMATCH');
    }
  }
}

function resolveCanonicalPublicOrigin(rawDomain) {
  if (
    typeof rawDomain !== 'string'
    || rawDomain.length === 0
    || rawDomain !== rawDomain.trim()
    || !PUBLIC_DOMAIN_PATTERN.test(rawDomain)
  ) {
    fail('RAILWAY_READINESS_TARGET_INVALID');
  }

  let origin;
  try {
    const candidate = new URL(`https://${rawDomain}`);
    if (
      candidate.protocol !== 'https:'
      || candidate.username !== ''
      || candidate.password !== ''
      || candidate.port !== ''
      || candidate.pathname !== '/'
      || candidate.search !== ''
      || candidate.hash !== ''
      || candidate.hostname.toLowerCase() !== rawDomain.toLowerCase()
    ) {
      fail('RAILWAY_READINESS_TARGET_INVALID');
    }
    origin = candidate.origin;
  } catch {
    fail('RAILWAY_READINESS_TARGET_INVALID');
  }

  return origin;
}

/**
 * Resolve the exact service role and direct readiness URL from Railway's
 * resolved variable projection.
 */
export function resolveReadinessTarget(variables, expectedIdentity) {
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
    fail('RAILWAY_READINESS_VARIABLES_INVALID');
  }

  requireExactIdentity(variables, expectedIdentity);

  if (
    Object.hasOwn(variables, 'RAILWAY_DEPLOYMENT_DRAINING_SECONDS')
    && variables.RAILWAY_DEPLOYMENT_DRAINING_SECONDS
      !== EXPECTED_DRAINING_SECONDS_VARIABLE
  ) {
    fail('RAILWAY_READINESS_DRAIN_OVERRIDE_MISMATCH');
  }

  const role = variables.ARCANOS_PROCESS_KIND;
  if (role !== 'web' && role !== 'worker') {
    fail('RAILWAY_READINESS_ROLE_INVALID');
  }
  if (role === 'web') {
    requireProductionWebDependencyConfiguration(variables);
  }

  const rawDomain = variables.RAILWAY_PUBLIC_DOMAIN;
  if (typeof rawDomain !== 'string' || rawDomain.length === 0) {
    if (role === 'worker') {
      return {
        mode: 'platform',
        role,
        url: null,
      };
    }
    fail('RAILWAY_WEB_READINESS_TARGET_MISSING');
  }

  const origin = resolveCanonicalPublicOrigin(rawDomain);
  return {
    mode: 'direct',
    role,
    url: `${origin}/readyz`,
  };
}

async function readResponseBodyBounded(response) {
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > MAX_READINESS_RESPONSE_BYTES) {
      await reader.cancel();
      fail('RAILWAY_READINESS_RESPONSE_TOO_LARGE');
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function hasExactWebReadinessShape(payload) {
  if (
    !payload
    || typeof payload !== 'object'
    || payload.ready !== true
    || payload.status !== 'healthy'
    || !Array.isArray(payload.checks)
    || payload.checks.length !== WEB_READINESS_CHECK_NAMES.length
  ) {
    return false;
  }

  const names = payload.checks.map(check => check?.name);
  return (
    new Set(names).size === WEB_READINESS_CHECK_NAMES.length
    && WEB_READINESS_CHECK_NAMES.every(name => names.includes(name))
    && payload.checks.every(check => (
      check
      && typeof check === 'object'
      && check.healthy === true
    ))
  );
}

function hasExactWorkerReadinessShape(payload) {
  return Boolean(
    payload
    && typeof payload === 'object'
    && payload.ready === true
    && payload.status === 'ready'
    && payload.child === 'running'
    && payload.reason === null
    && payload.checks
    && typeof payload.checks === 'object'
    && !Array.isArray(payload.checks)
    && payload.checks.bootstrap === 'ready'
    && payload.checks.database === 'ready'
    && payload.checks.provider === 'configured'
  );
}

/**
 * Verify current role readiness. Public services receive a bounded, no-redirect
 * request; a private worker preserves the caller's exact-deployment activation
 * evidence without creating a public domain. This helper rejects a conflicting
 * live drain variable but does not replace effective provider-setting readback.
 */
export async function verifyReadinessActivation({
  variables,
  expectedIdentity,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  const target = resolveReadinessTarget(variables, expectedIdentity);
  if (target.mode === 'platform') {
    return {
      mode: target.mode,
      role: target.role,
      status: 'ready',
    };
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(target.url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
        },
      });
    } catch {
      fail('RAILWAY_READINESS_REQUEST_FAILED');
    }

    if (
      response.status !== 200
      || !hasJsonContentType(response.headers)
      || !hasNoStoreDirective(response.headers)
    ) {
      fail('RAILWAY_READINESS_RESPONSE_INVALID');
    }

    let rawBody;
    try {
      rawBody = await readResponseBodyBounded(response);
    } catch (error) {
      if (
        error instanceof Error
        && error.message === 'RAILWAY_READINESS_RESPONSE_TOO_LARGE'
      ) {
        throw error;
      }
      fail('RAILWAY_READINESS_REQUEST_FAILED');
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      fail('RAILWAY_READINESS_RESPONSE_INVALID');
    }

    const valid = target.role === 'web'
      ? hasExactWebReadinessShape(payload)
      : hasExactWorkerReadinessShape(payload);
    if (!valid) {
      fail('RAILWAY_READINESS_RESPONSE_INVALID');
    }

    return {
      mode: target.mode,
      role: target.role,
      status: 'ready',
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function readJsonFromStdin() {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of process.stdin) {
    totalBytes += Buffer.byteLength(chunk);
    if (totalBytes > MAX_VARIABLE_INPUT_BYTES) {
      fail('RAILWAY_READINESS_VARIABLES_TOO_LARGE');
    }
    chunks.push(Buffer.from(chunk));
  }

  try {
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8'));
  } catch {
    fail('RAILWAY_READINESS_VARIABLES_INVALID');
  }
}

async function main() {
  const variables = await readJsonFromStdin();
  const result = await verifyReadinessActivation({
    variables,
    expectedIdentity: {
      projectId: process.env.RAILWAY_PROJECT_ID,
      environmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
      serviceId: process.env.RAILWAY_SERVICE_ID,
    },
  });
  process.stdout.write(
    `role=${result.role} readiness=${result.status} evidence=${result.mode}\n`,
  );
}

const isEntrypoint = typeof process.argv[1] === 'string'
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((error) => {
    const code = error instanceof Error && /^RAILWAY_[A-Z0-9_]+$/u.test(error.message)
      ? error.message
      : 'RAILWAY_READINESS_VERIFICATION_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}

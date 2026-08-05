#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  NATIVE_PR_PREVIEW_E2E_CONTRACT,
} from './native-pr-preview-contract.mjs';

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_AGGREGATE_RESPONSE_BYTES = 512 * 1024;
const MAX_REQUESTS = 65;
const FIXTURE_CREATED_AT = '2026-07-30T00:00:00.000Z';
const FIXTURE_COMPLETED_AT = '2026-07-30T00:00:01.000Z';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;
const CANONICAL_REPOSITORY = 'pbjustin/Arcanos';
const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const VALUE_ARGUMENTS = new Set([
  '--commit-sha',
  '--max-response-bytes',
  '--pr-number',
  '--request-timeout-ms',
  '--total-timeout-ms',
  '--web-base-url',
  '--worker-base-url',
]);
const BOOLEAN_ARGUMENTS = new Set(['--allow-network', '--execute']);

export class NativePrPreviewE2eError extends Error {
  constructor(code, caseId = undefined) {
    super(code);
    this.code = code;
    this.caseId = caseId;
  }
}

function fail(code, caseId = undefined) {
  throw new NativePrPreviewE2eError(code, caseId);
}

function readInteger(value, minimum, maximum, code) {
  if (!INTEGER_PATTERN.test(value ?? '')) {
    fail(code);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(code);
  }
  return parsed;
}

function validatePreviewOrigin(rawValue, prNumber, code) {
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    fail(code);
  }
  const prMarker = new RegExp(
    `(?:^|[.-])pr-(?:[0-9a-f]{6}-)?${prNumber}(?:[.-]|$)`,
    'iu'
  );
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || (parsed.pathname !== '' && parsed.pathname !== '/')
    || parsed.search
    || parsed.hash
    || !parsed.hostname.endsWith('.up.railway.app')
    || !prMarker.test(parsed.hostname)
    || /(?:^|[.-])production(?:[.-]|$)/iu.test(parsed.hostname)
  ) {
    fail(code);
  }
  return parsed.origin;
}

function runLocalGit(args, cwd) {
  const environment = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
  };
  for (const environmentName of [
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
  ]) {
    const value =
      process.env[environmentName]
      ?? process.env[
        Object.keys(process.env).find(
          (name) => name.toUpperCase() === environmentName
        ) ?? ''
      ];
    if (value) {
      environment[environmentName] = value;
    }
  }
  const result = spawnSync('git', [
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.untrackedCache=false',
    ...args,
  ], {
    cwd,
    encoding: 'utf8',
    env: environment,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail('NATIVE_PR_PREVIEW_LOCAL_GIT_UNAVAILABLE');
  }
  return result.stdout.trim();
}

function normalizeCanonicalRepository(remoteUrl) {
  const normalizedUrl = remoteUrl.trim().replace(/\/+$/u, '');
  let repository;
  try {
    const parsed = new URL(normalizedUrl);
    if (
      parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === 'github.com'
      && !parsed.username
      && !parsed.password
      && !parsed.port
      && !parsed.search
      && !parsed.hash
    ) {
      repository = parsed.pathname.replace(/^\/+/u, '').replace(/\.git$/iu, '');
    }
  } catch {
    const sshMatch =
      /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/iu.exec(normalizedUrl);
    repository = sshMatch?.[1];
  }
  if (
    repository?.toLowerCase() !== CANONICAL_REPOSITORY.toLowerCase()
  ) {
    fail('NATIVE_PR_PREVIEW_LOCAL_REPOSITORY_MISMATCH');
  }
  return CANONICAL_REPOSITORY;
}

function repositoryPathsMatch(actualPath, expectedPath) {
  const actual = path.resolve(actualPath);
  const expected = path.resolve(expectedPath);
  return process.platform === 'win32'
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
}

export function readLocalGitState(cwd = REPOSITORY_ROOT) {
  const repositoryRoot = runLocalGit(
    ['rev-parse', '--show-toplevel'],
    cwd
  );
  if (!repositoryPathsMatch(repositoryRoot, REPOSITORY_ROOT)) {
    fail('NATIVE_PR_PREVIEW_LOCAL_REPOSITORY_ROOT_MISMATCH');
  }
  const head = runLocalGit(['rev-parse', 'HEAD'], cwd).toLowerCase();
  if (!COMMIT_PATTERN.test(head)) {
    fail('NATIVE_PR_PREVIEW_LOCAL_HEAD_UNAVAILABLE');
  }
  const worktreeStatus = runLocalGit(
    ['status', '--porcelain=v1', '--untracked-files=all'],
    cwd
  );
  if (worktreeStatus !== '') {
    fail('NATIVE_PR_PREVIEW_LOCAL_WORKTREE_DIRTY');
  }
  const repository = normalizeCanonicalRepository(
    runLocalGit(['remote', 'get-url', 'origin'], cwd)
  );
  return {
    clean: true,
    head,
    repository,
  };
}

export function parseNativePrPreviewE2eArguments(
  args,
  { localGitState = readLocalGitState() } = {}
) {
  const values = new Map();
  const booleans = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (BOOLEAN_ARGUMENTS.has(argument)) {
      if (booleans.has(argument)) {
        fail('NATIVE_PR_PREVIEW_ARGUMENT_DUPLICATE');
      }
      booleans.add(argument);
      continue;
    }
    if (!VALUE_ARGUMENTS.has(argument)) {
      fail('NATIVE_PR_PREVIEW_ARGUMENT_INVALID');
    }
    if (values.has(argument)) {
      fail('NATIVE_PR_PREVIEW_ARGUMENT_DUPLICATE');
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      fail('NATIVE_PR_PREVIEW_ARGUMENT_VALUE_REQUIRED');
    }
    values.set(argument, value);
    index += 1;
  }

  for (const requiredArgument of [
    '--commit-sha',
    '--pr-number',
    '--web-base-url',
    '--worker-base-url',
  ]) {
    if (!values.has(requiredArgument)) {
      fail('NATIVE_PR_PREVIEW_ARGUMENT_REQUIRED');
    }
  }

  const execute = booleans.has('--execute');
  const allowNetwork = booleans.has('--allow-network');
  if (execute !== allowNetwork) {
    fail('NATIVE_PR_PREVIEW_NETWORK_OPT_IN_INCOMPLETE');
  }
  const prNumber = readInteger(
    values.get('--pr-number'),
    1,
    Number.MAX_SAFE_INTEGER,
    'NATIVE_PR_PREVIEW_PR_NUMBER_INVALID'
  );
  const commitSha = values.get('--commit-sha');
  if (!COMMIT_PATTERN.test(commitSha ?? '')) {
    fail('NATIVE_PR_PREVIEW_COMMIT_INVALID');
  }
  if (!localGitState.clean) {
    fail('NATIVE_PR_PREVIEW_LOCAL_WORKTREE_DIRTY');
  }
  if (localGitState.repository !== CANONICAL_REPOSITORY) {
    fail('NATIVE_PR_PREVIEW_LOCAL_REPOSITORY_MISMATCH');
  }
  if (commitSha !== localGitState.head) {
    fail('NATIVE_PR_PREVIEW_LOCAL_HEAD_MISMATCH');
  }

  const webBaseUrl = validatePreviewOrigin(
    values.get('--web-base-url'),
    prNumber,
    'NATIVE_PR_PREVIEW_WEB_ORIGIN_INVALID'
  );
  const workerBaseUrl = validatePreviewOrigin(
    values.get('--worker-base-url'),
    prNumber,
    'NATIVE_PR_PREVIEW_WORKER_ORIGIN_INVALID'
  );
  if (webBaseUrl === workerBaseUrl) {
    fail('NATIVE_PR_PREVIEW_ORIGINS_MUST_DIFFER');
  }

  return {
    allowNetwork,
    commitSha,
    execute,
    maxResponseBytes: readInteger(
      values.get('--max-response-bytes') ?? String(DEFAULT_MAX_RESPONSE_BYTES),
      1_024,
      128 * 1_024,
      'NATIVE_PR_PREVIEW_MAX_RESPONSE_BYTES_INVALID'
    ),
    prNumber,
    repository: localGitState.repository,
    requestTimeoutMs: readInteger(
      values.get('--request-timeout-ms') ?? String(DEFAULT_REQUEST_TIMEOUT_MS),
      1_000,
      10_000,
      'NATIVE_PR_PREVIEW_REQUEST_TIMEOUT_INVALID'
    ),
    totalTimeoutMs: readInteger(
      values.get('--total-timeout-ms') ?? String(DEFAULT_TOTAL_TIMEOUT_MS),
      10_000,
      120_000,
      'NATIVE_PR_PREVIEW_TOTAL_TIMEOUT_INVALID'
    ),
    webBaseUrl,
    workerBaseUrl,
  };
}

function jobCase(
  caseId,
  fixtureName,
  suffix,
  method,
  status,
  expectedType
) {
  const fixtureId = NATIVE_PR_PREVIEW_E2E_CONTRACT.fixtures[fixtureName];
  return {
    boundedResponse: true,
    caseId,
    expectedStatus: status,
    expectedType,
    fixtureId,
    method,
    path: `/jobs/${fixtureId}${suffix}`,
    pathTemplate: `/jobs/:${fixtureName}${suffix}`,
    role: 'web',
    ...(method === 'POST'
      ? { body: { reason: 'bounded preview check' } }
      : {}),
  };
}

function researchCase(caseId, fixtureName, status) {
  const fixture =
    NATIVE_PR_PREVIEW_E2E_CONTRACT.research.fixtures[fixtureName];
  return {
    body: { fixture },
    boundedResponse: true,
    caseId,
    expectedStatus: status,
    expectedType: 'research-contract',
    fixture,
    fixtureName,
    method: 'POST',
    path: NATIVE_PR_PREVIEW_E2E_CONTRACT.research.path,
    pathTemplate: NATIVE_PR_PREVIEW_E2E_CONTRACT.research.path,
    role: 'web',
  };
}

function backstageStorylineCase(caseId, fixtureName, status) {
  const fixture =
    NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageStoryline.fixtures[fixtureName];
  return {
    body: { fixture },
    boundedResponse: true,
    caseId,
    expectedStatus: status,
    expectedType: 'backstage-storyline-contract',
    fixture,
    fixtureName,
    method: 'POST',
    path: NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageStoryline.path,
    pathTemplate: NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageStoryline.path,
    role: 'web',
  };
}

export function buildNativePrPreviewRequestPlan() {
  const cases = [
    {
      caseId: 'web-readiness-initial',
      expectedStatus: 200,
      expectedType: 'web-readiness',
      method: 'GET',
      path: '/readyz',
      pathTemplate: '/readyz',
      role: 'web',
    },
    {
      caseId: 'worker-readiness-initial',
      expectedStatus: 200,
      expectedType: 'worker-readiness',
      method: 'GET',
      path: '/readyz',
      pathTemplate: '/readyz',
      role: 'worker',
    },
  ];

  for (const role of ['web', 'worker']) {
    for (const path of ['/health', '/healthz']) {
      cases.push({
        caseId: `${role}-${path.slice(1)}-get`,
        expectedStatus: 200,
        expectedType: 'health',
        method: 'GET',
        path,
        pathTemplate: path,
        role,
      });
      if (path === '/health') {
        cases.push(
        {
          caseId: `${role}-${path.slice(1)}-head`,
          expectedStatus: 200,
          expectedType: 'head',
          method: 'HEAD',
          path,
          pathTemplate: path,
          role,
        }
        );
      }
    }
    cases.push({
      caseId: `${role}-readiness-head`,
      expectedStatus: 200,
      expectedType: 'head',
      method: 'HEAD',
      path: '/readyz',
      pathTemplate: '/readyz',
      role,
    });
  }

  cases.push(
    {
      caseId: 'web-gpt-access-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'GET',
      path: '/gpt-access/openapi.json',
      pathTemplate: '/gpt-access/openapi.json',
      role: 'web',
    },
    {
      caseId: 'web-unlisted-job-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'GET',
      path: `/jobs/${NATIVE_PR_PREVIEW_E2E_CONTRACT.unlistedJobId}`,
      pathTemplate: '/jobs/:unlisted',
      role: 'web',
    },
    {
      caseId: 'web-job-stream-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'GET',
      path:
        `/jobs/${NATIVE_PR_PREVIEW_E2E_CONTRACT.fixtures.completed}/stream`,
      pathTemplate: '/jobs/:completed/stream',
      role: 'web',
    },
    {
      caseId: 'web-health-post-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'POST',
      path: '/health',
      pathTemplate: '/health',
      role: 'web',
    },
    {
      caseId: 'web-readiness-query-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'GET',
      path: '/readyz?verbose=true',
      pathTemplate: '/readyz?query',
      role: 'web',
    },
    {
      caseId: 'worker-job-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'GET',
      path: `/jobs/${NATIVE_PR_PREVIEW_E2E_CONTRACT.fixtures.completed}`,
      pathTemplate: '/jobs/:completed',
      role: 'worker',
    },
    {
      caseId: 'worker-health-post-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'POST',
      path: '/health',
      pathTemplate: '/health',
      role: 'worker',
    },
    {
      caseId: 'worker-readiness-query-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'GET',
      path: '/readyz?verbose=true',
      pathTemplate: '/readyz?query',
      role: 'worker',
    }
  );

  cases.push(
    jobCase('completed-status', 'completed', '', 'GET', 200, 'completed-status'),
    jobCase('completed-result', 'completed', '/result', 'GET', 200, 'completed-result'),
    jobCase('failed-status', 'failed', '', 'GET', 200, 'failed-status'),
    jobCase('failed-result', 'failed', '/result', 'GET', 200, 'failed-result'),
    jobCase('cancellable-status', 'cancellable', '', 'GET', 200, 'pending-status'),
    jobCase('cancellable-result', 'cancellable', '/result', 'GET', 200, 'pending-result'),
    jobCase('cancellable-cancel', 'cancellable', '/cancel', 'POST', 200, 'cancelled'),
    jobCase('cancellable-status-after-cancel', 'cancellable', '', 'GET', 200, 'pending-status'),
    jobCase('cancellable-cancel-repeat', 'cancellable', '/cancel', 'POST', 200, 'cancelled'),
    jobCase('terminal-status', 'terminal', '', 'GET', 200, 'completed-status'),
    jobCase('terminal-result', 'terminal', '/result', 'GET', 200, 'completed-result'),
    jobCase('terminal-cancel', 'terminal', '/cancel', 'POST', 409, 'already-terminal'),
    jobCase('repository-status', 'repositoryUnavailable', '', 'GET', 503, 'repository-unavailable'),
    jobCase('repository-result', 'repositoryUnavailable', '/result', 'GET', 503, 'repository-unavailable'),
    jobCase('repository-cancel', 'repositoryUnavailable', '/cancel', 'POST', 503, 'repository-unavailable'),
    jobCase('missing-status', 'missing', '', 'GET', 404, 'job-not-found'),
    jobCase('missing-result', 'missing', '/result', 'GET', 200, 'result-not-found'),
    jobCase('missing-cancel', 'missing', '/cancel', 'POST', 404, 'job-not-found'),
    jobCase('auth-unavailable-status', 'authUnavailable', '', 'GET', 503, 'auth-unavailable'),
    jobCase('auth-unavailable-result', 'authUnavailable', '/result', 'GET', 503, 'auth-unavailable'),
    jobCase('auth-unavailable-cancel', 'authUnavailable', '/cancel', 'POST', 503, 'auth-unavailable'),
    jobCase('unauthorized-status', 'unauthorized', '', 'GET', 404, 'job-not-found'),
    jobCase('unauthorized-result', 'unauthorized', '/result', 'GET', 200, 'result-not-found'),
    jobCase('unauthorized-cancel', 'unauthorized', '/cancel', 'POST', 404, 'job-not-found'),
    jobCase('cancellation-outage-status', 'cancellationUnavailable', '', 'GET', 200, 'pending-status'),
    jobCase('cancellation-outage-result', 'cancellationUnavailable', '/result', 'GET', 200, 'pending-result'),
    jobCase('cancellation-outage-cancel', 'cancellationUnavailable', '/cancel', 'POST', 503, 'repository-unavailable'),
    {
      boundedResponse: true,
      caseId: 'invalid-job-status',
      expectedStatus: 400,
      expectedType: 'job-id-invalid',
      method: 'GET',
      path: `/jobs/${NATIVE_PR_PREVIEW_E2E_CONTRACT.invalidJobId}`,
      pathTemplate: '/jobs/:invalid',
      role: 'web',
    },
    {
      boundedResponse: true,
      caseId: 'invalid-job-result',
      expectedStatus: 400,
      expectedType: 'job-id-invalid',
      method: 'GET',
      path: `/jobs/${NATIVE_PR_PREVIEW_E2E_CONTRACT.invalidJobId}/result`,
      pathTemplate: '/jobs/:invalid/result',
      role: 'web',
    },
    {
      body: { reason: 'bounded preview check' },
      boundedResponse: true,
      caseId: 'invalid-job-cancel',
      expectedStatus: 400,
      expectedType: 'job-id-invalid',
      method: 'POST',
      path: `/jobs/${NATIVE_PR_PREVIEW_E2E_CONTRACT.invalidJobId}/cancel`,
      pathTemplate: '/jobs/:invalid/cancel',
      role: 'web',
    },
    researchCase('research-topic-exact', 'topicExact', 200),
    researchCase('research-topic-over', 'topicOver', 400),
    researchCase('research-url-count-exact', 'urlCountExact', 200),
    researchCase('research-url-count-over', 'urlCountOver', 400),
    researchCase('research-url-item-exact', 'urlItemExact', 200),
    researchCase('research-url-item-over', 'urlItemOver', 400),
    researchCase(
      'research-url-aggregate-exact',
      'urlAggregateExact',
      200
    ),
    researchCase(
      'research-url-aggregate-over',
      'urlAggregateOver',
      400
    ),
    researchCase('research-url-snapshot', 'urlSnapshot', 200),
    researchCase('research-storage-component', 'storageComponent', 200),
    backstageStorylineCase(
      'backstage-storyline-lifecycle-exact',
      'lifecycleExact',
      200
    ),
    backstageStorylineCase(
      'backstage-storyline-lifecycle-repeat',
      'lifecycleExact',
      200
    ),
    backstageStorylineCase(
      'backstage-storyline-payload-over',
      'payloadOver',
      400
    ),
    {
      body: {
        fixture:
          NATIVE_PR_PREVIEW_E2E_CONTRACT.research.fixtures.topicExact,
      },
      caseId: 'worker-research-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'POST',
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.research.path,
      pathTemplate: NATIVE_PR_PREVIEW_E2E_CONTRACT.research.path,
      role: 'worker',
    },
    {
      body: {
        fixture:
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageStoryline.fixtures
            .lifecycleExact,
      },
      caseId: 'worker-backstage-storyline-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'POST',
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageStoryline.path,
      pathTemplate: NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageStoryline.path,
      role: 'worker',
    },
    {
      caseId: 'web-readiness-final',
      expectedStatus: 200,
      expectedType: 'web-readiness',
      method: 'GET',
      path: '/readyz',
      pathTemplate: '/readyz',
      role: 'web',
    },
    {
      caseId: 'worker-readiness-final',
      expectedStatus: 200,
      expectedType: 'worker-readiness',
      method: 'GET',
      path: '/readyz',
      pathTemplate: '/readyz',
      role: 'worker',
    }
  );

  if (cases.length > MAX_REQUESTS) {
    fail('NATIVE_PR_PREVIEW_REQUEST_PLAN_TOO_LARGE');
  }
  return Object.freeze(cases.map((requestCase) => Object.freeze(requestCase)));
}

function expectedWebReadiness(options) {
  return {
    applicationImported: true,
    fixturesSealed: true,
    mode: NATIVE_PR_PREVIEW_E2E_CONTRACT.mode,
    prNumber: options.prNumber,
    processKind: 'web',
    protectedEffectsEnabled: false,
    protectsMaliciousPr: false,
    ready: true,
    requiresPlatformSecretIsolationForUntrustedCode: true,
    sourceCommit: options.commitSha,
    trustScope: NATIVE_PR_PREVIEW_E2E_CONTRACT.trustScope,
  };
}

function expectedWorkerReadiness(options) {
  return {
    ready: true,
    mode: 'passive-pr-preview',
    processKind: 'worker',
    prNumber: options.prNumber,
    sourceCommit: options.commitSha,
  };
}

function parseJsonBody(bodyText, caseId) {
  try {
    return JSON.parse(bodyText);
  } catch {
    fail('NATIVE_PR_PREVIEW_JSON_INVALID', caseId);
  }
}

function requireExactJson(actual, expected, caseId) {
  if (!isDeepStrictEqual(actual, expected)) {
    fail('NATIVE_PR_PREVIEW_BODY_MISMATCH', caseId);
  }
}

function jobLinks(jobId) {
  return {
    poll: `/jobs/${jobId}/result`,
    stream: `/jobs/${jobId}/stream`,
  };
}

function expectedStatusPayload(
  jobId,
  status,
  {
    answer = null,
    cancelReason = null,
    errorMessage = null,
  } = {}
) {
  const terminal = ['cancelled', 'completed', 'failed'].includes(status);
  const completedAt = terminal ? FIXTURE_COMPLETED_AT : null;
  const lifecycleStatus = status === 'pending' ? 'queued' : status;
  const result = answer === null
    ? null
    : { ok: true, result: { answer } };
  return {
    id: jobId,
    jobId,
    job_type: 'gpt',
    status,
    lifecycle_status: lifecycleStatus,
    created_at: FIXTURE_CREATED_AT,
    updated_at: completedAt ?? FIXTURE_CREATED_AT,
    completed_at: completedAt,
    cancel_requested_at: status === 'cancelled' ? completedAt : null,
    cancel_reason: cancelReason,
    retention_until: null,
    idempotency_until: null,
    expires_at: null,
    ...jobLinks(jobId),
    error_message: errorMessage,
    output: result,
    result,
  };
}

function expectedResultPayload(
  jobId,
  status,
  {
    answer = null,
    error = null,
  } = {}
) {
  const terminal = ['completed', 'failed'].includes(status);
  const completedAt = terminal ? FIXTURE_COMPLETED_AT : null;
  return {
    jobId,
    status,
    jobStatus: status,
    lifecycleStatus: status === 'pending' ? 'queued' : status,
    createdAt: FIXTURE_CREATED_AT,
    updatedAt: completedAt ?? FIXTURE_CREATED_AT,
    completedAt,
    retentionUntil: null,
    idempotencyUntil: null,
    expiresAt: null,
    ...jobLinks(jobId),
    result: answer === null
      ? null
      : { ok: true, result: { answer } },
    error,
  };
}

function expectedNotFoundResult(jobId) {
  return {
    jobId,
    status: 'not_found',
    jobStatus: null,
    lifecycleStatus: 'not_found',
    createdAt: null,
    updatedAt: null,
    completedAt: null,
    retentionUntil: null,
    idempotencyUntil: null,
    expiresAt: null,
    ...jobLinks(jobId),
    result: null,
    error: {
      code: 'JOB_NOT_FOUND',
      message: 'Async GPT job was not found.',
    },
  };
}

function expectedResearchContractPayload(requestCase) {
  const base = {
    fixture: requestCase.fixture,
    protectedEffectsEnabled: false,
    schemaVersion: 1,
  };
  if (requestCase.expectedStatus === 400) {
    return {
      accepted: false,
      confirmationAttempted: false,
      effectsBoundaryReached: false,
      eligibleForConfirmation: false,
      ...base,
      postValidationBoundaryReached: false,
      validationCompleted: true,
      validationCode: 'RESEARCH_REQUEST_INVALID',
    };
  }

  const normalizedByFixture = {
    topicExact: {
      topicLength: 500,
      urlAggregateLength: 0,
      urlCount: 0,
      urlItemMaxLength: 0,
    },
    urlCountExact: {
      topicLength: 18,
      urlAggregateLength: 0,
      urlCount: 0,
      urlItemMaxLength: 0,
    },
    urlItemExact: {
      topicLength: 17,
      urlAggregateLength: 2_048,
      urlCount: 1,
      urlItemMaxLength: 2_048,
    },
    urlAggregateExact: {
      topicLength: 22,
      urlAggregateLength: 16_384,
      urlCount: 8,
      urlItemMaxLength: 2_048,
    },
    urlSnapshot: {
      topicLength: 12,
      urlAggregateLength: 38,
      urlCount: 1,
      urlItemMaxLength: 38,
    },
    storageComponent: {
      topicLength: 36,
      urlAggregateLength: 0,
      urlCount: 0,
      urlItemMaxLength: 0,
    },
  };
  const normalized = normalizedByFixture[requestCase.fixtureName];
  if (!normalized) {
    fail('NATIVE_PR_PREVIEW_CASE_CONTRACT_INVALID', requestCase.caseId);
  }
  return {
    accepted: true,
    confirmationAttempted: false,
    effectsBoundaryReached: false,
    eligibleForConfirmation: true,
    ...base,
    normalized,
    postValidationBoundaryReached: true,
    ...(requestCase.fixtureName === 'urlSnapshot'
      ? {
          snapshot: {
            descriptorReads: 1,
            normalizedUrl: 'https://example.invalid/first-snapshot',
            sourceMutationIsolated: true,
          },
        }
      : {}),
    ...(requestCase.fixtureName === 'storageComponent'
      ? {
          storage: {
            ascii: true,
            bytes: 97,
            component:
              'abcdefghijklmnopqrstuvwxyz012345-cc4166d770c11a66f226530d5a8d6c2d2b79bae729cf6f4c9350bb4635b8500d',
            deterministic: true,
            maxBytes: 97,
            portablePattern: true,
            withinLimit: true,
          },
        }
      : {}),
    validationCompleted: true,
    validationCode: 'VALID',
  };
}

function expectedBackstageStorylineContractPayload(requestCase) {
  const base = {
    fixture: requestCase.fixture,
    protectedEffectsEnabled: false,
    schemaVersion: 1,
  };
  if (requestCase.fixtureName === 'payloadOver') {
    return {
      accepted: false,
      confirmationAttempted: false,
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      eligibleForConfirmation: false,
      ...base,
      durablePersistenceAttempted: false,
      postValidationBoundaryReached: false,
      transactionComponentExecuted: false,
      validationCompleted: true,
      validationCode: 'BACKSTAGE_STORYLINE_INVALID',
    };
  }
  if (requestCase.fixtureName !== 'lifecycleExact') {
    fail('NATIVE_PR_PREVIEW_CASE_CONTRACT_INVALID', requestCase.caseId);
  }
  return {
    accepted: true,
    confirmationAttempted: false,
    databaseBoundaryReached: false,
    effectsBoundaryReached: false,
    eligibleForConfirmation: true,
    ...base,
    durablePersistenceAttempted: false,
    postValidationBoundaryReached: true,
    transactionComponentExecuted: true,
    validationCompleted: true,
    validationCode: 'VALID',
    lifecycle: {
      exactBytes: 16_384,
      finalResponseSequences: Array.from(
        { length: 25 },
        (_unused, index) => index + 78
      ),
      firstAcceptedBeatIncluded: true,
      firstAncientBeatRetained: true,
      firstNewestSequence: 101,
      firstOldestSequence: 2,
      firstResponseFirstSequence: 77,
      firstResponseLastSequence: 101,
      freshReadObservedPriorAcceptedBeat: true,
      mutationCount: 2,
      queryPhaseCount: 18,
      responseCount: 25,
      responseLimit: 25,
      retainedCount: 100,
      retentionLimit: 100,
      secondAcceptedBeatIncluded: true,
      secondNewestSequence: 102,
      secondOldestSequence: 3,
      transactionPhaseOrderVerified: true,
    },
  };
}

export function expectedNativePrPreviewContentType(requestCase) {
  if (
    requestCase.expectedType === 'health'
    || requestCase.expectedType === 'not-found'
    || (
      requestCase.expectedType === 'head'
      && requestCase.path !== '/readyz'
    )
  ) {
    return 'text/plain; charset=utf-8';
  }
  return 'application/json; charset=utf-8';
}

export function expectedNativePrPreviewResponseBody(requestCase, options) {
  const completedAnswer = requestCase.fixtureId
    === NATIVE_PR_PREVIEW_E2E_CONTRACT.fixtures.terminal
    ? 'synthetic terminal result'
    : 'synthetic preview result';
  switch (requestCase.expectedType) {
    case 'health':
      return 'ok';
    case 'not-found':
      return 'not found';
    case 'web-readiness':
      return expectedWebReadiness(options);
    case 'worker-readiness':
      return expectedWorkerReadiness(options);
    case 'completed-status':
      return expectedStatusPayload(
        requestCase.fixtureId,
        'completed',
        { answer: completedAnswer }
      );
    case 'completed-result':
      return expectedResultPayload(
        requestCase.fixtureId,
        'completed',
        { answer: completedAnswer }
      );
    case 'failed-status':
      return expectedStatusPayload(
        requestCase.fixtureId,
        'failed',
        { errorMessage: 'Synthetic preview failure.' }
      );
    case 'failed-result':
      return expectedResultPayload(
        requestCase.fixtureId,
        'failed',
        {
          error: {
            code: 'JOB_FAILED',
            message: 'Synthetic preview failure.',
            details: {
              lifecycleStatus: 'failed',
              jobStatus: 'failed',
              resultRetained: false,
            },
          },
        }
      );
    case 'pending-status':
      return expectedStatusPayload(requestCase.fixtureId, 'pending');
    case 'pending-result':
      return expectedResultPayload(requestCase.fixtureId, 'pending');
    case 'cancelled':
      return {
        ok: true,
        cancellationRequested: false,
        ...expectedStatusPayload(
          requestCase.fixtureId,
          'cancelled',
          { cancelReason: 'Synthetic preview cancellation.' }
        ),
      };
    case 'already-terminal':
      return {
        ok: false,
        error: {
          code: 'JOB_ALREADY_TERMINAL',
          message: 'Terminal jobs cannot be cancelled.',
        },
        job: expectedStatusPayload(
          requestCase.fixtureId,
          'completed',
          { answer: completedAnswer }
        ),
      };
    case 'repository-unavailable':
      return { error: 'JOB_REPOSITORY_UNAVAILABLE' };
    case 'job-not-found':
      return { error: 'JOB_NOT_FOUND' };
    case 'result-not-found':
      return expectedNotFoundResult(requestCase.fixtureId);
    case 'auth-unavailable':
      return {
        error: 'JOB_READ_AUTH_UNAVAILABLE',
        message: 'Async job reads are temporarily unavailable.',
      };
    case 'job-id-invalid':
      return { error: 'JOB_ID_INVALID' };
    case 'research-contract':
      return expectedResearchContractPayload(requestCase);
    case 'backstage-storyline-contract':
      return expectedBackstageStorylineContractPayload(requestCase);
    default:
      fail('NATIVE_PR_PREVIEW_CASE_CONTRACT_INVALID', requestCase.caseId);
  }
}

function validateResponseBody(requestCase, bodyBytes, options) {
  const bodyText = bodyBytes.toString('utf8');
  if (requestCase.expectedType === 'head') {
    if (bodyBytes.length !== 0) {
      fail('NATIVE_PR_PREVIEW_HEAD_BODY_PRESENT', requestCase.caseId);
    }
    return;
  }

  const expectedBody = expectedNativePrPreviewResponseBody(
    requestCase,
    options
  );
  if (typeof expectedBody === 'string') {
    if (bodyText !== expectedBody) {
      fail('NATIVE_PR_PREVIEW_BODY_MISMATCH', requestCase.caseId);
    }
    return;
  }

  const body = parseJsonBody(bodyText, requestCase.caseId);
  requireExactJson(body, expectedBody, requestCase.caseId);
}

async function readBoundedResponseBody(
  response,
  requestCase,
  maxResponseBytes,
  aggregateState
) {
  const reader = response.body?.getReader();
  if (!reader) {
    return Buffer.alloc(0);
  }
  const chunks = [];
  let responseBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    responseBytes += value.byteLength;
    aggregateState.bytes += value.byteLength;
    if (
      responseBytes > maxResponseBytes
      || aggregateState.bytes > MAX_AGGREGATE_RESPONSE_BYTES
    ) {
      await reader.cancel();
      fail('NATIVE_PR_PREVIEW_RESPONSE_LIMIT_EXCEEDED', requestCase.caseId);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, responseBytes);
}

async function executeRequestCase(
  requestCase,
  options,
  fetchImpl,
  deadlineMs,
  aggregateState
) {
  const baseUrl =
    requestCase.role === 'web' ? options.webBaseUrl : options.workerBaseUrl;
  const requestUrl = `${baseUrl}${requestCase.path}`;
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs < 1) {
    fail('NATIVE_PR_PREVIEW_TOTAL_TIMEOUT', requestCase.caseId);
  }
  const timeoutMs = Math.max(
    1,
    Math.min(options.requestTimeoutMs, remainingMs)
  );
  let response;
  try {
    response = await fetchImpl(requestUrl, {
      body: requestCase.body === undefined
        ? undefined
        : JSON.stringify(requestCase.body),
      headers: requestCase.body === undefined
        ? { accept: 'application/json, text/plain' }
        : {
            accept: 'application/json',
            'content-type': 'application/json',
          },
      method: requestCase.method,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    fail('NATIVE_PR_PREVIEW_NETWORK_REQUEST_FAILED', requestCase.caseId);
  }

  if (
    response.redirected
    || response.url !== requestUrl
    || response.headers.has('location')
    || response.headers.has('set-cookie')
    || response.headers.has('www-authenticate')
  ) {
    fail('NATIVE_PR_PREVIEW_RESPONSE_BOUNDARY_INVALID', requestCase.caseId);
  }
  if (response.status !== requestCase.expectedStatus) {
    fail('NATIVE_PR_PREVIEW_HTTP_STATUS_MISMATCH', requestCase.caseId);
  }
  if (!/(?:^|,)\s*no-store\s*(?:,|$)/iu.test(
    response.headers.get('cache-control') ?? ''
  )) {
    fail('NATIVE_PR_PREVIEW_NO_STORE_MISSING', requestCase.caseId);
  }
  if (
    response.headers.get('content-type')
    !== expectedNativePrPreviewContentType(requestCase)
  ) {
    fail('NATIVE_PR_PREVIEW_CONTENT_TYPE_INVALID', requestCase.caseId);
  }

  const bodyBytes = await readBoundedResponseBody(
    response,
    requestCase,
    options.maxResponseBytes,
    aggregateState
  );
  if (requestCase.boundedResponse) {
    const declaredBytes = response.headers.get('x-response-bytes') ?? '';
    if (
      !INTEGER_PATTERN.test(declaredBytes)
      || Number.parseInt(declaredBytes, 10) !== bodyBytes.length
    ) {
      fail('NATIVE_PR_PREVIEW_BOUNDED_RESPONSE_INVALID', requestCase.caseId);
    }
  }
  validateResponseBody(requestCase, bodyBytes, options);
  return {
    bodySha256: createHash('sha256').update(bodyBytes).digest('hex'),
    caseId: requestCase.caseId,
    httpStatus: response.status,
    method: requestCase.method,
    pathTemplate: requestCase.pathTemplate,
    responseBytes: bodyBytes.length,
    role: requestCase.role,
  };
}

export async function runNativePrPreviewE2e({
  args,
  fetchImpl = globalThis.fetch,
  localGitState = undefined,
} = {}) {
  const options = parseNativePrPreviewE2eArguments(
    args ?? [],
    localGitState === undefined ? {} : { localGitState }
  );
  const requestPlan = buildNativePrPreviewRequestPlan();
  const target = {
    repository: options.repository,
    prNumber: options.prNumber,
    commitSha: options.commitSha,
    webHost: new URL(options.webBaseUrl).hostname,
    workerHost: new URL(options.workerBaseUrl).hostname,
  };
  const limits = {
    maxAggregateResponseBytes: MAX_AGGREGATE_RESPONSE_BYTES,
    maxRequests: MAX_REQUESTS,
    maxResponseBytes: options.maxResponseBytes,
    requestTimeoutMs: options.requestTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs,
  };
  if (!options.execute) {
    return {
      schemaVersion: 1,
      kind: 'native_pr_preview_application_e2e',
      mode: 'DRY_RUN',
      executed: false,
      networkAttempted: false,
      target,
      attestation: {
        controlPlaneProvenanceAsserted: false,
        canonicalRepositoryMatched: true,
        localHeadMatched: true,
        localWorktreeClean: true,
        scope: 'served-public-identity',
      },
      limits,
      checks: [],
      summary: {
        status: 'PASS',
        code: 'EXPLICIT_NATIVE_PR_TARGET_VALIDATED_NO_NETWORK',
        checksPassed: 0,
        plannedRequests: requestPlan.length,
        requestsMade: 0,
      },
    };
  }
  if (typeof fetchImpl !== 'function') {
    fail('NATIVE_PR_PREVIEW_FETCH_UNAVAILABLE');
  }

  const checks = [];
  const aggregateState = { bytes: 0 };
  const deadlineMs = Date.now() + options.totalTimeoutMs;
  const initialIdentityHashes = new Map();
  for (const requestCase of requestPlan) {
    const check = await executeRequestCase(
      requestCase,
      options,
      fetchImpl,
      deadlineMs,
      aggregateState
    );
    checks.push(check);
    if (requestCase.caseId.endsWith('-readiness-initial')) {
      initialIdentityHashes.set(requestCase.role, check.bodySha256);
    }
    if (
      requestCase.caseId.endsWith('-readiness-final')
      && initialIdentityHashes.get(requestCase.role) !== check.bodySha256
    ) {
      fail('NATIVE_PR_PREVIEW_IDENTITY_DRIFT', requestCase.caseId);
    }
  }

  return {
    schemaVersion: 1,
    kind: 'native_pr_preview_application_e2e',
    mode: 'EXECUTE',
    executed: true,
    networkAttempted: true,
    target,
    attestation: {
      controlPlaneProvenanceAsserted: false,
      canonicalRepositoryMatched: true,
      localHeadMatched: true,
      localWorktreeClean: true,
      scope: 'served-public-identity',
    },
    limits,
    checks,
    summary: {
      status: 'PASS',
      code: 'NATIVE_PR_PREVIEW_APPLICATION_E2E_PASS',
      checksPassed: checks.length,
      plannedRequests: requestPlan.length,
      requestsMade: checks.length,
      responseBytes: aggregateState.bytes,
    },
  };
}

async function runCli() {
  try {
    const result = await runNativePrPreviewE2e({
      args: process.argv.slice(2),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const failure = error instanceof NativePrPreviewE2eError
      ? error
      : new NativePrPreviewE2eError(
          'NATIVE_PR_PREVIEW_E2E_UNEXPECTED_FAILURE'
        );
    process.stderr.write(`${JSON.stringify({
      schemaVersion: 1,
      kind: 'native_pr_preview_application_e2e',
      summary: {
        status: 'FAIL',
        code: failure.code,
        ...(failure.caseId ? { caseId: failure.caseId } : {}),
      },
    })}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runCli();
}

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
const MAX_REQUESTS = 137;
const MAX_BACKSTAGE_BOOKER_OPENAPI_SOURCE_BYTES = 128 * 1024;
const BACKSTAGE_BOOKER_OPENAPI_GIT_PATH =
  'contracts/backstage_booker.openapi.v1.json';
const BACKSTAGE_BOOKER_OPENAPI_VERSION_PATTERN = /^1\.\d+\.\d+$/u;
const BACKSTAGE_QUEUE_WAIT_POLICY_PROOF_VERSIONS = Object.freeze([
  'backstage-booker-queue-wait-policy/v1',
  'backstage-booker-queue-wait-policy/v2',
]);
const BACKSTAGE_MANAGED_ASYNC_PROOF_VERSIONS = Object.freeze([
  'backstage-booker-managed-async-continuation/v1',
  'backstage-booker-managed-async-continuation/v2',
]);
const BACKSTAGE_BOOKER_OPENAPI_PATHS = Object.freeze([
  '/gpt-access/capabilities/v1/backstage-booker/jobs/{jobId}/result',
  '/gpt-access/capabilities/v1/backstage-booker/run',
  '/gpt-access/capabilities/v1/backstage-booker/universes/{universeId}',
  '/gpt-access/capabilities/v1/backstage-booker/universes/{universeId}/storyline-summary',
  '/gpt/backstage-booker',
]);
const BACKSTAGE_GENERATION_REQUEST_TIMEOUT_MS = 20_000;
const BACKSTAGE_GENERATION_MIN_RESPONSE_MS = 13_000;
const RESEARCH_CANCELLATION_MIN_RESPONSE_MS = 300;
const FIXTURE_CREATED_AT = '2026-07-30T00:00:00.000Z';
const FIXTURE_COMPLETED_AT = '2026-07-30T00:00:01.000Z';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;
const CANONICAL_REPOSITORY = 'pbjustin/Arcanos';
const WEB_RESPONSE_HEADER_CONTRACT = Object.freeze({
  'content-security-policy':
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=()',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});
const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const VALUE_ARGUMENTS = new Set([
  '--commit-sha',
  '--git-evidence-root',
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

export function readLocalGitState(cwd = REPOSITORY_ROOT, expectedRoot = cwd) {
  const repositoryRoot = runLocalGit(
    ['rev-parse', '--show-toplevel'],
    cwd
  );
  if (!repositoryPathsMatch(repositoryRoot, expectedRoot)) {
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

export function readExpectedBackstageBookerOpenApiDocument(
  gitEvidenceRoot,
  commitSha
) {
  if (!COMMIT_PATTERN.test(commitSha ?? '')) {
    fail('NATIVE_PR_PREVIEW_COMMIT_INVALID');
  }
  const source = runLocalGit(
    ['show', commitSha + ':' + BACKSTAGE_BOOKER_OPENAPI_GIT_PATH],
    gitEvidenceRoot
  );
  if (
    Buffer.byteLength(source, 'utf8')
      > MAX_BACKSTAGE_BOOKER_OPENAPI_SOURCE_BYTES
  ) {
    fail('NATIVE_PR_PREVIEW_BACKSTAGE_BOOKER_OPENAPI_SOURCE_TOO_LARGE');
  }
  try {
    const document = JSON.parse(source);
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      fail('NATIVE_PR_PREVIEW_BACKSTAGE_BOOKER_OPENAPI_SOURCE_INVALID');
    }
    return document;
  } catch (error) {
    if (error instanceof NativePrPreviewE2eError) {
      throw error;
    }
    fail('NATIVE_PR_PREVIEW_BACKSTAGE_BOOKER_OPENAPI_SOURCE_INVALID');
  }
}

export function parseNativePrPreviewE2eArguments(
  args,
  { localGitState = undefined } = {}
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

  const gitEvidenceRoot = values.has('--git-evidence-root')
    ? path.resolve(values.get('--git-evidence-root'))
    : REPOSITORY_ROOT;
  const observedLocalGitState = localGitState
    ?? readLocalGitState(gitEvidenceRoot, gitEvidenceRoot);

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
  if (!observedLocalGitState.clean) {
    fail('NATIVE_PR_PREVIEW_LOCAL_WORKTREE_DIRTY');
  }
  if (observedLocalGitState.repository !== CANONICAL_REPOSITORY) {
    fail('NATIVE_PR_PREVIEW_LOCAL_REPOSITORY_MISMATCH');
  }
  if (commitSha !== observedLocalGitState.head) {
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
    gitEvidenceRoot,
    maxResponseBytes: readInteger(
      values.get('--max-response-bytes') ?? String(DEFAULT_MAX_RESPONSE_BYTES),
      1_024,
      128 * 1_024,
      'NATIVE_PR_PREVIEW_MAX_RESPONSE_BYTES_INVALID'
    ),
    prNumber,
    repository: observedLocalGitState.repository,
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

function backstageGenerationCase(caseId, fixtureName, simulatedAuth = false) {
  const fixture =
    NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.fixtures[fixtureName];
  return {
    body: { fixture },
    boundedResponse: true,
    caseId,
    expectedStatus: 200,
    expectedType: 'backstage-generation-contract',
    fixture,
    fixtureName,
    method: 'POST',
    path: NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.path,
    pathTemplate: NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.path,
    requestTimeoutMs: BACKSTAGE_GENERATION_REQUEST_TIMEOUT_MS,
    role: 'web',
    ...(simulatedAuth ? { simulatedAuth: true } : {}),
  };
}

function mcpBodyCapCase(caseId, fixtureName, status) {
  const fixture =
    NATIVE_PR_PREVIEW_E2E_CONTRACT.mcpBodyCap.fixtures[fixtureName];
  return {
    body: { fixture },
    boundedResponse: true,
    caseId,
    expectedStatus: status,
    expectedType: 'mcp-body-cap-contract',
    fixture,
    fixtureName,
    method: 'POST',
    path: NATIVE_PR_PREVIEW_E2E_CONTRACT.mcpBodyCap.path,
    pathTemplate: NATIVE_PR_PREVIEW_E2E_CONTRACT.mcpBodyCap.path,
    role: 'web',
  };
}

function dispatchGptIdentifierCase(caseId, fixtureName, status) {
  const fixture =
    NATIVE_PR_PREVIEW_E2E_CONTRACT.dispatchGptIdentifier.fixtures[fixtureName];
  return {
    body: { fixture },
    boundedResponse: true,
    caseId,
    expectedStatus: status,
    expectedType: 'dispatch-gpt-identifier-contract',
    fixture,
    fixtureName,
    method: 'POST',
    path: NATIVE_PR_PREVIEW_E2E_CONTRACT.dispatchGptIdentifier.path,
    pathTemplate: NATIVE_PR_PREVIEW_E2E_CONTRACT.dispatchGptIdentifier.path,
    role: 'web',
  };
}

function statusAuthBoundaryCase(caseId, fixtureName) {
  const fixture =
    NATIVE_PR_PREVIEW_E2E_CONTRACT.statusAuthBoundary.fixtures[fixtureName];
  return {
    body: { fixture },
    boundedResponse: true,
    caseId,
    expectedStatus: 200,
    expectedType: 'status-auth-boundary-contract',
    fixture,
    fixtureName,
    method: 'POST',
    path: NATIVE_PR_PREVIEW_E2E_CONTRACT.statusAuthBoundary.path,
    pathTemplate: NATIVE_PR_PREVIEW_E2E_CONTRACT.statusAuthBoundary.path,
    role: 'web',
    simulatedAuth: true,
  };
}

function selfHealApprovalCase(caseId, fixtureName) {
  const fixture =
    NATIVE_PR_PREVIEW_E2E_CONTRACT.selfHealApproval.fixtures[fixtureName];
  return {
    body: { fixture },
    boundedResponse: true,
    caseId,
    expectedStatus: 200,
    expectedType: 'self-heal-approval-contract',
    fixture,
    fixtureName,
    method: 'POST',
    path: NATIVE_PR_PREVIEW_E2E_CONTRACT.selfHealApproval.path,
    pathTemplate: NATIVE_PR_PREVIEW_E2E_CONTRACT.selfHealApproval.path,
    role: 'web',
  };
}

function gamingQueryBody(mode, prompt, extraPayload = undefined) {
  return {
    action: 'query',
    payload: {
      mode,
      game: NATIVE_PR_PREVIEW_E2E_CONTRACT.gaming.game,
      prompt,
      ...(extraPayload ?? {}),
    },
  };
}

function gamingCase(
  caseId,
  body,
  status,
  expectedType,
  extra = undefined
) {
  return {
    body,
    boundedResponse: true,
    caseId,
    expectedStatus: status,
    expectedType,
    method: 'POST',
    path: expectedType.startsWith('gaming-canary')
      ? NATIVE_PR_PREVIEW_E2E_CONTRACT.gaming.canaryPath
      : NATIVE_PR_PREVIEW_E2E_CONTRACT.gaming.queryPath,
    pathTemplate: expectedType.startsWith('gaming-canary')
      ? NATIVE_PR_PREVIEW_E2E_CONTRACT.gaming.canaryPath
      : NATIVE_PR_PREVIEW_E2E_CONTRACT.gaming.queryPath,
    role: 'web',
    ...(extra ?? {}),
  };
}

function gamingSourceIngestionBody(idempotencyKey, extraPayload = undefined) {
  return {
    action: 'ingest',
    payload: {
      game: NATIVE_PR_PREVIEW_E2E_CONTRACT.gaming.game,
      sourceUrls: ['https://example.invalid/palworld/guide'],
      origin: 'user_supplied',
      idempotencyKey,
      ...(extraPayload ?? {}),
    },
  };
}

function gamingSourceRefreshBody(idempotencyKey, extraPayload = undefined) {
  return {
    action: 'refresh',
    payload: {
      sourceIds: [NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.sourceId],
      idempotencyKey,
      reason: 'user_requested',
      ...(extraPayload ?? {}),
    },
  };
}

function percentEncodeEveryAsciiCharacter(value) {
  return [...value].map((character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  )).join('');
}

function simulatedGamingSourceCase({
  body,
  caseId,
  expectedStatus,
  fixture,
  headers = undefined,
  method = 'POST',
  path,
  pathTemplate = path,
  rawBody = undefined,
  sourceScenario,
}) {
  return {
    ...(body === undefined ? {} : { body }),
    ...(rawBody === undefined ? {} : { rawBody }),
    boundedResponse: true,
    caseId,
    expectedStatus,
    expectedType: 'gaming-source',
    headers: {
      [NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtureHeader]: fixture,
      ...(headers ?? {}),
    },
    method,
    path,
    pathTemplate,
    role: 'web',
    simulatedAuth: true,
    sourceScenario,
  };
}

export function nativePrPreviewCaseCorrelation(requestCase) {
  return {
    requestId: `native-pr-${requestCase.caseId}`,
    traceId: `native-pr-trace-${requestCase.caseId}`,
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
    {
      caseId: 'web-backstage-booker-openapi',
      expectedStatus: 200,
      expectedType: 'backstage-booker-openapi',
      method: 'GET',
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageBookerOpenApi.path,
      pathTemplate: NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageBookerOpenApi.path,
      role: 'web',
    },
    {
      caseId: 'worker-backstage-booker-openapi-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'GET',
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageBookerOpenApi.path,
      pathTemplate: NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageBookerOpenApi.path,
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
    },
    {
      body: {
        fixture:
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.fixtures
            .continuityQuery,
      },
      caseId: 'worker-backstage-generation-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'POST',
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.path,
      pathTemplate: NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.path,
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
    researchCase(
      'research-workflow-cancellation-drain',
      'workflowCancellationDrain',
      200
    ),
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
      'backstage-phase-one-universe-binding',
      'phaseOneUniverseBinding',
      200
    ),
    backstageStorylineCase(
      'backstage-storyline-payload-over',
      'payloadOver',
      400
    ),
    backstageStorylineCase(
      'backstage-saved-storyline-projection',
      'savedStorylineProjection',
      200
    ),
    backstageStorylineCase(
      'backstage-storyline-summary-pagination',
      'summaryPagination',
      200
    ),
    backstageGenerationCase(
      'backstage-generation-route-budget',
      'routeBudget'
    ),
    backstageGenerationCase(
      'backstage-generation-hrc-retry-cache',
      'hrcRetryCache'
    ),
    backstageGenerationCase(
      'backstage-generation-review-completion',
      'reviewCompletion'
    ),
    backstageGenerationCase(
      'backstage-generation-compact-retry',
      'compactRetry'
    ),
    backstageGenerationCase(
      'backstage-generation-production-output-contracts',
      'productionOutputContracts'
    ),
    backstageGenerationCase(
      'backstage-generation-output-admission',
      'outputAdmission'
    ),
    backstageGenerationCase(
      'backstage-generation-notion-sync-phase-a',
      'notionSyncPhaseA'
    ),
    backstageGenerationCase(
      'backstage-generation-notion-authority-rag',
      'notionAuthorityRag'
    ),
    backstageGenerationCase(
      'backstage-generation-partition-failure-telemetry',
      'partitionFailureTelemetry'
    ),
    backstageGenerationCase(
      'backstage-generation-continuity-query',
      'continuityQuery'
    ),
    backstageGenerationCase(
      'backstage-generation-continuity-subtree',
      'continuitySubtree'
    ),
    backstageGenerationCase(
      'backstage-generation-managed-async-continuation',
      'managedAsyncContinuation',
      true
    ),
    backstageGenerationCase(
      'backstage-generation-protected-failure-no-fallback',
      'protectedFailureNoFallback',
      true
    ),
    backstageGenerationCase(
      'backstage-generation-gpt-client-identity',
      'gptClientIdentity',
      true
    ),
    mcpBodyCapCase(
      'mcp-body-cap-effective-limits',
      'effectiveLimits',
      200
    ),
    dispatchGptIdentifierCase(
      'dispatch-gpt-identifier-maximum-length',
      'maximumLength',
      200
    ),
    dispatchGptIdentifierCase(
      'dispatch-gpt-identifier-oversized',
      'oversized',
      400
    ),
    statusAuthBoundaryCase(
      'status-auth-before-parser',
      'authBeforeParser'
    ),
    selfHealApprovalCase(
      'self-heal-approval-denied-outcomes',
      'deniedOutcomes'
    ),
    selfHealApprovalCase(
      'self-heal-approval-valid-completed',
      'validCompleted'
    ),
    selfHealApprovalCase(
      'self-heal-approval-incoherent-completed',
      'incoherentCompleted'
    ),
    selfHealApprovalCase(
      'self-heal-approval-disabled-legacy',
      'disabledLegacy'
    ),
    selfHealApprovalCase(
      'self-heal-approval-manual-independence',
      'manualIndependence'
    ),
    selfHealApprovalCase(
      'self-heal-approval-production-debug-denial',
      'productionDebugDenial'
    ),
    gamingCase(
      'gaming-canary-success',
      { action: 'canary', payload: { scope: 'public_pipeline' } },
      200,
      'gaming-canary'
    ),
    gamingCase(
      'gaming-canary-closed-schema',
      {
        action: 'canary',
        payload: { scope: 'public_pipeline', unexpected: true },
      },
      400,
      'gaming-canary-invalid'
    ),
    ...(['guide', 'build', 'meta'].map((mode) => gamingCase(
      `gaming-query-${mode}`,
      gamingQueryBody(
        mode,
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gaming.fixtures[mode]
      ),
      200,
      'gaming-query',
      { gamingMode: mode }
    ))),
    gamingCase(
      'gaming-query-mode-required',
      {
        action: 'query',
        payload: {
          game: NATIVE_PR_PREVIEW_E2E_CONTRACT.gaming.game,
          prompt: NATIVE_PR_PREVIEW_E2E_CONTRACT.gaming.fixtures.guide,
        },
      },
      400,
      'gaming-query-validation',
      {
        validation: {
          code: 'GAMEPLAY_MODE_REQUIRED',
          message:
            "Gameplay requests require explicit mode 'guide', 'build', or 'meta'.",
        },
      }
    ),
    gamingCase(
      'gaming-query-operational-guard',
      gamingQueryBody(
        'guide',
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gaming.fixtures.operational
      ),
      400,
      'gaming-query-operational'
    ),
    {
      body: gamingSourceIngestionBody(
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.idempotencyKeys
          .unauthorized
      ),
      boundedResponse: true,
      caseId: 'gaming-source-ingestion-unauthorized',
      expectedStatus: 401,
      expectedType: 'gaming-source',
      method: 'POST',
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath,
      pathTemplate:
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath,
      role: 'web',
      sourceScenario: 'unauthorized',
    },
    {
      boundedResponse: true,
      caseId: 'gaming-source-ingestion-malformed-unauthorized',
      expectedStatus: 401,
      expectedType: 'gaming-source',
      method: 'POST',
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath,
      pathTemplate:
        `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath}:malformed`,
      rawBody: '{"action":',
      role: 'web',
      sourceScenario: 'unauthorized',
    },
    {
      boundedResponse: true,
      caseId: 'gaming-source-ingestion-oversized-unauthorized',
      expectedStatus: 401,
      expectedType: 'gaming-source',
      method: 'POST',
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath,
      pathTemplate:
        `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath}:oversized`,
      rawBody: 'x'.repeat(16_385),
      role: 'web',
      sourceScenario: 'unauthorized',
    },
    {
      body: gamingSourceRefreshBody(
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.idempotencyKeys
          .refreshUnauthorized
      ),
      boundedResponse: true,
      caseId: 'gaming-source-refresh-unauthorized',
      expectedStatus: 401,
      expectedType: 'gaming-source',
      method: 'POST',
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.refreshPath,
      pathTemplate:
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.refreshPath,
      role: 'web',
      sourceScenario: 'unauthorized',
    },
    {
      boundedResponse: true,
      caseId: 'gaming-source-status-unauthorized',
      expectedStatus: 401,
      expectedType: 'gaming-source',
      method: 'GET',
      path:
        `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.statusPathPrefix}${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionIds.unauthorized}`,
      pathTemplate:
        `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.statusPathPrefix}:unauthorized`,
      role: 'web',
      sourceScenario: 'unauthorized',
    },
    {
      boundedResponse: true,
      caseId: 'gaming-source-status-encoded-unauthorized',
      expectedStatus: 401,
      expectedType: 'gaming-source',
      method: 'GET',
      path:
        `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.statusPathPrefix}${percentEncodeEveryAsciiCharacter(NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionIds.created)}`,
      pathTemplate:
        `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.statusPathPrefix}:encoded-unauthorized`,
      role: 'web',
      sourceScenario: 'unauthorized',
    },
    {
      boundedResponse: true,
      caseId: 'gaming-source-status-noncanonical-unauthorized',
      expectedStatus: 401,
      expectedType: 'gaming-source',
      method: 'GET',
      path:
        `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.statusPathPrefix}${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionIds.created}%2Fextra`,
      pathTemplate:
        `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.statusPathPrefix}:noncanonical-unauthorized`,
      role: 'web',
      sourceScenario: 'unauthorized',
    },
    simulatedGamingSourceCase({
      body: gamingSourceIngestionBody(
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.idempotencyKeys
          .validation,
        {
          unexpected: 'x'.repeat(
            NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources
              .validationPaddingChars
          ),
        }
      ),
      caseId: 'gaming-source-ingestion-validation',
      expectedStatus: 400,
      fixture:
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtures.validation,
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath,
      sourceScenario: 'validation',
    }),
    simulatedGamingSourceCase({
      caseId: 'gaming-source-ingestion-parser-oversized',
      expectedStatus: 413,
      fixture:
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtures.validation,
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath,
      rawBody: 'x'.repeat(16_385),
      sourceScenario: 'parser-validation',
    }),
    simulatedGamingSourceCase({
      caseId: 'gaming-source-ingestion-parser-media-type',
      expectedStatus: 415,
      fixture:
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtures.validation,
      headers: { 'content-type': 'text/plain' },
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath,
      rawBody: 'sealed-preview-non-json',
      sourceScenario: 'parser-validation',
    }),
    simulatedGamingSourceCase({
      body: gamingSourceIngestionBody(
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.idempotencyKeys.unsafe
      ),
      caseId: 'gaming-source-ingestion-unsafe',
      expectedStatus: 503,
      fixture: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtures.unsafe,
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath,
      sourceScenario: 'unsafe',
    }),
    simulatedGamingSourceCase({
      body: gamingSourceIngestionBody(
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.idempotencyKeys.outage
      ),
      caseId: 'gaming-source-ingestion-outage',
      expectedStatus: 503,
      fixture: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtures.outage,
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath,
      sourceScenario: 'outage',
    }),
    simulatedGamingSourceCase({
      body: gamingSourceIngestionBody(
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.idempotencyKeys.created
      ),
      caseId: 'gaming-source-ingestion-created',
      expectedStatus: 202,
      fixture: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtures.created,
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath,
      sourceScenario: 'created',
    }),
    simulatedGamingSourceCase({
      body: gamingSourceIngestionBody(
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.idempotencyKeys.replay
      ),
      caseId: 'gaming-source-ingestion-replay',
      expectedStatus: 202,
      fixture: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtures.replay,
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath,
      sourceScenario: 'replay',
    }),
    simulatedGamingSourceCase({
      body: gamingSourceIngestionBody(
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.idempotencyKeys.conflict
      ),
      caseId: 'gaming-source-ingestion-conflict',
      expectedStatus: 409,
      fixture: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtures.conflict,
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath,
      sourceScenario: 'conflict',
    }),
    simulatedGamingSourceCase({
      body: gamingSourceRefreshBody(
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.idempotencyKeys
          .refreshValidation,
        { unexpected: true }
      ),
      caseId: 'gaming-source-refresh-validation',
      expectedStatus: 400,
      fixture:
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtures
          .refreshValidation,
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.refreshPath,
      sourceScenario: 'validation',
    }),
    simulatedGamingSourceCase({
      body: gamingSourceRefreshBody(
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.idempotencyKeys
          .refreshUnsafe
      ),
      caseId: 'gaming-source-refresh-unsafe',
      expectedStatus: 503,
      fixture:
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtures.refreshUnsafe,
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.refreshPath,
      sourceScenario: 'unsafe',
    }),
    simulatedGamingSourceCase({
      body: gamingSourceRefreshBody(
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.idempotencyKeys
          .refreshOutage
      ),
      caseId: 'gaming-source-refresh-outage',
      expectedStatus: 503,
      fixture:
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtures.refreshOutage,
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.refreshPath,
      sourceScenario: 'refresh-outage',
    }),
    simulatedGamingSourceCase({
      body: gamingSourceRefreshBody(
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.idempotencyKeys
          .refreshCreated
      ),
      caseId: 'gaming-source-refresh-created',
      expectedStatus: 202,
      fixture:
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtures.refreshCreated,
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.refreshPath,
      sourceScenario: 'refresh-created',
    }),
    simulatedGamingSourceCase({
      caseId: 'gaming-source-status-validation',
      expectedStatus: 400,
      fixture:
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtures
          .statusValidation,
      method: 'GET',
      path:
        `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.statusPathPrefix}not-a-uuid`,
      pathTemplate:
        `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.statusPathPrefix}:invalid`,
      sourceScenario: 'status-validation',
    }),
    simulatedGamingSourceCase({
      caseId: 'gaming-source-status-encoded-queued',
      expectedStatus: 200,
      fixture:
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtures.statusQueued,
      method: 'GET',
      path:
        `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.statusPathPrefix}${percentEncodeEveryAsciiCharacter(NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionIds.created)}`,
      pathTemplate:
        `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.statusPathPrefix}:encoded-queued`,
      sourceScenario: 'status-queued',
    }),
    simulatedGamingSourceCase({
      caseId: 'gaming-source-status-noncanonical-validation',
      expectedStatus: 400,
      fixture:
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtures.statusValidation,
      method: 'GET',
      path:
        `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.statusPathPrefix}${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionIds.created}%2Fextra`,
      pathTemplate:
        `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.statusPathPrefix}:noncanonical-validation`,
      sourceScenario: 'parser-validation',
    }),
    ...([
      ['queued', 'created', 'statusQueued'],
      ['running', 'running', 'statusRunning'],
      ['completed', 'completed', 'statusCompleted'],
    ].map(([status, ingestionIdName, fixtureName]) =>
      simulatedGamingSourceCase({
        caseId: `gaming-source-status-${status}`,
        expectedStatus: 200,
        fixture:
          NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtures[fixtureName],
        method: 'GET',
        path:
          `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.statusPathPrefix}${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionIds[ingestionIdName]}`,
        pathTemplate:
          `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.statusPathPrefix}:${status}`,
        sourceScenario: `status-${status}`,
      })
    )),
    simulatedGamingSourceCase({
      caseId: 'gaming-source-status-missing',
      expectedStatus: 404,
      fixture:
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtures.statusMissing,
      method: 'GET',
      path:
        `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.statusPathPrefix}${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionIds.missing}`,
      pathTemplate:
        `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.statusPathPrefix}:missing`,
      sourceScenario: 'status-missing',
    }),
    simulatedGamingSourceCase({
      caseId: 'gaming-source-status-outage',
      expectedStatus: 503,
      fixture:
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtures.statusOutage,
      method: 'GET',
      path:
        `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.statusPathPrefix}${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionIds.outage}`,
      pathTemplate:
        `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.statusPathPrefix}:outage`,
      sourceScenario: 'status-outage',
    }),
    {
      boundedResponse: true,
      caseId: 'gaming-source-options-unauthorized',
      expectedStatus: 401,
      expectedType: 'gaming-source',
      forbidCors: true,
      headers: {
        'access-control-request-method': 'POST',
        origin: 'https://example.com',
      },
      method: 'OPTIONS',
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath,
      pathTemplate:
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath,
      role: 'web',
      sourceScenario: 'unauthorized',
    },
    {
      body: { action: 'canary', payload: { scope: 'public_pipeline' } },
      caseId: 'worker-gaming-canary-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'POST',
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gaming.canaryPath,
      pathTemplate: NATIVE_PR_PREVIEW_E2E_CONTRACT.gaming.canaryPath,
      role: 'worker',
    },
    {
      body: gamingSourceIngestionBody(
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.idempotencyKeys
          .unauthorized
      ),
      caseId: 'worker-gaming-source-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'POST',
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath,
      pathTemplate:
        NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath,
      role: 'worker',
    },
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
          NATIVE_PR_PREVIEW_E2E_CONTRACT.selfHealApproval.fixtures
            .deniedOutcomes,
      },
      caseId: 'worker-self-heal-approval-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'POST',
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.selfHealApproval.path,
      pathTemplate: NATIVE_PR_PREVIEW_E2E_CONTRACT.selfHealApproval.path,
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
      body: {
        fixture:
          NATIVE_PR_PREVIEW_E2E_CONTRACT.mcpBodyCap.fixtures
            .effectiveLimits,
      },
      caseId: 'worker-mcp-body-cap-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'POST',
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.mcpBodyCap.path,
      pathTemplate: NATIVE_PR_PREVIEW_E2E_CONTRACT.mcpBodyCap.path,
      role: 'worker',
    },
    {
      body: {
        fixture:
          NATIVE_PR_PREVIEW_E2E_CONTRACT.dispatchGptIdentifier.fixtures
            .oversized,
      },
      caseId: 'worker-dispatch-gpt-identifier-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'POST',
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.dispatchGptIdentifier.path,
      pathTemplate: NATIVE_PR_PREVIEW_E2E_CONTRACT.dispatchGptIdentifier.path,
      role: 'worker',
    },
    {
      body: {
        fixture:
          NATIVE_PR_PREVIEW_E2E_CONTRACT.statusAuthBoundary.fixtures
            .authBeforeParser,
      },
      caseId: 'worker-status-auth-boundary-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'POST',
      path: NATIVE_PR_PREVIEW_E2E_CONTRACT.statusAuthBoundary.path,
      pathTemplate: NATIVE_PR_PREVIEW_E2E_CONTRACT.statusAuthBoundary.path,
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
  if (requestCase.fixtureName === 'workflowCancellationDrain') {
    const scenario = (
      name,
      trigger,
      abortStage,
      startedStages
    ) => ({
      abortObserved: true,
      abortReasonName: 'AbortError',
      abortStage,
      activeWorkAtAbortObservation: 1,
      activeWorkAtOutwardSettlement: 0,
      callbackSettledAtOutwardSettlement: true,
      drainCompletedAtOutwardSettlement: true,
      laterStageStarts: 0,
      name,
      noPostOutwardSettlementMutation: true,
      sameWorkflowDeadlineAcrossStages: true,
      sameWorkflowSignalAcrossStages: true,
      settledStages: [...startedStages],
      startedStages,
      trigger,
    });
    return {
      accepted: true,
      confirmationAttempted: false,
      databaseBoundaryReached: false,
      durablePersistenceAttempted: false,
      effectsBoundaryReached: false,
      eligibleForConfirmation: false,
      ...base,
      memoryBoundaryReached: false,
      networkBoundaryReached: false,
      providerBoundaryReached: false,
      cancellation: {
        componentExecuted: true,
        noDetachedWorkAtOutwardSettlement: true,
        scenarioCount: 4,
        scenarios: [
          scenario('timeout-dns', 'timeout', 'dns', ['dns']),
          scenario(
            'parent-abort-fetch',
            'parent-abort',
            'fetch',
            ['dns', 'fetch']
          ),
          scenario(
            'parent-abort-model',
            'parent-abort',
            'model',
            ['dns', 'fetch', 'model']
          ),
          scenario(
            'parent-abort-persistence',
            'parent-abort',
            'persistence',
            ['dns', 'fetch', 'model', 'persistence']
          ),
        ],
        syntheticSeams: ['dns', 'fetch', 'model', 'persistence'],
      },
    };
  }
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
  if (requestCase.fixtureName === 'phaseOneUniverseBinding') {
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
      phaseOne: {
        action: 'trackStoryline',
        canonicalRoute: '/gpt/backstage-booker',
        confirmationFingerprintInputUniverseBound: true,
        confirmationTokenIssued: false,
        crossUniverseLeakageObserved: false,
        queryPhaseCount: 20,
        queryUniverseRoutingVerified: true,
        universes: [
          {
            universeId: 'preview-alpha',
            retainedSequences: [1, 101],
          },
          {
            universeId: 'preview-beta',
            retainedSequences: [2, 202],
          },
        ],
      },
    };
  }
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
  if (requestCase.fixtureName === 'savedStorylineProjection') {
    return {
      accepted: true,
      databaseBoundaryReached: false,
      durablePersistenceAttempted: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: false,
      ...base,
      providerBoundaryReached: false,
      sqlProjectionExecuted: false,
      universeReadProjection: {
        componentExecuted: true,
        excerptCodePoints: 1_500,
        excerptLimitCodePoints: 1_500,
        leadingWhitespaceCodePoints: 2_500,
        leadingWhitespaceTrimmed: true,
        meaningfulInputCodePoints: 1_501,
        repositoryTransferLimitCodePoints: 1_501,
        storylineExcerpt: 'N'.repeat(1_500),
        truncated: true,
      },
    };
  }
  if (requestCase.fixtureName === 'summaryPagination') {
    return {
      accepted: true,
      authenticationBoundaryReached: false,
      canonicalRouteReached: false,
      databaseBoundaryReached: false,
      durablePersistenceAttempted: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: false,
      ...base,
      providerBoundaryReached: false,
      sqlProjectionExecuted: false,
      storylineSummaryPagination: {
        componentExecuted: true,
        emptySummaryPreserved: true,
        exactMaximumCodePoints: 10_000,
        exactReconstructionVerified: true,
        notFoundRejected: true,
        nullSummaryPreserved: true,
        outOfRangeRejected: true,
        pageCodePointLimit: 4_000,
        pages: [
          {
            endCodePointExclusive: 4_000,
            hasMore: true,
            nextOffset: 4_000,
            startCodePoint: 0,
            textCodePoints: 4_000,
            textCodeUnits: 6_000,
          },
          {
            endCodePointExclusive: 8_000,
            hasMore: true,
            nextOffset: 8_000,
            startCodePoint: 4_000,
            textCodePoints: 4_000,
            textCodeUnits: 6_000,
          },
          {
            endCodePointExclusive: 10_000,
            hasMore: false,
            nextOffset: null,
            startCodePoint: 8_000,
            textCodePoints: 2_000,
            textCodeUnits: 3_000,
          },
        ],
        scopeMismatchRejected: true,
        unicodeCodePointPagingVerified: true,
        versionFenceVerified: true,
      },
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
      queryPhaseCount: 20,
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

function expectedBackstageGenerationContractPayload(requestCase) {
  const base = {
    accepted: true,
    cacheBoundaryReached: requestCase.fixtureName === 'hrcRetryCache',
    databaseBoundaryReached: false,
    effectsBoundaryReached: false,
    externalNetworkAttempted: false,
    fixture: requestCase.fixture,
    protectedEffectsEnabled: false,
    providerBoundaryReached: false,
    schemaVersion: 1,
  };
  if (requestCase.fixtureName === 'routeBudget') {
    return {
      ...base,
      canonicalRouteRecognized: true,
      generationStageTimeoutMs: 40_000,
      genericRouteBoundaryMs: 6_000,
      routeTimeoutMs: 60_000,
      syntheticProviderCompleted: true,
      syntheticProviderDelayMs: 13_250,
      trinityRunOptions: {
        answerMode: 'direct',
        modelStageTimeoutMs: 40_000,
        strictUserVisibleOutput: true,
      },
    };
  }
  if (requestCase.fixtureName === 'hrcRetryCache') {
    return {
      ...base,
      cacheWrites: 1,
      evaluationCalls: 2,
      first: {
        cacheable: false,
        verdict: 'Synthetic HRC timeout fallback',
      },
      hrcEvaluationTimeoutMs: 10_000,
      second: {
        cacheable: true,
        verdict: 'Synthetic HRC retry succeeded',
      },
      syntheticTimeoutMs: 25,
      thirdServedFromCache: true,
    };
  }
  if (requestCase.fixtureName === 'reviewCompletion') {
    return {
      ...base,
      classification: {
        astralQuotedDirectiveParity: true,
        balancedPostQuoteRebookOrdinary: true,
        balancedQuotedDirectiveIgnored: true,
        explicitRebookDirectiveOrdinary: true,
        fullReviewBounded: true,
        mixedCreativeOrdinary: true,
        namedEventReviewsBounded: true,
        narrowAnalysisOrdinary: true,
        narrowNamedEventReviewsOrdinary: true,
        politeReviewBounded: true,
        quotedContractionsIgnored: true,
        stateFieldsIgnored: true,
        unmatchedQuoteRebookOrdinary: true,
      },
      contracts: {
        authoritativeSixBulletOverride: true,
        backstageCaveatReview: true,
        backstageCollapsedCaveatReview: true,
        backstageInitialsReview: true,
        backstageMarkdownReview: true,
        backstageSingleInitialReview: true,
        quotedContractionWorkBound: true,
        reviewStyleInstruction: true,
        reviewTokenLimit: true,
        trinityCollapsedDirectAnswer: true,
        trinityDirectAnswer: true,
      },
      normalization: {
        authoritativeReviewBulletCount: 6,
        caveatReview: [
          "1. I can't verify current external state here without live access. Overall verdict: the card delivered a disciplined escalation.",
          '2. Match results: Alpha winner preserved the planned hierarchy.',
          '3. Promos and segments: Bravo segment sharpened the central conflict.',
          '4. Rivalry continuity: Charlie thread honored the established canon.',
          '5. Pacing and structure: Delta transition kept the second hour moving.',
          '6. Remaining matches: Echo finish should determine the next branch.',
        ].join('\n'),
        collapsedCaveatReview: [
          "1. I can't verify current external state here without live access.",
          '2. Match results: Alpha winner preserved the planned hierarchy.',
          '3. Promos and segments: Bravo segment sharpened the central conflict.',
          '4. Rivalry continuity: Charlie thread honored the established canon.',
          '5. Pacing and structure: Delta transition kept the second hour moving.',
          '6. Remaining matches: Echo finish should determine the next branch.',
        ].join('\n'),
        initialsReview:
          '1. J. J. Dillon backed A.J. Styles after the U.S. title match. His decision clarified the feud.',
        markdownReview: [
          '1. The card has a coherent through-line.',
          '2. The results preserve the planned hierarchy.',
          '3. The promos sharpen the central conflict.',
          '4. The rivalries honor established continuity.',
          '5. The pacing builds toward the closing stretch.',
          '6. The unfinished matches should determine the next branch.',
        ].join('\n'),
        numberedBulletCount: 6,
        quoteLookaheadScans: 4,
        quotedContractionCount: 256,
        singleInitialReview:
          '1. Bret J. Hart won cleanly. His follow-up promo advanced the feud.',
      },
      policy: {
        authoritativeBulletCount: 6,
        namedEventTokenLimit: 1_600,
        responseStyleInstruction: [
          'Return exactly 6 top-level numbered bullets:',
          '1. Overall verdict and the show\'s strongest through-line.',
          '2. Match results and ratings that most affected the show.',
          '3. Promos, headcanon, and non-match segments that mattered most.',
          '4. Rivalry development and continuity strengths or problems.',
          '5. Pacing, booking logic, and the highest-value correction.',
          '6. The remaining matches and the best next step.',
          'Use no more than two concise sentences per bullet.',
          'No preamble, headings, sub-bullets, alternative full card, conclusion, or production-notes appendix.',
          'Synthesize instead of recapping: do not re-list the supplied show state, results, ratings, or segments.',
          'Treat matches identified as still to come as unresolved; never invent their results.',
        ].join('\n'),
        tokenLimit: 1_600,
      },
    };
  }
  if (requestCase.fixtureName === 'compactRetry') {
    return {
      ...base,
      compactRetry: {
        contracts: {
          atMostOverflowRejected: true,
          atMostWithinBoundAccepted: true,
          exactRetryAccepted: true,
          firstPartialDiscarded: true,
          malformedShapeRejected: true,
          noThirdAttempt: true,
          nonLengthFailureNotRetried: true,
          overCountRejected: true,
          retryMarkerOnlyOnSecondCall: true,
          sameRequestStateReused: true,
          secondLengthCollapsed: true,
          underCountRejected: true,
          validNumberedParagraphCount: true,
          wordOverflowRejected: true,
        },
        productionSharedCoordinator: true,
        productionSharedValidator: true,
        syntheticAttemptCount: 2,
        validOutput: [
          '1. Cody challenges Gunther after a tense opening confrontation.',
          '2. Gunther accepts, then closes the segment with a decisive warning.',
        ].join('\n'),
      },
    };
  }
  if (requestCase.fixtureName === 'productionOutputContracts') {
    const scenario = (overrides) => ({
      budgetClass: 'queued_extended',
      budgetReason: 'queued_structured_generation',
      capacityFormat: 'structured_booking',
      directAnswerMode: true,
      recoveryInstructionVerified: true,
      tokenCap: 6_000,
      tokenLimit: 6_000,
      ...overrides,
    });
    return {
      ...base,
      outputContracts: {
        contracts: {
          atMostPresentationPreserved: true,
          completeCardHierarchyPreserved: true,
          exactPresentationPreserved: true,
          productionCapacitySelected: true,
        },
        productionSharedBudgetCore: true,
        productionSharedCompactContractCore: true,
        productionSharedPresentationCore: true,
        productionSharedRecoveryCore: true,
        scenarios: {
          atMostCompact: scenario({
            completeBookingContainerComponentCount: false,
            enforceParsedItemContract: true,
            explicitCompactOutputRequest: false,
            itemCount: 3,
            itemPolicyMode: 'atMost',
            recoveryMode: 'compact',
            requestedOutputShapeInstructionBound: true,
            responseFormat: 'compact_direct',
          }),
          completeCard: scenario({
            completeBookingContainerComponentCount: true,
            enforceParsedItemContract: false,
            explicitCompactOutputRequest: false,
            itemCount: null,
            itemPolicyMode: 'preserve',
            recoveryMode: 'structured',
            requestedOutputShapeInstructionBound: false,
            responseFormat: 'structured_booking',
          }),
          exactCompact: scenario({
            completeBookingContainerComponentCount: false,
            enforceParsedItemContract: true,
            explicitCompactOutputRequest: false,
            itemCount: 2,
            itemPolicyMode: 'exact',
            recoveryMode: 'compact',
            requestedOutputShapeInstructionBound: true,
            responseFormat: 'compact_direct',
          }),
        },
      },
      workerBoundaryReached: false,
    };
  }
  if (requestCase.fixtureName === 'outputAdmission') {
    const alternativeCase = (
      id,
      alternativeCardContainerRequest,
      budgetItemCount,
      itemPolicyMode,
      itemCount,
      compactOutputMode,
      enforceParsedItemContract,
      responseFormat,
      recoveryMode
    ) => ({
      alternativeCardContainerRequest,
      budgetItemCount,
      compactOutputMode,
      enforceParsedItemContract,
      id,
      itemCount,
      itemPolicyMode,
      recoveryMode,
      responseFormat,
    });
    const rejectedFirstSuccess = id => ({
      accepted: false,
      causeFreeIncomplete: true,
      errorCode: 'BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE',
      id,
      outputEscaped: false,
      outputReturnedByteForByte: false,
      retryable: false,
      syntheticAttemptCount: 1,
      syntheticRetryCalls: 0,
    });
    const validExact = {
      accepted: true,
      causeFreeIncomplete: false,
      errorCode: null,
      id: 'valid-exact',
      outputEscaped: false,
      outputReturnedByteForByte: true,
      retryable: null,
      syntheticAttemptCount: 1,
      syntheticRetryCalls: 0,
    };
    return {
      ...base,
      outputAdmission: {
        alternativeCases: [
          alternativeCase(
            'detailed-alternatives', true, 3, 'preserve', null,
            false, false, 'structured_booking', 'structured'
          ),
          alternativeCase(
            'nested-short-alternatives', true, 3, 'preserve', null,
            false, false, 'structured_booking', 'structured'
          ),
          alternativeCase(
            'slash-delimited-alternatives', true, 3, 'preserve', null,
            false, false, 'structured_booking', 'structured'
          ),
          alternativeCase(
            'two-dozen-alternatives', true, 24, 'preserve', null,
            false, false, 'structured_booking', 'structured'
          ),
          alternativeCase(
            'explicit-short-alternatives', false, 3, 'exact', 3,
            true, true, 'compact_direct', 'compact'
          ),
          alternativeCase(
            'ignore-supersession', false, 3, 'exact', 3,
            true, true, 'compact_direct', 'compact'
          ),
          alternativeCase(
            'attribution-supersession', false, 3, 'exact', 3,
            true, true, 'compact_direct', 'compact'
          ),
          alternativeCase(
            'considered-supersession', false, 3, 'exact', 3,
            true, true, 'compact_direct', 'compact'
          ),
        ],
        contracts: {
          alternativeClassificationVerified: true,
          malformedFirstSuccessRejected: true,
          noFirstSuccessRetry: true,
          validFirstSuccessAccepted: true,
        },
        firstSuccess: {
          malformedAtMost: rejectedFirstSuccess('malformed-at-most'),
          overlongAtMost: rejectedFirstSuccess('overlong-at-most'),
          supersession: {
            allCauseFreeIncomplete: true,
            allOutputContained: true,
            allRejected: true,
            caseCount: 3,
            syntheticAttemptCounts: [1, 1, 1],
            syntheticRetryCalls: [0, 0, 0],
          },
          validExact,
        },
        productionSharedFinalGate: true,
        productionSharedModeCore: true,
        productionSharedOutputContractCore: true,
      },
      workerBoundaryReached: false,
    };
  }
  if (requestCase.fixtureName === 'notionSyncPhaseA') {
    return {
      ...base,
      embeddingBoundaryReached: false,
      notionApiBoundaryReached: false,
      notionSyncPhaseA: {
        capacity: {
          cases: [
            { chunkCount: 2_048, readable: true, writable: true },
            { chunkCount: 2_117, readable: true, writable: false },
            { chunkCount: 4_096, readable: true, writable: false },
            { chunkCount: 4_097, readable: false, writable: false },
          ],
          readerCeiling: 4_096,
          writerCeiling: 2_048,
          writerRejectionMessage: 'chunks must contain 1-2048 records.',
        },
        contracts: {
          capacitySplitVerified: true,
          lateLeaseReleasedExactlyOnce: true,
          lateNullNotReleased: true,
          preAbortedAcquisitionSkipped: true,
          readableUnchangedSnapshotVerified: true,
          writerFenceRejectedBeforeEffects: true,
        },
        leaseFence: {
          acquireCalls: 1,
          alreadyAbortedAcquireCalls: 0,
          nullReleaseCalls: 0,
          outwardAbortName: 'AbortError',
          releaseCalls: 1,
          releaseCallsBeforeLateSettlement: 0,
          released: [
            {
              universeId: 'native-preview-notion-phase-a',
              holderId: 'native-preview-holder',
              leaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad',
            },
          ],
        },
        productionSharedCapacityCore: true,
        productionSharedLateAcquisitionFence: true,
        productionSharedUnchangedDecision: true,
        unchangedDecision: {
          chunkCount: 2_117,
          disposition: 'verify_unchanged',
        },
      },
      workerBoundaryReached: false,
    };
  }
  if (requestCase.fixtureName === 'notionAuthorityRag') {
    return {
      ...base,
      externalNetworkAttempted: true,
      notionAuthority: {
        citationProvenanceVerified: true,
        deterministicContentFixture: true,
        instructionBoundaryPreserved: true,
        liveCredentialUsed: false,
        liveNotionApiReached: true,
        liveNotionAuthenticationRejected: true,
        markdownRequests: 1,
        metadataRequests: 1,
        mutationActionsRecognized: 6,
        productionSharedPageCore: true,
        productionSharedPromptCore: true,
        sanitizationApplied: true,
      },
      rag: {
        category: 'kayfabe',
        chunkCount: 1,
        citationCount: 1,
        promptTruncated: false,
      },
    };
  }
  if (requestCase.fixtureName === 'partitionFailureTelemetry') {
    return {
      ...base,
      failureTelemetry: {
        componentExecuted: true,
        deterministicOrderingVerified: true,
        duplicateShardKeyDistinct: true,
        fallbackReasonCodeVerified: true,
        identityFormat:
          'backstage-notion-partition-shard-telemetry-v1',
        maximum: {
          boundedBelowBytes: 65_536,
          failedShardProjectionBytes: 55_314,
          failedShardCount: 512,
          firstShardIdentity:
            'opaque-ISvHkzlJWy0soyLp5CWbKsaJ1QURpKE7gItiNz8POMo',
          lastShardIdentity:
            'opaque-SXtGgR72kUvUwjonh2eKOP24P_CII2IS3pn0aeCaims',
          projectionSha256:
            '967a181c24119cfea50de0371f0a2dd4aa8df28759ea1878546dfbdbf49ce509',
          uniqueIdentityCount: 512,
        },
        loggerSinkExecuted: false,
        productionSharedProjection: true,
        rawIdentifiersAbsent: true,
        rootPageIdAliasProtected: true,
        sampleFailedShards: [
          {
            shardIdentity:
              'opaque-70vMMJ4Z_2lvnrnjSsWlsnORGAg8hXBlhWt8xhTuX68',
            safeReasonCode: 'SHARD_SOURCE_DRIFT',
          },
          {
            shardIdentity:
              'opaque-eVPQRBtG90baOJNEneYPq2OFyWVTFq5HYiTVW5P1NzA',
            safeReasonCode: 'SHARD_SYNC_FAILED',
          },
          {
            shardIdentity:
              'opaque-n07d5-jiZBvYTRnB0U7j1T_7FkWsdYa6sowmW2zV-hM',
            safeReasonCode: 'SHARD_CAPTURE_INCOMPLETE',
          },
        ],
        validAliasConfigurationParsed: true,
      },
    };
  }
  if (requestCase.fixtureName === 'continuityQuery') {
    return {
      ...base,
      actionPolicy: {
        canonicalRouteRecognized: true,
        publicReadOnlyAction: true,
        queryContinuityRecognized: true,
        tokenLimit: 900,
        trinityRunOptionsBound: true,
      },
      continuity: {
        compactRetryBound: true,
        cursorPreflight: {
          completeScopeAccepted: true,
          malformedRejected: true,
          wrongModeRejected: true,
        },
        exhaustiveCoverageInstruction: true,
        instructionBoundaryPreserved: true,
        publicResponse: {
          answer: "1. Rhea Ripley holds the Women's World Championship on Raw.",
          authority: 'notion',
          coverage: {
            exhaustive: false,
            hasMore: false,
            omittedChunks: 0,
            promptTruncated: false,
            scopeChunks: 1,
            selectedChunks: 1,
            status: 'sampled',
          },
          resolvedScope: {
            pagePath: ['WWE Universe Mode', 'Monday Night Raw'],
            pageTitle: 'Monday Night Raw',
            sectionPath: ['Championships', "Women's World Championship"],
          },
          sources: [
            {
              category: 'kayfabe',
              contentHash:
                '9ac466a759d89a5d1db68cb463399d363a17195ab54efe7e04b14aed39df1b91',
              headingPath: ['Championships', "Women's World Championship"],
              pagePath: ['WWE Universe Mode', 'Monday Night Raw'],
              pageTitle: 'Monday Night Raw',
              sourceId:
                '0907207c11757e22e61b23a2d600ecb5813564e6de792700c8629f0cf51a9456',
            },
          ],
          universeId: 'native-preview-continuity-query',
        },
        sampledCoverageInstruction: true,
        sourceProjectionVerified: true,
        syntheticAnswerNormalized: true,
      },
      rag: {
        category: 'kayfabe',
        chunkCount: 1,
        citationCount: 1,
        promptTruncated: false,
        sanitizationApplied: true,
        sourcePageChunkCount: 2,
      },
    };
  }
  if (requestCase.fixtureName === 'continuitySubtree') {
    const pagePath = ['WWE Universe Mode', 'Brands', 'Monday Night Raw'];
    const answer =
      '1. The Raw subtree contains root and descendant continuity.';
    const resolvedScope = {
      pageTitle: 'Monday Night Raw',
      pagePath,
      scopeKind: 'subtree',
    };
    const rootSource = {
      sourceId:
        '1111111111111111111111111111111111111111111111111111111111111111',
      pageTitle: 'Monday Night Raw',
      pagePath,
      headingPath: ['Overview'],
      category: 'kayfabe',
      contentHash:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    const rosterSource = {
      sourceId:
        '2222222222222222222222222222222222222222222222222222222222222222',
      pageTitle: 'Raw Roster',
      pagePath: [...pagePath, 'Raw Roster'],
      headingPath: ['Champions'],
      category: 'kayfabe',
      contentHash:
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };
    const response = (coverage, sources) => ({
      universeId: 'native-preview-continuity-subtree',
      authority: 'notion',
      answer,
      resolvedScope,
      coverage,
      sources,
    });
    return {
      ...base,
      continuity: {
        contracts: {
          completeScopeAllFixtureSourcesObserved: true,
          incompleteSubtreeCoverageRejected: true,
          pageCoverageTotalsTruthful: true,
          scopeSourcePathsBound: true,
          subtreeFieldsCoupled: true,
          subtreePageCoveragePromptBound: true,
        },
        cursorCodecBoundaryReached: false,
        cursorPreflight: {
          completeScopeShapeAccepted: true,
          malformedRejected: true,
          wrongModeRejected: true,
        },
        completeScopeProjections: {
          first: {
            coverage: {
              status: 'sampled',
              scopeChunks: 3,
              selectedChunks: 2,
              omittedChunks: 1,
              promptTruncated: false,
              exhaustive: false,
              hasMore: true,
              nextCursor:
                'eyJ2IjozLCJmaXh0dXJlIjoic2VhbGVkLXN1YnRyZWUtcHJldmlldyJ9',
              scopePages: 3,
              selectedPages: 2,
              omittedPages: 1,
            },
            sourceIds: [
              '1111111111111111111111111111111111111111111111111111111111111111',
              '2222222222222222222222222222222222222222222222222222222222222222',
            ],
          },
          final: {
            coverage: {
              status: 'sampled',
              scopeChunks: 3,
              selectedChunks: 1,
              omittedChunks: 2,
              promptTruncated: false,
              exhaustive: false,
              hasMore: false,
              scopePages: 3,
              selectedPages: 1,
              omittedPages: 2,
            },
            sourceIds: [
              '3333333333333333333333333333333333333333333333333333333333333333',
            ],
          },
        },
        productionSharedPolicyCore: true,
        productionSharedResponseCore: true,
        publicResponse: response(
          {
            status: 'sampled',
            scopeChunks: 3,
            selectedChunks: 2,
            omittedChunks: 1,
            promptTruncated: false,
            exhaustive: false,
            hasMore: false,
            scopePages: 3,
            selectedPages: 2,
            omittedPages: 1,
          },
          [rootSource, rosterSource]
        ),
      },
    };
  }
  if (requestCase.fixtureName === 'managedAsyncContinuation') {
    return {
      accepted: true,
      authentication: {
        currentAccepted: true,
        rotatedAccepted: true,
        missingRejected: true,
        malformedRejected: true,
        wrongRejected: true,
        duplicateRejected: true,
        emptyRejected: true,
        unavailableRejected: true,
        collisionRejected: true,
        stablePrincipalAcrossRotation: true,
        legacyIdentityChangesAcrossRotation: true,
      },
      cacheBoundaryReached: false,
      continuation: {
        allManagedPolls: true,
        managedCreationCapabilitiesRemoved: true,
        managedPoll:
          '/gpt-access/capabilities/v1/backstage-booker/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac/result',
        repositoryReads: 2,
        stateProjectionVerified: true,
        terminalMaterializationVerified: true,
        waiterCalls: 1,
      },
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: false,
      fixture: requestCase.fixture,
      ownership: {
        stableJobReadableAfterRotation: true,
        legacyJobReadableDuringCutover: true,
        rotatedLegacyJobHidden: true,
        wrongScopeHidden: true,
        nonPublicJobHidden: true,
        nonGptJobHidden: true,
        malformedJobHidden: true,
      },
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      schemaVersion: 1,
      sensitiveValuesAbsent: true,
      workerBoundaryReached: false,
    };
  }
  if (requestCase.fixtureName === 'protectedFailureNoFallback') {
    const publicFailure = ({ action, errorCode }) => ({
      action,
      authority: 'none',
      continuityVerified: false,
      errorCode,
      errorMessage: 'Protected Backstage generation did not complete.',
      fallbackPermitted: false,
      fallbackUsed: false,
      noDraftMaterial: true,
      official: false,
      protected: true,
      protectedGenerationCompleted: false,
      resultIsNull: true,
      snapshotStatus: 'not_applicable',
      status: 'failed',
    });
    return {
      accepted: true,
      continuityPolicy: {
        protectedGeneration: {
          processFallbackReads: 0,
          reason: 'protected_generation',
          state: 'unavailable',
        },
        quarantinedLegacy: {
          processFallbackReads: 0,
          reason: 'legacy_read_quarantined',
          state: 'unavailable',
        },
        protectedAndQuarantined: {
          processFallbackReads: 0,
          reason: 'legacy_read_quarantined',
          state: 'unavailable',
        },
        unprotectedControl: {
          processFallbackReads: 1,
          source: 'process-fallback-control',
          state: 'process_fallback',
        },
      },
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: false,
      failureProjection: {
        bothProtectedActionsVerified: true,
        failureOnly: true,
        projections: [
          publicFailure({
            action: 'generateBooking',
            errorCode: 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE',
          }),
          publicFailure({
            action: 'generateBookingWithHRC',
            errorCode: 'BACKSTAGE_ASYNC_EXECUTION_FAILED',
          }),
        ],
      },
      fixture: requestCase.fixture,
      hrcBoundaryReached: false,
      inMemoryJobReads: 2,
      processFallbackReads: 1,
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      queueBoundaryReached: false,
      repositoryBoundaryReached: false,
      schemaVersion: 1,
      workerBoundaryReached: false,
    };
  }
  if (requestCase.fixtureName === 'gptClientIdentity') {
    return {
      ...base,
      authentication: {
        currentAccepted: true,
        missingRejected: true,
        registryResolutionCount: 2,
        rotatedAccepted: true,
        unauthenticatedResolutionSkipped: true,
        wrongRejected: true,
      },
      canonicalRouteReached: false,
      identity: {
        authenticationType: 'managed-api-key',
        clientId: 'backstage-booker',
        frozen: true,
        gptId: 'backstage-booker',
        modelIdentityAssurance: 'unknown',
        registeredModelProfile: null,
        runtimeModel: null,
        stableAcrossRotation: true,
        telemetry: {
          clientId: 'backstage-booker',
          gptId: 'backstage-booker',
          authenticationType: 'managed-api-key',
          registeredModelProfile: null,
          modelIdentityAssurance: 'unknown',
        },
        telemetryAllowlisted: true,
        typeConfusionRejected: true,
        unknownClientRejected: true,
      },
      provenance: {
        emptyFallbackValid: true,
        legacyAbsencePreserved: true,
        plannerStatePreserved: true,
        rotationStable: true,
        serializationRoundTripValid: true,
        spoofedSnapshotOverwritten: true,
        tamperedSnapshotRejected: true,
      },
      queueBoundaryReached: false,
      repositoryBoundaryReached: false,
      sensitiveValuesAbsent: true,
      workerBoundaryReached: false,
    };
  }
  fail('NATIVE_PR_PREVIEW_CASE_CONTRACT_INVALID', requestCase.caseId);
}

function expectedMcpBodyCapContractPayload(requestCase) {
  if (requestCase.fixtureName !== 'effectiveLimits') {
    fail('NATIVE_PR_PREVIEW_CASE_CONTRACT_INVALID', requestCase.caseId);
  }
  const profiles = [
    {
      configuredMcpLimit: '8mb',
      effectiveLimitBytes: 1024 * 1024,
      globalJsonLimit: '10mb',
      name: 'hard-maximum',
    },
    {
      configuredMcpLimit: '512kb',
      effectiveLimitBytes: 512 * 1024,
      globalJsonLimit: '10mb',
      name: 'mcp-configured',
    },
    {
      configuredMcpLimit: '1mb',
      effectiveLimitBytes: 256 * 1024,
      globalJsonLimit: '256kb',
      name: 'global-json',
    },
  ];
  const cases = profiles.flatMap(profile => [0, 1].map(delta => {
    const accepted = delta === 0;
    const bodyBytes = profile.effectiveLimitBytes + delta;
    return {
      accepted,
      bodyBytes,
      cacheControl: 'no-store',
      configuredMcpLimit: profile.configuredMcpLimit,
      effectiveLimitBytes: profile.effectiveLimitBytes,
      globalJsonLimit: profile.globalJsonLimit,
      name: `${profile.name}-${accepted ? 'exact' : 'over'}`,
      nextCalls: accepted ? 1 : 0,
      parsedPaddingLength: accepted ? bodyBytes - 14 : null,
      pragma: 'no-cache',
      rejection: accepted
        ? null
        : {
            error: 'MCP_REQUEST_TOO_LARGE',
            message: 'MCP request body is too large.',
          },
      statusCode: accepted ? 200 : 413,
      streamedWithoutContentLength: true,
    };
  }));
  return {
    accepted: true,
    confirmationAttempted: false,
    databaseBoundaryReached: false,
    durablePersistenceAttempted: false,
    effectsBoundaryReached: false,
    eligibleForConfirmation: false,
    fixture: requestCase.fixture,
    memoryBoundaryReached: false,
    networkBoundaryReached: false,
    protectedEffectsEnabled: false,
    providerBoundaryReached: false,
    schemaVersion: 1,
    bodyCap: {
      callerBodyControlsProbe: false,
      caseCount: 6,
      cases,
      componentExecuted: true,
      hardMaximumBytes: 1024 * 1024,
      profileCount: 3,
      serverOwnedBodies: true,
    },
  };
}

function expectedSelfHealApprovalOutcome(
  name,
  approvalSource,
  allowLegacyReactiveEffects = false
) {
  return {
    name,
    approvalSource,
    allowLegacyReactiveEffects,
    allowReactiveAction: allowLegacyReactiveEffects,
    allowAutomaticController: allowLegacyReactiveEffects,
  };
}

function expectedSelfHealApprovalContractPayload(requestCase) {
  const envelope = policy => ({
    componentExecuted: true,
    databaseBoundaryReached: false,
    effectsBoundaryReached: false,
    fixture: requestCase.fixture,
    kind: 'predictive_reactive_self_heal_approval_contract',
    memoryBoundaryReached: false,
    outboundNetworkBoundaryReached: false,
    policy,
    protectedEffectsEnabled: false,
    providerBoundaryReached: false,
    schemaVersion: 1,
    workerBoundaryReached: false,
  });
  switch (requestCase.fixtureName) {
    case 'deniedOutcomes': {
      const outcomes = [
        expectedSelfHealApprovalOutcome(
          'authoritative-refusal',
          'authoritative_predictive_result'
        ),
        expectedSelfHealApprovalOutcome(
          'authoritative-recommendation',
          'authoritative_predictive_result'
        ),
        expectedSelfHealApprovalOutcome(
          'authoritative-dry-run',
          'authoritative_predictive_result'
        ),
        expectedSelfHealApprovalOutcome(
          'deterministic-fallback',
          'deterministic_fallback'
        ),
        expectedSelfHealApprovalOutcome(
          'attempted-failure',
          'predictive_execution_uncertain'
        ),
        expectedSelfHealApprovalOutcome(
          'declined-automatic-actuator',
          'predictive_execution_uncertain'
        ),
      ];
      return envelope({
        allReactiveEffectsDenied: true,
        caseCount: outcomes.length,
        outcomes,
      });
    }
    case 'validCompleted': {
      const outcome = expectedSelfHealApprovalOutcome(
        'valid-completed',
        'predictive_already_executed'
      );
      return envelope({
        confirmedPredictiveExecution: true,
        outcome,
      });
    }
    case 'incoherentCompleted': {
      const outcomes = [
        'attempt-missing',
        'mode-mismatch',
        'action-mismatch',
        'target-mismatch',
        'safety-mismatch',
        'decision-action-none',
        'disabled-completed',
      ].map(name => expectedSelfHealApprovalOutcome(
        name,
        'predictive_state_invalid'
      ));
      return envelope({
        allCompletedStatesRejected: true,
        caseCount: outcomes.length,
        outcomes,
      });
    }
    case 'disabledLegacy':
      return envelope({
        legacyReactivePolicyPreserved: true,
        outcome: expectedSelfHealApprovalOutcome(
          'disabled-legacy',
          'predictive_disabled',
          true
        ),
      });
    case 'manualIndependence':
      return envelope({
        automaticControllerRunAllowed: false,
        manualAuthorityIndependent: true,
        manualControllerRunAllowed: true,
      });
    case 'productionDebugDenial':
      return envelope({
        developmentDebugOverrideEligible: true,
        productionDebugDenied: true,
        productionDebugOverrideEligible: false,
      });
    default:
      fail('NATIVE_PR_PREVIEW_CASE_CONTRACT_INVALID', requestCase.caseId);
  }
}

function expectedGamingCanaryPayload(requestCase) {
  const valid = requestCase.expectedType === 'gaming-canary';
  const correlation = nativePrPreviewCaseCorrelation(requestCase);
  const common = {
    action: 'canary',
    scope: 'public_pipeline',
    schemaVersion: '1.5.0',
    intent: 'public_canary',
    route: 'public_canary',
    requestId: correlation.requestId,
    traceId: correlation.traceId,
    checks: valid
      ? {
          requestValidation: 'passed',
          dispatcher: 'passed',
          publicRoute: 'passed',
          fixtureValidation: 'passed',
          grounding: 'passed',
          networkRetrieval: 'skipped',
          providerExecution: 'skipped',
          responseConstruction: 'passed',
          responseGuard: 'passed',
        }
      : {
          requestValidation: 'failed',
          dispatcher: 'skipped',
          publicRoute: 'passed',
          fixtureValidation: 'skipped',
          grounding: 'skipped',
          networkRetrieval: 'skipped',
          providerExecution: 'skipped',
          responseConstruction: 'passed',
          responseGuard: 'passed',
        },
    usedFallback: false,
    acceptedSources: valid ? 1 : 0,
    durationMs: 0,
  };
  return valid
    ? {
        ok: true,
        ...common,
        message: 'Public ARCANOS Gaming Action pipeline canary passed.',
        fixture: {
          source: 'bundled',
          marker: 'ARCANOS_PUBLIC_CANARY_7F31',
          markerVerified: true,
        },
      }
    : {
        ok: false,
        ...common,
        message:
          "Public canary requests require action 'canary' and scope 'public_pipeline'.",
        code: 'BAD_REQUEST',
      };
}

function expectedGamingQueryPayload(requestCase) {
  const correlation = nativePrPreviewCaseCorrelation(requestCase);
  if (requestCase.expectedType === 'gaming-query') {
    return {
      ok: true,
      requestId: correlation.requestId,
      traceId: correlation.traceId,
      result: {
        ok: true,
        route: 'gaming',
        mode: requestCase.gamingMode,
        data: {
          response: `Sealed preview ${requestCase.gamingMode} response.`,
          sources: [],
        },
      },
      _route: {
        requestId: correlation.requestId,
        traceId: correlation.traceId,
        gptId: 'arcanos-gaming',
        module: 'ARCANOS:GAMING',
        action: 'query',
        route: 'gaming',
        timestamp: FIXTURE_CREATED_AT,
      },
    };
  }
  const operational = requestCase.expectedType === 'gaming-query-operational';
  const validation = operational
    ? {
        code: 'OPERATIONAL_REQUEST_NOT_GAMEPLAY',
        message:
          'This request asks about the public integration rather than gameplay. Use the public canary operation.',
      }
    : requestCase.validation;
  return {
    ok: false,
    requestId: correlation.requestId,
    traceId: correlation.traceId,
    gptId: 'arcanos-gaming',
    action: 'query',
    route: '/gpt/:gptId',
    error: validation,
    _route: {
      requestId: correlation.requestId,
      traceId: correlation.traceId,
      gptId: 'arcanos-gaming',
      action: 'query',
      route: operational
        ? 'gaming_operational_guard'
        : 'gaming_validation',
      timestamp: FIXTURE_CREATED_AT,
    },
  };
}

function expectedGamingSourceQueued(
  requestCase,
  action,
  ingestionId,
  deduplicated
) {
  const correlation = nativePrPreviewCaseCorrelation(requestCase);
  return {
    ok: true,
    action,
    ingestionId,
    status: 'queued',
    deduplicated,
    statusUrl:
      `${NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath}/${ingestionId}`,
    sources: [
      {
        submittedIndex: 0,
        status: 'queued',
        canonicalUrl: 'https://example.invalid/palworld/guide',
        ...(action === 'refresh'
          ? { sourceId: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.sourceId }
          : {}),
        recordsCreated: 0,
        recordsUpdated: 0,
      },
    ],
    createdAt: FIXTURE_CREATED_AT,
    requestId: correlation.requestId,
    traceId: correlation.traceId,
  };
}

function expectedGamingSourceStatus(requestCase, status) {
  const correlation = nativePrPreviewCaseCorrelation(requestCase);
  const ingestionId = NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources
    .ingestionIds[status === 'queued' ? 'created' : status];
  const completed = status === 'completed';
  const running = status === 'running';
  return {
    ok: true,
    action: 'status',
    ingestionId,
    status,
    counts: {
      total: 1,
      queued: status === 'queued' ? 1 : 0,
      succeeded: completed ? 1 : 0,
      rejected: 0,
      failed: 0,
      recordsCreated: completed ? 1 : 0,
      recordsUpdated: 0,
    },
    sources: [
      completed
        ? {
            submittedIndex: 0,
            status: 'stored',
            canonicalUrl: 'https://example.invalid/palworld/guide',
            sourceId: NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.sourceId,
            sourceType: 'wiki',
            recordsCreated: 1,
            recordsUpdated: 0,
            fetchedAt: FIXTURE_COMPLETED_AT,
            completedAt: FIXTURE_COMPLETED_AT,
            warnings: [],
          }
        : {
            submittedIndex: 0,
            status: running ? 'running' : 'queued',
            canonicalUrl: 'https://example.invalid/palworld/guide',
            recordsCreated: 0,
            recordsUpdated: 0,
          },
    ],
    createdAt: FIXTURE_CREATED_AT,
    updatedAt: completed
      ? FIXTURE_COMPLETED_AT
      : running
        ? '2026-07-30T00:00:00.500Z'
        : FIXTURE_CREATED_AT,
    ...(completed ? { completedAt: FIXTURE_COMPLETED_AT } : {}),
    requestId: correlation.requestId,
    traceId: correlation.traceId,
  };
}

function expectedGamingSourcePayload(requestCase) {
  const correlation = nativePrPreviewCaseCorrelation(requestCase);
  const ids = NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionIds;
  switch (requestCase.sourceScenario) {
    case 'unauthorized':
      return {
        ok: false,
        error: {
          code: 'UNAUTHORIZED_GPT_ACCESS',
          message: 'Missing GPT access bearer token.',
        },
      };
    case 'validation':
      return {
        ok: false,
        error: {
          code: 'GAMING_SOURCE_VALIDATION_ERROR',
          message: 'Invalid gaming-source request.',
        },
      };
    case 'parser-validation':
      return {
        ok: false,
        error: {
          code: 'GAMING_SOURCE_VALIDATION_ERROR',
          message: 'The Gaming source request is invalid.',
        },
        requestId: correlation.requestId,
        traceId: correlation.traceId,
      };
    case 'unsafe':
      return {
        ok: false,
        error: {
          code: 'UNSAFE_EXECUTION_DISABLED',
          message:
            'Gaming-source mutations are temporarily unavailable because runtime integrity checks did not pass.',
        },
        requestId: correlation.requestId,
        traceId: correlation.traceId,
      };
    case 'outage':
      return {
        ok: false,
        error: {
          code: 'GAMING_SOURCE_JOBS_UNAVAILABLE',
          message: 'Durable gaming-source ingestion is unavailable.',
        },
      };
    case 'created':
      return expectedGamingSourceQueued(
        requestCase,
        'ingest',
        ids.created,
        false
      );
    case 'replay':
      return expectedGamingSourceQueued(
        requestCase,
        'ingest',
        ids.created,
        true
      );
    case 'conflict':
      return {
        ok: false,
        error: {
          code: 'GAMING_SOURCE_IDEMPOTENCY_CONFLICT',
          message:
            'The idempotency key is already bound to a different ingestion request.',
        },
      };
    case 'refresh-outage':
      return {
        ok: false,
        error: {
          code: 'GAMING_SOURCE_STORAGE_UNAVAILABLE',
          message: 'Gaming-source refresh storage is unavailable.',
        },
      };
    case 'refresh-created':
      return expectedGamingSourceQueued(
        requestCase,
        'refresh',
        ids.refresh,
        false
      );
    case 'status-validation':
      return {
        ok: false,
        error: {
          code: 'GAMING_SOURCE_VALIDATION_ERROR',
          message: 'ingestionId must be a UUID.',
        },
      };
    case 'status-queued':
      return expectedGamingSourceStatus(requestCase, 'queued');
    case 'status-running':
      return expectedGamingSourceStatus(requestCase, 'running');
    case 'status-completed':
      return expectedGamingSourceStatus(requestCase, 'completed');
    case 'status-missing':
      return {
        ok: false,
        error: {
          code: 'GAMING_SOURCE_INGESTION_NOT_FOUND',
          message: 'The gaming-source ingestion was not found.',
        },
      };
    case 'status-outage':
      return {
        ok: false,
        error: {
          code: 'GAMING_SOURCE_JOBS_UNAVAILABLE',
          message: 'Gaming-source ingestion status is unavailable.',
        },
      };
    default:
      fail('NATIVE_PR_PREVIEW_CASE_CONTRACT_INVALID', requestCase.caseId);
  }
}

const DISPATCH_GPT_IDENTIFIER_TIMESTAMP_SENTINEL =
  '<validated-iso-8601-timestamp>';

function expectedStatusAuthBoundaryContractPayload(requestCase, options) {
  const contract = NATIVE_PR_PREVIEW_E2E_CONTRACT.statusAuthBoundary;
  if (requestCase.fixtureName !== 'authBeforeParser') {
    fail('NATIVE_PR_PREVIEW_CASE_CONTRACT_INVALID', requestCase.caseId);
  }
  const outcome = (
    name,
    bodyBytes,
    bodyBytesRead,
    boundaryNextCalls,
    parserCalls,
    parserNextCalls,
    downstreamCalls,
    statusCode,
    errorCode,
    parsedPaddingLength = null
  ) => ({
    bodyBytes,
    bodyBytesRead,
    boundaryNextCalls,
    cacheControl: 'no-store',
    downstreamCalls,
    errorCode,
    name,
    parsedPaddingLength,
    parserCalls,
    parserNextCalls,
    pragma: 'no-cache',
    statusCode,
  });
  return {
    accepted: true,
    confirmationAttempted: false,
    databaseBoundaryReached: false,
    durablePersistenceAttempted: false,
    effectsBoundaryReached: false,
    filesystemBoundaryReached: false,
    fixture: contract.fixtures.authBeforeParser,
    identity: {
      prNumber: options.prNumber,
      sourceCommit: options.commitSha,
    },
    memoryBoundaryReached: false,
    networkBoundaryReached: false,
    protectedEffectsEnabled: false,
    providerBoundaryReached: false,
    schemaVersion: 1,
    statusAuthBoundary: {
      authBeforeParser: true,
      bodyLimitBytes: contract.bodyLimitBytes,
      callerBodyControlsProbe: false,
      caseCount: 6,
      cases: [
        outcome(
          'auth-unavailable-over',
          contract.bodyLimitBytes + 1,
          0,
          0,
          0,
          0,
          0,
          503,
          'CONTROL_PLANE_AUTH_UNAVAILABLE'
        ),
        outcome(
          'missing-auth-over',
          contract.bodyLimitBytes + 1,
          0,
          0,
          0,
          0,
          0,
          401,
          'CONTROL_PLANE_AUTH_REQUIRED'
        ),
        outcome(
          'invalid-auth-over',
          contract.bodyLimitBytes + 1,
          0,
          0,
          0,
          0,
          0,
          401,
          'CONTROL_PLANE_AUTH_REQUIRED'
        ),
        outcome(
          'read-scope-over',
          contract.bodyLimitBytes + 1,
          0,
          0,
          0,
          0,
          0,
          403,
          'CONTROL_PLANE_SCOPE_DENIED'
        ),
        outcome(
          'mcp-scope-exact',
          contract.bodyLimitBytes,
          contract.bodyLimitBytes,
          1,
          1,
          1,
          1,
          204,
          null,
          contract.bodyLimitBytes - 14
        ),
        outcome(
          'mcp-scope-over',
          contract.bodyLimitBytes + 1,
          contract.bodyLimitBytes + 1,
          1,
          1,
          0,
          0,
          413,
          'SYSTEM_STATE_REQUEST_INVALID'
        ),
      ],
      componentExecuted: true,
      downstreamCalls: 1,
      requiredScope: contract.requiredScope,
      serverOwnedBodies: true,
    },
  };
}

function expectedDispatchGptIdentifierContractPayload(requestCase) {
  const contract = NATIVE_PR_PREVIEW_E2E_CONTRACT.dispatchGptIdentifier;
  if (requestCase.fixtureName === 'maximumLength') {
    return {
      accepted: true,
      actionCodeUnits: contract.actionLength,
      boundaryContinued: true,
      fixture: contract.fixtures.maximumLength,
      gptIdCodeUnits: contract.gptIdLengths.maximum,
      nextCalls: 1,
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      quotaBoundaryReached: false,
      schemaVersion: 1,
    };
  }
  if (requestCase.fixtureName !== 'oversized') {
    fail('NATIVE_PR_PREVIEW_CASE_CONTRACT_INVALID', requestCase.caseId);
  }
  const correlation = nativePrPreviewCaseCorrelation(requestCase);
  return {
    ok: false,
    error: {
      code: 'BAD_REQUEST',
      message: 'gptId too long',
    },
    _route: {
      requestId: correlation.requestId,
      traceId: correlation.traceId,
      gptId: 'invalid',
      timestamp: DISPATCH_GPT_IDENTIFIER_TIMESTAMP_SENTINEL,
    },
    target: 'gpt',
    routeFamily: 'dispatch',
    gptId: 'invalid',
    executionMode: 'gpt',
    _dispatch: {
      target: 'gpt',
      executionMode: 'gpt',
      reason: 'explicit_target_gpt',
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
    case 'backstage-booker-openapi':
      if (!options.expectedBackstageBookerOpenApiDocument) {
        fail('NATIVE_PR_PREVIEW_CASE_CONTRACT_INVALID', requestCase.caseId);
      }
      return options.expectedBackstageBookerOpenApiDocument;
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
    case 'backstage-generation-contract':
      return expectedBackstageGenerationContractPayload(requestCase);
    case 'mcp-body-cap-contract':
      return expectedMcpBodyCapContractPayload(requestCase);
    case 'dispatch-gpt-identifier-contract':
      return expectedDispatchGptIdentifierContractPayload(requestCase);
    case 'status-auth-boundary-contract':
      return expectedStatusAuthBoundaryContractPayload(requestCase, options);
    case 'self-heal-approval-contract':
      return expectedSelfHealApprovalContractPayload(requestCase);
    case 'gaming-canary':
    case 'gaming-canary-invalid':
      return expectedGamingCanaryPayload(requestCase);
    case 'gaming-query':
    case 'gaming-query-validation':
    case 'gaming-query-operational':
      return expectedGamingQueryPayload(requestCase);
    case 'gaming-source':
      return expectedGamingSourcePayload(requestCase);
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
  if (requestCase.expectedType === 'backstage-booker-openapi') {
    const managedResultPath =
      '/gpt-access/capabilities/v1/backstage-booker/jobs/{jobId}/result';
    const managedResultOperation = body?.paths?.[managedResultPath]?.get;
    const managedResultParameters = Array.isArray(
      managedResultOperation?.parameters
    )
      ? managedResultOperation.parameters
      : [];
    const jobIdParameter = managedResultParameters.find(
      (parameter) => parameter?.name === 'jobId'
    );
    const waitParameter = managedResultParameters.find(
      (parameter) => parameter?.name === 'waitForResultMs'
    );
    const observedPaths = body?.paths && typeof body.paths === 'object'
      ? Object.keys(body.paths).sort()
      : [];
    const expectedInfoVersion = expectedBody?.info?.version;
    if (
      body?.openapi !== '3.1.0'
      || typeof expectedInfoVersion !== 'string'
      || !BACKSTAGE_BOOKER_OPENAPI_VERSION_PATTERN.test(expectedInfoVersion)
      || body?.info?.version !== expectedInfoVersion
      || !isDeepStrictEqual(observedPaths, BACKSTAGE_BOOKER_OPENAPI_PATHS)
      || managedResultOperation?.operationId
        !== 'getBackstageBookerJobResult'
      || !isDeepStrictEqual(
        managedResultOperation?.security,
        [{ bearerAuth: [] }]
      )
      || jobIdParameter?.in !== 'path'
      || jobIdParameter?.required !== true
      || !isDeepStrictEqual(
        jobIdParameter?.schema,
        { format: 'uuid', type: 'string' }
      )
      || waitParameter?.in !== 'query'
      || waitParameter?.required !== false
      || !isDeepStrictEqual(
        waitParameter?.schema,
        {
          default: 30_000,
          maximum: 30_000,
          minimum: 0,
          type: 'integer',
        }
      )
      || Object.hasOwn(body?.paths ?? {}, '/jobs/{jobId}/result')
      || bodyText.includes('"jobReadToken"')
      || bodyText.includes('"jobReadTokenHeader"')
      || bodyText.includes('x-arcanos-job-read-token')
      || bodyText.includes('"stream":')
    ) {
      fail(
        'NATIVE_PR_PREVIEW_BACKSTAGE_BOOKER_OPENAPI_INVALID',
        requestCase.caseId
      );
    }
  }
  if (requestCase.expectedType === 'dispatch-gpt-identifier-contract') {
    const contract = NATIVE_PR_PREVIEW_E2E_CONTRACT.dispatchGptIdentifier;
    if (
      bodyText.includes(contract.actionMarker)
      || bodyText.includes('x'.repeat(contract.gptIdLengths.oversized))
    ) {
      fail(
        'NATIVE_PR_PREVIEW_DISPATCH_GPT_IDENTIFIER_REFLECTION',
        requestCase.caseId
      );
    }
    if (requestCase.fixtureName === 'oversized') {
      const timestamp = body?._route?.timestamp;
      let timestampValid = false;
      if (typeof timestamp === 'string') {
        try {
          timestampValid = new Date(timestamp).toISOString() === timestamp;
        } catch {
          timestampValid = false;
        }
      }
      if (!timestampValid) {
        fail(
          'NATIVE_PR_PREVIEW_DISPATCH_GPT_IDENTIFIER_TIMESTAMP_INVALID',
          requestCase.caseId
        );
      }
      const normalizedBody = {
        ...body,
        _route: {
          ...body._route,
          timestamp: DISPATCH_GPT_IDENTIFIER_TIMESTAMP_SENTINEL,
        },
      };
      requireExactJson(normalizedBody, expectedBody, requestCase.caseId);
      return;
    }
  }
  if (requestCase.expectedType === 'status-auth-boundary-contract') {
    if (
      bodyText.includes('Bearer ')
      || bodyText.includes('x'.repeat(64))
    ) {
      fail(
        'NATIVE_PR_PREVIEW_STATUS_AUTH_BOUNDARY_REFLECTION',
        requestCase.caseId
      );
    }
    if (
      body?.identity?.prNumber !== options.prNumber
      || body?.identity?.sourceCommit !== options.commitSha
    ) {
      fail(
        'NATIVE_PR_PREVIEW_STATUS_AUTH_BOUNDARY_IDENTITY_INVALID',
        requestCase.caseId
      );
    }
    const boundary = body?.statusAuthBoundary;
    const cases = Array.isArray(boundary?.cases) ? boundary.cases : [];
    if (
      boundary?.authBeforeParser !== true
      || boundary?.bodyLimitBytes
        !== NATIVE_PR_PREVIEW_E2E_CONTRACT.statusAuthBoundary.bodyLimitBytes
      || boundary?.caseCount !== 6
      || cases.length !== 6
      || boundary?.componentExecuted !== true
      || boundary?.downstreamCalls !== 1
      || boundary?.requiredScope
        !== NATIVE_PR_PREVIEW_E2E_CONTRACT.statusAuthBoundary.requiredScope
      || boundary?.serverOwnedBodies !== true
      || cases.slice(0, 4).some((outcome) => (
        outcome?.bodyBytesRead !== 0
        || outcome?.boundaryNextCalls !== 0
        || outcome?.parserCalls !== 0
        || outcome?.parserNextCalls !== 0
        || outcome?.downstreamCalls !== 0
      ))
      || cases[4]?.bodyBytesRead
        !== NATIVE_PR_PREVIEW_E2E_CONTRACT.statusAuthBoundary.bodyLimitBytes
      || cases[4]?.boundaryNextCalls !== 1
      || cases[4]?.parserCalls !== 1
      || cases[4]?.parserNextCalls !== 1
      || cases[4]?.downstreamCalls !== 1
      || cases[5]?.bodyBytesRead
        !== NATIVE_PR_PREVIEW_E2E_CONTRACT.statusAuthBoundary.bodyLimitBytes + 1
      || cases[5]?.boundaryNextCalls !== 1
      || cases[5]?.parserCalls !== 1
      || cases[5]?.parserNextCalls !== 0
      || cases[5]?.downstreamCalls !== 0
    ) {
      fail(
        'NATIVE_PR_PREVIEW_STATUS_AUTH_BOUNDARY_OUTCOME_INVALID',
        requestCase.caseId
      );
    }
  }
  if (
    requestCase.expectedType === 'backstage-generation-contract'
    && requestCase.fixtureName === 'partitionFailureTelemetry'
  ) {
    const telemetry = body?.failureTelemetry;
    const sample = Array.isArray(telemetry?.sampleFailedShards)
      ? telemetry.sampleFailedShards
      : [];
    if (
      bodyText.includes('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1')
      || bodyText.includes('preview-telemetry-alpha')
      || bodyText.includes('preview-telemetry-zeta')
      || bodyText.includes('shared-failure')
      || telemetry?.loggerSinkExecuted !== false
      || telemetry?.maximum?.failedShardCount !== 512
      || telemetry?.maximum?.uniqueIdentityCount !== 512
      || telemetry?.maximum?.failedShardProjectionBytes !== 55_314
      || telemetry?.maximum?.projectionSha256
        !== '967a181c24119cfea50de0371f0a2dd4aa8df28759ea1878546dfbdbf49ce509'
      || sample.length !== 3
      || sample.some((entry) => (
        !/^opaque-[A-Za-z0-9_-]{43}$/u.test(entry?.shardIdentity ?? '')
      ))
    ) {
      fail(
        'NATIVE_PR_PREVIEW_BACKSTAGE_PARTITION_FAILURE_TELEMETRY_INVALID',
        requestCase.caseId
      );
    }
  }
  if (
    requestCase.expectedType === 'backstage-generation-contract'
    && requestCase.fixtureName === 'managedAsyncContinuation'
  ) {
    if (
      bodyText.includes('native-preview-backstage-')
      || bodyText.includes('jobReadToken')
      || bodyText.includes('ciphertext')
      || bodyText.includes('/stream')
      || body?.continuation?.terminalMaterializationVerified !== true
      || body?.continuation?.stateProjectionVerified !== true
      || body?.continuation?.allManagedPolls !== true
      || body?.sensitiveValuesAbsent !== true
      || body?.workerBoundaryReached !== false
    ) {
      fail(
        'NATIVE_PR_PREVIEW_BACKSTAGE_MANAGED_ASYNC_OUTCOME_INVALID',
        requestCase.caseId
      );
    }
  }
  if (
    requestCase.expectedType === 'backstage-generation-contract'
    && requestCase.fixtureName === 'protectedFailureNoFallback'
  ) {
    const projections = body?.failureProjection?.projections;
    if (
      bodyText.includes('PRIVATE_NO_FALLBACK_')
      || bodyText.includes('ciphertext')
      || bodyText.includes('jobReadToken')
      || bodyText.includes('"storyline"')
      || bodyText.includes('"answer"')
      || bodyText.includes('"draft"')
      || bodyText.includes('"partial"')
      || bodyText.includes('"preview"')
      || body?.continuityPolicy?.protectedGeneration?.processFallbackReads !== 0
      || body?.continuityPolicy?.quarantinedLegacy?.processFallbackReads !== 0
      || body?.continuityPolicy?.protectedAndQuarantined?.processFallbackReads !== 0
      || body?.continuityPolicy?.unprotectedControl?.processFallbackReads !== 1
      || body?.processFallbackReads !== 1
      || body?.failureProjection?.bothProtectedActionsVerified !== true
      || body?.failureProjection?.failureOnly !== true
      || !Array.isArray(projections)
      || projections.length !== 2
      || projections.some(projection => (
        projection?.resultIsNull !== true
        || projection?.noDraftMaterial !== true
        || projection?.protectedGenerationCompleted !== false
        || projection?.official !== false
        || projection?.continuityVerified !== false
        || projection?.authority !== 'none'
        || projection?.fallbackUsed !== false
        || projection?.fallbackPermitted !== false
      ))
      || body?.databaseBoundaryReached !== false
      || body?.providerBoundaryReached !== false
      || body?.hrcBoundaryReached !== false
      || body?.workerBoundaryReached !== false
    ) {
      fail(
        'NATIVE_PR_PREVIEW_BACKSTAGE_PROTECTED_NO_FALLBACK_OUTCOME_INVALID',
        requestCase.caseId
      );
    }
  }
  if (
    requestCase.expectedType === 'backstage-generation-contract'
    && requestCase.fixtureName === 'gptClientIdentity'
  ) {
    if (
      bodyText.includes('native-preview-gpt-client-')
      || bodyText.includes('caller-controlled-')
      || bodyText.includes('openai-attested')
      || bodyText.includes('credentialFingerprint')
      || bodyText.includes('principalActorKey')
      || body?.authentication?.registryResolutionCount !== 2
      || body?.identity?.clientId !== 'backstage-booker'
      || body?.identity?.runtimeModel !== null
      || body?.identity?.telemetryAllowlisted !== true
      || body?.provenance?.serializationRoundTripValid !== true
      || body?.provenance?.spoofedSnapshotOverwritten !== true
      || body?.provenance?.tamperedSnapshotRejected !== true
      || body?.sensitiveValuesAbsent !== true
      || body?.repositoryBoundaryReached !== false
      || body?.workerBoundaryReached !== false
    ) {
      fail(
        'NATIVE_PR_PREVIEW_BACKSTAGE_GPT_CLIENT_IDENTITY_OUTCOME_INVALID',
        requestCase.caseId
      );
    }
  }
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
  aggregateState,
  monotonicNow
) {
  const cancellationProofStartedAt =
    requestCase.caseId === 'research-workflow-cancellation-drain'
      ? monotonicNow()
      : null;
  const generationProofStartedAt =
    requestCase.caseId === 'backstage-generation-route-budget'
      ? monotonicNow()
      : null;
  const baseUrl =
    requestCase.role === 'web' ? options.webBaseUrl : options.workerBaseUrl;
  const requestUrl = `${baseUrl}${requestCase.path}`;
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs < 1) {
    fail('NATIVE_PR_PREVIEW_TOTAL_TIMEOUT', requestCase.caseId);
  }
  const timeoutMs = Math.max(
    1,
    Math.min(
      requestCase.requestTimeoutMs ?? options.requestTimeoutMs,
      remainingMs
    )
  );
  const correlation = nativePrPreviewCaseCorrelation(requestCase);
  const requestHeaders = {
    accept: requestCase.body === undefined && requestCase.rawBody === undefined
      ? 'application/json, text/plain'
      : 'application/json',
    ...(requestCase.body === undefined && requestCase.rawBody === undefined
      ? {}
      : { 'content-type': 'application/json' }),
    ...(requestCase.role === 'web'
      ? {
          'x-request-id': correlation.requestId,
          'x-trace-id': correlation.traceId,
        }
      : {}),
    ...(requestCase.headers ?? {}),
  };
  let response;
  try {
    response = await fetchImpl(requestUrl, {
      body: requestCase.rawBody
        ?? (requestCase.body === undefined
          ? undefined
          : JSON.stringify(requestCase.body)),
      headers: requestHeaders,
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
  if (
    requestCase.forbidCors === true
    && response.headers.has('access-control-allow-origin')
  ) {
    fail('NATIVE_PR_PREVIEW_CORS_BOUNDARY_INVALID', requestCase.caseId);
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
  if (requestCase.role === 'web') {
    if (
      response.headers.get('x-request-id') !== correlation.requestId
      || response.headers.get('x-trace-id') !== correlation.traceId
    ) {
      fail('NATIVE_PR_PREVIEW_CORRELATION_INVALID', requestCase.caseId);
    }
    for (const [headerName, expectedValue] of Object.entries(
      WEB_RESPONSE_HEADER_CONTRACT
    )) {
      if (response.headers.get(headerName) !== expectedValue) {
        fail('NATIVE_PR_PREVIEW_SECURITY_HEADERS_INVALID', requestCase.caseId);
      }
    }
  }
  if (
    requestCase.expectedType === 'worker-readiness'
    && response.headers.get(
      NATIVE_PR_PREVIEW_E2E_CONTRACT.workerBudgetReadiness.proofHeader
    ) !== NATIVE_PR_PREVIEW_E2E_CONTRACT.workerBudgetReadiness.proofVersion
  ) {
    fail(
      'NATIVE_PR_PREVIEW_WORKER_BUDGET_READINESS_PROOF_INVALID',
      requestCase.caseId
    );
  }
  if (
    (
      requestCase.expectedType === 'gaming-source'
      || requestCase.expectedType === 'dispatch-gpt-identifier-contract'
      || requestCase.expectedType === 'status-auth-boundary-contract'
    )
    && response.headers.get('pragma') !== 'no-cache'
  ) {
    fail('NATIVE_PR_PREVIEW_NO_CACHE_MISSING', requestCase.caseId);
  }
  if (
    (
      requestCase.expectedType.startsWith('gaming-canary')
      || requestCase.expectedType.startsWith('gaming-query')
      || requestCase.expectedType === 'gaming-source'
      || requestCase.expectedType === 'backstage-storyline-contract'
      || requestCase.expectedType === 'backstage-generation-contract'
      || requestCase.expectedType === 'dispatch-gpt-identifier-contract'
      || requestCase.expectedType === 'status-auth-boundary-contract'
      || requestCase.expectedType === 'self-heal-approval-contract'
    )
    && response.headers.get(
      NATIVE_PR_PREVIEW_E2E_CONTRACT.syntheticResponseHeader.name
    ) !== NATIVE_PR_PREVIEW_E2E_CONTRACT.syntheticResponseHeader.value
  ) {
    fail('NATIVE_PR_PREVIEW_SYNTHETIC_MARKER_MISSING', requestCase.caseId);
  }
  if (requestCase.expectedType === 'backstage-generation-contract') {
    const contract = NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration;
    if (
      response.headers.get(contract.proofHeaders.clearPolicyVersion)
        !== contract.clearPolicyVersion
    ) {
      fail(
        'NATIVE_PR_PREVIEW_BACKSTAGE_CLEAR_POLICY_PROOF_INVALID',
        requestCase.caseId
      );
    }
    if (
      requestCase.fixtureName === 'routeBudget'
      && !BACKSTAGE_QUEUE_WAIT_POLICY_PROOF_VERSIONS.includes(
        response.headers.get(contract.proofHeaders.queueWaitPolicyVersion)
      )
    ) {
      fail(
        'NATIVE_PR_PREVIEW_BACKSTAGE_QUEUE_WAIT_POLICY_PROOF_INVALID',
        requestCase.caseId
      );
    }
    if (
      requestCase.fixtureName === 'routeBudget'
      && response.headers.get(
        contract.proofHeaders.trinityReasoningPolicyVersion
      ) !== contract.trinityReasoningPolicyProofVersion
    ) {
      fail(
        'NATIVE_PR_PREVIEW_TRINITY_REASONING_POLICY_PROOF_INVALID',
        requestCase.caseId
      );
    }
    if (
      requestCase.fixtureName === 'notionAuthorityRag'
      && response.headers.get(
        contract.proofHeaders.partitionedAuthorityVersion
      ) !== contract.partitionedAuthorityProofVersion
    ) {
      fail(
        'NATIVE_PR_PREVIEW_BACKSTAGE_PARTITION_PROOF_INVALID',
        requestCase.caseId
      );
    }
    if (
      requestCase.fixtureName === 'notionAuthorityRag'
      && response.headers.get(
        contract.proofHeaders.partitionCutoverRepairVersion
      ) !== contract.partitionCutoverRepairProofVersion
    ) {
      fail(
        'NATIVE_PR_PREVIEW_BACKSTAGE_PARTITION_CUTOVER_REPAIR_PROOF_INVALID',
        requestCase.caseId
      );
    }
    if (
      requestCase.fixtureName === 'notionAuthorityRag'
      && response.headers.get(
        contract.proofHeaders.notionReadDiagnosticsVersion
      ) !== contract.notionReadDiagnosticsProofVersion
    ) {
      fail(
        'NATIVE_PR_PREVIEW_BACKSTAGE_NOTION_READ_DIAGNOSTICS_PROOF_INVALID',
        requestCase.caseId
      );
    }
    if (
      requestCase.fixtureName === 'partitionFailureTelemetry'
      && response.headers.get(
        contract.proofHeaders.partitionFailureTelemetryVersion
      ) !== contract.partitionFailureTelemetryProofVersion
    ) {
      fail(
        'NATIVE_PR_PREVIEW_BACKSTAGE_PARTITION_FAILURE_TELEMETRY_PROOF_INVALID',
        requestCase.caseId
      );
    }
    if (
      requestCase.fixtureName === 'managedAsyncContinuation'
      && !BACKSTAGE_MANAGED_ASYNC_PROOF_VERSIONS.includes(
        response.headers.get(
          contract.proofHeaders.managedAsyncContinuationVersion
        )
      )
    ) {
      fail(
        'NATIVE_PR_PREVIEW_BACKSTAGE_MANAGED_ASYNC_PROOF_INVALID',
        requestCase.caseId
      );
    }
    if (
      requestCase.fixtureName === 'protectedFailureNoFallback'
      && response.headers.get(
        contract.proofHeaders.protectedFailureNoFallbackVersion
      ) !== contract.protectedFailureNoFallbackProofVersion
    ) {
      fail(
        'NATIVE_PR_PREVIEW_BACKSTAGE_PROTECTED_NO_FALLBACK_PROOF_INVALID',
        requestCase.caseId
      );
    }
    if (
      requestCase.fixtureName === 'gptClientIdentity'
      && response.headers.get(
        contract.proofHeaders.gptClientIdentityVersion
      ) !== contract.gptClientIdentityProofVersion
    ) {
      fail(
        'NATIVE_PR_PREVIEW_BACKSTAGE_GPT_CLIENT_IDENTITY_PROOF_INVALID',
        requestCase.caseId
      );
    }
    if (
      (
        requestCase.fixtureName === 'compactRetry'
        || requestCase.fixtureName === 'productionOutputContracts'
      )
      && response.headers.get(
        contract.proofHeaders.outputCapacityPresentationVersion
      ) !== contract.outputCapacityPresentationProofVersion
    ) {
      fail(
        'NATIVE_PR_PREVIEW_BACKSTAGE_OUTPUT_CAPACITY_PRESENTATION_PROOF_INVALID',
        requestCase.caseId
      );
    }
    if (
      requestCase.fixtureName === 'outputAdmission'
      && response.headers.get(
        contract.proofHeaders.outputAdmissionVersion
      ) !== contract.outputAdmissionProofVersion
    ) {
      fail(
        'NATIVE_PR_PREVIEW_BACKSTAGE_OUTPUT_ADMISSION_PROOF_INVALID',
        requestCase.caseId
      );
    }
    if (
      requestCase.fixtureName === 'notionSyncPhaseA'
      && response.headers.get(
        contract.proofHeaders.notionSyncPhaseAVersion
      ) !== contract.notionSyncPhaseAProofVersion
    ) {
      fail(
        'NATIVE_PR_PREVIEW_BACKSTAGE_NOTION_SYNC_PHASE_A_PROOF_INVALID',
        requestCase.caseId
      );
    }
    if (
      requestCase.fixtureName === 'notionSyncPhaseA'
      && response.headers.get(
        contract.proofHeaders.notionWriterCapacityReleaseVersion
      ) !== contract.notionWriterCapacityReleaseProofVersion
    ) {
      fail(
        'NATIVE_PR_PREVIEW_BACKSTAGE_NOTION_WRITER_CAPACITY_RELEASE_PROOF_INVALID',
        requestCase.caseId
      );
    }
  }
  if (requestCase.expectedType === 'dispatch-gpt-identifier-contract') {
    const contract = NATIVE_PR_PREVIEW_E2E_CONTRACT.dispatchGptIdentifier;
    const maximumLength = requestCase.fixtureName === 'maximumLength';
    if (
      response.headers.get(contract.proofHeaders.actionLength)
        !== String(contract.actionLength)
      || response.headers.get(contract.proofHeaders.gptIdLength)
        !== String(
          maximumLength
            ? contract.gptIdLengths.maximum
            : contract.gptIdLengths.oversized
        )
      || response.headers.get(contract.proofHeaders.nextCalls)
        !== (maximumLength ? '1' : '0')
      || response.headers.has('x-response-truncated')
    ) {
      fail(
        'NATIVE_PR_PREVIEW_DISPATCH_GPT_IDENTIFIER_PROOF_INVALID',
        requestCase.caseId
      );
    }
  }
  if (requestCase.expectedType === 'status-auth-boundary-contract') {
    const contract = NATIVE_PR_PREVIEW_E2E_CONTRACT.statusAuthBoundary;
    if (
      response.headers.get(contract.proofHeaders.authBeforeParser) !== 'true'
      || response.headers.get(contract.proofHeaders.bodyLimitBytes)
        !== String(contract.bodyLimitBytes)
      || response.headers.get(contract.proofHeaders.downstreamCalls) !== '1'
      || response.headers.has('x-response-truncated')
    ) {
      fail(
        'NATIVE_PR_PREVIEW_STATUS_AUTH_BOUNDARY_PROOF_INVALID',
        requestCase.caseId
      );
    }
  }

  const bodyBytes = await readBoundedResponseBody(
    response,
    requestCase,
    options.maxResponseBytes,
    aggregateState
  );
  if (
    requestCase.expectedType === 'backstage-generation-contract'
    && bodyBytes.length
      > NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.maxResponseBytes
  ) {
    fail(
      'NATIVE_PR_PREVIEW_BACKSTAGE_GENERATION_RESPONSE_TOO_LARGE',
      requestCase.caseId
    );
  }
  if (requestCase.boundedResponse) {
    const declaredBytes = response.headers.get('x-response-bytes') ?? '';
    if (
      !INTEGER_PATTERN.test(declaredBytes)
      || Number.parseInt(declaredBytes, 10) !== bodyBytes.length
    ) {
      fail('NATIVE_PR_PREVIEW_BOUNDED_RESPONSE_INVALID', requestCase.caseId);
    }
  }
  if (
    requestCase.expectedType === 'dispatch-gpt-identifier-contract'
    && bodyBytes.length > 2 * 1024
  ) {
    fail(
      'NATIVE_PR_PREVIEW_DISPATCH_GPT_IDENTIFIER_RESPONSE_TOO_LARGE',
      requestCase.caseId
    );
  }
  if (
    requestCase.expectedType === 'status-auth-boundary-contract'
    && bodyBytes.length > 8 * 1024
  ) {
    fail(
      'NATIVE_PR_PREVIEW_STATUS_AUTH_BOUNDARY_RESPONSE_TOO_LARGE',
      requestCase.caseId
    );
  }
  validateResponseBody(requestCase, bodyBytes, options);
  if (
    cancellationProofStartedAt !== null
    && monotonicNow() - cancellationProofStartedAt
      < RESEARCH_CANCELLATION_MIN_RESPONSE_MS
  ) {
    fail(
      'NATIVE_PR_PREVIEW_CANCELLATION_DRAIN_TOO_EARLY',
      requestCase.caseId
    );
  }
  if (
    generationProofStartedAt !== null
    && monotonicNow() - generationProofStartedAt
      < BACKSTAGE_GENERATION_MIN_RESPONSE_MS
  ) {
    fail(
      'NATIVE_PR_PREVIEW_BACKSTAGE_GENERATION_TOO_EARLY',
      requestCase.caseId
    );
  }
  return {
    bodySha256: createHash('sha256').update(bodyBytes).digest('hex'),
    caseId: requestCase.caseId,
    httpStatus: response.status,
    method: requestCase.method,
    pathTemplate: requestCase.pathTemplate,
    responseBytes: bodyBytes.length,
    role: requestCase.role,
    simulatedAuth: requestCase.simulatedAuth === true,
    ...(requestCase.expectedType === 'backstage-generation-contract'
      ? { clearPolicyVersionVerified: true }
      : {}),
    ...(requestCase.expectedType === 'backstage-generation-contract'
      && requestCase.fixtureName === 'routeBudget'
      ? { queueWaitPolicyVerified: true }
      : {}),
    ...(requestCase.expectedType === 'backstage-generation-contract'
      && requestCase.fixtureName === 'routeBudget'
      ? { trinityReasoningPolicyVerified: true }
      : {}),
    ...(requestCase.expectedType === 'backstage-generation-contract'
      && requestCase.fixtureName === 'notionAuthorityRag'
      ? {
          notionReadDiagnosticsVerified: true,
          partitionCutoverRepairVerified: true,
          partitionedAuthorityVerified: true,
        }
      : {}),
    ...(requestCase.expectedType === 'backstage-generation-contract'
      && requestCase.fixtureName === 'partitionFailureTelemetry'
      ? { failedShardTelemetryVerified: true }
      : {}),
    ...(requestCase.expectedType === 'backstage-generation-contract'
      && requestCase.fixtureName === 'managedAsyncContinuation'
      ? { managedAsyncContinuationVerified: true }
      : {}),
    ...(requestCase.expectedType === 'backstage-generation-contract'
      && requestCase.fixtureName === 'protectedFailureNoFallback'
      ? { protectedFailureNoFallbackVerified: true }
      : {}),
    ...(requestCase.expectedType === 'backstage-generation-contract'
      && requestCase.fixtureName === 'gptClientIdentity'
      ? { gptClientIdentityVerified: true }
      : {}),
    ...(requestCase.expectedType === 'backstage-generation-contract'
      && requestCase.fixtureName === 'productionOutputContracts'
      ? { outputCapacityPresentationVerified: true }
      : {}),
    ...(requestCase.expectedType === 'backstage-generation-contract'
      && requestCase.fixtureName === 'outputAdmission'
      ? { outputAdmissionVerified: true }
      : {}),
    ...(requestCase.expectedType === 'backstage-generation-contract'
      && requestCase.fixtureName === 'notionSyncPhaseA'
      ? {
          notionSyncPhaseAVerified: true,
          notionWriterCapacityReleaseVerified: true,
        }
      : {}),
    ...(requestCase.expectedType === 'status-auth-boundary-contract'
      ? { statusAuthBoundaryVerified: true }
      : {}),
    ...(requestCase.expectedType === 'backstage-booker-openapi'
      ? { backstageBookerOpenApiVerified: true }
      : {}),
    ...(requestCase.expectedType === 'worker-readiness'
      ? { workerBudgetReadinessVerified: true }
      : {}),
    ...(generationProofStartedAt === null
      ? {}
      : {
          minimumResponseMs: BACKSTAGE_GENERATION_MIN_RESPONSE_MS,
          minimumResponseMsVerified: true,
        }),
  };
}

export async function runNativePrPreviewE2e({
  args,
  expectedBackstageBookerOpenApiDocument = undefined,
  fetchImpl = globalThis.fetch,
  localGitState = undefined,
  monotonicNow = () => performance.now(),
} = {}) {
  const parsedOptions = parseNativePrPreviewE2eArguments(
    args ?? [],
    localGitState === undefined ? {} : { localGitState }
  );
  const options = {
    ...parsedOptions,
    expectedBackstageBookerOpenApiDocument:
      expectedBackstageBookerOpenApiDocument
      ?? readExpectedBackstageBookerOpenApiDocument(
          parsedOptions.gitEvidenceRoot,
          parsedOptions.commitSha
        ),
  };
  const requestPlan = buildNativePrPreviewRequestPlan();
  const target = {
    repository: options.repository,
    prNumber: options.prNumber,
    commitSha: options.commitSha,
    webHost: new URL(options.webBaseUrl).hostname,
    workerHost: new URL(options.workerBaseUrl).hostname,
  };
  const limits = {
    effectivePerCaseMaxRequestTimeoutMs: Math.max(
      options.requestTimeoutMs,
      ...requestPlan.map(
        (requestCase) =>
          requestCase.requestTimeoutMs ?? options.requestTimeoutMs
      )
    ),
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
        simulatedAuthRequests: requestPlan.filter(
          (requestCase) => requestCase.simulatedAuth === true
        ).length,
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
      aggregateState,
      monotonicNow
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
      simulatedAuthRequests: checks.filter(
        (check) => check.simulatedAuth
      ).length,
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

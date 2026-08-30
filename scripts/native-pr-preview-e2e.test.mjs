import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  NativePrPreviewE2eError,
  buildNativePrPreviewRequestPlan,
  expectedNativePrPreviewContentType,
  expectedNativePrPreviewResponseBody,
  nativePrPreviewCaseCorrelation,
  parseNativePrPreviewE2eArguments,
  readExpectedBackstageBookerOpenApiDocument,
  readLocalGitState,
  runNativePrPreviewE2e,
} from './native-pr-preview-e2e.mjs';
import {
  NATIVE_PR_PREVIEW_E2E_CONTRACT,
} from './native-pr-preview-contract.mjs';
import {
  NATIVE_PR_PREVIEW_DIST_IMPORT_CONTRACT,
  findNativePrPreviewDistImportSourceViolations,
} from './check-native-pr-preview-dist-imports.mjs';

const COMMIT_SHA = 'a'.repeat(40);
const PR_NUMBER = 1413;
const WEB_BASE_URL =
  'https://arcanos-v2-arcanos-pr-1413.up.railway.app';
const WORKER_BASE_URL =
  'https://arcanos-worker-arcanos-pr-1413.up.railway.app';
const LOCAL_GIT_STATE = Object.freeze({
  clean: true,
  head: COMMIT_SHA,
  repository: 'pbjustin/Arcanos',
});
const EXPECTED_BACKSTAGE_BOOKER_OPENAPI_DOCUMENT =
  NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageBookerOpenApi.document;

function validArguments(...extraArguments) {
  return [
    '--pr-number',
    String(PR_NUMBER),
    '--commit-sha',
    COMMIT_SHA,
    '--web-base-url',
    WEB_BASE_URL,
    '--worker-base-url',
    WORKER_BASE_URL,
    ...extraArguments,
  ];
}

function responseBodyForCase(
  requestCase,
  {
    commitSha = COMMIT_SHA,
    expectedBackstageBookerOpenApiDocument =
      EXPECTED_BACKSTAGE_BOOKER_OPENAPI_DOCUMENT,
    prNumber = PR_NUMBER,
  } = {}
) {
  if (requestCase.expectedType === 'head') {
    return null;
  }
  const expectedBody = expectedNativePrPreviewResponseBody(requestCase, {
    commitSha,
    expectedBackstageBookerOpenApiDocument,
    prNumber,
  });
  if (
    requestCase.expectedType === 'dispatch-gpt-identifier-contract'
    && requestCase.fixtureName === 'oversized'
  ) {
    return JSON.stringify({
      ...expectedBody,
      _route: {
        ...expectedBody._route,
        timestamp: '2026-08-21T12:00:00.000Z',
      },
    });
  }
  return typeof expectedBody === 'string'
    ? expectedBody
    : JSON.stringify(expectedBody);
}

function expectedResearchCancellationPayload() {
  const scenario = (name, trigger, abortStage, startedStages) => ({
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
    fixture: 'workflow-cancellation-drain',
    memoryBoundaryReached: false,
    networkBoundaryReached: false,
    protectedEffectsEnabled: false,
    providerBoundaryReached: false,
    schemaVersion: 1,
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

function responseHeadersForCase(
  requestCase,
  bodyBytes,
  overrides = undefined
) {
  const correlation = nativePrPreviewCaseCorrelation(requestCase);
  const syntheticResponse =
    requestCase.expectedType.startsWith('gaming-canary')
    || requestCase.expectedType.startsWith('gaming-query')
    || requestCase.expectedType === 'gaming-source'
    || requestCase.expectedType === 'backstage-storyline-contract'
    || requestCase.expectedType === 'backstage-generation-contract'
    || requestCase.expectedType === 'dispatch-gpt-identifier-contract'
    || requestCase.expectedType === 'status-auth-boundary-contract'
    || requestCase.expectedType === 'self-heal-approval-contract';
  return {
    'cache-control': 'no-store',
    'content-type': expectedNativePrPreviewContentType(requestCase),
    ...(requestCase.role === 'web'
      ? {
          'content-security-policy':
            "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          'cross-origin-resource-policy': 'same-origin',
          'permissions-policy': 'camera=(), geolocation=(), microphone=()',
          'referrer-policy': 'no-referrer',
          'strict-transport-security':
            'max-age=31536000; includeSubDomains',
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
          'x-request-id': correlation.requestId,
          'x-trace-id': correlation.traceId,
        }
      : {}),
    ...(requestCase.boundedResponse
      ? { 'x-response-bytes': String(bodyBytes) }
      : {}),
    ...(syntheticResponse
      ? {
          [NATIVE_PR_PREVIEW_E2E_CONTRACT.syntheticResponseHeader.name]:
            NATIVE_PR_PREVIEW_E2E_CONTRACT.syntheticResponseHeader.value,
        }
      : {}),
    ...(requestCase.expectedType === 'backstage-generation-contract'
      ? {
          [NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .clearPolicyVersion]:
            NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
              .clearPolicyVersion,
          ...(requestCase.fixtureName === 'routeBudget'
            ? {
                [NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                  .proofHeaders.queueWaitPolicyVersion]:
                  NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                    .queueWaitPolicyProofVersion,
                [NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                  .proofHeaders.trinityReasoningPolicyVersion]:
                  NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                    .trinityReasoningPolicyProofVersion,
              }
            : {}),
          ...(requestCase.fixtureName === 'notionAuthorityRag'
            ? {
                [NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                  .proofHeaders.partitionedAuthorityVersion]:
                  NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                    .partitionedAuthorityProofVersion,
                [NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                  .proofHeaders.partitionCutoverRepairVersion]:
                  NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                    .partitionCutoverRepairProofVersion,
              }
            : {}),
          ...(requestCase.fixtureName === 'partitionFailureTelemetry'
            ? {
                [NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                  .proofHeaders.partitionFailureTelemetryVersion]:
                  NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                    .partitionFailureTelemetryProofVersion,
              }
            : {}),
          ...(requestCase.fixtureName === 'managedAsyncContinuation'
            ? {
                [NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                  .proofHeaders.managedAsyncContinuationVersion]:
                  NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                    .managedAsyncContinuationProofVersion,
              }
            : {}),
          ...(requestCase.fixtureName === 'gptClientIdentity'
            ? {
                [NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                  .proofHeaders.gptClientIdentityVersion]:
                  NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                    .gptClientIdentityProofVersion,
              }
            : {}),
          ...(
            requestCase.fixtureName === 'compactRetry'
            || requestCase.fixtureName === 'productionOutputContracts'
            ? {
                [NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                  .proofHeaders.outputCapacityPresentationVersion]:
                  NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                    .outputCapacityPresentationProofVersion,
              }
            : {}
          ),
          ...(requestCase.fixtureName === 'outputAdmission'
            ? {
                [NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                  .proofHeaders.outputAdmissionVersion]:
                  NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                    .outputAdmissionProofVersion,
              }
            : {}),
          ...(requestCase.fixtureName === 'notionSyncPhaseA'
            ? {
                [NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                  .proofHeaders.notionSyncPhaseAVersion]:
                  NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration
                    .notionSyncPhaseAProofVersion,
              }
            : {}),
        }
      : {}),
    ...(
      requestCase.expectedType === 'gaming-source'
      || requestCase.expectedType === 'dispatch-gpt-identifier-contract'
      || requestCase.expectedType === 'status-auth-boundary-contract'
      ? { pragma: 'no-cache' }
      : {}
    ),
    ...(requestCase.expectedType === 'dispatch-gpt-identifier-contract'
      ? {
          [NATIVE_PR_PREVIEW_E2E_CONTRACT.dispatchGptIdentifier.proofHeaders
            .actionLength]: String(
            NATIVE_PR_PREVIEW_E2E_CONTRACT.dispatchGptIdentifier.actionLength
          ),
          [NATIVE_PR_PREVIEW_E2E_CONTRACT.dispatchGptIdentifier.proofHeaders
            .gptIdLength]: String(
            requestCase.fixtureName === 'maximumLength'
              ? NATIVE_PR_PREVIEW_E2E_CONTRACT.dispatchGptIdentifier
                  .gptIdLengths.maximum
              : NATIVE_PR_PREVIEW_E2E_CONTRACT.dispatchGptIdentifier
                  .gptIdLengths.oversized
          ),
          [NATIVE_PR_PREVIEW_E2E_CONTRACT.dispatchGptIdentifier.proofHeaders
            .nextCalls]: requestCase.fixtureName === 'maximumLength' ? '1' : '0',
        }
      : {}),
    ...(requestCase.expectedType === 'status-auth-boundary-contract'
      ? {
          [NATIVE_PR_PREVIEW_E2E_CONTRACT.statusAuthBoundary.proofHeaders
            .authBeforeParser]: 'true',
          [NATIVE_PR_PREVIEW_E2E_CONTRACT.statusAuthBoundary.proofHeaders
            .bodyLimitBytes]: String(
            NATIVE_PR_PREVIEW_E2E_CONTRACT.statusAuthBoundary.bodyLimitBytes
          ),
          [NATIVE_PR_PREVIEW_E2E_CONTRACT.statusAuthBoundary.proofHeaders
            .downstreamCalls]: '1',
        }
      : {}),
    ...(overrides ?? {}),
  };
}

function buildMockFetch(
  requestPlan,
  override = undefined,
  expectedResponseOptions = undefined
) {
  let requestIndex = 0;
  let monotonicTimeMs = 0;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const requestCase = requestPlan[requestIndex];
    assert.ok(requestCase);
    requestIndex += 1;
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, undefined);
    assert.equal(init.headers.cookie, undefined);
    assert.equal(init.headers['x-arcanos-job-read-token'], undefined);
    if (requestCase.role === 'web') {
      assert.deepEqual(
        {
          requestId: init.headers['x-request-id'],
          traceId: init.headers['x-trace-id'],
        },
        nativePrPreviewCaseCorrelation(requestCase)
      );
    }

    const overriddenResponse = override?.(requestCase, requestIndex);
    if (overriddenResponse) {
      return overriddenResponse;
    }
    if (requestCase.caseId === 'research-workflow-cancellation-drain') {
      monotonicTimeMs += 325;
    }
    if (requestCase.caseId === 'backstage-generation-route-budget') {
      monotonicTimeMs += 13_250;
    }
    const body = responseBodyForCase(requestCase, expectedResponseOptions);
    const bodyBytes = Buffer.byteLength(body ?? '');
    const headers = responseHeadersForCase(requestCase, bodyBytes);
    const response = new Response(body, {
      headers,
      status: requestCase.expectedStatus,
    });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  return {
    calls,
    fetchImpl,
    monotonicNow: () => monotonicTimeMs,
    get requestCount() {
      return requestIndex;
    },
  };
}

test('validates an exact native PR target without network access by default', async () => {
  let networkAttempted = false;
  const result = await runNativePrPreviewE2e({
    args: validArguments(),
    fetchImpl: async () => {
      networkAttempted = true;
      throw new Error('network must remain disabled');
    },
    expectedBackstageBookerOpenApiDocument:
      EXPECTED_BACKSTAGE_BOOKER_OPENAPI_DOCUMENT,
    localGitState: LOCAL_GIT_STATE,
  });

  assert.equal(networkAttempted, false);
  assert.equal(result.executed, false);
  assert.equal(result.networkAttempted, false);
  assert.equal(result.summary.status, 'PASS');
  assert.equal(result.limits.requestTimeoutMs, 5_000);
  assert.equal(result.limits.effectivePerCaseMaxRequestTimeoutMs, 20_000);
  assert.equal(
    result.summary.plannedRequests,
    buildNativePrPreviewRequestPlan().length
  );
});

test('requires paired execution and network opt-ins', () => {
  assert.throws(
    () => parseNativePrPreviewE2eArguments(
      validArguments('--execute'),
      { localGitState: LOCAL_GIT_STATE }
    ),
    (error) =>
      error instanceof NativePrPreviewE2eError
      && error.code === 'NATIVE_PR_PREVIEW_NETWORK_OPT_IN_INCOMPLETE'
  );
  assert.throws(
    () => parseNativePrPreviewE2eArguments(
      validArguments('--allow-network'),
      { localGitState: LOCAL_GIT_STATE }
    ),
    (error) =>
      error instanceof NativePrPreviewE2eError
      && error.code === 'NATIVE_PR_PREVIEW_NETWORK_OPT_IN_INCOMPLETE'
  );
});

test('rejects commit drift and non-preview or credential-bearing origins', () => {
  assert.throws(
    () => parseNativePrPreviewE2eArguments(
      validArguments(),
      {
        localGitState: {
          ...LOCAL_GIT_STATE,
          head: 'b'.repeat(40),
        },
      }
    ),
    (error) =>
      error instanceof NativePrPreviewE2eError
      && error.code === 'NATIVE_PR_PREVIEW_LOCAL_HEAD_MISMATCH'
  );

  const invalidOriginArguments = validArguments();
  invalidOriginArguments[
    invalidOriginArguments.indexOf('--web-base-url') + 1
  ] = 'https://user:secret@arcanos-production.up.railway.app';
  assert.throws(
    () => parseNativePrPreviewE2eArguments(
      invalidOriginArguments,
      { localGitState: LOCAL_GIT_STATE }
    ),
    (error) =>
      error instanceof NativePrPreviewE2eError
      && error.code === 'NATIVE_PR_PREVIEW_WEB_ORIGIN_INVALID'
  );
});

test('rejects dirty worktrees and non-canonical repositories', () => {
  assert.throws(
    () => parseNativePrPreviewE2eArguments(
      validArguments(),
      {
        localGitState: {
          ...LOCAL_GIT_STATE,
          clean: false,
        },
      }
    ),
    (error) =>
      error instanceof NativePrPreviewE2eError
      && error.code === 'NATIVE_PR_PREVIEW_LOCAL_WORKTREE_DIRTY'
  );
  assert.throws(
    () => parseNativePrPreviewE2eArguments(
      validArguments(),
      {
        localGitState: {
          ...LOCAL_GIT_STATE,
          repository: 'example/not-arcanos',
        },
      }
    ),
    (error) =>
      error instanceof NativePrPreviewE2eError
      && error.code === 'NATIVE_PR_PREVIEW_LOCAL_REPOSITORY_MISMATCH'
  );
});

test('reads exact candidate Git evidence without executing candidate files', async () => {
  const repositoryRoot = mkdtempSync(path.join(tmpdir(), 'arcanos-preview-evidence-'));
  const runGit = (...args) => {
    const result = spawnSync('git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    runGit('init');
    runGit('config', 'user.email', 'preview-evidence@example.invalid');
    runGit('config', 'user.name', 'Preview Evidence');
    const evidenceDocument = structuredClone(
      NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageBookerOpenApi.document
    );
    evidenceDocument['x-exact-head-evidence'] = 'candidate-only';
    mkdirSync(path.join(repositoryRoot, 'contracts'));
    writeFileSync(
      path.join(
        repositoryRoot,
        'contracts',
        'backstage_booker.openapi.v1.json'
      ),
      JSON.stringify(evidenceDocument)
    );
    writeFileSync(path.join(repositoryRoot, 'candidate.txt'), 'candidate evidence\n');
    runGit('add', 'candidate.txt', 'contracts/backstage_booker.openapi.v1.json');
    runGit('commit', '-m', 'candidate evidence');
    runGit('remote', 'add', 'origin', 'https://github.com/pbjustin/Arcanos.git');
    const head = runGit('rev-parse', 'HEAD').toLowerCase();

    assert.deepEqual(readLocalGitState(repositoryRoot, repositoryRoot), {
      clean: true,
      head,
      repository: 'pbjustin/Arcanos',
    });
    const evidenceArguments = validArguments('--git-evidence-root', repositoryRoot);
    evidenceArguments[evidenceArguments.indexOf('--commit-sha') + 1] = head;
    const parsed = parseNativePrPreviewE2eArguments(evidenceArguments);
    assert.equal(parsed.commitSha, head);
    assert.deepEqual(
      readExpectedBackstageBookerOpenApiDocument(repositoryRoot, head),
      evidenceDocument
    );
    const liveEvidenceArguments = validArguments(
      '--git-evidence-root',
      repositoryRoot,
      '--execute',
      '--allow-network'
    );
    liveEvidenceArguments[
      liveEvidenceArguments.indexOf('--commit-sha') + 1
    ] = head;
    const requestPlan = buildNativePrPreviewRequestPlan();
    const exactHeadMock = buildMockFetch(
      requestPlan,
      (requestCase) => {
        if (requestCase.caseId !== 'web-backstage-booker-openapi') {
          return undefined;
        }
        const body = JSON.stringify(evidenceDocument);
        const response = new Response(body, {
          headers: responseHeadersForCase(
            requestCase,
            Buffer.byteLength(body)
          ),
          status: requestCase.expectedStatus,
        });
        Object.defineProperty(response, 'url', {
          value: `${WEB_BASE_URL}${requestCase.path}`,
        });
        return response;
      },
      { commitSha: head }
    );
    const exactHeadResult = await runNativePrPreviewE2e({
      args: liveEvidenceArguments,
      fetchImpl: exactHeadMock.fetchImpl,
      monotonicNow: exactHeadMock.monotonicNow,
    });
    assert.equal(
      exactHeadResult.checks.find(({ caseId }) =>
        caseId === 'web-backstage-booker-openapi'
      )?.backstageBookerOpenApiVerified,
      true
    );

    const trustedCopyMock = buildMockFetch(
      requestPlan,
      undefined,
      { commitSha: head }
    );
    await assert.rejects(
      runNativePrPreviewE2e({
        args: liveEvidenceArguments,
        fetchImpl: trustedCopyMock.fetchImpl,
        monotonicNow: trustedCopyMock.monotonicNow,
      }),
      (error) =>
        error instanceof NativePrPreviewE2eError
        && error.code === 'NATIVE_PR_PREVIEW_BODY_MISMATCH'
        && error.caseId === 'web-backstage-booker-openapi'
    );
    assert.throws(
      () => readLocalGitState(repositoryRoot, path.dirname(repositoryRoot)),
      (error) => error instanceof NativePrPreviewE2eError
        && error.code === 'NATIVE_PR_PREVIEW_LOCAL_REPOSITORY_ROOT_MISMATCH'
    );
    writeFileSync(path.join(repositoryRoot, 'candidate.txt'), 'dirty evidence\n');
    assert.throws(
      () => readLocalGitState(repositoryRoot, repositoryRoot),
      (error) => error instanceof NativePrPreviewE2eError
        && error.code === 'NATIVE_PR_PREVIEW_LOCAL_WORKTREE_DIRTY'
    );
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('executes the bounded credential-free matrix and detects identity stability', async () => {
  const requestPlan = buildNativePrPreviewRequestPlan();
  assert.equal(requestPlan.length, 136);
  assert.equal(
    requestPlan.filter(({ caseId, expectedType }) =>
      expectedType !== 'research-contract'
      && expectedType !== 'backstage-booker-openapi'
      && expectedType !== 'backstage-storyline-contract'
      && expectedType !== 'backstage-generation-contract'
      && expectedType !== 'mcp-body-cap-contract'
      && expectedType !== 'dispatch-gpt-identifier-contract'
      && expectedType !== 'status-auth-boundary-contract'
      && expectedType !== 'self-heal-approval-contract'
      && !caseId.startsWith('gaming-')
      && !caseId.startsWith('worker-gaming-')
      && caseId !== 'worker-research-denied'
      && caseId !== 'worker-backstage-storyline-denied'
      && caseId !== 'worker-backstage-generation-denied'
      && caseId !== 'worker-backstage-booker-openapi-denied'
      && caseId !== 'worker-mcp-body-cap-denied'
      && caseId !== 'worker-dispatch-gpt-identifier-denied'
      && caseId !== 'worker-status-auth-boundary-denied'
      && caseId !== 'worker-self-heal-approval-denied'
    ).length,
    50
  );
  assert.deepEqual(
    requestPlan
      .filter(({ caseId }) => caseId.includes('backstage-booker-openapi'))
      .map(({ caseId, expectedStatus, expectedType, role }) => ({
        caseId,
        expectedStatus,
        expectedType,
        role,
      })),
    [
      {
        caseId: 'web-backstage-booker-openapi',
        expectedStatus: 200,
        expectedType: 'backstage-booker-openapi',
        role: 'web',
      },
      {
        caseId: 'worker-backstage-booker-openapi-denied',
        expectedStatus: 404,
        expectedType: 'not-found',
        role: 'worker',
      },
    ]
  );
  assert.equal(
    requestPlan.filter(({ expectedType }) =>
      expectedType === 'dispatch-gpt-identifier-contract'
    ).length,
    2
  );
  assert.equal(
    requestPlan.filter(({ expectedType }) =>
      expectedType === 'status-auth-boundary-contract'
    ).length,
    1
  );
  assert.equal(
    requestPlan.filter(({ expectedType }) =>
      expectedType === 'research-contract'
    ).length,
    11
  );
  assert.equal(
    requestPlan.filter(({ expectedType }) =>
      expectedType === 'backstage-storyline-contract'
    ).length,
    6
  );
  assert.equal(
    requestPlan.filter(({ expectedType }) =>
      expectedType === 'backstage-generation-contract'
    ).length,
    13
  );
  assert.equal(
    requestPlan.filter(({ expectedType }) =>
      expectedType === 'mcp-body-cap-contract'
    ).length,
    1
  );
  assert.equal(
    requestPlan.filter(({ expectedType }) =>
      expectedType === 'self-heal-approval-contract'
    ).length,
    6
  );
  assert.equal(
    requestPlan.filter(({ expectedType }) =>
      expectedType === 'gaming-source'
    ).length,
    28
  );
  assert.equal(
    requestPlan.filter(({ simulatedAuth }) => simulatedAuth === true).length,
    23
  );
  assert.equal(
    requestPlan.filter(({ expectedType, simulatedAuth }) =>
      expectedType === 'gaming-source' && simulatedAuth !== true
    ).length,
    8
  );
  const managedAsyncContinuationCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-generation-managed-async-continuation'
  );
  assert.ok(managedAsyncContinuationCase);
  assert.deepEqual(managedAsyncContinuationCase, {
    body: { fixture: 'managed-async-continuation-contract' },
    boundedResponse: true,
    caseId: 'backstage-generation-managed-async-continuation',
    expectedStatus: 200,
    expectedType: 'backstage-generation-contract',
    fixture: 'managed-async-continuation-contract',
    fixtureName: 'managedAsyncContinuation',
    method: 'POST',
    path: '/backstage/generation-contract',
    pathTemplate: '/backstage/generation-contract',
    requestTimeoutMs: 20_000,
    role: 'web',
    simulatedAuth: true,
  });
  const managedAsyncContinuationRequestBody = JSON.stringify(
    managedAsyncContinuationCase.body
  );
  assert.deepEqual(Object.keys(managedAsyncContinuationCase.body), ['fixture']);
  assert.equal(
    /authorization|cookie|credential|secret|session|token/iu.test(
      managedAsyncContinuationRequestBody
    ),
    false
  );
  const gptClientIdentityCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-generation-gpt-client-identity'
  );
  assert.ok(gptClientIdentityCase);
  assert.deepEqual(gptClientIdentityCase, {
    body: { fixture: 'gpt-client-identity-contract' },
    boundedResponse: true,
    caseId: 'backstage-generation-gpt-client-identity',
    expectedStatus: 200,
    expectedType: 'backstage-generation-contract',
    fixture: 'gpt-client-identity-contract',
    fixtureName: 'gptClientIdentity',
    method: 'POST',
    path: '/backstage/generation-contract',
    pathTemplate: '/backstage/generation-contract',
    requestTimeoutMs: 20_000,
    role: 'web',
    simulatedAuth: true,
  });
  assert.deepEqual(Object.keys(gptClientIdentityCase.body), ['fixture']);
  assert.equal(
    /authorization|cookie|credential|secret|session|token/iu.test(
      JSON.stringify(gptClientIdentityCase.body)
    ),
    false
  );
  const unauthenticatedParserBoundaryCases = requestPlan.filter(({ caseId }) =>
    caseId === 'gaming-source-ingestion-malformed-unauthorized'
    || caseId === 'gaming-source-ingestion-oversized-unauthorized'
  );
  assert.equal(unauthenticatedParserBoundaryCases.length, 2);
  assert.equal(
    unauthenticatedParserBoundaryCases[0].rawBody,
    '{"action":'
  );
  assert.equal(
    Buffer.byteLength(unauthenticatedParserBoundaryCases[1].rawBody, 'utf8'),
    16_385
  );
  const simulatedParserCases = requestPlan.filter(({ sourceScenario }) =>
    sourceScenario === 'parser-validation'
  );
  assert.equal(simulatedParserCases.length, 3);
  assert.deepEqual(
    simulatedParserCases.map(({ expectedStatus }) => expectedStatus).sort(),
    [400, 413, 415]
  );
  const sourceOptionsCase = requestPlan.find(({ caseId }) =>
    caseId === 'gaming-source-options-unauthorized'
  );
  assert.ok(sourceOptionsCase);
  assert.equal(sourceOptionsCase.expectedType, 'gaming-source');
  assert.equal(sourceOptionsCase.expectedStatus, 401);
  assert.equal(sourceOptionsCase.forbidCors, true);
  assert.equal(sourceOptionsCase.headers.origin, 'https://example.com');
  assert.equal(
    sourceOptionsCase.headers['access-control-request-method'],
    'POST'
  );
  assert.equal(sourceOptionsCase.simulatedAuth, undefined);
  const sourceValidationCase = requestPlan.find(({ caseId }) =>
    caseId === 'gaming-source-ingestion-validation'
  );
  assert.ok(sourceValidationCase);
  assert.ok(Buffer.byteLength(
    JSON.stringify(sourceValidationCase.body),
    'utf8'
  ) > 4 * 1024);
  assert.equal(
    requestPlan.filter(({ caseId }) =>
      caseId === 'worker-research-denied'
    ).length,
    1
  );
  assert.equal(
    requestPlan.filter(({ caseId }) =>
      caseId === 'worker-backstage-storyline-denied'
    ).length,
    1
  );
  assert.equal(
    requestPlan.filter(({ caseId }) =>
      caseId === 'worker-mcp-body-cap-denied'
    ).length,
    1
  );
  assert.equal(
    requestPlan.filter(({ caseId }) =>
      caseId === 'worker-dispatch-gpt-identifier-denied'
    ).length,
    1
  );
  assert.equal(
    requestPlan.filter(({ caseId }) =>
      caseId === 'worker-status-auth-boundary-denied'
    ).length,
    1
  );
  assert.deepEqual(
    requestPlan.find(({ caseId }) => caseId === 'status-auth-before-parser'),
    {
      body: { fixture: 'auth-before-parser' },
      boundedResponse: true,
      caseId: 'status-auth-before-parser',
      expectedStatus: 200,
      expectedType: 'status-auth-boundary-contract',
      fixture: 'auth-before-parser',
      fixtureName: 'authBeforeParser',
      method: 'POST',
      path: '/status/auth-before-parser-contract',
      pathTemplate: '/status/auth-before-parser-contract',
      role: 'web',
      simulatedAuth: true,
    }
  );
  assert.deepEqual(
    requestPlan.find(({ caseId }) =>
      caseId === 'worker-status-auth-boundary-denied'
    ),
    {
      body: { fixture: 'auth-before-parser' },
      caseId: 'worker-status-auth-boundary-denied',
      expectedStatus: 404,
      expectedType: 'not-found',
      method: 'POST',
      path: '/status/auth-before-parser-contract',
      pathTemplate: '/status/auth-before-parser-contract',
      role: 'worker',
    }
  );
  assert.equal(
    requestPlan.filter(({ caseId }) =>
      caseId === 'worker-self-heal-approval-denied'
    ).length,
    1
  );
  const lifecycleCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-storyline-lifecycle-exact'
  );
  const repeatedLifecycleCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-storyline-lifecycle-repeat'
  );
  assert.ok(lifecycleCase);
  assert.ok(repeatedLifecycleCase);
  const savedStorylineProjectionCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-saved-storyline-projection'
  );
  assert.ok(savedStorylineProjectionCase);
  assert.deepEqual(
    expectedNativePrPreviewResponseBody(savedStorylineProjectionCase, {
      commitSha: COMMIT_SHA,
      prNumber: PR_NUMBER,
    }),
    {
      accepted: true,
      databaseBoundaryReached: false,
      durablePersistenceAttempted: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: false,
      fixture: 'saved-storyline-projection',
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      schemaVersion: 1,
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
    }
  );
  const cancellationCase = requestPlan.find(({ caseId }) =>
    caseId === 'research-workflow-cancellation-drain'
  );
  assert.ok(cancellationCase);
  assert.deepEqual(
    expectedNativePrPreviewResponseBody(cancellationCase, {
      commitSha: COMMIT_SHA,
      prNumber: PR_NUMBER,
    }),
    expectedResearchCancellationPayload()
  );
  assert.deepEqual(
    expectedNativePrPreviewResponseBody(repeatedLifecycleCase, {
      commitSha: COMMIT_SHA,
      prNumber: PR_NUMBER,
    }),
    expectedNativePrPreviewResponseBody(lifecycleCase, {
      commitSha: COMMIT_SHA,
      prNumber: PR_NUMBER,
    })
  );
  assert.deepEqual(
    expectedNativePrPreviewResponseBody(lifecycleCase, {
      commitSha: COMMIT_SHA,
      prNumber: PR_NUMBER,
    }),
    {
      accepted: true,
      confirmationAttempted: false,
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      eligibleForConfirmation: true,
      fixture: 'lifecycle-exact',
      durablePersistenceAttempted: false,
      postValidationBoundaryReached: true,
      protectedEffectsEnabled: false,
      schemaVersion: 1,
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
    }
  );
  const phaseOneUniverseBindingCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-phase-one-universe-binding'
  );
  assert.ok(phaseOneUniverseBindingCase);
  assert.deepEqual(
    expectedNativePrPreviewResponseBody(phaseOneUniverseBindingCase, {
      commitSha: COMMIT_SHA,
      prNumber: PR_NUMBER,
    }),
    {
      accepted: true,
      confirmationAttempted: false,
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      eligibleForConfirmation: true,
      fixture: 'phase-one-universe-binding',
      durablePersistenceAttempted: false,
      postValidationBoundaryReached: true,
      protectedEffectsEnabled: false,
      schemaVersion: 1,
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
    }
  );
  const payloadOverCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-storyline-payload-over'
  );
  assert.ok(payloadOverCase);
  assert.deepEqual(
    expectedNativePrPreviewResponseBody(payloadOverCase, {
      commitSha: COMMIT_SHA,
      prNumber: PR_NUMBER,
    }),
    {
      accepted: false,
      confirmationAttempted: false,
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      eligibleForConfirmation: false,
      fixture: 'payload-over',
      durablePersistenceAttempted: false,
      postValidationBoundaryReached: false,
      protectedEffectsEnabled: false,
      schemaVersion: 1,
      transactionComponentExecuted: false,
      validationCompleted: true,
      validationCode: 'BACKSTAGE_STORYLINE_INVALID',
    }
  );
  const routeBudgetCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-generation-route-budget'
  );
  const hrcRetryCacheCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-generation-hrc-retry-cache'
  );
  const reviewCompletionCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-generation-review-completion'
  );
  const compactRetryCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-generation-compact-retry'
  );
  const productionOutputContractsCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-generation-production-output-contracts'
  );
  const outputAdmissionCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-generation-output-admission'
  );
  const notionSyncPhaseACase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-generation-notion-sync-phase-a'
  );
  const notionAuthorityRagCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-generation-notion-authority-rag'
  );
  const partitionFailureTelemetryCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-generation-partition-failure-telemetry'
  );
  const continuityQueryCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-generation-continuity-query'
  );
  const continuitySubtreeCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-generation-continuity-subtree'
  );
  assert.ok(routeBudgetCase);
  assert.ok(hrcRetryCacheCase);
  assert.ok(reviewCompletionCase);
  assert.ok(compactRetryCase);
  assert.ok(productionOutputContractsCase);
  assert.ok(outputAdmissionCase);
  assert.ok(notionSyncPhaseACase);
  assert.ok(notionAuthorityRagCase);
  assert.ok(partitionFailureTelemetryCase);
  assert.ok(continuityQueryCase);
  assert.ok(continuitySubtreeCase);
  assert.equal(routeBudgetCase.requestTimeoutMs, 20_000);
  assert.deepEqual(
    expectedNativePrPreviewResponseBody(routeBudgetCase, {
      commitSha: COMMIT_SHA,
      prNumber: PR_NUMBER,
    }),
    {
      accepted: true,
      cacheBoundaryReached: false,
      canonicalRouteRecognized: true,
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: false,
      fixture: 'route-budget-provider-delay',
      generationStageTimeoutMs: 40_000,
      genericRouteBoundaryMs: 6_000,
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      routeTimeoutMs: 60_000,
      schemaVersion: 1,
      syntheticProviderCompleted: true,
      syntheticProviderDelayMs: 13_250,
      trinityRunOptions: {
        answerMode: 'direct',
        modelStageTimeoutMs: 40_000,
        strictUserVisibleOutput: true,
      },
    }
  );
  assert.deepEqual(
    expectedNativePrPreviewResponseBody(hrcRetryCacheCase, {
      commitSha: COMMIT_SHA,
      prNumber: PR_NUMBER,
    }),
    {
      accepted: true,
      cacheBoundaryReached: true,
      cacheWrites: 1,
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      evaluationCalls: 2,
      externalNetworkAttempted: false,
      fixture: 'hrc-timeout-retry-cache',
      first: {
        cacheable: false,
        verdict: 'Synthetic HRC timeout fallback',
      },
      hrcEvaluationTimeoutMs: 10_000,
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      schemaVersion: 1,
      second: {
        cacheable: true,
        verdict: 'Synthetic HRC retry succeeded',
      },
      syntheticTimeoutMs: 25,
      thirdServedFromCache: true,
    }
  );
  const reviewCompletionPayload = expectedNativePrPreviewResponseBody(
    reviewCompletionCase,
    { commitSha: COMMIT_SHA, prNumber: PR_NUMBER }
  );
  assert.deepEqual(reviewCompletionPayload.classification, {
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
  });
  assert.deepEqual(reviewCompletionPayload.contracts, {
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
  });
  assert.equal(
    reviewCompletionPayload.normalization.authoritativeReviewBulletCount,
    6
  );
  assert.equal(reviewCompletionPayload.normalization.numberedBulletCount, 6);
  assert.equal(reviewCompletionPayload.normalization.quoteLookaheadScans, 4);
  assert.equal(reviewCompletionPayload.normalization.quotedContractionCount, 256);
  assert.match(
    reviewCompletionPayload.normalization.caveatReview,
    /^1\. I can't verify current external state here without live access\. Overall verdict:/u
  );
  assert.equal(
    reviewCompletionPayload.normalization.initialsReview,
    '1. J. J. Dillon backed A.J. Styles after the U.S. title match. His decision clarified the feud.'
  );
  assert.equal(
    reviewCompletionPayload.normalization.singleInitialReview,
    '1. Bret J. Hart won cleanly. His follow-up promo advanced the feud.'
  );
  assert.match(
    reviewCompletionPayload.normalization.collapsedCaveatReview,
    /^1\. I can't verify current external state here without live access\.\n2\. Match results:/u
  );
  assert.equal(reviewCompletionPayload.policy.authoritativeBulletCount, 6);
  assert.equal(reviewCompletionPayload.policy.namedEventTokenLimit, 1_600);
  assert.equal(reviewCompletionPayload.policy.tokenLimit, 1_600);
  assert.match(
    reviewCompletionPayload.policy.responseStyleInstruction,
    /^Return exactly 6 top-level numbered bullets:/u
  );
  const compactRetryPayload = expectedNativePrPreviewResponseBody(
    compactRetryCase,
    { commitSha: COMMIT_SHA, prNumber: PR_NUMBER }
  );
  assert.deepEqual(compactRetryPayload.compactRetry.contracts, {
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
  });
  assert.equal(
    compactRetryPayload.compactRetry.productionSharedCoordinator,
    true
  );
  assert.equal(
    compactRetryPayload.compactRetry.productionSharedValidator,
    true
  );
  assert.equal(compactRetryPayload.compactRetry.syntheticAttemptCount, 2);
  const productionOutputContractsPayload =
    expectedNativePrPreviewResponseBody(productionOutputContractsCase, {
      commitSha: COMMIT_SHA,
      prNumber: PR_NUMBER,
    });
  assert.deepEqual(productionOutputContractsPayload.outputContracts.contracts, {
    atMostPresentationPreserved: true,
    completeCardHierarchyPreserved: true,
    exactPresentationPreserved: true,
    productionCapacitySelected: true,
  });
  assert.deepEqual(
    productionOutputContractsPayload.outputContracts.scenarios.exactCompact,
    {
      budgetClass: 'queued_extended',
      budgetReason: 'queued_structured_generation',
      capacityFormat: 'structured_booking',
      completeBookingContainerComponentCount: false,
      directAnswerMode: true,
      enforceParsedItemContract: true,
      explicitCompactOutputRequest: false,
      itemCount: 2,
      itemPolicyMode: 'exact',
      recoveryInstructionVerified: true,
      recoveryMode: 'compact',
      requestedOutputShapeInstructionBound: true,
      responseFormat: 'compact_direct',
      tokenCap: 6_000,
      tokenLimit: 6_000,
    }
  );
  assert.deepEqual(
    productionOutputContractsPayload.outputContracts.scenarios.completeCard,
    {
      budgetClass: 'queued_extended',
      budgetReason: 'queued_structured_generation',
      capacityFormat: 'structured_booking',
      completeBookingContainerComponentCount: true,
      directAnswerMode: true,
      enforceParsedItemContract: false,
      explicitCompactOutputRequest: false,
      itemCount: null,
      itemPolicyMode: 'preserve',
      recoveryInstructionVerified: true,
      recoveryMode: 'structured',
      requestedOutputShapeInstructionBound: false,
      responseFormat: 'structured_booking',
      tokenCap: 6_000,
      tokenLimit: 6_000,
    }
  );
  const outputAdmissionPayload = expectedNativePrPreviewResponseBody(
    outputAdmissionCase,
    { commitSha: COMMIT_SHA, prNumber: PR_NUMBER }
  );
  assert.deepEqual(outputAdmissionPayload.outputAdmission.contracts, {
    alternativeClassificationVerified: true,
    malformedFirstSuccessRejected: true,
    noFirstSuccessRetry: true,
    validFirstSuccessAccepted: true,
  });
  assert.equal(
    outputAdmissionPayload.outputAdmission.alternativeCases.length,
    8
  );
  assert.deepEqual(
    outputAdmissionPayload.outputAdmission.firstSuccess.supersession,
    {
      allCauseFreeIncomplete: true,
      allOutputContained: true,
      allRejected: true,
      caseCount: 3,
      syntheticAttemptCounts: [1, 1, 1],
      syntheticRetryCalls: [0, 0, 0],
    }
  );
  const notionSyncPhaseAPayload = expectedNativePrPreviewResponseBody(
    notionSyncPhaseACase,
    { commitSha: COMMIT_SHA, prNumber: PR_NUMBER }
  );
  assert.deepEqual(
    notionSyncPhaseAPayload.notionSyncPhaseA.capacity.cases,
    [
      { chunkCount: 2_048, readable: true, writable: true },
      { chunkCount: 2_307, readable: true, writable: true },
      { chunkCount: 4_096, readable: true, writable: true },
      { chunkCount: 4_097, readable: false, writable: false },
    ]
  );
  assert.deepEqual(notionSyncPhaseAPayload.notionSyncPhaseA.leaseFence, {
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
  });
  assert.deepEqual(
    expectedNativePrPreviewResponseBody(notionAuthorityRagCase, {
      commitSha: COMMIT_SHA,
      prNumber: PR_NUMBER,
    }),
    {
      accepted: true,
      cacheBoundaryReached: false,
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: true,
      fixture: 'notion-authority-rag-contract',
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
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      rag: {
        category: 'kayfabe',
        chunkCount: 1,
        citationCount: 1,
        promptTruncated: false,
      },
      schemaVersion: 1,
    }
  );
  const partitionFailureTelemetryPayload =
    expectedNativePrPreviewResponseBody(partitionFailureTelemetryCase, {
      commitSha: COMMIT_SHA,
      prNumber: PR_NUMBER,
    });
  assert.equal(
    partitionFailureTelemetryPayload.failureTelemetry
      .maximum.failedShardCount,
    512
  );
  assert.equal(
    partitionFailureTelemetryPayload.failureTelemetry
      .maximum.uniqueIdentityCount,
    512
  );
  assert.equal(
    partitionFailureTelemetryPayload.failureTelemetry.loggerSinkExecuted,
    false
  );
  assert.equal(
    JSON.stringify(partitionFailureTelemetryPayload).includes(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    ),
    false
  );
  assert.deepEqual(
    expectedNativePrPreviewResponseBody(continuityQueryCase, {
      commitSha: COMMIT_SHA,
      prNumber: PR_NUMBER,
    }),
    {
      accepted: true,
      actionPolicy: {
        canonicalRouteRecognized: true,
        publicReadOnlyAction: true,
        queryContinuityRecognized: true,
        tokenLimit: 900,
        trinityRunOptionsBound: true,
      },
      cacheBoundaryReached: false,
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
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      externalNetworkAttempted: false,
      fixture: 'continuity-query-contract',
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      rag: {
        category: 'kayfabe',
        chunkCount: 1,
        citationCount: 1,
        promptTruncated: false,
        sanitizationApplied: true,
        sourcePageChunkCount: 2,
      },
      schemaVersion: 1,
    }
  );
  const continuitySubtreePayload = expectedNativePrPreviewResponseBody(
    continuitySubtreeCase,
    { commitSha: COMMIT_SHA, prNumber: PR_NUMBER }
  );
  assert.deepEqual(continuitySubtreePayload.continuity.contracts, {
    completeScopeAllFixtureSourcesObserved: true,
    incompleteSubtreeCoverageRejected: true,
    pageCoverageTotalsTruthful: true,
    scopeSourcePathsBound: true,
    subtreeFieldsCoupled: true,
    subtreePageCoveragePromptBound: true,
  });
  assert.equal(
    continuitySubtreePayload.continuity.cursorCodecBoundaryReached,
    false
  );
  assert.deepEqual(
    continuitySubtreePayload.continuity.cursorPreflight,
    {
      completeScopeShapeAccepted: true,
      malformedRejected: true,
      wrongModeRejected: true,
    }
  );
  assert.deepEqual(
    continuitySubtreePayload.continuity.publicResponse.resolvedScope,
    {
      pageTitle: 'Monday Night Raw',
      pagePath: ['WWE Universe Mode', 'Brands', 'Monday Night Raw'],
      scopeKind: 'subtree',
    }
  );
  assert.deepEqual(
    continuitySubtreePayload.continuity.completeScopeProjections.first.coverage,
    {
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
    }
  );
  assert.deepEqual(
    continuitySubtreePayload.continuity.completeScopeProjections.final.coverage,
    {
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
    }
  );
  assert.equal(
    continuitySubtreePayload.continuity.completeScopeProjections.first.sourceIds
      .length,
    2
  );
  assert.equal(
    continuitySubtreePayload.continuity.completeScopeProjections.final.sourceIds
      .length,
    1
  );
  const mcpBodyCapCase = requestPlan.find(({ caseId }) =>
    caseId === 'mcp-body-cap-effective-limits'
  );
  assert.ok(mcpBodyCapCase);
  const mcpBodyCapPayload = expectedNativePrPreviewResponseBody(
    mcpBodyCapCase,
    { commitSha: COMMIT_SHA, prNumber: PR_NUMBER }
  );
  assert.equal(mcpBodyCapPayload.bodyCap.componentExecuted, true);
  assert.equal(mcpBodyCapPayload.bodyCap.caseCount, 6);
  assert.deepEqual(
    mcpBodyCapPayload.bodyCap.cases.map((entry) => ({
      accepted: entry.accepted,
      bodyBytes: entry.bodyBytes,
      effectiveLimitBytes: entry.effectiveLimitBytes,
      name: entry.name,
      statusCode: entry.statusCode,
    })),
    [
      {
        accepted: true,
        bodyBytes: 1_048_576,
        effectiveLimitBytes: 1_048_576,
        name: 'hard-maximum-exact',
        statusCode: 200,
      },
      {
        accepted: false,
        bodyBytes: 1_048_577,
        effectiveLimitBytes: 1_048_576,
        name: 'hard-maximum-over',
        statusCode: 413,
      },
      {
        accepted: true,
        bodyBytes: 524_288,
        effectiveLimitBytes: 524_288,
        name: 'mcp-configured-exact',
        statusCode: 200,
      },
      {
        accepted: false,
        bodyBytes: 524_289,
        effectiveLimitBytes: 524_288,
        name: 'mcp-configured-over',
        statusCode: 413,
      },
      {
        accepted: true,
        bodyBytes: 262_144,
        effectiveLimitBytes: 262_144,
        name: 'global-json-exact',
        statusCode: 200,
      },
      {
        accepted: false,
        bodyBytes: 262_145,
        effectiveLimitBytes: 262_144,
        name: 'global-json-over',
        statusCode: 413,
      },
    ]
  );
  const statusAuthBoundaryCase = requestPlan.find(({ caseId }) =>
    caseId === 'status-auth-before-parser'
  );
  assert.ok(statusAuthBoundaryCase);
  const statusAuthBoundaryPayload = expectedNativePrPreviewResponseBody(
    statusAuthBoundaryCase,
    { commitSha: COMMIT_SHA, prNumber: PR_NUMBER }
  );
  assert.deepEqual(statusAuthBoundaryPayload, {
    accepted: true,
    confirmationAttempted: false,
    databaseBoundaryReached: false,
    durablePersistenceAttempted: false,
    effectsBoundaryReached: false,
    filesystemBoundaryReached: false,
    fixture: 'auth-before-parser',
    identity: {
      prNumber: PR_NUMBER,
      sourceCommit: COMMIT_SHA,
    },
    memoryBoundaryReached: false,
    networkBoundaryReached: false,
    protectedEffectsEnabled: false,
    providerBoundaryReached: false,
    schemaVersion: 1,
    statusAuthBoundary: {
      authBeforeParser: true,
      bodyLimitBytes: 65_536,
      callerBodyControlsProbe: false,
      caseCount: 6,
      cases: [
        {
          bodyBytes: 65_537,
          bodyBytesRead: 0,
          boundaryNextCalls: 0,
          cacheControl: 'no-store',
          downstreamCalls: 0,
          errorCode: 'CONTROL_PLANE_AUTH_UNAVAILABLE',
          name: 'auth-unavailable-over',
          parsedPaddingLength: null,
          parserCalls: 0,
          parserNextCalls: 0,
          pragma: 'no-cache',
          statusCode: 503,
        },
        {
          bodyBytes: 65_537,
          bodyBytesRead: 0,
          boundaryNextCalls: 0,
          cacheControl: 'no-store',
          downstreamCalls: 0,
          errorCode: 'CONTROL_PLANE_AUTH_REQUIRED',
          name: 'missing-auth-over',
          parsedPaddingLength: null,
          parserCalls: 0,
          parserNextCalls: 0,
          pragma: 'no-cache',
          statusCode: 401,
        },
        {
          bodyBytes: 65_537,
          bodyBytesRead: 0,
          boundaryNextCalls: 0,
          cacheControl: 'no-store',
          downstreamCalls: 0,
          errorCode: 'CONTROL_PLANE_AUTH_REQUIRED',
          name: 'invalid-auth-over',
          parsedPaddingLength: null,
          parserCalls: 0,
          parserNextCalls: 0,
          pragma: 'no-cache',
          statusCode: 401,
        },
        {
          bodyBytes: 65_537,
          bodyBytesRead: 0,
          boundaryNextCalls: 0,
          cacheControl: 'no-store',
          downstreamCalls: 0,
          errorCode: 'CONTROL_PLANE_SCOPE_DENIED',
          name: 'read-scope-over',
          parsedPaddingLength: null,
          parserCalls: 0,
          parserNextCalls: 0,
          pragma: 'no-cache',
          statusCode: 403,
        },
        {
          bodyBytes: 65_536,
          bodyBytesRead: 65_536,
          boundaryNextCalls: 1,
          cacheControl: 'no-store',
          downstreamCalls: 1,
          errorCode: null,
          name: 'mcp-scope-exact',
          parsedPaddingLength: 65_522,
          parserCalls: 1,
          parserNextCalls: 1,
          pragma: 'no-cache',
          statusCode: 204,
        },
        {
          bodyBytes: 65_537,
          bodyBytesRead: 65_537,
          boundaryNextCalls: 1,
          cacheControl: 'no-store',
          downstreamCalls: 0,
          errorCode: 'SYSTEM_STATE_REQUEST_INVALID',
          name: 'mcp-scope-over',
          parsedPaddingLength: null,
          parserCalls: 1,
          parserNextCalls: 0,
          pragma: 'no-cache',
          statusCode: 413,
        },
      ],
      componentExecuted: true,
      downstreamCalls: 1,
      requiredScope: 'mcp:invoke',
      serverOwnedBodies: true,
    },
  });
  const selfHealApprovalCases = requestPlan.filter(({ expectedType }) =>
    expectedType === 'self-heal-approval-contract'
  );
  assert.equal(selfHealApprovalCases.length, 6);
  const selfHealApprovalPayloads = new Map(
    selfHealApprovalCases.map(requestCase => [
      requestCase.fixtureName,
      expectedNativePrPreviewResponseBody(requestCase, {
        commitSha: COMMIT_SHA,
        prNumber: PR_NUMBER,
      }),
    ])
  );
  assert.equal(
    selfHealApprovalPayloads.get('deniedOutcomes').policy
      .allReactiveEffectsDenied,
    true
  );
  assert.equal(
    selfHealApprovalPayloads.get('validCompleted').policy
      .confirmedPredictiveExecution,
    true
  );
  assert.equal(
    selfHealApprovalPayloads.get('incoherentCompleted').policy
      .allCompletedStatesRejected,
    true
  );
  assert.equal(
    selfHealApprovalPayloads.get('disabledLegacy').policy
      .legacyReactivePolicyPreserved,
    true
  );
  assert.equal(
    selfHealApprovalPayloads.get('manualIndependence').policy
      .manualAuthorityIndependent,
    true
  );
  assert.equal(
    selfHealApprovalPayloads.get('productionDebugDenial').policy
      .productionDebugDenied,
    true
  );
  const mock = buildMockFetch(requestPlan);

  const result = await runNativePrPreviewE2e({
    args: validArguments('--execute', '--allow-network'),
    expectedBackstageBookerOpenApiDocument:
      EXPECTED_BACKSTAGE_BOOKER_OPENAPI_DOCUMENT,
    fetchImpl: mock.fetchImpl,
    localGitState: LOCAL_GIT_STATE,
    monotonicNow: mock.monotonicNow,
  });

  assert.equal(result.executed, true);
  assert.equal(result.networkAttempted, true);
  assert.equal(result.summary.status, 'PASS');
  assert.equal(result.summary.requestsMade, 136);
  assert.equal(result.summary.simulatedAuthRequests, 23);
  assert.equal(result.checks.length, 136);
  assert.equal(
    result.checks.filter(({ simulatedAuth }) => simulatedAuth).length,
    23
  );
  assert.equal(mock.requestCount, 136);
  const backstageBookerOpenApiCheck = result.checks.find(({ caseId }) =>
    caseId === 'web-backstage-booker-openapi'
  );
  assert.deepEqual(backstageBookerOpenApiCheck, {
    backstageBookerOpenApiVerified: true,
    bodySha256: backstageBookerOpenApiCheck.bodySha256,
    caseId: 'web-backstage-booker-openapi',
    httpStatus: 200,
    method: 'GET',
    pathTemplate: '/contracts/backstage_booker.openapi.v1.json',
    responseBytes: Buffer.byteLength(JSON.stringify(
      NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageBookerOpenApi.document
    )),
    role: 'web',
    simulatedAuth: false,
  });
  assert.deepEqual(
    result.checks.find(({ caseId }) =>
      caseId === 'status-auth-before-parser'
    ),
    {
      bodySha256: result.checks.find(({ caseId }) =>
        caseId === 'status-auth-before-parser'
      ).bodySha256,
      caseId: 'status-auth-before-parser',
      httpStatus: 200,
      method: 'POST',
      pathTemplate: '/status/auth-before-parser-contract',
      responseBytes: Buffer.byteLength(JSON.stringify(
        statusAuthBoundaryPayload
      )),
      role: 'web',
      simulatedAuth: true,
      statusAuthBoundaryVerified: true,
    }
  );
  const managedAsyncContinuationCheck = result.checks.find(({ caseId }) =>
    caseId === 'backstage-generation-managed-async-continuation'
  );
  assert.deepEqual(managedAsyncContinuationCheck, {
    bodySha256: managedAsyncContinuationCheck.bodySha256,
    caseId: 'backstage-generation-managed-async-continuation',
    clearPolicyVersionVerified: true,
    httpStatus: 200,
    managedAsyncContinuationVerified: true,
    method: 'POST',
    pathTemplate: '/backstage/generation-contract',
    responseBytes: Buffer.byteLength(JSON.stringify(
      expectedNativePrPreviewResponseBody(managedAsyncContinuationCase, {
        commitSha: COMMIT_SHA,
        prNumber: PR_NUMBER,
      })
    )),
    role: 'web',
    simulatedAuth: true,
  });
  const gptClientIdentityCheck = result.checks.find(({ caseId }) =>
    caseId === 'backstage-generation-gpt-client-identity'
  );
  assert.deepEqual(gptClientIdentityCheck, {
    bodySha256: gptClientIdentityCheck.bodySha256,
    caseId: 'backstage-generation-gpt-client-identity',
    clearPolicyVersionVerified: true,
    gptClientIdentityVerified: true,
    httpStatus: 200,
    method: 'POST',
    pathTemplate: '/backstage/generation-contract',
    responseBytes: Buffer.byteLength(JSON.stringify(
      expectedNativePrPreviewResponseBody(gptClientIdentityCase, {
        commitSha: COMMIT_SHA,
        prNumber: PR_NUMBER,
      })
    )),
    role: 'web',
    simulatedAuth: true,
  });
  const productionOutputContractsCheck = result.checks.find(({ caseId }) =>
    caseId === 'backstage-generation-production-output-contracts'
  );
  assert.deepEqual(productionOutputContractsCheck, {
    bodySha256: productionOutputContractsCheck.bodySha256,
    caseId: 'backstage-generation-production-output-contracts',
    clearPolicyVersionVerified: true,
    httpStatus: 200,
    method: 'POST',
    outputCapacityPresentationVerified: true,
    pathTemplate: '/backstage/generation-contract',
    responseBytes: Buffer.byteLength(JSON.stringify(
      productionOutputContractsPayload
    )),
    role: 'web',
    simulatedAuth: false,
  });
  const outputAdmissionCheck = result.checks.find(({ caseId }) =>
    caseId === 'backstage-generation-output-admission'
  );
  assert.deepEqual(outputAdmissionCheck, {
    bodySha256: outputAdmissionCheck.bodySha256,
    caseId: 'backstage-generation-output-admission',
    clearPolicyVersionVerified: true,
    httpStatus: 200,
    method: 'POST',
    outputAdmissionVerified: true,
    pathTemplate: '/backstage/generation-contract',
    responseBytes: Buffer.byteLength(JSON.stringify(outputAdmissionPayload)),
    role: 'web',
    simulatedAuth: false,
  });
  const notionSyncPhaseACheck = result.checks.find(({ caseId }) =>
    caseId === 'backstage-generation-notion-sync-phase-a'
  );
  assert.deepEqual(notionSyncPhaseACheck, {
    bodySha256: notionSyncPhaseACheck.bodySha256,
    caseId: 'backstage-generation-notion-sync-phase-a',
    clearPolicyVersionVerified: true,
    httpStatus: 200,
    method: 'POST',
    notionSyncPhaseAVerified: true,
    pathTemplate: '/backstage/generation-contract',
    responseBytes: Buffer.byteLength(JSON.stringify(notionSyncPhaseAPayload)),
    role: 'web',
    simulatedAuth: false,
  });
  assert.deepEqual(
    result.checks.find(({ caseId }) =>
      caseId === 'backstage-generation-route-budget'
    ),
    {
      bodySha256: result.checks.find(({ caseId }) =>
        caseId === 'backstage-generation-route-budget'
      ).bodySha256,
      caseId: 'backstage-generation-route-budget',
      clearPolicyVersionVerified: true,
      httpStatus: 200,
      method: 'POST',
      minimumResponseMs: 13_000,
      minimumResponseMsVerified: true,
      pathTemplate: '/backstage/generation-contract',
      queueWaitPolicyVerified: true,
      trinityReasoningPolicyVerified: true,
      responseBytes: Buffer.byteLength(JSON.stringify(
        expectedNativePrPreviewResponseBody(routeBudgetCase, {
          commitSha: COMMIT_SHA,
          prNumber: PR_NUMBER,
        })
      )),
      role: 'web',
      simulatedAuth: false,
    }
  );
  const partitionProofCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-generation-notion-authority-rag'
  );
  assert.ok(partitionProofCase);
  assert.deepEqual(
    result.checks.find(({ caseId }) =>
      caseId === 'backstage-generation-notion-authority-rag'
    ),
    {
      bodySha256: result.checks.find(({ caseId }) =>
        caseId === 'backstage-generation-notion-authority-rag'
      ).bodySha256,
      caseId: 'backstage-generation-notion-authority-rag',
      clearPolicyVersionVerified: true,
      httpStatus: 200,
      method: 'POST',
      partitionCutoverRepairVerified: true,
      partitionedAuthorityVerified: true,
      pathTemplate: '/backstage/generation-contract',
      responseBytes: Buffer.byteLength(JSON.stringify(
        expectedNativePrPreviewResponseBody(partitionProofCase, {
          commitSha: COMMIT_SHA,
          prNumber: PR_NUMBER,
        })
      )),
      role: 'web',
      simulatedAuth: false,
    }
  );
  const telemetryProofCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-generation-partition-failure-telemetry'
  );
  assert.ok(telemetryProofCase);
  assert.deepEqual(
    result.checks.find(({ caseId }) =>
      caseId === 'backstage-generation-partition-failure-telemetry'
    ),
    {
      bodySha256: result.checks.find(({ caseId }) =>
        caseId === 'backstage-generation-partition-failure-telemetry'
      ).bodySha256,
      caseId: 'backstage-generation-partition-failure-telemetry',
      clearPolicyVersionVerified: true,
      failedShardTelemetryVerified: true,
      httpStatus: 200,
      method: 'POST',
      pathTemplate: '/backstage/generation-contract',
      responseBytes: Buffer.byteLength(JSON.stringify(
        expectedNativePrPreviewResponseBody(telemetryProofCase, {
          commitSha: COMMIT_SHA,
          prNumber: PR_NUMBER,
        })
      )),
      role: 'web',
      simulatedAuth: false,
    }
  );
  const researchCalls = mock.calls.filter(({ url }) =>
    url.endsWith('/research/contract')
  );
  assert.equal(researchCalls.length, 12);
  assert.equal(
    researchCalls.filter(({ url }) => url.startsWith(WEB_BASE_URL)).length,
    11
  );
  assert.equal(
    researchCalls.filter(({ url }) => url.startsWith(WORKER_BASE_URL)).length,
    1
  );
  for (const { init } of researchCalls) {
    assert.deepEqual(Object.keys(JSON.parse(init.body)), ['fixture']);
    assert.equal(init.body.includes('https://'), false);
    assert.equal(
      /authorization|cookie|credential|secret|session|token/iu.test(init.body),
      false
    );
  }
  const backstageStorylineCalls = mock.calls.filter(({ url }) =>
    url.endsWith('/backstage/storyline-contract')
  );
  assert.equal(backstageStorylineCalls.length, 7);
  assert.equal(
    backstageStorylineCalls.filter(({ url }) =>
      url.startsWith(WEB_BASE_URL)
    ).length,
    6
  );
  assert.equal(
    backstageStorylineCalls.filter(({ url }) =>
      url.startsWith(WORKER_BASE_URL)
    ).length,
    1
  );
  for (const { init } of backstageStorylineCalls) {
    assert.deepEqual(Object.keys(JSON.parse(init.body)), ['fixture']);
    assert.equal(init.body.includes('https://'), false);
    assert.equal(
      /authorization|cookie|credential|secret|session|token/iu.test(init.body),
      false
    );
  }
  const backstageGenerationCalls = mock.calls.filter(({ url }) =>
    url.endsWith('/backstage/generation-contract')
  );
  assert.equal(backstageGenerationCalls.length, 14);
  assert.equal(
    backstageGenerationCalls.filter(({ url }) =>
      url.startsWith(WEB_BASE_URL)
    ).length,
    13
  );
  assert.equal(
    backstageGenerationCalls.filter(({ url }) =>
      url.startsWith(WORKER_BASE_URL)
    ).length,
    1
  );
  for (const { init } of backstageGenerationCalls) {
    assert.deepEqual(Object.keys(JSON.parse(init.body)), ['fixture']);
    assert.equal(init.body.includes('https://'), false);
    assert.equal(
      /authorization|cookie|credential|secret|session|token/iu.test(init.body),
      false
    );
  }
  const mcpBodyCapCalls = mock.calls.filter(({ url }) =>
    url.endsWith('/mcp/body-cap-contract')
  );
  assert.equal(mcpBodyCapCalls.length, 2);
  assert.equal(
    mcpBodyCapCalls.filter(({ url }) => url.startsWith(WEB_BASE_URL)).length,
    1
  );
  assert.equal(
    mcpBodyCapCalls.filter(({ url }) => url.startsWith(WORKER_BASE_URL)).length,
    1
  );
  for (const { init } of mcpBodyCapCalls) {
    assert.deepEqual(Object.keys(JSON.parse(init.body)), ['fixture']);
    assert.equal(init.body.includes('https://'), false);
    assert.equal(
      /authorization|cookie|credential|secret|session|token/iu.test(init.body),
      false
    );
  }
  const dispatchGptIdentifierCalls = mock.calls.filter(({ url }) =>
    url.endsWith('/dispatch/gpt-identifier-contract')
  );
  assert.equal(dispatchGptIdentifierCalls.length, 3);
  assert.equal(
    dispatchGptIdentifierCalls.filter(({ url }) =>
      url.startsWith(WEB_BASE_URL)
    ).length,
    2
  );
  assert.equal(
    dispatchGptIdentifierCalls.filter(({ url }) =>
      url.startsWith(WORKER_BASE_URL)
    ).length,
    1
  );
  for (const { init } of dispatchGptIdentifierCalls) {
    assert.deepEqual(Object.keys(JSON.parse(init.body)), ['fixture']);
    assert.equal(
      init.body.includes(
        NATIVE_PR_PREVIEW_E2E_CONTRACT.dispatchGptIdentifier.actionMarker
      ),
      false
    );
    assert.equal(
      /authorization|cookie|credential|secret|session|token/iu.test(init.body),
      false
    );
  }
  const statusAuthBoundaryCalls = mock.calls.filter(({ url }) =>
    url.endsWith('/status/auth-before-parser-contract')
  );
  assert.equal(statusAuthBoundaryCalls.length, 2);
  assert.equal(
    statusAuthBoundaryCalls.filter(({ url }) =>
      url.startsWith(WEB_BASE_URL)
    ).length,
    1
  );
  assert.equal(
    statusAuthBoundaryCalls.filter(({ url }) =>
      url.startsWith(WORKER_BASE_URL)
    ).length,
    1
  );
  for (const { init } of statusAuthBoundaryCalls) {
    assert.deepEqual(JSON.parse(init.body), {
      fixture: 'auth-before-parser',
    });
    assert.equal(
      /authorization|cookie|credential|secret|session|token/iu.test(init.body),
      false
    );
  }
  const selfHealApprovalCalls = mock.calls.filter(({ url }) =>
    url.endsWith('/self-heal/approval-contract')
  );
  assert.equal(selfHealApprovalCalls.length, 7);
  assert.equal(
    selfHealApprovalCalls.filter(({ url }) => url.startsWith(WEB_BASE_URL)).length,
    6
  );
  assert.equal(
    selfHealApprovalCalls.filter(({ url }) => url.startsWith(WORKER_BASE_URL)).length,
    1
  );
  for (const { init } of selfHealApprovalCalls) {
    assert.deepEqual(Object.keys(JSON.parse(init.body)), ['fixture']);
    assert.equal(
      /authorization|cookie|credential|secret|session|token/iu.test(init.body),
      false
    );
  }
  const simulatedSourceCalls = mock.calls.filter(({ init }) =>
    init.headers[
      NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtureHeader
    ] !== undefined
  );
  assert.equal(simulatedSourceCalls.length, 20);
  for (const { init, url } of simulatedSourceCalls) {
    assert.equal(init.headers.authorization, undefined);
    assert.equal(init.headers.cookie, undefined);
    assert.equal(url.startsWith(WEB_BASE_URL), true);
    if (typeof init.body === 'string' && init.body.includes('sourceUrls')) {
      assert.equal(
        init.body.includes('https://example.invalid/palworld/guide'),
        true
      );
    }
  }
  const unauthenticatedParserBoundaryCalls = mock.calls.filter(({ url }) =>
    url.endsWith(
      NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.ingestionPath
    )
  ).filter(({ init }) =>
    init.headers[
      NATIVE_PR_PREVIEW_E2E_CONTRACT.gamingSources.fixtureHeader
    ] === undefined
    && (init.body === '{"action":' || init.body === 'x'.repeat(16_385))
  );
  assert.equal(unauthenticatedParserBoundaryCalls.length, 2);
  assert.equal(
    unauthenticatedParserBoundaryCalls.every(({ init }) =>
      init.headers.authorization === undefined
      && init.headers.cookie === undefined
    ),
    true
  );
  assert.equal(
    mock.calls.some(({ init }) =>
      Object.keys(init.headers).some((headerName) =>
        /authorization|cookie|session|token|secret/iu.test(headerName)
      )
    ),
    false
  );
});

test('pins the emitted preview imports to the built request-abort runtime', () => {
  const [applicationContract, drainContract] =
    NATIVE_PR_PREVIEW_DIST_IMPORT_CONTRACT;
  const applicationSource = [
    'import {',
    '  getRequestAbortContext,',
    '  runWithRequestAbortTimeout,',
    `} from '${applicationContract.specifier}';`,
  ].join('\n');
  const drainSource = [
    'import {',
    '  createAbortError,',
    '  createLinkedAbortController,',
    '  runWithRequestAbortContext,',
    `} from '${drainContract.specifier}';`,
  ].join('\n');

  assert.deepEqual(
    findNativePrPreviewDistImportSourceViolations(
      applicationContract,
      applicationSource
    ),
    []
  );
  assert.deepEqual(
    findNativePrPreviewDistImportSourceViolations(
      drainContract,
      drainSource
    ),
    []
  );
  assert.deepEqual(
    findNativePrPreviewDistImportSourceViolations(
      applicationContract,
      applicationSource.replace('requestAbort.js', 'unreviewed.js')
    ),
    [
      `${applicationContract.filePath}: runtime package import must target ${applicationContract.specifier}`,
    ]
  );
  assert.deepEqual(
    findNativePrPreviewDistImportSourceViolations(
      applicationContract,
      applicationSource.replace(
        'runWithRequestAbortTimeout,',
        'runWithRequestAbortTimeout, createAbortError,'
      )
    ),
    [
      `${applicationContract.filePath}: runtime package import bindings must match the reviewed surface`,
    ]
  );
});

test('rejects a cancellation proof that returns before its drain window', async () => {
  const requestPlan = buildNativePrPreviewRequestPlan();
  const mock = buildMockFetch(requestPlan, (requestCase) => {
    if (requestCase.caseId !== 'research-workflow-cancellation-drain') {
      return undefined;
    }
    const body = responseBodyForCase(requestCase);
    const response = new Response(body, {
      headers: responseHeadersForCase(
        requestCase,
        Buffer.byteLength(body)
      ),
      status: requestCase.expectedStatus,
    });
    Object.defineProperty(response, 'url', {
      value: `${WEB_BASE_URL}${requestCase.path}`,
    });
    return response;
  });

  await assert.rejects(
    runNativePrPreviewE2e({
      args: validArguments('--execute', '--allow-network'),
      expectedBackstageBookerOpenApiDocument:
        EXPECTED_BACKSTAGE_BOOKER_OPENAPI_DOCUMENT,
      fetchImpl: mock.fetchImpl,
      localGitState: LOCAL_GIT_STATE,
      monotonicNow: mock.monotonicNow,
    }),
    (error) =>
      error instanceof NativePrPreviewE2eError
      && error.code === 'NATIVE_PR_PREVIEW_CANCELLATION_DRAIN_TOO_EARLY'
      && error.caseId === 'research-workflow-cancellation-drain'
  );
});

test('rejects a Backstage generation proof that returns before the former direct-answer boundary', async () => {
  const requestPlan = buildNativePrPreviewRequestPlan();
  const mock = buildMockFetch(requestPlan, (requestCase) => {
    if (requestCase.caseId !== 'backstage-generation-route-budget') {
      return undefined;
    }
    const body = responseBodyForCase(requestCase);
    const response = new Response(body, {
      headers: responseHeadersForCase(
        requestCase,
        Buffer.byteLength(body)
      ),
      status: requestCase.expectedStatus,
    });
    Object.defineProperty(response, 'url', {
      value: `${WEB_BASE_URL}${requestCase.path}`,
    });
    return response;
  });

  await assert.rejects(
    runNativePrPreviewE2e({
      args: validArguments('--execute', '--allow-network'),
      expectedBackstageBookerOpenApiDocument:
        EXPECTED_BACKSTAGE_BOOKER_OPENAPI_DOCUMENT,
      fetchImpl: mock.fetchImpl,
      localGitState: LOCAL_GIT_STATE,
      monotonicNow: mock.monotonicNow,
    }),
    (error) =>
      error instanceof NativePrPreviewE2eError
      && error.code === 'NATIVE_PR_PREVIEW_BACKSTAGE_GENERATION_TOO_EARLY'
      && error.caseId === 'backstage-generation-route-budget'
  );
});

test('rejects Backstage Booker contract semantic drift at the deployed endpoint', async () => {
  const mutationCases = [
    [
      'version',
      (document) => {
        document.info.version = '1.5.0';
      },
    ],
    [
      'managed result path',
      (document) => {
        delete document.paths[
          '/gpt-access/capabilities/v1/backstage-booker/jobs/{jobId}/result'
        ];
      },
    ],
    [
      'managed bearer security',
      (document) => {
        document.paths[
          '/gpt-access/capabilities/v1/backstage-booker/jobs/{jobId}/result'
        ].get.security = [];
      },
    ],
    [
      'managed job identifier format',
      (document) => {
        document.paths[
          '/gpt-access/capabilities/v1/backstage-booker/jobs/{jobId}/result'
        ].get.parameters[0].schema.format = 'opaque';
      },
    ],
    [
      'managed wait bounds',
      (document) => {
        document.paths[
          '/gpt-access/capabilities/v1/backstage-booker/jobs/{jobId}/result'
        ].get.parameters[1].schema.maximum = 60_000;
      },
    ],
    [
      'legacy result path',
      (document) => {
        document.paths['/jobs/{jobId}/result'] = { get: {} };
      },
    ],
    [
      'legacy job token',
      (document) => {
        document.jobReadToken = 'forbidden';
      },
    ],
    [
      'legacy job token header',
      (document) => {
        document.jobReadTokenHeader = 'forbidden';
      },
    ],
    [
      'legacy stream field',
      (document) => {
        document.stream = true;
      },
    ],
  ];

  for (const [name, mutate] of mutationCases) {
    const requestPlan = buildNativePrPreviewRequestPlan();
    const mock = buildMockFetch(requestPlan, (requestCase) => {
      if (requestCase.caseId !== 'web-backstage-booker-openapi') {
        return undefined;
      }
      const document = structuredClone(
        NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageBookerOpenApi.document
      );
      mutate(document);
      const body = JSON.stringify(document);
      const response = new Response(body, {
        headers: responseHeadersForCase(
          requestCase,
          Buffer.byteLength(body)
        ),
        status: requestCase.expectedStatus,
      });
      Object.defineProperty(response, 'url', {
        value: `${WEB_BASE_URL}${requestCase.path}`,
      });
      return response;
    });

    await assert.rejects(
      runNativePrPreviewE2e({
        args: validArguments('--execute', '--allow-network'),
        expectedBackstageBookerOpenApiDocument:
          EXPECTED_BACKSTAGE_BOOKER_OPENAPI_DOCUMENT,
        fetchImpl: mock.fetchImpl,
        localGitState: LOCAL_GIT_STATE,
        monotonicNow: mock.monotonicNow,
      }),
      (error) =>
        error instanceof NativePrPreviewE2eError
        && error.code === 'NATIVE_PR_PREVIEW_BACKSTAGE_BOOKER_OPENAPI_INVALID'
        && error.caseId === 'web-backstage-booker-openapi',
      name
    );
  }
});

test('rejects extra response fields and an incorrect media type', async () => {
  const requestPlan = buildNativePrPreviewRequestPlan();
  const bodyMismatchMock = buildMockFetch(
    requestPlan,
    (requestCase, _requestIndex) => {
      if (requestCase.caseId !== 'completed-status') {
        return undefined;
      }
      const expectedBody = expectedNativePrPreviewResponseBody(
        requestCase,
        { commitSha: COMMIT_SHA, prNumber: PR_NUMBER }
      );
      const body = JSON.stringify({
        ...expectedBody,
        unexpected: true,
      });
      const response = new Response(body, {
        headers: responseHeadersForCase(
          requestCase,
          Buffer.byteLength(body)
        ),
        status: requestCase.expectedStatus,
      });
      Object.defineProperty(response, 'url', {
        value: `${WEB_BASE_URL}${requestCase.path}`,
      });
      return response;
    }
  );
  await assert.rejects(
    runNativePrPreviewE2e({
      args: validArguments('--execute', '--allow-network'),
      expectedBackstageBookerOpenApiDocument:
        EXPECTED_BACKSTAGE_BOOKER_OPENAPI_DOCUMENT,
      fetchImpl: bodyMismatchMock.fetchImpl,
      localGitState: LOCAL_GIT_STATE,
      monotonicNow: bodyMismatchMock.monotonicNow,
    }),
    (error) =>
      error instanceof NativePrPreviewE2eError
      && error.code === 'NATIVE_PR_PREVIEW_BODY_MISMATCH'
      && error.caseId === 'completed-status'
  );

  const contentTypeMock = buildMockFetch(
    requestPlan,
    (requestCase) => {
      if (requestCase.caseId !== 'web-readiness-initial') {
        return undefined;
      }
      const body = JSON.stringify(expectedNativePrPreviewResponseBody(
        requestCase,
        { commitSha: COMMIT_SHA, prNumber: PR_NUMBER }
      ));
      const response = new Response(body, {
        headers: responseHeadersForCase(
          requestCase,
          Buffer.byteLength(body),
          { 'content-type': 'text/plain; charset=utf-8' }
        ),
        status: requestCase.expectedStatus,
      });
      Object.defineProperty(response, 'url', {
        value: `${WEB_BASE_URL}${requestCase.path}`,
      });
      return response;
    }
  );
  await assert.rejects(
    runNativePrPreviewE2e({
      args: validArguments('--execute', '--allow-network'),
      expectedBackstageBookerOpenApiDocument:
        EXPECTED_BACKSTAGE_BOOKER_OPENAPI_DOCUMENT,
      fetchImpl: contentTypeMock.fetchImpl,
      localGitState: LOCAL_GIT_STATE,
      monotonicNow: contentTypeMock.monotonicNow,
    }),
    (error) =>
      error instanceof NativePrPreviewE2eError
      && error.code === 'NATIVE_PR_PREVIEW_CONTENT_TYPE_INVALID'
      && error.caseId === 'web-readiness-initial'
  );
});

test('rejects missing synthetic provenance and correlation or security header drift', async () => {
  const requestPlan = buildNativePrPreviewRequestPlan();
  const cases = [
    {
      caseId: 'gaming-canary-success',
      code: 'NATIVE_PR_PREVIEW_SYNTHETIC_MARKER_MISSING',
      mutate(headers) {
        delete headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.syntheticResponseHeader.name
        ];
      },
    },
    {
      caseId: 'self-heal-approval-denied-outcomes',
      code: 'NATIVE_PR_PREVIEW_SYNTHETIC_MARKER_MISSING',
      mutate(headers) {
        delete headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.syntheticResponseHeader.name
        ];
      },
    },
    {
      caseId: 'backstage-saved-storyline-projection',
      code: 'NATIVE_PR_PREVIEW_SYNTHETIC_MARKER_MISSING',
      mutate(headers) {
        delete headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.syntheticResponseHeader.name
        ];
      },
    },
    {
      caseId: 'backstage-generation-route-budget',
      code: 'NATIVE_PR_PREVIEW_BACKSTAGE_QUEUE_WAIT_POLICY_PROOF_INVALID',
      mutate(headers) {
        delete headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .queueWaitPolicyVersion
        ];
      },
    },
    {
      caseId: 'backstage-generation-route-budget',
      code: 'NATIVE_PR_PREVIEW_BACKSTAGE_QUEUE_WAIT_POLICY_PROOF_INVALID',
      mutate(headers) {
        headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .queueWaitPolicyVersion
        ] = 'backstage-booker-queue-wait-policy/drifted';
      },
    },
    {
      caseId: 'backstage-generation-route-budget',
      code: 'NATIVE_PR_PREVIEW_TRINITY_REASONING_POLICY_PROOF_INVALID',
      mutate(headers) {
        delete headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .trinityReasoningPolicyVersion
        ];
      },
    },
    {
      caseId: 'backstage-generation-route-budget',
      code: 'NATIVE_PR_PREVIEW_TRINITY_REASONING_POLICY_PROOF_INVALID',
      mutate(headers) {
        headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .trinityReasoningPolicyVersion
        ] = 'trinity-reasoning-provider-policy/drifted';
      },
    },
    {
      caseId: 'backstage-generation-review-completion',
      code: 'NATIVE_PR_PREVIEW_BACKSTAGE_CLEAR_POLICY_PROOF_INVALID',
      mutate(headers) {
        delete headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .clearPolicyVersion
        ];
      },
    },
    {
      caseId: 'backstage-generation-compact-retry',
      code: 'NATIVE_PR_PREVIEW_BACKSTAGE_CLEAR_POLICY_PROOF_INVALID',
      mutate(headers) {
        headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .clearPolicyVersion
        ] = 'backstage-booker-clear-generation/drifted';
      },
    },
    {
      caseId: 'backstage-generation-compact-retry',
      code:
        'NATIVE_PR_PREVIEW_BACKSTAGE_OUTPUT_CAPACITY_PRESENTATION_PROOF_INVALID',
      mutate(headers) {
        delete headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .outputCapacityPresentationVersion
        ];
      },
    },
    {
      caseId: 'backstage-generation-production-output-contracts',
      code:
        'NATIVE_PR_PREVIEW_BACKSTAGE_OUTPUT_CAPACITY_PRESENTATION_PROOF_INVALID',
      mutate(headers) {
        headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .outputCapacityPresentationVersion
        ] = 'backstage-booker-output-capacity-presentation/drifted';
      },
    },
    {
      caseId: 'backstage-generation-output-admission',
      code: 'NATIVE_PR_PREVIEW_BACKSTAGE_OUTPUT_ADMISSION_PROOF_INVALID',
      mutate(headers) {
        delete headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .outputAdmissionVersion
        ];
      },
    },
    {
      caseId: 'backstage-generation-output-admission',
      code: 'NATIVE_PR_PREVIEW_BACKSTAGE_OUTPUT_ADMISSION_PROOF_INVALID',
      mutate(headers) {
        headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .outputAdmissionVersion
        ] = 'backstage-booker-output-admission/drifted';
      },
    },
    {
      caseId: 'backstage-generation-notion-sync-phase-a',
      code:
        'NATIVE_PR_PREVIEW_BACKSTAGE_NOTION_SYNC_PHASE_A_PROOF_INVALID',
      mutate(headers) {
        delete headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .notionSyncPhaseAVersion
        ];
      },
    },
    {
      caseId: 'backstage-generation-notion-sync-phase-a',
      code:
        'NATIVE_PR_PREVIEW_BACKSTAGE_NOTION_SYNC_PHASE_A_PROOF_INVALID',
      mutate(headers) {
        headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .notionSyncPhaseAVersion
        ] = 'backstage-notion-sync-phase-a/drifted';
      },
    },
    {
      caseId: 'backstage-generation-notion-authority-rag',
      code: 'NATIVE_PR_PREVIEW_BACKSTAGE_PARTITION_PROOF_INVALID',
      mutate(headers) {
        delete headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .partitionedAuthorityVersion
        ];
      },
    },
    {
      caseId: 'backstage-generation-notion-authority-rag',
      code: 'NATIVE_PR_PREVIEW_BACKSTAGE_PARTITION_PROOF_INVALID',
      mutate(headers) {
        headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .partitionedAuthorityVersion
        ] = 'backstage-notion-partitioned-authority/drifted';
      },
    },
    {
      caseId: 'backstage-generation-notion-authority-rag',
      code:
        'NATIVE_PR_PREVIEW_BACKSTAGE_PARTITION_CUTOVER_REPAIR_PROOF_INVALID',
      mutate(headers) {
        delete headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .partitionCutoverRepairVersion
        ];
      },
    },
    {
      caseId: 'backstage-generation-notion-authority-rag',
      code:
        'NATIVE_PR_PREVIEW_BACKSTAGE_PARTITION_CUTOVER_REPAIR_PROOF_INVALID',
      mutate(headers) {
        headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .partitionCutoverRepairVersion
        ] = 'backstage-notion-partition-cutover-repair/drifted';
      },
    },
    {
      caseId: 'backstage-generation-partition-failure-telemetry',
      code:
        'NATIVE_PR_PREVIEW_BACKSTAGE_PARTITION_FAILURE_TELEMETRY_PROOF_INVALID',
      mutate(headers) {
        delete headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .partitionFailureTelemetryVersion
        ];
      },
    },
    {
      caseId: 'backstage-generation-managed-async-continuation',
      code: 'NATIVE_PR_PREVIEW_BACKSTAGE_MANAGED_ASYNC_PROOF_INVALID',
      mutate(headers) {
        delete headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .managedAsyncContinuationVersion
        ];
      },
    },
    {
      caseId: 'backstage-generation-gpt-client-identity',
      code: 'NATIVE_PR_PREVIEW_BACKSTAGE_GPT_CLIENT_IDENTITY_PROOF_INVALID',
      mutate(headers) {
        delete headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .gptClientIdentityVersion
        ];
      },
    },
    {
      caseId: 'backstage-generation-gpt-client-identity',
      code: 'NATIVE_PR_PREVIEW_BACKSTAGE_GPT_CLIENT_IDENTITY_PROOF_INVALID',
      mutate(headers) {
        headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .gptClientIdentityVersion
        ] = 'backstage-booker-gpt-client-identity/drifted';
      },
    },
    {
      caseId: 'backstage-generation-managed-async-continuation',
      code: 'NATIVE_PR_PREVIEW_BACKSTAGE_MANAGED_ASYNC_PROOF_INVALID',
      mutate(headers) {
        headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.proofHeaders
            .managedAsyncContinuationVersion
        ] = 'backstage-booker-managed-async-continuation/drifted';
      },
    },
    {
      caseId: 'dispatch-gpt-identifier-oversized',
      code: 'NATIVE_PR_PREVIEW_SYNTHETIC_MARKER_MISSING',
      mutate(headers) {
        delete headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.syntheticResponseHeader.name
        ];
      },
    },
    {
      caseId: 'dispatch-gpt-identifier-oversized',
      code: 'NATIVE_PR_PREVIEW_NO_CACHE_MISSING',
      mutate(headers) {
        delete headers.pragma;
      },
    },
    {
      caseId: 'dispatch-gpt-identifier-oversized',
      code: 'NATIVE_PR_PREVIEW_DISPATCH_GPT_IDENTIFIER_PROOF_INVALID',
      mutate(headers) {
        delete headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.dispatchGptIdentifier.proofHeaders
            .nextCalls
        ];
      },
    },
    {
      caseId: 'status-auth-before-parser',
      code: 'NATIVE_PR_PREVIEW_SYNTHETIC_MARKER_MISSING',
      mutate(headers) {
        delete headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.syntheticResponseHeader.name
        ];
      },
    },
    {
      caseId: 'status-auth-before-parser',
      code: 'NATIVE_PR_PREVIEW_NO_CACHE_MISSING',
      mutate(headers) {
        delete headers.pragma;
      },
    },
    {
      caseId: 'status-auth-before-parser',
      code: 'NATIVE_PR_PREVIEW_STATUS_AUTH_BOUNDARY_PROOF_INVALID',
      mutate(headers) {
        delete headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.statusAuthBoundary.proofHeaders
            .downstreamCalls
        ];
      },
    },
    {
      caseId: 'status-auth-before-parser',
      code: 'NATIVE_PR_PREVIEW_STATUS_AUTH_BOUNDARY_PROOF_INVALID',
      mutate(headers) {
        headers[
          NATIVE_PR_PREVIEW_E2E_CONTRACT.statusAuthBoundary.proofHeaders
            .authBeforeParser
        ] = 'false';
      },
    },
    {
      caseId: 'web-readiness-initial',
      code: 'NATIVE_PR_PREVIEW_CORRELATION_INVALID',
      mutate(headers) {
        headers['x-request-id'] = 'wrong-request-id';
      },
    },
    {
      caseId: 'web-readiness-initial',
      code: 'NATIVE_PR_PREVIEW_SECURITY_HEADERS_INVALID',
      mutate(headers) {
        delete headers['x-frame-options'];
      },
    },
    {
      caseId: 'gaming-source-ingestion-unauthorized',
      code: 'NATIVE_PR_PREVIEW_NO_CACHE_MISSING',
      mutate(headers) {
        delete headers.pragma;
      },
    },
  ];

  for (const testCase of cases) {
    const mock = buildMockFetch(requestPlan, (requestCase) => {
      if (requestCase.caseId !== testCase.caseId) {
        return undefined;
      }
      const body = responseBodyForCase(requestCase);
      const headers = responseHeadersForCase(
        requestCase,
        Buffer.byteLength(body ?? '')
      );
      testCase.mutate(headers);
      const response = new Response(body, {
        headers,
        status: requestCase.expectedStatus,
      });
      Object.defineProperty(response, 'url', {
        value: `${WEB_BASE_URL}${requestCase.path}`,
      });
      return response;
    });

    await assert.rejects(
      runNativePrPreviewE2e({
        args: validArguments('--execute', '--allow-network'),
        expectedBackstageBookerOpenApiDocument:
          EXPECTED_BACKSTAGE_BOOKER_OPENAPI_DOCUMENT,
        fetchImpl: mock.fetchImpl,
        localGitState: LOCAL_GIT_STATE,
        monotonicNow: mock.monotonicNow,
      }),
      (error) =>
        error instanceof NativePrPreviewE2eError
        && error.code === testCase.code
        && error.caseId === testCase.caseId
    );
  }
});

test('rejects a padded Backstage generation response beyond the contained app ceiling', async () => {
  const requestPlan = buildNativePrPreviewRequestPlan();
  const caseId = 'backstage-generation-output-admission';
  const mock = buildMockFetch(requestPlan, (requestCase) => {
    if (requestCase.caseId !== caseId) {
      return undefined;
    }
    const exactBody = responseBodyForCase(requestCase);
    const paddingLength =
      NATIVE_PR_PREVIEW_E2E_CONTRACT.backstageGeneration.maxResponseBytes
      - Buffer.byteLength(exactBody)
      + 1;
    const body = `${exactBody}${' '.repeat(paddingLength)}`;
    const response = new Response(body, {
      headers: responseHeadersForCase(requestCase, Buffer.byteLength(body)),
      status: requestCase.expectedStatus,
    });
    Object.defineProperty(response, 'url', {
      value: `${WEB_BASE_URL}${requestCase.path}`,
    });
    return response;
  });

  await assert.rejects(
    runNativePrPreviewE2e({
      args: validArguments('--execute', '--allow-network'),
      expectedBackstageBookerOpenApiDocument:
        EXPECTED_BACKSTAGE_BOOKER_OPENAPI_DOCUMENT,
      fetchImpl: mock.fetchImpl,
      localGitState: LOCAL_GIT_STATE,
      monotonicNow: mock.monotonicNow,
    }),
    (error) =>
      error instanceof NativePrPreviewE2eError
      && error.code
        === 'NATIVE_PR_PREVIEW_BACKSTAGE_GENERATION_RESPONSE_TOO_LARGE'
      && error.caseId === caseId
  );
});

test('rejects dispatch identifier reflection and invalid timestamp evidence', async () => {
  const requestPlan = buildNativePrPreviewRequestPlan();
  for (const testCase of [
    {
      code: 'NATIVE_PR_PREVIEW_DISPATCH_GPT_IDENTIFIER_REFLECTION',
      mutate(body) {
        body.action =
          NATIVE_PR_PREVIEW_E2E_CONTRACT.dispatchGptIdentifier.actionMarker;
      },
    },
    {
      code: 'NATIVE_PR_PREVIEW_DISPATCH_GPT_IDENTIFIER_TIMESTAMP_INVALID',
      mutate(body) {
        body._route.timestamp = 'not-a-timestamp';
      },
    },
  ]) {
    const mock = buildMockFetch(requestPlan, (requestCase) => {
      if (requestCase.caseId !== 'dispatch-gpt-identifier-oversized') {
        return undefined;
      }
      const parsedBody = JSON.parse(responseBodyForCase(requestCase));
      testCase.mutate(parsedBody);
      const body = JSON.stringify(parsedBody);
      const response = new Response(body, {
        headers: responseHeadersForCase(requestCase, Buffer.byteLength(body)),
        status: requestCase.expectedStatus,
      });
      Object.defineProperty(response, 'url', {
        value: `${WEB_BASE_URL}${requestCase.path}`,
      });
      return response;
    });

    await assert.rejects(
      runNativePrPreviewE2e({
        args: validArguments('--execute', '--allow-network'),
        expectedBackstageBookerOpenApiDocument:
          EXPECTED_BACKSTAGE_BOOKER_OPENAPI_DOCUMENT,
        fetchImpl: mock.fetchImpl,
        localGitState: LOCAL_GIT_STATE,
        monotonicNow: mock.monotonicNow,
      }),
      (error) =>
        error instanceof NativePrPreviewE2eError
        && error.code === testCase.code
        && error.caseId === 'dispatch-gpt-identifier-oversized'
    );
  }
});

test('returns a stable case-scoped failure without consuming a mismatched body', async () => {
  const requestPlan = buildNativePrPreviewRequestPlan();
  const mock = buildMockFetch(requestPlan, (requestCase) => {
    if (requestCase.caseId !== 'web-readiness-initial') {
      return undefined;
    }
    const response = new Response('sensitive-sentinel', {
      headers: { 'cache-control': 'no-store' },
      status: 500,
    });
    Object.defineProperty(response, 'url', {
      value: `${WEB_BASE_URL}/readyz`,
    });
    return response;
  });

  await assert.rejects(
    runNativePrPreviewE2e({
      args: validArguments('--execute', '--allow-network'),
      expectedBackstageBookerOpenApiDocument:
        EXPECTED_BACKSTAGE_BOOKER_OPENAPI_DOCUMENT,
      fetchImpl: mock.fetchImpl,
      localGitState: LOCAL_GIT_STATE,
      monotonicNow: mock.monotonicNow,
    }),
    (error) =>
      error instanceof NativePrPreviewE2eError
      && error.code === 'NATIVE_PR_PREVIEW_HTTP_STATUS_MISMATCH'
      && error.caseId === 'web-readiness-initial'
      && !error.message.includes('sensitive-sentinel')
  );
});

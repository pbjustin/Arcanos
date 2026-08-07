import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  NativePrPreviewE2eError,
  buildNativePrPreviewRequestPlan,
  expectedNativePrPreviewContentType,
  expectedNativePrPreviewResponseBody,
  parseNativePrPreviewE2eArguments,
  runNativePrPreviewE2e,
} from './native-pr-preview-e2e.mjs';
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

function responseBodyForCase(requestCase) {
  if (requestCase.expectedType === 'head') {
    return null;
  }
  const expectedBody = expectedNativePrPreviewResponseBody(requestCase, {
    commitSha: COMMIT_SHA,
    prNumber: PR_NUMBER,
  });
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

function buildMockFetch(requestPlan, override = undefined) {
  let requestIndex = 0;
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

    const overriddenResponse = override?.(requestCase, requestIndex);
    if (overriddenResponse) {
      return overriddenResponse;
    }
    if (requestCase.caseId === 'research-workflow-cancellation-drain') {
      await delay(325);
    }
    const body = responseBodyForCase(requestCase);
    const bodyBytes = Buffer.byteLength(body ?? '');
    const headers = {
      'cache-control': 'no-store',
      'content-type': expectedNativePrPreviewContentType(requestCase),
      ...(requestCase.boundedResponse
        ? { 'x-response-bytes': String(bodyBytes) }
        : {}),
    };
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
    localGitState: LOCAL_GIT_STATE,
  });

  assert.equal(networkAttempted, false);
  assert.equal(result.executed, false);
  assert.equal(result.networkAttempted, false);
  assert.equal(result.summary.status, 'PASS');
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

test('executes the bounded credential-free matrix and detects identity stability', async () => {
  const requestPlan = buildNativePrPreviewRequestPlan();
  assert.equal(requestPlan.length, 66);
  assert.equal(
    requestPlan.filter(({ caseId, expectedType }) =>
      expectedType !== 'research-contract'
      && expectedType !== 'backstage-storyline-contract'
      && caseId !== 'worker-research-denied'
      && caseId !== 'worker-backstage-storyline-denied'
    ).length,
    50
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
    3
  );
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
  const lifecycleCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-storyline-lifecycle-exact'
  );
  const repeatedLifecycleCase = requestPlan.find(({ caseId }) =>
    caseId === 'backstage-storyline-lifecycle-repeat'
  );
  assert.ok(lifecycleCase);
  assert.ok(repeatedLifecycleCase);
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
  const mock = buildMockFetch(requestPlan);

  const result = await runNativePrPreviewE2e({
    args: validArguments('--execute', '--allow-network'),
    fetchImpl: mock.fetchImpl,
    localGitState: LOCAL_GIT_STATE,
  });

  assert.equal(result.executed, true);
  assert.equal(result.networkAttempted, true);
  assert.equal(result.summary.status, 'PASS');
  assert.equal(result.summary.requestsMade, 66);
  assert.equal(result.checks.length, 66);
  assert.equal(mock.requestCount, 66);
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
  assert.equal(backstageStorylineCalls.length, 4);
  assert.equal(
    backstageStorylineCalls.filter(({ url }) =>
      url.startsWith(WEB_BASE_URL)
    ).length,
    3
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
  const applicationSource =
    `import { getRequestAbortContext } from '${applicationContract.specifier}';`;
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
        'getRequestAbortContext }',
        'getRequestAbortContext, createAbortError }'
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
      headers: {
        'cache-control': 'no-store',
        'content-type': expectedNativePrPreviewContentType(requestCase),
        'x-response-bytes': String(Buffer.byteLength(body)),
      },
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
      fetchImpl: mock.fetchImpl,
      localGitState: LOCAL_GIT_STATE,
    }),
    (error) =>
      error instanceof NativePrPreviewE2eError
      && error.code === 'NATIVE_PR_PREVIEW_CANCELLATION_DRAIN_TOO_EARLY'
      && error.caseId === 'research-workflow-cancellation-drain'
  );
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
        headers: {
          'cache-control': 'no-store',
          'content-type': expectedNativePrPreviewContentType(requestCase),
          'x-response-bytes': String(Buffer.byteLength(body)),
        },
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
      fetchImpl: bodyMismatchMock.fetchImpl,
      localGitState: LOCAL_GIT_STATE,
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
        headers: {
          'cache-control': 'no-store',
          'content-type': 'text/plain; charset=utf-8',
        },
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
      fetchImpl: contentTypeMock.fetchImpl,
      localGitState: LOCAL_GIT_STATE,
    }),
    (error) =>
      error instanceof NativePrPreviewE2eError
      && error.code === 'NATIVE_PR_PREVIEW_CONTENT_TYPE_INVALID'
      && error.caseId === 'web-readiness-initial'
  );
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
      fetchImpl: mock.fetchImpl,
      localGitState: LOCAL_GIT_STATE,
    }),
    (error) =>
      error instanceof NativePrPreviewE2eError
      && error.code === 'NATIVE_PR_PREVIEW_HTTP_STATUS_MISMATCH'
      && error.caseId === 'web-readiness-initial'
      && !error.message.includes('sensitive-sentinel')
  );
});

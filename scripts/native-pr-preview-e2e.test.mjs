import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  NativePrPreviewE2eError,
  buildNativePrPreviewRequestPlan,
  expectedNativePrPreviewContentType,
  expectedNativePrPreviewResponseBody,
  parseNativePrPreviewE2eArguments,
  runNativePrPreviewE2e,
} from './native-pr-preview-e2e.mjs';

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
  assert.equal(requestPlan.length, 61);
  assert.equal(
    requestPlan.filter(({ caseId, expectedType }) =>
      expectedType !== 'research-contract'
      && caseId !== 'worker-research-denied'
    ).length,
    50
  );
  assert.equal(
    requestPlan.filter(({ expectedType }) =>
      expectedType === 'research-contract'
    ).length,
    10
  );
  assert.equal(
    requestPlan.filter(({ caseId }) =>
      caseId === 'worker-research-denied'
    ).length,
    1
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
  assert.equal(result.summary.requestsMade, 61);
  assert.equal(result.checks.length, 61);
  assert.equal(mock.requestCount, 61);
  const researchCalls = mock.calls.filter(({ url }) =>
    url.endsWith('/research/contract')
  );
  assert.equal(researchCalls.length, 11);
  assert.equal(
    researchCalls.filter(({ url }) => url.startsWith(WEB_BASE_URL)).length,
    10
  );
  assert.equal(
    researchCalls.filter(({ url }) => url.startsWith(WORKER_BASE_URL)).length,
    1
  );
  for (const { init } of researchCalls) {
    assert.deepEqual(Object.keys(JSON.parse(init.body)), ['fixture']);
    assert.equal(init.body.includes('https://'), false);
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

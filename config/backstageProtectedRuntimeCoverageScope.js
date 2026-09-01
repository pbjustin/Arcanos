/**
 * Coverage ownership for the protected Backstage generation runtime.
 *
 * These files implement the sealed preview, authenticated continuation,
 * bounded response, queue protection, and worker terminal behavior exercised
 * by the offline Backstage regression suites. Thresholds are explicit so new
 * runtime files cannot silently disappear from Jest or Codecov reporting.
 */
export const backstageProtectedRuntimeCoverageThresholds = Object.freeze({
  'src/nativePrPreviewApplication.ts': Object.freeze({
    branches: 80,
    functions: 90,
    lines: 95,
    statements: 95,
  }),
  'src/routes/backstageBookerAsyncResult.ts': Object.freeze({
    branches: 80,
    functions: 100,
    lines: 90,
    statements: 90,
  }),
  'src/shared/backstage/backstageBookerAsyncContinuation.ts': Object.freeze({
    branches: 100,
    functions: 100,
    lines: 100,
    statements: 100,
  }),
  'src/shared/backstage/backstageBookerAsyncResultCore.ts': Object.freeze({
    branches: 90,
    functions: 100,
    lines: 95,
    statements: 95,
  }),
  'src/shared/backstage/backstageProtectedContinuityPolicy.ts': Object.freeze({
    branches: 100,
    functions: 100,
    lines: 100,
    statements: 100,
  }),
  'src/shared/backstage/backstageProtectedFailure.ts': Object.freeze({
    branches: 90,
    functions: 100,
    lines: 95,
    statements: 95,
  }),
  'src/shared/backstage/backstageQueuedJobResultProtection.ts': Object.freeze({
    branches: 90,
    functions: 100,
    lines: 95,
    statements: 95,
  }),
  'src/shared/gpt/gptAsyncWaitPolicy.ts': Object.freeze({
    branches: 100,
    functions: 100,
    lines: 100,
    statements: 100,
  }),
  'src/shared/http/clientJsonPayload.ts': Object.freeze({
    branches: 70,
    functions: 100,
    lines: 85,
    statements: 85,
  }),
  'src/shared/http/sendBoundedJsonResponse.ts': Object.freeze({
    branches: 80,
    functions: 100,
    lines: 100,
    statements: 100,
  }),
  'src/workers/jobRunner.ts': Object.freeze({
    branches: 70,
    functions: 70,
    lines: 55,
    statements: 55,
  }),
});

export const backstageProtectedRuntimeCoverageScopeFiles = Object.freeze(
  Object.keys(backstageProtectedRuntimeCoverageThresholds)
);

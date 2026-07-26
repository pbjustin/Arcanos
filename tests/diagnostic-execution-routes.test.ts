import path from 'node:path';

import express from 'express';
import request from 'supertest';
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const runSelfTestPipelineMock = jest.fn();
const generateDailySummaryMock = jest.fn();
const analyzePrMock = jest.fn();
const formatPrMarkdownMock = jest.fn();

jest.unstable_mockModule('../src/services/selfTestPipeline.js', () => ({
  runSelfTestPipeline: runSelfTestPipelineMock,
}));
jest.unstable_mockModule('../src/services/dailySummaryService.js', () => ({
  generateDailySummary: generateDailySummaryMock,
}));
jest.unstable_mockModule('../src/services/prAssistant.js', () => ({
  PRAssistant: class MockPrAssistant {
    analyzePR = analyzePrMock;
    formatAsMarkdown = formatPrMarkdownMock;
  },
}));

const { default: devopsRouter } = await import('../src/routes/devops.js');
const { default: prAnalysisRouter } = await import(
  '../src/routes/pr-analysis.js'
);

const controlPlaneAccessToken =
  'diagnostic-route-control-token-1234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;
let principalCounter = 0;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(scopes: string): string {
  principalCounter += 1;
  const principalId = `operator:diagnostic-route-test-${principalCounter}`;
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneAccessToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = principalId;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
  return principalId;
}

function buildApp(): express.Express {
  const app = express();
  app.use('/', devopsRouter);
  app.use('/api/pr-analysis', prAnalysisRouter);
  return app;
}

function authenticatedPost(
  app: express.Express,
  routePath: string
) {
  return request(app)
    .post(routePath)
    .set('Authorization', `Bearer ${controlPlaneAccessToken}`);
}

describe('diagnostic execution routes', () => {
  beforeEach(() => {
    runSelfTestPipelineMock.mockReset();
    generateDailySummaryMock.mockReset();
    analyzePrMock.mockReset();
    formatPrMarkdownMock.mockReset();
  });

  it('rejects caller-selected DevOps targets and attribution', async () => {
    configureControlPlane('diagnostics:execute');

    const response = await authenticatedPost(
      buildApp(),
      '/devops/self-test'
    ).send({
      baseUrl: 'http://169.254.169.254',
      triggeredBy: 'anonymous-caller',
    });

    expect(response.status).toBe(400);
    expect(runSelfTestPipelineMock).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain('169.254.169.254');
  });

  it('uses server-owned attribution and hides absolute summary paths', async () => {
    const principalId = configureControlPlane('diagnostics:execute');
    runSelfTestPipelineMock.mockResolvedValue({
      triggeredBy: principalId,
      passCount: 3,
      failCount: 0,
    });
    generateDailySummaryMock.mockResolvedValue({
      model: 'test-model',
      file: path.join(process.cwd(), 'memory', 'summary-2026-07-25.json'),
      summary: { status: 'ok' },
      generatedAt: '2026-07-25T00:00:00.000Z',
      triggeredBy: principalId,
    });
    const app = buildApp();

    const selfTestResponse = await authenticatedPost(
      app,
      '/devops/self-test'
    ).send({});
    const dailySummaryResponse = await authenticatedPost(
      app,
      '/devops/daily-summary'
    ).send({});

    expect(selfTestResponse.status).toBe(200);
    expect(runSelfTestPipelineMock).toHaveBeenCalledWith({
      triggeredBy: principalId,
    });
    expect(dailySummaryResponse.status).toBe(200);
    expect(generateDailySummaryMock).toHaveBeenCalledWith(principalId);
    expect(dailySummaryResponse.body.file).toBe(
      'memory/summary-2026-07-25.json'
    );
    expect(dailySummaryResponse.body.file).not.toContain(process.cwd());
  });

  it('does not disclose DevOps execution exceptions', async () => {
    configureControlPlane('diagnostics:execute');
    runSelfTestPipelineMock.mockRejectedValue(
      new Error('SENTINEL_INTERNAL_SELF_TEST_FAILURE')
    );

    const response = await authenticatedPost(
      buildApp(),
      '/devops/self-test'
    ).send({});

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain(
      'SENTINEL_INTERNAL_SELF_TEST_FAILURE'
    );
    expect(response.body.message).toBe('Self-test execution failed.');
  });

  it.each([
    '../outside.ts',
    'src/../../outside.ts',
    'C:\\outside.ts',
    '\\\\server\\share\\outside.ts',
    'src/\u0000outside.ts',
  ])('rejects unsafe PR file path %s', async (unsafePath) => {
    configureControlPlane('repo:verify');

    const response = await authenticatedPost(
      buildApp(),
      '/api/pr-analysis/analyze'
    ).send({
      prDiff: 'diff --git a/src/file.ts b/src/file.ts',
      prFiles: [unsafePath],
    });

    expect(response.status).toBe(400);
    expect(analyzePrMock).not.toHaveBeenCalled();
  });

  it('normalizes validated PR paths and reconstructs strict metadata', async () => {
    configureControlPlane('repo:verify');
    const result = {
      status: '✅',
      summary: 'ok',
      checks: {},
      reasoning: '',
      recommendations: [],
    };
    analyzePrMock.mockResolvedValue(result);
    formatPrMarkdownMock.mockReturnValue('# result');

    const response = await authenticatedPost(
      buildApp(),
      '/api/pr-analysis/analyze'
    ).send({
      prDiff: 'diff --git a/src/file.ts b/src/file.ts',
      prFiles: ['src\\file.ts'],
      metadata: {
        prNumber: 42,
        prTitle: 'Safe change',
        repository: 'example/arcanos',
      },
    });

    expect(response.status).toBe(200);
    expect(analyzePrMock).toHaveBeenCalledWith(
      'diff --git a/src/file.ts b/src/file.ts',
      ['src/file.ts']
    );
    expect(response.body.metadata).toMatchObject({
      prNumber: 42,
      prTitle: 'Safe change',
      repository: 'example/arcanos',
    });
  });

  it('does not disclose PR execution exceptions', async () => {
    configureControlPlane('repo:verify');
    analyzePrMock.mockRejectedValue(
      new Error('SENTINEL_INTERNAL_PR_ANALYSIS_FAILURE')
    );

    const response = await authenticatedPost(
      buildApp(),
      '/api/pr-analysis/analyze'
    ).send({
      prDiff: 'diff --git a/src/file.ts b/src/file.ts',
      prFiles: ['src/file.ts'],
    });

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain(
      'SENTINEL_INTERNAL_PR_ANALYSIS_FAILURE'
    );
    expect(response.body.message).toBe('PR analysis execution failed.');
  });
});

afterAll(() => {
  clearPurposeBoundCredentialEnvironment();
  for (const [environmentName, value] of originalCredentialEnvironment) {
    if (value !== undefined) {
      process.env[environmentName] = value;
    }
  }
  if (originalPrincipalId === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = originalPrincipalId;
  }
  if (originalScopes === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_SCOPES;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_SCOPES = originalScopes;
  }
});

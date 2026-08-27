import { describe, expect, it } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import {
  NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES,
  findNativePrPreviewImportViolations,
  findNativePrPreviewBuildScriptViolations,
  findPreviewDistImportCheckerDigestViolations,
  findRuntimeRequestAbortExportViolations,
  findRuntimeRequestAbortTypeResolutionViolations,
  findUnsafeRuntimeSyntax,
} from '../scripts/check-native-pr-preview-imports.mjs';

const RAILWAY_LAUNCHER_URL =
  new URL('../scripts/start-railway-service.mjs', import.meta.url);
const NATIVE_PREVIEW_CHILD_URL =
  new URL('../src/start-native-pr-preview.ts', import.meta.url);
const REQUEST_ABORT_URL = new URL(
  '../packages/arcanos-runtime/src/requestAbort.ts',
  import.meta.url
);
const RUNTIME_PACKAGE_MANIFEST_URL = new URL(
  '../packages/arcanos-runtime/package.json',
  import.meta.url
);
const ROOT_PACKAGE_MANIFEST_URL = new URL('../package.json', import.meta.url);
const ROOT_TSCONFIG_URL = new URL('../tsconfig.json', import.meta.url);
const PREVIEW_DIST_IMPORT_CHECKER_URL = new URL(
  '../scripts/check-native-pr-preview-dist-imports.mjs',
  import.meta.url
);
const RESEARCH_ABORT_DRAIN_URL = new URL(
  '../src/routes/_core/researchAbortDrain.ts',
  import.meta.url
);
const RESEARCH_REQUEST_URL =
  new URL('../src/shared/researchRequest.ts', import.meta.url);
const SELF_HEAL_PREDICTIVE_APPROVAL_URL = new URL(
  '../src/shared/selfHealPredictiveApproval.ts',
  import.meta.url
);
const STORYLINE_REPOSITORY_URL = new URL(
  '../src/core/db/repositories/backstageStorylineRepository.ts',
  import.meta.url
);
const STORYLINE_SHARED_URL = new URL(
  '../src/shared/backstage/backstageStoryline.ts',
  import.meta.url
);
const UNIVERSE_READ_PROJECTION_URL = new URL(
  '../src/shared/backstage/backstageUniverseReadProjection.ts',
  import.meta.url
);
const BACKSTAGE_REVIEW_CONTRACT_URL = new URL(
  '../src/shared/backstage/backstageReviewContract.ts',
  import.meta.url
);
const BACKSTAGE_BOOKER_CLEAR_URL = new URL(
  '../src/services/backstageBookerClear.ts',
  import.meta.url
);
const BACKSTAGE_COMPACT_OUTPUT_CONTRACT_URL = new URL(
  '../src/shared/backstage/backstageCompactOutputContract.ts',
  import.meta.url
);
const BACKSTAGE_GENERATION_ERROR_URL = new URL(
  '../src/shared/backstage/backstageGenerationError.ts',
  import.meta.url
);
const BACKSTAGE_NOTION_PREVIEW_CANARY_URL = new URL(
  '../src/shared/backstage/backstageNotionPreviewCanary.ts',
  import.meta.url
);
const BACKSTAGE_NOTION_RAG_CORE_URL = new URL(
  '../src/shared/backstage/backstageNotionRagCore.ts',
  import.meta.url
);
const BACKSTAGE_NOTION_PARTITION_CORE_URL = new URL(
  '../src/shared/backstage/backstageNotionPartitionCore.ts',
  import.meta.url
);
const BACKSTAGE_NOTION_PARTITION_MATERIAL_CORE_URL = new URL(
  '../src/shared/backstage/backstageNotionPartitionMaterialCore.ts',
  import.meta.url
);
const BACKSTAGE_NOTION_PARTITION_ROUTING_CORE_URL = new URL(
  '../src/shared/backstage/backstageNotionPartitionRoutingCore.ts',
  import.meta.url
);
const BACKSTAGE_NOTION_PARTITION_SYNC_CORE_URL = new URL(
  '../src/shared/backstage/backstageNotionPartitionSyncCore.ts',
  import.meta.url
);
const BACKSTAGE_NOTION_PARTITION_TELEMETRY_CORE_URL = new URL(
  '../src/shared/backstage/backstageNotionPartitionTelemetryCore.ts',
  import.meta.url
);
const BACKSTAGE_NOTION_PARTITION_SYNC_JOB_URL = new URL(
  '../src/shared/jobs/backstageNotionPartitionSyncJob.ts',
  import.meta.url
);
const TRINITY_DIRECT_ANSWER_MODE_URL = new URL(
  '../src/core/logic/trinityDirectAnswerMode.ts',
  import.meta.url
);
const DIRECT_ANSWER_MODE_URL = new URL(
  '../src/services/directAnswerMode.ts',
  import.meta.url
);
const MCP_HTTP_BODY_PARSER_CORE_URL = new URL(
  '../src/mcp/httpBodyParserCore.ts',
  import.meta.url
);
const GAMING_PUBLIC_DISPATCHER_URL = new URL(
  '../src/services/gamingPublicDispatcher.ts',
  import.meta.url
);
const PUBLIC_GAMING_CANARY_URL = new URL(
  '../src/services/publicGamingCanary.ts',
  import.meta.url
);
const PUBLIC_GAMING_CANARY_FIXTURE_URL = new URL(
  '../src/services/publicGamingCanaryFixture.ts',
  import.meta.url
);
const DISPATCH_GPT_IDENTIFIER_BOUNDARY_URL = new URL(
  '../src/shared/dispatch/dispatchGptIdentifierBoundary.ts',
  import.meta.url
);
const UNIVERSAL_DISPATCH_URL = new URL(
  '../src/shared/dispatch/universalDispatch.ts',
  import.meta.url
);
const GPT_IDENTIFIER_URL = new URL(
  '../src/shared/gpt/gptIdentifier.ts',
  import.meta.url
);
const GPT_ASYNC_WAIT_POLICY_URL = new URL(
  '../src/shared/gpt/gptAsyncWaitPolicy.ts',
  import.meta.url
);
const GPT_CLIENT_REGISTRY_URL = new URL(
  '../src/shared/gpt/gptClientRegistry.ts',
  import.meta.url
);
const BACKSTAGE_EXECUTION_BUDGET_URL = new URL(
  '../src/shared/backstage/backstageExecutionBudget.ts',
  import.meta.url
);
const QUEUED_JOB_COMPLETION_POLLING_URL = new URL(
  '../src/services/queuedJobCompletionPolling.ts',
  import.meta.url
);
const BACKSTAGE_BOOKER_ACCESS_AUTH_CORE_URL = new URL(
  '../src/shared/backstage/backstageBookerAccessAuthCore.ts',
  import.meta.url
);
const BACKSTAGE_BOOKER_ASYNC_CONTINUATION_URL = new URL(
  '../src/shared/backstage/backstageBookerAsyncContinuation.ts',
  import.meta.url
);
const BACKSTAGE_BOOKER_ASYNC_RESULT_CORE_URL = new URL(
  '../src/shared/backstage/backstageBookerAsyncResultCore.ts',
  import.meta.url
);
const BACKSTAGE_QUEUED_JOB_RESULT_PROTECTION_URL = new URL(
  '../src/shared/backstage/backstageQueuedJobResultProtection.ts',
  import.meta.url
);
const SYSTEM_STATE_HTTP_BOUNDARY_URL = new URL(
  '../src/services/controlPlane/systemStateHttpBoundary.ts',
  import.meta.url
);
const SYSTEM_STATE_BODY_PARSER_URL = new URL(
  '../src/services/controlPlane/systemStateBodyParser.ts',
  import.meta.url
);
const CONTROL_PLANE_HTTP_AUTH_URL = new URL(
  '../src/services/controlPlane/httpAuth.ts',
  import.meta.url
);
const PLATFORM_RUNTIME_SECURITY_URL = new URL(
  '../src/platform/runtime/security.ts',
  import.meta.url
);

async function readRailwayLauncherSource() {
  return (await readFile(RAILWAY_LAUNCHER_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readNativePreviewChildSource() {
  return (await readFile(NATIVE_PREVIEW_CHILD_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readRequestAbortSource() {
  return (await readFile(REQUEST_ABORT_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readResearchAbortDrainSource() {
  return (await readFile(RESEARCH_ABORT_DRAIN_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readResearchRequestSource() {
  return (await readFile(RESEARCH_REQUEST_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readDispatchGptIdentifierBoundarySource() {
  return (await readFile(DISPATCH_GPT_IDENTIFIER_BOUNDARY_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readUniversalDispatchSource() {
  return (await readFile(UNIVERSAL_DISPATCH_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readGptIdentifierSource() {
  return (await readFile(GPT_IDENTIFIER_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readNormalizedSource(url) {
  return (await readFile(url, 'utf8')).replace(/\r\n/gu, '\n');
}

async function readSelfHealPredictiveApprovalSource() {
  return (await readFile(SELF_HEAL_PREDICTIVE_APPROVAL_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readStorylineRepositorySource() {
  return (await readFile(STORYLINE_REPOSITORY_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readStorylineSharedSource() {
  return (await readFile(STORYLINE_SHARED_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readUniverseReadProjectionSource() {
  return (await readFile(UNIVERSE_READ_PROJECTION_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readBackstageReviewContractSource() {
  return (await readFile(BACKSTAGE_REVIEW_CONTRACT_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readBackstageBookerClearSource() {
  return (await readFile(BACKSTAGE_BOOKER_CLEAR_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readBackstageCompactOutputContractSource() {
  return (await readFile(BACKSTAGE_COMPACT_OUTPUT_CONTRACT_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readBackstageGenerationErrorSource() {
  return (await readFile(BACKSTAGE_GENERATION_ERROR_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readBackstageNotionPreviewCanarySource() {
  return (await readFile(BACKSTAGE_NOTION_PREVIEW_CANARY_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readBackstageNotionRagCoreSource() {
  return (await readFile(BACKSTAGE_NOTION_RAG_CORE_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readBackstageNotionPartitionSource(sourceUrl) {
  return (await readFile(sourceUrl, 'utf8')).replace(/\r\n/gu, '\n');
}

async function readTrinityDirectAnswerModeSource() {
  return (await readFile(TRINITY_DIRECT_ANSWER_MODE_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readDirectAnswerModeSource() {
  return (await readFile(DIRECT_ANSWER_MODE_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readMcpHttpBodyParserCoreSource() {
  return (await readFile(MCP_HTTP_BODY_PARSER_CORE_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readGamingPublicDispatcherSource() {
  return (await readFile(GAMING_PUBLIC_DISPATCHER_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readPublicGamingCanarySource() {
  return (await readFile(PUBLIC_GAMING_CANARY_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

async function readPublicGamingCanaryFixtureSource() {
  return (await readFile(PUBLIC_GAMING_CANARY_FIXTURE_URL, 'utf8'))
    .replace(/\r\n/gu, '\n');
}

function replaceRequired(sourceText, expected, replacement) {
  expect(sourceText).toContain(expected);
  return sourceText.replace(expected, replacement);
}

describe('native PR preview import boundary', () => {
  it('keeps the contained application outside production side-effect modules', async () => {
    await expect(findNativePrPreviewImportViolations()).resolves.toEqual([]);
  }, 30_000);

  it('fails closed when the runtime graph gains an unreviewed module', async () => {
    const graphFiles = [
      ...NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES,
      'src/config/openai.ts',
    ];
    const analyzeDependencies = async () => ({
      obj: () => Object.fromEntries(
        graphFiles.map((graphFile) => [graphFile, []])
      ),
      warnings: () => ({ skipped: [] }),
    });

    await expect(findNativePrPreviewImportViolations({
      analyzeDependencies,
    })).resolves.toContain(
      'unreviewed preview import: src/config/openai.ts'
    );
  });

  it('keeps runtime loader hooks outside the contained child command graph', () => {
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).not.toEqual(
      expect.arrayContaining([
        'scripts/esm-alias-loader.mjs',
        'scripts/register-esm-loader.mjs',
      ])
    );
  });

  it('admits and pins only the pure Booker queue-wait policy seams', async () => {
    const reviewedFiles = [
      'src/shared/gpt/gptAsyncWaitPolicy.ts',
      'src/shared/backstage/backstageExecutionBudget.ts',
      'src/services/queuedJobCompletionPolling.ts',
    ];
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).toEqual(
      expect.arrayContaining(reviewedFiles)
    );
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).not.toEqual(
      expect.arrayContaining([
        'src/routes/gptRouter.ts',
        'src/services/queuedGptCompletionService.ts',
        'src/core/db/repositories/jobRepository.ts',
        'src/workers/jobRunner.ts',
      ])
    );

    const sources = [
      await readNormalizedSource(GPT_ASYNC_WAIT_POLICY_URL),
      await readNormalizedSource(BACKSTAGE_EXECUTION_BUDGET_URL),
      await readNormalizedSource(QUEUED_JOB_COMPLETION_POLLING_URL),
    ];
    for (const [index, filePath] of reviewedFiles.entries()) {
      expect(findUnsafeRuntimeSyntax(filePath, sources[index])).toEqual([]);
    }

    const semanticDrifts = [
      [
        reviewedFiles[0],
        replaceRequired(
          sources[0],
          'return MAX_ASYNC_GPT_WAIT_FOR_RESULT_MS;',
          'return 1;'
        ),
      ],
      [
        reviewedFiles[1],
        replaceRequired(
          sources[1],
          'export const BACKSTAGE_RESULT_POLL_WAIT_MS =\n  MAX_ASYNC_GPT_WAIT_FOR_RESULT_MS;',
          'export const BACKSTAGE_RESULT_POLL_WAIT_MS = 1;'
        ),
      ],
      [
        reviewedFiles[2],
        replaceRequired(sources[2], 'Math.ceil(', 'Math.floor('),
      ],
    ];
    for (const [filePath, driftedSource] of semanticDrifts) {
      expect(findUnsafeRuntimeSyntax(filePath, driftedSource)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('critical entry file semantic digest'),
        ])
      );
    }
  });

  it('admits and pins only the pure GPT client identity seam', async () => {
    const filePath = 'src/shared/gpt/gptClientRegistry.ts';
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).toContain(filePath);
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).not.toEqual(
      expect.arrayContaining([
        'src/routes/gptRouter.ts',
        'src/services/backstageBookerAccessAuth.ts',
        'src/core/db/repositories/jobRepository.ts',
        'src/workers/jobRunner.ts',
      ])
    );

    const sourceText = await readNormalizedSource(GPT_CLIENT_REGISTRY_URL);
    expect(findUnsafeRuntimeSyntax(filePath, sourceText)).toEqual([]);

    const semanticDrift = replaceRequired(
      sourceText,
      "  clientId: 'backstage-booker',\n  gptId: 'backstage-booker',",
      "  clientId: 'drifted-client',\n  gptId: 'backstage-booker',"
    );
    expect(findUnsafeRuntimeSyntax(filePath, semanticDrift)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('critical entry file semantic digest'),
      ])
    );
  });

  it('admits and pins only the pure managed Booker continuation seams', async () => {
    const reviewedFiles = [
      'src/shared/backstage/backstageBookerAccessAuthCore.ts',
      'src/shared/backstage/backstageBookerAsyncContinuation.ts',
      'src/shared/backstage/backstageBookerAsyncResultCore.ts',
      'src/shared/backstage/backstageQueuedJobResultProtection.ts',
    ];
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).toEqual(
      expect.arrayContaining(reviewedFiles)
    );
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).not.toEqual(
      expect.arrayContaining([
        'src/routes/backstageBookerAsyncResult.ts',
        'src/services/backstageBookerAccessAuth.ts',
        'src/services/queuedGptCompletionService.ts',
        'src/core/db/repositories/jobRepository.ts',
        'src/platform/observability/appMetrics.ts',
        'src/workers/jobRunner.ts',
      ])
    );

    const sources = new Map([
      [reviewedFiles[0], await readNormalizedSource(
        BACKSTAGE_BOOKER_ACCESS_AUTH_CORE_URL
      )],
      [reviewedFiles[1], await readNormalizedSource(
        BACKSTAGE_BOOKER_ASYNC_CONTINUATION_URL
      )],
      [reviewedFiles[2], await readNormalizedSource(
        BACKSTAGE_BOOKER_ASYNC_RESULT_CORE_URL
      )],
      [reviewedFiles[3], await readNormalizedSource(
        BACKSTAGE_QUEUED_JOB_RESULT_PROTECTION_URL
      )],
    ]);
    for (const [filePath, source] of sources) {
      expect(findUnsafeRuntimeSyntax(filePath, source)).toEqual([]);
      expect(findUnsafeRuntimeSyntax(
        filePath,
        source.replace(/\n/gu, '\r\n')
      )).toEqual([]);
    }

    const semanticDrifts = [
      [
        reviewedFiles[0],
        replaceRequired(
          sources.get(reviewedFiles[0]),
          "  'backstage-booker-access:principal:v1';",
          "  'backstage-booker-access:principal:v2';"
        ),
      ],
      [
        reviewedFiles[1],
        replaceRequired(
          sources.get(reviewedFiles[1]),
          "  '/gpt-access/capabilities/v1/backstage-booker/jobs';",
          "  '/jobs';"
        ),
      ],
      [
        reviewedFiles[2],
        replaceRequired(
          sources.get(reviewedFiles[2]),
          "    && resolvePublicGptJobCreationSurface(job.input) === 'public-gpt'",
          "    && resolvePublicGptJobCreationSurface(job.input) !== 'public-gpt'"
        ),
      ],
      [
        reviewedFiles[3],
        replaceRequired(
          sources.get(reviewedFiles[3]),
          "const PROTECTED_BACKSTAGE_JOB_RESULT_SOURCE = 'backstage-booker-worker';",
          "const PROTECTED_BACKSTAGE_JOB_RESULT_SOURCE = 'backstage-booker-preview';"
        ),
      ],
    ];
    for (const [filePath, source] of semanticDrifts) {
      expect(findUnsafeRuntimeSyntax(filePath, source)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('critical entry file semantic digest'),
        ])
      );
    }
  });

  it('admits and pins only the pure dispatch GPT identifier boundary seam', async () => {
    const reviewedFiles = [
      'src/shared/dispatch/dispatchGptIdentifierBoundary.ts',
      'src/shared/dispatch/universalDispatch.ts',
      'src/shared/gpt/gptIdentifier.ts',
    ];
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).toEqual(
      expect.arrayContaining(reviewedFiles)
    );
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).not.toEqual(
      expect.arrayContaining([
        'src/services/controlPlane/dispatchDagCompatibilityBoundary.ts',
        'src/services/controlPlane/dagHttpBoundary.ts',
        'src/routes/dispatch.ts',
        'src/platform/publicProviderAdmission.ts',
      ])
    );

    const sources = new Map([
      [reviewedFiles[0], await readDispatchGptIdentifierBoundarySource()],
      [reviewedFiles[1], await readUniversalDispatchSource()],
      [reviewedFiles[2], await readGptIdentifierSource()],
    ]);
    for (const [filePath, source] of sources) {
      expect(findUnsafeRuntimeSyntax(filePath, source)).toEqual([]);
      expect(findUnsafeRuntimeSyntax(
        filePath,
        source.replace(/\n/gu, '\r\n')
      )).toEqual([]);
    }

    const driftedBoundary = replaceRequired(
      sources.get(reviewedFiles[0]),
      'statusCode: 400,',
      'statusCode: 401,'
    );
    const driftedResolution = replaceRequired(
      sources.get(reviewedFiles[1]),
      "if (input.target === 'dag') {",
      "if (input.target === 'gpt') {"
    );
    const driftedIdentifier = replaceRequired(
      sources.get(reviewedFiles[2]),
      'export const MAX_GPT_IDENTIFIER_LENGTH = 256;',
      'export const MAX_GPT_IDENTIFIER_LENGTH = 255;'
    );
    for (const [filePath, source] of [
      [reviewedFiles[0], driftedBoundary],
      [reviewedFiles[1], driftedResolution],
      [reviewedFiles[2], driftedIdentifier],
    ]) {
      expect(findUnsafeRuntimeSyntax(filePath, source)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('critical entry file semantic digest'),
        ])
      );
    }
  });

  it('admits and pins only the production status auth and body-parser seam', async () => {
    const reviewedFiles = [
      'src/platform/runtime/security.ts',
      'src/services/controlPlane/httpAuth.ts',
      'src/services/controlPlane/systemStateBodyParser.ts',
      'src/services/controlPlane/systemStateHttpBoundary.ts',
    ];
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).toEqual(
      expect.arrayContaining(reviewedFiles)
    );
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).not.toEqual(
      expect.arrayContaining([
        'src/app.ts',
        'src/services/stateManager.ts',
        'src/middleware/confirmGate.ts',
        'src/routes/status.ts',
        'src/routes/system-state.ts',
      ])
    );

    const sources = new Map([
      [reviewedFiles[0], await readNormalizedSource(PLATFORM_RUNTIME_SECURITY_URL)],
      [reviewedFiles[1], await readNormalizedSource(CONTROL_PLANE_HTTP_AUTH_URL)],
      [reviewedFiles[2], await readNormalizedSource(SYSTEM_STATE_BODY_PARSER_URL)],
      [reviewedFiles[3], await readNormalizedSource(SYSTEM_STATE_HTTP_BOUNDARY_URL)],
    ]);
    for (const [filePath, source] of sources) {
      expect(findUnsafeRuntimeSyntax(filePath, source)).toEqual([]);
      expect(findUnsafeRuntimeSyntax(
        filePath,
        source.replace(/\n/gu, '\r\n')
      )).toEqual([]);
    }

    const semanticDrifts = [
      [
        reviewedFiles[0],
        replaceRequired(
          sources.get(reviewedFiles[0]),
          "'X-Frame-Options': 'DENY',",
          "'X-Frame-Options': 'SAMEORIGIN',"
        ),
      ],
      [
        reviewedFiles[1],
        replaceRequired(
          sources.get(reviewedFiles[1]),
          "const statusCode = configurationUnavailable ? 503 : 401;",
          "const statusCode = configurationUnavailable ? 401 : 401;"
        ),
      ],
      [
        reviewedFiles[2],
        replaceRequired(
          sources.get(reviewedFiles[2]),
          'export const SYSTEM_STATE_BODY_LIMIT_BYTES = 64 * 1024;',
          'export const SYSTEM_STATE_BODY_LIMIT_BYTES = 128 * 1024;'
        ),
      ],
      [
        reviewedFiles[3],
        replaceRequired(
          sources.get(reviewedFiles[3]),
          "const LEGACY_STATUS_PATH = '/status';",
          "const LEGACY_STATUS_PATH = '/status-unsafe';"
        ),
      ],
    ];
    for (const [filePath, source] of semanticDrifts) {
      expect(findUnsafeRuntimeSyntax(filePath, source)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('critical entry file semantic digest'),
        ])
      );
    }
  });

  it('admits only the pinned storyline component seam from the database tree', async () => {
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).toEqual(
      expect.arrayContaining([
        'src/core/db/repositories/backstageStorylineRepository.ts',
        'src/shared/backstage/backstageStoryline.ts',
      ])
    );
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).not.toEqual(
      expect.arrayContaining([
        'src/core/db/index.ts',
        'src/core/db/connection.ts',
        'src/services/backstage-booker.ts',
      ])
    );

    const repositorySource = await readStorylineRepositorySource();
    const sharedSource = await readStorylineSharedSource();
    expect(findUnsafeRuntimeSyntax(
      'src/core/db/repositories/backstageStorylineRepository.ts',
      repositorySource
    )).toEqual([]);
    expect(findUnsafeRuntimeSyntax(
      'src/shared/backstage/backstageStoryline.ts',
      sharedSource
    )).toEqual([]);
    expect(findUnsafeRuntimeSyntax(
      'src/core/db/repositories/backstageStorylineRepository.ts',
      repositorySource.replace(/\n/gu, '\r\n')
    )).toEqual([]);

    const driftedRepository = replaceRequired(
      repositorySource,
      'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'
    );
    const driftedSharedContract = replaceRequired(
      sharedSource,
      'export const BACKSTAGE_STORYLINE_MAX_BYTES = 16 * 1024;',
      'export const BACKSTAGE_STORYLINE_MAX_BYTES = 32 * 1024;'
    );
    expect(findUnsafeRuntimeSyntax(
      'src/core/db/repositories/backstageStorylineRepository.ts',
      driftedRepository
    )).toEqual(expect.arrayContaining([
      expect.stringContaining('critical entry file semantic digest'),
    ]));
    expect(findUnsafeRuntimeSyntax(
      'src/shared/backstage/backstageStoryline.ts',
      driftedSharedContract
    )).toEqual(expect.arrayContaining([
      expect.stringContaining('critical entry file semantic digest'),
    ]));
  });

  it('admits and pins the pure saved-storyline read projector without its database service', async () => {
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).toEqual(
      expect.arrayContaining([
        'src/shared/backstage/backstageUniverseReadProjection.ts',
      ])
    );
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).not.toEqual(
      expect.arrayContaining([
        'src/core/db/repositories/backstageBookerRepository.ts',
        'src/services/backstageUniverseRead.ts',
      ])
    );

    const projectionSource = await readUniverseReadProjectionSource();
    expect(findUnsafeRuntimeSyntax(
      'src/shared/backstage/backstageUniverseReadProjection.ts',
      projectionSource
    )).toEqual([]);
    const driftedProjection = replaceRequired(
      projectionSource,
      'export const BACKSTAGE_SAVED_STORYLINE_EXCERPT_CODE_POINTS = 1_500;',
      'export const BACKSTAGE_SAVED_STORYLINE_EXCERPT_CODE_POINTS = 1_499;'
    );
    expect(findUnsafeRuntimeSyntax(
      'src/shared/backstage/backstageUniverseReadProjection.ts',
      driftedProjection
    )).toEqual(expect.arrayContaining([
      expect.stringContaining('critical entry file semantic digest'),
    ]));
  });

  it('admits and pins only the pure Backstage review completion seam', async () => {
    const reviewedFiles = [
      'src/core/logic/trinityDirectAnswerMode.ts',
      'src/services/directAnswerMode.ts',
      'src/shared/backstage/backstageReviewContract.ts',
    ];
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).toEqual(
      expect.arrayContaining(reviewedFiles)
    );
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).not.toEqual(
      expect.arrayContaining([
        'src/services/backstage-booker.ts',
        'src/services/openai.ts',
        'src/core/logic/trinityWritingPipeline.ts',
      ])
    );

    const sources = [
      await readTrinityDirectAnswerModeSource(),
      await readDirectAnswerModeSource(),
      await readBackstageReviewContractSource(),
    ];
    for (let index = 0; index < reviewedFiles.length; index += 1) {
      expect(findUnsafeRuntimeSyntax(
        reviewedFiles[index],
        sources[index]
      )).toEqual([]);
    }

    const semanticDrifts = [
      [
        reviewedFiles[0],
        replaceRequired(
          sources[0],
          "export const TRINITY_DIRECT_ANSWER_STAGE = 'ARCANOS-DIRECT-ANSWER';",
          "export const TRINITY_DIRECT_ANSWER_STAGE = 'ARCANOS-DIRECT-ANSWER-DRIFT';"
        ),
      ],
      [
        reviewedFiles[1],
        replaceRequired(
          sources[1],
          "  | 'simple_informational_prompt';",
          "  | 'simple_informational_prompt' | 'preview_drift';"
        ),
      ],
      [
        reviewedFiles[2],
        replaceRequired(
          sources[2],
          'export const BACKSTAGE_REVIEW_BULLET_COUNT = 6;',
          'export const BACKSTAGE_REVIEW_BULLET_COUNT = 7;'
        ),
      ],
    ];
    for (const [filePath, driftedSource] of semanticDrifts) {
      expect(findUnsafeRuntimeSyntax(filePath, driftedSource)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('critical entry file semantic digest'),
        ])
      );
    }
  });

  it('admits and pins the pure Backstage CLEAR policy composer', async () => {
    const filePath = 'src/services/backstageBookerClear.ts';
    const sourceText = await readBackstageBookerClearSource();

    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).toContain(filePath);
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).not.toContain(
      'src/services/backstage-booker.ts'
    );
    expect(findUnsafeRuntimeSyntax(filePath, sourceText)).toEqual([]);

    const weakenedPolicy = replaceRequired(
      sourceText,
      'Return only the final booking or review.',
      'Return the draft and final booking or review.'
    );
    expect(findUnsafeRuntimeSyntax(filePath, weakenedPolicy)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('critical entry file semantic digest'),
      ])
    );
  });

  it('admits and pins the pure Backstage compact retry seam', async () => {
    const reviewedFiles = [
      'src/shared/backstage/backstageCompactOutputContract.ts',
      'src/shared/backstage/backstageGenerationError.ts',
    ];
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).toEqual(
      expect.arrayContaining(reviewedFiles)
    );
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).not.toContain(
      'src/services/backstage-booker.ts'
    );

    const sources = [
      await readBackstageCompactOutputContractSource(),
      await readBackstageGenerationErrorSource(),
    ];
    for (let index = 0; index < reviewedFiles.length; index += 1) {
      expect(findUnsafeRuntimeSyntax(
        reviewedFiles[index],
        sources[index]
      )).toEqual([]);
    }

    const semanticDrifts = [
      [
        reviewedFiles[0],
        replaceRequired(
          sources[0],
          "result: await runAttempt(false),",
          "result: await runAttempt(true),"
        ),
      ],
      [
        reviewedFiles[1],
        replaceRequired(
          sources[1],
          "finishReason === 'length'",
          "finishReason === 'stop'"
        ),
      ],
    ];
    for (const [filePath, driftedSource] of semanticDrifts) {
      expect(findUnsafeRuntimeSyntax(filePath, driftedSource)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('critical entry file semantic digest'),
        ])
      );
    }
  });

  it('pins the central Research helper and its one reviewed Reflect read', async () => {
    const sourceText = await readResearchRequestSource();

    expect(findUnsafeRuntimeSyntax(
      'src/shared/researchRequest.ts',
      sourceText
    )).toEqual([]);

    const broadenedReflectRead = replaceRequired(
      sourceText,
      'Reflect.ownKeys(descriptors)',
      'Reflect.ownKeys({})'
    );
    expect(findUnsafeRuntimeSyntax(
      'src/shared/researchRequest.ts',
      broadenedReflectRead
    )).toEqual(expect.arrayContaining([
      expect.stringContaining('forbidden runtime capability reference'),
      expect.stringContaining('critical entry file semantic digest'),
    ]));
  });

  it('pins the fixed Notion edge canary and production-shared RAG core', async () => {
    const canaryFile =
      'src/shared/backstage/backstageNotionPreviewCanary.ts';
    const ragCoreFile = 'src/shared/backstage/backstageNotionRagCore.ts';
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).toEqual(
      expect.arrayContaining([canaryFile, ragCoreFile])
    );
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).not.toEqual(
      expect.arrayContaining([
        'src/services/backstageNotionRag.ts',
        'src/services/backstageNotionSync.ts',
      ])
    );

    const canarySource = await readBackstageNotionPreviewCanarySource();
    const ragCoreSource = await readBackstageNotionRagCoreSource();
    expect(findUnsafeRuntimeSyntax(canaryFile, canarySource)).toEqual([]);
    expect(findUnsafeRuntimeSyntax(ragCoreFile, ragCoreSource)).toEqual([]);

    const broadenedCanary = replaceRequired(
      canarySource,
      "const NOTION_CANARY_HOST = 'api.notion.com';",
      "const NOTION_CANARY_HOST = 'example.com';"
    );
    const weakenedPromptLimit = replaceRequired(
      ragCoreSource,
      'export const BACKSTAGE_NOTION_RAG_PROMPT_CODE_POINTS = 12_000;',
      'export const BACKSTAGE_NOTION_RAG_PROMPT_CODE_POINTS = 24_000;'
    );
    for (const [filePath, sourceText] of [
      [canaryFile, broadenedCanary],
      [ragCoreFile, weakenedPromptLimit],
    ]) {
      expect(findUnsafeRuntimeSyntax(filePath, sourceText)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('critical entry file semantic digest'),
        ])
      );
    }
  });

  it('pins only the pure partition authority contracts used by the preview proof', async () => {
    const reviewedFiles = [
      [
        'src/shared/backstage/backstageNotionPartitionCore.ts',
        BACKSTAGE_NOTION_PARTITION_CORE_URL,
        'export const BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS = 2_048;',
        'export const BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS = 4_096;',
      ],
      [
        'src/shared/backstage/backstageNotionPartitionMaterialCore.ts',
        BACKSTAGE_NOTION_PARTITION_MATERIAL_CORE_URL,
        "return createHash('sha256').update(sanitizedMarkdown, 'utf8').digest('hex');",
        "return createHash('sha512').update(sanitizedMarkdown, 'utf8').digest('hex');",
      ],
      [
        'src/shared/backstage/backstageNotionPartitionRoutingCore.ts',
        BACKSTAGE_NOTION_PARTITION_ROUTING_CORE_URL,
        'export const BACKSTAGE_NOTION_PARTITION_ROUTING_VERSION = 1;',
        'export const BACKSTAGE_NOTION_PARTITION_ROUTING_VERSION = 2;',
      ],
      [
        'src/shared/backstage/backstageNotionPartitionSyncCore.ts',
        BACKSTAGE_NOTION_PARTITION_SYNC_CORE_URL,
        "  'SHARD_CAPACITY_EXCEEDED',",
        "  'SHARD_CAPACITY_RELAXED',",
      ],
      [
        'src/shared/backstage/backstageNotionPartitionTelemetryCore.ts',
        BACKSTAGE_NOTION_PARTITION_TELEMETRY_CORE_URL,
        "  'backstage-notion-partition-shard-telemetry-v1';",
        "  'backstage-notion-partition-shard-telemetry-v2';",
      ],
      [
        'src/shared/jobs/backstageNotionPartitionSyncJob.ts',
        BACKSTAGE_NOTION_PARTITION_SYNC_JOB_URL,
        "  'backstage-notion-partition-sync-job-v1';",
        "  'backstage-notion-partition-sync-job-v2';",
      ],
    ];
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).toEqual(
      expect.arrayContaining(reviewedFiles.map(([filePath]) => filePath))
    );
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).not.toEqual(
      expect.arrayContaining([
        'src/services/backstageNotionPartitionSync.ts',
        'src/services/backstageNotionPartitionRetrieval.ts',
        'src/services/backstageNotionPartitionCutover.ts',
        'src/services/backstageNotionPartitionDiagnostics.ts',
        'src/services/backstageNotionPartitionSyncOperations.ts',
        'src/core/db/repositories/backstageNotionPartitionRepository.ts',
        'src/workers/backstageNotionPartitionSyncJob.ts',
      ])
    );

    for (const [filePath, sourceUrl, expected, replacement] of reviewedFiles) {
      const sourceText = await readBackstageNotionPartitionSource(sourceUrl);
      expect(findUnsafeRuntimeSyntax(filePath, sourceText)).toEqual([]);
      const driftedSource = replaceRequired(
        sourceText,
        expected,
        replacement
      );
      expect(findUnsafeRuntimeSyntax(filePath, driftedSource)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('critical entry file semantic digest'),
        ])
      );
    }
  });

  it('rejects broader crypto access from the partition preview cores', async () => {
    for (const [filePath, sourceUrl] of [
      [
        'src/shared/backstage/backstageNotionPartitionCore.ts',
        BACKSTAGE_NOTION_PARTITION_CORE_URL,
      ],
      [
        'src/shared/backstage/backstageNotionPartitionMaterialCore.ts',
        BACKSTAGE_NOTION_PARTITION_MATERIAL_CORE_URL,
      ],
      [
        'src/shared/backstage/backstageNotionPartitionRoutingCore.ts',
        BACKSTAGE_NOTION_PARTITION_ROUTING_CORE_URL,
      ],
      [
        'src/shared/backstage/backstageNotionPartitionTelemetryCore.ts',
        BACKSTAGE_NOTION_PARTITION_TELEMETRY_CORE_URL,
      ],
    ]) {
      const sourceText = await readBackstageNotionPartitionSource(sourceUrl);
      const broadenedCryptoImport = replaceRequired(
        sourceText,
        "import { createHash } from 'node:crypto';",
        "import { createHash, randomBytes } from 'node:crypto';"
      );
      expect(findUnsafeRuntimeSyntax(filePath, broadenedCryptoImport)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            'forbidden runtime import binding "randomBytes:randomBytes"'
          ),
        ])
      );
    }
  });

  it('pins only the effect-free predictive/reactive approval policy', async () => {
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).toEqual(
      expect.arrayContaining(['src/shared/selfHealPredictiveApproval.ts'])
    );
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).not.toEqual(
      expect.arrayContaining([
        'src/services/selfImprove/selfHealingLoop.ts',
        'src/services/selfImprove/predictiveHealingService.ts',
      ])
    );

    const sourceText = await readSelfHealPredictiveApprovalSource();
    expect(findUnsafeRuntimeSyntax(
      'src/shared/selfHealPredictiveApproval.ts',
      sourceText
    )).toEqual([]);

    const driftedExecutionRecognition = replaceRequired(
      sourceText,
      "params.execution.status === 'executed'",
      "params.execution.status === 'skipped'"
    );
    expect(findUnsafeRuntimeSyntax(
      'src/shared/selfHealPredictiveApproval.ts',
      driftedExecutionRecognition
    )).toEqual(expect.arrayContaining([
      expect.stringContaining('critical entry file semantic digest'),
    ]));
  });

  it('rejects a broader Research crypto binding or helper semantic drift', async () => {
    const sourceText = await readResearchRequestSource();
    const broaderCryptoImport = replaceRequired(
      sourceText,
      "import { createHash } from 'node:crypto';",
      "import { createHash, randomBytes } from 'node:crypto';"
    );
    expect(findUnsafeRuntimeSyntax(
      'src/shared/researchRequest.ts',
      broaderCryptoImport
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'forbidden runtime import binding "randomBytes:randomBytes"'
      ),
    ]));

    const driftedScope = replaceRequired(
      sourceText,
      "const RESEARCH_STORAGE_HASH_SCOPE = 'research-topic-v1:utf16le\\0';",
      "const RESEARCH_STORAGE_HASH_SCOPE = 'research-topic-v2:utf16le\\0';"
    );
    expect(findUnsafeRuntimeSyntax(
      'src/shared/researchRequest.ts',
      driftedScope
    )).toEqual(expect.arrayContaining([
      expect.stringContaining('critical entry file semantic digest'),
    ]));
  });

  it('pins only the config-free production MCP pre-parser core', async () => {
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).toEqual(
      expect.arrayContaining(['src/mcp/httpBodyParserCore.ts'])
    );
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).not.toEqual(
      expect.arrayContaining([
        'src/mcp/httpBodyParser.ts',
        'src/routes/mcp.ts',
        'src/platform/runtime/config.ts',
      ])
    );

    const sourceText = await readMcpHttpBodyParserCoreSource();
    expect(findUnsafeRuntimeSyntax(
      'src/mcp/httpBodyParserCore.ts',
      sourceText
    )).toEqual([]);

    const widenedHardLimit = replaceRequired(
      sourceText,
      'export const MCP_HTTP_BODY_LIMIT_BYTES = 1024 * 1024;',
      'export const MCP_HTTP_BODY_LIMIT_BYTES = 2 * 1024 * 1024;'
    );
    const relaxedJsonParser = replaceRequired(
      sourceText,
      '    strict: true,',
      '    strict: false,'
    );
    for (const driftedSource of [widenedHardLimit, relaxedJsonParser]) {
      expect(findUnsafeRuntimeSyntax(
        'src/mcp/httpBodyParserCore.ts',
        driftedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining('critical entry file semantic digest'),
      ]));
    }
  });

  it('pins only the pure production public Gaming canary component seam', async () => {
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).toEqual(
      expect.arrayContaining([
        'src/services/gamingPublicDispatcher.ts',
        'src/services/publicGamingCanary.ts',
        'src/services/publicGamingCanaryFixture.ts',
      ])
    );
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).not.toEqual(
      expect.arrayContaining([
        'src/routes/gptRouter.ts',
        'src/services/gamingPipeline.ts',
        'src/services/gamingSourceIngestion.ts',
      ])
    );

    const dispatcherSource = await readGamingPublicDispatcherSource();
    const canarySource = await readPublicGamingCanarySource();
    const fixtureSource = await readPublicGamingCanaryFixtureSource();
    for (const [filePath, sourceText] of [
      ['src/services/gamingPublicDispatcher.ts', dispatcherSource],
      ['src/services/publicGamingCanary.ts', canarySource],
      ['src/services/publicGamingCanaryFixture.ts', fixtureSource],
    ]) {
      expect(findUnsafeRuntimeSyntax(filePath, sourceText)).toEqual([]);
    }

    const semanticDrifts = [
      [
        'src/services/gamingPublicDispatcher.ts',
        replaceRequired(
          dispatcherSource,
          "if (expectedAction === 'canary') {",
          "if (expectedAction === 'query') {"
        ),
      ],
      [
        'src/services/publicGamingCanary.ts',
        replaceRequired(
          canarySource,
          "    providerExecution: 'skipped',",
          "    providerExecution: 'passed',"
        ),
      ],
      [
        'src/services/publicGamingCanaryFixture.ts',
        replaceRequired(
          fixtureSource,
          "'ARCANOS_PUBLIC_CANARY_7F31'",
          "'ARCANOS_PUBLIC_CANARY_DRIFT'"
        ),
      ],
    ];
    for (const [filePath, sourceText] of semanticDrifts) {
      expect(findUnsafeRuntimeSyntax(filePath, sourceText)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('critical entry file semantic digest'),
        ])
      );
    }
  });

  it('pins the Research drain wrapper and its narrow request-abort runtime', async () => {
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).toEqual(
      expect.arrayContaining([
        'packages/arcanos-runtime/src/requestAbort.ts',
        'src/routes/_core/researchAbortDrain.ts',
      ])
    );
    expect(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES).not.toEqual(
      expect.arrayContaining([
        'packages/arcanos-runtime/dist/requestAbort.d.ts',
        'src/services/research.ts',
        'src/services/memory.ts',
        'src/shared/webFetcher.ts',
        'src/core/logic/trinityWritingPipeline.ts',
      ])
    );

    const requestAbortSource = await readRequestAbortSource();
    const researchAbortDrainSource = await readResearchAbortDrainSource();
    expect(findUnsafeRuntimeSyntax(
      'packages/arcanos-runtime/src/requestAbort.ts',
      requestAbortSource
    )).toEqual([]);
    expect(findUnsafeRuntimeSyntax(
      'src/routes/_core/researchAbortDrain.ts',
      researchAbortDrainSource
    )).toEqual([]);

    const broadenedTimer = replaceRequired(
      requestAbortSource,
      'const timeoutHandle = setTimeout(',
      'const timeoutHandle = setInterval('
    );
    expect(findUnsafeRuntimeSyntax(
      'packages/arcanos-runtime/src/requestAbort.ts',
      broadenedTimer
    )).toEqual(expect.arrayContaining([
      expect.stringContaining('forbidden setInterval call'),
      expect.stringContaining('critical entry file semantic digest'),
    ]));

    const racedCallback = replaceRequired(
      researchAbortDrainSource,
      'const value = await runWithRequestAbortContext(context, callback);',
      'const value = await Promise.race([runWithRequestAbortContext(context, callback)]);'
    );
    expect(findUnsafeRuntimeSyntax(
      'src/routes/_core/researchAbortDrain.ts',
      racedCallback
    )).toEqual(expect.arrayContaining([
      expect.stringContaining('critical entry file semantic digest'),
    ]));

    const runtimePackageManifest = JSON.parse(await readFile(
      RUNTIME_PACKAGE_MANIFEST_URL,
      'utf8'
    ));
    expect(findRuntimeRequestAbortExportViolations(
      runtimePackageManifest
    )).toEqual([]);
    expect(findRuntimeRequestAbortExportViolations({
      ...runtimePackageManifest,
      exports: {
        ...runtimePackageManifest.exports,
        './requestAbort': {
          ...runtimePackageManifest.exports['./requestAbort'],
          import: './dist/unreviewed.js',
        },
      },
    })).toEqual([
      'packages/arcanos-runtime/package.json: requestAbort export must match the reviewed ESM runtime surface',
    ]);

    const rootTsconfig = JSON.parse(await readFile(ROOT_TSCONFIG_URL, 'utf8'));
    expect(findRuntimeRequestAbortTypeResolutionViolations(
      rootTsconfig
    )).toEqual([]);
    expect(findRuntimeRequestAbortTypeResolutionViolations({
      ...rootTsconfig,
      compilerOptions: {
        ...rootTsconfig.compilerOptions,
        paths: {
          ...rootTsconfig.compilerOptions.paths,
          '@arcanos/runtime/requestAbort': [
            'packages/arcanos-runtime/dist/unreviewed.d.ts',
          ],
        },
      },
    })).toEqual([
      'tsconfig.json: requestAbort path must match the reviewed build target',
    ]);

    const rootPackageManifest = JSON.parse(await readFile(
      ROOT_PACKAGE_MANIFEST_URL,
      'utf8'
    ));
    expect(findNativePrPreviewBuildScriptViolations(
      rootPackageManifest
    )).toEqual([]);
    expect(findNativePrPreviewBuildScriptViolations({
      ...rootPackageManifest,
      scripts: {
        ...rootPackageManifest.scripts,
        build: rootPackageManifest.scripts.build.replace(
          ' && npm run check:native-pr-preview-dist-imports',
          ''
        ),
      },
    })).toEqual([
      'package.json: build must run the reviewed preview dist-import check after alias repair',
    ]);

    const previewDistImportCheckerSource = await readFile(
      PREVIEW_DIST_IMPORT_CHECKER_URL,
      'utf8'
    );
    expect(findPreviewDistImportCheckerDigestViolations(
      previewDistImportCheckerSource
    )).toEqual([]);
    expect(findPreviewDistImportCheckerDigestViolations(
      `${previewDistImportCheckerSource}\n// unreviewed drift`
    )).toEqual([
      'scripts/check-native-pr-preview-dist-imports.mjs: content digest must match the reviewed emitted-import check',
    ]);
  });

  it.each([
    ['fetch("https://example.invalid")', 'forbidden fetch call'],
    ['globalThis.fetch("https://example.invalid")', 'forbidden runtime effect call'],
    ['setImmediate(() => undefined)', 'forbidden setImmediate call'],
    ['setInterval(() => undefined, 1000)', 'forbidden setInterval call'],
    ['queueMicrotask(() => undefined)', 'forbidden queueMicrotask call'],
    ['process.getBuiltinModule("node:fs")', 'forbidden runtime effect call'],
    ['process.exit(1)', 'forbidden process effect capability'],
    ['process.stdout.write("oops")', 'forbidden process effect capability'],
    ['express().listen(8080)', 'forbidden runtime effect call'],
    ['app[`listen`](8080)', 'forbidden runtime effect call'],
    ['new globalThis.Function("return 1")()', 'forbidden runtime effect constructor'],
    ['new setInterval(() => undefined, 10)', 'forbidden runtime effect constructor'],
    ['new setTimeout(() => undefined, 10)', 'forbidden runtime effect constructor'],
    [
      'new globalThis.WebSocket("wss://example.invalid")',
      'forbidden runtime effect constructor',
    ],
    [
      'new globalThis.EventSource("https://example.invalid")',
      'forbidden runtime effect constructor',
    ],
    [
      'class Preview extends (fetch("https://example.invalid") as any) {}',
      'forbidden fetch call',
    ],
    [
      'class Preview extends globalThis.Function {}',
      'forbidden runtime capability reference',
    ],
    [
      'new app.listen(8080)',
      'forbidden runtime effect constructor',
    ],
  ])('rejects an ambient runtime effect: %s', (sourceText, expectedViolation) => {
    expect(findUnsafeRuntimeSyntax(
      'src/nativePrPreviewApplication.ts',
      sourceText
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(expectedViolation),
    ]));
  });

  it.each([
    [
      [
        'const send = globalThis.fetch;',
        'send("https://example.invalid");',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const { setTimeout: delay } = globalThis;',
        'delay(() => undefined, 1);',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const load = process.getBuiltinModule;',
        'load("node:fs");',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const { getBuiltinModule: load } = process;',
        'load("node:fs");',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const runtime = process;',
        'const load = runtime.getBuiltinModule;',
        'load("node:fs");',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const runtime = globalThis.process;',
        'const load = runtime.getBuiltinModule;',
        'load("node:fs");',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const runtime = globalThis.valueOf();',
        'runtime.fetch("https://example.invalid");',
      ].join('\n'),
      'forbidden runtime effect call',
    ],
    [
      [
        'const runtime = process.valueOf();',
        'runtime.getBuiltinModule("node:fs");',
      ].join('\n'),
      'forbidden runtime effect call',
    ],
    [
      [
        'const { fetch: send } = global;',
        'send("https://example.invalid");',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const capabilityName = "fetch";',
        'const send = globalThis[capabilityName];',
        'send("https://example.invalid");',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const { ...ambient } = globalThis;',
        'ambient.fetch("https://example.invalid");',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const listen = express().listen;',
        'listen(8080);',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const start = app.listen.bind(app);',
        'start(8080);',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const { listen: start } = app;',
        'start(8080);',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const start = app[`listen`];',
        'start(8080);',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const { [`listen`]: start } = app;',
        'start(8080);',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const listenerName = "listen";',
        'app[listenerName](8080);',
      ].join('\n'),
      'forbidden dynamic runtime effect call',
    ],
    [
      [
        'const listenerName = "lis" + "ten";',
        'const start = app[listenerName];',
        'start(8080);',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const start = Reflect.get(app, "listen");',
        'start(8080);',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const httpApp = express();',
        'const key = "listen";',
        'const start = httpApp[key];',
        'start(8080);',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const httpd = createServer(() => undefined);',
        'const alias = httpd;',
        'const key = "listen";',
        'const start = alias[key];',
        'start(8080);',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const createListener = createServer;',
        'const httpd = createListener(() => undefined);',
      ].join('\n'),
      'forbidden listener factory capability reference',
    ],
    [
      [
        'const stop = process.exit;',
        'stop(1);',
      ].join('\n'),
      'forbidden process effect capability',
    ],
    [
      [
        'const { exit: stop } = process;',
        'stop(1);',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const holder = { api: express() };',
        'const key = "listen";',
        'const start = holder.api[key];',
        'start(8080);',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'function makeApplication() { return express(); }',
        'const key = "listen";',
        'const start = makeApplication()[key];',
        'start(8080);',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      [
        'const merge = Object.assign;',
        'merge(process.env, { OPENAI_API_KEY: "restored" });',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
    [
      'Object.assign.call(null, process.env, { OPENAI_API_KEY: "restored" });',
      'forbidden runtime capability reference',
    ],
    [
      [
        'const define = Object.defineProperty;',
        'define(process.env, "OPENAI_API_KEY", { value: "restored" });',
      ].join('\n'),
      'forbidden runtime capability reference',
    ],
  ])('rejects an aliased ambient capability: %s', (
    sourceText,
    expectedViolation
  ) => {
    expect(findUnsafeRuntimeSyntax(
      'src/nativePrPreviewApplication.ts',
      sourceText
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(expectedViolation),
    ]));
  });

  it.each([
    'client.fetch("contained-value");',
    'process.env; process.argv; process.execPath; process.platform;',
    'const { execPath, platform } = process; void execPath; void platform;',
    '(process as typeof process).env;',
    'process.env.toString(); process.argv.slice();',
    'type Fetch = typeof globalThis.fetch;',
    'declare class Preview extends globalThis.Function {}',
    'declare class Preview extends (fetch("https://example.invalid") as any) {}',
  ])('allows a non-ambient capability spelling: %s', sourceText => {
    expect(findUnsafeRuntimeSyntax(
      'src/nativePrPreviewApplication.ts',
      sourceText
    )).toEqual([]);
  });

  it.each([
    'process.exitCode = 1;',
    'process.env.OPENAI_API_KEY = "restored";',
    'Object.assign(process.env, { OPENAI_API_KEY: "restored" });',
    'Object.freeze(process.env);',
    'Object.preventExtensions(process.env);',
    'Object.seal(process.env);',
    "process.env.__defineGetter__('OPENAI_API_KEY', () => 'restored');",
    "process.env['__defineSetter__']('OPENAI_API_KEY', () => {});",
    "process.argv.__defineGetter__('0', () => '--evil');",
    "process.argv['__defineSetter__']('0', () => {});",
    "process.argv.forEach((_value, _index, args) => args.push('--evil'));",
    [
      'process.argv.map((_value, _index, args) => {',
      "  args[0] = '--evil';",
      "  return '';",
      '});',
    ].join('\n'),
    [
      'process.argv.reduce((_result, _value, _index, args) => {',
      '  args.splice(0);',
      '  return 0;',
      '}, 0);',
    ].join('\n'),
    'for (process.env.OPENAI_API_KEY in { restored: true }) {}',
    "for (process.argv[0] of ['--evil']) {}",
    [
      'const inheritedEnvironment = process.env;',
      'for (inheritedEnvironment.OPENAI_API_KEY in { restored: true }) {}',
    ].join('\n'),
    [
      "for ({ value: process.env.OPENAI_API_KEY } of [{ value: 'restored' }]) {}",
    ].join('\n'),
    "for ([process.argv[0]] of [['--evil']]) {}",
    '({ value: process.env.NODE_ENV } = { value: "development" });',
    [
      'const inheritedEnvironment = process.env;',
      'inheritedEnvironment.NODE_OPTIONS = "--import=./sentinel.mjs";',
    ].join('\n'),
    [
      'const inheritedArguments = process.argv;',
      'inheritedArguments.splice(1, 1, "sentinel");',
    ].join('\n'),
    [
      'const { value: inherited = process.env } = {};',
      'inherited.OPENAI_API_KEY = "restored";',
    ].join('\n'),
    [
      'const [inherited = process.env] = [];',
      'inherited.OPENAI_API_KEY = "restored";',
    ].join('\n'),
    [
      'function mutate({ target = process.env } = {}) {',
      '  target.OPENAI_API_KEY = "restored";',
      '}',
    ].join('\n'),
    [
      'function mutate([target = process.env] = []) {',
      '  target.OPENAI_API_KEY = "restored";',
      '}',
    ].join('\n'),
    [
      'const inherited = true ? process.env : {};',
      'inherited.OPENAI_API_KEY = "restored";',
    ].join('\n'),
    [
      'const inherited = undefined ?? process.env;',
      'inherited.OPENAI_API_KEY = "restored";',
    ].join('\n'),
    [
      'const inherited = false || process.env;',
      'inherited.OPENAI_API_KEY = "restored";',
    ].join('\n'),
    [
      'const inherited = (undefined, process.env);',
      'inherited.OPENAI_API_KEY = "restored";',
    ].join('\n'),
    [
      'let inherited;',
      'inherited ||= process.env;',
      'inherited.OPENAI_API_KEY = "restored";',
    ].join('\n'),
    [
      'let inherited;',
      'inherited ??= process.env;',
      'inherited.OPENAI_API_KEY = "restored";',
    ].join('\n'),
    [
      'let inherited = process.env;',
      'inherited &&= process.env;',
      'inherited.OPENAI_API_KEY = "restored";',
    ].join('\n'),
    [
      'export let inherited;',
      'inherited ??= process.env;',
    ].join('\n'),
    [
      'const inherited = process.env.valueOf();',
      'inherited.OPENAI_API_KEY = "restored";',
    ].join('\n'),
    [
      'const inherited = process.argv.valueOf();',
      'inherited.splice(0, 1);',
    ].join('\n'),
    [
      'const inherited = process.env.valueOf(undefined);',
      'inherited.OPENAI_API_KEY = "restored";',
    ].join('\n'),
    [
      'const inherited = process.argv.valueOf(1, 2);',
      'inherited.push("--evil");',
    ].join('\n'),
    [
      "const inherited = process.env['valueOf'](null);",
      'inherited.OPENAI_API_KEY = "restored";',
    ].join('\n'),
    [
      'const inherited = process.env.valueOf``;',
      'inherited.OPENAI_API_KEY = "restored";',
    ].join('\n'),
    [
      'const inherited = process.argv.valueOf`ignored`;',
      'inherited.push("--evil");',
    ].join('\n'),
    [
      "const inherited = process.env['valueOf']``;",
      'inherited.OPENAI_API_KEY = "restored";',
    ].join('\n'),
    [
      'const first = process.env;',
      'const second = first.valueOf();',
      'second.OPENAI_API_KEY = "restored";',
    ].join('\n'),
  ])('rejects process state mutation: %s', sourceText => {
    expect(findUnsafeRuntimeSyntax(
      'src/nativePrPreviewApplication.ts',
      sourceText
    )).toEqual(expect.arrayContaining([
      expect.stringContaining('forbidden process'),
    ]));
  });

  it.each([
    [
      'function mutate(target) { target.OPENAI_API_KEY = "restored"; }',
      'mutate(process.env);',
    ].join('\n'),
    [
      'function mutate(target) { target.OPENAI_API_KEY = "restored"; }',
      'const inheritedEnvironment = process.env;',
      'mutate(inheritedEnvironment);',
    ].join('\n'),
    [
      'class Mutator {',
      '  constructor(target) { target.OPENAI_API_KEY = "restored"; }',
      '}',
      'new Mutator(process.env);',
    ].join('\n'),
    [
      'function mutate(target) { target.env.OPENAI_API_KEY = "restored"; }',
      'mutate({ env: process.env });',
    ].join('\n'),
    [
      'function mutate([target]) { target.OPENAI_API_KEY = "restored"; }',
      'mutate([process.env]);',
    ].join('\n'),
    [
      'function mutate(target) { target.OPENAI_API_KEY = "restored"; }',
      'mutate(...[process.env]);',
    ].join('\n'),
    [
      'function mutate(target) { target.OPENAI_API_KEY = "restored"; }',
      'mutate(process.env.valueOf());',
    ].join('\n'),
  ])('rejects a mutable process object passed to an unreviewed call: %s', (
    sourceText
  ) => {
    expect(findUnsafeRuntimeSyntax(
      'src/nativePrPreviewApplication.ts',
      sourceText
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'mutable process object escapes to an unreviewed call'
      ),
    ]));
  });

  it.each([
    'function expose() { return process.env; }',
    'const expose = () => process.env;',
    'function* expose() { yield process.env; }',
    'function expose() { return process.env.valueOf(); }',
    'throw process.env;',
    'const holder = { env: process.env };',
    'const holder = [process.env];',
    'const copiedEnvironment = { ...process.env };',
    'const { ...copiedEnvironment } = process.env;',
    '({ ...copiedEnvironment } = process.env);',
    'const copiedArguments = [...process.argv];',
    'class Holder { env = process.env; }',
    [
      'class Holder {',
      '  constructor(public env = process.env) {}',
      '}',
      'new Holder();',
    ].join('\n'),
    'tag`${process.env}`;',
    'export const inheritedEnvironment = process.env;',
  ])('rejects a mutable process reference escape: %s', sourceText => {
    expect(findUnsafeRuntimeSyntax(
      'src/nativePrPreviewApplication.ts',
      sourceText
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'mutable process object escapes containment'
      ),
    ]));
  });

  it.each([
    'env.OPENAI_API_KEY = "restored";',
    [
      'function mutate(target) {',
      '  target.OPENAI_API_KEY = "restored";',
      '}',
      'mutate(env);',
    ].join('\n'),
    'Object.freeze(env);',
    'return env;',
    '(arguments[0] as NodeJS.ProcessEnv).OPENAI_API_KEY = "restored";',
    [
      'const actual = arguments[0] as NodeJS.ProcessEnv;',
      'actual.OPENAI_API_KEY = "restored";',
    ].join('\n'),
    [
      'function mutate(input) {',
      '  input.environment.OPENAI_API_KEY = "restored";',
      '}',
      'mutate({ environment: arguments[0] });',
    ].join('\n'),
    [
      'if (Date.now() < 0) {',
      '  return arguments[0] as NodeJS.ProcessEnv;',
      '}',
    ].join('\n'),
  ])(
    'rejects mutable environment drift inside the contained child resolver: %s',
    async (insertion) => {
      const sourceText = await readNativePreviewChildSource();
      const marker = [
        '): NativePrPreviewIdentity & { host: string; port: number } {',
        '  if (',
      ].join('\n');
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        [
          '): NativePrPreviewIdentity & { host: string; port: number } {',
          `  ${insertion}`,
          '  if (',
        ].join('\n')
      );

      expect(findUnsafeRuntimeSyntax(
        'src/start-native-pr-preview.ts',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringMatching(
          /forbidden process|forbidden runtime capability|mutable process object/u
        ),
      ]));
    }
  );

  it('rejects a shadowed Object.keys environment reader', async () => {
    const sourceText = await readNativePreviewChildSource();
    const marker = 'const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;';
    const shadow = [
      'const Object = {',
      '  keys(target) {',
      '    target.OPENAI_API_KEY = "restored";',
      '    return [];',
      '  },',
      '};',
    ].join('\n');
    const mutatedSource = replaceRequired(
      sourceText,
      marker,
      `${marker}\n${shadow}`
    );

    expect(findUnsafeRuntimeSyntax(
      'src/start-native-pr-preview.ts',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringMatching(
        /forbidden process|mutable process object/u
      ),
    ]));
  });

  it('rejects reassignment of the reviewed Object.keys reader', async () => {
    const sourceText = await readNativePreviewChildSource();
    const marker = 'const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;';
    const replacement = [
      marker,
      'Object.keys = (target) => {',
      '  target.OPENAI_API_KEY = "restored";',
      '  return [];',
      '};',
    ].join('\n');
    const mutatedSource = replaceRequired(
      sourceText,
      marker,
      replacement
    );

    expect(findUnsafeRuntimeSyntax(
      'src/start-native-pr-preview.ts',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringMatching(
        /mutable process object|reviewed mutable process call/u
      ),
    ]));
  });

  it('rejects destructuring reassignment of the reviewed Object.keys reader', async () => {
    const sourceText = await readNativePreviewChildSource();
    const marker = 'const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;';
    const replacement = [
      marker,
      '({ keys: Object.keys } = {',
      '  keys(target) {',
      '    target.OPENAI_API_KEY = "restored";',
      '    return [];',
      '  },',
      '});',
    ].join('\n');
    const mutatedSource = replaceRequired(
      sourceText,
      marker,
      replacement
    );

    expect(findUnsafeRuntimeSyntax(
      'src/start-native-pr-preview.ts',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringMatching(
        /mutable process object|reviewed mutable process call/u
      ),
    ]));
  });

  it.each([
    [
      'const ObjectAlias = Object;',
      'ObjectAlias.keys = () => [];',
    ].join('\n'),
    [
      'const ObjectAlias = Object;',
      "ObjectAlias['keys'] = () => [];",
    ].join('\n'),
    [
      'const ObjectAlias = Object;',
      '({ keys: ObjectAlias.keys } = { keys: () => [] });',
    ].join('\n'),
  ])(
    'rejects alias mutation of the reviewed global Object receiver: %s',
    async (insertion) => {
      const sourceText = await readNativePreviewChildSource();
      const marker = 'const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;';
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        `${marker}\n${insertion}`
      );

      expect(findUnsafeRuntimeSyntax(
        'src/start-native-pr-preview.ts',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'forbidden reviewed global Object capability reference'
        ),
      ]));
    }
  );

  it.each([
    "process.execPath = 'C:/tmp/other-node.exe';",
    "process.cwd = () => 'C:/tmp';",
  ])(
    'rejects launcher scalar process-member mutation: %s',
    async (insertion) => {
      const sourceText = await readRailwayLauncherSource();
      const marker =
        "import { fileURLToPath, pathToFileURL } from 'node:url';";
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        `${marker}\n${insertion}`
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining('forbidden process state mutation'),
      ]));
    }
  );

  it.each([
    "const LAUNCHER_REPOSITORY_ROOT = 'C:/tmp/alternate-runtime';",
    [
      'const LAUNCHER_REPOSITORY_ROOT =',
      "  fileURLToPath(new URL('../../other', import.meta.url));",
    ].join('\n'),
  ])(
    'rejects launcher repository-root drift: %s',
    async (replacement) => {
      const sourceText = await readRailwayLauncherSource();
      const original = [
        'const LAUNCHER_REPOSITORY_ROOT =',
        "  fileURLToPath(new URL('../', import.meta.url));",
      ].join('\n');
      const mutatedSource = replaceRequired(
        sourceText,
        original,
        replacement
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'native preview repository root must match the exact immutable launcher-relative contract'
        ),
      ]));
    }
  );

  it.each([
    "LAUNCHER_REPOSITORY_ROOT = 'C:/tmp/alternate-runtime';",
    'const URL = class AlternateUrl {};',
  ])(
    'rejects mutation or shadowing of launcher repository-root dependencies: %s',
    async (insertion) => {
      const sourceText = await readRailwayLauncherSource();
      const marker = 'async function main() {';
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        `${insertion}\n\n${marker}`
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'native preview repository root must match the exact immutable launcher-relative contract'
        ),
      ]));
    }
  );

  it.each([
    "delete process.platform;",
    "process.platform = 'win32';",
  ])(
    'rejects mutation of a scalar process member in the contained child: %s',
    async (insertion) => {
      const sourceText = await readNativePreviewChildSource();
      const marker = 'const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;';
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        `${marker}\n${insertion}`
      );

      expect(findUnsafeRuntimeSyntax(
        'src/start-native-pr-preview.ts',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining('forbidden process state mutation'),
      ]));
    }
  );

  it.each([
    "import './nativePrPreviewApplication.js';",
    "void import('./nativePrPreviewApplication.js');",
    "export * from './nativePrPreviewApplication.js';",
    [
      'export {',
      '  createNativePrPreviewApplication,',
      "} from './nativePrPreviewApplication.js';",
    ].join('\n'),
  ])(
    'rejects application evaluation before contained-child validation: %s',
    async (insertion) => {
      const sourceText = await readNativePreviewChildSource();
      const marker = "import { pathToFileURL } from 'node:url';";
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        `${marker}\n${insertion}`
      );

      expect(findUnsafeRuntimeSyntax(
        'src/start-native-pr-preview.ts',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringMatching(
          /application import|local runtime import|local runtime re-export/u
        ),
      ]));
    }
  );

  it.each([
    '  server.listen(port, host);\n  server.listen(port + 1, host);',
    [
      '  server.listen(port, host);',
      '  (() => server.listen(port + 1, host))();',
    ].join('\n'),
  ])(
    'rejects an extra contained-child listener effect: %s',
    async (replacement) => {
      const sourceText = await readNativePreviewChildSource();
      const mutatedSource = replaceRequired(
        sourceText,
        '  server.listen(port, host);',
        replacement
      );

      expect(findUnsafeRuntimeSyntax(
        'src/start-native-pr-preview.ts',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'critical runtime function "listen" body digest'
        ),
      ]));
    }
  );

  it.each([
    "  await listen(server, 1, '127.0.0.1');",
    [
      '  const startListener = listen;',
      "  await startListener(server, 1, '127.0.0.1');",
      '  await listen(server, identity.port, identity.host);',
    ].join('\n'),
    [
      '  await listen(server, identity.port, identity.host);',
      "  await listen(server, 1, '127.0.0.1');",
    ].join('\n'),
  ])(
    'rejects drift in the contained-child listener call site: %s',
    async (replacement) => {
      const sourceText = await readNativePreviewChildSource();
      const mutatedSource = replaceRequired(
        sourceText,
        '  await listen(server, identity.port, identity.host);',
        replacement
      );

      expect(findUnsafeRuntimeSyntax(
        'src/start-native-pr-preview.ts',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringMatching(
          /contained child listener call|listener helper reference/u
        ),
      ]));
    }
  );

  it.each([
    [
      [
        'function requireExactEnvironmentValue(',
        '  env: NodeJS.ProcessEnv,',
        '  name: string,',
        '  expected: string',
        '): void {',
        '  if (env[name] !== expected) {',
        "    throw new Error('PREVIEW_APPLICATION_ENVIRONMENT_INVALID');",
        '  }',
        '}',
      ].join('\n'),
      [
        'function requireExactEnvironmentValue(',
        '  _env: NodeJS.ProcessEnv,',
        '  _name: string,',
        '  _expected: string',
        '): void {}',
      ].join('\n'),
    ],
    [
      'const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;',
      'const COMMIT_PATTERN = /^.*$/u;',
    ],
    [
      'const CHILD_ENVIRONMENT_NAMES = new Set([',
      [
        'const CHILD_ENVIRONMENT_NAMES = new Set([',
        "  'OPENAI_API_KEY',",
      ].join('\n'),
    ],
    [
      'const WINDOWS_RUNTIME_ENVIRONMENT_NAMES = new Set([',
      [
        'const WINDOWS_RUNTIME_ENVIRONMENT_NAMES = new Set([',
        "  'OPENAI_API_KEY',",
      ].join('\n'),
    ],
  ])(
    'rejects drift in a transitive contained-child environment contract: %s',
    async (original, replacement) => {
      const sourceText = await readNativePreviewChildSource();
      const mutatedSource = replaceRequired(
        sourceText,
        original,
        replacement
      );

      expect(findUnsafeRuntimeSyntax(
        'src/start-native-pr-preview.ts',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'critical entry file semantic digest'
        ),
      ]));
    }
  );

  it.each([
    "CHILD_ENVIRONMENT_NAMES.add('OPENAI_API_KEY');",
    "WINDOWS_RUNTIME_ENVIRONMENT_NAMES.add('OPENAI_API_KEY');",
    'COMMIT_PATTERN.compile(/^.*$/u);',
  ])(
    'rejects post-declaration mutation of a child environment contract: %s',
    async (insertion) => {
      const sourceText = await readNativePreviewChildSource();
      const marker = 'const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;';
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        `${marker}\n${insertion}`
      );

      expect(findUnsafeRuntimeSyntax(
        'src/start-native-pr-preview.ts',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'critical entry file semantic digest'
        ),
      ]));
    }
  );

  it('requires environment validation to remain the first child-main statement', async () => {
    const sourceText = await readNativePreviewChildSource();
    const marker = [
      'async function main(): Promise<void> {',
      '  const identity = resolveNativePrPreviewChildEnvironment(process.env);',
    ].join('\n');
    const mutatedSource = replaceRequired(
      sourceText,
      marker,
      [
        'async function main(): Promise<void> {',
        '  void 0;',
        '  const identity = resolveNativePrPreviewChildEnvironment(process.env);',
      ].join('\n')
    );

    expect(findUnsafeRuntimeSyntax(
      'src/start-native-pr-preview.ts',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'reviewed mutable process call contract'
      ),
    ]));
  });

  it('rejects moving child validation into a nested closure', async () => {
    const sourceText = await readNativePreviewChildSource();
    const validation = [
      '  requireExactEnvironmentValue(',
      '    env,',
      "    'ARCANOS_NATIVE_PR_APPLICATION_PREVIEW',",
      "    'v1'",
      '  );',
    ].join('\n');
    const replacement = [
      '  function deferredValidation() {',
      validation.replace(/^/gmu, '  '),
      '  }',
    ].join('\n');
    const mutatedSource = replaceRequired(
      sourceText,
      validation,
      replacement
    );

    expect(findUnsafeRuntimeSyntax(
      'src/start-native-pr-preview.ts',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringMatching(
        /critical runtime function|reviewed mutable process call/u
      ),
    ]));
  });

  it.each([
    [
      'import fs = require("node:fs");',
      'runtime import-equals declaration',
    ],
    [
      'import {} from "node:fs";',
      'external runtime import',
    ],
    [
      'export {} from "node:fs";',
      'external runtime import',
    ],
  ])('rejects an empty or legacy runtime edge: %s', (
    sourceText,
    expectedViolation
  ) => {
    expect(findUnsafeRuntimeSyntax(
      'src/nativePrPreviewApplication.ts',
      sourceText
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(expectedViolation),
    ]));
  });

  it.each([
    'export * from "node:child_process";',
    'export * as childProcessRaw from "node:child_process";',
    'export { exec as launchRaw } from "node:child_process";',
  ])('rejects an external capability re-export: %s', sourceText => {
    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      sourceText
    )).toEqual(expect.arrayContaining([
      expect.stringContaining('external runtime re-export'),
    ]));
  });

  it.each([
    [
      [
        "import { spawn } from 'node:child_process';",
        "spawn(process.execPath, ['dist/start-server.js'], { env: process.env });",
      ].join('\n'),
      'forbidden child process spawn call',
    ],
    [
      "import { get } from 'node:http';",
      'forbidden runtime import binding "get:get"',
    ],
    [
      'express().listen(8080);',
      'forbidden runtime effect call',
    ],
    [
      [
        'function runNativePrApplicationPreview() {',
        '  const spawnSpec = buildNativePrApplicationSpawnSpec();',
        "  spawnProcess(process.execPath, ['dist/start-server.js'], 'web', { env: process.env });",
        '}',
      ].join('\n'),
      'unsafe native preview spawn call',
    ],
    [
      [
        'const spawnSpec = {',
        '  command: process.execPath,',
        '  args: ["evil.js"],',
        '  cwd: process.cwd(),',
        '  env: process.env',
        '};',
        'function runNativePrApplicationPreview() {',
        '  buildNativePrApplicationSpawnSpec();',
        '  spawnProcess(',
        '    spawnSpec.command,',
        '    spawnSpec.args,',
        "    'web',",
        '    { cwd: spawnSpec.cwd, env: spawnSpec.env }',
        '  );',
        '}',
      ].join('\n'),
      'unsafe native preview spawn specification use',
    ],
    [
      [
        'function runNativePrApplicationPreview() {',
        '  const spawnSpec = buildNativePrApplicationSpawnSpec();',
        '  const launch = spawnProcess;',
        '  launch(process.execPath, ["evil.js"], "web", { env: process.env });',
        '  spawnProcess(',
        '    spawnSpec.command,',
        '    spawnSpec.args,',
        "    'web',",
        '    { cwd: spawnSpec.cwd, env: spawnSpec.env }',
        '  );',
        '}',
      ].join('\n'),
      'forbidden spawnProcess capability reference',
    ],
    [
      [
        'function runNativePrApplicationPreview() {',
        '  const spawnSpec = buildNativePrApplicationSpawnSpec();',
        '  Reflect.apply(spawnProcess, null, [',
        '    process.execPath,',
        '    ["evil.js"],',
        '    "web",',
        '    { env: process.env }',
        '  ]);',
        '  spawnProcess(',
        '    spawnSpec.command,',
        '    spawnSpec.args,',
        "    'web',",
        '    { cwd: spawnSpec.cwd, env: spawnSpec.env }',
        '  );',
        '}',
      ].join('\n'),
      'forbidden spawnProcess capability reference',
    ],
    [
      [
        "import { spawn } from 'node:child_process';",
        'spawn.call(undefined, process.execPath, ["evil.js"], { env: process.env });',
      ].join('\n'),
      'forbidden spawn capability reference',
    ],
    [
      [
        "import { spawn } from 'node:child_process';",
        'function buildNativePrApplicationSpawnSpec() {',
        '  return { command: process.execPath, args: [], cwd: process.cwd(), env: process.env };',
        '}',
        'function spawnProcess(command, args, processKind, options = {}) {',
        '  return spawn(command, args, options);',
        '}',
        'function runNativePrApplicationPreview() {',
        '  const spawnSpec = buildNativePrApplicationSpawnSpec();',
        '  const launch = spawn;',
        '  launch(process.execPath, ["evil.js"], { env: process.env });',
        '  spawnProcess(',
        '    spawnSpec.command,',
        '    spawnSpec.args,',
        "    'web',",
        '    { cwd: spawnSpec.cwd, env: spawnSpec.env }',
        '  );',
        '}',
      ].join('\n'),
      'forbidden spawn capability reference',
    ],
    [
      [
        'function buildNativePrApplicationSpawnSpec() {',
        '  return { command: process.execPath, args: [], cwd: process.cwd(), env: process.env };',
        '}',
        'function runNativePrApplicationPreview() {',
        '  function buildNativePrApplicationSpawnSpec() {',
        '    return { command: process.execPath, args: ["evil.js"], cwd: process.cwd(), env: process.env };',
        '  }',
        '  const spawnSpec = buildNativePrApplicationSpawnSpec();',
        '  spawnProcess(',
        '    spawnSpec.command,',
        '    spawnSpec.args,',
        "    'web',",
        '    { cwd: spawnSpec.cwd, env: spawnSpec.env }',
        '  );',
        '}',
      ].join('\n'),
      'unsafe native preview builder declaration',
    ],
    [
      [
        "import { spawn } from 'node:child_process';",
        'function buildNativePrApplicationSpawnSpec() {',
        '  return { command: process.execPath, args: [], cwd: process.cwd(), env: process.env };',
        '}',
        'function spawnProcess(command, args, processKind, options = {}) {',
        '  return spawn(command, args, options);',
        '}',
        'function runNativePrApplicationPreview() {',
        '  function spawnProcess(command, args, processKind, options = {}) {',
        '    return spawn(command, args, options);',
        '  }',
        '  const spawnSpec = buildNativePrApplicationSpawnSpec();',
        '  spawnProcess(',
        '    spawnSpec.command,',
        '    spawnSpec.args,',
        "    'web',",
        '    { cwd: spawnSpec.cwd, env: spawnSpec.env }',
        '  );',
        '}',
      ].join('\n'),
      'unsafe spawnProcess declaration',
    ],
    [
      [
        'function runNativePrApplicationPreview() {',
        '  const spawnSpec = buildNativePrApplicationSpawnSpec();',
        '  function launchUnapprovedChild() {',
        '    spawnProcess(process.execPath, ["evil.js"], "web", { env: process.env });',
        '  }',
        '  launchUnapprovedChild();',
        '  spawnProcess(',
        '    spawnSpec.command,',
        '    spawnSpec.args,',
        "    'web',",
        '    { cwd: spawnSpec.cwd, env: spawnSpec.env }',
        '  );',
        '}',
      ].join('\n'),
      'unsafe native preview spawn call',
    ],
    [
      [
        'function runNativePrApplicationPreview() {',
        '  const spawnSpec = buildNativePrApplicationSpawnSpec();',
        '  spawnSpec.env = process.env;',
        '  spawnProcess(',
        '    spawnSpec.command,',
        '    spawnSpec.args,',
        "    'web',",
        '    { cwd: spawnSpec.cwd, env: spawnSpec.env }',
        '  );',
        '}',
      ].join('\n'),
      'unsafe native preview spawn specification use',
    ],
    [
      [
        'function runNativePrApplicationPreview() {',
        '  const spawnSpec = buildNativePrApplicationSpawnSpec();',
        '  spawnSpec.args.push("--inspect");',
        '  spawnProcess(',
        '    spawnSpec.command,',
        '    spawnSpec.args,',
        "    'web',",
        '    { cwd: spawnSpec.cwd, env: spawnSpec.env }',
        '  );',
        '}',
      ].join('\n'),
      'unsafe native preview spawn specification use',
    ],
    [
      [
        'function runNativePrApplicationPreview() {',
        '  const spawnSpec = buildNativePrApplicationSpawnSpec();',
        '  Object.assign(spawnSpec, { env: process.env });',
        '  spawnProcess(',
        '    spawnSpec.command,',
        '    spawnSpec.args,',
        "    'web',",
        '    { cwd: spawnSpec.cwd, env: spawnSpec.env }',
        '  );',
        '}',
      ].join('\n'),
      'unsafe native preview spawn specification use',
    ],
    [
      [
        'function runNativePrApplicationPreview() {',
        '  const spawnSpec = buildNativePrApplicationSpawnSpec();',
        '  function mutateSpawnSpec() {',
        '    spawnSpec.env = process.env;',
        '  }',
        '  mutateSpawnSpec();',
        '  spawnProcess(',
        '    spawnSpec.command,',
        '    spawnSpec.args,',
        "    'web',",
        '    { cwd: spawnSpec.cwd, env: spawnSpec.env }',
        '  );',
        '}',
      ].join('\n'),
      'unsafe native preview spawn specification use',
    ],
    [
      [
        'function runNativePrApplicationPreview() {',
        '  const spawnSpec = buildNativePrApplicationSpawnSpec();',
        '  spawnProcess(',
        '    spawnSpec.command,',
        '    spawnSpec.args,',
        "    'web',",
        '    {',
        '      cwd: process.cwd(),',
        '      cwd: spawnSpec.cwd,',
        '      env: spawnSpec.env',
        '    }',
        '  );',
        '}',
      ].join('\n'),
      'unsafe native preview spawn call',
    ],
  ])('rejects Railway launcher effect drift: %s', (
    sourceText,
    expectedViolation
  ) => {
    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      sourceText
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(expectedViolation),
    ]));
  });

  it.each([
    [
      'src/nativePrPreviewApplication.ts',
      "import { static as serveFiles } from 'express';",
      'forbidden runtime import binding "static:serveFiles"',
    ],
    [
      'src/nativePrPreviewApplication.ts',
      "import web from 'express';",
      'forbidden runtime import binding "default:web"',
    ],
    [
      'src/shared/jobs/jobReadCapability.ts',
      "import { randomBytes } from 'node:crypto';",
      'forbidden runtime import binding "randomBytes:randomBytes"',
    ],
    [
      'src/shared/gpt/gptJobResult.ts',
      "import { ZodError } from 'zod';",
      'forbidden runtime import binding "ZodError:ZodError"',
    ],
    [
      'src/shared/http/clientJsonPayload.ts',
      "import { static as serveFiles } from 'express';",
      'unreviewed external runtime import binding surface for "express"',
    ],
    [
      'src/nativePrPreviewApplication.ts',
      "import * as schemas from 'zod';",
      'unreviewed external runtime import binding surface for "zod"',
    ],
    [
      'src/nativePrPreviewApplication.ts',
      "import * as crypto from 'node:crypto';",
      'forbidden runtime import binding "*:crypto"',
    ],
    [
      'src/nativePrPreviewApplication.ts',
      "import { createHash, randomBytes } from 'node:crypto';",
      'forbidden runtime import binding "randomBytes:randomBytes"',
    ],
  ])('rejects unreviewed external runtime binding: %s', (
    filePath,
    sourceText,
    expectedViolation
  ) => {
    expect(findUnsafeRuntimeSyntax(
      filePath,
      sourceText
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(expectedViolation),
    ]));
  });

  it.each([
    'await runWebRuntime();',
    'maybeStartCliBridgeDaemon();',
    'await runWorkerRuntimeWithHealthServer();',
    'const launchProduction = runWebRuntime; await launchProduction();',
  ])(
    'rejects a production call from the complete native launcher: %s',
    async (insertion) => {
      const sourceText = await readRailwayLauncherSource();
      const marker = 'async function runNativePrApplicationPreview() {';
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        `${marker}\n  ${insertion}`
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining('forbidden native preview launch call'),
      ]));
    }
  );

  it('rejects a complete launcher that hides the exact spawn in control flow', async () => {
    const sourceText = await readRailwayLauncherSource();
    const original = [
      '  const previewProcess = spawnProcess(',
      '    spawnSpec.command,',
      '    spawnSpec.args,',
      "    'web',",
      '    {',
      '      cwd: spawnSpec.cwd,',
      '      env: spawnSpec.env',
      '    }',
      '  );',
    ].join('\n');
    const replacement = [
      '  for (;;) {',
      ...original.split('\n').map((line) => `  ${line}`),
      '    break;',
      '  }',
    ].join('\n');

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      replaceRequired(sourceText, original, replacement)
    )).toEqual(expect.arrayContaining([
      expect.stringContaining('unsafe native preview spawn call'),
    ]));
  });

  it('rejects a second main entrypoint invocation', async () => {
    const sourceText = await readRailwayLauncherSource();
    const mutatedSource = `${sourceText}\nawait main();\n`;

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'forbidden launcher helper capability reference'
      ),
    ]));
  });

  it('rejects removal of the guarded main entrypoint', async () => {
    const sourceText = await readRailwayLauncherSource();
    const original = [
      "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {",
      '  await main();',
      '}',
    ].join('\n');

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      replaceRequired(sourceText, original, 'await main();')
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'forbidden launcher helper capability reference'
      ),
    ]));
  });

  it('rejects relocation of the sole production web call into the native branch', async () => {
    const sourceText = await readRailwayLauncherSource();
    const withoutProductionCall = replaceRequired(
      sourceText,
      '\n    await runWebRuntime();\n',
      '\n'
    );
    const marker = '      if (nativePrPreview.runtimeMode === \'application\') {';
    const mutatedSource = replaceRequired(
      withoutProductionCall,
      marker,
      `${marker}\n        await runWebRuntime();`
    );

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'forbidden launcher helper capability reference'
      ),
    ]));
  });

  it('rejects reassignment of the credential-empty child environment builder', async () => {
    const sourceText = await readRailwayLauncherSource();
    const marker =
      'export function buildNativePrApplicationSpawnSpec(env = process.env) {';
    const mutatedSource = replaceRequired(
      sourceText,
      marker,
      [
        'buildNativePrApplicationChildEnvironment = buildChildEnvironment;',
        '',
        marker,
      ].join('\n')
    );

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'forbidden launcher helper capability reference'
      ),
    ]));
  });

  it.each([
    [
      'export function resolveNativePrPreviewOrThrow(args = process.argv.slice(2), env = process.env) {',
      [
        'export function resolveNativePrPreviewOrThrow(args = process.argv.slice(2), env = process.env) {',
        '  if (arguments.length === 0) return { enabled: false };',
      ].join('\n'),
      'resolveNativePrPreviewOrThrow',
    ],
    [
      'export function resolveNativePrPreviewOrThrow(args = process.argv.slice(2), env = process.env) {',
      [
        'export function resolveNativePrPreviewOrThrow(args = process.argv.slice(2), env = process.env) {',
        '  if (env === process.env) return { enabled: false };',
      ].join('\n'),
      'resolveNativePrPreviewOrThrow',
    ],
    [
      '  return childEnvironment;',
      '  return env;',
      'buildNativePrApplicationChildEnvironment',
    ],
    [
      '  const childEnvironment = {',
      [
        '  const childEnvironment = {',
        '    ...env,',
      ].join('\n'),
      'buildNativePrApplicationChildEnvironment',
    ],
    [
      '  const listener = resolveHealthListenerConfig(env);',
      [
        '  if (env === process.env) return { ...process.env };',
        '  const listener = resolveHealthListenerConfig(env);',
      ].join('\n'),
      'buildNativePrApplicationChildEnvironment',
    ],
  ])(
    'rejects safety-critical launcher function body drift in %s',
    async (original, replacement, functionName) => {
      const sourceText = await readRailwayLauncherSource();
      const mutatedSource = replaceRequired(
        sourceText,
        original,
        replacement
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          `critical launcher function "${functionName}" body digest`
        ),
      ]));
    }
  );

  it.each([
    [
      'export function buildNativePrApplicationSpawnSpec(env = process.env) {',
      'export async function buildNativePrApplicationSpawnSpec(env = process.env) {',
      'unsafe native preview spawn specification builder',
    ],
    [
      'export function buildNativePrApplicationSpawnSpec(env = process.env) {',
      'export function* buildNativePrApplicationSpawnSpec(env = process.env) {',
      'unsafe native preview spawn specification builder',
    ],
    [
      'function spawnProcess(command, args, processKind, options = {}) {',
      'async function spawnProcess(command, args, processKind, options = {}) {',
      'unsafe spawnProcess wrapper',
    ],
    [
      'function spawnProcess(command, args, processKind, options = {}) {',
      'function* spawnProcess(command, args, processKind, options = {}) {',
      'unsafe spawnProcess wrapper',
    ],
  ])(
    'rejects async or generator drift in exact launcher helpers: %s',
    async (original, replacement, expectedViolation) => {
      const sourceText = await readRailwayLauncherSource();
      const mutatedSource = replaceRequired(
        sourceText,
        original,
        replacement
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(expectedViolation),
      ]));
    }
  );

  it.each([
    'nativePrPreview.enabled = false;',
    'delete nativePrPreview.enabled;',
    "Object.defineProperty(nativePrPreview, 'enabled', { value: false });",
  ])(
    'rejects mutation of native preview selection before its branch: %s',
    async (insertion) => {
      const sourceText = await readRailwayLauncherSource();
      const marker = '    if (nativePrPreview.enabled) {';
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        `    ${insertion}\n${marker}`
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'launcher helper call surface must match the reviewed contract'
        ),
      ]));
    }
  );

  it('rejects reassignment of the native preview resolver before selection', async () => {
    const sourceText = await readRailwayLauncherSource();
    const marker =
      '    const nativePrPreview = resolveNativePrPreviewOrThrow();';
    const mutatedSource = replaceRequired(
      sourceText,
      marker,
      [
        '    resolveNativePrPreviewOrThrow = () => ({ enabled: false });',
        marker,
      ].join('\n')
    );

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'forbidden launcher helper capability reference'
      ),
    ]));
  });

  it.each([
    'process.argv[1] = fileURLToPath(import.meta.url);',
    [
      'const launcherArgv = process.argv;',
      'launcherArgv[1] = fileURLToPath(import.meta.url);',
    ].join('\n'),
    "process.argv.splice(1, 1, fileURLToPath(import.meta.url));",
    'const { argv: launcherArgv } = process;',
  ])(
    'rejects mutation or extraction of process.argv before the main guard: %s',
    async (insertion) => {
      const sourceText = await readRailwayLauncherSource();
      const marker =
        "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {";
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        `${insertion}\n${marker}`
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'launcher process.argv use must match the reviewed read-only contract'
        ),
      ]));
    }
  );

  it.each([
    [
      'async function runWebRuntime() {',
      'export async function runWebRuntime() {',
    ],
    [
      'async function main() {',
      'export async function main() {',
    ],
    [
      'function spawnProcess(command, args, processKind, options = {}) {',
      'export function spawnProcess(command, args, processKind, options = {}) {',
    ],
    [
      'async function runNativePrApplicationPreview() {',
      'export async function runNativePrApplicationPreview() {',
    ],
  ])(
    'rejects direct export of a privileged launcher helper: %s',
    async (original, replacement) => {
      const sourceText = await readRailwayLauncherSource();
      const mutatedSource = replaceRequired(
        sourceText,
        original,
        replacement
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'forbidden privileged launcher helper export'
        ),
      ]));
    }
  );

  it('rejects a complete launcher that reaches a new spawn helper', async () => {
    const sourceText = await readRailwayLauncherSource();
    const marker = 'async function runNativePrApplicationPreview() {';
    const helper = [
      'function launchUnapprovedChild() {',
      '  return spawnProcess(',
      '    process.execPath,',
      '    ["evil.js"],',
      '    "web",',
      '    { env: process.env }',
      '  );',
      '}',
      '',
      marker,
      '  launchUnapprovedChild();',
    ].join('\n');

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      replaceRequired(sourceText, marker, helper)
    )).toEqual(expect.arrayContaining([
      expect.stringContaining('forbidden native preview launch call'),
    ]));
  });

  it('rejects a complete launcher that passes process.env to a new helper', async () => {
    const sourceText = await readRailwayLauncherSource();
    const marker =
      "import { fileURLToPath, pathToFileURL } from 'node:url';";
    const insertion = [
      'function mutate(target) {',
      '  target.OPENAI_API_KEY = "restored";',
      '}',
      'mutate(process.env);',
    ].join('\n');
    const mutatedSource = replaceRequired(
      sourceText,
      marker,
      `${marker}\n${insertion}`
    );

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'mutable process object escapes to an unreviewed call'
      ),
    ]));
  });

  it('rejects a shadowed reviewed environment helper in the complete launcher', async () => {
    const sourceText = await readRailwayLauncherSource();
    const marker =
      'export function buildNativePrApplicationChildEnvironment(env = process.env) {';
    const insertion = [
      marker,
      '  function resolveHealthListenerConfig(target) {',
      '    target.OPENAI_API_KEY = "restored";',
      '    return { host: "0.0.0.0", port: 3000 };',
      '  }',
      '  resolveHealthListenerConfig(process.env);',
    ].join('\n');
    const mutatedSource = replaceRequired(
      sourceText,
      marker,
      insertion
    );

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringMatching(
        /forbidden process|mutable process object/u
      ),
    ]));
  });

  it.each([
    [
      '({ resolveHealthListenerConfig } = {',
      '  resolveHealthListenerConfig(target) {',
      '    target.OPENAI_API_KEY = "restored";',
      '    return { host: "0.0.0.0", port: 3000 };',
      '  },',
      '});',
    ].join('\n'),
    [
      '[resolveHealthListenerConfig] = [function replacement(target) {',
      '  target.OPENAI_API_KEY = "restored";',
      '  return { host: "0.0.0.0", port: 3000 };',
      '}];',
    ].join('\n'),
    [
      'for (resolveHealthListenerConfig of [function replacement(target) {',
      '  target.OPENAI_API_KEY = "restored";',
      '  return { host: "0.0.0.0", port: 3000 };',
      '}]) {}',
    ].join('\n'),
  ])(
    'rejects indirect reassignment of a reviewed environment helper: %s',
    async (insertion) => {
      const sourceText = await readRailwayLauncherSource();
      const marker = 'async function main() {';
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        `${insertion}\n\n${marker}`
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'reviewed mutable process call contract'
        ),
      ]));
    }
  );

  it('rejects an extra reviewed environment call in the complete launcher', async () => {
    const sourceText = await readRailwayLauncherSource();
    const marker =
      'export function buildNativePrApplicationChildEnvironment(env = process.env) {';
    const mutatedSource = replaceRequired(
      sourceText,
      marker,
      `${marker}\n  resolveHealthListenerConfig(env);`
    );

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'reviewed mutable process call contract'
      ),
    ]));
  });

  it.each([
    [
      "    'RAILWAY_SERVICE_ID',",
      "    'RAILWAY_ENVIRONMENT_ID',",
    ],
    [
      'const providerBaseUrl = firstConfiguredValue(env, OPENAI_BASE_URL_ENV_NAMES);',
      'const providerBaseUrl = firstConfiguredValue(env, OPENAI_API_KEY_ENV_NAMES);',
    ],
  ])(
    'rejects drift in non-environment arguments of a reviewed call: %s',
    async (original, replacement) => {
      const sourceText = await readRailwayLauncherSource();
      const mutatedSource = replaceRequired(
        sourceText,
        original,
        replacement
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'reviewed mutable process call contract'
        ),
        expect.stringContaining(
          'full-call digest mismatch'
        ),
      ]));
    }
  );

  it('rejects drift in the reviewed production environment spread', async () => {
    const sourceText = await readRailwayLauncherSource();
    const mutatedSource = replaceRequired(
      sourceText,
      "RUN_WORKERS: processKind === 'worker' ? 'true' : 'false',",
      "RUN_WORKERS: processKind === 'worker' ? '1' : '0',"
    );

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'reviewed mutable process spread function'
      ),
    ]));
  });

  it('rejects another call to the reviewed production environment builder', async () => {
    const sourceText = await readRailwayLauncherSource();
    const marker =
      "import { fileURLToPath, pathToFileURL } from 'node:url';";
    const mutatedSource = replaceRequired(
      sourceText,
      marker,
      `${marker}\nbuildChildEnvironment('web');`
    );

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'reviewed mutable process spread function'
      ),
    ]));
  });

  it.each([
    [
      'const copyProductionEnvironment = buildChildEnvironment;',
      "const inheritedEnvironment = copyProductionEnvironment('web');",
      'console.log(inheritedEnvironment.OPENAI_API_KEY);',
    ].join('\n'),
    [
      'const helpers = { buildChildEnvironment };',
      "const inheritedEnvironment = helpers.buildChildEnvironment('web');",
      'console.log(inheritedEnvironment.OPENAI_API_KEY);',
    ].join('\n'),
    'export { buildChildEnvironment };',
    'export { buildChildEnvironment as copyProductionEnvironment };',
  ])(
    'rejects extraction or export of the production environment builder: %s',
    async (insertion) => {
      const sourceText = await readRailwayLauncherSource();
      const marker = 'async function main() {';
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        `${insertion}\n\n${marker}`
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'forbidden launcher helper capability reference'
        ),
      ]));
    }
  );

  it.each([
    'buildChildEnvironment = isCliBridgeEnabled;',
    [
      '({ buildChildEnvironment } = {',
      '  buildChildEnvironment: isCliBridgeEnabled,',
      '});',
    ].join('\n'),
  ])(
    'rejects reassignment of the reviewed production environment builder: %s',
    async (insertion) => {
      const sourceText = await readRailwayLauncherSource();
      const marker = 'async function main() {';
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        `${insertion}\n\n${marker}`
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'reviewed mutable process spread function'
        ),
      ]));
    }
  );

  it.each([
    'destination.end();',
    'mutate(destination);',
    'options.leakedDestination = destination;',
  ])(
    'rejects drift in the reviewed worker output mirror: %s',
    async (insertion) => {
      const sourceText = await readRailwayLauncherSource();
      const marker =
        '  const observeReadiness = options.observeReadiness !== false;';
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        `${insertion}\n${marker}`
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'critical launcher function "mirrorAndObserveWorkerOutput" body digest'
        ),
      ]));
    }
  );

  it.each([
    '  workerProcess.stdout = workerProcess.stderr;',
    "  workerProcess.stdout?.removeAllListeners('data');",
  ])(
    'rejects mutation of the reviewed worker output source: %s',
    async (insertion) => {
      const sourceText = await readRailwayLauncherSource();
      const marker = [
        '  mirrorAndObserveWorkerOutput(',
        '    workerProcess.stdout,',
      ].join('\n');
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        `${insertion}\n${marker}`
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'critical launcher function "runWorkerRuntimeWithHealthServer" body digest'
        ),
      ]));
    }
  );

  it.each([
    'recordWorkerOutput = () => undefined;',
    'recordWorkerExit = (state) => state;',
    'createWorkerReadinessState = () => ({ ready: true });',
    [
      'buildWorkerReadinessResponse = () => ({',
      '  statusCode: 200,',
      '  body: { ready: true },',
      '});',
    ].join('\n'),
  ])(
    'rejects replacement of a transitive worker readiness helper: %s',
    async (insertion) => {
      const sourceText = await readRailwayLauncherSource();
      const marker = 'async function main() {';
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        `${insertion}\n\n${marker}`
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'critical entry file semantic digest'
        ),
      ]));
    }
  );

  it.each([
    '  childProcess.stdout = childProcess.stderr;',
    "  childProcess.stdout?.removeAllListeners('data');",
  ])(
    'rejects output mutation inside the child-exit observer: %s',
    async (insertion) => {
      const sourceText = await readRailwayLauncherSource();
      const marker =
        'export function waitForExit(childProcess, options = {}) {';
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        `${marker}\n${insertion}`
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'critical entry file semantic digest'
        ),
      ]));
    }
  );

  it.each([
    'waitForExit = isCliBridgeEnabled;',
    [
      '({ waitForExit } = {',
      '  waitForExit: isCliBridgeEnabled,',
      '});',
    ].join('\n'),
  ])(
    'rejects reassignment of the child-exit observer: %s',
    async (insertion) => {
      const sourceText = await readRailwayLauncherSource();
      const marker = 'async function main() {';
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        `${insertion}\n\n${marker}`
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'critical entry file semantic digest'
        ),
      ]));
    }
  );

  it.each([
    'mirrorAndObserveWorkerOutput = (_stream, destination) => destination.end();',
    [
      '({ mirrorAndObserveWorkerOutput } = {',
      '  mirrorAndObserveWorkerOutput: (_stream, destination) => destination.end(),',
      '});',
    ].join('\n'),
  ])(
    'rejects reassignment of the reviewed worker output mirror: %s',
    async (insertion) => {
      const sourceText = await readRailwayLauncherSource();
      const marker = 'async function main() {';
      const mutatedSource = replaceRequired(
        sourceText,
        marker,
        `${insertion}\n\n${marker}`
      );

      expect(findUnsafeRuntimeSyntax(
        'scripts/start-railway-service.mjs',
        mutatedSource
      )).toEqual(expect.arrayContaining([
        expect.stringContaining(
          'forbidden launcher helper capability reference'
        ),
      ]));
    }
  );

  it.each([
    'spawnProcess(process.execPath, ["evil.js"], "web", { env: process.env });',
    '(() => spawnProcess(process.execPath, ["evil.js"], "web", { env: process.env }))();',
  ])('rejects a module-evaluation spawn path: %s', async (insertion) => {
    const sourceText = await readRailwayLauncherSource();
    const marker =
      "import { fileURLToPath, pathToFileURL } from 'node:url';";
    const mutatedSource = replaceRequired(
      sourceText,
      marker,
      `${marker}\n${insertion}`
    );

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringContaining('forbidden spawnProcess capability reference'),
    ]));
  });

  it.each([
    'void runWebRuntime();',
    'const launchProduction = runWebRuntime; void launchProduction();',
  ])('rejects a module-evaluation production helper path: %s', async (insertion) => {
    const sourceText = await readRailwayLauncherSource();
    const marker =
      "import { fileURLToPath, pathToFileURL } from 'node:url';";
    const mutatedSource = replaceRequired(
      sourceText,
      marker,
      `${marker}\n${insertion}`
    );

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'forbidden launcher helper capability reference'
      ),
    ]));
  });

  it.each([
    'await runWebRuntime();',
    'const launchProduction = runWebRuntime; await launchProduction();',
  ])('rejects a production helper path in the main native branch: %s', async (insertion) => {
    const sourceText = await readRailwayLauncherSource();
    const marker = '    if (nativePrPreview.enabled) {';
    const mutatedSource = replaceRequired(
      sourceText,
      marker,
      `${marker}\n      ${insertion}`
    );

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'forbidden launcher helper capability reference'
      ),
    ]));
  });

  it('rejects a complete launcher whose spawn wrapper ignores the checked specification', async () => {
    const sourceText = await readRailwayLauncherSource();
    const original = [
      'function spawnProcess(command, args, processKind, options = {}) {',
      '  return spawn(command, args, {',
      "    stdio: options.stdio ?? 'inherit',",
      '    env: options.env ?? buildChildEnvironment(processKind),',
      '    cwd: options.cwd',
      '  });',
      '}',
    ].join('\n');
    const replacement = [
      'function spawnProcess(command, args, processKind, options = {}) {',
      '  return spawn(process.execPath, ["dist/start-server.js"], {',
      '    env: process.env,',
      '    cwd: process.cwd()',
      '  });',
      '}',
    ].join('\n');

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      replaceRequired(sourceText, original, replacement)
    )).toEqual(expect.arrayContaining([
      expect.stringContaining('unsafe spawnProcess wrapper'),
    ]));
  });

  it('rejects a complete launcher whose spawn-spec builder restores inherited credentials', async () => {
    const sourceText = await readRailwayLauncherSource();
    const original = [
      'export function buildNativePrApplicationSpawnSpec(env = process.env) {',
      '  return {',
      '    args: [',
      "      '--max-old-space-size=512',",
      "      'dist/start-native-pr-preview.js'",
      '    ],',
      '    command: process.execPath,',
      '    cwd: LAUNCHER_REPOSITORY_ROOT,',
      '    env: buildNativePrApplicationChildEnvironment(env)',
      '  };',
      '}',
    ].join('\n');
    const replacement = original.replace(
      'env: buildNativePrApplicationChildEnvironment(env)',
      'env: process.env'
    );

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      replaceRequired(sourceText, original, replacement)
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'unsafe native preview spawn specification builder'
      ),
    ]));
  });

  it('rejects a shared spawn-spec alias mutated by the complete native launcher', async () => {
    const sourceText = await readRailwayLauncherSource();
    const withSharedAlias = replaceRequired(
      sourceText,
      'export function buildNativePrApplicationSpawnSpec(env = process.env) {\n  return {',
      'let leakedPreviewSpec;\n\nexport function buildNativePrApplicationSpawnSpec(env = process.env) {\n  return leakedPreviewSpec = {'
    );
    const marker = 'async function runNativePrApplicationPreview() {';
    const mutatedSource = replaceRequired(
      withSharedAlias,
      marker,
      `${marker}\n  leakedPreviewSpec.env = process.env;`
    );

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(
        'unsafe native preview spawn specification builder'
      ),
    ]));
  });

  it.each([
    'export { spawn as launchRaw };',
    'export { spawnProcess as launchRaw };',
  ])('rejects an exported launcher effect alias: %s', async (exportText) => {
    const sourceText = await readRailwayLauncherSource();
    const marker = "import { spawn } from 'node:child_process';";
    const mutatedSource = replaceRequired(
      sourceText,
      marker,
      `${marker}\n${exportText}`
    );

    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      mutatedSource
    )).toEqual(expect.arrayContaining([
      expect.stringContaining('capability reference'),
    ]));
  });
});

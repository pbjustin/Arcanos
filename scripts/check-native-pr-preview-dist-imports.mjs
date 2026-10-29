#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const currentScriptPath = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(currentScriptPath), '..');
const RUNTIME_TARGET_FILE =
  'packages/arcanos-runtime/dist/requestAbort.js';
const RUNTIME_TARGET_SEMANTIC_DIGEST =
  '3d819666e59abbefb9e90b13daab1a5bcff74728728fe82a5e76451250dbef95';

export const NATIVE_PR_PREVIEW_DIST_IMPORT_CONTRACT = Object.freeze([
  Object.freeze({
    filePath: 'dist/chatgpt/bookerCore.js',
    specifier: '../../packages/arcanos-runtime/dist/requestAbort.js',
    bindings: Object.freeze(["getRequestAbortSignal:getRequestAbortSignal"]),
  }),
  Object.freeze({
    filePath: 'dist/routes/chatgptBookerMcpCore.js',
    specifier: '../../packages/arcanos-runtime/dist/requestAbort.js',
    bindings: Object.freeze(["getRequestAbortSignal:getRequestAbortSignal","getRequestRemainingMs:getRequestRemainingMs","runWithRequestAbortTimeout:runWithRequestAbortTimeout"]),
  }),
  Object.freeze({
    filePath: 'dist/bookerMcpPreviewFixture.js',
    specifier: '../packages/arcanos-runtime/dist/requestAbort.js',
    bindings: Object.freeze(["getRequestAbortSignal:getRequestAbortSignal"]),
  }),
  Object.freeze({
    filePath: 'dist/shared/http/clientDisconnectAbort.js',
    specifier: '../../../packages/arcanos-runtime/dist/requestAbort.js',
    bindings: Object.freeze(["createAbortError:createAbortError","runWithRequestAbortContext:runWithRequestAbortContext"]),
  }),

  Object.freeze({
    bindings: Object.freeze([
      'getRequestAbortContext:getRequestAbortContext',
      'runWithRequestAbortTimeout:runWithRequestAbortTimeout',
    ]),
    filePath: 'dist/nativePrPreviewApplication.js',
    specifier: '../packages/arcanos-runtime/dist/requestAbort.js',
  }),
  Object.freeze({
    bindings: Object.freeze([
      'createAbortError:createAbortError',
      'createLinkedAbortController:createLinkedAbortController',
      'runWithRequestAbortContext:runWithRequestAbortContext',
    ]),
    filePath: 'dist/routes/_core/researchAbortDrain.js',
    specifier: '../../../packages/arcanos-runtime/dist/requestAbort.js',
  }),
]);

// Validation compatibility reaches only the reviewed pure Zod helpers. Pin the
// emitted leaves and their direct consumers without admitting runtime adapters.
export const ZOD_VALIDATION_PREVIEW_DIST_IMPORT_CONTRACT = Object.freeze([
  ...[
    'dist/shared/validation/zodIssues.js',
    'dist/shared/validation/zodNumberChecks.js',
    'dist/shared/validation/zodStringChecks.js',
  ].map(filePath => Object.freeze({
    filePath,
    imports: Object.freeze({ zod: Object.freeze(['z:z']) }),
  })),
  Object.freeze({
    filePath: 'dist/shared/http/validation.js',
    imports: Object.freeze({
      './errors.js': Object.freeze(['sendBadRequest:sendBadRequest', 'sendValidationError:sendValidationError']),
      '../validation/zodIssues.js': Object.freeze(['formatZodIssues:formatZodIssues']),
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/gaming/gamingClearPolicy.js',
    imports: Object.freeze({
      'node:crypto': Object.freeze(['createHash:createHash']),
      zod: Object.freeze(['z:z']),
      '../validation/zodStringChecks.js': Object.freeze(['legacyDatetime:legacyDatetime', 'utf16MaxLength:utf16MaxLength']),
      './gamingFreshnessCore.js': Object.freeze(['classifyGamingQuestionFreshness:classifyGamingQuestionFreshness']),
      './gamingFreshnessDisposition.js': Object.freeze(['resolveGamingFreshnessDisposition:resolveGamingFreshnessDisposition']),
      './gamingGameRegistry.js': Object.freeze(['GAMING_GAME_REGISTRY:GAMING_GAME_REGISTRY']),
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/gaming/gamingHybridContract.js',
    imports: Object.freeze({
      zod: Object.freeze(['z:z']),
      '../validation/zodNumberChecks.js': Object.freeze(['legacyInteger:legacyInteger']),
      '../validation/zodStringChecks.js': Object.freeze(['legacyUuid:legacyUuid', 'utf16MaxLength:utf16MaxLength']),
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/security/gptAccessDevice.js',
    imports: Object.freeze({
      zod: Object.freeze(['z:z']),
      '../validation/zodStringChecks.js': Object.freeze(['legacyUuid:legacyUuid', 'utf16MaxLength:utf16MaxLength']),
    }),
  }),
]);

// This sealed fixture reaches only the production honesty functions and their
// four pure helpers. Check every emitted edge, including the leaf modules.
export const TUTOR_HONESTY_PREVIEW_DIST_IMPORT_CONTRACT = Object.freeze([
  Object.freeze({
    filePath: 'dist/shared/chatgpt/tutorHonestyPreviewFixture.js',
    imports: Object.freeze({
      '../../core/logic/trinityHonesty.js': Object.freeze([
        'createDefaultTrinityReasoningHonesty:createDefaultTrinityReasoningHonesty',
        'deriveTrinityCapabilityFlags:deriveTrinityCapabilityFlags',
        'deriveTrinityOutputControls:deriveTrinityOutputControls',
        'enforceFinalStageHonestyAndMinimalism:enforceFinalStageHonestyAndMinimalism',
        'prepareTrinityDirectAnswerHonesty:prepareTrinityDirectAnswerHonesty',
      ]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/core/logic/trinityHonesty.js',
    imports: Object.freeze({
      '../../shared/text/countWords.js': Object.freeze(['countWords:countWords']),
      '../../shared/text/creativeDialogue.js': Object.freeze(['hasCreativeDialogue:hasCreativeDialogue']),
      '../../shared/text/intentModeClassifier.js': Object.freeze(['classifyIntentMode:classifyIntentMode']),
      '../../shared/promptGuidance.js': Object.freeze(['renderPromptGuidanceSections:renderPromptGuidanceSections']),
    }),
  }),
  ...[
    'dist/shared/text/countWords.js',
    'dist/shared/text/creativeDialogue.js',
    'dist/shared/text/intentModeClassifier.js',
    'dist/shared/promptGuidance.js',
  ].map(filePath => Object.freeze({ filePath, imports: Object.freeze({}) })),
]);

// The structured validator shares only Ajv and the already reviewed pure honesty graph.
export const FINAL_OUTPUT_INTEGRITY_PREVIEW_DIST_IMPORT_CONTRACT = Object.freeze([
  Object.freeze({
    filePath: 'dist/shared/gpt/trinityFinalOutputPreviewFixture.js',
    imports: Object.freeze({
      '../../core/logic/trinityStructuredOutput.js': Object.freeze([
        'createTrinityStructuredOutputValidator:createTrinityStructuredOutputValidator',
        'TrinityStructuredOutputError:TrinityStructuredOutputError',
      ]),
      '../../core/logic/trinityHonesty.js': Object.freeze([
        'createDefaultTrinityReasoningHonesty:createDefaultTrinityReasoningHonesty',
        'deriveTrinityCapabilityFlags:deriveTrinityCapabilityFlags',
        'deriveTrinityOutputControls:deriveTrinityOutputControls',
        'enforceFinalStageHonestyAndMinimalism:enforceFinalStageHonestyAndMinimalism',
      ]),
      '../../core/logic/trinityDirectAnswerMode.js': Object.freeze([
        'applyTrinityDirectAnswerOutputContract:applyTrinityDirectAnswerOutputContract',
      ]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/core/logic/trinityStructuredOutput.js',
    imports: Object.freeze({
      ajv: Object.freeze(['Ajv:Ajv']),
      './trinityHonesty.js': Object.freeze([
        'deriveTrinityOutputControls:deriveTrinityOutputControls',
        'enforceFinalStageHonesty:enforceFinalStageHonesty',
        'enforceFinalStageHonestyAndMinimalism:enforceFinalStageHonestyAndMinimalism',
        'readIntentMode:readIntentMode',
      ]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/core/logic/trinityDirectAnswerMode.js',
    imports: Object.freeze({
      '../../services/directAnswerMode.js': Object.freeze([
        'buildDirectAnswerModeSystemInstruction:buildDirectAnswerModeSystemInstruction',
      ]),
    }),
  }),
  Object.freeze({ filePath: 'dist/services/directAnswerMode.js', imports: Object.freeze({}) }),
]);

// The CLI core stays at scripts/ in the image. No filesystem/private-input
// adapters may enter this emitted fixture graph, including through its leaf.
export const PLUGIN_MIGRATION_PREVIEW_DIST_IMPORT_CONTRACT = Object.freeze([
  Object.freeze({
    filePath: 'dist/shared/chatgpt/chatgptTutorPreviewFixture.js',
    imports: Object.freeze({
      '../../../scripts/native-pr-preview-contract.mjs': Object.freeze(['NATIVE_PR_PREVIEW_E2E_CONTRACT:NATIVE_PR_PREVIEW_E2E_CONTRACT']),
      './tutorHonestyPreviewFixture.js': Object.freeze(['assertTutorHonestyPreviewFixture:assertTutorHonestyPreviewFixture']),
      './pluginMigrationPreviewFixture.js': Object.freeze(['assertPluginMigrationPreviewFixture:assertPluginMigrationPreviewFixture']),
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/chatgpt/pluginMigrationPreviewFixture.js',
    imports: Object.freeze({
      '../../../scripts/tutor-package-core.mjs': Object.freeze([
        'assertArtifactDigest:assertArtifactDigest',
        'assertTutorAppMapping:assertTutorAppMapping',
        'assertTutorPackageManifestIdentity:assertTutorPackageManifestIdentity',
        'digest:digest',
        'packageFingerprint:packageFingerprint',
      ]),
    }),
  }),
  Object.freeze({
    filePath: 'scripts/tutor-package-core.mjs',
    imports: Object.freeze({ 'node:crypto': Object.freeze(['createHash:createHash']) }),
  }),
]);

// The served model-policy fixture shares only these pure production functions.
// Neither the configuration/credential adapter nor the SDK graph may enter it.
export const GENERATIVE_MODEL_POLICY_PREVIEW_DIST_IMPORT_CONTRACT = Object.freeze([
  Object.freeze({
    filePath: 'dist/shared/gpt/generativeModelPolicyPreviewFixture.js',
    imports: Object.freeze({
      './generativeModelPolicyCore.js': Object.freeze([
        'GenerativeModelPolicyError:GenerativeModelPolicyError',
        'assertGenerativeModelResponseIdentity:assertGenerativeModelResponseIdentity',
        'resolveGenerativeModelFromConfig:resolveGenerativeModelFromConfig',
      ]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/gpt/generativeModelPolicyCore.js',
    imports: Object.freeze({
      './arcanosBehavioralProfile.js': Object.freeze(['isArcanosBehavioralProfileId:isArcanosBehavioralProfileId']),
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/gpt/arcanosBehavioralProfile.js',
    imports: Object.freeze({}),
  }),
]);

export const GAMING_MCP_PREVIEW_DIST_IMPORT_CONTRACT = Object.freeze([
  Object.freeze({
    filePath: 'dist/shared/chatgpt/gamingMcpPreviewFixture.js',
    imports: Object.freeze({
      '../../../scripts/native-pr-preview-contract.mjs': Object.freeze(['NATIVE_PR_PREVIEW_E2E_CONTRACT:NATIVE_PR_PREVIEW_E2E_CONTRACT']),
      './pluginMigrationPreviewFixture.js': Object.freeze(['assertPluginMigrationPreviewFixture:assertPluginMigrationPreviewFixture']),
      './gamingMcpContract.js': Object.freeze([
        'gamingMcpTools:gamingMcpTools', 'gamingMcpWritePolicyError:gamingMcpWritePolicyError',
        'isGamingMcpInput:isGamingMcpInput', 'isGamingMcpOutput:isGamingMcpOutput',
        'isGamingMcpToolName:isGamingMcpToolName', 'isGamingMcpWrite:isGamingMcpWrite',
        'GAMING_QUERY_SCOPE:GAMING_QUERY_SCOPE', 'GAMING_WRITE_SCOPE:GAMING_WRITE_SCOPE',
      ]),
      './gamingCompositionPreviewFixture.js': Object.freeze(['assertGamingCompositionPreviewFixture:assertGamingCompositionPreviewFixture']),
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/chatgpt/gamingMcpContract.js',
    imports: Object.freeze({
      ajv: Object.freeze(['Ajv:Ajv']),
      '@arcanos/protocol/chatgptGaming': Object.freeze(['CHATGPT_GAMING_TOOL_NAMES:CHATGPT_GAMING_TOOL_NAMES', 'chatGptGamingSchemas:chatGptGamingSchemas']),
    }),
  }),
  Object.freeze({
    filePath: 'packages/protocol/dist/src/chatgptGaming.js',
    imports: Object.freeze({ '../schemas/v1/tools/arcanos-gaming/contract.schema.json': Object.freeze(['default:contract']) }),
  }),
]);

// The same pure section mapper used by private composition receives only fixed
// synthetic text here. Keep the filesystem adapters and public/private inputs out.
export const GAMING_COMPOSITION_PREVIEW_DIST_IMPORT_CONTRACT = Object.freeze([
  Object.freeze({
    filePath: 'dist/shared/chatgpt/gamingCompositionPreviewFixture.js',
    imports: Object.freeze({
      '../../../scripts/skill-composition-core.mjs': Object.freeze([
        'instructionSectionMap:instructionSectionMap',
        'transformInstructionSections:transformInstructionSections',
      ]),
    }),
  }),
  Object.freeze({
    filePath: 'scripts/skill-composition-core.mjs',
    imports: Object.freeze({ './tutor-package-core.mjs': Object.freeze(['digest:digest']) }),
  }),
]);

// Exact emitted closure of the shared Booker transport, verifier and contained profiles.
export const BOOKER_MCP_PREVIEW_DIST_IMPORT_CONTRACT = Object.freeze([
  Object.freeze({
    filePath: 'dist/bookerMcpRealAuthPreview.js',
    imports: Object.freeze({
      'express': Object.freeze(['default:express']),
      './routes/chatgptBookerMcpCore.js': Object.freeze(['createChatGptBookerMcpRouterCore:createChatGptBookerMcpRouterCore']),
      './chatgpt/bookerAuthCore.js': Object.freeze(['bookerAuthChallenge:bookerAuthChallenge', 'createBookerTokenVerifierCore:createBookerTokenVerifierCore', 'readBookerAuthConfigurationCore:readBookerAuthConfigurationCore']),
      './shared/chatgpt/bookerMcpContract.js': Object.freeze(['BOOKER_MCP_PATH:BOOKER_MCP_PATH', 'BOOKER_METADATA_PATH:BOOKER_METADATA_PATH']),
    }),
  }),
  Object.freeze({
    filePath: 'packages/protocol/dist/src/chatgptBooker.js',
    imports: Object.freeze({
      '../schemas/v1/tools/arcanos-booker/contract.schema.json': Object.freeze(["default:contract"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/chatgpt/authCore.js',
    imports: Object.freeze({
      'jose': Object.freeze(["createRemoteJWKSet:createRemoteJWKSet","jwtVerify:jwtVerify"]),
      '../shared/security/opaqueSecret.js': Object.freeze(["timingSafeEqualOpaqueSecret:timingSafeEqualOpaqueSecret"]),
      '../shared/security/purposeBoundCredential.js': Object.freeze(["PURPOSE_BOUND_CREDENTIAL_ENV_NAMES:PURPOSE_BOUND_CREDENTIAL_ENV_NAMES"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/chatgpt/bookerAuthCore.js',
    imports: Object.freeze({
      'node:crypto': Object.freeze(["createHash:createHash"]),
      '../shared/chatgpt/bookerMcpContract.js': Object.freeze(["BOOKER_GENERATE_SCOPE:BOOKER_GENERATE_SCOPE","BOOKER_MCP_PATH:BOOKER_MCP_PATH","BOOKER_METADATA_PATH:BOOKER_METADATA_PATH","BOOKER_READ_SCOPE:BOOKER_READ_SCOPE"]),
      './authCore.js': Object.freeze(["createScopedChatGptTokenVerifierCore:createScopedChatGptTokenVerifierCore","hasVerifiedChatGptPermission:hasVerifiedChatGptPermission","readHttpsIdentifier:readHttpsIdentifier"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/chatgpt/bookerCore.js',
    imports: Object.freeze({
      '../../packages/arcanos-runtime/dist/requestAbort.js': Object.freeze(["getRequestAbortSignal:getRequestAbortSignal"]),
      '../platform/runtime/sessionContext.js': Object.freeze(["runWithSessionContext:runWithSessionContext"]),
      '../shared/chatgpt/bookerMcpContract.js': Object.freeze(["isBookerMcpInput:isBookerMcpInput","getBookerMcpOutputValidationIssues:getBookerMcpOutputValidationIssues","requiresBookerGenerationPermission:requiresBookerGenerationPermission"]),
      '../shared/backstage/backstageBookerAsyncContinuation.js': Object.freeze(["buildBackstageBookerProtectedFailureState:buildBackstageBookerProtectedFailureState"]),
      '../shared/backstage/backstageProtectedFailure.js': Object.freeze(["readProtectedBackstageCompletionProvenance:readProtectedBackstageCompletionProvenance"]),
      './bookerAuthCore.js': Object.freeze(["bookerPrincipalActorKey:bookerPrincipalActorKey","hasBookerPermission:hasBookerPermission"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/platform/runtime/security.js',
    imports: Object.freeze({
      'node:crypto': Object.freeze(["default:crypto"]),
      '../../shared/security/opaqueSecret.js': Object.freeze(["buildAuthenticatedCredentialActorKey:buildAuthenticatedCredentialActorKey"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/platform/runtime/sessionContext.js',
    imports: Object.freeze({
      'node:async_hooks': Object.freeze(["AsyncLocalStorage:AsyncLocalStorage"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/routes/chatgptBookerMcpCore.js',
    imports: Object.freeze({
      'express': Object.freeze(["default:express"]),
      'node:util': Object.freeze(["TextDecoder:TextDecoder"]),
      '@modelcontextprotocol/sdk/server/index.js': Object.freeze(["Server:Server"]),
      '@modelcontextprotocol/sdk/server/streamableHttp.js': Object.freeze(["StreamableHTTPServerTransport:StreamableHTTPServerTransport"]),
      '@modelcontextprotocol/sdk/types.js': Object.freeze(["CallToolRequestSchema:CallToolRequestSchema","ListToolsRequestSchema:ListToolsRequestSchema"]),
      '../../packages/arcanos-runtime/dist/requestAbort.js': Object.freeze(["getRequestAbortSignal:getRequestAbortSignal","getRequestRemainingMs:getRequestRemainingMs","runWithRequestAbortTimeout:runWithRequestAbortTimeout"]),
      '../shared/http/clientDisconnectAbort.js': Object.freeze(["createClientDisconnectAbortScope:createClientDisconnectAbortScope"]),
      '../platform/runtime/security.js': Object.freeze(["createRateLimitMiddleware:createRateLimitMiddleware"]),
      '../shared/chatgpt/bookerMcpContract.js': Object.freeze(["BOOKER_MCP_PATH:BOOKER_MCP_PATH","BOOKER_METADATA_PATH:BOOKER_METADATA_PATH","bookerMcpTools:bookerMcpTools","isBookerMcpInput:isBookerMcpInput","getBookerMcpOutputValidationIssues:getBookerMcpOutputValidationIssues","isBookerMcpToolName:isBookerMcpToolName","requiresBookerGenerationPermission:requiresBookerGenerationPermission"]),
      '../chatgpt/bookerAuthCore.js': Object.freeze(["bookerAuthChallenge:bookerAuthChallenge","bookerPrincipalActorKey:bookerPrincipalActorKey","bookerProtectedResourceMetadata:bookerProtectedResourceMetadata","createBookerTokenVerifierCore:createBookerTokenVerifierCore","hasBookerPermission:hasBookerPermission"]),
      '../chatgpt/bookerCore.js': Object.freeze(["BookerMcpError:BookerMcpError"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/services/backstageBookerClear.js',
    imports: Object.freeze({
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/backstage/backstageBookerAsyncContinuation.js',
    imports: Object.freeze({
      './backstageProtectedFailure.js': Object.freeze(["readProtectedBackstageCompletionProvenance:readProtectedBackstageCompletionProvenance","resolveBackstageProtectedFailureCode:resolveBackstageProtectedFailureCode"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/backstage/backstageBookerAsyncResultCore.js',
    imports: Object.freeze({
      './backstageQueuedJobResultProtection.js': Object.freeze(["isProtectedBackstageQueuedGptJobEnvelope:isProtectedBackstageQueuedGptJobEnvelope","markProtectedBackstageQueuedGptJobResultMaterialized:markProtectedBackstageQueuedGptJobResultMaterialized","resolveProtectedBackstageQueuedGptJobEnvelopeAction:resolveProtectedBackstageQueuedGptJobEnvelopeAction","unprotectBackstageQueuedGptJobOutput:unprotectBackstageQueuedGptJobOutput"]),
      './backstageBookerAsyncContinuation.js': Object.freeze(["projectBackstageBookerManagedJobResultPayload:projectBackstageBookerManagedJobResultPayload","projectBackstageBookerManagedProtectedFailurePayload:projectBackstageBookerManagedProtectedFailurePayload"]),
      './backstageProtectedFailure.js': Object.freeze(["readProtectedBackstageCompletionProvenance:readProtectedBackstageCompletionProvenance","readProtectedBackstageFailureCode:readProtectedBackstageFailureCode"]),
      '../gpt/gptIdempotency.js': Object.freeze(["buildGptIdempotencyScopeHash:buildGptIdempotencyScopeHash","resolvePublicGptJobCreationSurface:resolvePublicGptJobCreationSurface"]),
      '../gpt/gptJobLifecycle.js': Object.freeze(["isGptJobTerminalStatus:isGptJobTerminalStatus"]),
      '../gpt/gptJobResult.js': Object.freeze(["buildGptJobResultLookupPayload:buildGptJobResultLookupPayload"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/backstage/backstageContinuityQueryCore.js',
    imports: Object.freeze({
      './backstageNotionSnapshotStatus.js': Object.freeze(["BACKSTAGE_NOTION_SYNC_ATTEMPT_OUTCOMES:BACKSTAGE_NOTION_SYNC_ATTEMPT_OUTCOMES","BACKSTAGE_NOTION_SYNC_FAILURE_PHASES:BACKSTAGE_NOTION_SYNC_FAILURE_PHASES","BACKSTAGE_NOTION_SYNC_FAILURE_REASONS:BACKSTAGE_NOTION_SYNC_FAILURE_REASONS"]),
      './backstageNotionSyncCore.js': Object.freeze(["BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT:BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/backstage/backstageJobPayloadProtection.js',
    imports: Object.freeze({
      'node:crypto': Object.freeze(["createCipheriv:createCipheriv","createDecipheriv:createDecipheriv","createHash:createHash","randomBytes:randomBytes","timingSafeEqual:timingSafeEqual"]),
      '../security/purposeBoundCredential.js': Object.freeze(["hasConfiguredPurposeBoundCredentialCollision:hasConfiguredPurposeBoundCredentialCollision","resolveConfiguredPurposeBoundCredential:resolveConfiguredPurposeBoundCredential"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/backstage/backstageMatchSimulationCore.js',
    imports: Object.freeze({
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/backstage/backstageNotionScopeIndex.js',
    imports: Object.freeze({
      'node:crypto': Object.freeze(["createHash:createHash"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/backstage/backstageNotionSnapshotStatus.js',
    imports: Object.freeze({
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/backstage/backstageNotionSyncCore.js',
    imports: Object.freeze({
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/backstage/backstageProtectedFailure.js',
    imports: Object.freeze({
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/backstage/backstageQueuedJobResultProtection.js',
    imports: Object.freeze({
      './backstageJobPayloadProtection.js': Object.freeze(["BACKSTAGE_JOB_PAYLOAD_OUTPUT_PURPOSE:BACKSTAGE_JOB_PAYLOAD_OUTPUT_PURPOSE","sealBackstageJobPayload:sealBackstageJobPayload","unsealBackstageJobPayload:unsealBackstageJobPayload"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/chatgpt/bookerMcpContract.js',
    imports: Object.freeze({
      'ajv/dist/2020.js': Object.freeze(["Ajv2020:Ajv2020"]),
      '@arcanos/protocol/chatgptBooker': Object.freeze(["CHATGPT_BOOKER_TOOL_NAMES:CHATGPT_BOOKER_TOOL_NAMES","chatGptBookerSchemas:chatGptBookerSchemas"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/bookerMcpPreviewFixture.js',
    imports: Object.freeze({
      'express': Object.freeze(["default:express"]),
      'node:crypto': Object.freeze(["createHash:createHash"]),
      'jose': Object.freeze(["createLocalJWKSet:createLocalJWKSet"]),
      '../packages/arcanos-runtime/dist/requestAbort.js': Object.freeze(["getRequestAbortSignal:getRequestAbortSignal"]),
      './routes/chatgptBookerMcpCore.js': Object.freeze(["createChatGptBookerMcpRouterCore:createChatGptBookerMcpRouterCore"]),
      './chatgpt/bookerCore.js': Object.freeze(["createBookerMcpExecutorCore:createBookerMcpExecutorCore"]),
      './chatgpt/bookerAuthCore.js': Object.freeze(["bookerPrincipalActorKey:bookerPrincipalActorKey","createBookerTokenVerifierCore:createBookerTokenVerifierCore","readBookerAuthConfigurationCore:readBookerAuthConfigurationCore"]),
      '../scripts/booker-mcp-preview-key.mjs': Object.freeze(["BOOKER_PREVIEW_CLIENT_ID:BOOKER_PREVIEW_CLIENT_ID","BOOKER_PREVIEW_ISSUER:BOOKER_PREVIEW_ISSUER","BOOKER_PREVIEW_PUBLIC_JWK:BOOKER_PREVIEW_PUBLIC_JWK","BOOKER_PREVIEW_SUBJECT:BOOKER_PREVIEW_SUBJECT","BOOKER_PREVIEW_UNIVERSE_ID:BOOKER_PREVIEW_UNIVERSE_ID"]),
      './shared/chatgpt/bookerMcpContract.js': Object.freeze(["BOOKER_MCP_PATH:BOOKER_MCP_PATH","BOOKER_METADATA_PATH:BOOKER_METADATA_PATH"]),
      './shared/backstage/backstageContinuityQueryCore.js': Object.freeze(["buildBackstageContinuityResponse:buildBackstageContinuityResponse","isBackstageContinuityCursorRequestValid:isBackstageContinuityCursorRequestValid"]),
      './shared/backstage/backstageNotionScopeIndex.js': Object.freeze(["normalizeBackstageNotionScopePath:normalizeBackstageNotionScopePath"]),
      './shared/backstage/backstageNotionSnapshotStatus.js': Object.freeze(["resolveBackstageNotionSnapshotStatusObservation:resolveBackstageNotionSnapshotStatusObservation"]),
      './shared/backstage/backstageMatchSimulationCore.js': Object.freeze(["simulateBackstageMatchCore:simulateBackstageMatchCore"]),
      './services/backstageBookerClear.js': Object.freeze(["BACKSTAGE_BOOKER_CLEAR_GENERATION_POLICY_MARKER:BACKSTAGE_BOOKER_CLEAR_GENERATION_POLICY_MARKER","buildBackstageBookerClearGenerationPolicy:buildBackstageBookerClearGenerationPolicy"]),
      './shared/backstage/backstageBookerAsyncContinuation.js': Object.freeze(["buildBackstageBookerProtectedFailureState:buildBackstageBookerProtectedFailureState"]),
      './shared/backstage/backstageProtectedFailure.js': Object.freeze(["buildProtectedBackstageFailureEnvelope:buildProtectedBackstageFailureEnvelope"]),
      './shared/backstage/backstageBookerAsyncResultCore.js': Object.freeze(["readBackstageBookerAsyncResultCore:readBackstageBookerAsyncResultCore"]),
      './shared/backstage/backstageQueuedJobResultProtection.js': Object.freeze(["protectBackstageQueuedGptJobOutput:protectBackstageQueuedGptJobOutput"]),
      './shared/backstage/backstageJobPayloadProtection.js': Object.freeze(["resolveBackstageJobPayloadProtectionConfig:resolveBackstageJobPayloadProtectionConfig","sealBackstageJobPayload:sealBackstageJobPayload"]),
      './shared/gpt/gptIdempotency.js': Object.freeze(["buildGptIdempotencyScopeHash:buildGptIdempotencyScopeHash"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/gpt/gptIdempotency.js',
    imports: Object.freeze({
      'node:crypto': Object.freeze(["default:crypto"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/gpt/gptJobLifecycle.js',
    imports: Object.freeze({
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/gpt/gptJobResult.js',
    imports: Object.freeze({
      'zod': Object.freeze(["z:z"]),
      '../jobs/jobLinks.js': Object.freeze(["buildJobResultPollPath:buildJobResultPollPath"]),
      './gptJobLifecycle.js': Object.freeze(["resolveGptJobLifecycleStatus:resolveGptJobLifecycleStatus"]),
      '../backstage/backstageQueuedJobResultProtection.js': Object.freeze(["hasProtectedBackstageQueuedGptJobMarker:hasProtectedBackstageQueuedGptJobMarker","isProtectedBackstageQueuedGptJobResultMaterialized:isProtectedBackstageQueuedGptJobResultMaterialized"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/http/clientDisconnectAbort.js',
    imports: Object.freeze({
      '../../../packages/arcanos-runtime/dist/requestAbort.js': Object.freeze(["createAbortError:createAbortError","runWithRequestAbortContext:runWithRequestAbortContext"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/jobs/jobLinks.js',
    imports: Object.freeze({
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/security/opaqueSecret.js',
    imports: Object.freeze({
      'node:crypto': Object.freeze(["createHash:createHash","timingSafeEqual:timingSafeEqual"]),
    }),
  }),
  Object.freeze({
    filePath: 'dist/shared/security/purposeBoundCredential.js',
    imports: Object.freeze({
      './opaqueSecret.js': Object.freeze(["timingSafeEqualOpaqueSecret:timingSafeEqualOpaqueSecret"]),
    }),
  }),
  Object.freeze({
    filePath: 'scripts/booker-mcp-preview-key.mjs',
    imports: Object.freeze({
      'jose': Object.freeze(["SignJWT:SignJWT","importJWK:importJWK"]),
    }),
  }),
]);

function runtimeImportBindings(node) {
  const importClause = node.importClause;
  if (!importClause || importClause.isTypeOnly) {
    return [];
  }
  const bindings = [];
  if (importClause.name) {
    bindings.push(`default:${importClause.name.text}`);
  }
  const namedBindings = importClause.namedBindings;
  if (namedBindings && ts.isNamespaceImport(namedBindings)) {
    bindings.push(`namespace:${namedBindings.name.text}`);
  } else if (namedBindings) {
    for (const element of namedBindings.elements) {
      if (!element.isTypeOnly) {
        bindings.push(
          `${element.propertyName?.text ?? element.name.text}:${element.name.text}`
        );
      }
    }
  }
  return bindings.sort();
}

function isRuntimePackageSpecifier(specifier) {
  return (
    specifier.startsWith('@arcanos/runtime')
    || specifier.includes('packages/arcanos-runtime/')
  );
}

export function findRuntimeTargetSemanticDigestViolations(sourceText) {
  const sourceFile = ts.createSourceFile(
    RUNTIME_TARGET_FILE,
    sourceText.replace(/\r\n?/gu, '\n'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: true,
  });
  const observedDigest = createHash('sha256')
    .update(
      printer.printNode(
        ts.EmitHint.Unspecified,
        sourceFile,
        sourceFile
      )
    )
    .digest('hex');
  if (observedDigest === RUNTIME_TARGET_SEMANTIC_DIGEST) {
    return [];
  }
  return [
    `${RUNTIME_TARGET_FILE}: semantic digest must match the reviewed request-abort runtime build`,
  ];
}

export function findNativePrPreviewDistImportSourceViolations(
  contract,
  sourceText
) {
  const sourceFile = ts.createSourceFile(
    contract.filePath,
    sourceText.replace(/\r\n?/gu, '\n'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  const runtimeImports = sourceFile.statements.filter((statement) => (
    ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && isRuntimePackageSpecifier(statement.moduleSpecifier.text)
  ));
  const violations = [];
  if (runtimeImports.length !== 1) {
    violations.push(
      `${contract.filePath}: expected one reviewed runtime package import`
    );
    return violations;
  }
  const [runtimeImport] = runtimeImports;
  const observedSpecifier = runtimeImport.moduleSpecifier.text;
  if (observedSpecifier !== contract.specifier) {
    violations.push(
      `${contract.filePath}: runtime package import must target ${contract.specifier}`
    );
  }
  const observedBindings = runtimeImportBindings(runtimeImport);
  const expectedBindings = [...contract.bindings].sort();
  if (
    observedBindings.length !== expectedBindings.length
    || observedBindings.some(
      (binding, index) => binding !== expectedBindings[index]
    )
  ) {
    violations.push(
      `${contract.filePath}: runtime package import bindings must match the reviewed surface`
    );
  }
  return violations;
}

export function findTutorHonestyPreviewDistImportSourceViolations(contract, sourceText) {
  const sourceFile = ts.createSourceFile(
    contract.filePath,
    sourceText.replace(/\r\n?/gu, '\n'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  const violations = [];
  const observedImports = sourceFile.statements
    .filter(statement => ts.isImportDeclaration(statement))
    .map(statement => JSON.stringify([
      ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null,
      runtimeImportBindings(statement),
    ]))
    .sort();
  const expectedImports = Object.entries(contract.imports)
    .map(([specifier, bindings]) => JSON.stringify([specifier, [...bindings].sort()]))
    .sort();
  if (sourceFile.parseDiagnostics.length > 0
    || observedImports.length !== expectedImports.length
    || observedImports.some((entry, index) => entry !== expectedImports[index])) {
    violations.push(`${contract.filePath}: emitted sealed preview imports must match the reviewed pure graph`);
  }
  const inspect = node => {
    if ((ts.isExportDeclaration(node) && node.moduleSpecifier)
      || ts.isImportEqualsDeclaration(node)
      || (ts.isCallExpression(node) && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      ))) {
      violations.push(`${contract.filePath}: emitted sealed preview graph must not use dynamic imports or runtime re-exports`);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  return [...new Set(violations)].sort();
}

export async function findNativePrPreviewDistImportViolations({
  repositoryRoot = REPOSITORY_ROOT,
} = {}) {
  const violations = [];
  const expectedRuntimeTarget = path.resolve(
    repositoryRoot,
    RUNTIME_TARGET_FILE
  );
  try {
    const runtimeTargetSource = await fs.readFile(
      expectedRuntimeTarget,
      'utf8'
    );
    violations.push(
      ...findRuntimeTargetSemanticDigestViolations(runtimeTargetSource)
    );
  } catch {
    violations.push(`${RUNTIME_TARGET_FILE}: built runtime target is missing`);
  }

  for (const contract of NATIVE_PR_PREVIEW_DIST_IMPORT_CONTRACT) {
    const resolvedImportTarget = path.resolve(
      repositoryRoot,
      path.dirname(contract.filePath),
      contract.specifier
    );
    if (resolvedImportTarget !== expectedRuntimeTarget) {
      violations.push(
        `${contract.filePath}: reviewed import does not resolve to ${RUNTIME_TARGET_FILE}`
      );
    }
    try {
      const sourceText = await fs.readFile(
        path.join(repositoryRoot, contract.filePath),
        'utf8'
      );
      violations.push(
        ...findNativePrPreviewDistImportSourceViolations(
          contract,
          sourceText
        )
      );
    } catch {
      violations.push(`${contract.filePath}: built preview module is missing`);
    }
  }
  for (const contract of [...TUTOR_HONESTY_PREVIEW_DIST_IMPORT_CONTRACT,
    ...FINAL_OUTPUT_INTEGRITY_PREVIEW_DIST_IMPORT_CONTRACT,
    ...PLUGIN_MIGRATION_PREVIEW_DIST_IMPORT_CONTRACT, ...GAMING_MCP_PREVIEW_DIST_IMPORT_CONTRACT,
    ...GAMING_COMPOSITION_PREVIEW_DIST_IMPORT_CONTRACT,
    ...GENERATIVE_MODEL_POLICY_PREVIEW_DIST_IMPORT_CONTRACT,
    ...BOOKER_MCP_PREVIEW_DIST_IMPORT_CONTRACT,
    ...ZOD_VALIDATION_PREVIEW_DIST_IMPORT_CONTRACT]) {
    try {
      const sourceText = await fs.readFile(path.join(repositoryRoot, contract.filePath), 'utf8');
      violations.push(...findTutorHonestyPreviewDistImportSourceViolations(contract, sourceText));
    } catch {
      violations.push(`${contract.filePath}: reviewed sealed preview module is missing`);
    }
  }
  return [...new Set(violations)].sort();
}

export async function runCliCheck() {
  const violations = await findNativePrPreviewDistImportViolations();
  if (violations.length > 0) {
    console.error('check:native-pr-preview-dist-imports failed');
    console.error(JSON.stringify(violations, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(
    'check:native-pr-preview-dist-imports passed: emitted preview imports match the reviewed runtime, honesty and migration-package core graphs.'
  );
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(currentScriptPath)
) {
  try {
    await runCliCheck();
  } catch {
    console.error(
      'check:native-pr-preview-dist-imports failed to run: PREVIEW_DIST_IMPORT_CHECK_FAILED'
    );
    process.exitCode = 1;
  }
}

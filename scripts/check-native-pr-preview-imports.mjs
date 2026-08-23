#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import madge from 'madge';
import ts from 'typescript';

const currentScriptPath = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(currentScriptPath), '..');
const PREVIEW_IMPORT_TSCONFIG_FILE =
  'scripts/native-pr-preview-imports-tsconfig.json';
const PREVIEW_DIST_IMPORT_CHECKER_FILE =
  'scripts/check-native-pr-preview-dist-imports.mjs';
const PREVIEW_DIST_IMPORT_CHECKER_DIGEST =
  '935852fbb8b53d5c6e767cb685c9d80fda9c68f67a114410c6341492e50fa990';
const ROOT_PACKAGE_MANIFEST_FILE = 'package.json';
const ROOT_TSCONFIG_FILE = 'tsconfig.json';
const RUNTIME_PACKAGE_MANIFEST_FILE =
  'packages/arcanos-runtime/package.json';
const PREVIEW_ENTRY_FILES = [
  'packages/arcanos-runtime/src/requestAbort.ts',
  'scripts/native-pr-preview-contract.mjs',
  'scripts/start-railway-service.mjs',
  'src/nativePrPreviewApplication.ts',
  'src/routes/genericJobsRouter.ts',
  'src/start-native-pr-preview.ts',
];
export const NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES = Object.freeze([
  'packages/arcanos-runtime/src/redaction.ts',
  'packages/arcanos-runtime/src/requestAbort.ts',
  'scripts/native-pr-preview-contract.d.mts',
  'scripts/native-pr-preview-contract.mjs',
  'scripts/start-railway-service.mjs',
  'src/core/logic/trinityDirectAnswerMode.ts',
  'src/core/db/repositories/backstageStorylineRepository.ts',
  'src/lib/errors/responses.ts',
  'src/mcp/httpBodyParserCore.ts',
  'src/nativePrPreviewApplication.ts',
  'src/nativePrPreviewContract.ts',
  'src/platform/runtime/security.ts',
  'src/routes/_core/researchAbortDrain.ts',
  'src/routes/genericJobsRouter.ts',
  'src/services/gamingModes.ts',
  'src/services/backstageBookerClear.ts',
  'src/services/controlPlane/httpAuth.ts',
  'src/services/controlPlane/systemStateBodyParser.ts',
  'src/services/controlPlane/systemStateHttpBoundary.ts',
  'src/services/directAnswerMode.ts',
  'src/services/gamingPublicDispatcher.ts',
  'src/services/publicGamingCanary.ts',
  'src/services/publicGamingCanaryFixture.ts',
  'src/shared/backstage/backstageActionPolicy.ts',
  'src/shared/backstage/backstageJobPayloadProtection.ts',
  'src/shared/backstage/backstageQueuedJobResultProtection.ts',
  'src/shared/backstage/backstageCompactOutputContract.ts',
  'src/shared/backstage/backstageContinuityQueryCore.ts',
  'src/shared/backstage/backstageGenerationError.ts',
  'src/shared/backstage/backstageNotionContextCore.ts',
  'src/shared/backstage/backstageNotionPreviewCanary.ts',
  'src/shared/backstage/backstageNotionRagCore.ts',
  'src/shared/backstage/backstageReviewContract.ts',
  'src/shared/backstage/backstageStoryline.ts',
  'src/shared/backstage/backstageUniverseReadProjection.ts',
  'src/shared/dispatch/dispatchGptIdentifierBoundary.ts',
  'src/shared/dispatch/universalDispatch.ts',
  'src/shared/gpt/gptIdentifier.ts',
  'src/shared/gpt/gptIdempotency.ts',
  'src/shared/gpt/gptJobLifecycle.ts',
  'src/shared/gpt/gptJobResult.ts',
  'src/shared/http/clientJsonPayload.ts',
  'src/shared/http/clientResponseCommon.ts',
  'src/shared/http/errors.ts',
  'src/shared/http/gptRouteTimeout.ts',
  'src/shared/http/sendBoundedJsonResponse.ts',
  'src/shared/http/sendPreparedJsonResponse.ts',
  'src/shared/http/validation.ts',
  'src/shared/jobs/jobLinks.ts',
  'src/shared/jobs/jobReadCapability.ts',
  'src/shared/hrcEvaluationPolicy.ts',
  'src/shared/researchRequest.ts',
  'src/shared/security/opaqueSecret.ts',
  'src/shared/security/purposeBoundCredential.ts',
  'src/shared/security/sensitiveProviderStorage.ts',
  'src/shared/selfHealPredictiveApproval.ts',
  'src/shared/typeGuards.ts',
  'src/start-native-pr-preview.ts',
  'src/transport/http/asyncHandler.ts',
  'src/transport/http/payloadNormalization.ts',
  'src/transport/http/responseHelpers.ts',
]);
const ALLOWED_GRAPH_FILES =
  new Set(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES);
const FORBIDDEN_LOCAL_IMPORT_PATTERNS = [
  /^src\/app\.ts$/u,
  /^src\/server\.ts$/u,
  /^src\/core\/db\/(?!repositories\/backstageStorylineRepository\.ts$)/u,
  /^src\/core\/diagnostics\.ts$/u,
  /^src\/core\/init-openai\.ts$/u,
  /^src\/middleware\//u,
  /^src\/platform\/(?!runtime\/security\.ts$)/u,
  /^src\/routes\/jobs\.ts$/u,
  /^src\/routes\/modules\.ts$/u,
  /^src\/routes\/register\.ts$/u,
  /^src\/services\/(?!(?:(?:backstageBookerClear|directAnswerMode|gamingModes|gamingPublicDispatcher|publicGamingCanary|publicGamingCanaryFixture)\.ts$|controlPlane\/(?:httpAuth|systemStateBodyParser|systemStateHttpBoundary|types)\.ts$))/u,
  /^src\/shared\/http\/index\.ts$/u,
  /^src\/shared\/http\/middleware\.ts$/u,
  /^src\/transport\/http\/middleware\//u,
  /^src\/workers\//u,
];
const LOCAL_IMPORT_PREFIXES = [
  '.',
  '@analytics/',
  '@config/',
  '@core/',
  '@dag/',
  '@dispatcher/',
  '@middleware/',
  '@platform/',
  '@routes/',
  '@services/',
  '@shared/',
  '@stores/',
  '@transport/',
  '@trinity/',
  '@workers/',
];
const ALLOWED_EXTERNAL_RUNTIME_IMPORTS = new Set([
  '@arcanos/runtime/requestAbort',
  'express',
  'node:crypto',
  'zod',
]);
const FILE_SPECIFIC_EXTERNAL_RUNTIME_IMPORTS = new Map([
  [
    'packages/arcanos-runtime/src/requestAbort.ts',
    new Set(['node:async_hooks']),
  ],
  [
    'src/nativePrPreviewApplication.ts',
    new Set(['node:stream', 'node:timers/promises']),
  ],
  [
    'src/shared/backstage/backstageNotionPreviewCanary.ts',
    new Set(['node:https']),
  ],
  [
    'src/shared/backstage/backstageNotionRagCore.ts',
    new Set(['crypto', 'entities']),
  ],
  [
    'scripts/start-railway-service.mjs',
    new Set([
      'node:child_process',
      'node:http',
      'node:process',
      'node:url',
    ]),
  ],
  ['src/start-native-pr-preview.ts', new Set(['node:http', 'node:url'])],
]);
const FILE_SPECIFIC_EXTERNAL_IMPORT_BINDINGS = new Map([
  [
    'src/shared/backstage/backstageJobPayloadProtection.ts',
    new Map([
      [
        'node:crypto',
        new Set([
          'createCipheriv:createCipheriv',
          'createDecipheriv:createDecipheriv',
          'createHash:createHash',
          'randomBytes:randomBytes',
          'timingSafeEqual:timingSafeEqual',
        ]),
      ],
    ]),
  ],
  [
    'packages/arcanos-runtime/src/requestAbort.ts',
    new Map([
      [
        'node:async_hooks',
        new Set(['AsyncLocalStorage:AsyncLocalStorage']),
      ],
    ]),
  ],
  [
    'scripts/start-railway-service.mjs',
    new Map([
      ['node:child_process', new Set(['spawn:spawn'])],
      ['node:http', new Set(['createServer:createServer'])],
      ['node:process', new Set(['default:process'])],
      [
        'node:url',
        new Set([
          'fileURLToPath:fileURLToPath',
          'pathToFileURL:pathToFileURL',
        ]),
      ],
    ]),
  ],
  [
    'src/start-native-pr-preview.ts',
    new Map([
      ['node:http', new Set(['createServer:createServer'])],
      ['node:url', new Set(['pathToFileURL:pathToFileURL'])],
    ]),
  ],
  [
    'src/lib/errors/responses.ts',
    new Map([
      ['express', new Set(['Response:Response'])],
    ]),
  ],
  [
    'src/mcp/httpBodyParserCore.ts',
    new Map([
      ['express', new Set(['default:express'])],
    ]),
  ],
  [
    'src/nativePrPreviewApplication.ts',
    new Map([
      [
        '@arcanos/runtime/requestAbort',
        new Set([
          'getRequestAbortContext:getRequestAbortContext',
          'runWithRequestAbortTimeout:runWithRequestAbortTimeout',
        ]),
      ],
      ['express', new Set(['default:express'])],
      ['node:stream', new Set(['Readable:Readable'])],
      ['node:timers/promises', new Set(['setTimeout:delay'])],
    ]),
  ],
  [
    'src/platform/runtime/security.ts',
    new Map([
      ['node:crypto', new Set(['default:crypto'])],
    ]),
  ],
  [
    'src/services/controlPlane/systemStateBodyParser.ts',
    new Map([
      ['express', new Set(['default:express'])],
    ]),
  ],
  [
    'src/shared/backstage/backstageNotionContextCore.ts',
    new Map([
      [
        '@arcanos/runtime/requestAbort',
        new Set([
          'createAbortError:createAbortError',
          'getRequestAbortSignal:getRequestAbortSignal',
          'runWithRequestAbortTimeout:runWithRequestAbortTimeout',
        ]),
      ],
    ]),
  ],
  [
    'src/shared/backstage/backstageNotionPreviewCanary.ts',
    new Map([
      ['node:https', new Set(['request:requestHttps'])],
    ]),
  ],
  [
    'src/shared/backstage/backstageNotionRagCore.ts',
    new Map([
      ['crypto', new Set(['createHash:createHash'])],
      ['entities', new Set(['decodeHTMLStrict:decodeHTMLStrict'])],
    ]),
  ],
  [
    'src/routes/_core/researchAbortDrain.ts',
    new Map([
      [
        '@arcanos/runtime/requestAbort',
        new Set([
          'createAbortError:createAbortError',
          'createLinkedAbortController:createLinkedAbortController',
          'runWithRequestAbortContext:runWithRequestAbortContext',
        ]),
      ],
    ]),
  ],
  [
    'src/routes/genericJobsRouter.ts',
    new Map([
      ['express', new Set(['default:express'])],
      ['node:crypto', new Set(['default:crypto'])],
      ['zod', new Set(['z:z'])],
    ]),
  ],
  [
    'src/shared/researchRequest.ts',
    new Map([
      ['node:crypto', new Set(['createHash:createHash'])],
    ]),
  ],
  [
    'src/shared/gpt/gptIdempotency.ts',
    new Map([
      ['node:crypto', new Set(['default:crypto'])],
    ]),
  ],
  [
    'src/shared/gpt/gptJobResult.ts',
    new Map([
      ['zod', new Set(['z:z'])],
    ]),
  ],
  [
    'src/shared/dispatch/dispatchGptIdentifierBoundary.ts',
    new Map([
      [
        'express',
        new Set(['Request:Request', 'RequestHandler:RequestHandler']),
      ],
    ]),
  ],
  [
    'src/shared/http/errors.ts',
    new Map([
      ['express', new Set(['Response:Response'])],
    ]),
  ],
  [
    'src/shared/http/sendBoundedJsonResponse.ts',
    new Map([
      [
        'express',
        new Set(['Request:Request', 'Response:Response']),
      ],
    ]),
  ],
  [
    'src/shared/http/sendPreparedJsonResponse.ts',
    new Map([
      ['express', new Set(['Response:Response'])],
    ]),
  ],
  [
    'src/shared/http/validation.ts',
    new Map([
      [
        'express',
        new Set([
          'NextFunction:NextFunction',
          'Request:Request',
          'RequestHandler:RequestHandler',
          'Response:Response',
        ]),
      ],
    ]),
  ],
  [
    'src/shared/jobs/jobReadCapability.ts',
    new Map([
      ['node:crypto', new Set(['createHmac:createHmac'])],
    ]),
  ],
  [
    'src/shared/security/opaqueSecret.ts',
    new Map([
      [
        'node:crypto',
        new Set([
          'createHash:createHash',
          'timingSafeEqual:timingSafeEqual',
        ]),
      ],
    ]),
  ],
  [
    'src/transport/http/asyncHandler.ts',
    new Map([
      ['express', new Set(['RequestHandler:RequestHandler'])],
    ]),
  ],
  [
    'src/transport/http/responseHelpers.ts',
    new Map([
      ['express', new Set(['Response:Response'])],
    ]),
  ],
]);
const ALLOWED_MUTABLE_PROCESS_CALL_ARGUMENTS = new Map([
  [
    'scripts/start-railway-service.mjs',
    new Map([
      [
        'assertNativePrApplicationIdentityOrThrow:0:env:resolveNativePrPreviewOrThrow',
        [
          '78e2a8c05e6b89c6a90fae6afd28082defd99b9b883edfe79f452a0c77853068',
        ],
      ],
      [
        'buildNativePrApplicationChildEnvironment:0:env:buildNativePrApplicationSpawnSpec',
        [
          '858d99aa5a97688286480876738c364f6f22c6bcba5101a799851e2ab99f358c',
        ],
      ],
      [
        'firstConfiguredValue:0:env:assertPreviewIsolationOrThrow',
        [
          '3ed884043a6efde3da365425580655597a6fcd4cfb65f6b0c9a1098e88ca15bc',
        ],
      ],
      [
        'normalizeRailwayPublicDomain:0:env:assertNativePrApplicationIdentityOrThrow',
        [
          '18a7a50e02578b4579c37a3133b29877e551412782d7979810f6c70cf1fe01d7',
        ],
      ],
      [
        'requirePreviewIdentityValue:0:env:assertNativePrApplicationIdentityOrThrow',
        [
          '37bbfeb1f117dd2be7c4cc340ad5b456e370dd115a41e3bcdde147a58f61384a',
          'b03007bb56da70c7e5c2cc9d8eb41b0b37b4961a8d67addcaecce78c1a15527b',
        ],
      ],
      [
        'requirePreviewIdentityValue:0:env:resolveNativePrPreviewOrThrow',
        [
          '2b9a14fb5bfaacf28936a601b2532fe83c0daa0515860977d86eab8e13f36ae8',
          'c99a5c127b9a55aa15b6055b967f09ef6fbc9af7fb7f4ceb2da5e703bd8ae57d',
        ],
      ],
      [
        'resolveHealthListenerConfig:0:env:buildNativePrApplicationChildEnvironment',
        [
          '43983c6d8a915296589360a075640d0227daec172fa9871e278632285e1a8883',
        ],
      ],
      [
        'resolveNativePrPreviewOrThrow:1:env:buildNativePrApplicationChildEnvironment',
        [
          'ad7605f1cac45aa497f9c416f202067c45419a88dd9e00ed1cf80b680a8310bb',
        ],
      ],
      [
        'resolvePassivePrPreviewOrThrow:1:env:resolveNativePrPreviewOrThrow',
        [
          'd083dd672e98c758e623811568ce011587be2e3c44889acdded41b0606357547',
        ],
      ],
      [
        'resolvePassivePrProcessKindOrThrow:0:env:resolveNativePrPreviewOrThrow',
        [
          'c1543868f104ec6eca22275400fa0f80d7001d3725fb6ca2e3af4118db617421',
        ],
      ],
    ]),
  ],
  [
    'src/shared/gpt/gptJobLifecycle.ts',
    new Map([
      [
        'resolveGptIdempotencyRetentionMs:0:env:computeGptJobLifecycleDeadlines',
        [
          '608a4fd6d1e13745449c7ecb7db427d71fbcd2b420e0fdd26b61efe988a1cf4e',
        ],
      ],
      [
        'resolveGptJobRetentionWindowMs:1:env:computeGptJobLifecycleDeadlines',
        [
          'ebc39d1971cf5804dbccc1e81c9652067cfe5922b0b9190620e92894858753b7',
        ],
      ],
      [
        'resolveGptPendingMaxAgeMs:0:env:shouldExpirePendingGptJob',
        [
          '4732f06ee61dd88dfacaa342b2dccbc0fa620397fb5c65ac338162905edf12d2',
        ],
      ],
    ]),
  ],
  [
    'src/start-native-pr-preview.ts',
    new Map([
      [
        'Object.keys:0:env:resolveNativePrPreviewChildEnvironment',
        [
          '89f82e76944ee2122282dcacafbb3b1ac45f58c0ab9f2d691d70f0b43d6b5346',
        ],
      ],
      [
        'requireExactEnvironmentValue:0:env:resolveNativePrPreviewChildEnvironment',
        [
          '2def4c6388cb208094f3cba748d6f8ce171fbc42ea00bbc6238b4619b80c108b',
          '31d9d5a04be68d8cf82f3170d8f4bfd97bc52d1113221e7c07f779edfcce3fb0',
          '369a0e8014b89f1aea708ffdbb8720618bef533b516415db598a9789ab8c44e3',
          '48c37c805b5b884b939c95b40819a07a744021c0a728f55954dc93538f8f3a2d',
          '83f2e2e5efe31a3e28fbc163c7a09974d534914a3d0e51f553b28b8226eebcd8',
          'b375703473aa150fa4480903277870582da25c4acd86a025ab21df274c1201a2',
        ],
      ],
      [
        'resolveNativePrPreviewChildEnvironment:0:env:main',
        [
          'dd4e941e150df6620d257e949d367bbaa59a9ecaeab9632527bcac49fff4b2f7',
        ],
      ],
    ]),
  ],
]);
const REVIEWED_READ_ONLY_MUTABLE_PROCESS_CALL_TARGETS =
  new Set(['Object.keys']);
const ALLOWED_LISTENER_CALLS = new Map([
  [
    'scripts/start-railway-service.mjs',
    new Map([
      ['runPassivePrPreview', new Set(['server'])],
      ['runWorkerRuntimeWithHealthServer', new Set(['healthServer'])],
    ]),
  ],
  [
    'src/start-native-pr-preview.ts',
    new Map([
      ['listen', new Set(['server'])],
    ]),
  ],
]);
const RAILWAY_LAUNCHER_FILE = 'scripts/start-railway-service.mjs';
const NATIVE_PREVIEW_LAUNCH_FUNCTION = 'runNativePrApplicationPreview';
const LAUNCHER_REPOSITORY_ROOT_STATEMENT_DIGEST =
  'd396b2efbae912e708125ebb4535806f5b516cf91aa48bc2ba579e6fb413e0d2';
const SENSITIVE_LAUNCHER_HELPER_NAMES = new Set([
  'buildChildEnvironment',
  'buildNativePrApplicationChildEnvironment',
  'main',
  'maybeStartCliBridgeDaemon',
  'mirrorAndObserveWorkerOutput',
  'repairDistAliases',
  'resolveNativePrPreviewOrThrow',
  'runNativePrApplicationPreview',
  'runPassivePrPreview',
  'runWebRuntime',
  'runWorkerRuntimeWithHealthServer',
]);
const NON_EXPORTABLE_LAUNCHER_HELPER_NAMES = new Set([
  'buildChildEnvironment',
  'main',
  'maybeStartCliBridgeDaemon',
  'repairDistAliases',
  'runNativePrApplicationPreview',
  'runPassivePrPreview',
  'runWebRuntime',
  'runWorkerRuntimeWithHealthServer',
  'spawnProcess',
]);
const LISTENER_FACTORY_NAMES = new Set([
  'createServer',
  'express',
]);
const CRITICAL_LAUNCHER_FUNCTION_DIGESTS = new Map([
  [
    'buildNativePrApplicationChildEnvironment',
    '15608712aaec5c154465bef7efb2dc0a83c36cd55ec70f25bcdd8c28988fa017',
  ],
  [
    'mirrorAndObserveWorkerOutput',
    '431d10b6c59ffa80fdc256d93523f4fc05b904f2d1cd1e1ebf8499329639ade1',
  ],
  [
    'resolveNativePrPreviewOrThrow',
    'f0036cf32f393ca09e5df31048e7d621d260a5e39cfc914d68d03c77fec68868',
  ],
  [
    'runPassivePrPreview',
    '858eb042a6b390d897ec355d8c6c833242aca8e406315696748c07afa4f9b84e',
  ],
  [
    'runWorkerRuntimeWithHealthServer',
    'b610e254832d19402efd555f810317742210e7c57e81aeb01e3b68036e40b34c',
  ],
]);
const REVIEWED_MUTABLE_PROCESS_SPREAD_FUNCTION_DIGESTS = new Map([
  [
    'scripts/start-railway-service.mjs',
    new Map([
      [
        'buildChildEnvironment',
        '84cabe14ac63481348f38d00db438c321ea5a39209645291597d39802f93965f',
      ],
    ]),
  ],
]);
const CRITICAL_RUNTIME_FUNCTION_DIGESTS = new Map([
  [
    'src/start-native-pr-preview.ts',
    new Map([
      [
        'listen',
        'b6aa99cf08cfbb3369951307b71dd601aae1e06f5d4dd3d0ff0508324c538bcf',
      ],
      [
        'resolveNativePrPreviewChildEnvironment',
        'eb41a9a232903e5555f368678cabf1ebf3ae3d5ecb2907db59ef205d8d056367',
      ],
    ]),
  ],
]);
const CRITICAL_ENTRY_FILE_DIGESTS = new Map([
  [
    'src/core/logic/trinityDirectAnswerMode.ts',
    '80060899d1ed7c1ea4304b4fdfc96ff1f7678f33736ab056ebd378487ce889af',
  ],
  [
    'src/services/directAnswerMode.ts',
    'a4002ca1d79e508ffa8d95d52383e0db7ddac56e54704d583d82eb0746ff6b63',
  ],
  [
    'src/services/backstageBookerClear.ts',
    '001cd70c7af10701bc1f58e335f500d9a554951e8ef5ef00ef3b90ff532527ce',
  ],
  [
    'src/services/gamingPublicDispatcher.ts',
    'fae5727fc7b800cdda980172ee8739a3362cd6e91ecdcff7de8e229cb724f2f0',
  ],
  [
    'src/services/publicGamingCanary.ts',
    '49e0004c356dde1869e710a886c28e192146432d177d4ffc33dd5377b0292933',
  ],
  [
    'src/services/publicGamingCanaryFixture.ts',
    'fedbadf49cb5ed92661d494a6e8a232c2f8bb1d8f81f72feed9b05d82fe45acb',
  ],
  [
    'packages/arcanos-runtime/src/requestAbort.ts',
    'ca6e8019c919d83c67f37f7dccb14aff6d8a7456df3fae9f2d51ae63d203cdc4',
  ],
  [
    'src/core/db/repositories/backstageStorylineRepository.ts',
    '6a38cb1b934544e1db96a0c9c796a4fde7aa89e0fd2a15cf1f17d70183151144',
  ],
  [
    'scripts/start-railway-service.mjs',
    'ce4f69c883bed63e019db3d166c1c6f9c5a2c82f2ae632d89f594c812a2da06d',
  ],
  [
    'src/start-native-pr-preview.ts',
    'eede53e221d3fecdb00d1662205d56d1fe91d40a3a3905477c54a5582c1ec54d',
  ],
  [
    'src/shared/backstage/backstageStoryline.ts',
    '1352383228608e77a2b1d86a0bf9cafdc928809753f11036553a94b83468c148',
  ],
  [
    'src/shared/backstage/backstageUniverseReadProjection.ts',
    '262585c6236dae39abf47a8fa44c96a910cb362f292a61d5f0a1401abb173bef',
  ],
  [
    'src/shared/backstage/backstageActionPolicy.ts',
    '0379cb26ea580cc88d994786e552f3e6d528244354a1668b84f699abe9386e82',
  ],
  [
    'src/shared/backstage/backstageJobPayloadProtection.ts',
    '07af40fc9f66086f28727c0accc09c9ac9b95767e8b15802608a9dc756793de0',
  ],
  [
    'src/shared/backstage/backstageQueuedJobResultProtection.ts',
    '290eff6f6d00d047583ba10a109e8498605f4165f35f38311bd7a503669214b2',
  ],
  [
    'src/shared/backstage/backstageCompactOutputContract.ts',
    '7e3caa4f864d86e12faaf49a08a6c55db1c4f8dc6e3eb85eb34b3efc1dc55801',
  ],
  [
    'src/shared/backstage/backstageContinuityQueryCore.ts',
    '65539139100841a1f96925747ce6382093611e7427155a31dd24ab290e6ab12e',
  ],
  [
    'src/shared/backstage/backstageGenerationError.ts',
    '523566c7108e4e51fd1d9b0e371d9d8178de85a42c9ec43a1171b3a81baa759b',
  ],
  [
    'src/shared/backstage/backstageNotionContextCore.ts',
    'bf3e1a0e812961519147c061d4b63fc54c76ae2b652fa45b3f9b5af9a6d8e6d1',
  ],
  [
    'src/shared/backstage/backstageNotionPreviewCanary.ts',
    'd6aa19cfb3ea5ee0e3b84faebc463d3a8ef549c456a04199de84497571bd4bc8',
  ],
  [
    'src/shared/backstage/backstageNotionRagCore.ts',
    '56007dffcfbbde8f6e3b2a8b812a876d5940544ee088e1b08f3b03a605e53631',
  ],
  [
    'src/shared/backstage/backstageReviewContract.ts',
    'e413bf2b84f358cc6dce8ad1ff39bfd9c4322629b55acbd94b74d2582ce6dcd5',
  ],
  [
    'src/shared/dispatch/dispatchGptIdentifierBoundary.ts',
    '5554111d8b6bfd0dba409d1fec6b0abc3c36d5a7a3fb0fa2368fda0c1231c69f',
  ],
  [
    'src/shared/dispatch/universalDispatch.ts',
    'e3ebb2cae5501b419712013b7f64c69faaddcd876f9b6672f666b18ad3040883',
  ],
  [
    'src/shared/gpt/gptIdentifier.ts',
    'fb0047bf8bc554e33c217bf47fae59ced14507ce0facf9039acee55b4ed6d3bb',
  ],
  [
    'src/shared/hrcEvaluationPolicy.ts',
    'c5a75922f94a345f3205c91c26cba7199578c38407dfde548641ed5ac6b946f9',
  ],
  [
    'src/shared/http/gptRouteTimeout.ts',
    '2f4232f2555db98cefdd4f4613d73eff134e724c5713ed37f80d9706659f112f',
  ],
  [
    'src/shared/researchRequest.ts',
    '3fc92f358952e766e3bfd3b69018906759b01ad88c642d9ca6aa730926367761',
  ],
  [
    'src/shared/security/sensitiveProviderStorage.ts',
    '2d499c6caa7ae13b9a59ed444f47cc5a036d46efe0d874cc37f04de5504b19d5',
  ],
  [
    'src/mcp/httpBodyParserCore.ts',
    '31a5ac406ecd6517f3d8163663fb30d9b65f285d7c09f93e2f824742e13fed20',
  ],
  [
    'src/platform/runtime/security.ts',
    '080cbb45b1bbb0d5cb6a7a9319c70699c1e455b1d652f52e1449ec3fe2a28541',
  ],
  [
    'src/services/controlPlane/httpAuth.ts',
    '9c73c3c77d60ca54a962cb3859d8be4f5a215384eb2365d20bb5792b44e70ffa',
  ],
  [
    'src/services/controlPlane/systemStateBodyParser.ts',
    '09075362c98cfa17d157ed83be7601d430b9171106de2e69153379ff8667a447',
  ],
  [
    'src/services/controlPlane/systemStateHttpBoundary.ts',
    'b6f69af614c4a008337a54e9ea1bebf59cd11c799c41b2c4d28b0aa13a0f6c47',
  ],
  [
    'src/routes/_core/researchAbortDrain.ts',
    '0f8ca2e91c799218e3fa873bd3f247ef7eec9061924f1ce0c92e71f9a8b7521c',
  ],
  [
    'src/shared/selfHealPredictiveApproval.ts',
    '0ffb63a5137f1992a1901f8690c01b68562e737a320a52987d07b598c6053c38',
  ],
]);
const REVIEWED_STATUS_AUTH_DYNAMIC_CALL_FILE =
  'src/services/controlPlane/httpAuth.ts';
const REVIEWED_STATUS_AUTH_CAPABILITY_REFERENCE_FILE =
  'src/services/controlPlane/systemStateHttpBoundary.ts';
const FORBIDDEN_AMBIENT_IDENTIFIER_NAMES = new Set([
  'EventSource',
  'Function',
  'Reflect',
  'WebSocket',
  'arguments',
  'eval',
  'fetch',
  'require',
  'queueMicrotask',
  'setImmediate',
  'setInterval',
  'setTimeout',
]);
const GLOBAL_RUNTIME_NAMESPACE_NAMES = new Set([
  'global',
  'globalThis',
]);
const ALLOWED_PROCESS_MEMBERS = new Set([
  'argv',
  'cwd',
  'env',
  'execPath',
  'exit',
  'exitCode',
  'off',
  'once',
  'platform',
  'stderr',
  'stdout',
]);
const PROCESS_EFFECT_MEMBER_NAMES = new Set([
  'exit',
  'exitCode',
  'off',
  'once',
  'stderr',
  'stdout',
]);
const MUTABLE_PROCESS_OBJECT_MEMBER_NAMES = new Set([
  'argv',
  'env',
  'stderr',
  'stdout',
]);
const FORBIDDEN_PROCESS_CAPABILITY_NAMES = new Set([
  '_linkedBinding',
  'binding',
  'dlopen',
  'getBuiltinModule',
]);
const FORBIDDEN_RUNTIME_BINDING_NAMES = new Set([
  ...FORBIDDEN_AMBIENT_IDENTIFIER_NAMES,
  ...FORBIDDEN_PROCESS_CAPABILITY_NAMES,
]);

function isRuntimeImportDeclaration(node) {
  if (!node.importClause) {
    return true;
  }
  if (node.importClause.isTypeOnly) {
    return false;
  }
  if (node.importClause.name || !node.importClause.namedBindings) {
    return true;
  }
  if (ts.isNamespaceImport(node.importClause.namedBindings)) {
    return true;
  }
  if (node.importClause.namedBindings.elements.length === 0) {
    return true;
  }
  return node.importClause.namedBindings.elements.some(
    (element) => !element.isTypeOnly
  );
}

function isRuntimeExportDeclaration(node) {
  if (node.isTypeOnly) {
    return false;
  }
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) {
    return true;
  }
  if (node.exportClause.elements.length === 0) {
    return true;
  }
  return node.exportClause.elements.some((element) => !element.isTypeOnly);
}

function isLocalImportSpecifier(specifier) {
  return LOCAL_IMPORT_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

function literalPropertyName(node) {
  if (
    ts.isStringLiteral(node)
    || ts.isNumericLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.text;
  }
  return null;
}

function staticPropertyName(node) {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (ts.isComputedPropertyName(node)) {
    return literalPropertyName(node.expression);
  }
  return literalPropertyName(node);
}

function propertyAccessParts(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return [
      ts.isIdentifier(node.expression) ? node.expression.text : null,
      node.name.text,
    ];
  }
  if (
    ts.isElementAccessExpression(node)
    && node.argumentExpression
    && literalPropertyName(node.argumentExpression) !== null
  ) {
    return [
      ts.isIdentifier(node.expression) ? node.expression.text : null,
      literalPropertyName(node.argumentExpression),
    ];
  }
  return null;
}

function unwrapExpression(node) {
  let expression = node;
  while (
    ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)
    || (
      typeof ts.isSatisfiesExpression === 'function'
      && ts.isSatisfiesExpression(expression)
    )
  ) {
    expression = expression.expression;
  }
  return expression;
}

function runtimeNamespaceName(node) {
  const expression = unwrapExpression(node);
  if (
    ts.isIdentifier(expression)
    && (
      GLOBAL_RUNTIME_NAMESPACE_NAMES.has(expression.text)
      || expression.text === 'process'
    )
  ) {
    return expression.text;
  }
  return null;
}

function runtimeNamespaceMemberAccess(node) {
  const expression = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(expression)) {
    const namespace = runtimeNamespaceName(expression.expression);
    return namespace
      ? { namespace, member: expression.name.text, dynamic: false }
      : null;
  }
  if (ts.isElementAccessExpression(expression)) {
    const namespace = runtimeNamespaceName(expression.expression);
    if (!namespace) {
      return null;
    }
    const argument = expression.argumentExpression;
    if (
      argument
      && (
        ts.isStringLiteral(argument)
        || ts.isNoSubstitutionTemplateLiteral(argument)
      )
    ) {
      return {
        namespace,
        member: argument.text,
        dynamic: false,
      };
    }
    return { namespace, member: null, dynamic: true };
  }
  return null;
}

function isForbiddenRuntimeNamespaceMember(access) {
  if (!access) {
    return false;
  }
  if (access.dynamic) {
    return true;
  }
  return access.namespace === 'process'
    ? !ALLOWED_PROCESS_MEMBERS.has(access.member)
    : true;
}

function isForbiddenRuntimeCapabilityAccess(node) {
  return isForbiddenRuntimeNamespaceMember(
    runtimeNamespaceMemberAccess(node)
  );
}

function isObjectMutationCapabilityAccess(node) {
  const parts = propertyAccessParts(unwrapExpression(node));
  return Boolean(
    parts
    && (
      (
        parts[0] === 'Object'
        && [
          'assign',
          'defineProperties',
          'defineProperty',
          'setPrototypeOf',
        ].includes(parts[1])
      )
      || (
        parts[0] === 'Reflect'
        && ['defineProperty', 'deleteProperty', 'set'].includes(parts[1])
      )
    )
  );
}

function isListenerCapabilityAccess(node) {
  const expression = unwrapExpression(node);
  const parts = propertyAccessParts(expression);
  return Boolean(parts && parts[1] === 'listen');
}

function isDynamicListenerCapabilityAccess(
  node,
  listenerObjectBindingNames
) {
  const expression = unwrapExpression(node);
  if (
    !ts.isElementAccessExpression(expression)
    || literalPropertyName(expression.argumentExpression) !== null
  ) {
    return false;
  }
  const target = unwrapExpression(expression.expression);
  return (
    (
      ts.isIdentifier(target)
      && listenerObjectBindingNames.has(target.text)
    )
    || (
      ts.isCallExpression(target)
      && ts.isIdentifier(target.expression)
      && LISTENER_FACTORY_NAMES.has(target.expression.text)
    )
  );
}

function listenerBindingInitializerName(node) {
  const expression = unwrapExpression(node);
  if (
    ts.isCallExpression(expression)
    && ts.isIdentifier(expression.expression)
    && LISTENER_FACTORY_NAMES.has(expression.expression.text)
  ) {
    return true;
  }
  return (
    ts.isIdentifier(expression)
      ? expression.text
      : null
  );
}

function collectListenerObjectBindingNames(nodes) {
  const bindingNames = new Set([
    'app',
    'application',
    'healthServer',
    'server',
  ]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      let target = null;
      let initializer = null;
      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer
      ) {
        target = node.name.text;
        initializer = node.initializer;
      } else if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left)
      ) {
        target = node.left.text;
        initializer = node.right;
      }
      if (!target || !initializer || bindingNames.has(target)) {
        continue;
      }
      const source = listenerBindingInitializerName(initializer);
      if (source === true || (source && bindingNames.has(source))) {
        bindingNames.add(target);
        changed = true;
      }
    }
  }
  return bindingNames;
}

function collectInvokedBindingNames(nodes) {
  const invokedNames = new Set(
    nodes
      .filter(
        (node) => (
          ts.isCallExpression(node)
          && ts.isIdentifier(unwrapExpression(node.expression))
        )
      )
      .map((call) => unwrapExpression(call.expression).text)
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      let targetName = null;
      let sourceName = null;
      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer
        && ts.isIdentifier(unwrapExpression(node.initializer))
      ) {
        targetName = node.name.text;
        sourceName = unwrapExpression(node.initializer).text;
      } else if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left)
        && ts.isIdentifier(unwrapExpression(node.right))
      ) {
        targetName = node.left.text;
        sourceName = unwrapExpression(node.right).text;
      }
      if (
        targetName
        && sourceName
        && invokedNames.has(targetName)
        && !invokedNames.has(sourceName)
      ) {
        invokedNames.add(sourceName);
        changed = true;
      }
    }
  }
  return invokedNames;
}

function isDynamicCallableExtraction(node, invokedBindingNames) {
  const expression = unwrapExpression(node);
  if (
    !ts.isElementAccessExpression(expression)
    || literalPropertyName(expression.argumentExpression) !== null
  ) {
    return false;
  }
  const outerExpression = outerTransparentExpression(expression);
  const parent = outerExpression.parent;
  if (
    ts.isVariableDeclaration(parent)
    && parent.initializer === outerExpression
    && ts.isIdentifier(parent.name)
  ) {
    return invokedBindingNames.has(parent.name.text);
  }
  return Boolean(
    ts.isBinaryExpression(parent)
    && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && parent.right === outerExpression
    && ts.isIdentifier(parent.left)
    && invokedBindingNames.has(parent.left.text)
  );
}

function isForbiddenListenerFactoryReference(node) {
  if (
    !ts.isIdentifier(node)
    || !LISTENER_FACTORY_NAMES.has(node.text)
    || isNonReferenceIdentifier(node)
  ) {
    return false;
  }
  const expression = outerTransparentExpression(node);
  const parent = expression.parent;
  if (
    ts.isCallExpression(parent)
    && parent.expression === expression
  ) {
    return false;
  }
  return Boolean(
    !(
      node.text === 'express'
      && ts.isPropertyAccessExpression(parent)
      && parent.expression === expression
      && ['json', 'Router'].includes(parent.name.text)
    )
  );
}

function isDirectCallOrConstructorTarget(node) {
  const parent = node.parent;
  return Boolean(
    (
      ts.isCallExpression(parent)
      || ts.isNewExpression(parent)
    )
    && parent.expression === node
  );
}

function isNonReferenceIdentifier(node) {
  const parent = node.parent;
  return (
    (
      (
        ts.isVariableDeclaration(parent)
        || ts.isParameter(parent)
        || ts.isFunctionDeclaration(parent)
        || ts.isFunctionExpression(parent)
        || ts.isClassDeclaration(parent)
        || ts.isClassExpression(parent)
      )
      && parent.name === node
    )
    || (
      ts.isBindingElement(parent)
      && (
        parent.name === node
        || parent.propertyName === node
      )
    )
    || (
      (
        ts.isPropertyAccessExpression(parent)
        || ts.isPropertyAssignment(parent)
        || ts.isMethodDeclaration(parent)
        || ts.isPropertyDeclaration(parent)
        || ts.isPropertySignature(parent)
        || ts.isMethodSignature(parent)
      )
      && parent.name === node
    )
    || ts.isImportClause(parent)
    || ts.isImportSpecifier(parent)
    || ts.isNamespaceImport(parent)
    || ts.isExportSpecifier(parent)
    || ts.isTypeNode(parent)
  );
}

function isBindingIdentifier(node) {
  const parent = node.parent;
  return Boolean(
    ts.isIdentifier(node)
    && (
      (
        (
          ts.isVariableDeclaration(parent)
          || ts.isParameter(parent)
          || ts.isFunctionDeclaration(parent)
          || ts.isFunctionExpression(parent)
          || ts.isClassDeclaration(parent)
          || ts.isClassExpression(parent)
        )
        && parent.name === node
      )
      || (
        ts.isBindingElement(parent)
        && parent.name === node
      )
      || (
        (
          ts.isImportClause(parent)
          || ts.isImportSpecifier(parent)
          || ts.isNamespaceImport(parent)
        )
        && parent.name === node
      )
    )
  );
}

function isRuntimeValueBindingOrReference(node) {
  if (isBindingIdentifier(node) || !isNonReferenceIdentifier(node)) {
    return true;
  }
  const parent = node.parent;
  return Boolean(
    ts.isExportSpecifier(parent)
    && (parent.propertyName ?? parent.name) === node
  );
}

function isForbiddenRuntimeCapabilityIdentifierReference(node) {
  return (
    ts.isIdentifier(node)
    && FORBIDDEN_RUNTIME_BINDING_NAMES.has(node.text)
    && !isNonReferenceIdentifier(node)
    && !isDirectCallOrConstructorTarget(node)
  );
}

function isReviewedResearchOwnKeysReference(filePath, node) {
  if (
    filePath !== 'src/shared/researchRequest.ts'
    || !ts.isIdentifier(node)
    || node.text !== 'Reflect'
  ) {
    return false;
  }
  const access = node.parent;
  if (
    !ts.isPropertyAccessExpression(access)
    || access.expression !== node
    || access.name.text !== 'ownKeys'
  ) {
    return false;
  }
  const call = access.parent;
  return (
    ts.isCallExpression(call)
    && call.expression === access
    && call.arguments.length === 1
    && ts.isIdentifier(call.arguments[0])
    && call.arguments[0].text === 'descriptors'
  );
}

function isReviewedRequestAbortTimeoutCall(filePath, node) {
  return (
    filePath === 'packages/arcanos-runtime/src/requestAbort.ts'
    && ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'setTimeout'
  );
}

function objectBindingSourceNamespace(bindingPattern) {
  const declaration = bindingPattern.parent;
  if (
    (
      ts.isVariableDeclaration(declaration)
      || ts.isParameter(declaration)
    )
    && declaration.name === bindingPattern
    && declaration.initializer
  ) {
    return runtimeNamespaceName(declaration.initializer);
  }
  return null;
}

function isUnsafeRuntimeNamespaceBindingElement(node) {
  if (
    !ts.isBindingElement(node)
    || !ts.isObjectBindingPattern(node.parent)
  ) {
    return false;
  }
  const namespace = objectBindingSourceNamespace(node.parent);
  if (!namespace) {
    return false;
  }
  if (
    node.dotDotDotToken
    || (
      node.propertyName
      && ts.isComputedPropertyName(node.propertyName)
    )
  ) {
    return true;
  }
  const propertyName = node.propertyName ?? node.name;
  if (
    !ts.isIdentifier(propertyName)
    && !ts.isStringLiteral(propertyName)
    && !ts.isNumericLiteral(propertyName)
  ) {
    return true;
  }
  const member = propertyName.text;
  return namespace === 'process'
    ? (
      !ALLOWED_PROCESS_MEMBERS.has(member)
      || MUTABLE_PROCESS_OBJECT_MEMBER_NAMES.has(member)
      || PROCESS_EFFECT_MEMBER_NAMES.has(member)
    )
    : true;
}

function isUnsafeListenerBindingElement(node) {
  if (
    !ts.isBindingElement(node)
    || !ts.isObjectBindingPattern(node.parent)
    || node.dotDotDotToken
  ) {
    return false;
  }
  const propertyName = node.propertyName ?? node.name;
  return (
    staticPropertyName(propertyName) === 'listen'
  );
}

function outerTransparentExpression(node) {
  let expression = node;
  while (
    expression.parent
    && (
      ts.isParenthesizedExpression(expression.parent)
      || ts.isAsExpression(expression.parent)
      || ts.isTypeAssertionExpression(expression.parent)
      || ts.isNonNullExpression(expression.parent)
      || (
        typeof ts.isSatisfiesExpression === 'function'
        && ts.isSatisfiesExpression(expression.parent)
      )
    )
    && expression.parent.expression === expression
  ) {
    expression = expression.parent;
  }
  return expression;
}

function isAllowedRuntimeNamespaceIdentifierUse(node) {
  if (isNonReferenceIdentifier(node)) {
    return true;
  }
  const expression = outerTransparentExpression(node);
  const parent = expression.parent;
  if (
    (
      ts.isPropertyAccessExpression(parent)
      || ts.isElementAccessExpression(parent)
    )
    && parent.expression === expression
  ) {
    return true;
  }
  if (
    (
      ts.isVariableDeclaration(parent)
      || ts.isParameter(parent)
    )
    && parent.initializer === expression
    && ts.isObjectBindingPattern(parent.name)
  ) {
    return true;
  }
  return false;
}

function isForbiddenRuntimeNamespaceReference(node) {
  if (
    !ts.isIdentifier(node)
    || (
      !GLOBAL_RUNTIME_NAMESPACE_NAMES.has(node.text)
      && node.text !== 'process'
    )
  ) {
    return false;
  }
  return !isAllowedRuntimeNamespaceIdentifierUse(node);
}

function runtimeImportBindings(node) {
  const bindings = [];
  const clause = node.importClause;
  if (!clause || clause.isTypeOnly) {
    return bindings;
  }
  if (clause.name) {
    bindings.push(`default:${clause.name.text}`);
  }
  if (!clause.namedBindings) {
    return bindings;
  }
  if (ts.isNamespaceImport(clause.namedBindings)) {
    bindings.push(`*:${clause.namedBindings.name.text}`);
    return bindings;
  }
  for (const element of clause.namedBindings.elements) {
    if (!element.isTypeOnly) {
      bindings.push(
        `${element.propertyName?.text ?? element.name.text}:${element.name.text}`
      );
    }
  }
  return bindings;
}

function isNamedPropertyAccess(node, objectName, propertyName) {
  return (
    ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === objectName
    && node.name.text === propertyName
  );
}

function isNamedIdentifier(node, identifierName) {
  return ts.isIdentifier(node) && node.text === identifierName;
}

function isReviewedGlobalObjectReference(node, filePath) {
  if (
    filePath !== 'src/start-native-pr-preview.ts'
    || !isNamedIdentifier(node, 'Object')
  ) {
    return true;
  }
  const keysAccess = node.parent;
  const call = keysAccess?.parent;
  return Boolean(
    ts.isPropertyAccessExpression(keysAccess)
    && keysAccess.expression === node
    && keysAccess.name.text === 'keys'
    && ts.isCallExpression(call)
    && call.expression === keysAccess
    && call.arguments.length === 1
    && isNamedIdentifier(call.arguments[0], 'env')
    && topLevelContainingFunctionName(call, call.getSourceFile())
      === 'resolveNativePrPreviewChildEnvironment'
  );
}

function exactObjectPropertyAssignments(node, expectedPropertyNames) {
  if (
    !ts.isObjectLiteralExpression(node)
    || node.properties.length !== expectedPropertyNames.length
  ) {
    return null;
  }
  const expectedNames = new Set(expectedPropertyNames);
  const properties = new Map();
  for (const property of node.properties) {
    if (
      !ts.isPropertyAssignment(property)
      || !ts.isIdentifier(property.name)
      || !expectedNames.has(property.name.text)
      || properties.has(property.name.text)
    ) {
      return null;
    }
    properties.set(property.name.text, property.initializer);
  }
  return properties.size === expectedNames.size ? properties : null;
}

function isSafeNativePreviewSpawnCall(node) {
  if (node.arguments.length !== 4) {
    return false;
  }
  const [command, args, role, options] = node.arguments;
  if (
    !command
    || !args
    || !role
    || !options
    || !isNamedPropertyAccess(command, 'spawnSpec', 'command')
    || !isNamedPropertyAccess(args, 'spawnSpec', 'args')
    || !ts.isStringLiteral(role)
    || role.text !== 'web'
  ) {
    return false;
  }
  const properties = exactObjectPropertyAssignments(
    options,
    ['cwd', 'env']
  );
  return (
    properties
    && isNamedPropertyAccess(properties.get('cwd'), 'spawnSpec', 'cwd')
    && isNamedPropertyAccess(properties.get('env'), 'spawnSpec', 'env')
  );
}

function isExactNativePreviewSpawnSpecBuilder(builderFunction) {
  if (
    !builderFunction?.body
    || builderFunction.asteriskToken
    || builderFunction.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword
    )
    || builderFunction.parameters.length !== 1
    || builderFunction.body.statements.length !== 1
  ) {
    return false;
  }
  const [envParameter] = builderFunction.parameters;
  if (
    !isNamedIdentifier(envParameter.name, 'env')
    || !envParameter.initializer
    || !isNamedPropertyAccess(envParameter.initializer, 'process', 'env')
    || envParameter.dotDotDotToken
  ) {
    return false;
  }
  const [statement] = builderFunction.body.statements;
  if (!ts.isReturnStatement(statement) || !statement.expression) {
    return false;
  }
  const properties = exactObjectPropertyAssignments(
    statement.expression,
    ['args', 'command', 'cwd', 'env']
  );
  if (!properties) {
    return false;
  }
  const args = properties.get('args');
  const expectedArgs = [
    '--max-old-space-size=512',
    'dist/start-native-pr-preview.js',
  ];
  if (
    !ts.isArrayLiteralExpression(args)
    || args.elements.length !== expectedArgs.length
    || args.elements.some(
      (element, index) => (
        !ts.isStringLiteral(element)
        || element.text !== expectedArgs[index]
      )
    )
    || !isNamedPropertyAccess(
      properties.get('command'),
      'process',
      'execPath'
    )
    || !isNamedIdentifier(
      properties.get('cwd'),
      'LAUNCHER_REPOSITORY_ROOT'
    )
  ) {
    return false;
  }
  const environment = properties.get('env');
  return Boolean(
    ts.isCallExpression(environment)
    && isNamedIdentifier(
      environment.expression,
      'buildNativePrApplicationChildEnvironment'
    )
    && environment.arguments.length === 1
    && isNamedIdentifier(environment.arguments[0], 'env')
  );
}

function isNullishFallback(node, objectName, propertyName, fallbackCheck) {
  return Boolean(
    ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    && isNamedPropertyAccess(node.left, objectName, propertyName)
    && fallbackCheck(node.right)
  );
}

function isExactSpawnProcessWrapper(
  spawnProcessFunction,
  spawnEffectCall
) {
  if (
    !spawnProcessFunction?.body
    || spawnProcessFunction.asteriskToken
    || spawnProcessFunction.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword
    )
    || spawnProcessFunction.parameters.length !== 4
    || spawnProcessFunction.body.statements.length !== 1
  ) {
    return false;
  }
  const [
    commandParameter,
    argsParameter,
    processKindParameter,
    optionsParameter,
  ] = spawnProcessFunction.parameters;
  if (
    !isNamedIdentifier(commandParameter.name, 'command')
    || commandParameter.initializer
    || !isNamedIdentifier(argsParameter.name, 'args')
    || argsParameter.initializer
    || !isNamedIdentifier(processKindParameter.name, 'processKind')
    || processKindParameter.initializer
    || !isNamedIdentifier(optionsParameter.name, 'options')
    || !optionsParameter.initializer
    || !ts.isObjectLiteralExpression(optionsParameter.initializer)
    || optionsParameter.initializer.properties.length !== 0
  ) {
    return false;
  }
  const [statement] = spawnProcessFunction.body.statements;
  if (
    !ts.isReturnStatement(statement)
    || statement.expression !== spawnEffectCall
    || !spawnEffectCall
    || spawnEffectCall.arguments.length !== 3
    || !isNamedIdentifier(spawnEffectCall.arguments[0], 'command')
    || !isNamedIdentifier(spawnEffectCall.arguments[1], 'args')
  ) {
    return false;
  }
  const properties = exactObjectPropertyAssignments(
    spawnEffectCall.arguments[2],
    ['stdio', 'env', 'cwd']
  );
  if (
    !properties
    || !isNullishFallback(
      properties.get('stdio'),
      'options',
      'stdio',
      (fallback) => (
        ts.isStringLiteral(fallback)
        && fallback.text === 'inherit'
      )
    )
    || !isNamedPropertyAccess(
      properties.get('cwd'),
      'options',
      'cwd'
    )
  ) {
    return false;
  }
  return isNullishFallback(
    properties.get('env'),
    'options',
    'env',
    (fallback) => (
      ts.isCallExpression(fallback)
      && isNamedIdentifier(
        fallback.expression,
        'buildChildEnvironment'
      )
      && fallback.arguments.length === 1
      && isNamedIdentifier(fallback.arguments[0], 'processKind')
    )
  );
}

function nearestContainingFunction(node) {
  let ancestor = node.parent;
  while (ancestor) {
    if (ts.isFunctionLike(ancestor)) {
      return ancestor;
    }
    ancestor = ancestor.parent;
  }
  return null;
}

function isWithinFunction(node, containingFunction) {
  if (!containingFunction) {
    return false;
  }
  let ancestor = node.parent;
  while (ancestor) {
    if (ancestor === containingFunction) {
      return true;
    }
    ancestor = ancestor.parent;
  }
  return false;
}

function directFunctionBodyStatement(node, containingFunction) {
  if (!containingFunction?.body || !ts.isBlock(containingFunction.body)) {
    return null;
  }
  let current = node;
  while (current.parent && current.parent !== containingFunction.body) {
    if (ts.isFunctionLike(current.parent)) {
      return null;
    }
    current = current.parent;
  }
  return (
    current.parent === containingFunction.body
    && ts.isStatement(current)
  )
    ? current
    : null;
}

function isDirectConstCallBinding(
  callExpression,
  containingFunction,
  bindingName
) {
  const declaration = callExpression.parent;
  return Boolean(
    ts.isVariableDeclaration(declaration)
    && declaration.initializer === callExpression
    && isNamedIdentifier(declaration.name, bindingName)
    && ts.isVariableDeclarationList(declaration.parent)
    && declaration.parent.declarations.length === 1
    && (
      declaration.parent.flags & ts.NodeFlags.Const
    ) !== 0
    && ts.isVariableStatement(declaration.parent.parent)
    && declaration.parent.parent.parent === containingFunction?.body
  );
}

function directConstCallBindingStatement(
  callExpression,
  containingBlock,
  bindingName
) {
  const declaration = callExpression?.parent;
  if (
    !callExpression
    || !ts.isVariableDeclaration(declaration)
    || declaration.initializer !== callExpression
    || !isNamedIdentifier(declaration.name, bindingName)
    || !ts.isVariableDeclarationList(declaration.parent)
    || declaration.parent.declarations.length !== 1
    || (
      declaration.parent.flags & ts.NodeFlags.Const
    ) === 0
    || !ts.isVariableStatement(declaration.parent.parent)
    || declaration.parent.parent.parent !== containingBlock
  ) {
    return null;
  }
  return declaration.parent.parent;
}

function isEmptyReturnStatement(node) {
  return ts.isReturnStatement(node) && !node.expression;
}

function hasRuntimeExportModifier(node) {
  return Boolean(
    node?.modifiers?.some(
      (modifier) => (
        modifier.kind === ts.SyntaxKind.ExportKeyword
        || modifier.kind === ts.SyntaxKind.DefaultKeyword
      )
    )
  );
}

function sourceNodeDigest(node, sourceFile) {
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: true,
  });
  return createHash('sha256')
    .update(
      printer.printNode(
        ts.EmitHint.Unspecified,
        node,
        sourceFile
      )
    )
    .digest('hex');
}

function inspectCriticalRuntimeFunctionDigests(
  filePath,
  sourceFile,
  bindingIdentifiers,
  syntaxNodes
) {
  const expectedFunctions =
    CRITICAL_RUNTIME_FUNCTION_DIGESTS.get(filePath);
  if (!expectedFunctions) {
    return [];
  }
  const mismatches = [];
  for (const [functionName, expectedDigest] of expectedFunctions) {
    const declaration = uniqueTopLevelFunctionBinding(
      sourceFile,
      bindingIdentifiers,
      functionName
    );
    const observedDigest = (
      declaration
      && !isIdentifierReassigned(syntaxNodes, functionName)
    )
      ? sourceNodeDigest(declaration, sourceFile)
      : null;
    if (observedDigest !== expectedDigest) {
      mismatches.push({
        expectedDigest,
        functionName,
        observedDigest,
      });
    }
  }
  return mismatches;
}

function collectReviewedMutableProcessSpreads(
  filePath,
  sourceFile,
  syntaxNodes,
  bindingIdentifiers,
  aliasKinds
) {
  const expectedFunctions =
    REVIEWED_MUTABLE_PROCESS_SPREAD_FUNCTION_DIGESTS.get(filePath);
  if (!expectedFunctions) {
    return {
      approvedSpreads: new Set(),
      mismatches: [],
    };
  }
  const approvedSpreads = new Set();
  const mismatches = [];
  for (const [functionName, expectedDigest] of expectedFunctions) {
    const declaration = uniqueTopLevelFunctionBinding(
      sourceFile,
      bindingIdentifiers,
      functionName
    );
    const observedDigest = declaration
      ? sourceNodeDigest(declaration, sourceFile)
      : null;
    const calls = syntaxNodes.filter(
      (node) => (
        ts.isCallExpression(node)
        && ts.isIdentifier(unwrapExpression(node.expression))
        && unwrapExpression(node.expression).text === functionName
      )
    );
    const spreads = syntaxNodes.filter(
      (node) => (
        ts.isSpreadAssignment(node)
        && directMutableProcessObjectKind(
          node.expression,
          aliasKinds
        ) === 'env'
      )
    );
    const [call] = calls;
    const [spread] = spreads;
    const objectLiteral = spread?.parent;
    const returnStatement = objectLiteral?.parent;
    const structurallySafe = Boolean(
      declaration
      && !hasRuntimeExportModifier(declaration)
      && !isIdentifierReassigned(syntaxNodes, functionName)
      && observedDigest === expectedDigest
      && declaration.parameters.length === 1
      && isNamedIdentifier(
        declaration.parameters[0].name,
        'processKind'
      )
      && !declaration.parameters[0].initializer
      && !declaration.parameters[0].dotDotDotToken
      && declaration.body?.statements.length === 1
      && calls.length === 1
      && call.arguments.length === 1
      && isNamedIdentifier(call.arguments[0], 'processKind')
      && nearestContainingFunction(call)?.name?.text
        === 'spawnProcess'
      && spreads.length === 1
      && ts.isObjectLiteralExpression(objectLiteral)
      && objectLiteral.properties[0] === spread
      && ts.isReturnStatement(returnStatement)
      && returnStatement.expression === objectLiteral
      && returnStatement.parent === declaration.body
    );
    if (structurallySafe) {
      approvedSpreads.add(spread);
    } else {
      mismatches.push({
        expectedDigest,
        functionName,
        observedDigest,
      });
    }
  }
  return { approvedSpreads, mismatches };
}

const NATIVE_PREVIEW_LAUNCH_CALL_COUNTS = new Map([
  ['JSON.stringify', 1],
  ['SHUTDOWN_SIGNALS.has', 1],
  ['buildNativePrApplicationSpawnSpec', 1],
  ['console.log', 1],
  ['previewProcess.kill', 1],
  ['process.exit', 1],
  ['process.once', 2],
  ['shutdownPreview', 2],
  ['spawnProcess', 1],
  ['waitForExit', 1],
]);
const SPAWN_PROCESS_CALL_COUNTS = new Map([
  ['maybeStartCliBridgeDaemon', 1],
  ['repairDistAliases', 1],
  ['runNativePrApplicationPreview', 1],
  ['runWebRuntime', 1],
  ['runWorkerRuntimeWithHealthServer', 1],
]);

function nativePreviewLaunchCallName(node) {
  const expression = unwrapExpression(node.expression);
  if (ts.isIdentifier(expression)) {
    return NATIVE_PREVIEW_LAUNCH_CALL_COUNTS.has(expression.text)
      ? expression.text
      : null;
  }
  if (!ts.isPropertyAccessExpression(expression)) {
    return null;
  }
  const parts = propertyAccessParts(expression);
  if (!parts || !parts[0]) {
    return null;
  }
  const callName = `${parts[0]}.${parts[1]}`;
  return NATIVE_PREVIEW_LAUNCH_CALL_COUNTS.has(callName)
    ? callName
    : null;
}

function inspectNativePreviewLaunchCalls(nodes, launchFunction) {
  const calls = nodes.filter(
    (node) => (
      ts.isCallExpression(node)
      && isWithinFunction(node, launchFunction)
    )
  );
  const counts = new Map();
  const unapprovedCalls = [];
  for (const call of calls) {
    const callName = nativePreviewLaunchCallName(call);
    if (!callName) {
      unapprovedCalls.push(call);
      continue;
    }
    counts.set(callName, (counts.get(callName) ?? 0) + 1);
  }
  const exactCounts = (
    unapprovedCalls.length === 0
    && [...NATIVE_PREVIEW_LAUNCH_CALL_COUNTS].every(
      ([callName, expectedCount]) => (
        counts.get(callName) === expectedCount
      )
    )
    && counts.size === NATIVE_PREVIEW_LAUNCH_CALL_COUNTS.size
  );
  return { calls, exactCounts, unapprovedCalls };
}

function inspectSpawnProcessCallSites(
  nodes,
  sourceFile,
  nativePreviewSpawnCall
) {
  const counts = new Map();
  const approvedCalls = new Set();
  const unapprovedCalls = [];
  const calls = nodes.filter(
    (node) => (
      ts.isCallExpression(node)
      && isNamedIdentifier(node.expression, 'spawnProcess')
    )
  );
  for (const call of calls) {
    const containingFunction = nearestContainingFunction(call);
    const functionName = (
      containingFunction
      && ts.isFunctionDeclaration(containingFunction)
      && containingFunction.parent === sourceFile
    )
      ? containingFunction.name?.text
      : null;
    if (
      !functionName
      || !SPAWN_PROCESS_CALL_COUNTS.has(functionName)
      || (
        functionName === NATIVE_PREVIEW_LAUNCH_FUNCTION
        && call !== nativePreviewSpawnCall
      )
    ) {
      unapprovedCalls.push(call);
      continue;
    }
    approvedCalls.add(call);
    counts.set(functionName, (counts.get(functionName) ?? 0) + 1);
  }
  const exactCounts = (
    unapprovedCalls.length === 0
    && [...SPAWN_PROCESS_CALL_COUNTS].every(
      ([functionName, expectedCount]) => (
        counts.get(functionName) === expectedCount
      )
    )
    && counts.size === SPAWN_PROCESS_CALL_COUNTS.size
  );
  return { approvedCalls, exactCounts };
}

function collectSyntaxNodes(root) {
  const nodes = [];
  function collect(node) {
    nodes.push(node);
    ts.forEachChild(node, collect);
  }
  collect(root);
  return nodes;
}

function uniqueTopLevelFunctionBinding(
  sourceFile,
  bindingIdentifiers,
  functionName
) {
  const bindings = bindingIdentifiers.filter(
    (identifier) => identifier.text === functionName
  );
  if (bindings.length !== 1) {
    return null;
  }
  const [binding] = bindings;
  return (
    ts.isFunctionDeclaration(binding.parent)
    && binding.parent.name === binding
    && binding.parent.parent === sourceFile
  )
    ? binding.parent
    : null;
}

function inspectContainedChildApplicationImportContract(
  filePath,
  sourceFile,
  syntaxNodes,
  bindingIdentifiers
) {
  if (filePath !== 'src/start-native-pr-preview.ts') {
    return {
      approvedDynamicImport: null,
      required: false,
      safe: true,
    };
  }
  const mainFunction = uniqueTopLevelFunctionBinding(
    sourceFile,
    bindingIdentifiers,
    'main'
  );
  const runtimeLocalStaticEdges = syntaxNodes.filter(
    (node) => (
      (
        ts.isImportDeclaration(node)
        && isRuntimeImportDeclaration(node)
      )
      || (
        ts.isExportDeclaration(node)
        && isRuntimeExportDeclaration(node)
      )
    )
  ).filter(
    (node) => (
      node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
      && isLocalImportSpecifier(node.moduleSpecifier.text)
    )
  );
  const dynamicImports = syntaxNodes.filter(
    (node) => (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
    )
  );
  const [dynamicImport] = dynamicImports;
  const argument = dynamicImport?.arguments[0];
  const awaitExpression = dynamicImport?.parent;
  const declaration = awaitExpression?.parent;
  const declarationList = declaration?.parent;
  const statement = declarationList?.parent;
  const bindingNames = (
    declaration
    && ts.isVariableDeclaration(declaration)
    && ts.isObjectBindingPattern(declaration.name)
  )
    ? declaration.name.elements.map((element) => (
      !element.dotDotDotToken
      && !element.propertyName
      && !element.initializer
      && ts.isIdentifier(element.name)
        ? element.name.text
        : null
    ))
    : [];
  const safe = Boolean(
    mainFunction?.body
    && runtimeLocalStaticEdges.length === 0
    && dynamicImports.length === 1
    && dynamicImport
    && dynamicImport.arguments.length === 1
    && argument
    && ts.isStringLiteral(argument)
    && argument.text === './nativePrPreviewApplication.js'
    && awaitExpression
    && ts.isAwaitExpression(awaitExpression)
    && awaitExpression.expression === dynamicImport
    && declaration
    && ts.isVariableDeclaration(declaration)
    && declaration.initializer === awaitExpression
    && declarationList
    && ts.isVariableDeclarationList(declarationList)
    && declarationList.declarations.length === 1
    && (
      declarationList.flags & ts.NodeFlags.Const
    ) !== 0
    && statement
    && ts.isVariableStatement(statement)
    && statement.parent === mainFunction.body
    && mainFunction.body.statements[1] === statement
    && bindingNames.length === 2
    && bindingNames[0] === 'createNativePrPreviewApplication'
    && bindingNames[1] === 'createNativePrPreviewReadinessState'
  );
  return {
    approvedDynamicImport: safe ? dynamicImport : null,
    required: true,
    safe,
  };
}

function inspectContainedChildListenerCallContract(
  filePath,
  sourceFile,
  syntaxNodes,
  bindingIdentifiers
) {
  if (filePath !== 'src/start-native-pr-preview.ts') {
    return {
      approvedCall: null,
      functionDeclaration: null,
      required: false,
      safe: true,
    };
  }
  const mainFunction = uniqueTopLevelFunctionBinding(
    sourceFile,
    bindingIdentifiers,
    'main'
  );
  const functionDeclaration = uniqueTopLevelFunctionBinding(
    sourceFile,
    bindingIdentifiers,
    'listen'
  );
  const calls = syntaxNodes.filter(
    (node) => (
      ts.isCallExpression(node)
      && isNamedIdentifier(
        unwrapExpression(node.expression),
        'listen'
      )
    )
  );
  const [call] = calls;
  const callStatement = call
    ? directAwaitCallStatement(call, mainFunction?.body)
    : null;
  const statementIndex = (
    callStatement
    && mainFunction?.body
  )
    ? mainFunction.body.statements.indexOf(callStatement)
    : -1;
  const serverStatement = statementIndex > 0
    ? mainFunction.body.statements[statementIndex - 1]
    : null;
  const serverDeclaration = (
    serverStatement
    && ts.isVariableStatement(serverStatement)
    && serverStatement.declarationList.declarations.length === 1
    && (
      serverStatement.declarationList.flags
      & ts.NodeFlags.Const
    ) !== 0
  )
    ? serverStatement.declarationList.declarations[0]
    : null;
  const createServerCall = serverDeclaration?.initializer;
  const safe = Boolean(
    mainFunction?.body
    && functionDeclaration
    && !isIdentifierReassigned(syntaxNodes, 'listen')
    && calls.length === 1
    && call
    && call.arguments.length === 3
    && isNamedIdentifier(call.arguments[0], 'server')
    && isNamedPropertyAccess(
      call.arguments[1],
      'identity',
      'port'
    )
    && isNamedPropertyAccess(
      call.arguments[2],
      'identity',
      'host'
    )
    && callStatement
    && statementIndex === 7
    && serverDeclaration
    && isNamedIdentifier(serverDeclaration.name, 'server')
    && createServerCall
    && ts.isCallExpression(createServerCall)
    && isNamedIdentifier(
      unwrapExpression(createServerCall.expression),
      'createServer'
    )
    && createServerCall.arguments.length === 1
    && isNamedIdentifier(
      createServerCall.arguments[0],
      'application'
    )
  );
  return {
    approvedCall: safe ? call : null,
    functionDeclaration,
    required: true,
    safe,
  };
}

function isAllowedContainedChildListenerUse(node, contract) {
  return Boolean(
    node === contract.functionDeclaration?.name
    || node === contract.approvedCall?.expression
  );
}

function directAwaitCallStatement(callExpression, containingBlock) {
  const awaitExpression = callExpression.parent;
  const statement = awaitExpression?.parent;
  return (
    ts.isAwaitExpression(awaitExpression)
    && awaitExpression.expression === callExpression
    && ts.isExpressionStatement(statement)
    && statement.expression === awaitExpression
    && statement.parent === containingBlock
  )
    ? statement
    : null;
}

function isStrictStringEquality(
  node,
  objectName,
  propertyName,
  expectedValue
) {
  return Boolean(
    ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && isNamedPropertyAccess(node.left, objectName, propertyName)
    && ts.isStringLiteral(node.right)
    && node.right.text === expectedValue
  );
}

function isProcessArgvEntry(node) {
  return Boolean(
    ts.isElementAccessExpression(node)
    && isNamedPropertyAccess(node.expression, 'process', 'argv')
    && node.argumentExpression
    && ts.isNumericLiteral(node.argumentExpression)
    && node.argumentExpression.text === '1'
  );
}

function isImportMetaUrl(node) {
  return Boolean(
    ts.isPropertyAccessExpression(node)
    && ts.isMetaProperty(node.expression)
    && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    && node.expression.name.text === 'meta'
    && node.name.text === 'url'
  );
}

function isExactMainEntryCondition(node) {
  if (
    !ts.isBinaryExpression(node)
    || node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken
    || !isProcessArgvEntry(node.left)
    || !ts.isBinaryExpression(node.right)
    || node.right.operatorToken.kind
      !== ts.SyntaxKind.EqualsEqualsEqualsToken
    || !isImportMetaUrl(node.right.left)
    || !ts.isPropertyAccessExpression(node.right.right)
    || node.right.right.name.text !== 'href'
    || !ts.isCallExpression(node.right.right.expression)
  ) {
    return false;
  }
  const pathCall = node.right.right.expression;
  return (
    isNamedIdentifier(pathCall.expression, 'pathToFileURL')
    && pathCall.arguments.length === 1
    && isProcessArgvEntry(pathCall.arguments[0])
  );
}

function directProcessMemberName(node) {
  if (
    ts.isPropertyAccessExpression(node)
    && isNamedIdentifier(node.expression, 'process')
  ) {
    return node.name.text;
  }
  if (
    ts.isElementAccessExpression(node)
    && isNamedIdentifier(node.expression, 'process')
  ) {
    return literalPropertyName(node.argumentExpression);
  }
  return null;
}

function isDirectProcessArgvAccess(node) {
  return directProcessMemberName(node) === 'argv';
}

function nodeHasAncestor(node, expectedAncestor) {
  let ancestor = node.parent;
  while (ancestor) {
    if (ancestor === expectedAncestor) {
      return true;
    }
    ancestor = ancestor.parent;
  }
  return false;
}

function topLevelContainingFunctionName(node, sourceFile) {
  let ancestor = node.parent;
  while (ancestor) {
    if (
      ts.isFunctionDeclaration(ancestor)
      && ancestor.parent === sourceFile
    ) {
      return ancestor.name?.text ?? null;
    }
    ancestor = ancestor.parent;
  }
  return null;
}

function processEffectUseKey(access, sourceFile, filePath) {
  const member = directProcessMemberName(access);
  const containingFunctionName =
    topLevelContainingFunctionName(access, sourceFile);
  if (
    member === 'exit'
    && ts.isCallExpression(access.parent)
    && access.parent.expression === access
    && access.parent.arguments.length === 1
  ) {
    const [argument] = access.parent.arguments;
    const argumentName = ts.isIdentifier(argument)
      ? argument.text
      : ts.isNumericLiteral(argument)
        ? argument.text
        : null;
    return containingFunctionName && argumentName
      ? `exit:${containingFunctionName}:${argumentName}`
      : null;
  }
  if (
    ['off', 'once'].includes(member)
    && ts.isCallExpression(access.parent)
    && access.parent.expression === access
    && access.parent.arguments.length === 2
    && ts.isStringLiteral(access.parent.arguments[0])
  ) {
    const signal = access.parent.arguments[0].text;
    const handler = access.parent.arguments[1];
    const handlerShape = ts.isIdentifier(handler)
      ? handler.text
      : ts.isArrowFunction(handler)
        ? 'arrow'
        : null;
    return containingFunctionName && handlerShape
      ? `${member}:${containingFunctionName}:${signal}:${handlerShape}`
      : null;
  }
  if (
    ['stderr', 'stdout'].includes(member)
    && ts.isCallExpression(access.parent)
    && isNamedIdentifier(
      access.parent.expression,
      'mirrorAndObserveWorkerOutput'
    )
    && access.parent.arguments[1] === access
  ) {
    return containingFunctionName
      ? `${member}:${containingFunctionName}:mirror`
      : null;
  }
  if (member === 'exitCode') {
    const assignment = access.parent;
    const lastSourceStatement = sourceFile.statements.at(-1);
    if (
      filePath === 'src/start-native-pr-preview.ts'
      && ts.isBinaryExpression(assignment)
      && assignment.left === access
      && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isNumericLiteral(assignment.right)
      && assignment.right.text === '1'
      && lastSourceStatement
      && ts.isIfStatement(lastSourceStatement)
      && isExactMainEntryCondition(lastSourceStatement.expression)
      && nodeHasAncestor(access, lastSourceStatement.thenStatement)
    ) {
      return 'exitCode:entry:1';
    }
  }
  return null;
}

function expectedProcessEffectUseKeys(filePath) {
  if (filePath === RAILWAY_LAUNCHER_FILE) {
    return new Set([
      'exit:main:1',
      'exit:runNativePrApplicationPreview:exitCode',
      'exit:runWebRuntime:exitCode',
      'exit:runWorkerRuntimeWithHealthServer:exitCode',
      'off:runPassivePrPreview:SIGINT:handleSigint',
      'off:runPassivePrPreview:SIGTERM:handleSigterm',
      'once:runNativePrApplicationPreview:SIGINT:arrow',
      'once:runNativePrApplicationPreview:SIGTERM:arrow',
      'once:runWebRuntime:SIGINT:arrow',
      'once:runWebRuntime:SIGTERM:arrow',
      'once:runWorkerRuntimeWithHealthServer:SIGINT:arrow',
      'once:runWorkerRuntimeWithHealthServer:SIGTERM:arrow',
      'once:runPassivePrPreview:SIGINT:handleSigint',
      'once:runPassivePrPreview:SIGTERM:handleSigterm',
      'stderr:runWorkerRuntimeWithHealthServer:mirror',
      'stdout:runWorkerRuntimeWithHealthServer:mirror',
    ]);
  }
  if (filePath === 'src/start-native-pr-preview.ts') {
    return new Set([
      'exitCode:entry:1',
      'off:main:SIGINT:handleSignal',
      'off:main:SIGTERM:handleSignal',
      'once:main:SIGINT:handleSignal',
      'once:main:SIGTERM:handleSignal',
    ]);
  }
  return new Set();
}

function inspectProcessEffectContract(nodes, sourceFile, filePath) {
  const expectedKeys = expectedProcessEffectUseKeys(filePath);
  const accesses = nodes.filter(
    (node) => (
      PROCESS_EFFECT_MEMBER_NAMES.has(
        directProcessMemberName(node)
      )
    )
  );
  const approvedAccesses = new Set();
  const observedKeys = new Set();
  for (const access of accesses) {
    const key = processEffectUseKey(access, sourceFile, filePath);
    if (
      key
      && expectedKeys.has(key)
      && !observedKeys.has(key)
    ) {
      observedKeys.add(key);
      approvedAccesses.add(access);
    }
  }
  return {
    approvedAccesses,
    required: expectedKeys.size > 0,
    safe: (
      accesses.length === expectedKeys.size
      && observedKeys.size === expectedKeys.size
    ),
  };
}

function directMutableProcessObjectKind(node, aliasKinds) {
  const expression = unwrapExpression(node);
  const directMember = directProcessMemberName(expression);
  if (MUTABLE_PROCESS_OBJECT_MEMBER_NAMES.has(directMember)) {
    return directMember;
  }
  return ts.isIdentifier(expression)
    ? aliasKinds.get(expression.text) ?? null
    : null;
}

function mutableProcessObjectKind(node, aliasKinds) {
  const expression = unwrapExpression(node);
  const directKind = directMutableProcessObjectKind(
    expression,
    aliasKinds
  );
  if (directKind) {
    return directKind;
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      mutableProcessObjectKind(expression.whenTrue, aliasKinds)
      ?? mutableProcessObjectKind(expression.whenFalse, aliasKinds)
    );
  }
  if (
    ts.isBinaryExpression(expression)
    && [
      ts.SyntaxKind.AmpersandAmpersandEqualsToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarEqualsToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.CommaToken,
      ts.SyntaxKind.EqualsToken,
      ts.SyntaxKind.QuestionQuestionEqualsToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(expression.operatorToken.kind)
  ) {
    if (
      [
        ts.SyntaxKind.AmpersandAmpersandEqualsToken,
        ts.SyntaxKind.BarBarEqualsToken,
        ts.SyntaxKind.CommaToken,
        ts.SyntaxKind.EqualsToken,
        ts.SyntaxKind.QuestionQuestionEqualsToken,
      ].includes(expression.operatorToken.kind)
    ) {
      return mutableProcessObjectKind(expression.right, aliasKinds);
    }
    return (
      mutableProcessObjectKind(expression.left, aliasKinds)
      ?? mutableProcessObjectKind(expression.right, aliasKinds)
    );
  }
  if (ts.isAwaitExpression(expression)) {
    return mutableProcessObjectKind(expression.expression, aliasKinds);
  }
  if (
    ts.isCallExpression(expression)
  ) {
    const target = unwrapExpression(expression.expression);
    const memberName = ts.isPropertyAccessExpression(target)
      ? target.name.text
      : ts.isElementAccessExpression(target)
        ? literalPropertyName(target.argumentExpression)
        : null;
    if (memberName === 'valueOf') {
      return mutableProcessObjectKind(
        target.expression,
        aliasKinds
      );
    }
  }
  if (ts.isTaggedTemplateExpression(expression)) {
    const target = unwrapExpression(expression.tag);
    const memberName = ts.isPropertyAccessExpression(target)
      ? target.name.text
      : ts.isElementAccessExpression(target)
        ? literalPropertyName(target.argumentExpression)
        : null;
    if (memberName === 'valueOf') {
      return mutableProcessObjectKind(
        target.expression,
        aliasKinds
      );
    }
  }
  return null;
}

function mutableProcessReferenceKind(node, aliasKinds) {
  const expression = unwrapExpression(node);
  const valueKind = mutableProcessObjectKind(expression, aliasKinds);
  if (valueKind) {
    return valueKind;
  }
  if (ts.isSpreadElement(expression)) {
    return mutableProcessReferenceKind(
      expression.expression,
      aliasKinds
    );
  }
  if (ts.isObjectLiteralExpression(expression)) {
    for (const property of expression.properties) {
      if (ts.isPropertyAssignment(property)) {
        const kind = mutableProcessReferenceKind(
          property.initializer,
          aliasKinds
        );
        if (kind) {
          return kind;
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        const kind = directMutableProcessObjectKind(
          property.name,
          aliasKinds
        );
        if (kind) {
          return kind;
        }
      } else if (ts.isSpreadAssignment(property)) {
        const spreadValueKind = mutableProcessObjectKind(
          property.expression,
          aliasKinds
        );
        if (!spreadValueKind) {
          const nestedKind = mutableProcessReferenceKind(
            property.expression,
            aliasKinds
          );
          if (nestedKind) {
            return nestedKind;
          }
        }
      }
    }
  }
  if (ts.isArrayLiteralExpression(expression)) {
    for (const element of expression.elements) {
      if (ts.isOmittedExpression(element)) {
        continue;
      }
      const kind = mutableProcessReferenceKind(element, aliasKinds);
      if (kind) {
        return kind;
      }
    }
  }
  return null;
}

function collectMutableProcessObjectAliases(nodes) {
  const aliasKinds = new Map();
  const functionDeclarationsByName = new Map();
  for (const node of nodes) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const declarations =
        functionDeclarationsByName.get(node.name.text) ?? [];
      declarations.push(node);
      functionDeclarationsByName.set(node.name.text, declarations);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      let targetName = null;
      let initializer = null;
      if (
        (
          ts.isVariableDeclaration(node)
          || ts.isParameter(node)
        )
        && ts.isIdentifier(node.name)
        && node.initializer
      ) {
        targetName = node.name.text;
        initializer = node.initializer;
      } else if (
        ts.isBindingElement(node)
        && ts.isIdentifier(node.name)
        && node.initializer
      ) {
        targetName = node.name.text;
        initializer = node.initializer;
      } else if (
        ts.isBinaryExpression(node)
        && [
          ts.SyntaxKind.AmpersandAmpersandEqualsToken,
          ts.SyntaxKind.BarBarEqualsToken,
          ts.SyntaxKind.EqualsToken,
          ts.SyntaxKind.QuestionQuestionEqualsToken,
        ].includes(node.operatorToken.kind)
        && ts.isIdentifier(node.left)
      ) {
        targetName = node.left.text;
        initializer = node.right;
      }
      if (targetName && initializer) {
        const kind = mutableProcessObjectKind(
          initializer,
          aliasKinds
        );
        if (kind && !aliasKinds.has(targetName)) {
          aliasKinds.set(targetName, kind);
          changed = true;
        }
      }
      if (
        (
          ts.isCallExpression(node)
          || ts.isNewExpression(node)
        )
        && node.arguments
      ) {
        const target = unwrapExpression(node.expression);
        if (!ts.isIdentifier(target)) {
          continue;
        }
        const declarations =
          functionDeclarationsByName.get(target.text) ?? [];
        node.arguments.forEach((argument, index) => {
          if (ts.isSpreadElement(argument)) {
            return;
          }
          const argumentKind = mutableProcessObjectKind(
            argument,
            aliasKinds
          );
          if (
            !argumentKind
            || !['argv', 'env'].includes(argumentKind)
          ) {
            return;
          }
          for (const declaration of declarations) {
            const parameter = declaration.parameters[index];
            if (
              !parameter
              || parameter.dotDotDotToken
              || !ts.isIdentifier(parameter.name)
              || aliasKinds.has(parameter.name.text)
            ) {
              continue;
            }
            aliasKinds.set(parameter.name.text, argumentKind);
            changed = true;
          }
        });
      }
    }
  }
  return aliasKinds;
}

function processMutableObjectRootKind(node, aliasKinds) {
  let expression = unwrapExpression(node);
  const directKind = mutableProcessObjectKind(expression, aliasKinds);
  if (directKind) {
    return directKind;
  }
  while (
    (
      ts.isPropertyAccessExpression(expression)
      || ts.isElementAccessExpression(expression)
    )
  ) {
    expression = unwrapExpression(expression.expression);
    const kind = mutableProcessObjectKind(expression, aliasKinds);
    if (kind) {
      return kind;
    }
  }
  return null;
}

function isAssignmentOperatorKind(kind) {
  return (
    kind >= ts.SyntaxKind.FirstAssignment
    && kind <= ts.SyntaxKind.LastAssignment
  );
}

function assignmentTargetMutatesMutableProcessObject(node, aliasKinds) {
  const target = unwrapExpression(node);
  if (
    runtimeNamespaceMemberAccess(target)?.namespace === 'process'
  ) {
    return true;
  }
  if (processMutableObjectRootKind(target, aliasKinds)) {
    return true;
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.some((property) => {
      if (ts.isPropertyAssignment(property)) {
        return assignmentTargetMutatesMutableProcessObject(
          property.initializer,
          aliasKinds
        );
      }
      if (ts.isSpreadAssignment(property)) {
        return assignmentTargetMutatesMutableProcessObject(
          property.expression,
          aliasKinds
        );
      }
      return false;
    });
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.some((element) => {
      if (ts.isOmittedExpression(element)) {
        return false;
      }
      if (ts.isSpreadElement(element)) {
        return assignmentTargetMutatesMutableProcessObject(
          element.expression,
          aliasKinds
        );
      }
      return assignmentTargetMutatesMutableProcessObject(
        element,
        aliasKinds
      );
    });
  }
  if (
    ts.isBinaryExpression(target)
    && target.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return assignmentTargetMutatesMutableProcessObject(
      target.left,
      aliasKinds
    );
  }
  return false;
}

function isProcessMutableStateMutation(
  node,
  aliasKinds,
  approvedProcessEffectAccesses
) {
  const reassignedStateTarget = reassignmentTarget(node);
  if (
    reassignedStateTarget
    && !approvedProcessEffectAccesses.has(
      unwrapExpression(reassignedStateTarget)
    )
    && assignmentTargetMutatesMutableProcessObject(
      reassignedStateTarget,
      aliasKinds
    )
  ) {
    return true;
  }
  if (
    (
      ts.isDeleteExpression(node)
      || ts.isPostfixUnaryExpression(node)
      || ts.isPrefixUnaryExpression(node)
    )
    && (
      processMutableObjectRootKind(
        ts.isDeleteExpression(node) ? node.expression : node.operand,
        aliasKinds
      )
      || runtimeNamespaceMemberAccess(
        unwrapExpression(
          ts.isDeleteExpression(node)
            ? node.expression
            : node.operand
        )
      )?.namespace === 'process'
    )
  ) {
    return true;
  }
  if (!ts.isCallExpression(node)) {
    return false;
  }
  const target = unwrapExpression(node.expression);
  const mutableReceiverMemberName =
    ts.isPropertyAccessExpression(target)
      ? target.name.text
      : ts.isElementAccessExpression(target)
        ? literalPropertyName(target.argumentExpression)
        : null;
  if (
    (
      ts.isPropertyAccessExpression(target)
      || ts.isElementAccessExpression(target)
    )
    && mutableProcessObjectKind(
      target.expression,
      aliasKinds
    )
    && ![
      'slice',
      'toString',
      'valueOf',
    ].includes(mutableReceiverMemberName)
  ) {
    return true;
  }
  if (node.arguments.length === 0) {
    return false;
  }
  const parts = propertyAccessParts(node.expression);
  return Boolean(
    parts
    && (
      (
        parts[0] === 'Object'
        && [
          'assign',
          'defineProperties',
          'defineProperty',
          'freeze',
          'preventExtensions',
          'seal',
          'setPrototypeOf',
        ].includes(parts[1])
      )
      || (
        parts[0] === 'Reflect'
        && ['defineProperty', 'deleteProperty', 'set'].includes(parts[1])
      )
    )
    && processMutableObjectRootKind(node.arguments[0], aliasKinds)
  );
}

function callTargetName(node) {
  const expression = unwrapExpression(node.expression);
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  const parts = propertyAccessParts(expression);
  return parts?.[0] && parts[1]
    ? `${parts[0]}.${parts[1]}`
    : null;
}

function assignmentTargetContainsIdentifier(node, identifierName) {
  const target = unwrapExpression(node);
  if (ts.isIdentifier(target)) {
    return target.text === identifierName;
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.some((property) => {
      if (ts.isPropertyAssignment(property)) {
        return assignmentTargetContainsIdentifier(
          property.initializer,
          identifierName
        );
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return property.name.text === identifierName;
      }
      if (ts.isSpreadAssignment(property)) {
        return assignmentTargetContainsIdentifier(
          property.expression,
          identifierName
        );
      }
      return false;
    });
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.some(
      (element) => (
        !ts.isOmittedExpression(element)
        && assignmentTargetContainsIdentifier(
          ts.isSpreadElement(element)
            ? element.expression
            : element,
          identifierName
        )
      )
    );
  }
  if (
    ts.isBinaryExpression(target)
    && target.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return assignmentTargetContainsIdentifier(
      target.left,
      identifierName
    );
  }
  return false;
}

function assignmentTargetContainsPropertyPath(
  node,
  rootName,
  memberName
) {
  const target = unwrapExpression(node);
  const parts = propertyAccessParts(target);
  if (
    parts?.[0] === rootName
    && parts[1] === memberName
  ) {
    return true;
  }
  if (
    ts.isElementAccessExpression(target)
    && isNamedIdentifier(target.expression, rootName)
    && literalPropertyName(target.argumentExpression) === null
  ) {
    return true;
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.some((property) => {
      if (ts.isPropertyAssignment(property)) {
        return assignmentTargetContainsPropertyPath(
          property.initializer,
          rootName,
          memberName
        );
      }
      if (ts.isSpreadAssignment(property)) {
        return assignmentTargetContainsPropertyPath(
          property.expression,
          rootName,
          memberName
        );
      }
      return false;
    });
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.some(
      (element) => (
        !ts.isOmittedExpression(element)
        && assignmentTargetContainsPropertyPath(
          ts.isSpreadElement(element)
            ? element.expression
            : element,
          rootName,
          memberName
        )
      )
    );
  }
  if (
    ts.isBinaryExpression(target)
    && target.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return assignmentTargetContainsPropertyPath(
      target.left,
      rootName,
      memberName
    );
  }
  return false;
}

function reassignmentTarget(node) {
  if (
    ts.isForInStatement(node)
    || ts.isForOfStatement(node)
  ) {
    return ts.isVariableDeclarationList(node.initializer)
      ? null
      : node.initializer;
  }
  if (
    ts.isBinaryExpression(node)
    && isAssignmentOperatorKind(node.operatorToken.kind)
  ) {
    return node.left;
  }
  return null;
}

function isIdentifierReassigned(nodes, identifierName) {
  return nodes.some((node) => {
    const target = reassignmentTarget(node);
    if (target) {
      return assignmentTargetContainsIdentifier(
        target,
        identifierName
      );
    }
    if (
      ts.isPrefixUnaryExpression(node)
      || ts.isPostfixUnaryExpression(node)
      || ts.isDeleteExpression(node)
    ) {
      const target = unwrapExpression(
        ts.isDeleteExpression(node) ? node.expression : node.operand
      );
      return (
        ts.isIdentifier(target)
        && target.text === identifierName
      );
    }
    return false;
  });
}

function isPropertyPathReassigned(nodes, rootName, memberName) {
  return nodes.some((node) => {
    const assignmentTarget = reassignmentTarget(node);
    if (assignmentTarget) {
      return assignmentTargetContainsPropertyPath(
        assignmentTarget,
        rootName,
        memberName
      );
    }
    if (
      ts.isPrefixUnaryExpression(node)
      || ts.isPostfixUnaryExpression(node)
      || ts.isDeleteExpression(node)
    ) {
      return assignmentTargetContainsPropertyPath(
        ts.isDeleteExpression(node) ? node.expression : node.operand,
        rootName,
        memberName
      );
    }
    return false;
  });
}

function isReviewedMutableProcessCallTarget(
  node,
  filePath,
  targetName,
  argumentIndex,
  sourceFile,
  syntaxNodes,
  bindingIdentifiers
) {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  const containingFunctionName =
    topLevelContainingFunctionName(node, sourceFile);
  const containingFunction = containingFunctionName
    ? uniqueTopLevelFunctionBinding(
      sourceFile,
      bindingIdentifiers,
      containingFunctionName
    )
    : null;
  if (
    !containingFunction
    || nearestContainingFunction(node) !== containingFunction
  ) {
    return false;
  }
  const target = unwrapExpression(node.expression);
  if (
    REVIEWED_READ_ONLY_MUTABLE_PROCESS_CALL_TARGETS.has(targetName)
  ) {
    const parts = propertyAccessParts(target);
    return Boolean(
      parts?.[0] === 'Object'
      && parts[1] === 'keys'
      && ts.isPropertyAccessExpression(target)
      && bindingIdentifiers.every(
        (identifier) => identifier.text !== 'Object'
      )
      && !isIdentifierReassigned(syntaxNodes, 'Object')
      && !isPropertyPathReassigned(
        syntaxNodes,
        'Object',
        'keys'
      )
    );
  }
  if (!ts.isIdentifier(target) || target.text !== targetName) {
    return false;
  }
  const declaration = uniqueTopLevelFunctionBinding(
    sourceFile,
    bindingIdentifiers,
    targetName
  );
  const parameter = declaration?.parameters[argumentIndex];
  if (
    filePath === 'src/start-native-pr-preview.ts'
    && targetName === 'resolveNativePrPreviewChildEnvironment'
  ) {
    const mainFunction = uniqueTopLevelFunctionBinding(
      sourceFile,
      bindingIdentifiers,
      'main'
    );
    const bindingStatement = directConstCallBindingStatement(
      node,
      mainFunction?.body,
      'identity'
    );
    if (
      !mainFunction
      || !bindingStatement
      || mainFunction.body?.statements[0] !== bindingStatement
    ) {
      return false;
    }
  }
  return Boolean(
    declaration
    && parameter
    && !parameter.dotDotDotToken
    && ts.isIdentifier(parameter.name)
    && !isIdentifierReassigned(syntaxNodes, targetName)
  );
}

function reviewedMutableProcessCallKey(
  node,
  argumentIndex,
  kind,
  sourceFile
) {
  const targetName = callTargetName(node);
  const containingFunctionName =
    topLevelContainingFunctionName(node, sourceFile);
  return targetName && containingFunctionName
    ? `${targetName}:${argumentIndex}:${kind}:${containingFunctionName}`
    : null;
}

function collectReviewedMutableProcessCallArguments(
  filePath,
  sourceFile,
  syntaxNodes,
  aliasKinds,
  bindingIdentifiers
) {
  const expectedCalls =
    ALLOWED_MUTABLE_PROCESS_CALL_ARGUMENTS.get(filePath);
  if (!expectedCalls) {
    return {
      approvedArguments: new Set(),
      mismatches: [],
    };
  }
  const candidatesByKey = new Map();
  for (const node of syntaxNodes) {
    if (!ts.isCallExpression(node)) {
      continue;
    }
    const targetName = callTargetName(node);
    node.arguments.forEach((argument, argumentIndex) => {
      if (ts.isSpreadElement(argument)) {
        return;
      }
      const kind = directMutableProcessObjectKind(
        argument,
        aliasKinds
      );
      if (!kind) {
        return;
      }
      const key = reviewedMutableProcessCallKey(
        node,
        argumentIndex,
        kind,
        sourceFile
      );
      if (
        !key
        || !expectedCalls.has(key)
        || !isReviewedMutableProcessCallTarget(
          node,
          filePath,
          targetName,
          argumentIndex,
          sourceFile,
          syntaxNodes,
          bindingIdentifiers
        )
      ) {
        return;
      }
      const candidates = candidatesByKey.get(key) ?? [];
      candidates.push({
        argument,
        callDigest: sourceNodeDigest(node, sourceFile),
      });
      candidatesByKey.set(key, candidates);
    });
  }
  const approvedArguments = new Set();
  const mismatches = [];
  for (const [key, expectedCallDigests] of expectedCalls) {
    const candidates = candidatesByKey.get(key) ?? [];
    const observedCallDigests = candidates
      .map((candidate) => candidate.callDigest)
      .sort();
    const sortedExpectedCallDigests =
      [...expectedCallDigests].sort();
    const countMismatch = (
      observedCallDigests.length
        !== sortedExpectedCallDigests.length
    );
    const digestMismatch = (
      !countMismatch
      && observedCallDigests.some(
        (digest, index) => (
          digest !== sortedExpectedCallDigests[index]
        )
      )
    );
    if (countMismatch || digestMismatch) {
      mismatches.push({
        digestMismatch,
        expectedCount: sortedExpectedCallDigests.length,
        key,
        observedCount: candidates.length,
      });
      continue;
    }
    for (const candidate of candidates) {
      approvedArguments.add(candidate.argument);
    }
  }
  return { approvedArguments, mismatches };
}

function unapprovedMutableProcessCallArguments(
  node,
  aliasKinds,
  approvedProcessEffectAccesses,
  approvedMutableProcessCallArguments
) {
  if (
    !ts.isCallExpression(node)
    && !ts.isNewExpression(node)
  ) {
    return [];
  }
  const unapprovedArguments = [];
  node.arguments?.forEach((argument, index) => {
    const expression = unwrapExpression(argument);
    const kind = mutableProcessReferenceKind(
      expression,
      aliasKinds
    );
    if (!kind) {
      return;
    }
    if (
      ts.isCallExpression(node)
      && approvedMutableProcessCallArguments.has(argument)
    ) {
      return;
    }
    if (
      directProcessMemberName(expression)
      && approvedProcessEffectAccesses.has(expression)
    ) {
      return;
    }
    unapprovedArguments.push({ index, kind });
  });
  return unapprovedArguments;
}

function isWithinDestructuringAssignmentTarget(node) {
  let current = node;
  let ancestor = node.parent;
  while (ancestor) {
    if (
      ts.isBinaryExpression(ancestor)
      && isAssignmentOperatorKind(ancestor.operatorToken.kind)
    ) {
      let target = current;
      while (target.parent && target.parent !== ancestor) {
        target = target.parent;
      }
      return ancestor.left === target;
    }
    if (
      ts.isStatement(ancestor)
      || ts.isFunctionLike(ancestor)
    ) {
      return false;
    }
    current = ancestor;
    ancestor = ancestor.parent;
  }
  return false;
}

function isExportedVariableDeclaration(node) {
  const declarationList = node.parent;
  const statement = declarationList?.parent;
  return Boolean(
    ts.isVariableDeclarationList(declarationList)
    && ts.isVariableStatement(statement)
    && hasRuntimeExportModifier(statement)
  );
}

function collectBindingNameIdentifiers(name, identifiers) {
  if (ts.isIdentifier(name)) {
    identifiers.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    collectBindingNameIdentifiers(element.name, identifiers);
  }
}

function collectExportedVariableBindingNames(sourceFile) {
  const identifiers = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement)
      || !hasRuntimeExportModifier(statement)
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      collectBindingNameIdentifiers(declaration.name, identifiers);
    }
  }
  return identifiers;
}

function isParameterProperty(node) {
  return Boolean(
    ts.isParameter(node)
    && node.modifiers?.some(
      (modifier) => [
        ts.SyntaxKind.OverrideKeyword,
        ts.SyntaxKind.PrivateKeyword,
        ts.SyntaxKind.ProtectedKeyword,
        ts.SyntaxKind.PublicKeyword,
        ts.SyntaxKind.ReadonlyKeyword,
      ].includes(modifier.kind)
    )
  );
}

function assignmentTargetContainsRestElement(node) {
  const target = unwrapExpression(node);
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.some(
      (property) => (
        ts.isSpreadAssignment(property)
        || (
          ts.isPropertyAssignment(property)
          && assignmentTargetContainsRestElement(
            property.initializer
          )
        )
      )
    );
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.some(
      (element) => (
        !ts.isOmittedExpression(element)
        && (
          ts.isSpreadElement(element)
          || assignmentTargetContainsRestElement(element)
        )
      )
    );
  }
  if (
    ts.isBinaryExpression(target)
    && target.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return assignmentTargetContainsRestElement(target.left);
  }
  return false;
}

function bindingPatternInitializer(node) {
  const pattern = node.parent;
  const owner = pattern?.parent;
  return (
    (
      ts.isVariableDeclaration(owner)
      || ts.isParameter(owner)
      || ts.isBindingElement(owner)
    )
    && owner.initializer
  )
    ? owner.initializer
    : null;
}

function isMutableProcessReferenceEscape(
  node,
  aliasKinds,
  approvedMutableProcessSpreads,
  exportedVariableBindingNames
) {
  if (
    (
      ts.isReturnStatement(node)
      || ts.isThrowStatement(node)
      || ts.isYieldExpression(node)
      || ts.isExportAssignment(node)
    )
    && node.expression
  ) {
    return Boolean(
      mutableProcessReferenceKind(node.expression, aliasKinds)
    );
  }
  if (
    ts.isArrowFunction(node)
    && !ts.isBlock(node.body)
  ) {
    return Boolean(
      mutableProcessReferenceKind(node.body, aliasKinds)
    );
  }
  if (
    isParameterProperty(node)
    && node.initializer
    && mutableProcessReferenceKind(node.initializer, aliasKinds)
  ) {
    return true;
  }
  if (
    ts.isVariableDeclaration(node)
    && node.initializer
  ) {
    const valueKind = mutableProcessObjectKind(
      node.initializer,
      aliasKinds
    );
    const referenceKind = mutableProcessReferenceKind(
      node.initializer,
      aliasKinds
    );
    if (!referenceKind) {
      return false;
    }
    if (
      valueKind
      && ts.isIdentifier(node.name)
      && !isExportedVariableDeclaration(node)
    ) {
      return false;
    }
    if (
      valueKind
      && (
        ts.isObjectBindingPattern(node.name)
        || ts.isArrayBindingPattern(node.name)
      )
    ) {
      return false;
    }
    return true;
  }
  if (
    ts.isBinaryExpression(node)
    && isAssignmentOperatorKind(node.operatorToken.kind)
  ) {
    const valueKind = mutableProcessObjectKind(
      node.right,
      aliasKinds
    );
    const referenceKind = mutableProcessReferenceKind(
      node.right,
      aliasKinds
    );
    if (!referenceKind) {
      return false;
    }
    const target = unwrapExpression(node.left);
    if (valueKind && ts.isIdentifier(target)) {
      return exportedVariableBindingNames.has(target.text);
    }
    if (
      valueKind
      && (
        ts.isObjectLiteralExpression(target)
        || ts.isArrayLiteralExpression(target)
      )
    ) {
      return assignmentTargetContainsRestElement(target);
    }
    return true;
  }
  if (
    ts.isSpreadAssignment(node)
    && mutableProcessObjectKind(node.expression, aliasKinds)
    && !approvedMutableProcessSpreads.has(node)
  ) {
    return true;
  }
  if (
    ts.isBindingElement(node)
    && node.dotDotDotToken
  ) {
    const initializer = bindingPatternInitializer(node);
    return Boolean(
      initializer
      && mutableProcessObjectKind(initializer, aliasKinds)
    );
  }
  if (
    ts.isPropertyAssignment(node)
    && !isWithinDestructuringAssignmentTarget(node)
  ) {
    return Boolean(
      mutableProcessReferenceKind(node.initializer, aliasKinds)
    );
  }
  if (
    ts.isShorthandPropertyAssignment(node)
    && !isWithinDestructuringAssignmentTarget(node)
  ) {
    return Boolean(
      directMutableProcessObjectKind(node.name, aliasKinds)
    );
  }
  if (
    ts.isPropertyDeclaration(node)
    && node.initializer
  ) {
    return Boolean(
      mutableProcessReferenceKind(node.initializer, aliasKinds)
    );
  }
  if (
    ts.isArrayLiteralExpression(node)
    && !isWithinDestructuringAssignmentTarget(node)
  ) {
    return Boolean(
      mutableProcessReferenceKind(node, aliasKinds)
    );
  }
  if (ts.isTaggedTemplateExpression(node)) {
    if (mutableProcessReferenceKind(node.tag, aliasKinds)) {
      return true;
    }
    return (
      ts.isTemplateExpression(node.template)
      && node.template.templateSpans.some(
        (span) => Boolean(
          mutableProcessReferenceKind(
            span.expression,
            aliasKinds
          )
        )
      )
    );
  }
  if (ts.isExportSpecifier(node)) {
    const localName = node.propertyName ?? node.name;
    return Boolean(
      directMutableProcessObjectKind(localName, aliasKinds)
    );
  }
  return false;
}

function inspectLauncherProcessArgvContract(
  nodes,
  sourceFile
) {
  const accesses = nodes.filter(isDirectProcessArgvAccess);
  const resolverNames = new Set();
  const resolverAccesses = accesses.filter((access) => {
    const sliceAccess = access.parent;
    const sliceCall = sliceAccess?.parent;
    const parameter = sliceCall?.parent;
    const resolverFunction = parameter?.parent;
    const isApproved = Boolean(
      ts.isPropertyAccessExpression(sliceAccess)
      && sliceAccess.expression === access
      && sliceAccess.name.text === 'slice'
      && ts.isCallExpression(sliceCall)
      && sliceCall.expression === sliceAccess
      && sliceCall.arguments.length === 1
      && ts.isNumericLiteral(sliceCall.arguments[0])
      && sliceCall.arguments[0].text === '2'
      && ts.isParameter(parameter)
      && parameter.initializer === sliceCall
      && isNamedIdentifier(parameter.name, 'args')
      && ts.isFunctionDeclaration(resolverFunction)
      && resolverFunction.parent === sourceFile
      && parameter === resolverFunction.parameters[0]
      && resolverFunction.name
      && [
        'resolveNativePrPreviewOrThrow',
        'resolvePassivePrPreviewOrThrow',
      ].includes(resolverFunction.name.text)
    );
    if (isApproved) {
      resolverNames.add(resolverFunction.name.text);
    }
    return isApproved;
  });
  const lastSourceStatement = sourceFile.statements.at(-1);
  const mainEntryIf = (
    lastSourceStatement
    && ts.isIfStatement(lastSourceStatement)
    && isExactMainEntryCondition(lastSourceStatement.expression)
  )
    ? lastSourceStatement
    : null;
  const entryAccesses = accesses.filter(
    (access) => (
      isProcessArgvEntry(access.parent)
      && nodeHasAncestor(access, mainEntryIf?.expression)
    )
  );
  const argvBindingElements = nodes.filter(
    (node) => (
      ts.isBindingElement(node)
      && ts.isObjectBindingPattern(node.parent)
      && objectBindingSourceNamespace(node.parent) === 'process'
      && staticPropertyName(node.propertyName ?? node.name) === 'argv'
    )
  );
  return Boolean(
    accesses.length === 4
    && resolverAccesses.length === 2
    && resolverNames.size === 2
    && entryAccesses.length === 2
    && argvBindingElements.length === 0
  );
}

function inspectSensitiveLauncherHelpers(
  nodes,
  sourceFile,
  bindingIdentifiers
) {
  const functions = new Map();
  for (const helperName of SENSITIVE_LAUNCHER_HELPER_NAMES) {
    functions.set(
      helperName,
      uniqueTopLevelFunctionBinding(
        sourceFile,
        bindingIdentifiers,
        helperName
      )
    );
  }
  const mainFunction = functions.get('main');
  const mainTryStatement = (
    mainFunction?.body
    && mainFunction.body.statements.length === 1
    && ts.isTryStatement(mainFunction.body.statements[0])
  )
    ? mainFunction.body.statements[0]
    : null;
  const mainTryBlock = mainTryStatement?.tryBlock ?? null;
  const nativePreviewIf = mainTryBlock?.statements.find(
    (statement) => (
      ts.isIfStatement(statement)
      && isNamedPropertyAccess(
        statement.expression,
        'nativePrPreview',
        'enabled'
      )
      && ts.isBlock(statement.thenStatement)
    )
  ) ?? null;
  const nativePreviewBlock = nativePreviewIf?.thenStatement ?? null;
  const applicationIf = nativePreviewBlock?.statements.find(
    (statement) => (
      ts.isIfStatement(statement)
      && isStrictStringEquality(
        statement.expression,
        'nativePrPreview',
        'runtimeMode',
        'application'
      )
      && ts.isBlock(statement.thenStatement)
    )
  ) ?? null;
  const applicationBlock = applicationIf?.thenStatement ?? null;
  const workerIf = mainTryBlock?.statements.find(
    (statement) => (
      ts.isIfStatement(statement)
      && ts.isBinaryExpression(statement.expression)
      && statement.expression.operatorToken.kind
        === ts.SyntaxKind.EqualsEqualsEqualsToken
      && isNamedIdentifier(statement.expression.left, 'processKind')
      && ts.isStringLiteral(statement.expression.right)
      && statement.expression.right.text === 'worker'
      && ts.isBlock(statement.thenStatement)
    )
  ) ?? null;
  const workerBlock = workerIf?.thenStatement ?? null;
  const lastSourceStatement = sourceFile.statements.at(-1);
  const mainEntryIf = (
    lastSourceStatement
    && ts.isIfStatement(lastSourceStatement)
    && isExactMainEntryCondition(lastSourceStatement.expression)
    && ts.isBlock(lastSourceStatement.thenStatement)
  )
    ? lastSourceStatement
    : null;
  const mainEntryBlock = mainEntryIf?.thenStatement ?? null;
  const callsByName = new Map();
  for (const helperName of SENSITIVE_LAUNCHER_HELPER_NAMES) {
    callsByName.set(
      helperName,
      nodes.filter(
        (node) => (
          ts.isCallExpression(node)
          && isNamedIdentifier(node.expression, helperName)
        )
      )
    );
  }
  const onlyCall = (helperName) => {
    const calls = callsByName.get(helperName);
    return calls?.length === 1 ? calls[0] : null;
  };
  const maybeStartCall = onlyCall('maybeStartCliBridgeDaemon');
  const productionEnvironmentCall =
    onlyCall('buildChildEnvironment');
  const childEnvironmentCall =
    onlyCall('buildNativePrApplicationChildEnvironment');
  const mainCall = onlyCall('main');
  const mirrorCalls =
    callsByName.get('mirrorAndObserveWorkerOutput') ?? [];
  const repairCall = onlyCall('repairDistAliases');
  const nativeApplicationCall =
    onlyCall('runNativePrApplicationPreview');
  const passivePreviewCall = onlyCall('runPassivePrPreview');
  const resolverCalls =
    callsByName.get('resolveNativePrPreviewOrThrow') ?? [];
  const webCall = onlyCall('runWebRuntime');
  const workerCall = onlyCall('runWorkerRuntimeWithHealthServer');
  const approvedCalls = new Set();
  const spawnSpecBuilderFunction =
    uniqueTopLevelFunctionBinding(
      sourceFile,
      bindingIdentifiers,
      'buildNativePrApplicationSpawnSpec'
    );
  const childEnvironmentFunction =
    functions.get('buildNativePrApplicationChildEnvironment');
  const childResolverCall = resolverCalls.find(
    (call) => (
      nearestContainingFunction(call) === childEnvironmentFunction
      && directConstCallBindingStatement(
        call,
        childEnvironmentFunction?.body,
        'preview'
      ) === childEnvironmentFunction?.body?.statements[0]
      && call.arguments.length === 2
      && ts.isArrayLiteralExpression(call.arguments[0])
      && call.arguments[0].elements.length === 1
      && isNamedIdentifier(
        call.arguments[0].elements[0],
        'APPLICATION_PR_PREVIEW_ARGUMENT'
      )
      && isNamedIdentifier(call.arguments[1], 'env')
    )
  ) ?? null;
  const mainResolverCall = resolverCalls.find(
    (call) => (
      nearestContainingFunction(call) === mainFunction
      && directConstCallBindingStatement(
        call,
        mainTryBlock,
        'nativePrPreview'
      ) === mainTryBlock?.statements[0]
      && call.arguments.length === 0
    )
  ) ?? null;
  if (
    resolverCalls.length === 2
    && childResolverCall
    && mainResolverCall
  ) {
    approvedCalls.add(childResolverCall);
    approvedCalls.add(mainResolverCall);
  }
  if (
    productionEnvironmentCall
    && productionEnvironmentCall.arguments.length === 1
    && isNamedIdentifier(
      productionEnvironmentCall.arguments[0],
      'processKind'
    )
    && nearestContainingFunction(productionEnvironmentCall)
      === uniqueTopLevelFunctionBinding(
        sourceFile,
        bindingIdentifiers,
        'spawnProcess'
      )
  ) {
    approvedCalls.add(productionEnvironmentCall);
  }
  if (
    childEnvironmentCall
    && childEnvironmentCall.arguments.length === 1
    && isNamedIdentifier(childEnvironmentCall.arguments[0], 'env')
    && nearestContainingFunction(childEnvironmentCall)
      === spawnSpecBuilderFunction
  ) {
    approvedCalls.add(childEnvironmentCall);
  }
  if (
    mainCall
    && mainCall.arguments.length === 0
    && directAwaitCallStatement(mainCall, mainEntryBlock)
    && mainEntryBlock?.statements.length === 1
  ) {
    approvedCalls.add(mainCall);
  }
  if (
    maybeStartCall
    && maybeStartCall.arguments.length === 0
    && nearestContainingFunction(maybeStartCall)
      === functions.get('runWebRuntime')
    && isDirectConstCallBinding(
      maybeStartCall,
      functions.get('runWebRuntime'),
      'daemonProcess'
    )
  ) {
    approvedCalls.add(maybeStartCall);
  }
  if (
    repairCall
    && repairCall.arguments.length === 1
    && ts.isStringLiteral(repairCall.arguments[0])
    && repairCall.arguments[0].text === 'worker'
    && nearestContainingFunction(repairCall)
      === functions.get('runWorkerRuntimeWithHealthServer')
    && directAwaitCallStatement(
      repairCall,
      functions.get('runWorkerRuntimeWithHealthServer')?.body
    )
  ) {
    approvedCalls.add(repairCall);
  }
  if (
    nativeApplicationCall
    && nativeApplicationCall.arguments.length === 0
    && nearestContainingFunction(nativeApplicationCall) === mainFunction
    && directAwaitCallStatement(
      nativeApplicationCall,
      applicationBlock
    )
  ) {
    approvedCalls.add(nativeApplicationCall);
  }
  if (
    passivePreviewCall
    && passivePreviewCall.arguments.length === 2
    && nearestContainingFunction(passivePreviewCall) === mainFunction
    && directAwaitCallStatement(
      passivePreviewCall,
      nativePreviewBlock
    )
  ) {
    approvedCalls.add(passivePreviewCall);
  }
  if (
    workerCall
    && workerCall.arguments.length === 0
    && nearestContainingFunction(workerCall) === mainFunction
    && directAwaitCallStatement(workerCall, workerBlock)
  ) {
    approvedCalls.add(workerCall);
  }
  const workerFunction =
    functions.get('runWorkerRuntimeWithHealthServer');
  const exactMirrorCall = (
    call,
    sourceMember,
    destinationMember,
    observeReadiness
  ) => {
    if (!call || call.arguments.length !== 4) {
      return false;
    }
    const options = exactObjectPropertyAssignments(
      call.arguments[3],
      ['observeReadiness']
    );
    return Boolean(
      isNamedPropertyAccess(
        call.arguments[0],
        'workerProcess',
        sourceMember
      )
      && isNamedPropertyAccess(
        call.arguments[1],
        'process',
        destinationMember
      )
      && isNamedIdentifier(call.arguments[2], 'readinessState')
      && options
      && options.get('observeReadiness')?.kind
        === (
          observeReadiness
            ? ts.SyntaxKind.TrueKeyword
            : ts.SyntaxKind.FalseKeyword
        )
      && nearestContainingFunction(call) === workerFunction
      && directFunctionBodyStatement(call, workerFunction)
        === call.parent
    );
  };
  if (
    mirrorCalls.length === 2
    && exactMirrorCall(
      mirrorCalls[0],
      'stdout',
      'stdout',
      true
    )
    && exactMirrorCall(
      mirrorCalls[1],
      'stderr',
      'stderr',
      false
    )
  ) {
    approvedCalls.add(mirrorCalls[0]);
    approvedCalls.add(mirrorCalls[1]);
  }
  const webStatement = webCall
    ? directAwaitCallStatement(webCall, mainTryBlock)
    : null;
  if (
    webCall
    && webCall.arguments.length === 0
    && nearestContainingFunction(webCall) === mainFunction
    && webStatement
    && webStatement === mainTryBlock?.statements.at(-1)
  ) {
    approvedCalls.add(webCall);
  }
  const nativeProcessKindStatement =
    nativePreviewBlock?.statements[0] ?? null;
  const nativeProcessKindDeclaration = (
    nativeProcessKindStatement
    && ts.isVariableStatement(nativeProcessKindStatement)
    && nativeProcessKindStatement.declarationList.declarations.length
      === 1
    && (
      nativeProcessKindStatement.declarationList.flags
      & ts.NodeFlags.Const
    ) !== 0
  )
    ? nativeProcessKindStatement.declarationList.declarations[0]
    : null;
  const nativeProcessKindSafe = Boolean(
    nativeProcessKindDeclaration
    && isNamedIdentifier(
      nativeProcessKindDeclaration.name,
      'processKind'
    )
    && nativeProcessKindDeclaration.initializer
    && isNullishFallback(
      nativeProcessKindDeclaration.initializer,
      'nativePrPreview',
      'processKind',
      (fallback) => (
        ts.isCallExpression(fallback)
        && isNamedIdentifier(
          fallback.expression,
          'resolvePassivePrProcessKindOrThrow'
        )
        && fallback.arguments.length === 0
      )
    )
  );
  const passiveProperties = passivePreviewCall?.arguments.length === 2
    ? exactObjectPropertyAssignments(
      passivePreviewCall.arguments[1],
      ['prNumber', 'sourceCommit']
    )
    : null;
  const nativePreviewSelectionSafe = Boolean(
    mainResolverCall
    && nativeApplicationCall
    && passivePreviewCall
    && mainTryBlock?.statements[0]
      === directConstCallBindingStatement(
        mainResolverCall,
        mainTryBlock,
        'nativePrPreview'
      )
    && mainTryBlock.statements[1] === nativePreviewIf
    && nativePreviewBlock?.statements.length === 4
    && nativeProcessKindSafe
    && nativePreviewBlock.statements[1] === applicationIf
    && applicationBlock?.statements.length === 2
    && directAwaitCallStatement(
      nativeApplicationCall,
      applicationBlock
    ) === applicationBlock.statements[0]
    && isEmptyReturnStatement(applicationBlock.statements[1])
    && directAwaitCallStatement(
      passivePreviewCall,
      nativePreviewBlock
    ) === nativePreviewBlock.statements[2]
    && isNamedIdentifier(
      passivePreviewCall.arguments[0],
      'processKind'
    )
    && passiveProperties
    && isNamedPropertyAccess(
      passiveProperties.get('prNumber'),
      'nativePrPreview',
      'prNumber'
    )
    && isNamedPropertyAccess(
      passiveProperties.get('sourceCommit'),
      'nativePrPreview',
      'sourceCommit'
    )
    && isEmptyReturnStatement(nativePreviewBlock.statements[3])
  );
  const nonExportableDeclarationsSafe = [
    ...NON_EXPORTABLE_LAUNCHER_HELPER_NAMES,
  ].every((helperName) => {
    const helperFunction = helperName === 'spawnProcess'
      ? uniqueTopLevelFunctionBinding(
        sourceFile,
        bindingIdentifiers,
        helperName
      )
      : functions.get(helperName);
    return helperFunction && !hasRuntimeExportModifier(helperFunction);
  });
  const declarationNamesSafe = (
    mainFunction
    && [...functions.values()].every(Boolean)
  );
  return {
    approvedCalls,
    contractSafe: Boolean(
      declarationNamesSafe
      && nativePreviewSelectionSafe
      && nonExportableDeclarationsSafe
      && approvedCalls.size
        === SENSITIVE_LAUNCHER_HELPER_NAMES.size + 2
    ),
    functions,
  };
}

function isExactNativePreviewSpawnSpecDeclaration(
  declaration,
  launchFunction
) {
  if (
    !launchFunction
    || !ts.isIdentifier(declaration.name)
    || declaration.name.text !== 'spawnSpec'
    || !ts.isVariableDeclarationList(declaration.parent)
    || declaration.parent.declarations.length !== 1
    || (
      declaration.parent.flags & ts.NodeFlags.Const
    ) === 0
    || !ts.isVariableStatement(declaration.parent.parent)
    || declaration.parent.parent.parent !== launchFunction.body
    || !declaration.initializer
    || !ts.isCallExpression(declaration.initializer)
    || !ts.isIdentifier(declaration.initializer.expression)
    || declaration.initializer.expression.text
      !== 'buildNativePrApplicationSpawnSpec'
  ) {
    return false;
  }
  return declaration.initializer.arguments.length === 0;
}

function inspectLauncherRepositoryRootContract(
  sourceFile,
  syntaxNodes,
  bindingIdentifiers
) {
  const rootBindings = bindingIdentifiers.filter(
    (identifier) => (
      identifier.text === 'LAUNCHER_REPOSITORY_ROOT'
    )
  );
  const rootBinding = rootBindings.length === 1
    ? rootBindings[0]
    : null;
  const declaration = rootBinding?.parent;
  const declarationList = declaration?.parent;
  const statement = declarationList?.parent;
  const fileUrlBindings = bindingIdentifiers.filter(
    (identifier) => identifier.text === 'fileURLToPath'
  );
  const fileUrlBinding = fileUrlBindings.length === 1
    ? fileUrlBindings[0]
    : null;
  const fileUrlImport =
    fileUrlBinding?.parent?.parent?.parent?.parent;
  return Boolean(
    declaration
    && ts.isVariableDeclaration(declaration)
    && declaration.name === rootBinding
    && declarationList
    && ts.isVariableDeclarationList(declarationList)
    && declarationList.declarations.length === 1
    && (
      declarationList.flags & ts.NodeFlags.Const
    ) !== 0
    && statement
    && ts.isVariableStatement(statement)
    && statement.parent === sourceFile
    && sourceNodeDigest(statement, sourceFile)
      === LAUNCHER_REPOSITORY_ROOT_STATEMENT_DIGEST
    && !isIdentifierReassigned(
      syntaxNodes,
      'LAUNCHER_REPOSITORY_ROOT'
    )
    && fileUrlBinding
    && ts.isImportSpecifier(fileUrlBinding.parent)
    && fileUrlBinding.parent.name === fileUrlBinding
    && (
      fileUrlBinding.parent.propertyName?.text
      ?? fileUrlBinding.text
    ) === 'fileURLToPath'
    && fileUrlImport
    && ts.isImportDeclaration(fileUrlImport)
    && ts.isStringLiteral(fileUrlImport.moduleSpecifier)
    && fileUrlImport.moduleSpecifier.text === 'node:url'
    && !isIdentifierReassigned(syntaxNodes, 'fileURLToPath')
    && bindingIdentifiers.every(
      (identifier) => identifier.text !== 'URL'
    )
    && !isIdentifierReassigned(syntaxNodes, 'URL')
  );
}

function createNativePreviewLauncherContract(sourceFile) {
  const nodes = collectSyntaxNodes(sourceFile);
  const bindingIdentifiers = nodes.filter(isBindingIdentifier);
  const sensitiveHelpers = inspectSensitiveLauncherHelpers(
    nodes,
    sourceFile,
    bindingIdentifiers
  );
  const criticalFunctionBodyMismatches = [];
  for (
    const [functionName, expectedDigest]
    of CRITICAL_LAUNCHER_FUNCTION_DIGESTS
  ) {
    const functionDeclaration =
      sensitiveHelpers.functions.get(functionName);
    const observedDigest = functionDeclaration
      ? sourceNodeDigest(functionDeclaration, sourceFile)
      : null;
    if (observedDigest !== expectedDigest) {
      criticalFunctionBodyMismatches.push({
        expectedDigest,
        functionName,
        observedDigest,
      });
    }
  }
  const launchFunction = uniqueTopLevelFunctionBinding(
    sourceFile,
    bindingIdentifiers,
    NATIVE_PREVIEW_LAUNCH_FUNCTION
  );
  const builderFunction = uniqueTopLevelFunctionBinding(
    sourceFile,
    bindingIdentifiers,
    'buildNativePrApplicationSpawnSpec'
  );
  const builderStructureSafe =
    isExactNativePreviewSpawnSpecBuilder(builderFunction);
  const spawnProcessFunction = uniqueTopLevelFunctionBinding(
    sourceFile,
    bindingIdentifiers,
    'spawnProcess'
  );
  const spawnBindings = bindingIdentifiers.filter(
    (identifier) => identifier.text === 'spawn'
  );
  const spawnImportIdentifier = spawnBindings.length === 1
    && ts.isImportSpecifier(spawnBindings[0].parent)
    && spawnBindings[0].parent.name === spawnBindings[0]
    && (
      spawnBindings[0].parent.propertyName?.text
      ?? spawnBindings[0].text
    ) === 'spawn'
    && ts.isImportDeclaration(
      spawnBindings[0].parent.parent.parent.parent
    )
    && ts.isStringLiteral(
      spawnBindings[0].parent.parent.parent.parent.moduleSpecifier
    )
    && spawnBindings[0].parent.parent.parent.parent.moduleSpecifier.text
      === 'node:child_process'
    ? spawnBindings[0]
    : null;
  const spawnEffectCalls = nodes.filter(
    (node) => (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'spawn'
    )
  );
  const spawnEffectCall =
    spawnImportIdentifier
    && spawnProcessFunction
    && spawnEffectCalls.length === 1
    && nearestContainingFunction(spawnEffectCalls[0])
      === spawnProcessFunction
    && directFunctionBodyStatement(
      spawnEffectCalls[0],
      spawnProcessFunction
    )
      ? spawnEffectCalls[0]
      : null;
  const spawnProcessWrapperSafe = isExactSpawnProcessWrapper(
    spawnProcessFunction,
    spawnEffectCall
  );
  const spawnSpecBindings = bindingIdentifiers.filter(
    (identifier) => identifier.text === 'spawnSpec'
  );
  const spawnSpecDeclarations = nodes.filter(
    (node) => (
      ts.isVariableDeclaration(node)
      && isExactNativePreviewSpawnSpecDeclaration(node, launchFunction)
    )
  );
  const spawnSpecDeclaration =
    spawnSpecBindings.length === 1
    && spawnSpecDeclarations.length === 1
    && spawnSpecDeclarations[0].name === spawnSpecBindings[0]
    && builderStructureSafe
      ? spawnSpecDeclarations[0]
      : null;
  const builderCalls = nodes.filter(
    (node) => (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'buildNativePrApplicationSpawnSpec'
      && isWithinFunction(node, launchFunction)
    )
  );
  const spawnProcessCalls = nodes.filter(
    (node) => (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'spawnProcess'
      && isWithinFunction(node, launchFunction)
    )
  );
  const spawnCall =
    spawnSpecDeclaration
    && spawnProcessWrapperSafe
    && builderCalls.length === 1
    && builderCalls[0] === spawnSpecDeclaration.initializer
    && spawnProcessCalls.length === 1
    && isSafeNativePreviewSpawnCall(spawnProcessCalls[0])
    && isDirectConstCallBinding(
      spawnProcessCalls[0],
      launchFunction,
      'previewProcess'
    )
    && spawnProcessCalls[0].getStart(sourceFile)
      > spawnSpecDeclaration.getEnd()
      ? spawnProcessCalls[0]
      : null;
  const spawnProcessCallSites = inspectSpawnProcessCallSites(
    nodes,
    sourceFile,
    spawnCall
  );
  const launchCalls = inspectNativePreviewLaunchCalls(
    nodes,
    launchFunction
  );
  const processArgvContractSafe = inspectLauncherProcessArgvContract(
    nodes,
    sourceFile
  );
  const repositoryRootSafe =
    inspectLauncherRepositoryRootContract(
      sourceFile,
      nodes,
      bindingIdentifiers
    );

  return {
    approvedSpawnProcessCalls: spawnProcessCallSites.approvedCalls,
    approvedSensitiveHelperCalls: sensitiveHelpers.approvedCalls,
    builderCalls,
    builderFunction,
    builderStructureSafe,
    criticalFunctionBodyMismatches,
    launchFunction,
    launchCallSurfaceSafe: launchCalls.exactCounts,
    processArgvContractSafe,
    repositoryRootSafe,
    spawnCall,
    spawnEffectCall,
    spawnImportIdentifier,
    spawnProcessCalls,
    spawnProcessCallSurfaceSafe: spawnProcessCallSites.exactCounts,
    spawnProcessFunction,
    spawnProcessWrapperSafe,
    spawnSpecDeclaration,
    sensitiveHelperContractSafe: sensitiveHelpers.contractSafe,
    sensitiveHelperFunctions: sensitiveHelpers.functions,
    unapprovedLaunchCalls: new Set(launchCalls.unapprovedCalls),
  };
}

function enclosingCallExpression(node) {
  let ancestor = node.parent;
  while (ancestor) {
    if (ts.isCallExpression(ancestor)) {
      return ancestor;
    }
    if (ts.isFunctionLike(ancestor)) {
      return null;
    }
    ancestor = ancestor.parent;
  }
  return null;
}

function isAllowedNativePreviewSpawnSpecUse(node, launcherContract) {
  return Boolean(
    node === launcherContract.spawnSpecDeclaration?.name
    || enclosingCallExpression(node) === launcherContract.spawnCall
  );
}

function isAllowedNativePreviewBuilderUse(node, launcherContract) {
  return Boolean(
    node === launcherContract.builderFunction?.name
    || node === launcherContract.spawnSpecDeclaration?.initializer.expression
  );
}

function isAllowedSpawnProcessUse(node, launcherContract) {
  if (node === launcherContract.spawnProcessFunction?.name) {
    return true;
  }
  const parent = node.parent;
  if (
    !ts.isCallExpression(parent)
    || parent.expression !== node
    || !launcherContract.spawnProcessFunction
  ) {
    return false;
  }
  return launcherContract.approvedSpawnProcessCalls.has(parent);
}

function isAllowedSpawnUse(node, launcherContract) {
  return (
    node === launcherContract.spawnImportIdentifier
    || (
      node === launcherContract.spawnEffectCall?.expression
      && nearestContainingFunction(launcherContract.spawnEffectCall)
        === launcherContract.spawnProcessFunction
    )
  );
}

function isAllowedSensitiveLauncherHelperUse(node, launcherContract) {
  const helperFunction =
    launcherContract.sensitiveHelperFunctions.get(node.text);
  if (node === helperFunction?.name) {
    return true;
  }
  const parent = node.parent;
  return Boolean(
    ts.isCallExpression(parent)
    && parent.expression === node
    && launcherContract.approvedSensitiveHelperCalls.has(parent)
  );
}

export function findUnsafeRuntimeSyntax(filePath, sourceText) {
  const violations = [];
  const normalizedSourceText = sourceText.replace(/\r\n?/gu, '\n');
  const sourceFile = ts.createSourceFile(
    filePath,
    normalizedSourceText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  );
  const syntaxNodes = collectSyntaxNodes(sourceFile);
  const expectedEntryFileDigest =
    CRITICAL_ENTRY_FILE_DIGESTS.get(filePath);
  const observedEntryFileDigest = expectedEntryFileDigest
    ? sourceNodeDigest(sourceFile, sourceFile)
    : null;
  const hasExactReviewedEntryDigest = Boolean(
    expectedEntryFileDigest
    && observedEntryFileDigest === expectedEntryFileDigest
  );
  const allowsReviewedStatusAuthDynamicCall =
    hasExactReviewedEntryDigest
    && filePath === REVIEWED_STATUS_AUTH_DYNAMIC_CALL_FILE;
  const allowsReviewedStatusAuthCapabilityReference =
    hasExactReviewedEntryDigest
    && filePath === REVIEWED_STATUS_AUTH_CAPABILITY_REFERENCE_FILE;
  const listenerObjectBindingNames =
    collectListenerObjectBindingNames(syntaxNodes);
  const invokedBindingNames =
    collectInvokedBindingNames(syntaxNodes);
  const bindingIdentifiers =
    syntaxNodes.filter(isBindingIdentifier);
  const exportedVariableBindingNames =
    collectExportedVariableBindingNames(sourceFile);
  const mutableProcessObjectAliases =
    collectMutableProcessObjectAliases(syntaxNodes);
  const processEffectContract = inspectProcessEffectContract(
    syntaxNodes,
    sourceFile,
    filePath
  );
  const mutableProcessCallContract =
    collectReviewedMutableProcessCallArguments(
      filePath,
      sourceFile,
      syntaxNodes,
      mutableProcessObjectAliases,
      bindingIdentifiers
    );
  const mutableProcessSpreadContract =
    collectReviewedMutableProcessSpreads(
      filePath,
      sourceFile,
      syntaxNodes,
      bindingIdentifiers,
      mutableProcessObjectAliases
    );
  const criticalRuntimeFunctionDigestMismatches =
    inspectCriticalRuntimeFunctionDigests(
      filePath,
      sourceFile,
      bindingIdentifiers,
      syntaxNodes
    );
  const containedChildApplicationImportContract =
    inspectContainedChildApplicationImportContract(
      filePath,
      sourceFile,
      syntaxNodes,
      bindingIdentifiers
    );
  const containedChildListenerCallContract =
    inspectContainedChildListenerCallContract(
      filePath,
      sourceFile,
      syntaxNodes,
      bindingIdentifiers
    );
  const launcherContract = filePath === RAILWAY_LAUNCHER_FILE
    ? createNativePreviewLauncherContract(sourceFile)
    : null;

  function checkSpecifier(specifier, lineNumber) {
    const fileSpecificImports =
      FILE_SPECIFIC_EXTERNAL_RUNTIME_IMPORTS.get(filePath);
    if (
      !isLocalImportSpecifier(specifier)
      && !ALLOWED_EXTERNAL_RUNTIME_IMPORTS.has(specifier)
      && !fileSpecificImports?.has(specifier)
    ) {
      violations.push(
        `${filePath}:${lineNumber}: external runtime import "${specifier}"`
      );
    }
  }

  function checkImportBindings(node, specifier, lineNumber) {
    if (isLocalImportSpecifier(specifier)) {
      return;
    }
    const allowedBindings =
      FILE_SPECIFIC_EXTERNAL_IMPORT_BINDINGS
        .get(filePath)
        ?.get(specifier);
    if (!allowedBindings) {
      violations.push(
        `${filePath}:${lineNumber}: unreviewed external runtime import binding surface for "${specifier}"`
      );
      return;
    }
    for (const binding of runtimeImportBindings(node)) {
      if (!allowedBindings.has(binding)) {
        violations.push(
          `${filePath}:${lineNumber}: forbidden runtime import binding "${binding}"`
        );
      }
    }
  }

  function visit(node, containingFunctionName = null) {
    if (ts.isTypeNode(node)) {
      const classLike = (
        ts.isExpressionWithTypeArguments(node)
        && ts.isHeritageClause(node.parent)
        && (
          ts.isClassDeclaration(node.parent.parent)
          || ts.isClassExpression(node.parent.parent)
        )
      )
        ? node.parent.parent
        : null;
      if (
        classLike
        && node.parent.token === ts.SyntaxKind.ExtendsKeyword
        && !sourceFile.isDeclarationFile
        && !classLike.modifiers?.some(
          (modifier) => (
            modifier.kind === ts.SyntaxKind.DeclareKeyword
          )
        )
      ) {
        visit(node.expression, containingFunctionName);
      }
      return;
    }
    const lineNumber =
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line
      + 1;
    const currentFunctionName =
      ts.isFunctionDeclaration(node) && node.name
        ? node.name.text
        : containingFunctionName;
    if (
      ts.isImportEqualsDeclaration(node)
      && !node.isTypeOnly
    ) {
      violations.push(
        `${filePath}:${lineNumber}: runtime import-equals declaration`
      );
    } else if (
      ts.isImportDeclaration(node)
      && isRuntimeImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      checkSpecifier(node.moduleSpecifier.text, lineNumber);
      checkImportBindings(node, node.moduleSpecifier.text, lineNumber);
      if (
        containedChildApplicationImportContract.required
        && isLocalImportSpecifier(node.moduleSpecifier.text)
      ) {
        violations.push(
          `${filePath}:${lineNumber}: contained child local runtime imports must follow environment validation`
        );
      }
    } else if (
      ts.isExportDeclaration(node)
      && node.moduleSpecifier
      && isRuntimeExportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      checkSpecifier(node.moduleSpecifier.text, lineNumber);
      if (!isLocalImportSpecifier(node.moduleSpecifier.text)) {
        violations.push(
          `${filePath}:${lineNumber}: external runtime re-export`
        );
      } else if (
        containedChildApplicationImportContract.required
      ) {
        violations.push(
          `${filePath}:${lineNumber}: contained child local runtime re-exports must not precede environment validation`
        );
      }
    } else if (
      ts.isIdentifier(node)
      && isRuntimeValueBindingOrReference(node)
      && node.text === 'Object'
      && !isReviewedGlobalObjectReference(node, filePath)
    ) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden reviewed global Object capability reference`
      );
    } else if (
      containedChildListenerCallContract.required
      && ts.isIdentifier(node)
      && isRuntimeValueBindingOrReference(node)
      && node.text === 'listen'
      && !isAllowedContainedChildListenerUse(
        node,
        containedChildListenerCallContract
      )
    ) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden contained child listener helper reference`
      );
    } else if (
      launcherContract
      && ts.isFunctionDeclaration(node)
      && node.name
      && NON_EXPORTABLE_LAUNCHER_HELPER_NAMES.has(node.name.text)
      && hasRuntimeExportModifier(node)
    ) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden privileged launcher helper export`
      );
    } else if (
      isProcessMutableStateMutation(
        node,
        mutableProcessObjectAliases,
        processEffectContract.approvedAccesses
      )
    ) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden process state mutation`
      );
    } else if (
      PROCESS_EFFECT_MEMBER_NAMES.has(
        directProcessMemberName(node)
      )
      && !processEffectContract.approvedAccesses.has(node)
    ) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden process effect capability`
      );
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [argument] = node.arguments;
      if (
        containedChildApplicationImportContract.required
        && node
          !== containedChildApplicationImportContract.approvedDynamicImport
      ) {
        violations.push(
          `${filePath}:${lineNumber}: unsafe contained child application import timing`
        );
      } else if (!argument || !ts.isStringLiteral(argument)) {
        violations.push(`${filePath}:${lineNumber}: non-literal dynamic import`);
      } else if (!isLocalImportSpecifier(argument.text)) {
        violations.push(`${filePath}:${lineNumber}: external dynamic import`);
      } else {
        checkSpecifier(argument.text, lineNumber);
      }
    } else if (
      ts.isCallExpression(node)
      && launcherContract?.unapprovedLaunchCalls.has(node)
    ) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden native preview launch call`
      );
    } else if (
      ts.isCallExpression(node)
      && ts.isElementAccessExpression(
        unwrapExpression(node.expression)
      )
      && literalPropertyName(
        unwrapExpression(node.expression).argumentExpression
      ) === null
      && !allowsReviewedStatusAuthDynamicCall
    ) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden dynamic runtime effect call`
      );
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && FORBIDDEN_RUNTIME_BINDING_NAMES.has(node.expression.text)
      && !isReviewedRequestAbortTimeoutCall(filePath, node)
    ) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden ${node.expression.text} call`
      );
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'spawn'
      && (
        !launcherContract
        || node !== launcherContract.spawnEffectCall
      )
    ) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden child process spawn call`
      );
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'spawnProcess'
      && launcherContract
      && isWithinFunction(node, launcherContract.launchFunction)
    ) {
      if (node !== launcherContract.spawnCall) {
        violations.push(
          `${filePath}:${lineNumber}: unsafe native preview spawn call`
        );
      }
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'buildNativePrApplicationSpawnSpec'
      && launcherContract
      && isWithinFunction(node, launcherContract.launchFunction)
    ) {
      if (
        node !== launcherContract.spawnSpecDeclaration?.initializer
      ) {
        violations.push(
          `${filePath}:${lineNumber}: unsafe native preview spawn specification call`
        );
      }
    } else if (
      unapprovedMutableProcessCallArguments(
        node,
        mutableProcessObjectAliases,
        processEffectContract.approvedAccesses,
        mutableProcessCallContract.approvedArguments
      ).length > 0
      && !allowsReviewedStatusAuthDynamicCall
    ) {
      violations.push(
        `${filePath}:${lineNumber}: mutable process object escapes to an unreviewed call`
      );
    } else if (
      isMutableProcessReferenceEscape(
        node,
        mutableProcessObjectAliases,
        mutableProcessSpreadContract.approvedSpreads,
        exportedVariableBindingNames
      )
    ) {
      violations.push(
        `${filePath}:${lineNumber}: mutable process object escapes containment`
      );
    } else if (ts.isCallExpression(node)) {
      const propertyAccess = propertyAccessParts(node.expression);
      const runtimeNamespaceAccess =
        runtimeNamespaceMemberAccess(node.expression);
      const allowedListenerObjects =
        ALLOWED_LISTENER_CALLS
          .get(filePath)
          ?.get(currentFunctionName);
      if (
        isForbiddenRuntimeNamespaceMember(runtimeNamespaceAccess)
        || isObjectMutationCapabilityAccess(node.expression)
        || (
          propertyAccess
          && (
            propertyAccess[1] === 'listen'
            && !allowedListenerObjects?.has(propertyAccess[0])
          )
        )
      ) {
        violations.push(
          `${filePath}:${lineNumber}: forbidden runtime effect call`
        );
      }
    } else if (ts.isNewExpression(node)) {
      const expression = unwrapExpression(node.expression);
      const runtimeNamespaceAccess =
        runtimeNamespaceMemberAccess(expression);
      if (
        isForbiddenRuntimeNamespaceMember(runtimeNamespaceAccess)
        || isObjectMutationCapabilityAccess(expression)
        || isListenerCapabilityAccess(expression)
        || (
          ts.isIdentifier(expression)
          && FORBIDDEN_AMBIENT_IDENTIFIER_NAMES.has(expression.text)
        )
      ) {
        violations.push(
          `${filePath}:${lineNumber}: forbidden runtime effect constructor`
        );
      }
    } else if (
      (
        isForbiddenRuntimeCapabilityAccess(node)
        || isObjectMutationCapabilityAccess(node)
        || isListenerCapabilityAccess(node)
        || isDynamicListenerCapabilityAccess(
          node,
          listenerObjectBindingNames
        )
        || isDynamicCallableExtraction(
          node,
          invokedBindingNames
        )
      )
      && !isDirectCallOrConstructorTarget(node)
      && !allowsReviewedStatusAuthCapabilityReference
    ) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden runtime capability reference`
      );
    } else if (
      isForbiddenRuntimeCapabilityIdentifierReference(node)
      && !isReviewedResearchOwnKeysReference(filePath, node)
    ) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden runtime capability reference`
      );
    } else if (isForbiddenListenerFactoryReference(node)) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden listener factory capability reference`
      );
    } else if (
      isUnsafeRuntimeNamespaceBindingElement(node)
      || isUnsafeListenerBindingElement(node)
    ) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden runtime capability reference`
      );
    } else if (
      isForbiddenRuntimeNamespaceReference(node)
    ) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden runtime capability reference`
      );
    } else if (
      launcherContract
      && ts.isIdentifier(node)
      && isRuntimeValueBindingOrReference(node)
      && SENSITIVE_LAUNCHER_HELPER_NAMES.has(node.text)
      && !isAllowedSensitiveLauncherHelperUse(node, launcherContract)
    ) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden launcher helper capability reference`
      );
    } else if (
      launcherContract
      && ts.isIdentifier(node)
      && isRuntimeValueBindingOrReference(node)
      && node.text === 'buildNativePrApplicationSpawnSpec'
      && !isAllowedNativePreviewBuilderUse(node, launcherContract)
    ) {
      violations.push(
        isBindingIdentifier(node)
          ? `${filePath}:${lineNumber}: unsafe native preview builder declaration`
          : `${filePath}:${lineNumber}: forbidden native preview builder capability reference`
      );
    } else if (
      launcherContract
      && ts.isIdentifier(node)
      && isRuntimeValueBindingOrReference(node)
      && node.text === 'spawn'
      && !isAllowedSpawnUse(node, launcherContract)
    ) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden spawn capability reference`
      );
    } else if (
      launcherContract
      && ts.isIdentifier(node)
      && isRuntimeValueBindingOrReference(node)
      && node.text === 'spawnProcess'
      && !isAllowedSpawnProcessUse(node, launcherContract)
    ) {
      violations.push(
        isBindingIdentifier(node)
          ? `${filePath}:${lineNumber}: unsafe spawnProcess declaration`
          : `${filePath}:${lineNumber}: forbidden spawnProcess capability reference`
      );
    } else if (
      launcherContract
      && ts.isIdentifier(node)
      && isBindingIdentifier(node)
      && node.text === NATIVE_PREVIEW_LAUNCH_FUNCTION
      && node !== launcherContract.launchFunction?.name
    ) {
      violations.push(
        `${filePath}:${lineNumber}: unsafe native preview launch declaration`
      );
    } else if (
      launcherContract
      && ts.isIdentifier(node)
      && isRuntimeValueBindingOrReference(node)
      && node.text === 'spawnSpec'
      && !isAllowedNativePreviewSpawnSpecUse(node, launcherContract)
    ) {
      violations.push(
        `${filePath}:${lineNumber}: unsafe native preview spawn specification use`
      );
    }
    ts.forEachChild(
      node,
      (child) => visit(child, currentFunctionName)
    );
  }

  visit(sourceFile);
  for (const mismatch of mutableProcessCallContract.mismatches) {
    violations.push(
      mismatch.digestMismatch
        ? `${filePath}: reviewed mutable process call contract "${mismatch.key}" full-call digest mismatch`
        : `${filePath}: reviewed mutable process call contract "${mismatch.key}" expected ${mismatch.expectedCount}, observed ${mismatch.observedCount}`
    );
  }
  if (
    containedChildApplicationImportContract.required
    && !containedChildApplicationImportContract.safe
  ) {
    violations.push(
      `${filePath}: contained child application import contract must validate the environment before one exact dynamic import`
    );
  }
  if (
    containedChildListenerCallContract.required
    && !containedChildListenerCallContract.safe
  ) {
    violations.push(
      `${filePath}: contained child listener call must use one exact validated server, port, and host`
    );
  }
  if (
    expectedEntryFileDigest
    && observedEntryFileDigest !== expectedEntryFileDigest
  ) {
    violations.push(
      `${filePath}: critical entry file semantic digest must match the reviewed contract (expected ${expectedEntryFileDigest}, observed ${observedEntryFileDigest ?? 'missing'})`
    );
  }
  for (const mismatch of mutableProcessSpreadContract.mismatches) {
    violations.push(
      `${filePath}: reviewed mutable process spread function "${mismatch.functionName}" body digest must match the reviewed contract (expected ${mismatch.expectedDigest}, observed ${mismatch.observedDigest ?? 'missing'})`
    );
  }
  for (const mismatch of criticalRuntimeFunctionDigestMismatches) {
    violations.push(
      `${filePath}: critical runtime function "${mismatch.functionName}" body digest must match the reviewed contract (expected ${mismatch.expectedDigest}, observed ${mismatch.observedDigest ?? 'missing'})`
    );
  }
  if (launcherContract) {
    if (!launcherContract.launchFunction) {
      violations.push(
        `${filePath}: native preview launch declaration count must be 1`
      );
    }
    if (!launcherContract.builderFunction) {
      violations.push(
        `${filePath}: native preview builder declaration count must be 1`
      );
    }
    if (!launcherContract.builderStructureSafe) {
      violations.push(
        `${filePath}: unsafe native preview spawn specification builder`
      );
    }
    for (
      const mismatch
      of launcherContract.criticalFunctionBodyMismatches
    ) {
      violations.push(
        `${filePath}: critical launcher function "${mismatch.functionName}" body digest must match the reviewed contract (expected ${mismatch.expectedDigest}, observed ${mismatch.observedDigest ?? 'missing'})`
      );
    }
    if (!launcherContract.spawnProcessFunction) {
      violations.push(
        `${filePath}: spawnProcess declaration count must be 1`
      );
    }
    if (!launcherContract.spawnProcessWrapperSafe) {
      violations.push(
        `${filePath}: unsafe spawnProcess wrapper`
      );
    }
    if (!launcherContract.spawnProcessCallSurfaceSafe) {
      violations.push(
        `${filePath}: spawnProcess call surface must match the reviewed contract`
      );
    }
    if (!launcherContract.spawnImportIdentifier) {
      violations.push(
        `${filePath}: child process spawn import count must be 1`
      );
    }
    if (!launcherContract.spawnSpecDeclaration) {
      violations.push(
        `${filePath}: native preview spawn specification declaration count must be 1`
      );
    }
    if (launcherContract.builderCalls.length !== 1) {
      violations.push(
        `${filePath}: native preview spawn specification call count must be 1`
      );
    }
    if (
      launcherContract.spawnProcessCalls.length !== 1
      || !launcherContract.spawnCall
    ) {
      violations.push(
        `${filePath}: native preview spawn call count must be 1`
      );
    }
    if (!launcherContract.spawnEffectCall) {
      violations.push(
        `${filePath}: child process spawn effect call count must be 1`
      );
    }
    if (!launcherContract.launchCallSurfaceSafe) {
      violations.push(
        `${filePath}: native preview launch call surface must match the reviewed contract`
      );
    }
    if (!launcherContract.sensitiveHelperContractSafe) {
      violations.push(
        `${filePath}: launcher helper call surface must match the reviewed contract`
      );
    }
    if (!launcherContract.processArgvContractSafe) {
      violations.push(
        `${filePath}: launcher process.argv use must match the reviewed read-only contract`
      );
    }
    if (!launcherContract.repositoryRootSafe) {
      violations.push(
        `${filePath}: native preview repository root must match the exact immutable launcher-relative contract`
      );
    }
  }
  if (processEffectContract.required && !processEffectContract.safe) {
    violations.push(
      `${filePath}: process effect surface must match the reviewed contract`
    );
  }
  return violations;
}

export function findRuntimeRequestAbortExportViolations(manifest) {
  const manifestObject = (
    manifest
    && typeof manifest === 'object'
    && !Array.isArray(manifest)
  ) ? manifest : null;
  const exportsObject = (
    manifestObject?.exports
    && typeof manifestObject.exports === 'object'
    && !Array.isArray(manifestObject.exports)
  ) ? manifestObject.exports : null;
  const requestAbortExport = (
    exportsObject?.['./requestAbort']
    && typeof exportsObject['./requestAbort'] === 'object'
    && !Array.isArray(exportsObject['./requestAbort'])
  ) ? exportsObject['./requestAbort'] : null;
  const requestAbortExportKeys = requestAbortExport
    ? Object.keys(requestAbortExport).sort()
    : [];
  if (
    manifestObject?.name === '@arcanos/runtime'
    && manifestObject.type === 'module'
    && requestAbortExport?.types === './dist/requestAbort.d.ts'
    && requestAbortExport?.import === './dist/requestAbort.js'
    && requestAbortExportKeys.length === 2
    && requestAbortExportKeys[0] === 'import'
    && requestAbortExportKeys[1] === 'types'
  ) {
    return [];
  }
  return [
    `${RUNTIME_PACKAGE_MANIFEST_FILE}: requestAbort export must match the reviewed ESM runtime surface`,
  ];
}

export function findRuntimeRequestAbortTypeResolutionViolations(tsconfig) {
  const requestAbortPaths = tsconfig?.compilerOptions?.paths
    ?.['@arcanos/runtime/requestAbort'];
  if (
    Array.isArray(requestAbortPaths)
    && requestAbortPaths.length === 1
    && requestAbortPaths[0]
      === 'packages/arcanos-runtime/dist/requestAbort.d.ts'
  ) {
    return [];
  }
  return [
    `${ROOT_TSCONFIG_FILE}: requestAbort path must match the reviewed build target`,
  ];
}

export function findNativePrPreviewBuildScriptViolations(manifest) {
  const scripts = manifest?.scripts;
  const buildScript = typeof scripts?.build === 'string'
    ? scripts.build
    : '';
  const buildSteps = buildScript.split('&&').map(step => step.trim());
  const aliasCheckIndex = buildSteps.indexOf('npm run dist:check-aliases');
  const previewDistCheckIndex = buildSteps.indexOf(
    'npm run check:native-pr-preview-dist-imports'
  );
  const copyAssetsIndex = buildSteps.indexOf('npm run build:copy-assets');
  if (
    scripts?.['check:native-pr-preview-dist-imports']
      === 'node scripts/check-native-pr-preview-dist-imports.mjs'
    && aliasCheckIndex >= 0
    && previewDistCheckIndex === aliasCheckIndex + 1
    && copyAssetsIndex === previewDistCheckIndex + 1
    && buildSteps.filter(
      step => step === 'npm run check:native-pr-preview-dist-imports'
    ).length === 1
  ) {
    return [];
  }
  return [
    `${ROOT_PACKAGE_MANIFEST_FILE}: build must run the reviewed preview dist-import check after alias repair`,
  ];
}

export function findPreviewDistImportCheckerDigestViolations(sourceText) {
  const observedDigest = createHash('sha256')
    .update(sourceText.replace(/\r\n?/gu, '\n'))
    .digest('hex');
  if (observedDigest === PREVIEW_DIST_IMPORT_CHECKER_DIGEST) {
    return [];
  }
  return [
    `${PREVIEW_DIST_IMPORT_CHECKER_FILE}: content digest must match the reviewed emitted-import check`,
  ];
}

export async function findNativePrPreviewImportViolations({
  repositoryRoot = REPOSITORY_ROOT,
  analyzeDependencies = madge,
} = {}) {
  const graph = await analyzeDependencies(PREVIEW_ENTRY_FILES, {
    baseDir: repositoryRoot,
    detectiveOptions: {
      ts: { skipTypeImports: true },
    },
    fileExtensions: ['mjs', 'ts'],
    tsConfig: path.join(repositoryRoot, PREVIEW_IMPORT_TSCONFIG_FILE),
  });
  const graphFiles = Object.keys(graph.obj()).sort();
  const violations = [];
  const skippedImports = graph.warnings().skipped ?? [];

  try {
    const runtimePackageManifest = JSON.parse(await fs.readFile(
      path.join(repositoryRoot, RUNTIME_PACKAGE_MANIFEST_FILE),
      'utf8'
    ));
    violations.push(
      ...findRuntimeRequestAbortExportViolations(runtimePackageManifest)
    );
  } catch {
    violations.push(
      `${RUNTIME_PACKAGE_MANIFEST_FILE}: requestAbort export manifest is unreadable`
    );
  }
  try {
    const rootTsconfig = JSON.parse(await fs.readFile(
      path.join(repositoryRoot, ROOT_TSCONFIG_FILE),
      'utf8'
    ));
    violations.push(
      ...findRuntimeRequestAbortTypeResolutionViolations(rootTsconfig)
    );
  } catch {
    violations.push(
      `${ROOT_TSCONFIG_FILE}: requestAbort path configuration is unreadable`
    );
  }
  try {
    const rootPackageManifest = JSON.parse(await fs.readFile(
      path.join(repositoryRoot, ROOT_PACKAGE_MANIFEST_FILE),
      'utf8'
    ));
    violations.push(
      ...findNativePrPreviewBuildScriptViolations(rootPackageManifest)
    );
  } catch {
    violations.push(
      `${ROOT_PACKAGE_MANIFEST_FILE}: preview dist-import build contract is unreadable`
    );
  }
  try {
    const previewDistImportCheckerSource = await fs.readFile(
      path.join(repositoryRoot, PREVIEW_DIST_IMPORT_CHECKER_FILE),
      'utf8'
    );
    violations.push(
      ...findPreviewDistImportCheckerDigestViolations(
        previewDistImportCheckerSource
      )
    );
  } catch {
    violations.push(
      `${PREVIEW_DIST_IMPORT_CHECKER_FILE}: emitted-import checker is unreadable`
    );
  }

  for (const skippedImport of skippedImports) {
    violations.push(`unresolved import: ${skippedImport}`);
  }
  for (const requiredFile of NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES) {
    if (!graphFiles.includes(requiredFile)) {
      violations.push(`required preview graph file missing: ${requiredFile}`);
    }
  }
  for (const graphFile of graphFiles) {
    if (!ALLOWED_GRAPH_FILES.has(graphFile)) {
      violations.push(`unreviewed preview import: ${graphFile}`);
    }
    if (
      FORBIDDEN_LOCAL_IMPORT_PATTERNS.some((pattern) =>
        pattern.test(graphFile)
      )
    ) {
      violations.push(`forbidden preview import: ${graphFile}`);
    }

    const sourceText = await fs.readFile(
      path.join(repositoryRoot, graphFile),
      'utf8'
    );
    violations.push(...findUnsafeRuntimeSyntax(graphFile, sourceText));
  }

  return [...new Set(violations)].sort();
}

export async function runCliCheck() {
  const violations = await findNativePrPreviewImportViolations();
  if (violations.length > 0) {
    console.error('check:native-pr-preview-imports failed');
    console.error(JSON.stringify(violations, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(
    'check:native-pr-preview-imports passed: contained preview graph is side-effect bounded.'
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
      'check:native-pr-preview-imports failed to run: PREVIEW_IMPORT_CHECK_FAILED'
    );
    process.exitCode = 1;
  }
}

import express, { Request, Response } from 'express';
import type { TrinityResult } from '@core/logic/trinity.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';
import {
  createValidationMiddleware,
  createRateLimitMiddleware,
  getRequestActorKey
} from '@platform/runtime/security.js';
import { asyncHandler } from '@shared/http/index.js';
import { isDiagnosticRequest } from '@shared/http/diagnosticRequest.js';
import type {
  AIRequestDTO,
  AIResponseDTO,
  ErrorResponseDTO
} from '@shared/types/dto.js';
import type { IdleStateService } from '@services/idleStateService.js';
import {
  extractInput,
  handleAIError,
  validateAIRequest
} from '@transport/http/requestHandler.js';
import { buildTrinityOutputControlOptions } from '@shared/ask/trinityRequestOptions.js';
import { buildTrinityUserVisibleResponse } from '@shared/ask/trinityResponseSerializer.js';
import {
  applyDeprecatedAskRouteHeaders
} from '@shared/http/gptRouteHeaders.js';
import apiArcanosVerificationRouter from './api-arcanos-verification.js';
import { buildPromptShortcutTelemetry } from '@routes/_core/promptShortcutResponse.js';
import {
  tryExecutePromptRouteShortcut,
  type PromptRouteShortcutResult
} from '@services/promptRouteShortcuts.js';
import { runArcanosCoreQuery } from '@services/arcanos-core.js';

const router = express.Router();

const DEPRECATED_ARCANOS_ENDPOINT = '/api/arcanos/ask';
const CANONICAL_ARCANOS_GPT_ID = 'arcanos-core';
const CANONICAL_ARCANOS_ROUTE = `/gpt/${CANONICAL_ARCANOS_GPT_ID}`;
const ARCANOS_API_ENDPOINT_NAME = 'api-arcanos.ask';
const TRINITY_PIPELINE_NAME = 'trinity' as const;
const TRINITY_PIPELINE_VERSION = '1.0' as const;

const arcanosAskRateLimit = createRateLimitMiddleware({
  bucketName: 'api-arcanos-ask',
  maxRequests: 120,
  windowMs: 15 * 60 * 1000,
  keyGenerator: (req) => `${getRequestActorKey(req)}:route:ask`
});

router.use('/', apiArcanosVerificationRouter);

interface AskBody extends Partial<AIRequestDTO> {
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  prompt?: string;
  message?: string;
  userInput?: string;
  content?: string;
  text?: string;
  query?: string;
  action?: string;
  mode?: string;
  domain?: string;
  metadata?: Record<string, unknown>;
  clientContext?: Record<string, unknown>;
  sessionId?: string;
  overrideAuditSafe?: string;
  requestedVerbosity?: 'minimal' | 'normal' | 'detailed';
  requested_verbosity?: 'minimal' | 'normal' | 'detailed';
  maxWords?: number | null;
  max_words?: number | null;
  answerMode?: 'direct' | 'explained' | 'audit' | 'debug';
  answer_mode?: 'direct' | 'explained' | 'audit' | 'debug';
  debugPipeline?: boolean;
  debug_pipeline?: boolean;
  strictUserVisibleOutput?: boolean;
  strict_user_visible_output?: boolean;
  timeoutMs?: number;
  options?: {
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
  };
}

interface AskResponse {
  success: boolean;
  result?: unknown;
  error?: string;
  metadata?: {
    service?: string;
    version?: string;
    model?: string;
    tokensUsed?: number;
    timestamp?: string;
    arcanosRouting?: boolean;
    deprecatedEndpoint?: boolean;
    canonicalRoute?: string;
    pipeline?: typeof TRINITY_PIPELINE_NAME;
    trinityVersion?: typeof TRINITY_PIPELINE_VERSION;
    endpoint?: string;
    requestId?: string;
    route?: string;
    gptId?: string;
    matchMethod?: string;
    routingStages?: string[];
    fallbackFlag?: boolean;
  };
  module?: string;
  activeModel?: string;
  fallbackFlag?: boolean;
  routingStages?: string[];
  gpt5Used?: boolean;
  gpt5Model?: string;
  dryRun?: boolean;
  pipelineDebug?: TrinityResult['pipelineDebug'];
}

const arcanosSchema = {
  mode: {
    required: false,
    type: 'string' as const,
    minLength: 1,
    maxLength: 64,
    sanitize: true
  },
  action: {
    required: false,
    type: 'string' as const,
    minLength: 1,
    maxLength: 64,
    sanitize: true
  },
  prompt: {
    required: false,
    type: 'string' as const,
    minLength: 1,
    maxLength: 4000,
    sanitize: true
  },
  message: {
    required: false,
    type: 'string' as const,
    minLength: 1,
    maxLength: 4000,
    sanitize: true
  },
  userInput: {
    required: false,
    type: 'string' as const,
    minLength: 1,
    maxLength: 4000,
    sanitize: true
  },
  content: {
    required: false,
    type: 'string' as const,
    minLength: 1,
    maxLength: 4000,
    sanitize: true
  },
  text: {
    required: false,
    type: 'string' as const,
    minLength: 1,
    maxLength: 4000,
    sanitize: true
  },
  query: {
    required: false,
    type: 'string' as const,
    minLength: 1,
    maxLength: 4000,
    sanitize: true
  },
  sessionId: {
    required: false,
    type: 'string' as const,
    minLength: 1,
    maxLength: 100,
    sanitize: true
  },
  overrideAuditSafe: {
    required: false,
    type: 'string' as const,
    minLength: 1,
    maxLength: 50,
    sanitize: true
  },
  requestedVerbosity: {
    required: false,
    type: 'string' as const,
    minLength: 1,
    maxLength: 16,
    sanitize: true
  },
  requested_verbosity: {
    required: false,
    type: 'string' as const,
    minLength: 1,
    maxLength: 16,
    sanitize: true
  },
  maxWords: {
    required: false,
    type: 'number' as const
  },
  max_words: {
    required: false,
    type: 'number' as const
  },
  answerMode: {
    required: false,
    type: 'string' as const,
    minLength: 1,
    maxLength: 16,
    sanitize: true
  },
  answer_mode: {
    required: false,
    type: 'string' as const,
    minLength: 1,
    maxLength: 16,
    sanitize: true
  },
  debugPipeline: {
    required: false,
    type: 'boolean' as const
  },
  debug_pipeline: {
    required: false,
    type: 'boolean' as const
  },
  strictUserVisibleOutput: {
    required: false,
    type: 'boolean' as const
  },
  strict_user_visible_output: {
    required: false,
    type: 'boolean' as const
  },
  metadata: {
    required: false,
    type: 'object' as const
  },
  clientContext: {
    required: false,
    type: 'object' as const
  },
  options: {
    required: false,
    type: 'object' as const
  }
};

function buildArcanosCompatibilityMetadata(result: TrinityResult): NonNullable<AskResponse['metadata']> {
  return {
    service: 'ARCANOS API',
    version: '1.0.0',
    model: result.activeModel,
    tokensUsed: result.meta.tokens?.total_tokens ?? 0,
    timestamp: new Date().toISOString(),
    arcanosRouting: true,
    deprecatedEndpoint: true,
    canonicalRoute: CANONICAL_ARCANOS_ROUTE,
    pipeline: TRINITY_PIPELINE_NAME,
    trinityVersion: TRINITY_PIPELINE_VERSION,
    endpoint: ARCANOS_API_ENDPOINT_NAME,
    requestId: result.taskLineage.requestId,
    gptId: CANONICAL_ARCANOS_GPT_ID,
    routingStages: result.routingStages
  };
}

function buildArcanosCompatibilityResponse(result: TrinityResult): AskResponse {
  const userVisibleResponse = buildTrinityUserVisibleResponse({
    trinityResult: result,
    endpoint: ARCANOS_API_ENDPOINT_NAME
  });

  return {
    success: true,
    result: userVisibleResponse.result,
    metadata: buildArcanosCompatibilityMetadata(result),
    module: userVisibleResponse.module,
    activeModel: userVisibleResponse.activeModel,
    fallbackFlag: userVisibleResponse.fallbackFlag,
    routingStages: userVisibleResponse.routingStages,
    gpt5Used: userVisibleResponse.gpt5Used,
    gpt5Model: userVisibleResponse.gpt5Model,
    dryRun: userVisibleResponse.dryRun,
    ...(userVisibleResponse.pipelineDebug ? { pipelineDebug: userVisibleResponse.pipelineDebug } : {})
  };
}

/**
 * Purpose: Serialize compatibility results for the deprecated route's SSE mode.
 * Inputs/Outputs: Accepts the legacy `result` payload and returns one string chunk.
 * Edge cases: JSON-encodes structured results instead of dropping them.
 */
function serializeCompatibilityResult(result: AskResponse['result']): string {
  if (typeof result === 'string') {
    return result;
  }

  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Purpose: Stream one finalized compatibility response for legacy SSE callers.
 * Inputs/Outputs: Writes terminal SSE frames to the Express response and closes the socket.
 * Edge cases: Emits a single final chunk because the deprecated shim forwards to canonical one-shot routing.
 */
function sendTrinityCompatibilityStream(
  res: Response<AskResponse | ErrorResponseDTO>,
  responsePayload: AskResponse
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const content = serializeCompatibilityResult(responsePayload.result);
  if (content.length > 0) {
    res.write(`data: ${JSON.stringify({
      success: true,
      content,
      type: 'chunk',
      pipeline: TRINITY_PIPELINE_NAME,
      canonicalRoute: CANONICAL_ARCANOS_ROUTE
    })}\n\n`);
  }

  res.write(`data: ${JSON.stringify({
    success: true,
    type: 'done',
    metadata: responsePayload.metadata
  })}\n\n`);
  res.end();
}

/**
 * Purpose: Build a compatibility response for any registered prompt shortcut on `/api/arcanos/ask`.
 * Inputs/Outputs: normalized shortcut result -> legacy-compatible response envelope.
 * Edge cases: new shortcut types reuse the same compatibility envelope without bespoke per-shortcut route builders.
 */
function buildArcanosPromptShortcutResponse(params: {
  shortcut: PromptRouteShortcutResult;
}): AskResponse {
  const shortcutTelemetry = buildPromptShortcutTelemetry(params.shortcut);

  return {
    success: true,
    result: params.shortcut.resultText,
    metadata: {
      service: 'ARCANOS API',
      version: '1.0.0',
      timestamp: shortcutTelemetry.timestamp,
      arcanosRouting: false,
      deprecatedEndpoint: true,
      canonicalRoute: CANONICAL_ARCANOS_ROUTE,
      endpoint: ARCANOS_API_ENDPOINT_NAME,
      requestId: shortcutTelemetry.requestId,
      gptId: CANONICAL_ARCANOS_GPT_ID,
      routingStages: shortcutTelemetry.routingStages
    },
    module: shortcutTelemetry.module,
    activeModel: shortcutTelemetry.activeModel,
    fallbackFlag: shortcutTelemetry.fallbackFlag,
    routingStages: shortcutTelemetry.routingStages
  };
}

function attachApiArcanosCompatibilityMetadata(
  req: Request<{}, AskResponse | ErrorResponseDTO, AskBody>,
  res: Response<AskResponse | ErrorResponseDTO>,
  next: () => void
): void {
  const canonicalRoute = applyDeprecatedAskRouteHeaders(res, CANONICAL_ARCANOS_GPT_ID);
  res.setHeader('x-deprecated-endpoint', DEPRECATED_ARCANOS_ENDPOINT);
  req.logger?.info?.('deprecated.endpoint.used', {
    deprecatedEndpoint: DEPRECATED_ARCANOS_ENDPOINT,
    canonicalRoute,
    requestId: req.requestId ?? null
  });
  next();
}

/**
 * Purpose: Compatibility handler for deprecated `/api/arcanos/ask` traffic.
 * Inputs/Outputs: Accepts legacy request bodies and returns the historical route envelope.
 * Edge cases: Preserves `ping` health checks and rewrites deprecated traffic through the shared Trinity wrapper.
 */
const handleArcanosAsk = asyncHandler(async (
  req: Request<{}, AskResponse | ErrorResponseDTO, AskBody>,
  res: Response<AskResponse | ErrorResponseDTO>
) => {
  const pingCandidate = extractInput((req.body ?? {}) as AIRequestDTO)?.trim().toLowerCase();
  const diagnosticProbe = isDiagnosticRequest(req.body, pingCandidate);

  if (diagnosticProbe) {
    const idleStateService = req.app.locals.idleStateService as IdleStateService | undefined;
    idleStateService?.noteUserPing({ route: DEPRECATED_ARCANOS_ENDPOINT, source: ARCANOS_API_ENDPOINT_NAME });
    return res.json({
      success: true,
      result: pingCandidate === 'ping' ? 'pong' : 'backend operational',
      metadata: {
        service: 'ARCANOS API',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        arcanosRouting: true,
        deprecatedEndpoint: true,
        canonicalRoute: CANONICAL_ARCANOS_ROUTE,
        pipeline: TRINITY_PIPELINE_NAME,
        trinityVersion: TRINITY_PIPELINE_VERSION,
        endpoint: ARCANOS_API_ENDPOINT_NAME,
        gptId: CANONICAL_ARCANOS_GPT_ID
      },
      module: 'diagnostic',
      activeModel: 'diagnostic',
      fallbackFlag: false,
      routingStages: ['DIAGNOSTIC-SHORTCUT'],
      gpt5Used: false
    });
  }

  let promptForError = pingCandidate ?? '';

  try {
    const validation = validateAIRequest(
      req as unknown as Request<{}, AIResponseDTO | ErrorResponseDTO, AIRequestDTO>,
      res as unknown as Response<AIResponseDTO | ErrorResponseDTO>,
      ARCANOS_API_ENDPOINT_NAME
    );

    if (!validation) {
      return;
    }

    const { client: openai, input: prompt } = validation;
    promptForError = prompt;
    const promptShortcut = await tryExecutePromptRouteShortcut({
      prompt,
      sessionId: req.body.sessionId
    });
    if (promptShortcut) {
      return res.json(
        buildArcanosPromptShortcutResponse({
          shortcut: promptShortcut
        })
      );
    }

    const trinityResult = await runArcanosCoreQuery({
      client: openai,
      prompt,
      sessionId: req.body.sessionId,
      overrideAuditSafe: req.body.overrideAuditSafe,
      sourceEndpoint: ARCANOS_API_ENDPOINT_NAME,
      runOptions: buildTrinityOutputControlOptions(req.body)
    });

    const responsePayload = buildArcanosCompatibilityResponse(trinityResult);

    if (req.body.options?.stream === true) {
      sendTrinityCompatibilityStream(res, responsePayload);
      return;
    }

    return res.json(responsePayload);
  } catch (error: unknown) {
    handleAIError(
      error,
      promptForError,
      ARCANOS_API_ENDPOINT_NAME,
      res as unknown as Response<AIResponseDTO | ErrorResponseDTO>
    );
  }
});

router.post(
  '/ask',
  arcanosAskRateLimit,
  attachApiArcanosCompatibilityMetadata,
  confirmGate,
  createValidationMiddleware(arcanosSchema),
  handleArcanosAsk
);

export default router;

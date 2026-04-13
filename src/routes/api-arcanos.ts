import express, { Request, Response } from 'express';
import type { TrinityResult } from '@core/logic/trinity.js';
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
  applyDeprecatedAskRouteHeaders,
  ASK_ROUTE_MODE_HEADER,
  resolveAskRouteMode
} from '@shared/http/gptRouteHeaders.js';
import {
  applyAIDegradedResponseHeaders,
  extractAIDegradedResponseMetadata
} from '@shared/http/aiDegradedHeaders.js';
import apiArcanosVerificationRouter from './api-arcanos-verification.js';
import { runArcanosCoreQuery } from '@services/arcanos-core.js';
import {
  extractPromptText,
  recordPromptDebugTrace,
} from '@services/promptDebugTraceService.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { sendBoundedJsonResponse } from '@shared/http/sendBoundedJsonResponse.js';

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

type ApiArcanosResponse = AskResponse | ErrorResponseDTO;

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

function attachApiArcanosCompatibilityMetadata(
  req: Request<{}, ApiArcanosResponse, AskBody>,
  res: Response<ApiArcanosResponse>,
  next: () => void
): void {
  const canonicalRoute = applyDeprecatedAskRouteHeaders(res, CANONICAL_ARCANOS_GPT_ID);
  res.setHeader('x-deprecated-endpoint', DEPRECATED_ARCANOS_ENDPOINT);
  res.setHeader(ASK_ROUTE_MODE_HEADER, 'compat');
  if (resolveAskRouteMode() !== 'compat') {
    req.logger?.warn?.('deprecated.endpoint.recovered', {
      deprecatedEndpoint: DEPRECATED_ARCANOS_ENDPOINT,
      canonicalRoute,
      configuredRouteMode: resolveAskRouteMode(),
      effectiveRouteMode: 'compat',
      requestId: req.requestId ?? null,
      route: DEPRECATED_ARCANOS_ENDPOINT
    });
  }
  req.logger?.info?.('deprecated.endpoint.used', {
    deprecatedEndpoint: DEPRECATED_ARCANOS_ENDPOINT,
    canonicalRoute,
    routeMode: 'compat',
    requestId: req.requestId ?? null
  });
  next();
}

function stripLegacyAuditOverride(
  req: Request<{}, ApiArcanosResponse, AskBody>,
  _res: Response<ApiArcanosResponse>,
  next: () => void
): void {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && req.body.overrideAuditSafe) {
    delete req.body.overrideAuditSafe;
    req.logger?.warn?.('deprecated.endpoint.audit_override_ignored', {
      deprecatedEndpoint: DEPRECATED_ARCANOS_ENDPOINT,
      canonicalRoute: CANONICAL_ARCANOS_ROUTE,
      requestId: req.requestId ?? null,
      route: DEPRECATED_ARCANOS_ENDPOINT
    });
  }

  next();
}

function classifyApiArcanosErrorType(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidateName = (error as { name?: unknown }).name;
    if (typeof candidateName === 'string' && candidateName.trim().length > 0) {
      return candidateName.trim();
    }
  }

  const message = resolveErrorMessage(error).toLowerCase();
  if (message.includes('timeout')) {
    return 'timeout';
  }
  if (message.includes('abort')) {
    return 'abort';
  }

  return 'unexpected_error';
}

/**
 * Purpose: Compatibility handler for deprecated `/api/arcanos/ask` traffic.
 * Inputs/Outputs: Accepts legacy request bodies and returns the historical route envelope.
 * Edge cases: Preserves `ping` health checks and rewrites deprecated traffic through the shared Trinity wrapper.
 */
const handleArcanosAsk = asyncHandler(async (
  req: Request<{}, ApiArcanosResponse, AskBody>,
  res: Response<ApiArcanosResponse>
) => {
  const requestId = req.requestId ?? 'api-arcanos-ask';
  const rawPrompt = extractPromptText(req.body, false) ?? '';
  recordPromptDebugTrace(requestId, 'ingress', {
    traceId: req.traceId ?? null,
    endpoint: ARCANOS_API_ENDPOINT_NAME,
    method: req.method,
    rawPrompt,
  });
  const pingCandidate = extractInput((req.body ?? {}) as AIRequestDTO)?.trim().toLowerCase();
  const diagnosticProbe = isDiagnosticRequest(req.body, pingCandidate);

  if (diagnosticProbe) {
    const idleStateService = req.app.locals.idleStateService as IdleStateService | undefined;
    idleStateService?.noteUserPing({ route: DEPRECATED_ARCANOS_ENDPOINT, source: ARCANOS_API_ENDPOINT_NAME });
    const diagnosticPayload = {
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
    };
    recordPromptDebugTrace(requestId, 'response', {
      traceId: req.traceId ?? null,
      endpoint: ARCANOS_API_ENDPOINT_NAME,
      method: req.method,
      rawPrompt,
      normalizedPrompt: pingCandidate ?? '',
      selectedRoute: DEPRECATED_ARCANOS_ENDPOINT,
      selectedModule: 'diagnostic',
      responseReturned: diagnosticPayload,
    });
    return sendBoundedJsonResponse(req, res, diagnosticPayload, {
      logEvent: 'api-arcanos.diagnostic.response',
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
    recordPromptDebugTrace(requestId, 'preprocess', {
      traceId: req.traceId ?? null,
      endpoint: ARCANOS_API_ENDPOINT_NAME,
      method: req.method,
      rawPrompt,
      normalizedPrompt: prompt,
    });
    recordPromptDebugTrace(requestId, 'routing', {
      traceId: req.traceId ?? null,
      endpoint: ARCANOS_API_ENDPOINT_NAME,
      method: req.method,
      rawPrompt,
      normalizedPrompt: prompt,
      selectedRoute: DEPRECATED_ARCANOS_ENDPOINT,
      selectedModule: 'ARCANOS:CORE',
      selectedTools: [],
    });
    recordPromptDebugTrace(requestId, 'executor', {
      traceId: req.traceId ?? null,
      endpoint: ARCANOS_API_ENDPOINT_NAME,
      method: req.method,
      rawPrompt,
      normalizedPrompt: prompt,
      selectedRoute: DEPRECATED_ARCANOS_ENDPOINT,
      selectedModule: 'ARCANOS:CORE',
      finalExecutorPayload: {
        executor: 'runArcanosCoreQuery',
        prompt,
        sessionId: req.body.sessionId ?? null,
        overrideAuditSafe: req.body.overrideAuditSafe ?? null,
        sourceEndpoint: ARCANOS_API_ENDPOINT_NAME,
        runOptions: buildTrinityOutputControlOptions(req.body),
      },
    });
    const trinityResult = await runArcanosCoreQuery({
      client: openai,
      prompt,
      sessionId: req.body.sessionId,
      overrideAuditSafe: req.body.overrideAuditSafe,
      sourceEndpoint: ARCANOS_API_ENDPOINT_NAME,
      runOptions: buildTrinityOutputControlOptions(req.body)
    });
    applyAIDegradedResponseHeaders(res, extractAIDegradedResponseMetadata(trinityResult));

    const responsePayload = buildArcanosCompatibilityResponse(trinityResult);
    recordPromptDebugTrace(requestId, 'response', {
      traceId: req.traceId ?? null,
      endpoint: ARCANOS_API_ENDPOINT_NAME,
      method: req.method,
      rawPrompt,
      normalizedPrompt: prompt,
      selectedRoute: DEPRECATED_ARCANOS_ENDPOINT,
      selectedModule: 'ARCANOS:CORE',
      responseReturned: responsePayload,
      fallbackPathUsed: responsePayload.fallbackFlag ? 'trinity-fallback' : null,
      fallbackReason: trinityResult.fallbackSummary?.fallbackReasons?.join('; ') ?? null,
    });

    if (req.body.options?.stream === true) {
      sendTrinityCompatibilityStream(res, responsePayload);
      return;
    }

    return sendBoundedJsonResponse(req, res, responsePayload, {
      logEvent: 'api-arcanos.response',
    });
  } catch (error: unknown) {
    req.logger?.error?.('api-arcanos.ask.failed', {
      route: DEPRECATED_ARCANOS_ENDPOINT,
      endpoint: ARCANOS_API_ENDPOINT_NAME,
      errorType: classifyApiArcanosErrorType(error),
      error: resolveErrorMessage(error),
      requestId,
    });
    recordPromptDebugTrace(requestId, 'fallback', {
      traceId: req.traceId ?? null,
      endpoint: ARCANOS_API_ENDPOINT_NAME,
      method: req.method,
      rawPrompt,
      normalizedPrompt: promptForError,
      selectedRoute: DEPRECATED_ARCANOS_ENDPOINT,
      selectedModule: 'ARCANOS:CORE',
      fallbackPathUsed: 'error-handler',
      fallbackReason: error instanceof Error ? error.message : String(error),
    });
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
  createValidationMiddleware(arcanosSchema),
  stripLegacyAuditOverride,
  handleArcanosAsk
);

export default router;

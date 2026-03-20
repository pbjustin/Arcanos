import express, { Request, Response } from 'express';
import { runThroughBrain, type TrinityResult } from '@core/logic/trinity.js';
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
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { buildTrinityOutputControlOptions } from '@shared/ask/trinityRequestOptions.js';
import { buildTrinityUserVisibleResponse } from '@shared/ask/trinityResponseSerializer.js';
import apiArcanosVerificationRouter from './api-arcanos-verification.js';
import { buildPromptShortcutTelemetry } from '@routes/_core/promptShortcutResponse.js';
import {
  tryExecutePromptRouteShortcut,
  type PromptRouteShortcutResult
} from '@services/promptRouteShortcuts.js';

const router = express.Router();

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
  mode?: string;
  action?: string;
  prompt?: string;
  message?: string;
  userInput?: string;
  content?: string;
  text?: string;
  query?: string;
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
    pipeline?: typeof TRINITY_PIPELINE_NAME;
    trinityVersion?: typeof TRINITY_PIPELINE_VERSION;
    endpoint?: string;
    requestId?: string;
    routingStages?: string[];
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

/**
 * Build stable Trinity metadata for the compatibility response envelope.
 *
 * Purpose:
 * - Make the legacy `/api/arcanos/ask` route explicitly identify the same Trinity pipeline used by the main `/ask` endpoint.
 *
 * Inputs/outputs:
 * - Input: Trinity execution result.
 * - Output: compatibility metadata block for the HTTP response.
 *
 * Edge case behavior:
 * - Missing token usage resolves to `0` to preserve a numeric compatibility field.
 */
function buildArcanosCompatibilityMetadata(result: TrinityResult): NonNullable<AskResponse['metadata']> {
  return {
    service: 'ARCANOS API',
    version: '1.0.0',
    model: result.activeModel,
    tokensUsed: result.meta.tokens?.total_tokens ?? 0,
    timestamp: new Date().toISOString(),
    arcanosRouting: true,
    pipeline: TRINITY_PIPELINE_NAME,
    trinityVersion: TRINITY_PIPELINE_VERSION,
    endpoint: ARCANOS_API_ENDPOINT_NAME,
    requestId: result.taskLineage.requestId,
    routingStages: result.routingStages
  };
}

/**
 * Convert a Trinity result into the legacy `/api/arcanos/ask` response envelope.
 *
 * Purpose:
 * - Preserve the compatibility shape for existing clients while routing execution through Trinity.
 *
 * Inputs/outputs:
 * - Input: Trinity execution result.
 * - Output: compatibility response payload with explicit pipeline metadata.
 *
 * Edge case behavior:
 * - Optional observability fields remain omitted when Trinity does not provide them.
 */
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
 * Serialize a Trinity compatibility result for SSE clients.
 *
 * Purpose:
 * - Keep the streaming compatibility path alive even though Trinity returns one finalized payload.
 *
 * Inputs/outputs:
 * - Input: compatibility response payload.
 * - Output: string chunk content suitable for one SSE `data:` frame.
 *
 * Edge case behavior:
 * - Non-string results are JSON encoded so structured outputs still reach streaming clients.
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
 * Stream one finalized Trinity compatibility response over SSE.
 *
 * Purpose:
 * - Preserve the existing `options.stream` contract without falling back to the legacy non-Trinity completion path.
 *
 * Inputs/outputs:
 * - Input: Express response plus compatibility payload.
 * - Output: writes the terminal SSE frames and closes the connection.
 *
 * Edge case behavior:
 * - Sends a single terminal chunk because Trinity currently resolves as one finalized response.
 */
function sendTrinityCompatibilityStream(
  res: Response<AskResponse | ErrorResponseDTO>,
  responsePayload: AskResponse
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const content = serializeCompatibilityResult(responsePayload.result);

  //audit Assumption: compatibility streaming clients still prefer SSE framing even when Trinity returns one finalized payload; failure risk: route-specific streaming clients break after the Trinity cleanup; expected invariant: the route emits one content frame and one done frame; handling strategy: serialize the final Trinity result into a terminal SSE sequence.
  if (content.length > 0) {
    res.write(`data: ${JSON.stringify({
      success: true,
      content,
      type: 'chunk',
      pipeline: TRINITY_PIPELINE_NAME
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
 * Build a compatibility response for any registered prompt shortcut on `/api/arcanos/ask`.
 * Inputs/outputs: normalized shortcut result -> legacy-compatible response envelope.
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
      endpoint: ARCANOS_API_ENDPOINT_NAME,
      requestId: shortcutTelemetry.requestId,
      routingStages: shortcutTelemetry.routingStages
    },
    module: shortcutTelemetry.module,
    activeModel: shortcutTelemetry.activeModel,
    fallbackFlag: shortcutTelemetry.fallbackFlag,
    routingStages: shortcutTelemetry.routingStages
  };
}

/**
 * Execute the legacy `/api/arcanos/ask` route through the Trinity pipeline.
 *
 * Purpose:
 * - Remove the old centralized-completion split while preserving the compatibility response envelope for existing clients.
 *
 * Inputs/outputs:
 * - Input: Express request carrying one prompt plus optional session and audit-safe overrides.
 * - Output: JSON or SSE compatibility response derived from a Trinity result.
 *
 * Edge case behavior:
 * - Ping requests bypass Trinity and return an immediate health response.
 */
const handleArcanosAsk = asyncHandler(async (
  req: Request<{}, AskResponse | ErrorResponseDTO, AskBody>,
  res: Response<AskResponse | ErrorResponseDTO>
) => {
  const pingCandidate = extractInput((req.body ?? {}) as AIRequestDTO)?.trim().toLowerCase();
  const diagnosticProbe = isDiagnosticRequest(req.body, pingCandidate);

  //audit Assumption: explicit diagnostic probes on the compatibility route must bypass Trinity and shortcuts just like the primary `/ask` route; failure risk: compatibility clients accidentally trigger stateful AI paths for health checks; expected invariant: diagnostic traffic returns a deterministic route-local payload; handling strategy: reuse the shared diagnostic classifier and short-circuit before model execution.
  if (diagnosticProbe) {
    const idleStateService = req.app.locals.idleStateService as IdleStateService | undefined;
    idleStateService?.noteUserPing({ route: '/api/arcanos/ask', source: ARCANOS_API_ENDPOINT_NAME });
    return res.json({
      success: true,
      result: pingCandidate === 'ping' ? 'pong' : 'backend operational',
      metadata: {
        service: 'ARCANOS API',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        arcanosRouting: true,
        pipeline: TRINITY_PIPELINE_NAME,
        trinityVersion: TRINITY_PIPELINE_VERSION,
        endpoint: ARCANOS_API_ENDPOINT_NAME
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
    //audit Assumption: deterministic prompt shortcuts should bypass Trinity generation on the compatibility route when they have a confident route-specific execution path; failure risk: route-specific prompts regress into generic Trinity output; expected invariant: registered shortcuts return stable deterministic content before Trinity; handling strategy: short-circuit through the shared shortcut registry.
    if (promptShortcut) {
      return res.json(
        buildArcanosPromptShortcutResponse({
          shortcut: promptShortcut
        })
      );
    }

    const runtimeBudget = createRuntimeBudget();

    //audit Assumption: legacy `/api/arcanos/ask` requests should now enter the same Trinity brain as the primary `/ask` route; failure risk: route-level pipeline drift persists even after the cleanup; expected invariant: every non-ping request on this route calls `runThroughBrain`; handling strategy: invoke Trinity directly and stamp the compatibility response with explicit pipeline metadata.
    const trinityResult = await runThroughBrain(
      openai,
      prompt,
      req.body.sessionId,
      req.body.overrideAuditSafe,
      {
        sourceEndpoint: ARCANOS_API_ENDPOINT_NAME,
        ...buildTrinityOutputControlOptions(req.body)
      },
      runtimeBudget
    );

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

router.post('/ask', arcanosAskRateLimit, confirmGate, createValidationMiddleware(arcanosSchema), handleArcanosAsk);

export default router;

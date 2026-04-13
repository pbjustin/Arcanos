import express, { Request, Response } from 'express';
import { z } from 'zod';
import { runThroughBrain } from "@core/logic/trinity.js";
import { createJob } from "@core/db/repositories/jobRepository.js";
import { validateAIRequest, handleAIError, logRequestFeedback } from "@transport/http/requestHandler.js";
import { confirmGate } from "@transport/http/middleware/confirmGate.js";
import {
  createRateLimitMiddleware,
  getRequestActorKey,
  securityHeaders
} from "@platform/runtime/security.js";
import type {
  AIRequestDTO,
  ErrorResponseDTO
} from "@shared/types/dto.js";
import { aiRequestSchema } from "@shared/types/dto.js";
import { asyncHandler, sendBadRequest, sendInternalErrorPayload } from '@shared/http/index.js';
import {
  shapeClientRouteResult
} from '@shared/http/clientResponseGuards.js';
import { sendBoundedJsonResponse } from '@shared/http/sendBoundedJsonResponse.js';
import {
  applyDeprecatedAskRouteHeaders,
  ASK_ROUTE_SUNSET_HEADER,
  ASK_ROUTE_MODE_HEADER,
  resolveAskRouteMode
} from '@shared/http/gptRouteHeaders.js';
import { isDiagnosticRequest } from '@shared/http/diagnosticRequest.js';
import { askValidationMiddleware } from "./validation.js";
import type {
  AskRequest,
  AskResponse,
  SchemaValidationBypassAuditFlag,
  SystemStateResponse
} from './types.js';
import { tryDispatchDaemonTools } from './daemonTools.js';
import { tryDispatchDagTools } from './dagTools.js';
import { tryDispatchWorkerTools } from './workerTools.js';
import { getGPT5Model } from '@services/openai.js';
import {
  buildCompletedQueuedAskOutput,
  buildQueuedAskJobInput,
  buildQueuedAskPendingResponse,
  type CompletedQueuedAskJobOutput
} from '@shared/ask/asyncAskJob.js';
import { buildTrinityOutputControlOptions } from '@shared/ask/trinityRequestOptions.js';
import {
  getActiveIntentSnapshot,
  getLastRoutingUsed,
  recordChatIntent,
  setLastRoutingUsed,
  type IntentConflict,
  updateIntentWithOptimisticLock
} from './intent_store.js';
import { detectCognitiveDomain } from '@dispatcher/detectCognitiveDomain.js';
import { gptFallbackClassifier } from '@dispatcher/gptDomainClassifier.js';
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { buildPromptShortcutTelemetry } from '@routes/_core/promptShortcutResponse.js';
import { shouldStoreOpenAIResponses } from '@config/openaiStore.js';
import { planAutonomousWorkerJob } from '@services/workerAutonomyService.js';
import {
  waitForQueuedAskJobCompletion,
  resolveAsyncAskWaitForResultMs,
  resolveAsyncAskPollIntervalMs
} from '@services/queuedAskCompletionService.js';
import {
  tryExecutePromptRouteShortcut,
  type PromptRouteShortcutResult
} from '@services/promptRouteShortcuts.js';
import { runHealthCheck } from '@platform/logging/diagnostics.js';
import { checkRedisHealth } from '@platform/resilience/unifiedHealth.js';
import {
  beginAiRouteTrace,
  completeAiRouteTrace,
  failAiRouteTrace
} from '@transport/http/aiRouteTelemetry.js';
import {
  summarizeAiExecutionContext,
  updateAiExecutionContext,
} from '@services/openai/aiExecutionContext.js';
import {
  collectRepoInspectionEvidence,
  buildRepoInspectionAnswer,
  isVerificationQuestion,
  shouldInspectRepoPrompt
} from '@services/repoImplementationEvidence.js';
import {
  extractPromptText,
  recordPromptDebugTrace,
  shouldInspectRuntimePrompt,
} from '@services/promptDebugTraceService.js';

const router = express.Router();

// Apply security middleware
router.use(securityHeaders);
const askRateLimit = createRateLimitMiddleware({
  bucketName: 'ask-route',
  maxRequests: 120,
  windowMs: 15 * 60 * 1000,
  keyGenerator: (req) => `${getRequestActorKey(req)}:route:ask`
});

const SYSTEM_REVIEW_PROMPT = `You are operating in SYSTEM_REVIEW mode.

You are not an assistant.
You are a system reviewer and architect.

Rules:
- Do not converse.
- Do not ask questions.
- Do not speculate beyond provided input.
- Identify strengths, risks, gaps, and assumptions explicitly.
- Output deterministic, structured JSON only.

Output must conform exactly to the system_review schema.`;

const SYSTEM_STATE_PROMPT = `⚠️ Do not use the model yet.
Return backend data directly.`;

const systemReviewSchema = z.object({
  mode: z.literal('system_review'),
  subject: z.literal('intent_system'),
  verdict: z.enum(['approved', 'approved_with_risks', 'blocked']),
  summary: z.string().min(1).max(2000),
  strengths: z.array(z.string()),
  risks: z.array(
    z.object({
      level: z.enum(['low', 'medium', 'high']),
      area: z.string().min(1),
      description: z.string().min(1),
      mitigation: z.string().min(1)
    })
  ),
  gaps: z.array(z.string()),
  recommendations: z.array(
    z.object({
      priority: z.enum(['low', 'medium', 'high']),
      action: z.string().min(1),
      rationale: z.string().min(1)
    })
  ),
  assumptions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  reviewedAt: z.string().datetime(),
  reviewVersion: z.literal(1)
});

const systemStateSchema = z.object({
  mode: z.literal('system_state'),
  intent: z.object({
    intentId: z.string().nullable(),
    label: z.string().nullable(),
    status: z.enum(['active', 'paused', 'completed']).nullable(),
    phase: z.enum(['exploration', 'execution']).nullable(),
    confidence: z.number().min(0).max(1),
    version: z.number().int().min(1),
    lastTouchedAt: z.string().datetime().nullable()
  }),
  routing: z.object({
    preferred: z.enum(['local', 'backend']),
    lastUsed: z.enum(['local', 'backend']),
    confidenceGate: z.number().min(0).max(1)
  }),
  backend: z.object({
    connected: z.literal(true),
    registryAvailable: z.literal(true),
    lastHeartbeatAt: z.string().datetime()
  }),
  stateFreshness: z.object({
    intent: z.enum(['fresh', 'stale']),
    backend: z.enum(['fresh', 'degraded']),
    lastValidatedAt: z.string().datetime()
  }),
  limits: z.object({
    rateLimited: z.boolean(),
    remainingRequests: z.number().int().min(0)
  }),
  generatedAt: z.string().datetime(),
  confidence: z.number().min(0).max(1)
});

const systemStateUpdateSchema = z
  .object({
    mode: z.literal('system_state'),
    expectedVersion: z.number().int().min(1).optional(),
    patch: z
      .object({
        confidence: z.number().min(0).max(1).optional(),
        phase: z.enum(['exploration', 'execution']).optional(),
        status: z.enum(['active', 'paused', 'completed']).optional(),
        label: z.string().min(1).max(200).optional()
      })
      .optional()
  })
  .superRefine((data, ctx) => {
    //audit Assumption: optimistic lock updates require both expectedVersion and patch; failure risk: partial contract writes; expected invariant: update fields provided together; handling strategy: reject incomplete update payload.
    if ((data.expectedVersion === undefined) !== (data.patch === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "system_state updates require both 'expectedVersion' and 'patch'"
      });
    }
  });

function nowIso(): string {
  return new Date().toISOString();
}

function buildPromptDebugContext(
  req: Request,
  endpointName: string,
  rawPrompt: string,
  normalizedPrompt?: string,
): {
  traceId: string | null;
  endpoint: string;
  method: string;
  rawPrompt: string;
  normalizedPrompt?: string;
} {
  return {
    traceId: req.traceId ?? null,
    endpoint: endpointName,
    method: req.method,
    rawPrompt,
    ...(typeof normalizedPrompt === 'string' ? { normalizedPrompt } : {}),
  };
}

function getMode(body: AskRequest): 'chat' | 'system_review' | 'system_state' {
  if (body.mode === 'system_review') {
    return 'system_review';
  }
  if (body.mode === 'system_state') {
    return 'system_state';
  }
  return 'chat';
}

function buildDiagnosticAskResponse(params: {
  endpointName: string;
  clientContext?: AskRequest['clientContext'];
  auditFlag?: SchemaValidationBypassAuditFlag;
}): AskResponse {
  return {
    result: 'backend operational',
    module: 'diagnostic',
    meta: {
      id: `diagnostic-${params.endpointName}-v1`,
      created: 0
    },
    activeModel: 'diagnostic',
    fallbackFlag: false,
    routingStages: ['DIAGNOSTIC-SHORTCUT'],
    gpt5Used: false,
    endpoint: params.endpointName,
    ...(params.clientContext ? { clientContext: params.clientContext } : {}),
    ...(params.auditFlag ? { auditFlag: params.auditFlag } : {})
  };
}

function wantsAsync(body: AskRequest): boolean {
  // Accept either `mode: "async"` or `async: true` without breaking existing clients.
  const anyBody = body as unknown as Record<string, unknown>;
  return body.mode === 'async' || anyBody.async === true;
}

function extractTextInput(body: AskRequest): string | null {
  const candidates = [body.prompt, body.message, body.userInput, body.content, body.text, body.query];
  for (const candidate of candidates) {
    //audit Assumption: first non-empty string should be treated as primary text input; failure risk: alias precedence mismatch; expected invariant: deterministic extraction order; handling strategy: fixed field ordering.
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

function buildValidationBypassFlag(reason: string): SchemaValidationBypassAuditFlag {
  return {
    auditFlag: 'SCHEMA_VALIDATION_BYPASS',
    reason,
    timestamp: nowIso()
  };
}

function parseJsonContent(rawContent: string): unknown {
  const trimmed = rawContent.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fencedMatch ? fencedMatch[1] : trimmed;
  return JSON.parse(jsonText);
}

function buildSystemStateResponse(sessionId?: string): SystemStateResponse {
  const now = nowIso();
  const activeIntent = getActiveIntentSnapshot(sessionId);
  const lastTouchedAt = activeIntent?.lastTouchedAt ?? null;
  const isIntentFresh =
    !!lastTouchedAt && Date.now() - Date.parse(lastTouchedAt) <= 15 * 60 * 1000;

  return {
    mode: 'system_state',
    intent: {
      intentId: activeIntent?.intentId ?? null,
      label: activeIntent?.label ?? null,
      status: activeIntent?.status ?? null,
      phase: activeIntent?.phase ?? null,
      confidence: activeIntent?.confidence ?? 0,
      version: activeIntent?.version ?? 1,
      lastTouchedAt
    },
    routing: {
      preferred: 'backend',
      lastUsed: getLastRoutingUsed(sessionId),
      confidenceGate: 0.75
    },
    backend: {
      connected: true,
      registryAvailable: true,
      lastHeartbeatAt: now
    },
    stateFreshness: {
      intent: isIntentFresh ? 'fresh' : 'stale',
      backend: 'fresh',
      lastValidatedAt: now
    },
    limits: {
      rateLimited: false,
      remainingRequests: 0
    },
    generatedAt: now,
    confidence: 0.99
  };
}

function validateLenientChatRequest(body: AskRequest): {
  ok: true;
  normalizedBody: AIRequestDTO & AskRequest;
  auditFlag?: SchemaValidationBypassAuditFlag;
} | {
  ok: false;
  errorPayload: ErrorResponseDTO;
} {
  const extractedPrompt = extractTextInput(body);
  //audit Assumption: chat mode requires textual input; failure risk: empty requests entering model pipeline; expected invariant: prompt exists; handling strategy: reject missing text fields.
  if (!extractedPrompt) {
    return {
      ok: false,
      errorPayload: {
        error: 'Validation failed',
        details: [
          "Request must include one of 'prompt', 'message', 'userInput', 'content', 'text', or 'query' fields"
        ]
      }
    };
  }

  const normalizedBody: AIRequestDTO & AskRequest = {
    ...body,
    prompt: extractedPrompt
  };

  const strictResult = aiRequestSchema.safeParse(normalizedBody);
  if (strictResult.success) {
    return { ok: true, normalizedBody: strictResult.data };
  }

  const fallbackBody: AIRequestDTO & AskRequest = {
    prompt: extractedPrompt,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    overrideAuditSafe: typeof body.overrideAuditSafe === 'string' ? body.overrideAuditSafe : undefined,
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata : undefined,
    clientContext: typeof body.clientContext === 'object' && body.clientContext !== null ? body.clientContext : undefined
  };

  const fallbackStrictResult = aiRequestSchema.safeParse(fallbackBody);
  //audit Assumption: lenient fallback should still respect base AI schema; failure risk: malformed payload bypass; expected invariant: fallback remains schema-valid; handling strategy: reject if fallback parse fails.
  if (!fallbackStrictResult.success) {
    return {
      ok: false,
      errorPayload: {
        error: 'Validation failed',
        details: fallbackStrictResult.error.issues.map(
          issue => `${issue.path.join('.') || 'body'}: ${issue.message}`
        )
      }
    };
  }

  return {
    ok: true,
    normalizedBody: fallbackStrictResult.data,
    auditFlag: buildValidationBypassFlag(
      'Lenient chat schema path accepted request after strict validation failure'
    )
  };
}

/**
 * Build a deterministic `/ask` response for any registered prompt shortcut.
 * Inputs/outputs: normalized shortcut result + endpoint metadata -> route response payload.
 * Edge cases: shortcut-specific telemetry is derived from the shared shortcut contract so new shortcut types do not need route-specific response builders.
 */
function buildAskPromptShortcutResponse(params: {
  shortcut: PromptRouteShortcutResult;
  endpointName: string;
  clientContext?: AskRequest['clientContext'];
  auditFlag?: SchemaValidationBypassAuditFlag;
}): AskResponse {
  const shortcutTelemetry = buildPromptShortcutTelemetry(params.shortcut);

  return {
    result: params.shortcut.resultText,
    module: shortcutTelemetry.module,
    meta: {
      id: shortcutTelemetry.requestId,
      created: Math.floor(new Date(shortcutTelemetry.timestamp).getTime() / 1000)
    },
    activeModel: shortcutTelemetry.activeModel,
    fallbackFlag: shortcutTelemetry.fallbackFlag,
    routingStages: shortcutTelemetry.routingStages,
    gpt5Used: false,
    endpoint: params.endpointName,
    ...(params.clientContext ? { clientContext: params.clientContext } : {}),
    ...(params.auditFlag ? { auditFlag: params.auditFlag } : {})
  };
}

function readRequestedAsyncAskWaitMs(body: AskRequest): number | undefined {
  return typeof body.waitForResultMs === 'number'
    ? body.waitForResultMs
    : undefined;
}

function isSystemHealthProbePrompt(prompt: string): boolean {
  return prompt.trim().toLowerCase() === 'system health test';
}

/**
 * Build a deterministic `/ask` response for operator health probe prompts.
 * Inputs/outputs: endpoint metadata + optional client context/audit flag -> standard ask response payload.
 * Edge cases: Redis health is folded into the returned summary so probe callers see the same degraded signal as `/health`.
 */
async function buildSystemHealthProbeResponse(params: {
  endpointName: string;
  clientContext?: AskRequest['clientContext'];
  auditFlag?: SchemaValidationBypassAuditFlag;
}): Promise<AskResponse> {
  const healthReport = runHealthCheck();
  const redisHealth = await checkRedisHealth();
  const overallStatus = healthReport.status === 'ok' && redisHealth.healthy ? 'ok' : 'degraded';
  const summary = redisHealth.healthy
    ? healthReport.summary
    : `${healthReport.summary} | Redis: ${redisHealth.error || 'unhealthy'}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const requestId = `health_${createdAt}`;

  return {
    result: `System health ${overallStatus}. ${summary}.`,
    module: 'system-health',
    meta: {
      id: requestId,
      created: createdAt
    },
    activeModel: 'system-health',
    fallbackFlag: false,
    routingStages: ['SYSTEM-HEALTH-SHORTCUT'],
    gpt5Used: false,
    endpoint: params.endpointName,
    ...(params.clientContext ? { clientContext: params.clientContext } : {}),
    ...(params.auditFlag ? { auditFlag: params.auditFlag } : {})
  };
}

/**
 * Convert a completed async queue job payload into the standard `/ask` response contract.
 * Purpose: keep queued and synchronous ask responses shape-compatible when the worker finishes inside the wait window.
 * Inputs/outputs: accepts the raw terminal queue output and returns the route response payload or `null`.
 * Edge case behavior: non-object or null outputs are treated as invalid so callers do not receive ambiguous success payloads.
 */
function normalizeCompletedAsyncAskResponse(output: unknown): CompletedQueuedAskJobOutput | null {
  //audit Assumption: successful queued `/ask` jobs persist the same structured output shape returned by sync Trinity execution; failure risk: malformed job output gets returned as a false-success payload; expected invariant: completed async output is a non-null object; handling strategy: fail closed on invalid shapes.
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return null;
  }

  return output as CompletedQueuedAskJobOutput;
}

/**
 * Build a stable internal-error payload for terminal async `/ask` job failures.
 * Purpose: surface queue failures immediately when the worker fails inside the bounded wait window.
 * Inputs/outputs: accepts the queued job id plus error context and returns a JSON-safe error payload.
 * Edge case behavior: missing error messages fall back to a deterministic generic failure string.
 */
function buildAsyncAskFailurePayload(jobId: string, errorMessage?: string | null): {
  error: string;
  message: string;
  jobId: string;
  poll: string;
} {
  return {
    error: 'ASYNC_ASK_JOB_FAILED',
    message: errorMessage?.trim() || 'Async ask job failed.',
    jobId,
    poll: `/jobs/${jobId}`
  };
}

function sendGuardedAskResponse(
  req: Request<{}, any, AskRequest>,
  res: Response<any>,
  payload: object,
  logEvent: string,
  statusCode = 200
) {
  return sendBoundedJsonResponse(req, res, payload as Record<string, unknown>, {
    logEvent,
    statusCode,
  });
}

function extractAskRouteGptHint(req: Request): string | null {
  const source = req.method === 'GET' ? req.query : req.body;
  const routedBodyGptId = typeof source?.gptId === 'string' ? source.gptId.trim() : '';
  if (routedBodyGptId) {
    return routedBodyGptId;
  }

  const headerGptId = req.header('x-gpt-id');
  if (typeof headerGptId === 'string' && headerGptId.trim().length > 0) {
    return headerGptId.trim();
  }

  return null;
}

function attachAskDeprecationMetadata(req: Request, res: Response, next: () => void): void {
  const hintedGptId = extractAskRouteGptHint(req);
  const canonicalRoute = applyDeprecatedAskRouteHeaders(res, hintedGptId);
  const askRouteMode = resolveAskRouteMode();

  req.logger?.info?.('ask.deprecated_route_used', {
    endpoint: req.originalUrl,
    method: req.method,
    canonicalRoute,
    gptIdHint: hintedGptId,
    headerGptIdPresent: Boolean(req.header('x-gpt-id')),
    requestId: req.requestId ?? null,
    routeMode: askRouteMode,
    sunsetAt: ASK_ROUTE_SUNSET_HEADER
  });

  next();
}

/**
 * Shared handler for both ask and brain endpoints
 * Handles AI request processing with standardized error handling and validation
 */
export const handleAIRequest = async (
  req: Request<{}, any, AskRequest>,
  res: Response<any>,
  endpointName: string
) => {
  const requestId = req.requestId ?? `${endpointName}-prompt-debug`;
  const rawPrompt = extractPromptText(req.body, false) ?? '';
  recordPromptDebugTrace(requestId, 'ingress', buildPromptDebugContext(req, endpointName, rawPrompt));
  updateAiExecutionContext({
    sourceType: 'route',
    sourceName: endpointName,
    requestId: req.requestId,
    traceId: req.traceId,
    budget: {
      maxCalls: 24,
    }
  });
  const mode = getMode(req.body);

  if (mode === 'system_state') {
    const stateRequest = systemStateUpdateSchema.safeParse(req.body);
    //audit Assumption: system mode requests are strictly validated; failure risk: ambiguous mode behavior; expected invariant: strict contract before execution; handling strategy: hard fail on validation errors.
    if (!stateRequest.success) {
      return sendBadRequest(res, 'SYSTEM_STATE_REQUEST_INVALID', stateRequest.error.issues.map(issue => issue.message));
    }

    if (stateRequest.data.expectedVersion !== undefined && stateRequest.data.patch) {
      const updateResult = updateIntentWithOptimisticLock(
        stateRequest.data.expectedVersion,
        stateRequest.data.patch,
        typeof req.body.sessionId === 'string' ? req.body.sessionId : undefined
      );
      //audit Assumption: optimistic lock mismatch must return conflict; failure risk: stale write accepted; expected invariant: 409 on version mismatch; handling strategy: return conflict payload.
      if (!updateResult.ok) {
        const conflict = (updateResult as { ok: false; conflict: IntentConflict }).conflict;
        return sendGuardedAskResponse(
          req,
          res,
          conflict,
          `${endpointName}.system_state.conflict`,
          409
        );
      }
    }

    //audit Assumption: SYSTEM_STATE_PROMPT exists as governance artifact only; failure risk: accidental model usage; expected invariant: mode serves backend facts directly; handling strategy: never call model here.
    void SYSTEM_STATE_PROMPT;

    const stateResponse = buildSystemStateResponse(typeof req.body.sessionId === 'string' ? req.body.sessionId : undefined);
    const strictState = systemStateSchema.safeParse(stateResponse);
    //audit Assumption: system_state responses must be schema-valid before send; failure risk: CLI drift on malformed payload; expected invariant: strict response contract; handling strategy: hard fail invalid payloads.
    if (!strictState.success) {
      return sendInternalErrorPayload(res, {
        error: 'SYSTEM_STATE_RESPONSE_INVALID',
        details: strictState.error.issues.map(issue => issue.message)
      });
    }

    return sendGuardedAskResponse(req, res, strictState.data, `${endpointName}.system_state.response`);
  }

  if (mode === 'system_review') {

    // Normalize and validate via shared AI request path to get a client and input
    const validation = validateAIRequest(req as Request, res as Response, endpointName);
    if (!validation) return; // validateAIRequest has already sent a response

    const { client } = validation;
    let reviewInput = validation.input;

    // Sanitize user input to reduce prompt-injection surface
    const sanitizeForPrompt = (input: string): string => {
      // remove non-printable/control characters and limit length
      const cleaned = input.replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, 20000);
      // escape triple backticks (avoid literal backticks in source)
      const triples = String.fromCharCode(96, 96, 96);
      return cleaned.replace(new RegExp(triples.replace(/([\\^$.*+?()[\]{}|])/g, '\\$1'), 'g'), "\u200B" + triples);
    };

    try {
      const modelResponse = await client.responses.create({
        model: getGPT5Model(),
        store: shouldStoreOpenAIResponses(),
        input: [
          { role: 'developer', content: SYSTEM_REVIEW_PROMPT },
          {
            role: 'user',
            content: [
              'Subject: intent_system',
              '',
              'Input:',
              '',
              String.fromCharCode(96,96,96),
              sanitizeForPrompt(reviewInput),
              String.fromCharCode(96,96,96),
              ''
            ].join('\n')
          }
        ],
        temperature: 0,
        stream: false
      });

      const rawContent = (modelResponse as any)?.output_text ?? (modelResponse as any)?.outputText ?? (modelResponse as any)?.output_text;
      //audit Assumption: strict review requires textual JSON payload; failure risk: empty model content; expected invariant: parseable JSON string; handling strategy: hard fail missing content.
      if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
        return sendInternalErrorPayload(res, {
          error: 'SYSTEM_REVIEW_RESPONSE_INVALID',
          details: ['Model returned empty content for system_review mode']
        });
      }

      const parsedContent = parseJsonContent(rawContent);
      const normalizedReviewPayload = {
        ...(typeof parsedContent === 'object' && parsedContent !== null ? parsedContent : {}),
        mode: 'system_review',
        subject: 'intent_system',
        reviewVersion: 1,
        reviewedAt: nowIso()
      };

      const strictReview = systemReviewSchema.safeParse(normalizedReviewPayload);
      if (!strictReview.success) {
        return sendInternalErrorPayload(res, {
          error: 'SYSTEM_REVIEW_RESPONSE_INVALID',
          details: strictReview.error.issues.map(issue => issue.message)
        });
      }

      return sendGuardedAskResponse(req, res, strictReview.data, `${endpointName}.system_review.response`);
    } catch (error) {
      return sendInternalErrorPayload(res, {
        error: 'SYSTEM_REVIEW_EXECUTION_FAILED',
        details: [error instanceof Error ? error.message : String(error)]
      });
    }
  }

  //audit Assumption: async intent must be captured from the raw payload before schema normalization; failure risk: `mode:"async"` / `async:true` gets stripped and request runs synchronously; expected invariant: asyncRequested reflects caller intent; handling strategy: read once from original body.
  const asyncRequested = wantsAsync(req.body);
  const requestedAsyncAskWaitMs = readRequestedAsyncAskWaitMs(req.body);

  //audit Assumption: diagnostic probes must bypass prompt shortcuts, memory, audit-safe, and Trinity to stay deterministic and stateless; failure risk: health checks inherit prior context or gameplay routing; expected invariant: explicit diagnostic traffic returns a stable route-local payload; handling strategy: short-circuit before validation normalization and before any stateful or generative layer executes.
  if (isDiagnosticRequest(req.body, extractTextInput(req.body))) {
    const diagnosticPayload = buildDiagnosticAskResponse({
      endpointName,
      clientContext: req.body.clientContext
    });
    recordPromptDebugTrace(requestId, 'response', {
      ...buildPromptDebugContext(req, endpointName, rawPrompt, rawPrompt.trim()),
      selectedRoute: endpointName,
      selectedModule: 'diagnostic',
      responseReturned: diagnosticPayload,
    });
    return sendGuardedAskResponse(
      req,
      res,
      diagnosticPayload,
      `${endpointName}.diagnostic.response`
    );
  }

  const lenientChatValidation = validateLenientChatRequest(req.body);
  if (!lenientChatValidation.ok) {
    recordPromptDebugTrace(requestId, 'response', {
      ...buildPromptDebugContext(req, endpointName, rawPrompt),
      responseReturned: lenientChatValidation.errorPayload,
      fallbackReason: 'lenient_chat_validation_failed',
    });
    return sendGuardedAskResponse(
      req,
      res,
      lenientChatValidation.errorPayload as Record<string, unknown>,
      `${endpointName}.validation.error`,
      400
    );
  }

  req.body = lenientChatValidation.normalizedBody;
  const bypassAuditFlag = lenientChatValidation.auditFlag;

  const { sessionId, overrideAuditSafe, metadata } = req.body;
  const normalizedPrompt = req.body.prompt || extractTextInput(req.body) || '';
  recordPromptDebugTrace(requestId, 'preprocess', buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt));
  const trackedSessionId =
    typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : undefined;

  //audit Assumption: anonymous /ask traffic must stay stateless by default; risk: unrelated callers sharing an in-memory intent bucket; invariant: intent tracking only persists for explicit session scopes; handling: skip stateful intent storage unless sessionId is present.
  const activeIntent = trackedSessionId ? recordChatIntent(normalizedPrompt, trackedSessionId) : null;
  if (trackedSessionId) {
    setLastRoutingUsed('backend', trackedSessionId);
  }

  // Domain Detection
  const detection = detectCognitiveDomain(normalizedPrompt);
  let finalDomain = detection.domain;
  let finalConfidence = detection.confidence;

  // Use shared validation logic
  const validation = validateAIRequest(req, res, endpointName);
  if (!validation) return; // Response already sent

  const { client: openai, input: prompt } = validation;
  const repoInspectionRequested = shouldInspectRepoPrompt(prompt);
  const runtimeInspectionRequested = shouldInspectRuntimePrompt(prompt);
  const verificationQuestion = isVerificationQuestion(prompt);
  let repoEvidence: Awaited<ReturnType<typeof collectRepoInspectionEvidence>> | null = null;

  if (repoInspectionRequested) {
    repoEvidence = await collectRepoInspectionEvidence(prompt);

    const hasSuccessfulRepoEvidence =
      repoEvidence.tree.ok
      || repoEvidence.status.ok
      || repoEvidence.log.ok
      || repoEvidence.searches.some((search) => search.ok);

    if (verificationQuestion && !hasSuccessfulRepoEvidence) {
      const failurePayload = {
        error: {
          code: 'REPO_EVIDENCE_REQUIRED',
          message: 'Cannot verify implementation without repo inspection.'
        }
      };
      recordPromptDebugTrace(requestId, 'response', {
        ...buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt),
        selectedRoute: endpointName,
        selectedModule: 'repo-inspection',
        selectedTools: ['repo-inspection'],
        repoInspectionChosen: true,
        runtimeInspectionChosen: false,
        responseReturned: failurePayload,
        fallbackReason: 'repo_evidence_required',
      });
      return sendGuardedAskResponse(req, res, {
        error: {
          code: 'REPO_EVIDENCE_REQUIRED',
          message: 'Cannot verify implementation without repo inspection.'
        }
      }, `${endpointName}.repo_evidence_required`, 503);
    }
  }

  // Hybrid fallback: use GPT classifier when heuristic confidence is low
  if (finalConfidence < 0.85) {
    try {
      // Use the same normalized prompt for both heuristic and GPT-based domain classification
      finalDomain = await gptFallbackClassifier(openai, normalizedPrompt);
      finalConfidence = 0.9;
    } catch (error) {
      // Keep heuristic result on classifier failure, but log for observability
      console.warn('[⚠️ DOMAIN] GPT fallback classifier failed; using heuristic result instead.', error);
    }
  }

  // Update intent state with cognitive domain
  if (trackedSessionId && activeIntent) {
    const domainUpdate = updateIntentWithOptimisticLock(
      activeIntent.version,
      {
        cognitiveDomain: finalDomain,
        domainConfidence: finalConfidence
      },
      trackedSessionId
    );
    if (!domainUpdate.ok) {
      console.warn(`[⚠️ DOMAIN] Intent version conflict during domain update (expected=${activeIntent.version}, current=${domainUpdate.conflict.currentVersion})`);
    }
  }

  console.log(`[📨 ${endpointName.toUpperCase()}] Processing with sessionId: ${sessionId || 'none'}, auditOverride: ${overrideAuditSafe || 'none'}, domain: ${finalDomain} (${finalConfidence})`);
  // Log request for feedback loop
  logRequestFeedback(prompt, endpointName);
  const routeTrace = beginAiRouteTrace(req, endpointName, prompt, getGPT5Model());

  try {
    const daemonToolResponse = await tryDispatchDaemonTools(openai, prompt, metadata);
    if (daemonToolResponse) {
      recordPromptDebugTrace(requestId, 'routing', {
        ...buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt),
        selectedRoute: endpointName,
        selectedModule: 'daemon-tool',
        selectedTools: ['daemon-tools'],
        repoInspectionChosen: repoInspectionRequested,
        runtimeInspectionChosen: false,
      });
      if ('confirmation_required' in daemonToolResponse) {
        //audit Assumption: confirmation required should block response; risk: sensitive execution; invariant: 403 returned; handling: return challenge.
        const confirmationPayload = {
          code: 'CONFIRMATION_REQUIRED',
          confirmationChallenge: { id: daemonToolResponse.confirmation_token },
          pending_actions: daemonToolResponse.pending_actions
        };
        recordPromptDebugTrace(requestId, 'response', {
          ...buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt),
          selectedRoute: endpointName,
          selectedModule: 'daemon-tool',
          selectedTools: ['daemon-tools'],
          repoInspectionChosen: repoInspectionRequested,
          runtimeInspectionChosen: false,
          finalExecutorPayload: {
            executor: 'daemon-tools',
            prompt,
            metadata: metadata ?? null,
          },
          responseReturned: confirmationPayload,
          fallbackPathUsed: 'confirmation-required',
          fallbackReason: 'daemon_tool_confirmation_required',
        });
        completeAiRouteTrace(req, routeTrace, {
          activeModel: 'daemon-tool',
          fallbackFlag: false,
          extra: { disposition: 'confirmation-required' }
        });
        return sendGuardedAskResponse(req, res, {
          code: 'CONFIRMATION_REQUIRED',
          confirmationChallenge: { id: daemonToolResponse.confirmation_token },
          pending_actions: daemonToolResponse.pending_actions
        }, `${endpointName}.confirmation_required`, 403);
      }
      //audit Assumption: daemon tool response is terminal; risk: skipping trinity; invariant: tool actions queued; handling: return early.
      recordPromptDebugTrace(requestId, 'response', {
        ...buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt),
        selectedRoute: endpointName,
        selectedModule: 'daemon-tool',
        selectedTools: ['daemon-tools'],
        repoInspectionChosen: repoInspectionRequested,
        runtimeInspectionChosen: false,
        finalExecutorPayload: {
          executor: 'daemon-tools',
          prompt,
          metadata: metadata ?? null,
        },
        responseReturned: daemonToolResponse,
      });
      completeAiRouteTrace(req, routeTrace, {
        activeModel: 'daemon-tool',
        fallbackFlag: false,
        extra: { disposition: 'daemon-tool' }
      });
      return sendGuardedAskResponse(req, res, {
        ...(shapeClientRouteResult(daemonToolResponse) as Record<string, unknown>),
        endpoint: endpointName,
        clientContext: req.body.clientContext,
        ...(bypassAuditFlag ? { auditFlag: bypassAuditFlag } : {})
      }, `${endpointName}.daemon_tool.response`);
    }

    const dagToolResponse = await tryDispatchDagTools(openai, prompt, {
      sessionId,
      requestId: req.requestId,
      traceId: req.traceId,
      logger: req.logger,
    });
    if (dagToolResponse) {
      recordPromptDebugTrace(requestId, 'response', {
        ...buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt),
        selectedRoute: endpointName,
        selectedModule: 'dag-tool',
        selectedTools: ['dag-tools'],
        repoInspectionChosen: repoInspectionRequested,
        runtimeInspectionChosen: false,
        finalExecutorPayload: {
          executor: 'dag-tools',
          prompt,
          sessionId: sessionId ?? null,
          requestId: req.requestId ?? null,
          traceId: req.traceId ?? null,
        },
        responseReturned: dagToolResponse,
      });
      completeAiRouteTrace(req, routeTrace, {
        activeModel: 'dag-tool',
        fallbackFlag: false,
        extra: { disposition: 'dag-tool' }
      });
      return sendGuardedAskResponse(req, res, {
        ...(shapeClientRouteResult(dagToolResponse) as Record<string, unknown>),
        endpoint: endpointName,
        clientContext: req.body.clientContext,
        ...(bypassAuditFlag ? { auditFlag: bypassAuditFlag } : {})
      }, `${endpointName}.dag_tool.response`);
    }

    const workerToolResponse = await tryDispatchWorkerTools(openai, prompt);
    if (workerToolResponse) {
      recordPromptDebugTrace(requestId, 'response', {
        ...buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt),
        selectedRoute: endpointName,
        selectedModule: 'worker-tool',
        selectedTools: ['worker-tools'],
        repoInspectionChosen: repoInspectionRequested,
        runtimeInspectionChosen: false,
        finalExecutorPayload: {
          executor: 'worker-tools',
          prompt,
        },
        responseReturned: workerToolResponse,
      });
      completeAiRouteTrace(req, routeTrace, {
        activeModel: 'worker-tool',
        fallbackFlag: false,
        extra: { disposition: 'worker-tool' }
      });
      return sendGuardedAskResponse(req, res, {
        ...(shapeClientRouteResult(workerToolResponse) as Record<string, unknown>),
        endpoint: endpointName,
        clientContext: req.body.clientContext,
        ...(bypassAuditFlag ? { auditFlag: bypassAuditFlag } : {})
      }, `${endpointName}.worker_tool.response`);
    }

    const promptShortcut = await tryExecutePromptRouteShortcut({
      prompt,
      sessionId
    });
    //audit Assumption: deterministic prompt shortcuts should bypass Trinity generation when they have a confident route-specific execution path; failure risk: memory and booker prompts drift back into generic chat behavior; expected invariant: registered shortcuts return stable route-specific output before Trinity; handling strategy: execute the shared shortcut registry and short-circuit on the first match.
    if (promptShortcut) {
      const shortcutResponse = buildAskPromptShortcutResponse({
        shortcut: promptShortcut,
        endpointName,
        clientContext: req.body.clientContext,
        auditFlag: bypassAuditFlag ?? undefined
      });
      recordPromptDebugTrace(requestId, 'response', {
        ...buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt),
        selectedRoute: endpointName,
        selectedModule: promptShortcut.response.module,
        selectedTools: [promptShortcut.shortcutId],
        repoInspectionChosen: repoInspectionRequested,
        runtimeInspectionChosen: false,
        finalExecutorPayload: {
          executor: 'prompt-shortcut',
          shortcutId: promptShortcut.shortcutId,
          prompt,
        },
        responseReturned: shortcutResponse,
      });
      completeAiRouteTrace(req, routeTrace, {
        activeModel: promptShortcut.response.activeModel,
        fallbackFlag: false,
        extra: {
          disposition: 'prompt-shortcut',
          shortcutId: promptShortcut.shortcutId
        }
      });
      return sendGuardedAskResponse(
        req,
        res,
        shortcutResponse,
        `${endpointName}.shortcut.response`
      );
    }

    if (isSystemHealthProbePrompt(prompt)) {
      const systemHealthResponse = await buildSystemHealthProbeResponse({
        endpointName,
        clientContext: req.body.clientContext,
        auditFlag: bypassAuditFlag ?? undefined
      });
      recordPromptDebugTrace(requestId, 'response', {
        ...buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt),
        selectedRoute: endpointName,
        selectedModule: 'system-health',
        selectedTools: [],
        repoInspectionChosen: repoInspectionRequested,
        runtimeInspectionChosen: true,
        finalExecutorPayload: {
          executor: 'system-health-shortcut',
          prompt,
        },
        responseReturned: systemHealthResponse,
      });
      completeAiRouteTrace(req, routeTrace, {
        activeModel: systemHealthResponse.activeModel,
        fallbackFlag: false,
        extra: { disposition: 'system-health-shortcut' }
      });
      return sendGuardedAskResponse(req, res, systemHealthResponse, `${endpointName}.system_health.response`);
    }

    if (repoEvidence) {
      const repoInspectionResult = buildRepoInspectionAnswer(prompt, repoEvidence);
      const repoInspectionResponse = {
        result: repoInspectionResult,
        module: 'repo-inspection',
        meta: {
          id: `repo_inspection_${Date.now()}`,
          created: Math.floor(Date.now() / 1000)
        },
        activeModel: 'repo-inspection',
        fallbackFlag: false,
        routingStages: ['REPO-INSPECTION'],
        gpt5Used: false,
        endpoint: endpointName,
        clientContext: req.body.clientContext,
        ...(bypassAuditFlag ? { auditFlag: bypassAuditFlag } : {})
      };
      recordPromptDebugTrace(requestId, 'response', {
        ...buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt),
        selectedRoute: endpointName,
        selectedModule: 'repo-inspection',
        selectedTools: ['repo-inspection'],
        repoInspectionChosen: true,
        runtimeInspectionChosen: false,
        finalExecutorPayload: {
          executor: 'repo-inspection',
          prompt,
          repoEvidence,
        },
        responseReturned: repoInspectionResponse,
      });
      completeAiRouteTrace(req, routeTrace, {
        activeModel: 'repo-inspection',
        fallbackFlag: false,
        extra: { disposition: 'repo-inspection' }
      });
      return sendGuardedAskResponse(req, res, repoInspectionResponse, `${endpointName}.repo_inspection.response`);
    }

    let trinityPrompt = prompt;

    const queuedAskJobInput = buildQueuedAskJobInput({
      prompt: trinityPrompt,
      sessionId,
      overrideAuditSafe,
      cognitiveDomain: finalDomain,
      ...buildTrinityOutputControlOptions(req.body),
      clientContext: req.body.clientContext ?? null,
      endpointName,
      auditFlag: bypassAuditFlag
    });

    // runThroughBrain now unconditionally routes through GPT-5.1 before final ARCANOS processing.
    //
    // NOTE: Legacy ask-style endpoints still perform cognitive domain detection (via
    // detectCognitiveDomain / gptFallbackClassifier earlier in this handler) and pass an explicit
    // `cognitiveDomain` hint into runThroughBrain when compat mode is enabled.
    //
    // Canonical GPT traffic should target /gpt/:gptId. Other endpoints that call runThroughBrain
    // (e.g. /siri, /write, /guide, /audit, /sim, and arcanosPrompt flows) do not perform this
    // detection and therefore rely on the default TRINITY_STAGE_TEMPERATURE configuration inside
    // runThroughBrain until they adopt equivalent routing hints.
    if (asyncRequested) {
      const workerId = process.env.WORKER_ID || 'api';
      const plannedJob = await planAutonomousWorkerJob('ask', queuedAskJobInput);
      const job = await createJob(workerId, 'ask', queuedAskJobInput, plannedJob);
      const waitedJob = await waitForQueuedAskJobCompletion(
        job.id,
        {
          waitForResultMs: resolveAsyncAskWaitForResultMs(requestedAsyncAskWaitMs),
          pollIntervalMs: resolveAsyncAskPollIntervalMs(undefined)
        }
      );

      //audit Assumption: most user-visible frustration comes from fast jobs still requiring a second poll hop; failure risk: clients perceive working queue jobs as hung because they only receive a job id; expected invariant: terminal jobs inside the bounded wait window return immediately; handling strategy: branch on the waited queue state before falling back to HTTP 202.
      if (waitedJob.state === 'completed') {
        const completedResponse = normalizeCompletedAsyncAskResponse(waitedJob.job.output);

        if (!completedResponse) {
          recordPromptDebugTrace(requestId, 'fallback', {
            ...buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt),
            selectedRoute: endpointName,
            selectedModule: 'queued-ask',
            selectedTools: ['queued-ask'],
            repoInspectionChosen: repoInspectionRequested,
            runtimeInspectionChosen: false,
            finalExecutorPayload: {
              executor: 'queued-ask',
              jobInput: queuedAskJobInput,
            },
            fallbackPathUsed: 'async-completed-invalid',
            fallbackReason: 'Async ask job completed without a structured output payload.',
          });
          failAiRouteTrace(req, routeTrace, new Error('Async ask job completed without a structured output payload.'), {
            activeModel: 'queued-ask',
            statusCode: 500,
            extra: { disposition: 'async-completed-invalid', jobId: job.id }
          });
          return sendInternalErrorPayload(res, {
            error: 'ASYNC_ASK_JOB_OUTPUT_INVALID',
            message: 'Async ask job completed without a structured output payload.',
            jobId: job.id,
            poll: `/jobs/${job.id}`
          });
        }

        recordPromptDebugTrace(requestId, 'response', {
          ...buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt),
          selectedRoute: endpointName,
          selectedModule: 'queued-ask',
          selectedTools: ['queued-ask'],
          repoInspectionChosen: repoInspectionRequested,
          runtimeInspectionChosen: false,
          finalExecutorPayload: {
            executor: 'queued-ask',
            jobInput: queuedAskJobInput,
          },
          responseReturned: completedResponse,
        });
        completeAiRouteTrace(req, routeTrace, {
          activeModel: completedResponse.activeModel,
          fallbackFlag: completedResponse.fallbackFlag,
          fallbackReason: null,
          extra: {
            disposition: 'async-completed',
            jobId: job.id
          }
        });
        return sendGuardedAskResponse(req, res, completedResponse, `${endpointName}.async_completed.response`);
      }

      if (waitedJob.state === 'failed') {
        recordPromptDebugTrace(requestId, 'fallback', {
          ...buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt),
          selectedRoute: endpointName,
          selectedModule: 'queued-ask',
          selectedTools: ['queued-ask'],
          repoInspectionChosen: repoInspectionRequested,
          runtimeInspectionChosen: false,
          finalExecutorPayload: {
            executor: 'queued-ask',
            jobInput: queuedAskJobInput,
          },
          fallbackPathUsed: 'async-job-failed',
          fallbackReason: waitedJob.job.error_message || 'Async ask job failed.',
        });
        failAiRouteTrace(req, routeTrace, new Error(waitedJob.job.error_message || 'Async ask job failed.'), {
          activeModel: 'queued-ask',
          statusCode: 500,
          extra: { disposition: 'async-failed', jobId: job.id }
        });
        return sendInternalErrorPayload(
          res,
          buildAsyncAskFailurePayload(job.id, waitedJob.job.error_message)
        );
      }

      if (waitedJob.state === 'missing') {
        recordPromptDebugTrace(requestId, 'fallback', {
          ...buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt),
          selectedRoute: endpointName,
          selectedModule: 'queued-ask',
          selectedTools: ['queued-ask'],
          repoInspectionChosen: repoInspectionRequested,
          runtimeInspectionChosen: false,
          finalExecutorPayload: {
            executor: 'queued-ask',
            jobInput: queuedAskJobInput,
          },
          fallbackPathUsed: 'async-job-missing',
          fallbackReason: 'Async ask job disappeared before completion.',
        });
        failAiRouteTrace(req, routeTrace, new Error('Async ask job disappeared before completion.'), {
          activeModel: 'queued-ask',
          statusCode: 500,
          extra: { disposition: 'async-missing', jobId: job.id }
        });
        return sendInternalErrorPayload(res, {
          error: 'ASYNC_ASK_JOB_MISSING',
          message: 'Async ask job disappeared before completion.',
          jobId: job.id,
          poll: `/jobs/${job.id}`
        });
      }

      completeAiRouteTrace(req, routeTrace, {
        activeModel: 'queued-ask',
        fallbackFlag: false,
        extra: {
          disposition: 'async-pending',
          jobId: job.id
        }
      });
      const pendingResponse = buildQueuedAskPendingResponse(job.id);
      recordPromptDebugTrace(requestId, 'response', {
        ...buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt),
        selectedRoute: endpointName,
        selectedModule: 'queued-ask',
        selectedTools: ['queued-ask'],
        repoInspectionChosen: repoInspectionRequested,
        runtimeInspectionChosen: false,
        finalExecutorPayload: {
          executor: 'queued-ask',
          jobInput: queuedAskJobInput,
        },
        responseReturned: pendingResponse,
      });
      return sendGuardedAskResponse(
        req,
        res,
        pendingResponse,
        `${endpointName}.async_pending.response`,
        202
      );
    }

    const runtimeBudget = createRuntimeBudget();
    const outputControlOptions = buildTrinityOutputControlOptions(req.body);
    recordPromptDebugTrace(requestId, 'routing', {
      ...buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt),
      selectedRoute: endpointName,
      selectedModule: 'trinity',
      selectedTools: [],
      repoInspectionChosen: repoInspectionRequested,
      runtimeInspectionChosen: false,
      intentTags: [
        `cognitive_domain:${finalDomain}`,
        ...(runtimeInspectionRequested ? ['runtime_inspection_requested'] : []),
      ],
    });
    recordPromptDebugTrace(requestId, 'executor', {
      ...buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt),
      selectedRoute: endpointName,
      selectedModule: 'trinity',
      selectedTools: [],
      repoInspectionChosen: repoInspectionRequested,
      runtimeInspectionChosen: false,
      finalExecutorPayload: {
        executor: 'runThroughBrain',
        prompt: trinityPrompt,
        sessionId: sessionId ?? null,
        overrideAuditSafe: overrideAuditSafe ?? null,
        options: {
          cognitiveDomain: finalDomain,
          sourceEndpoint: endpointName,
          ...outputControlOptions,
        },
      },
    });
    const output = await runThroughBrain(
      openai,
      trinityPrompt,
      sessionId,
      overrideAuditSafe,
      {
        cognitiveDomain: finalDomain,
        sourceEndpoint: endpointName,
        ...outputControlOptions
      },
      runtimeBudget
    );
    const completedOutput = buildCompletedQueuedAskOutput(output, queuedAskJobInput);
    recordPromptDebugTrace(requestId, 'response', {
      ...buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt),
      selectedRoute: endpointName,
      selectedModule: 'trinity',
      selectedTools: [],
      repoInspectionChosen: repoInspectionRequested,
      runtimeInspectionChosen: false,
      responseReturned: completedOutput,
      fallbackPathUsed: output.fallbackFlag ? 'trinity-fallback' : null,
      fallbackReason: output.fallbackSummary?.fallbackReasons?.join('; ') ?? null,
    });
    completeAiRouteTrace(req, routeTrace, {
      activeModel: output.activeModel,
      fallbackFlag: output.fallbackFlag,
      fallbackReason: output.fallbackSummary?.fallbackReasons?.join('; ') ?? null,
      extra: {
        disposition: 'trinity',
        reasoningModel: output.gpt5Model,
        gpt5Used: output.gpt5Used,
        routingStages: output.routingStages,
        aiUsage: summarizeAiExecutionContext()
      }
    });
    return sendGuardedAskResponse(
      req,
      res,
      completedOutput,
      `${endpointName}.trinity.response`
    );
  } catch (err) {
    recordPromptDebugTrace(requestId, 'fallback', {
      ...buildPromptDebugContext(req, endpointName, rawPrompt, normalizedPrompt),
      selectedRoute: endpointName,
      selectedModule: 'trinity',
      selectedTools: [],
      repoInspectionChosen: repoInspectionRequested,
      runtimeInspectionChosen: false,
      fallbackPathUsed: 'error-handler',
      fallbackReason: err instanceof Error ? err.message : String(err),
    });
    failAiRouteTrace(req, routeTrace, err, {
      activeModel: getGPT5Model(),
      statusCode: 500,
      extra: {
        aiUsage: summarizeAiExecutionContext()
      }
    });
    handleAIError(err, prompt, endpointName, res);
  }
};

function rejectGptRoutedAskRequests(req: Request, res: Response, next: () => void): void {
  const source = req.method === 'GET' ? req.query : req.body;
  const rawGptId = typeof source?.gptId === 'string' ? source.gptId.trim() : '';
  if (!rawGptId) {
    next();
    return;
  }

  req.logger?.warn?.('ask.gpt_misroute', {
    endpoint: req.originalUrl,
    gptId: rawGptId,
    canonicalRoute: `/gpt/${encodeURIComponent(rawGptId)}`
  });
  sendGuardedAskResponse(req, res, {
    error: 'GPT-routed requests must target /gpt/:gptId',
    deprecated: true,
    canonicalRoute: `/gpt/${encodeURIComponent(rawGptId)}`,
    details: [`Received gptId '${rawGptId}' on ${req.originalUrl}; use /gpt/${rawGptId} instead.`]
  }, 'ask.misroute.response', 400);
}

function rejectRemovedAskRoute(req: Request, res: Response, next: () => void): void {
  if (resolveAskRouteMode() !== 'gone') {
    next();
    return;
  }

  const hintedGptId = extractAskRouteGptHint(req);
  const responseCanonicalRoute = res.getHeader('x-canonical-route');
  const canonicalRoute = typeof responseCanonicalRoute === 'string'
    ? responseCanonicalRoute
    : hintedGptId
      ? `/gpt/${encodeURIComponent(hintedGptId)}`
      : '/gpt/{gptId}';

  req.logger?.warn?.('ask.deprecated_route_blocked', {
    endpoint: req.originalUrl,
    method: req.method,
    canonicalRoute,
    gptIdHint: hintedGptId,
    requestId: req.requestId ?? null,
    routeMode: 'gone',
    sunsetAt: ASK_ROUTE_SUNSET_HEADER
  });

  res.setHeader(ASK_ROUTE_MODE_HEADER, 'gone');
  sendGuardedAskResponse(req, res, {
    error: 'Legacy ask-style route has been removed; use /gpt/:gptId',
    deprecated: true,
    canonicalRoute,
    sunsetAt: ASK_ROUTE_SUNSET_HEADER,
    details: [
      `${req.method} ${req.originalUrl} is no longer available. Migrate callers to POST ${canonicalRoute}.`
    ]
  }, 'ask.removed.response', 410);
}

// Brain endpoint (alias for ask) still requires explicit confirmation.
//audit Assumption: explicit confirmation gate is sufficient for sensitive brain actions in unsigned mode; failure risk: anonymous challenge attempts; expected invariant: confirmGate enforces confirmation token flow; handling strategy: keep confirmGate in front of handler.
router.post('/brain', askRateLimit, attachAskDeprecationMetadata, rejectRemovedAskRoute, rejectGptRoutedAskRequests, askValidationMiddleware, confirmGate, asyncHandler((req, res) => handleAIRequest(req, res, 'brain')));
router.get('/brain', askRateLimit, attachAskDeprecationMetadata, rejectRemovedAskRoute, rejectGptRoutedAskRequests, askValidationMiddleware, confirmGate, asyncHandler((req, res) => handleAIRequest(req, res, 'brain')));

export default router;

export type { AskRequest, AskResponse };
export { askValidationMiddleware };

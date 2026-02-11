import express, { Request, Response } from 'express';
import { z } from 'zod';
import { runThroughBrain } from '../logic/trinity.js';
import { validateAIRequest, handleAIError, logRequestFeedback } from '../utils/requestHandler.js';
import { confirmGate } from '../middleware/confirmGate.js';
import { createRateLimitMiddleware, securityHeaders } from '../utils/security.js';
import { aiRequestSchema, type AIRequestDTO } from '../types/dto.js';
import type {
  ConfirmationRequiredResponseDTO,
  ErrorResponseDTO
} from '../types/dto.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { askValidationMiddleware } from './ask/validation.js';
import type {
  AskRequest,
  AskResponse,
  SchemaValidationBypassAuditFlag,
  SystemReviewResponse,
  SystemStateResponse
} from './ask/types.js';
import { tryDispatchDaemonTools } from './ask/daemonTools.js';
import { getOpenAIClientOrAdapter } from '../services/openai/clientBridge.js';
import { getGPT5Model, hasValidAPIKey } from '../services/openai.js';
import {
  getActiveIntentSnapshot,
  getLastRoutingUsed,
  recordChatIntent,
  setLastRoutingUsed,
  type IntentConflict,
  updateIntentWithOptimisticLock
} from './ask/intent_store.js';
import { detectCognitiveDomain } from '../dispatcher/detectCognitiveDomain.js';
import { gptFallbackClassifier } from '../dispatcher/gptDomainClassifier.js';

const router = express.Router();

// Apply security middleware
router.use(securityHeaders);
router.use(createRateLimitMiddleware(60, 15 * 60 * 1000)); // 60 requests per 15 minutes

type AskRouteResponse =
  | AskResponse
  | ErrorResponseDTO
  | ConfirmationRequiredResponseDTO
  | SystemReviewResponse
  | SystemStateResponse
  | IntentConflict;

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

function getMode(body: AskRequest): 'chat' | 'system_review' | 'system_state' {
  if (body.mode === 'system_review') {
    return 'system_review';
  }
  if (body.mode === 'system_state') {
    return 'system_state';
  }
  return 'chat';
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
 * Shared handler for both ask and brain endpoints
 * Handles AI request processing with standardized error handling and validation
 */
export const handleAIRequest = async (
  req: Request<{}, any, AskRequest>,
  res: Response<any>,
  endpointName: string
) => {
  const mode = getMode(req.body);

  function hasAuthHeader(): boolean {
    const auth = req.get('authorization') || req.get('x-api-key');
    if (typeof auth !== 'string') return false;
    const trimmed = auth.trim();
    // Accept either `Bearer <token>` or a reasonably long API key
    if (/^Bearer\s+\S+/i.test(trimmed)) return true;
    if (/^[A-Za-z0-9\-_.~+/]+=*$/.test(trimmed) && trimmed.length >= 16) return true;
    return false;
  }

  function canBypassSystemAuth(): boolean {
    //audit Assumption: tests should exercise system modes without secrets; risk: accidental auth bypass; invariant: bypass only when explicitly allowed in test env; handling: require explicit env allow flag.
    return process.env.NODE_ENV === 'test' && process.env.ENABLE_TEST_SYSTEM_MODE_BYPASS === '1';
  }

  if (mode === 'system_state') {
    const stateRequest = systemStateUpdateSchema.safeParse(req.body);
    //audit Assumption: system mode requests are strictly validated; failure risk: ambiguous mode behavior; expected invariant: strict contract before execution; handling strategy: hard fail on validation errors.
    if (!stateRequest.success) {
      return res.status(400).json({
        error: 'SYSTEM_STATE_REQUEST_INVALID',
        details: stateRequest.error.issues.map(issue => issue.message)
      });
    }

    // Require an authorization header for state mutation/read operations
    //audit Assumption: system_state should be protected outside tests; risk: unauthorized access; invariant: auth required unless test env; handling: explicit bypass check.
    if (!hasAuthHeader() && !canBypassSystemAuth()) {
      return res.status(401).json({ error: 'UNAUTHORIZED', details: ['Authorization required for system_state operations'] });
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
        return res.status(409).json(conflict);
      }
    }

    //audit Assumption: SYSTEM_STATE_PROMPT exists as governance artifact only; failure risk: accidental model usage; expected invariant: mode serves backend facts directly; handling strategy: never call model here.
    void SYSTEM_STATE_PROMPT;

    const stateResponse = buildSystemStateResponse(typeof req.body.sessionId === 'string' ? req.body.sessionId : undefined);
    const strictState = systemStateSchema.safeParse(stateResponse);
    //audit Assumption: system_state responses must be schema-valid before send; failure risk: CLI drift on malformed payload; expected invariant: strict response contract; handling strategy: hard fail invalid payloads.
    if (!strictState.success) {
      return res.status(500).json({
        error: 'SYSTEM_STATE_RESPONSE_INVALID',
        details: strictState.error.issues.map(issue => issue.message)
      });
    }

    return res.json(strictState.data);
  }

  if (mode === 'system_review') {
    // Require caller authentication before initiating expensive model calls
    //audit Assumption: system_review should be protected outside tests; risk: unauthorized access; invariant: auth required unless test env; handling: explicit bypass check.
    if (!hasAuthHeader() && !canBypassSystemAuth()) {
      return res.status(401).json({ error: 'UNAUTHORIZED', details: ['Authorization required for system_review mode'] });
    }

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
      const modelResponse = await client.chat.completions.create({
        model: getGPT5Model(),
        messages: [
          { role: 'system', content: SYSTEM_REVIEW_PROMPT },
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

      const rawContent = modelResponse.choices?.[0]?.message?.content;
      //audit Assumption: strict review requires textual JSON payload; failure risk: empty model content; expected invariant: parseable JSON string; handling strategy: hard fail missing content.
      if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
        return res.status(500).json({
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
        return res.status(500).json({
          error: 'SYSTEM_REVIEW_RESPONSE_INVALID',
          details: strictReview.error.issues.map(issue => issue.message)
        });
      }

      return res.json(strictReview.data);
    } catch (error) {
      return res.status(500).json({
        error: 'SYSTEM_REVIEW_EXECUTION_FAILED',
        details: [error instanceof Error ? error.message : String(error)]
      });
    }
  }

  const lenientChatValidation = validateLenientChatRequest(req.body);
  if (!lenientChatValidation.ok) {
    return res.status(400).json(lenientChatValidation.errorPayload);
  }

  req.body = lenientChatValidation.normalizedBody;
  const bypassAuditFlag = lenientChatValidation.auditFlag;

  const { sessionId, overrideAuditSafe, metadata } = req.body;
  const normalizedPrompt = req.body.prompt || extractTextInput(req.body) || '';

  //audit Assumption: intent tracking should happen for valid chat requests even when mock responses are used; risk: stale system_state intent; invariant: intent recorded for leniently validated chat inputs; handling: record before API key checks.
  const activeIntent = recordChatIntent(normalizedPrompt, sessionId);
  setLastRoutingUsed('backend', sessionId);

  // Domain Detection
  const detection = detectCognitiveDomain(normalizedPrompt);
  let finalDomain = detection.domain;
  let finalConfidence = detection.confidence;

  // Use shared validation logic
  const validation = validateAIRequest(req, res, endpointName);
  if (!validation) return; // Response already sent

  const { client: openai, input: prompt } = validation;

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
  const domainUpdate = updateIntentWithOptimisticLock(
    activeIntent.version,
    {
      cognitiveDomain: finalDomain,
      domainConfidence: finalConfidence
    },
    sessionId
  );
  if (!domainUpdate.ok) {
    console.warn(`[⚠️ DOMAIN] Intent version conflict during domain update (expected=${activeIntent.version}, current=${domainUpdate.conflict.currentVersion})`);
  }

  console.log(`[📨 ${endpointName.toUpperCase()}] Processing with sessionId: ${sessionId || 'none'}, auditOverride: ${overrideAuditSafe || 'none'}, domain: ${finalDomain} (${finalConfidence})`);

  // Log request for feedback loop
  logRequestFeedback(prompt, endpointName);

  try {
    const daemonToolResponse = await tryDispatchDaemonTools(openai, prompt, metadata);
    if (daemonToolResponse) {
      if ('confirmation_required' in daemonToolResponse) {
        //audit Assumption: confirmation required should block response; risk: sensitive execution; invariant: 403 returned; handling: return challenge.
        return res.status(403).json({
          code: 'CONFIRMATION_REQUIRED',
          confirmationChallenge: { id: daemonToolResponse.confirmation_token },
          pending_actions: daemonToolResponse.pending_actions
        });
      }
      //audit Assumption: daemon tool response is terminal; risk: skipping trinity; invariant: tool actions queued; handling: return early.
      return res.json({
        ...daemonToolResponse,
        clientContext: req.body.clientContext,
        ...(bypassAuditFlag ? { auditFlag: bypassAuditFlag } : {})
      });
    }

    // runThroughBrain now unconditionally routes through GPT-5.1 before final ARCANOS processing.
    //
    // NOTE: This /ask route (and its /brain alias) is currently the only entrypoint that performs
    // cognitive domain detection (via detectCognitiveDomain / gptFallbackClassifier earlier in
    // this handler) and passes an explicit `cognitiveDomain` hint into runThroughBrain.
    //
    // Other endpoints that call runThroughBrain (e.g. /siri, /write, /guide, /audit, /sim, and
    // arcanosPrompt flows) do *not* perform this detection and therefore rely on the default
    // TRINITY_STAGE_TEMPERATURE configuration inside runThroughBrain. This asymmetry is
    // intentional for now: /ask is the primary, fully context-routed chat endpoint, while the
    // others use a simpler, fixed-temperature behavior unless/until they adopt similar routing.
    const output = await runThroughBrain(openai, prompt, sessionId, overrideAuditSafe, { cognitiveDomain: finalDomain });
    return res.json({
      ...(output as AskResponse),
      clientContext: req.body.clientContext,
      ...(bypassAuditFlag ? { auditFlag: bypassAuditFlag } : {})
    });
  } catch (err) {
    handleAIError(err, prompt, endpointName, res);
  }
};

// Primary ask endpoint routed through the Trinity brain (no confirmation required)
router.post('/ask', askValidationMiddleware, asyncHandler((req, res) => handleAIRequest(req, res, 'ask')));
router.get('/ask', askValidationMiddleware, asyncHandler((req, res) => handleAIRequest(req, res, 'ask')));

// Brain endpoint (alias for ask with same functionality) still requires confirmation
router.post('/brain', askValidationMiddleware, confirmGate, asyncHandler((req, res) => handleAIRequest(req, res, 'brain')));
router.get('/brain', askValidationMiddleware, confirmGate, asyncHandler((req, res) => handleAIRequest(req, res, 'brain')));

export default router;

export type { AskRequest, AskResponse };
export { askValidationMiddleware };

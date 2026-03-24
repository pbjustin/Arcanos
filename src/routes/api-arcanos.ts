import express, { Request, Response } from 'express';
import {
  createRateLimitMiddleware,
  getRequestActorKey
} from '@platform/runtime/security.js';
import { asyncHandler } from '@shared/http/index.js';
import type { IdleStateService } from '@services/idleStateService.js';
import apiArcanosVerificationRouter from './api-arcanos-verification.js';
import { routeGptRequest, type AskEnvelope } from './_core/gptDispatch.js';

const router = express.Router();

const DEPRECATED_ARCANOS_ENDPOINT = '/api/arcanos/ask';
const CANONICAL_ARCANOS_GPT_ID = 'arcanos-core';
const CANONICAL_ARCANOS_ROUTE = `/gpt/${CANONICAL_ARCANOS_GPT_ID}`;

const arcanosAskRateLimit = createRateLimitMiddleware({
  bucketName: 'api-arcanos-ask',
  maxRequests: 120,
  windowMs: 15 * 60 * 1000,
  keyGenerator: (req) => `${getRequestActorKey(req)}:route:ask`
});

router.use('/', apiArcanosVerificationRouter);

interface DeprecatedAskOptions {
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

interface DeprecatedAskBody {
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
  options?: DeprecatedAskOptions;
}

interface AskResponse {
  success: boolean;
  result?: unknown;
  error?: string;
  metadata?: {
    service?: string;
    version?: string;
    model?: string;
    timestamp?: string;
    arcanosRouting?: boolean;
    deprecatedEndpoint?: boolean;
    canonicalRoute?: string;
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
}

type SuccessfulAskEnvelope = Extract<AskEnvelope, { ok: true }>;
type FailedAskEnvelope = Extract<AskEnvelope, { ok: false }>;

/**
 * Purpose: Attach stable deprecation headers so legacy callers can discover the canonical route.
 * Inputs/Outputs: Mutates the outgoing response headers in place.
 * Edge cases: Safe to call repeatedly because the emitted values are deterministic.
 */
function applyDeprecatedEndpointHeaders(res: Response<AskResponse>): void {
  res.setHeader('X-Deprecated-Endpoint', DEPRECATED_ARCANOS_ENDPOINT);
  res.setHeader('X-Canonical-Route', CANONICAL_ARCANOS_ROUTE);
}

/**
 * Purpose: Extract the first usable text prompt from the deprecated ARCANOS payload.
 * Inputs/Outputs: Accepts the legacy request body and returns the first non-empty string prompt.
 * Edge cases: Returns null when every candidate field is empty or absent.
 */
function extractLegacyPrompt(body: DeprecatedAskBody): string | null {
  const candidateValues = [
    body.prompt,
    body.message,
    body.userInput,
    body.content,
    body.text,
    body.query
  ];

  for (const candidateValue of candidateValues) {
    //audit Assumption: only explicit non-empty strings are safe prompts for compatibility forwarding; failure risk: objects or blank text leaking into GPT dispatch; expected invariant: prompt remains textual; handling strategy: ignore non-string and blank values.
    if (typeof candidateValue === 'string' && candidateValue.trim().length > 0) {
      return candidateValue.trim();
    }
  }

  return null;
}

/**
 * Purpose: Canonicalize legacy ARCANOS request bodies for GPT-router dispatch.
 * Inputs/Outputs: Accepts the deprecated body and returns a `/gpt/:gptId` compatible payload.
 * Edge cases: Rewrites blank or legacy `ask` actions onto canonical `query`.
 */
function buildCanonicalAskBody(body: DeprecatedAskBody): Record<string, unknown> {
  const prompt = extractLegacyPrompt(body);
  const normalizedAction =
    typeof body.action === 'string' ? body.action.trim().toLowerCase() : '';

  //audit Assumption: deprecated clients either omit `action` or send `ask`; failure risk: legacy callers keep failing after migration; expected invariant: ARCANOS core dispatch receives canonical `query`; handling strategy: rewrite blank/legacy action names before GPT routing.
  const canonicalAction =
    normalizedAction.length === 0 || normalizedAction === 'ask'
      ? 'query'
      : body.action;

  return {
    ...body,
    ...(prompt ? { prompt } : {}),
    action: canonicalAction
  };
}

/**
 * Purpose: Safely treat module results as records before extracting compatibility metadata.
 * Inputs/Outputs: Accepts unknown module output and returns a plain-object record or null.
 * Edge cases: Rejects arrays to avoid index-based compatibility assumptions.
 */
function getModuleResultRecord(moduleResult: unknown): Record<string, unknown> | null {
  //audit Assumption: compatibility metadata reads are valid only on plain objects; failure risk: array-like payloads causing unsafe property access; expected invariant: metadata extraction reads object fields only; handling strategy: guard for non-array objects.
  if (moduleResult && typeof moduleResult === 'object' && !Array.isArray(moduleResult)) {
    return moduleResult as Record<string, unknown>;
  }

  return null;
}

/**
 * Purpose: Preserve the legacy route's top-level `result` semantics when wrapping GPT-router output.
 * Inputs/Outputs: Accepts canonical module output and returns the legacy-facing `result` payload.
 * Edge cases: Falls back to the original module result when no nested `result` field exists.
 */
function extractLegacyResultPayload(moduleResult: unknown): unknown {
  const moduleResultRecord = getModuleResultRecord(moduleResult);

  //audit Assumption: ARCANOS core responses often wrap the final text in `result`; failure risk: legacy clients needing a new parsing contract; expected invariant: compatibility response keeps the historical top-level `result`; handling strategy: unwrap nested `result` when present.
  if (moduleResultRecord && 'result' in moduleResultRecord) {
    return moduleResultRecord.result;
  }

  return moduleResult;
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
function sendCompatibilityStream(
  res: Response<AskResponse>,
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
 * Purpose: Convert a successful canonical GPT dispatch response into the deprecated route envelope.
 * Inputs/Outputs: Accepts the canonical GPT-router success envelope and returns the historical JSON shape.
 * Edge cases: Copies optional routing metadata only when present on the module result.
 */
function buildLegacySuccessResponse(envelope: SuccessfulAskEnvelope): AskResponse {
  const moduleResultRecord = getModuleResultRecord(envelope.result);
  const routingStages = Array.isArray(moduleResultRecord?.routingStages)
    ? moduleResultRecord.routingStages.filter(
        (routingStage): routingStage is string => typeof routingStage === 'string'
      )
    : undefined;
  const activeModel =
    typeof moduleResultRecord?.activeModel === 'string'
      ? moduleResultRecord.activeModel
      : undefined;
  const fallbackFlag =
    typeof moduleResultRecord?.fallbackFlag === 'boolean'
      ? moduleResultRecord.fallbackFlag
      : undefined;

  return {
    success: true,
    result: extractLegacyResultPayload(envelope.result),
    metadata: {
      service: 'ARCANOS API',
      version: '2.0.0',
      model: activeModel,
      timestamp: new Date().toISOString(),
      arcanosRouting: true,
      deprecatedEndpoint: true,
      canonicalRoute: CANONICAL_ARCANOS_ROUTE,
      route: envelope._route.route,
      gptId: envelope._route.gptId,
      matchMethod: String(envelope._route.matchMethod ?? 'unknown'),
      routingStages,
      fallbackFlag
    },
    module: envelope._route.module,
    activeModel,
    fallbackFlag,
    routingStages
  };
}

/**
 * Purpose: Translate canonical GPT-router failures into the deprecated route's HTTP/error shape.
 * Inputs/Outputs: Accepts the canonical error envelope and returns an HTTP status plus response body.
 * Edge cases: Maps validation issues to 400, unknown GPTs to 404, and module timeouts to 504.
 */
function buildLegacyErrorResponse(
  envelope: FailedAskEnvelope
): { statusCode: number; body: AskResponse } {
  let statusCode = 500;

  //audit Assumption: caller-fixable routing and validation failures should surface as 4xx, not generic backend errors; failure risk: clients misclassifying bad requests as service outages; expected invariant: canonical error classes preserve their retry semantics; handling strategy: map known validation and lookup failures explicitly.
  if (envelope.error.code === 'BAD_REQUEST' || envelope.error.code === 'NO_DEFAULT_ACTION') {
    statusCode = 400;
  } else if (envelope.error.code === 'UNKNOWN_GPT') {
    statusCode = 404;
  } else if (envelope.error.code === 'MODULE_TIMEOUT') {
    statusCode = 504;
  }

  return {
    statusCode,
    body: {
      success: false,
      error: envelope.error.message,
      metadata: {
        service: 'ARCANOS API',
        version: '2.0.0',
        timestamp: new Date().toISOString(),
        arcanosRouting: true,
        deprecatedEndpoint: true,
        canonicalRoute: CANONICAL_ARCANOS_ROUTE,
        route: envelope._route.route ?? 'core',
        gptId: CANONICAL_ARCANOS_GPT_ID,
        matchMethod: String(envelope._route.matchMethod ?? 'exact')
      }
    }
  };
}

/**
 * Purpose: Compatibility handler for deprecated `/api/arcanos/ask` traffic.
 * Inputs/Outputs: Accepts legacy request bodies and returns the historical route envelope.
 * Edge cases: Preserves `ping` health checks and rewrites deprecated traffic through `arcanos-core`.
 */
const handleArcanosAsk = asyncHandler(
  async (req: Request<{}, AskResponse, DeprecatedAskBody>, res: Response<AskResponse>) => {
    applyDeprecatedEndpointHeaders(res);

    req.logger?.warn?.('deprecated.endpoint.used', {
      deprecatedEndpoint: DEPRECATED_ARCANOS_ENDPOINT,
      canonicalRoute: CANONICAL_ARCANOS_ROUTE,
      requestId: req.requestId ?? null
    });

    const prompt = extractLegacyPrompt(req.body ?? {});

    //audit Assumption: existing health probes still rely on legacy `ping` semantics even on the deprecated path; failure risk: migration shim breaks operational checks; expected invariant: `ping` remains a cheap local response; handling strategy: preserve the direct `pong` shortcut.
    if (prompt?.toLowerCase() === 'ping') {
      const idleStateService = req.app.locals.idleStateService as IdleStateService | undefined;
      idleStateService?.noteUserPing({
        route: DEPRECATED_ARCANOS_ENDPOINT,
        source: 'api-arcanos-deprecated'
      });

      return res.json({
        success: true,
        result: 'pong',
        metadata: {
          service: 'ARCANOS API',
          version: '2.0.0',
          timestamp: new Date().toISOString(),
          arcanosRouting: true,
          deprecatedEndpoint: true,
          canonicalRoute: CANONICAL_ARCANOS_ROUTE
        }
      });
    }

    const envelope = await routeGptRequest({
      gptId: CANONICAL_ARCANOS_GPT_ID,
      body: buildCanonicalAskBody(req.body ?? {}),
      requestId: req.requestId,
      logger: req.logger,
      request: req
    });

    //audit Assumption: canonical GPT routing is the source of truth for deprecated traffic; failure risk: shim hides canonical validation failures; expected invariant: canonical success/error semantics survive the wrapper; handling strategy: map the canonical envelope explicitly before responding.
    if (!envelope.ok) {
      const legacyErrorResponse = buildLegacyErrorResponse(envelope);
      return res.status(legacyErrorResponse.statusCode).json(legacyErrorResponse.body);
    }

    const responsePayload = buildLegacySuccessResponse(envelope);
    if (req.body.options?.stream === true) {
      sendCompatibilityStream(res, responsePayload);
      return;
    }

    return res.json(responsePayload);
  }
);

router.post('/ask', arcanosAskRateLimit, handleArcanosAsk);

// Test plan:
// - Happy path: legacy `/api/arcanos/ask` rewrites to `arcanos-core` and returns the historical JSON envelope.
// - Edge case: prompt `ping` returns `pong` without invoking canonical GPT routing.
// - Failure modes: missing prompt returns a mapped 400; canonical dispatcher failures surface with preserved status semantics.

export default router;

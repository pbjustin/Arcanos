import express, { Request, Response } from 'express';
import { handleAIRequest, type AskRequest, type AskResponse } from './ask.js';
import { createRateLimitMiddleware, createValidationMiddleware, securityHeaders } from "@platform/runtime/security.js";
import { inferHttpMethodIntent } from "@transport/http/httpMethodIntent.js";
import { buildValidationErrorResponse } from "@core/lib/errors/index.js";
import type {
  ClientContextDTO,
  ConfirmationRequiredResponseDTO,
  ErrorResponseDTO
} from "@shared/types/dto.js";
import { asyncHandler } from "@transport/http/asyncHandler.js";
import getGptModuleMap from "@platform/runtime/gptRouterConfig.js";
import { dispatchModuleAction, getModuleMetadata } from './modules.js';

const router = express.Router();

router.use(securityHeaders);
router.use(createRateLimitMiddleware(120, 10 * 60 * 1000));

const actionSchema = {
  message: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  prompt: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  userInput: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  content: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  text: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  query: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  domain: { type: 'string' as const, required: false, maxLength: 120, sanitize: true },
  useRAG: { type: 'boolean' as const, required: false },
  useHRC: { type: 'boolean' as const, required: false },
  sessionId: { type: 'string' as const, required: false, maxLength: 100, sanitize: true },
  overrideAuditSafe: { type: 'string' as const, required: false, maxLength: 50, sanitize: true },
  metadata: { type: 'object' as const, required: false },
  dispatchReroute: { type: 'object' as const, required: false }
};

const apiAskValidation = createValidationMiddleware(actionSchema);

interface ChatGPTActionBody {
  message?: string;
  prompt?: string;
  userInput?: string;
  content?: string;
  text?: string;
  query?: string;
  domain?: string;
  useRAG?: boolean;
  useHRC?: boolean;
  sessionId?: string;
  overrideAuditSafe?: string;
  metadata?: Record<string, unknown>;
  dispatchReroute?: {
    originalRoute?: string;
    reason?: string;
    memoryVersion?: string;
  };
}

router.post(
  '/api/ask',
  apiAskValidation,
  asyncHandler(
    async (
      req: Request<{}, AskResponse | ErrorResponseDTO | ConfirmationRequiredResponseDTO, ChatGPTActionBody>,
      res: Response<any>
    ) => {
  const { domain, useRAG, useHRC, sessionId, overrideAuditSafe, metadata } = req.body;

  const sourceField =
    (req.body.message && 'message') ||
    (req.body.prompt && 'prompt') ||
    (req.body.userInput && 'userInput') ||
    (req.body.content && 'content') ||
    (req.body.text && 'text') ||
    (req.body.query && 'query');

  const basePrompt =
    req.body.message ||
    req.body.prompt ||
    req.body.userInput ||
    req.body.content ||
    req.body.text ||
    req.body.query;

  const dispatchRerouteInfo =
    req.dispatchRerouted && req.dispatchDecision === 'reroute' && req.body.dispatchReroute
      ? req.body.dispatchReroute
      : undefined;

  if (!basePrompt) {
    //audit Assumption: at least one text field is required; risk: rejecting new aliases; invariant: prompt content must exist; handling: return standardized validation error.
    return res
      .status(400)
      .json(
        buildValidationErrorResponse([
          'Request must include one of message, prompt, userInput, content, text, or query fields'
        ])
      );
  }

  // GPT module dispatch: if gptId is present, route to module instead of Trinity brain
  const gptId = (req.body as Record<string, unknown>).gptId;
  if (typeof gptId === 'string' && gptId.trim()) {
    try {
      const gptModuleMap = await getGptModuleMap();
      const normalizedId = gptId.trim().toLowerCase();
      const entry = gptModuleMap[gptId.trim()] || gptModuleMap[normalizedId];
      if (entry) {
        const result = await dispatchModuleAction(entry.module, 'generateBooking', { prompt: basePrompt });
        const meta = getModuleMetadata(entry.module);
        return res.json({
          result,
          module: entry.module,
          meta: {
            gptId: gptId.trim(),
            route: entry.route,
            matchMethod: 'exact',
            availableActions: meta?.actions ?? [],
            timestamp: new Date().toISOString()
          }
        });
      }
    } catch (err) {
      console.warn(`[GPT_DISPATCH] Module dispatch failed for gptId="${gptId}", falling back to Trinity`, err);
      // Fall through to normal Trinity brain processing
    }
  }

  const contextDirectives: string[] = [];

  if (domain) {
    contextDirectives.push(`Domain routing hint: ${domain}`);
  }
  if (typeof useRAG === 'boolean') {
    contextDirectives.push(`RAG requested: ${useRAG ? 'ENABLED' : 'DISABLED'}`);
  }
  if (typeof useHRC === 'boolean') {
    contextDirectives.push(`HRC requested: ${useHRC ? 'ENABLED' : 'DISABLED'}`);
  }
  let metadataKeys: string[] | undefined;
  if (metadata && Object.keys(metadata).length > 0) {
    metadataKeys = Object.keys(metadata).slice(0, 10);
    contextDirectives.push(`Metadata keys: ${metadataKeys.join(', ')}`);
  }

  //audit Assumption: rerouted requests should preserve conflict context; risk: hidden reroute semantics; invariant: reroute directive appended; handling: add dispatch context.
  if (dispatchRerouteInfo) {
    const reason =
      typeof dispatchRerouteInfo.reason === 'string' && dispatchRerouteInfo.reason
        ? dispatchRerouteInfo.reason.replace(/[\r\n]/g, ' ').trim()
        : 'unknown';
    const originalRoute =
      typeof dispatchRerouteInfo.originalRoute === 'string' && dispatchRerouteInfo.originalRoute
        ? dispatchRerouteInfo.originalRoute.replace(/[\r\n]/g, ' ').trim()
        : 'unknown';
    contextDirectives.push(`Dispatch reroute active: ${originalRoute} (${reason})`);
  }

  const httpMethodIntent = inferHttpMethodIntent(basePrompt) || undefined;

  if (httpMethodIntent) {
    contextDirectives.push(
      `HTTP intent detected: ${httpMethodIntent.method} (${httpMethodIntent.confidence} confidence${
        httpMethodIntent.signals.length ? ` via ${httpMethodIntent.signals.join(', ')}` : ''
      })`
    );
  }

  const normalizedPrompt = contextDirectives.length
    ? `${basePrompt}\n\n[ARCANOS CONTEXT]\n${contextDirectives.join('\n')}`
    : basePrompt;

  const clientContext: ClientContextDTO = {
    basePrompt,
    normalizedPrompt,
    routingDirectives: contextDirectives,
    flags: {
      domain,
      useRAG,
      useHRC,
      metadataKeys,
      sourceField,
      httpMethodIntent
    }
  };

  const normalizedRequest: AskRequest = {
    prompt: normalizedPrompt,
    sessionId,
    overrideAuditSafe,
    clientContext,
    metadata
  };

  const typedRequest = req as unknown as Request<{}, any, AskRequest>;
  typedRequest.body = normalizedRequest;

  return handleAIRequest(typedRequest, res, 'ask');
  }
  )
);

export default router;

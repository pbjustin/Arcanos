import express, { Request, Response } from 'express';
import { createRateLimitMiddleware, createValidationMiddleware, securityHeaders } from "@platform/runtime/security.js";
import { buildValidationErrorResponse } from "@core/lib/errors/index.js";
import type {
  AIResponseDTO,
  ConfirmationRequiredResponseDTO,
  ErrorResponseDTO,
  ClientContextDTO
} from "@shared/types/dto.js";
import { asyncHandler, sendInternalErrorPayload } from '@shared/http/index.js';
import { routeGptRequest } from "./_core/gptDispatch.js";
import { hasValidAPIKey } from '@services/openai.js';
import { createMockAIResponse } from '@transport/http/requestHandler.js';
import { extractPromptFromBody, normalizePromptWithContext } from '@shared/promptUtils.js';

const router = express.Router();

router.use(securityHeaders);
router.use('/api/ask', createRateLimitMiddleware(120, 10 * 60 * 1000));

const actionSchema = {
  message: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  prompt: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  userInput: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  content: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  text: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  query: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  messages: { type: 'array' as const, required: false },
  gptId: { type: 'string' as const, required: false, maxLength: 120, sanitize: true },
  action: { type: 'string' as const, required: false, maxLength: 120, sanitize: true },
  payload: { required: false },
  timeoutMs: { type: 'number' as const, required: false },
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
  messages?: Array<{ role?: string; content?: string }>;
  gptId?: string;
  action?: string;
  payload?: unknown;
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
  timeoutMs?: number;
}

interface ApiAskModuleDispatchResponse {
  result: unknown;
  module: string;
  meta: {
    gptId: string;
    route: string;
    matchMethod: string;
    availableActions: string[];
    timestamp: string;
    requestId?: string;
  };
}

type ApiAskResponse =
  | ErrorResponseDTO
  | ConfirmationRequiredResponseDTO
  | AIResponseDTO
  | ApiAskModuleDispatchResponse;

function buildLegacyClientContext(
  body: ChatGPTActionBody,
  basePrompt: string,
  sourceField: string
): ClientContextDTO {
  const routingDirectives: string[] = [];

  if (typeof body.domain === 'string' && body.domain.trim().length > 0) {
    routingDirectives.push(`Domain routing hint: ${body.domain.trim()}`);
  }

  if (body.useRAG === true) {
    routingDirectives.push('RAG hint: enabled');
  }

  if (body.useHRC === true) {
    routingDirectives.push('HRC hint: enabled');
  }

  const normalizedPrompt = normalizePromptWithContext(basePrompt, routingDirectives);
  const metadataKeys = body.metadata ? Object.keys(body.metadata) : undefined;

  return {
    basePrompt,
    normalizedPrompt,
    routingDirectives,
    flags: {
      domain: body.domain,
      useRAG: body.useRAG,
      useHRC: body.useHRC,
      metadataKeys,
      sourceField
    }
  };
}

router.post(
  '/api/ask',
  apiAskValidation,
  asyncHandler(
    async (
      req: Request<{}, ApiAskResponse, ChatGPTActionBody>,
      res: Response<ApiAskResponse>
    ) => {
      req.logger?.debug('ask.received', {
        bodyKeys: Object.keys((req.body ?? {}) as Record<string, unknown>),
        gptId: req.body?.gptId
      });

      const gptId = (req.body?.gptId ?? '').trim();
      if (!gptId) {
        const { prompt, sourceField } = extractPromptFromBody((req.body ?? {}) as Record<string, unknown>);

        if (!prompt || !sourceField) {
          return res.status(400).json(
            buildValidationErrorResponse(["Request must include one of message/prompt/userInput/content/text/query fields"]) as any
          );
        }

        // Compatibility path: legacy ChatGPT action payloads without gptId are allowed in mock mode.
        if (!hasValidAPIKey()) {
          const clientContext = buildLegacyClientContext(req.body, prompt, sourceField);
          const payload = createMockAIResponse(clientContext.normalizedPrompt || prompt, 'ask', {
            clientContext
          });
          return res.json(payload as any);
        }

        return res.status(400).json(buildValidationErrorResponse(["Field 'gptId' is required"]) as any);
      }

      const envelope = await routeGptRequest({
        gptId,
        body: req.body,
        requestId: (req as any).requestId,
        logger: (req as any).logger,
      });

      if (!envelope.ok) {
        if (envelope.error.code === 'BAD_REQUEST') {
          return res.status(400).json(buildValidationErrorResponse([envelope.error.message]) as any);
        }
        if (envelope.error.code === 'UNKNOWN_GPT') {
          return res.status(401).json({
            error: 'Unauthorized GPT identity',
            details: [envelope.error.message]
          } as any);
        }
        // MODULE_ERROR / other
        return sendInternalErrorPayload(res, {
          error: envelope.error.message,
          details: envelope.error.details ? [String(envelope.error.details)] : undefined
        } as any);
      }

      return res.json({
        result: envelope.result,
        module: envelope._route.module ?? 'unknown',
        meta: {
          gptId: envelope._route.gptId,
          route: envelope._route.route ?? 'unknown',
          matchMethod: String(envelope._route.matchMethod ?? 'unknown'),
          availableActions: envelope._route.availableActions ?? [],
          timestamp: envelope._route.timestamp,
          requestId: envelope._route.requestId,
        }
      });
    }
  )
);

export default router;

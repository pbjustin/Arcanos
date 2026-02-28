import express, { Request, Response } from 'express';
import { createRateLimitMiddleware, createValidationMiddleware, securityHeaders } from "@platform/runtime/security.js";
import { requireAiEndpointAuth } from "@transport/http/middleware/aiEndpointAuth.js";
import { buildValidationErrorResponse } from "@core/lib/errors/index.js";
import type {
  ConfirmationRequiredResponseDTO,
  ErrorResponseDTO
} from "@shared/types/dto.js";
import { asyncHandler } from "@transport/http/asyncHandler.js";
import getGptModuleMap from "@platform/runtime/gptRouterConfig.js";
import { dispatchModuleAction, getModuleMetadata } from './modules.js';

const router = express.Router();

router.use(securityHeaders);
router.use(createRateLimitMiddleware(120, 10 * 60 * 1000));
router.use(requireAiEndpointAuth);

const actionSchema = {
  message: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  prompt: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  userInput: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  content: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  text: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  query: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  gptId: { type: 'string' as const, required: true, maxLength: 120, sanitize: true },
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
  gptId?: string;
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

interface ApiAskModuleDispatchResponse {
  result: unknown;
  module: string;
  meta: {
    gptId: string;
    route: string;
    matchMethod: 'exact' | 'normalized';
    availableActions: string[];
    timestamp: string;
  };
}

type ApiAskResponse =
  | ErrorResponseDTO
  | ConfirmationRequiredResponseDTO
  | ApiAskModuleDispatchResponse;

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

      const { domain, metadata, gptId } = req.body;
      const basePrompt =
        req.body.message ||
        req.body.prompt ||
        req.body.userInput ||
        req.body.content ||
        req.body.text ||
        req.body.query;

      //audit Assumption: /api/ask requires textual prompt input for deterministic module dispatch; failure risk: empty payload reaching module action; expected invariant: one prompt field is present; handling strategy: return standardized 400 validation error.
      if (!basePrompt) {
        return res
          .status(400)
          .json(
            buildValidationErrorResponse([
              'Request must include one of message, prompt, userInput, content, text, or query fields'
            ])
          );
      }

      //audit Assumption: gptId identity must come from request body only; failure risk: spec drift and ambiguous identity source; expected invariant: non-empty body gptId; handling strategy: reject missing/blank ids with 400.
      if (typeof gptId !== 'string' || gptId.trim().length === 0) {
        return res.status(400).json(buildValidationErrorResponse(['Field \'gptId\' is required']));
      }

      const trimmedGptId = gptId.trim();
      const gptModuleMap = await getGptModuleMap();
      const normalizedId = trimmedGptId.toLowerCase();
      const exactEntry = gptModuleMap[trimmedGptId];
      const normalizedEntry = gptModuleMap[normalizedId];
      const entry = exactEntry || normalizedEntry;

      req.logger?.info('ask.gpt.lookup', {
        gptId: trimmedGptId,
        match: Boolean(entry),
        module: entry?.module
      });

      //audit Assumption: unknown GPT identities must fail closed; failure risk: silent fallback and wrong module execution; expected invariant: only allowlisted gptId values dispatch; handling strategy: return 401 when no registry match exists.
      if (!entry) {
        return res.status(401).json({
          error: 'Unauthorized GPT identity',
          details: [`gptId '${trimmedGptId}' is not registered`]
        });
      }

      const moduleMetadata = getModuleMetadata(entry.module);
      const availableActions = moduleMetadata?.actions ?? [];
      const action = availableActions.includes('query')
        ? 'query'
        : availableActions.length === 1
        ? availableActions[0]
        : undefined;

      //audit Assumption: module metadata either exposes a single callable action or an explicit 'query' default; failure risk: array-order fallback dispatches unintended logic; expected invariant: dispatch action is unambiguous; handling strategy: throw explicit error for global handler.
      if (!action) {
        const reason =
          availableActions.length > 1
            ? "Ambiguous actions and no default 'query' action found"
            : 'No actions available';
        throw new Error(`${reason} for module ${entry.module}`);
      }

      req.logger?.info('ask.dispatch.plan', {
        module: entry.module,
        action,
        availableActions
      });

      const payload = { prompt: basePrompt, domain, metadata };
      const result = await dispatchModuleAction(entry.module, action, payload);

      req.logger?.info('ask.dispatch.ok', {
        module: entry.module,
        action
      });

      return res.json({
        result,
        module: entry.module,
        meta: {
          gptId: trimmedGptId,
          route: entry.route,
          matchMethod: exactEntry ? 'exact' : 'normalized',
          availableActions,
          timestamp: new Date().toISOString()
        }
      });
    }
  )
);

export default router;

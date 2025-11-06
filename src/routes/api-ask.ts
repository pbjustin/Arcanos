import express, { Request, Response } from 'express';
import { handleAIRequest, type AskRequest, type AskResponse } from './ask.js';
import { createRateLimitMiddleware, createValidationMiddleware, securityHeaders } from '../utils/security.js';
import type { ErrorResponseDTO } from '../types/dto.js';

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
  metadata: { type: 'object' as const, required: false }
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
}

router.post('/api/ask', apiAskValidation, (req: Request<{}, AskResponse | ErrorResponseDTO, ChatGPTActionBody>, res: Response<AskResponse | ErrorResponseDTO>) => {
  const { domain, useRAG, useHRC, sessionId, overrideAuditSafe, metadata } = req.body;

  const basePrompt =
    req.body.message ||
    req.body.prompt ||
    req.body.userInput ||
    req.body.content ||
    req.body.text ||
    req.body.query;

  if (!basePrompt) {
    return res.status(400).json({
      error: 'Validation failed',
      details: ['Request must include one of message, prompt, userInput, content, text, or query fields']
    });
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
  if (metadata && Object.keys(metadata).length > 0) {
    const keys = Object.keys(metadata).slice(0, 10);
    contextDirectives.push(`Metadata keys: ${keys.join(', ')}`);
  }

  const normalizedPrompt = contextDirectives.length
    ? `${basePrompt}\n\n[ARCANOS CONTEXT]\n${contextDirectives.join('\n')}`
    : basePrompt;

  const normalizedRequest: AskRequest = {
    prompt: normalizedPrompt,
    sessionId,
    overrideAuditSafe
  };

  const typedRequest = req as unknown as Request<{}, AskResponse | ErrorResponseDTO, AskRequest>;
  typedRequest.body = normalizedRequest;

  return handleAIRequest(typedRequest, res, 'ask');
});

export default router;


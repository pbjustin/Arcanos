import express, { Request, Response } from 'express';
import { handleAIRequest, type AskRequest, type AskResponse } from './ask.js';
import { createRateLimitMiddleware, createValidationMiddleware, securityHeaders, sanitizeInput } from '../utils/security.js';
import { inferHttpMethodIntent } from '../utils/httpMethodIntent.js';
import { buildValidationErrorResponse } from '../utils/errorResponse.js';
import type { ClientContextDTO, ErrorResponseDTO } from '../types/dto.js';

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
  input: { type: 'string' as const, required: false, minLength: 1, maxLength: 6000, sanitize: true },
  messages: { type: 'array' as const, required: false },
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
  input?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  domain?: string;
  useRAG?: boolean;
  useHRC?: boolean;
  sessionId?: string;
  overrideAuditSafe?: string;
  metadata?: Record<string, unknown>;
}

function normalizeMessageContent(content: unknown): string | undefined {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (part && typeof part === 'object') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') {
          parts.push(text);
        }
      }
    }

    const joined = parts.join('\n').trim();
    return joined.length > 0 ? joined : undefined;
  }

  return undefined;
}

function extractPromptFromMessages(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  const normalized: Array<{ role: string; content: string }> = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue;
    }

    const normalizedContent = normalizeMessageContent((message as { content?: unknown }).content);
    if (!normalizedContent) {
      continue;
    }

    const rawRole = (message as { role?: unknown }).role;
    const role = typeof rawRole === 'string' ? rawRole : 'user';

    normalized.push({ role, content: normalizedContent });
  }

  if (normalized.length === 0) {
    return undefined;
  }

  for (let i = normalized.length - 1; i >= 0; i -= 1) {
    if (normalized[i].role === 'user') {
      return normalized[i].content;
    }
  }

  return normalized[normalized.length - 1].content;
}

router.post('/api/ask', apiAskValidation, (req: Request<{}, AskResponse | ErrorResponseDTO, ChatGPTActionBody>, res: Response<AskResponse | ErrorResponseDTO>) => {
  const { domain, useRAG, useHRC, sessionId, overrideAuditSafe, metadata } = req.body;
  const messagePrompt = extractPromptFromMessages(req.body.messages);
  const inputPrompt = typeof req.body.input === 'string' ? req.body.input : undefined;

  const sourceField =
    (req.body.message && 'message') ||
    (req.body.prompt && 'prompt') ||
    (req.body.userInput && 'userInput') ||
    (req.body.content && 'content') ||
    (req.body.text && 'text') ||
    (req.body.query && 'query') ||
    (inputPrompt && 'input') ||
    (messagePrompt && 'messages');

  const basePromptRaw =
    req.body.message ||
    req.body.prompt ||
    req.body.userInput ||
    req.body.content ||
    req.body.text ||
    req.body.query ||
    inputPrompt ||
    messagePrompt;

  const basePrompt = sourceField === 'messages' && typeof basePromptRaw === 'string'
    ? sanitizeInput(basePromptRaw)
    : basePromptRaw;

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
    clientContext
  };

  const typedRequest = req as unknown as Request<{}, AskResponse | ErrorResponseDTO, AskRequest>;
  typedRequest.body = normalizedRequest;

  return handleAIRequest(typedRequest, res, 'ask');
});

export default router;

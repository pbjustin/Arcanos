import { z } from 'zod';
import type {
  AskRequest,
  AskResponse,
  SchemaValidationBypassAuditFlag,
  SystemStateResponse
} from './types.js';

export function nowIso(): string {
  return new Date().toISOString();
}

export function getMode(body: AskRequest): 'chat' | 'system_review' | 'system_state' {
  if (body.mode === 'system_review') return 'system_review';
  if (body.mode === 'system_state') return 'system_state';
  return 'chat';
}

export function wantsAsync(body: AskRequest): boolean {
  const anyBody = body as unknown as Record<string, unknown>;
  return body.mode === 'async' || anyBody.async === true;
}

export function extractTextInput(body: AskRequest): string {
  const candidates = [body.prompt, body.message, body.userInput, body.content, body.text, body.query];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return '';
}

export function buildValidationBypassFlag(body: AskRequest): SchemaValidationBypassAuditFlag | null {
  const anyBody = body as unknown as Record<string, unknown>;
  if (anyBody.validationBypass === true) {
    return {
      auditFlag: 'SCHEMA_VALIDATION_BYPASS',
      reason: 'explicit_client_flag',
      timestamp: nowIso()
    };
  }
  return null;
}

export function parseJsonContent(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

export function buildSystemStateResponse(state: SystemStateResponse): AskResponse {
  return {
    result: JSON.stringify(state),
    module: 'system_state',
    endpoint: '/ask',
    meta: {
      id: `system_state_${Date.now()}`,
      created: Math.floor(Date.now() / 1000)
    }
  };
}

export function validateLenientChatRequest(payload: unknown): AskRequest {
  const schema = z
    .object({
      prompt: z.string().optional(),
      message: z.string().optional(),
      userInput: z.string().optional(),
      content: z.string().optional(),
      text: z.string().optional(),
      query: z.string().optional(),
      mode: z.string().optional(),
      async: z.boolean().optional(),
      validationBypass: z.boolean().optional()
    })
    .passthrough();

  const parsed = schema.parse(payload);
  return parsed as unknown as AskRequest;
}

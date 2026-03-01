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
  if (typeof body.input === 'string') return body.input;
  if (typeof (body as any).prompt === 'string') return (body as any).prompt;
  return '';
}

export function buildValidationBypassFlag(body: AskRequest): SchemaValidationBypassAuditFlag | null {
  const anyBody = body as unknown as Record<string, unknown>;
  if (anyBody.validationBypass === true) {
    return { bypassed: true, reason: 'explicit_client_flag' };
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

export function buildSystemStateResponse(details: SystemStateResponse['details']): AskResponse {
  return {
    ok: true,
    mode: 'system_state',
    timestamp: nowIso(),
    details
  } as AskResponse;
}

export function validateLenientChatRequest(payload: unknown): AskRequest {
  const schema = z.object({
    input: z.string().optional(),
    prompt: z.string().optional(),
    mode: z.string().optional(),
    async: z.boolean().optional(),
    validationBypass: z.boolean().optional()
  }).passthrough();

  const parsed = schema.parse(payload);
  return parsed as unknown as AskRequest;
}

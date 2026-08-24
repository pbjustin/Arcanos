import type { Request } from 'express';
import { normalizeGptRequestBody } from '@shared/gpt/gptIdempotency.js';
import {
  extractGptPromptText as extractDispatcherPromptText,
  extractLastUserMessageText,
} from '@shared/gpt/messageContentText.js';
import { extractDiagnosticTextInput } from '@shared/http/diagnosticRequest.js';
import { isRecord } from '@shared/typeGuards.js';
import { ARCANOS_SUPPRESS_TIMEOUT_FALLBACK_FLAG } from '@shared/gpt/gptDirectAction.js';
import {
  GPT_GET_RESULT_ACTION,
  GPT_GET_STATUS_ACTION,
  GPT_QUERY_ACTION,
  GPT_QUERY_AND_WAIT_ACTION
} from '@shared/gpt/gptJobResult.js';

const MAX_ACTION_ALIAS_DEPTH = 8;
const MAX_ACTION_ALIAS_VALUES = 64;
const DISPATCH_PROMPT_ALIAS_KEYS = [
  'message',
  'prompt',
  'userInput',
  'content',
  'text',
  'query',
  'messages',
] as const;
const FORWARDED_TOP_LEVEL_PAYLOAD_KEYS = [
  ...DISPATCH_PROMPT_ALIAS_KEYS,
  'sessionId',
  'mode',
  'game',
  'url',
  'urls',
  'guideUrl',
  'guideUrls',
  'audit',
  'enableAudit',
  'hrc',
  'enableHrc',
  'overrideAuditSafe',
  'answerMode',
  'maxWords',
  'max_words',
  '__arcanosExecutionMode',
  ARCANOS_SUPPRESS_TIMEOUT_FALLBACK_FLAG,
] as const;
const DISPATCH_PROMPT_ALIAS_KEY_SET = new Set<string>(DISPATCH_PROMPT_ALIAS_KEYS);

export interface GptDispatchPayloadProvenanceAdapter {
  markExplicitPayload(
    payload: Record<string, unknown>,
    explicitFields: readonly string[]
  ): void;
  markFlattenedPayload(payload: Record<string, unknown>): void;
}

function mergeForwardedTopLevelPayloadFields(
  body: Record<string, unknown>,
  explicitPayload: Record<string, unknown>
): Record<string, unknown> {
  const mergedPayload = { ...explicitPayload };
  const explicitPayloadHasPromptAlias = DISPATCH_PROMPT_ALIAS_KEYS.some(
    (key) => Object.prototype.hasOwnProperty.call(explicitPayload, key)
  );

  for (const key of FORWARDED_TOP_LEVEL_PAYLOAD_KEYS) {
    if (explicitPayloadHasPromptAlias && DISPATCH_PROMPT_ALIAS_KEY_SET.has(key)) {
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(mergedPayload, key)) {
      continue;
    }

    const forwardedValue = body[key];
    if (forwardedValue !== undefined) {
      mergedPayload[key] = forwardedValue;
    }
  }

  return mergedPayload;
}

/** Build the exact payload consumed by GPT module action adapters. */
export function buildGptDispatchPayload(
  body: unknown,
  promptOverride?: { promptText: string | null },
  provenanceAdapter?: GptDispatchPayloadProvenanceAdapter
): unknown {
  if (isRecord(body) && Object.prototype.hasOwnProperty.call(body, 'payload')) {
    const explicitPayload = body.payload;
    if (isRecord(explicitPayload)) {
      const sanitizedPayload = mergeForwardedTopLevelPayloadFields(body, explicitPayload);
      delete sanitizedPayload.gptId;
      if (provenanceAdapter) {
        if (
          !Object.prototype.hasOwnProperty.call(sanitizedPayload, 'universeId')
          && body.universeId !== undefined
        ) {
          sanitizedPayload.universeId = body.universeId;
        }
        provenanceAdapter.markExplicitPayload(sanitizedPayload, Object.keys(explicitPayload));
      }
      return sanitizedPayload;
    }
    return explicitPayload;
  }

  const prompt = promptOverride
    ? promptOverride.promptText
    : extractDispatcherPromptText(body);

  if (isRecord(body)) {
    const normalizedPayload = { ...body };
    delete normalizedPayload.gptId;
    if (prompt) {
      normalizedPayload.prompt = prompt;
    }
    provenanceAdapter?.markFlattenedPayload(normalizedPayload);
    return normalizedPayload;
  }

  if (typeof prompt === 'string' && prompt.length > 0) {
    return { prompt };
  }

  return body;
}

function readFirstNonEmptyString(value: unknown): string | null {
  const frames: Array<{ values: unknown[]; nextIndex: number; depth: number }> = [];
  let current = value;
  let depth = 0;
  let visited = 0;

  while (visited < MAX_ACTION_ALIAS_VALUES) {
    visited += 1;
    if (typeof current === 'string') {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    } else if (Array.isArray(current) && depth < MAX_ACTION_ALIAS_DEPTH && current.length > 0) {
      frames.push({ values: current, nextIndex: 1, depth });
      current = current[0];
      depth += 1;
      continue;
    }

    let advanced = false;
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame && frame.nextIndex < frame.values.length) {
        current = frame.values[frame.nextIndex];
        frame.nextIndex += 1;
        depth = frame.depth + 1;
        advanced = true;
        break;
      }
      frames.pop();
    }
    if (!advanced) {
      return null;
    }
  }

  return null;
}

export function normalizeRequestedGptActionName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const lowered = trimmed.toLowerCase();
  const decamelized = trimmed.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const compact = decamelized.replace(/[^a-z0-9]+/g, '');

  if (compact === 'invokegptroute' || compact === 'gptroute' || compact === 'invokegpt') {
    return null;
  }
  if (
    compact === 'queryandwait' ||
    compact === 'requestqueryandwait' ||
    compact === 'gptqueryandwait'
  ) {
    return GPT_QUERY_AND_WAIT_ACTION;
  }
  if (compact === 'query') {
    return GPT_QUERY_ACTION;
  }
  if (compact === 'getstatus') {
    return GPT_GET_STATUS_ACTION;
  }
  if (compact === 'getresult') {
    return GPT_GET_RESULT_ACTION;
  }
  if (compact === 'systemstate') {
    return 'system_state';
  }
  return lowered;
}

function readActionAlias(record: Record<string, unknown> | null | undefined): string | null {
  if (!record) {
    return null;
  }
  const actionValue =
    readFirstNonEmptyString(record.action) ??
    readFirstNonEmptyString(record.operation) ??
    readFirstNonEmptyString(record.operationId) ??
    readFirstNonEmptyString(record.operation_id) ??
    readFirstNonEmptyString(record.toolAction) ??
    readFirstNonEmptyString(record.tool_action) ??
    readFirstNonEmptyString(record.gptAction) ??
    readFirstNonEmptyString(record.gpt_action);

  return actionValue ? normalizeRequestedGptActionName(actionValue) : null;
}

function resolveRequestedActionFromBody(body: unknown): string | null {
  const normalizedBody = normalizeGptRequestBody(body);
  if (!normalizedBody) {
    return null;
  }

  const directAction = readActionAlias(normalizedBody);
  if (directAction) {
    return directAction.toLowerCase();
  }

  const payload = normalizedBody.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  return readActionAlias(payload as Record<string, unknown>);
}

export interface RequestedGptActionInput {
  body?: unknown;
  query?: Record<string, unknown>;
  gptActionHeader?: unknown;
  arcanosActionHeader?: unknown;
}

export function resolveRequestedGptAction(input: RequestedGptActionInput): string | null {
  const headerAction =
    readFirstNonEmptyString(input.gptActionHeader) ??
    readFirstNonEmptyString(input.arcanosActionHeader);

  return (
    resolveRequestedActionFromBody(input.body) ??
    readActionAlias(input.query) ??
    normalizeRequestedGptActionName(headerAction ?? '')
  );
}

export function extractGptPromptTextFromRecord(
  record: Record<string, unknown> | null
): string | null {
  const candidate =
    record?.message ??
    record?.prompt ??
    record?.userInput ??
    record?.content ??
    record?.text ??
    record?.query;

  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim();
  }

  return extractLastUserMessageText(record?.messages);
}

export function extractGptPromptText(body: unknown): string | null {
  const normalizedBody = normalizeGptRequestBody(body);
  const payload = normalizedBody?.payload;
  const payloadRecord = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;

  return extractGptPromptTextFromRecord(normalizedBody)
    ?? extractGptPromptTextFromRecord(payloadRecord);
}

/** Resolve text from the dispatcher's already-prepared payload with its body fallback. */
export function extractPreparedGptDispatchPromptText(
  body: unknown,
  dispatchPayload: unknown
): string | null {
  return extractDispatcherPromptText(dispatchPayload)
    ?? extractDiagnosticTextInput(isRecord(body) ? body : undefined);
}

/** Match HTTP dispatcher prompt precedence when an explicit payload is present. */
export function extractGptDispatchPromptText(body: unknown): string | null {
  const normalizedBody = normalizeGptRequestBody(body);
  if (!normalizedBody) {
    return null;
  }

  return extractPreparedGptDispatchPromptText(
    normalizedBody,
    buildGptDispatchPayload(normalizedBody)
  );
}

export function extractGptPromptTextFromRequest(req: Request): string | null {
  return (
    extractGptPromptText(req.body) ??
    extractGptPromptTextFromRecord(req.query as Record<string, unknown>)
  );
}

export function resolveRequestedGptActionFromRequest(req: Request): string | null {
  return resolveRequestedGptAction({
    body: req.body,
    query: req.query as Record<string, unknown>,
    gptActionHeader: typeof req.header === 'function' ? req.header('x-gpt-action') : undefined,
    arcanosActionHeader:
      typeof req.header === 'function' ? req.header('x-arcanos-action') : undefined,
  });
}

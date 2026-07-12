import type { Request } from 'express';
import { normalizeGptRequestBody } from '@shared/gpt/gptIdempotency.js';
import {
  GPT_GET_RESULT_ACTION,
  GPT_GET_STATUS_ACTION,
  GPT_QUERY_ACTION,
  GPT_QUERY_AND_WAIT_ACTION
} from '@shared/gpt/gptJobResult.js';

const MAX_ACTION_ALIAS_DEPTH = 8;
const MAX_ACTION_ALIAS_VALUES = 64;

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

function resolveRequestedAction(body: unknown): string | null {
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

export function resolveRequestedGptActionFromRequest(req: Request): string | null {
  const headerAction = typeof req.header === 'function'
    ? readFirstNonEmptyString(req.header('x-gpt-action')) ??
      readFirstNonEmptyString(req.header('x-arcanos-action'))
    : null;
  return (
    resolveRequestedAction(req.body) ??
    readActionAlias(req.query as Record<string, unknown> | undefined) ??
    normalizeRequestedGptActionName(headerAction ?? '')
  );
}

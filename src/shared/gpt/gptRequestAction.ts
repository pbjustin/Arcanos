import type { Request } from 'express';
import { normalizeGptRequestBody } from '@shared/gpt/gptIdempotency.js';
import {
  GPT_GET_RESULT_ACTION,
  GPT_GET_STATUS_ACTION,
  GPT_QUERY_ACTION,
  GPT_QUERY_AND_WAIT_ACTION
} from '@shared/gpt/gptJobResult.js';

function readFirstNonEmptyString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalizedEntry = readFirstNonEmptyString(entry);
      if (normalizedEntry) {
        return normalizedEntry;
      }
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

import type { RequestScopedLogger } from './types.js';
import type { PreparedClientJsonPayload } from './clientResponseCommon.js';
import {
  STRING_PREVIEW_MAX_BYTES,
  emitClientResponseTruncationWarning,
  isRecord,
  measureJsonBytes,
  readBoolean,
  readNumber,
  readString,
  readStringArray,
  resolveClientResponseMaxBytes,
  truncateText,
} from './clientResponseCommon.js';

function extractPreviewText(payload: Record<string, unknown>): string {
  const result = payload.result;

  if (typeof result === 'string' && result.trim().length > 0) {
    return result;
  }

  if (isRecord(result)) {
    const resultText = readString(result.result) ?? readString(result.message) ?? readString(result.text);
    if (resultText) {
      return resultText;
    }
  }

  return truncateText(JSON.stringify(payload), STRING_PREVIEW_MAX_BYTES);
}

function buildTruncatedPayloadFromPreview(
  payload: Record<string, unknown>,
  preview: string
): Record<string, unknown> {
  if (isRecord(payload.meta)) {
    return {
      result: preview,
      ...(readString(payload.module) ? { module: readString(payload.module) } : {}),
      meta: {
        ...(readString(payload.meta.gptId) ? { gptId: readString(payload.meta.gptId) } : {}),
        ...(readString(payload.meta.route) ? { route: readString(payload.meta.route) } : {}),
        ...(readString(payload.meta.timestamp) ? { timestamp: readString(payload.meta.timestamp) } : {}),
        truncated: true,
      },
    };
  }

  if (isRecord(payload._route)) {
    return {
      ...(typeof payload.ok === 'boolean' ? { ok: payload.ok } : {}),
      result: preview,
      _route: {
        ...(readString(payload._route.gptId) ? { gptId: readString(payload._route.gptId) } : {}),
        ...(readString(payload._route.module) ? { module: readString(payload._route.module) } : {}),
        ...(readString(payload._route.route) ? { route: readString(payload._route.route) } : {}),
        ...(readString(payload._route.timestamp) ? { timestamp: readString(payload._route.timestamp) } : {}),
        truncated: true,
      },
    };
  }

  const genericTruncatedPayload: Record<string, unknown> = {
    result: preview,
    truncated: true,
  };

  for (const [key, value] of Object.entries(payload)) {
    if (key === 'result' || key === 'output' || key === 'truncated') {
      continue;
    }

    if (value === null) {
      genericTruncatedPayload[key] = null;
      continue;
    }

    const booleanValue = readBoolean(value);
    if (booleanValue !== undefined) {
      genericTruncatedPayload[key] = booleanValue;
      continue;
    }

    const numberValue = readNumber(value);
    if (numberValue !== undefined) {
      genericTruncatedPayload[key] = numberValue;
      continue;
    }

    const stringValue = readString(value);
    if (stringValue !== undefined) {
      genericTruncatedPayload[key] = truncateText(stringValue, STRING_PREVIEW_MAX_BYTES);
      continue;
    }

    const stringArrayValue = readStringArray(value, 8);
    if (stringArrayValue !== undefined) {
      genericTruncatedPayload[key] = stringArrayValue;
      continue;
    }

    if (isRecord(value)) {
      const code = readString(value.code);
      const message = readString(value.message);
      if (code || message) {
        genericTruncatedPayload[key] = {
          ...(code ? { code } : {}),
          ...(message ? { message } : {}),
        };
      }
    }
  }

  return genericTruncatedPayload;
}

function buildMinimalTruncatedPayload(previewSource: string): Record<string, unknown> {
  return {
    result: truncateText(previewSource, 0),
    truncated: true,
  };
}

function buildTruncatedPayload(payload: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  const previewSource = extractPreviewText(payload);
  const maxPreviewBytes = Math.max(512, Math.floor(maxBytes * 0.45));
  let lowerPreviewBytes = 0;
  let upperPreviewBytes = maxPreviewBytes;
  const minimalPayload = buildMinimalTruncatedPayload(previewSource);
  let bestPayload = buildTruncatedPayloadFromPreview(payload, truncateText(previewSource, 0));

  if (measureJsonBytes(bestPayload) > maxBytes) {
    bestPayload = minimalPayload;
  }

  while (lowerPreviewBytes <= upperPreviewBytes) {
    const previewBytes = Math.floor((lowerPreviewBytes + upperPreviewBytes) / 2);
    const candidatePayload = buildTruncatedPayloadFromPreview(
      payload,
      truncateText(previewSource, previewBytes)
    );
    const candidateBytes = measureJsonBytes(candidatePayload);

    if (candidateBytes <= maxBytes) {
      bestPayload = candidatePayload;
      lowerPreviewBytes = previewBytes + 1;
    } else {
      upperPreviewBytes = previewBytes - 1;
    }
  }

  return measureJsonBytes(bestPayload) <= maxBytes ? bestPayload : minimalPayload;
}

export function prepareBoundedClientJsonPayload<T extends Record<string, unknown>>(
  payload: T,
  options: {
    logger?: RequestScopedLogger;
    logEvent?: string;
    maxBytes?: number;
  } = {}
): PreparedClientJsonPayload<T> {
  const maxResponseBytes = resolveClientResponseMaxBytes(options.maxBytes);
  const originalResponseBytes = measureJsonBytes(payload);
  let normalizedPayload: Record<string, unknown> = payload;
  let truncated = false;

  if (originalResponseBytes > maxResponseBytes) {
    normalizedPayload = buildTruncatedPayload(payload, maxResponseBytes);
    truncated = true;
  }

  const responseBytes = measureJsonBytes(normalizedPayload);

  options.logger?.info(options.logEvent ?? 'http.client_response', {
    originalResponseBytes,
    responseBytes,
    maxResponseBytes,
    truncated,
  });

  if (truncated) {
    emitClientResponseTruncationWarning(options.logger, options.logEvent ?? 'http.client_response', {
      originalResponseBytes,
      responseBytes,
      maxResponseBytes,
    });
  }

  return {
    payload: normalizedPayload as T,
    responseBytes,
    originalResponseBytes,
    truncated,
    maxResponseBytes,
  };
}

export function withJsonResponseBytes<T extends Record<string, unknown>, K extends string = 'response_bytes'>(
  payload: T,
  fieldName?: K
): T & Record<K, number> {
  const resolvedFieldName = (fieldName ?? 'response_bytes') as K;
  let responseBytes = 0;
  let nextPayload = {
    ...payload,
    [resolvedFieldName]: responseBytes,
  } as T & Record<K, number>;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const measuredResponseBytes = measureJsonBytes(nextPayload);
    if (measuredResponseBytes === responseBytes) {
      return nextPayload;
    }

    responseBytes = measuredResponseBytes;
    nextPayload = {
      ...payload,
      [resolvedFieldName]: responseBytes,
    } as T & Record<K, number>;
  }

  return nextPayload;
}

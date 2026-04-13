import type { RequestScopedLogger } from './types.js';

const DEFAULT_CLIENT_RESPONSE_MAX_BYTES = 32 * 1024;
const MIN_CLIENT_RESPONSE_MAX_BYTES = 2 * 1024;
const MAX_CLIENT_RESPONSE_MAX_BYTES = 256 * 1024;
export const STRING_PREVIEW_MAX_BYTES = 4 * 1024;
const TRUNCATION_MARKER = '\n...[truncated]';

export const INTERNAL_RESPONSE_KEYS = new Set([
  'auditSafe',
  'content',
  'debug',
  'debugInfo',
  'fallbackSummary',
  'log',
  'logs',
  'memoryContext',
  'outputControls',
  'pipelineDebug',
  'prompt',
  'prompts',
  'raw',
  'requestPayload',
  'responsePayload',
  'stack',
  'stackTrace',
  'structuredContent',
  'taskLineage',
]);

export interface PreparedClientJsonPayload<T extends Record<string, unknown>> {
  payload: T;
  responseBytes: number;
  originalResponseBytes: number;
  truncated: boolean;
  maxResponseBytes: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readStringArray(value: unknown, maxItems = 8): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .slice(0, maxItems);

  return normalized.length > 0 ? normalized : undefined;
}

export function measureJsonBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

export function truncateText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  const targetBytes = Math.max(0, maxBytes - markerBytes);
  let end = Math.min(text.length, targetBytes);

  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > targetBytes) {
    end -= 1;
  }

  return `${text.slice(0, end).trimEnd()}${TRUNCATION_MARKER}`;
}

export function resolveClientResponseMaxBytes(explicitMaxBytes?: number): number {
  const envValue = Number.parseInt(process.env.CLIENT_RESPONSE_MAX_BYTES ?? '', 10);
  const candidate = explicitMaxBytes ?? envValue;

  if (!Number.isFinite(candidate) || candidate <= 0) {
    return DEFAULT_CLIENT_RESPONSE_MAX_BYTES;
  }

  return Math.min(MAX_CLIENT_RESPONSE_MAX_BYTES, Math.max(MIN_CLIENT_RESPONSE_MAX_BYTES, candidate));
}

export function emitClientResponseTruncationWarning(
  logger: RequestScopedLogger | undefined,
  logEvent: string,
  details: {
    originalResponseBytes: number;
    responseBytes: number;
    maxResponseBytes: number;
  }
): void {
  if (!logger) {
    return;
  }

  logger.warn('http.client_response_truncated', {
    sourceEvent: logEvent,
    originalResponseBytes: details.originalResponseBytes,
    responseBytes: details.responseBytes,
    maxResponseBytes: details.maxResponseBytes,
    truncated: true,
    alert: true,
  });
}

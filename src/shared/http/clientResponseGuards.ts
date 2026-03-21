import type { RequestScopedLogger } from './types.js';

const DEFAULT_CLIENT_RESPONSE_MAX_BYTES = 32 * 1024;
const MIN_CLIENT_RESPONSE_MAX_BYTES = 2 * 1024;
const MAX_CLIENT_RESPONSE_MAX_BYTES = 256 * 1024;
const STRING_PREVIEW_MAX_BYTES = 4 * 1024;
const TRUNCATION_MARKER = '\n...[truncated]';

const INTERNAL_RESPONSE_KEYS = new Set([
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

interface PreparedClientJsonPayload<T extends Record<string, unknown>> {
  payload: T;
  responseBytes: number;
  originalResponseBytes: number;
  truncated: boolean;
  maxResponseBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readStringArray(value: unknown, maxItems = 8): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .slice(0, maxItems);

  return normalized.length > 0 ? normalized : undefined;
}

function measureJsonBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

function truncateText(text: string, maxBytes: number): string {
  if (measureJsonBytes(text) <= maxBytes) {
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

function resolveClientResponseMaxBytes(explicitMaxBytes?: number): number {
  const envValue = Number.parseInt(process.env.CLIENT_RESPONSE_MAX_BYTES ?? '', 10);
  const candidate = explicitMaxBytes ?? envValue;

  if (!Number.isFinite(candidate) || candidate <= 0) {
    return DEFAULT_CLIENT_RESPONSE_MAX_BYTES;
  }

  return Math.min(MAX_CLIENT_RESPONSE_MAX_BYTES, Math.max(MIN_CLIENT_RESPONSE_MAX_BYTES, candidate));
}

function emitClientResponseTruncationWarning(
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

function pickTrinitySummary(value: Record<string, unknown>): Record<string, unknown> | null {
  const result = readString(value.result);
  const moduleName = readString(value.module);

  if (!result || !moduleName) {
    return null;
  }

  return {
    result,
    module: moduleName,
    ...(readString(value.activeModel) ? { activeModel: readString(value.activeModel) } : {}),
    ...(readBoolean(value.fallbackFlag) !== undefined ? { fallbackFlag: readBoolean(value.fallbackFlag) } : {}),
    ...(readStringArray(value.routingStages) ? { routingStages: readStringArray(value.routingStages) } : {}),
    ...(readBoolean(value.gpt5Used) !== undefined ? { gpt5Used: readBoolean(value.gpt5Used) } : {}),
    ...(readString(value.gpt5Model) ? { gpt5Model: readString(value.gpt5Model) } : {}),
    ...(readBoolean(value.dryRun) !== undefined ? { dryRun: readBoolean(value.dryRun) } : {}),
    ...(readString(value.error) ? { error: readString(value.error) } : {}),
  };
}

function pickHealthSummary(value: Record<string, unknown>): Record<string, unknown> | null {
  const status = readString(value.status);
  const summary = readString(value.summary);

  if (!status && !summary) {
    return null;
  }

  return {
    ...(status ? { status } : {}),
    ...(summary ? { summary } : {}),
    ...(readString(value.timestamp) ? { timestamp: readString(value.timestamp) } : {}),
  };
}

function pickModulesSummary(value: Record<string, unknown>): Record<string, unknown> | null {
  const rawModules = Array.isArray(value.value)
    ? value.value
    : Array.isArray(value.modules)
      ? value.modules
      : null;

  if (!rawModules) {
    return null;
  }

  const modules = rawModules
    .filter(isRecord)
    .slice(0, 16)
    .map((entry) => {
      const definition = isRecord(entry.definition) ? entry.definition : null;
      return {
        ...(readString(entry.route) ? { route: readString(entry.route) } : {}),
        ...(definition && readString(definition.name) ? { name: readString(definition.name) } : {}),
        ...(definition && readString(definition.description)
          ? { description: truncateText(readString(definition.description) as string, 240) }
          : {}),
        ...(definition && readString(definition.defaultAction)
          ? { defaultAction: readString(definition.defaultAction) }
          : {}),
        ...(definition && readStringArray(definition.gptIds, 6)
          ? { gptIds: readStringArray(definition.gptIds, 6) }
          : {}),
      };
    });

  return {
    total: rawModules.length,
    modules,
  };
}

function extractMcpText(value: Record<string, unknown>): string | null {
  if (!Array.isArray(value.content)) {
    return null;
  }

  const parts = value.content
    .filter(isRecord)
    .map((item) => readString(item.text))
    .filter((item): item is string => typeof item === 'string');

  if (parts.length === 0) {
    return null;
  }

  return parts.join('\n').trim();
}

function pruneGenericValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return truncateText(value, STRING_PREVIEW_MAX_BYTES);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    if (depth >= 2) {
      return { total: value.length };
    }

    return value.slice(0, 8).map((item) => pruneGenericValue(item, depth + 1));
  }

  if (!isRecord(value)) {
    return undefined;
  }

  if (depth >= 3) {
    return undefined;
  }

  const output: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (INTERNAL_RESPONSE_KEYS.has(key)) {
      continue;
    }

    const normalized = pruneGenericValue(entryValue, depth + 1);
    if (normalized !== undefined) {
      output[key] = normalized;
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function shapeMcpToolOutput(toolName: string | undefined, rawResult: unknown): unknown {
  if (!isRecord(rawResult)) {
    return rawResult;
  }

  const structured = isRecord(rawResult.structuredContent) ? rawResult.structuredContent : null;

  if (structured) {
    const trinitySummary = pickTrinitySummary(structured);
    if (trinitySummary) {
      return trinitySummary;
    }

    const healthSummary = pickHealthSummary(structured);
    if (healthSummary) {
      return healthSummary;
    }

    if (toolName === 'modules.list') {
      const modulesSummary = pickModulesSummary(structured);
      if (modulesSummary) {
        return modulesSummary;
      }
    }

    const genericStructured = pruneGenericValue(structured);
    if (genericStructured !== undefined) {
      return genericStructured;
    }
  }

  const text = extractMcpText(rawResult);
  if (text) {
    return { text: truncateText(text, STRING_PREVIEW_MAX_BYTES) };
  }

  const genericRaw = pruneGenericValue(rawResult);
  return genericRaw ?? { ok: true };
}

function shapeMcpDispatchResult(value: Record<string, unknown>): Record<string, unknown> | null {
  if (value.handledBy !== 'mcp-dispatcher' || !isRecord(value.mcp)) {
    return null;
  }

  const mcpAction = readString(value.mcp.action) ?? 'invoke';
  const toolName = readString(value.mcp.toolName);

  return {
    handledBy: 'mcp-dispatcher',
    mcp: {
      action: mcpAction,
      ...(toolName ? { toolName } : {}),
      ...(readString(value.mcp.dispatchMode) ? { dispatchMode: readString(value.mcp.dispatchMode) } : {}),
      ...(readString(value.mcp.reason) ? { reason: readString(value.mcp.reason) } : {}),
      output: shapeMcpToolOutput(toolName, value.mcp.result),
    },
  };
}

function shapeRepoInspectionResult(value: Record<string, unknown>): Record<string, unknown> | null {
  if (value.handledBy !== 'repo-inspection' || !isRecord(value.repoInspection)) {
    return null;
  }

  return {
    handledBy: 'repo-inspection',
    repoInspection: {
      ...(readString(value.repoInspection.reason) ? { reason: readString(value.repoInspection.reason) } : {}),
      answer: readString(value.repoInspection.answer) ?? 'Repository inspection completed.',
    },
  };
}

function shapeMemoryDispatchResult(value: Record<string, unknown>): Record<string, unknown> | null {
  if (value.handledBy !== 'memory-dispatcher' || !isRecord(value.memory)) {
    return null;
  }

  const output = pruneGenericValue(value.memory);
  return {
    handledBy: 'memory-dispatcher',
    ...(output !== undefined ? { memory: output } : {}),
  };
}

function shapeDiagnosticResult(value: Record<string, unknown>): Record<string, unknown> | null {
  if (value.ok !== true || readString(value.route) !== 'diagnostic') {
    return null;
  }

  return {
    status: 'ok',
    route: 'diagnostic',
    message: readString(value.message) ?? 'backend operational',
  };
}

export function shapeClientRouteResult(result: unknown): unknown {
  if (typeof result === 'string') {
    return truncateText(result, STRING_PREVIEW_MAX_BYTES);
  }

  if (Array.isArray(result)) {
    return result.slice(0, 8).map((item) => shapeClientRouteResult(item));
  }

  if (!isRecord(result)) {
    return result;
  }

  const diagnostic = shapeDiagnosticResult(result);
  if (diagnostic) {
    return diagnostic;
  }

  const mcpDispatch = shapeMcpDispatchResult(result);
  if (mcpDispatch) {
    return mcpDispatch;
  }

  const repoInspection = shapeRepoInspectionResult(result);
  if (repoInspection) {
    return repoInspection;
  }

  const memoryDispatch = shapeMemoryDispatchResult(result);
  if (memoryDispatch) {
    return memoryDispatch;
  }

  const trinitySummary = pickTrinitySummary(result);
  if (trinitySummary) {
    return trinitySummary;
  }

  const generic = pruneGenericValue(result);
  return generic ?? { status: 'ok' };
}

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

function buildTruncatedPayload(payload: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  const previewBudget = Math.max(512, Math.floor(maxBytes * 0.45));
  const preview = truncateText(extractPreviewText(payload), previewBudget);

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

  return {
    result: preview,
    truncated: true,
  };
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
): T & Record<K | 'response_bytes', number> {
  const resolvedFieldName = (fieldName ?? 'response_bytes') as K | 'response_bytes';
  let responseBytes = 0;
  let nextPayload = {
    ...payload,
    [resolvedFieldName]: responseBytes,
  } as T & Record<K | 'response_bytes', number>;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const measuredResponseBytes = measureJsonBytes(nextPayload);
    if (measuredResponseBytes === responseBytes) {
      return nextPayload;
    }

    responseBytes = measuredResponseBytes;
    nextPayload = {
      ...payload,
      [resolvedFieldName]: responseBytes,
    } as T & Record<K | 'response_bytes', number>;
  }

  return nextPayload;
}

export { measureJsonBytes };

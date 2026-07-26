import { resolvePromptDebugTraceMode } from '@services/promptDebugTracePolicy.js';
import { redactString } from '@shared/redaction.js';

export interface AiRoutingDebugSnapshot {
  contentMode?: 'metadata' | 'full';
  requestId: string;
  timestamp: string;
  rawPrompt: string;
  normalizedPrompt: string;
  detectedIntent: 'RUNTIME_INSPECTION_REQUIRED' | 'DAG_EXECUTION_REQUIRED' | 'STANDARD';
  routingDecision: string;
  toolsAvailable: string[];
  toolsSelected: string[];
  cliUsed: boolean;
  runtimeEndpointsQueried: string[];
  repoFallbackUsed: boolean;
  constraintViolations: string[];
}

type AiRoutingDebugGlobal = typeof globalThis & {
  __ARCANOS_AI_ROUTING_DEBUG__?: {
    byRequestId: Map<string, AiRoutingDebugSnapshot>;
    latestRequestId: string | null;
    contentMode?: 'off' | 'metadata' | 'full';
  };
};

const GLOBAL_KEY = '__ARCANOS_AI_ROUTING_DEBUG__';
const MAX_RECORDS = 100;
const MAX_METADATA_VALUES = 64;
const MAX_METADATA_CHARS = 256;
const MAX_PROMPT_CHARS = 4096;
const METADATA_VALUE_PATTERN = /^[A-Za-z0-9_./:@{}-]+$/u;

function sanitizeMetadataValue(value: string): string | null {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_METADATA_CHARS ||
    !METADATA_VALUE_PATTERN.test(trimmed) ||
    redactString(trimmed) !== trimmed
  ) {
    return null;
  }

  return trimmed;
}

function sanitizeMetadataValues(values: readonly string[]): string[] {
  return Array.from(
    new Set(
      values
        .slice(0, MAX_METADATA_VALUES)
        .map(sanitizeMetadataValue)
        .filter((value): value is string => value !== null),
    ),
  );
}

function sanitizePrompt(value: string): string {
  const redacted = redactString(value);
  return redacted.length <= MAX_PROMPT_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_PROMPT_CHARS)}[truncated]`;
}

function sanitizeSnapshot(
  snapshot: AiRoutingDebugSnapshot,
  contentMode: 'metadata' | 'full',
): AiRoutingDebugSnapshot {
  const requestId =
    sanitizeMetadataValue(snapshot.requestId) ?? 'invalid-request-id';
  return {
    contentMode,
    requestId,
    timestamp:
      typeof snapshot.timestamp === 'string' &&
      snapshot.timestamp.length <= 40 &&
      Number.isFinite(Date.parse(snapshot.timestamp))
        ? snapshot.timestamp
        : new Date().toISOString(),
    rawPrompt: contentMode === 'full' ? sanitizePrompt(snapshot.rawPrompt) : '',
    normalizedPrompt:
      contentMode === 'full' ? sanitizePrompt(snapshot.normalizedPrompt) : '',
    detectedIntent: snapshot.detectedIntent,
    routingDecision:
      sanitizeMetadataValue(snapshot.routingDecision) ?? 'details_redacted',
    toolsAvailable: sanitizeMetadataValues(snapshot.toolsAvailable),
    toolsSelected: sanitizeMetadataValues(snapshot.toolsSelected),
    cliUsed: snapshot.cliUsed === true,
    runtimeEndpointsQueried: sanitizeMetadataValues(
      snapshot.runtimeEndpointsQueried,
    ),
    repoFallbackUsed: snapshot.repoFallbackUsed === true,
    constraintViolations: sanitizeMetadataValues(
      snapshot.constraintViolations,
    ),
  };
}

function getMutableState() {
  const runtime = globalThis as AiRoutingDebugGlobal;
  if (!runtime[GLOBAL_KEY]) {
    runtime[GLOBAL_KEY] = {
      byRequestId: new Map<string, AiRoutingDebugSnapshot>(),
      latestRequestId: null,
      contentMode: undefined,
    };
  }

  return runtime[GLOBAL_KEY]!;
}

function applyContentMode(): ReturnType<typeof getMutableState> {
  const state = getMutableState();
  const contentMode = resolvePromptDebugTraceMode();
  if (contentMode === state.contentMode) {
    return state;
  }

  if (contentMode === 'off') {
    state.byRequestId.clear();
    state.latestRequestId = null;
  } else if (contentMode === 'metadata') {
    const projected = new Map<string, AiRoutingDebugSnapshot>();
    for (const snapshot of state.byRequestId.values()) {
      const sanitized = sanitizeSnapshot(snapshot, 'metadata');
      projected.set(sanitized.requestId, sanitized);
    }
    state.byRequestId = projected;
    if (
      state.latestRequestId &&
      !state.byRequestId.has(state.latestRequestId)
    ) {
      state.latestRequestId = null;
    }
  }

  state.contentMode = contentMode;
  return state;
}

export function recordAiRoutingDebugSnapshot(snapshot: AiRoutingDebugSnapshot): void {
  const state = applyContentMode();
  if (state.contentMode === 'off') {
    return;
  }

  const sanitized = sanitizeSnapshot(snapshot, state.contentMode ?? 'metadata');
  state.byRequestId.set(sanitized.requestId, sanitized);
  state.latestRequestId = sanitized.requestId;

  while (state.byRequestId.size > MAX_RECORDS) {
    const firstKey = state.byRequestId.keys().next().value;
    if (typeof firstKey !== 'string') {
      break;
    }
    state.byRequestId.delete(firstKey);
  }
}

export function getLatestAiRoutingDebugSnapshot(requestId?: string): AiRoutingDebugSnapshot | null {
  const state = applyContentMode();
  if (state.contentMode === 'off') {
    return null;
  }
  const resolvedRequestId = requestId
    ? sanitizeMetadataValue(requestId)
    : state.latestRequestId;
  if (!resolvedRequestId) {
    return null;
  }

  const contentMode = state.contentMode === 'full' ? 'full' : 'metadata';
  const snapshot = state.byRequestId.get(resolvedRequestId);
  return snapshot
    ? sanitizeSnapshot(snapshot, contentMode)
    : null;
}

export function listAiRoutingDebugSnapshots(limit = 20): AiRoutingDebugSnapshot[] {
  const state = applyContentMode();
  if (state.contentMode === 'off') {
    return [];
  }
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(MAX_RECORDS, Math.trunc(limit)))
    : 20;
  const contentMode = state.contentMode === 'full' ? 'full' : 'metadata';

  return Array.from(state.byRequestId.values())
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, normalizedLimit)
    .map(snapshot =>
      sanitizeSnapshot(snapshot, contentMode),
    );
}

export function clearAiRoutingDebugSnapshotsForTest(): void {
  const state = getMutableState();
  state.byRequestId.clear();
  state.latestRequestId = null;
  state.contentMode = undefined;
}

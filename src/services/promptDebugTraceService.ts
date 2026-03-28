import fs from 'node:fs';
import path from 'node:path';

import { resolveErrorMessage } from '@core/lib/errors/index.js';

export type PromptDebugStage =
  | 'ingress'
  | 'preprocess'
  | 'routing'
  | 'executor'
  | 'response'
  | 'fallback';

export interface PromptDebugStageEvent {
  stage: PromptDebugStage;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface PromptDebugTraceRecord {
  requestId: string;
  traceId: string | null;
  endpoint: string | null;
  method: string | null;
  createdAt: string;
  updatedAt: string;
  rawPrompt: string;
  normalizedPrompt: string;
  intentTags: string[];
  selectedRoute: string | null;
  selectedModule: string | null;
  selectedTools: string[];
  repoInspectionChosen: boolean;
  runtimeInspectionChosen: boolean;
  explicitlyRequestedLiveRuntimeVerification: boolean;
  liveRuntimeRequirementPreserved: boolean;
  finalExecutorPayload: unknown | null;
  responseReturned: unknown | null;
  fallbackPathUsed: string | null;
  fallbackReason: string | null;
  preservedConstraints: string[];
  droppedConstraints: string[];
  rawConstraintPhrases: string[];
  normalizedConstraintPhrases: string[];
  executorConstraintPhrases: string[];
  stages: PromptDebugStageEvent[];
}

export interface PromptDebugTracePatch {
  traceId?: string | null;
  endpoint?: string | null;
  method?: string | null;
  rawPrompt?: string;
  normalizedPrompt?: string;
  intentTags?: string[];
  selectedRoute?: string | null;
  selectedModule?: string | null;
  selectedTools?: string[];
  repoInspectionChosen?: boolean;
  runtimeInspectionChosen?: boolean;
  finalExecutorPayload?: unknown | null;
  responseReturned?: unknown | null;
  fallbackPathUsed?: string | null;
  fallbackReason?: string | null;
}

type PromptConstraintRule = {
  phrase: string;
  pattern: RegExp;
  tag: string;
  liveRuntime: boolean;
};

const PROMPT_DEBUG_STORAGE_ENV = 'PROMPT_DEBUG_EVENTS_PATH';
const DEFAULT_PROMPT_DEBUG_STORAGE_PATH = path.resolve(process.cwd(), 'logs', 'prompt-debug-events.jsonl');
const MAX_IN_MEMORY_TRACES = 200;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const MAX_STAGE_EVENTS = 24;

const PROMPT_CONSTRAINT_RULES: PromptConstraintRule[] = [
  {
    phrase: 'live backend',
    pattern: /\blive\s+backend\b/i,
    tag: 'live_backend',
    liveRuntime: true,
  },
  {
    phrase: 'runtime',
    pattern: /\bruntime\b/i,
    tag: 'runtime',
    liveRuntime: true,
  },
  {
    phrase: 'currently active',
    pattern: /\bcurrently\s+active\b/i,
    tag: 'currently_active',
    liveRuntime: true,
  },
  {
    phrase: 'implemented now',
    pattern: /\bimplemented\s+now\b/i,
    tag: 'implemented_now',
    liveRuntime: true,
  },
  {
    phrase: 'verify in production',
    pattern: /\bverify\s+in\s+production\b/i,
    tag: 'verify_in_production',
    liveRuntime: true,
  },
];

const runtimeInspectionPatterns = [
  /\blive\s+backend\b/i,
  /\bruntime\b/i,
  /\bcurrently\s+active\b/i,
  /\bverify\s+in\s+production\b/i,
  /\bproduction\b/i,
  /\blive\s+system\b/i,
  /\bsystem\s+health\b/i,
  /\bhealth\s+probe\b/i,
  /\blive\s+verification\b/i,
];

const repoInspectionPatterns = [
  /\brepo\b/i,
  /\brepository\b/i,
  /\bcodebase\b/i,
  /\bimplementation\b/i,
  /\bfiles?\b/i,
  /\bsource\b/i,
  /\bschema\b/i,
];

function resolveStoragePath(): string {
  const configured = process.env[PROMPT_DEBUG_STORAGE_ENV];
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return path.isAbsolute(configured)
      ? configured.trim()
      : path.resolve(process.cwd(), configured.trim());
  }

  return DEFAULT_PROMPT_DEBUG_STORAGE_PATH;
}

function ensureStorageDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      deduped.add(trimmed);
    }
  }
  return Array.from(deduped.values());
}

function safeClone(value: unknown, depth = 0): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }

  if (typeof value === 'function') {
    return '[function]';
  }

  if (depth >= 4) {
    return '[truncated]';
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => safeClone(item, depth + 1));
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 40);
    return Object.fromEntries(entries.map(([key, nestedValue]) => [key, safeClone(nestedValue, depth + 1)]));
  }

  return String(value);
}

function extractPromptTextFromMessages(messages: unknown): string | null {
  if (!Array.isArray(messages)) {
    return null;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    const typedCandidate = candidate as Record<string, unknown>;
    if (typedCandidate.role !== 'user') {
      continue;
    }

    const content = typedCandidate.content;
    if (typeof content === 'string' && content.length > 0) {
      return content;
    }
  }

  return null;
}

export function extractPromptText(value: unknown, trim = true): string | null {
  if (typeof value === 'string') {
    return trim ? value.trim() : value;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const recordValue = value as Record<string, unknown>;
  const directCandidates = [
    recordValue.prompt,
    recordValue.message,
    recordValue.userInput,
    recordValue.content,
    recordValue.text,
    recordValue.query,
    recordValue.input,
  ];

  for (const candidate of directCandidates) {
    if (typeof candidate === 'string') {
      return trim ? candidate.trim() : candidate;
    }
  }

  const nestedPayloadPrompt =
    extractPromptText(recordValue.payload, trim) ??
    extractPromptText(recordValue.input, trim) ??
    extractPromptText(recordValue.body, trim);
  if (nestedPayloadPrompt) {
    return nestedPayloadPrompt;
  }

  const messagePrompt = extractPromptTextFromMessages(recordValue.messages);
  if (messagePrompt) {
    return trim ? messagePrompt.trim() : messagePrompt;
  }

  return null;
}

function extractConstraintPhrases(text: string): string[] {
  if (!text) {
    return [];
  }

  return PROMPT_CONSTRAINT_RULES
    .filter(rule => rule.pattern.test(text))
    .map(rule => rule.phrase);
}

function buildDerivedIntentTags(prompt: string): string[] {
  if (!prompt) {
    return [];
  }

  const tags: string[] = [];
  const normalizedPrompt = prompt.toLowerCase();
  for (const rule of PROMPT_CONSTRAINT_RULES) {
    if (rule.pattern.test(prompt)) {
      tags.push(rule.tag);
    }
  }

  if (runtimeInspectionPatterns.some(pattern => pattern.test(prompt))) {
    tags.push('runtime_inspection_candidate');
  }

  if (repoInspectionPatterns.some(pattern => pattern.test(prompt))) {
    tags.push('repo_inspection_candidate');
  }

  if (/\bverify\b|\bcheck\b|\binspect\b/.test(normalizedPrompt)) {
    tags.push('verification');
  }

  return uniqueStrings(tags);
}

export function shouldInspectRuntimePrompt(prompt: string | null | undefined): boolean {
  if (!prompt) {
    return false;
  }

  return runtimeInspectionPatterns.some(pattern => pattern.test(prompt));
}

function resolveExecutorConstraintPhrases(payload: unknown): string[] {
  const promptText = extractPromptText(payload, false);
  return extractConstraintPhrases(promptText ?? '');
}

function isStructuredRuntimeVerificationPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }

  const recordPayload = payload as Record<string, unknown>;
  return (
    recordPayload.runtimeInspectionChosen === true ||
    recordPayload.verifyLiveRuntime === true ||
    recordPayload.liveRuntimeVerificationRequired === true ||
    recordPayload.runtimeInspectionRequested === true
  );
}

function buildEmptyTraceRecord(requestId: string): PromptDebugTraceRecord {
  const now = new Date().toISOString();
  return {
    requestId,
    traceId: null,
    endpoint: null,
    method: null,
    createdAt: now,
    updatedAt: now,
    rawPrompt: '',
    normalizedPrompt: '',
    intentTags: [],
    selectedRoute: null,
    selectedModule: null,
    selectedTools: [],
    repoInspectionChosen: false,
    runtimeInspectionChosen: false,
    explicitlyRequestedLiveRuntimeVerification: false,
    liveRuntimeRequirementPreserved: true,
    finalExecutorPayload: null,
    responseReturned: null,
    fallbackPathUsed: null,
    fallbackReason: null,
    preservedConstraints: [],
    droppedConstraints: [],
    rawConstraintPhrases: [],
    normalizedConstraintPhrases: [],
    executorConstraintPhrases: [],
    stages: [],
  };
}

function updateDerivedFields(record: PromptDebugTraceRecord): PromptDebugTraceRecord {
  const rawConstraintPhrases = extractConstraintPhrases(record.rawPrompt);
  const normalizedConstraintPhrases = extractConstraintPhrases(record.normalizedPrompt);
  const executorConstraintPhrases = resolveExecutorConstraintPhrases(record.finalExecutorPayload);
  const explicitlyRequestedLiveRuntimeVerification =
    rawConstraintPhrases.some(phrase =>
      PROMPT_CONSTRAINT_RULES.some(rule => rule.phrase === phrase && rule.liveRuntime)
    );
  const preservedConstraints = rawConstraintPhrases.filter(phrase => executorConstraintPhrases.includes(phrase));
  const droppedConstraints = rawConstraintPhrases.filter(phrase => !executorConstraintPhrases.includes(phrase));
  const liveRuntimeRequirementPreserved =
    !explicitlyRequestedLiveRuntimeVerification ||
    record.runtimeInspectionChosen ||
    isStructuredRuntimeVerificationPayload(record.finalExecutorPayload);

  return {
    ...record,
    rawConstraintPhrases,
    normalizedConstraintPhrases,
    executorConstraintPhrases,
    explicitlyRequestedLiveRuntimeVerification,
    liveRuntimeRequirementPreserved,
    preservedConstraints,
    droppedConstraints,
    intentTags: uniqueStrings([
      ...record.intentTags,
      ...buildDerivedIntentTags(record.rawPrompt),
      ...buildDerivedIntentTags(record.normalizedPrompt),
    ]),
  };
}

class PromptDebugTraceStore {
  private readonly byRequestId = new Map<string, PromptDebugTraceRecord>();

  private hydrated = false;

  private hydrateFromDisk(): void {
    if (this.hydrated) {
      return;
    }

    this.hydrated = true;
    const storagePath = resolveStoragePath();
    if (!fs.existsSync(storagePath)) {
      return;
    }

    try {
      const lines = fs.readFileSync(storagePath, 'utf8')
        .split(/\r?\n/)
        .filter(line => line.trim().length > 0);

      for (const line of lines) {
        const parsed = JSON.parse(line) as PromptDebugTraceRecord;
        if (parsed?.requestId) {
          this.byRequestId.set(parsed.requestId, parsed);
        }
      }
    } catch (error) {
      console.error('[prompt-debug] failed to hydrate traces', resolveErrorMessage(error));
    }
  }

  private persist(record: PromptDebugTraceRecord): void {
    const storagePath = resolveStoragePath();
    try {
      ensureStorageDirectory(storagePath);
      fs.appendFileSync(storagePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      console.error('[prompt-debug] failed to persist trace', resolveErrorMessage(error));
    }
  }

  private trimInMemory(): void {
    if (this.byRequestId.size <= MAX_IN_MEMORY_TRACES) {
      return;
    }

    const records = Array.from(this.byRequestId.values())
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const recordsToDelete = records.slice(0, Math.max(0, records.length - MAX_IN_MEMORY_TRACES));
    for (const record of recordsToDelete) {
      this.byRequestId.delete(record.requestId);
    }
  }

  upsert(requestId: string, stage: PromptDebugStage, patch: PromptDebugTracePatch): PromptDebugTraceRecord {
    this.hydrateFromDisk();
    const existing = this.byRequestId.get(requestId) ?? buildEmptyTraceRecord(requestId);
    const now = new Date().toISOString();

    const nextRecord: PromptDebugTraceRecord = updateDerivedFields({
      ...existing,
      ...(Object.prototype.hasOwnProperty.call(patch, 'traceId') ? { traceId: patch.traceId ?? null } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'endpoint') ? { endpoint: patch.endpoint ?? null } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'method') ? { method: patch.method ?? null } : {}),
      ...(typeof patch.rawPrompt === 'string' ? { rawPrompt: patch.rawPrompt } : {}),
      ...(typeof patch.normalizedPrompt === 'string' ? { normalizedPrompt: patch.normalizedPrompt } : {}),
      ...(Array.isArray(patch.intentTags)
        ? { intentTags: uniqueStrings([...(existing.intentTags ?? []), ...patch.intentTags]) }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'selectedRoute')
        ? { selectedRoute: patch.selectedRoute ?? null }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'selectedModule')
        ? { selectedModule: patch.selectedModule ?? null }
        : {}),
      ...(Array.isArray(patch.selectedTools)
        ? { selectedTools: uniqueStrings([...(existing.selectedTools ?? []), ...patch.selectedTools]) }
        : {}),
      ...(typeof patch.repoInspectionChosen === 'boolean'
        ? { repoInspectionChosen: patch.repoInspectionChosen }
        : {}),
      ...(typeof patch.runtimeInspectionChosen === 'boolean'
        ? { runtimeInspectionChosen: patch.runtimeInspectionChosen }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'finalExecutorPayload')
        ? { finalExecutorPayload: safeClone(patch.finalExecutorPayload) }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'responseReturned')
        ? { responseReturned: safeClone(patch.responseReturned) }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'fallbackPathUsed')
        ? { fallbackPathUsed: patch.fallbackPathUsed ?? null }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'fallbackReason')
        ? { fallbackReason: patch.fallbackReason ?? null }
        : {}),
      updatedAt: now,
      stages: [
        ...existing.stages,
        {
          stage,
          timestamp: now,
          data: safeClone(patch) as Record<string, unknown>,
        },
      ].slice(-MAX_STAGE_EVENTS),
    });

    this.byRequestId.set(requestId, nextRecord);
    this.trimInMemory();
    this.persist(nextRecord);
    return safeClone(nextRecord) as PromptDebugTraceRecord;
  }

  list(limit = DEFAULT_LIST_LIMIT, requestId?: string): PromptDebugTraceRecord[] {
    this.hydrateFromDisk();

    const normalizedLimit = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(limit)));
    const records = Array.from(this.byRequestId.values())
      .filter(record => !requestId || record.requestId === requestId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, normalizedLimit);

    return safeClone(records) as PromptDebugTraceRecord[];
  }

  latest(requestId?: string): PromptDebugTraceRecord | null {
    const [latestRecord] = this.list(1, requestId);
    return latestRecord ?? null;
  }

  clear(): void {
    this.byRequestId.clear();
    this.hydrated = true;
    const storagePath = resolveStoragePath();
    if (fs.existsSync(storagePath)) {
      fs.rmSync(storagePath, { force: true });
    }
  }
}

const promptDebugTraceStore = new PromptDebugTraceStore();

export function recordPromptDebugTrace(
  requestId: string,
  stage: PromptDebugStage,
  patch: PromptDebugTracePatch,
): PromptDebugTraceRecord {
  return promptDebugTraceStore.upsert(requestId, stage, patch);
}

export function getLatestPromptDebugTrace(requestId?: string): PromptDebugTraceRecord | null {
  return promptDebugTraceStore.latest(requestId);
}

export function listPromptDebugTraces(limit?: number, requestId?: string): PromptDebugTraceRecord[] {
  return promptDebugTraceStore.list(limit, requestId);
}

export function clearPromptDebugTracesForTest(): void {
  promptDebugTraceStore.clear();
}

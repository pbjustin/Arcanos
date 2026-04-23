import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { resolveErrorMessage } from '@core/lib/errors/index.js';
import {
  classifyIntentMode,
  hasPromptGenerationIntent,
  type IntentModeClassification
} from '@shared/text/intentModeClassifier.js';

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
const MAX_PERSISTED_EVENT_BUFFER = 2048;
const SAFE_CLONE_MAX_DEPTH = 4;
const SAFE_CLONE_MAX_ARRAY_ITEMS = 20;
const SAFE_CLONE_MAX_OBJECT_PROPS = 40;

const PROMPT_DEBUG_EVENT_KIND = 'prompt-debug-stage-event';

interface PromptDebugPersistedEvent {
  kind: typeof PROMPT_DEBUG_EVENT_KIND;
  requestId: string;
  stage: PromptDebugStage;
  timestamp: string;
  patch: PromptDebugTracePatch;
}

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

const dagArtifactExecutionPatterns = [
  /\b(?:dag(?:\s+run)?|workflow(?:\s+run)?|orchestration(?:\s+run)?)\b/i,
  /\b(?:trace|lineage|nodes?|events?|metrics?|verification|latest|recent|most\s+recent)\b/i,
];

const runtimeInspectionPatterns = [
  /\b(?:run|reach|show|check|inspect|list|query|fetch|get|audit|diagnose|debug|investigate|probe|validate|verify)\b[^.!?\n]{0,40}\bdiagnostics?\b/i,
  /\b(?:run|reach|show|check|inspect|list|query|fetch|get|audit|diagnose|debug|investigate|probe|validate|verify)\b[^.!?\n]{0,40}\b(?:runtime|self[-\s]?heal|workers?|worker\s+health|queue|system\s+status|runtime\s+status|telemetry|metrics|events?|status)\b/i,
  /\b(?:runtime|self[-\s]?heal|worker\s+health|queue\s+health|system\s+status|runtime\s+status|telemetry|metrics|events?)\b[^.!?\n]{0,20}\b(?:now|current|currently|live)\b/i,
  /\b(?:current|currently|live)\b[^.!?\n]{0,20}\b(?:runtime|backend|deployment|service|instance|worker\s+health|queue|system\s+status)\b/i,
  /\bverify\s+in\s+production\b/i,
  /\b(?:run|show|check|inspect)\s+self[-\s]?heal\b|\bself[-\s]?heal\s+(?:status|health|runtime|events?)\b/i,
  /\b(?:show|check|inspect|list)\s+workers?\b|\bworkers?\s+(?:status|health|queue|runtime)\b/i,
  /\bqueue\s+health\b/i,
  /\bsystem\s+status\b/i,
  /\bloop\s+running\b/i,
  /\b(?:runtime|telemetry|worker|self[-\s]?heal|process|queue|deployment)\b[^.!?\n]{0,20}\bevents?\b|\bevents?\b[^.!?\n]{0,20}\b(?:runtime|telemetry|worker|self[-\s]?heal|process|queue|deployment)\b/i,
  /\bsystem\s+health\b/i,
  /\bhealth\s+probe\b/i,
  /\blive\s+verification\b/i,
  /\baudit\b[^.!?\n]{0,24}\b(?:this|the)\s+(?:instance|deployment|backend|service)\b/i,
  /\b(?:instance|deployment|backend|service)\b[^.!?\n]{0,24}\baudit\b/i,
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

async function ensureStorageDirectory(filePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
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

  if (depth >= SAFE_CLONE_MAX_DEPTH) {
    return '[truncated]';
  }

  if (Array.isArray(value)) {
    return value.slice(0, SAFE_CLONE_MAX_ARRAY_ITEMS).map(item => safeClone(item, depth + 1));
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, SAFE_CLONE_MAX_OBJECT_PROPS);
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

  const intentClassification = classifyIntentMode(prompt);
  const tags: string[] = [];
  const normalizedPrompt = prompt.toLowerCase();
  for (const rule of PROMPT_CONSTRAINT_RULES) {
    if (rule.pattern.test(prompt)) {
      tags.push(rule.tag);
    }
  }

  if (intentClassification.intentMode === 'PROMPT_GENERATION') {
    tags.push('prompt_authoring_requested');
    tags.push('intent_mode_prompt_generation');
  }
  tags.push(`intent_reason_${intentClassification.reason}`);

  if (shouldInspectRuntimePrompt(prompt, intentClassification)) {
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

export function shouldInspectRuntimePrompt(
  prompt: string | null | undefined,
  intentClassification?: IntentModeClassification
): boolean {
  if (!prompt) {
    return false;
  }

  if (intentClassification?.intentMode === 'PROMPT_GENERATION') {
    return false;
  }

  if (!intentClassification && isPromptAuthoringRequest(prompt)) {
    return false;
  }

  if (isDagArtifactExecutionRequest(prompt)) {
    return false;
  }

  return runtimeInspectionPatterns.some(pattern => pattern.test(prompt));
}

export function isPromptAuthoringRequest(prompt: string | null | undefined): boolean {
  return hasPromptGenerationIntent(prompt);
}

function isDagArtifactExecutionRequest(prompt: string | null | undefined): boolean {
  if (!prompt) {
    return false;
  }

  return dagArtifactExecutionPatterns.every(pattern => pattern.test(prompt));
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

function sanitizeTracePatch(patch: PromptDebugTracePatch): PromptDebugTracePatch {
  return {
    ...(Object.prototype.hasOwnProperty.call(patch, 'traceId') ? { traceId: patch.traceId ?? null } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'endpoint') ? { endpoint: patch.endpoint ?? null } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'method') ? { method: patch.method ?? null } : {}),
    ...(typeof patch.rawPrompt === 'string' ? { rawPrompt: patch.rawPrompt } : {}),
    ...(typeof patch.normalizedPrompt === 'string' ? { normalizedPrompt: patch.normalizedPrompt } : {}),
    ...(Array.isArray(patch.intentTags) ? { intentTags: uniqueStrings(patch.intentTags) } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'selectedRoute')
      ? { selectedRoute: patch.selectedRoute ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'selectedModule')
      ? { selectedModule: patch.selectedModule ?? null }
      : {}),
    ...(Array.isArray(patch.selectedTools) ? { selectedTools: uniqueStrings(patch.selectedTools) } : {}),
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
  };
}

function compareIsoTimestamp(left: string, right: string): number {
  return left.localeCompare(right);
}

function sortStageEvents(events: PromptDebugStageEvent[]): PromptDebugStageEvent[] {
  return [...events]
    .sort((left, right) => compareIsoTimestamp(left.timestamp, right.timestamp))
    .slice(-MAX_STAGE_EVENTS);
}

function resolveCreatedAt(existing: string, candidate: string): string {
  return compareIsoTimestamp(existing, candidate) <= 0 ? existing : candidate;
}

function resolveUpdatedAt(existing: string, candidate: string): string {
  return compareIsoTimestamp(existing, candidate) >= 0 ? existing : candidate;
}

function applyPromptDebugStageEvent(
  existing: PromptDebugTraceRecord,
  stage: PromptDebugStage,
  timestamp: string,
  patch: PromptDebugTracePatch,
): PromptDebugTraceRecord {
  const sanitizedPatch = sanitizeTracePatch(patch);

  return updateDerivedFields({
    ...existing,
    ...(Object.prototype.hasOwnProperty.call(sanitizedPatch, 'traceId')
      ? { traceId: sanitizedPatch.traceId ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(sanitizedPatch, 'endpoint')
      ? { endpoint: sanitizedPatch.endpoint ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(sanitizedPatch, 'method')
      ? { method: sanitizedPatch.method ?? null }
      : {}),
    ...(typeof sanitizedPatch.rawPrompt === 'string' ? { rawPrompt: sanitizedPatch.rawPrompt } : {}),
    ...(typeof sanitizedPatch.normalizedPrompt === 'string'
      ? { normalizedPrompt: sanitizedPatch.normalizedPrompt }
      : {}),
    ...(Array.isArray(sanitizedPatch.intentTags)
      ? { intentTags: uniqueStrings([...(existing.intentTags ?? []), ...sanitizedPatch.intentTags]) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(sanitizedPatch, 'selectedRoute')
      ? { selectedRoute: sanitizedPatch.selectedRoute ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(sanitizedPatch, 'selectedModule')
      ? { selectedModule: sanitizedPatch.selectedModule ?? null }
      : {}),
    ...(Array.isArray(sanitizedPatch.selectedTools)
      ? { selectedTools: uniqueStrings([...(existing.selectedTools ?? []), ...sanitizedPatch.selectedTools]) }
      : {}),
    ...(typeof sanitizedPatch.repoInspectionChosen === 'boolean'
      ? { repoInspectionChosen: sanitizedPatch.repoInspectionChosen }
      : {}),
    ...(typeof sanitizedPatch.runtimeInspectionChosen === 'boolean'
      ? { runtimeInspectionChosen: sanitizedPatch.runtimeInspectionChosen }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(sanitizedPatch, 'finalExecutorPayload')
      ? { finalExecutorPayload: sanitizedPatch.finalExecutorPayload ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(sanitizedPatch, 'responseReturned')
      ? { responseReturned: sanitizedPatch.responseReturned ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(sanitizedPatch, 'fallbackPathUsed')
      ? { fallbackPathUsed: sanitizedPatch.fallbackPathUsed ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(sanitizedPatch, 'fallbackReason')
      ? { fallbackReason: sanitizedPatch.fallbackReason ?? null }
      : {}),
    createdAt: resolveCreatedAt(existing.createdAt, timestamp),
    updatedAt: resolveUpdatedAt(existing.updatedAt, timestamp),
    stages: sortStageEvents([
      ...existing.stages,
      {
        stage,
        timestamp,
        data: safeClone(sanitizedPatch) as Record<string, unknown>,
      },
    ]),
  });
}

function buildPersistedStageEvent(
  requestId: string,
  stage: PromptDebugStage,
  timestamp: string,
  patch: PromptDebugTracePatch,
): PromptDebugPersistedEvent {
  return {
    kind: PROMPT_DEBUG_EVENT_KIND,
    requestId,
    stage,
    timestamp,
    patch: sanitizeTracePatch(patch),
  };
}

function isPromptDebugPersistedEvent(value: unknown): value is PromptDebugPersistedEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === PROMPT_DEBUG_EVENT_KIND &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.stage === 'string' &&
    typeof candidate.timestamp === 'string' &&
    typeof candidate.patch === 'object' &&
    candidate.patch !== null &&
    !Array.isArray(candidate.patch)
  );
}

function isPromptDebugTraceRecord(value: unknown): value is PromptDebugTraceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.requestId === 'string' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.updatedAt === 'string' &&
    Array.isArray(candidate.stages)
  );
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

  private readonly pendingPersistedLines: string[] = [];

  private hydrated = false;

  private hydrationPromise: Promise<void> | null = null;

  private persistFlushPromise: Promise<void> | null = null;

  private persistFailed = false;

  private queuePersistedLine(line: string): void {
    if (this.pendingPersistedLines.length >= MAX_PERSISTED_EVENT_BUFFER) {
      this.pendingPersistedLines.shift();
      console.warn(`[prompt-debug] dropping oldest buffered event after reaching ${MAX_PERSISTED_EVENT_BUFFER} queued entries`);
    }

    this.pendingPersistedLines.push(line);
    this.persistFailed = false;
    this.ensurePersistFlushLoop();
  }

  private ensurePersistFlushLoop(): void {
    if (!this.persistFlushPromise) {
      this.persistFlushPromise = this.flushPersistedLines();
    }
  }

  private async flushPersistedLines(): Promise<void> {
    let batch: string[] = [];

    try {
      while (this.pendingPersistedLines.length > 0) {
        batch = this.pendingPersistedLines.splice(0, this.pendingPersistedLines.length);
        const storagePath = resolveStoragePath();
        await ensureStorageDirectory(storagePath);
        await fsp.appendFile(storagePath, batch.join(''), 'utf8');
        batch = [];
      }
    } catch (error) {
      this.persistFailed = true;
      if (batch.length > 0) {
        this.pendingPersistedLines.unshift(...batch);
        if (this.pendingPersistedLines.length > MAX_PERSISTED_EVENT_BUFFER) {
          this.pendingPersistedLines.splice(0, this.pendingPersistedLines.length - MAX_PERSISTED_EVENT_BUFFER);
        }
      }
      console.error('[prompt-debug] failed to persist trace event', resolveErrorMessage(error));
    } finally {
      this.persistFlushPromise = null;
      if (this.pendingPersistedLines.length > 0 && !this.persistFailed) {
        this.ensurePersistFlushLoop();
      }
    }
  }

  private applyLegacyRecord(parsed: PromptDebugTraceRecord): void {
    const existing = this.byRequestId.get(parsed.requestId);
    if (!existing || compareIsoTimestamp(existing.updatedAt, parsed.updatedAt) < 0) {
      this.byRequestId.set(parsed.requestId, updateDerivedFields(safeClone(parsed) as PromptDebugTraceRecord));
      this.trimInMemory();
    }
  }

  private applyPersistedEvent(event: PromptDebugPersistedEvent): PromptDebugTraceRecord {
    const existing = this.byRequestId.get(event.requestId) ?? buildEmptyTraceRecord(event.requestId);
    const nextRecord = applyPromptDebugStageEvent(existing, event.stage, event.timestamp, event.patch);
    this.byRequestId.set(event.requestId, nextRecord);
    this.trimInMemory();
    return nextRecord;
  }

  private applyPersistedLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isPromptDebugPersistedEvent(parsed)) {
        this.applyPersistedEvent(parsed);
        return;
      }

      if (isPromptDebugTraceRecord(parsed)) {
        this.applyLegacyRecord(parsed);
      }
    } catch (error) {
      console.error('[prompt-debug] failed to parse persisted trace line', resolveErrorMessage(error));
    }
  }

  private async hydrateFromDisk(): Promise<void> {
    if (this.hydrated) {
      return;
    }

    if (!this.hydrationPromise) {
      this.hydrationPromise = (async () => {
        const storagePath = resolveStoragePath();
        try {
          await fsp.access(storagePath);
        } catch (error) {
          const errorCode = (error as NodeJS.ErrnoException).code;
          if (errorCode === 'ENOENT') {
            this.hydrated = true;
            return;
          }
          console.error('[prompt-debug] failed to access trace storage', resolveErrorMessage(error));
          this.hydrated = true;
          return;
        }

        const input = fs.createReadStream(storagePath, { encoding: 'utf8' });
        const lines = readline.createInterface({
          input,
          crlfDelay: Infinity,
        });

        try {
          for await (const line of lines) {
            this.applyPersistedLine(line);
          }
        } catch (error) {
          console.error('[prompt-debug] failed to hydrate traces', resolveErrorMessage(error));
        } finally {
          lines.close();
          input.destroy();
          this.hydrated = true;
        }
      })();
    }

    try {
      await this.hydrationPromise;
    } finally {
      this.hydrationPromise = null;
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
    const persistedEvent = buildPersistedStageEvent(requestId, stage, new Date().toISOString(), patch);
    const nextRecord = this.applyPersistedEvent(persistedEvent);
    this.queuePersistedLine(`${JSON.stringify(persistedEvent)}\n`);
    return safeClone(nextRecord) as PromptDebugTraceRecord;
  }

  async list(limit = DEFAULT_LIST_LIMIT, requestId?: string): Promise<PromptDebugTraceRecord[]> {
    await this.hydrateFromDisk();

    const normalizedLimit = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(limit)));
    const records = Array.from(this.byRequestId.values())
      .filter(record => !requestId || record.requestId === requestId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, normalizedLimit);

    return safeClone(records) as PromptDebugTraceRecord[];
  }

  async latest(requestId?: string): Promise<PromptDebugTraceRecord | null> {
    const [latestRecord] = await this.list(1, requestId);
    return latestRecord ?? null;
  }

  async flush(): Promise<void> {
    this.ensurePersistFlushLoop();
    await this.persistFlushPromise;
  }

  async clear(): Promise<void> {
    this.ensurePersistFlushLoop();
    await this.persistFlushPromise;
    this.pendingPersistedLines.length = 0;
    this.persistFailed = false;
    this.persistFlushPromise = null;
    this.byRequestId.clear();
    this.hydrated = false;
    this.hydrationPromise = null;
    const storagePath = resolveStoragePath();
    try {
      await fsp.rm(storagePath, { force: true });
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode !== 'ENOENT') {
        console.error('[prompt-debug] failed to clear traces', resolveErrorMessage(error));
      }
    }
  }

  async reloadFromDiskForTest(): Promise<void> {
    this.byRequestId.clear();
    this.hydrated = false;
    this.hydrationPromise = null;
    await this.hydrateFromDisk();
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

export async function getLatestPromptDebugTrace(requestId?: string): Promise<PromptDebugTraceRecord | null> {
  return promptDebugTraceStore.latest(requestId);
}

export async function listPromptDebugTraces(limit?: number, requestId?: string): Promise<PromptDebugTraceRecord[]> {
  return promptDebugTraceStore.list(limit, requestId);
}

export async function flushPromptDebugTracePersistenceForTest(): Promise<void> {
  await promptDebugTraceStore.flush();
}

export async function clearPromptDebugTracesForTest(): Promise<void> {
  await promptDebugTraceStore.clear();
}

export async function reloadPromptDebugTracesFromDiskForTest(): Promise<void> {
  await promptDebugTraceStore.reloadFromDiskForTest();
}

import fs, { promises as fsp, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { redactString, SENSITIVE_KEYS } from '@shared/redaction.js';
import {
  resolvePromptDebugTraceMode,
  type PromptDebugTraceContentMode,
} from '@services/promptDebugTracePolicy.js';
import {
  classifyIntentMode,
} from '@shared/text/intentModeClassifier.js';
import {
  isPromptAuthoringRequest,
  shouldInspectRuntimePrompt,
} from '@shared/runtimeInspectionPrompt.js';

export {
  isPromptAuthoringRequest,
  resolvePromptDebugTraceMode,
  shouldInspectRuntimePrompt,
};
export type { PromptDebugTraceContentMode };

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
  contentMode: PromptDebugTraceContentMode;
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
  structuredRuntimeVerificationObserved: boolean;
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

const REDACTED_GPT_ACCESS_PROMPT = '[REDACTED_GPT_ACCESS_PROMPT]';

export function suppressPromptDebugTraceContent(
  patch: PromptDebugTracePatch,
): PromptDebugTracePatch {
  return {
    ...(Object.prototype.hasOwnProperty.call(patch, 'traceId')
      ? { traceId: patch.traceId ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'endpoint')
      ? { endpoint: patch.endpoint ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'method')
      ? { method: patch.method ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'rawPrompt')
      ? { rawPrompt: REDACTED_GPT_ACCESS_PROMPT }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'normalizedPrompt')
      ? { normalizedPrompt: REDACTED_GPT_ACCESS_PROMPT }
      : {}),
    ...(Array.isArray(patch.intentTags)
      ? { intentTags: [...patch.intentTags] }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'selectedRoute')
      ? { selectedRoute: patch.selectedRoute ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'selectedModule')
      ? { selectedModule: patch.selectedModule ?? null }
      : {}),
    ...(Array.isArray(patch.selectedTools)
      ? { selectedTools: [...patch.selectedTools] }
      : {}),
    ...(typeof patch.repoInspectionChosen === 'boolean'
      ? { repoInspectionChosen: patch.repoInspectionChosen }
      : {}),
    ...(typeof patch.runtimeInspectionChosen === 'boolean'
      ? { runtimeInspectionChosen: patch.runtimeInspectionChosen }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'finalExecutorPayload')
      ? { finalExecutorPayload: null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'responseReturned')
      ? { responseReturned: null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'fallbackPathUsed')
      ? { fallbackPathUsed: patch.fallbackPathUsed ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'fallbackReason')
      ? { fallbackReason: null }
      : {}),
  };
}

type PromptConstraintRule = {
  phrase: string;
  pattern: RegExp;
  tag: string;
  liveRuntime: boolean;
};

const PROMPT_DEBUG_STORAGE_ENV = 'PROMPT_DEBUG_EVENTS_PATH';
const PROMPT_DEBUG_TRACE_PERSIST_ENV = 'PROMPT_DEBUG_TRACE_PERSIST';
const PROMPT_DEBUG_TRACE_MAX_BYTES_ENV = 'PROMPT_DEBUG_TRACE_MAX_BYTES';
const DEFAULT_PROMPT_DEBUG_STORAGE_PATH = path.resolve(process.cwd(), 'logs', 'prompt-debug-events.jsonl');
const MAX_IN_MEMORY_TRACES = 200;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const MAX_STAGE_EVENTS = 24;
const MAX_PERSISTED_EVENT_BUFFER = 2048;
const MAX_PERSISTED_EVENT_BYTES = 64 * 1024;
const MAX_PENDING_PERSIST_BYTES = 1024 * 1024;
const SAFE_CLONE_MAX_DEPTH = 3;
const SAFE_CLONE_MAX_ARRAY_ITEMS = 10;
const SAFE_CLONE_MAX_OBJECT_PROPS = 20;
const MAX_FULL_TRACE_STRING_CHARS = 4096;
const MAX_PROMPT_EXTRACTION_DEPTH = 8;
const MAX_PROMPT_ANALYSIS_CHARS = 4096;
const MAX_METADATA_VALUE_CHARS = 160;
const MIN_PERSISTED_TRACE_BYTES = 1024;
const MAX_PERSISTED_TRACE_BYTES = 100 * 1024 * 1024;

const PROMPT_DEBUG_EVENT_KIND = 'prompt-debug-stage-event';
const PROMPT_DEBUG_STAGES = new Set<PromptDebugStage>([
  'ingress',
  'preprocess',
  'routing',
  'executor',
  'response',
  'fallback',
]);
const METADATA_VALUE_PATTERN = /^[A-Za-z0-9_./:@{}-]+$/u;
const HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

interface PromptDebugDerivedMetadata {
  intentTags: string[];
  rawConstraintPhrases: string[];
  normalizedConstraintPhrases: string[];
  executorConstraintPhrases: string[];
  structuredRuntimeVerificationObserved: boolean;
}

interface PromptDebugPersistedEvent {
  kind: typeof PROMPT_DEBUG_EVENT_KIND;
  contentMode?: Exclude<PromptDebugTraceContentMode, 'off'>;
  requestId: string;
  stage: PromptDebugStage;
  timestamp: string;
  patch: PromptDebugTracePatch;
  metadata?: PromptDebugDerivedMetadata;
}

interface PromptDebugTraceConfig {
  mode: PromptDebugTraceContentMode;
  persistence:
    | {
        enabled: true;
        storagePath: string;
        maxBytes: number;
      }
    | {
        enabled: false;
      };
}

type PromptDebugTracePersistenceConfig = PromptDebugTraceConfig & {
  persistence: Extract<
    PromptDebugTraceConfig['persistence'],
    { enabled: true }
  >;
};

interface PendingPersistedLine {
  contentMode: Exclude<PromptDebugTraceContentMode, 'off'>;
  configGeneration: number;
  configKey: string;
  line: string;
  storagePath: string;
  maxBytes: number;
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

const repoInspectionPatterns = [
  /\brepo\b/i,
  /\brepository\b/i,
  /\bcodebase\b/i,
  /\bimplementation\b/i,
  /\bfiles?\b/i,
  /\bsource\b/i,
  /\bschema\b/i,
];

const SAFE_INTENT_TAGS = new Set([
  'live_backend',
  'runtime',
  'currently_active',
  'implemented_now',
  'verify_in_production',
  'prompt_authoring_requested',
  'intent_mode_prompt_generation',
  'intent_reason_empty_prompt_defaults_to_execute_task',
  'intent_reason_artifact_requested_for_downstream_executor',
  'intent_reason_artifact_requested',
  'intent_reason_delegated_deliverable_for_downstream_executor',
  'intent_reason_downstream_executor_instruction_requested',
  'intent_reason_no_prompt_generation_signals',
  'runtime_inspection_candidate',
  'repo_inspection_candidate',
  'verification',
  'openai_prompt',
  'runtime_inspection_requested',
  'generic',
  'memory',
  'memory:save',
  'memory:lookup',
  'memory:inspect',
  'memory:retrieve',
  'memory:list',
  'cognitive_domain:diagnostic',
  'cognitive_domain:code',
  'cognitive_domain:creative',
  'cognitive_domain:natural',
  'cognitive_domain:execution',
]);

function resolveStoragePath(environment: NodeJS.ProcessEnv): string {
  const configured = environment[PROMPT_DEBUG_STORAGE_ENV];
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return path.isAbsolute(configured)
      ? configured.trim()
      : path.resolve(process.cwd(), configured.trim());
  }

  return DEFAULT_PROMPT_DEBUG_STORAGE_PATH;
}

function resolvePersistenceMaxBytes(value: string | undefined): number | null {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    return null;
  }

  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_PERSISTED_TRACE_BYTES ||
    parsed > MAX_PERSISTED_TRACE_BYTES
  ) {
    return null;
  }

  return parsed;
}

function resolvePromptDebugTraceConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PromptDebugTraceConfig {
  const mode = resolvePromptDebugTraceMode(environment);
  const persistenceRequested =
    environment[PROMPT_DEBUG_TRACE_PERSIST_ENV] === 'true';
  const maxBytes = resolvePersistenceMaxBytes(
    environment[PROMPT_DEBUG_TRACE_MAX_BYTES_ENV],
  );

  if (mode === 'off' || !persistenceRequested || maxBytes === null) {
    return {
      mode,
      persistence: {
        enabled: false,
      },
    };
  }

  return {
    mode,
    persistence: {
      enabled: true,
      storagePath: resolveStoragePath(environment),
      maxBytes,
    },
  };
}

function buildPromptDebugTraceConfigKey(config: PromptDebugTraceConfig): string {
  return JSON.stringify(
    config.persistence.enabled
      ? [
          config.mode,
          true,
          config.persistence.storagePath,
          config.persistence.maxBytes,
        ]
      : [config.mode, false],
  );
}

function buildPromptDebugStorageKey(
  config: PromptDebugTracePersistenceConfig,
): string {
  return JSON.stringify([
    config.persistence.storagePath,
    config.persistence.maxBytes,
  ]);
}

async function ensureStorageDirectory(filePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

function uniqueStrings(
  values: Array<string | null | undefined>,
  sanitize?: (value: string) => string | null,
): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const normalized = sanitize ? sanitize(value) : value.trim();
    if (normalized && normalized.length > 0) {
      deduped.add(normalized);
    }
  }
  return Array.from(deduped.values());
}

function truncateFullTraceString(value: string): string {
  const redacted = redactString(value);
  return redacted.length <= MAX_FULL_TRACE_STRING_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_FULL_TRACE_STRING_CHARS)}[truncated]`;
}

function sanitizeMetadataValue(value: string): string | null {
  if (
    value.length === 0 ||
    value.length > MAX_METADATA_VALUE_CHARS ||
    value !== value.trim() ||
    !METADATA_VALUE_PATTERN.test(value) ||
    redactString(value) !== value
  ) {
    return null;
  }

  return value;
}

function sanitizeIntentTag(value: string): string | null {
  const sanitized = sanitizeMetadataValue(value);
  return sanitized && SAFE_INTENT_TAGS.has(sanitized) ? sanitized : null;
}

function sanitizeEndpointValue(value: string): string | null {
  const [pathOnly = ''] = value.split(/[?#]/u, 1);
  return sanitizeMetadataValue(pathOnly);
}

function sanitizeHttpMethod(value: string): string | null {
  const normalized = value.toUpperCase();
  return HTTP_METHODS.has(normalized) ? normalized : null;
}

function normalizeRequestId(value: string): string {
  const sanitized = sanitizeMetadataValue(value);
  if (sanitized) {
    return sanitized;
  }

  const digest = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `opaque-${digest}`;
}

function sanitizeTimestamp(value: string | undefined, fallback: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 40 ||
    !Number.isFinite(Date.parse(value))
  ) {
    return fallback;
  }

  return value;
}

function isSensitiveObjectKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[\s._-]+/gu, '');
  return SENSITIVE_KEYS.some(sensitiveKey =>
    normalized.includes(
      String(sensitiveKey).toLowerCase().replace(/[\s._-]+/gu, ''),
    ),
  );
}

function safeClone(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return truncateFullTraceString(value);
  }

  if (value instanceof Error) {
    return {
      name: truncateFullTraceString(value.name),
      message: truncateFullTraceString(value.message),
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
    return Object.fromEntries(
      entries.map(([key, nestedValue]) => [
        key.slice(0, MAX_METADATA_VALUE_CHARS),
        isSensitiveObjectKey(key)
          ? '[REDACTED]'
          : safeClone(nestedValue, depth + 1),
      ]),
    );
  }

  return truncateFullTraceString(String(value));
}

function cloneTraceRecord(record: PromptDebugTraceRecord): PromptDebugTraceRecord {
  const cloneBoundedStrings = (values: string[]): string[] =>
    values.slice(0, SAFE_CLONE_MAX_ARRAY_ITEMS).map(value => String(value));

  return {
    contentMode: record.contentMode,
    requestId: record.requestId,
    traceId: record.traceId,
    endpoint: record.endpoint,
    method: record.method,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    rawPrompt: record.rawPrompt,
    normalizedPrompt: record.normalizedPrompt,
    intentTags: cloneBoundedStrings(record.intentTags),
    selectedRoute: record.selectedRoute,
    selectedModule: record.selectedModule,
    selectedTools: cloneBoundedStrings(record.selectedTools),
    repoInspectionChosen: record.repoInspectionChosen,
    runtimeInspectionChosen: record.runtimeInspectionChosen,
    explicitlyRequestedLiveRuntimeVerification:
      record.explicitlyRequestedLiveRuntimeVerification,
    liveRuntimeRequirementPreserved: record.liveRuntimeRequirementPreserved,
    structuredRuntimeVerificationObserved:
      record.structuredRuntimeVerificationObserved,
    finalExecutorPayload: safeClone(record.finalExecutorPayload),
    responseReturned: safeClone(record.responseReturned),
    fallbackPathUsed: record.fallbackPathUsed,
    fallbackReason: record.fallbackReason,
    preservedConstraints: cloneBoundedStrings(record.preservedConstraints),
    droppedConstraints: cloneBoundedStrings(record.droppedConstraints),
    rawConstraintPhrases: cloneBoundedStrings(record.rawConstraintPhrases),
    normalizedConstraintPhrases: cloneBoundedStrings(
      record.normalizedConstraintPhrases,
    ),
    executorConstraintPhrases: cloneBoundedStrings(
      record.executorConstraintPhrases,
    ),
    stages: record.stages.slice(-MAX_STAGE_EVENTS).map(stageEvent => ({
      stage: stageEvent.stage,
      timestamp: stageEvent.timestamp,
      data: safeClone(stageEvent.data) as Record<string, unknown>,
    })),
  };
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

function extractPromptTextBounded(
  value: unknown,
  trim: boolean,
  depth: number,
  visited: WeakSet<object>,
): string | null {
  if (typeof value === 'string') {
    return trim ? value.trim() : value;
  }

  if (
    !value ||
    typeof value !== 'object' ||
    depth >= MAX_PROMPT_EXTRACTION_DEPTH ||
    visited.has(value)
  ) {
    return null;
  }
  visited.add(value);

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
    extractPromptTextBounded(recordValue.payload, trim, depth + 1, visited) ??
    extractPromptTextBounded(recordValue.input, trim, depth + 1, visited) ??
    extractPromptTextBounded(recordValue.body, trim, depth + 1, visited);
  if (nestedPayloadPrompt) {
    return nestedPayloadPrompt;
  }

  const messagePrompt = extractPromptTextFromMessages(recordValue.messages);
  if (messagePrompt) {
    return trim ? messagePrompt.trim() : messagePrompt;
  }

  return null;
}

export function extractPromptText(value: unknown, trim = true): string | null {
  return extractPromptTextBounded(value, trim, 0, new WeakSet<object>());
}

function extractConstraintPhrases(text: string): string[] {
  if (!text) {
    return [];
  }

  const boundedText = text.slice(0, MAX_PROMPT_ANALYSIS_CHARS);
  return PROMPT_CONSTRAINT_RULES
    .filter(rule => rule.pattern.test(boundedText))
    .map(rule => rule.phrase);
}

function buildDerivedIntentTags(prompt: string): string[] {
  if (!prompt) {
    return [];
  }

  const boundedPrompt = prompt.slice(0, MAX_PROMPT_ANALYSIS_CHARS);
  const intentClassification = classifyIntentMode(boundedPrompt);
  const tags: string[] = [];
  const normalizedPrompt = boundedPrompt.toLowerCase();
  for (const rule of PROMPT_CONSTRAINT_RULES) {
    if (rule.pattern.test(boundedPrompt)) {
      tags.push(rule.tag);
    }
  }

  if (intentClassification.intentMode === 'PROMPT_GENERATION') {
    tags.push('prompt_authoring_requested');
    tags.push('intent_mode_prompt_generation');
  }
  tags.push(`intent_reason_${intentClassification.reason}`);

  if (shouldInspectRuntimePrompt(boundedPrompt, intentClassification)) {
    tags.push('runtime_inspection_candidate');
  }

  if (repoInspectionPatterns.some(pattern => pattern.test(boundedPrompt))) {
    tags.push('repo_inspection_candidate');
  }

  if (/\bverify\b|\bcheck\b|\binspect\b/.test(normalizedPrompt)) {
    tags.push('verification');
  }

  return uniqueStrings(tags);
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

function sanitizeConstraintPhrases(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const allowedPhrases = new Set(PROMPT_CONSTRAINT_RULES.map(rule => rule.phrase));
  return uniqueStrings(
    values.filter((value): value is string => typeof value === 'string'),
  ).filter(value => allowedPhrases.has(value));
}

function sanitizeDerivedMetadata(
  metadata: PromptDebugDerivedMetadata | undefined,
): PromptDebugDerivedMetadata {
  return {
    intentTags: uniqueStrings(metadata?.intentTags ?? [], sanitizeIntentTag),
    rawConstraintPhrases: sanitizeConstraintPhrases(metadata?.rawConstraintPhrases),
    normalizedConstraintPhrases: sanitizeConstraintPhrases(
      metadata?.normalizedConstraintPhrases,
    ),
    executorConstraintPhrases: sanitizeConstraintPhrases(
      metadata?.executorConstraintPhrases,
    ),
    structuredRuntimeVerificationObserved:
      metadata?.structuredRuntimeVerificationObserved === true,
  };
}

function derivePromptDebugMetadata(
  patch: PromptDebugTracePatch,
  existing?: PromptDebugDerivedMetadata,
): PromptDebugDerivedMetadata {
  const rawPrompt = typeof patch.rawPrompt === 'string' ? patch.rawPrompt : '';
  const normalizedPrompt =
    typeof patch.normalizedPrompt === 'string' ? patch.normalizedPrompt : '';
  const sanitizedExisting = sanitizeDerivedMetadata(existing);

  return {
    intentTags: uniqueStrings(
      [
        ...sanitizedExisting.intentTags,
        ...(Array.isArray(patch.intentTags) ? patch.intentTags : []),
        ...buildDerivedIntentTags(rawPrompt),
        ...buildDerivedIntentTags(normalizedPrompt),
      ],
      sanitizeIntentTag,
    ),
    rawConstraintPhrases: uniqueStrings([
      ...sanitizedExisting.rawConstraintPhrases,
      ...extractConstraintPhrases(rawPrompt),
    ]),
    normalizedConstraintPhrases: uniqueStrings([
      ...sanitizedExisting.normalizedConstraintPhrases,
      ...extractConstraintPhrases(normalizedPrompt),
    ]),
    executorConstraintPhrases: uniqueStrings([
      ...sanitizedExisting.executorConstraintPhrases,
      ...resolveExecutorConstraintPhrases(patch.finalExecutorPayload),
    ]),
    structuredRuntimeVerificationObserved:
      sanitizedExisting.structuredRuntimeVerificationObserved ||
      isStructuredRuntimeVerificationPayload(patch.finalExecutorPayload),
  };
}

function buildEmptyTraceRecord(
  requestId: string,
  contentMode: PromptDebugTraceContentMode,
): PromptDebugTraceRecord {
  const now = new Date().toISOString();
  return {
    contentMode,
    requestId: normalizeRequestId(requestId),
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
    structuredRuntimeVerificationObserved: false,
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

function sanitizeTracePatch(
  patch: PromptDebugTracePatch,
  contentMode: Exclude<PromptDebugTraceContentMode, 'off'>,
  metadata: PromptDebugDerivedMetadata,
): PromptDebugTracePatch {
  const fullContent = contentMode === 'full';
  return {
    ...(Object.prototype.hasOwnProperty.call(patch, 'traceId')
      ? {
          traceId:
            typeof patch.traceId === 'string'
              ? sanitizeMetadataValue(patch.traceId)
              : null,
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'endpoint')
      ? {
          endpoint:
            typeof patch.endpoint === 'string'
              ? sanitizeEndpointValue(patch.endpoint)
              : null,
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'method')
      ? {
          method:
            typeof patch.method === 'string'
              ? sanitizeHttpMethod(patch.method)
              : null,
        }
      : {}),
    ...(fullContent && typeof patch.rawPrompt === 'string'
      ? { rawPrompt: truncateFullTraceString(patch.rawPrompt) }
      : {}),
    ...(fullContent && typeof patch.normalizedPrompt === 'string'
      ? { normalizedPrompt: truncateFullTraceString(patch.normalizedPrompt) }
      : {}),
    ...(metadata.intentTags.length > 0
      ? { intentTags: metadata.intentTags }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'selectedRoute')
      ? {
          selectedRoute:
            typeof patch.selectedRoute === 'string'
              ? sanitizeEndpointValue(patch.selectedRoute)
              : null,
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'selectedModule')
      ? {
          selectedModule:
            typeof patch.selectedModule === 'string'
              ? sanitizeMetadataValue(patch.selectedModule)
              : null,
        }
      : {}),
    ...(Array.isArray(patch.selectedTools)
      ? {
          selectedTools: uniqueStrings(
            patch.selectedTools,
            sanitizeMetadataValue,
          ),
        }
      : {}),
    ...(typeof patch.repoInspectionChosen === 'boolean'
      ? { repoInspectionChosen: patch.repoInspectionChosen }
      : {}),
    ...(typeof patch.runtimeInspectionChosen === 'boolean'
      ? { runtimeInspectionChosen: patch.runtimeInspectionChosen }
      : {}),
    ...(fullContent && Object.prototype.hasOwnProperty.call(patch, 'finalExecutorPayload')
      ? { finalExecutorPayload: safeClone(patch.finalExecutorPayload) }
      : {}),
    ...(fullContent && Object.prototype.hasOwnProperty.call(patch, 'responseReturned')
      ? { responseReturned: safeClone(patch.responseReturned) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'fallbackPathUsed')
      ? {
          fallbackPathUsed:
            typeof patch.fallbackPathUsed === 'string'
              ? sanitizeMetadataValue(patch.fallbackPathUsed)
              : null,
        }
      : {}),
    ...(fullContent && Object.prototype.hasOwnProperty.call(patch, 'fallbackReason')
      ? {
          fallbackReason:
            typeof patch.fallbackReason === 'string'
              ? truncateFullTraceString(patch.fallbackReason)
              : null,
        }
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
  contentMode: Exclude<PromptDebugTraceContentMode, 'off'>,
  derivedMetadata?: PromptDebugDerivedMetadata,
): PromptDebugTraceRecord {
  const metadata = derivePromptDebugMetadata(patch, derivedMetadata);
  const sanitizedPatch = sanitizeTracePatch(patch, contentMode, metadata);

  return updateDerivedFields({
    ...existing,
    contentMode,
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
    structuredRuntimeVerificationObserved:
      existing.structuredRuntimeVerificationObserved ||
      metadata.structuredRuntimeVerificationObserved,
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
  }, metadata);
}

function buildPersistedStageEvent(
  requestId: string,
  stage: PromptDebugStage,
  timestamp: string,
  patch: PromptDebugTracePatch,
  contentMode: Exclude<PromptDebugTraceContentMode, 'off'>,
): PromptDebugPersistedEvent {
  const metadata = derivePromptDebugMetadata(patch);
  return {
    kind: PROMPT_DEBUG_EVENT_KIND,
    contentMode,
    requestId: normalizeRequestId(requestId),
    stage,
    timestamp,
    patch: sanitizeTracePatch(patch, contentMode, metadata),
    metadata,
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
    PROMPT_DEBUG_STAGES.has(candidate.stage as PromptDebugStage) &&
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

function updateDerivedFields(
  record: PromptDebugTraceRecord,
  derivedMetadata?: PromptDebugDerivedMetadata,
): PromptDebugTraceRecord {
  const metadata = sanitizeDerivedMetadata(derivedMetadata);
  const rawConstraintPhrases = uniqueStrings([
    ...sanitizeConstraintPhrases(record.rawConstraintPhrases),
    ...metadata.rawConstraintPhrases,
    ...extractConstraintPhrases(record.rawPrompt),
  ]);
  const normalizedConstraintPhrases = uniqueStrings([
    ...sanitizeConstraintPhrases(record.normalizedConstraintPhrases),
    ...metadata.normalizedConstraintPhrases,
    ...extractConstraintPhrases(record.normalizedPrompt),
  ]);
  const executorConstraintPhrases = uniqueStrings([
    ...sanitizeConstraintPhrases(record.executorConstraintPhrases),
    ...metadata.executorConstraintPhrases,
    ...resolveExecutorConstraintPhrases(record.finalExecutorPayload),
  ]);
  const explicitlyRequestedLiveRuntimeVerification =
    rawConstraintPhrases.some(phrase =>
      PROMPT_CONSTRAINT_RULES.some(rule => rule.phrase === phrase && rule.liveRuntime)
    );
  const preservedConstraints = rawConstraintPhrases.filter(phrase => executorConstraintPhrases.includes(phrase));
  const droppedConstraints = rawConstraintPhrases.filter(phrase => !executorConstraintPhrases.includes(phrase));
  const structuredRuntimeVerificationObserved =
    record.structuredRuntimeVerificationObserved ||
    metadata.structuredRuntimeVerificationObserved ||
    isStructuredRuntimeVerificationPayload(record.finalExecutorPayload);
  const liveRuntimeRequirementPreserved =
    !explicitlyRequestedLiveRuntimeVerification ||
    record.runtimeInspectionChosen ||
    structuredRuntimeVerificationObserved;

  return {
    ...record,
    rawConstraintPhrases,
    normalizedConstraintPhrases,
    executorConstraintPhrases,
    explicitlyRequestedLiveRuntimeVerification,
    liveRuntimeRequirementPreserved,
    structuredRuntimeVerificationObserved,
    preservedConstraints,
    droppedConstraints,
    intentTags: uniqueStrings([
      ...record.intentTags,
      ...metadata.intentTags,
      ...buildDerivedIntentTags(record.rawPrompt),
      ...buildDerivedIntentTags(record.normalizedPrompt),
    ]),
  };
}

function buildPatchFromTraceRecord(
  record: PromptDebugTraceRecord,
): PromptDebugTracePatch {
  return {
    traceId: record.traceId,
    endpoint: record.endpoint,
    method: record.method,
    rawPrompt: typeof record.rawPrompt === 'string' ? record.rawPrompt : '',
    normalizedPrompt:
      typeof record.normalizedPrompt === 'string' ? record.normalizedPrompt : '',
    intentTags: Array.isArray(record.intentTags) ? record.intentTags : [],
    selectedRoute: record.selectedRoute,
    selectedModule: record.selectedModule,
    selectedTools: Array.isArray(record.selectedTools)
      ? record.selectedTools
      : [],
    repoInspectionChosen: record.repoInspectionChosen === true,
    runtimeInspectionChosen: record.runtimeInspectionChosen === true,
    finalExecutorPayload: record.finalExecutorPayload,
    responseReturned: record.responseReturned,
    fallbackPathUsed: record.fallbackPathUsed,
    fallbackReason: record.fallbackReason,
  };
}

function normalizeStageEvents(
  stages: unknown,
  contentMode: Exclude<PromptDebugTraceContentMode, 'off'>,
): PromptDebugStageEvent[] {
  if (!Array.isArray(stages)) {
    return [];
  }

  const fallbackTimestamp = new Date().toISOString();
  const normalized: PromptDebugStageEvent[] = [];
  for (const stageEvent of stages.slice(-MAX_STAGE_EVENTS)) {
    if (!stageEvent || typeof stageEvent !== 'object' || Array.isArray(stageEvent)) {
      continue;
    }

    const candidate = stageEvent as Record<string, unknown>;
    if (
      typeof candidate.stage !== 'string' ||
      !PROMPT_DEBUG_STAGES.has(candidate.stage as PromptDebugStage) ||
      !candidate.data ||
      typeof candidate.data !== 'object' ||
      Array.isArray(candidate.data)
    ) {
      continue;
    }

    const patch = candidate.data as PromptDebugTracePatch;
    const metadata = derivePromptDebugMetadata(patch);
    normalized.push({
      stage: candidate.stage as PromptDebugStage,
      timestamp: sanitizeTimestamp(
        typeof candidate.timestamp === 'string'
          ? candidate.timestamp
          : undefined,
        fallbackTimestamp,
      ),
      data: safeClone(
        sanitizeTracePatch(patch, contentMode, metadata),
      ) as Record<string, unknown>,
    });
  }

  return sortStageEvents(normalized);
}

function projectTraceRecord(
  record: PromptDebugTraceRecord,
  contentMode: Exclude<PromptDebugTraceContentMode, 'off'>,
): PromptDebugTraceRecord {
  const patch = buildPatchFromTraceRecord(record);
  const metadata = derivePromptDebugMetadata(patch, {
    intentTags: Array.isArray(record.intentTags) ? record.intentTags : [],
    rawConstraintPhrases: sanitizeConstraintPhrases(
      record.rawConstraintPhrases,
    ),
    normalizedConstraintPhrases: sanitizeConstraintPhrases(
      record.normalizedConstraintPhrases,
    ),
    executorConstraintPhrases: sanitizeConstraintPhrases(
      record.executorConstraintPhrases,
    ),
    structuredRuntimeVerificationObserved:
      record.structuredRuntimeVerificationObserved === true,
  });
  const now = new Date().toISOString();
  const updatedAt = sanitizeTimestamp(record.updatedAt, now);
  const createdAt = sanitizeTimestamp(record.createdAt, updatedAt);
  const base = buildEmptyTraceRecord(record.requestId, contentMode);
  const projected = applyPromptDebugStageEvent(
    base,
    'ingress',
    updatedAt,
    patch,
    contentMode,
    metadata,
  );

  return {
    ...projected,
    createdAt,
    updatedAt,
    stages: normalizeStageEvents(record.stages, contentMode),
  };
}

class PromptDebugTraceStore {
  private readonly byRequestId = new Map<string, PromptDebugTraceRecord>();

  private readonly pendingPersistedLines: PendingPersistedLine[] = [];

  private hydratedStorageKey: string | null = null;

  private hydratedStoragePath: string | null = null;

  private hydrationPromise: Promise<void> | null = null;

  private persistFlushPromise: Promise<void> | null = null;

  private persistFailed = false;

  private pendingPersistedBytes = 0;

  private currentConfig: PromptDebugTraceConfig | null = null;

  private currentConfigKey: string | null = null;

  private configGeneration = 0;

  private persistenceCapWarningEmitted = false;

  private persistenceEventWarningEmitted = false;

  private discardPendingPersistence(): void {
    this.pendingPersistedLines.length = 0;
    this.pendingPersistedBytes = 0;
    this.persistFailed = false;
  }

  private applyConfig(config: PromptDebugTraceConfig): number {
    const configKey = buildPromptDebugTraceConfigKey(config);
    if (configKey === this.currentConfigKey) {
      return this.configGeneration;
    }

    const previousConfig = this.currentConfig;
    const previousStoragePath = previousConfig?.persistence.enabled
      ? previousConfig.persistence.storagePath
      : this.hydratedStoragePath;
    const nextStoragePath = config.persistence.enabled
      ? config.persistence.storagePath
      : null;

    if (previousConfig !== null) {
      this.discardPendingPersistence();
    }
    if (
      nextStoragePath !== null &&
      previousStoragePath !== null &&
      nextStoragePath !== previousStoragePath
    ) {
      this.byRequestId.clear();
      this.hydratedStorageKey = null;
      this.hydratedStoragePath = null;
    }

    if (config.mode === 'off') {
      this.byRequestId.clear();
      this.discardPendingPersistence();
      this.hydratedStorageKey = null;
      this.hydratedStoragePath = null;
    } else if (config.mode === 'metadata') {
      for (const [requestId, record] of this.byRequestId.entries()) {
        this.byRequestId.set(
          requestId,
          projectTraceRecord(record, 'metadata'),
        );
      }
      this.pendingPersistedLines.splice(
        0,
        this.pendingPersistedLines.length,
        ...this.pendingPersistedLines.filter(
          entry => entry.contentMode === 'metadata',
        ),
      );
      this.pendingPersistedBytes = this.pendingPersistedLines.reduce(
        (total, entry) => total + Buffer.byteLength(entry.line, 'utf8'),
        0,
      );
    }

    this.currentConfig = config;
    this.currentConfigKey = configKey;
    this.configGeneration += 1;
    this.persistenceCapWarningEmitted = false;
    this.persistenceEventWarningEmitted = false;
    return this.configGeneration;
  }

  private queuePersistedLine(entry: PendingPersistedLine): void {
    const entryBytes = Buffer.byteLength(entry.line, 'utf8');
    if (entryBytes > MAX_PERSISTED_EVENT_BYTES) {
      if (!this.persistenceEventWarningEmitted) {
        console.warn(
          '[prompt-debug] persisted event exceeds the per-event byte limit; dropping its disk copy',
        );
        this.persistenceEventWarningEmitted = true;
      }
      return;
    }

    let droppedOldest = false;
    while (
      this.pendingPersistedLines.length > 0 &&
      (
        this.pendingPersistedLines.length >= MAX_PERSISTED_EVENT_BUFFER ||
        this.pendingPersistedBytes + entryBytes > MAX_PENDING_PERSIST_BYTES
      )
    ) {
      const dropped = this.pendingPersistedLines.shift();
      if (dropped) {
        this.pendingPersistedBytes -= Buffer.byteLength(dropped.line, 'utf8');
      }
      droppedOldest = true;
    }
    if (droppedOldest) {
      console.warn('[prompt-debug] dropping oldest buffered event after reaching the pending persistence limit');
    }

    this.pendingPersistedLines.push(entry);
    this.pendingPersistedBytes += entryBytes;
    this.persistFailed = false;
    this.ensurePersistFlushLoop();
  }

  private ensurePersistFlushLoop(): void {
    if (!this.persistFlushPromise) {
      this.persistFlushPromise = this.flushPersistedLines();
    }
  }

  private isPersistenceEntryCurrentlyEnabled(
    entry: PendingPersistedLine,
  ): boolean {
    const config = resolvePromptDebugTraceConfig();
    return (
      entry.configGeneration === this.configGeneration &&
      entry.configKey === this.currentConfigKey &&
      entry.configKey === buildPromptDebugTraceConfigKey(config) &&
      config.persistence.enabled &&
      config.mode === entry.contentMode &&
      config.persistence.storagePath === entry.storagePath &&
      config.persistence.maxBytes === entry.maxBytes
    );
  }

  private async rollbackStalePersistedAppend(
    entry: PendingPersistedLine,
    beforeStats: BigIntStats,
    appendedBytes: number,
  ): Promise<boolean> {
    let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
    try {
      handle = await fsp.open(entry.storagePath, 'r+');
      const afterStats = await handle.stat({ bigint: true });
      if (
        afterStats.dev !== beforeStats.dev ||
        afterStats.ino !== beforeStats.ino ||
        afterStats.size !== beforeStats.size + BigInt(appendedBytes)
      ) {
        return false;
      }
      await handle.truncate(Number(beforeStats.size));
      return true;
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  private async flushPersistedLines(): Promise<void> {
    let currentEntry: PendingPersistedLine | null = null;

    try {
      while (this.pendingPersistedLines.length > 0) {
        currentEntry = this.pendingPersistedLines.shift() ?? null;
        if (!currentEntry) {
          continue;
        }
        this.pendingPersistedBytes = Math.max(
          0,
          this.pendingPersistedBytes -
            Buffer.byteLength(currentEntry.line, 'utf8'),
        );

        if (!this.isPersistenceEntryCurrentlyEnabled(currentEntry)) {
          currentEntry = null;
          continue;
        }

        await ensureStorageDirectory(currentEntry.storagePath);
        const prepareHandle = await fsp.open(
          currentEntry.storagePath,
          'a',
          0o600,
        );
        await prepareHandle.close();
        const beforeAppendStats = await fsp.stat(
          currentEntry.storagePath,
          { bigint: true },
        );

        const lineBytes = Buffer.byteLength(currentEntry.line, 'utf8');
        if (
          beforeAppendStats.size + BigInt(lineBytes) >
          BigInt(currentEntry.maxBytes)
        ) {
          if (!this.persistenceCapWarningEmitted) {
            console.warn(
              '[prompt-debug] persistence byte limit reached; dropping new trace events',
            );
            this.persistenceCapWarningEmitted = true;
          }
          currentEntry = null;
          continue;
        }

        if (!this.isPersistenceEntryCurrentlyEnabled(currentEntry)) {
          currentEntry = null;
          continue;
        }

        await fsp.appendFile(
          currentEntry.storagePath,
          currentEntry.line,
          {
            encoding: 'utf8',
            mode: 0o600,
          },
        );
        if (!this.isPersistenceEntryCurrentlyEnabled(currentEntry)) {
          const rolledBack = await this.rollbackStalePersistedAppend(
            currentEntry,
            beforeAppendStats,
            lineBytes,
          );
          if (!rolledBack) {
            console.error(
              '[prompt-debug] could not roll back a stale persisted trace append',
            );
          }
        }
        currentEntry = null;
      }
    } catch (error) {
      this.persistFailed = true;
      if (
        currentEntry &&
        this.isPersistenceEntryCurrentlyEnabled(currentEntry)
      ) {
        this.pendingPersistedLines.unshift(currentEntry);
        this.pendingPersistedBytes += Buffer.byteLength(
          currentEntry.line,
          'utf8',
        );
        while (
          this.pendingPersistedLines.length > MAX_PERSISTED_EVENT_BUFFER ||
          this.pendingPersistedBytes > MAX_PENDING_PERSIST_BYTES
        ) {
          const removed = this.pendingPersistedLines.pop();
          if (removed) {
            this.pendingPersistedBytes -= Buffer.byteLength(
              removed.line,
              'utf8',
            );
          }
        }
      }
      if (
        currentEntry &&
        !this.isPersistenceEntryCurrentlyEnabled(currentEntry)
      ) {
        this.persistFailed = false;
      }
      console.error('[prompt-debug] failed to persist trace event', resolveErrorMessage(error));
    } finally {
      this.persistFlushPromise = null;
      if (this.pendingPersistedLines.length > 0 && !this.persistFailed) {
        this.ensurePersistFlushLoop();
      }
    }
  }

  private applyLegacyRecord(
    parsed: PromptDebugTraceRecord,
    contentMode: Exclude<PromptDebugTraceContentMode, 'off'>,
    target: Map<string, PromptDebugTraceRecord> = this.byRequestId,
  ): void {
    const projected = projectTraceRecord(parsed, contentMode);
    const existing = target.get(projected.requestId);
    if (
      !existing ||
      compareIsoTimestamp(existing.updatedAt, projected.updatedAt) < 0
    ) {
      target.set(projected.requestId, projected);
      this.trimInMemory(target);
    }
  }

  private applyPersistedEvent(
    event: PromptDebugPersistedEvent,
    contentMode: Exclude<PromptDebugTraceContentMode, 'off'>,
    target: Map<string, PromptDebugTraceRecord> = this.byRequestId,
  ): PromptDebugTraceRecord {
    const requestId = normalizeRequestId(event.requestId);
    const existing =
      target.get(requestId) ??
      buildEmptyTraceRecord(requestId, contentMode);
    const nextRecord = applyPromptDebugStageEvent(
      existing,
      event.stage,
      sanitizeTimestamp(event.timestamp, new Date().toISOString()),
      event.patch,
      contentMode,
      event.metadata,
    );
    target.set(requestId, nextRecord);
    this.trimInMemory(target);
    return nextRecord;
  }

  private applyPersistedLine(
    line: string,
    contentMode: Exclude<PromptDebugTraceContentMode, 'off'>,
    target: Map<string, PromptDebugTraceRecord>,
  ): 'applied' | 'ignored' | 'invalid' {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return 'ignored';
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isPromptDebugPersistedEvent(parsed)) {
        this.applyPersistedEvent(parsed, contentMode, target);
        return 'applied';
      }

      if (isPromptDebugTraceRecord(parsed)) {
        this.applyLegacyRecord(parsed, contentMode, target);
        return 'applied';
      }
    } catch {
      return 'invalid';
    }

    return 'ignored';
  }

  private isHydrationConfigCurrent(
    expectedConfigKey: string,
    expectedGeneration: number,
  ): boolean {
    return (
      this.configGeneration === expectedGeneration &&
      this.currentConfigKey === expectedConfigKey &&
      buildPromptDebugTraceConfigKey(resolvePromptDebugTraceConfig()) ===
        expectedConfigKey
    );
  }

  private commitHydratedRecords(
    records: Map<string, PromptDebugTraceRecord>,
    config: PromptDebugTracePersistenceConfig,
    expectedConfigKey: string,
    expectedGeneration: number,
  ): void {
    if (
      !this.isHydrationConfigCurrent(
        expectedConfigKey,
        expectedGeneration,
      )
    ) {
      return;
    }

    for (const [requestId, hydratedRecord] of records.entries()) {
      const existing = this.byRequestId.get(requestId);
      if (
        !existing ||
        compareIsoTimestamp(existing.updatedAt, hydratedRecord.updatedAt) < 0
      ) {
        this.byRequestId.set(requestId, hydratedRecord);
      }
    }
    this.trimInMemory();
    this.hydratedStorageKey = buildPromptDebugStorageKey(config);
    this.hydratedStoragePath = config.persistence.storagePath;
  }

  private async performHydration(
    config: PromptDebugTracePersistenceConfig,
    expectedConfigKey: string,
    expectedGeneration: number,
  ): Promise<void> {
    const storagePath = config.persistence.storagePath;
    const hydratedRecords = new Map<string, PromptDebugTraceRecord>();
    try {
      const stats = await fsp.stat(storagePath);
      if (stats.size > config.persistence.maxBytes) {
        console.warn(
          '[prompt-debug] trace storage exceeds the configured byte limit; hydration skipped',
        );
        this.commitHydratedRecords(
          hydratedRecords,
          config,
          expectedConfigKey,
          expectedGeneration,
        );
        return;
      }
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode !== 'ENOENT') {
        console.error('[prompt-debug] failed to access trace storage');
      }
      this.commitHydratedRecords(
        hydratedRecords,
        config,
        expectedConfigKey,
        expectedGeneration,
      );
      return;
    }

    const input = fs.createReadStream(storagePath, {
      encoding: 'utf8',
      highWaterMark: 16 * 1024,
    });
    let bufferedLine = '';
    let bufferedLineBytes = 0;
    let discardingOversizedLine = false;
    let malformedLineObserved = false;
    let oversizedLineObserved = false;
    let hydrationByteLimitExceeded = false;
    let totalHydrationBytes = 0;
    let hydrationSucceeded = true;
    const contentMode = config.mode as Exclude<
      PromptDebugTraceContentMode,
      'off'
    >;

    const appendLineSegment = (segment: string): void => {
      if (discardingOversizedLine || segment.length === 0) {
        return;
      }
      const segmentBytes = Buffer.byteLength(segment, 'utf8');
      if (
        bufferedLineBytes + segmentBytes >
        MAX_PERSISTED_EVENT_BYTES
      ) {
        bufferedLine = '';
        bufferedLineBytes = 0;
        discardingOversizedLine = true;
        return;
      }
      bufferedLine += segment;
      bufferedLineBytes += segmentBytes;
    };

    const finishLine = (): void => {
      if (discardingOversizedLine) {
        oversizedLineObserved = true;
      } else {
        const result = this.applyPersistedLine(
          bufferedLine,
          contentMode,
          hydratedRecords,
        );
        malformedLineObserved ||= result === 'invalid';
      }
      bufferedLine = '';
      bufferedLineBytes = 0;
      discardingOversizedLine = false;
    };

    try {
      for await (const chunk of input) {
        const text = String(chunk);
        totalHydrationBytes += Buffer.byteLength(text, 'utf8');
        if (totalHydrationBytes > config.persistence.maxBytes) {
          hydrationByteLimitExceeded = true;
          hydrationSucceeded = false;
          break;
        }
        let offset = 0;
        let newlineIndex = text.indexOf('\n', offset);
        while (newlineIndex >= 0) {
          appendLineSegment(text.slice(offset, newlineIndex));
          finishLine();
          offset = newlineIndex + 1;
          newlineIndex = text.indexOf('\n', offset);
        }
        appendLineSegment(text.slice(offset));
      }
      if (bufferedLine.length > 0 || discardingOversizedLine) {
        finishLine();
      }
    } catch {
      hydrationSucceeded = false;
      console.error('[prompt-debug] failed to hydrate traces');
    } finally {
      input.destroy();
    }

    if (malformedLineObserved) {
      console.warn('[prompt-debug] skipped malformed persisted trace lines');
    }
    if (oversizedLineObserved) {
      console.warn(
        '[prompt-debug] skipped persisted trace lines exceeding the per-event byte limit',
      );
    }
    if (hydrationByteLimitExceeded) {
      console.warn(
        '[prompt-debug] trace storage exceeded the configured byte limit during hydration; hydration skipped',
      );
    }
    if (hydrationSucceeded) {
      this.commitHydratedRecords(
        hydratedRecords,
        config,
        expectedConfigKey,
        expectedGeneration,
      );
    }
  }

  private async hydrateFromDisk(
    config: PromptDebugTracePersistenceConfig,
    expectedGeneration: number,
  ): Promise<void> {
    const storageKey = buildPromptDebugStorageKey(config);
    if (this.hydratedStorageKey === storageKey) {
      return;
    }

    if (!this.hydrationPromise) {
      const expectedConfigKey = buildPromptDebugTraceConfigKey(config);
      this.hydrationPromise = this.performHydration(
        config,
        expectedConfigKey,
        expectedGeneration,
      );
    }

    const hydrationPromise = this.hydrationPromise;
    try {
      await hydrationPromise;
    } finally {
      if (this.hydrationPromise === hydrationPromise) {
        this.hydrationPromise = null;
      }
    }
  }

  private trimInMemory(
    target: Map<string, PromptDebugTraceRecord> = this.byRequestId,
  ): void {
    if (target.size <= MAX_IN_MEMORY_TRACES) {
      return;
    }

    const records = Array.from(target.values())
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const recordsToDelete = records.slice(0, Math.max(0, records.length - MAX_IN_MEMORY_TRACES));
    for (const record of recordsToDelete) {
      target.delete(record.requestId);
    }
  }

  upsert(requestId: string, stage: PromptDebugStage, patch: PromptDebugTracePatch): PromptDebugTraceRecord {
    const config = resolvePromptDebugTraceConfig();
    const configGeneration = this.applyConfig(config);
    if (config.mode === 'off' || !PROMPT_DEBUG_STAGES.has(stage)) {
      return buildEmptyTraceRecord(requestId, 'off');
    }

    const persistedEvent = buildPersistedStageEvent(
      requestId,
      stage,
      new Date().toISOString(),
      patch,
      config.mode,
    );
    const nextRecord = this.applyPersistedEvent(
      persistedEvent,
      config.mode,
    );
    if (config.persistence.enabled) {
      this.queuePersistedLine({
        contentMode: config.mode,
        configGeneration,
        configKey: buildPromptDebugTraceConfigKey(config),
        line: `${JSON.stringify(persistedEvent)}\n`,
        storagePath: config.persistence.storagePath,
        maxBytes: config.persistence.maxBytes,
      });
    }
    return cloneTraceRecord(nextRecord);
  }

  async list(limit = DEFAULT_LIST_LIMIT, requestId?: string): Promise<PromptDebugTraceRecord[]> {
    let stableConfig: PromptDebugTraceConfig | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const config = resolvePromptDebugTraceConfig();
      const generation = this.applyConfig(config);
      if (config.mode === 'off' || !config.persistence.enabled) {
        stableConfig = config;
        break;
      }

      const persistenceConfig = config as PromptDebugTracePersistenceConfig;
      if (
        this.hydratedStorageKey ===
        buildPromptDebugStorageKey(persistenceConfig)
      ) {
        stableConfig = config;
        break;
      }
      await this.hydrateFromDisk(persistenceConfig, generation);
    }

    if (stableConfig === null || stableConfig.mode === 'off') {
      return [];
    }

    const normalizedLimit = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(limit)));
    const normalizedRequestId =
      typeof requestId === 'string' ? normalizeRequestId(requestId) : undefined;
    const records = Array.from(this.byRequestId.values())
      .filter(record => !normalizedRequestId || record.requestId === normalizedRequestId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, normalizedLimit);

    return records.map(record => cloneTraceRecord(record));
  }

  async latest(requestId?: string): Promise<PromptDebugTraceRecord | null> {
    const [latestRecord] = await this.list(1, requestId);
    return latestRecord ?? null;
  }

  async flush(): Promise<void> {
    this.applyConfig(resolvePromptDebugTraceConfig());
    if (
      this.pendingPersistedLines.length === 0 &&
      this.persistFlushPromise === null
    ) {
      return;
    }
    if (!this.persistFlushPromise) {
      this.ensurePersistFlushLoop();
    }
    await this.persistFlushPromise;
  }

  async clear(): Promise<void> {
    this.configGeneration += 1;
    this.currentConfig = null;
    this.currentConfigKey = null;
    const activeHydration = this.hydrationPromise;
    if (activeHydration) {
      await activeHydration;
    }
    this.ensurePersistFlushLoop();
    await this.persistFlushPromise;
    this.discardPendingPersistence();
    this.persistFlushPromise = null;
    this.byRequestId.clear();
    this.hydratedStorageKey = null;
    this.hydratedStoragePath = null;
    this.hydrationPromise = null;
    this.persistenceCapWarningEmitted = false;
    this.persistenceEventWarningEmitted = false;
    const storagePath = resolveStoragePath(process.env);
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
    this.configGeneration += 1;
    this.currentConfig = null;
    this.currentConfigKey = null;
    const activeHydration = this.hydrationPromise;
    if (activeHydration) {
      await activeHydration;
    }
    this.byRequestId.clear();
    this.hydratedStorageKey = null;
    this.hydratedStoragePath = null;
    this.hydrationPromise = null;
    await this.list();
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

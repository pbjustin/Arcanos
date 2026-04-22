export type GptRouteExecutionPath = 'fast_path' | 'orchestrated_path';

export type GptFastPathModeHint = 'fast' | 'orchestrated' | null;

export interface GptFastPathDecision {
  path: GptRouteExecutionPath;
  eligible: boolean;
  reason: string;
  queueBypassed: boolean;
  promptLength: number;
  messageCount: number;
  maxWords: number | null;
  action: string | null;
  promptGenerationIntent: boolean;
  explicitMode: GptFastPathModeHint;
}

export interface GptFastPathConfig {
  enabled: boolean;
  maxPromptChars: number;
  maxMessageCount: number;
  maxWords: number;
  gptAllowlist: string[];
}

export interface ClassifyGptFastPathInput {
  gptId: string;
  body: unknown;
  promptText: string | null;
  requestedAction: string | null;
  routeTimeoutProfile: 'default' | 'dag_execution';
  explicitMode?: GptFastPathModeHint;
  hasExplicitIdempotencyKey?: boolean;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_FAST_PATH_MAX_PROMPT_CHARS = 900;
const DEFAULT_FAST_PATH_MAX_MESSAGE_COUNT = 3;
const DEFAULT_FAST_PATH_MAX_WORDS = 350;

const HEAVY_REQUEST_FIELDS = new Set([
  'attachments',
  'audio',
  'dag',
  'dagRunId',
  'executionPlan',
  'file',
  'files',
  'image',
  'images',
  'longRunning',
  'research',
  'toolChoice',
  'tool_choice',
  'tools',
  'webSearch',
  'web_search',
  'workflow',
  'workflowId'
]);

const PROMPT_GENERATION_PATTERNS = [
  /\b(generate|create|write|draft|compose|make|build)\s+(?:me\s+|a\s+|an\s+|the\s+)?(?:[\w-]+\s+){0,6}prompt\b/i,
  /\b(?:image|video|system|assistant|ai|chatgpt|midjourney|stable diffusion|logo|marketing|copywriting)\s+prompt\b/i,
  /\bprompt\s+(?:for|about|that|to|which|generator|template)\b/i,
  /\bturn\s+.+\s+into\s+(?:a\s+|an\s+)?prompt\b/i
];

function readBooleanEnv(name: string, fallbackValue: boolean, env: NodeJS.ProcessEnv): boolean {
  const normalized = (env[name] ?? '').trim().toLowerCase();
  if (!normalized) {
    return fallbackValue;
  }

  return normalized !== 'false' && normalized !== '0' && normalized !== 'no' && normalized !== 'off';
}

function readPositiveIntegerEnv(name: string, fallbackValue: number, env: NodeJS.ProcessEnv): number {
  const parsedValue = Number(env[name]);
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? Math.trunc(parsedValue)
    : fallbackValue;
}

function parseCsvEnv(name: string, env: NodeJS.ProcessEnv): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

export function resolveGptFastPathConfig(
  env: NodeJS.ProcessEnv = process.env
): GptFastPathConfig {
  return {
    enabled: readBooleanEnv('GPT_FAST_PATH_ENABLED', true, env),
    maxPromptChars: readPositiveIntegerEnv(
      'GPT_FAST_PATH_MAX_PROMPT_CHARS',
      DEFAULT_FAST_PATH_MAX_PROMPT_CHARS,
      env
    ),
    maxMessageCount: readPositiveIntegerEnv(
      'GPT_FAST_PATH_MAX_MESSAGE_COUNT',
      DEFAULT_FAST_PATH_MAX_MESSAGE_COUNT,
      env
    ),
    maxWords: readPositiveIntegerEnv(
      'GPT_FAST_PATH_MAX_WORDS',
      DEFAULT_FAST_PATH_MAX_WORDS,
      env
    ),
    gptAllowlist: parseCsvEnv('GPT_FAST_PATH_GPT_ALLOWLIST', env)
  };
}

function normalizeBodyRecord(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
}

function countMessages(body: unknown): number {
  const bodyRecord = normalizeBodyRecord(body);
  return Array.isArray(bodyRecord?.messages) ? bodyRecord.messages.length : 0;
}

function readMaxWords(body: unknown): number | null {
  const bodyRecord = normalizeBodyRecord(body);
  const candidates = [bodyRecord?.maxWords, bodyRecord?.max_words];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return Math.trunc(candidate);
    }
  }

  return null;
}

function readAnswerMode(body: unknown): string | null {
  const bodyRecord = normalizeBodyRecord(body);
  return typeof bodyRecord?.answerMode === 'string' && bodyRecord.answerMode.trim().length > 0
    ? bodyRecord.answerMode.trim().toLowerCase()
    : null;
}

function hasHeavyRequestField(body: unknown): boolean {
  const bodyRecord = normalizeBodyRecord(body);
  if (!bodyRecord) {
    return false;
  }

  return Object.keys(bodyRecord).some((key) => HEAVY_REQUEST_FIELDS.has(key));
}

function hasNonEmptyPayload(body: unknown): boolean {
  const bodyRecord = normalizeBodyRecord(body);
  if (!bodyRecord || bodyRecord.payload === undefined || bodyRecord.payload === null) {
    return false;
  }

  if (typeof bodyRecord.payload !== 'object' || Array.isArray(bodyRecord.payload)) {
    return true;
  }

  return Object.keys(bodyRecord.payload as Record<string, unknown>).length > 0;
}

export function hasPromptGenerationIntent(promptText: string | null): boolean {
  if (!promptText) {
    return false;
  }

  return PROMPT_GENERATION_PATTERNS.some((pattern) => pattern.test(promptText));
}

function buildDecision(input: {
  path: GptRouteExecutionPath;
  reason: string;
  promptLength: number;
  messageCount: number;
  maxWords: number | null;
  action: string | null;
  promptGenerationIntent: boolean;
  explicitMode: GptFastPathModeHint;
}): GptFastPathDecision {
  const eligible = input.path === 'fast_path';
  return {
    path: input.path,
    eligible,
    reason: input.reason,
    queueBypassed: eligible,
    promptLength: input.promptLength,
    messageCount: input.messageCount,
    maxWords: input.maxWords,
    action: input.action,
    promptGenerationIntent: input.promptGenerationIntent,
    explicitMode: input.explicitMode
  };
}

export function classifyGptFastPathRequest(
  input: ClassifyGptFastPathInput
): GptFastPathDecision {
  const config = resolveGptFastPathConfig(input.env ?? process.env);
  const promptLength = input.promptText?.length ?? 0;
  const messageCount = countMessages(input.body);
  const maxWords = readMaxWords(input.body);
  const action = input.requestedAction;
  const explicitMode = input.explicitMode ?? null;
  const promptGenerationIntent = hasPromptGenerationIntent(input.promptText);
  const common = {
    promptLength,
    messageCount,
    maxWords,
    action,
    promptGenerationIntent,
    explicitMode
  };

  if (!config.enabled) {
    return buildDecision({ ...common, path: 'orchestrated_path', reason: 'fast_path_disabled' });
  }

  if (explicitMode === 'orchestrated') {
    return buildDecision({ ...common, path: 'orchestrated_path', reason: 'explicit_orchestrated_mode' });
  }

  if (!input.promptText) {
    return buildDecision({ ...common, path: 'orchestrated_path', reason: 'missing_prompt' });
  }

  if (input.hasExplicitIdempotencyKey) {
    return buildDecision({ ...common, path: 'orchestrated_path', reason: 'idempotency_requires_durable_job' });
  }

  if (config.gptAllowlist.length > 0 && !config.gptAllowlist.includes(input.gptId.trim().toLowerCase())) {
    return buildDecision({ ...common, path: 'orchestrated_path', reason: 'gpt_not_fast_path_allowlisted' });
  }

  if (action) {
    return buildDecision({ ...common, path: 'orchestrated_path', reason: 'explicit_action_preserves_async_bridge' });
  }

  if (!promptGenerationIntent) {
    return buildDecision({ ...common, path: 'orchestrated_path', reason: 'no_prompt_generation_intent' });
  }

  if (input.routeTimeoutProfile === 'dag_execution') {
    return buildDecision({ ...common, path: 'orchestrated_path', reason: 'dag_execution_intent' });
  }

  if (promptLength > config.maxPromptChars) {
    return buildDecision({ ...common, path: 'orchestrated_path', reason: 'prompt_too_large' });
  }

  if (messageCount > config.maxMessageCount) {
    return buildDecision({ ...common, path: 'orchestrated_path', reason: 'too_many_messages' });
  }

  if (maxWords !== null && maxWords > config.maxWords) {
    return buildDecision({ ...common, path: 'orchestrated_path', reason: 'max_words_too_large' });
  }

  const answerMode = readAnswerMode(input.body);
  if (answerMode === 'audit' || answerMode === 'debug') {
    return buildDecision({ ...common, path: 'orchestrated_path', reason: 'diagnostic_answer_mode' });
  }

  if (hasHeavyRequestField(input.body)) {
    return buildDecision({ ...common, path: 'orchestrated_path', reason: 'heavy_request_field' });
  }

  if (hasNonEmptyPayload(input.body)) {
    return buildDecision({ ...common, path: 'orchestrated_path', reason: 'explicit_payload_requires_module_dispatch' });
  }

  return buildDecision({ ...common, path: 'fast_path', reason: explicitMode === 'fast' ? 'explicit_fast_mode' : 'simple_prompt_generation' });
}

import { isRecord } from '@shared/typeGuards.js';

export type DispatchTarget = 'gpt' | 'dag' | 'mcp' | 'tool' | 'auto';
export type DispatchExecutionMode = 'gpt' | 'dag' | 'tool' | 'auto';
export type DispatchClassifierMode = 'gpt' | 'dag';

export interface DispatchRequest {
  target?: DispatchTarget;
  gptId?: string;
  action?: string;
  executionMode?: DispatchExecutionMode;
  prompt?: string;
  payload?: Record<string, unknown>;
}

export interface DispatchIntentDecision {
  mode: DispatchClassifierMode;
  confidence: number;
  reason: string;
}

export type DispatchIntentClassifier = (input: {
  prompt?: string | null;
  action?: string | null;
  payload?: Record<string, unknown>;
}) => DispatchIntentDecision;

export interface NormalizedDispatchInput {
  body: Record<string, unknown>;
  payload: Record<string, unknown>;
  target: DispatchTarget;
  gptId: string | null;
  action: string;
  executionMode: DispatchExecutionMode;
  prompt: string;
}

export type DispatchLaneResolution =
  | {
      lane: 'dag';
      reason: string;
      input: NormalizedDispatchInput;
    }
  | {
      lane: 'gpt';
      reason: string;
      input: NormalizedDispatchInput;
    }
  | {
      lane: 'reject-control';
      reason: string;
      rejectionTarget: 'mcp' | 'tool';
      input: NormalizedDispatchInput;
    };

const VALID_TARGETS = new Set<DispatchTarget>(['gpt', 'dag', 'mcp', 'tool', 'auto']);
const VALID_EXECUTION_MODES = new Set<DispatchExecutionMode>(['gpt', 'dag', 'tool', 'auto']);

export const DAG_DISPATCH_CONFIDENCE_THRESHOLD = 0.85;
const EMPTY_PROMPT_GPT_CONFIDENCE = 0.5;
const CONTENT_OR_DIAGNOSTIC_GPT_CONFIDENCE = 0.78;
const DAG_EXECUTION_CONFIDENCE = 0.88;
const DAG_EXECUTION_WITH_QUALIFIER_CONFIDENCE = 0.92;
const SAFE_DEFAULT_GPT_CONFIDENCE = 0.55;

const NEGATIVE_DAG_INTENT_PATTERNS = [
  /\b(?:generate|draft|write|design|outline|describe|explain|document|propose|summarize|analyze)\b[\s\S]{0,80}\b(?:workflow|dag|orchestration|pipeline|job|trace|agent\s+process)\b/i,
  /\bcreate\b[\s\S]{0,80}\b(?:codex\s+prompt|prompt|workflow|plan)\b/i,
  /\bdiagnos(?:e|ing|is)\b[\s\S]{0,80}\b(?:dag|routing|orchestration|workflow|pipeline)\b/i,
  /\bexplain\b[\s\S]{0,80}\borchestration\b/i,
  /\bwrite\b[\s\S]{0,80}\bplan\b/i,
] as const;

const DAG_EXECUTION_VERB_PATTERN =
  /\b(?:run|execute|start|launch|schedule|resume|poll)\b/i;
const DAG_EXECUTION_SUBJECT_PATTERN =
  /\b(?:dag|workflow|pipeline|job|trace|agent\s+process)\b/i;
const DAG_HIGH_CONFIDENCE_QUALIFIER_PATTERN =
  /\b(?:now|live|real|actual|production|background|async|queued)\b/i;

function normalizeLiteral<T extends string>(
  value: unknown,
  allowed: Set<T>,
  fallback: T
): T {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase() as T;
  return allowed.has(normalized) ? normalized : fallback;
}

export function normalizeDispatchTarget(value: unknown): DispatchTarget {
  return normalizeLiteral(value, VALID_TARGETS, 'auto');
}

export function normalizeDispatchExecutionMode(value: unknown): DispatchExecutionMode {
  return normalizeLiteral(value, VALID_EXECUTION_MODES, 'gpt');
}

export function normalizeDispatchAction(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : 'query';
}

export function normalizeDispatchGptId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

export function normalizeDispatchPrompt(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function isDagDispatchAction(action: string | null | undefined): boolean {
  return typeof action === 'string' && action.trim().toLowerCase().startsWith('dag.');
}

function normalizeDispatchInput(rawBody: unknown): NormalizedDispatchInput {
  const body = isRecord(rawBody) ? rawBody : {};

  return {
    body,
    payload: isRecord(body.payload) ? body.payload : {},
    target: normalizeDispatchTarget(body.target),
    gptId: normalizeDispatchGptId(body.gptId),
    action: normalizeDispatchAction(body.action),
    executionMode: normalizeDispatchExecutionMode(body.executionMode),
    prompt: normalizeDispatchPrompt(body.prompt),
  };
}

/** Build the exact GPT body consumed after universal lane resolution. */
export function buildResolvedGptDispatchBody(
  input: NormalizedDispatchInput
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...input.body,
    action: input.action,
  };

  if (input.prompt) {
    body.prompt = input.prompt;
  }

  if (input.action === 'trackStoryline') {
    body.payload = Object.prototype.hasOwnProperty.call(input.body, 'payload')
      ? input.body.payload
      : {};
  } else if (Object.keys(input.payload).length > 0) {
    body.payload = input.payload;
  }

  delete body.target;
  delete body.gptId;
  return body;
}

/**
 * Classify only auto-mode dispatch prompts. The classifier is intentionally
 * conservative: content-generation prompts about workflows stay on GPT.
 */
export function classifyDispatchIntent(input: {
  prompt?: string | null;
  action?: string | null;
  payload?: Record<string, unknown>;
}): DispatchIntentDecision {
  const prompt = input.prompt?.trim() ?? '';
  if (!prompt) {
    return {
      mode: 'gpt',
      confidence: EMPTY_PROMPT_GPT_CONFIDENCE,
      reason: 'empty_prompt_default_gpt',
    };
  }

  if (NEGATIVE_DAG_INTENT_PATTERNS.some((pattern) => pattern.test(prompt))) {
    return {
      mode: 'gpt',
      confidence: CONTENT_OR_DIAGNOSTIC_GPT_CONFIDENCE,
      reason: 'content_or_diagnostic_workflow_prompt',
    };
  }

  if (
    DAG_EXECUTION_VERB_PATTERN.test(prompt) &&
    DAG_EXECUTION_SUBJECT_PATTERN.test(prompt)
  ) {
    return {
      mode: 'dag',
      confidence: DAG_HIGH_CONFIDENCE_QUALIFIER_PATTERN.test(prompt)
        ? DAG_EXECUTION_WITH_QUALIFIER_CONFIDENCE
        : DAG_EXECUTION_CONFIDENCE,
      reason: 'explicit_dag_execution_intent',
    };
  }

  return {
    mode: 'gpt',
    confidence: SAFE_DEFAULT_GPT_CONFIDENCE,
    reason: 'safe_default_gpt',
  };
}

/** Resolve the compatibility dispatcher lane once, without performing I/O. */
export function resolveDispatchLane(
  rawBody: unknown,
  classifyIntent: DispatchIntentClassifier = classifyDispatchIntent
): DispatchLaneResolution {
  const input = normalizeDispatchInput(rawBody);

  if (input.target === 'dag') {
    return { lane: 'dag', reason: 'explicit_target_dag', input };
  }

  if (input.target === 'gpt') {
    return { lane: 'gpt', reason: 'explicit_target_gpt', input };
  }

  if (input.target === 'mcp' || input.target === 'tool') {
    return {
      lane: 'reject-control',
      reason: `explicit_target_${input.target}`,
      rejectionTarget: input.target,
      input,
    };
  }

  if (input.gptId) {
    return { lane: 'gpt', reason: 'explicit_gpt_id', input };
  }

  if (isDagDispatchAction(input.action)) {
    return { lane: 'dag', reason: 'explicit_dag_action', input };
  }

  if (input.executionMode === 'dag') {
    return { lane: 'dag', reason: 'explicit_execution_mode_dag', input };
  }

  if (input.executionMode === 'tool') {
    return {
      lane: 'reject-control',
      reason: 'explicit_execution_mode_tool',
      rejectionTarget: 'tool',
      input,
    };
  }

  if (input.executionMode === 'gpt') {
    return { lane: 'gpt', reason: 'explicit_execution_mode_gpt', input };
  }

  const decision = classifyIntent({
    prompt: input.prompt,
    action: input.action,
    payload: input.payload,
  });
  if (
    decision.mode === 'dag'
    && decision.confidence >= DAG_DISPATCH_CONFIDENCE_THRESHOLD
  ) {
    return {
      lane: 'dag',
      reason: `${decision.reason}:${decision.confidence}`,
      input,
    };
  }

  return { lane: 'gpt', reason: 'safe_fallback_gpt', input };
}

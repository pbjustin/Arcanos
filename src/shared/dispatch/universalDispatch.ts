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

const VALID_TARGETS = new Set<DispatchTarget>(['gpt', 'dag', 'mcp', 'tool', 'auto']);
const VALID_EXECUTION_MODES = new Set<DispatchExecutionMode>(['gpt', 'dag', 'tool', 'auto']);

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
      confidence: 0.5,
      reason: 'empty_prompt_default_gpt',
    };
  }

  if (NEGATIVE_DAG_INTENT_PATTERNS.some((pattern) => pattern.test(prompt))) {
    return {
      mode: 'gpt',
      confidence: 0.78,
      reason: 'content_or_diagnostic_workflow_prompt',
    };
  }

  if (
    DAG_EXECUTION_VERB_PATTERN.test(prompt) &&
    DAG_EXECUTION_SUBJECT_PATTERN.test(prompt)
  ) {
    return {
      mode: 'dag',
      confidence: DAG_HIGH_CONFIDENCE_QUALIFIER_PATTERN.test(prompt) ? 0.92 : 0.88,
      reason: 'explicit_dag_execution_intent',
    };
  }

  return {
    mode: 'gpt',
    confidence: 0.55,
    reason: 'safe_default_gpt',
  };
}

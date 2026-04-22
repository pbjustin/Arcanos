import type { GptDirectControlAction } from './gptControlActions.js';

export const GPT_EXECUTION_PLAN_DETAILS = ['summary', 'standard', 'full'] as const;

export type GptExecutionPlanDetail = (typeof GPT_EXECUTION_PLAN_DETAILS)[number];
export type GptExecutionPlanSource = 'explicit' | 'planner';
export type GptPlannableControlAction =
  | 'runtime.inspect'
  | 'workers.status'
  | 'queue.inspect'
  | 'self_heal.status';

export interface GptExecutionPlan<Action extends GptPlannableControlAction = GptPlannableControlAction> {
  action: Action;
  detail: GptExecutionPlanDetail;
  sections: string[];
  shouldUseAsync: boolean;
  source: GptExecutionPlanSource;
}

export interface GptControlResponseMeta {
  detail: GptExecutionPlanDetail;
  truncated: boolean;
  availableSections: string[];
  returnedSections?: string[];
  omittedSections?: string[];
  generatedAt: string;
  source: GptExecutionPlanSource;
}

type PlannerErrorCode = 'INVALID_GPT_DETAIL' | 'INVALID_GPT_SECTIONS';

type PlannerErrorResult = {
  ok: false;
  error: {
    code: PlannerErrorCode;
    message: string;
  };
  canonical: Record<string, unknown>;
};

type PlannerSuccessResult<Action extends GptPlannableControlAction> = {
  ok: true;
  plan: GptExecutionPlan<Action>;
  availableSections: string[];
};

export type GptExecutionPlannerResult<Action extends GptPlannableControlAction> =
  | PlannerSuccessResult<Action>
  | PlannerErrorResult;

export interface GptExecutionPlannerInput<Action extends GptPlannableControlAction = GptPlannableControlAction> {
  action: Action;
  promptText?: string | null;
  payload?: unknown;
}

export interface GptExecutionPlanner {
  plan<Action extends GptPlannableControlAction>(
    input: GptExecutionPlannerInput<Action>
  ): GptExecutionPlannerResult<Action>;
}

const GPT_EXECUTION_PLAN_SECTION_ALLOWLIST: Record<GptPlannableControlAction, readonly string[]> = {
  'runtime.inspect': ['workers', 'queues', 'memory', 'incidents', 'events', 'trace'],
  'workers.status': ['workers', 'queues', 'incidents'],
  'queue.inspect': ['queues', 'incidents'],
  'self_heal.status': ['system', 'workers', 'memory', 'incidents', 'events', 'trace', 'predictive'],
};

const SUMMARY_DETAIL_PATTERN =
  /\b(?:brief|briefly|summary|summarize|overview|healthy|health|compact|high[-\s]?level)\b/i;
const INVESTIGATIVE_DETAIL_PATTERN =
  /\b(?:why|analy[sz]e|analysis|investigat(?:e|ion|ing)|debug|issue|problem|incident|failure|failing|stuck|degraded|degradation|triage)\b/i;
const FULL_DETAIL_PATTERN =
  /\b(?:full|complete|raw|everything|all\s+details|near[-\s]?complete)\b/i;

const SECTION_CUE_PATTERNS: Array<{
  section: string;
  pattern: RegExp;
}> = [
  { section: 'workers', pattern: /\bworkers?\b/i },
  { section: 'queues', pattern: /\bqueues?\b|\bqueue\b/i },
  { section: 'memory', pattern: /\bmemory\b|\bheap\b|\brss\b/i },
  { section: 'incidents', pattern: /\bincident(?:s)?\b|\bfailure(?:s)?\b|\berror(?:s)?\b|\balerts?\b/i },
  { section: 'events', pattern: /\bevents?\b|\blogs?\b/i },
  { section: 'trace', pattern: /\btrace\b|\btimeline\b|\bhistory\b/i },
  { section: 'system', pattern: /\bsystem\b|\bhealth\b/i },
  { section: 'predictive', pattern: /\bpredictive\b|\bforecast\b|\btrend(?:s)?\b/i },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePrompt(promptText: string | null | undefined): string {
  return typeof promptText === 'string' ? promptText.trim() : '';
}

function normalizeDetail(detail: unknown): GptExecutionPlanDetail | null {
  return typeof detail === 'string' && detail.trim().length > 0
    ? (GPT_EXECUTION_PLAN_DETAILS.find((value) => value === detail.trim().toLowerCase()) ?? null)
    : null;
}

function normalizeBooleanLike(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }

  return null;
}

function readPlannerPayloadRecord(payload: unknown): Record<string, unknown> | null {
  return isRecord(payload) ? payload : null;
}

function inferDetailFromPrompt(
  action: GptPlannableControlAction,
  promptText: string,
): GptExecutionPlanDetail {
  if (FULL_DETAIL_PATTERN.test(promptText)) {
    return 'full';
  }

  if (SUMMARY_DETAIL_PATTERN.test(promptText) && !INVESTIGATIVE_DETAIL_PATTERN.test(promptText)) {
    return 'summary';
  }

  const inferredSections = inferSectionsFromPrompt(action, promptText);
  if (INVESTIGATIVE_DETAIL_PATTERN.test(promptText) || inferredSections.length > 0) {
    return 'standard';
  }

  if (action === 'runtime.inspect' || action === 'self_heal.status') {
    return 'summary';
  }

  return 'standard';
}

function inferSectionsFromPrompt(
  action: GptPlannableControlAction,
  promptText: string,
): string[] {
  const availableSections = getGptExecutionPlanAvailableSections(action);
  if (availableSections.length === 0 || !promptText) {
    return [];
  }

  const matchedSections = SECTION_CUE_PATTERNS
    .filter((entry) => entry.pattern.test(promptText))
    .map((entry) => entry.section)
    .filter((section) => availableSections.includes(section));

  return Array.from(new Set(matchedSections));
}

function defaultSectionsForPlan(
  action: GptPlannableControlAction,
  detail: GptExecutionPlanDetail,
): string[] {
  switch (action) {
    case 'runtime.inspect':
      if (detail === 'summary') {
        return ['workers', 'queues', 'memory', 'incidents'];
      }
      if (detail === 'standard') {
        return ['workers', 'queues', 'memory', 'incidents', 'events'];
      }
      return [...GPT_EXECUTION_PLAN_SECTION_ALLOWLIST[action]];
    case 'self_heal.status':
      if (detail === 'summary') {
        return ['system', 'incidents', 'workers', 'memory'];
      }
      if (detail === 'standard') {
        return ['system', 'incidents', 'workers', 'memory', 'events', 'trace'];
      }
      return [...GPT_EXECUTION_PLAN_SECTION_ALLOWLIST[action]];
    case 'workers.status':
      return detail === 'summary'
        ? ['workers', 'queues', 'incidents']
        : [...GPT_EXECUTION_PLAN_SECTION_ALLOWLIST[action]];
    case 'queue.inspect':
      return detail === 'summary'
        ? ['queues', 'incidents']
        : [...GPT_EXECUTION_PLAN_SECTION_ALLOWLIST[action]];
  }
}

function inferShouldUseAsync(
  action: GptPlannableControlAction,
  detail: GptExecutionPlanDetail,
  sections: string[],
  promptText: string,
): boolean {
  if (detail !== 'full') {
    return false;
  }

  if (action !== 'runtime.inspect' && action !== 'self_heal.status') {
    return false;
  }

  return sections.includes('events') ||
    sections.includes('trace') ||
    /\b(?:full|complete|raw|everything|history|trace|timeline)\b/i.test(promptText);
}

function readExplicitShouldUseAsync(payloadRecord: Record<string, unknown> | null): boolean | null {
  if (!payloadRecord) {
    return null;
  }

  const executionMode = payloadRecord.executionMode;
  if (typeof executionMode === 'string') {
    const normalizedExecutionMode = executionMode.trim().toLowerCase();
    if (normalizedExecutionMode === 'async') {
      return true;
    }
    if (normalizedExecutionMode === 'sync') {
      return false;
    }
  }

  return normalizeBooleanLike(payloadRecord.async);
}

function invalidDetailResult(
  action: GptPlannableControlAction,
  availableSections: string[],
  detail: unknown,
): PlannerErrorResult {
  return {
    ok: false,
    error: {
      code: 'INVALID_GPT_DETAIL',
      message: `Unsupported detail '${String(detail)}'. Supported detail values: ${GPT_EXECUTION_PLAN_DETAILS.join(', ')}.`,
    },
    canonical: {
      action,
      supportedDetail: GPT_EXECUTION_PLAN_DETAILS.join(', '),
      availableSections,
    },
  };
}

function invalidSectionsResult(
  action: GptPlannableControlAction,
  availableSections: string[],
  sections: unknown,
): PlannerErrorResult {
  return {
    ok: false,
    error: {
      code: 'INVALID_GPT_SECTIONS',
      message: `Unsupported sections for action '${action}'. Supported sections: ${availableSections.join(', ') || '(none)'}.`,
    },
    canonical: {
      action,
      supportedSections: availableSections,
      receivedSections: sections,
    },
  };
}

function normalizeSections(
  action: GptPlannableControlAction,
  sections: unknown,
): { ok: true; sections: string[] } | PlannerErrorResult {
  const availableSections = getGptExecutionPlanAvailableSections(action);
  if (sections === undefined || sections === null) {
    return {
      ok: true,
      sections: [],
    };
  }

  if (!Array.isArray(sections)) {
    return invalidSectionsResult(action, availableSections, sections);
  }

  const normalizedSections = Array.from(
    new Set(
      sections
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim().toLowerCase())
    )
  );

  const unsupportedSections = normalizedSections.filter(
    (section) => !availableSections.includes(section)
  );
  if (unsupportedSections.length > 0) {
    return invalidSectionsResult(action, availableSections, normalizedSections);
  }

  return {
    ok: true,
    sections: normalizedSections,
  };
}

export function isPlannableGptControlAction(
  action: GptDirectControlAction
): action is GptPlannableControlAction {
  return action === 'runtime.inspect' ||
    action === 'workers.status' ||
    action === 'queue.inspect' ||
    action === 'self_heal.status';
}

export function getGptExecutionPlanAvailableSections(
  action: GptPlannableControlAction,
): string[] {
  return [...GPT_EXECUTION_PLAN_SECTION_ALLOWLIST[action]];
}

export function buildGptControlResponseMeta(params: {
  plan: GptExecutionPlan;
  generatedAt?: string;
  availableSections: string[];
  truncated: boolean;
  returnedSections?: string[];
  omittedSections?: string[];
}): GptControlResponseMeta {
  return {
    detail: params.plan.detail,
    truncated: params.truncated,
    availableSections: [...params.availableSections],
    ...(params.returnedSections
      ? { returnedSections: [...params.returnedSections] }
      : {}),
    ...(params.omittedSections
      ? { omittedSections: [...params.omittedSections] }
      : {}),
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    source: params.plan.source,
  };
}

function planWithRules<Action extends GptPlannableControlAction>(
  input: GptExecutionPlannerInput<Action>
): GptExecutionPlannerResult<Action> {
  const payloadRecord = readPlannerPayloadRecord(input.payload);
  const normalizedPrompt = normalizePrompt(input.promptText);
  const availableSections = getGptExecutionPlanAvailableSections(input.action);
  const explicitDetail = payloadRecord ? payloadRecord.detail : undefined;
  const normalizedExplicitDetail = normalizeDetail(explicitDetail);

  if (explicitDetail !== undefined && normalizedExplicitDetail === null) {
    return invalidDetailResult(input.action, availableSections, explicitDetail);
  }

  const explicitSections = normalizeSections(input.action, payloadRecord?.sections);
  if (!explicitSections.ok) {
    return explicitSections;
  }

  const inferredDetail =
    normalizedExplicitDetail ??
    inferDetailFromPrompt(input.action, normalizedPrompt);
  const inferredSections =
    explicitSections.sections.length > 0
      ? explicitSections.sections
      : inferSectionsFromPrompt(input.action, normalizedPrompt);
  const plannedSections =
    inferredSections.length > 0
      ? inferredSections
      : defaultSectionsForPlan(input.action, inferredDetail);
  const explicitShouldUseAsync = readExplicitShouldUseAsync(payloadRecord);
  const plan: GptExecutionPlan<Action> = {
    action: input.action,
    detail: inferredDetail,
    sections: plannedSections,
    shouldUseAsync:
      explicitShouldUseAsync ??
      inferShouldUseAsync(input.action, inferredDetail, plannedSections, normalizedPrompt),
    source:
      normalizedExplicitDetail !== null || explicitSections.sections.length > 0
        ? 'explicit'
        : 'planner',
  };

  return {
    ok: true,
    plan,
    availableSections,
  };
}

const ruleBasedGptExecutionPlanner: GptExecutionPlanner = {
  plan: planWithRules,
};

export function planGptControlExecution<Action extends GptPlannableControlAction>(
  input: GptExecutionPlannerInput<Action>
): GptExecutionPlannerResult<Action> {
  // TODO: Allow an AI-assisted planner to implement the same interface after allowlist validation,
  // response guards, and direct-control safety checks stay fixed at this boundary.
  return ruleBasedGptExecutionPlanner.plan(input);
}

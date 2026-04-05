import { AsyncLocalStorage } from 'node:async_hooks';

import {
  recordAiBudgetExceeded,
  recordAiOperation,
} from '@platform/observability/appMetrics.js';

export type AiExecutionSourceType = 'route' | 'job' | 'background' | 'unknown';

export interface AiExecutionBudget {
  maxCalls?: number;
  maxPromptTokens?: number;
  maxCompletionTokens?: number;
  maxTotalTokens?: number;
}

export interface AiUsageTotals {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AiExecutionContext {
  provider: 'openai';
  sourceType: AiExecutionSourceType;
  sourceName: string;
  requestId?: string;
  traceId?: string;
  jobId?: string;
  budget?: AiExecutionBudget;
  totals: AiUsageTotals;
  operationCounts: Record<string, number>;
  models: Record<string, number>;
}

export interface AiExecutionSummary {
  provider: 'openai';
  sourceType: AiExecutionSourceType;
  sourceName: string;
  requestId?: string;
  traceId?: string;
  jobId?: string;
  budget?: AiExecutionBudget;
  totals: AiUsageTotals;
  operationCounts: Record<string, number>;
  models: Record<string, number>;
}

interface AiOperationUsageInput {
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
}

const aiExecutionStorage = new AsyncLocalStorage<AiExecutionContext>();

function normalizePositiveInteger(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function normalizeUsageTotals(usage?: AiOperationUsageInput | null): AiUsageTotals {
  const promptTokens = normalizePositiveInteger(usage?.promptTokens);
  const completionTokens = normalizePositiveInteger(usage?.completionTokens);
  const totalTokensCandidate = normalizePositiveInteger(usage?.totalTokens);
  const totalTokens =
    totalTokensCandidate > 0 ? totalTokensCandidate : promptTokens + completionTokens;

  return {
    calls: 0,
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function cloneBudget(budget?: AiExecutionBudget): AiExecutionBudget | undefined {
  if (!budget) {
    return undefined;
  }

  return { ...budget };
}

function cloneTotals(totals: AiUsageTotals): AiUsageTotals {
  return {
    calls: totals.calls,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    totalTokens: totals.totalTokens,
  };
}

function sanitizeSourceName(sourceName: string | null | undefined): string {
  if (typeof sourceName !== 'string') {
    return 'unknown';
  }

  const trimmed = sourceName.trim();
  return trimmed.length > 0 ? trimmed : 'unknown';
}

export function createAiExecutionContext(input: {
  sourceType?: AiExecutionSourceType;
  sourceName: string;
  requestId?: string;
  traceId?: string;
  jobId?: string;
  budget?: AiExecutionBudget;
}): AiExecutionContext {
  return {
    provider: 'openai',
    sourceType: input.sourceType ?? 'unknown',
    sourceName: sanitizeSourceName(input.sourceName),
    requestId: input.requestId,
    traceId: input.traceId,
    jobId: input.jobId,
    budget: cloneBudget(input.budget),
    totals: {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    operationCounts: {},
    models: {},
  };
}

export function runWithAiExecutionContext<T>(
  context: AiExecutionContext,
  callback: () => Promise<T> | T,
): Promise<T> | T {
  return aiExecutionStorage.run(context, callback);
}

export function getAiExecutionContext(): AiExecutionContext | null {
  return aiExecutionStorage.getStore() ?? null;
}

export function updateAiExecutionContext(update: {
  sourceType?: AiExecutionSourceType;
  sourceName?: string;
  requestId?: string;
  traceId?: string;
  jobId?: string;
  budget?: AiExecutionBudget;
}): AiExecutionContext | null {
  const activeContext = aiExecutionStorage.getStore();
  if (!activeContext) {
    return null;
  }

  if (update.sourceType) {
    activeContext.sourceType = update.sourceType;
  }
  if (update.sourceName) {
    activeContext.sourceName = sanitizeSourceName(update.sourceName);
  }
  if (update.requestId !== undefined) {
    activeContext.requestId = update.requestId;
  }
  if (update.traceId !== undefined) {
    activeContext.traceId = update.traceId;
  }
  if (update.jobId !== undefined) {
    activeContext.jobId = update.jobId;
  }
  if (update.budget) {
    activeContext.budget = {
      ...(activeContext.budget ?? {}),
      ...update.budget,
    };
  }

  return activeContext;
}

export function assertAiBudgetAllowsCall(operation: string, model?: string | null): void {
  const activeContext = aiExecutionStorage.getStore();
  if (!activeContext) {
    return;
  }

  const budget = activeContext.budget;
  if (budget?.maxPromptTokens && activeContext.totals.promptTokens >= budget.maxPromptTokens) {
    recordAiBudgetExceeded({
      provider: activeContext.provider,
      sourceType: activeContext.sourceType,
      sourceName: activeContext.sourceName,
      limitKind: 'prompt_tokens',
    });
    throw new Error(
      `AI prompt-token budget exceeded for ${activeContext.sourceType}:${activeContext.sourceName} during ${operation}.`,
    );
  }
  if (budget?.maxCompletionTokens && activeContext.totals.completionTokens >= budget.maxCompletionTokens) {
    recordAiBudgetExceeded({
      provider: activeContext.provider,
      sourceType: activeContext.sourceType,
      sourceName: activeContext.sourceName,
      limitKind: 'completion_tokens',
    });
    throw new Error(
      `AI completion-token budget exceeded for ${activeContext.sourceType}:${activeContext.sourceName} during ${operation}.`,
    );
  }
  if (budget?.maxTotalTokens && activeContext.totals.totalTokens >= budget.maxTotalTokens) {
    recordAiBudgetExceeded({
      provider: activeContext.provider,
      sourceType: activeContext.sourceType,
      sourceName: activeContext.sourceName,
      limitKind: 'total_tokens',
    });
    throw new Error(
      `AI total-token budget exceeded for ${activeContext.sourceType}:${activeContext.sourceName} during ${operation}.`,
    );
  }
  if (!budget?.maxCalls) {
    return;
  }

  if (activeContext.totals.calls + 1 <= budget.maxCalls) {
    return;
  }

  recordAiBudgetExceeded({
    provider: activeContext.provider,
    sourceType: activeContext.sourceType,
    sourceName: activeContext.sourceName,
    limitKind: 'calls',
  });

  const modelSuffix = typeof model === 'string' && model.trim().length > 0 ? ` (${model.trim()})` : '';
  throw new Error(
    `AI call budget exceeded for ${activeContext.sourceType}:${activeContext.sourceName} during ${operation}${modelSuffix}.`,
  );
}

export function recordAiOperationResult(input: {
  operation: string;
  outcome: string;
  durationMs: number;
  model?: string | null;
  usage?: AiOperationUsageInput | null;
}): void {
  const activeContext = aiExecutionStorage.getStore();
  const normalizedUsage = normalizeUsageTotals(input.usage);

  if (activeContext) {
    activeContext.totals.calls += 1;
    activeContext.totals.promptTokens += normalizedUsage.promptTokens;
    activeContext.totals.completionTokens += normalizedUsage.completionTokens;
    activeContext.totals.totalTokens += normalizedUsage.totalTokens;
    activeContext.operationCounts[input.operation] =
      (activeContext.operationCounts[input.operation] ?? 0) + 1;

    if (typeof input.model === 'string' && input.model.trim().length > 0) {
      const normalizedModel = input.model.trim();
      activeContext.models[normalizedModel] = (activeContext.models[normalizedModel] ?? 0) + 1;
    }

    if (
      activeContext.budget?.maxPromptTokens &&
      activeContext.totals.promptTokens > activeContext.budget.maxPromptTokens
    ) {
      recordAiBudgetExceeded({
        provider: activeContext.provider,
        sourceType: activeContext.sourceType,
        sourceName: activeContext.sourceName,
        limitKind: 'prompt_tokens',
      });
    }
    if (
      activeContext.budget?.maxCompletionTokens &&
      activeContext.totals.completionTokens > activeContext.budget.maxCompletionTokens
    ) {
      recordAiBudgetExceeded({
        provider: activeContext.provider,
        sourceType: activeContext.sourceType,
        sourceName: activeContext.sourceName,
        limitKind: 'completion_tokens',
      });
    }
    if (
      activeContext.budget?.maxTotalTokens &&
      activeContext.totals.totalTokens > activeContext.budget.maxTotalTokens
    ) {
      recordAiBudgetExceeded({
        provider: activeContext.provider,
        sourceType: activeContext.sourceType,
        sourceName: activeContext.sourceName,
        limitKind: 'total_tokens',
      });
    }
  }

  recordAiOperation({
    provider: activeContext?.provider ?? 'openai',
    operation: input.operation,
    sourceType: activeContext?.sourceType ?? 'unknown',
    sourceName: activeContext?.sourceName ?? 'unknown',
    model: input.model ?? null,
    outcome: input.outcome,
    durationMs: input.durationMs,
    promptTokens: normalizedUsage.promptTokens,
    completionTokens: normalizedUsage.completionTokens,
    totalTokens: normalizedUsage.totalTokens,
  });
}

export function summarizeAiExecutionContext(
  context: AiExecutionContext | null = aiExecutionStorage.getStore() ?? null,
): AiExecutionSummary | null {
  if (!context) {
    return null;
  }

  return {
    provider: context.provider,
    sourceType: context.sourceType,
    sourceName: context.sourceName,
    requestId: context.requestId,
    traceId: context.traceId,
    jobId: context.jobId,
    budget: cloneBudget(context.budget),
    totals: cloneTotals(context.totals),
    operationCounts: { ...context.operationCounts },
    models: { ...context.models },
  };
}

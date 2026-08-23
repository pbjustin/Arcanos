import { APPLICATION_CONSTANTS } from '../constants.js';
import {
  BACKSTAGE_BOOKING_HEAVY_CONTEXT_CODE_UNITS,
  BACKSTAGE_BOOKING_HEAVY_EXPECTED_WORDS,
  BACKSTAGE_BOOKING_HEAVY_PROMPT_CODE_UNITS,
  BACKSTAGE_CONTINUITY_QUERY_TOKEN_LIMIT,
  BACKSTAGE_GENERATION_TOKEN_LIMIT_DEFAULT,
  BACKSTAGE_GENERATION_TOKEN_LIMIT_MAX,
} from './backstageActionPolicy.js';
import type {
  BackstageExecutionBudgetProfile,
  BackstageGenerationAction,
} from './backstageExecutionBudget.js';

export const BACKSTAGE_WORKER_OUTPUT_TOKEN_LIMIT_DEFAULT = 6_000;
export const BACKSTAGE_WORKER_OUTPUT_TOKEN_LIMIT_MIN = 4_000;
export const BACKSTAGE_OUTPUT_TOKEN_LIMIT_MAX =
  APPLICATION_CONSTANTS.MAX_SAFE_TOKENS;
export const BACKSTAGE_EXTENDED_OUTPUT_STAGE_MIN_MS = 45_000;
export const BACKSTAGE_EXTENDED_OUTPUT_STAGE_MEDIUM_MS = 60_000;
export const BACKSTAGE_EXTENDED_OUTPUT_STAGE_FULL_MS = 75_000;
export const BACKSTAGE_EXTENDED_OUTPUT_STAGE_MIN_TOKEN_CAP = 4_000;
export const BACKSTAGE_EXTENDED_OUTPUT_STAGE_MEDIUM_TOKEN_CAP = 5_000;
export const BACKSTAGE_TRINITY_WATCHDOG_HEADROOM_MS = 1_000;

export type BackstageOutputFormat =
  | 'continuity'
  | 'compact_direct'
  | 'bounded_review'
  | 'structured_booking';

export type BackstageOutputBudgetClass =
  | 'continuity_small'
  | 'bounded_request'
  | 'queued_extended';

export type BackstageOutputModelCapability =
  | 'extended_gpt5'
  | 'baseline_fallback';

export type BackstageOutputBudgetReason =
  | 'continuity_profile'
  | 'bounded_request_profile'
  | 'compact_response_contract'
  | 'unsupported_extended_model'
  | 'insufficient_model_stage_budget'
  | 'queued_structured_generation';

export interface BackstageOutputBudgetInput {
  action: BackstageGenerationAction | 'queryContinuity';
  profile: BackstageExecutionBudgetProfile;
  requestedFormat: BackstageOutputFormat;
  requestedTokenLimit: number;
  configuredWorkerTokenLimit?: number;
  promptCodeUnits: number;
  retrievedContextCodeUnits: number;
  expectedOutputWords: number;
  model: string;
  modelStageTimeoutMs: number;
}

export interface BackstageOutputBudgetDecision {
  action: BackstageGenerationAction | 'queryContinuity';
  profile: BackstageExecutionBudgetProfile;
  requestedFormat: BackstageOutputFormat;
  budgetClass: BackstageOutputBudgetClass;
  reason: BackstageOutputBudgetReason;
  modelCapability: BackstageOutputModelCapability;
  tokenLimit: number;
  tokenCap: number;
  promptCodeUnits: number;
  retrievedContextCodeUnits: number;
  expectedOutputWords: number;
  modelStageTimeoutMs: number;
}

export type BackstageOutputBudgetTelemetry = Record<string, unknown>
  & BackstageOutputBudgetDecision;

function normalizePositiveInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function resolveBoundedRequestTokenLimit(value: number): number {
  const normalized = normalizePositiveInteger(value);
  return Math.min(
    normalized || BACKSTAGE_GENERATION_TOKEN_LIMIT_DEFAULT,
    BACKSTAGE_GENERATION_TOKEN_LIMIT_MAX
  );
}

function resolveConfiguredWorkerTokenLimit(value: number | undefined): number {
  const normalized = typeof value === 'number'
    ? normalizePositiveInteger(value)
    : 0;
  return Math.max(
    BACKSTAGE_WORKER_OUTPUT_TOKEN_LIMIT_MIN,
    Math.min(
      normalized || BACKSTAGE_WORKER_OUTPUT_TOKEN_LIMIT_DEFAULT,
      BACKSTAGE_OUTPUT_TOKEN_LIMIT_MAX
    )
  );
}

function resolveModelCapability(model: string): BackstageOutputModelCapability {
  const normalizedModel = model.trim().toLowerCase();
  const supportsBoundedExtendedOutput =
    /^gpt-5\.1(?:$|-\d{4}-\d{2}-\d{2}$)/.test(normalizedModel)
    || /^gpt-5\.6(?:$|-\d{4}-\d{2}-\d{2}$|-(?:sol|terra|luna)(?:-\d{4}-\d{2}-\d{2})?$)/
      .test(normalizedModel);
  return supportsBoundedExtendedOutput
    ? 'extended_gpt5'
    : 'baseline_fallback';
}

function resolveStageTokenCap(modelStageTimeoutMs: number): number {
  if (modelStageTimeoutMs < BACKSTAGE_EXTENDED_OUTPUT_STAGE_MIN_MS) {
    return BACKSTAGE_GENERATION_TOKEN_LIMIT_MAX;
  }
  if (modelStageTimeoutMs < BACKSTAGE_EXTENDED_OUTPUT_STAGE_MEDIUM_MS) {
    return BACKSTAGE_EXTENDED_OUTPUT_STAGE_MIN_TOKEN_CAP;
  }
  if (modelStageTimeoutMs < BACKSTAGE_EXTENDED_OUTPUT_STAGE_FULL_MS) {
    return BACKSTAGE_EXTENDED_OUTPUT_STAGE_MEDIUM_TOKEN_CAP;
  }
  return BACKSTAGE_OUTPUT_TOKEN_LIMIT_MAX;
}

function isProductionSizedStructuredGeneration(
  input: BackstageOutputBudgetInput,
  promptCodeUnits: number,
  retrievedContextCodeUnits: number,
  expectedOutputWords: number
): boolean {
  return input.requestedFormat === 'structured_booking'
    && (
      input.action === 'generateBookingWithHRC'
      || promptCodeUnits >= BACKSTAGE_BOOKING_HEAVY_PROMPT_CODE_UNITS
      || retrievedContextCodeUnits >= BACKSTAGE_BOOKING_HEAVY_CONTEXT_CODE_UNITS
      || expectedOutputWords >= BACKSTAGE_BOOKING_HEAVY_EXPECTED_WORDS
    );
}

/**
 * Select a finite output budget from safe workload metadata only. The queued
 * worker profile is the sole path allowed above the historical Booker cap;
 * synchronous, compact, continuity, and unsupported-model calls retain their
 * existing bounded budgets.
 */
export function resolveBackstageOutputBudget(
  input: BackstageOutputBudgetInput
): BackstageOutputBudgetDecision {
  const promptCodeUnits = normalizePositiveInteger(input.promptCodeUnits);
  const retrievedContextCodeUnits = normalizePositiveInteger(
    input.retrievedContextCodeUnits
  );
  const expectedOutputWords = normalizePositiveInteger(input.expectedOutputWords);
  const modelStageTimeoutMs = normalizePositiveInteger(input.modelStageTimeoutMs);
  const modelCapability = resolveModelCapability(input.model);
  const boundedRequestTokenLimit = input.action === 'queryContinuity'
    ? BACKSTAGE_CONTINUITY_QUERY_TOKEN_LIMIT
    : resolveBoundedRequestTokenLimit(input.requestedTokenLimit);
  const buildDecision = (
    budgetClass: BackstageOutputBudgetClass,
    reason: BackstageOutputBudgetReason,
    tokenLimit: number,
    tokenCap = BACKSTAGE_GENERATION_TOKEN_LIMIT_MAX
  ): BackstageOutputBudgetDecision => ({
    action: input.action,
    profile: input.profile,
    requestedFormat: input.requestedFormat,
    budgetClass,
    reason,
    modelCapability,
    tokenLimit,
    tokenCap,
    promptCodeUnits,
    retrievedContextCodeUnits,
    expectedOutputWords,
    modelStageTimeoutMs,
  });

  if (
    input.action === 'queryContinuity'
    || input.profile === 'continuity_sync'
    || input.requestedFormat === 'continuity'
  ) {
    return buildDecision(
      'continuity_small',
      'continuity_profile',
      BACKSTAGE_CONTINUITY_QUERY_TOKEN_LIMIT
    );
  }

  if (input.profile !== 'queued_generation') {
    return buildDecision(
      'bounded_request',
      'bounded_request_profile',
      boundedRequestTokenLimit
    );
  }

  if (
    input.requestedFormat === 'compact_direct'
    || input.requestedFormat === 'bounded_review'
  ) {
    return buildDecision(
      'bounded_request',
      'compact_response_contract',
      boundedRequestTokenLimit
    );
  }

  if (modelCapability !== 'extended_gpt5') {
    return buildDecision(
      'bounded_request',
      'unsupported_extended_model',
      boundedRequestTokenLimit
    );
  }

  const stageTokenCap = resolveStageTokenCap(modelStageTimeoutMs);
  if (stageTokenCap <= BACKSTAGE_GENERATION_TOKEN_LIMIT_MAX) {
    return buildDecision(
      'bounded_request',
      'insufficient_model_stage_budget',
      boundedRequestTokenLimit
    );
  }

  const productionSizedWorkload = isProductionSizedStructuredGeneration(
    input,
    promptCodeUnits,
    retrievedContextCodeUnits,
    expectedOutputWords
  );
  const workloadTokenTarget = productionSizedWorkload
    ? resolveConfiguredWorkerTokenLimit(input.configuredWorkerTokenLimit)
    : BACKSTAGE_WORKER_OUTPUT_TOKEN_LIMIT_MIN;
  const tokenLimit = Math.min(
    workloadTokenTarget,
    stageTokenCap,
    BACKSTAGE_OUTPUT_TOKEN_LIMIT_MAX
  );
  return buildDecision(
    'queued_extended',
    'queued_structured_generation',
    tokenLimit,
    tokenLimit
  );
}

/** Return a log-safe copy containing only closed enums and bounded numbers. */
export function buildBackstageOutputBudgetTelemetry(
  decision: BackstageOutputBudgetDecision
): BackstageOutputBudgetTelemetry {
  return { ...decision };
}

/** Server-owned completeness instruction paired with the selected finite cap. */
export function buildBackstageOutputBudgetCompletionInstruction(
  decision: Pick<BackstageOutputBudgetDecision, 'tokenLimit'>
): string {
  return [
    '<<BACKSTAGE_OUTPUT_BUDGET>>',
    `Complete every requested section within ${decision.tokenLimit} output tokens.`,
    'Compact lower-priority detail before truncating any sentence, numbered item, or final section.',
    'Return no partial draft and close the requested structure before stopping.',
  ].join('\n');
}

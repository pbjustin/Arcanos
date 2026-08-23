export const BACKSTAGE_MODULE_NAME = 'BACKSTAGE:BOOKER';
export const BACKSTAGE_MODULE_ROUTE = 'backstage-booker';
export const BACKSTAGE_DEFAULT_ACTION = 'generateBooking';
export const BACKSTAGE_MUTATION_SCOPE = 'mcp:invoke';
export const BACKSTAGE_MUTATION_CONFIRMATION_PROTOCOL =
  'backstage-mutation-confirmation-v1';
export const BACKSTAGE_ROUTE_TIMEOUT_MINIMUM_MS = 60_000;
export const BACKSTAGE_GENERATION_STAGE_TIMEOUT_DEFAULT_MS = 40_000;
export const BACKSTAGE_GENERATION_STAGE_TIMEOUT_MAX_MS = 45_000;
export const BACKSTAGE_HRC_EVALUATION_TIMEOUT_MS = 10_000;
export const BACKSTAGE_GENERATION_TOKEN_LIMIT_DEFAULT = 2400;
export const BACKSTAGE_GENERATION_TOKEN_LIMIT_MAX = 2400;
export const BACKSTAGE_CONTINUITY_QUERY_TOKEN_LIMIT = 900;
export const BACKSTAGE_BOOKING_HEAVY_PROMPT_CODE_UNITS = 1_200;
export const BACKSTAGE_BOOKING_HEAVY_CONTEXT_CODE_UNITS = 6_000;
export const BACKSTAGE_BOOKING_HEAVY_ITEM_COUNT = 4;
export const BACKSTAGE_BOOKING_HEAVY_EXPECTED_WORDS = 500;

export const BACKSTAGE_PUBLIC_ACTIONS = Object.freeze([
  'queryContinuity',
  'generateBooking',
  'generateBookingWithHRC',
  'simulateMatch',
] as const);

export const BACKSTAGE_MUTATION_ACTIONS = Object.freeze([
  'bookEvent',
  'updateRoster',
  'trackStoryline',
  'saveStoryline',
  'upsertStoryline',
  'appendCanonBeat',
] as const);

export const BACKSTAGE_ACTIONS = Object.freeze([
  ...BACKSTAGE_PUBLIC_ACTIONS,
  ...BACKSTAGE_MUTATION_ACTIONS,
] as const);

export type BackstageAction = (typeof BACKSTAGE_ACTIONS)[number];
export type BackstageMutationAction = (typeof BACKSTAGE_MUTATION_ACTIONS)[number];

export type BackstageBookerWorkloadClass =
  | 'not_applicable'
  | 'validation_only'
  | 'lightweight'
  | 'bounded_small'
  | 'production_generation';

export type BackstageBookerWorkloadReason =
  | 'unknown_or_non_generation_action'
  | 'authorization_not_established'
  | 'continuity_sync'
  | 'provider_not_required'
  | 'safe_explicit_async'
  | 'bounded_small_sync'
  | 'generate_booking_with_hrc'
  | 'notion_authority_context'
  | 'prompt_size'
  | 'retrieved_context_size'
  | 'expected_item_count'
  | 'expected_output_words';

export interface BackstageBookerWorkloadDecision {
  workloadClass: BackstageBookerWorkloadClass;
  queueRequired: boolean;
  forceSynchronous: boolean;
  reason: BackstageBookerWorkloadReason;
  requestedExecutionMode: 'sync' | 'async' | null;
  promptCodeUnits: number;
  contextCodeUnits: number;
  expectedItemCount: number;
  expectedOutputWords: number;
  notionAuthorityContext: boolean;
  providerInvocationRequired: boolean;
}

export interface BackstageBookerWorkloadInput {
  action: BackstageAction | null;
  authorizationEstablished: boolean;
  requestedExecutionMode: 'sync' | 'async' | null;
  promptCodeUnits: number;
  contextCodeUnits: number;
  expectedItemCount: number;
  expectedOutputWords: number;
  notionAuthorityContext: boolean;
  providerInvocationRequired: boolean;
}

export interface BackstageBookerTrinityRunOptions {
  answerMode: 'direct';
  internalMode: false;
  strictUserVisibleOutput: true;
  directAnswerModelOverride: string;
  directAnswerTokenLimitOverride: number;
  directAnswerTokenCapOverride: number;
  directAnswerUserIntentPrompt: string;
  modelStageTimeoutMs: number;
}

const backstagePublicActionSet = new Set<string>(BACKSTAGE_PUBLIC_ACTIONS);
const backstageMutationActionSet = new Set<string>(BACKSTAGE_MUTATION_ACTIONS);
const backstageGptRouteSet = new Set([BACKSTAGE_MODULE_ROUTE, 'backstage']);

function normalizeWorkloadCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Classify one already-authorized Backstage request without reading ambient
 * configuration or retaining prompt/context content.
 *
 * Heavy generation is a safety boundary: an explicit synchronous preference
 * cannot move it back under the request timeout. Lightweight continuity and
 * deterministic no-provider shortcuts remain request-local.
 */
export function classifyBackstageBookerWorkload(
  input: BackstageBookerWorkloadInput
): BackstageBookerWorkloadDecision {
  const promptCodeUnits = normalizeWorkloadCount(input.promptCodeUnits);
  const contextCodeUnits = normalizeWorkloadCount(input.contextCodeUnits);
  const expectedItemCount = normalizeWorkloadCount(input.expectedItemCount);
  const expectedOutputWords = normalizeWorkloadCount(input.expectedOutputWords);
  const buildDecision = (
    workloadClass: BackstageBookerWorkloadClass,
    queueRequired: boolean,
    forceSynchronous: boolean,
    reason: BackstageBookerWorkloadReason
  ): BackstageBookerWorkloadDecision => ({
    workloadClass,
    queueRequired,
    forceSynchronous,
    reason,
    requestedExecutionMode: input.requestedExecutionMode,
    promptCodeUnits,
    contextCodeUnits,
    expectedItemCount,
    expectedOutputWords,
    notionAuthorityContext: input.notionAuthorityContext,
    providerInvocationRequired: input.providerInvocationRequired,
  });

  if (!input.action || !isBackstagePublicAction(input.action)) {
    return buildDecision(
      'not_applicable',
      false,
      false,
      'unknown_or_non_generation_action'
    );
  }

  if (!input.authorizationEstablished) {
    return buildDecision(
      'validation_only',
      false,
      false,
      'authorization_not_established'
    );
  }

  if (input.action === 'queryContinuity') {
    return buildDecision('lightweight', false, true, 'continuity_sync');
  }

  if (
    input.action !== 'generateBooking'
    && input.action !== 'generateBookingWithHRC'
  ) {
    return buildDecision(
      'not_applicable',
      false,
      false,
      'unknown_or_non_generation_action'
    );
  }

  const heavyReason: BackstageBookerWorkloadReason | null =
    input.action === 'generateBookingWithHRC'
      ? 'generate_booking_with_hrc'
      : input.notionAuthorityContext
        ? 'notion_authority_context'
        : promptCodeUnits >= BACKSTAGE_BOOKING_HEAVY_PROMPT_CODE_UNITS
          ? 'prompt_size'
          : contextCodeUnits >= BACKSTAGE_BOOKING_HEAVY_CONTEXT_CODE_UNITS
            ? 'retrieved_context_size'
            : expectedItemCount >= BACKSTAGE_BOOKING_HEAVY_ITEM_COUNT
              ? 'expected_item_count'
              : expectedOutputWords >= BACKSTAGE_BOOKING_HEAVY_EXPECTED_WORDS
                ? 'expected_output_words'
                : null;

  if (!input.providerInvocationRequired && input.action === 'generateBooking') {
    return buildDecision('lightweight', false, true, 'provider_not_required');
  }

  if (heavyReason) {
    return buildDecision(
      'production_generation',
      true,
      false,
      heavyReason
    );
  }

  return buildDecision(
    'bounded_small',
    false,
    false,
    input.requestedExecutionMode === 'async'
      ? 'safe_explicit_async'
      : 'bounded_small_sync'
  );
}

export function isBackstageGptRoute(value: string): boolean {
  return backstageGptRouteSet.has(value.trim().toLowerCase());
}

export function resolveBackstageGenerationStageTimeoutMs(
  configuredTimeoutMs: number
): number {
  const preferredTimeoutMs =
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? Math.trunc(configuredTimeoutMs)
      : BACKSTAGE_GENERATION_STAGE_TIMEOUT_DEFAULT_MS;

  return Math.max(
    1,
    Math.min(preferredTimeoutMs, BACKSTAGE_GENERATION_STAGE_TIMEOUT_MAX_MS)
  );
}

export function resolveBackstageGenerationTokenLimit(
  configuredTokenLimit: number
): number {
  if (!Number.isFinite(configuredTokenLimit) || configuredTokenLimit <= 0) {
    return BACKSTAGE_GENERATION_TOKEN_LIMIT_DEFAULT;
  }

  return Math.min(
    Math.max(1, Math.trunc(configuredTokenLimit)),
    BACKSTAGE_GENERATION_TOKEN_LIMIT_MAX
  );
}

export function buildBackstageBookerTrinityRunOptions(params: {
  model: string;
  tokenLimit: number;
  userIntentPrompt: string;
  modelStageTimeoutMs: number;
}): BackstageBookerTrinityRunOptions {
  return {
    answerMode: 'direct',
    internalMode: false,
    strictUserVisibleOutput: true,
    directAnswerModelOverride: params.model,
    directAnswerTokenLimitOverride: params.tokenLimit,
    directAnswerTokenCapOverride: BACKSTAGE_GENERATION_TOKEN_LIMIT_MAX,
    directAnswerUserIntentPrompt: params.userIntentPrompt,
    modelStageTimeoutMs: params.modelStageTimeoutMs,
  };
}

export function resolveBackstageGptAction(value: unknown): BackstageAction | null {
  if (value === undefined || value === null || value === '') {
    return BACKSTAGE_DEFAULT_ACTION;
  }
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue) {
    return BACKSTAGE_DEFAULT_ACTION;
  }

  return BACKSTAGE_ACTIONS.find(
    (action) => action.toLowerCase() === normalizedValue
  ) ?? null;
}

export function resolveBackstageLegacyAction(value: unknown): BackstageAction | null {
  return typeof value === 'string' && BACKSTAGE_ACTIONS.includes(value as BackstageAction)
    ? value as BackstageAction
    : null;
}

export function isBackstagePublicAction(action: string): boolean {
  return backstagePublicActionSet.has(action);
}

export function isBackstageMutationAction(
  action: BackstageAction
): action is BackstageMutationAction {
  return backstageMutationActionSet.has(action);
}

export function buildBackstageMutationConfirmationFingerprintBody(
  action: string,
  body: unknown
): Record<string, unknown> {
  return {
    protocol: BACKSTAGE_MUTATION_CONFIRMATION_PROTOCOL,
    action,
    body,
  };
}

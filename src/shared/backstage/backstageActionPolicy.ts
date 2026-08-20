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

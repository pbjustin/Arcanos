export const BACKSTAGE_MODULE_NAME = 'BACKSTAGE:BOOKER';
export const BACKSTAGE_MODULE_ROUTE = 'backstage-booker';
export const BACKSTAGE_DEFAULT_ACTION = 'generateBooking';
export const BACKSTAGE_MUTATION_SCOPE = 'mcp:invoke';

export const BACKSTAGE_PUBLIC_ACTIONS = Object.freeze([
  'generateBooking',
  'generateBookingWithHRC',
  'simulateMatch',
] as const);

export const BACKSTAGE_MUTATION_ACTIONS = Object.freeze([
  'bookEvent',
  'updateRoster',
  'trackStoryline',
  'saveStoryline',
] as const);

export const BACKSTAGE_ACTIONS = Object.freeze([
  ...BACKSTAGE_PUBLIC_ACTIONS,
  ...BACKSTAGE_MUTATION_ACTIONS,
] as const);

export type BackstageAction = (typeof BACKSTAGE_ACTIONS)[number];
export type BackstageMutationAction = (typeof BACKSTAGE_MUTATION_ACTIONS)[number];

const backstagePublicActionSet = new Set<string>(BACKSTAGE_PUBLIC_ACTIONS);
const backstageMutationActionSet = new Set<string>(BACKSTAGE_MUTATION_ACTIONS);

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

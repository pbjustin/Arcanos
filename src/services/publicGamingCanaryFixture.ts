export const PUBLIC_GAMING_CANARY_MARKER = 'ARCANOS_PUBLIC_CANARY_7F31';
export const PUBLIC_GAMING_CANARY_SENTENCE =
  'The Ember Finch opens the Copper Gate after three Azure Seeds are collected.';
export const PUBLIC_GAMING_CANARY_FIXTURE =
  `${PUBLIC_GAMING_CANARY_MARKER}:\n${PUBLIC_GAMING_CANARY_SENTENCE}`;

export function loadPublicGamingCanaryFixture(): string {
  return PUBLIC_GAMING_CANARY_FIXTURE;
}

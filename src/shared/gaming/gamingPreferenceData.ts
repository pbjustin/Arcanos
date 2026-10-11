/** Owner-reviewed request recognition data; never acquired identity, gameplay evidence, or authorization. */
export const GAMING_PREFERENCE_DATA_VERSION = 'gaming-preference-data/v1';
export const GAMING_PREFERENCE_DATA_REVISION = '2026-10-10.1';
export const GAMING_PREFERENCE_DATA_PROVENANCE = {
  origin: 'repository-defaults',
  migratedFrom: '200463b3aac65eb494f71d842c1e2b0378530bfb',
  reviewPolicy: 'owner-reviewed-public-lexemes'
} as const;

/** Public vocabulary limits hints so private free-text player fields cannot become search terms. */
export const GAMING_GUIDE_PUBLIC_TOPIC_LEXEMES = [
  'early game', 'beginner', 'Samurai', 'katana', 'Uchigatana', 'blade', 'weapon', 'stats', 'armor',
  'skills', 'strategy', 'boss', 'quest', 'location', 'mechanics', 'build', 'upgrade', 'progression'
] as const;

/** Existing explicit alternatives are configurable examples of player decisions, not missing source facts. */
export const GAMING_PLAYER_DECISION_CHOICES = [
  { first: 'bleed', second: 'pure\\s+(?:dex(?:terity)?)', question: 'Do you prefer bleed or pure Dexterity?' },
  { first: 'single\\s+katana', second: 'dual[\\s-]+wield(?:ing)?', question: 'Do you prefer a single katana or dual wielding?' },
  { first: 'aggressive', second: 'defensive', question: 'Do you prefer an aggressive or defensive playstyle?' }
] as const;

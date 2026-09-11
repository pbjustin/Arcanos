/** Request-scoped player claims. None of these values is verified game state. */
export type GamingSpoilerMode = 'none' | 'light' | 'full';
export type GamingSpoilerTolerance = GamingSpoilerMode | 'avoid' | 'allowed' | 'unknown' | 'no spoilers' | 'ok' | 'spoilers ok';
export type GamingAnswerDepth = 'auto' | 'concise' | 'standard' | 'detailed';
export const GAMING_CONTEXT_STRING_LIMITS = {
  platform: 64, edition: 120, version: 64, difficulty: 64,
  currentArea: 160, lastCompletedObjective: 240, progressPoint: 160, class: 64, role: 64
} as const;
export type GamingContextField = keyof typeof GAMING_CONTEXT_STRING_LIMITS | 'constraints' | 'spoilerTolerance' | 'answerDepth';
export type GamingContextOrigin = 'explicit' | 'question' | 'tentative' | 'default';
export type GamingPlayerContext = Partial<Record<keyof typeof GAMING_CONTEXT_STRING_LIMITS, string>> & {
  constraints?: string[];
  spoilerTolerance?: GamingSpoilerTolerance;
  spoilerMode?: GamingSpoilerMode;
  answerDepth?: GamingAnswerDepth;
  contextOrigins?: Partial<Record<GamingContextField, GamingContextOrigin>>;
  contextConflicts?: GamingContextField[];
};

/** JSON callers cannot supply this server-owned mapping attestation. */
export const GAMING_PLAYER_CONTEXT = Symbol('gaming.player-context');
export type GamingContextCarrier = { [GAMING_PLAYER_CONTEXT]?: GamingPlayerContext };
export const GAMING_CONTEXT_MAX_CHARACTERS = 2_000;
export const GAMING_CONTEXT_MAX_CONSTRAINTS = 8;
export const GAMING_CONTEXT_MAX_CONSTRAINT_CHARACTERS = 160;
const CONTEXT_ALIASES = { patch: 'version', className: 'class', progress: 'progressPoint', checkpoint: 'progressPoint' } as const;
export const GAMING_CONTEXT_PUBLIC_FIELDS = [
  ...Object.keys(GAMING_CONTEXT_STRING_LIMITS), ...Object.keys(CONTEXT_ALIASES),
  'constraints', 'spoilerTolerance', 'answerDepth'
] as const;
const SPOILER_MODES: Record<GamingSpoilerTolerance, GamingSpoilerMode | undefined> = {
  none: 'none', light: 'light', full: 'full', avoid: 'none', allowed: 'full',
  unknown: undefined, 'no spoilers': 'none', ok: 'full', 'spoilers ok': 'full'
};
const owns = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const clean = (value: string): string => value.replace(/\s+/gu, ' ').trim();
const validText = (value: unknown, limit: number): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= limit
  && !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/u.test(value);

/** Validate raw fields before any normalizer can silently drop or trim invalid values. */
export function validateGamingPlayerContextInput(payload: unknown): string | undefined {
  const values = record(payload);
  let characters = 0;
  if (owns(values, 'requestedVersion')) {
    if (!validText(values.requestedVersion, 64)
      || !/^(?:(?:version|patch|v)\s*)?\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/iu.test(values.requestedVersion.trim())) return 'Gaming requestedVersion must be a bounded string.';
    characters += values.requestedVersion.length;
  }
  for (const [field, max] of Object.entries(GAMING_CONTEXT_STRING_LIMITS)) {
    if (!owns(values, field)) continue;
    if (!validText(values[field], max)) return `Gaming ${field} must be a non-empty string of at most ${max} characters.`;
    characters += (values[field] as string).length;
  }
  for (const [alias, canonical] of Object.entries(CONTEXT_ALIASES)) {
    if (!owns(values, alias)) continue;
    if (!validText(values[alias], GAMING_CONTEXT_STRING_LIMITS[canonical])) return `Gaming ${alias} is invalid or exceeds its field limit.`;
    characters += (values[alias] as string).length;
  }
  if (owns(values, 'constraints')) {
    const constraints = values.constraints;
    if (!Array.isArray(constraints) || constraints.length > GAMING_CONTEXT_MAX_CONSTRAINTS
      || constraints.some(value => !validText(value, GAMING_CONTEXT_MAX_CONSTRAINT_CHARACTERS))) {
      return 'Gaming constraints must contain at most eight non-empty strings of at most 160 characters.';
    }
    characters += (constraints as string[]).reduce((sum, value) => sum + value.length, 0);
  }
  if (owns(values, 'spoilerTolerance')) {
    if (typeof values.spoilerTolerance !== 'string' || !owns(SPOILER_MODES, values.spoilerTolerance.toLowerCase())) return 'Gaming spoilerTolerance is not supported.';
    characters += values.spoilerTolerance.length;
  }
  if (owns(values, 'answerDepth')) {
    if (typeof values.answerDepth !== 'string' || !['auto', 'concise', 'standard', 'detailed'].includes(values.answerDepth)) return 'Gaming answerDepth is not supported.';
    characters += values.answerDepth.length;
  }
  if (characters > GAMING_CONTEXT_MAX_CHARACTERS) return 'Gaming player context exceeds the aggregate 2000-character limit.';
  return undefined;
}

function read(values: Record<string, unknown>, key: string): string | undefined {
  return owns(values, key) && typeof values[key] === 'string' && values[key].trim() ? clean(values[key]) : undefined;
}

/** Only direct first-person affirmative clauses may establish progression claims. */
function questionProgress(prompt: string, game?: string): Partial<GamingPlayerContext> {
  const result: Partial<GamingPlayerContext> = {};
  const conflicts = new Set<GamingContextField>();
  const assign = (field: 'currentArea' | 'lastCompletedObjective' | 'progressPoint', value: string): void => {
    if (result[field] && result[field]?.toLowerCase() !== clean(value).toLowerCase()) conflicts.add(field);
    result[field] = clean(value);
  };
  // A decimal in a game edition is not a sentence boundary. Only the exact
  // supplied title can be removed from an area claim; other location suffixes remain.
  const gameSuffix = game ? new RegExp(` in ${clean(game).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'iu') : undefined;
  const clauses = prompt.split(/(?<!\d)\.|\.(?!\d)|[!?;\n]/u).map(clean);
  for (const clause of clauses) {
    if (/\b(?:if|would|could|might|suppose|imagine|hypothetical|not|never|haven['’]?t|hadn['’]?t|didn['’]?t)\b/iu.test(clause)) continue;
    const areaClaim = /^(?:now\s+)?I(?:['’]m|\s+am)\s+(?:currently\s+)?(?:at|in)\s+([^,]{1,160})(?:,|$)/iu.exec(clause)?.[1];
    const gameSuffixMatch = areaClaim && gameSuffix ? gameSuffix.exec(areaClaim) : null;
    const area = gameSuffixMatch ? areaClaim?.slice(0, gameSuffixMatch.index).trim() : areaClaim;
    const completed = /^I\s+(?:(?:have|['’]ve)\s+(?:just\s+)?(?:completed|finished|defeated|beaten)|(?:just\s+)?(?:completed|finished|defeated)|just\s+beat)\s+([^,]{1,240})(?:,|$)/iu.exec(clause)?.[1];
    const progress = /^I(?:['’]m|\s+am)\s+(?:currently\s+)?(?:at\s+)?(?:checkpoint|progress\s+point)\s+([^,]{1,160})(?:,|$)/iu.exec(clause)?.[1];
    if (area && !/\b(?:checkpoint|progress\s+point)\b/iu.test(area)) assign('currentArea', area);
    if (completed) assign('lastCompletedObjective', completed);
    if (progress) assign('progressPoint', progress);
  }
  result.contextConflicts = [...conflicts];
  return result;
}

/** Public transport projection excludes effective policy and server-derived provenance. */
export function pickGamingPublicPlayerContext(input: GamingPlayerContext): GamingPlayerContext {
  const result = pickGamingPlayerContext(input);
  delete result.spoilerMode;
  delete result.contextOrigins;
  delete result.contextConflicts;
  if (input.contextOrigins?.spoilerTolerance === 'default') delete result.spoilerTolerance;
  if (input.contextOrigins?.answerDepth === 'default') delete result.answerDepth;
  return result;
}

function textSpoilerMode(prompt: string): GamingSpoilerMode | undefined {
  if (/\b(?:no|avoid|without)\s+(?:(?:major|story)\s+)?spoilers?\b|\bspoiler[- ]free\b/iu.test(prompt)) return 'none';
  if (/\b(?:light|minor)\s+spoilers?\b/iu.test(prompt)) return 'light';
  // A negated or hypothetical permission never widens the default.
  if (!/\b(?:if|would|not|never|don['’]?t)\b[^.!?\n]{0,50}\bspoilers?\b/iu.test(prompt)
    && /\bspoilers?\s+(?:ok|okay|allowed|fine)\b|\b(?:include|full)\s+spoilers?\b/iu.test(prompt)) return 'full';
  return undefined;
}

export function normalizeGamingVersionContext(value: string): string {
  return /^(?:(?:version|patch|v)\s*)?(\d{1,3}\.\d{1,3}(?:\.\d{1,3})?)$/iu.exec(value.trim())?.[1] ?? clean(value);
}

export function resolveGamingPlayerContext(
  payload: unknown,
  prompt: string,
  tentative: Partial<GamingPlayerContext> = {}
): GamingPlayerContext {
  const values = record(payload);
  const context: GamingPlayerContext = {};
  const origins: NonNullable<GamingPlayerContext['contextOrigins']> = {};
  const conflicts = new Set<GamingContextField>();
  const question = questionProgress(prompt, read(values, 'game'));
  for (const field of question.contextConflicts ?? []) conflicts.add(field);
  for (const field of Object.keys(GAMING_CONTEXT_STRING_LIMITS) as Array<keyof typeof GAMING_CONTEXT_STRING_LIMITS>) {
    const aliasKeys = Object.entries(CONTEXT_ALIASES).filter(([, canonical]) => canonical === field).map(([alias]) => alias);
    const explicitValues = [field, ...aliasKeys, ...(field === 'version' ? ['requestedVersion'] : [])].map(key => read(values, key)).filter((value): value is string => Boolean(value));
    const normalizedValues = field === 'version' ? explicitValues.map(normalizeGamingVersionContext) : explicitValues;
    const explicit = normalizedValues[0];
    const fromQuestion = question[field];
    // Existing broad class/role/version extraction remains tentative; broad progression extraction is excluded.
    const inferred = field === 'currentArea' || field === 'lastCompletedObjective' || field === 'progressPoint' || field === 'edition'
      || (field === 'version' && /\b(?:if|suppose|imagine|hypothetical)\b/iu.test(prompt)) ? undefined : tentative[field];
    const value = explicit ?? fromQuestion ?? inferred;
    if (value && validText(value, GAMING_CONTEXT_STRING_LIMITS[field])) {
      context[field] = clean(value);
      origins[field] = explicit ? 'explicit' : fromQuestion ? 'question' : 'tentative';
    }
    if (new Set(normalizedValues.map(value => value.toLowerCase())).size > 1
      || (explicit && fromQuestion && explicit.toLowerCase() !== fromQuestion.toLowerCase())) conflicts.add(field);
  }
  const explicitConstraints = Array.isArray(values.constraints) ? values.constraints.filter((value): value is string => typeof value === 'string').map(clean) : [];
  const constraints = Array.from(new Set([...explicitConstraints, ...(tentative.constraints ?? [])])).slice(0, GAMING_CONTEXT_MAX_CONSTRAINTS);
  if (constraints.length) {
    context.constraints = constraints;
    origins.constraints = explicitConstraints.length ? 'explicit' : 'tentative';
  }
  const tolerance = read(values, 'spoilerTolerance')?.toLowerCase() as GamingSpoilerTolerance | undefined;
  const explicitSpoiler = tolerance && owns(SPOILER_MODES, tolerance) ? SPOILER_MODES[tolerance] : undefined;
  const questionSpoiler = textSpoilerMode(prompt);
  const rank = { none: 0, light: 1, full: 2 };
  const effective = explicitSpoiler && questionSpoiler
    ? rank[explicitSpoiler] <= rank[questionSpoiler] ? explicitSpoiler : questionSpoiler
    : explicitSpoiler ?? questionSpoiler ?? 'none';
  context.spoilerMode = effective;
  context.spoilerTolerance = tolerance ?? (questionSpoiler === 'none' ? 'avoid' : questionSpoiler === 'full' ? 'allowed' : questionSpoiler ?? 'unknown');
  origins.spoilerTolerance = explicitSpoiler ? 'explicit' : questionSpoiler ? 'question' : 'default';
  const depthRequest = prompt.replace(/\b(?:not|no|without|avoid|don['’]?t\s+(?:be|give\s+me))\s+(?:a\s+)?(?:detailed|thorough|comprehensive|concise|brief|short)(?:\s+(?:answer|explanation))?/giu, '');
  const textDepth = /\b(?:be\s+brief|briefly|keep\s+it\s+(?:short|brief)|concise|short\s+answer)\b/iu.test(depthRequest) ? 'concise'
    : /\b(?:in\s+detail|detailed|thorough|comprehensive)\b/iu.test(depthRequest) ? 'detailed' : undefined;
  const suppliedDepth = read(values, 'answerDepth') as GamingAnswerDepth | undefined;
  context.answerDepth = textDepth ?? suppliedDepth ?? 'auto';
  origins.answerDepth = textDepth ? 'question' : suppliedDepth ? 'explicit' : 'default';
  context.contextOrigins = origins;
  context.contextConflicts = [...conflicts];
  return context;
}

/** Allowlisted projection; never merge arbitrary payload keys into provider or retrieval inputs. */
export function pickGamingPlayerContext(input: GamingPlayerContext): GamingPlayerContext {
  const result: GamingPlayerContext = {};
  for (const field of Object.keys(GAMING_CONTEXT_STRING_LIMITS) as Array<keyof typeof GAMING_CONTEXT_STRING_LIMITS>) {
    if (input[field] !== undefined) result[field] = input[field];
  }
  if (input.constraints?.length) result.constraints = [...input.constraints];
  if (input.spoilerTolerance !== undefined) result.spoilerTolerance = input.spoilerTolerance;
  if (input.spoilerMode !== undefined) result.spoilerMode = input.spoilerMode;
  if (input.answerDepth !== undefined) result.answerDepth = input.answerDepth;
  if (input.contextOrigins) result.contextOrigins = { ...input.contextOrigins };
  if (input.contextConflicts) result.contextConflicts = [...input.contextConflicts];
  return result;
}

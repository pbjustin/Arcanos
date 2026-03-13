import { randomUUID } from 'crypto';
import { callOpenAI, getGPT5Model } from "@services/openai.js";
import { saveWithAuditCheck } from "@services/persistenceManager.js";
import {
  BACKSTAGE_BOOKER_PERSONA,
  BOOKING_INSTRUCTIONS_SUFFIX,
  BOOKING_RESPONSE_GUIDELINES
} from "@platform/runtime/prompts.js";
import { query, saveMemory } from "@core/db/index.js";
import { getEnv, getEnvNumber } from "@platform/runtime/env.js";
import { evaluateWithHRC, withHRC } from './hrcWrapper.js';
import { buildDirectAnswerModeSystemInstruction, shouldPreferDirectAnswerMode } from '@services/directAnswerMode.js';
import { tryExtractExactLiteralPromptShortcut } from '@services/exactLiteralPromptShortcut.js';

export interface Wrestler {
  name: string;
  overall: number; // rating 0-100
}

export interface MatchInput {
  wrestler1: string;
  wrestler2: string;
  matchType: string;
  kayfabeMode?: boolean;
}

export interface MatchResultBase {
  match: string;
  interference: string | null;
  rating: string; // 1.0-5.0
}

export interface KayfabeResult extends MatchResultBase {
  result: string;
  via: string;
}

export interface RealResult extends MatchResultBase {
  winner: string;
  loser: string;
  probability: Record<string, string>;
}

interface BackstageDirectAnswerOutputContract {
  requestedBulletCount?: number;
  requiresShortBullets: boolean;
}

interface EventData {
  [key: string]: unknown;
}

interface Storyline {
  [key: string]: unknown;
}

// Internal in-memory stores
const events: Array<{ id: string; data: EventData }> = [];
let roster: Wrestler[] = [];
const storylines: Array<Storyline> = [];

/**
 * Persist latest roster snapshot for cross-session recall.
 * Inputs: wrestler list and source marker.
 * Output: resolves when memory convenience key is updated.
 * Edge cases: logs warning without throwing when persistence is unavailable.
 */
async function persistLatestRosterSnapshot(
  nextRoster: Wrestler[],
  source: "database" | "fallback"
): Promise<void> {
  await saveMemory("backstage-roster:latest", {
    roster: nextRoster,
    source,
    updatedAt: new Date().toISOString()
  }).catch((error: unknown) => {
    //audit Assumption: convenience roster mirror is optional metadata; failure risk: stale roster recall in new chats; expected invariant: primary roster mutation still succeeds; handling strategy: warn and continue.
    console.warn("Backstage Booker: failed to persist latest roster snapshot", (error as Error).message);
  });
}

/**
 * Persist latest storyline snapshot for cross-session recall.
 * Inputs: storyline key, storyline text, source marker.
 * Output: resolves when latest and keyed storyline convenience entries are updated.
 * Edge cases: warns and continues on persistence failures.
 */
async function persistLatestStorylineSnapshot(
  key: string,
  storyline: string,
  source: "database" | "fallback"
): Promise<void> {
  const snapshot = {
    key,
    storyline,
    source,
    updatedAt: new Date().toISOString()
  };

  await saveMemory("backstage-storyline:latest", snapshot).catch((error: unknown) => {
    //audit Assumption: latest storyline mirror may fail independently; failure risk: no quick "latest" recall; expected invariant: primary storyline flow continues; handling strategy: warn and continue.
    console.warn("Backstage Booker: failed to persist latest storyline snapshot", (error as Error).message);
  });

  await saveMemory(`backstage-storyline:${key}`, snapshot).catch((error: unknown) => {
    //audit Assumption: keyed storyline mirror is convenience only; failure risk: key lookup misses; expected invariant: core save path unaffected; handling strategy: warn and continue.
    console.warn(`Backstage Booker: failed to persist keyed storyline snapshot for ${key}`, (error as Error).message);
  });
}

/**
 * Persist latest storyline beats snapshot for cross-session recall.
 * Inputs: storyline beat collection and source marker.
 * Output: resolves when convenience key is updated.
 * Edge cases: warns and continues when persistence is unavailable.
 */
async function persistLatestStoryBeatsSnapshot(
  beats: Storyline[],
  source: "database" | "fallback"
): Promise<void> {
  await saveMemory("backstage-storybeats:latest", {
    beats,
    source,
    updatedAt: new Date().toISOString()
  }).catch((error: unknown) => {
    //audit Assumption: story beats mirror is best-effort; failure risk: reduced context continuity; expected invariant: storyline tracking still returns beats; handling strategy: warn and continue.
    console.warn("Backstage Booker: failed to persist latest story beats snapshot", (error as Error).message);
  });
}

function formatJsonSnippet(value: unknown, maxLength = 220): string {
  if (value === null || value === undefined) {
    return '∅';
  }

  if (typeof value === 'string') {
    const compact = value.replace(/\s+/g, ' ').trim();
    return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}…` : serialized;
  } catch (error) {
    console.warn('Backstage Booker: failed to format JSON snippet', (error as Error).message);
    const fallback = String(value);
    return fallback.length > maxLength ? `${fallback.slice(0, maxLength)}…` : fallback;
  }
}

function toISODate(value: unknown): string {
  try {
    return new Date(value as string).toISOString();
  } catch {
    return 'unknown-date';
  }
}

function buildBackstageDirectAnswerModeInstruction(): string {
  return buildDirectAnswerModeSystemInstruction({
    moduleLabel: 'BACKSTAGE:BOOKER',
    domainGuidance: 'Produce wrestling booking plans, rivalry maps, and storyline logic grounded in the supplied roster and recent continuity.',
    prohibitedBehaviors: [
      'role-play a backstage conversation',
      'narrate fictional locker-room scenes',
      'simulate a hypothetical booking meeting'
    ],
    missingInfoBehavior: 'If the request depends on roster, brand, timeline, or title context that is missing, say what is missing briefly instead of fabricating continuity.'
  });
}

function buildBackstageResponseStyleSuffix(directAnswerMode: boolean): string {
  return directAnswerMode
    ? '\nKeep the response direct, non-theatrical, and free of role-play framing.'
    : '';
}

function resolveBackstageDirectAnswerBulletCount(contract: BackstageDirectAnswerOutputContract): number {
  return contract.requestedBulletCount ?? 5;
}

const NUMBER_WORDS = new Map<string, number>([
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
  ['ten', 10],
  ['eleven', 11],
  ['twelve', 12]
]);

function parseBackstageDirectAnswerOutputContract(prompt: string): BackstageDirectAnswerOutputContract {
  const normalizedPrompt = prompt.trim();
  const bulletMatch = normalizedPrompt.match(
    /\b(?:(?<digitCount>\d{1,2})|(?<wordCount>one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\s+(?<shortness>short\s+)?bullets?\b/i
  );

  if (!bulletMatch?.groups) {
    return {
      requiresShortBullets: /\bshort\s+bullets?\b/i.test(normalizedPrompt)
    };
  }

  const digitCount = bulletMatch.groups.digitCount ? Number.parseInt(bulletMatch.groups.digitCount, 10) : undefined;
  const wordCount = bulletMatch.groups.wordCount
    ? NUMBER_WORDS.get(bulletMatch.groups.wordCount.toLowerCase())
    : undefined;

  return {
    requestedBulletCount: digitCount ?? wordCount,
    requiresShortBullets: Boolean(bulletMatch.groups.shortness) || /\bshort\s+bullets?\b/i.test(normalizedPrompt)
  };
}

function stripMarkdownFormatting(value: string): string {
  return value
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.+?)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripBackstageDirectAnswerPreamblePrefix(value: string): string {
  return value.replace(
    /^(?:quick\s+gut\s+check|gut\s+read|quick\s+take|direct\s+answer|bottom\s+line)\s*:\s*/i,
    ''
  ).trim();
}

function collectTopLevelListItems(text: string): string[] {
  const items: string[] = [];
  let currentItem = '';

  for (const line of text.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    const indentation = line.match(/^\s*/)?.[0].length ?? 0;

    if (!trimmedLine || /^---+$/.test(trimmedLine) || /^#{1,6}\s+/.test(trimmedLine)) {
      continue;
    }

    const isTopLevelItem = indentation <= 1 && /^(?:[-*]|\d+\.)\s+/.test(trimmedLine);
    const isNestedItem = indentation > 1 && /^(?:[-*]|\d+\.)\s+/.test(trimmedLine);

    if (isTopLevelItem) {
      if (currentItem) {
        items.push(currentItem.trim());
      }
      currentItem = trimmedLine.replace(/^(?:[-*]|\d+\.)\s+/, '');
      continue;
    }

    if (currentItem) {
      const appendedLine = isNestedItem
        ? trimmedLine.replace(/^(?:[-*]|\d+\.)\s+/, '')
        : trimmedLine;
      currentItem = `${currentItem} ${appendedLine}`.trim();
    }
  }

  if (currentItem) {
    items.push(currentItem.trim());
  }

  return items;
}

function compactBackstageBulletItem(item: string, requiresShortBullets: boolean): string {
  const normalizedItem = stripBackstageDirectAnswerPreamblePrefix(stripMarkdownFormatting(item));

  if (!requiresShortBullets) {
    return normalizedItem;
  }

  const emphasizedHeadingMatch = item.match(/\*\*(.+?)\*\*/);
  if (emphasizedHeadingMatch?.[1]) {
    return stripMarkdownFormatting(emphasizedHeadingMatch[1]);
  }

  if (normalizedItem.length <= 160) {
    return normalizedItem;
  }

  const firstClause = normalizedItem.split(/\s[–-]\s/)[0]?.trim();
  if (firstClause && firstClause.length >= 24) {
    return firstClause;
  }

  return normalizedItem.length > 160
    ? `${normalizedItem.slice(0, 157).trimEnd()}...`
    : normalizedItem;
}

function applyBackstageDirectAnswerOutputContract(
  output: string,
  prompt: string
): string {
  const contract = parseBackstageDirectAnswerOutputContract(prompt);
  const requestedBulletCount = resolveBackstageDirectAnswerBulletCount(contract);
  const listItems = collectTopLevelListItems(output);

  //audit Assumption: prompts that request a fixed bullet count want the final answer body, not model preambles/headings; failure risk: direct-answer mode still returns “Gut read” intros and oversized list items; expected invariant: bullet-shaped requests return only top-level bullets, capped to the requested count; handling strategy: extract top-level list items, trim extras, and compact each item when the prompt asks for short bullets.
  if (listItems.length > 0) {
    return listItems
      .slice(0, requestedBulletCount)
      .map((item, index) => `${index + 1}. ${compactBackstageBulletItem(item, contract.requiresShortBullets)}`)
      .join('\n');
  }

  return stripBackstageDirectAnswerPreamblePrefix(stripMarkdownFormatting(output));
}

function buildBackstageResponseStyleInstruction(
  directAnswerMode: boolean,
  directAnswerContract: BackstageDirectAnswerOutputContract | null
): string {
  if (!directAnswerMode) {
    return `${BOOKING_RESPONSE_GUIDELINES().trim()}${buildBackstageResponseStyleSuffix(false)}`;
  }

  const contract = directAnswerContract ?? {
    requiresShortBullets: false
  };
  const requestedBulletCount = resolveBackstageDirectAnswerBulletCount(contract);

  return [
    `Return only ${requestedBulletCount} top-level numbered bullets.`,
    'No preamble, headings, divider lines, or conclusion.',
    'No sub-bullets, no production notes, no consequences section, and no meta commentary.',
    contract.requiresShortBullets
      ? 'Each bullet must be one compact sentence.'
      : 'Each bullet must be one compact paragraph.',
    'Each bullet should contain only the core booking beat for that week or phase.'
  ].join('\n');
}

function resolveBackstageBookerTokenLimit(prompt: string, defaultTokenLimit: number): number {
  if (!shouldPreferDirectAnswerMode(prompt)) {
    return defaultTokenLimit;
  }

  const contract = parseBackstageDirectAnswerOutputContract(prompt);
  const requestedBulletCount = resolveBackstageDirectAnswerBulletCount(contract);
  const tokenBudgetPerBullet = contract.requiresShortBullets ? 48 : 80;
  const directAnswerTokenLimit = Math.max(96, requestedBulletCount * tokenBudgetPerBullet);

  //audit Assumption: direct-answer backstage prompts do not need the full long-form booking token budget; failure risk: oversized generations ignore the bullet-only contract and increase timeout pressure; expected invariant: direct-answer mode uses a smaller bounded token budget proportional to requested bullet count; handling strategy: clamp direct-answer requests to a conservative per-bullet allowance.
  return Math.min(defaultTokenLimit, directAnswerTokenLimit);
}

async function buildStructuredBookingPrompt(basePrompt: string): Promise<string> {
  const directAnswerMode = shouldPreferDirectAnswerMode(basePrompt);
  const directAnswerContract = directAnswerMode
    ? parseBackstageDirectAnswerOutputContract(basePrompt)
    : null;

  try {
    const [rosterResult, eventsResult, beatsResult, savedStoriesResult] = await Promise.all([
      query(
        'SELECT name, overall, updated_at FROM backstage_wrestlers ORDER BY updated_at DESC LIMIT 25',
        [],
        1,
        true
      ),
      query(
        'SELECT data, created_at FROM backstage_events ORDER BY created_at DESC LIMIT 5',
        [],
        1,
        true
      ),
      query(
        'SELECT data, created_at FROM backstage_story_beats ORDER BY created_at DESC LIMIT 5',
        [],
        1,
        true
      ),
      query(
        'SELECT story_key, storyline, updated_at FROM backstage_storylines ORDER BY updated_at DESC LIMIT 5',
        [],
        1,
        true
      )
    ]);

    const rosterBlock = rosterResult.rows.length
      ? rosterResult.rows
          .map(row => `- ${row.name} (Overall ${row.overall}) • updated ${toISODate(row.updated_at)}`)
          .join('\n')
      : 'No roster data recorded yet.';

    const eventsBlock = eventsResult.rows.length
      ? eventsResult.rows
          .map(row => {
            const payload = row.data as Record<string, unknown> | undefined;
            const label =
              (payload?.name as string | undefined) ||
              (payload?.title as string | undefined) ||
              'Unlabeled Event';
            return `- ${label} • booked ${toISODate(row.created_at)} :: ${formatJsonSnippet(payload)}`;
          })
          .join('\n')
      : 'No events booked yet.';

    const beatsBlock = beatsResult.rows.length
      ? beatsResult.rows
          .map(row => `- ${toISODate(row.created_at)} :: ${formatJsonSnippet(row.data)}`)
          .join('\n')
      : 'No story beats recorded yet.';

    const savedStoriesBlock = savedStoriesResult.rows.length
      ? savedStoriesResult.rows
          .map(row => `- ${row.story_key}: ${formatJsonSnippet(row.storyline, 260)}`)
          .join('\n')
      : 'No saved storylines yet.';

    //audit Assumption: explicit anti-simulation booking prompts should suspend the theatrical persona while preserving roster continuity; failure risk: direct-answer requests still receive in-character backstage narration; expected invariant: direct-answer mode swaps persona framing for neutral execution guidance only; handling strategy: emit an execution-mode section when the prompt contains explicit non-simulation cues.
    const sections = [
      directAnswerMode
        ? `<<EXECUTION_MODE>>\n${buildBackstageDirectAnswerModeInstruction()}`
        : `<<PERSONA>>\n${BACKSTAGE_BOOKER_PERSONA()}`,
      `<<BOOKING_DIRECTIVE>>\n${basePrompt.trim()}`,
      `<<CURRENT_ROSTER>>\n${rosterBlock}`,
      `<<RECENT_EVENTS>>\n${eventsBlock}`,
      `<<RECENT_STORY_BEATS>>\n${beatsBlock}`,
      `<<SAVED_STORYLINES>>\n${savedStoriesBlock}`,
      `<<RESPONSE_STYLE>>\n${buildBackstageResponseStyleInstruction(directAnswerMode, directAnswerContract)}`
    ];

    return `${sections.join('\n\n')}${BOOKING_INSTRUCTIONS_SUFFIX()}`;
  } catch (error) {
    console.warn('Backstage Booker: falling back to in-memory context', (error as Error).message);
    const fallbackRoster = roster.length
      ? roster.map(w => `- ${w.name} (Overall ${w.overall})`).join('\n')
      : 'No roster data recorded yet.';
    const fallbackStories = storylines.length
      ? storylines.map((entry, idx) => `- #${idx + 1}: ${formatJsonSnippet(entry)}`).join('\n')
      : 'No story beats recorded yet.';

    //audit Assumption: fallback continuity mode must preserve the same direct-answer vs persona split as the primary database-backed prompt builder; failure risk: DB outages reintroduce simulation-heavy framing that the primary path suppresses; expected invariant: execution mode remains stable regardless of data source; handling strategy: reuse the same direct-answer prompt sections in the fallback branch.
    const sections = [
      directAnswerMode
        ? `<<EXECUTION_MODE>>\n${buildBackstageDirectAnswerModeInstruction()}`
        : `<<PERSONA>>\n${BACKSTAGE_BOOKER_PERSONA()}`,
      `<<BOOKING_DIRECTIVE>>\n${basePrompt.trim()}`,
      `<<CURRENT_ROSTER>>\n${fallbackRoster}`,
      `<<RECENT_STORY_BEATS>>\n${fallbackStories}`,
      `<<RESPONSE_STYLE>>\n${buildBackstageResponseStyleInstruction(directAnswerMode, directAnswerContract)}`
    ];

    return `${sections.join('\n\n')}${BOOKING_INSTRUCTIONS_SUFFIX()}`;
  }
}

/**
 * Resolve the model used for backstage booking generation.
 * Inputs/outputs: none -> explicit USER_GPT_ID override when present, otherwise the shared GPT-5 model fallback.
 * Edge cases: trims legacy env overrides so blank strings do not block the standard fallback model.
 */
function resolveBackstageBookerModel(): string {
  const configuredUserModel = getEnv('USER_GPT_ID')?.trim();
  //audit Assumption: legacy USER_GPT_ID overrides should remain supported, but blank/missing values must not break backstage generation; failure risk: booker path 500s in environments that only configure the shared model stack; expected invariant: a usable model is always selected when global OpenAI config is healthy; handling strategy: prefer USER_GPT_ID when present, else fall back to getGPT5Model().
  if (configuredUserModel) {
    return configuredUserModel;
  }

  return getGPT5Model();
}

export async function bookEvent(data: EventData): Promise<string> {
  const id = randomUUID();
  try {
    await query(
      'INSERT INTO backstage_events (id, data, created_at) VALUES ($1, $2, NOW())',
      [id, data]
    );
    events.push({ id, data });
    if (events.length > 25) {
      events.shift();
    }
    return id;
  } catch (error) {
    console.warn('Backstage Booker: falling back to in-memory events store', (error as Error).message);
    events.push({ id, data });
    return id;
  }
}

export async function updateRoster(wrestlers: Wrestler[]): Promise<Wrestler[]> {
  try {
    await Promise.all(
      wrestlers.map(wrestler =>
        query(
          `INSERT INTO backstage_wrestlers (name, overall, created_at, updated_at)
           VALUES ($1, $2, NOW(), NOW())
           ON CONFLICT (name)
           DO UPDATE SET overall = EXCLUDED.overall, updated_at = NOW()`,
          [wrestler.name, wrestler.overall]
        )
      )
    );

    const result = await query(
      'SELECT name, overall FROM backstage_wrestlers ORDER BY name ASC',
      [],
      1,
      true
    );

    roster = result.rows.map(row => ({ name: row.name as string, overall: Number(row.overall) }));
    await persistLatestRosterSnapshot(roster, "database");
    return roster;
  } catch (error) {
    console.warn('Backstage Booker: roster DB unavailable, using in-memory roster', (error as Error).message);
    wrestlers.forEach(w => {
      const idx = roster.findIndex(r => r.name === w.name);
      if (idx >= 0) {
        roster[idx] = w;
      } else {
        roster.push(w);
      }
    });
    await persistLatestRosterSnapshot(roster, "fallback");
    return roster;
  }
}

export async function trackStoryline(data: Storyline): Promise<Storyline[]> {
  try {
    await query('INSERT INTO backstage_story_beats (data, created_at) VALUES ($1, NOW())', [data]);
    const result = await query(
      'SELECT data FROM backstage_story_beats ORDER BY created_at ASC',
      [],
      1,
      true
    );
    storylines.length = 0;
    storylines.push(...result.rows.map(row => row.data));
    await persistLatestStoryBeatsSnapshot([...storylines], "database");
    return [...storylines];
  } catch (error) {
    console.warn('Backstage Booker: storyline DB unavailable, using in-memory log', (error as Error).message);
    storylines.push(data);
    await persistLatestStoryBeatsSnapshot([...storylines], "fallback");
    return [...storylines];
  }
}

/**
 * Generate a backstage booking response from the current roster and continuity context.
 * Inputs/outputs: natural-language booking prompt -> finalized storyline or booking plan string.
 * Edge cases: exact-literal anti-simulation prompts short-circuit before persona/context expansion, and database failures fall back to in-memory continuity snapshots.
 */
export async function generateBooking(prompt: string): Promise<string> {
  const exactLiteralShortcut = tryExtractExactLiteralPromptShortcut(prompt);
  //audit Assumption: literal-only backstage prompts should bypass persona/context expansion; failure risk: the booker persona or context scaffolding wraps the required literal in storytelling language; expected invariant: recognized exact-literal directives return verbatim output; handling strategy: short-circuit before prompt construction and provider invocation.
  if (exactLiteralShortcut) {
    return exactLiteralShortcut.literal;
  }

  const model = resolveBackstageBookerModel();
  const tokenLimit = resolveBackstageBookerTokenLimit(
    prompt,
    getEnvNumber('BOOKER_TOKEN_LIMIT', 512)
  );
  const instructions = await buildStructuredBookingPrompt(prompt);
  try {
    const { output } = await callOpenAI(model, instructions, tokenLimit, false);
    const clean = output.replace(/\b(meta|reflection)[:].*$/gi, '').trim();
    //audit Assumption: direct-answer backstage prompts may still pick up model preambles or overlong list structures despite stricter prompt instructions; failure risk: live responses ignore “five short bullets” and reopen simulation-style framing; expected invariant: direct-answer output respects the caller's requested list shape; handling strategy: apply a prompt-aware cleanup pass only when direct-answer mode is active.
    if (shouldPreferDirectAnswerMode(prompt)) {
      return applyBackstageDirectAnswerOutputContract(clean, prompt);
    }
    return clean;
  } catch (error) {
    console.error('Failed to generate booking storyline:', error);
    throw new Error('Booking generation failed');
  }
}

export async function saveStoryline(key: string, storyline: string): Promise<boolean> {
  const data = { key, storyline };
  const result = await saveWithAuditCheck(
    'backstage_booker',
    data,
    d => typeof d.storyline === 'string' && d.storyline.trim().length > 0
  );
  if (result) {
    try {
      await query(
        `INSERT INTO backstage_storylines (story_key, storyline, created_at, updated_at)
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (story_key)
         DO UPDATE SET storyline = EXCLUDED.storyline, updated_at = NOW()`,
        [key, storyline]
      );
    } catch (error) {
      console.warn('Backstage Booker: failed to persist storyline to DB', (error as Error).message);
    }
    await persistLatestStorylineSnapshot(key, storyline, "database");
  } else {
    //audit Assumption: failed audit-safe validation should still keep a transient breadcrumb for operators; failure risk: lost debugging context; expected invariant: invalid data not written to core storyline table; handling strategy: write fallback-tagged snapshot key only.
    await persistLatestStorylineSnapshot(key, storyline, "fallback");
  }
  return result;
}

export async function simulateMatch(
  match: MatchInput,
  rosters: Wrestler[] = [],
  winProbModifier = 0
): Promise<KayfabeResult | RealResult> {
  const { wrestler1, wrestler2, matchType, kayfabeMode = false } = match;

  let activeRoster = rosters;

  if (!activeRoster || activeRoster.length === 0) {
    try {
      const result = await query(
        'SELECT name, overall FROM backstage_wrestlers ORDER BY name ASC',
        [],
        1,
        true
      );
      activeRoster = result.rows.map(row => ({ name: row.name as string, overall: Number(row.overall) }));
    } catch (error) {
      console.warn('Backstage Booker: match simulation falling back to in-memory roster', (error as Error).message);
      activeRoster = roster;
    }
  }

  const w1 = activeRoster.find(r => r.name === wrestler1);
  const w2 = activeRoster.find(r => r.name === wrestler2);

  if (!w1 || !w2) {
    throw new Error('One or both wrestlers not found in roster');
  }

  let w1Chance = w1.overall / (w1.overall + w2.overall);
  let w2Chance = 1 - w1Chance;

  w1Chance = Math.min(Math.max(w1Chance + winProbModifier, 0), 1);
  w2Chance = 1 - w1Chance;

  let interference: string | null = null;
  if (Math.random() < 0.1 && activeRoster.length > 0) {
    interference = activeRoster[Math.floor(Math.random() * activeRoster.length)].name;
    if (Math.random() > 0.5) {
      w1Chance = Math.min(Math.max(w1Chance + 0.15, 0), 1);
    } else {
      w1Chance = Math.min(Math.max(w1Chance - 0.15, 0), 1);
    }
    w2Chance = 1 - w1Chance;
  }

  const roll = Math.random();
  const winner = roll < w1Chance ? wrestler1 : wrestler2;
  const loser = winner === wrestler1 ? wrestler2 : wrestler1;
  const rating = (Math.random() * 4 + 1).toFixed(1);

  if (kayfabeMode) {
    return {
      match: `${wrestler1} vs ${wrestler2} (${matchType})`,
      result: `${winner} wins`,
      via: 'Pinfall',
      interference,
      rating
    };
  }

  return {
    match: `${wrestler1} vs ${wrestler2} (${matchType})`,
    winner,
    loser,
    probability: {
      [wrestler1]: w1Chance.toFixed(2),
      [wrestler2]: w2Chance.toFixed(2)
    },
    interference,
    rating
  };
}

export const BackstageBooker = {
  bookEvent,
  updateRoster,
  trackStoryline,
  simulateMatch,
  generateBooking,
  saveStoryline
};

function normalizePayloadRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload must be an object');
  }
  return payload as Record<string, unknown>;
}

export const BackstageBookerModule = {
  name: 'BACKSTAGE:BOOKER',
  description: 'Behind-the-scenes pro wrestling booker for WWE/AEW with strict canon and logic.',
  gptIds: ['backstage-booker', 'backstage'],
  defaultAction: 'generateBooking',
  actions: {
    async bookEvent(payload: unknown) {
      const record = normalizePayloadRecord(payload);
      return BackstageBooker.bookEvent(record);
    },
    async updateRoster(payload: Wrestler[]) {
      return BackstageBooker.updateRoster(payload);
    },
    async trackStoryline(payload: unknown) {
      const record = normalizePayloadRecord(payload);
      return BackstageBooker.trackStoryline(record);
    },
    async simulateMatch(payload: { match: MatchInput; rosters: Wrestler[]; winProbModifier?: number }) {
      const result = await BackstageBooker.simulateMatch(payload.match, payload.rosters, payload.winProbModifier ?? 0);
      return withHRC(result as typeof result & Record<string, unknown>, r => r.match);
    },
    async generateBooking(payload: { prompt: string }) {
      // Maintain backward-compatible behavior: return the raw storyline string.
      return BackstageBooker.generateBooking(payload.prompt);
    },
    async generateBookingWithHRC(payload: { prompt: string }) {
      const storyline = await BackstageBooker.generateBooking(payload.prompt);
      const hrc = await evaluateWithHRC(storyline);
      return { storyline, hrc };
    },
    async saveStoryline(payload: { key: string; storyline: string }) {
      return BackstageBooker.saveStoryline(payload.key, payload.storyline);
    }
  }
};

export default BackstageBookerModule;

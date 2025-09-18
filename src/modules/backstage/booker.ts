import { randomUUID } from 'crypto';
import { callOpenAI } from '../../services/openai.js';
import { saveWithAuditCheck } from '../../services/persistenceManager.js';
import {
  BACKSTAGE_BOOKER_PERSONA,
  BOOKING_INSTRUCTIONS_SUFFIX,
  BOOKING_RESPONSE_GUIDELINES
} from '../../config/prompts.js';
import { query } from '../../db.js';

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

// Internal in-memory stores
const events: Array<{ id: string; data: any }> = [];
let roster: Wrestler[] = [];
const storylines: Array<any> = [];

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

async function buildStructuredBookingPrompt(basePrompt: string): Promise<string> {
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

    const sections = [
      `<<PERSONA>>\n${BACKSTAGE_BOOKER_PERSONA}`,
      `<<BOOKING_DIRECTIVE>>\n${basePrompt.trim()}`,
      `<<CURRENT_ROSTER>>\n${rosterBlock}`,
      `<<RECENT_EVENTS>>\n${eventsBlock}`,
      `<<RECENT_STORY_BEATS>>\n${beatsBlock}`,
      `<<SAVED_STORYLINES>>\n${savedStoriesBlock}`,
      `<<RESPONSE_STYLE>>\n${BOOKING_RESPONSE_GUIDELINES.trim()}`
    ];

    return `${sections.join('\n\n')}${BOOKING_INSTRUCTIONS_SUFFIX}`;
  } catch (error) {
    console.warn('Backstage Booker: falling back to in-memory context', (error as Error).message);
    const fallbackRoster = roster.length
      ? roster.map(w => `- ${w.name} (Overall ${w.overall})`).join('\n')
      : 'No roster data recorded yet.';
    const fallbackStories = storylines.length
      ? storylines.map((entry, idx) => `- #${idx + 1}: ${formatJsonSnippet(entry)}`).join('\n')
      : 'No story beats recorded yet.';

    const sections = [
      `<<PERSONA>>\n${BACKSTAGE_BOOKER_PERSONA}`,
      `<<BOOKING_DIRECTIVE>>\n${basePrompt.trim()}`,
      `<<CURRENT_ROSTER>>\n${fallbackRoster}`,
      `<<RECENT_STORY_BEATS>>\n${fallbackStories}`,
      `<<RESPONSE_STYLE>>\n${BOOKING_RESPONSE_GUIDELINES.trim()}`
    ];

    return `${sections.join('\n\n')}${BOOKING_INSTRUCTIONS_SUFFIX}`;
  }
}

/**
 * Books an event by storing the payload and returning an id.
 */
export async function bookEvent(data: any): Promise<string> {
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

/**
 * Updates the roster. Existing wrestlers are replaced, new ones added.
 */
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
    return roster;
  }
}

/**
 * Tracks storyline information by appending to the internal array.
 */
export async function trackStoryline(data: any): Promise<any[]> {
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
    return [...storylines];
  } catch (error) {
    console.warn('Backstage Booker: storyline DB unavailable, using in-memory log', (error as Error).message);
    storylines.push(data);
    return [...storylines];
  }
}

/**
 * Generates a booking storyline using a custom GPT model.
 * Ensures the response contains no meta-data or self reflections.
 */
export async function generateBooking(prompt: string): Promise<string> {
  const model = process.env.USER_GPT_ID;
  if (!model) {
    throw new Error('USER_GPT_ID not configured');
  }
  const tokenLimit = parseInt(process.env.BOOKER_TOKEN_LIMIT ?? '512', 10);
  const instructions = await buildStructuredBookingPrompt(prompt);
  try {
    const { output } = await callOpenAI(model, instructions, tokenLimit, false);
    const clean = output.replace(/\b(meta|reflection)[:].*$/gi, '').trim();
    return clean;
  } catch (error) {
    console.error('Failed to generate booking storyline:', error);
    throw new Error('Booking generation failed');
  }
}

/**
 * Saves a storyline to persistent storage without additional metadata.
 */
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
  }
  return result;
}

/**
 * Simulates a wrestling match using wrestler overalls and optional
 * probability modifiers. Can optionally return kayfabe-style results.
 */
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

export default BackstageBooker;


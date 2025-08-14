import { randomUUID } from 'crypto';

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

/**
 * Books an event by storing the payload and returning an id.
 */
export async function bookEvent(data: any): Promise<string> {
  const id = randomUUID();
  events.push({ id, data });
  return id;
}

/**
 * Updates the roster. Existing wrestlers are replaced, new ones added.
 */
export async function updateRoster(wrestlers: Wrestler[]): Promise<Wrestler[]> {
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

/**
 * Tracks storyline information by appending to the internal array.
 */
export async function trackStoryline(data: any): Promise<any[]> {
  storylines.push(data);
  return storylines;
}

/**
 * Simulates a wrestling match using wrestler overalls and optional
 * probability modifiers. Can optionally return kayfabe-style results.
 */
export async function simulateMatch(
  match: MatchInput,
  rosters: Wrestler[],
  winProbModifier = 0
): Promise<KayfabeResult | RealResult> {
  const { wrestler1, wrestler2, matchType, kayfabeMode = false } = match;

  const w1 = rosters.find(r => r.name === wrestler1);
  const w2 = rosters.find(r => r.name === wrestler2);

  if (!w1 || !w2) {
    throw new Error('One or both wrestlers not found in roster');
  }

  let w1Chance = w1.overall / (w1.overall + w2.overall);
  let w2Chance = 1 - w1Chance;

  w1Chance = Math.min(Math.max(w1Chance + winProbModifier, 0), 1);
  w2Chance = 1 - w1Chance;

  let interference: string | null = null;
  if (Math.random() < 0.1 && rosters.length > 0) {
    interference = rosters[Math.floor(Math.random() * rosters.length)].name;
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
  simulateMatch
};

export default BackstageBooker;


import { BackstageBooker } from '@services/backstage-booker.js';

export interface BackstageBookerIntentMatch {
  score: number;
  reason: string;
}

export interface BackstageBookerRouteShortcut {
  resultText: string;
  dispatcher: {
    module: 'BACKSTAGE:BOOKER';
    action: 'generateBooking';
    reason: string;
  };
}

const explicitBookerPattern =
  /\b(?:backstage\s+booker|booker\s+logic|booking\s+logic|creative\s+team|wrestling\s+booker)\b/i;
const bookingVerbPattern =
  /\b(?:book|booking|generate|create|plan|write|draft|build|pitch|map\s+out|set\s+up|setup)\b/i;
const storylineRequestPattern =
  /\b(?:rivalr(?:y|ies)|feud|storyline|angle|promo|match\s*card|card|segment|main\s+event|title\s+picture)\b/i;
const wrestlingBrandPattern =
  /\b(?:wwe|aew|raw|smackdown|nxt|wrestlemania|royal\s+rumble|survivor\s+series|ple|ppv|roster|wrestler|champion|contender)\b/i;
const wrestlingJargonPattern =
  /\b(?:heel|babyface|face\s+turn|heel\s+turn|faction|stable|run[-\s]?in|no\.?\s*1\s+contender)\b/i;

/**
 * Detect whether a prompt is explicitly asking for pro-wrestling booking output.
 * Inputs/outputs: raw prompt text -> scored match with deterministic reason, or null when cues are insufficient.
 * Edge cases: requires both booking intent and wrestling-specific context so generic "rivalry" prompts do not auto-route.
 */
export function detectBackstageBookerIntent(prompt: string | null | undefined): BackstageBookerIntentMatch | null {
  const normalizedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
  //audit Assumption: empty prompts cannot carry enough routing signal for backstage booking; failure risk: empty traffic auto-routed into booker generation; expected invariant: prompt text exists before cue scoring; handling strategy: return null on blank input.
  if (!normalizedPrompt) {
    return null;
  }

  const matchedReasons: string[] = [];
  let score = 0;

  //audit Assumption: explicit booker phrasing is the strongest routing cue; failure risk: explicit backstage requests still fall through to Trinity; expected invariant: explicit cues dominate score; handling strategy: add a high-confidence score weight and record the reason.
  if (explicitBookerPattern.test(normalizedPrompt)) {
    score += 3;
    matchedReasons.push('explicit_booker_phrase');
  }

  if (bookingVerbPattern.test(normalizedPrompt)) {
    score += 2;
    matchedReasons.push('booking_verb');
  }

  if (storylineRequestPattern.test(normalizedPrompt)) {
    score += 2;
    matchedReasons.push('storyline_request');
  }

  const hasBrandCue = wrestlingBrandPattern.test(normalizedPrompt);
  if (hasBrandCue) {
    score += 2;
    matchedReasons.push('wrestling_brand');
  }

  const hasJargonCue = wrestlingJargonPattern.test(normalizedPrompt);
  if (hasJargonCue) {
    score += 1;
    matchedReasons.push('wrestling_jargon');
  }

  //audit Assumption: auto-routing must require wrestling-specific context in addition to generic rivalry/storyline language; failure risk: non-wrestling creative prompts get hijacked by backstage booking; expected invariant: at least one strong wrestling-domain cue is present; handling strategy: reject matches without brand/jargon/explicit booker evidence.
  if (!hasBrandCue && !hasJargonCue && !matchedReasons.includes('explicit_booker_phrase')) {
    return null;
  }

  //audit Assumption: a threshold of 4 balances recall and precision for routing; failure risk: vague prompts either miss booking flow or over-trigger it; expected invariant: only clearly booking-oriented prompts pass; handling strategy: require threshold and emit a deterministic reason string.
  if (score < 4) {
    return null;
  }

  return {
    score,
    reason: matchedReasons.join('+')
  };
}

/**
 * Execute a deterministic backstage-booker shortcut for chat-style routes.
 * Inputs/outputs: prompt text -> generated booking response when the prompt clearly targets wrestling booking, otherwise null.
 * Edge cases: returns null when routing confidence is insufficient so generic prompts continue through their normal pipeline.
 */
export async function tryExecuteBackstageBookerRouteShortcut(params: {
  prompt: string;
  sessionId?: string;
}): Promise<BackstageBookerRouteShortcut | null> {
  const intentMatch = detectBackstageBookerIntent(params.prompt);
  //audit Assumption: non-booking prompts should preserve their existing route behavior; failure risk: over-eager interception on generic chat inputs; expected invariant: only scored booker prompts short-circuit; handling strategy: return null when detection fails.
  if (!intentMatch) {
    return null;
  }

  const resultText = await BackstageBooker.generateBooking(params.prompt);
  return {
    resultText,
    dispatcher: {
      module: 'BACKSTAGE:BOOKER',
      action: 'generateBooking',
      reason: intentMatch.reason
    }
  };
}

import { detectGamingRegistryAlias, gamingRegistrySourceGameMatchesRequest,
  gamingRegistryLiteralPattern, normalizeGamingComparableIdentity, resolveGamingRegistryGame } from './gamingGameRegistry.js';
import { isGamingAcquiredTopicTitle } from '@services/gamingGameDetection.js';

export type GamingIdentityResolutionState = 'IDENTITY_VERIFIED' | 'IDENTITY_UNVERIFIED'
  | 'IDENTITY_CONFLICT' | 'INSUFFICIENT_EVIDENCE';

/** Recognition never proves identity. Ordinary words and undeclared acronyms
 * need explicit acquired game context, even when they equal the request. */
export function gamingIdentityNeedsExplicitContext(value: string): boolean {
  if (detectGamingRegistryAlias(value, true, true)) return false;
  const entry = resolveGamingRegistryGame(value);
  if (entry && normalizeGamingComparableIdentity(value) === normalizeGamingComparableIdentity(entry.name)) return false;
  return isGamingAcquiredTopicTitle(value) || !/[\s:–—-]/u.test(value.trim()) || /^[\p{Lu}\d]{2,8}$/u.test(value.trim());
}

/** Compare an already acquired declarative subject, never a URL or player label. */
export function resolveGamingAcquiredIdentity(input: {
  sourceGame: string; requestedGame: string; explicitGameContext?: boolean;
}): GamingIdentityResolutionState {
  if (!input.sourceGame.trim() || !input.requestedGame.trim()) return 'INSUFFICIENT_EVIDENCE';
  if (input.sourceGame.length > 160 || input.requestedGame.length > 120) return 'IDENTITY_UNVERIFIED';
  if (!gamingRegistrySourceGameMatchesRequest(input.sourceGame, input.requestedGame)) return 'IDENTITY_CONFLICT';
  if (!input.explicitGameContext && (gamingIdentityNeedsExplicitContext(input.sourceGame)
    || gamingIdentityNeedsExplicitContext(input.requestedGame))) return 'IDENTITY_UNVERIFIED';
  return 'IDENTITY_VERIFIED';
}

/** A full game name owning an affirmative sentence is separate acquired prose.
 * Negated, requested, compared and whole-quoted mentions never match this form. */
export function hasGamingAffirmativeIdentityProse(unquotedText: string, game: string, explicitGameDeclared = false): boolean {
  if (gamingIdentityNeedsExplicitContext(game)) return false;
  const entry = resolveGamingRegistryGame(game);
  const names = [game, ...(entry ? [entry.name, ...entry.aliases] : [])];
  return names.some(name => {
    const title = gamingRegistryLiteralPattern(name);
    const affirmativePredicate = '(?!(?:not|never|no|nothing|neither)\\b)(?!(?:only|merely|solely|just)\\s+(?:(?:as|in)\\s+)?(?:a\\s+)?(?:comparison|reference|quote|quotation|request)\\b)';
    return new RegExp(`(?:^|[.!?;\\n])\\s*${title}\\s+(?:has|uses|offers|features|releases|starts|begins|requires|supports|includes)\\s+${affirmativePredicate}[^.!?;\\n\\s]`, 'iu').test(unquotedText)
      || new RegExp(`(?:^|[.!?;\\n])\\s*${title}\\s+is\\s+(?:played\\s+(?:with|by|on|in)|set\\s+in|built\\s+around|focused\\s+on)\\s+${affirmativePredicate}[^.!?;\\n\\s]`, 'iu').test(unquotedText)
      || new RegExp(`(?:^|[.!?;\\n])\\s*this\\s+${title}\\s+(?:guide|article|build|walkthrough|source|page|document)\\s+(?:is\\s+(?:for|about)|covers|explains|describes|shows|documents|provides)\\b`, 'iu').test(unquotedText)
      || new RegExp(`(?:^|[.!?;\\n])\\s*this\\s+(?:guide|article|walkthrough)\\s+(?:explains|describes|documents|provides)\\s+(?![^.!?;\\n]{0,120}\\b(?:not|never|without|unlike|compared?)\\b)[^.!?;\\n]{0,120}?\\bin\\s+${title}(?=\\s+and\\s+(?:gives|provides|explains|describes)\\b|[,;.!?]|$)`, 'iu').test(unquotedText)
      || explicitGameDeclared && (new RegExp(`(?:^|[.!?;\\n])\\s*the\\s+${title}\\s+[\\p{L}\\p{N}'’ -]{1,64}\\s+(?:use|provide|require|support|offer|feature|include)\\b`, 'iu').test(unquotedText)
        || new RegExp(`(?:^|[.!?;\\n])\\s*in\\s+(?:early|late|mid(?:[\\s-]+game)?)\\s+${title}\\s*,`, 'iu').test(unquotedText));
  });
}

/** Source-local aliases are assertions. Callers must separately corroborate the
 * full canonical title before using any alias; collisions never pick a winner. */
export function readGamingAcquiredAliasDeclarations(unquotedText: string): {
  declarations: Array<{ canonical: string; alias: string; index: number }>; complete: boolean;
} {
  const declarations: Array<{ canonical: string; alias: string; index: number }> = [];
  for (const match of unquotedText.matchAll(/(?:^|[.!?;\n])\s*(?:the\s+)?game\s+([^.!?;\n]{1,120}?)\s+is\s+also\s+known\s+as\s+([\p{L}\p{N}][\p{L}\p{N}'’ -]{0,31})(?=[.;,\n]|$)/giu)) {
    if (declarations.length >= 128) return { declarations, complete: false };
    declarations.push({ canonical: match[1].trim(), alias: match[2].trim(), index: match.index });
  }
  return { declarations, complete: true };
}

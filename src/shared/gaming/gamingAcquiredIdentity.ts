import { detectGamingRegistryAlias, gamingRegistrySourceGameMatchesRequest,
  gamingRegistryLiteralPattern, normalizeGamingComparableIdentity, resolveGamingRegistryGame } from './gamingGameRegistry.js';
import { isGamingAcquiredTopicTitle } from '@services/gamingGameDetection.js';

export type GamingIdentityResolutionState = 'IDENTITY_VERIFIED' | 'IDENTITY_UNVERIFIED'
  | 'IDENTITY_CONFLICT' | 'INSUFFICIENT_EVIDENCE';

/** A prepositional scope ends before its independent gameplay subject/predicate.
 * Without a nominal prefix, "in the game" refers to the established article game;
 * the following player instructions are not a newly named title. Keep case and
 * complete nominal suffixes so titles such as "Minecraft Has Fallen" stay intact. */
export function gamingAcquiredNominalScope(value: string, commaDelimited = false, namedGameScope = false): string | undefined {
  // Registry recognition protects a complete leading name regardless of case;
  // lowercasing a wrong game must not turn it into an ordinary sentence subject.
  const known = detectGamingRegistryAlias(value, true);
  const nameEnd = known ? Math.max(0, ...[known.name, ...known.aliases].map(name =>
    new RegExp(`^${gamingRegistryLiteralPattern(name)}(?=$|[^\\p{L}\\p{N}])`, 'iu').exec(value)?.[0].length ?? 0)) : 0;
  const continuationText = value.slice(nameEnd);
  // A pronoun-shaped title can also be a complete sentence. A comma closes
  // the acquired nominal scope regardless of capitalization; without that
  // boundary, keep its title/predicate ambiguity explicit rather than dropping it.
  if (!known && namedGameScope && /^(?:it|we|they|he|she)\s+/iu.test(value)
    && (commaDelimited || !/^\S+\s+(?:must|should)\b/iu.test(value)))
    return commaDelimited ? value : undefined;
  const personClause = /(?:^|\s)(?:(?:you|we|they|he|she|it|(?:new\s+|experienced\s+)?players|characters|your\s+character|the\s+player)(?:['’](?:re|ve|ll|d|s))?\s+\p{Ll}[\p{L}'’]*\b|there\s+(?:are|is)\b)/iu.exec(continuationText);
  // An independent player clause ends the preceding name, even if its words
  // could also match the broad lowercase gameplay-subject heuristic below.
  if (personClause && personClause.index > 0)
    return value.slice(0, nameEnd + personClause.index).trim();
  if (personClause?.index === 0) return value.slice(0, nameEnd).trim();
  // Multiword unfamiliar names followed directly by a finite predicate have
  // no independent subject boundary. Do not infer a different scope from case.
  if (!known && namedGameScope && /^(?!(?:the|your|our|their)\b)(?:\p{L}[\p{L}'’]*\s+){2,}(?:is|are|has|have|can|could|may|might|must|should|will|would|starts?|begins?|rewards?|requires?|offers?|contains?)\b/iu.test(value))
    return commaDelimited ? value : undefined;
  // An unfamiliar noun after a recognized family name may be its subtitle.
  // Only an independent person/existential clause can terminate that name.
  // A lowercase interface noun followed by a player-purpose clause belongs to
  // the game ("game console to inspect your party"), rather than naming it.
  const nominalClause = !known ? /(?:^|\s)(?:(?:\p{Lu}[\p{L}'’]*\s+){1,3}(?:can|could|may|might|must|should|will|would)\s+\p{Ll}[\p{L}'’]*\b|(?:(?:the|your|our|their)\s+)?(?:\p{Ll}[\p{L}'’]*\s+){1,3}(?:is|are|has|have|can|will|starts?|begins?|rewards?|requires?|offers?|contains?)\b|(?:console|menu|chat|interface)\s+to\s+\p{Ll}[\p{L}'’]*\s+(?:your|our|their)\b)/u.exec(continuationText) : null;
  const continuation = personClause && nominalClause ? (personClause.index < nominalClause.index ? personClause : nominalClause) : personClause ?? nominalClause;
  return continuation ? value.slice(0, nameEnd + continuation.index).trim() : value;
}

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
  for (const match of unquotedText.matchAll(/(?:^|[.!?;\n])\s*(?:the\s+)?game\s+([^.!?;\n]{1,120}?)\s+is\s+also\s+known\s+as\s+([\p{L}\p{N}][\p{L}\p{N}'’:–— -]{0,119})(?=[.;,\n]|$)/giu)) {
    if (declarations.length >= 128) return { declarations, complete: false };
    declarations.push({ canonical: match[1].trim(), alias: match[2].trim(), index: match.index });
  }
  return { declarations, complete: true };
}

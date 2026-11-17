import { resolveGamingFreshnessDisposition } from './gamingQuestionFreshnessPolicy.js';
import { normalizeGamingRegistryIdentity, resolveGamingRegistryGame, gamingRegistryLiteralPattern,
  normalizeGamingRegistryEdition, readGamingRegistryEditionScope } from './gamingGameRegistry.js';
import { GAMING_LEGACY_EDITION_GAME } from './gamingGameRegistryData.js';

/** Formatting equivalence only: edition, sequel, expansion and platform words remain identity. */
export function normalizeGamingGameIdentity(game: string): string {
  return normalizeGamingRegistryIdentity(game);
}

/** Closed edition aliases: punctuation and arbitrary qualifiers never become a recognized edition. */
export function normalizeGamingEditionIdentity(edition: string): string {
  const identity = edition.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
  return identity === 'base game' || identity === 'base-game' ? 'base-game' : identity;
}

/** Missing edition evidence is never a match, including when the requested edition is absent. */
export function gamingEditionIdentitiesMatch(left?: string, right?: string): boolean {
  const leftIdentity = left === undefined ? '' : normalizeGamingEditionIdentity(left);
  const rightIdentity = right === undefined ? '' : normalizeGamingEditionIdentity(right);
  return Boolean(leftIdentity && rightIdentity && leftIdentity === rightIdentity);
}

/** An explicit edition narrows identity; an already complete title is not duplicated. */
export function resolveGamingGuideIdentity(game: string, edition?: string): string {
  const identity = normalizeGamingGameIdentity(game);
  const editionIdentity = edition ? normalizeGamingGameIdentity(edition) : '';
  if (!editionIdentity || identity === editionIdentity || identity.endsWith(`-${editionIdentity}`)) return identity;
  return `${identity}-${editionIdentity}`;
}

/** Preserve existing catalog numeral spellings without collapsing a sequel or edition. */
export function normalizeGamingEvidenceGameIdentity(game: string): string {
  const numerals: Record<string, string> = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };
  return normalizeGamingGameIdentity(game).split('-').map(part => numerals[part] ?? part).join('-');
}

/** Source-attributed title descriptions never choose a player's edition. */
function gamingRequestScopeText(question: string): string {
  return question.replace(/https?:\/\/[^\s)]+/giu, ' ')
    .replace(/(?:^|(?<=[.!?])\s+)(?:(?:the|this|that)\s+)?(?:(?:submitted|supplied|cited)\s+)?(?:guide|source)\s+(?:is\s+|was\s+)?(?:titled|named|for|about|reports?|says?|covers?)\b[^.!?\n]{0,240}(?=[.!?]|$)/giu,
      description => {
        // Keep offsets while masking titles, including quotes cut off by the sentence boundary.
        const unquoted = description.replace(/"[^"\n]*(?:"|$)|“[^”\n]*(?:”|$)|`[^`\n]*(?:`|$)|‘[^’\n]*(?:’|$)|(?<![\p{L}\p{N}])'[^'\n]*(?:'(?![\p{L}\p{N}])|$)/gu,
          quote => ' '.repeat(quote.length));
        const request = /\b(?:but|however|instead|yet)\b\s*,?\s+(?=(?:please|(?:can|could|would|will)\s+you|i\s+(?:want|need|would\s+like)|i['’]d\s+like|what\s+about|(?:how|what|which|where|when|why)\s+(?:do|does|can|could|should|is|are)|(?:now\s+)?(?:explain|describe|recommend|tell|show|list|include))\b)/iu.exec(unquoted);
        return request ? ` ${description.slice(request.index)}` : ' ';
      });
}

const NEGATED_CONTENT_ACTION = String.raw`(?:not|never|don['’]t|doesn['’]t)\s+(?:include|use|recommend|suggest|cover|mention|show|give)`;
const OUTSIDE_BASE_EXCLUSION = new RegExp(String.raw`\b(?:${NEGATED_CONTENT_ACTION}|avoid|exclude|excluding|without)(?:\s+(?:any|anything|me|the|those|extra|additional|content|material|gear|items?|options?|steps?|stuff)){0,5}\s*$`, 'iu');

function withoutOutsideBaseGameClause(question: string): string {
  return question.replace(/"[^"]*"|“[^”]*”|`[^`]*`|‘[^’]*’|(?<![\p{L}\p{N}])'[^']*'(?![\p{L}\p{N}])|\boutside\s+(?:of\s+)?(?:the\s+)?base[\s-]+game\b/giu,
    (clause: string, offset: number) => {
      if (!/^outside\b/iu.test(clause)) return clause;
      const before = question.slice(0, offset).split(/[.!?;,\n]|\b(?:but|however|instead|yet)\b/iu).at(-1) ?? '';
      const directlyNegated = /\b(?:not|never|isn['’]t|aren['’]t)(?:\s+available)?\s*$/iu.test(before);
      return directlyNegated || OUTSIDE_BASE_EXCLUSION.test(before) ? clause : ' ';
    });
}

// A necessity question asks for availability evidence without choosing an expansion.
function withoutDlcNecessityQuestion(question: string): string {
  return question.replace(/\bis\s+dlc\s+(?:required|needed|necessary)\s+to\s+obtain\b/giu, ' ');
}

function withoutExcludedExpansionScope(question: string, names: readonly string[] = []): string {
  const genericExpansion = String.raw`dlcs?|expansions?(?:\s+content)?`;
  const expansionPattern = [genericExpansion, ...names.map(gamingRegistryLiteralPattern)].join('|');
  const qualifier = String.raw`\s+(?:(?:any|the)\s+)?`;
  const coordinated = String.raw`(?:\s+(?:and|or)${qualifier}(?:${genericExpansion})\b)*`;
  const negativeScope = new RegExp(String.raw`\b(?:(?:without|no|excluding)${qualifier}(?:${expansionPattern})|${NEGATED_CONTENT_ACTION}${qualifier}(?:${genericExpansion}))\b${coordinated}`, 'giu');
  return question.replace(negativeScope, (clause: string, offset: number) =>
    /\b(?:not|without|no)\s*$/iu.test(question.slice(0, offset)) ? clause : ' ');
}

/** Request interpretation only; never an assertion about acquired source metadata. */
export function resolveGamingRequestEdition(input: { game?: string; edition?: string; prompt?: string; question?: string }): string | undefined {
  if (input.edition) return normalizeGamingEditionIdentity(input.edition) === 'base-game' ? 'base-game' : input.edition;
  const scopeText = gamingRequestScopeText(input.prompt ?? input.question ?? '');
  const question = withoutOutsideBaseGameClause(scopeText);
  const outsideBaseGame = question !== scopeText;
  const entry = resolveGamingRegistryGame(input.game ?? '');
  if (!entry) {
    // A missing catalog entry supplies no edition default. Explicit generic
    // base-only requests still constrain acquired expansion evidence.
    const base = /\bbase[\s-]+game\b/iu.test(question);
    const remaining = withoutExcludedExpansionScope(question);
    const without = remaining !== question;
    return !outsideBaseGame && (base || without) && !/\b(?:dlcs?|expansions?)\b/iu.test(remaining) ? 'base-game' : undefined;
  }
  const independentEditions = entry.editions.filter(edition => edition.kind === 'edition');
  if (independentEditions.length) {
    const requestText = question.replace(/"[^"]*"|“[^”]*”|`[^`]*`|'[^']*'|‘[^’]*’/gu, ' ');
    const gamePattern = [entry.name, ...entry.aliases].map(gamingRegistryLiteralPattern).join('|');
    const editionPattern = independentEditions.flatMap(edition => [edition.name, ...edition.aliases])
      .sort((left, right) => right.length - left.length).map(gamingRegistryLiteralPattern).join('|');
    const fullEditions = independentEditions.flatMap(edition => edition.aliases.filter(alias => /\bedition\b/iu.test(alias)))
      .map(gamingRegistryLiteralPattern).join('|');
    const matches = [...requestText.matchAll(new RegExp(`\\b(?:${gamePattern})[\\s-]+(${editionPattern})(?=$|[^\\p{L}\\p{N}])${fullEditions ? `|\\b(${fullEditions})(?=$|[^\\p{L}\\p{N}])` : ''}`, 'giu'))];
    if (matches.some(match => /\b(?:not(?:\s+(?:use|apply|include|for)){0,2}|no|without|excluding)\s*$/iu.test(requestText.slice(0, match.index)))) return undefined;
    const editions = matches.filter(match => {
      const before = requestText.slice(0, match.index).split(/[.!?\n]/u).at(-1) ?? '';
      const requestingGuide = /^\s*(?:give me|build me|i (?:need|want))\b/iu.test(before);
      return /\b(?:in|on|for)\s*$/iu.test(before)
        && (!/\b(?:guide|source|article|title)\b/iu.test(before) || requestingGuide);
    }).map(match => normalizeGamingRegistryEdition(entry.name, match[1] ?? match[2]));
    const choices = [...new Set(editions)];
    return choices.length === 1 ? choices[0] : undefined;
  }
  const defaultEdition = entry.editions.find(edition => edition.id === entry.defaultEdition)?.name;
  const expansionNames = entry.editions.filter(edition => ['expansion', 'dlc'].includes(edition.kind))
    .flatMap(edition => [edition.name, ...edition.aliases]);
  const named = expansionNames.length ? new RegExp(`\\b(?:${[...new Set(expansionNames)].map(gamingRegistryLiteralPattern).join('|')})\\b`, 'iu') : undefined;
  const baseRequested = /\bbase[\s-]+game\b/iu.test(question);
  const withoutNecessity = withoutDlcNecessityQuestion(question);
  const remaining = withoutExcludedExpansionScope(withoutNecessity, expansionNames);
  const negativeRequested = remaining !== withoutNecessity;
  const expansionRequested = /\b(?:dlcs?|expansions?)\b/iu.test(remaining) || Boolean(named?.test(remaining));
  if (expansionRequested && (baseRequested || negativeRequested)) return undefined;
  if (named) for (const match of remaining.matchAll(new RegExp(named.source, 'giu'))) {
    const before = remaining.slice(Math.max(0, match.index - 120), match.index);
    if (/\b(?:not(?:\s+(?:use|include|equip|have|own|need|require|for|in|from|with)){0,2}|(?:don|doesn|didn|isn|aren)['’]t(?:\s+(?:use|include|equip|have|own|need|require|for|in|from|with)){0,2}|never\s+(?:use|include|equip)|no|without|excluding)\s*(?:(?:the|any)\s+)?["“‘'`]*\s*$/iu.test(before)) return undefined;
  }
  const requested = entry.editions.filter(edition => ['expansion', 'dlc'].includes(edition.kind)
    && [edition.name, ...edition.aliases].some(alias => new RegExp(`\\b${gamingRegistryLiteralPattern(alias)}\\b`, 'iu').test(remaining)));
  if (requested.length === 1) return requested[0].name;
  if (expansionRequested || outsideBaseGame) return undefined;
  // An explicit base-only request is meaningful even when this registered
  // game has no catalog default. Unspecified requests still receive no scope.
  return defaultEdition ?? (baseRequested || negativeRequested ? 'base-game' : undefined);
}

export interface GamingEditionRequestContext {
  game?: string;
  edition?: string;
  prompt?: string;
  question?: string;
  mode?: string;
  requestedVersion?: string;
  version?: string;
}

/** A request for extra content is distinct from choosing a specific expansion. */
export function gamingRequestTargetsExtraContent(input: GamingEditionRequestContext): boolean {
  if (input.edition) return false;
  const question = gamingRequestScopeText(input.prompt ?? input.question ?? '');
  const extraContent = withoutOutsideBaseGameClause(question) !== question
    || /\b(?:dlcs?|expansions?)\b/iu.test(withoutExcludedExpansionScope(withoutDlcNecessityQuestion(question)));
  return extraContent && resolveGamingRequestEdition(input) === undefined;
}

/** Eligibility only: acquired identity, intact scope and source restrictions still need independent inspection. */
export function canQualifyGamingUnrequestedEdition(input: GamingEditionRequestContext): boolean {
  const prompt = input.prompt ?? input.question ?? '';
  const scopePrompt = gamingRequestScopeText(prompt);
  const namedEdition = resolveGamingRegistryGame(input.game ?? '')?.editions.some(edition => edition.kind !== 'base'
    && [edition.name, ...edition.aliases].some(alias => new RegExp(`\\b${gamingRegistryLiteralPattern(alias)}\\b`, 'iu').test(scopePrompt)));
  return !resolveGamingRequestEdition(input) && Boolean(input.game)
    && !gamingRequestTargetsExtraContent(input) && !namedEdition
    && !/\b(?:edition|dlcs?|expansions?|remaster(?:ed)?|remake|anniversary|definitive)\b/iu.test(scopePrompt)
    && resolveGamingFreshnessDisposition({ prompt, mode: input.mode, requestedVersion: input.requestedVersion ?? input.version }) !== 'REQUIRED';
}

/** Unknown ordinary base-game metadata is not an explicit edition contradiction. */
export function gamingEditionEvidenceMatchesRequest(sourceEdition: string | undefined, requestEdition: string | undefined,
  context?: GamingEditionRequestContext): boolean {
  if (!requestEdition && context && gamingRequestTargetsExtraContent(context)) return false;
  if (resolveGamingRegistryGame(context?.game ?? '')?.editions.some(edition => edition.kind === 'edition')) {
    const acquired = normalizeGamingRegistryEdition(context?.game ?? '', sourceEdition);
    if (acquired) return requestEdition ? acquired === normalizeGamingRegistryEdition(context?.game ?? '', requestEdition)
      : Boolean(context && canQualifyGamingUnrequestedEdition(context));
  }
  return sourceEdition === undefined && (!requestEdition || normalizeGamingEditionIdentity(requestEdition) === 'base-game')
    || gamingEditionIdentitiesMatch(sourceEdition, requestEdition)
    || !requestEdition && sourceEdition !== undefined && normalizeGamingEditionIdentity(sourceEdition) === 'base-game'
      && Boolean(context && canQualifyGamingUnrequestedEdition(context));
}

/** Retain the acquired scope as a source assertion; never fill the player's missing edition. */
export function buildGamingSourceEditionQualification(sourceEdition: string | undefined, input: GamingEditionRequestContext): string {
  return sourceEdition && !resolveGamingRequestEdition(input) && gamingEditionEvidenceMatchesRequest(sourceEdition, undefined, input)
    ? `The cited guide reports edition: ${normalizeGamingEditionIdentity(sourceEdition)}. Your edition was not specified; advice is limited to that guide's reported scope. Compatibility with other editions was not independently verified.` : '';
}

/** @deprecated Compatibility alias; edition recognition is configured in the generic registry. */
export function normalizeGamingMinecraftEdition(value?: string): 'Java' | 'Bedrock' | undefined {
  return normalizeGamingRegistryEdition(GAMING_LEGACY_EDITION_GAME, value) as 'Java' | 'Bedrock' | undefined;
}

/** @deprecated Compatibility alias; acquired-source scope is evaluated by generic rules. */
export function readGamingMinecraftEditionScope(document: { text: string; metadata?: { title?: string; headings?: string } }, game: string): {
  status: 'none' | 'verified' | 'unverified' | 'conflict'; edition?: 'Java' | 'Bedrock'; exclusive: boolean;
} {
  return readGamingRegistryEditionScope(document, game) as ReturnType<typeof readGamingMinecraftEditionScope>;
}

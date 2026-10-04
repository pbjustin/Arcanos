import { resolveGamingFreshnessDisposition } from './gamingQuestionFreshnessPolicy.js';

/** Formatting equivalence only: edition, sequel, expansion and platform words remain identity. */
export function normalizeGamingGameIdentity(game: string): string {
  return game.replace(/[™®©'’‘]/gu, '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}+]+/gu, '-').replace(/^-+|-+$/gu, '');
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
function minecraftRequestScopeText(question: string): string {
  return question.replace(/(?:^|[.!?]\s+)(?:(?:the|this|that)\s+)?(?:(?:submitted|cited)\s+)?(?:guide|source)\s+(?:is\s+|was\s+)?(?:titled|named|for|about|reports?|says?|covers?)\b[^.!?\n]{0,240}(?=[.!?]|$)/giu, ' ');
}

/** Request interpretation only; never an assertion about acquired source metadata. */
export function resolveGamingRequestEdition(input: { game?: string; edition?: string; prompt?: string; question?: string }): string | undefined {
  if (input.edition) return normalizeGamingEditionIdentity(input.edition) === 'base-game' ? 'base-game' : input.edition;
  const question = input.prompt ?? input.question ?? '';
  const gameIdentity = normalizeGamingGameIdentity(input.game ?? '');
  if (gameIdentity === 'minecraft') {
    const requestText = minecraftRequestScopeText(question).replace(/"[^"]*"|“[^”]*”|`[^`]*`|'[^']*'|‘[^’]*’/gu, ' ');
    const matches = [...requestText.matchAll(/\bminecraft[\s-]+(java|bedrock)(?: edition)?\b|\b(java|bedrock) edition\b/giu)];
    if (matches.some(match => /\b(?:not(?:\s+(?:use|apply|include|for)){0,2}|no|without|excluding)\s*$/iu.test(requestText.slice(0, match.index)))) return undefined;
    const editions = matches.filter(match => {
      const before = requestText.slice(0, match.index).split(/[.!?\n]/u).at(-1) ?? '';
      const requestingGuide = /^\s*(?:give me|build me|i (?:need|want))\b/iu.test(before);
      return /\b(?:in|on|for)\s*$/iu.test(before)
        && (!/\b(?:guide|source|article|title)\b/iu.test(before) || requestingGuide);
    }).map(match => normalizeGamingMinecraftEdition(match[1] ?? match[2]));
    const choices = [...new Set(editions)];
    return choices.length === 1 ? choices[0] : undefined;
  }
  if (gameIdentity !== 'elden-ring') return undefined;
  const shadow = /\bshadow[\s-]+of[\s-]+the[\s-]+erdtree\b/iu;
  const baseRequested = /\bbase[\s-]+game\b/iu.test(question);
  // A closed generic necessity question requests a fact; acquired evidence must
  // prove availability. Never remove named or remaining positive expansion scope.
  const withoutNecessity = question.replace(/\bis\s+dlc\s+(?:required|needed|necessary)\s+to\s+obtain\b/giu, ' ');
  // Closed negative clauses express base scope, rather than expansion intent.
  // Keep double negations and mixed positive/negative scope unresolved.
  const negativeScope = /\b(?:without|no|excluding)\s+(?:(?:any|the)\s+)?(?:dlcs?|expansions?(?:\s+content)?|shadow[\s-]+of[\s-]+the[\s-]+erdtree)\b/giu;
  const remaining = withoutNecessity.replace(negativeScope, (clause: string, offset: number) =>
    /\b(?:not|without|no)\s*$/iu.test(withoutNecessity.slice(0, offset)) ? clause : ' ');
  const negativeRequested = remaining !== withoutNecessity;
  const expansionRequested = /\b(?:dlcs?|expansions?)\b/iu.test(remaining) || shadow.test(remaining);
  if (expansionRequested && (baseRequested || negativeRequested)) return undefined;
  if (shadow.test(remaining)) return 'shadow of the erdtree';
  // Unspecified expansion requests and unrecognized language remain unresolved.
  if (expansionRequested) return undefined;
  return 'base-game';
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

/** Eligibility only: acquired identity, intact scope and source restrictions still need independent inspection. */
export function canQualifyGamingUnrequestedEdition(input: GamingEditionRequestContext): boolean {
  const prompt = input.prompt ?? input.question ?? '';
  const scopePrompt = normalizeGamingGameIdentity(input.game ?? '') === 'minecraft' ? minecraftRequestScopeText(prompt) : prompt;
  return !resolveGamingRequestEdition(input) && Boolean(input.game)
    && !/\b(?:edition|dlcs?|expansions?|remaster(?:ed)?|remake|anniversary|definitive|java|bedrock)\b/iu.test(scopePrompt)
    && resolveGamingFreshnessDisposition({ prompt, mode: input.mode, requestedVersion: input.requestedVersion ?? input.version }) !== 'REQUIRED';
}

/** Unknown ordinary base-game metadata is not an explicit edition contradiction. */
export function gamingEditionEvidenceMatchesRequest(sourceEdition: string | undefined, requestEdition: string | undefined,
  context?: GamingEditionRequestContext): boolean {
  if (normalizeGamingGameIdentity(context?.game ?? '') === 'minecraft') {
    const acquired = normalizeGamingMinecraftEdition(sourceEdition);
    if (acquired) return requestEdition ? acquired === normalizeGamingMinecraftEdition(requestEdition)
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

/** Closed editions of the parent game; complete requested game titles remain distinct. */
export function normalizeGamingMinecraftEdition(value?: string): 'Java' | 'Bedrock' | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(java|bedrock)(?: edition)?$/iu.exec(value.normalize('NFKC').trim());
  return match ? match[1].toLowerCase() === 'java' ? 'Java' : 'Bedrock' : undefined;
}

/** Acquired source assertions only, never frontend labels or a derived user choice. */
export function readGamingMinecraftEditionScope(document: { text: string; metadata?: { title?: string; headings?: string } }, game: string): {
  status: 'none' | 'verified' | 'unverified' | 'conflict'; edition?: 'Java' | 'Bedrock'; exclusive: boolean;
} {
  if (normalizeGamingGameIdentity(game) !== 'minecraft') return { status: 'none', exclusive: false };
  const metadata = [document.metadata?.title, document.metadata?.headings].flatMap(value => {
    const match = /^minecraft[\s-]+(java|bedrock)(?:[\s-]+edition)?(?=$|[\s:.,;!?-])/iu.exec(value?.trim() ?? '');
    return match ? [normalizeGamingMinecraftEdition(match[1])!] : [];
  });
  const text = document.text.slice(0, 32_000);
  const assertions: Array<'Java' | 'Bedrock'> = [];
  const unquoted = text.replace(/"[^"]*"|“[^”]*”|`[^`]*`|'[^']*'|‘[^’]*’/gu, quote => ' '.repeat(quote.length));
  for (const match of unquoted.matchAll(/\b(?:in(?: the game)?|this (?:guide|build|walkthrough) (?:covers|is for))\s+minecraft[\s-]+(java|bedrock)(?:[\s-]+edition)?\b/giu)) {
    const before = unquoted.slice(0, match.index).split(/[.!?;,\n]/u).at(-1) ?? '';
    if (/\b(?:unlike|compared(?:\s+to)?|comparison(?:\s+with)?|contrast(?:\s+to)?|similar(?:ly)?|rather\s+than|instead\s+of|as(?:\s+is\s+the\s+case)?|like)\s*$/iu.test(before)
      || /\b(?:not(?:\s+(?:apply|applicable|valid|available|supported|used|found|present|exist|included|be|for)){0,4}|(?:doesn|isn|aren|don|didn)['’]?t(?:\s+(?:apply|exist|work))?|without|except|excluding|unavailable|unsupported)\s*$/iu.test(before)) continue;
    assertions.push(normalizeGamingMinecraftEdition(match[1])!);
  }
  const declared: Array<'Java' | 'Bedrock'> = [];
  for (const match of text.matchAll(/\b(?:edition\s*:\s*|game\s*:\s*minecraft[\s-]+)(java|bedrock)(?:[\s-]+edition)?(?=\s*[.;|\n]|$)/giu)) {
    declared.push(normalizeGamingMinecraftEdition(match[1])!);
    assertions.push(normalizeGamingMinecraftEdition(match[1])!);
  }
  let exclusive = false;
  const scopeText = [document.metadata?.title, document.metadata?.headings, text].filter(Boolean).join('\n');
  for (const match of scopeText.matchAll(/\b(java|bedrock)[ -]only\b|\b(?:requires?|only (?:works|is available) (?:in|on))\s+(?:minecraft\s+)?(java|bedrock)(?: edition)?\b/giu)) {
    if (/\b(?:not|never|without|isn['’]?t|doesn['’]?t|aren['’]?t|don['’]?t)\s*$/iu.test(scopeText.slice(Math.max(0, match.index - 32), match.index))) continue;
    assertions.push(normalizeGamingMinecraftEdition(match[1] ?? match[2])!);
    exclusive = true;
  }
  const unspecifiedEdition = [...text.matchAll(/\bedition\s*:\s*([^.;|\n]{1,120})(?=\s*[.;|\n]|$)/giu)]
    .some(match => !normalizeGamingMinecraftEdition(match[1]));
  const editions = [...new Set(assertions)];
  const titleEditions = [...new Set(metadata)];
  if (new Set(declared).size > 1 || declared.length && editions.some(value => value !== declared[0])
    || editions.length === 1 && titleEditions.some(value => value !== editions[0])) return { status: 'conflict', exclusive };
  // Multiple separately described editions are scope uncertainty, not a contradiction.
  if (unspecifiedEdition || editions.length > 1 || titleEditions.length > 1) return { status: 'unverified', exclusive };
  exclusive ||= /\b(?:unlike|differs? from|different from)\b[^.!?\n]{0,80}\b(?:java|bedrock)(?: edition)?\b/iu.test(text);
  if (editions.length === 1) return { status: 'verified', edition: editions[0], exclusive };
  return { status: titleEditions.length ? 'unverified' : 'none', exclusive };
}

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

/** Request interpretation only; never an assertion about acquired source metadata. */
export function resolveGamingRequestEdition(input: { game?: string; edition?: string; prompt?: string; question?: string }): string | undefined {
  if (input.edition) return normalizeGamingEditionIdentity(input.edition) === 'base-game' ? 'base-game' : input.edition;
  const question = input.prompt ?? input.question ?? '';
  if (normalizeGamingGameIdentity(input.game ?? '') !== 'elden-ring') return undefined;
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
  return !resolveGamingRequestEdition(input) && Boolean(input.game)
    && !/\b(?:edition|dlcs?|expansions?|remaster(?:ed)?|remake|anniversary|definitive|java|bedrock)\b/iu.test(prompt)
    && resolveGamingFreshnessDisposition({ prompt, mode: input.mode, requestedVersion: input.requestedVersion ?? input.version }) !== 'REQUIRED';
}

/** Unknown ordinary base-game metadata is not an explicit edition contradiction. */
export function gamingEditionEvidenceMatchesRequest(sourceEdition: string | undefined, requestEdition: string | undefined,
  context?: GamingEditionRequestContext): boolean {
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
